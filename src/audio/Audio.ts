import { CONFIG, type QualityLevel } from '../config';
import { lerp } from '../core/math';
import type { GameEvents, GameState } from '../core/events';
import type { GameContext, IAudio } from '../game/contracts';
import type { CarModelId } from '../vehicle/CarBuild';
import type { DistrictId } from '../world/types';
import { Ambience } from './Ambience';
import { emptyBank, sfxBakeJobs, type SfxBank } from './bakes';
import { EngineSound } from './EngineSound';
import { Mixer, type DuckState } from './Mixer';
import { Sfx, type Held } from './Sfx';
import { VehicleSounds } from './VehicleSounds';
import { Listener, VoicePool, audioStats } from './Voices';

type DuckPreset = { engine: number; sfx: number; ambience: number; cutoff: number };

/**
 * Procedural Web Audio (spec §12). No audio files: everything is synthesized or baked in code at runtime.
 *
 * Lifecycle: the AudioContext is created lazily on the first real user gesture (or unlock() when one is active),
 * resumed on any later gesture (iOS 'interrupted'/'suspended' quirks), suspended while the tab is hidden.
 * After creation, buffers (noise, explosion, debris, fire, glass, crunch, reverb IR, engine loops) are baked
 * progressively within a small per-frame budget.
 *
 * Modules: Mixer (buses, compressor/limiter, reverb, state ducking), EngineSound, VehicleSounds (tyres, road, wind,
 * scrape, horn, landing), Sfx (one-shots incl. impacts, props, explosion, NPC voices, UI), Ambience (city bed).
 */
export class Audio implements IAudio {
  readonly name = 'audio';
  unlocked = false;
  private ac: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private pool: VoicePool | null = null;
  private sfx: Sfx | null = null;
  private engine: EngineSound | null = null;
  private veh: VehicleSounds | null = null;
  private amb: Ambience | null = null;
  private readonly listener = new Listener();
  private readonly bank: SfxBank = emptyBank();
  private jobs: [string, () => void][] = [];
  private state: GameState = 'boot';
  private readonly duck: DuckState = { engine: 0, sfx: 0, ambience: 0, cutoff: 20000 };
  private explosionT = -100;
  private fire: Held | null = null;
  private fireStartAt = -1;
  private pendingStart = false;
  private hiddenSuspended = false;
  private failed = false;
  private resuming = false;
  private district: DistrictId = 'downtown';
  private districtT = 0;

  constructor(private ctx: GameContext) {}

  init(): void {
    const ev = this.ctx.events;
    ev.on('userGesture', () => this.unlock());
    ev.on('stateChanged', ({ to }) => this.onState(to));
    ev.on('impact', (e) => this.live()?.impact(e));
    ev.on('scrape', (e) => {
      if (this.live()) this.veh?.scrape(e);
    });
    ev.on('horn', (e) => this.onHorn(e.on, e.position));
    ev.on('explosion', (e) => this.onExplosion(e));
    ev.on('carReset', () => this.onCarReset());
    ev.on('carSpawned', (e) => {
      this.engine?.ensureBaked(e.build.model);
      this.pendingStart = true;
    });
    ev.on('glassBreak', (e) => this.live()?.glassBreak(e));
    ev.on('partDetached', (e) => this.live()?.partDetached(e));
    ev.on('gearShift', (e) => {
      if (this.live()) this.engine?.onGearShift(e.up, e.gear);
    });
    ev.on('propHit', (e) => this.live()?.propHit(e));
    ev.on('parkedCarHit', (e) => this.live()?.parkedCarHit(e));
    ev.on('npcHit', (e) => this.live()?.npcHit(e));
    ev.on('npcStartled', (e) => this.live()?.npcStartled(e));
    ev.on('settingsChanged', () => this.applyMix());
    ev.on('qualityChanged', ({ level }) => {
      if (this.pool) this.pool.cap = this.voiceCap(level);
    });

    // Any trusted gesture creates / resumes the context (iOS needs touchend/click; Chrome accepts pointerdown/keydown).
    const onGesture = () => this.onGesture();
    for (const t of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'] as const) {
      window.addEventListener(t, onGesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', () => this.onVisibility());
    if (this.ctx.debug) this.installDebug();
  }

  // ─────────────────────────────── lifecycle ───────────────────────────────
  unlock(): void {
    if (!this.ac) {
      const ua = (navigator as Navigator & { userActivation?: { isActive: boolean; hasBeenActive: boolean } }).userActivation;
      // No gesture yet (e.g. ?autostart): creating now would only produce a blocked context + console warning.
      if (ua && !ua.isActive && !ua.hasBeenActive) return;
      this.create();
    }
    this.resume();
  }

  private onGesture(): void {
    if (!this.ac) this.create();
    this.resume();
  }

  private resume(): void {
    const ac = this.ac;
    if (!ac || document.hidden) return;
    if (ac.state !== 'running') {
      this.resuming = true;
      this.hiddenSuspended = false;
      ac.resume()
        .catch(() => {})
        .finally(() => {
          this.resuming = false;
        });
    }
  }

  private voiceCap(level: QualityLevel): number {
    return CONFIG.audio.maxVoices[level] ?? 22;
  }

  private create(): void {
    if (this.ac || this.failed) return;
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) {
      this.failed = true;
      return;
    }
    try {
      this.ac = new AC({ latencyHint: 'interactive' });
    } catch {
      try {
        this.ac = new AC();
      } catch (err) {
        console.warn('[audio] AudioContext unavailable', err);
        this.failed = true;
        return;
      }
    }
    const ac = this.ac;
    ac.onstatechange = () => {
      this.unlocked = ac.state === 'running';
    };
    this.unlocked = ac.state === 'running';
    try {
      this.mixer = new Mixer(ac, this.ctx.debug);
      this.pool = new VoicePool(ac);
      this.pool.cap = this.voiceCap(this.ctx.quality.level);
      this.sfx = new Sfx(ac, this.mixer, this.pool, this.listener, this.bank);
      this.engine = new EngineSound(ac, this.mixer, this.sfx, this.listener, this.bank);
      this.veh = new VehicleSounds(ac, this.mixer, this.sfx, this.listener, this.bank);
      this.amb = new Ambience(ac, this.mixer, this.sfx, this.listener, this.bank);
      const low = this.ctx.quality.level === 'low' || this.ctx.quality.isMobile;
      this.jobs = sfxBakeJobs(ac, this.bank, low, (b) => this.mixer?.setImpulse(b));
      // Shared noise first: every layer depends on it (~3 × 4 s of noise, a few ms).
      for (let i = 0; i < 3 && this.jobs.length; i++) this.jobs.shift()![1]();
      const b = this.ctx.vehicle.build;
      if (b) this.engine.ensureBaked(b.model);
      else this.engine.ensureBaked(this.ctx.save?.data?.garage?.current?.model ?? 'coupe');
      // iOS unlock idiom: start a silent buffer inside the gesture.
      const s = ac.createBufferSource();
      s.buffer = ac.createBuffer(1, 1, Math.max(22050, ac.sampleRate));
      s.connect(ac.destination);
      s.onended = () => s.disconnect();
      s.start(0);
      this.applyMix();
    } catch (err) {
      console.warn('[audio] graph setup failed', err);
    }
  }

  private onVisibility(): void {
    const ac = this.ac;
    if (!ac) return;
    if (document.hidden) {
      if (ac.state === 'running') {
        this.hiddenSuspended = true;
        ac.suspend().catch(() => {});
      }
    } else if (this.hiddenSuspended) {
      this.hiddenSuspended = false;
      this.resume();
    }
  }

  /** Sfx if the context is actually running (events while suspended are dropped, not queued). */
  private live(): Sfx | null {
    return this.ac && this.ac.state === 'running' ? this.sfx : null;
  }

  // ─────────────────────────────── events ───────────────────────────────
  private onState(to: GameState): void {
    this.state = to;
    if (to === 'garage' || to === 'menu' || to === 'title') {
      this.stopFire();
      this.veh?.hornOff();
    }
    if (to === 'paused') this.veh?.hornOff();
    this.applyMix();
  }

  private onHorn(on: boolean, pos: { x: number; y: number; z: number }): void {
    if (!on) {
      this.veh?.hornOff();
      return;
    }
    const v = this.ctx.vehicle;
    if (!this.live() || !v.active || v.state.exploded) return;
    this.veh?.hornOn(pos, (v.build?.model ?? null) as CarModelId | null);
  }

  private onExplosion(e: GameEvents['explosion']): void {
    const s = this.live();
    if (!s || !this.ac) return;
    s.explosion(e.position, e.force);
    const now = this.ac.currentTime;
    this.explosionT = now;
    this.fireStartAt = now + CONFIG.audio.explosion.fireDelay;
    this.veh?.silence();
  }

  private onCarReset(): void {
    this.stopFire();
    if (!this.live()) return;
    this.pendingStart = true;
    this.sfx?.respawn();
  }

  private stopFire(): void {
    this.fireStartAt = -1;
    if (this.fire) {
      this.fire.stop(0.45);
      this.fire = null;
    }
  }

  ui(kind: 'click' | 'confirm' | 'back' | 'toggle'): void {
    if (!this.ac) this.unlock();
    const ac = this.ac;
    if (!ac || !this.sfx || document.hidden) return;
    if (ac.state === 'running' || this.resuming) this.sfx.ui(kind);
  }

  // ─────────────────────────────── frame ───────────────────────────────
  private applyMix(): void {
    const ac = this.ac;
    if (!ac || !this.mixer) return;
    const D = CONFIG.audio.duck;
    const d = ((D as unknown as Record<string, DuckPreset>)[this.state] ?? D.driving) as DuckPreset;
    const since = ac.currentTime - this.explosionT;
    const extra = since < D.explosionRecover ? lerp(D.explosionAmbience, 1, Math.max(0, since) / D.explosionRecover) : 1;
    this.duck.engine = d.engine;
    this.duck.sfx = d.sfx;
    this.duck.ambience = d.ambience;
    this.duck.cutoff = d.cutoff;
    this.mixer.apply(this.ctx.settings.values, this.duck, extra, D.duckTau);
  }

  private runJobs(): void {
    const budget = CONFIG.audio.engine.bakeBudgetMs;
    const t0 = performance.now();
    try {
      if (this.engine?.pendingBakes) this.engine.bakeStep(budget);
    } catch (err) {
      console.warn('[audio] engine bake failed', err);
    }
    while (this.jobs.length && performance.now() - t0 < budget) {
      const [name, fn] = this.jobs.shift()!;
      try {
        fn();
      } catch (err) {
        console.warn(`[audio] bake ${name} failed`, err);
      }
    }
  }

  update(_dt: number): void {
    const ac = this.ac;
    if (!ac || !this.mixer || !this.sfx || !this.engine || !this.veh || !this.amb || !this.pool) return;
    if (ac.state !== 'running') return;
    const rdt = Math.min(0.1, Math.max(0, this.ctx.engine.realDt || 1 / 60));
    this.runJobs();
    this.applyMix();
    const now = ac.currentTime;
    const { vehicle, engine } = this.ctx;
    engine.camera.updateMatrixWorld();
    this.listener.update(engine.camera);

    const st = vehicle.state;
    const active = vehicle.active && !!vehicle.object && this.state !== 'garage';
    if (this.pendingStart && active && this.engine.running) {
      this.pendingStart = false;
      if (!st.exploded) this.engine.start(st.position);
    }
    this.engine.update(now, rdt, st, active, vehicle.build);
    const alive = active && !st.exploded;
    this.veh.update(now, rdt, st, alive, vehicle.build?.model ?? null);

    // burning wreck
    if (this.fireStartAt > 0 && now >= this.fireStartAt) {
      this.fireStartAt = -1;
      if (active && st.exploded && !this.fire) this.fire = this.sfx.startFire(st.position);
    }
    if (this.fire) {
      if (!active || !st.exploded || this.fire.dead) this.stopFire();
      else this.fire.pos.copy(st.position);
    }
    this.sfx.updateHeld();

    // ambience
    this.districtT -= rdt;
    if (this.districtT <= 0) {
      this.districtT = 0.3;
      try {
        this.district = this.ctx.world.districtAt(this.listener.pos.x, this.listener.pos.z) ?? 'downtown';
      } catch {
        this.district = 'downtown';
      }
    }
    const presetNpc = Math.max(1, this.ctx.quality.current?.npcCount ?? 60);
    this.amb.update(now, rdt, {
      night: this.ctx.env?.nightFactor ?? 0,
      npcDensity: (this.ctx.npcs?.activeCount ?? 0) / presetNpc,
      speedKmh: active ? st.speedKmh || 0 : 0,
      schedule: this.state === 'driving' || this.state === 'menu' || this.state === 'title',
      shoreZ: this.ctx.world?.data?.coast?.shoreZ ?? 360,
      district: this.district,
    });
    this.pool.update(now);
  }

  dispose(): void {
    this.stopFire();
    this.pool?.stopAll();
    this.ac?.close().catch(() => {});
    this.ac = null;
  }

  // ─────────────────────────────── debug ───────────────────────────────
  private installDebug(): void {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const r3 = (v: number) => +v.toFixed(4);
    (window as unknown as { __audioDebug: unknown }).__audioDebug = {
      get state() {
        return self.ac?.state ?? 'none';
      },
      get unlocked() {
        return self.unlocked;
      },
      get sampleRate() {
        return self.ac?.sampleRate ?? 0;
      },
      get gameState() {
        return self.state;
      },
      /** Active (non-stolen) one-shot voices. */
      get voices() {
        return self.pool?.active.length ?? 0;
      },
      get liveVoices() {
        return self.pool?.liveCount ?? 0;
      },
      get cap() {
        return self.pool?.cap ?? 0;
      },
      get stats() {
        return { ...audioStats };
      },
      get engine() {
        const e = self.engine;
        return e ? { ...e.dbg, weights: e.dbg.weights.map((w) => +w.toFixed(2)), running: e.running, pending: e.pendingBakes } : null;
      },
      get vehicle() {
        return self.veh ? { ...self.veh.dbg } : null;
      },
      get ambience() {
        return self.amb ? { ...self.amb.dbg } : null;
      },
      get counts() {
        return self.sfx ? { ...self.sfx.counts } : {};
      },
      get bakeMs() {
        return { ...self.bank.ms };
      },
      get pendingJobs() {
        return self.jobs.length + (self.engine?.pendingBakes ?? 0);
      },
      get duck() {
        return { ...self.duck };
      },
      get fire() {
        return !!self.fire;
      },
      /** Instantaneous RMS per bus (post volume) + master (post limiter). */
      rms() {
        const m = self.mixer;
        if (!m) return null;
        return { engine: r3(m.rms('engine')), sfx: r3(m.rms('sfx')), ambience: r3(m.rms('ambience')), ui: r3(m.rms('ui')), master: r3(m.rms('master')) };
      },
      engineData(model: CarModelId) {
        return self.engine?.bakedData(model) ?? null;
      },
      raw(name: string) {
        return self.bank.raw[name] ?? null;
      },
      unlock() {
        self.onGesture();
      },
      test(kind: string) {
        const s = self.live();
        const p = self.listener.pos;
        const at = { x: p.x + 4, y: p.y, z: p.z };
        if (!s) return false;
        switch (kind) {
          case 'alarm': s.alarm(at); break;
          case 'gull': s.gull(at); break;
          case 'songbird': s.songbird(at); break;
          case 'farHorn': s.farHorn(at); break;
          case 'passby': s.passby(at, 1); break;
          case 'scream': s.vocal(at, 'scream'); break;
          case 'whoa': s.vocal(at, 'whoa'); break;
          case 'pop': s.pop(self.ac!.currentTime, 1, at); break;
          case 'blowoff': s.blowoff(at, 1, false); break;
          default: s.ui(kind as 'click');
        }
        return true;
      },
    };
  }
}
