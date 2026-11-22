import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, wrapAngle } from '../core/math';
import type { GameContext } from '../game/contracts';
import { expK } from './camMath';

/**
 * Everything the cameras need to know about the player car this frame, derived ONLY from the vehicle contract
 * (`ctx.vehicle.state` + `ctx.vehicle.object`): pivot, heading, velocity heading, slip, yaw rate, flags, plus
 * the car's local bounds and auto-detected hood / rear camera mounts (measured once per car object).
 */
export class CarFrame {
  active = false;
  /** True on the first frame after the car object changed (spawn) — springs should snap. */
  fresh = true;

  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  /** Geometric center of the car body (world). */
  readonly pivot = new THREE.Vector3();
  readonly fwd = new THREE.Vector3(0, 0, 1);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly vel = new THREE.Vector3();

  /** Heading of the car's nose (rad, yaw 0 = +Z). Held when the car points straight up/down. */
  yaw = 0;
  yawValid = true;
  /** Heading of the horizontal velocity. */
  velYaw = 0;
  /** wrap(velYaw - yaw): 0 gripping, ±large drifting, ±π moving backwards. */
  slip = 0;
  hSpeed = 0;
  /** Signed speed along the nose. */
  speed = 0;
  /** |speed| / CONFIG.camera.speedRef, 0..1 */
  speedN = 0;
  /** Smoothed yaw rate (rad/s, + = turning left). */
  yawRate = 0;
  airborne = false;
  airTime = 0;
  tumbling = false;
  exploded = false;
  reversing = false;
  offroad = false;
  boost = 0;
  /** Vertical impact speed (m/s) on the frame the car lands after real airtime, else 0. */
  landing = 0;

  // Local-space measurements (car faces +Z).
  readonly bmin = new THREE.Vector3(-0.9, 0, -2.15);
  readonly bmax = new THREE.Vector3(0.9, 1.35, 2.15);
  readonly center = new THREE.Vector3(0, 0.67, 0);
  length = 4.3;
  height = 1.35;
  /** Local hood camera eye + a local point it looks at. */
  readonly hoodEye = new THREE.Vector3(0, 1.05, 1.0);
  /** Local rear (look-back) camera eye. */
  readonly rearEye = new THREE.Vector3(0, 1.0, -2.2);

  private obj: THREE.Object3D | null = null;
  private prevYaw = 0;
  private prevAir = false;
  private minVyAir = 0;

  update(ctx: GameContext, dt: number): boolean {
    const v = ctx.vehicle;
    const obj = v?.object ?? null;
    if (!v || !v.active || !obj) {
      this.active = false;
      return false;
    }
    if (obj !== this.obj) {
      this.obj = obj;
      this.measure(obj);
      this.fresh = true;
    }
    this.active = true;
    const s = v.state;
    this.pos.copy(s.position);
    this.quat.copy(s.quaternion);
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.pivot.copy(this.center).applyQuaternion(this.quat).add(this.pos);
    this.vel.copy(s.velocity);

    const fh = Math.hypot(this.fwd.x, this.fwd.z);
    this.yawValid = fh > 0.3;
    const prevYaw = this.yaw;
    if (this.yawValid) this.yaw = Math.atan2(this.fwd.x, this.fwd.z);

    this.hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (this.hSpeed > 0.3) this.velYaw = Math.atan2(this.vel.x, this.vel.z);
    else this.velYaw = this.yaw;
    this.slip = wrapAngle(this.velYaw - this.yaw);
    this.speed = Number.isFinite(s.speed) ? s.speed : this.hSpeed;
    this.speedN = clamp(Math.abs(this.speed) / Math.max(1, CONFIG.camera.speedRef), 0, 1);

    // Yaw rate (smoothed). Ignore the first frame and invalid headings.
    if (!this.fresh && dt > 0 && this.yawValid) {
      const raw = clamp(wrapAngle(this.yaw - prevYaw) / dt, -6, 6);
      this.yawRate += (raw - this.yawRate) * expK(9, dt);
    } else if (this.fresh) {
      this.yawRate = 0;
    }
    this.prevYaw = this.yaw;

    // Flags. Fall back to wheel contacts when the vehicle does not report airborne.
    const wheels = s.wheels ?? [];
    let contacts = 0;
    let off = false;
    for (const w of wheels) {
      if (w.contact) {
        contacts++;
        if (w.surface === 'grass' || w.surface === 'sand') off = true;
      }
    }
    const air = !!s.airborne || (wheels.length >= 4 && contacts === 0);
    this.landing = 0;
    if (air) {
      this.airTime += dt;
      this.minVyAir = Math.min(this.minVyAir, this.vel.y);
    } else {
      if (this.prevAir && this.airTime > 0.3) this.landing = Math.max(0, -this.minVyAir);
      this.airTime = 0;
      this.minVyAir = 0;
    }
    this.prevAir = air;
    this.airborne = air;
    this.offroad = off && this.hSpeed > 4;
    this.exploded = !!s.exploded;
    this.tumbling = !!s.upsideDown || this.up.y < 0.35 || Math.abs(this.fwd.y) > 0.8;
    this.reversing = (s.gear === -1 && this.speed < -0.3) || (this.speed < -1.2 && Math.abs(this.slip) > 2.4 && s.throttle < 0.1);
    this.boost = s.boost ?? 0;
    return true;
  }

  /** Call after consuming `fresh`. */
  settle(): void {
    this.fresh = false;
  }

  /** Forget motion history (after a teleport/reset): no fake landings or yaw-rate spikes. */
  resetHistory(): void {
    this.airTime = 0;
    this.minVyAir = 0;
    this.prevAir = false;
    this.landing = 0;
    this.yawRate = 0;
    this.prevYaw = this.yaw;
  }

  /** Re-measure on next update (e.g. the car got a new body via applyBuild). */
  invalidate(): void {
    this.obj = null;
  }

  // ───────────────────────── measurement ─────────────────────────
  private measure(obj: THREE.Object3D): void {
    try {
      this.measureBounds(obj);
      this.findMounts(obj);
    } catch {
      /* keep defaults — never let a weird model break the camera */
    }
  }

  private meshes: THREE.Mesh[] = [];

  private measureBounds(obj: THREE.Object3D): void {
    obj.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const rel = new THREE.Matrix4();
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    this.meshes = [];
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry || !m.visible) return;
      if ((m as unknown as THREE.Points).isPoints || (m as unknown as THREE.Sprite).isSprite) return;
      const g = m.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox || g.boundingBox.isEmpty()) return;
      rel.multiplyMatrices(inv, m.matrixWorld);
      tmp.copy(g.boundingBox).applyMatrix4(rel);
      // Ignore far-flung helpers (underglow planes, light cones...) that would wreck the bounds.
      if (tmp.max.y - tmp.min.y > 6 || tmp.max.z - tmp.min.z > 12) return;
      box.union(tmp);
      this.meshes.push(m);
    });
    if (box.isEmpty()) return;
    const len = box.max.z - box.min.z;
    const h = box.max.y - box.min.y;
    if (!(len > 1.5 && len < 12 && h > 0.5 && h < 6)) return;
    this.bmin.copy(box.min);
    this.bmax.copy(box.max);
    this.length = len;
    this.height = h;
    this.center.set(0, (box.min.y + box.max.y) * 0.5, (box.min.z + box.max.z) * 0.5);
  }

  /**
   * Scan the car's top surface along its centerline (downward rays against its own meshes) to find where the
   * windshield ends and the hood begins; the hood camera sits just above that point. Same idea for the trunk.
   */
  private findMounts(obj: THREE.Object3D): void {
    const c = CONFIG.camera;
    const halfLen = this.length * 0.5;
    const top = this.bmax.y;
    const bottom = this.bmin.y;
    const h = this.height;
    // Fallbacks (fractions of the bounds).
    this.hoodEye.set(0, bottom + h * 0.74, this.center.z + halfLen * 0.45);
    this.rearEye.set(0, bottom + h * 0.62, this.bmin.z - 0.05);
    if (!this.meshes.length) return;

    const ray = new THREE.Raycaster();
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
    const surfaceAt = (z: number): number | null => {
      o.set(0, top + 1, z).applyMatrix4(obj.matrixWorld);
      d.set(0, -1, 0).transformDirection(obj.matrixWorld);
      ray.set(o, d);
      ray.far = h + 2;
      const hits = ray.intersectObjects(this.meshes, false);
      if (!hits.length) return null;
      return hits[0].point.clone().applyMatrix4(inv).y;
    };

    const cabinLine = bottom + h * 0.8;
    let hoodZ: number | null = null;
    let hoodY = 0;
    for (let f = 0.05; f <= 0.9; f += 0.05) {
      const z = this.center.z + halfLen * f;
      const y = surfaceAt(z);
      if (y === null) continue;
      if (y < cabinLine) {
        hoodZ = z;
        hoodY = y;
        break;
      }
    }
    if (hoodZ !== null) {
      // Sit a touch forward of the windshield base, above the highest hood point under the eye.
      const z = Math.min(this.bmax.z - 0.3, hoodZ + c.hoodForward);
      const y2 = surfaceAt(z);
      const surf = Math.max(hoodY, y2 ?? hoodY);
      this.hoodEye.set(0, surf + c.hoodHeight, z);
    }

    let rearZ: number | null = null;
    let rearY = 0;
    for (let f = 0.3; f <= 0.95; f += 0.05) {
      const z = this.center.z - halfLen * f;
      const y = surfaceAt(z);
      if (y === null) continue;
      if (y < cabinLine) {
        rearZ = z;
        rearY = y;
        break;
      }
    }
    if (rearZ !== null) {
      // Just behind the tail (behind any spoiler), at trunk-lid height, looking back.
      this.rearEye.set(0, rearY + c.hoodHeight + 0.05, this.bmin.z - 0.05);
    }
  }
}
