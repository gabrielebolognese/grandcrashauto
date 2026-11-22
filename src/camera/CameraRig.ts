import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, DEG } from '../core/math';
import type { CameraMode, GameContext, ICameraRig } from '../game/contracts';
import { blendPoses, CamPose, smooth01, smoother01 } from './camMath';
import { CarFrame } from './CarFrame';
import { ChaseCam } from './ChaseCam';
import { CinematicCam } from './CinematicCam';
import { HoodCam } from './HoodCam';
import { OrbitCam } from './OrbitCam';
import { PlaneRig } from './PlaneRig';
import { ScreenFlash } from './ScreenFlash';
import { Shake } from './Shake';
import { Showcase } from './Showcase';

/** Which controller currently produces the pose ('hold' = freeze on the last pose, nothing to follow). */
type Ctrl = 'chase' | 'hood' | 'orbit' | 'cine' | 'show' | 'plane' | 'hold';

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

/**
 * Camera rig (SPEC §10, §11, §13; PART2 cameras/crash camera; PART3 turbo/stunts/floating origin). Owner: camera.
 *
 * Car modes: chase (spring follow), hood (mounted), orbit (drag, auto-returns), cinematic (explosion orbit) and
 * showcase (title/menu city tour). In plane mode a PlaneRig (chase/cockpit/wing/orbit + explosion/crash phases)
 * takes over. Every controller writes a CamPose; the rig picks the active one, blends between controllers
 * (spherically around the subject so transitions swing around it rather than through it), then adds trauma
 * shake + FOV punch, an aspect-aware FOV correction and view-dependent near/far before writing `engine.camera`.
 *
 * All smoothing runs on real time (`engine.realDt`), so explosion slow-mo plays out while the camera keeps moving
 * at full speed — the classic "bullet time" look. Every tunable lives in CONFIG.camera.
 */
export class CameraRig implements ICameraRig {
  readonly name = 'camera';
  private _mode: CameraMode = 'showcase';

  get mode(): CameraMode {
    if (this.planeMode()) return this.plane.modeLabel;
    return this._mode;
  }

  /** Concrete view (adds plane 'cockpit' / 'wing'): chase | hood | orbit | cockpit | wing | cinematic | showcase. */
  get view(): 'chase' | 'hood' | 'orbit' | 'cockpit' | 'wing' | 'cinematic' | 'showcase' {
    if (this.planeMode()) return this.plane.viewLabel as 'chase';
    return this._mode;
  }

  private readonly frame = new CarFrame();
  private readonly chase = new ChaseCam();
  private readonly hood = new HoodCam();
  private readonly orbit = new OrbitCam();
  private readonly cine = new CinematicCam();
  private readonly show: Showcase;
  private readonly shakeFx = new Shake();
  private readonly flash = new ScreenFlash();
  private readonly plane: PlaneRig;

  /** Final pose before shake. */
  private readonly out = new CamPose();
  private readonly holdPose = new CamPose();
  private readonly frozen = new CamPose();
  private readonly frozenRel = new THREE.Vector3();
  private active: Ctrl = 'show';
  private blendFrom: Ctrl | 'frozen' | null = null;
  private blendT = 0;
  private blendDur = 0;
  private cutNext = true;
  private snapPending = false;
  private cineReturn: CameraMode = 'chase';
  /** 0..1 linear look-back progress. */
  private lookBack = 0;
  private externalDrag = false;
  private dragId = -1;
  private lastX = 0;
  private lastY = 0;
  private dragAccum = 0;
  private dragging = false;
  private unsubs: (() => void)[] = [];
  private domCleanup: (() => void)[] = [];

  constructor(private readonly ctx: GameContext) {
    this.show = new Showcase(ctx);
    this.plane = new PlaneRig(ctx, this.shakeFx, this.flash);
  }

  init(): void {
    const { events } = this.ctx;
    this.show.init();
    this.flash.init();
    this.plane.init();
    this.unsubs.push(
      events.on('explosion', (e) => this.onExplosion(e.position, e.force)),
      events.on('impact', (e) => this.onImpact(e.strength)),
      events.on('stateChanged', ({ to }) => {
        // The showcase overlay must never linger over the garage or the drive.
        if (to !== 'title' && to !== 'menu') this.show.stop();
        if (to !== 'driving' && to !== 'paused') this.flash.clear();
      }),
      events.on('originShift', ({ delta }) => this.onOriginShift(delta.x, delta.z)),
      events.on('turbo', ({ on }) => {
        if (!on || this.planeMode() || this._mode === 'showcase') return;
        const c = CONFIG.camera;
        this.shakeFx.add(c.turboShake, 0.6);
        this.shakeFx.kick(c.turboPunch);
      }),
      events.on('stunt', (e) => this.onStunt(e.kind)),
      events.on('modeChanged', ({ mode }) => {
        if (mode === 'plane') this.plane.snap();
      }),
    );
    this.bindPointer();
    this.out.pos.copy(this.ctx.engine.camera.position);
    this.out.quat.copy(this.ctx.engine.camera.quaternion);
    this.out.fov = CONFIG.camera.fov;
    this.holdPose.copy(this.out);
  }

  private planeMode(): boolean {
    return this.ctx.game?.mode === 'plane' && this._mode !== 'showcase';
  }

  // ───────────────────────────── ICameraRig ─────────────────────────────
  cycleMode(): void {
    if (this._mode === 'showcase') return;
    if (this.planeMode()) {
      const label = this.plane.cycle();
      if (label) this.ctx.events.emit('toast', { text: label, ms: 1100 });
      return;
    }
    if (this._mode === 'cinematic') {
      this.endCinematic(false);
      return;
    }
    const next: CameraMode = this._mode === 'chase' ? 'hood' : this._mode === 'hood' ? 'orbit' : 'chase';
    this.applyUserMode(next, true);
    const label = next === 'chase' ? 'Chase camera' : next === 'hood' ? 'Hood camera' : 'Orbit camera — drag to look around';
    this.ctx.events.emit('toast', { text: label, ms: 1100 });
  }

  setMode(mode: CameraMode): void {
    if (mode === 'showcase') {
      this.enterShowcase();
      return;
    }
    if (mode === 'cinematic') {
      const target = this.frame.active ? this.frame.pivot : this.chase.pivot;
      this.startCinematic(target, CONFIG.camera.cineDuration);
      return;
    }
    if (this._mode === 'showcase') this.show.stop();
    this.applyUserMode(mode, true);
  }

  shake(intensity: number, duration: number): void {
    this.shakeFx.add(intensity, duration);
  }

  startCinematic(target: THREE.Vector3, duration: number): void {
    if (this._mode === 'showcase') return;
    if (this._mode !== 'cinematic') this.cineReturn = this._mode === 'orbit' ? 'chase' : this._mode;
    this.cine.start(this.ctx, target, duration > 0 ? duration : CONFIG.camera.cineDuration, this.out.pos);
    this._mode = 'cinematic';
  }

  skipCinematic(): void {
    if (this.planeMode()) this.plane.endPhase();
    if (this._mode !== 'cinematic') return;
    this.endCinematic(true);
  }

  snap(): void {
    if (this._mode === 'showcase') return;
    this.snapPending = true;
    this.cutNext = true;
    this.blendFrom = null;
    if (this.planeMode()) {
      this.plane.snap();
      return;
    }
    // Best effort right now; repeated on the next update with fresh vehicle state (spawn/reset happen
    // before the vehicle has re-published its interpolated transform).
    if (this.frame.update(this.ctx, 0)) {
      this.doSnap(false);
      this.writeCamera(0);
    }
  }

  orbitDrag(dx: number, dy: number): void {
    this.externalDrag = true;
    this.drag(dx, dy);
  }

  // ───────────────────────────── mode plumbing ─────────────────────────────
  private applyUserMode(mode: CameraMode, explicit: boolean): void {
    if (mode !== 'chase' && mode !== 'hood' && mode !== 'orbit') return;
    const prev = this._mode;
    if (prev === 'cinematic') this.cutNext = true;
    this._mode = mode;
    if (mode === 'orbit' && prev !== 'orbit') {
      const from = prev === 'hood' ? this.chase.pose.pos : this.out.pos;
      this.orbit.enter(from, this.chase.pivot, explicit);
    }
    if (mode === 'hood' && prev !== 'hood') this.hood.snap();
  }

  private enterShowcase(): void {
    if (this._mode === 'showcase' && this.show.active) return;
    this._mode = 'showcase';
    this.cutNext = true;
    this.blendFrom = null;
    this.lookBack = 0;
    this.shakeFx.reset();
    this.flash.clear();
    this.show.start();
  }

  private endCinematic(cut: boolean): void {
    this._mode = this.cineReturn;
    if (cut) this.cutNext = true;
    // Hand over seamlessly: the chase heading picks up from wherever the cinematic camera is.
    if (this.frame.active) this.chase.faceFrom(this.out.pos, this.frame);
  }

  private doSnap(clearPending: boolean): void {
    const f = this.frame;
    f.resetHistory();
    this.chase.snap(f);
    this.hood.snap();
    this.shakeFx.reset();
    this.lookBack = 0;
    this.blendFrom = null;
    this.chase.update(this.ctx, f, 0, 0);
    if (this._mode === 'hood' && !f.exploded) this.hood.update(f, 0, false);
    this.out.copy(this._mode === 'hood' && !f.exploded ? this.hood.pose : this.chase.pose);
    this.active = this._mode === 'hood' && !f.exploded ? 'hood' : this._mode === 'orbit' ? 'orbit' : 'chase';
    if (this.active === 'orbit') this.orbit.enter(this.chase.pose.pos, this.chase.pivot, this.orbit.explicit);
    this.cutNext = false;
    if (clearPending) this.snapPending = false;
  }

  private blendDuration(from: Ctrl, to: Ctrl): number {
    const c = CONFIG.camera;
    if (from === 'show' || to === 'show' || from === 'hold' || to === 'hold') return 0;
    if (to === 'plane') return c.planeBoardBlend; // camera move from the car to the plane
    if (from === 'plane') return c.planeExitBlend;
    if (to === 'cine') return c.cineBlendIn + this.cine.extraBlend;
    if (from === 'cine') return c.cineBlendOut;
    if (from === 'orbit' && to === 'chase') return this.lookBack > 0 ? Math.max(0.05, c.lookBackBlend) : c.orbitBlend;
    if (from === 'chase' && to === 'orbit') return this.lookBack > 0 ? Math.max(0.05, c.lookBackBlend) : 0;
    return 0; // chase ⇄ hood: a clean cut (a blend would fly through the car body)
  }

  /** Pivot for spherical blending: the subject we are blending TO. */
  private pivotFor(_a: Ctrl | 'frozen' | null, b: Ctrl): THREE.Vector3 | null {
    if (b === 'plane') return this.plane.active ? this.plane.pivot : null;
    return this.frame.active ? this.chase.pivot : null;
  }

  private frozenOnCar = false;

  private transition(to: Ctrl): void {
    const from = this.active;
    const dur = this.cutNext ? 0 : this.blendDuration(from, to);
    this.cutNext = false;
    if (dur <= 0) {
      this.blendFrom = null;
    } else if (this.blendFrom !== null || from === 'plane' || to === 'plane') {
      // Interrupted mid-blend: freeze what's on screen, riding along with the car. Crossing car ⇄ plane: the
      // subject we leave is parked, so the frozen shot simply stays put in the world.
      this.frozen.copy(this.out);
      this.frozenOnCar = from !== 'plane' && to !== 'plane' && this.frame.active;
      if (this.frozenOnCar) this.frozenRel.subVectors(this.out.pos, this.chase.pivot);
      this.blendFrom = 'frozen';
    } else {
      this.blendFrom = from;
    }
    this.blendT = 0;
    this.blendDur = dur;
    this.active = to;
  }

  private poseOf(c: Ctrl | 'frozen'): CamPose {
    switch (c) {
      case 'chase': return this.chase.pose;
      case 'hood': return this.hood.pose;
      case 'orbit': return this.orbit.pose;
      case 'cine': return this.cine.pose;
      case 'show': return this.show.pose;
      case 'plane': return this.plane.pose;
      case 'frozen':
        if (this.frozenOnCar && this.frame.active) this.frozen.pos.addVectors(this.chase.pivot, this.frozenRel);
        return this.frozen;
      default: return this.holdPose;
    }
  }

  // ───────────────────────────── per frame ─────────────────────────────
  update(_dt: number, _alpha: number): void {
    const ctx = this.ctx;
    const c = CONFIG.camera;
    const dt = Math.min(0.1, Math.max(0, ctx.engine.realDt));
    const f = this.frame;
    const hasCar = f.update(ctx, dt);
    const planeMode = this.planeMode();

    if (this._mode === 'showcase' && !this.show.active) this.show.start();
    if (!planeMode && hasCar && this._mode !== 'showcase' && (this.snapPending || f.fresh)) this.doSnap(true);
    if (planeMode) this.snapPending = false;

    // Look-back (held): chase arcs around quickly, hood cuts to the tail camera.
    const lbHeld = !planeMode && hasCar && !f.exploded && this._mode !== 'showcase' && this._mode !== 'cinematic' && !!ctx.input?.state?.lookBack;
    const lbDur = c.lookBackBlend;
    this.lookBack = lbDur > 0 ? clamp(this.lookBack + (lbHeld ? dt : -dt) / lbDur, 0, 1) : lbHeld ? 1 : 0;
    const lbW = smoother01(this.lookBack);

    if (planeMode) this.plane.update(dt);
    else this.flash.update(dt);

    let want: Ctrl;
    if (this._mode === 'showcase') want = 'show';
    else if (planeMode) want = this.plane.active ? 'plane' : 'hold';
    else if (this._mode === 'cinematic') want = 'cine';
    else if (!hasCar) want = 'hold';
    else if (this._mode === 'hood' && !f.exploded) want = 'hood';
    else if (this._mode === 'orbit' && !lbHeld) want = 'orbit';
    else want = 'chase';
    if (want !== this.active) this.transition(want);

    // Controllers. The chase cam always runs with a car: it is "home" for every return blend.
    const needs = (k: Ctrl) => this.active === k || this.blendFrom === k;
    if (hasCar) this.chase.update(ctx, f, dt, lbW);
    if (hasCar && needs('hood')) this.hood.update(f, dt, lbHeld);
    if (hasCar && needs('orbit')) this.orbit.update(ctx, f, this.chase.pivot, this.chase.dist, dt);
    if (needs('cine')) this.cine.update(ctx, f, dt);
    if (needs('show')) this.show.update(dt);

    // Compose (with blend).
    const pose = this.poseOf(this.active);
    if (this.blendFrom && this.blendDur > 0) {
      this.blendT += dt;
      const w = smoother01(this.blendT / this.blendDur);
      blendPoses(this.poseOf(this.blendFrom), pose, w, this.pivotFor(this.blendFrom, this.active), this.out);
      if (this.blendT >= this.blendDur) this.blendFrom = null;
    } else {
      this.out.copy(pose);
    }
    this.holdPose.copy(this.out);

    // Mode bookkeeping for next frame.
    if (!planeMode && this._mode === 'cinematic' && this.cine.done) this.endCinematic(false);
    if (!planeMode && this._mode === 'orbit' && this.active === 'orbit' && this.orbit.wantsReturn) this._mode = 'chase';

    // Shake sources from the car itself: landings, top-speed vibration, off-road rumble, turbo body shake.
    let vib = 0;
    if (!planeMode && hasCar && !f.exploded && (this.active === 'chase' || this.active === 'hood')) {
      if (f.landing > 5) this.shakeFx.add(clamp((f.landing - 5) / 14, 0, 1) * c.landingShake);
      if (!f.airborne) {
        vib = smooth01((f.speedN - c.speedShakeStart) / Math.max(0.05, 1 - c.speedShakeStart)) * c.speedShake;
        if (f.offroad) vib += c.offroadShake * smooth01(f.hSpeed / 15);
      }
      vib += c.turboVibration * f.turbo;
    }
    let scale = 1;
    if (this.active === 'show') scale = 0;
    else if (this.active === 'hood') scale = c.hoodShake;
    else if (this.active === 'plane' && this.plane.isMounted && !ctx.planes?.inCockpitSequence) scale = c.planeCockpitShake;
    this.shakeFx.sample(dt, vib, scale);
    this.writeCamera(scale);
    f.settle();
  }

  private writeCamera(shakeScale: number): void {
    const cam = this.ctx.engine.camera;
    cam.position.copy(this.out.pos);
    cam.quaternion.copy(this.out.quat);
    const s = this.shakeFx;
    let kick = 0;
    if (shakeScale > 0) {
      _e.set(s.pitch, s.yaw, s.roll, 'YXZ');
      cam.quaternion.multiply(_q.setFromEuler(_e));
      _v.set(s.x, s.y, s.z).applyQuaternion(cam.quaternion);
      cam.position.add(_v);
      kick = s.fovKick;
    }
    let dirty = false;
    const fov = this.aspectFov(this.out.fov + kick, cam.aspect);
    if (Math.abs(fov - cam.fov) > 1e-3) {
      cam.fov = fov;
      dirty = true;
    }
    const { near, far } = this.clipPlanes();
    if (Math.abs(near - cam.near) > near * 0.02 || Math.abs(far - cam.far) > far * 0.02) {
      cam.near = near;
      cam.far = far;
      dirty = true;
    }
    if (dirty) cam.updateProjectionMatrix();
  }

  /**
   * Near/far by view: hood/cockpit need a close near plane; the far plane covers the terrain view distance
   * (Part 3) and grows with altitude in a plane (haze to ~10 km) — env's fog and ocean radius follow it.
   */
  private clipPlanes(): { near: number; far: number } {
    const c = CONFIG.camera;
    const q = (this.ctx.quality?.current ?? {}) as { terrainViewDistance?: number; viewDistance?: number };
    const view = Math.max(q.terrainViewDistance ?? 0, q.viewDistance ?? 0);
    let far = Math.max(c.far, view * 1.15 + 150);
    let near = this.active === 'hood' ? c.nearHood : c.near;
    if (this.active === 'plane') {
      near = this.plane.near;
      const agl = Math.max(0, this.ctx.planes?.state?.altitudeAgl ?? 0, this.out.pos.y - CONFIG.world.waterLevel);
      far = clamp(Math.max(far, view * 1.2 + agl * 3.5), c.far, c.planeFar);
    }
    return { near, far };
  }

  /**
   * Keep framing sane on any screen: the design FOV is for 16:9. On wider screens (landscape phones ~2.16:1)
   * the vertical FOV shrinks part-way so the horizontal view doesn't balloon; on narrower ones (4:3 tablets)
   * it grows part-way so the sides aren't cropped.
   */
  private aspectFov(vfov: number, aspect: number): number {
    const c = CONFIG.camera;
    if (!(aspect > 0)) return vfov;
    const ref = c.aspectRef > 0 ? c.aspectRef : 16 / 9;
    const k = aspect > ref ? c.aspectWideK : c.aspectNarrowK;
    const t = Math.tan((vfov * DEG) / 2) * Math.pow(ref / aspect, k);
    return clamp((2 * Math.atan(t)) / DEG, 20, 100);
  }

  // ───────────────────────────── events ─────────────────────────────
  private onOriginShift(dx: number, dz: number): void {
    // Core already moved every scene child (incl. engine.camera); shift every cached world-space position too,
    // or springs/blends would swoop across kilometres.
    for (const p of [this.out, this.holdPose, this.frozen]) {
      p.pos.x -= dx;
      p.pos.z -= dz;
    }
    this.frame.shift(dx, dz);
    this.chase.shift(dx, dz);
    this.hood.shift(dx, dz);
    this.orbit.shift(dx, dz);
    this.cine.shift(dx, dz);
    this.show.shift(dx, dz);
    this.plane.shift(dx, dz);
  }

  private onStunt(kind: string): void {
    if (this.planeMode() || this._mode === 'showcase') return;
    const c = CONFIG.camera;
    if (kind === 'barrelRoll') this.chase.showRoll(c.rollShowTime);
    else if (kind === 'cleanLanding') {
      this.chase.bump(c.landingBump);
      this.shakeFx.add(0.12);
    } else if (kind === 'crashLanding') this.shakeFx.add(0.5, 0.8);
  }

  private onExplosion(pos: THREE.Vector3, force: number): void {
    if (this._mode === 'showcase' || this.ctx.game?.state !== 'driving' || this.planeMode()) return;
    const c = CONFIG.camera;
    const d = this.ctx.engine.camera.position.distanceTo(pos);
    const k = clamp(1 - d / Math.max(1, c.explosionShakeRange), 0.15, 1) * clamp(Number.isFinite(force) && force > 0 ? force : 1, 0.4, 1.5);
    this.shakeFx.add(c.explosionShake * k, c.explosionShakeTime);
    this.shakeFx.kick(c.fovKick * k);
    // The player's own car blowing up → cinematic. (Far-away blasts only shake.)
    const own = !this.frame.active || this.frame.pivot.distanceTo(pos) < 12;
    if (own && c.cineEnabled > 0) this.startCinematic(pos, c.cineDuration);
  }

  private onImpact(strength: number): void {
    if (this._mode === 'showcase' || this.planeMode()) return;
    const c = CONFIG.camera;
    if (!(strength > c.impactMin)) return;
    this.shakeFx.add(Math.min(1, strength) * c.impactShake);
  }

  // ───────────────────────────── pointer input ─────────────────────────────
  private canDrag(): boolean {
    if (this.ctx.game?.state !== 'driving') return false;
    if (this.planeMode()) return this.plane.active;
    return this.frame.active && (this._mode === 'chase' || this._mode === 'orbit' || this._mode === 'hood');
  }

  private drag(dx: number, dy: number): void {
    if (!this.canDrag() || !(Number.isFinite(dx) && Number.isFinite(dy))) return;
    if (this.planeMode()) {
      this.plane.drag(dx, dy);
      return;
    }
    if (this._mode === 'hood' && !this.frame.exploded) {
      this.hood.drag(dx, dy);
      return;
    }
    if (this._mode !== 'orbit') this.applyUserMode('orbit', false);
    this.orbit.drag(dx, dy);
  }

  /** Desktop: drag on the canvas (left or right button) to orbit / look, wheel to zoom. Touch is forwarded by the UI. */
  private bindPointer(): void {
    const el = this.ctx.engine?.canvas;
    if (!el) return;
    const down = (e: PointerEvent) => {
      if (this.dragId !== -1 || !this.canDrag()) return;
      if (e.pointerType === 'touch' && this.externalDrag) return; // the UI forwards touch drags itself
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      this.dragId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.dragAccum = 0;
      this.dragging = false;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== this.dragId) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (!this.dragging) {
        this.dragAccum += Math.abs(dx) + Math.abs(dy);
        if (this.dragAccum < 4) return;
        this.dragging = true;
      }
      if (e.pointerType === 'touch' && this.externalDrag) return;
      this.drag(dx, dy);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== this.dragId) return;
      this.dragId = -1;
      this.dragging = false;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const wheel = (e: WheelEvent) => {
      if (!this.canDrag() || e.ctrlKey) return;
      const d = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      if (this.planeMode()) this.plane.zoomBy(d);
      else if (this._mode !== 'hood') this.chase.zoomBy(d);
    };
    const ctxMenu = (e: Event) => {
      if (this.ctx.game?.state === 'driving') e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('wheel', wheel, { passive: true });
    el.addEventListener('contextmenu', ctxMenu);
    this.domCleanup.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctxMenu);
    });
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    for (const d of this.domCleanup) d();
    this.unsubs = [];
    this.domCleanup = [];
    this.show.stop();
    this.flash.dispose();
  }
}
