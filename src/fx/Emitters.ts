import * as THREE from 'three';
import { CONFIG } from '../config';
import { CELL, RAMP } from './textures';
import { type FxKit, pick, rnd, rndS } from './kit';

/**
 * Continuous emitters. All of them emit in WORLD space with sub-frame interpolation: the n particles spawned this
 * frame are spread along the segment prev→cur and get birth times spread over the frame (negative delay), so fast
 * emitters (tumbling wreck, 250 m/s burning engine) leave continuous ribbons instead of dotted puffs.
 */

const tmp = new THREE.Vector3();
const vtmp = new THREE.Vector3();

/** Fire + smoke (+ embers, glow) following an Object3D: burning wreck, burning engine/tail trail. */
export class FireEmitter {
  active = false;
  gen = 0;
  target: THREE.Object3D | null = null;
  readonly offset = new THREE.Vector3();
  fire = 1;
  smoke = 1;
  size = 1;
  auto = false;
  level = 0;
  stopping = false;
  age = 0;
  readonly cur = new THREE.Vector3();
  readonly prev = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  hasPrev = false;
  private accF = 0;
  private accS = 0;
  private accE = 0;
  private accG = 0;
  seed = Math.random() * 100;

  start(target: THREE.Object3D, offset: THREE.Vector3 | undefined, fire: number, smoke: number, size: number, auto: boolean): void {
    this.active = true;
    this.gen++;
    this.target = target;
    if (offset) this.offset.copy(offset);
    else this.offset.set(0, 0, 0);
    this.fire = fire;
    this.smoke = smoke;
    this.size = Math.max(0.1, size);
    this.auto = auto;
    this.level = 0;
    this.stopping = false;
    this.age = 0;
    this.hasPrev = false;
    this.vel.set(0, 0, 0);
    this.accF = this.accS = this.accE = this.accG = 0;
    this.seed = Math.random() * 100;
  }

  kill(): void {
    this.active = false;
    this.target = null;
    this.gen++;
  }

  /** Light request intensity this frame (0 if none). */
  glow(time: number): number {
    if (!this.active) return 0;
    const f = 0.78 + 0.14 * Math.sin(time * 13.1 + this.seed) + 0.08 * Math.sin(time * 31.7 + this.seed * 2.3);
    return CONFIG.fx.fire.glowIntensity * this.size * this.size * this.level * Math.min(1.5, this.fire) * f;
  }

  update(kit: FxKit, dt: number): void {
    const cfg = CONFIG.fx.fire;
    const t = this.target;
    if (!t) {
      this.kill();
      return;
    }
    if (!t.parent) this.stopping = true; // target removed from the scene → fade out
    t.updateWorldMatrix(true, false);
    tmp.copy(this.offset).applyMatrix4(t.matrixWorld);
    if (!this.hasPrev || tmp.distanceToSquared(this.cur) > 80 * 80) {
      this.cur.copy(tmp);
      this.prev.copy(tmp);
      this.vel.set(0, 0, 0);
      this.hasPrev = true;
    } else {
      this.prev.copy(this.cur);
      this.cur.copy(tmp);
      if (dt > 1e-5) {
        vtmp.subVectors(this.cur, this.prev).divideScalar(dt);
        this.vel.lerp(vtmp, 1 - Math.exp(-20 * dt));
      }
    }
    this.age += dt;
    if (this.stopping) {
      this.level -= dt / Math.max(0.05, cfg.fadeOut);
      if (this.level <= 0) {
        this.kill();
        return;
      }
    } else this.level = Math.min(1, this.level + dt / Math.max(0.05, cfg.fadeIn));
    if (dt <= 0) return;

    const S = this.size;
    const sq = Math.sqrt(S);
    const { s, wind } = kit;
    const now = kit.time;
    const relx = this.vel.x - wind.x;
    const rely = this.vel.y - wind.y;
    const relz = this.vel.z - wind.z;
    const speed = Math.hypot(relx, rely, relz);
    const moveBoost = 1 + speed / (5 * S); // distance-based emission so fast trails stay continuous
    const q = kit.q;
    const lv = this.level;
    const maxN = cfg.maxPerFrame;
    const dx = this.cur.x - this.prev.x;
    const dy = this.cur.y - this.prev.y;
    const dz = this.cur.z - this.prev.z;
    const spread = cfg.spread * S;
    const stretch = speed > 6 ? cfg.airStretch : 0;

    // flames (glow pool: drawn over the smoke)
    this.accF += cfg.flameRate * this.fire * lv * q * (0.6 + 0.4 * S) * moveBoost * dt;
    let n = Math.min(maxN, Math.floor(this.accF));
    this.accF -= n;
    for (let i = 0; i < n; i++) {
      const f = (i + Math.random()) / n;
      s.reset();
      s.x = this.prev.x + dx * f + rndS() * spread;
      s.y = this.prev.y + dy * f + rndS() * spread * 0.3;
      s.z = this.prev.z + dz * f + rndS() * spread;
      s.delay = -(1 - f) * dt;
      s.vx = this.vel.x * cfg.inheritFlame + rndS() * 0.35 * sq;
      s.vy = this.vel.y * cfg.inheritFlame + rnd(1.0, 2.2) * sq;
      s.vz = this.vel.z * cfg.inheritFlame + rndS() * 0.35 * sq;
      s.air(stretch > 0 ? 6 : 2.5, wind, 3.2 * sq);
      s.life = rnd(cfg.flameLife[0], cfg.flameLife[1]) * (0.8 + 0.2 * sq);
      s.size0 = rnd(cfg.flameSize[0], cfg.flameSize[1]) * S * (0.7 + 0.3 * lv);
      s.size1 = 0.3 * S;
      s.rot = rndS() * 0.35;
      s.spin = rndS() * 0.8;
      s.stretch = stretch;
      s.turb = 0.1 * S;
      s.heat = rnd(2.0, 3.0);
      s.cell = pick(CELL.FLAME_A, CELL.FLAME_B);
      s.ramp = RAMP.FLAME;
      kit.glow.emit(s, now);
    }

    // soft glow halo
    this.accG += 5 * lv * this.fire * dt;
    if (this.accG >= 1) {
      this.accG -= 1;
      s.reset().pos(this.cur);
      s.y += 0.3 * S;
      s.vx = this.vel.x * 0.9;
      s.vy = this.vel.y * 0.9;
      s.vz = this.vel.z * 0.9;
      s.air(3, wind, 0);
      s.size0 = 2.2 * S;
      s.size1 = 2.6 * S;
      s.life = 0.4;
      s.heat = 0.9;
      s.cell = CELL.GLOW;
      s.ramp = RAMP.FLASH;
      s.tint(1, 0.6, 0.3, 0.32 * Math.min(1, this.fire));
      kit.glow.emit(s, now);
    }

    // smoke (main pool)
    this.accS += cfg.smokeRate * this.smoke * lv * q * (0.6 + 0.4 * S) * moveBoost * dt;
    n = Math.min(maxN, Math.floor(this.accS));
    this.accS -= n;
    for (let i = 0; i < n; i++) {
      const f = (i + Math.random()) / n;
      s.reset();
      s.x = this.prev.x + dx * f + rndS() * spread;
      s.y = this.prev.y + dy * f + 0.6 * S;
      s.z = this.prev.z + dz * f + rndS() * spread;
      s.delay = -(1 - f) * dt;
      s.vx = this.vel.x * cfg.inheritSmoke + rndS() * 0.4;
      s.vy = this.vel.y * cfg.inheritSmoke + rnd(1.4, 2.6) * sq;
      s.vz = this.vel.z * cfg.inheritSmoke + rndS() * 0.4;
      s.air(0.9, wind, 0.9 * sq);
      s.life = rnd(cfg.smokeLife[0], cfg.smokeLife[1]) * (0.8 + 0.2 * sq);
      s.size0 = rnd(0.7, 1.1) * S;
      s.size1 = rnd(cfg.smokeSize[0], cfg.smokeSize[1]) * S;
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.3;
      s.turb = 0.3 * S;
      s.cell = pick(CELL.SMOKE_A, CELL.SMOKE_B);
      s.ramp = RAMP.FIRE_SMOKE;
      const v = rnd(0.85, 1.1);
      s.tint(v, v, v, 1);
      kit.main.emit(s, now);
    }

    // embers
    this.accE += cfg.emberRate * this.fire * lv * q * dt;
    n = Math.min(8, Math.floor(this.accE));
    this.accE -= n;
    for (let i = 0; i < n; i++) {
      const f = (i + Math.random()) / n;
      s.reset();
      s.x = this.prev.x + dx * f + rndS() * spread;
      s.y = this.prev.y + dy * f + 0.2 * S;
      s.z = this.prev.z + dz * f + rndS() * spread;
      s.delay = -(1 - f) * dt;
      s.vx = this.vel.x * 0.8 + rndS() * 1.2;
      s.vy = this.vel.y * 0.8 + rnd(1.5, 3.5) * sq;
      s.vz = this.vel.z * 0.8 + rndS() * 1.2;
      s.air(1.2, wind, 1.4);
      s.life = rnd(1.2, 2.2);
      s.size0 = s.size1 = rnd(0.06, 0.12) * sq;
      s.turb = 0.45;
      s.heat = 3;
      s.cell = CELL.STAR;
      s.ramp = RAMP.EMBER;
      s.rot = rnd(0, 6.28);
      kit.glow.emit(s, now);
    }
  }
}

export const EmKind = { None: 0, Streamer: 1, Column: 2, Geyser: 3 } as const;

/** Small CPU-integrated emitters (burning debris streamers, lingering smoke columns, hydrant geysers). */
export class CpuEmitter {
  kind: number = EmKind.None;
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  age = 0;
  life = 1;
  scale = 1;
  floor = -1e5;
  acc = 0;
  acc2 = 0;

  update(kit: FxKit, dt: number): void {
    if (this.kind === EmKind.Streamer) this.streamer(kit, dt);
    else if (this.kind === EmKind.Column) this.column(kit, dt);
    else if (this.kind === EmKind.Geyser) this.geyser(kit, dt);
  }

  private streamer(kit: FxKit, dt: number): void {
    const { s, wind } = kit;
    const now = kit.time;
    const px = this.x;
    const py = this.y;
    const pz = this.z;
    // integrate (semi-implicit, light drag)
    const drag = Math.exp(-0.35 * dt);
    this.vy += kit.gravity * dt;
    this.vx = (this.vx - wind.x) * drag + wind.x;
    this.vy *= drag;
    this.vz = (this.vz - wind.z) * drag + wind.z;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.z += this.vz * dt;
    this.age += dt;
    const hitGround = this.y < this.floor + 0.1;
    if (this.age >= this.life || hitGround) this.kind = EmKind.None;
    const lifeT = Math.min(1, this.age / this.life);
    const S = this.scale;
    const dx = this.x - px;
    const dy = this.y - py;
    const dz = this.z - pz;
    const dist = Math.hypot(dx, dy, dz);
    const spacing = 0.22 * Math.sqrt(S);
    this.acc += dist / spacing;
    const n = Math.min(14, Math.floor(this.acc));
    this.acc -= n;
    const fireAmt = 1 - lifeT * 0.85;
    for (let i = 0; i < n; i++) {
      const f = (i + Math.random()) / n;
      const x = px + dx * f;
      const y = py + dy * f;
      const z = pz + dz * f;
      const delay = -(1 - f) * dt;
      // flame bit
      if (Math.random() < 0.85) {
        s.reset();
        s.x = x;
        s.y = y;
        s.z = z;
        s.delay = delay;
        s.vx = this.vx * 0.15 + rndS() * 0.3;
        s.vy = this.vy * 0.15 + rnd(0.2, 0.8);
        s.vz = this.vz * 0.15 + rndS() * 0.3;
        s.air(3, wind, 2);
        s.life = rnd(0.25, 0.45);
        s.size0 = rnd(0.55, 0.9) * Math.sqrt(S) * fireAmt + 0.1;
        s.size1 = 0.15 * Math.sqrt(S);
        s.rot = rnd(0, 6.28);
        s.spin = rndS() * 2;
        s.heat = rnd(2.2, 3.2);
        s.cell = CELL.BILLOW;
        s.ramp = RAMP.FIREBALL;
        kit.glow.emit(s, now);
      }
      // smoke trail
      if (Math.random() < 0.7) {
        s.reset();
        s.x = x;
        s.y = y;
        s.z = z;
        s.delay = delay;
        s.vx = this.vx * 0.08 + rndS() * 0.3;
        s.vy = this.vy * 0.08 + rnd(0.3, 0.9);
        s.vz = this.vz * 0.08 + rndS() * 0.3;
        s.air(1.2, wind, 0.6);
        s.life = rnd(1.4, 2.6);
        s.size0 = rnd(0.35, 0.55) * Math.sqrt(S);
        s.size1 = rnd(1.6, 2.4) * Math.sqrt(S);
        s.rot = rnd(0, 6.28);
        s.spin = rndS() * 0.4;
        s.turb = 0.2;
        s.cell = pick(CELL.SMOKE_A, CELL.WISP);
        s.ramp = RAMP.FIRE_SMOKE;
        kit.main.emit(s, now);
      }
    }
  }

  private column(kit: FxKit, dt: number): void {
    const cfg = CONFIG.fx.explosion;
    const { s, wind } = kit;
    this.age += dt;
    if (this.age >= this.life) {
      this.kind = EmKind.None;
      return;
    }
    const t = this.age / this.life;
    const S = this.scale;
    // starts after the fireball has risen, peaks early, decays
    const env = Math.min(1, this.age / 0.8) * (1 - t);
    this.acc += cfg.columnRate * env * Math.sqrt(S) * kit.q * dt;
    const n = Math.min(4, Math.floor(this.acc));
    this.acc -= n;
    for (let i = 0; i < n; i++) {
      s.reset();
      const a = Math.random() * 6.28;
      const r = Math.random() * 1.4 * S;
      s.x = this.x + Math.cos(a) * r;
      s.y = this.y + rnd(0.3, 1.0) * S;
      s.z = this.z + Math.sin(a) * r;
      s.delay = -Math.random() * dt;
      s.vx = rndS() * 0.5;
      s.vy = rnd(2.2, 3.6) * Math.sqrt(S);
      s.vz = rndS() * 0.5;
      s.air(0.45, wind, 0.5 * Math.sqrt(S));
      s.life = rnd(5, 8) * Math.pow(S, 0.3);
      s.size0 = rnd(1.4, 2.2) * S;
      s.size1 = rnd(6, 9) * S;
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.2;
      s.turb = 0.6 * S;
      s.cell = pick(CELL.SMOKE_A, CELL.SMOKE_B);
      s.ramp = RAMP.COLUMN;
      const v = rnd(0.85, 1.1);
      s.tint(v, v, v, 0.9);
      kit.main.emit(s, kit.time);
    }
  }

  private geyser(kit: FxKit, dt: number): void {
    const { s, wind } = kit;
    this.age += dt;
    if (this.age >= this.life) {
      this.kind = EmKind.None;
      return;
    }
    const env = 1 - Math.pow(this.age / this.life, 3);
    this.acc += 70 * env * kit.q * dt;
    const n = Math.min(10, Math.floor(this.acc));
    this.acc -= n;
    for (let i = 0; i < n; i++) {
      s.reset();
      s.x = this.x + rndS() * 0.05;
      s.y = this.y + 0.5;
      s.z = this.z + rndS() * 0.05;
      s.delay = -Math.random() * dt;
      s.vx = rndS() * 1.2;
      s.vy = rnd(7, 10) * env + 2;
      s.vz = rndS() * 1.2;
      s.air(0.3, wind, kit.gravity);
      s.floor = this.floor;
      s.life = rnd(1.2, 1.8);
      s.size0 = rnd(0.12, 0.2);
      s.size1 = rnd(0.5, 0.9);
      s.rot = rnd(0, 6.28);
      s.cell = Math.random() < 0.5 ? CELL.DROP : CELL.WISP;
      s.ramp = RAMP.WATER;
      kit.main.emit(s, kit.time);
    }
  }
}
