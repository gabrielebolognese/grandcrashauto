import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderTag } from '../../core/Physics';
import type { WreckPiece } from '../types';
import { newMassProps, type MassProps } from './structure';

/**
 * Render interpolation with copyable samples (a split seeds every new piece with the parent's previous/current pose,
 * so nothing visually jumps on the break frame). Shifted by Breakup on 'originShift'.
 */
export class PoseInterp {
  readonly prevP = new THREE.Vector3();
  readonly currP = new THREE.Vector3();
  readonly prevQ = new THREE.Quaternion();
  readonly currQ = new THREE.Quaternion();
  primed = false;

  capture(t: { x: number; y: number; z: number }, r: { x: number; y: number; z: number; w: number }): void {
    if (!this.primed) {
      this.currP.set(t.x, t.y, t.z);
      this.currQ.set(r.x, r.y, r.z, r.w);
      this.primed = true;
    }
    this.prevP.copy(this.currP);
    this.prevQ.copy(this.currQ);
    this.currP.set(t.x, t.y, t.z);
    this.currQ.set(r.x, r.y, r.z, r.w);
  }

  copy(o: PoseInterp): void {
    this.prevP.copy(o.prevP);
    this.currP.copy(o.currP);
    this.prevQ.copy(o.prevQ);
    this.currQ.copy(o.currQ);
    this.primed = o.primed;
  }

  shift(dx: number, dz: number): void {
    this.prevP.x -= dx;
    this.prevP.z -= dz;
    this.currP.x -= dx;
    this.currP.z -= dz;
  }

  apply(obj: THREE.Object3D, alpha: number): void {
    obj.position.lerpVectors(this.prevP, this.currP, alpha);
    obj.quaternion.slerpQuaternions(this.prevQ, this.currQ, alpha);
  }
}

export class PieceImpl implements WreckPiece {
  burning = 0;
  constructor(
    readonly id: number,
    public body: RAPIER.RigidBody,
    readonly object: THREE.Group,
    public parts: string[],
    public mass: number,
    public hasCockpit: boolean,
  ) {}
}

/** One rigid body made of parts: the tracked intact plane body (owned by the flight module) or a wreck piece (ours). */
export class Assembly {
  /** Membership flag per part index. */
  readonly has: Uint8Array;
  readonly mp: MassProps = newMassProps();
  readonly interp = new PoseInterp();
  piece: PieceImpl | null = null;
  /** Collider per part index (null if the part is not on this body). */
  readonly colliders: (RAPIER.Collider | null)[];

  // physics state (refreshed every fixed step)
  readonly pos = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly vel = new THREE.Vector3();
  readonly angvel = new THREE.Vector3();
  readonly comW = new THREE.Vector3();
  readonly vPre = new THREE.Vector3();
  readonly wPre = new THREE.Vector3();
  readonly posPre = new THREE.Vector3();
  speed = 0;

  // contact bookkeeping (filled by the 'contact' handler during the physics step)
  cPart = -1;
  cOtherHandle = -1;
  cMyHandle = -1;
  cTag: ColliderTag | null = null;
  cForce = 0;
  cThisStep = false;
  cFrames = 0;
  /** Steps since the last contact. */
  cGap = 999;
  lastImpactT = -99;
  lastImpactVn = 0;
  lastEventT = -99;
  readonly cNormal = new THREE.Vector3(0, 1, 0);
  readonly cPoint = new THREE.Vector3();
  cSurface: 'runway' | 'ground' | 'building' | 'other' | 'self' = 'ground';
  cMaterial = 'asphalt';

  // water
  waterY: number | null = null;
  waterQx = 1e9;
  waterQz = 1e9;
  waterQt = 0;
  wet = 0; // submerged fraction 0..1 (by volume)
  wetT = 0; // seconds in water
  entered = false;
  sinkT = 0;
  bubbleT = 0;
  readonly waterF = new THREE.Vector3();

  // slide fx
  readonly lastGouge = new THREE.Vector3();
  gougeValid = false;
  fxT = 0;
  readonly lastPatch = new THREE.Vector3();
  patchValid = false;
  sliding = false;
  slidePart = -1;
  slideT = 0;
  restT = 0;
  /** Seconds slow (< 2 m/s) — camera focus treats the piece as settled after a moment. */
  slowT = 0;

  // fire & engines
  burning = 0;
  /** Bounding radius around the centre of mass (m). */
  radius = 1;
  thrust: { part: number; force: number; t: number; dur: number }[] = [];
  /** Inherited trim load (N·m, nose-up about body −X) of a piece that kept wings + tail but lost its nose ballast. */
  trimTorque = 0;
  trimQ0 = 1;
  trimT = 0;
  /** Collision grace (s): colliders ignore other plane bodies (spawned out of a surviving body's full-size boxes). */
  ghostT = 0;
  age = 0;
  removed = false;
  /** CCD currently enabled on the body. */
  ccd = true;
  /** Rapier gravity scale of the body (plane bodies fly with real g in the arcade -14 world). */
  gScale = 1;
  /** Decaying max of recent speeds (energy guard). */
  recentSpeed = 0;
  readonly recentVel = new THREE.Vector3();
  /** Spin sign for the severed-wing autorotation helper. */
  spinSign = 1;

  constructor(
    readonly id: number,
    public body: RAPIER.RigidBody,
    readonly tracked: boolean,
    readonly nParts: number,
    public parts: number[],
    /** Scene group holding the part objects (the plane visual root for the tracked body). */
    public group: THREE.Object3D,
  ) {
    this.has = new Uint8Array(nParts);
    for (const p of parts) this.has[p] = 1;
    this.colliders = new Array(nParts).fill(null);
  }

  setParts(parts: number[]): void {
    this.parts = parts;
    this.has.fill(0);
    for (const p of parts) this.has[p] = 1;
  }

  /** Read the body state (translation, rotation, velocities, world com). */
  read(): void {
    const b = this.body;
    // targets are filled in place (no allocation)
    b.translation(this.pos);
    b.rotation(this.quat);
    b.linvel(this.vel);
    b.angvel(this.angvel);
    this.comW.copy(this.mp.com).applyQuaternion(this.quat).add(this.pos);
    this.speed = this.vel.length();
  }
}
