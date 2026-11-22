import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp } from '../core/math';
import type { GameContext } from '../game/contracts';
import { CamPose, expK } from './camMath';
import type { CarFrame } from './CarFrame';
import { clampAboveGround, Occluder } from './Occluder';

/**
 * Free orbit around the car (world-anchored angles, follows the car's position). Drag to orbit with eased,
 * slightly inertial motion. When entered explicitly (C) with the car parked it slowly turns like a showroom
 * turntable. Reports `wantsReturn` once idle long enough so the rig can glide back to the chase camera.
 */
export class OrbitCam {
  readonly pose = new CamPose();
  explicit = false;
  private yaw = 0;
  private pitch = 0.3;
  private yawT = 0;
  private pitchT = 0.3;
  private dist = 7;
  private idle = 0;
  private spin = 0;
  private readonly occ = new Occluder();
  private readonly desired = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  /** Start orbiting from the current camera position (no visible jump). */
  enter(fromPos: THREE.Vector3, pivot: THREE.Vector3, explicit: boolean): void {
    const c = CONFIG.camera;
    const dx = fromPos.x - pivot.x;
    const dy = fromPos.y - pivot.y;
    const dz = fromPos.z - pivot.z;
    const d = Math.max(2, Math.hypot(dx, dy, dz));
    this.yaw = this.yawT = Math.atan2(dx, dz);
    this.pitch = this.pitchT = clamp(Math.asin(clamp(dy / d, -1, 1)), c.orbitPitchMin, c.orbitPitchMax);
    this.dist = d;
    this.idle = 0;
    this.spin = 0;
    this.explicit = explicit;
    this.occ.reset();
  }

  drag(dx: number, dy: number): void {
    const c = CONFIG.camera;
    this.yawT -= dx * c.orbitSensitivity;
    this.pitchT = clamp(this.pitchT + dy * c.orbitSensitivity, c.orbitPitchMin, c.orbitPitchMax);
    this.idle = 0;
    this.spin = 0;
  }

  /** True once the user stopped dragging long enough (and, for an explicit orbit, the car is moving). */
  get wantsReturn(): boolean {
    return this.idle > CONFIG.camera.orbitReturnDelay && (!this.explicit || this.moving);
  }
  private moving = false;

  update(ctx: GameContext, f: CarFrame, pivot: THREE.Vector3, chaseDist: number, dt: number): void {
    this.updateAround(ctx, pivot, chaseDist * 1.05, f.hSpeed > 3, f.height * 0.15, f.pivot.y, CONFIG.camera.fov, dt);
  }

  /** Generic orbit around `pivot` (planes, wrecks). `moving` disables the turntable; refY = subject height. */
  updateAround(ctx: GameContext, pivot: THREE.Vector3, wantDist: number, moving: boolean, lookUp: number, refY: number, fov: number, dt: number): void {
    const c = CONFIG.camera;
    this.idle += dt;
    this.moving = moving;
    // Showroom turntable when parked and left alone.
    const turntable = this.explicit && !this.moving && this.idle > 1.2;
    this.spin += ((turntable ? c.orbitAutoRotate : 0) - this.spin) * expK(1.5, dt);
    this.yawT += this.spin * dt;

    this.yaw += (this.yawT - this.yaw) * expK(10, dt);
    this.pitch += (this.pitchT - this.pitch) * expK(10, dt);
    this.dist += (Math.max(3, wantDist) - this.dist) * expK(3, dt);

    const cp = Math.cos(this.pitch);
    this.desired.set(
      pivot.x + Math.sin(this.yaw) * cp * this.dist,
      pivot.y + Math.sin(this.pitch) * this.dist,
      pivot.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.look.set(pivot.x, pivot.y + lookUp, pivot.z);
    const p = this.pose.pos;
    this.occ.apply(ctx, this.look, this.desired, dt, p);
    clampAboveGround(ctx, p, refY, c.groundClearance);
    this.pose.lookAt(this.look);
    this.pose.fov = fov;
  }

  shift(dx: number, dz: number): void {
    this.pose.pos.x -= dx;
    this.pose.pos.z -= dz;
  }
}
