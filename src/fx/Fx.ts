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
import { CELL, RAMP, createAtlas, createRamps } from './textures';
import { type FxKit, count, pick, randDir, rnd, rndS } from './kit';

/**
 * Effects system (spec §6, §10; SPEC-PART2 §12). Owner: fx.
 *  - 3 GPU particle pools (main / glow / decals) + 1 skid-mark ribbon buffer = at most 4 draw calls, 0 when idle.
 *  - Pooled point lights (created once at init, intensity 0 when unused) for explosion flashes and fire glow.
 *  - Reacts to events: explosion, impact, scrape, glassBreak, propHit, partDetached, npcHit, parkedCarHit.
 *  - Reads ctx.vehicle.state.wheels every frame for skid marks, tyre smoke, dust and water spray.
 *  - clearAll() is instant and free: the fx clock jumps forward and a shared uniform kills everything born before.
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
}

type Level = 'low' | 'medium' | 'high';

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _c = new THREE.Color();

export class Fx implements IFx, FxKit, StreamerSink {
  readonly name = 'fx';
  time = 0;
  q = 1;
  gravity = -14;
  readonly wind = new THREE.Vector3();
  readonly s = new Spawn();
  main!: ParticlePool;
  glow!: ParticlePool;
  decals!: ParticlePool;

  private skid!: SkidMarks;
  private lights!: LightPool;
  private u!: FxSharedUniforms;
  private readonly root = new THREE.Group();
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private fires: FireEmitter[] = [];
  private emitters: CpuEmitter[] = [];
  private flashes: Flash[] = [];
  private wheelAcc = new Float32Array(8);
  private scrapeAcc = 0;
  private autoTarget: THREE.Object3D | null = null;
  private autoT = -1;
  private offs: (() => void)[] = [];
  private ambientKey = '';
  private colorCache = new Map<string, THREE.Color>();
  private level: Level = 'medium';

  constructor(private ctx: GameContext) {}

  // ─────────────────────────────── lifecycle ───────────────────────────────
  init(): void {
    const { ctx } = this;
    const atlas = createAtlas();
    const ramps = createRamps();
    this.textures.push(atlas, ramps);
    this.u = {
      uFxTime: { value: 0 },
      uClear: { value: -1 },
      uRamp: { value: ramps },
      uAtlas: { value: atlas },
      uNearFade: { value: new THREE.Vector2(0.4, 2.5) },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: GLOBAL_UNIFORMS.uSunColor,
      uAmbient: { value: new THREE.Color(CONFIG.fx.ambient) },
      uDim: { value: 1 },
    };
    const mat = createParticleMaterial(this.u);
    const decalMat = createParticleMaterial(this.u, true);
    this.materials.push(mat, decalMat);

    this.level = ctx.quality.level as Level;
    const caps = this.caps();
    this.decals = new ParticlePool('decals', CONFIG.fx.decalCap, decalMat, 1);
    this.main = new ParticlePool('main', caps.main, mat, 10);
    this.glow = new ParticlePool('glow', caps.glow, mat, 11);
    this.skid = new SkidMarks(CONFIG.fx.skidCap[this.level] ?? 2000, this.u);
    this.root.name = 'fx';
    this.root.add(this.decals.mesh, this.skid.mesh, this.main.mesh, this.glow.mesh);
    ctx.engine.scene.add(this.root);
    this.lights = new LightPool(ctx.engine.scene, CONFIG.fx.lights[this.level] ?? 1);

    for (let i = 0; i < CONFIG.fx.fire.maxFires; i++) this.fires.push(new FireEmitter());
    for (let i = 0; i < 48; i++) this.emitters.push(new CpuEmitter());
    for (let i = 0; i < 8; i++) this.flashes.push({ active: false, x: 0, y: 0, z: 0, t0: 0, peak: 0, decay: 1, dist: 10 });

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
    );
  }

  private caps(): { main: number; glow: number } {
    const total = CONFIG.fx.caps[this.level] ?? 8000;
    const g = CONFIG.fx.glowShare;
    return { main: Math.round(total * (1 - g)), glow: Math.round(total * g) };
  }

  private onQuality(): void {
    if (!this.main) return;
    const lvl = this.ctx.quality.level as Level;
    if (lvl === this.level) return;
    this.level = lvl;
    const caps = this.caps();
    this.main.resize(caps.main);
    this.glow.resize(caps.glow);
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (!this.main) return;
    this.root.removeFromParent();
    this.main.dispose();
    this.glow.dispose();
    this.decals.dispose();
    this.skid.dispose();
    this.lights.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }

  // ─────────────────────────────── per frame ───────────────────────────────
  update(dt: number): void {
    if (!this.main) return;
    const cfg = CONFIG.fx;
    this.q = this.ctx.quality.current.particleScale ?? 1;
    this.gravity = CONFIG.physics.gravity;
    this.wind.set(cfg.wind[0], cfg.wind[1], cfg.wind[2]);
    this.time += dt;
    const u = this.u;
    u.uFxTime.value = this.time;
    u.uNearFade.value.set(cfg.nearFade[0], cfg.nearFade[1]);
    u.uDim.value = 1 + (cfg.nightDim - 1) * GLOBAL_UNIFORMS.uNight.value;
    const cam = this.ctx.engine.camera;
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

    this.updateWheels(dt);
    for (const f of this.fires) if (f.active) f.update(this, dt);
    for (const e of this.emitters) if (e.kind !== EmKind.None) e.update(this, dt);
    this.updateLights();

    this.decals.update(this.time);
    this.main.update(this.time);
    this.glow.update(this.time);
    this.skid.update(this.time);
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
      L.request(f.x, f.y, f.z, I, 1, 0.62 + 0.25 * e, 0.32 + 0.35 * e, f.dist);
    }
    for (const f of this.fires) {
      if (!f.active) continue;
      const I = f.glow(this.time);
      L.request(f.cur.x, f.cur.y + 0.8 * f.size, f.cur.z, I, 1, 0.5, 0.18, 16 * f.size);
    }
    L.end();
  }

  // ─────────────────────────────── wheels ───────────────────────────────
  private updateWheels(dt: number): void {
    const v = this.ctx.vehicle;
    const st = v?.state;
    const wheels = st?.wheels;
    if (!v || !v.active || !st || st.exploded || !wheels || wheels.length === 0 || dt <= 0) {
      this.skid.endAll();
      return;
    }
    const cfg = CONFIG.fx;
    const { s, wind } = this;
    const now = this.time;
    const vel = st.velocity;
    const speed = vel.length();
    const n = Math.min(8, wheels.length);
    for (let i = 0; i < n; i++) {
      const w = wheels[i];
      if (!w || !w.position || !w.contact) {
        this.skid.end(i);
        continue;
      }
      const slip = w.slip || 0;
      const surf: SurfaceMaterial = w.surface ?? 'asphalt';
      const paved = surf === 'asphalt' || surf === 'concrete';
      const p = w.position;
      const nrm = w.normal ?? UP;
      const th = cfg.skid.slipThreshold;
      if (paved && slip > th && (speed > 0.8 || slip > 0.6)) {
        this.skid.add(i, p, nrm, smooth(th, th + 0.3, slip), now);
      } else this.skid.end(i);

      if (paved && slip > cfg.tyreSmoke.slipThreshold) {
        const ts = cfg.tyreSmoke;
        const k = smooth(ts.slipThreshold, 1, slip);
        this.wheelAcc[i] += ts.rate * (0.25 + k) * this.q * dt;
        let m = Math.min(6, Math.floor(this.wheelAcc[i]));
        this.wheelAcc[i] -= m;
        while (m-- > 0) {
          s.reset();
          s.x = p.x + rndS() * 0.15;
          s.y = p.y + 0.18;
          s.z = p.z + rndS() * 0.15;
          s.delay = -Math.random() * dt;
          s.vx = vel.x * 0.3 + rndS() * 0.6;
          s.vy = rnd(0.25, 0.9);
          s.vz = vel.z * 0.3 + rndS() * 0.6;
          s.air(1.6, wind, 0.45);
          s.floor = p.y;
          s.life = rnd(ts.life[0], ts.life[1]);
          s.size0 = rnd(0.45, 0.7) * (ts.size[0] / 0.6);
          s.size1 = rnd(0.8, 1.1) * ts.size[1] * (0.65 + 0.5 * k);
          s.rot = rnd(0, 6.28);
          s.spin = rndS() * 0.6;
          s.turb = 0.3;
          s.cell = pick(CELL.WISP, CELL.SMOKE_A);
          s.ramp = RAMP.SMOKE_LIGHT;
          s.tint(1, 1, 1, 0.45 + 0.5 * k);
          this.main.emit(s, now);
        }
      } else if ((surf === 'sand' || surf === 'grass') && speed > cfg.dust.minSpeed) {
        const k = Math.min(1, speed / 20) * 0.75 + slip * 0.6;
        this.wheelAcc[i] += cfg.dust.rate * k * this.q * dt;
        let m = Math.min(6, Math.floor(this.wheelAcc[i]));
        this.wheelAcc[i] -= m;
        const col = this.color(surf === 'sand' ? cfg.dust.sand : cfg.dust.grass);
        while (m-- > 0) {
          s.reset();
          s.x = p.x + rndS() * 0.2;
          s.y = p.y + 0.12;
          s.z = p.z + rndS() * 0.2;
          s.delay = -Math.random() * dt;
          s.vx = vel.x * 0.2 + rndS() * 1.0;
          s.vy = rnd(0.6, 1.8) * (0.5 + 0.5 * k);
          s.vz = vel.z * 0.2 + rndS() * 1.0;
          s.air(1.8, wind, -0.35);
          s.floor = p.y;
          s.life = rnd(cfg.dust.life[0], cfg.dust.life[1]);
          s.size0 = rnd(0.8, 1.2) * cfg.dust.size[0];
          s.size1 = rnd(0.7, 1.05) * cfg.dust.size[1] * (0.6 + 0.6 * Math.min(1, k));
          s.rot = rnd(0, 6.28);
          s.spin = rndS() * 0.5;
          s.turb = 0.25;
          s.cell = pick(CELL.DUST, CELL.WISP);
          s.ramp = RAMP.DUST;
          s.tint(col.r, col.g, col.b, Math.min(1, 0.45 + 0.4 * k));
          this.main.emit(s, now);
          if (surf === 'grass' && Math.random() < 0.3) {
            s.reset();
            s.x = p.x;
            s.y = p.y + 0.1;
            s.z = p.z;
            s.vx = vel.x * 0.4 + rndS() * 2;
            s.vy = rnd(2, 4);
            s.vz = vel.z * 0.4 + rndS() * 2;
            s.air(1.2, wind, this.gravity * 0.6);
            s.floor = p.y + 0.02;
            s.life = rnd(1.0, 1.8);
            s.size0 = s.size1 = rnd(0.07, 0.12);
            s.rot = rnd(0, 6.28);
            s.spin = rndS() * 8;
            s.cell = CELL.LEAF;
            s.ramp = RAMP.SOLID;
            s.tint(0.28, rnd(0.45, 0.6), 0.2, 1);
            this.main.emit(s, now);
          }
        }
      } else if (surf === 'water' && speed > cfg.spray.minSpeed) {
        const k = Math.min(1, speed / 15);
        this.wheelAcc[i] += cfg.spray.rate * k * this.q * dt;
        let m = Math.min(8, Math.floor(this.wheelAcc[i]));
        this.wheelAcc[i] -= m;
        while (m-- > 0) {
          s.reset();
          s.x = p.x + rndS() * 0.2;
          s.y = p.y + 0.1;
          s.z = p.z + rndS() * 0.2;
          s.delay = -Math.random() * dt;
          s.vx = vel.x * 0.5 + rndS() * 1.6;
          s.vy = rnd(1.5, 3.5) * (0.5 + k);
          s.vz = vel.z * 0.5 + rndS() * 1.6;
          s.air(0.6, wind, this.gravity);
          s.floor = p.y - 0.2;
          s.life = rnd(0.6, 1.1);
          s.size0 = rnd(0.12, 0.22);
          s.size1 = rnd(0.5, 0.9);
          s.rot = rnd(0, 6.28);
          s.cell = Math.random() < 0.5 ? CELL.DROP : CELL.WISP;
          s.ramp = RAMP.WATER;
          this.main.emit(s, now);
        }
      }
    }
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

  flash(x: number, y: number, z: number, peak: number, decay: number, distance: number, delay = 0): void {
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
  }

  private freeEmitter(): CpuEmitter | null {
    for (const e of this.emitters) if (e.kind === EmKind.None) return e;
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
  private onExplosion(pos: THREE.Vector3, radius: number): void {
    if (!this.main) return;
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
    this.explosionEx({ position: pos, velocity: vel, radius: cfg.fireballRadius * scale, kind: 'car' });
  }

  explosion(pos: THREE.Vector3, scale: number): void {
    this.explosionEx({ position: pos, radius: CONFIG.fx.explosion.fireballRadius * Math.max(0.1, scale), kind: 'car' });
  }

  explosionEx(o: {
    position: THREE.Vector3;
    velocity?: THREE.Vector3;
    radius: number;
    kind?: 'car' | 'engine' | 'plane' | 'secondary' | 'impact';
    nearSurface?: 'ground' | 'water' | null;
    light?: boolean;
  }): void {
    if (!this.main) return;
    const p = o.position;
    const vel = o.velocity ?? ZERO;
    let surface: 'ground' | 'water' | null = o.nearSurface === undefined ? 'ground' : o.nearSurface;
    let surfaceY = this.ground(p.x, p.z);
    let mat: SurfaceMaterial = 'asphalt';
    try {
      mat = this.ctx.world.surfaceAt(p.x, p.z);
    } catch {
      /* world not ready */
    }
    if (o.nearSurface === undefined && mat === 'water') surface = 'water';
    if (surface === 'water') surfaceY = Math.max(surfaceY, CONFIG.world.waterLevel ?? 0);
    const dustCol = this.dustColorFor(mat);
    const opts: ExplosionOpts = {
      x: p.x,
      y: p.y,
      z: p.z,
      vx: vel.x,
      vy: vel.y,
      vz: vel.z,
      radius: o.radius,
      kind: o.kind ?? 'car',
      surface,
      surfaceY,
      light: o.light ?? true,
    };
    try {
      spawnExplosion(this, opts, this, dustCol);
    } catch (err) {
      reportError('[fx] explosion failed', err);
    }
  }

  private dustArr = [0.8, 0.76, 0.7];
  private dustColorFor(mat: SurfaceMaterial): number[] {
    const cfg = CONFIG.fx.dust;
    const c = this.color(mat === 'sand' ? cfg.sand : mat === 'grass' || mat === 'foliage' ? cfg.grass : cfg.other);
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

  attachTrail(target: THREE.Object3D, localOffset: THREE.Vector3, o: { fire: number; smoke: number; size: number }): TrailHandle {
    if (!this.main || !target) return { stop() {}, setIntensity() {} };
    const f = this.startFire(target, localOffset, o.fire, o.smoke, o.size, false);
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

  // ─────────────────────────────── one-shot effects ───────────────────────────────
  sparks(pos: THREE.Vector3, normal: THREE.Vector3, intensity: number, inherit?: THREE.Vector3): void {
    if (!this.main) return;
    const cfg = CONFIG.fx.sparks;
    const { s, wind } = this;
    const now = this.time;
    const k = Math.min(1.5, Math.max(0, intensity));
    _n.copy(normal);
    if (_n.lengthSq() < 0.01) _n.copy(UP);
    _n.normalize();
    const floor = this.ground(pos.x, pos.z) + 0.03;
    const iv = inherit ?? ZERO;
    const n = Math.max(3, count(cfg.impactCount * (0.3 + k), this.q, 120));
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
    if (!this.main) return;
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
    if (!this.main) return;
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
    if (!this.main) return;
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
    if (!this.main) return;
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
    if (!this.main) return;
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
    if (!this.main) return;
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
    if (!this.main) return;
    this.sparks(pos, UP, 0.5, this.vehicleVel(pos, 0.6));
    this.smoke(pos, 0.3);
  }

  // ─────────────────────────────── reset ───────────────────────────────
  clearAll(): void {
    if (!this.main) return;
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
    this.autoTarget = null;
    this.autoT = -1;
    this.wheelAcc.fill(0);
    this.scrapeAcc = 0;
  }

  /** Debug/testing snapshot (not part of IFx). */
  debugStats(): Record<string, number> {
    if (!this.main) return {};
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
    };
  }
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
