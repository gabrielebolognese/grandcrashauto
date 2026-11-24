import * as THREE from 'three';
import { BONE, HIP_H, LIE_H, MIRROR, NUM_BONES, PARENT, PIVOTS } from './rig';

/**
 * Procedural animation clips for the pedestrian rig, authored in code and baked into a float texture
 * (3 texels = one 3x4 skin matrix per bone per frame) for instanced GPU skinning.
 *
 * Angle conventions (degrees, Euler order ZXY = twist first, then pitch, then roll in the parent frame):
 *  - legs:  ULeg rx < 0 swings the thigh forward, LLeg rx > 0 bends the knee, Foot rx > 0 points the toes down.
 *           Left leg out = rz > 0, right leg out = rz < 0.
 *  - arms:  UArm rx < 0 raises the arm forward, LArm rx < 0 bends the elbow. Left arm out = rz > 0, right = rz < 0.
 *           UArm ry twists the arm about its own axis (left arm: ry < 0 turns a bent forearm across the body).
 *  - spine / chest / head / pelvis: rx > 0 bends forward, ry > 0 turns left, rz > 0 leans to the character's right.
 *  - root = absolute pelvis pivot position in model space (standing: 0, HIP_H, 0).
 */

export const CLIP = {
  idle: 0,
  walk: 1,
  run: 2,
  flee: 3,
  talk: 4,
  phone: 5,
  lookAround: 6,
  armsCrossed: 7,
  sit: 8,
  sitPhone: 9,
  sitDown: 10,
  standUp: 11,
  dive: 12,
  hopL: 13,
  hopR: 14,
  stumble: 15,
  fallBack: 16,
  tumble: 17,
  relaxB: 18,
  relaxF: 19,
  lieBack: 20,
  lieFront: 21,
  getUpBack: 22,
  getUpFront: 23,
  flinch: 24,
  cheer: 25,
  clap: 26,
  jump: 27,
  sway: 28,
  // plane passengers (user request): seated reactions
  sitPanic: 29,
  sitBrace: 30,
  sitLookPX: 31,
  sitLookNX: 32,
} as const;
export type ClipId = (typeof CLIP)[keyof typeof CLIP];

export interface ClipInfo {
  name: string;
  start: number; // first texture row
  frames: number;
  fps: number;
  duration: number;
  loop: boolean;
  /** Standing origin offset (local +Z, metres at scale 1) of the pelvis at frame 0 (clip starts from a standing pose there). */
  rootStartZ: number;
  /** Local +Z offset where the character stands at the last frame (origin moves there when the clip ends). */
  rootEndZ: number;
}

/** Stride length (m per walk cycle at scale 1) — walk clip time advances at speed / stride. */
export const WALK_STRIDE = 1.36;
export const RUN_STRIDE = 2.7;
export const FLEE_STRIDE = 2.6;
/** Height of the seat surface the sit clips were authored for (the butt touches y = SEAT_H at scale 1). */
export const SEAT_H = 0.46;
/** sitDown starts / standUp ends standing this far in front of the seat (local +Z, scale 1). */
export const SIT_STAND_Z = 0.36;
/** Butt sits this far behind the bench seat centre (so the thighs rest on the seat). */
export const SIT_BACK = 0.03;

// ───────────────────────────────────────── pose ─────────────────────────────────────────
const NCH = NUM_BONES * 3 + 3 + 6; // rotations + root + 2 ankle targets (y, z, footWorldDeg)

export class Pose {
  readonly r = new Float32Array(NUM_BONES * 3);
  readonly root = new Float32Array([0, HIP_H, 0]);
  /** Optional IK ankle targets: [y, z, footWorldDeg]; NaN = not used. */
  readonly ank = new Float32Array([NaN, NaN, NaN, NaN, NaN, NaN]);

  reset(): this {
    this.r.fill(0);
    this.root[0] = 0;
    this.root[1] = HIP_H;
    this.root[2] = 0;
    this.ank.fill(NaN);
    return this;
  }
  set(b: number, x: number, y = 0, z = 0): this {
    this.r[b * 3] = x;
    this.r[b * 3 + 1] = y;
    this.r[b * 3 + 2] = z;
    return this;
  }
  add(b: number, x: number, y = 0, z = 0): this {
    this.r[b * 3] += x;
    this.r[b * 3 + 1] += y;
    this.r[b * 3 + 2] += z;
    return this;
  }
  rx(b: number): number {
    return this.r[b * 3];
  }
  setRoot(x: number, y: number, z: number): this {
    this.root[0] = x;
    this.root[1] = y;
    this.root[2] = z;
    return this;
  }
  /** IK ankle target for a leg (side 0 = left, 1 = right): ankle height y, forward z, foot world pitch (0 = flat). */
  ankle(side: 0 | 1, y: number, z: number, footDeg = 0): this {
    this.ank[side * 3] = y;
    this.ank[side * 3 + 1] = z;
    this.ank[side * 3 + 2] = footDeg;
    return this;
  }
  copy(o: Pose): this {
    this.r.set(o.r);
    this.root.set(o.root);
    this.ank.set(o.ank);
    return this;
  }
  toArray(out: Float32Array): void {
    out.set(this.r, 0);
    out.set(this.root, NUM_BONES * 3);
    out.set(this.ank, NUM_BONES * 3 + 3);
  }
  fromArray(a: Float32Array): this {
    this.r.set(a.subarray(0, NUM_BONES * 3));
    this.root.set(a.subarray(NUM_BONES * 3, NUM_BONES * 3 + 3));
    this.ank.set(a.subarray(NUM_BONES * 3 + 3, NCH));
    return this;
  }
  mirrorFrom(o: Pose): this {
    for (let b = 0; b < NUM_BONES; b++) {
      const m = MIRROR[b];
      this.r[m * 3] = o.r[b * 3];
      this.r[m * 3 + 1] = -o.r[b * 3 + 1];
      this.r[m * 3 + 2] = -o.r[b * 3 + 2];
    }
    this.root[0] = -o.root[0];
    this.root[1] = o.root[1];
    this.root[2] = o.root[2];
    this.ank[0] = o.ank[3];
    this.ank[1] = o.ank[4];
    this.ank[2] = o.ank[5];
    this.ank[3] = o.ank[0];
    this.ank[4] = o.ank[1];
    this.ank[5] = o.ank[2];
    return this;
  }
}

type PoseFn = (t: number, p: Pose) => void;

interface ClipDef {
  id: ClipId;
  name: string;
  duration: number;
  loop: boolean;
  fps: number;
  fn: PoseFn;
  rootStartZ?: number;
  rootEndZ?: number;
}

// ───────────────────────────────────────── helpers ─────────────────────────────────────────
const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const sin = Math.sin;
const cos = Math.cos;
const pos = (v: number) => (v > 0 ? v : 0);
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Smooth window: 0 outside [a,d], ramps up over [a,b], 1 on [b,c], ramps down over [c,d]. */
const win = (a: number, b: number, c: number, d: number, x: number) => sstep(a, b, x) * (1 - sstep(c, d, x));

const L1 = PIVOTS[BONE.ULegL][1] - PIVOTS[BONE.LLegL][1]; // thigh length
const L2 = PIVOTS[BONE.LLegL][1] - PIVOTS[BONE.FootL][1]; // shin length
const HIP_DROP = PIVOTS[0][1] - PIVOTS[BONE.ULegL][1]; // hip joint below the pelvis pivot

/** Two-link sagittal IK for the legs (degrees). Uses pose.root + pelvis pitch; writes hip/knee/foot rx. */
function solveLegIK(p: Pose): void {
  const pr = p.rx(BONE.Pelvis) * D2R;
  for (let side = 0; side < 2; side++) {
    const ay = p.ank[side * 3];
    if (Number.isNaN(ay)) continue;
    const az = p.ank[side * 3 + 1];
    const footW = p.ank[side * 3 + 2];
    // hip joint position (pelvis pitch only)
    const hy = p.root[1] - HIP_DROP * cos(pr);
    const hz = p.root[2] - HIP_DROP * sin(pr);
    const dy = ay - hy;
    const dz = az - hz;
    let D = Math.hypot(dy, dz);
    D = Math.min(L1 + L2 - 1e-4, Math.max(Math.abs(L1 - L2) + 1e-3, D));
    const cosK = (L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2);
    const k = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosK)));
    const r = Math.atan2(-dz, -dy); // pitch of the hip→ankle direction (rx convention)
    const alpha = Math.atan2(L2 * sin(k), L1 + L2 * cos(k));
    const thighW = (r - alpha) / D2R;
    const kneeDeg = k / D2R;
    const ub = side === 0 ? BONE.ULegL : BONE.ULegR;
    const lb = side === 0 ? BONE.LLegL : BONE.LLegR;
    const fb = side === 0 ? BONE.FootL : BONE.FootR;
    const pelvisDeg = pr / D2R;
    p.r[ub * 3] = thighW - pelvisDeg;
    p.r[lb * 3] = kneeDeg;
    p.r[fb * 3] = footW - (thighW + kneeDeg);
  }
}

// ── forward kinematics (bake time only) ──
const _local = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _world: THREE.Matrix4[] = Array.from({ length: NUM_BONES }, () => new THREE.Matrix4());
const _skin = new THREE.Matrix4();
const _v = new THREE.Vector3();

function fk(p: Pose): THREE.Matrix4[] {
  for (let b = 0; b < NUM_BONES; b++) {
    _euler.set(p.r[b * 3] * D2R, p.r[b * 3 + 1] * D2R, p.r[b * 3 + 2] * D2R, 'ZXY');
    _rot.makeRotationFromEuler(_euler);
    const par = PARENT[b];
    if (par < 0) {
      _local.makeTranslation(p.root[0], p.root[1], p.root[2]).multiply(_rot);
      _world[b].copy(_local);
    } else {
      const pv = PIVOTS[b];
      const pp = PIVOTS[par];
      _local.makeTranslation(pv[0] - pp[0], pv[1] - pp[1], pv[2] - pp[2]).multiply(_rot);
      _world[b].multiplyMatrices(_world[par], _local);
    }
  }
  return _world;
}

/** World-space ankle of a pose (for keys that must match another pose exactly). Returns [y, z, footWorldDeg]. */
function ankleOf(p: Pose, side: 0 | 1): [number, number, number] {
  const w = fk(p);
  const fb = side === 0 ? BONE.FootL : BONE.FootR;
  _v.set(0, 0, 0).applyMatrix4(w[fb]);
  const ub = side === 0 ? BONE.ULegL : BONE.ULegR;
  const lb = side === 0 ? BONE.LLegL : BONE.LLegR;
  const footW = p.rx(BONE.Pelvis) + p.rx(ub) + p.rx(lb) + p.rx(fb);
  return [_v.y, _v.z, footW];
}

// ── keyframed clips (Catmull-Rom / Hermite through key descriptors, IK solved per frame) ──
interface Key {
  t: number;
  build: (p: Pose) => void;
}

function keyed(keys: Key[]): PoseFn {
  const n = keys.length;
  const times = keys.map((k) => k.t);
  const vals = keys.map((k) => {
    const p = new Pose();
    k.build(p);
    solveLegIK(p); // store IK-solved angles so IK → non-IK key transitions stay continuous
    const a = new Float32Array(NCH);
    p.toArray(a);
    return a;
  });
  const tmp = new Float32Array(NCH);
  return (t, p) => {
    let i = 0;
    while (i < n - 2 && t > times[i + 1]) i++;
    const t0 = times[i];
    const t1 = times[i + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-6, t1 - t0)));
    const a = vals[i];
    const b = vals[i + 1];
    const pa = vals[Math.max(0, i - 1)];
    const pb = vals[Math.min(n - 1, i + 2)];
    const ta = times[Math.max(0, i - 1)];
    const tb = times[Math.min(n - 1, i + 2)];
    const h = t1 - t0;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let c = 0; c < NCH; c++) {
      const va = a[c];
      const vb = b[c];
      if (Number.isNaN(va) || Number.isNaN(vb)) {
        tmp[c] = NaN;
        continue;
      }
      // tangents (clamped at the ends → ease in/out on the first / last key)
      const m0 = i === 0 || Number.isNaN(pa[c]) ? 0 : ((vb - pa[c]) / Math.max(1e-6, t1 - ta)) * h;
      const m1 = i + 1 === n - 1 || Number.isNaN(pb[c]) ? 0 : ((pb[c] - va) / Math.max(1e-6, tb - t0)) * h;
      tmp[c] = h00 * va + h10 * m0 + h01 * vb + h11 * m1;
    }
    p.fromArray(tmp);
    solveLegIK(p);
  };
}

// ───────────────────────────────────────── base poses ─────────────────────────────────────────
function stand(p: Pose): void {
  p.reset();
  p.set(BONE.UArmL, 0, 0, 5).set(BONE.UArmR, 0, 0, -5);
  p.set(BONE.LArmL, -8).set(BONE.LArmR, -8);
  p.set(BONE.ULegL, 0, 0, 1.5).set(BONE.ULegR, 0, 0, -1.5);
  p.set(BONE.LLegL, 3).set(BONE.LLegR, 3).set(BONE.FootL, -3).set(BONE.FootR, -3);
  p.set(BONE.Head, 2);
}

/** Standing pose with IK feet planted under the hips at local z. */
function standAt(p: Pose, z: number): void {
  stand(p);
  p.setRoot(0, HIP_H, z);
  p.ankle(0, PIVOTS[BONE.FootL][1], z - 0.004).ankle(1, PIVOTS[BONE.FootR][1], z - 0.004);
}

function idle(t: number, p: Pose, amt = 1): void {
  const w = TAU / 4;
  const s = sin(w * t);
  stand(p);
  p.root[0] = 0.012 * s * amt;
  p.root[1] = HIP_H - 0.004 - 0.004 * Math.abs(s) * amt;
  p.set(BONE.Pelvis, 0, 2 * sin(w * t + 1) * amt, 2.4 * s * amt);
  p.set(BONE.Spine, 1, 0, -1.4 * s * amt);
  p.set(BONE.Chest, -1 + 1.2 * sin(2 * w * t), 1.5 * sin(w * t + 2), -0.8 * s * amt);
  p.set(BONE.ULegL, 0, 0, 1.5 - 2.4 * s * amt).set(BONE.ULegR, 0, 0, -1.5 - 2.4 * s * amt);
  p.set(BONE.LLegL, 3 + 5 * pos(-s) * amt).set(BONE.LLegR, 3 + 5 * pos(s) * amt);
  p.set(BONE.FootL, -3 - 2 * pos(-s) * amt).set(BONE.FootR, -3 - 2 * pos(s) * amt);
  p.set(BONE.UArmL, 2 * sin(w * t + 1), 0, 5 + sin(2 * w * t));
  p.set(BONE.UArmR, 2 * sin(w * t + 2.5), 0, -5 - sin(2 * w * t + 1));
  p.set(BONE.Head, 3 + 2 * sin(2 * w * t + 0.4), 8 * sin(w * t + 0.5) * amt, 0);
}

function walk(t: number, p: Pose): void {
  const ph = TAU * t; // 1 s cycle
  const s = sin(ph);
  const c = cos(ph);
  stand(p);
  p.root[1] = HIP_H - 0.024 + 0.024 * cos(2 * ph);
  p.set(BONE.Pelvis, 0, -6 * s, -3 * c);
  p.set(BONE.Spine, 4, 3 * s, 1.5 * c);
  p.set(BONE.Chest, -1, 6 * s, 0);
  p.set(BONE.Head, 3, -5 * s, 0);
  const legs = (side: 0 | 1, phase: number) => {
    const ls = sin(phase);
    const lc = cos(phase);
    const hip = -24 * ls - 2;
    const knee = 4 + 56 * Math.pow(pos(cos(phase + 0.3)), 1.5) + 7 * Math.pow(pos(cos(phase - 2.1)), 3);
    const foot = -10 * ls + 12 * Math.pow(pos(-sin(phase + 0.4)), 3) - 14 * pos(lc) * pos(lc);
    const ub = side === 0 ? BONE.ULegL : BONE.ULegR;
    p.set(ub, hip, 0, side === 0 ? 1 : -1);
    p.set(side === 0 ? BONE.LLegL : BONE.LLegR, knee);
    p.set(side === 0 ? BONE.FootL : BONE.FootR, foot);
  };
  legs(0, ph);
  legs(1, ph + Math.PI);
  p.set(BONE.UArmL, 16 * s + 2, 0, 6).set(BONE.UArmR, -16 * s + 2, 0, -6);
  p.set(BONE.LArmL, -14 - 12 * pos(-s)).set(BONE.LArmR, -14 - 12 * pos(s));
}

function runBase(t: number, p: Pose, period: number): number {
  const ph = (TAU * t) / period;
  const s = sin(ph);
  stand(p);
  p.root[1] = HIP_H - 0.06 + 0.04 * cos(2 * ph - 0.6);
  p.set(BONE.Pelvis, 0, -8 * s, 0);
  p.set(BONE.Spine, 10, 4 * s, 0);
  p.set(BONE.Chest, 4, 7 * s, 0);
  p.set(BONE.Head, -6, -6 * s, 0);
  const legs = (side: 0 | 1, phase: number) => {
    const ls = sin(phase);
    const lc = cos(phase);
    const hip = -38 * ls - 8;
    const knee = 15 + 85 * Math.pow(pos(cos(phase + 0.5)), 1.3) + 15 * Math.pow(pos(cos(phase - 2.0)), 3);
    const foot = -8 * ls + 18 * Math.pow(pos(-sin(phase + 0.5)), 2) - 10 * pos(lc);
    p.set(side === 0 ? BONE.ULegL : BONE.ULegR, hip, 0, side === 0 ? 1.5 : -1.5);
    p.set(side === 0 ? BONE.LLegL : BONE.LLegR, knee);
    p.set(side === 0 ? BONE.FootL : BONE.FootR, foot);
  };
  legs(0, ph);
  legs(1, ph + Math.PI);
  return ph;
}

function run(t: number, p: Pose): void {
  const ph = runBase(t, p, 0.66);
  const s = sin(ph);
  p.set(BONE.UArmL, 35 * s - 5, 0, 10).set(BONE.UArmR, -35 * s - 5, 0, -10);
  p.set(BONE.LArmL, -80 - 15 * pos(-s)).set(BONE.LArmR, -80 - 15 * pos(s));
}

function flee(t: number, p: Pose): void {
  const ph = runBase(t, p, 0.6);
  const s = sin(ph);
  const c = cos(ph);
  // cartoony panic: hands up and waving while sprinting away
  p.set(BONE.UArmL, -150 + 14 * s, 0, 28 + 10 * c).set(BONE.UArmR, -150 - 14 * s, 0, -28 + 10 * c);
  p.set(BONE.LArmL, -35 + 18 * sin(2 * ph)).set(BONE.LArmR, -35 - 18 * sin(2 * ph));
  p.set(BONE.Head, -12, 8 * s, 0);
  p.set(BONE.Chest, 0, 5 * s, 0);
}

function talk(t: number, p: Pose): void {
  idle(t, p, 0.7);
  const g1 = win(0.1, 0.45, 1.0, 1.4, t);
  const g2 = win(2.0, 2.35, 3.05, 3.45, t);
  const beat = sin(TAU * 2.5 * t);
  p.set(BONE.UArmR, -(20 * g1 + 14 * g2), -20 * g1, -(5 + 16 * g2));
  p.set(BONE.LArmR, -(8 + 72 * g1 + 52 * g2) + 9 * beat * (g1 + g2));
  p.set(BONE.UArmL, -(14 * g2) + 2 * sin(TAU * t / 4), 18 * g2, 5 + 16 * g2);
  p.set(BONE.LArmL, -(8 + 55 * g2) - 8 * beat * g2);
  p.set(BONE.Head, 3 + 4 * sin(TAU * 1.5 * t) * (0.4 + 0.6 * (g1 + g2)), 10 * sin((TAU * t) / 4 + 0.6), 3 * sin((TAU * t) / 2));
  p.add(BONE.Chest, 0, 4 * sin((TAU * t) / 4), 0);
}

function phone(t: number, p: Pose): void {
  idle(t, p, 0.5);
  const two = win(-1, -0.5, 2.0, 2.6, t) + win(3.5, 4.1, 5, 6, t);
  const tap = sin(TAU * 3 * t) * 1.5;
  p.set(BONE.UArmR, -24, 0, 9);
  p.set(BONE.LArmR, -102 + tap);
  p.set(BONE.UArmL, -12 * two + 2 * (1 - two), 0, 5 - 11 * two);
  p.set(BONE.LArmL, -8 - 80 * two);
  p.set(BONE.Head, 25 + 2 * sin((TAU * 2 * t) / 4), 3 * sin((TAU * t) / 4), 0);
  p.add(BONE.Chest, 4, 0, 0);
  p.add(BONE.Spine, 2, 0, 0);
}

const lookAroundYaw = keyedScalar([
  [0, 0],
  [0.6, 52],
  [1.6, 50],
  [2.3, -48],
  [3.2, -46],
  [3.75, 0],
  [4, 0],
]);
function lookAround(t: number, p: Pose): void {
  idle(t, p, 0.6);
  const y = lookAroundYaw(t);
  p.set(BONE.Head, -2, y * 0.75, 0);
  p.add(BONE.Chest, 0, y * 0.2, 0);
  p.add(BONE.Spine, 0, y * 0.08, 0);
}

function armsCrossed(t: number, p: Pose): void {
  idle(t, p, 0.8);
  const b = sin((TAU * t) / 4);
  p.set(BONE.UArmL, -32 + b, -72, -6).set(BONE.LArmL, -98);
  p.set(BONE.UArmR, -26 - b, 72, 6).set(BONE.LArmR, -88);
  p.add(BONE.Chest, -2, 0, 0);
}

const SIT_HIP_Y = SEAT_H + 0.084 + HIP_DROP; // pelvis pivot height when seated
function sitPose(p: Pose): void {
  p.reset();
  p.setRoot(0, SIT_HIP_Y, 0);
  p.set(BONE.Pelvis, -6);
  p.set(BONE.Spine, 3).set(BONE.Chest, 2).set(BONE.Head, 4);
  p.ankle(0, PIVOTS[BONE.FootL][1], 0.43, 0).ankle(1, PIVOTS[BONE.FootR][1], 0.43, 0);
  p.set(BONE.ULegL, 0, 0, 4).set(BONE.ULegR, 0, 0, -4);
  p.set(BONE.UArmL, -32, 0, 8).set(BONE.LArmL, -52);
  p.set(BONE.UArmR, -32, 0, -8).set(BONE.LArmR, -52);
}
function sit(t: number, p: Pose): void {
  sitPose(p);
  const w = TAU / 4;
  p.add(BONE.Chest, 1.2 * sin(2 * w * t), 0, 0);
  p.set(BONE.Head, 4 + 2 * sin(w * t + 1), 12 * sin(w * t), 0);
  p.add(BONE.UArmL, 2 * sin(w * t), 0, 0);
  // one foot taps lazily
  p.ankle(1, PIVOTS[BONE.FootR][1] + 0.025 * pos(sin(TAU * 2 * t)), 0.45, -8 * pos(sin(TAU * 2 * t)));
  solveLegIK(p);
}
function sitPhone(t: number, p: Pose): void {
  sitPose(p);
  const w = TAU / 4;
  p.set(BONE.UArmR, -28, 0, 10).set(BONE.LArmR, -92 + 1.5 * sin(TAU * 3 * t));
  p.set(BONE.UArmL, -24, 0, -8).set(BONE.LArmL, -84);
  p.set(BONE.Head, 30 + 2 * sin(2 * w * t), 4 * sin(w * t), 0);
  p.add(BONE.Chest, 5 + sin(2 * w * t), 0, 0);
  solveLegIK(p);
}

/** Seated panic (plane passengers): arms flung up over the head, shaking, head darting, rocking in the seat. */
function sitPanic(t: number, p: Pose): void {
  sitPose(p);
  const ph = TAU * t;
  p.add(BONE.Spine, 4 + 3 * sin(ph * 2.5), 0, 0).add(BONE.Chest, -6 + 4 * sin(ph * 2.5 + 1), 0, 0);
  p.set(BONE.Head, -8 + 6 * sin(ph * 3), 22 * sin(ph * 1.5), 0);
  p.set(BONE.UArmL, -150 + 16 * sin(ph * 4), 0, 20 + 8 * sin(ph * 3)).set(BONE.LArmL, -40 + 20 * sin(ph * 4 + 1));
  p.set(BONE.UArmR, -150 + 16 * sin(ph * 4 + 2), 0, -20 + 8 * sin(ph * 3)).set(BONE.LArmR, -40 + 20 * sin(ph * 4 + 3));
  solveLegIK(p);
}

/** Brace position: folded forward over the knees, hands clasped on the head, trembling. */
function sitBrace(t: number, p: Pose): void {
  sitPose(p);
  const tr = 1.5 * sin(TAU * t * 5);
  p.set(BONE.Pelvis, 8).set(BONE.Spine, 30 + tr).set(BONE.Chest, 26).set(BONE.Head, 30);
  p.set(BONE.UArmL, -125, 0, 30).set(BONE.LArmL, -120 + tr);
  p.set(BONE.UArmR, -125, 0, -30).set(BONE.LArmR, -120 - tr);
  solveLegIK(p);
}

/** Worried, staring out of the window on the model's +X side: turned, one hand gripping the armrest, the other at the mouth. */
function sitLookPX(t: number, p: Pose): void {
  sitPose(p);
  const tr = sin(TAU * t * 4);
  p.set(BONE.Spine, 3, 8, 0).set(BONE.Chest, 4, 14, 0);
  p.set(BONE.Head, 6 + 2 * tr, 55 + 4 * sin(TAU * t * 0.5), 0);
  p.set(BONE.UArmL, -28, 0, 14).set(BONE.LArmL, -50 + 2 * tr);
  p.set(BONE.UArmR, -40, 0, -6).set(BONE.LArmR, -95 + 3 * tr);
  solveLegIK(p);
}

/** Lying limb arrangement shared by the body-frame (relax*) and canonical (lie*) clips so they match exactly. */
function lieLimbs(p: Pose, t: number, front: boolean): void {
  const br = sin((TAU * t) / 2);
  if (!front) {
    p.set(BONE.Spine, 0).set(BONE.Chest, 1.5 * br).set(BONE.Head, -6, 18, 0);
    p.set(BONE.UArmL, 4, 0, 48).set(BONE.LArmL, -25);
    p.set(BONE.UArmR, -4, 0, -40).set(BONE.LArmR, -45);
    p.set(BONE.ULegL, -16, 0, 7).set(BONE.LLegL, 34).set(BONE.FootL, 18);
    p.set(BONE.ULegR, 4, 0, -5).set(BONE.LLegR, 6).set(BONE.FootR, 30);
  } else {
    p.set(BONE.Spine, -2).set(BONE.Chest, -2 + 1.2 * br).set(BONE.Head, -14, 72, 0);
    p.set(BONE.UArmL, -150, 0, 30).set(BONE.LArmL, -70);
    p.set(BONE.UArmR, 6, 0, -22).set(BONE.LArmR, -20);
    p.set(BONE.ULegL, -6, 0, 9).set(BONE.LLegL, 20).set(BONE.FootL, 55);
    p.set(BONE.ULegR, -3, 0, -6).set(BONE.LLegR, 4).set(BONE.FootR, 62);
  }
}
function relax(front: boolean): PoseFn {
  return (t, p) => {
    p.reset();
    lieLimbs(p, t, front);
  };
}
function lie(front: boolean): PoseFn {
  return (t, p) => {
    p.reset();
    p.setRoot(0, LIE_H, 0);
    p.set(BONE.Pelvis, front ? 90 : -90);
    lieLimbs(p, t, front);
  };
}

function tumble(t: number, p: Pose): void {
  const ph = (TAU * t) / 0.8;
  p.reset();
  p.set(BONE.Spine, 14 + 6 * sin(ph)).set(BONE.Chest, 6).set(BONE.Head, 12 + 10 * sin(ph + 1), 10 * sin(ph), 0);
  p.set(BONE.UArmL, -95 + 70 * sin(ph), 0, 62 + 30 * cos(ph)).set(BONE.LArmL, -40 + 30 * sin(2 * ph));
  p.set(BONE.UArmR, -95 - 70 * sin(ph + 0.7), 0, -62 - 30 * cos(ph + 0.7)).set(BONE.LArmR, -40 - 30 * sin(2 * ph + 1));
  p.set(BONE.ULegL, -45 + 35 * sin(ph + 1), 0, 10).set(BONE.LLegL, 60 + 30 * sin(ph + 2));
  p.set(BONE.ULegR, -40 - 35 * sin(ph + 1.3), 0, -10).set(BONE.LLegR, 55 - 30 * sin(ph + 2.4));
  p.set(BONE.FootL, 20).set(BONE.FootR, 20);
}

/** Scalar Catmull-Rom over [t, v] keys. */
function keyedScalar(keys: [number, number][]): (t: number) => number {
  return (t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const [t0, v0] = keys[i];
    const [t1, v1] = keys[i + 1];
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const vp = keys[Math.max(0, i - 1)][1];
    const vn = keys[Math.min(keys.length - 1, i + 2)][1];
    const m0 = i === 0 ? 0 : (v1 - vp) * 0.5;
    const m1 = i + 1 === keys.length - 1 ? 0 : (vn - v0) * 0.5;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1;
  };
}

// ───────────────────────────────────────── keyed clip definitions ─────────────────────────────────────────
const AY = PIVOTS[BONE.FootL][1]; // ankle height when the foot is flat on the ground

function lieRef(front: boolean): Pose {
  const p = new Pose();
  lie(front)(0, p);
  return p;
}
function sitRef(): Pose {
  const p = new Pose();
  sitPose(p);
  solveLegIK(p);
  return p;
}

function buildSitDown(): PoseFn {
  return keyed([
    { t: 0, build: (p) => standAt(p, SIT_STAND_Z) },
    {
      t: 0.35,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.84, 0.26).set(BONE.Pelvis, 8).set(BONE.Spine, 14).set(BONE.Chest, 8).set(BONE.Head, -4);
        p.set(BONE.UArmL, -22, 0, 10).set(BONE.UArmR, -22, 0, -10).set(BONE.LArmL, -30).set(BONE.LArmR, -30);
        p.ankle(0, AY, 0.4).ankle(1, AY, 0.4);
      },
    },
    {
      t: 0.72,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.64, 0.06).set(BONE.Pelvis, 2).set(BONE.Spine, 10).set(BONE.Chest, 5).set(BONE.Head, 0);
        p.set(BONE.UArmL, -28, 0, 9).set(BONE.UArmR, -28, 0, -9).set(BONE.LArmL, -40).set(BONE.LArmR, -40);
        p.ankle(0, AY, 0.42).ankle(1, AY, 0.42);
      },
    },
    { t: 1.0, build: (p) => p.copy(sitRef()) },
  ]);
}

function buildStandUp(): PoseFn {
  return keyed([
    { t: 0, build: (p) => p.copy(sitRef()) },
    {
      t: 0.3,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.6, 0.1).set(BONE.Pelvis, 18).set(BONE.Spine, 18).set(BONE.Chest, 8).set(BONE.Head, -8);
        p.set(BONE.UArmL, -30, 0, 10).set(BONE.UArmR, -30, 0, -10).set(BONE.LArmL, -45).set(BONE.LArmR, -45);
        p.ankle(0, AY, 0.4).ankle(1, AY, 0.4);
      },
    },
    {
      t: 0.62,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.82, 0.3).set(BONE.Pelvis, 10).set(BONE.Spine, 10).set(BONE.Chest, 4).set(BONE.Head, -3);
        p.set(BONE.UArmL, -12, 0, 8).set(BONE.UArmR, -12, 0, -8).set(BONE.LArmL, -20).set(BONE.LArmR, -20);
        p.ankle(0, AY, 0.38).ankle(1, AY, 0.37);
      },
    },
    { t: 1.0, build: (p) => standAt(p, SIT_STAND_Z) },
  ]);
}

function buildDive(): PoseFn {
  const lf = lieRef(true);
  return keyed([
    { t: 0, build: (p) => stand(p) },
    {
      t: 0.13,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.8, 0).set(BONE.Spine, 26).set(BONE.Chest, 8).set(BONE.Head, -14);
        p.set(BONE.UArmL, 40, 0, 12).set(BONE.UArmR, 40, 0, -12).set(BONE.LArmL, -20).set(BONE.LArmR, -20);
        p.ankle(0, AY, 0.02).ankle(1, AY, -0.06);
      },
    },
    {
      t: 0.32,
      build: (p) => {
        p.reset();
        p.setRoot(0, 1.0, 0).set(BONE.Pelvis, 40).set(BONE.Spine, 8).set(BONE.Head, -32);
        p.set(BONE.UArmL, -160, 0, 16).set(BONE.UArmR, -160, 0, -16).set(BONE.LArmL, -12).set(BONE.LArmR, -12);
        p.set(BONE.ULegL, 6, 0, 4).set(BONE.LLegL, 14).set(BONE.FootL, 30);
        p.set(BONE.ULegR, 14, 0, -4).set(BONE.LLegR, 40).set(BONE.FootR, 30);
      },
    },
    {
      t: 0.56,
      build: (p) => {
        p.reset();
        p.setRoot(0, 0.55, 0).set(BONE.Pelvis, 80).set(BONE.Spine, 4).set(BONE.Head, -45);
        p.set(BONE.UArmL, -168, 0, 18).set(BONE.UArmR, -168, 0, -18).set(BONE.LArmL, -10).set(BONE.LArmR, -10);
        p.set(BONE.ULegL, 4, 0, 6).set(BONE.LLegL, 16).set(BONE.FootL, 40);
        p.set(BONE.ULegR, 8, 0, -6).set(BONE.LLegR, 24).set(BONE.FootR, 40);
      },
    },
    {
      t: 0.76,
      build: (p) => {
        p.reset();
        p.setRoot(0, 0.15, 0).set(BONE.Pelvis, 88).set(BONE.Spine, -4).set(BONE.Head, -30);
        p.set(BONE.UArmL, -150, 0, 26).set(BONE.UArmR, -150, 0, -26).set(BONE.LArmL, -40).set(BONE.LArmR, -40);
        p.set(BONE.ULegL, -4, 0, 8).set(BONE.LLegL, 30).set(BONE.FootL, 50);
        p.set(BONE.ULegR, -2, 0, -6).set(BONE.LLegR, 20).set(BONE.FootR, 55);
      },
    },
    { t: 1.0, build: (p) => p.copy(lf) },
  ]);
}

function buildHopL(): PoseFn {
  return keyed([
    { t: 0, build: (p) => standAt(p, 0) },
    {
      t: 0.12,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0.02, 0.8, 0).set(BONE.Pelvis, 6, 0, -6).set(BONE.Spine, 14, 0, -4).set(BONE.Head, -6);
        p.set(BONE.UArmL, 20, 0, 30).set(BONE.UArmR, 20, 0, -30).set(BONE.LArmL, -30).set(BONE.LArmR, -30);
        p.ankle(0, AY, 0.02).ankle(1, AY, 0.02);
      },
    },
    {
      t: 0.32,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 1.06, 0).set(BONE.Pelvis, 0, 0, -10).set(BONE.Spine, 4, 0, -6).set(BONE.Head, 4, 0, 8);
        p.set(BONE.UArmL, -40, 0, 95).set(BONE.UArmR, -40, 0, -85).set(BONE.LArmL, -30).set(BONE.LArmR, -30);
        p.ankle(0, 0.32, 0.08).ankle(1, 0.26, -0.05);
        p.set(BONE.ULegL, 0, 0, 14).set(BONE.ULegR, 0, 0, 8);
      },
    },
    {
      t: 0.52,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(-0.03, 0.82, 0).set(BONE.Pelvis, 6, 0, 6).set(BONE.Spine, 12, 0, 4).set(BONE.Head, 0);
        p.set(BONE.UArmL, -30, 0, 55).set(BONE.UArmR, -30, 0, -45).set(BONE.LArmL, -40).set(BONE.LArmR, -40);
        p.ankle(0, AY, 0.04).ankle(1, AY, -0.04);
        p.set(BONE.ULegL, 0, 0, 8).set(BONE.ULegR, 0, 0, -9);
      },
    },
    { t: 0.8, build: (p) => standAt(p, 0) },
  ]);
}

function buildStumble(): PoseFn {
  return keyed([
    { t: 0, build: (p) => standAt(p, 0) },
    {
      t: 0.15,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 0.92, 0).set(BONE.Pelvis, -8).set(BONE.Spine, -12).set(BONE.Chest, -8).set(BONE.Head, 22);
        p.set(BONE.UArmL, -70, 0, 35).set(BONE.UArmR, -70, 0, -35).set(BONE.LArmL, -40).set(BONE.LArmR, -40);
      },
    },
    {
      t: 0.42,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 0.89, -0.06).set(BONE.Pelvis, -6).set(BONE.Spine, -8).set(BONE.Chest, -4).set(BONE.Head, 10);
        p.set(BONE.UArmL, -125, 0, 40).set(BONE.UArmR, -40, 0, -50).set(BONE.LArmL, -30).set(BONE.LArmR, -50);
        p.ankle(0, AY, -0.26).ankle(1, AY + 0.04, 0.06, 20);
      },
    },
    {
      t: 0.7,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 0.9, -0.12).set(BONE.Pelvis, -2).set(BONE.Spine, 0).set(BONE.Head, 6);
        p.set(BONE.UArmL, -40, 0, 45).set(BONE.UArmR, -130, 0, -40).set(BONE.LArmL, -50).set(BONE.LArmR, -30);
        p.ankle(0, AY, -0.24).ankle(1, AY, -0.1);
      },
    },
    {
      t: 0.95,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 0.9, -0.06).set(BONE.Pelvis, 6).set(BONE.Spine, 12).set(BONE.Head, -4);
        p.set(BONE.UArmL, -20, 0, 20).set(BONE.UArmR, -20, 0, -20).set(BONE.LArmL, -30).set(BONE.LArmR, -30);
        p.ankle(0, AY, -0.06).ankle(1, AY, -0.04);
      },
    },
    { t: 1.2, build: (p) => standAt(p, 0) },
  ]);
}

function buildFallBack(): PoseFn {
  const lb = lieRef(false);
  const aL = ankleOf(lb, 0);
  const aR = ankleOf(lb, 1);
  return keyed([
    { t: 0, build: (p) => standAt(p, 0.55) },
    {
      t: 0.22,
      build: (p) => {
        standAt(p, 0.55);
        p.setRoot(0, 0.9, 0.48).set(BONE.Pelvis, -14).set(BONE.Spine, -10).set(BONE.Head, 14);
        p.set(BONE.UArmL, -70, 0, 40).set(BONE.UArmR, -60, 0, -45).set(BONE.LArmL, -40).set(BONE.LArmR, -30);
        p.ankle(0, AY, 0.62).ankle(1, AY + 0.03, 0.5);
      },
    },
    {
      t: 0.52,
      build: (p) => {
        p.reset();
        p.setRoot(0, 0.46, 0.2).set(BONE.Pelvis, -50).set(BONE.Spine, -4).set(BONE.Head, 28);
        p.set(BONE.UArmL, -40, 0, 72).set(BONE.UArmR, -50, 0, -70).set(BONE.LArmL, -30).set(BONE.LArmR, -30);
        p.ankle(0, 0.16, 0.84, 20).ankle(1, 0.1, 0.78, 10);
      },
    },
    {
      t: 0.74,
      build: (p) => {
        p.reset();
        p.setRoot(0, 0.14, 0.02).set(BONE.Pelvis, -86).set(BONE.Spine, 4).set(BONE.Head, 24);
        p.set(BONE.UArmL, 0, 0, 62).set(BONE.UArmR, 0, 0, -58).set(BONE.LArmL, -20).set(BONE.LArmR, -30);
        p.ankle(0, 0.22, 0.84, 30).ankle(1, 0.18, 0.86, 30);
      },
    },
    {
      t: 1.0,
      build: (p) => {
        p.copy(lb);
        p.ankle(0, aL[0], aL[1], aL[2]).ankle(1, aR[0], aR[1], aR[2]);
      },
    },
  ]);
}

function buildGetUpBack(): PoseFn {
  const lb = lieRef(false);
  const aL = ankleOf(lb, 0);
  const aR = ankleOf(lb, 1);
  const END = 0.42;
  return keyed([
    {
      t: 0,
      build: (p) => {
        p.copy(lb);
        p.ankle(0, aL[0], aL[1], aL[2]).ankle(1, aR[0], aR[1], aR[2]);
      },
    },
    {
      t: 0.42,
      build: (p) => {
        p.reset();
        p.setRoot(0, LIE_H, 0).set(BONE.Pelvis, -58).set(BONE.Spine, 20).set(BONE.Chest, 10).set(BONE.Head, 22);
        p.set(BONE.UArmL, 35, 0, 26).set(BONE.UArmR, 35, 0, -26).set(BONE.LArmL, -14).set(BONE.LArmR, -14);
        p.ankle(0, 0.1, 0.78, 20).ankle(1, 0.1, 0.8, 25);
      },
    },
    {
      t: 0.88,
      build: (p) => {
        p.reset();
        p.setRoot(0, LIE_H, 0.06).set(BONE.Pelvis, -15).set(BONE.Spine, 26).set(BONE.Chest, 10).set(BONE.Head, 8);
        p.set(BONE.UArmL, 22, 0, 30).set(BONE.UArmR, 22, 0, -30).set(BONE.LArmL, -10).set(BONE.LArmR, -10);
        p.ankle(0, AY, 0.42).ankle(1, AY, 0.4);
      },
    },
    {
      t: 1.32,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.42, 0.14).set(BONE.Pelvis, 34).set(BONE.Spine, 28).set(BONE.Chest, 12).set(BONE.Head, -16);
        p.set(BONE.UArmL, -58, 0, 10).set(BONE.UArmR, -58, 0, -10).set(BONE.LArmL, -40).set(BONE.LArmR, -40);
        p.ankle(0, AY, END).ankle(1, AY, END - 0.02);
      },
    },
    {
      t: 1.76,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.76, 0.31).set(BONE.Pelvis, 14).set(BONE.Spine, 12).set(BONE.Chest, 5).set(BONE.Head, -6);
        p.set(BONE.UArmL, -22, 0, 8).set(BONE.UArmR, -22, 0, -8).set(BONE.LArmL, -26).set(BONE.LArmR, -26);
        p.ankle(0, AY, END).ankle(1, AY, END - 0.01);
      },
    },
    { t: 2.2, build: (p) => standAt(p, END) },
  ]);
}

function buildGetUpFront(): PoseFn {
  const lf = lieRef(true);
  const aL = ankleOf(lf, 0);
  const aR = ankleOf(lf, 1);
  const END = -0.3;
  return keyed([
    {
      t: 0,
      build: (p) => {
        p.copy(lf);
        p.ankle(0, aL[0], aL[1], aL[2]).ankle(1, aR[0], aR[1], aR[2]);
      },
    },
    {
      t: 0.45,
      build: (p) => {
        p.reset();
        p.setRoot(0, 0.17, 0).set(BONE.Pelvis, 76).set(BONE.Spine, -10).set(BONE.Chest, -8).set(BONE.Head, -22);
        p.set(BONE.UArmL, -58, 0, 14).set(BONE.UArmR, -58, 0, -14).set(BONE.LArmL, -10).set(BONE.LArmR, -10);
        p.ankle(0, 0.1, -0.8, 60).ankle(1, 0.1, -0.82, 62);
      },
    },
    {
      t: 0.95,
      build: (p) => {
        p.reset();
        p.setRoot(0, 0.46, -0.3).set(BONE.Pelvis, 60).set(BONE.Spine, 2).set(BONE.Chest, 0).set(BONE.Head, -24);
        p.set(BONE.UArmL, -62, 0, 10).set(BONE.UArmR, -62, 0, -10).set(BONE.LArmL, -6).set(BONE.LArmR, -6);
        p.ankle(0, 0.08, -0.7, 100).ankle(1, 0.08, -0.72, 100);
      },
    },
    {
      t: 1.45,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.5, -0.22).set(BONE.Pelvis, 40).set(BONE.Spine, 20).set(BONE.Chest, 5).set(BONE.Head, -22);
        p.set(BONE.UArmL, -32, 0, 10).set(BONE.UArmR, -32, 0, -10).set(BONE.LArmL, -40).set(BONE.LArmR, -40);
        p.ankle(0, AY, -0.06).ankle(1, 0.12, -0.5, 60);
      },
    },
    {
      t: 1.85,
      build: (p) => {
        stand(p);
        p.setRoot(0, 0.78, -0.26).set(BONE.Pelvis, 14).set(BONE.Spine, 10).set(BONE.Head, -6);
        p.set(BONE.UArmL, -14, 0, 8).set(BONE.UArmR, -14, 0, -8).set(BONE.LArmL, -24).set(BONE.LArmR, -24);
        p.ankle(0, AY, -0.18).ankle(1, AY, -0.38);
      },
    },
    { t: 2.2, build: (p) => standAt(p, END) },
  ]);
}

function cheer(t: number, p: Pose): void {
  const ph = TAU * t; // 1 s cycle (loop 2 s)
  stand(p);
  p.root[1] = HIP_H - 0.02 + 0.03 * Math.abs(sin(ph));
  p.set(BONE.LLegL, 6 + 8 * Math.abs(cos(ph))).set(BONE.LLegR, 6 + 8 * Math.abs(cos(ph)));
  p.set(BONE.ULegL, -3, 0, 2).set(BONE.ULegR, -3, 0, -2);
  p.set(BONE.UArmL, -158 + 14 * sin(2 * ph), 0, 24 + 10 * sin(ph)).set(BONE.LArmL, -22 + 16 * sin(2 * ph + 1));
  p.set(BONE.UArmR, -158 + 14 * sin(2 * ph + 2), 0, -24 + 10 * sin(ph)).set(BONE.LArmR, -22 + 16 * sin(2 * ph + 3));
  p.set(BONE.Head, -10 + 4 * sin(2 * ph), 8 * sin(ph * 0.5), 0);
  p.set(BONE.Chest, -4, 6 * sin(ph * 0.5), 0);
}

function clap(t: number, p: Pose): void {
  idle(t, p, 0.4);
  const c = 0.5 + 0.5 * sin(TAU * 3 * t);
  p.set(BONE.UArmL, -42, -38, -4 + 12 * c).set(BONE.LArmL, -78);
  p.set(BONE.UArmR, -42, 38, 4 - 12 * c).set(BONE.LArmR, -78);
  p.set(BONE.Head, -2 + 2 * sin(TAU * 3 * t), 0, 0);
}

/** Concert: bouncing on the beat (120 bpm) with a fist pump — feet planted in the dip, off the ground at the top. */
function jump(t: number, p: Pose): void {
  const ph = TAU * 2 * t;
  stand(p);
  const up = pos(sin(ph));
  const dip = pos(-sin(ph));
  p.root[1] = HIP_H - 0.08 * dip + 0.14 * up;
  p.set(BONE.Pelvis, 6 * dip).set(BONE.Spine, 4 * dip).set(BONE.Head, -8 + 10 * dip);
  p.set(BONE.UArmR, -118 - 52 * up, 0, -12).set(BONE.LArmR, -34 + 26 * up);
  p.set(BONE.UArmL, -24 - 14 * up, 0, 20).set(BONE.LArmL, -70);
  p.ankle(0, AY + 0.12 * up, -0.004).ankle(1, AY + 0.12 * up, -0.004);
  solveLegIK(p);
}

/** Concert: both arms up, swaying side to side. */
function sway(t: number, p: Pose): void {
  const s = sin((TAU * t) / 2);
  stand(p);
  p.root[0] = 0.03 * s;
  p.root[1] = HIP_H - 0.01 - 0.01 * Math.abs(s);
  p.set(BONE.Pelvis, 0, 0, 4 * s).set(BONE.Spine, 0, 0, 5 * s).set(BONE.Chest, -4, 0, 5 * s);
  p.set(BONE.UArmL, -164, 0, 16 + 14 * s).set(BONE.LArmL, -10);
  p.set(BONE.UArmR, -164, 0, -16 + 14 * s).set(BONE.LArmR, -10);
  p.set(BONE.Head, -10, 0, 7 * s);
  p.ankle(0, AY, -0.004).ankle(1, AY, -0.004);
  solveLegIK(p);
}

function buildFlinch(): PoseFn {
  return keyed([
    { t: 0, build: (p) => standAt(p, 0) },
    {
      t: 0.12,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 0.9, -0.02).set(BONE.Pelvis, -4).set(BONE.Spine, -4).set(BONE.Chest, -6).set(BONE.Head, 12);
        p.set(BONE.UArmL, -60, 30, 22).set(BONE.UArmR, -60, -30, -22).set(BONE.LArmL, -110).set(BONE.LArmR, -110);
      },
    },
    {
      t: 0.38,
      build: (p) => {
        standAt(p, 0);
        p.setRoot(0, 0.91, -0.02).set(BONE.Spine, -2).set(BONE.Chest, -4).set(BONE.Head, 6);
        p.set(BONE.UArmL, -45, 25, 18).set(BONE.UArmR, -45, -25, -18).set(BONE.LArmL, -95).set(BONE.LArmR, -95);
      },
    },
    { t: 0.7, build: (p) => standAt(p, 0) },
  ]);
}

function mirrored(fn: PoseFn): PoseFn {
  const tmp = new Pose();
  return (t, p) => {
    tmp.reset();
    fn(t, tmp);
    p.mirrorFrom(tmp);
  };
}

function defs(): ClipDef[] {
  const hopL = buildHopL();
  return [
    { id: CLIP.idle, name: 'idle', duration: 4, loop: true, fps: 20, fn: (t, p) => idle(t, p) },
    { id: CLIP.walk, name: 'walk', duration: 1, loop: true, fps: 30, fn: walk },
    { id: CLIP.run, name: 'run', duration: 0.66, loop: true, fps: 30, fn: run },
    { id: CLIP.flee, name: 'flee', duration: 0.6, loop: true, fps: 30, fn: flee },
    { id: CLIP.talk, name: 'talk', duration: 4, loop: true, fps: 20, fn: talk },
    { id: CLIP.phone, name: 'phone', duration: 4, loop: true, fps: 20, fn: phone },
    { id: CLIP.lookAround, name: 'lookAround', duration: 4, loop: true, fps: 20, fn: lookAround },
    { id: CLIP.armsCrossed, name: 'armsCrossed', duration: 4, loop: true, fps: 20, fn: armsCrossed },
    { id: CLIP.sit, name: 'sit', duration: 4, loop: true, fps: 20, fn: sit },
    { id: CLIP.sitPhone, name: 'sitPhone', duration: 4, loop: true, fps: 20, fn: sitPhone },
    { id: CLIP.sitDown, name: 'sitDown', duration: 1, loop: false, fps: 30, fn: buildSitDown(), rootStartZ: SIT_STAND_Z },
    { id: CLIP.standUp, name: 'standUp', duration: 1, loop: false, fps: 30, fn: buildStandUp(), rootEndZ: SIT_STAND_Z },
    { id: CLIP.dive, name: 'dive', duration: 1, loop: false, fps: 30, fn: buildDive() },
    { id: CLIP.hopL, name: 'hopL', duration: 0.8, loop: false, fps: 30, fn: hopL },
    { id: CLIP.hopR, name: 'hopR', duration: 0.8, loop: false, fps: 30, fn: mirrored(hopL) },
    { id: CLIP.stumble, name: 'stumble', duration: 1.2, loop: false, fps: 30, fn: buildStumble() },
    { id: CLIP.fallBack, name: 'fallBack', duration: 1, loop: false, fps: 30, fn: buildFallBack(), rootStartZ: 0.55 },
    { id: CLIP.tumble, name: 'tumble', duration: 0.8, loop: true, fps: 30, fn: tumble },
    { id: CLIP.relaxB, name: 'relaxB', duration: 2, loop: true, fps: 15, fn: relax(false) },
    { id: CLIP.relaxF, name: 'relaxF', duration: 2, loop: true, fps: 15, fn: relax(true) },
    { id: CLIP.lieBack, name: 'lieBack', duration: 2, loop: true, fps: 15, fn: lie(false) },
    { id: CLIP.lieFront, name: 'lieFront', duration: 2, loop: true, fps: 15, fn: lie(true) },
    { id: CLIP.getUpBack, name: 'getUpBack', duration: 2.2, loop: false, fps: 30, fn: buildGetUpBack(), rootEndZ: 0.42 },
    { id: CLIP.getUpFront, name: 'getUpFront', duration: 2.2, loop: false, fps: 30, fn: buildGetUpFront(), rootEndZ: -0.3 },
    { id: CLIP.flinch, name: 'flinch', duration: 0.7, loop: false, fps: 30, fn: buildFlinch() },
    { id: CLIP.cheer, name: 'cheer', duration: 2, loop: true, fps: 24, fn: cheer },
    { id: CLIP.clap, name: 'clap', duration: 1, loop: true, fps: 24, fn: clap },
    { id: CLIP.jump, name: 'jump', duration: 1, loop: true, fps: 24, fn: jump },
    { id: CLIP.sway, name: 'sway', duration: 2, loop: true, fps: 20, fn: sway },
    { id: CLIP.sitPanic, name: 'sitPanic', duration: 2, loop: true, fps: 24, fn: sitPanic },
    { id: CLIP.sitBrace, name: 'sitBrace', duration: 2, loop: true, fps: 15, fn: sitBrace },
    { id: CLIP.sitLookPX, name: 'sitLookPX', duration: 4, loop: true, fps: 15, fn: sitLookPX },
    { id: CLIP.sitLookNX, name: 'sitLookNX', duration: 4, loop: true, fps: 15, fn: mirrored(sitLookPX) },
  ];
}

export interface BakedClips {
  texture: THREE.DataTexture;
  clips: ClipInfo[];
  rows: number;
}

/** Bake every clip into an RGBA32F texture: width = bones × 3 texels (rows of the 3x4 skin matrix), height = frames. */
export function bakeClips(): BakedClips {
  const list = defs().sort((a, b) => a.id - b.id);
  const clips: ClipInfo[] = [];
  let rows = 0;
  for (const d of list) {
    const frames = d.loop ? Math.max(2, Math.round(d.duration * d.fps)) : Math.round(d.duration * d.fps) + 1;
    clips.push({
      name: d.name,
      start: rows,
      frames,
      fps: d.fps,
      duration: d.duration,
      loop: d.loop,
      rootStartZ: d.rootStartZ ?? 0,
      rootEndZ: d.rootEndZ ?? 0,
    });
    rows += frames;
  }
  const width = NUM_BONES * 3;
  const data = new Float32Array(width * rows * 4);
  const pose = new Pose();
  for (let ci = 0; ci < list.length; ci++) {
    const d = list[ci];
    const info = clips[ci];
    for (let f = 0; f < info.frames; f++) {
      const t = d.loop ? (f / info.frames) * d.duration : Math.min(d.duration, f / d.fps);
      pose.reset();
      d.fn(t, pose);
      const world = fk(pose);
      const row = info.start + f;
      for (let b = 0; b < NUM_BONES; b++) {
        const pv = PIVOTS[b];
        _skin.makeTranslation(-pv[0], -pv[1], -pv[2]).premultiply(world[b]);
        const e = _skin.elements; // column-major
        const o = (row * width + b * 3) * 4;
        // texel 0..2 = matrix rows 0..2
        data[o] = e[0];
        data[o + 1] = e[4];
        data[o + 2] = e[8];
        data[o + 3] = e[12];
        data[o + 4] = e[1];
        data[o + 5] = e[5];
        data[o + 6] = e[9];
        data[o + 7] = e[13];
        data[o + 8] = e[2];
        data[o + 9] = e[6];
        data[o + 10] = e[10];
        data[o + 11] = e[14];
      }
    }
  }
  const texture = new THREE.DataTexture(data, width, rows, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, clips, rows };
}
