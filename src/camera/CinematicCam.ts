import * as THREE from 'three';
import { CONFIG } from '../config';
import { lerp } from '../core/math';
import type { GameContext } from '../game/contracts';
import { CamPose, easeInOutSine, smooth01, smoothDampVec3 } from './camMath';
import type { CarFrame } from './CarFrame';
import { castSolid, clampAboveGround, Occluder } from './Occluder';

const _dir = new THREE.Vector3();
const _o = new THREE.Vector3();

/**
 * Explosion cinematic (SPEC §10/§11): a low-angle orbit around the blast in real time while the world plays in
 * slow motion. It starts from the side the player was already looking from (no line crossing), picks the swing
 * direction with the most open space, frames both the fireball and the tumbling wreck (smoothed so the wreck's
 * spin never jerks the camera), widens the orbit if the wreck flies far, with a gentle dutch tilt and slow zoom.
 */
export class CinematicCam {
  readonly pose = new CamPose();
  t = 0;
  duration = 3;
  private readonly blast = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private readonly focusVel = new THREE.Vector3();
  private readonly center = new THREE.Vector3();
  private readonly centerVel = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private readonly focusT = new THREE.Vector3();
  private a0 = 0;
  private dir = 1;
  private readonly occ = new Occluder();
  /** Extra blend-in time when the start angle had to move away from the current view. */
  extraBlend = 0;

  get done(): boolean {
    return this.t >= this.duration;
  }

  shift(dx: number, dz: number): void {
    for (const v of [this.blast, this.focus, this.center, this.pose.pos]) {
      v.x -= dx;
      v.z -= dz;
    }
  }

  start(ctx: GameContext, target: THREE.Vector3, duration: number, fromCam: THREE.Vector3): void {
    const c = CONFIG.camera;
    this.blast.copy(target);
    this.duration = Math.max(0.5, duration);
    this.t = 0;
    this.focus.copy(target).y += 1.2;
    this.focusVel.set(0, 0, 0);
    this.center.copy(target);
    this.centerVel.set(0, 0, 0);
    this.occ.reset();

    // Start where the player was looking from; if that side is walled in, find the nearest open bearing.
    const want = Math.atan2(fromCam.x - target.x, fromCam.z - target.z);
    const need = c.cineRadius * 0.9;
    let best = want;
    let found = false;
    for (let k = 0; k < 12 && !found; k++) {
      const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * (Math.PI / 6);
      const a = want + step;
      if (this.clearance(ctx, a) >= need) {
        best = a;
        found = true;
      }
    }
    this.a0 = best;
    this.extraBlend = Math.min(0.5, Math.abs(best - want) * 0.25);
    // Swing toward the more open side.
    const l = this.clearance(ctx, best + 0.9);
    const r = this.clearance(ctx, best - 0.9);
    this.dir = Math.abs(l - r) < 1 ? (Math.random() < 0.5 ? 1 : -1) : l > r ? 1 : -1;
  }

  private clearance(ctx: GameContext, a: number): number {
    const c = CONFIG.camera;
    const maxD = c.cineRadiusEnd + 1;
    _o.copy(this.blast).y += 1.3;
    _dir.set(Math.sin(a), 0, Math.cos(a));
    const hit = castSolid(ctx, _o, _dir, maxD);
    return hit === null ? maxD : hit;
  }

  update(ctx: GameContext, f: CarFrame, dt: number): void {
    const c = CONFIG.camera;
    this.t += dt;
    const u = Math.min(1, this.t / this.duration);
    const e = easeInOutSine(u);

    // Framing: from the fireball toward the wreck as it flies and tumbles.
    const wreck = f.active ? f.pivot : this.blast;
    const w = smooth01(this.t / 0.9) * 0.7;
    this.focusT.copy(this.blast).y += 1.8;
    this.focusT.lerp(wreck, w);
    smoothDampVec3(this.focus, this.focusT, this.focusVel, 0.22, dt);

    // Orbit center drifts to the middle of blast and wreck; radius grows to keep both in frame.
    this.focusT.copy(this.blast).lerp(wreck, 0.5);
    this.focusT.y = this.blast.y;
    smoothDampVec3(this.center, this.focusT, this.centerVel, 0.5, dt);
    const sep = Math.hypot(wreck.x - this.blast.x, wreck.z - this.blast.z);
    const r = Math.max(lerp(c.cineRadius, c.cineRadiusEnd, e), sep * 1.1 + 6);
    const h = lerp(c.cineHeight, c.cineHeightEnd, e) + Math.max(0, wreck.y - this.blast.y) * 0.25;
    const a = this.a0 + this.dir * c.cineSpin * this.t;

    this.desired.set(this.center.x + Math.sin(a) * r, this.blast.y + h, this.center.z + Math.cos(a) * r);
    const p = this.pose.pos;
    this.occ.apply(ctx, this.focus, this.desired, dt, p);
    clampAboveGround(ctx, p, this.blast.y + 2, Math.min(c.groundClearance, 0.4));

    const roll = c.cineRoll * this.dir * Math.sin(Math.PI * Math.min(1, this.t / (this.duration + 1)));
    this.pose.lookAt(this.focus, roll);
    this.pose.fov = lerp(c.cineFov, c.cineFovEnd, e);
  }
}
