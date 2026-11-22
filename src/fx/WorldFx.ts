import * as THREE from 'three';
import { CONFIG } from '../config';
import { CELL, RAMP } from './textures';
import { type FxKit, count, pick, randDir, rnd, rndS } from './kit';

/**
 * One-shot world effects for planes / crashes / water (SPEC-PART2 §7, §8, §11, §12). All momentum-aware: they take
 * the source velocity and particles drag toward the wind. Sizes come from the caller's size/radius parameter.
 */

const _d = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Water impact: plume (height ~ speed²), crown of droplets, mist, splash ring + foam patch. */
export function splash(kit: FxKit, pos: THREE.Vector3, vel: THREE.Vector3, size: number, waterY: number): void {
  const { s, wind } = kit;
  const g = kit.gravity;
  const now = kit.time;
  const S = Math.max(0.3, size);
  const sc = S / 4;
  const speed = vel.length();
  const h = Math.min(90, Math.max(1.2, (speed * speed) / 70)) * Math.min(2.5, Math.max(0.35, Math.sqrt(sc)));
  const vUp = Math.sqrt(2 * Math.abs(g) * h);
  const cs = kit.q * Math.pow(Math.max(0.25, sc), 0.55) * Math.min(2, 0.6 + speed / 60);
  const cap = Math.floor(kit.main.capacity * 0.25);
  const hx = vel.x * 0.25;
  const hz = vel.z * 0.25;
  const air = Math.max(1, vUp * 2 / Math.abs(g));

  // plume: tall column of spray (water sheets + droplets)
  const nPlume = count(46, cs, cap);
  for (let i = 0; i < nPlume; i++) {
    randDir(_d);
    s.reset();
    s.x = pos.x + _d.x * 0.25 * S;
    s.y = waterY + 0.1;
    s.z = pos.z + _d.z * 0.25 * S;
    const up = vUp * rnd(0.45, 1.0);
    s.vx = hx + _d.x * vUp * 0.18;
    s.vy = up;
    s.vz = hz + _d.z * vUp * 0.18;
    s.air(0.45, wind, g);
    s.floor = waterY - 0.2;
    s.life = air * rnd(0.75, 1.05) + 0.4;
    s.size0 = rnd(0.25, 0.4) * S;
    s.size1 = rnd(1.0, 1.7) * S;
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 0.6;
    s.turb = 0.05 * S;
    s.cell = pick(CELL.WISP, CELL.DUST);
    s.ramp = RAMP.WATER;
    kit.main.emit(s, now);
  }
  // crown: droplets thrown out in a ring
  const nCrown = count(40, cs, cap);
  for (let i = 0; i < nCrown; i++) {
    const a = (i / Math.max(1, nCrown)) * 6.283 + rnd(-0.1, 0.1);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    s.reset();
    s.x = pos.x + ca * 0.45 * S;
    s.y = waterY + 0.1;
    s.z = pos.z + sa * 0.45 * S;
    const out = vUp * rnd(0.25, 0.5);
    s.vx = hx + ca * out;
    s.vy = vUp * rnd(0.3, 0.65);
    s.vz = hz + sa * out;
    s.air(0.3, wind, g);
    s.floor = waterY - 0.1;
    s.life = air * 0.6 + 0.3;
    s.size0 = s.size1 = rnd(0.12, 0.3) * Math.sqrt(S);
    s.rot = rnd(0, 6.28);
    s.cell = CELL.DROP;
    s.ramp = RAMP.WATER;
    kit.main.emit(s, now);
  }
  // low rolling mist
  const nMist = count(10, cs, cap);
  for (let i = 0; i < nMist; i++) {
    randDir(_d);
    s.reset();
    s.x = pos.x + _d.x * 0.5 * S;
    s.y = waterY + 0.3 * S;
    s.z = pos.z + _d.z * 0.5 * S;
    s.vx = hx * 0.6 + _d.x * 0.6 * S;
    s.vy = rnd(0.2, 0.8) * Math.sqrt(S);
    s.vz = hz * 0.6 + _d.z * 0.6 * S;
    s.air(1.2, wind, 0.1);
    s.floor = waterY;
    s.life = rnd(2.5, 4.5) * Math.pow(Math.max(1, sc), 0.3);
    s.size0 = 0.6 * S;
    s.size1 = rnd(2.2, 3.2) * S;
    s.delay = rnd(0.05, 0.3);
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 0.2;
    s.cell = pick(CELL.SMOKE_A, CELL.WISP);
    s.ramp = RAMP.MIST;
    kit.main.emit(s, now);
  }
  // expanding splash ring + lingering foam patch on the surface
  s.reset();
  s.x = pos.x;
  s.y = waterY + 0.06;
  s.z = pos.z;
  s.floor = waterY + 0.06;
  s.stretch = -1;
  s.cell = CELL.RING;
  s.ramp = RAMP.FOAM;
  s.size0 = 0.6 * S;
  s.size1 = 5 * S * Math.min(2, 0.6 + speed / 50);
  s.life = 2.2;
  s.rot = rnd(0, 6.28);
  kit.main.emit(s, now);
  foam(kit, pos.x, waterY, pos.z, 2.2 * S, CONFIG.fx.water.foamLife);
}

export function foam(kit: FxKit, x: number, y: number, z: number, size: number, life: number): void {
  const { s } = kit;
  s.reset();
  s.x = x;
  s.y = y + 0.05;
  s.z = z;
  s.floor = y + 0.05;
  s.stretch = -1;
  s.cell = CELL.DUST;
  s.ramp = RAMP.FOAM;
  s.size0 = size * 0.7;
  s.size1 = size * 1.25;
  s.life = life;
  s.rot = rnd(0, 6.28);
  s.tint(1, 1, 1, 0.9);
  kit.decals.emit(s, kit.time);
}

/** Continuous spray sheet thrown sideways/back by a skimming object (call per frame). */
export function spraySheet(kit: FxKit, pos: THREE.Vector3, vel: THREE.Vector3, intensity: number, acc: { v: number }): void {
  const { s, wind } = kit;
  const g = kit.gravity;
  const k = Math.min(3, Math.max(0, intensity));
  acc.v += CONFIG.fx.water.sheetRate * k * kit.q * kit.dt;
  let n = Math.min(40, Math.floor(acc.v));
  acc.v -= n;
  if (n <= 0) return;
  const hs = Math.hypot(vel.x, vel.z) || 1;
  const fx = vel.x / hs;
  const fz = vel.z / hs;
  while (n-- > 0) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const out = rnd(3, 9) * (0.4 + 0.6 * k);
    s.reset().pos(pos);
    s.x += rndS() * 0.5;
    s.z += rndS() * 0.5;
    s.delay = -Math.random() * kit.dt;
    s.vx = vel.x * 0.35 + -fz * side * out;
    s.vy = rnd(2.5, 7) * (0.4 + 0.6 * k);
    s.vz = vel.z * 0.35 + fx * side * out;
    s.air(0.7, wind, g);
    s.floor = pos.y - 0.2;
    s.life = rnd(0.7, 1.3);
    s.size0 = rnd(0.25, 0.45);
    s.size1 = rnd(1.2, 2.2) * (0.6 + 0.4 * k);
    s.rot = rnd(0, 6.28);
    s.spin = rndS();
    s.cell = Math.random() < 0.35 ? CELL.DROP : CELL.WISP;
    s.ramp = RAMP.WATER;
    kit.main.emit(s, kit.time);
  }
}

export function steam(kit: FxKit, pos: THREE.Vector3, size: number): void {
  const { s, wind } = kit;
  const S = Math.max(0.3, size);
  const n = Math.max(1, count(10, kit.q * Math.pow(S, 0.5), 80));
  for (let i = 0; i < n; i++) {
    s.reset().pos(pos);
    s.x += rndS() * 0.5 * S;
    s.z += rndS() * 0.5 * S;
    s.vx = rndS() * 0.6;
    s.vy = rnd(1.8, 3.6) * Math.sqrt(S);
    s.vz = rndS() * 0.6;
    s.air(0.8, wind, 1.4 * Math.sqrt(S));
    s.life = rnd(2, 3.5);
    s.delay = rnd(0, 0.4);
    s.size0 = 0.4 * S;
    s.size1 = rnd(2.2, 3.2) * S;
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 0.4;
    s.turb = 0.3 * S;
    s.cell = pick(CELL.SMOKE_A, CELL.SMOKE_B);
    s.ramp = RAMP.STEAM;
    kit.main.emit(s, kit.time);
  }
}

/** Bubbles breaking the surface over a sinking piece. */
export function bubbles(kit: FxKit, pos: THREE.Vector3, size: number, waterY: number): void {
  const { s } = kit;
  const S = Math.max(0.2, size);
  const n = Math.max(1, count(5, kit.q * Math.sqrt(S), 30));
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(Math.random()) * 0.6 * S;
    const a = Math.random() * 6.283;
    s.reset();
    s.x = pos.x + Math.cos(a) * r;
    s.y = waterY + 0.02;
    s.z = pos.z + Math.sin(a) * r;
    s.vy = rnd(0.1, 0.35);
    s.life = rnd(0.35, 0.9);
    s.delay = rnd(0, 0.5);
    s.size0 = rnd(0.08, 0.2) * Math.sqrt(S);
    s.size1 = s.size0 * 1.5;
    s.cell = CELL.DROP;
    s.ramp = RAMP.FOAM;
    kit.main.emit(s, kit.time);
    if (i % 2 === 0) {
      s.vy = 0;
      s.y = waterY + 0.04;
      s.floor = waterY + 0.04;
      s.stretch = -1;
      s.cell = CELL.RING;
      s.size0 = 0.1 * Math.sqrt(S);
      s.size1 = 0.8 * Math.sqrt(S);
      s.life = rnd(0.6, 1.0);
      kit.main.emit(s, kit.time);
    }
  }
}

/** White depressurization mist puff carried by the airflow. */
export function mist(kit: FxKit, pos: THREE.Vector3, vel: THREE.Vector3, size: number): void {
  const { s, wind } = kit;
  const S = Math.max(0.3, size);
  const n = Math.max(2, count(14, kit.q * Math.pow(S, 0.5), 80));
  for (let i = 0; i < n; i++) {
    randDir(_d);
    s.reset().pos(pos);
    s.vx = vel.x * 0.8 + _d.x * 2.5 * S;
    s.vy = vel.y * 0.8 + _d.y * 2.5 * S;
    s.vz = vel.z * 0.8 + _d.z * 2.5 * S;
    s.air(2.2, wind, 0);
    s.life = rnd(1.0, 1.9);
    s.size0 = 0.3 * S;
    s.size1 = rnd(2.0, 3.0) * S;
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 0.8;
    s.turb = 0.15 * S;
    s.cell = pick(CELL.WISP, CELL.SMOKE_B);
    s.ramp = RAMP.MIST;
    kit.main.emit(s, kit.time);
  }
}

const DEBRIS_TINT: Record<string, number[]> = {
  metal: [0.58, 0.6, 0.64],
  panel: [0.88, 0.88, 0.9],
  paper: [0.96, 0.95, 0.9],
  cushion: [0.32, 0.4, 0.62],
};

/** Small non-colliding fragments inheriting the source velocity (fan blades, cowling, panels, paper, cushions). */
export function debrisBurst(
  kit: FxKit,
  o: { position: THREE.Vector3; velocity: THREE.Vector3; count: number; size: number; kind?: 'metal' | 'panel' | 'paper' | 'cushion' },
): void {
  const { s, wind } = kit;
  const kind = o.kind ?? 'metal';
  const tint = DEBRIS_TINT[kind] ?? DEBRIS_TINT.metal;
  const S = Math.max(0.05, o.size);
  const paper = kind === 'paper';
  const floor = kit.ground(o.position.x, o.position.z);
  const nearGround = o.position.y - floor < 60;
  const n = Math.max(1, count(o.count, Math.max(0.5, kit.q), 300));
  const v = o.velocity;
  for (let i = 0; i < n; i++) {
    randDir(_d);
    const kick = rnd(3, 12) * (paper ? 0.6 : 1) * Math.min(3, 0.6 + Math.sqrt(S));
    s.reset().pos(o.position);
    s.vx = v.x + _d.x * kick;
    s.vy = v.y + _d.y * kick + 2;
    s.vz = v.z + _d.z * kick;
    if (paper) {
      s.air(2.4, wind, kit.gravity * 0.3);
      s.turb = 0.9;
      s.life = rnd(6, 10);
      s.spin = rndS() * 9;
    } else {
      s.air(kind === 'cushion' ? 0.9 : 0.15, wind, kit.gravity);
      s.life = rnd(3, 6);
      s.spin = rndS() * 15;
    }
    s.floor = nearGround ? floor + 0.04 : -1e5;
    s.size0 = s.size1 = S * rnd(0.5, 1.2);
    s.rot = rnd(0, 6.28);
    s.cell = paper ? CELL.LEAF : kind === 'panel' ? pick(CELL.CHIP, CELL.SHARD) : kind === 'cushion' ? CELL.CHIP : pick(CELL.SHARD, CELL.CHIP);
    s.ramp = RAMP.SOLID;
    const sh = rnd(0.75, 1.1);
    s.tint(tint[0] * sh, tint[1] * sh, tint[2] * sh, 1);
    kit.main.emit(s, kit.time);
  }
}

/** Scorch decal on any surface (facades): oriented by the normal. */
export function scorch(kit: FxKit, pos: THREE.Vector3, normal: THREE.Vector3, size: number): void {
  const { s } = kit;
  _p.copy(normal);
  if (_p.lengthSq() < 1e-4) _p.set(0, 1, 0);
  _p.normalize();
  s.reset();
  s.x = pos.x + _p.x * 0.06;
  s.y = pos.y + _p.y * 0.06;
  s.z = pos.z + _p.z * 0.06;
  s.vx = _p.x;
  s.vy = _p.y;
  s.vz = _p.z;
  s.stretch = -2;
  s.cell = CELL.SCORCH;
  s.ramp = RAMP.SCORCH;
  s.size0 = s.size1 = Math.max(0.3, size) * rnd(0.9, 1.1);
  s.life = CONFIG.fx.explosion.scorchLife * 1.5;
  s.rot = rnd(0, 6.28);
  s.tint(0.05, 0.045, 0.04, 0.9);
  kit.decals.emit(s, kit.time);
}
