import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, lerp, wrapAngle } from '../core/math';
import type { GameContext } from '../game/contracts';
import { CamPose, critStep, expK, smooth01, smoothDamp, smoothDampAngle, type SpringState } from './camMath';
import type { CarFrame } from './CarFrame';
import { clampAboveGround, Occluder } from './Occluder';

/**
 * Chase camera (SPEC §11).
 *  - Heading: critically damped spring toward the car's nose, leaning toward the velocity direction (a little when
 *    gripping, a lot when drifting / sliding, fully when spinning out or flying). Never rolls/flips with the car.
 *  - Follow point: the car's geometric center, horizontally exact, vertically filtered (suspension jitter).
 *  - Inertia: an extra critically damped offset kicked by the car's velocity CHANGES — hard acceleration lets the
 *    car pull away, a crash makes the camera surge in, landings dip — with zero lag at constant speed.
 *  - Distance/height/FOV grow with speed, look-ahead into turns, a hint of bank, raycast occlusion, ground clamp.
 */
export class ChaseCam {
  readonly pose = new CamPose();
  /** Smoothed follow point (car center). Shared with the orbit camera and used as the blend pivot. */
  readonly pivot = new THREE.Vector3();
  heading = 0;
  dist = 6.4;
  height = 1.75;
  fov = 62;
  zoom = 1;
  zoomTarget = 1;

  private headingS: SpringState = { v: 0 };
  private pivotVy: SpringState = { v: 0 };
  private ahead = 1.5;
  private readonly inertiaX = new THREE.Vector3();
  private readonly inertiaV = new THREE.Vector3();
  private readonly inertiaOut = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private lead = 0;
  private roll = 0;
  private readonly occ = new Occluder();
  private readonly desired = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly origin = new THREE.Vector3();

  /** Instantly place the camera behind the car for its current speed. */
  snap(f: CarFrame): void {
    const c = CONFIG.camera;
    this.heading = f.yaw;
    this.headingS.v = 0;
    this.zoom = this.zoomTarget;
    this.dist = this.targetDist(f);
    this.height = this.targetHeight(f);
    this.fov = this.targetFov(f);
    this.ahead = lerp(c.lookAhead, c.lookAheadMax, f.speedN);
    this.pivot.copy(f.pivot);
    this.pivotVy.v = 0;
    this.inertiaX.set(0, 0, 0);
    this.inertiaV.set(0, 0, 0);
    this.prevVel.copy(f.vel);
    this.lead = 0;
    this.roll = 0;
    this.occ.reset();
  }

  /** Point the chase heading so the camera sits where `camPos` is (seamless hand-off from cinematic/orbit). */
  faceFrom(camPos: THREE.Vector3, f: CarFrame): void {
    const dx = f.pivot.x - camPos.x;
    const dz = f.pivot.z - camPos.z;
    if (dx * dx + dz * dz > 0.01) this.heading = Math.atan2(dx, dz);
    this.headingS.v = 0;
  }

  zoomBy(deltaY: number): void {
    const c = CONFIG.camera;
    this.zoomTarget = clamp(this.zoomTarget * Math.exp(deltaY * c.zoomStep * 0.01), c.zoomMin, c.zoomMax);
  }

  private sizeK(f: CarFrame): number {
    return clamp(f.length / 4.3, 0.85, 1.45) * CONFIG.camera.sizeScale;
  }

  private targetDist(f: CarFrame): number {
    const c = CONFIG.camera;
    let d = lerp(c.distance, c.distanceMax, f.speedN) * this.sizeK(f);
    if (f.exploded) d *= c.wreckDistance;
    else if (f.airborne && f.airTime > 0.25) d *= 1 + c.airPullback * smooth01((f.airTime - 0.25) / 0.8);
    return d * this.zoom;
  }

  private targetHeight(f: CarFrame): number {
    const c = CONFIG.camera;
    let h = lerp(c.height, c.heightMax, f.speedN) * clamp(f.height / 1.35, 0.85, 1.5);
    if (f.exploded) h *= c.wreckHeight;
    return h * lerp(1, this.zoom, 0.7);
  }

  private targetFov(f: CarFrame): number {
    const c = CONFIG.camera;
    return lerp(c.fov, c.fovMax, Math.pow(f.speedN, 1.35)) + f.boost * c.boostFov;
  }

  private targetHeading(f: CarFrame): { yaw: number; smooth: number } {
    const c = CONFIG.camera;
    if (f.airborne || f.tumbling) {
      // Flying / tumbling: follow the flight path, never the spinning body.
      if (f.hSpeed > 4 && !f.reversing) return { yaw: f.velYaw, smooth: c.headingSmoothAir };
      if (f.yawValid && !f.tumbling) return { yaw: f.yaw, smooth: c.headingSmoothAir };
      return { yaw: this.heading, smooth: c.headingSmoothAir };
    }
    const smooth = lerp(c.headingSmoothSlow, c.headingSmooth, smooth01(f.hSpeed / 20));
    if (f.reversing || !f.yawValid) return { yaw: f.yaw, smooth };
    const moving = smooth01((f.hSpeed - 1.5) / 6);
    const as = Math.abs(f.slip);
    let follow = lerp(c.velFollow, c.driftFollow, smooth01((as - 0.12) / 0.55));
    // Spinning out (sliding sideways/backwards): keep tracking the direction of travel.
    follow = lerp(follow, 1, smooth01((as - 1.4) / 0.6));
    return { yaw: f.yaw + f.slip * follow * moving, smooth };
  }

  /** lookBack: 0..1 eased look-back amount (the camera arcs around to face backwards). */
  update(ctx: GameContext, f: CarFrame, dt: number, lookBack: number): void {
    const c = CONFIG.camera;

    // ── heading ──
    if (f.exploded) {
      // Burning wreck: slow, steady orbit; the wreck's own spin is ignored.
      this.headingS.v += (c.wreckOrbit - this.headingS.v) * expK(1.2, dt);
      this.heading += this.headingS.v * dt;
    } else {
      const t = this.targetHeading(f);
      this.heading = smoothDampAngle(this.heading, t.yaw, this.headingS, t.smooth, dt);
      // Never trail more than ~100° behind the nose while driving normally (e.g. after a spin).
      if (!f.airborne && !f.tumbling && f.hSpeed > 3) {
        const err = wrapAngle(t.yaw - this.heading);
        const lim = 1.75;
        if (Math.abs(err) > lim) this.heading = t.yaw - Math.sign(err) * lim;
      }
    }
    if (Math.abs(this.heading) > 64) this.heading = wrapAngle(this.heading);

    // ── distance / height / fov ──
    this.zoom += (this.zoomTarget - this.zoom) * expK(8, dt);
    this.dist += (this.targetDist(f) - this.dist) * expK(c.distSmooth, dt);
    this.height += (this.targetHeight(f) - this.height) * expK(c.distSmooth, dt);
    this.fov += (this.targetFov(f) - this.fov) * expK(c.fovSmooth, dt);
    this.ahead += (lerp(c.lookAhead, c.lookAheadMax, f.speedN) - this.ahead) * expK(3, dt);

    // ── follow point ──
    this.pivot.x = f.pivot.x;
    this.pivot.z = f.pivot.z;
    this.pivot.y = smoothDamp(this.pivot.y, f.pivot.y, this.pivotVy, f.airborne ? c.pivotSmoothAir : c.pivotSmooth, dt);
    this.pivot.y = clamp(this.pivot.y, f.pivot.y - 1.2, f.pivot.y + 1.2);

    // ── inertia (velocity-change driven, critically damped) ──
    const dvx = f.vel.x - this.prevVel.x;
    const dvy = f.vel.y - this.prevVel.y;
    const dvz = f.vel.z - this.prevVel.z;
    this.prevVel.copy(f.vel);
    if (dvx * dvx + dvy * dvy + dvz * dvz < 45 * 45 && !f.fresh) {
      this.inertiaV.x -= dvx;
      this.inertiaV.y -= dvy * c.inertiaVertical;
      this.inertiaV.z -= dvz;
    }
    critStep(this.inertiaX, this.inertiaV, Math.max(0.5, c.inertia), dt);
    const il = this.inertiaX.length();
    const imax = Math.max(0.01, c.inertiaMax);
    if (il > 1e-5) this.inertiaOut.copy(this.inertiaX).multiplyScalar((imax * Math.tanh(il / imax)) / il);
    else this.inertiaOut.set(0, 0, 0);

    // ── look into turns, a hint of bank ──
    const grounded = f.airborne || f.exploded ? 0 : 1;
    const leadT = clamp(f.yawRate * c.turnLead, -c.turnLeadMax, c.turnLeadMax) * smooth01((f.hSpeed - 2) / 10) * (1 - lookBack) * grounded;
    this.lead += (leadT - this.lead) * expK(4, dt);
    const rollT = clamp((f.yawRate * f.hSpeed) / 25, -1, 1) * c.turnRoll * (1 - lookBack) * grounded;
    this.roll += (rollT - this.roll) * expK(3.5, dt);

    // ── compose ──
    const yawCam = this.heading + Math.PI * lookBack;
    const dx = Math.sin(yawCam);
    const dz = Math.cos(yawCam);
    this.desired.set(this.pivot.x - dx * this.dist, this.pivot.y + this.height, this.pivot.z - dz * this.dist).add(this.inertiaOut);
    this.look.set(this.pivot.x + dx * this.ahead, this.pivot.y + c.lookHeight, this.pivot.z + dz * this.ahead);

    // Occlusion from roof height, then lift a little when pulled in so we look over the car.
    this.origin.set(this.pivot.x, this.pivot.y + f.height * 0.4, this.pivot.z);
    const p = this.pose.pos;
    this.occ.apply(ctx, this.origin, this.desired, dt, p);
    p.y += this.occ.pull * c.occlusionLift;
    clampAboveGround(ctx, p, f.pivot.y, c.groundClearance);

    this.pose.lookAt(this.look, this.roll);
    this.pose.yawBy(this.lead);
    this.pose.fov = this.fov;
  }
}
