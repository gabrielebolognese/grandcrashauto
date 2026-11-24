import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, lerp } from '../core/math';
import type { CameraMode, GameContext, PlaneCameraTarget } from '../game/contracts';
import type { CrashOutcome, WreckPiece } from '../plane/types';
import {
  blendPoses, CamPose, critStep, easeInOutSine, expK, smooth01, smoother01, smoothDamp, smoothDampAngle, smoothDampVec3,
  type SpringState,
} from './camMath';
import { castSolid, clampAboveGround, Occluder } from './Occluder';
import { OrbitCam } from './OrbitCam';
import type { ScreenFlash } from './ScreenFlash';
import type { Shake } from './Shake';

/**
 * Plane cameras (SPEC-PART2 "Cameras", §8a–8c, §11). Follows `ctx.planes.cameraTarget` (or the biggest burning
 * wreck piece after a total explosion) in four views — chase (distance grows with the plane's size), cockpit,
 * wing, free orbit — plus three scripted phases:
 *   cine  : quick orbit around the fireball, which streaks along the flight path (momentum, drag), then follow
 *           `ctx.breakup.focusPiece` down;
 *   crash : the best crash shot for the impact type (water level / low ground angle / wide chase), shake by distance;
 *   wreck : settle on the burning wreck with a slow orbit.
 * Dragging pans in every view and recentres after ~2 s idle — except in the middle-split cockpit sequence, where
 * free 360° look stays on (with violent shake and a white-out + cut outside at impact).
 */

export type PlaneView = 'chase' | 'cockpit' | 'wing' | 'orbit';
type Phase = 'normal' | 'cine' | 'crash' | 'wreck';
type CrashShot = 'wide' | 'low' | 'water';

const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qf = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _up = new THREE.Vector3();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);

export class PlaneRig {
  readonly pose = new CamPose();
  view: PlaneView = 'chase';
  phase: Phase = 'normal';
  /** A subject to follow exists this frame. */
  active = false;
  /** Smoothed subject position (blend pivot for the rig). */
  readonly pivot = new THREE.Vector3();
  /** Near plane the current view wants. */
  near = 0.4;
  zoom = 1;

  // ── subject ──
  private obj: THREE.Object3D | null = null;
  private kind: PlaneCameraTarget['kind'] = 'plane';
  private size = 20;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly left = new THREE.Vector3(1, 0, 0);
  private readonly vel = new THREE.Vector3();
  private eye: THREE.Vector3 | null = null;
  private wing: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private fresh = true;
  private switchT = 99;
  private readonly pivotVel = new THREE.Vector3();
  private followPiece = false;
  private readonly pieceSize = new Map<number, number>();

  // ── chase ──
  private yaw = 0;
  private readonly yawS: SpringState = { v: 0 };
  private pitch = 0;
  private readonly pitchS: SpringState = { v: 0 };
  private roll = 0;
  private readonly rollS: SpringState = { v: 0 };
  private dist = 30;
  private height = 8;
  private fov = 60;
  private tail = 0;
  private readonly inertiaX = new THREE.Vector3();
  private readonly inertiaV = new THREE.Vector3();
  private readonly inertiaOut = new THREE.Vector3();
  private readonly prevVel = new THREE.Vector3();
  private readonly occ = new Occluder();
  private readonly occShot = new Occluder();

  // ── free look (every view) ──
  private lookYaw = 0;
  private lookPitch = 0;
  private lookYawT = 0;
  private lookPitchT = 0;
  private idle = 99;

  // ── orbit ──
  private readonly orbit = new OrbitCam();

  // ── internal phase blend (relative to the pivot so it travels with a fast plane) ──
  private readonly from = new CamPose();
  private readonly fromRel = new THREE.Vector3();
  private blendT = 1;
  private blendDur = 0;
  private readonly raw = new CamPose();

  // ── cinematic ──
  private cineT = 0;
  private cineDur = 2.6;
  private readonly blast0 = new THREE.Vector3();
  private readonly cineVel = new THREE.Vector3();
  private readonly cineCenter = new THREE.Vector3();
  private readonly cineFocus = new THREE.Vector3();
  private readonly cineFocusVel = new THREE.Vector3();
  private cineA0 = 0;
  private cineDir = 1;
  private cineR = 40;

  // ── crash / wreck ──
  private crashT = 0;
  private crashShot: CrashShot = 'wide';
  private readonly crashPos = new THREE.Vector3();
  private readonly crashFocus = new THREE.Vector3();
  private readonly crashFocusVel = new THREE.Vector3();
  private crashR = 40;
  private pendingCrash: { pos: THREE.Vector3; vel: THREE.Vector3; outcome: CrashOutcome } | null = null;
  private wreckA = 0;

  private readonly desired = new THREE.Vector3();
  private readonly look = new THREE.Vector3();

  constructor(
    private readonly ctx: GameContext,
    private readonly shakeFx: Shake,
    private readonly flash: ScreenFlash,
  ) {}

  init(): void {
    const ev = this.ctx.events;
    const plane = () => this.ctx.game?.mode === 'plane';
    ev.on('planeSpawned', () => this.reset());
    ev.on('planeExplosion', (e) => !e.replay && plane() && this.onExplosion(e.position, e.velocity, e.radius, e.kind));
    ev.on('engineExplode', (e) => !e.replay && plane() && this.shakeAt(e.position, CONFIG.camera.planeEngineShake, 350, 3));
    ev.on('planeBreak', (e) => plane() && this.shakeAt(e.position, 0.25 + 0.6 * clamp(e.intensity, 0, 1), 400, 0));
    ev.on('planeImpact', (e) => !e.replay && plane() && this.onImpact(e.position, e.velocity, e.outcome, e.energy));
    ev.on('touchdown', (e) => {
      if (!plane()) return;
      if (e.hard) this.shakeAt(e.position, 0.45, 300, 0);
      else this.shakeAt(e.position, clamp(Math.abs(e.verticalSpeed) * 0.04, 0.03, 0.15), 300, 0);
    });
  }

  /** Mode label for ICameraRig.mode. */
  get modeLabel(): CameraMode {
    if (this.phase !== 'normal') return 'cinematic';
    const v = this.effectiveView();
    return v === 'chase' ? 'chase' : v === 'orbit' ? 'orbit' : 'hood';
  }

  /** Concrete view name for ICameraRig.view. */
  get viewLabel(): string {
    return this.phase !== 'normal' ? 'cinematic' : this.effectiveView();
  }

  get isMounted(): boolean {
    return this.phase === 'normal' && (this.effectiveView() === 'cockpit' || this.effectiveView() === 'wing');
  }

  /** Full reset (spawn / respawn / retry). */
  reset(): void {
    this.phase = 'normal';
    this.followPiece = false;
    this.fresh = true;
    this.obj = null;
    this.pendingCrash = null;
    this.tail = 0;
    this.blendT = 1;
    this.blendDur = 0;
    this.pieceSize.clear();
    this.flash.clear();
    this.lookYaw = this.lookPitch = this.lookYawT = this.lookPitchT = 0;
  }

  snap(): void {
    this.fresh = true;
    this.blendT = 1;
    this.blendDur = 0;
  }

  shift(dx: number, dz: number): void {
    for (const v of [this.pivot, this.pose.pos, this.raw.pos, this.from.pos, this.blast0, this.cineCenter, this.cineFocus, this.crashPos, this.crashFocus, this.pos]) {
      v.x -= dx;
      v.z -= dz;
    }
    if (this.pendingCrash) {
      this.pendingCrash.pos.x -= dx;
      this.pendingCrash.pos.z -= dz;
    }
    this.orbit.shift(dx, dz);
  }

  cycle(): string {
    if (this.phase === 'cine' || this.phase === 'crash') {
      this.endPhase();
      return '';
    }
    if (this.phase === 'wreck') this.setPhase('normal', 0.6);
    const order: PlaneView[] = ['chase', 'cockpit', 'wing', 'orbit'];
    let i = order.indexOf(this.view);
    for (let k = 0; k < 4; k++) {
      i = (i + 1) % 4;
      const v = order[i];
      if (v === 'cockpit' && !this.eye && !this.ctx.planes?.visual?.partByName.cockpit) continue;
      if (v === 'wing' && !this.wing) continue;
      this.setView(v);
      break;
    }
    return this.view === 'chase' ? 'Chase camera' : this.view === 'cockpit' ? 'Cockpit camera' : this.view === 'wing' ? 'Wing camera' : 'Orbit camera — drag to look around';
  }

  private setView(v: PlaneView): void {
    if (v === this.view) return;
    if (v === 'orbit') {
      this.orbit.enter(this.pose.pos, this.pivot, true);
    }
    this.view = v;
    this.lookYaw = this.lookPitch = this.lookYawT = this.lookPitchT = 0;
  }

  /** Skip the current scripted phase (C / Skip / reset). */
  endPhase(): void {
    if (this.phase === 'cine') {
      this.followPiece = true;
      this.setPhase('normal', 0.8);
    } else if (this.phase === 'crash') {
      this.enterWreck();
    }
  }

  drag(dx: number, dy: number): void {
    const c = CONFIG.camera;
    if (this.phase !== 'normal') return;
    if (this.effectiveView() === 'orbit') {
      this.orbit.drag(dx, dy);
      return;
    }
    const s = c.orbitSensitivity;
    const seq = !!this.ctx.planes?.inCockpitSequence;
    // Grab-the-world semantics (same as the car cameras). Free 360° look (user request): yaw is unlimited (wrapped,
    // continuous), the mounted cockpit / wing views can look almost straight up and down.
    void seq;
    this.lookYawT += dx * s;
    if (this.lookYawT > Math.PI) {
      this.lookYawT -= Math.PI * 2;
      this.lookYaw -= Math.PI * 2;
    } else if (this.lookYawT < -Math.PI) {
      this.lookYawT += Math.PI * 2;
      this.lookYaw += Math.PI * 2;
    }
    const pMax = this.isMounted ? 1.5 : 1.2;
    this.lookPitchT = clamp(this.lookPitchT + dy * s, -pMax, pMax);
    this.idle = 0;
  }

  zoomBy(deltaY: number): void {
    const c = CONFIG.camera;
    this.zoom = clamp(this.zoom * Math.exp(deltaY * c.zoomStep * 0.01), c.zoomMin, c.zoomMax);
  }

  // ───────────────────────────── per frame ─────────────────────────────
  update(dt: number): void {
    this.active = this.acquire(dt);
    this.flash.update(dt);
    if (!this.active) return;
    const c = CONFIG.camera;

    // Cockpit-sequence impact: hold the cockpit view until the screen is white, then cut outside.
    if (this.pendingCrash && (this.flash.covered || !this.eye)) {
      const p = this.pendingCrash;
      this.pendingCrash = null;
      this.startCrash(p.pos, p.vel, p.outcome, true);
    }
    if (this.ctx.planes?.inCockpitSequence && this.phase === 'normal' && !this.pendingCrash) {
      // Violent, continuous cockpit shake while the front section falls.
      if (this.shakeFx.trauma < c.cockpitSeqShake) this.shakeFx.trauma = c.cockpitSeqShake;
    }

    // Free look recentres after a pause in the chase view (cockpit / wing views stay where you looked).
    this.idle += dt;
    const seq = !!this.ctx.planes?.inCockpitSequence;
    if (this.idle > c.planeLookReturn && !seq && !this.isMounted) {
      this.lookYawT += (0 - this.lookYawT) * expK(2.5, dt);
      this.lookPitchT += (0 - this.lookPitchT) * expK(2.5, dt);
    }
    this.lookYaw += (this.lookYawT - this.lookYaw) * expK(10, dt);
    this.lookPitch += (this.lookPitchT - this.lookPitch) * expK(10, dt);

    // The chase always runs (home for every phase blend).
    this.updateChase(dt);
    let out: CamPose = this.chasePose;
    const lock = this.cockpitLock();
    if (lock) {
      // User request: the cockpit view never disappears — split, explosion, structural failure, impact: you stay in
      // the cockpit (riding whatever piece it's on). No scripted cine / crash / wreck shots while locked.
      if (this.phase !== 'normal') this.phase = 'normal';
      this.pendingCrash = null;
      lock.obj.matrixWorld.decompose(_v2, _qf, _s);
      this.raw.pos.copy(lock.eye).applyMatrix4(lock.obj.matrixWorld);
      this.raw.quat.copy(_qf).multiply(_q.setFromAxisAngle(AXIS_Y, Math.PI));
      this.raw.quat.multiply(_q.setFromAxisAngle(AXIS_Y, this.lookYaw)).multiply(_q.setFromAxisAngle(AXIS_X, this.lookPitch));
      this.raw.fov = c.planeCockpitFov;
      this.near = 0.08;
      if (this.blendT < this.blendDur) this.blendT = this.blendDur;
      this.pose.copy(this.raw);
      return;
    }
    switch (this.phase) {
      case 'cine':
        this.updateCine(dt);
        out = this.raw;
        break;
      case 'crash':
        this.updateCrash(dt);
        out = this.raw;
        break;
      case 'wreck':
        this.updateWreck(dt);
        out = this.raw;
        break;
      default: {
        const v = this.effectiveView();
        if (v === 'cockpit') this.updateCockpit();
        else if (v === 'wing') this.updateWing();
        else if (v === 'orbit') this.orbit.updateAround(this.ctx, this.pivot, this.dist * 1.1, false, this.size * 0.08, this.pivot.y, c.planeFov, dt);
        out = v === 'orbit' ? this.orbit.pose : v === 'chase' ? this.chasePose : this.raw;
      }
    }
    this.near = this.phase === 'normal' && (this.effectiveView() === 'cockpit' || this.effectiveView() === 'wing') ? 0.08 : 0.4;

    // Internal phase blend.
    if (this.blendT < this.blendDur) {
      this.blendT += dt;
      this.from.pos.addVectors(this.pivot, this.fromRel);
      blendPoses(this.from, out, smoother01(this.blendT / this.blendDur), this.pivot, this.pose);
    } else {
      this.pose.copy(out);
    }
  }

  private lockEye = new THREE.Vector3();
  /** The cockpit view the player chose, pinned to the cockpit PART (wherever it ends up), or null. */
  private cockpitLock(): { obj: THREE.Object3D; eye: THREE.Vector3 } | null {
    if (this.view !== 'cockpit') return null;
    const vis = this.ctx.planes?.visual;
    const part = vis?.partByName.cockpit ?? vis?.partByName.nose;
    if (!vis || !part || !this.ctx.planes?.active) return null;
    let p: THREE.Object3D | null = part.object;
    while (p && p !== this.ctx.engine.scene) p = p.parent;
    if (!p) return null;
    part.object.updateWorldMatrix(true, false);
    this.lockEye.copy(vis.cockpitEye).sub(part.com); // root space → part-local
    return { obj: part.object, eye: this.lockEye };
  }

  private effectiveView(): PlaneView {
    if (this.ctx.planes?.inCockpitSequence && this.eye) return 'cockpit';
    if (this.view === 'cockpit' && !this.eye) return 'chase';
    if (this.view === 'wing' && !this.wing) return 'chase';
    return this.view;
  }

  private setPhase(p: Phase, blend: number): void {
    this.from.copy(this.pose);
    this.fromRel.subVectors(this.pose.pos, this.pivot);
    this.blendT = 0;
    this.blendDur = blend;
    this.phase = p;
  }

  // ───────────────────────────── subject ─────────────────────────────
  private acquire(dt: number): boolean {
    const planes = this.ctx.planes;
    const tgt = planes?.cameraTarget ?? null;
    let obj: THREE.Object3D | null = tgt?.object ?? null;
    let kind: PlaneCameraTarget['kind'] = tgt?.kind ?? 'plane';
    let size = tgt?.size ?? 20;
    let piece: WreckPiece | null = null;
    const fp = this.ctx.breakup?.focusPiece ?? null;
    if (fp && (this.followPiece || !obj || (this.phase !== 'normal' && kind !== 'plane'))) {
      piece = fp;
      obj = fp.object;
      kind = 'wreck';
      size = this.measurePiece(fp);
    }
    // Never freeze (user request): if the target vanishes for a moment, keep following the last subject while it is
    // still in the scene (falling wreckage, burning piece) instead of dropping to the 'hold' pose.
    if (!obj && this.obj && this.obj.parent && this.ctx.game.mode === 'plane') {
      obj = this.obj;
      kind = 'wreck';
      size = this.size;
    }
    if (!obj) return false;
    if (obj !== this.obj) {
      if (!this.obj) this.fresh = true;
      this.obj = obj;
      this.switchT = 0;
    }
    this.switchT += dt;
    this.kind = kind;
    this.size = clamp(Number.isFinite(size) ? size : 20, 3, 120);
    const own = tgt && tgt.object === obj;
    this.eye = own ? tgt.cockpitEye ?? null : null;
    this.wing = own ? tgt.wingCam ?? null : null;
    obj.updateWorldMatrix(true, false);
    obj.matrixWorld.decompose(this.pos, this.quat, _s);
    if (own && tgt.velocity) this.vel.copy(tgt.velocity);
    else if (piece) {
      try {
        const lv = piece.body.linvel();
        this.vel.set(lv.x, lv.y, lv.z);
      } catch {
        /* body gone */
      }
    }
    this.fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.left.set(1, 0, 0).applyQuaternion(this.quat);

    // Pivot: exact while following one object; glides over when the followed object changes (split, wreck).
    if (this.fresh) {
      this.pivot.copy(this.pos);
      this.pivotVel.set(0, 0, 0);
    } else if (this.switchT < 1.2) {
      smoothDampVec3(this.pivot, this.pos, this.pivotVel, 0.3, dt);
    } else {
      this.pivot.copy(this.pos);
    }
    return true;
  }

  private measurePiece(p: WreckPiece): number {
    let s = this.pieceSize.get(p.id);
    if (s === undefined) {
      try {
        const b = new THREE.Box3().setFromObject(p.object);
        const v = b.getSize(new THREE.Vector3());
        s = clamp(Math.max(v.x, v.y, v.z), 3, 120);
      } catch {
        s = 12;
      }
      this.pieceSize.set(p.id, s);
    }
    return s;
  }

  // ───────────────────────────── chase ─────────────────────────────
  private readonly chasePose = new CamPose();

  private updateChase(dt: number): void {
    const c = CONFIG.camera;
    const st = this.ctx.planes?.state;
    const tumbling = this.kind !== 'plane';
    const v = this.vel;
    const hs = Math.hypot(v.x, v.z);
    const sp = v.length();
    const speedN = clamp(sp / Math.max(1, c.planeSpeedRef), 0, 1);
    const tailLost = !!st?.damage?.tailLost && !tumbling;
    this.tail += ((tailLost ? 1 : 0) - this.tail) * expK(1.2, dt);

    let yawT: number;
    let pitchT: number;
    let rollT: number;
    const fh = Math.hypot(this.fwd.x, this.fwd.z);
    if (!tumbling) {
      yawT = fh > 0.2 ? Math.atan2(this.fwd.x, this.fwd.z) : hs > 3 ? Math.atan2(v.x, v.z) : this.yaw;
      // A tail-less plane yaws and flat-spins: track the flight path instead of the nose.
      if (this.tail > 0.3 && hs > 10) yawT = Math.atan2(v.x, v.z);
      pitchT = Math.asin(clamp(this.fwd.y, -1, 1)) * c.planePitchFollow;
      rollT = Math.asin(clamp(this.left.y, -1, 1)) * c.planeRollFollow * (1 - this.tail);
    } else {
      yawT = hs > 4 ? Math.atan2(v.x, v.z) : this.yaw;
      pitchT = sp > 4 ? clamp(Math.asin(clamp(v.y / sp, -1, 1)), -1.0, 0.7) * 0.55 : this.pitch;
      rollT = 0;
    }
    if (st?.onGround && !tumbling) pitchT *= 0.3;

    let distT = (c.planeDistBase + this.size * c.planeDistK) * (1 + 0.15 * speedN) * (1 + c.planeTailWiden * this.tail);
    let heightT = (2 + this.size * c.planeHeightK) * (1 + 0.6 * this.tail);
    if (this.kind === 'wreck') {
      distT = Math.max(distT * 1.25, 28);
      heightT *= 1.4;
    } else if (this.kind === 'cockpitPiece') {
      distT = Math.max(distT, 22);
    }
    distT *= this.zoom;
    const fovT = c.planeFov + c.planeFovSpeed * Math.pow(speedN, 1.2) + 6 * this.tail;

    if (this.fresh) {
      this.yaw = yawT;
      this.pitch = pitchT;
      this.roll = rollT;
      this.yawS.v = this.pitchS.v = this.rollS.v = 0;
      this.dist = distT;
      this.height = heightT;
      this.fov = fovT;
      this.inertiaX.set(0, 0, 0);
      this.inertiaV.set(0, 0, 0);
      this.prevVel.copy(v);
      this.occ.reset();
      this.fresh = false;
    } else {
      this.yaw = smoothDampAngle(this.yaw, yawT, this.yawS, tumbling ? 0.7 : c.planeYawSmooth, dt);
      this.pitch = smoothDamp(this.pitch, pitchT, this.pitchS, tumbling ? 0.6 : c.planePitchSmooth, dt);
      this.roll = smoothDamp(this.roll, rollT, this.rollS, c.planeRollSmooth, dt);
      this.dist += (distT - this.dist) * expK(1.6, dt);
      this.height += (heightT - this.height) * expK(1.6, dt);
      this.fov += (fovT - this.fov) * expK(2, dt);
      const dvx = v.x - this.prevVel.x;
      const dvy = v.y - this.prevVel.y;
      const dvz = v.z - this.prevVel.z;
      this.prevVel.copy(v);
      if (dvx * dvx + dvy * dvy + dvz * dvz < 80 * 80 && this.switchT > 0.2) {
        this.inertiaV.x -= dvx;
        this.inertiaV.y -= dvy * 0.6;
        this.inertiaV.z -= dvz;
      }
    }
    if (Math.abs(this.yaw) > 64) this.yaw = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
    critStep(this.inertiaX, this.inertiaV, 3.5, dt);
    const il = this.inertiaX.length();
    const imax = c.planeInertiaMax;
    if (il > 1e-5) this.inertiaOut.copy(this.inertiaX).multiplyScalar((imax * Math.tanh(il / imax)) / il);
    else this.inertiaOut.set(0, 0, 0);

    // Camera frame: yaw/pitch/partial roll of the plane, plus free-look orbit and the tail-loss side angle.
    const camYaw = this.yaw + this.lookYaw + 0.5 * this.tail;
    const camPitch = clamp(this.pitch - this.lookPitch * 0.8, -1.3, 1.3);
    _e.set(-camPitch, camYaw, this.roll, 'YXZ');
    _qf.setFromEuler(_e);
    this.desired.set(0, this.height, -this.dist).applyQuaternion(_qf).add(this.pivot).add(this.inertiaOut);
    this.look.set(0, this.height * 0.22, this.size * 0.35 - this.size * 0.7 * this.tail).applyQuaternion(_qf).add(this.pivot);
    _up.set(0, 1, 0).applyQuaternion(_qf);

    const p = this.chasePose.pos;
    this.occ.apply(this.ctx, this.pivot, this.desired, dt, p);
    clampAboveGround(this.ctx, p, this.pivot.y, 0.8);
    this.chasePose.lookAt(this.look, 0, _up);
    this.chasePose.fov = this.fov;
  }

  // ───────────────────────────── mounted views ─────────────────────────────
  private updateCockpit(): void {
    const c = CONFIG.camera;
    const obj = this.obj!;
    this.raw.pos.copy(this.eye!).applyMatrix4(obj.matrixWorld);
    // Camera looks down -Z; the plane's nose is +Z.
    this.raw.quat.copy(this.quat).multiply(_q.setFromAxisAngle(AXIS_Y, Math.PI));
    this.raw.quat.multiply(_q.setFromAxisAngle(AXIS_Y, this.lookYaw)).multiply(_q.setFromAxisAngle(AXIS_X, this.lookPitch));
    this.raw.fov = c.planeCockpitFov;
  }

  private updateWing(): void {
    const c = CONFIG.camera;
    const obj = this.obj!;
    const w = this.wing!;
    this.raw.pos.copy(w.position).applyMatrix4(obj.matrixWorld);
    _v.copy(w.target).applyMatrix4(obj.matrixWorld);
    this.raw.lookAt(_v, 0, this.up);
    this.raw.quat.multiply(_q.setFromAxisAngle(AXIS_Y, this.lookYaw)).multiply(_q.setFromAxisAngle(AXIS_X, this.lookPitch));
    this.raw.fov = c.planeWingFov;
  }

  // ───────────────────────────── events ─────────────────────────────
  private camPos(): THREE.Vector3 {
    return this.ctx.engine.camera.position;
  }

  private shakeAt(pos: THREE.Vector3, amount: number, range: number, kick: number): void {
    const d = this.camPos().distanceTo(pos);
    const k = clamp(1 - d / Math.max(1, range), 0, 1);
    if (k <= 0) return;
    const m = this.isMounted ? CONFIG.camera.planeCockpitShake : 1;
    this.shakeFx.add(amount * k * m, 1.2);
    if (kick > 0) this.shakeFx.kick(kick * k);
  }

  private onExplosion(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, kind: 'total' | 'middle' | 'tail' | 'secondary'): void {
    const c = CONFIG.camera;
    const range = Math.max(250, radius * 12);
    if (kind === 'total') {
      this.shakeAt(pos, 1, range, c.fovKick);
      if (!this.ctx.planes?.inCockpitSequence) this.startCine(pos, vel, radius);
    } else if (kind === 'middle') {
      this.shakeAt(pos, 1, range, c.fovKick * 0.6);
    } else if (kind === 'tail') {
      this.shakeAt(pos, 0.7, range, 4);
    } else {
      this.shakeAt(pos, 0.5, range, 2);
    }
  }

  private startCine(pos: THREE.Vector3, vel: THREE.Vector3, radius: number): void {
    if (this.cockpitLock()) return; // staying in the cockpit
    const c = CONFIG.camera;
    this.cineT = 0;
    this.cineDur = c.planeCineDuration;
    this.blast0.copy(pos);
    this.cineVel.copy(vel);
    this.cineCenter.copy(pos);
    this.cineFocus.copy(pos);
    this.cineFocusVel.set(0, 0, 0);
    this.cineR = clamp(Math.max((radius || 20) * 1.8, this.size * 1.3, 30), 30, 180);
    const cp = this.camPos();
    this.cineA0 = Math.atan2(cp.x - pos.x, cp.z - pos.z);
    this.cineDir = Math.random() < 0.5 ? 1 : -1;
    this.setPhase('cine', 0.35);
  }

  private updateCine(dt: number): void {
    const c = CONFIG.camera;
    this.cineT += dt;
    const u = Math.min(1, this.cineT / this.cineDur);
    const e = easeInOutSine(u);
    // The fireball inherits the plane's momentum and slows by drag: a streaking comet, not a static bloom.
    const tau = c.planeCineDrag;
    const k = tau * (1 - Math.exp(-this.cineT / tau));
    this.cineCenter.copy(this.blast0).addScaledVector(this.cineVel, k);
    _v.copy(this.cineCenter);
    const fp = this.ctx.breakup?.focusPiece;
    if (fp) _v.lerp(this.pos, smooth01((this.cineT - 0.5) / 1.2) * 0.6);
    smoothDampVec3(this.cineFocus, _v, this.cineFocusVel, 0.22, dt);
    const a = this.cineA0 + this.cineDir * c.cineSpin * 0.8 * this.cineT;
    const r = this.cineR * lerp(0.85, 1.15, e);
    const p = this.raw.pos;
    p.set(this.cineCenter.x + Math.sin(a) * r, this.cineCenter.y + r * 0.16 + 2, this.cineCenter.z + Math.cos(a) * r);
    clampAboveGround(this.ctx, p, Infinity, 1.0);
    this.raw.lookAt(this.cineFocus, c.cineRoll * this.cineDir * Math.sin(Math.PI * u) * 0.7);
    this.raw.fov = lerp(62, 52, e);
    if (this.cineT >= this.cineDur) {
      this.followPiece = true;
      this.setPhase('normal', 1.0);
    }
  }

  private onImpact(pos: THREE.Vector3, vel: THREE.Vector3, outcome: CrashOutcome, energy: number): void {
    const e = clamp(Math.log10(Math.max(1, energy)) / 8, 0.2, 1);
    if (outcome === 'landing') return;
    if (outcome === 'hardLanding') {
      this.shakeAt(pos, 0.45, 300, 0);
      return;
    }
    this.shakeAt(pos, 0.5 + 0.5 * e, 500, 4 * e);
    if (this.phase === 'crash' || this.phase === 'wreck' || this.pendingCrash) return;
    // Only the impact of what we follow triggers the crash shot (not every flying panel).
    const near = pos.distanceTo(this.pos) < this.size * 2 + 40;
    if (!near && this.ctx.planes?.crashed !== true) return;
    if (this.ctx.planes?.inCockpitSequence && this.eye) {
      // Middle split: impact seen from inside, white-out, then cut to the wreckage outside.
      this.flash.flash(0.05, 0.45, 1.1);
      this.shakeFx.add(1, 1.5);
      this.pendingCrash = { pos: pos.clone(), vel: vel.clone(), outcome };
      return;
    }
    this.startCrash(pos, vel, outcome, false);
  }

  private startCrash(pos: THREE.Vector3, vel: THREE.Vector3, outcome: CrashOutcome, cut: boolean): void {
    if (this.cockpitLock()) return; // staying in the cockpit
    const c = CONFIG.camera;
    const hs = Math.hypot(vel.x, vel.z);
    const water = outcome === 'waterCrash' || outcome === 'ditching';
    this.crashShot = water ? 'water' : outcome === 'groundCrash' && hs > 35 ? 'low' : 'wide';
    const R = clamp(this.size * 1.6, 25, 90);
    this.crashR = R;
    // Horizontal travel direction (fallback: the nose).
    _v.set(vel.x, 0, vel.z);
    if (_v.lengthSq() < 1) _v.set(this.fwd.x, 0, this.fwd.z);
    if (_v.lengthSq() < 1e-4) _v.set(0, 0, 1);
    _v.normalize();
    _v2.set(_v.z, 0, -_v.x); // side
    // Pick the side with more open space.
    const sideClear = (s: number) => {
      _s.copy(pos).y += 3;
      const d = castSolid(this.ctx, _s, _up.copy(_v2).multiplyScalar(s), R * 1.2);
      return d === null ? R * 1.2 : d;
    };
    const side = sideClear(1) >= sideClear(-1) ? 1 : -1;
    const p = this.crashPos;
    if (this.crashShot === 'water') {
      // Just above the waves, ahead and to the side: spray and the sliding hull come at the lens.
      p.copy(pos).addScaledVector(_v, R * 0.9).addScaledVector(_v2, side * R * 0.7);
      p.y = CONFIG.world.waterLevel + c.crashWaterHeight;
    } else if (this.crashShot === 'low') {
      p.copy(pos).addScaledVector(_v, R * 1.2).addScaledVector(_v2, side * R * 0.5);
      let g = pos.y;
      try {
        g = this.ctx.world.groundHeightAt(p.x, p.z);
      } catch {
        /* keep */
      }
      p.y = (Number.isFinite(g) ? g : pos.y) + 1.4;
    } else {
      p.copy(pos).addScaledVector(_v, -R * 1.1).addScaledVector(_v2, side * R * 0.8);
      p.y = pos.y + R * 0.55;
    }
    clampAboveGround(this.ctx, p, Infinity, water ? 0.5 : 1.0);
    this.crashFocus.copy(pos);
    this.crashFocusVel.set(0, 0, 0);
    this.crashT = 0;
    this.occShot.reset();
    // A hard cut is the TV-crash-cam convention (and after a white-out the cut is hidden anyway).
    void cut;
    this.setPhase('crash', 0);
  }

  private updateCrash(dt: number): void {
    const c = CONFIG.camera;
    this.crashT += dt;
    smoothDampVec3(this.crashFocus, this.pos, this.crashFocusVel, 0.18, dt);
    // Fixed "TV" crash camera, drifting up a touch; occlusion from the wreck keeps it in sight.
    this.desired.copy(this.crashPos);
    this.desired.y += Math.min(3, this.crashT * 0.4);
    const p = this.raw.pos;
    this.occShot.apply(this.ctx, this.crashFocus, this.desired, dt, p);
    clampAboveGround(this.ctx, p, Infinity, this.crashShot === 'water' ? 0.45 : 0.8);
    this.raw.lookAt(this.crashFocus);
    const u = Math.min(1, this.crashT / c.crashShotTime);
    const f0 = this.crashShot === 'wide' ? 56 : this.crashShot === 'low' ? 46 : 50;
    this.raw.fov = lerp(f0, f0 - 6, easeInOutSine(u));
    if (this.crashT >= c.crashShotTime) this.enterWreck();
  }

  private enterWreck(): void {
    const cp = this.raw.pos;
    this.wreckA = Math.atan2(cp.x - this.crashFocus.x, cp.z - this.crashFocus.z);
    this.setPhase('wreck', 1.5);
  }

  private updateWreck(dt: number): void {
    const c = CONFIG.camera;
    smoothDampVec3(this.crashFocus, this.pos, this.crashFocusVel, 0.4, dt);
    this.wreckA += c.wreckOrbit * 1.2 * dt;
    const R = this.crashR * 0.9;
    this.desired.set(this.crashFocus.x + Math.sin(this.wreckA) * R, this.crashFocus.y + R * 0.32, this.crashFocus.z + Math.cos(this.wreckA) * R);
    const p = this.raw.pos;
    this.occShot.apply(this.ctx, this.crashFocus, this.desired, dt, p);
    clampAboveGround(this.ctx, p, Infinity, 0.8);
    this.raw.lookAt(this.crashFocus);
    this.raw.fov = 55;
  }
}
