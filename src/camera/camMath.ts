import * as THREE from 'three';
import { wrapAngle } from '../core/math';

/**
 * Camera math toolkit: critically damped springs (stable for any dt), easing curves, smooth 1D noise and a
 * camera pose (position + orientation + fov) with pivot-aware blending. Allocation-free in the hot path.
 */

export const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export interface SpringState {
  v: number;
}

/**
 * Critically damped spring toward `target` (the classic "SmoothDamp", Game Programming Gems 4 ch. 1.10).
 * `smoothTime` ≈ time to (mostly) reach the target. Velocity is kept in `s.v`, so motion stays C1-continuous.
 */
export function smoothDamp(cur: number, target: number, s: SpringState, smoothTime: number, dt: number): number {
  if (dt <= 0) return cur;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (s.v + omega * change) * dt;
  s.v = (s.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/** smoothDamp for angles (shortest way round). The returned angle is NOT wrapped, so it stays continuous. */
export function smoothDampAngle(cur: number, target: number, s: SpringState, smoothTime: number, dt: number): number {
  return smoothDamp(cur, cur + wrapAngle(target - cur), s, smoothTime, dt);
}

/** Component-wise smoothDamp on a vector (vel holds the per-axis velocities). */
export function smoothDampVec3(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number): void {
  if (dt <= 0) return;
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (let i = 0; i < 3; i++) {
    const c = cur.getComponent(i);
    const change = c - target.getComponent(i);
    const v = vel.getComponent(i);
    const temp = (v + omega * change) * dt;
    vel.setComponent(i, (v - omega * temp) * exp);
    cur.setComponent(i, target.getComponent(i) + (change + temp) * exp);
  }
}

/**
 * Exact step of a critically damped oscillator x'' = -ω²x - 2ωx' (per component, in place).
 * Used for the "inertia" offset: kick v with the target's velocity change, the offset rings out without overshoot.
 */
export function critStep(x: THREE.Vector3, v: THREE.Vector3, omega: number, dt: number): void {
  if (dt <= 0) return;
  const e = Math.exp(-omega * dt);
  const kx = v.x + omega * x.x;
  const ky = v.y + omega * x.y;
  const kz = v.z + omega * x.z;
  x.set((x.x + kx * dt) * e, (x.y + ky * dt) * e, (x.z + kz * dt) * e);
  v.set((v.x - omega * kx * dt) * e, (v.y - omega * ky * dt) * e, (v.z - omega * kz * dt) * e);
}

/** Exponential approach factor for frame-rate independent damping. */
export const expK = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt);

// ── easing ──
export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const smooth01 = (t: number) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const smoother01 = (t: number) => {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
export const easeInOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(t));
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

// ── smooth noise ──
function hash1(i: number, seed: number): number {
  const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453123;
  return (s - Math.floor(s)) * 2 - 1;
}

/** Smooth 1D value noise in about [-1, 1] (two octaves, quintic interpolation). Non-periodic. */
export function noise1(x: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  for (let o = 0; o < 2; o++) {
    const xf = x * freq;
    const i = Math.floor(xf);
    const f = xf - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    sum += amp * (hash1(i, seed + o * 17) * (1 - u) + hash1(i + 1, seed + o * 17) * u);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / 1.5;
}

// ── pose ──
export class CamPose {
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  fov = 62;

  copy(o: CamPose): this {
    this.pos.copy(o.pos);
    this.quat.copy(o.quat);
    this.fov = o.fov;
    return this;
  }

  /** Orient toward `target` with world up, then roll about the view axis (radians, + = counter-clockwise). */
  lookAt(target: THREE.Vector3, roll = 0, up: THREE.Vector3 = WORLD_UP): this {
    _m.lookAt(this.pos, target, up);
    this.quat.setFromRotationMatrix(_m);
    if (roll) this.quat.multiply(_q.setFromAxisAngle(AXIS_Z, roll));
    return this;
  }

  /** Rotate the view about world up (radians, + = toward +yaw / left turn). */
  yawBy(angle: number): this {
    if (angle) this.quat.premultiply(_q.setFromAxisAngle(WORLD_UP, angle));
    return this;
  }
}

/**
 * Blend two poses. With a pivot (the car), positions are interpolated in spherical coordinates around it, so a
 * transition swings AROUND the car instead of cutting through it. Orientation is slerped, fov lerped.
 */
export function blendPoses(a: CamPose, b: CamPose, w: number, pivot: THREE.Vector3 | null, out: CamPose): CamPose {
  if (w <= 0) return out.copy(a);
  if (w >= 1) return out.copy(b);
  if (pivot) {
    _a.subVectors(a.pos, pivot);
    _b.subVectors(b.pos, pivot);
    const da = _a.length();
    const db = _b.length();
    if (da > 0.05 && db > 0.05) {
      const ya = Math.atan2(_a.x, _a.z);
      const yb = Math.atan2(_b.x, _b.z);
      const pa = Math.asin(THREE.MathUtils.clamp(_a.y / da, -1, 1));
      const pb = Math.asin(THREE.MathUtils.clamp(_b.y / db, -1, 1));
      const yaw = ya + wrapAngle(yb - ya) * w;
      const pitch = pa + (pb - pa) * w;
      const d = da + (db - da) * w;
      const cp = Math.cos(pitch);
      out.pos.set(pivot.x + Math.sin(yaw) * cp * d, pivot.y + Math.sin(pitch) * d, pivot.z + Math.cos(yaw) * cp * d);
    } else {
      out.pos.lerpVectors(a.pos, b.pos, w);
    }
  } else {
    out.pos.lerpVectors(a.pos, b.pos, w);
  }
  out.quat.slerpQuaternions(a.quat, b.quat, w);
  out.fov = a.fov + (b.fov - a.fov) * w;
  return out;
}
