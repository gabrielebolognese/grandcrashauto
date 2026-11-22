import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, lerp, wrapAngle } from '../core/math';
import { CamPose, expK } from './camMath';
import type { CarFrame } from './CarFrame';

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _left = new THREE.Vector3();

/**
 * Hood camera: mounted just above the hood (auto-detected from the car's geometry). Yaw is rigid (the hood never
 * swims in view), pitch is lightly smoothed (head-like), roll is partially horizon-stabilized. Look-back cuts to a
 * tail-mounted camera. Drag = free look that eases back to forward.
 */
export class HoodCam {
  readonly pose = new CamPose();
  private pitch = 0;
  private roll = 0;
  private init = false;
  private wasRear = false;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookYawT = 0;
  private lookPitchT = 0;
  private idle = 99;
  private readonly eye = new THREE.Vector3();

  snap(): void {
    this.init = false;
    this.lookYaw = this.lookPitch = this.lookYawT = this.lookPitchT = 0;
    this.idle = 99;
  }

  drag(dx: number, dy: number): void {
    const s = CONFIG.camera.orbitSensitivity;
    // "Grab the world" semantics, like the orbit camera (and Street View).
    this.lookYawT = clamp(this.lookYawT + dx * s, -2.6, 2.6);
    this.lookPitchT = clamp(this.lookPitchT + dy * s, -0.5, 0.6);
    this.idle = 0;
  }

  update(f: CarFrame, dt: number, lookBack: boolean): void {
    const c = CONFIG.camera;
    const rear = lookBack;
    this.eye.copy(rear ? f.rearEye : f.hoodEye).applyQuaternion(f.quat).add(f.pos);
    this.pose.pos.copy(this.eye);

    const pitchRaw = Math.asin(clamp(f.fwd.y, -1, 1));
    _left.set(1, 0, 0).applyQuaternion(f.quat);
    const rollRaw = -Math.asin(clamp(_left.y, -1, 1)) * (1 - c.hoodStabilize);
    if (!this.init || rear !== this.wasRear) {
      this.pitch = pitchRaw;
      this.roll = rollRaw;
      this.init = true;
    } else {
      this.pitch += (pitchRaw - this.pitch) * expK(c.hoodSmooth, dt);
      this.roll += wrapAngle(rollRaw - this.roll) * expK(c.hoodSmooth * 0.7, dt);
    }
    this.wasRear = rear;

    // Free look eases back after a pause.
    this.idle += dt;
    if (this.idle > c.freeLookReturn) {
      this.lookYawT += (0 - this.lookYawT) * expK(3, dt);
      this.lookPitchT += (0 - this.lookPitchT) * expK(3, dt);
    }
    this.lookYaw += (this.lookYawT - this.lookYaw) * expK(12, dt);
    this.lookPitch += (this.lookPitchT - this.lookPitch) * expK(12, dt);

    const yaw = f.yaw + (rear ? 0 : Math.PI) + this.lookYaw;
    const pitch = (rear ? -this.pitch : this.pitch) - c.hoodPitch + this.lookPitch;
    _euler.set(pitch, yaw, rear ? -this.roll : this.roll, 'YXZ');
    this.pose.quat.setFromEuler(_euler);
    this.pose.fov = lerp(c.hoodFov, c.hoodFovMax, Math.pow(f.speedN, 1.3)) + f.boost * c.boostFov;
  }
}
