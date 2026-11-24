import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { approach, DEG } from '../core/math';
import type { FlightSnapshot } from '../game/contracts';
import type { FlightInputs, FlightModel } from '../plane/FlightModel';

/**
 * Agent forecasts. The plane forecast runs a GHOST copy of the real flight model (same aero, assists, trim state)
 * on a tiny rigid body integrated like Rapier, with the agent's planned controls (held keys, autopilot, queued
 * commands), so "if you hold nose-up for 2 s, at +2 s you are at 48 m, pitch +9°" comes from the same physics.
 * Not modelled: collisions (reported as ground contact instead), turbulence, wing-failure torques, engine fires.
 */

const _qa = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _m = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

/** Rigid body with the subset of the Rapier API the flight model uses, integrated semi-implicitly (like Rapier). */
class GhostBody {
  readonly p = new THREE.Vector3();
  readonly q = new THREE.Quaternion();
  readonly v = new THREE.Vector3();
  readonly w = new THREE.Vector3();
  private F = new THREE.Vector3();
  private M = new THREE.Vector3();
  private invI = new THREE.Vector3();
  private frame = new THREE.Quaternion();
  private invMass = 0;
  private gy = 0;

  copyFrom(body: RAPIER.RigidBody): void {
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    this.p.set(t.x, t.y, t.z);
    this.q.set(r.x, r.y, r.z, r.w);
    this.v.set(lv.x, lv.y, lv.z);
    this.w.set(av.x, av.y, av.z);
    const m = body.mass();
    this.invMass = m > 0 ? 1 / m : 0;
    const I = body.principalInertia();
    this.invI.set(I.x > 0 ? 1 / I.x : 0, I.y > 0 ? 1 / I.y : 0, I.z > 0 ? 1 / I.z : 0);
    const f = body.principalInertiaLocalFrame();
    this.frame.set(f.x, f.y, f.z, f.w);
    this.gy = CONFIG.physics.gravity * body.gravityScale();
  }

  rotation(): THREE.Quaternion {
    return this.q;
  }
  linvel(): THREE.Vector3 {
    return this.v;
  }
  angvel(): THREE.Vector3 {
    return this.w;
  }
  resetForces(): void {
    this.F.set(0, 0, 0);
  }
  resetTorques(): void {
    this.M.set(0, 0, 0);
  }
  addForce(f: { x: number; y: number; z: number }): void {
    this.F.x += f.x;
    this.F.y += f.y;
    this.F.z += f.z;
  }
  addTorque(t: { x: number; y: number; z: number }): void {
    this.M.x += t.x;
    this.M.y += t.y;
    this.M.z += t.z;
  }

  step(dt: number): void {
    const { v, w, q } = this;
    v.x += this.F.x * this.invMass * dt;
    v.y += (this.F.y * this.invMass + this.gy) * dt;
    v.z += this.F.z * this.invMass * dt;
    // ω += I_world⁻¹ τ dt (principal frame), no gyroscopic term (Rapier's default)
    _qa.copy(q).multiply(this.frame);
    _m.copy(this.M).applyQuaternion(_qi.copy(_qa).invert()).multiply(this.invI).applyQuaternion(_qa);
    w.addScaledVector(_m, dt);
    this.p.addScaledVector(v, dt);
    const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
    const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
    q.set(qx + hx * qw + hy * qz - hz * qy, qy + hy * qw + hz * qx - hx * qz, qz + hz * qw + hx * qy - hy * qx, qw - hx * qx - hy * qy - hz * qz).normalize();
  }
}

function cloneModel(m: FlightModel): FlightModel {
  const g = Object.assign(Object.create(Object.getPrototypeOf(m)), m) as FlightModel;
  const w = g as unknown as Record<string, unknown>;
  w.controls = { ...m.controls };
  w.surfaces = m.surfaces.map((s) => ({ ...s }));
  return g;
}

function cloneInputs(fi: FlightInputs): FlightInputs {
  return {
    ...fi,
    thrust: fi.thrust.slice(),
    sideDrag: fi.sideDrag.slice(),
    turb: new THREE.Vector3(),
    turbVert: 0,
    wind: fi.wind.clone(),
    controlScale: fi.controlScale.clone(),
  };
}

/** What the planner sees of the ghost each step (degrees for angles, heading 0 = north, 90 = east). */
export interface GhostView {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  V: number;
  agl: number;
  pitch: number;
  bank: number;
  heading: number;
  rest: number;
  throttle: number;
}

export interface GhostControls {
  pitch: number;
  roll: number;
  yaw: number;
  /** Flight-path angle (rad) for the assists to hold while the stick is neutral (autopilot), or null. */
  gamma: number | null;
  /** Throttle target 0..1 or null (keep). */
  throttle: number | null;
}

export interface ForecastPoint {
  t: number;
  agl: number;
  pitch: number;
  bank: number;
  heading: number;
  speed: number;
  vs: number;
}

export interface FlightForecast {
  points: ForecastPoint[];
  /** First ground/water contact (wheels), or null within the horizon. */
  impact: { t: number; speed: number; vs: number; pitch: number; bank: number; water: boolean } | null;
  /** The ghost stopped at a queued break-up command (split / explode / tail). */
  stop: { t: number; label: string; at: ForecastPoint; pos: THREE.Vector3; vel: THREE.Vector3 } | null;
  /** First stall warning. */
  stall: number | null;
  lowest: { t: number; agl: number };
  horizon: number;
}

export interface GroundSample {
  y: number;
  water: boolean;
}

/** Run the ghost: `control` is asked for the stick every step; `stops` end the flight (break-up commands). */
export function forecastFlight(
  snap: FlightSnapshot,
  horizon: number,
  ground: (x: number, z: number) => GroundSample,
  control: (v: GhostView) => GhostControls,
  stops: { t: number; label: string }[],
  every = 0.5,
): FlightForecast {
  const model = cloneModel(snap.model as FlightModel);
  const fi = cloneInputs(snap.inputs as FlightInputs);
  const gb = new GhostBody();
  gb.copyFrom(snap.body);
  const dt = 1 / 60;
  const baseThrust = fi.thrust.slice();
  const k0 = snap.idle + (1 - snap.idle) * Math.max(0.02, snap.spool);
  const spoolS = (model.cfg as { spoolS?: number }).spoolS ?? 4;
  let spool = snap.spool;
  let throttle = snap.throttle;
  let g = ground(gb.p.x, gb.p.z);
  let nextG = 0.1;
  const out: FlightForecast = { points: [], impact: null, stop: null, stall: null, lowest: { t: 0, agl: Infinity }, horizon };
  const stopList = stops.slice().sort((a, b) => a.t - b.t);
  let stopI = 0;
  let nextPoint = every;
  const view: GhostView = { t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, V: 0, agl: 0, pitch: 0, bank: 0, heading: 0, rest: snap.rest, throttle };
  const point = (t: number): ForecastPoint => ({ t, agl: view.agl, pitch: view.pitch, bank: view.bank, heading: view.heading, speed: view.V, vs: view.vy });
  const steps = Math.ceil(horizon / dt);
  for (let i = 1; i <= steps; i++) {
    const t = i * dt;
    if (t >= nextG) {
      g = ground(gb.p.x, gb.p.z);
      nextG = t + 0.1;
    }
    // attitude straight from the ghost body (heading 0 = north / -Z)
    _fwd.set(0, 0, 1).applyQuaternion(gb.q);
    _up.set(0, 1, 0).applyQuaternion(gb.q);
    _right.set(-1, 0, 0).applyQuaternion(gb.q);
    view.t = t;
    view.x = gb.p.x;
    view.y = gb.p.y;
    view.z = gb.p.z;
    view.vx = gb.v.x;
    view.vy = gb.v.y;
    view.vz = gb.v.z;
    view.V = gb.v.length();
    view.agl = gb.p.y - snap.rest - g.y;
    view.pitch = Math.asin(Math.max(-1, Math.min(1, _fwd.y))) / DEG;
    view.bank = Math.atan2(-_right.y, _up.y) / DEG;
    view.heading = ((Math.atan2(_fwd.x, -_fwd.z) / DEG) % 360 + 360) % 360;
    view.throttle = throttle;
    if (view.agl < out.lowest.agl) out.lowest = { t, agl: view.agl };
    if (stopI < stopList.length && t >= stopList[stopI].t) {
      const s = stopList[stopI];
      out.stop = { t: s.t, label: s.label, at: point(s.t), pos: gb.p.clone(), vel: gb.v.clone() };
      break;
    }
    if (view.agl <= 0) {
      out.impact = { t, speed: view.V, vs: view.vy, pitch: view.pitch, bank: view.bank, water: g.water };
      break;
    }
    const c = control(view);
    fi.pitch = c.pitch;
    fi.roll = c.roll;
    fi.yaw = c.yaw;
    if (c.gamma !== null && Math.abs(c.pitch) < 0.06) model.gammaHold = c.gamma;
    if (c.throttle !== null) throttle = c.throttle;
    spool = approach(spool, throttle, ((throttle > spool ? 1 : 1.5) / spoolS) * dt);
    const k = (snap.idle + (1 - snap.idle) * spool) / k0;
    for (let e = 0; e < baseThrust.length; e++) fi.thrust[e] = baseThrust[e] * k;
    fi.onGround = false;
    fi.wheelAgl = view.agl;
    fi.agl = view.agl + snap.rest;
    model.step(dt, gb as unknown as RAPIER.RigidBody, fi);
    gb.step(dt);
    if (out.stall === null && model.stallWarning) out.stall = t;
    if (t >= nextPoint - 1e-6) {
      out.points.push(point(t));
      nextPoint += every;
    }
  }
  return out;
}

/**
 * Point-mass fall to the ground (wreck pieces, the character, a car in the air). `gAt(t)` = downward acceleration
 * (m/s²) after t seconds; `drag` = k in a = -k·v·|v| (terminal ≈ sqrt(g/k)). Returns the first contact or null.
 */
export function fallForecast(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  ground: (x: number, z: number) => GroundSample,
  gAt: (t: number) => number,
  drag = 0,
  maxT = 25,
): { t: number; speed: number; x: number; z: number; water: boolean; dist: number } | null {
  let x = pos.x, y = pos.y, z = pos.z;
  let vx = vel.x, vy = vel.y, vz = vel.z;
  const dt = 0.02;
  for (let t = dt; t <= maxT; t += dt) {
    const sp = Math.hypot(vx, vy, vz);
    vx -= drag * vx * sp * dt;
    vz -= drag * vz * sp * dt;
    vy += (-gAt(t) - drag * vy * sp) * dt;
    x += vx * dt;
    y += vy * dt;
    z += vz * dt;
    const g = ground(x, z);
    if (y <= g.y) return { t, speed: Math.hypot(vx, vy, vz), x, z, water: g.water, dist: Math.hypot(x - pos.x, z - pos.z) };
  }
  return null;
}

/** Wreck pieces: aero for ~1.2 s, then gravity ramps to ~2.1 g (CONFIG.planes.fall / breakup behaviour), ~150 m/s cap. */
export const wreckG = (t: number): number => 9.81 * (t < 1.2 ? 0.8 : Math.min(2.1, 0.8 + (t - 1.2) * 0.9));
