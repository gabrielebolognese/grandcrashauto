import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups } from '../core/Physics';
import type { GameContext } from '../game/contracts';

/** What the stunt system needs from the vehicle each fixed step (reused object, no allocation). */
export interface StuntFrame {
  body: RAPIER.RigidBody;
  nContact: number;
  pos: THREE.Vector3; // chassis translation
  vel: THREE.Vector3; // pre-step velocity
  fwd: THREE.Vector3;
  left: THREE.Vector3;
  up: THREE.Vector3;
  groundN: THREE.Vector3; // contact normal (or landing normal when airborne)
  gravity: number; // |g|
  liftAccel: number; // current glide lift acceleration (m/s², along car up) for the prediction
  barrel: number; // -1 left, +1 right, 0 none (trigger this step)
}

export interface StuntHost {
  readonly ctx: GameContext;
  /** Crash landing: dents/glass, maybe explode. */
  crashLanding(impactSpeed: number): void;
}

/**
 * Airborne mode, landings and barrel rolls (SPEC-PART3 §8, §8a). Owner: src/vehicle.
 *  - airborne mode starts when all wheels leave the ground above ~60 km/h with enough predicted air time,
 *  - predicted landing = ballistic arc (incl. glide lift) ray-cast against the world every few steps,
 *  - barrel roll: angular velocity to finish 360° in ~70% of the remaining air time, auto-stabilised over the last
 *    60° relative to the landing surface; combos when pressed again after a roll completes,
 *  - landing verdict: clean (wheels first, near level) or crash (roof/nose first or > 45° tilt).
 */
export class Stunts {
  readonly info = { active: false, time: 0, distance: 0, predicted: 0, gliding: false, rolling: false, rolls: 0 };
  /** Seconds since the last wheel contact. */
  airT = 0;
  private takeoffSpeed = 0;
  private start = new THREE.Vector3();
  private predictTotal = 0;
  private lastPredictAirT = -1;
  private rollDir = 0;
  private rolled = 0;
  private rollOmega = 0;
  private glideAnnounced = false;
  private chassisHit = false;
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private w = new THREE.Vector3();
  private rv = { x: 0, y: 0, z: 0 };

  constructor(private host: StuntHost) {}

  reset(): void {
    const i = this.info;
    i.active = i.gliding = i.rolling = false;
    i.time = i.distance = i.predicted = 0;
    i.rolls = 0;
    this.airT = 0;
    this.rolled = 0;
    this.rollDir = 0;
    this.glideAnnounced = false;
    this.chassisHit = false;
    this.lastPredictAirT = -1;
  }

  shift(dx: number, dz: number): void {
    this.start.x -= dx;
    this.start.z -= dz;
  }

  /** The chassis touched the world while airborne (roof / nose / side first). */
  chassisContact(): void {
    if (this.info.active) this.chassisHit = true;
  }

  /** Glide on/off this step (emits 'airGlide' once per flight). */
  setGliding(on: boolean): void {
    const i = this.info;
    i.gliding = on && i.active;
    if (i.gliding && !this.glideAnnounced) {
      this.glideAnnounced = true;
      this.host.ctx.events.emit('stunt', { kind: 'airGlide', airTime: i.time, distance: i.distance, rolls: i.rolls });
    }
  }

  /** True while the roll controller owns the roll axis (air auto-level must not fight it). */
  get rolling(): boolean {
    return this.info.rolling;
  }

  step(dt: number, f: StuntFrame): void {
    const S = CONFIG.vehicle.stunts;
    const i = this.info;
    const ev = this.host.ctx.events;

    // ── touchdown
    if (f.nContact > 0 || this.chassisHit) {
      if (i.active) this.land(f);
      this.airT = 0;
      this.chassisHit = false;
      i.active = i.gliding = i.rolling = false;
      i.time = i.distance = i.predicted = 0;
      this.glideAnnounced = false;
      this.lastPredictAirT = -1;
      if (f.nContact > 0) {
        this.takeoffSpeed = f.vel.length();
        this.start.copy(f.pos);
      }
      return;
    }

    // ── in the air
    this.airT += dt;
    if (this.airT > S.enterAir && (this.lastPredictAirT < 0 || this.airT - this.lastPredictAirT >= 0.1)) {
      this.lastPredictAirT = this.airT;
      const remaining = this.predict(f);
      this.predictTotal = this.airT + remaining;
      i.predicted = remaining;
    } else i.predicted = Math.max(0, i.predicted - dt);

    if (!i.active && this.airT > S.enterAir && this.takeoffSpeed > S.minKmh / 3.6 && this.predictTotal >= S.minPredicted) {
      i.active = true;
      i.rolls = 0;
      ev.emit('stunt', { kind: 'airborne', airTime: this.airT, distance: 0 });
    }
    if (i.active) {
      i.time = this.airT;
      i.distance = Math.hypot(f.pos.x - this.start.x, f.pos.z - this.start.z);
    }

    // ── barrel roll
    if (f.barrel !== 0 && i.active && !i.rolling && i.predicted >= S.rollMinAir) {
      // time the roll on the arc WITHOUT glide lift: the lift turns with the car while it rolls
      const noLift = f.liftAccel > 0 ? Math.min(i.predicted, this.predict(f, 0)) : i.predicted;
      const dur = Math.min(S.rollMaxTime, Math.max(S.rollMinTime, noLift * S.rollTimeFrac));
      this.rollDir = f.barrel;
      this.rollOmega = (Math.PI * 2) / dur;
      this.rolled = 0;
      i.rolling = true;
      if (this.predictTotal >= S.megaAirTime) this.host.ctx.game.slowMo?.(S.slowMoScale, S.slowMoTime);
    }
    if (i.rolling) this.stepRoll(dt, f);
  }

  private stepRoll(dt: number, f: StuntFrame): void {
    const S = CONFIG.vehicle.stunts;
    const i = this.info;
    const body = f.body;
    const av = body.angvel(this.rv);
    const w = this.w.set(av.x, av.y, av.z);
    const wF = w.dot(f.fwd);
    this.rolled += Math.max(0, wF * this.rollDir) * dt;
    const stab = (S.rollStabiliseDeg * Math.PI) / 180;
    let target = this.rollOmega;
    let done = false;
    if (this.rolled > Math.PI * 2 - stab - 0.05) {
      // Auto-stabilise: remaining rotation (in the roll direction) to come out level with the landing surface.
      const rollErr = Math.atan2(f.left.dot(f.groundN), f.up.dot(f.groundN)); // + = rotated positively about fwd
      let rem = this.rollDir > 0 ? -rollErr : rollErr;
      rem = ((rem % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      if (rem > Math.PI * 1.5) rem = 0; // tiny overshoot past level
      if (rem < 0.06 || this.rolled > Math.PI * 2 + stab) done = true;
      else target = Math.min(this.rollOmega, Math.max(1.4, rem * (this.rollOmega / stab) * 1.3));
    }
    // own the roll axis; keep pitch/yaw calm so the roll reads clean
    const want = done ? 0 : this.rollDir * target;
    const k = 1 - Math.min(1, 3 * dt);
    w.addScaledVector(f.fwd, -wF).multiplyScalar(k).addScaledVector(f.fwd, want);
    body.setAngvel(w, true);
    if (done) {
      i.rolling = false;
      i.rolls++;
      this.host.ctx.events.emit('stunt', { kind: 'barrelRoll', airTime: i.time, distance: i.distance, rolls: i.rolls });
    }
  }

  private land(f: StuntFrame): void {
    const S = CONFIG.vehicle.stunts;
    const i = this.info;
    const tilt = (Math.acos(Math.max(-1, Math.min(1, f.up.dot(f.groundN)))) * 180) / Math.PI;
    const bad = tilt > S.badLandingDeg || (this.chassisHit && tilt > 25) || i.rolling;
    const impact = Math.max(0, -f.vel.dot(f.groundN));
    if (i.time >= S.minStuntAir) {
      this.host.ctx.events.emit('stunt', { kind: bad ? 'crashLanding' : 'cleanLanding', airTime: i.time, distance: i.distance, rolls: i.rolls });
    }
    if (bad) this.host.crashLanding(impact);
  }

  /** Remaining air time (s): ballistic arc from the car's underside, ray-cast segment by segment. */
  private predict(f: StuntFrame, liftAccel = f.liftAccel): number {
    const S = CONFIG.vehicle.stunts;
    const world = this.host.ctx.physics.world;
    const gy = -f.gravity + liftAccel * Math.max(0, f.up.y);
    const step = Math.max(0.03, S.predictStep);
    let px = f.pos.x, py = f.pos.y - 0.3, pz = f.pos.z;
    const vx = f.vel.x, vz = f.vel.z;
    let vy = f.vel.y;
    const flt = groups(G.ALL, G.WORLD | G.PARKED);
    for (let t = 0; t < S.predictMax; t += step) {
      const nx = px + vx * step;
      const ny = py + vy * step + 0.5 * gy * step * step;
      const nz = pz + vz * step;
      vy += gy * step;
      const dx = nx - px, dy = ny - py, dz = nz - pz;
      const len = Math.hypot(dx, dy, dz);
      if (len > 1e-4) {
        this.ray.origin.x = px;
        this.ray.origin.y = py;
        this.ray.origin.z = pz;
        this.ray.dir.x = dx / len;
        this.ray.dir.y = dy / len;
        this.ray.dir.z = dz / len;
        const hit = world.castRay(this.ray, len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, flt, undefined, f.body);
        if (hit) return t + (hit.timeOfImpact / len) * step;
      }
      px = nx;
      py = ny;
      pz = nz;
    }
    return S.predictMax;
  }
}
