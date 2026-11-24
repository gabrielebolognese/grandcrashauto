import * as THREE from 'three';
import { CONFIG } from '../config';
import { approach, clamp, dampAngle, smoothstep } from '../core/math';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { ControlState } from '../core/Input';
import type { AvatarHandle, GameContext, IWalker } from '../game/contracts';
import type { PlaneCabin, PlaneTypeId, PlaneVisual, TrackedPlane } from '../plane/types';
import { FpHand } from './FpHand';

type Mode = 'off' | 'cabin' | 'fall' | 'ground';
const G = 9.81;
const R = 0.22; // body radius
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _s = new THREE.Vector3();

/**
 * THE PLAYER ON FOOT (user request): get up from the pilot seat and walk the cabin of a flying airliner / jumbo / jet
 * (autopilot holds the plane), look out of the windows, sit down, then blow it up from inside. Invincible.
 *
 *  - cabin: the character lives in ROOT space of the plane at rest (cabin floor, seats, aisles from PlaneVisual.cabin)
 *    and is carried by the part object of the fuselage section it stands in, so after a split it rides that piece.
 *    It feels the piece's apparent gravity (gravity − the piece's acceleration): banking, diving, tumbling pieces
 *    throw you around; after a split you "fall faster than the plane" (only part of the piece's acceleration is
 *    felt) and the open end sucks you out — unless you grab a seat (hold E / GRAB).
 *  - fall: thrown out → free fall (skydive steering), invincible landing (fall flat, lie, get up).
 *  - ground: walk / run / jump on the ground or wade in water; fly again from here or go back to the car.
 *  First / third person in every mode (C / VIEW). The walker drives the camera itself (after the camera rig).
 */
export class Walker implements IWalker {
  readonly name = 'walker';
  mode: Mode = 'off';
  firstPerson = true;
  /** Public for the crash replay (records / poses the character). */
  avatar: AvatarHandle | null = null;
  private yaw = Math.PI; // cabin: relative to the plane (0 = toward the nose); world modes: absolute
  private pitch = 0;
  // cabin
  private visual: PlaneVisual | null = null;
  private cabin: PlaneCabin | null = null;
  private tracked: TrackedPlane | null = null;
  private type: PlaneTypeId | null = null;
  private p = new THREE.Vector3(); // root space
  private v = new THREE.Vector3(); // root space, relative to the cabin
  private sec = 0;
  private seat = -1;
  private windowSeat = false;
  private grabHeld = false;
  private jumpHeld = false;
  private floating = false;
  private stumbling = false;
  private bodyYaw = Math.PI;
  private chain = { front: 0, back: 0, zMax: 0, zMin: 0, openFront: false, openRear: false };
  private M0 = new THREE.Matrix4();
  private M1 = new THREE.Matrix4();
  private M2 = new THREE.Matrix4();
  private hist = 0;
  private histKey = '';
  private dt1 = 0;
  private gApp = new THREE.Vector3(0, -G, 0); // apparent gravity, section-local
  private frameVel = new THREE.Vector3(); // world velocity of the cabin point you stand on
  private partQ = new THREE.Quaternion();
  // world modes
  private wp = new THREE.Vector3();
  private wv = new THREE.Vector3();
  private onGround = false;
  private inWater = false;
  private landStage = 0;
  private landT = 0;
  private fallTop = 0;
  // camera
  private camSaved: { fov: number; near: number } | null = null;
  private shakeT = 0;
  private shakeK = 0;
  private focusV = new THREE.Vector3();
  // first person: head bob + the hand (user request)
  private hand: FpHand | null = null;
  private bob = 0;
  private bobK = 0;
  private floatK = 0;

  constructor(private ctx: GameContext) {}

  init(): void {
    const { ctx } = this;
    try {
      this.avatar = ctx.npcs.createAvatar?.() ?? null;
      if (this.avatar) ctx.engine.scene.add(this.avatar.object);
    } catch {
      this.avatar = null;
    }
    this.hand = new FpHand();
    ctx.engine.scene.add(this.hand.root);
    ctx.events.on('planeSpawned', () => this.active && this.stop(false));
    ctx.events.on('modeChanged', ({ mode }) => mode !== 'plane' && this.active && this.stop(false));
    ctx.events.on('originShift', ({ delta }) => {
      this.wp.sub(delta);
      this.focusV.sub(delta);
      this.hist = 0;
    });
    ctx.events.on('planeExplosion', ({ position, radius, replay }) => {
      if (!this.active || replay) return;
      const d = position.distanceTo(this.ctx.engine.camera.position);
      const k = clamp(1.4 - d / (radius * 4 + 60), 0, 1.2);
      if (k > 0.05) {
        this.shakeT = Math.max(this.shakeT, 0.5 + k);
        this.shakeK = Math.max(this.shakeK, k);
        this.ctx.events.emit('vibrate', { pattern: [60, 40, 90] });
      }
    });
  }

  // ───────────────────────────── state / contract ─────────────────────────────
  get active(): boolean {
    return this.mode !== 'off';
  }
  get focus(): THREE.Vector3 | null {
    return this.active ? this.focusV : null;
  }
  get seated(): boolean {
    return this.seat >= 0;
  }
  get canTakeControls(): boolean {
    const planes = this.ctx.planes;
    return this.mode === 'cabin' && !!this.cabin && !!this.tracked?.body && !planes.crashed && this.chain.front === 0 && this.p.z > this.cabin.frontZ - 2.8;
  }
  get canStepOut(): boolean {
    if (this.mode !== 'cabin') return false;
    const st = this.ctx.planes.state;
    if (this.tracked?.body) return !!st?.onGround && (st.groundSpeedKmh ?? 99) < 6;
    const w = this.toWorld(this.p, _v3);
    return this.frameVel.length() < 2.5 && w.y - this.surfaceAt(w.x, w.z) < 9;
  }

  canStart(): boolean {
    const { ctx } = this;
    const planes = ctx.planes;
    return ctx.game.state === 'driving' && ctx.game.mode === 'plane' && planes.active && !planes.crashed && !planes.inCockpitSequence &&
      !!planes.visual?.cabin && !!planes.currentTracked?.body && !this.active;
  }

  start(): boolean {
    const { ctx } = this;
    const planes = ctx.planes;
    if (!this.canStart()) {
      if (planes.active && planes.visual && !planes.visual.cabin) ctx.events.emit('toast', { text: 'This little plane has no cabin to walk in', ms: 1800 });
      return false;
    }
    const visual = planes.visual!;
    const cab = visual.cabin!;
    this.visual = visual;
    this.cabin = cab;
    this.tracked = planes.currentTracked ?? null;
    this.type = planes.currentType ?? null;
    const aisle = cab.aisles.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a), cab.aisles[0] ?? 0);
    this.p.set(aisle, cab.floorY, cab.frontZ - 1.1);
    this.v.set(0, 0, 0);
    this.yaw = Math.PI;
    this.pitch = -0.04;
    this.bodyYaw = Math.PI;
    this.seat = -1;
    this.windowSeat = false;
    this.floating = false;
    this.hist = 0;
    this.gApp.set(0, -G, 0);
    this.sec = this.secAt(this.p.z);
    this.mode = 'cabin';
    visual.setInteriorVisible?.(true);
    planes.walking = true;
    this.avatar?.play('idle', 0);
    ctx.events.emit('toast', { text: '🚶 Walking the cabin — autopilot on', ms: 1800 });
    return true;
  }

  stop(snapCam = true): void {
    const { ctx } = this;
    if (!this.active) return;
    this.mode = 'off';
    this.setHandVisible(false);
    this.visual?.setInteriorVisible?.(false);
    ctx.planes.walking = false;
    if (this.avatar) this.avatar.visible = false;
    this.seat = -1;
    this.windowSeat = false;
    const cam = ctx.engine.camera;
    if (this.camSaved) {
      cam.fov = this.camSaved.fov;
      cam.near = this.camSaved.near;
      cam.updateProjectionMatrix();
      this.camSaved = null;
    }
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* ignore */
    }
    if (snapCam) {
      try {
        ctx.cameraRig.snap();
      } catch {
        /* camera not ready */
      }
    }
    this.visual = null;
    this.cabin = null;
    this.tracked = null;
  }

  interact(): void {
    if (this.canTakeControls) {
      this.stop();
      this.ctx.events.emit('toast', { text: '✈ You have the controls', ms: 1400 });
    } else if (this.canStepOut) this.stepOut();
  }

  toggleView(): void {
    this.firstPerson = !this.firstPerson;
  }

  /** The crash replay hides the first-person hand (the walker is not updated while it plays). */
  setHandVisible(on: boolean): void {
    if (this.hand) this.hand.root.visible = on;
  }

  lookOutWindow(): void {
    if (this.mode !== 'cabin' || !this.cabin) return;
    if (this.seat >= 0 && this.windowSeat) {
      this.standUp();
      return;
    }
    if (this.seat >= 0) this.standUp();
    this.trySit(true);
  }

  flyAgain(): void {
    const planes = this.ctx.planes;
    const t = this.type ?? 'airliner';
    if (this.mode === 'fall' || this.mode === 'ground') {
      const d = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const x = this.wp.x, z = this.wp.z;
      planes.quickFly?.(t, { x, z, dirX: d.x, dirZ: d.z });
    } else planes.quickFly?.(t);
  }

  // ───────────────────────────── helpers ─────────────────────────────
  private partOf(i: number): { obj: THREE.Object3D; rest: THREE.Vector3 } | null {
    const s = this.cabin?.sections[i];
    const info = s ? this.visual?.partByName[s.part] : null;
    return info ? { obj: info.object, rest: info.com } : null;
  }

  private inScene(o: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = o;
    while (p) {
      if (p === this.ctx.engine.scene) return true;
      p = p.parent;
    }
    return false;
  }

  /** Root-space cabin point → world (through the current section's part object). */
  private toWorld(pr: THREE.Vector3, out: THREE.Vector3, sec = this.sec): THREE.Vector3 {
    const po = this.partOf(sec);
    if (!po) return out.copy(this.focusV);
    return out.copy(pr).sub(po.rest).applyMatrix4(po.obj.matrixWorld);
  }

  private secAt(z: number): number {
    const S = this.cabin?.sections ?? [];
    for (let i = 0; i < S.length; i++) if (z >= S[i].z0 && z <= S[i].z1) return i;
    if (!S.length) return 0;
    return z > S[0].z1 ? 0 : S.length - 1;
  }

  private sample(arr: Float32Array, z: number): number {
    const c = this.cabin!;
    const f = clamp((z - c.rearZ) / c.step, 0, arr.length - 1);
    const i = Math.floor(f);
    const j = Math.min(arr.length - 1, i + 1);
    return arr[i] + (arr[j] - arr[i]) * (f - i);
  }

  private broken(a: string, b: string): boolean {
    const s = this.tracked?.brokenJoints;
    return !!s && (s.has(`${a}|${b}`) || s.has(`${b}|${a}`));
  }

  /** The run of connected sections around the current one, and whether its ends are torn open. */
  private computeChain(): void {
    const S = this.cabin!.sections;
    let f = this.sec, b = this.sec;
    while (f > 0 && !this.broken(S[f - 1].part, S[f].part)) f--;
    while (b < S.length - 1 && !this.broken(S[b].part, S[b + 1].part)) b++;
    const c = this.chain;
    c.front = f;
    c.back = b;
    c.zMax = f === 0 ? this.cabin!.frontZ : S[f].z1;
    c.zMin = b === S.length - 1 ? this.cabin!.rearZ : S[b].z0;
    c.openFront = f > 0 || this.broken('cockpit', S[0].part);
    c.openRear = b < S.length - 1 || this.broken(S[S.length - 1].part, 'tailCone');
  }

  private surfaceAt(x: number, z: number): number {
    const { ctx } = this;
    let g = 0;
    try {
      g = ctx.world.groundHeightAt(x, z);
      if (!Number.isFinite(g)) g = 0;
    } catch {
      g = 0;
    }
    let w: number | null = null;
    try {
      w = ctx.terrain?.waterAt?.(x, z) ?? null;
    } catch {
      w = null;
    }
    if (w === null) {
      try {
        if (ctx.world.isDeepWater(x, z)) w = 0;
      } catch {
        /* ignore */
      }
    }
    this.inWater = w !== null && w > g + 0.3;
    return this.inWater ? (w as number) - 1.15 : g; // wading / swimming: chest deep
  }

  // ───────────────────────────── per frame ─────────────────────────────
  update(dtIn: number): void {
    if (this.mode === 'off' || this.ctx.game.state !== 'driving') return;
    const dt = Math.min(0.05, Math.max(0, dtIn));
    const inp = this.ctx.input.state;
    const W = CONFIG.walk;
    this.yaw -= inp.lookX * W.lookSens;
    this.pitch = clamp(this.pitch - inp.lookY * W.lookSens, -1.45, 1.45);
    if (this.mode === 'cabin') this.updateCabin(dt, inp);
    if (this.mode === 'fall' || this.mode === 'ground') this.updateWorld(dt, inp);
    if ((this.mode as Mode) === 'off') return;
    this.updateAvatar(dt);
    this.updateBob(dt);
    this.updateCamera(dt);
  }

  private updateCabin(dt: number, inp: ControlState): void {
    const cab = this.cabin;
    const W = CONFIG.walk;
    if (!cab || !this.visual) {
      this.stop();
      return;
    }
    let po = this.partOf(this.sec);
    if (!po || !this.inScene(po.obj)) {
      // the piece was cleaned up / sank: out into the world
      this.ejectToWorld(this.focusV.clone(), this.frameVel.clone());
      return;
    }
    po.obj.updateWorldMatrix(true, false);
    this.computeChain();
    this.sampleFrame(po.obj, po.rest, dt);
    const g = this.gApp;
    const floorY = cab.floorY;
    const ceil = this.sample(cab.ceil, this.p.z);
    const headroom = Math.min(1.75, ceil - floorY - 0.02);

    // grab = hold a seat (sit down in the nearest one); window seats stay until you move
    const grab = inp.grab;
    if (grab && !this.grabHeld && this.seat < 0) this.trySit(false);
    if (!grab && this.grabHeld && this.seat >= 0 && !this.windowSeat) this.standUp();
    this.grabHeld = grab;
    if (this.windowSeat && this.seat >= 0 && (Math.abs(inp.moveX) > 0.5 || Math.abs(inp.moveY) > 0.5)) this.standUp();

    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let mx = -fz * inp.moveX + fx * inp.moveY;
    let mz = fx * inp.moveX + fz * inp.moveY;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    this.stumbling = false;
    if (this.seat >= 0) {
      this.sitPos(this.seat, this.p);
      this.v.set(0, 0, 0);
      this.floating = false;
    } else {
      const support = -g.y;
      const onFloor = this.p.y <= floorY + 0.03 && this.v.y <= 0.05;
      if (onFloor && support > W.minSupport) {
        this.floating = false;
        const speed = inp.run ? W.run : W.walk;
        const lat = Math.hypot(g.x, g.z);
        const slide = Math.max(0, lat - W.friction * support);
        const k = slide > 0.5 ? 0.35 : 1;
        this.v.x = approach(this.v.x, mx * speed * k, W.accel * dt);
        this.v.z = approach(this.v.z, mz * speed * k, W.accel * dt);
        if (slide > 0 && lat > 1e-3) {
          this.v.x += (g.x / lat) * slide * dt * 2;
          this.v.z += (g.z / lat) * slide * dt * 2;
        }
        this.v.y = 0;
        if (inp.jump && !this.jumpHeld) this.v.y = W.jump;
        this.stumbling = slide > 2.2;
      } else {
        this.floating = true;
        this.v.addScaledVector(g, dt);
        this.v.x += mx * 1.2 * dt;
        this.v.z += mz * 1.2 * dt;
      }
      // decompression: an open end at speed pulls you toward it
      const air = this.frameVel.length();
      if (air > 25) {
        const pull = W.suction * clamp((air - 25) / 60, 0, 1);
        const c = this.chain;
        if (c.openFront) {
          const d = c.zMax - this.p.z;
          if (d < W.suctionRange) this.v.z += pull * (1 - Math.max(0, d) / W.suctionRange) * dt;
        }
        if (c.openRear) {
          const d = this.p.z - c.zMin;
          if (d < W.suctionRange) this.v.z -= pull * (1 - Math.max(0, d) / W.suctionRange) * dt;
        }
      }
      if (this.v.length() > W.maxSpeed) this.v.setLength(W.maxSpeed);
      // anti-noclip: small sub-steps, colliding after each one (no tunnelling through seats, walls or the ends)
      const n = Math.min(12, Math.max(1, Math.ceil((this.v.length() * dt) / 0.08)));
      for (let i = 0; i < n; i++) {
        this.p.addScaledVector(this.v, dt / n);
        if (this.collide(floorY, headroom)) return;
      }
    }
    this.jumpHeld = inp.jump;
    this.sec = clamp(this.secAt(this.p.z), this.chain.front, this.chain.back);
    po = this.partOf(this.sec);
    if (po) this.toWorld(this.p, this.focusV);
  }

  /** Cabin collisions; returns true when you went out of an open end (now falling). */
  private collide(floorY: number, headroom: number): boolean {
    const p = this.p, v = this.v, c = this.chain;
    const ceil = this.sample(this.cabin!.ceil, p.z);
    const beyond = (c.openFront && p.z > c.zMax) || (c.openRear && p.z < c.zMin);
    if (!beyond) {
      if (p.y < floorY) {
        p.y = floorY;
        v.y = v.y < -4 ? -v.y * 0.2 : Math.max(0, v.y);
      }
      const top = this.floating ? 0.9 : headroom;
      if (p.y + top > ceil) {
        p.y = Math.max(floorY, ceil - top);
        if (v.y > 0) v.y *= -0.2;
      }
      // the whole body (feet, waist, head) stays inside the curved walls and under the overhead bins
      const lim = this.wallLimit(p.z, p.y, top);
      if (Math.abs(p.x) > lim) {
        p.x = Math.sign(p.x) * lim;
        v.x *= -0.25;
      }
      if (p.y < floorY + 1.1) this.pushOutOfSeats(floorY);
    }
    if (!c.openFront && p.z > c.zMax - R - 0.05) {
      p.z = c.zMax - R - 0.05;
      if (v.z > 0) v.z *= -0.2;
    }
    if (!c.openRear && p.z < c.zMin + R + 0.05) {
      p.z = c.zMin + R + 0.05;
      if (v.z < 0) v.z *= -0.2;
    }
    if ((c.openFront && p.z > c.zMax + 0.5) || (c.openRear && p.z < c.zMin - 0.5)) {
      this.fallOut();
      return true;
    }
    return false;
  }

  /** Max |x| of the body centre at (z, feet y) for a body `top` m tall: inside the hull and the bins at every height. */
  private wallLimit(z: number, y: number, top: number): number {
    const cab = this.cabin!;
    const f = cab.halfWidthAt;
    if (!f) return Math.max(0.05, this.sample(cab.halfW, z) - R);
    const w = Math.min(f(z, y + 0.1), f(z, y + top * 0.5), f(z, y + Math.max(0.2, top - 0.05)));
    return Math.max(0.05, w - R);
  }

  private pushOutOfSeats(floorY: number): void {
    const seats = this.cabin!.seats;
    const p = this.p;
    const hx = 0.23;
    // below the seat pans the whole seat blocks; up to the top of the backs only the (tilted) back rest
    const low = p.y < floorY + 0.5;
    for (const s of seats) {
      if (Math.abs(s.z - p.z) > 0.9 || Math.abs(s.x - p.x) > 0.8) continue;
      const x0 = s.x - hx, x1 = s.x + hx, z0 = low ? s.z - 0.24 : s.z - 0.33, z1 = low ? s.z + 0.3 : s.z - 0.1;
      const cx = clamp(p.x, x0, x1), cz = clamp(p.z, z0, z1);
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x += (dx / d) * (R - d);
        p.z += (dz / d) * (R - d);
      } else {
        const pen = [p.x - x0 + R, x1 - p.x + R, p.z - z0 + R, z1 - p.z + R];
        const i = pen.indexOf(Math.min(...pen));
        if (i === 0) p.x = x0 - R;
        else if (i === 1) p.x = x1 + R;
        else if (i === 2) p.z = z0 - R;
        else p.z = z1 + R;
      }
    }
  }

  /** Apparent gravity in the section frame from the part's world motion (3 frames), with the cinematic rules. */
  /** The rigid body carrying the current section: the intact plane, or the wreck piece holding that part. */
  private currentBody(): import('@dimforge/rapier3d-compat').RigidBody | null {
    const t = this.tracked;
    let body = t?.body ?? null;
    if (!body) {
      const part = this.cabin?.sections[this.sec]?.part;
      const pc = part ? this.ctx.breakup.pieces.find((q) => q.parts.includes(part)) : null;
      body = pc?.body ?? null;
    }
    try {
      if (body && !this.ctx.physics.world.bodies.contains(body.handle)) body = null;
    } catch {
      body = null;
    }
    return body;
  }

  /**
   * Per physics step: the carrying body's velocity at the character's point (lin + ω × r) → its acceleration. From the
   * rigid body itself (not the interpolated visuals), so slow / irregular frames don't fake jolts.
   */
  fixedUpdate(dt: number): void {
    if (this.mode !== 'cabin' || dt <= 0) return;
    const body = this.currentBody();
    if (!body) {
      this.hist = 0;
      return;
    }
    const lv = body.linvel(), av = body.angvel(), t = body.translation();
    const w = this.toWorld(this.p, _v3);
    const rx = w.x - t.x, ry = w.y - t.y, rz = w.z - t.z;
    const vx = lv.x + av.y * rz - av.z * ry, vy = lv.y + av.z * rx - av.x * rz, vz = lv.z + av.x * ry - av.y * rx;
    if (this.hist > 0 && this.bodyRef === body) {
      this.accRaw.set((vx - this.vPrev.x) / dt, (vy - this.vPrev.y) / dt, (vz - this.vPrev.z) / dt);
      if (this.accRaw.length() > CONFIG.walk.maxFrameAccel) this.accRaw.setLength(CONFIG.walk.maxFrameAccel);
      this.acc.lerp(this.accRaw, 1 - Math.exp(-dt / 0.05));
    } else this.acc.set(0, 0, 0);
    this.vPrev.set(vx, vy, vz);
    this.frameVel.set(vx, vy, vz);
    this.bodyRef = body;
    this.hist++;
  }
  private acc = new THREE.Vector3();
  private accRaw = new THREE.Vector3();
  private vPrev = new THREE.Vector3();
  private bodyRef: unknown = null;

  /** Apparent gravity in the section frame (gravity − the carrying body's acceleration) with the cinematic rules. */
  private sampleFrame(obj: THREE.Object3D, _rest: THREE.Vector3, dt: number): void {
    const W = CONFIG.walk;
    const intact = !!this.tracked?.body;
    const k = intact ? 1 : W.splitCoupling;
    const a = this.acc;
    const gw = _s.set(-a.x * k, -G - a.y * k, -a.z * k);
    // you fall faster than a split / diving plane: it never lets you float up (cinematic, user request)
    if (!intact || a.y < -0.7 * G) gw.y = Math.min(gw.y, -W.minFallG * G);
    obj.matrixWorld.decompose(_v2, this.partQ, _v3);
    const gl = gw.applyQuaternion(_q.copy(this.partQ).invert());
    this.gApp.lerp(gl, 1 - Math.exp(-dt / 0.06));
  }

  private sitPos(i: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.cabin!.seats[i];
    // seat pan top at floor + 0.48 (interior.ts), clips authored for a 0.46 m seat, butt 3 cm behind the centre
    return out.set(s.x, s.y + 0.02, s.z + 0.02);
  }

  private trySit(window: boolean): void {
    const cab = this.cabin!;
    const c = this.chain;
    let best = -1, bestD = Infinity;
    let side = 0;
    if (window) {
      const dx = Math.sin(this.yaw);
      side = Math.abs(dx) > 0.3 ? Math.sign(dx) : this.p.x >= 0 ? 1 : -1;
    }
    let maxX = 0;
    if (window) for (const s of cab.seats) if (Math.sign(s.x) === side) maxX = Math.max(maxX, Math.abs(s.x));
    cab.seats.forEach((s, i) => {
      if (s.z > c.zMax || s.z < c.zMin) return;
      let d: number;
      if (window) {
        if (Math.sign(s.x) !== side) return;
        d = Math.abs(s.z - this.p.z) + (maxX - Math.abs(s.x)) * 4;
      } else d = Math.hypot(s.x - this.p.x, s.z - this.p.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0 || (!window && bestD > 1.9) || (window && bestD > 6)) {
      this.ctx.events.emit('toast', { text: 'No seat within reach', ms: 1000 });
      return;
    }
    this.seat = best;
    this.windowSeat = window;
    this.sitPos(best, this.p);
    this.v.set(0, 0, 0);
    this.floating = false;
    this.avatar?.play('sit', 0.25);
    if (window) {
      this.yaw = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      this.pitch = -0.06;
      this.firstPerson = true;
    }
    this.ctx.events.emit('vibrate', { pattern: 15 });
  }

  private standUp(): void {
    const cab = this.cabin;
    if (!cab || this.seat < 0) return;
    const s = cab.seats[this.seat];
    const aisle = cab.aisles.reduce((a, b) => (Math.abs(b - s.x) < Math.abs(a - s.x) ? b : a), cab.aisles[0] ?? 0);
    this.p.set(aisle, cab.floorY, s.z + 0.03);
    this.seat = -1;
    this.windowSeat = false;
  }

  private fallOut(): void {
    const po = this.partOf(this.sec);
    if (!po) return;
    const w = this.toWorld(this.p, new THREE.Vector3());
    const vel = this.v.clone().applyQuaternion(this.partQ).add(this.frameVel);
    // the look / body directions carry over into world yaw
    const d = _v.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).applyQuaternion(this.partQ);
    this.yaw = Math.atan2(d.x, d.z);
    const b = _v2.set(Math.sin(this.bodyYaw), 0, Math.cos(this.bodyYaw)).applyQuaternion(this.partQ);
    this.bodyYaw = Math.atan2(b.x, b.z);
    this.ejectToWorld(w, vel);
    this.ctx.events.emit('vibrate', { pattern: [80, 40, 80] });
  }

  private ejectToWorld(pos: THREE.Vector3, vel: THREE.Vector3): void {
    this.wp.copy(pos);
    this.wv.copy(vel);
    this.seat = -1;
    this.windowSeat = false;
    this.mode = 'fall';
    this.fallTop = pos.y;
    this.landStage = 0;
    this.hist = 0;
    this.focusV.copy(pos);
  }

  private stepOut(): void {
    const po = this.partOf(this.sec);
    if (!po || !this.cabin) return;
    const side = this.p.x >= 0 ? 1 : -1;
    const out = _v.set(side * (this.sample(this.cabin.halfW, this.p.z) + 2.5), this.cabin.floorY, this.p.z);
    const w = this.toWorld(out, new THREE.Vector3());
    const d = _v2.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).applyQuaternion(this.partQ);
    this.yaw = Math.atan2(d.x, d.z);
    w.y = this.surfaceAt(w.x, w.z);
    this.wp.copy(w);
    this.wv.set(0, 0, 0);
    this.mode = 'ground';
    this.onGround = true;
    this.landStage = 0;
    this.focusV.copy(w);
  }

  private updateWorld(dt: number, inp: ControlState): void {
    const W = CONFIG.walk;
    const wp = this.wp, wv = this.wv;
    const gy = this.surfaceAt(wp.x, wp.z);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    let mx = -fz * inp.moveX + fx * inp.moveY;
    let mz = fx * inp.moveX + fz * inp.moveY;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) {
      mx /= ml;
      mz /= ml;
    }
    if (this.mode === 'fall') {
      wv.y -= G * dt;
      const sp = wv.length();
      wv.multiplyScalar(1 / (1 + W.airDrag * sp * dt));
      wv.x += mx * W.skydiveSteer * dt;
      wv.z += mz * W.skydiveSteer * dt;
      wp.addScaledVector(wv, dt);
      if (wp.y <= gy) this.land(gy);
    } else {
      if (this.landStage > 0) {
        this.landT += dt;
        wv.x = approach(wv.x, 0, 8 * dt);
        wv.z = approach(wv.z, 0, 8 * dt);
        mx = mz = 0;
      }
      const speed = (inp.run ? W.run : W.walk) * W.outsideMul * (this.inWater ? 0.5 : 1);
      if (this.landStage === 0) {
        wv.x = approach(wv.x, mx * speed, W.accel * dt);
        wv.z = approach(wv.z, mz * speed, W.accel * dt);
      }
      // buildings / props in the way (knee-high ray)
      const hs = Math.hypot(wv.x, wv.z);
      if (hs > 0.05) {
        const o = _v.set(wp.x, wp.y + 0.5, wp.z);
        const d = _v2.set(wv.x / hs, 0, wv.z / hs);
        const hit = this.ctx.physics.raycast(o, d, hs * dt + R + 0.05);
        if (hit) {
          wv.x = 0;
          wv.z = 0;
        }
      }
      const airborne = wp.y > gy + 0.02 || wv.y > 0;
      if (airborne) wv.y -= G * dt;
      else {
        wv.y = 0;
        if (inp.jump && !this.jumpHeld && this.landStage === 0 && !this.inWater) wv.y = W.jump;
      }
      wp.addScaledVector(wv, dt);
      if (wp.y < gy) {
        if (wv.y < -W.hardLanding) this.land(gy);
        wp.y = gy;
        if (wv.y < 0) wv.y = 0;
      }
      this.onGround = wp.y <= gy + 0.02;
      // landing sequence: fall flat → lie a moment → get up
      if (this.landStage === 1 && (this.avatar?.clipDone ?? true) && this.landT > 0.6) {
        this.landStage = 2;
        this.landT = 0;
        this.avatar?.play('lieBack', 0.15);
      } else if (this.landStage === 2 && this.landT > 0.9) {
        this.landStage = 3;
        this.landT = 0;
        this.avatar?.play('getUpBack', 0.15, 1, true);
      } else if (this.landStage === 3 && ((this.avatar?.clipDone ?? true) || this.landT > 2.6)) {
        this.landStage = 0;
      }
    }
    this.jumpHeld = inp.jump;
    this.focusV.copy(wp);
  }

  private land(gy: number): void {
    const { ctx } = this;
    const impact = -this.wv.y;
    const fell = Math.max(0, this.fallTop - gy);
    this.wp.y = gy;
    this.mode = 'ground';
    if (this.inWater) {
      ctx.fx.splash?.({ position: this.wp.clone().setY(gy + 1.15), velocity: this.wv.clone(), size: Math.min(3, 0.8 + impact / 15) });
      this.wv.set(0, 0, 0);
      this.landStage = 0;
    } else if (impact > CONFIG.walk.hardLanding) {
      ctx.fx.dust(this.wp, Math.min(3, 0.8 + impact / 20), 0xcbb89a);
      this.shakeT = 0.6;
      this.shakeK = Math.min(1.2, impact / 40);
      ctx.events.emit('vibrate', { pattern: [90, 30, 60] });
      this.wv.set(0, 0, 0);
      this.landStage = 1;
      this.landT = 0;
      this.avatar?.play('fallBack', 0.05, 1, true);
    } else this.wv.y = 0;
    if (fell > 30) ctx.events.emit('toast', { text: `💥 Fell ${Math.round(fell)} m — still invincible`, ms: 2200 });
  }

  // ───────────────────────────── avatar + camera ─────────────────────────────
  private updateAvatar(dt: number): void {
    const a = this.avatar;
    if (!a) return;
    a.visible = !this.firstPerson;
    // lit by the cabin lights inside (match the cabin shader), a faint fill outdoors at night
    const night = GLOBAL_UNIFORMS.uNight.value;
    a.setFill?.(this.mode === 'cabin' ? (0.1 + 0.6 * smoothstep(0.12, 0.6, night)) : 0.22 * night);
    let vx: number, vz: number;
    if (this.mode === 'cabin') {
      vx = this.v.x;
      vz = this.v.z;
    } else {
      vx = this.wv.x;
      vz = this.wv.z;
    }
    const sp = Math.hypot(vx, vz);
    if (this.mode === 'cabin' && this.seat >= 0) {
      this.bodyYaw = 0;
      a.play('sit', 0.25);
    } else if (this.mode === 'fall' || (this.mode === 'cabin' && (this.floating || this.stumbling))) {
      a.play('tumble', 0.2);
    } else if (this.mode === 'ground' && this.landStage > 0) {
      /* sequence clips set in updateWorld */
    } else if (this.mode === 'ground' && !this.onGround && this.wv.y < -4) {
      a.play('tumble', 0.2);
    } else if (sp > 2.4) a.play('run', 0.2, (0.66 * sp) / 2.7);
    else if (sp > 0.15) a.play('walk', 0.2, (this.inWater ? 0.7 : 1) * Math.max(0.5, sp / 1.36));
    else a.play('idle', 0.3);
    if (sp > 0.3 && this.seat < 0 && this.landStage === 0) this.bodyYaw = dampAngle(this.bodyYaw, Math.atan2(vx, vz), 10, dt);
    _m.makeRotationY(this.bodyYaw);
    if (this.mode === 'cabin') {
      const po = this.partOf(this.sec);
      if (po) {
        _m.setPosition(_v.copy(this.p).sub(po.rest));
        _m2.multiplyMatrices(po.obj.matrixWorld, _m);
        a.setMatrix(_m2);
      }
    } else {
      _m.setPosition(this.wp);
      a.setMatrix(_m);
    }
    a.update(dt);
  }

  private updateCamera(dt: number): void {
    const { ctx } = this;
    const W = CONFIG.walk;
    const cam = ctx.engine.camera;
    if (!this.camSaved) this.camSaved = { fov: cam.fov, near: cam.near };
    const cp = Math.cos(this.pitch);
    const dir = _v.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    const eye = _v2;
    if (this.mode === 'cabin' && this.cabin) {
      const po = this.partOf(this.sec);
      if (!po) return;
      const cab = this.cabin;
      const ceil = this.sample(cab.ceil, this.p.z);
      const headroom = Math.min(1.75, ceil - cab.floorY - 0.02);
      if (this.firstPerson) {
        const ey = this.seat >= 0 ? W.sitEye : this.floating ? 0.9 : Math.min(W.eye, headroom - 0.1);
        eye.copy(this.p).setY(this.p.y + ey).addScaledVector(dir, this.seat >= 0 ? 0.02 : 0.1);
        this.applyBob(eye);
        // anti-noclip: the eye never leaves the cabin (walls, bins, ceiling, floor, closed ends)
        const c = this.chain;
        if (!c.openFront) eye.z = Math.min(eye.z, c.zMax - 0.12);
        if (!c.openRear) eye.z = Math.max(eye.z, c.zMin + 0.12);
        const inside = (c.openFront || eye.z < c.zMax) && (c.openRear || eye.z > c.zMin) && eye.z <= cab.frontZ && eye.z >= cab.rearZ;
        if (inside) {
          eye.y = Math.min(eye.y, this.sample(cab.ceil, eye.z) - 0.1);
          eye.y = Math.max(eye.y, cab.floorY + 0.25);
          const lim = (cab.halfWidthAt ? cab.halfWidthAt(eye.z, eye.y) : this.sample(cab.halfW, eye.z)) - 0.04;
          if (Math.abs(eye.x) > lim) eye.x = Math.sign(eye.x) * Math.max(0, lim);
        }
      } else {
        const tgt = _v3.copy(this.p).setY(this.p.y + (this.seat >= 0 ? 1.0 : 1.35));
        const c = this.chain;
        for (let t = 1; t >= 0.15; t -= 0.085) {
          eye.copy(tgt).addScaledVector(dir, -W.tpDist * t);
          eye.y += 0.3 * t;
          const zc = clamp(eye.z, cab.rearZ, cab.frontZ);
          const hw = this.sample(cab.halfW, zc);
          const top = this.sample(cab.ceil, zc) - 0.12;
          // overhead bins hang over the seats: high up, stay toward the aisle
          const lim = cab.halfWidthAt ? cab.halfWidthAt(zc, eye.y) - 0.15 : eye.y > cab.floorY + 1.4 ? hw * 0.55 : hw - 0.2;
          const insideZ = (c.openFront || eye.z < c.zMax - 0.2) && (c.openRear || eye.z > c.zMin + 0.2);
          if (Math.abs(eye.x) < lim && eye.y < top && eye.y > cab.floorY + 0.3 && insideZ) break;
        }
      }
      // local look rotation, then into the section's world frame
      _m.lookAt(eye, _v3.copy(eye).add(dir), UP);
      _q.setFromRotationMatrix(_m);
      po.obj.matrixWorld.decompose(_s, _q2, _v3);
      cam.quaternion.multiplyQuaternions(_q2, _q);
      cam.position.copy(eye).sub(po.rest).applyMatrix4(po.obj.matrixWorld);
    } else {
      const lying = this.landStage === 1 || this.landStage === 2;
      if (this.firstPerson) {
        const ey = lying ? 0.35 : this.mode === 'fall' ? 0.9 : this.inWater ? 1.4 : W.eye;
        eye.copy(this.wp).setY(this.wp.y + ey).addScaledVector(dir, 0.1);
        this.applyBob(eye);
      } else {
        const tgt = _v3.copy(this.wp).setY(this.wp.y + 1.2);
        eye.copy(tgt).addScaledVector(dir, -W.tpDistWorld);
        eye.y += 0.5;
        const gy = this.surfaceAt(eye.x, eye.z) + (this.inWater ? 1.6 : 0.4);
        if (eye.y < gy) eye.y = gy;
      }
      _m.lookAt(eye, _v3.copy(eye).add(dir), UP);
      cam.quaternion.setFromRotationMatrix(_m);
      cam.position.copy(eye);
    }
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = this.shakeK * Math.min(1, this.shakeT) * 0.12;
      cam.position.x += (Math.random() - 0.5) * k;
      cam.position.y += (Math.random() - 0.5) * k;
      cam.position.z += (Math.random() - 0.5) * k;
      if (this.shakeT <= 0) this.shakeK = 0;
    }
    const fov = this.firstPerson ? W.fovFP : W.fovTP;
    if (Math.abs(cam.fov - fov) > 0.01 || Math.abs(cam.near - 0.05) > 1e-4) {
      cam.fov = fov;
      cam.near = 0.05;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    // the first-person hand
    const hand = this.hand;
    if (hand) {
      const show = this.firstPerson && this.seat < 0 && !(this.mode === 'ground' && this.landStage > 0);
      hand.root.visible = show;
      if (show) {
        const sp = this.mode === 'cabin' ? Math.hypot(this.v.x, this.v.z) : Math.hypot(this.wv.x, this.wv.z);
        const runK = clamp((sp - W.walk * 1.05) / (W.walk * 0.5), 0, 1);
        const night = GLOBAL_UNIFORMS.uNight.value;
        const fill = this.mode === 'cabin' ? 0.1 + 0.6 * smoothstep(0.12, 0.6, night) : 0.22 * night;
        hand.update(cam, dt, this.bob, this.bobK, runK, this.floatK, fill);
      }
    }
  }

  /** Head bob while walking (user request): one up-down per step, a gentle side sway per stride. */
  private applyBob(eye: THREE.Vector3): void {
    if (this.bobK < 0.01) return;
    const k = this.bobK;
    const r = _v3.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    eye.y += Math.sin(this.bob * 2) * 0.035 * k;
    eye.addScaledVector(r, Math.sin(this.bob) * 0.025 * k);
  }

  /** Walk cycle for the bob and the hand: steps of ~0.9 m, at most ~5.5 steps a second. */
  private updateBob(dt: number): void {
    const cabin = this.mode === 'cabin';
    const sp = cabin ? Math.hypot(this.v.x, this.v.z) : Math.hypot(this.wv.x, this.wv.z);
    const grounded = cabin ? this.seat < 0 && !this.floating && !this.stumbling : this.mode === 'ground' && this.onGround && this.landStage === 0;
    const want = grounded ? clamp(sp / 2.2, 0, 1) : 0;
    this.bobK += (want - this.bobK) * Math.min(1, dt * 6);
    this.bob += dt * Math.PI * Math.min(sp / 0.9, 5.5);
    const fl = cabin ? (this.floating || this.stumbling ? 1 : 0) : this.mode === 'fall' ? 1 : 0;
    this.floatK += (fl - this.floatK) * Math.min(1, dt * 4);
  }

  dispose(): void {
    this.avatar?.dispose();
    this.hand?.dispose();
  }
}
