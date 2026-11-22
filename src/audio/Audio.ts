import * as THREE from 'three';
import { CONFIG, type QualityLevel } from '../config';
import { clamp, damp, lerp } from '../core/math';
import type { GameEvents, GameState } from '../core/events';
import type { GameContext, IAudio } from '../game/contracts';
import type { CarModelId } from '../vehicle/CarBuild';
import type { DistrictId } from '../world/types';
import { Ambience } from './Ambience';
import { Baker } from './Baker';
import { emptyBank, toBuffer, type BakeKind, type SfxBank } from './bakes';
import { EngineSound } from './EngineSound';
import { Mixer, type DuckState } from './Mixer';
import { PlaneSounds } from './PlaneSounds';
import { Sfx, type Held } from './Sfx';
import { VehicleSounds } from './VehicleSounds';
import { Listener, VoicePool, audioStats, type Vec3Like } from './Voices';
import { WeatherSounds } from './WeatherSounds';

type DuckPreset = { engine: number; sfx: number; ambience: number; cutoff: number };

/** A sound waiting for its sound-wave to reach the listener (distance / speed of sound). */
interface Delayed {
  at: number; // ctx time
  pos: THREE.Vector3; // LOCAL coords (shifted on originShift)
  dist: number;
  fn: (pos: THREE.Vector3, dist: number) => void;
}

/**
 * Procedural Web Audio (SPEC §12, PART2 §7/§12, PART3 §4/§6/§7). No audio files: everything is synthesized or baked
 * in code at runtime.
 *
 * Lifecycle: the AudioContext is created lazily on the first real user gesture (or unlock() while one is active),
 * resumed on any later gesture (iOS 'interrupted'/'suspended' quirks), suspended while the tab is hidden.
 * Buffers (noise, explosion, debris, fire, glass, crunch, tear, thunder, rain, reverb IR, engine loops) are baked
 * progressively, one job per frame within a small budget.
 *
 * Modules: Mixer (buses, compressor/limiter, reverb, tunnel echo, state ducking), EngineSound, VehicleSounds
 * (tyres, road, wet spray, wind, scrape, horn, turbo, landing), PlaneSounds (engines, wind, fire, cockpit tones),
 * WeatherSounds (rain, roof, wipers, wind howl), Sfx (one-shots), Ambience (city bed, ocean, birds, crowd).
 *
 * Floating origin: positional audio is computed from LOCAL positions relative to the camera every frame; the only
 * cached world positions (delayed booms, held voices, scrape, plane engines) are shifted on 'originShift'.
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
  private plane: PlaneSounds | null = null;
  private weather: WeatherSounds | null = null;
  private readonly listener = new Listener();
  private readonly bank: SfxBank = emptyBank();
  private baker: Baker | null = null;
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
  private delayed: Delayed[] = [];
  private tunnel = 0;
  private tunnelRaw = 0;
  private tunnelT = 0;
  private turboEvt = false;
  private oceanT = 0;
  private ocean = { dist: 1e9, dirX: 0, dirZ: 1 };
  private readonly tmpV = new THREE.Vector3();
  private readonly camPos = new THREE.Vector3();

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

    // ── part 2: planes ──
    ev.on('engineExplode', (e) => this.later(e.position, (p) => this.sfx?.bang(p, e.radius)));
    ev.on('planeExplosion', (e) => {
      this.explosionT = this.ac?.currentTime ?? -100;
      this.later(e.position, (p) => this.sfx?.bigBoom(p, e.radius, e.kind));
    });
    ev.on('planeBreak', (e) => this.later(e.position, (p) => this.sfx?.tear(p, e.intensity)));
    ev.on('planeImpact', (e) => this.onPlaneImpact(e));
    ev.on('touchdown', (e) => this.live()?.touchdown(e.position, e.verticalSpeed, e.hard));
    ev.on('gearCollapse', (e) => this.live()?.strutSnap(e.position));
    ev.on('stallWarning', (e) => this.plane?.stallWarning(e.on));
    ev.on('masterCaution', (e) => {
      if (this.live()) this.plane?.masterCaution(e.level);
    });
    ev.on('outOfMap', (e) => this.plane?.outOfMap(e.state));
    ev.on('modeChanged', () => {
      this.veh?.hornOff();
      this.plane?.reset();
    });
    ev.on('planeSpawned', () => this.plane?.reset());

    // ── part 3 ──
    ev.on('originShift', ({ delta }) => this.onOriginShift(delta.x, delta.z));
    ev.on('lightning', (e) => this.later(e.position, (p, d) => this.sfx?.thunder(p, e.intensity, d), CONFIG.audio.farMaxDistance * 1.5));
    ev.on('turbo', (e) => {
      this.turboEvt = e.on;
      const s = this.live();
      const v = this.ctx.vehicle;
      if (s && e.on && v.active) s.turboWhoosh(v.state.position);
      else if (s && !e.on && v.active && this.ctx.vehicle.build) s.blowoff(v.state.position, 0.45, false);
    });
    ev.on('stunt', (e) => this.onStunt(e));

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
      this.baker = new Baker();
      this.engine = new EngineSound(ac, this.mixer, this.sfx, this.listener, this.bank, this.baker);
      this.veh = new VehicleSounds(ac, this.mixer, this.sfx, this.listener, this.bank);
      this.amb = new Ambience(ac, this.mixer, this.sfx, this.listener, this.bank);
      this.plane = new PlaneSounds(ac, this.mixer, this.sfx, this.listener, this.bank);
      this.weather = new WeatherSounds(ac, this.mixer, this.sfx, this.bank);
      const low = this.ctx.quality.level === 'low' || this.ctx.quality.isMobile;
      // Bake order: shared noise → engine loops of the current car → everything else (worker; main-thread fallback).
      const seed = (Math.random() * 1e9) | 0;
      this.queueBakes(ac, [['white', 'white'], ['pink', 'pink'], ['brown', 'brown']], seed);
      const b = this.ctx.vehicle.build;
      this.engine.ensureBaked(b ? b.model : (this.ctx.save?.data?.garage?.current?.model ?? 'coupe'));
      this.queueBakes(ac, [['crunch0', 'crunch'], ['boom0', 'boom'], ['debris0', 'debris'], ['fire', 'fire'], ['glass0', 'glass'], ['crunch1', 'crunch'], ['ir', 'ir'], ['boom1', 'boom'], ['rain', 'rain'], ['roof', 'roof'], ['tear0', 'tear'], ['thunderFar', 'thunderFar'], ['thunderNear', 'thunderNear'], ['glass1', 'glass'], ['crunch2', 'crunch'], ['debris1', 'debris'], ['tear1', 'tear']], seed, low);
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

  /** Queue named bakes; each result lands in the shared bank as an AudioBuffer. */
  private queueBakes(ac: AudioContext, list: [string, BakeKind][], seed: number, low = false): void {
    const bk = this.baker;
    if (!bk) return;
    const bank = this.bank;
    const sr = ac.sampleRate;
    const R = CONFIG.audio.reverb;
    const keepRaw = new Set(['crunch0', 'boom0', 'fire', 'glass0', 'tear0', 'thunderNear']);
    list.forEach(([name, kind], i) => {
      const args = kind === 'ir' ? { sr, seed: seed + i, seconds: low ? R.secondsLow : R.seconds, lowDecay: R.lowDecay, highDecay: R.highDecay, taps: R.earlyTaps } : { sr, seed: seed + i * 7 + 1 };
      bk.bake(name, kind, args, (chans) => {
        const buf = toBuffer(ac, chans, sr);
        if (keepRaw.has(name)) bank.raw[name] = chans[0];
        bank.ms[name] = bk.ms[name] ?? 0;
        switch (kind) {
          case 'white': bank.white = buf; break;
          case 'pink': bank.pink = buf; break;
          case 'brown': bank.brown = buf; break;
          case 'fire': bank.fire = buf; break;
          case 'rain': bank.rain = buf; break;
          case 'roof': bank.roof = buf; break;
          case 'thunderNear': bank.thunderNear = buf; break;
          case 'thunderFar': bank.thunderFar = buf; break;
          case 'ir': bank.ir = buf; this.mixer?.setImpulse(buf); break;
          case 'boom': bank.boom.push(buf); break;
          case 'debris': bank.debris.push(buf); break;
          case 'glass': bank.glass.push(buf); break;
          case 'crunch': bank.crunch.push(buf); break;
          case 'tear': bank.tear.push(buf); break;
          default: break;
        }
      });
    });
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

  /** Run `fn` when the sound from `pos` reaches the camera (distance / speed of sound). */
  private later(pos: Vec3Like, fn: (pos: THREE.Vector3, dist: number) => void, maxDist: number = CONFIG.audio.farMaxDistance): void {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    this.listener.update(this.ctx.engine.camera);
    const p = new THREE.Vector3(pos.x, pos.y, pos.z);
    const dist = p.distanceTo(this.listener.pos);
    if (dist > maxDist) return;
    const delay = dist / CONFIG.audio.speedOfSound;
    if (delay < 0.02) fn(p, dist);
    else if (this.delayed.length < 24) this.delayed.push({ at: ac.currentTime + delay, pos: p, dist, fn });
  }

  private onOriginShift(dx: number, dz: number): void {
    for (const d of this.delayed) {
      d.pos.x -= dx;
      d.pos.z -= dz;
    }
    this.sfx?.shiftHeld(dx, dz);
    this.veh?.shift(dx, dz);
    this.plane?.shift(dx, dz);
    this.oceanT = 0;
  }

  // ─────────────────────────────── events ───────────────────────────────
  private onState(to: GameState): void {
    this.state = to;
    if (to === 'garage' || to === 'menu' || to === 'title') {
      this.stopFire();
      this.veh?.hornOff();
      this.plane?.reset();
      this.delayed.length = 0;
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
    if (!this.live() || !v.active || v.state.exploded || this.ctx.game.mode === 'plane') return;
    this.veh?.hornOn(pos, (v.build?.model ?? null) as CarModelId | null);
  }

  private onExplosion(e: GameEvents['explosion']): void {
    if (!this.live() || !this.ac) return;
    const now = this.ac.currentTime;
    this.explosionT = now;
    this.fireStartAt = now + CONFIG.audio.explosion.fireDelay;
    this.veh?.silence();
    this.later(e.position, (p) => this.sfx?.explosion(p, e.force));
  }

  private onPlaneImpact(e: GameEvents['planeImpact']): void {
    if (e.outcome === 'landing') return; // touchdown event covers gentle landings
    const s = clamp((Math.log10(Math.max(1, e.energy)) - 5) / 3.5, 0.1, 1);
    const sv = Math.max(s, clamp((e.normalSpeed || 0) / 30, 0, 1));
    if (e.surface === 'water') this.later(e.position, (p) => this.sfx?.waterRoar(p, sv));
    else this.later(e.position, (p) => this.sfx?.heavyCrash(p, e.outcome === 'hardLanding' ? sv * 0.6 : sv));
  }

  private onStunt(e: GameEvents['stunt']): void {
    const s = this.live();
    const v = this.ctx.vehicle;
    if (!s || !v.active) return;
    if (e.kind === 'barrelRoll') s.rollWhoosh(v.state.position);
    else if (e.kind === 'cleanLanding' || e.kind === 'crashLanding') {
      this.veh?.suppressLanding();
      s.slam(v.state.position, clamp(0.5 + (e.airTime || 0) * 0.25, 0.5, 1.2), e.kind === 'crashLanding');
    }
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
    this.mixer.apply(this.ctx.settings.values, this.duck, extra, D.duckTau, this.tunnel);
  }

  private runJobs(): void {
    // Worker mode: results arrive by message. Fallback: bake on the main thread within a small per-frame budget.
    this.baker?.step(CONFIG.audio.engine.bakeBudgetMs);
  }

  /** Probe the ocean around the listener (part-3 geography: west + south coasts; works offshore too). */
  private probeOcean(): void {
    const w = this.ctx.world;
    const L = this.listener.pos;
    const od = w?.oceanDistance?.bind(w);
    if (!od) {
      const dz = (w?.data?.coast?.shoreZ ?? 360) - L.z;
      this.ocean.dist = Math.max(0, dz);
      this.ocean.dirX = 0;
      this.ocean.dirZ = 1;
      return;
    }
    try {
      if (od(L.x, L.z) > 0) {
        this.ocean.dist = 0;
        return;
      }
      let best = 1e9;
      let sx = 0;
      let sz = 0;
      for (const r of [40, 110, 230]) {
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          if (od(L.x + dx * r, L.z + dz * r) > 0) {
            if (r < best) best = r;
            sx += dx / r;
            sz += dz / r;
          }
        }
        if (best < 1e9) break;
      }
      this.ocean.dist = best === 1e9 ? 1e9 : best * 0.8;
      const n = Math.hypot(sx, sz);
      if (n > 1e-6) {
        this.ocean.dirX = sx / n;
        this.ocean.dirZ = sz / n;
      }
    } catch {
      this.ocean.dist = 1e9;
    }
  }

  update(_dt: number): void {
    const ac = this.ac;
    if (!ac || !this.mixer || !this.sfx || !this.engine || !this.veh || !this.amb || !this.pool || !this.plane || !this.weather) return;
    if (ac.state !== 'running') return;
    const rdt = Math.min(0.1, Math.max(0, this.ctx.engine.realDt || 1 / 60));
    this.runJobs();
    const now = ac.currentTime;
    const { vehicle, engine, planes, env } = this.ctx;
    engine.camera.updateMatrixWorld();
    this.listener.update(engine.camera);
    this.camPos.copy(this.listener.pos);

    // tunnel (camera inside a tunnel tube → echo, muffled outside world)
    this.tunnelT -= rdt;
    if (this.tunnelT <= 0) {
      this.tunnelT = CONFIG.audio.tunnel.check;
      try {
        this.tunnelRaw = this.ctx.highways?.inTunnel?.(this.camPos) ? 1 : 0;
      } catch {
        this.tunnelRaw = 0;
      }
    }
    this.tunnel = damp(this.tunnel, this.state === 'driving' ? this.tunnelRaw : 0, 4, rdt);
    this.applyMix();

    // delayed (speed-of-sound) one-shots
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i];
      if (now >= d.at) {
        this.delayed.splice(i, 1);
        try {
          d.fn(d.pos, d.dist);
        } catch (err) {
          console.warn('[audio] delayed sound failed', err);
        }
      }
    }

    const planeMode = this.ctx.game.mode === 'plane';
    const st = vehicle.state;
    const active = vehicle.active && !!vehicle.object && this.state !== 'garage' && !planeMode;
    if (this.pendingStart && active && this.engine.running) {
      this.pendingStart = false;
      if (!st.exploded) this.engine.start(st.position);
    }
    this.engine.update(now, rdt, st, active, vehicle.build);
    const alive = active && !st.exploded;
    const wx = env?.weather;
    // Interior = car hood/bumper view or the plane cockpit (not the wing camera, which `mode` also reports as 'hood').
    const view = this.ctx.cameraRig?.view;
    const interior = view
      ? view === 'hood' || view === 'cockpit' || !!this.ctx.planes?.inCockpitSequence
      : this.ctx.cameraRig?.mode === 'hood';
    this.veh.update(now, rdt, st, alive, vehicle.build?.model ?? null, {
      snow: wx?.snow ?? 0,
      wet: wx?.wetness ?? 0,
      turbo: !!(st.turboActive ?? this.turboEvt),
      gliding: !!st.airborne3?.gliding,
    });

    // burning car wreck
    if (this.fireStartAt > 0 && now >= this.fireStartAt) {
      this.fireStartAt = -1;
      if (active && st.exploded && !this.fire) this.fire = this.sfx.startFire(st.position);
    }
    if (this.fire) {
      if (!active || !st.exploded || this.fire.dead) this.stopFire();
      else this.fire.pos.copy(st.position);
    }

    // planes
    let burning: { pos: Vec3Like; amount: number } | null = null;
    try {
      const pieces = this.ctx.breakup?.pieces;
      if (pieces?.length) {
        let best = 1e9;
        for (const pc of pieces) {
          if (!pc || pc.burning <= 0.05 || !pc.object) continue;
          pc.object.getWorldPosition(this.tmpV);
          const d = this.tmpV.distanceToSquared(this.camPos);
          if (d < best) {
            best = d;
            burning = { pos: { x: this.tmpV.x, y: this.tmpV.y, z: this.tmpV.z }, amount: pc.burning };
          }
        }
      }
    } catch {
      burning = null;
    }
    const pActive = planeMode && !!planes?.active && this.state !== 'garage';
    this.plane.update(now, rdt, {
      active: pActive,
      state: planes.state,
      visual: planes.visual ?? null,
      interior: interior || !!planes.inCockpitSequence,
      sequence: !!planes.inCockpitSequence,
      burning,
    });
    this.sfx.updateHeld();

    // weather
    this.weather.update(now, {
      rain: wx?.rain ?? 0,
      snow: wx?.snow ?? 0,
      storm: wx?.storm ?? 0,
      wind: (wx?.windSpeed ?? 3) + Math.abs(wx?.gust ?? 0),
      interior: interior || (pActive && !!planes.inCockpitSequence),
      tunnel: this.tunnel,
      altitude: this.camPos.y,
      wipers: interior && active && !st.exploded,
    });

    // ambience
    this.districtT -= rdt;
    if (this.districtT <= 0) {
      this.districtT = 0.3;
      try {
        this.district = this.ctx.world.districtAt(this.camPos.x, this.camPos.z) ?? 'downtown';
      } catch {
        this.district = 'downtown';
      }
    }
    this.oceanT -= rdt;
    if (this.oceanT <= 0) {
      this.oceanT = 0.5;
      this.probeOcean();
    }
    const presetNpc = Math.max(1, this.ctx.quality.current?.npcCount ?? 60);
    const alt = Math.max(0, this.camPos.y);
    this.amb.update(now, rdt, {
      night: env?.nightFactor ?? 0,
      npcDensity: alt > 80 ? 0 : (this.ctx.npcs?.activeCount ?? 0) / presetNpc,
      speedKmh: pActive ? planes.state.airspeedKmh || 0 : active ? st.speedKmh || 0 : 0,
      schedule: (this.state === 'driving' || this.state === 'menu' || this.state === 'title') && alt < 150,
      oceanDist: this.ocean.dist + Math.max(0, alt - 20) * 2.5,
      oceanDirX: this.ocean.dirX,
      oceanDirZ: this.ocean.dirZ,
      district: this.district,
      rain: wx?.rain ?? 0,
      altitude: alt,
    });
    this.pool.update(now);
  }

  dispose(): void {
    this.baker?.dispose();
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
      get plane() {
        return self.plane ? { ...self.plane.dbg, spools: [...self.plane.dbg.spools] } : null;
      },
      get weather() {
        return self.weather ? { ...self.weather.dbg, tunnel: r3(self.tunnel) } : null;
      },
      get counts() {
        return self.sfx ? { ...self.sfx.counts } : {};
      },
      get bakeMs() {
        return { worker: !!self.baker?.usingWorker, ...(self.baker?.ms ?? {}) };
      },
      get pendingJobs() {
        return self.baker?.pending ?? 0;
      },
      get delayed() {
        return self.delayed.length;
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
      /** Force the tunnel echo (0..1) for testing; -1 returns to detection. */
      tunnel(v: number) {
        if (v < 0) self.tunnelT = 0;
        else {
          self.tunnelRaw = v;
          self.tunnelT = 1e9;
        }
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
          case 'wiper': s.wiper(0.42); break;
          case 'caution': s.caution('caution'); break;
          case 'warning': s.caution('warning'); break;
          case 'thunder': s.thunder({ x: p.x + 300, y: p.y + 200, z: p.z }, 1, 400); break;
          case 'tear': s.tear(at, 1); break;
          case 'water': s.waterRoar(at, 1); break;
          case 'snap': s.strutSnap(at); break;
          default: s.ui(kind as 'click');
        }
        return true;
      },
    };
  }
}
