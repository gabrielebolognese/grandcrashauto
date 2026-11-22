import * as THREE from 'three';
import { CONFIG } from '../config';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { SurfaceMaterial } from '../core/Physics';
import type { GameContext } from '../game/contracts';
import type { SkidMarks } from './SkidMarks';
import { CELL, RAMP } from './textures';
import { type FxKit, count, pick, randDir, rnd, rndS } from './kit';

/**
 * Player-car effects driven by ctx.vehicle.state every frame (spec §6, SPEC-PART3 §6–8):
 * skid marks, tyre smoke, dust / grass bits, water & wet-road spray, snow puffs, rain splashes around the car,
 * turbo blue-white exhaust flames + pops, heat haze, glide vapour trails, night taillight streaks, landing hits.
 * All emitters are world-space with sub-frame interpolation along the mount's path.
 */

const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _back = new THREE.Vector3();
const _col = new THREE.Color();

/** A world-space mount point tracked across frames (prev → cur) for sub-frame emission. */
class Mount {
  readonly prev = new THREE.Vector3();
  readonly cur = new THREE.Vector3();
  has = false;
  acc = 0;
  set(p: THREE.Vector3): void {
    if (!this.has || this.cur.distanceToSquared(p) > 30 * 30) {
      this.prev.copy(p);
      this.cur.copy(p);
      this.has = true;
    } else {
      this.prev.copy(this.cur);
      this.cur.copy(p);
    }
  }
  shift(dx: number, dz: number): void {
    this.prev.x -= dx;
    this.prev.z -= dz;
    this.cur.x -= dx;
    this.cur.z -= dz;
  }
}

export class VehicleFx {
  private wheelAcc = new Float32Array(8);
  private wetAcc = new Float32Array(8);
  private exhaust = [new Mount(), new Mount(), new Mount(), new Mount()];
  private corners = [new Mount(), new Mount()];
  private tails = [new Mount(), new Mount()];
  private local: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private heatAcc = 0;
  private rainAcc = 0;
  private popT = 0.5;
  private turboWas = false;

  constructor(
    private ctx: GameContext,
    private skid: SkidMarks,
  ) {}

  reset(): void {
    this.wheelAcc.fill(0);
    this.wetAcc.fill(0);
    for (const m of [...this.exhaust, ...this.corners, ...this.tails]) m.has = false;
    this.heatAcc = this.rainAcc = 0;
    this.turboWas = false;
  }

  shift(dx: number, dz: number): void {
    for (const m of [...this.exhaust, ...this.corners, ...this.tails]) m.shift(dx, dz);
  }

  update(kit: FxKit, dt: number): void {
    const v = this.ctx.vehicle;
    const st = v?.state;
    const alive = !!(v && v.active && st && !st.exploded && dt > 0);
    if (!alive) this.skid.endAll();
    if (alive) {
      this.wheels(kit, dt);
      this.turbo(kit, dt);
      this.glide(kit, dt);
      this.taillights(kit, dt);
    } else {
      for (const m of [...this.exhaust, ...this.corners, ...this.tails]) m.has = false;
    }
    if (dt > 0) this.rain(kit, dt);
  }

  // ─────────────────────────────── wheels ───────────────────────────────
  private wheels(kit: FxKit, dt: number): void {
    const st = this.ctx.vehicle.state;
    const wheels = st.wheels;
    if (!wheels || wheels.length === 0) {
      this.skid.endAll();
      return;
    }
    const cfg = CONFIG.fx;
    const { s, wind } = kit;
    const now = kit.time;
    const vel = st.velocity;
    const speed = vel.length();
    const weather = this.ctx.env?.weather;
    const wet = weather ? weather.wetness : GLOBAL_UNIFORMS.uWetness.value;
    const snow = weather ? weather.snow : GLOBAL_UNIFORMS.uSnow.value;
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
      if (paved && slip > th && (speed > 0.8 || slip > 0.6)) this.skid.add(i, p, nrm, smooth(th, th + 0.3, slip), now);
      else this.skid.end(i);

      // wet-road spray behind each tyre
      if (paved && wet > 0.12 && speed > 6) {
        const k = wet * Math.min(1, speed / 30);
        this.wetAcc[i] += cfg.spray.wetRate * k * kit.q * dt;
        let m = Math.min(5, Math.floor(this.wetAcc[i]));
        this.wetAcc[i] -= m;
        while (m-- > 0) {
          s.reset().pos(p);
          s.y += 0.15;
          s.delay = -Math.random() * dt;
          s.vx = vel.x * 0.55 + rndS() * 0.8;
          s.vy = rnd(0.6, 1.8) * (0.5 + k);
          s.vz = vel.z * 0.55 + rndS() * 0.8;
          s.air(2.2, wind, -1.5);
          s.floor = p.y;
          s.life = rnd(0.5, 0.9);
          s.size0 = rnd(0.3, 0.45);
          s.size1 = rnd(1.4, 2.4) * (0.6 + 0.5 * k);
          s.rot = rnd(0, 6.28);
          s.spin = rndS();
          s.cell = pick(CELL.WISP, CELL.DUST);
          s.ramp = RAMP.MIST;
          s.tint(1, 1, 1, 0.25 + 0.35 * k);
          kit.main.emit(s, now);
        }
      }

      if (paved && slip > cfg.tyreSmoke.slipThreshold) {
        const ts = cfg.tyreSmoke;
        const k = smooth(ts.slipThreshold, 1, slip) * (1 - 0.7 * wet);
        this.wheelAcc[i] += ts.rate * (0.25 + k) * kit.q * dt;
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
          s.size0 = rnd(0.75, 1.15) * ts.size[0];
          s.size1 = rnd(0.8, 1.1) * ts.size[1] * (0.65 + 0.5 * k);
          s.rot = rnd(0, 6.28);
          s.spin = rndS() * 0.6;
          s.turb = 0.3;
          s.cell = pick(CELL.WISP, CELL.SMOKE_A);
          s.ramp = RAMP.SMOKE_LIGHT;
          s.tint(1, 1, 1, 0.4 + 0.5 * k);
          kit.main.emit(s, now);
        }
      } else if ((surf === 'sand' || surf === 'grass' || (snow > 0.35 && !paved)) && speed > cfg.dust.minSpeed) {
        const isSnow = snow > 0.35;
        const k = Math.min(1, speed / 20) * 0.75 + slip * 0.6;
        this.wheelAcc[i] += cfg.dust.rate * k * kit.q * dt * (isSnow ? 1.3 : 1);
        let m = Math.min(6, Math.floor(this.wheelAcc[i]));
        this.wheelAcc[i] -= m;
        const col = _col.set(isSnow ? cfg.dust.snow : surf === 'sand' ? cfg.dust.sand : cfg.dust.grass);
        const damp = isSnow ? 1 : 1 - 0.8 * wet; // wet ground barely dusts
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
          s.tint(col.r, col.g, col.b, Math.min(1, 0.45 + 0.4 * k) * damp);
          kit.main.emit(s, now);
          if (surf === 'grass' && !isSnow && Math.random() < 0.3) {
            s.reset();
            s.x = p.x;
            s.y = p.y + 0.1;
            s.z = p.z;
            s.vx = vel.x * 0.4 + rndS() * 2;
            s.vy = rnd(2, 4);
            s.vz = vel.z * 0.4 + rndS() * 2;
            s.air(1.2, wind, kit.gravity * 0.6);
            s.floor = p.y + 0.02;
            s.life = rnd(1.0, 1.8);
            s.size0 = s.size1 = rnd(0.07, 0.12);
            s.rot = rnd(0, 6.28);
            s.spin = rndS() * 8;
            s.cell = CELL.LEAF;
            s.ramp = RAMP.SOLID;
            s.tint(0.28, rnd(0.45, 0.6), 0.2, 1);
            kit.main.emit(s, now);
          }
        }
      } else if (surf === 'water' && speed > cfg.spray.minSpeed) {
        const k = Math.min(1, speed / 15);
        this.wheelAcc[i] += cfg.spray.rate * k * kit.q * dt;
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
          s.air(0.6, wind, kit.gravity);
          s.floor = p.y - 0.2;
          s.life = rnd(0.6, 1.1);
          s.size0 = rnd(0.12, 0.22);
          s.size1 = rnd(0.5, 0.9);
          s.rot = rnd(0, 6.28);
          s.cell = Math.random() < 0.5 ? CELL.DROP : CELL.WISP;
          s.ramp = RAMP.WATER;
          kit.main.emit(s, now);
        }
      }
    }
  }

  // ─────────────────────────────── mounts ───────────────────────────────
  /** Root-local exhaust / corner / taillight points: from the car model if it provides them, else estimated. */
  private mounts(kind: 'exhaust' | 'corners' | 'tails'): THREE.Vector3[] {
    const vis = this.ctx.vehicle.visual;
    const d = vis?.dims;
    const hx = d ? d.halfExtents.x : 0.9;
    const hy = d ? d.halfExtents.y : 0.6;
    const hz = d ? d.halfExtents.z : 2.2;
    const oy = d ? d.colliderOffset.y : 0.6;
    const oz = d ? d.colliderOffset.z : 0;
    const out = this.local;
    if (kind === 'exhaust') {
      const pts = vis?.exhaustPoints;
      if (pts && pts.length) {
        const n = Math.min(4, pts.length);
        for (let i = 0; i < n; i++) out[i].copy(pts[i]);
        return out.slice(0, n);
      }
      out[0].set(hx * 0.42, oy - hy * 0.55, oz - hz - 0.05);
      out[1].set(-hx * 0.42, oy - hy * 0.55, oz - hz - 0.05);
      return out.slice(0, 2);
    }
    if (kind === 'corners') {
      const pts = vis?.rearCorners;
      if (pts && pts.length >= 2) {
        out[0].copy(pts[0]);
        out[1].copy(pts[1]);
      } else {
        out[0].set(hx * 0.95, oy + hy * 0.75, oz - hz * 0.95);
        out[1].set(-hx * 0.95, oy + hy * 0.75, oz - hz * 0.95);
      }
      return out.slice(0, 2);
    }
    out[0].set(hx - 0.22, oy + hy * 0.15, oz - hz - 0.02);
    out[1].set(-(hx - 0.22), oy + hy * 0.15, oz - hz - 0.02);
    return out.slice(0, 2);
  }

  private carMatrix(): THREE.Matrix4 | null {
    const obj = this.ctx.vehicle.object;
    if (!obj) return null;
    obj.updateWorldMatrix(true, false);
    return obj.matrixWorld;
  }

  // ─────────────────────────────── turbo ───────────────────────────────
  private turbo(kit: FxKit, dt: number): void {
    const st = this.ctx.vehicle.state;
    const on = !!st.turboActive;
    const m = this.carMatrix();
    if (!m) return;
    const pts = this.mounts('exhaust');
    _back.set(0, 0, -1).transformDirection(m);
    for (let i = 0; i < pts.length; i++) this.exhaust[i].set(_a.copy(pts[i]).applyMatrix4(m));
    if (on && !this.turboWas) this.pop(kit, 1);
    this.turboWas = on;
    if (!on) return;
    const { s, wind } = kit;
    const now = kit.time;
    const vel = st.velocity;
    const cfg = CONFIG.fx.turbo;
    // random backfire pops while boosting
    this.popT -= dt;
    if (this.popT <= 0) {
      this.popT = rnd(cfg.popInterval[0], cfg.popInterval[1]);
      this.pop(kit, 0.45);
    }
    for (let e = 0; e < pts.length; e++) {
      const mt = this.exhaust[e];
      mt.acc += cfg.flameRate * kit.q * dt;
      const n = Math.min(12, Math.floor(mt.acc));
      mt.acc -= n;
      const dx = mt.cur.x - mt.prev.x;
      const dy = mt.cur.y - mt.prev.y;
      const dz = mt.cur.z - mt.prev.z;
      for (let i = 0; i < n; i++) {
        const f = (i + Math.random()) / n;
        const out = rnd(5, 10);
        s.reset();
        s.x = mt.prev.x + dx * f;
        s.y = mt.prev.y + dy * f;
        s.z = mt.prev.z + dz * f;
        s.delay = -(1 - f) * dt;
        s.vx = vel.x + _back.x * out + rndS() * 0.4;
        s.vy = vel.y + _back.y * out + rndS() * 0.4;
        s.vz = vel.z + _back.z * out + rndS() * 0.4;
        s.air(7, wind, 0);
        s.life = rnd(0.09, 0.17);
        s.size0 = rnd(0.26, 0.38) * cfg.size;
        s.size1 = 0.08 * cfg.size;
        s.stretch = 0.03;
        s.heat = rnd(1.4, 2.0);
        s.cell = CELL.FLAME_A;
        s.ramp = RAMP.TURBO;
        kit.glow.emit(s, now);
      }
      // glowing nozzle
      s.reset().pos(mt.cur);
      s.vx = vel.x;
      s.vy = vel.y;
      s.vz = vel.z;
      s.life = Math.max(0.03, dt * 1.5);
      s.size0 = s.size1 = rnd(0.35, 0.5) * cfg.size;
      s.heat = 1.1;
      s.cell = CELL.GLOW;
      s.ramp = RAMP.TURBO;
      s.tint(0.6, 0.8, 1, 0.9);
      kit.glow.emit(s, now);
    }
    // heat haze (not on Low)
    if (kit.q >= 0.7 && st.speedKmh > 40) {
      this.heatAcc += cfg.heatRate * kit.q * dt;
      let n = Math.min(4, Math.floor(this.heatAcc));
      this.heatAcc -= n;
      while (n-- > 0) {
        const mt = this.exhaust[(Math.random() * pts.length) | 0];
        s.reset().pos(mt.cur);
        s.vx = vel.x * 0.55 + _back.x * 3;
        s.vy = vel.y * 0.55 + 0.6;
        s.vz = vel.z * 0.55 + _back.z * 3;
        s.air(2.5, wind, 0.8);
        s.life = rnd(0.4, 0.7);
        s.size0 = 0.35;
        s.size1 = rnd(1.4, 2.0);
        s.rot = rnd(0, 6.28);
        s.spin = rndS() * 2;
        s.turb = 0.25;
        s.cell = CELL.WISP;
        s.ramp = RAMP.HEAT;
        kit.glow.emit(s, now);
      }
    }
  }

  /** Exhaust pop: blue-white flash, flame puffs, a few sparks and a light blip. strength 1 = turbo activation. */
  pop(kit: FxKit, strength: number): void {
    const v = this.ctx.vehicle;
    if (!v?.active || v.state.exploded) return;
    const m = this.carMatrix();
    if (!m) return;
    const pts = this.mounts('exhaust');
    _back.set(0, 0, -1).transformDirection(m);
    const vel = v.state.velocity;
    const { s, wind } = kit;
    const now = kit.time;
    const cfg = CONFIG.fx.turbo;
    const which = strength >= 1 ? -1 : (Math.random() * pts.length) | 0;
    for (let e = 0; e < pts.length; e++) {
      if (which >= 0 && e !== which) continue;
      _a.copy(pts[e]).applyMatrix4(m);
      s.reset().pos(_a);
      s.vx = vel.x;
      s.vy = vel.y;
      s.vz = vel.z;
      s.air(3, wind, 0);
      s.cell = CELL.STAR;
      s.ramp = RAMP.FLASH;
      s.size0 = 1.6 * strength * cfg.size;
      s.size1 = 0.6 * cfg.size;
      s.life = 0.09;
      s.heat = 4;
      s.rot = rnd(0, 3.14);
      s.tint(0.7, 0.85, 1, 1);
      kit.glow.emit(s, now);
      const n = Math.round(8 * strength) + 2;
      for (let i = 0; i < n; i++) {
        randDir(_d).multiplyScalar(0.6).add(_back).normalize();
        const sp = rnd(4, 9) * strength;
        s.reset().pos(_a);
        s.vx = vel.x + _d.x * sp;
        s.vy = vel.y + _d.y * sp;
        s.vz = vel.z + _d.z * sp;
        s.air(6, wind, 1);
        s.life = rnd(0.12, 0.25);
        s.size0 = rnd(0.25, 0.4) * cfg.size * (0.6 + 0.4 * strength);
        s.size1 = rnd(0.5, 0.7) * cfg.size;
        s.rot = rnd(0, 6.28);
        s.spin = rndS() * 3;
        s.heat = 1.8;
        s.cell = CELL.BILLOW;
        s.ramp = RAMP.TURBO;
        kit.glow.emit(s, now);
      }
      const ns = Math.round(5 * strength);
      for (let i = 0; i < ns; i++) {
        randDir(_d).multiplyScalar(0.7).add(_back).normalize();
        const sp = rnd(5, 12);
        s.reset().pos(_a);
        s.vx = vel.x + _d.x * sp;
        s.vy = vel.y + _d.y * sp + 1;
        s.vz = vel.z + _d.z * sp;
        s.air(0.8, wind, kit.gravity);
        s.floor = kit.ground(_a.x, _a.z) + 0.03;
        s.life = rnd(0.25, 0.5);
        s.size0 = s.size1 = rnd(0.04, 0.07);
        s.stretch = 0.035;
        s.heat = 3;
        s.cell = CELL.SPARK;
        s.ramp = RAMP.SPARK;
        kit.glow.emit(s, now);
      }
      kit.flash(_a.x, _a.y + 1.0, _a.z, 7 * strength, 16, 7, 0, 0.55, 0.7, 1);
    }
  }

  // ─────────────────────────────── glide vapour trails ───────────────────────────────
  private glide(kit: FxKit, dt: number): void {
    const st = this.ctx.vehicle.state;
    const gliding = !!st.airborne3?.gliding;
    const m = this.carMatrix();
    if (!m) return;
    const pts = this.mounts('corners');
    for (let i = 0; i < 2; i++) this.corners[i].set(_a.copy(pts[i]).applyMatrix4(m));
    if (!gliding) return;
    const { s, wind } = kit;
    const now = kit.time;
    const vel = st.velocity;
    const cfg = CONFIG.fx.glide;
    for (let c = 0; c < 2; c++) {
      const mt = this.corners[c];
      const dist = mt.cur.distanceTo(mt.prev);
      mt.acc += (dist / cfg.spacing) * Math.min(1, kit.q * 1.4);
      const n = Math.min(16, Math.floor(mt.acc));
      mt.acc -= n;
      const dx = mt.cur.x - mt.prev.x;
      const dy = mt.cur.y - mt.prev.y;
      const dz = mt.cur.z - mt.prev.z;
      for (let i = 0; i < n; i++) {
        const f = (i + Math.random()) / n;
        s.reset();
        s.x = mt.prev.x + dx * f;
        s.y = mt.prev.y + dy * f;
        s.z = mt.prev.z + dz * f;
        s.delay = -(1 - f) * dt;
        s.vx = vel.x * 0.15;
        s.vy = vel.y * 0.15;
        s.vz = vel.z * 0.15;
        s.air(3, wind, 0);
        s.life = rnd(cfg.life[0], cfg.life[1]);
        s.size0 = cfg.size[0];
        s.size1 = cfg.size[1] * rnd(0.8, 1.2);
        s.rot = rnd(0, 6.28);
        s.spin = rndS() * 0.5;
        s.turb = 0.04;
        s.cell = CELL.WISP;
        s.ramp = RAMP.VAPOR;
        kit.main.emit(s, now);
      }
    }
  }

  // ─────────────────────────────── night taillight streaks ───────────────────────────────
  private taillights(kit: FxKit, dt: number): void {
    const st = this.ctx.vehicle.state;
    const night = GLOBAL_UNIFORMS.uNight.value > 0.35 || (st.headlights !== undefined && st.headlights !== 'off' && GLOBAL_UNIFORMS.uNight.value > 0.15);
    const m = this.carMatrix();
    if (!m) return;
    const pts = this.mounts('tails');
    for (let i = 0; i < 2; i++) this.tails[i].set(_a.copy(pts[i]).applyMatrix4(m));
    if (!night || !st.turboActive || st.speedKmh < 50) return;
    const { s, wind } = kit;
    const now = kit.time;
    const vel = st.velocity;
    for (let c = 0; c < 2; c++) {
      const mt = this.tails[c];
      const n = 3;
      const dx = mt.cur.x - mt.prev.x;
      const dy = mt.cur.y - mt.prev.y;
      const dz = mt.cur.z - mt.prev.z;
      for (let i = 0; i < n; i++) {
        const f = (i + Math.random()) / n;
        s.reset();
        s.x = mt.prev.x + dx * f;
        s.y = mt.prev.y + dy * f;
        s.z = mt.prev.z + dz * f;
        s.delay = -(1 - f) * dt;
        s.vx = vel.x * 0.9;
        s.vy = vel.y * 0.9;
        s.vz = vel.z * 0.9;
        s.air(5, wind, 0);
        s.life = 0.22;
        s.size0 = s.size1 = 0.16;
        s.stretch = 0.07;
        s.heat = 1.5;
        s.cell = CELL.SPARK;
        s.ramp = RAMP.TAIL;
        kit.glow.emit(s, now);
      }
    }
  }

  // ─────────────────────────────── landings ───────────────────────────────
  landing(kit: FxKit, crash: boolean, sparks: (p: THREE.Vector3, n: THREE.Vector3, k: number, inherit?: THREE.Vector3) => void): void {
    const v = this.ctx.vehicle;
    if (!v?.active) return;
    const st = v.state;
    const p = st.position;
    const gy = kit.ground(p.x, p.z);
    let mat: SurfaceMaterial = 'asphalt';
    try {
      mat = this.ctx.world.surfaceAt(p.x, p.z);
    } catch {
      /* not ready */
    }
    const weather = this.ctx.env?.weather;
    const snow = (weather ? weather.snow : GLOBAL_UNIFORMS.uSnow.value) > 0.35;
    const cfg = CONFIG.fx.dust;
    _col.set(snow ? cfg.snow : mat === 'sand' ? cfg.sand : mat === 'grass' ? cfg.grass : cfg.other);
    const { s, wind } = kit;
    const now = kit.time;
    const k = crash ? 1.4 : 0.8;
    // ground ring
    s.reset();
    s.x = p.x;
    s.y = gy + 0.08;
    s.z = p.z;
    s.floor = gy + 0.08;
    s.stretch = -1;
    s.cell = CELL.RING;
    s.ramp = RAMP.RING_DUST;
    s.size0 = 2;
    s.size1 = 9 * k;
    s.life = 0.8;
    s.rot = rnd(0, 6.28);
    s.tint(_col.r, _col.g, _col.b, 0.85);
    kit.main.emit(s, now);
    const n = count(16 * k, kit.q, 60);
    for (let i = 0; i < n; i++) {
      const a = (i / Math.max(1, n)) * 6.283;
      const sp = rnd(4, 8) * k;
      s.reset();
      s.x = p.x + Math.cos(a) * 1.2;
      s.y = gy + 0.25;
      s.z = p.z + Math.sin(a) * 1.2;
      s.vx = Math.cos(a) * sp + st.velocity.x * 0.35;
      s.vy = rnd(0.4, 1.4);
      s.vz = Math.sin(a) * sp + st.velocity.z * 0.35;
      s.air(2.4, wind, -0.4);
      s.floor = gy;
      s.life = rnd(1.0, 1.9);
      s.size0 = rnd(0.5, 0.8);
      s.size1 = rnd(2.0, 3.0) * k;
      s.rot = rnd(0, 6.28);
      s.spin = rndS() * 0.5;
      s.cell = pick(CELL.DUST, CELL.SMOKE_B);
      s.ramp = RAMP.DUST;
      s.tint(_col.r, _col.g, _col.b, 0.85);
      kit.main.emit(s, now);
    }
    if (!snow && (mat === 'asphalt' || mat === 'concrete' || mat === 'metal')) {
      _b.copy(p);
      _b.y = gy + 0.15;
      _d.copy(st.velocity).multiplyScalar(0.7);
      sparks(_b, UP, crash ? 1.3 : 0.6, _d);
    }
  }

  // ─────────────────────────────── rain splashes ───────────────────────────────
  private rain(kit: FxKit, dt: number): void {
    const weather = this.ctx.env?.weather;
    const rain = weather ? weather.rain : GLOBAL_UNIFORMS.uRain.value;
    const snow = weather ? weather.snow : GLOBAL_UNIFORMS.uSnow.value;
    if (rain < 0.03 || snow > 0.5) return;
    const cfg = CONFIG.fx.rain;
    const v = this.ctx.vehicle;
    const focus = v?.active ? v.state.position : this.ctx.engine.camera.position;
    const cam = this.ctx.engine.camera.position;
    this.rainAcc += cfg.splashRate * rain * kit.q * dt;
    let n = Math.min(30, Math.floor(this.rainAcc));
    this.rainAcc -= n;
    const { s } = kit;
    const now = kit.time;
    // bias splashes toward the camera side of the car so they're visible
    const bx = (cam.x - focus.x) * 0.25;
    const bz = (cam.z - focus.z) * 0.25;
    while (n-- > 0) {
      const a = Math.random() * 6.283;
      const r = Math.sqrt(Math.random()) * cfg.radius;
      const x = focus.x + bx + Math.cos(a) * r;
      const z = focus.z + bz + Math.sin(a) * r;
      const y = kit.ground(x, z);
      if (Math.abs(y - focus.y) > 8) continue;
      s.reset();
      s.x = x;
      s.y = y + 0.04;
      s.z = z;
      s.floor = y + 0.04;
      s.stretch = -1;
      s.cell = CELL.RING;
      s.ramp = RAMP.FOAM;
      s.size0 = 0.05;
      s.size1 = rnd(0.25, 0.45);
      s.life = rnd(0.2, 0.32);
      s.tint(0.9, 0.95, 1, 0.8);
      kit.main.emit(s, now);
      if (Math.random() < 0.6) {
        s.reset();
        s.x = x;
        s.y = y + 0.05;
        s.z = z;
        s.vx = rndS() * 0.6;
        s.vy = rnd(0.8, 1.6);
        s.vz = rndS() * 0.6;
        s.air(0.2, kit.wind, kit.gravity);
        s.floor = y;
        s.life = rnd(0.18, 0.3);
        s.size0 = s.size1 = rnd(0.03, 0.05);
        s.cell = CELL.DROP;
        s.ramp = RAMP.WATER;
        kit.main.emit(s, now);
      }
    }
  }
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
