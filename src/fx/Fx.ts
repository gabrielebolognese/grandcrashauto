import * as THREE from 'three';
import { CONFIG } from '../config';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import { reportError } from '../core/debugOverlay';
import type { SurfaceMaterial } from '../core/Physics';
import type { FireHandle, GameContext, IFx, TrailHandle } from '../game/contracts';
import { ParticlePool, Spawn, createParticleMaterial, type FxSharedUniforms } from './ParticlePool';
import { SkidMarks } from './SkidMarks';
import { LightPool } from './LightPool';
import { CpuEmitter, EmKind, FireEmitter } from './Emitters';
import { spawnExplosion, type ExplosionOpts, type StreamerSink } from './Explosion';
import { VehicleFx } from './VehicleFx';
import { FallbackBlast } from './FallbackBlast';
import * as W from './WorldFx';
import { CELL, RAMP, createAtlas, createRamps } from './textures';
import { type FxKit, count, pick, randDir, rnd, rndS } from './kit';

/**
 * Effects system (spec §6, §10; SPEC-PART2 §12; SPEC-PART3 §6–8). Owner: fx.
 *  - 3 GPU particle pools (decals / main / glow) + 1 ground-ribbon buffer (skids, gouges) = at most 4 draw calls,
 *    0 when idle. Simulation is closed-form in the vertex shader (zero CPU per live particle, zero allocations).
 *  - Pooled point lights created once at init (intensity 0 when unused) for flashes, fires and burning slicks.
 *  - Floating origin: the fx root is a top-level scene child shifted by core; buffers store root-space positions,
 *    so live particles/decals/skids move with the world; cached emitter positions are shifted on 'originShift'.
 *  - clearAll() is instant and free: the fx clock jumps and a shared uniform kills everything born before.
 */

interface Flash {
  active: boolean;
  x: number;
  y: number;
  z: number;
  t0: number;
  peak: number;
  decay: number;
  dist: number;
  r: number;
  g: number;
  b: number;
}

type Level = 'low' | 'medium' | 'high';
type ExKind = 'car' | 'engine' | 'plane' | 'secondary' | 'impact';

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();
const _m4 = new THREE.Matrix4();

export class Fx implements IFx, FxKit, StreamerSink {
  readonly name = 'fx';
  time = 0;
  dt = 0;
  q = 1;
  gravity = -14;
  readonly wind = new THREE.Vector3();
  readonly s = new Spawn();
  main!: ParticlePool;
  glow!: ParticlePool;
  decals!: ParticlePool;

  private skid!: SkidMarks;
  private lights!: LightPool;
  private vfx!: VehicleFx;
  private u!: FxSharedUniforms;
  private readonly root = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private fires: FireEmitter[] = [];
  private emitters: CpuEmitter[] = [];
  private flashes: Flash[] = [];
  private scrapeAcc = 0;
  private sheetAcc = { v: 0 };
  private autoTarget: THREE.Object3D | null = null;
  private autoT = -1;
  private offs: (() => void)[] = [];
  private ambientKey = '';
  private colorCache = new Map<string, THREE.Color>();
  private level: Level = 'medium';
  /** Recent explosionEx calls (x, z, time, radius) — dedupes a generic 'explosion' event fired for the same blast. */
  private recent = new Float32Array(4 * 6);
  private recentHead = 0;
  private lastExRadius = -1;
  /** GPU particle path usable (init ok + shaders linked). Otherwise explosions use the fallback blast. */
  private ok = false;
  private fallback: FallbackBlast | null = null;
  private checkFrames = 6;

  constructor(private ctx: GameContext) {}

  // ─────────────────────────────── lifecycle ───────────────────────────────
  init(): void {
    const { ctx } = this;
    this.root.name = 'fx';
    ctx.engine.scene.add(this.root);
    this.level = (ctx.quality.level as Level) ?? 'medium';
    try {
      this.lights = new LightPool(ctx.engine.scene, CONFIG.fx.lights[this.level] ?? 1);
    } catch (err) {
      reportError('[fx] light pool init failed', err);
    }
    try {
      this.fallback = new FallbackBlast(this.root);
    } catch (err) {
      reportError('[fx] fallback blast init failed', err);
    }
    for (let i = 0; i < 10; i++) this.flashes.push({ active: false, x: 0, y: 0, z: 0, t0: 0, peak: 0, decay: 1, dist: 10, r: 1, g: 0.8, b: 0.6 });
    this.recent.fill(-1e9);
    try {
      this.initParticles();
      this.ok = true;
    } catch (err) {
      // Loud in ?debug, graceful otherwise: explosions still show the fallback fireball + flash.
      reportError('[fx] particle system init failed - using fallback blasts', err);
      this.ok = false;
    }

    const ev = ctx.events;
    this.offs.push(
      ev.on('explosion', (e) => this.onExplosion(e.position, e.radius)),
      ev.on('impact', (e) => this.onImpact(e.position, e.normal, e.strength, e.material)),
      ev.on('scrape', (e) => this.onScrape(e.position, e.intensity)),
      ev.on('glassBreak', (e) => this.glassShards(e.position, e.shattered ? 34 : 10)),
      ev.on('propHit', (e) => this.onPropHit(e.position, e.kind, e.speed)),
      ev.on('partDetached', (e) => this.onPartDetached(e.position)),
      ev.on('npcHit', (e) => this.dust(e.position, Math.min(0.6, e.speed / 25))),
      ev.on('parkedCarHit', (e) => {
        if (e.speed > 7) this.sparks(e.position, UP, Math.min(1, e.speed / 25));
      }),
      ev.on('qualityChanged', () => this.onQuality()),
      ev.on('originShift', (e) => this.onOriginShift(e.delta.x, e.delta.z)),
      ev.on('turbo', (e) => {
        if (e.on && this.ok) this.vfx.pop(this, 1);
      }),
      ev.on('stunt', (e) => {
        if (!this.ok) return;
        if (e.kind === 'cleanLanding') this.vfx.landing(this, false, (p, n, k, i) => this.sparks(p, n, k, i));
        else if (e.kind === 'crashLanding') this.vfx.landing(this, true, (p, n, k, i) => this.sparks(p, n, k, i));
      }),
      // plane hooks with no dedicated IFx member
      ev.on('touchdown', (e) => this.onTouchdown(e.position, e.verticalSpeed, e.hard)),
      ev.on('gearCollapse', (e) => this.sparks(e.position, UP, 1.2)),
      ev.on('planeBreak', (e) => this.sparks(e.position, UP, 0.6 + e.intensity, e.velocity)),
      ev.on('engineExplode', (e) => this.onPlaneBlast(e.position, e.velocity, e.radius, 'engine')),
      ev.on('planeExplosion', (e) => this.onPlaneBlast(e.position, e.velocity, e.radius, e.kind === 'secondary' ? 'secondary' : 'plane')),
    );
  }

  private initParticles(): void {
    const { ctx } = this;
    const atlas = createAtlas();
    const ramps = createRamps();
    this.textures.push(atlas, ramps);
    this.u = {
      uFxTime: { value: 0 },
      uClear: { value: -1 },
      uCut: { value: new THREE.Vector2(0, 0) },
      uRamp: { value: ramps },
      uAtlas: { value: atlas },
      uNearFade: { value: new THREE.Vector2(0.25, 1.4) },
      uMinSize: { value: 0.002 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: GLOBAL_UNIFORMS.uSunColor,
      uAmbient: { value: new THREE.Color(CONFIG.fx.ambient) },
      uDim: { value: 1 },
    };
    const mat = createParticleMaterial(this.u);
    const decalMat = createParticleMaterial(this.u, true);
    this.materials.push(mat, decalMat);
    const caps = this.caps();
    this.decals = new ParticlePool('decals', CONFIG.fx.decalCap, decalMat, 1, this.root);
    this.main = new ParticlePool('main', caps.main, mat, 10, this.root);
    this.glow = new ParticlePool('glow', caps.glow, mat, 11, this.root);
    this.skid = new SkidMarks(CONFIG.fx.skidCap[this.level] ?? 2000, this.u, this.root);
    this.root.add(this.decals.mesh, this.skid.mesh, this.main.mesh, this.glow.mesh);
    this.vfx = new VehicleFx(ctx, this.skid);
    for (let i = 0; i < CONFIG.fx.fire.maxFires; i++) this.fires.push(new FireEmitter());
    for (let i = 0; i < 64; i++) this.emitters.push(new CpuEmitter());
    // Draw every fx mesh for a few frames (no live particles) so programs/buffers exist before the first explosion.
    for (const p of [this.main, this.glow, this.decals]) p.warmup(4);
    this.skid.warmup(4);
    try {
      ctx.engine.renderer.compile(this.root, ctx.engine.camera, ctx.engine.scene);
      ctx.engine.renderer.initTexture(atlas);
      ctx.engine.renderer.initTexture(ramps);
    } catch (err) {
      console.warn('[fx] precompile failed', err);
    }
  }

  /** GameSystem warm-up (behind the loading bar): upload textures, compile programs, draw the empty pools once. */
  warmup(): void {
    if (!this.ok || !this.main) return;
    const r = this.ctx.engine.renderer;
    try {
      for (const t of this.textures) r.initTexture(t);
      r.compile(this.root, this.ctx.engine.camera, this.ctx.engine.scene);
    } catch (err) {
      console.warn('[fx] warmup failed', err);
    }
    for (const p of [this.main, this.glow, this.decals]) p.warmup(4);
    this.skid.warmup(4);
    this.checkFrames = 6;
  }

  /** After the warm-up frames: if a particle shader failed to compile/link on this device, switch to the fallback. */
  private checkPrograms(): void {
    const r = this.ctx.engine.renderer;
    const mats: THREE.Material[] = [...this.materials, this.skid.mesh.material as THREE.Material];
    for (const m of mats) {
      const prog = (r.properties.get(m) as { currentProgram?: { diagnostics?: { runnable: boolean } } }).currentProgram;
      if (prog?.diagnostics && prog.diagnostics.runnable === false) {
        reportError('[fx] particle shader failed on this device - using fallback blasts', new Error(m.name));
        this.ok = false;
        return;
      }
    }
  }

  private caps(): { main: number; glow: number } {
    const total = CONFIG.fx.caps[this.level] ?? 8000;
    const g = CONFIG.fx.glowShare;
    return { main: Math.round(total * (1 - g)), glow: Math.round(total * g) };
  }

  private onQuality(): void {
    if (!this.ok || !this.main) return;
    const lvl = this.ctx.quality.level as Level;
    if (lvl === this.level) return;
    this.level = lvl;
    const caps = this.caps();
    this.main.resize(caps.main);
    this.glow.resize(caps.glow);
  }

  private onOriginShift(dx: number, dz: number): void {
    for (const f of this.flashes) {
      f.x -= dx;
      f.z -= dz;
    }
    if (!this.ok) return;
    // Pools/decals/skids live in the root's space (core already shifted the root); cached scene-space state:
    for (const f of this.fires) if (f.active) f.shift(dx, dz);
    for (const e of this.emitters) if (e.kind !== EmKind.None) e.shift(dx, dz);
    for (let i = 0; i < 6; i++) {
      this.recent[i * 4] -= dx;
      this.recent[i * 4 + 1] -= dz;
    }
    this.skid.shift(dx, dz);
    this.vfx.shift(dx, dz);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.fallback?.dispose();
    this.lights?.dispose();
    this.root.removeFromParent();
    if (!this.main) return;
    this.main.dispose();
    this.glow.dispose();
    this.decals.dispose();
    this.skid.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }

  // ─────────────────────────────── per frame ───────────────────────────────
  update(dt: number): void {
    this.fallback?.update(dt);
    if (!this.ok) {
      this.time += dt;
      if (this.lights) this.updateLights();
      return;
    }
    if (this.checkFrames > 0 && --this.checkFrames === 0) this.checkPrograms();
    const cfg = CONFIG.fx;
    this.q = this.ctx.quality.current?.particleScale ?? 1;
    this.gravity = CONFIG.physics.gravity;
    const w = this.ctx.env?.wind ?? GLOBAL_UNIFORMS.uWind.value;
    this.wind.copy(w).multiplyScalar(cfg.windScale);
    this.wind.y = 0;
    this.dt = dt;
    this.time += dt;
    const u = this.u;
    u.uFxTime.value = this.time;
    u.uNearFade.value.set(cfg.nearFade[0], cfg.nearFade[1]);
    u.uDim.value = 1 + (cfg.nightDim - 1) * GLOBAL_UNIFORMS.uNight.value;
    const cam = this.ctx.engine.camera;
    const vh = Math.max(240, this.ctx.engine.renderer.domElement.height || 720);
    u.uMinSize.value = (cfg.minPixels * 2 * Math.tan(((cam.fov || 60) * Math.PI) / 360)) / vh;
    u.uSunView.value.copy(GLOBAL_UNIFORMS.uSunDir.value).transformDirection(cam.matrixWorldInverse);
    if (this.ambientKey !== cfg.ambient) {
      this.ambientKey = cfg.ambient;
      u.uAmbient.value.set(cfg.ambient);
    }

    // auto wreck fire (unless the vehicle module attached its own)
    if (this.autoT >= 0) {
      this.autoT -= dt;
      if (this.autoT < 0) {
        const v = this.ctx.vehicle;
        const t = this.autoTarget;
        this.autoTarget = null;
        if (t && v.active && v.state.exploded && v.object === t && !this.fires.some((f) => f.active && f.target === t)) {
          const o = cfg.fire.autoOffset;
          this.startFire(t, _v.set(o[0], o[1], o[2]), 1, 1, 1, true);
        }
      }
    }

    try {
      this.vfx.update(this, dt);
    } catch (err) {
      reportError('[fx] vehicle fx failed', err);
    }
    const cut = this.rpClock;
    for (const l of this.fireLog) if (l.died === Infinity && (!l.em.active || l.em.gen !== l.gen)) l.died = this.time;
    if (cut === null) {
      for (const f of this.fires) if (f.active) f.update(this, dt);
    } else this.replayFires(cut, dt);
    for (const e of this.emitters) if (e.kind !== EmKind.None && (cut === null || e.born <= cut)) e.update(this, dt);
    this.updateLights();

    const weather = this.ctx.env?.weather;
    this.decals.update(this.time);
    this.main.update(this.time);
    this.glow.update(this.time);
    this.skid.update(this.time, weather ? weather.wetness : GLOBAL_UNIFORMS.uWetness.value);
  }

  private updateLights(): void {
    const L = this.lights;
    L.begin();
    for (const f of this.flashes) {
      if (!f.active) continue;
      const age = this.time - f.t0;
      if (age < 0) continue;
      const e = Math.exp(-f.decay * age);
      const I = f.peak * e * (age < 0.12 ? 0.85 + 0.15 * Math.sin(age * 95) : 1);
      if (I < 0.5) {
        f.active = false;
        continue;
      }
      // warm flashes cool from white-yellow to orange as they decay
      const warm = f.b < f.g;
      L.request(f.x, f.y, f.z, I, f.r, warm ? f.g * (0.75 + 0.25 * e) : f.g, warm ? f.b * (0.55 + 0.45 * e) : f.b, f.dist);
    }
    const cut = this.rpClock;
    for (const f of this.fires) {
      if (!f.active || (cut !== null && f.born > cut)) continue;
      const I = f.glow(this.time);
      L.request(f.cur.x, f.cur.y + 0.8 * f.size, f.cur.z, I, 1, 0.5, 0.18, 16 * f.size);
    }
    if (cut !== null)
      for (const g of this.ghosts) {
        if (!g.active) continue;
        L.request(g.cur.x, g.cur.y + 0.8 * g.size, g.cur.z, g.glow(this.time), 1, 0.5, 0.18, 16 * g.size);
      }
    for (const e of this.emitters) {
      if (e.kind !== EmKind.FuelFire || (cut !== null && e.born > cut)) continue;
      const I = e.glow(this.time);
      if (I <= 0) continue;
      e.patchPos(_v2);
      L.request(_v2.x, _v2.y + 1 + e.scale * 0.15, _v2.z, I, 1, 0.5, 0.18, 10 + e.scale * 4);
    }
    L.end();
  }

  // ─────────────────────────────── FxKit / StreamerSink ───────────────────────────────
  ground(x: number, z: number): number {
    try {
      const h = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(h) ? h : 0;
    } catch {
      return 0;
    }
  }

  private waterY(): number {
    return CONFIG.world.waterLevel ?? 0;
  }

  flash(x: number, y: number, z: number, peak: number, decay: number, distance: number, delay = 0, r = 1, g = 0.82, b = 0.6): void {
    let slot = this.flashes.find((f) => !f.active);
    if (!slot) {
      slot = this.flashes[0];
      for (const f of this.flashes) if (f.peak * Math.exp(-f.decay * (this.time - f.t0)) < slot.peak * Math.exp(-slot.decay * (this.time - slot.t0))) slot = f;
    }
    slot.active = true;
    slot.x = x;
    slot.y = y;
    slot.z = z;
    slot.t0 = this.time + delay;
    slot.peak = peak;
    slot.decay = decay;
    slot.dist = distance;
    slot.r = r;
    slot.g = g;
    slot.b = b;
  }

  private freeEmitter(): CpuEmitter | null {
    for (const e of this.emitters)
      if (e.kind === EmKind.None) {
        e.born = this.time;
        return e;
      }
    return null;
  }

  addStreamer(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, scale: number, floor: number): void {
    const e = this.freeEmitter();
    if (!e) return;
    e.kind = EmKind.Streamer;
    e.x = x;
    e.y = y;
    e.z = z;
    e.vx = vx;
    e.vy = vy;
    e.vz = vz;
    e.age = 0;
    e.life = life;
    e.scale = scale;
    e.floor = floor;
    e.acc = 0;
  }

  addColumn(x: number, y: number, z: number, scale: number, seconds: number): void {
    const e = this.freeEmitter();
    if (!e) return;
    e.kind = EmKind.Column;
    e.x = x;
    e.y = y;
    e.z = z;
    e.vx = e.vy = e.vz = 0;
    e.age = 0;
    e.life = seconds;
    e.scale = scale;
    e.acc = 0;
  }

  private color(css: string): THREE.Color {
    let c = this.colorCache.get(css);
    if (!c) {
      c = new THREE.Color(css);
      this.colorCache.set(css, c);
    }
    return c;
  }

  // ─────────────────────────────── explosions ───────────────────────────────
  /** Was a blast already spawned here within `window` s (within `dist` m)? */
  private recentHit(x: number, z: number, window: number, dist: number): boolean {
    for (let i = 0; i < 6; i++) {
      const o = i * 4;
      if (this.time - this.recent[o + 2] < window && (x - this.recent[o]) ** 2 + (z - this.recent[o + 1]) ** 2 < Math.max(dist, this.recent[o + 3]) ** 2) return true;
    }
    return false;
  }

  /** Plane systems may call explosionEx directly AND emit the event (or only one of them): spawn exactly once. */
  private onPlaneBlast(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, kind: ExKind): void {
    if (this.recentHit(pos.x, pos.z, 0.12, Math.max(2, radius * 0.5))) return;
    this.explosionEx({ position: pos, velocity: vel, radius, kind });
  }

  private onExplosion(pos: THREE.Vector3, radius: number): void {
    // A system that already called explosionEx for this blast may also emit the generic event (props/npcs react).
    if (this.recentHit(pos.x, pos.z, 0.3, 10)) return;
    const cfg = CONFIG.fx.explosion;
    const scale = Math.min(3, Math.max(0.4, Math.sqrt(Math.max(0, radius) / cfg.refRadius)));
    const v = this.ctx.vehicle;
    let vel: THREE.Vector3 | undefined;
    if (v?.active && v.state.position.distanceToSquared(pos) < 16) {
      vel = v.state.velocity;
      // auto wreck fire (cancelled if the vehicle attaches its own fire to the car)
      if (CONFIG.fx.fire.autoWreckFire && v.object) {
        this.autoTarget = v.object;
        this.autoT = CONFIG.fx.fire.autoDelay;
      }
    }
    this.explode(pos, vel ?? ZERO, cfg.fireballRadius * scale, 'car', undefined, true);
  }

  explosion(pos: THREE.Vector3, scale: number): void {
    this.explosionEx({ position: pos, radius: CONFIG.fx.explosion.fireballRadius * Math.max(0.1, scale), kind: 'car' });
  }

  explosionEx(o: { position: THREE.Vector3; velocity?: THREE.Vector3; radius: number; kind?: ExKind; nearSurface?: 'ground' | 'water' | null; light?: boolean }): void {
    if (this.recentHit(o.position.x, o.position.z, 0.12, Math.max(2, o.radius * 0.5)) && this.lastExRadius === o.radius) return;
    this.lastExRadius = o.radius;
    const r = this.recentHead * 4;
    this.recent[r] = o.position.x;
    this.recent[r + 1] = o.position.z;
    this.recent[r + 2] = this.time;
    this.recent[r + 3] = o.radius * 0.5;
    this.recentHead = (this.recentHead + 1) % 6;
    this.explode(o.position, o.velocity ?? ZERO, o.radius, o.kind ?? 'plane', o.nearSurface, o.light ?? true);
  }

  private explode(p: THREE.Vector3, vel: THREE.Vector3, radius: number, kind: ExKind, near: 'ground' | 'water' | null | undefined, light: boolean): void {
    if (!this.ok) {
      const X = CONFIG.fx.explosion;
      if (CONFIG.fx.fallbackBlast) this.fallback?.trigger(p, radius);
      if (light) this.flash(p.x, p.y + radius * 0.3, p.z, X.flashIntensity * (radius / 6) ** 2, X.flashDecay, X.flashDistance * radius);
      return;
    }
    let surface: 'ground' | 'water' | null = near === undefined ? 'ground' : near;
    let surfaceY = this.ground(p.x, p.z);
    let mat: SurfaceMaterial = 'asphalt';
    try {
      mat = this.ctx.world.surfaceAt(p.x, p.z);
    } catch {
      /* world not ready */
    }
    if (near === undefined) {
      if (mat === 'water') surface = 'water';
      else {
        try {
          if (this.ctx.world.isDeepWater(p.x, p.z)) surface = 'water';
        } catch {
          /* ignore */
        }
      }
    }
    if (surface === 'water') surfaceY = Math.max(surfaceY, this.waterY());
    // no surface effects when the blast is far above it (~100 m for planes)
    if (surface && p.y - surfaceY > Math.max(CONFIG.fx.explosion.groundMaxHeight * radius, kind === 'car' ? 0 : 100)) surface = null;
    const opts: ExplosionOpts = { x: p.x, y: p.y, z: p.z, vx: vel.x, vy: vel.y, vz: vel.z, radius, kind, surface, surfaceY, light };
    try {
      spawnExplosion(this, opts, this, this.dustColorFor(mat));
    } catch (err) {
      reportError('[fx] explosion failed', err);
    }
  }

  private dustArr = [0.8, 0.76, 0.7];
  private dustColorFor(mat: SurfaceMaterial): number[] {
    const cfg = CONFIG.fx.dust;
    const weather = this.ctx.env?.weather;
    const snow = (weather ? weather.snow : GLOBAL_UNIFORMS.uSnow.value) > 0.35;
    const c = this.color(snow ? cfg.snow : mat === 'sand' ? cfg.sand : mat === 'grass' || mat === 'foliage' ? cfg.grass : cfg.other);
    this.dustArr[0] = c.r;
    this.dustArr[1] = c.g;
    this.dustArr[2] = c.b;
    return this.dustArr;
  }

  // ─────────────────────────────── fires & trails ───────────────────────────────
  private startFire(target: THREE.Object3D, offset: THREE.Vector3 | undefined, fire: number, smoke: number, size: number, auto: boolean): FireEmitter {
    let f = this.fires.find((e) => !e.active);
    if (!f) f = this.fires.find((e) => e.auto) ?? this.fires.reduce((a, b) => (a.age > b.age ? a : b));
    f.start(target, offset, fire, smoke, size, auto);
    f.cap = 0;
    f.lifeK = 1;
    f.born = this.time;
    // crash replay: a fire on a wreck group follows one of its plane parts (the replay poses parts, not groups)
    f.rTarget = target;
    f.rOffset.copy(f.offset);
    if (target.userData.wreckGroup) {
      const p = target.children.find((c) => c.userData.planePart);
      if (p) {
        p.updateMatrix();
        f.rTarget = p;
        f.rOffset.copy(f.offset).applyMatrix4(_m4.copy(p.matrix).invert());
      }
    }
    if (!auto) {
      this.fireLog.push({ target: f.rTarget, offset: f.rOffset.clone(), fire, smoke, size, born: this.time, died: Infinity, em: f, gen: f.gen, ghost: null });
      if (this.fireLog.length > 64) this.fireLog = this.fireLog.filter((l) => l.died === Infinity || l.died > this.time - 40).slice(-64);
    }
    return f;
  }

  attachFire(target: THREE.Object3D, localOffset?: THREE.Vector3, scale = 1): FireHandle {
    if (!this.main || !target) return { stop() {} };
    // An explicit fire replaces the automatic wreck fire on the same object.
    if (this.autoTarget === target) {
      this.autoTarget = null;
      this.autoT = -1;
    }
    for (const f of this.fires) if (f.active && f.auto && f.target === target) f.kill();
    const off = localOffset ?? _v.set(0, 0.5 * scale, 0);
    const f = this.startFire(target, off, 1, 1, scale, false);
    const gen = f.gen;
    return {
      stop: () => {
        if (f.active && f.gen === gen) f.stopping = true;
      },
    };
  }

  attachTrail(target: THREE.Object3D, localOffset: THREE.Vector3, o: { fire: number; smoke: number; size: number; cap?: number }): TrailHandle {
    if (!this.main || !target) return { stop() {}, setIntensity() {} };
    const f = this.startFire(target, localOffset, o.fire, o.smoke, o.size, false);
    f.cap = o.cap ?? 0;
    f.lifeK = o.cap ? 0.4 : 1;
    const gen = f.gen;
    return {
      stop: () => {
        if (f.active && f.gen === gen) f.stopping = true;
      },
      setIntensity: (fire: number, smoke: number, size?: number) => {
        if (!f.active || f.gen !== gen) return;
        f.fire = fire;
        f.smoke = smoke;
        if (size !== undefined) f.size = Math.max(0.1, size);
      },
    };
  }

  fuelFire(o: { position: THREE.Vector3; velocity?: THREE.Vector3; size: number; duration: number; onWater: boolean }): void {
    if (!this.ok) return;
    const e = this.freeEmitter();
    if (!e) return;
    const p = o.position;
    const vel = o.velocity ?? ZERO;
    const y = o.onWater ? this.waterY() : this.ground(p.x, p.z);
    e.kind = EmKind.FuelFire;
    e.x = p.x;
    e.y = y + 0.02;
    e.z = p.z;
    e.vx = vel.x * 0.6;
    e.vy = 0;
    e.vz = vel.z * 0.6;
    e.k = o.onWater ? 0.5 : 1.4;
    // slicks drift slowly with the wind; ground patches stop where they slid
    e.wx = o.onWater ? this.wind.x * 0.06 : 0;
    e.wz = o.onWater ? this.wind.z * 0.06 : 0;
    e.onWater = o.onWater;
    e.age = 0;
    e.life = Math.max(1, o.duration);
    e.scale = Math.max(0.5, o.size);
    e.acc = e.acc2 = 0;
    e.level = 0;
    e.seed = Math.random() * 100;
    // the burnt patch / dark slick under it follows the same closed-form drift
    const { s } = this;
    s.reset();
    s.x = e.x;
    s.y = e.y + 0.02;
    s.z = e.z;
    s.vx = e.vx;
    s.vz = e.vz;
    s.drag = e.k;
    s.ax = e.k * e.wx;
    s.az = e.k * e.wz;
    s.floor = e.y + 0.02;
    s.stretch = -1;
    s.cell = o.onWater ? CELL.DUST : CELL.SCORCH;
    s.ramp = o.onWater ? RAMP.SLICK : RAMP.SCORCH;
    s.size0 = e.scale * 1.1;
    s.size1 = e.scale * (o.onWater ? 1.8 : 1.3);
    s.life = e.life + 15;
    s.rot = rnd(0, 6.28);
    if (o.onWater) s.tint(0.03, 0.028, 0.03, 0.75);
    else s.tint(0.045, 0.04, 0.038, 0.9);
    this.decals.emit(s, this.time);
  }

  // ─────────────────────────────── part-2 one-shots ───────────────────────────────
  splash(o: { position: THREE.Vector3; velocity: THREE.Vector3; size: number }): void {
    if (!this.ok) return;
    W.splash(this, o.position, o.velocity ?? ZERO, o.size, this.waterY());
  }

  spraySheet(position: THREE.Vector3, velocity: THREE.Vector3, intensity: number): void {
    if (!this.ok) return;
    W.spraySheet(this, position, velocity, intensity, this.sheetAcc);
  }

  steam(position: THREE.Vector3, size: number): void {
    if (!this.ok) return;
    W.steam(this, position, size);
  }

  bubbles(position: THREE.Vector3, size: number): void {
    if (!this.ok) return;
    W.bubbles(this, position, size, this.waterY());
  }

  gouge(a: THREE.Vector3, b: THREE.Vector3, width: number): void {
    if (!this.ok) return;
    this.skid.gouge(a, b, width, this.time);
  }

  debrisBurst(o: { position: THREE.Vector3; velocity: THREE.Vector3; count: number; size: number; kind?: 'metal' | 'panel' | 'paper' | 'cushion' }): void {
    if (!this.ok) return;
    W.debrisBurst(this, o);
  }

  mist(position: THREE.Vector3, velocity: THREE.Vector3, size: number): void {
    if (!this.ok) return;
    W.mist(this, position, velocity ?? ZERO, size);
  }

  scorch(position: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    if (!this.ok) return;
    W.scorch(this, position, normal, size);
  }

  // ─────────────────────────────── part-1 one-shots ───────────────────────────────
  sparks(pos: THREE.Vector3, normal: THREE.Vector3, intensity: number, inherit?: THREE.Vector3): void {
    if (!this.ok) return;
    const cfg = CONFIG.fx.sparks;
    const { s, wind } = this;
    const now = this.time;
    const k = Math.min(2, Math.max(0, intensity));
    _n.copy(normal);
    if (_n.lengthSq() < 0.01) _n.copy(UP);
    _n.normalize();
    const floor = this.ground(pos.x, pos.z) + 0.03;
    const iv = inherit ?? ZERO;
    const n = Math.max(3, count(cfg.impactCount * (0.3 + k), this.q, 160));
    for (let i = 0; i < n; i++) {
      randDir(_d).multiplyScalar(0.85).addScaledVector(_n, rnd(0.5, 1.1));
      _d.y += 0.25;
      _d.normalize();
      const sp = rnd(3, 13) * (0.5 + k);
      s.reset().pos(pos);
      s.vx = iv.x + _d.x * sp;
      s.vy = iv.y + _d.y * sp;
      s.vz = iv.z + _d.z * sp;
      s.air(0.8, wind, this.gravity);
      s.floor = floor;
      s.life = rnd(cfg.life[0], cfg.life[1]) * (0.8 + 0.4 * k);
      s.size0 = s.size1 = rnd(cfg.size[0], cfg.size[1]);
      s.stretch = cfg.stretch;
      s.heat = rnd(2.5, 4);
      s.cell = CELL.SPARK;
      s.ramp = RAMP.SPARK;
      this.glow.emit(s, now);
    }
    // impact flash
    s.reset().pos(pos);
    s.vx = iv.x;
    s.vy = iv.y;
    s.vz = iv.z;
    s.air(4, wind, 0);
    s.cell = CELL.STAR;
    s.ramp = RAMP.FLASH;
    s.size0 = 0.8 + 1.4 * k;
    s.size1 = 0.4 + 0.6 * k;
    s.life = 0.1;
    s.heat = 3;
    s.rot = rnd(0, 6.28);
    this.glow.emit(s, now);
    if (k > 0.5) this.puff(pos, 2, 0.6, 0.55);
  }

  /** Small grey impact puff. */
  private puff(pos: THREE.Vector3, n: number, size: number, alpha: number): void {
    const { s, wind } = this;
    for (let i = 0; i < n; i++) {
      s.reset().pos(pos);
      s.x += rndS() * 0.3;
      s.z += rndS() * 0.3;
      s.vx = rndS() * 0.8;
      s.vy = rnd(0.4, 1.2);
      s.vz = rndS() * 0.8;
      s.air(1.5, wind, 0.4);
      s.life = rnd(1.0, 1.8);
      s.size0 = size * 0.5;
      s.size1 = size * rnd(2, 3);
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.5;
      s.cell = pick(CELL.WISP, CELL.DUST);
      s.ramp = RAMP.SMOKE_LIGHT;
      s.tint(0.85, 0.84, 0.83, alpha);
      this.main.emit(s, this.time);
    }
  }

  dust(pos: THREE.Vector3, intensity: number, color?: THREE.ColorRepresentation): void {
    if (!this.ok) return;
    const { s, wind } = this;
    const k = Math.min(2, Math.max(0, intensity));
    if (color !== undefined) _c.set(color);
    else _c.copy(this.color(CONFIG.fx.dust.other));
    const floor = this.ground(pos.x, pos.z);
    const n = Math.max(1, count(4 + 12 * k, this.q, 60));
    for (let i = 0; i < n; i++) {
      randDir(_d);
      _d.y = Math.abs(_d.y) * 0.6 + 0.15;
      const sp = rnd(1, 4) * (0.5 + k);
      s.reset().pos(pos);
      s.vx = _d.x * sp;
      s.vy = _d.y * sp;
      s.vz = _d.z * sp;
      s.air(2, wind, -0.3);
      s.floor = floor;
      s.life = rnd(1.2, 2.4);
      s.size0 = rnd(0.3, 0.5) * (0.6 + 0.4 * k);
      s.size1 = rnd(1.4, 2.4) * (0.6 + 0.5 * k);
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.5;
      s.turb = 0.2;
      s.cell = pick(CELL.DUST, CELL.SMOKE_B);
      s.ramp = RAMP.DUST;
      s.tint(_c.r, _c.g, _c.b, 0.85);
      this.main.emit(s, this.time);
    }
  }

  smoke(pos: THREE.Vector3, intensity: number): void {
    if (!this.ok) return;
    const { s, wind } = this;
    const k = Math.min(3, Math.max(0, intensity));
    const n = Math.max(1, count(3 + 9 * k, this.q, 60));
    for (let i = 0; i < n; i++) {
      s.reset().pos(pos);
      s.x += rndS() * 0.4 * (0.5 + k);
      s.z += rndS() * 0.4 * (0.5 + k);
      s.vx = rndS() * 0.8;
      s.vy = rnd(1.2, 2.6) * (0.6 + 0.4 * k);
      s.vz = rndS() * 0.8;
      s.air(0.9, wind, 0.7);
      s.life = rnd(2.5, 4.5);
      s.delay = rnd(0, 0.3);
      s.size0 = rnd(0.5, 0.9) * (0.6 + 0.4 * k);
      s.size1 = rnd(2.5, 4) * (0.6 + 0.5 * k);
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.3;
      s.turb = 0.3;
      s.cell = pick(CELL.SMOKE_A, CELL.SMOKE_B);
      s.ramp = RAMP.FIRE_SMOKE;
      this.main.emit(s, this.time);
    }
  }

  glassShards(pos: THREE.Vector3, n: number): void {
    if (!this.ok) return;
    const cfg = CONFIG.fx.glass;
    const { s, wind } = this;
    const floor = this.ground(pos.x, pos.z) + 0.02;
    const total = Math.max(2, count(n, this.q, 120));
    const iv = this.ctx.vehicle?.active && this.ctx.vehicle.state.position.distanceToSquared(pos) < 9 ? this.ctx.vehicle.state.velocity : ZERO;
    for (let i = 0; i < total; i++) {
      randDir(_d);
      _d.y = Math.abs(_d.y) * 0.8 + 0.2;
      const sp = rnd(1.5, 6);
      s.reset().pos(pos);
      s.x += rndS() * 0.3;
      s.z += rndS() * 0.3;
      s.vx = iv.x * 0.8 + _d.x * sp;
      s.vy = iv.y * 0.8 + _d.y * sp;
      s.vz = iv.z * 0.8 + _d.z * sp;
      s.air(0.4, wind, this.gravity);
      s.floor = floor;
      s.life = rnd(cfg.life[0], cfg.life[1]);
      s.size0 = s.size1 = rnd(0.05, 0.15);
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 16;
      s.cell = CELL.SHARD;
      s.ramp = RAMP.GLASS;
      s.tint(0.8, 0.92, 1.0, 0.95);
      this.main.emit(s, this.time);
      // a twinkling glint following the exact same trajectory (same params → same closed-form path)
      if (i % 3 === 0) {
        s.cell = CELL.STAR;
        s.ramp = RAMP.GLINT;
        s.size0 = s.size1 = rnd(0.25, 0.4);
        s.spin = 0;
        s.heat = 3;
        s.tint(1, 1, 1, 1);
        this.glow.emit(s, this.time);
      }
    }
  }

  // ─────────────────────────────── event handlers ───────────────────────────────
  private onImpact(pos: THREE.Vector3, normal: THREE.Vector3, strength: number, material: SurfaceMaterial): void {
    if (!this.ok) return;
    const cfg = CONFIG.fx.sparks;
    const inherit = this.vehicleVel(pos, 0.5);
    switch (material) {
      case 'metal':
      case 'concrete':
      case 'asphalt':
        if (strength >= cfg.impactThreshold) this.sparks(pos, normal, strength, inherit);
        break;
      case 'wood':
      case 'plastic':
      case 'foliage':
        if (strength >= cfg.impactThreshold * 0.5) this.bits(pos, Math.round(4 + 8 * strength), material === 'wood' ? 0x8a6a48 : material === 'foliage' ? 0x4f9a5a : 0xd9d2c5, strength);
        break;
      case 'sand':
      case 'grass':
        if (strength >= cfg.impactThreshold * 0.5) this.dust(pos, strength, material === 'sand' ? CONFIG.fx.dust.sand : CONFIG.fx.dust.grass);
        break;
      case 'water':
        if (strength >= cfg.impactThreshold * 0.5) W.splash(this, pos, inherit, 0.6 + strength, this.waterY());
        break;
      default:
        break;
    }
    if (strength > 0.6 && material !== 'glass' && material !== 'water') this.puff(pos, 2, 0.5 + strength * 0.5, 0.5);
  }

  private vehicleVel(pos: THREE.Vector3, k: number): THREE.Vector3 {
    const v = this.ctx.vehicle;
    if (v?.active && v.state.position.distanceToSquared(pos) < 16) return _v.copy(v.state.velocity).multiplyScalar(k);
    return ZERO;
  }

  private onScrape(pos: THREE.Vector3, intensity: number): void {
    if (!this.ok) return;
    const cfg = CONFIG.fx.sparks;
    this.scrapeAcc += Math.max(0, intensity) * cfg.scrapeRate * (1 / 60) * this.q;
    let n = Math.min(10, Math.floor(this.scrapeAcc));
    this.scrapeAcc -= n;
    if (n <= 0) return;
    const { s, wind } = this;
    const v = this.ctx.vehicle;
    const vel = v?.active ? v.state.velocity : ZERO;
    const floor = this.ground(pos.x, pos.z) + 0.03;
    while (n-- > 0) {
      s.reset().pos(pos);
      s.x += rndS() * 0.15;
      s.y += 0.05;
      s.z += rndS() * 0.15;
      s.delay = -Math.random() / 60;
      const k = rnd(0.5, 0.9);
      s.vx = vel.x * k + rndS() * 2.2;
      s.vy = rnd(0.8, 3.5) * (0.6 + intensity);
      s.vz = vel.z * k + rndS() * 2.2;
      s.air(1.0, wind, this.gravity);
      s.floor = floor;
      s.life = rnd(0.25, 0.7);
      s.size0 = s.size1 = rnd(cfg.size[0], cfg.size[1]);
      s.stretch = cfg.stretch;
      s.heat = rnd(2.5, 4);
      s.cell = CELL.SPARK;
      s.ramp = RAMP.SPARK;
      this.glow.emit(s, this.time);
    }
  }

  private bits(pos: THREE.Vector3, n: number, hex: number, strength: number): void {
    const { s, wind } = this;
    _c.setHex(hex);
    const floor = this.ground(pos.x, pos.z) + 0.03;
    const total = Math.max(1, count(n, this.q, 40));
    for (let i = 0; i < total; i++) {
      randDir(_d);
      _d.y = Math.abs(_d.y) * 0.8 + 0.3;
      const sp = rnd(2, 6) * (0.6 + strength);
      s.reset().pos(pos);
      s.vx = _d.x * sp;
      s.vy = _d.y * sp;
      s.vz = _d.z * sp;
      s.air(0.5, wind, this.gravity);
      s.floor = floor;
      s.life = rnd(1.4, 2.4);
      s.size0 = s.size1 = rnd(0.06, 0.16);
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 12;
      s.cell = Math.random() < 0.5 ? CELL.CHIP : CELL.LEAF;
      s.ramp = RAMP.SOLID;
      const v = rnd(0.8, 1.1);
      s.tint(_c.r * v, _c.g * v, _c.b * v, 1);
      this.main.emit(s, this.time);
    }
  }

  private onPropHit(pos: THREE.Vector3, kind: string, speed: number): void {
    if (!this.ok) return;
    const k = Math.min(1, speed / 20);
    const name = (kind || '').toLowerCase();
    let hex = 0xbdb6aa;
    if (name.includes('cone')) hex = 0xff7a3a;
    else if (name.includes('barrier')) hex = 0xf2f0e8;
    else if (name.includes('bin') || name.includes('trash')) hex = 0x4f9a7a;
    else if (name.includes('bench')) hex = 0x8a6a48;
    else if (name.includes('palm') || name.includes('tree') || name.includes('plant')) hex = 0x4f9a5a;
    else if (name.includes('hydrant')) hex = 0xd94a3a;
    this.bits(pos, CONFIG.fx.propBits * (0.5 + k), hex, k);
    this.dust(pos, 0.25 + 0.4 * k);
    if (name.includes('hydrant')) {
      const e = this.freeEmitter();
      if (e) {
        e.kind = EmKind.Geyser;
        e.x = pos.x;
        e.y = this.ground(pos.x, pos.z);
        e.z = pos.z;
        e.age = 0;
        e.life = 7;
        e.floor = e.y;
        e.acc = 0;
      }
    }
  }

  private onPartDetached(pos: THREE.Vector3): void {
    if (!this.ok) return;
    this.sparks(pos, UP, 0.5, this.vehicleVel(pos, 0.6));
    this.smoke(pos, 0.3);
  }

  /** Plane wheels touching down: tyre smoke puffs scaled by vertical speed. */
  private onTouchdown(pos: THREE.Vector3, vs: number, hard: boolean): void {
    if (!this.ok) return;
    const { s, wind } = this;
    const k = Math.min(2, 0.4 + Math.abs(vs) / 3);
    const n = Math.max(3, count(10 * k, this.q, 40));
    const gy = this.ground(pos.x, pos.z);
    for (let i = 0; i < n; i++) {
      s.reset().pos(pos);
      s.y = gy + 0.3;
      s.x += rndS() * 0.6;
      s.z += rndS() * 0.6;
      s.vx = rndS() * 1.5;
      s.vy = rnd(0.5, 1.6);
      s.vz = rndS() * 1.5;
      s.air(1.4, wind, 0.4);
      s.floor = gy;
      s.life = rnd(1.4, 2.6);
      s.size0 = rnd(0.6, 1.0) * k;
      s.size1 = rnd(3, 4.5) * k;
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.5;
      s.cell = pick(CELL.WISP, CELL.SMOKE_A);
      s.ramp = RAMP.SMOKE_LIGHT;
      s.tint(1, 1, 1, 0.75);
      this.main.emit(s, this.time);
    }
    if (hard) this.sparks(_v.set(pos.x, gy + 0.2, pos.z), UP, 0.8);
  }

  // ─────────────────────────────── crash replay (rewind) ───────────────────────────────
  private rpClock: number | null = null; // the replayed moment (fx clock); fires / fuel fires born later are dormant
  private rpFrom = 0; // fx clock of the start of the replayed window
  private rpBegan = 0; // fx clock when the replay began

  private fireLog: { target: THREE.Object3D; offset: THREE.Vector3; fire: number; smoke: number; size: number; born: number; died: number; em: FireEmitter; gen: number; ghost: FireEmitter | null }[] = [];
  private ghosts: FireEmitter[] = [];

  /**
   * Fires during the crash replay: live ones that started before the replayed moment burn on the replayed part they
   * belong to; ones that have gone out since are re-lit as "ghosts" for the stretch of the replay they burned in.
   */
  private replayFires(cut: number, dt: number): void {
    for (const f of this.fires) {
      if (!f.active || f.born > cut) continue;
      if (f.rTarget && f.rTarget !== f.target) {
        const t = f.target!;
        _v2.copy(f.offset);
        f.target = f.rTarget;
        f.offset.copy(f.rOffset);
        f.update(this, dt);
        if (f.active) {
          f.target = t;
          f.offset.copy(_v2);
        }
      } else f.update(this, dt);
    }
    for (const l of this.fireLog) {
      const live = l.em.active && l.em.gen === l.gen;
      const want = !live && l.born <= cut && cut < l.died && !!l.target.parent;
      if (want && !l.ghost) {
        let g = this.ghosts.find((e) => !e.active);
        if (!g && this.ghosts.length < 12) this.ghosts.push((g = new FireEmitter()));
        if (g) {
          g.start(l.target, l.offset, l.fire, l.smoke, l.size, false);
          l.ghost = g;
        }
      } else if (!want && l.ghost) {
        l.ghost.kill();
        l.ghost = null;
      }
    }
    for (const g of this.ghosts) if (g.active) g.update(this, dt);
  }

  /** The fx clock (the crash replay records it with every frame). */
  get clock(): number {
    return this.time;
  }

  /**
   * Crash replay: fxClock = the fx time of the moment being replayed (null = the replay is over). Particles born
   * between the replayed window start and the replay start are hidden; fires and burning slicks born after the
   * replayed moment stay dormant until the replay reaches them (so a crash fire is not "already there").
   * restart = the replay looped: the previous pass's particles go too.
   */
  replayClock(fxClock: number | null, restart = false): void {
    const cut = this.u?.uCut.value;
    if (fxClock === null) {
      // back to live: the original particles return, the ones the replay re-spawned are hidden
      if (this.rpClock !== null && cut) cut.set(this.rpBegan, this.time);
      this.rpClock = null;
      for (const g of this.ghosts) g.kill();
      for (const l of this.fireLog) l.ghost = null;
      return;
    }
    if (this.rpClock === null) {
      this.rpBegan = this.time;
      this.rpFrom = fxClock;
      restart = true;
    }
    if (restart && cut) cut.set(this.rpFrom, this.time);
    this.rpClock = fxClock;
  }

  // ─────────────────────────────── reset ───────────────────────────────
  clearAll(): void {
    this.fallback?.clear();
    for (const f of this.flashes) f.active = false;
    this.lights?.off();
    if (!this.ok || !this.main) return;
    // Jump the clock past every pending spawn delay; the shader kills everything born before uClear.
    this.time += CONFIG.fx.clearJump;
    this.u.uFxTime.value = this.time;
    this.u.uClear.value = this.time;
    this.main.clear();
    this.glow.clear();
    this.decals.clear();
    this.skid.clear();
    for (const f of this.fires) if (f.active) f.kill();
    for (const e of this.emitters) e.kind = EmKind.None;
    for (const f of this.flashes) f.active = false;
    this.lights.off();
    this.vfx.reset();
    this.autoTarget = null;
    this.autoT = -1;
    this.scrapeAcc = 0;
    this.sheetAcc.v = 0;
  }

  /** Debug/testing snapshot (not part of IFx). */
  debugStats(): Record<string, number> {
    if (!this.ok) return { ok: 0, time: +this.time.toFixed(2) };
    return {
      time: +this.time.toFixed(2),
      main: this.main.liveEstimate,
      glow: this.glow.liveEstimate,
      decals: this.decals.liveEstimate,
      mainCap: this.main.capacity,
      glowCap: this.glow.capacity,
      spawned: this.main.totalSpawned + this.glow.totalSpawned + this.decals.totalSpawned,
      skid: this.skid.segmentCount,
      fires: this.fires.filter((f) => f.active).length,
      emitters: this.emitters.filter((e) => e.kind !== EmKind.None).length,
      lights: this.lights.lights.filter((l) => l.intensity > 0).length,
      visibleMeshes: this.root.children.filter((c) => c.visible).length,
      ok: 1,
    };
  }
}
