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
import type { Pose } from '../world/types';
import type { PlaneTypeId } from '../plane/types';
import type { GameActions, GameContext, GameSystem, PlayerMode } from './contracts';

import { World } from '../world/World';
import { Environment } from '../world/env/Environment';
import { Props } from '../world/props/Props';
import { NpcSystem } from '../npc/NpcSystem';
import { Walker } from '../walk/Walker';
import { Replay } from '../replay/Replay';
import { MissileSystem } from '../missiles/MissileSystem';
import { Towers } from '../towers/Towers';
import { Agent } from '../agent/Agent';
import { CarFactory } from '../vehicle/models/CarFactory';
import { PlayerVehicle } from '../vehicle/PlayerVehicle';
import { CameraRig } from '../camera/CameraRig';
import { Fx } from '../fx/Fx';
import { Audio } from '../audio/Audio';
import { Garage } from '../ui/garage/Garage';
import { UI } from '../ui/UI';
import { PlaneFactory } from '../plane/models/PlaneFactory';
import { PlaneSystem } from '../plane/PlaneSystem';
import { Breakup } from '../plane/breakup/Breakup';
import { Nav } from '../nav/Nav';
import { Origin } from '../core/Origin';
import { shiftCityData } from '../core/shiftData';
import { Terrain } from '../terrain/Terrain';
import { Highways } from '../highway/Highways';

/**
 * Orchestrator: owns the context, the state machine and the system update order. Owner: core.
 * State flow: boot → title ("tap to start") → menu ⇄ garage, menu → driving ⇄ paused.
 * In 'driving' the player controls either the car or a plane (`mode`, part 2).
 */
export class Game implements GameActions {
  state: GameState = 'boot';
  mode: PlayerMode = 'car';
  readonly ctx: GameContext;
  private simSystems: GameSystem[] = [];
  private errorCounts = new Map<string, number>();
  private autoResetT = -1;
  private slowMoT = -1;
  private slowMoScale = CONFIG.game.slowMoScale;
  private slowMoDuration = CONFIG.game.slowMoDuration;
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

    const origin = new Origin(engine, physics, events);
    const ctx = { engine, physics, input, events, save, settings, quality, origin, game: this, debug } as unknown as GameContext;
    this.ctx = ctx;
    // Floating origin: CityData is shifted in place before modules get the 'originShift' event.
    origin.beforeEmit = (dx, dz) => {
      if (ctx.world?.data) shiftCityData(ctx.world.data, dx, dz);
    };
    // Construct every system (constructors must be cheap; real work happens in init()).
    ctx.ui = new UI(ctx);
    ctx.env = new Environment(ctx);
    ctx.world = new World(ctx);
    ctx.terrain = new Terrain(ctx);
    ctx.highways = new Highways(ctx);
    ctx.props = new Props(ctx);
    ctx.npcs = new NpcSystem(ctx);
    ctx.cars = new CarFactory(ctx);
    ctx.vehicle = new PlayerVehicle(ctx);
    ctx.planeModels = new PlaneFactory(ctx);
    ctx.planes = new PlaneSystem(ctx);
    ctx.breakup = new Breakup(ctx);
    ctx.nav = new Nav(ctx);
    ctx.cameraRig = new CameraRig(ctx);
    ctx.walker = new Walker(ctx);
    ctx.replay = new Replay(ctx);
    ctx.missiles = new MissileSystem(ctx);
    ctx.towers = new Towers(ctx);
    if (params.has('agent')) ctx.agent = new Agent(ctx);
    ctx.fx = new Fx(ctx);
    ctx.audio = new Audio(ctx);
    ctx.garage = new Garage(ctx);

    // Simulation order matters: world/props/npcs, then the car and planes (forces), breakup (water/piece aero),
    // navigation, then the camera that follows them, then fx/audio.
    this.simSystems = [
      ctx.env, ctx.world, ctx.terrain, ctx.highways, ctx.props, ctx.npcs, ctx.vehicle, ctx.planes, ctx.breakup, ctx.nav,
      ctx.towers, ctx.cameraRig, ctx.walker, ctx.missiles, ctx.fx, ctx.audio, // walker / missiles after the rig: they drive the camera on foot / in a control room
      ctx.replay, // last: records the frame as rendered
    ];
    // agent first: its latched holds / autopilot / queued commands act before the vehicle and planes step
    if (ctx.agent) this.simSystems.unshift(ctx.agent);

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
      [ctx.terrain, 'Raising the mountains'],
      [ctx.highways, 'Paving the highways'],
      [ctx.props, 'Placing street furniture'],
      [ctx.cars, 'Assembling cars'],
      [ctx.planeModels, 'Rolling out the planes'],
      [ctx.npcs, 'Waking up the locals'],
      [ctx.vehicle, 'Fuelling up'],
      [ctx.planes, 'Pre-flight checks'],
      [ctx.breakup, 'Briefing the crash team'],
      [ctx.nav, 'Calibrating GPS'],
      [ctx.cameraRig, 'Framing the shot'],
      [ctx.walker, 'Stretching legs'],
      [ctx.replay, 'Loading the tape'],
      ...(ctx.missiles ? [[ctx.missiles, 'Arming the air defence'] as [GameSystem, string]] : []),
      ...(ctx.towers ? [[ctx.towers, 'Raising the towers'] as [GameSystem, string]] : []),
      ...(ctx.agent ? [[ctx.agent, 'Waking the agent'] as [GameSystem, string]] : []),
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
    await this.warmUp();
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

  /**
   * Pre-warm everything that would otherwise hitch during the first seconds of play (behind the loading bar):
   * systems' warmup hooks, a temporary car (its paint/glass programs), parallel shader compilation of EVERY material
   * in the scene (hidden objects included), then a few hidden frames so geometry/textures get uploaded to the GPU.
   */
  private async warmUp(): Promise<void> {
    const { ctx } = this;
    const { renderer, scene, camera } = ctx.engine;
    const t0 = performance.now();
    ctx.ui.setLoading(0.95, 'Warming up');
    for (const sys of [ctx.env, ctx.world, ctx.terrain, ctx.highways, ctx.props, ctx.cars, ctx.planeModels, ctx.npcs, ctx.vehicle, ctx.planes, ctx.breakup, ctx.nav, ctx.fx, ctx.audio]) {
      if (!sys?.warmup) continue;
      try {
        await sys.warmup();
      } catch (err) {
        reportError(`[${sys.name}] warmup failed`, err);
      }
    }
    // Temporary player car far below the world: compiles the car materials before the first spawn.
    let tmpCar: ReturnType<typeof ctx.cars.create> | null = null;
    try {
      tmpCar = ctx.cars.create(ctx.save.data.garage.current);
      tmpCar.root.position.set(0, -500, 0);
      scene.add(tmpCar.root);
    } catch (err) {
      reportError('[warmup] temp car failed', err);
    }
    // Compile only what is VISIBLE now (forcing hidden pools/LODs visible made phones and SwiftShader boot take minutes).
    // Hidden effects compile in their own warmup() hooks or on first use. Hard cap: never hold the loading screen long.
    const software = /swiftshader|llvmpipe|software/i.test(ctx.quality.gpuName);
    // Opt-in hidden warm-up meshes (userData.warmup, or tiny hidden meshes systems add for exactly this purpose).
    const optIn: THREE.Object3D[] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (o.visible || (o as THREE.Light).isLight) return;
      const n = m.geometry?.attributes?.position?.count ?? Infinity;
      if (o.userData.warmup || n <= 64 || o.name.includes('warmup')) {
        optIn.push(o);
        o.visible = true;
      }
    });
    if (!software) {
      ctx.ui.setLoading(0.97, 'Compiling shaders');
      try {
        const comp = (renderer as unknown as { compileAsync?: (s: THREE.Object3D, c: THREE.Camera) => Promise<unknown> }).compileAsync;
        if (comp) await Promise.race([comp.call(renderer, scene, camera), new Promise((r) => setTimeout(r, ctx.quality.isMobile ? 4000 : 6000))]);
      } catch (err) {
        reportError('[warmup] shader compile failed', err);
      }
    }
    for (const o of optIn) o.visible = false;
    // A few hidden frames (the boot overlay covers the canvas) upload the visible buffers/textures + shadow maps.
    try {
      const prev = camera.position.clone();
      const prevQ = camera.quaternion.clone();
      const frames = software || ctx.quality.isMobile ? 1 : 2;
      for (let i = 0; i < frames; i++) {
        const a = (i / 3) * Math.PI * 2;
        camera.position.set(Math.cos(a) * 120, 60, Math.sin(a) * 120);
        camera.lookAt(0, 0, 0);
        camera.updateMatrixWorld();
        ctx.engine.render(0);
        await new Promise((r) => setTimeout(r, 0));
      }
      camera.position.copy(prev);
      camera.quaternion.copy(prevQ);
    } catch (err) {
      reportError('[warmup] warm frames failed', err);
    }
    if (tmpCar) {
      scene.remove(tmpCar.root);
      try {
        tmpCar.dispose();
      } catch {
        /* ignore */
      }
    }
    console.info(`[warmup] done in ${Math.round(performance.now() - t0)} ms`);
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
    if (!this.simulating || this.ctx.replay.active || this.ctx.agent?.frozen) return; // replay / agent freeze: the world holds still
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
    // the air-defence control room owns the keys (your car / plane gets none while you aim)
    ctx.input.enabled = this.state === 'driving' && !ctx.missiles?.controlling && !ctx.missiles?.viewing;
    ctx.input.mode = this.mode;
    ctx.input.walking = this.mode === 'plane' && ctx.walker.active;
    ctx.input.sensitivity = ctx.settings.values.steerSensitivity;
    ctx.input.invertPitch = ctx.settings.values.invertPitch;
    ctx.input.update(realDt);
    this.handleTriggers();
    this.updateTimers(realDt);

    // Streaming / shadow focus follows what the player controls (car or plane/wreck), else the camera.
    const target = this.mode === 'plane' ? ctx.planes.cameraTarget?.object : null;
    const onFoot = ctx.walker.focus;
    const replayAt = ctx.replay.active ? ctx.replay.focus : null;
    const controlAt = ctx.missiles?.focus ?? null;
    if (replayAt) this.focus.copy(replayAt);
    else if (controlAt) this.focus.copy(controlAt);
    else if (onFoot) this.focus.copy(onFoot);
    else if (target) target.getWorldPosition(this.focus);
    else if (ctx.vehicle.active && ctx.vehicle.object) this.focus.copy(ctx.vehicle.state.position);
    else this.focus.copy(ctx.engine.camera.position);
    // Floating origin: re-centre the world when the focus wanders > ~2 km from the local origin.
    if (this.state === 'driving' && ctx.origin.maybeShift(this.focus)) this.focus.sub(ctx.origin.delta);
    ctx.world.setFocus(this.focus);
    ctx.terrain.setFocus?.(this.focus);
    ctx.highways.setFocus?.(this.focus);
    ctx.env.setShadowFocus(this.focus);

    const agent = ctx.agent;
    if (this.simulating && agent?.frozen && !ctx.replay.active) {
      // agent freeze (turn-based): the world holds still; streaming, the agent view and sound stay alive
      for (const s of [ctx.world, ctx.terrain, ctx.highways] as GameSystem[]) if (s.update) this.guard(s, 'update', () => s.update!(realDt, alpha));
      this.guard(agent, 'update', () => agent.update?.(realDt, alpha));
      this.guard(ctx.audio, 'update', () => ctx.audio.update?.(0, alpha));
    } else if (this.simulating && ctx.replay.active) {
      // crash replay: frozen simulation; world streaming, effects and sound keep running, the replay poses + films
      const sp = ctx.replay.speed;
      for (const s of [ctx.env, ctx.world, ctx.terrain, ctx.highways] as GameSystem[]) if (s.update) this.guard(s, 'update', () => s.update!(realDt, alpha));
      this.guard(ctx.replay, 'play', () => ctx.replay.play(realDt));
      if (agent) this.guard(agent, 'update', () => agent.update?.(realDt, alpha));
      this.guard(ctx.fx, 'update', () => ctx.fx.update?.(realDt * sp, alpha));
      this.guard(ctx.audio, 'update', () => ctx.audio.update?.(realDt * sp, alpha));
    } else if (this.simulating) {
      for (const s of this.simSystems) if (s.update) this.guard(s, 'update', () => s.update!(dt, alpha));
    } else {
      // Paused / garage: keep audio (ducking, UI sounds) alive.
      this.guard(ctx.audio, 'update', () => ctx.audio.update?.(0, alpha));
    }
    if (this.state === 'garage') this.guard(ctx.garage, 'update', () => ctx.garage.update?.(realDt, alpha));
    this.guard(ctx.ui, 'update', () => ctx.ui.update?.(realDt, alpha));
    if (!ctx.engine.filming) ctx.quality.update(realDt, this.state === 'driving' || this.state === 'menu' || this.state === 'title'); // film: fixed full res
  }

  private handleTriggers(): void {
    const { input, vehicle, planes, cameraRig, events, nav, walker, replay } = this.ctx;
    if (this.state === 'driving' && replay.active) {
      if (input.consume('camera') || input.consume('switchTarget')) replay.nextCam();
      if (input.consume('reset')) replay.restart();
      if (input.consume('skip') || input.consume('pause') || input.consume('explode')) replay.stop();
      input.clearTriggers();
      return;
    }
    if (this.state === 'driving') {
      if (input.consume('pause')) this.pause();
      if (input.consume('map')) nav.openMap();
      if (input.consume('camera')) {
        if (walker.active) walker.toggleView();
        else cameraRig.cycleMode();
      }
      if (this.mode === 'plane') {
        if (input.consume('explode')) this.explodeOrReset();
        if (input.consume('reset')) this.requestReset();
        if (input.consume('interact')) {
          // on foot: take the controls back / step out; flying: get up and walk the cabin (exit on the ground)
          if (walker.active) walker.interact();
          else if (!planes.exit()) walker.start();
        }
        if (input.consume('window')) walker.lookOutWindow();
        if (input.consume('explodeMiddle')) planes.explodeMiddle();
        if (input.consume('explodeTail')) planes.explodeTail();
        for (let i = 1; i <= 4; i++) if (input.consume(`engine${i}` as 'engine1')) planes.explodeEngine(i);
        if (input.consume('skip')) planes.skipSequence();
        if (input.consume('switchTarget')) planes.cycleTarget?.();
        // 'gear' is consumed by the plane system itself.
        input.consume('flip');
      } else {
        if (input.consume('explode')) this.explodeOrReset();
        if (input.consume('reset')) this.requestReset();
        if (input.consume('flip')) vehicle.flip();
        if (input.consume('interact')) {
          if (planes.boardCandidate) planes.board();
          else if (vehicle.state.upsideDown) vehicle.flip();
        }
        for (const a of ['gear', 'engine1', 'engine2', 'engine3', 'engine4', 'explodeMiddle', 'explodeTail', 'skip', 'switchTarget', 'window'] as const) input.consume(a);
        const horn = input.state.horn && vehicle.active;
        if (horn !== this.hornWasOn) {
          this.hornWasOn = horn;
          events.emit('horn', { position: vehicle.state.position, on: horn });
        }
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
      const t = Math.min(1, this.slowMoT / this.slowMoDuration);
      engine.timeScale = this.slowMoScale + (1 - this.slowMoScale) * t * t;
      if (t >= 1) {
        engine.timeScale = 1;
        this.slowMoT = -1;
      }
    }
    if (this.autoResetT >= 0 && this.state === 'driving' && this.mode === 'car') {
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
  setMode(mode: PlayerMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.ctx.input.mode = mode;
    this.ctx.input.clearTriggers();
    this.hornWasOn = false;
    this.autoResetT = -1;
    this.ctx.events.emit('modeChanged', { mode });
  }

  slowMo(scale: number, duration: number): void {
    this.slowMoScale = scale;
    this.slowMoDuration = Math.max(0.05, duration);
    this.slowMoT = 0;
    this.ctx.engine.timeScale = scale;
  }

  teleportCar(pose: Pose): void {
    const { ctx } = this;
    if (this.state !== 'driving' && this.state !== 'paused') return;
    if (!ctx.vehicle.active || ctx.vehicle.state.exploded || this.resetting) return;
    if (this.mode === 'plane') ctx.planes.backToCar();
    this.resetting = true;
    let done = false;
    const doIt = () => {
      if (done) return;
      done = true;
      try {
        ctx.engine.timeScale = 1;
        this.slowMoT = -1;
        ctx.vehicle.reset(pose);
        ctx.fx.clearAll();
        ctx.cameraRig.setMode('chase');
        ctx.cameraRig.snap();
        ctx.events.emit('carReset', { position: ctx.vehicle.state.position, yaw: pose.yaw });
      } finally {
        this.resetting = false;
      }
    };
    ctx.ui.fade(doIt);
    window.setTimeout(doIt, 1500);
  }

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
    if (this.mode === 'car') {
      ctx.cameraRig.setMode('chase');
      ctx.cameraRig.snap();
    }
    this.setState('driving');
  }

  /** Menu "click and fly": start playing straight in the air in this plane (no driving, boarding or teleport). */
  quickFly(type: PlaneTypeId): void {
    const { ctx } = this;
    this.play();
    if (this.state !== 'driving') return;
    ctx.planes.quickFly?.(type);
  }

  /** Leave plane control cleanly (menus / garage). */
  private leavePlane(): void {
    if (this.mode === 'plane') this.ctx.planes.backToCar();
    if (this.mode === 'plane') this.setMode('car');
  }

  openGarage(): void {
    const { ctx } = this;
    if (this.state === 'garage') return;
    this.leavePlane();
    ctx.engine.timeScale = 1;
    this.slowMoT = -1;
    this.autoResetT = -1;
    ctx.nav.closeMap();
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
    this.ctx.nav.closeMap();
    this.setState('driving');
  }

  toMainMenu(): void {
    const { ctx } = this;
    if (this.state === 'garage') ctx.garage.close();
    this.leavePlane();
    ctx.nav.closeMap();
    ctx.nav.setDestination(null);
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
    if (this.state !== 'driving') return;
    if (this.mode === 'plane') {
      if (ctx.planes.crashed) ctx.planes.respawnPlane();
      else ctx.planes.explode();
      return;
    }
    if (!ctx.vehicle.active) return;
    if (ctx.vehicle.state.exploded) {
      this.requestReset();
      return;
    }
    ctx.vehicle.explode(); // vehicle emits 'explosion'
    this.slowMo(CONFIG.game.slowMoScale, CONFIG.game.slowMoDuration);
    ctx.save.update((d) => d.stats.explosions++);
    this.autoResetT = ctx.settings.values.autoReset ? CONFIG.game.autoResetDelay : -1;
  }

  requestReset(): void {
    const { ctx } = this;
    if (this.state !== 'driving') return;
    if (this.mode === 'plane') {
      ctx.planes.respawnPlane();
      return;
    }
    if (!ctx.vehicle.active || this.resetting) return;
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
