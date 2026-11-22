import * as THREE from 'three';
import { CONFIG } from '../config';
import { Engine } from '../core/Engine';
import { EventBus } from '../core/EventBus';
import type { GameEvents, GameState } from '../core/events';
import { Input } from '../core/Input';
import { Physics } from '../core/Physics';
import { Quality } from '../core/Quality';
import { SaveStore } from '../core/Save';
import { SettingsStore } from '../core/Settings';
import { installDebugOverlay, reportError } from '../core/debugOverlay';
import type { CarBuild } from '../vehicle/CarBuild';
import type { GameActions, GameContext, GameSystem } from './contracts';

import { World } from '../world/World';
import { Environment } from '../world/env/Environment';
import { Props } from '../world/props/Props';
import { NpcSystem } from '../npc/NpcSystem';
import { CarFactory } from '../vehicle/models/CarFactory';
import { PlayerVehicle } from '../vehicle/PlayerVehicle';
import { CameraRig } from '../camera/CameraRig';
import { Fx } from '../fx/Fx';
import { Audio } from '../audio/Audio';
import { Garage } from '../ui/garage/Garage';
import { UI } from '../ui/UI';

/**
 * Orchestrator: owns the context, the state machine and the system update order. Owner: core.
 * State flow: boot → title ("tap to start") → menu ⇄ garage, menu → driving ⇄ paused.
 */
export class Game implements GameActions {
  state: GameState = 'boot';
  readonly ctx: GameContext;
  private simSystems: GameSystem[] = [];
  private allSystems: GameSystem[] = [];
  private errorCounts = new Map<string, number>();
  private autoResetT = -1;
  private slowMoT = -1;
  private resetting = false;
  private focus = new THREE.Vector3();
  private hornWasOn = false;

  constructor(container: HTMLElement) {
    const params = new URLSearchParams(location.search);
    const debug = params.has('debug');
    if (debug) installDebugOverlay();
    const seed = Number(params.get('seed'));
    if (Number.isFinite(seed) && seed > 0) CONFIG.game.seed = Math.floor(seed);

    const events = new EventBus<GameEvents>();
    const save = new SaveStore();
    const settings = new SettingsStore(save, events);
    const input = new Input();
    const initialLevel = Quality.initialLevel(save);
    const engine = new Engine(container, CONFIG.quality.presets[initialLevel].antialias && !/Mobile|Android|iPhone|iPad/i.test(navigator.userAgent));
    const physics = new Physics(events);
    const quality = new Quality(engine, settings, save, events);

    const ctx = { engine, physics, input, events, save, settings, quality, game: this, debug } as unknown as GameContext;
    this.ctx = ctx;
    // Construct every system (constructors must be cheap; real work happens in init()).
    ctx.ui = new UI(ctx);
    ctx.env = new Environment(ctx);
    ctx.world = new World(ctx);
    ctx.props = new Props(ctx);
    ctx.npcs = new NpcSystem(ctx);
    ctx.cars = new CarFactory(ctx);
    ctx.vehicle = new PlayerVehicle(ctx);
    ctx.cameraRig = new CameraRig(ctx);
    ctx.fx = new Fx(ctx);
    ctx.audio = new Audio(ctx);
    ctx.garage = new Garage(ctx);

    // Simulation order matters: world/props/npcs, then the car, then the camera that follows it, then fx/audio.
    this.simSystems = [ctx.env, ctx.world, ctx.props, ctx.npcs, ctx.vehicle, ctx.cameraRig, ctx.fx, ctx.audio];
    this.allSystems = [ctx.ui, ctx.env, ctx.world, ctx.props, ctx.npcs, ctx.cars, ctx.vehicle, ctx.cameraRig, ctx.fx, ctx.audio, ctx.garage];

    if (debug) (window as any).__game = { game: this, ctx, CONFIG };
  }

  async boot(): Promise<void> {
    const { ctx } = this;
    await this.safeInit(ctx.ui);
    ctx.ui.setLoading(0.05, 'Starting physics');
    try {
      await ctx.physics.init();
    } catch (err) {
      console.error(err);
      ctx.ui.showFatal('Physics engine failed to start on this device. Try another browser (Chrome, Safari or Firefox, latest version).');
      throw err;
    }
    ctx.quality.init();
    const order: [GameSystem, string][] = [
      [ctx.env, 'Painting the sky'],
      [ctx.world, 'Building the city'],
      [ctx.props, 'Placing street furniture'],
      [ctx.cars, 'Assembling cars'],
      [ctx.npcs, 'Waking up the locals'],
      [ctx.vehicle, 'Fuelling up'],
      [ctx.cameraRig, 'Framing the shot'],
      [ctx.fx, 'Loading effects'],
      [ctx.audio, 'Tuning the engine'],
      [ctx.garage, 'Opening the garage'],
    ];
    for (let i = 0; i < order.length; i++) {
      const [sys, label] = order[i];
      ctx.ui.setLoading(0.1 + (0.85 * i) / order.length, label);
      await new Promise((r) => setTimeout(r, 0)); // let the progress bar paint
      await this.safeInit(sys);
    }
    ctx.ui.setLoading(1, 'Ready');

    ctx.engine.onFixed = (dt) => this.fixed(dt);
    ctx.engine.onUpdate = (dt, alpha, realDt) => this.update(dt, alpha, realDt);
    ctx.cameraRig.setMode('showcase');
    this.setState('title');
    ctx.engine.start();

    const params = new URLSearchParams(location.search);
    if (params.has('autostart')) {
      this.titleDone();
      this.play();
    }
    window.addEventListener('pagehide', () => ctx.save.flush());
  }

  private async safeInit(sys: GameSystem): Promise<void> {
    try {
      await sys.init();
    } catch (err) {
      reportError(`[${sys.name}] init failed`, err);
    }
  }

  private guard(sys: GameSystem, phase: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const key = sys.name + phase;
      const n = (this.errorCounts.get(key) ?? 0) + 1;
      this.errorCounts.set(key, n);
      if (n <= 3 || n % 600 === 0) reportError(`[${sys.name}] ${phase} threw (x${n})`, err);
    }
  }

  private get simulating(): boolean {
    return this.state === 'title' || this.state === 'menu' || this.state === 'driving';
  }

  // ─────────────────────────────── loop ───────────────────────────────
  private fixed(dt: number): void {
    if (!this.simulating) return;
    for (const s of this.simSystems) if (s.fixedUpdate) this.guard(s, 'fixedUpdate', () => s.fixedUpdate!(dt));
    try {
      this.ctx.physics.step();
    } catch (err) {
      reportError('[physics] step threw', err);
    }
    for (const s of this.simSystems) if (s.postStep) this.guard(s, 'postStep', () => s.postStep!(dt));
  }

  private update(dt: number, alpha: number, realDt: number): void {
    const { ctx } = this;
    ctx.input.enabled = this.state === 'driving';
    ctx.input.sensitivity = ctx.settings.values.steerSensitivity;
    ctx.input.update(realDt);
    this.handleTriggers();
    this.updateTimers(realDt);

    // Streaming / shadow focus follows the car, or the camera when there is no car.
    if (ctx.vehicle.active && ctx.vehicle.object) this.focus.copy(ctx.vehicle.state.position);
    else this.focus.copy(ctx.engine.camera.position);
    ctx.world.setFocus(this.focus);
    ctx.env.setShadowFocus(this.focus);

    if (this.simulating) {
      for (const s of this.simSystems) if (s.update) this.guard(s, 'update', () => s.update!(dt, alpha));
    } else {
      // Paused / garage: keep audio (ducking, UI sounds) alive.
      this.guard(ctx.audio, 'update', () => ctx.audio.update?.(0, alpha));
    }
    if (this.state === 'garage') this.guard(ctx.garage, 'update', () => ctx.garage.update?.(realDt, alpha));
    this.guard(ctx.ui, 'update', () => ctx.ui.update?.(realDt, alpha));
    ctx.quality.update(realDt, this.state === 'driving' || this.state === 'menu' || this.state === 'title');
  }

  private handleTriggers(): void {
    const { input, vehicle, cameraRig, events } = this.ctx;
    if (this.state === 'driving') {
      if (input.consume('explode')) this.explodeOrReset();
      if (input.consume('reset')) this.requestReset();
      if (input.consume('camera')) cameraRig.cycleMode();
      if (input.consume('flip')) vehicle.flip();
      if (input.consume('pause')) this.pause();
      const horn = input.state.horn && vehicle.active;
      if (horn !== this.hornWasOn) {
        this.hornWasOn = horn;
        events.emit('horn', { position: vehicle.state.position, on: horn });
      }
    } else if (this.state === 'paused') {
      if (input.consume('pause')) this.resume();
      input.clearTriggers();
    } else {
      input.clearTriggers();
    }
    if (input.consume('fullscreen')) toggleFullscreen();
  }

  private updateTimers(realDt: number): void {
    const { engine } = this.ctx;
    if (this.slowMoT >= 0) {
      this.slowMoT += realDt;
      const t = Math.min(1, this.slowMoT / CONFIG.game.slowMoDuration);
      engine.timeScale = CONFIG.game.slowMoScale + (1 - CONFIG.game.slowMoScale) * t * t;
      if (t >= 1) {
        engine.timeScale = 1;
        this.slowMoT = -1;
      }
    }
    if (this.autoResetT >= 0 && this.state === 'driving') {
      this.autoResetT -= realDt;
      if (this.autoResetT < 0) this.requestReset();
    }
  }

  private setState(to: GameState): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.ctx.input.clearTriggers();
    this.ctx.events.emit('stateChanged', { from, to });
  }

  // ─────────────────────────────── actions ───────────────────────────────
  titleDone(): void {
    if (this.state !== 'title') return;
    this.ctx.events.emit('userGesture', {});
    this.ctx.audio.unlock();
    this.setState('menu');
  }

  play(): void {
    const { ctx } = this;
    if (this.state === 'title') this.titleDone();
    if (this.state === 'garage') ctx.garage.close();
    if (!ctx.vehicle.active) ctx.vehicle.spawn(ctx.save.data.garage.current, ctx.world.data.spawn);
    ctx.engine.timeScale = 1;
    ctx.cameraRig.setMode('chase');
    ctx.cameraRig.snap();
    this.setState('driving');
  }

  openGarage(): void {
    const { ctx } = this;
    if (this.state === 'garage') return;
    ctx.engine.timeScale = 1;
    this.slowMoT = -1;
    this.autoResetT = -1;
    ctx.vehicle.despawn();
    ctx.fx.clearAll();
    this.setState('garage');
    ctx.garage.open();
  }

  driveFromGarage(build: CarBuild): void {
    const { ctx } = this;
    ctx.save.update((d) => (d.garage.current = build));
    ctx.garage.close();
    ctx.vehicle.despawn();
    ctx.vehicle.spawn(build, ctx.world.data.spawn);
    ctx.cameraRig.setMode('chase');
    ctx.cameraRig.snap();
    this.setState('driving');
  }

  pause(): void {
    if (this.state !== 'driving') return;
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.setState('driving');
  }

  toMainMenu(): void {
    const { ctx } = this;
    if (this.state === 'garage') ctx.garage.close();
    ctx.vehicle.despawn();
    ctx.fx.clearAll();
    ctx.engine.timeScale = 1;
    this.slowMoT = -1;
    this.autoResetT = -1;
    ctx.cameraRig.setMode('showcase');
    this.setState('menu');
  }

  explodeOrReset(): void {
    const { ctx } = this;
    if (this.state !== 'driving' || !ctx.vehicle.active) return;
    if (ctx.vehicle.state.exploded) {
      this.requestReset();
      return;
    }
    ctx.vehicle.explode(); // vehicle emits 'explosion'
    this.slowMoT = 0;
    ctx.engine.timeScale = CONFIG.game.slowMoScale;
    ctx.save.update((d) => d.stats.explosions++);
    this.autoResetT = ctx.settings.values.autoReset ? CONFIG.game.autoResetDelay : -1;
  }

  requestReset(): void {
    const { ctx } = this;
    if (this.state !== 'driving' || !ctx.vehicle.active || this.resetting) return;
    this.resetting = true;
    this.autoResetT = -1;
    ctx.cameraRig.skipCinematic();
    let done = false;
    const doReset = () => {
      if (done) return;
      done = true;
      try {
        ctx.engine.timeScale = 1;
        this.slowMoT = -1;
        ctx.vehicle.reset();
        ctx.fx.clearAll();
        ctx.cameraRig.setMode(ctx.cameraRig.mode === 'cinematic' ? 'chase' : ctx.cameraRig.mode);
        ctx.cameraRig.snap();
        ctx.events.emit('carReset', { position: ctx.vehicle.state.position, yaw: 0 });
      } finally {
        this.resetting = false;
      }
    };
    ctx.ui.fade(doReset);
    window.setTimeout(doReset, 1500); // watchdog: never get stuck if the fade callback is lost
  }
}

export function toggleFullscreen(): void {
  const d = document as any;
  const el = document.documentElement as any;
  try {
    if (!document.fullscreenElement && !d.webkitFullscreenElement) {
      const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
      const p = req?.call(el, { navigationUI: 'hide' });
      p?.then?.(() => (screen.orientation as any)?.lock?.('landscape').catch(() => {})).catch(() => {});
    } else {
      (document.exitFullscreen ?? d.webkitExitFullscreen)?.call(document);
    }
  } catch {
    /* unsupported (iPhone Safari) */
  }
}
