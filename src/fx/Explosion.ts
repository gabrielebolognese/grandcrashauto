import * as THREE from 'three';
import { CONFIG } from '../config';
import { CELL, RAMP } from './textures';
import { type FxKit, count, pick, randDir, randInBall, rnd, rndS } from './kit';

/**
 * The signature moment. A momentum-correct, radius-scaled explosion (car fireball ~6 m … jumbo ~70 m):
 * flash (core sprite + star flare + light spike) → optically-thick fireball puffs on a blackbody ramp rolling up on
 * buoyancy → shock dome + ground dust ring → sparks, burning streamers, debris chips, embers → smoke + scorch.
 * Every particle inherits the source velocity (fireball 90 %, smoke 60 %, sparks/debris 100 %) and drags toward
 * the wind, so moving explosions become streaking comets.
 */

export interface ExplosionOpts {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Fireball radius in m. */
  radius: number;
  kind: 'car' | 'engine' | 'plane' | 'secondary' | 'impact';
  /** Surface below (for rings/scorch), resolved by the caller. */
  surface: 'ground' | 'water' | null;
  surfaceY: number;
  light: boolean;
}

export interface StreamerSink {
  addStreamer(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, scale: number, floor: number): void;
  addColumn(x: number, y: number, z: number, scale: number, seconds: number): void;
}

const tmp = new THREE.Vector3();
const dir = new THREE.Vector3();
const DUST_ASPHALT = [0.8, 0.76, 0.7];

export function spawnExplosion(kit: FxKit, o: ExplosionOpts, sink: StreamerSink, dustColor?: number[]): void {
  const cfg = CONFIG.fx.explosion;
  const { s, wind } = kit;
  const g = kit.gravity;
  const R = Math.max(0.5, o.radius);
  const sc = R / 6; // relative to a car fireball
  const q = kit.q;
  const cs = q * Math.pow(sc, 0.6); // count scale
  const ls = Math.pow(sc, 0.3); // life scale
  const inh = cfg.inherit;
  const now = kit.time;
  const near = o.surface !== null && o.y - o.surfaceY < cfg.groundMaxHeight * R;
  const floorY = o.surface === 'ground' && o.y - o.surfaceY < R * 3 ? o.surfaceY : -1e5;
  const glowCap = Math.floor(kit.glow.capacity * 0.22);
  const mainCap = Math.floor(kit.main.capacity * 0.22);
  const small = o.kind === 'secondary' || o.kind === 'engine';

  // ── 1. flash: light spike, white-hot core, star flare ──
  if (o.light) kit.flash(o.x, o.y + 0.3 * R, o.z, cfg.flashIntensity * sc * sc * (small ? 0.5 : 1), cfg.flashDecay / Math.sqrt(ls), cfg.flashDistance * R);

  s.reset().pos(o);
  s.vx = o.vx * 0.95;
  s.vy = o.vy * 0.95;
  s.vz = o.vz * 0.95;
  s.air(2, wind, 0);
  s.cell = CELL.GLOW;
  s.ramp = RAMP.FLASH;
  s.size0 = 3.4 * R;
  s.size1 = 4.0 * R;
  s.life = 0.16 * ls;
  s.heat = 3;
  s.tint(1, 0.85, 0.6, 0.85);
  kit.glow.emit(s, now);

  s.cell = CELL.STAR;
  s.size0 = 4.2 * R;
  s.size1 = 2.0 * R;
  s.life = 0.14 * ls;
  s.heat = 5;
  s.rot = rnd(0, Math.PI);
  s.tint(1, 0.92, 0.8, 0.85);
  kit.glow.emit(s, now);

  for (let i = 0; i < 2; i++) {
    s.reset().pos(o);
    s.vx = o.vx * 0.95;
    s.vy = o.vy * 0.95;
    s.vz = o.vz * 0.95;
    s.air(3, wind, 0.6 * R);
    s.cell = CELL.BILLOW;
    s.ramp = RAMP.HOTCORE;
    s.size0 = rnd(0.4, 0.5) * R;
    s.size1 = rnd(0.8, 0.95) * R;
    s.life = rnd(0.18, 0.26) * ls;
    s.heat = 3;
    s.rot = rnd(0, 6.28);
    s.spin = rndS();
    kit.glow.emit(s, now);
  }

  // ── 2. fireball: optically thick puffs on the blackbody ramp ──
  const nFire = count(cfg.counts.fireball, cs * (small ? 0.5 : 1), glowCap);
  const lift = cfg.fireballLift * Math.pow(R, 0.75);
  for (let i = 0; i < nFire; i++) {
    randDir(dir);
    dir.y = Math.abs(dir.y) * 0.85 + 0.12;
    dir.normalize();
    const r0 = rnd(0, 0.32) * R;
    const sp = rnd(0.45, 1.15) * cfg.fireballSpeed * R;
    s.reset();
    s.x = o.x + dir.x * r0;
    s.y = o.y + dir.y * r0 * 0.6;
    s.z = o.z + dir.z * r0;
    s.vx = o.vx * inh.fireball + dir.x * sp;
    s.vy = o.vy * inh.fireball + dir.y * sp;
    s.vz = o.vz * inh.fireball + dir.z * sp;
    s.air(cfg.fireballDrag, wind, lift);
    s.floor = floorY;
    s.size0 = rnd(0.32, 0.5) * R;
    s.size1 = rnd(0.85, 1.25) * R;
    s.life = rnd(cfg.fireballLife[0], cfg.fireballLife[1]) * ls;
    s.delay = rnd(0, 0.07) * ls;
    s.heat = rnd(cfg.fireballHeat[0], cfg.fireballHeat[1]);
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 0.7;
    s.turb = 0.06 * R;
    s.cell = Math.random() < 0.6 ? CELL.BILLOW : pick(CELL.SMOKE_A, CELL.SMOKE_B);
    s.ramp = RAMP.FIREBALL;
    const v = rnd(0.9, 1.05);
    s.tint(v, v, v, 1);
    kit.glow.emit(s, now);
  }

  // secondary pops (car): two smaller delayed bursts around the wreck
  if (o.kind === 'car') {
    for (let b = 0; b < cfg.counts.secondary; b++) {
      const delay = 0.2 + b * 0.28 + rnd(0, 0.08);
      randDir(tmp);
      tmp.y = Math.abs(tmp.y);
      const bx = o.x + tmp.x * 0.7 * R;
      const by = o.y + tmp.y * 0.5 * R;
      const bz = o.z + tmp.z * 0.7 * R;
      if (o.light) kit.flash(bx, by, bz, cfg.flashIntensity * 0.25 * sc * sc, cfg.flashDecay * 1.6, cfg.flashDistance * R * 0.6, delay);
      const n = count(8, q * Math.pow(sc, 0.5));
      for (let i = 0; i < n; i++) {
        randDir(dir);
        dir.y = Math.abs(dir.y) * 0.7 + 0.2;
        const sp = rnd(0.5, 1.1) * cfg.fireballSpeed * R * 0.55;
        s.reset();
        s.x = bx;
        s.y = by;
        s.z = bz;
        s.vx = o.vx * inh.fireball + dir.x * sp;
        s.vy = o.vy * inh.fireball + dir.y * sp;
        s.vz = o.vz * inh.fireball + dir.z * sp;
        s.air(cfg.fireballDrag, wind, lift * 0.8);
        s.floor = floorY;
        s.size0 = rnd(0.2, 0.3) * R;
        s.size1 = rnd(0.5, 0.75) * R;
        s.life = rnd(0.7, 1.2) * ls;
        s.delay = delay + rnd(0, 0.04);
        s.heat = rnd(2.4, 3.4);
        s.rot = rnd(0, 6.28);
        s.spin = rndS();
        s.cell = CELL.BILLOW;
        s.ramp = RAMP.FIREBALL;
        kit.glow.emit(s, now);
      }
    }
  }

  // ── 3. shock dome (camera-facing ring = sphere silhouette) ──
  s.reset().pos(o);
  s.vx = o.vx;
  s.vy = o.vy;
  s.vz = o.vz;
  s.air(1.5, wind, 0);
  s.cell = CELL.RING;
  s.ramp = RAMP.SHOCK;
  s.size0 = 0.5 * R;
  s.size1 = cfg.shockGrow * 2 * R;
  s.life = cfg.shockLife * ls;
  s.heat = 1.1;
  const domeA = 1 / (1 + R / 15);
  s.tint(1, 0.94, 0.86, 0.55 * domeA);
  kit.glow.emit(s, now);
  s.size0 = 0.8 * R;
  s.size1 = cfg.shockGrow * 3.2 * R;
  s.life = cfg.shockLife * 1.8 * ls;
  s.heat = 0.7;
  s.tint(1, 0.95, 0.9, 0.2 * domeA);
  kit.glow.emit(s, now);

  // ── 4. ground: dust ring, radial dust, scorch, smoke column ──
  const dc = dustColor ?? DUST_ASPHALT;
  if (near && o.surface === 'ground') {
    const gy = o.surfaceY;
    s.reset();
    s.x = o.x;
    s.y = gy + 0.1;
    s.z = o.z;
    s.floor = gy + 0.1;
    s.stretch = -1;
    s.cell = CELL.RING;
    s.ramp = RAMP.RING_DUST;
    s.size0 = 0.9 * R;
    s.size1 = cfg.ringGrow * 2 * R;
    s.life = cfg.ringLife * ls;
    s.rot = rnd(0, 6.28);
    s.tint(dc[0], dc[1], dc[2], 0.95);
    kit.main.emit(s, now);

    const nDust = count(cfg.counts.dust, cs * (small ? 0.4 : 1), mainCap);
    for (let i = 0; i < nDust; i++) {
      const a = (i / Math.max(1, nDust)) * Math.PI * 2 + rnd(-0.1, 0.1);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const sp = rnd(2.0, 3.3) * R;
      s.reset();
      s.x = o.x + ca * 0.5 * R;
      s.y = gy + rnd(0.2, 0.6) * Math.sqrt(sc);
      s.z = o.z + sa * 0.5 * R;
      s.vx = ca * sp + o.vx * 0.5;
      s.vy = rnd(0.2, 1.2) * Math.sqrt(sc);
      s.vz = sa * sp + o.vz * 0.5;
      s.air(2.5, wind, -0.5);
      s.floor = gy;
      s.size0 = rnd(0.22, 0.32) * R;
      s.size1 = rnd(0.65, 0.95) * R;
      s.life = rnd(1.6, 3.0) * ls;
      s.delay = rnd(0, 0.05);
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.5;
      s.turb = 0.04 * R;
      s.cell = pick(CELL.DUST, CELL.SMOKE_B);
      s.ramp = RAMP.DUST;
      const v = rnd(0.9, 1.08);
      s.tint(dc[0] * v, dc[1] * v, dc[2] * v, 0.9);
      kit.main.emit(s, now);
    }

    if (!small) {
      s.reset();
      s.x = o.x + o.vx * 0.05;
      s.y = gy + 0.035;
      s.z = o.z + o.vz * 0.05;
      s.floor = gy + 0.035;
      s.stretch = -1;
      s.cell = CELL.SCORCH;
      s.ramp = RAMP.SCORCH;
      s.size0 = s.size1 = cfg.scorchSize * R * rnd(0.9, 1.1);
      s.life = cfg.scorchLife;
      s.rot = rnd(0, 6.28);
      s.tint(0.045, 0.04, 0.038, 0.92);
      kit.decals.emit(s, now);
      if (Math.hypot(o.vx, o.vz) < 8) sink.addColumn(o.x, gy, o.z, sc, cfg.columnSeconds * ls);
    }
  } else if (near && o.surface === 'water') {
    // basic spray ring (part 2 extends this)
    const wy = o.surfaceY;
    const n = count(cfg.counts.dust * 1.2, cs, mainCap);
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const sp = rnd(1.2, 2.4) * R;
      s.reset();
      s.x = o.x + Math.cos(a) * 0.4 * R;
      s.y = wy + 0.2;
      s.z = o.z + Math.sin(a) * 0.4 * R;
      s.vx = Math.cos(a) * sp;
      s.vy = rnd(0.6, 1.6) * R;
      s.vz = Math.sin(a) * sp;
      s.air(1.2, wind, g);
      s.floor = wy;
      s.size0 = rnd(0.15, 0.25) * R;
      s.size1 = rnd(0.5, 0.8) * R;
      s.life = rnd(1.2, 2.2) * ls;
      s.rot = rnd(0, 6.28);
      s.cell = pick(CELL.WISP, CELL.DUST);
      s.ramp = RAMP.WATER;
      kit.main.emit(s, now);
    }
  }

  // ── 5. smoke: lingering dark billows (drawn under the fireball) ──
  const nSmoke = count(cfg.counts.smoke, cs * (small ? 0.5 : 1), mainCap);
  for (let i = 0; i < nSmoke; i++) {
    randInBall(tmp, 0.45 * R);
    randDir(dir);
    dir.y = Math.abs(dir.y) * 0.6 + 0.2;
    const sp = rnd(0.3, 0.9) * R;
    s.reset();
    s.x = o.x + tmp.x;
    s.y = o.y + Math.abs(tmp.y) * 0.6;
    s.z = o.z + tmp.z;
    s.vx = o.vx * inh.smoke + dir.x * sp;
    s.vy = o.vy * inh.smoke + dir.y * sp + 0.3 * R;
    s.vz = o.vz * inh.smoke + dir.z * sp;
    s.air(1.3, wind, 1.0 * Math.pow(R, 0.75));
    s.floor = floorY;
    s.size0 = rnd(0.45, 0.65) * R;
    s.size1 = rnd(1.3, 1.9) * R;
    s.life = rnd(cfg.smokeLife[0], cfg.smokeLife[1]) * ls;
    s.delay = rnd(0.1, 0.45) * ls;
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 0.25;
    s.turb = 0.1 * R;
    s.cell = pick(CELL.SMOKE_A, CELL.SMOKE_B);
    s.ramp = RAMP.SMOKE_DARK;
    kit.main.emit(s, now);
  }

  // ── 6. sparks: velocity-stretched streaks with gravity ──
  const nSpark = count(cfg.counts.sparks, cs, glowCap);
  const ss = Math.pow(sc, 0.4);
  for (let i = 0; i < nSpark; i++) {
    randDir(dir);
    dir.y = Math.abs(dir.y) * 0.9 + 0.1;
    dir.normalize();
    const sp = rnd(cfg.sparkSpeed[0], cfg.sparkSpeed[1]) * ss;
    s.reset();
    s.x = o.x + dir.x * 0.3 * R;
    s.y = o.y + dir.y * 0.2 * R;
    s.z = o.z + dir.z * 0.3 * R;
    s.vx = o.vx * inh.sparks + dir.x * sp;
    s.vy = o.vy * inh.sparks + dir.y * sp;
    s.vz = o.vz * inh.sparks + dir.z * sp;
    s.air(0.5, wind, g);
    s.floor = floorY + 0.03;
    s.size0 = s.size1 = rnd(0.05, 0.1) * Math.pow(sc, 0.3);
    s.life = rnd(0.6, 1.6) * ls;
    s.delay = rnd(0, 0.04);
    s.stretch = 0.045;
    s.heat = rnd(2.5, 4.5);
    s.cell = CELL.SPARK;
    s.ramp = RAMP.SPARK;
    kit.glow.emit(s, now);
  }

  // ── 7. debris chips: tumbling charred bits that land and slide ──
  const nDeb = count(cfg.counts.debris, cs * (small ? 0.5 : 1), mainCap);
  for (let i = 0; i < nDeb; i++) {
    randDir(dir);
    dir.y = Math.abs(dir.y) * 0.8 + 0.25;
    dir.normalize();
    const sp = rnd(cfg.debrisSpeed[0], cfg.debrisSpeed[1]) * ss;
    s.reset();
    s.x = o.x + dir.x * 0.25 * R;
    s.y = o.y + dir.y * 0.15 * R;
    s.z = o.z + dir.z * 0.25 * R;
    s.vx = o.vx * inh.debris + dir.x * sp;
    s.vy = o.vy * inh.debris + dir.y * sp;
    s.vz = o.vz * inh.debris + dir.z * sp;
    s.air(0.25, wind, g);
    s.floor = floorY + 0.05;
    s.size0 = s.size1 = rnd(0.1, 0.36) * Math.pow(sc, 0.5);
    s.life = rnd(2.5, 4.5);
    s.rot = rnd(0, 6.28);
    s.spin = rndS() * 14;
    s.cell = Math.random() < 0.85 ? CELL.CHIP : CELL.SHARD;
    s.ramp = RAMP.SOLID;
    const v = rnd(0.05, 0.14);
    s.tint(v * 1.1, v, v * 0.95, 1);
    kit.main.emit(s, now);
  }

  // ── 8. embers: glowing motes drifting up on the heat ──
  const nEmb = count(cfg.counts.embers, cs, glowCap);
  for (let i = 0; i < nEmb; i++) {
    randInBall(tmp, 0.6 * R);
    s.reset();
    s.x = o.x + tmp.x;
    s.y = o.y + Math.abs(tmp.y) * 0.5;
    s.z = o.z + tmp.z;
    s.vx = o.vx * 0.7 + rndS() * 0.5 * R;
    s.vy = o.vy * 0.7 + rnd(0.2, 0.7) * R;
    s.vz = o.vz * 0.7 + rndS() * 0.5 * R;
    s.air(1.1, wind, 2.2);
    s.size0 = s.size1 = rnd(0.06, 0.14) * Math.pow(sc, 0.4);
    s.life = rnd(2, 4);
    s.delay = rnd(0.05, 0.9) * ls;
    s.turb = 0.3 * Math.sqrt(sc);
    s.heat = rnd(2.5, 4);
    s.cell = CELL.STAR;
    s.ramp = RAMP.EMBER;
    s.rot = rnd(0, 6.28);
    kit.glow.emit(s, now);
  }

  // ── 9. burning streamers (CPU emitters leaving fire + smoke trails) ──
  if (!small) {
    const nStr = count(cfg.counts.streamers, Math.sqrt(q) * Math.pow(sc, 0.3));
    for (let i = 0; i < nStr; i++) {
      randDir(dir);
      dir.y = rnd(0.35, 0.95);
      dir.normalize();
      const sp = rnd(1.5, 2.8) * R * Math.pow(sc, -0.35);
      sink.addStreamer(o.x, o.y + 0.1 * R, o.z, o.vx + dir.x * sp, o.vy + dir.y * sp, o.vz + dir.z * sp, rnd(0.9, 1.8) * ls, sc, floorY);
    }
  }
}
