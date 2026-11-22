import * as THREE from 'three';
import { CONFIG } from '../../config';
import { ROOM_MAX_CAM_DIST } from './GarageScene';

const DEG = Math.PI / 180;

/**
 * Orbit camera for the garage (owner: garage): drag/swipe to orbit with inertia, pinch / wheel to zoom, double-tap to
 * re-frame. Listens on its own "stage" element only, so the UI panels never orbit the camera.
 * The projection is shifted with setViewOffset so the car sits in the middle of the area left free by the UI.
 */
export class GarageOrbit {
  yaw = CONFIG.garage.defaultYawDeg * DEG;
  pitch = CONFIG.garage.defaultPitchDeg * DEG;
  zoom = 1;
  /** Seconds since the last user interaction (drives the turntable idle resume). */
  idle = 999;
  readonly target = new THREE.Vector3(0, 0.7, 0);

  private desiredTarget = new THREE.Vector3(0, 0.7, 0);
  private fitDist = 7;
  private dist = 9;
  private vYaw = 0;
  private vPitch = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchStart = 0;
  private zoomStart = 1;
  private lastMoveT = 0;
  private lastTap = 0;
  private introT = 1;
  private viewTop = 0;
  private viewBottom = 0;
  private curOffset = 0;
  private lastW = 0;
  private lastH = 0;
  private carSize = new THREE.Vector3(1.9, 1.4, 4.4);
  private enabled = false;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private el: HTMLElement,
    private onInteract: () => void,
  ) {
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('lostpointercapture', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get interacting(): boolean {
    return this.pointers.size > 0 || Math.abs(this.vYaw) > 0.05 || Math.abs(this.vPitch) > 0.05;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.pointers.clear();
      this.vYaw = this.vPitch = 0;
    }
  }

  /** Free screen area for the car (CSS px from the top / bottom edges covered by UI). */
  setViewInsets(top: number, bottom: number): void {
    this.viewTop = top;
    this.viewBottom = bottom;
  }

  /** New car dimensions → new framing. */
  frame(size: THREE.Vector3, centerY: number, resetView: boolean): void {
    this.carSize.copy(size);
    this.desiredTarget.set(0, centerY, 0);
    if (resetView) {
      this.target.copy(this.desiredTarget);
    }
  }

  /** Cinematic sweep-in when the garage opens. */
  intro(): void {
    this.introT = 0;
    this.yaw = CONFIG.garage.defaultYawDeg * DEG;
    this.pitch = CONFIG.garage.defaultPitchDeg * DEG;
    this.zoom = 1;
    this.vYaw = this.vPitch = 0;
    this.idle = 999;
    this.curOffset = this.computeOffsetTarget();
  }

  resetView(): void {
    this.zoom = 1;
    this.pitch = CONFIG.garage.defaultPitchDeg * DEG;
    this.vYaw = this.vPitch = 0;
  }

  private computeOffsetTarget(): number {
    const H = window.innerHeight;
    const free = Math.max(80, H - this.viewTop - this.viewBottom);
    const cy = this.viewTop + free / 2;
    return H / 2 - cy;
  }

  /** Distance that fits the car into the free area (car can face any direction on the turntable). */
  private computeFit(): number {
    const H = Math.max(1, window.innerHeight);
    const W = Math.max(1, window.innerWidth);
    const free = Math.max(80, H - this.viewTop - this.viewBottom);
    const t = Math.tan((this.camera.fov * DEG) / 2);
    const tv = t * (free / H);
    const th = t * (W / H);
    const s = this.carSize;
    const len = Math.max(s.x, s.z);
    const p = this.pitch;
    const halfV = (s.y * Math.cos(p) + len * Math.sin(p)) / 2;
    const dV = halfV / tv + len * 0.35;
    const dH = (len * 0.55) / th + s.x * 0.5;
    return Math.max(dV, dH) * 1.08;
  }

  update(dt: number): void {
    const cfg = CONFIG.garage;
    this.idle += dt;
    // Inertia.
    if (this.pointers.size === 0) {
      this.yaw += this.vYaw * dt;
      this.pitch += this.vPitch * dt;
      const decay = Math.exp(-cfg.orbitInertia * dt);
      this.vYaw *= decay;
      this.vPitch *= decay;
      if (Math.abs(this.vYaw) < 0.002) this.vYaw = 0;
      if (Math.abs(this.vPitch) < 0.002) this.vPitch = 0;
    }
    const pMin = cfg.pitchMinDeg * DEG, pMax = cfg.pitchMaxDeg * DEG;
    if (this.pitch < pMin) { this.pitch = pMin; this.vPitch = 0; }
    if (this.pitch > pMax) { this.pitch = pMax; this.vPitch = 0; }
    this.zoom = Math.min(cfg.zoomMax, Math.max(cfg.zoomMin, this.zoom));

    // Framing (target + distance), eased.
    const k = 1 - Math.exp(-dt * 6);
    this.target.lerp(this.desiredTarget, k);
    this.fitDist = this.computeFit();
    let introEase = 1;
    if (this.introT < 1) {
      this.introT = Math.min(1, this.introT + dt / 1.6);
      const t = this.introT;
      introEase = 1 - Math.pow(1 - t, 3);
    }
    const wantDist = Math.min(ROOM_MAX_CAM_DIST, this.fitDist * this.zoom) * (1 + (1 - introEase) * 0.55);
    this.dist += (wantDist - this.dist) * (this.introT < 1 ? 1 : k);

    const yaw = this.yaw + (1 - introEase) * 0.9;
    const pitch = this.pitch + (1 - introEase) * 0.12;
    const cp = Math.cos(pitch);
    this.camera.position.set(
      this.target.x + Math.sin(yaw) * cp * this.dist,
      this.target.y + Math.sin(pitch) * this.dist,
      this.target.z + Math.cos(yaw) * cp * this.dist,
    );
    this.camera.lookAt(this.target);

    // Shift the projection centre into the free area (smoothly when the dock resizes).
    const W = window.innerWidth, H = window.innerHeight;
    const off = this.computeOffsetTarget();
    this.curOffset += (off - this.curOffset) * (1 - Math.exp(-dt * 8));
    if (Math.abs(this.curOffset - off) < 0.25) this.curOffset = off;
    const view = this.camera.view;
    if (!view || view.offsetY !== this.curOffset || this.lastW !== W || this.lastH !== H || view.fullHeight !== H) {
      this.camera.aspect = W / H;
      this.camera.setViewOffset(W, H, 0, this.curOffset, W, H);
      this.lastW = W;
      this.lastH = H;
    }
  }

  // ───────────────────────────── input ─────────────────────────────
  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.vYaw = this.vPitch = 0;
    this.lastMoveT = performance.now();
    if (this.pointers.size === 2) {
      this.pinchStart = this.pinchDistance();
      this.zoomStart = this.zoom;
    } else if (this.pointers.size === 1) {
      const now = performance.now();
      if (now - this.lastTap < 300) this.resetView();
      this.lastTap = now;
    }
    this.touch();
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size >= 2) {
      const d = this.pinchDistance();
      if (this.pinchStart > 10) this.zoom = this.zoomStart * (this.pinchStart / Math.max(10, d));
    } else {
      const s = CONFIG.garage.orbitSpeed;
      const now = performance.now();
      const dtm = Math.max(8, now - this.lastMoveT) / 1000;
      this.lastMoveT = now;
      this.yaw -= dx * s;
      this.pitch += dy * s * 0.7;
      // Smoothed fling velocity (rad/s).
      const vy = (-dx * s) / dtm, vp = (dy * s * 0.7) / dtm;
      this.vYaw = this.vYaw * 0.5 + vy * 0.5;
      this.vPitch = this.vPitch * 0.5 + vp * 0.5;
      if (Math.abs(dx) + Math.abs(dy) > 2) this.lastTap = 0;
    }
    this.touch();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    // Stale fling (finger held still before release) → no inertia.
    if (performance.now() - this.lastMoveT > 90) this.vYaw = this.vPitch = 0;
    const max = 6;
    this.vYaw = Math.max(-max, Math.min(max, this.vYaw));
    this.vPitch = Math.max(-max * 0.5, Math.min(max * 0.5, this.vPitch));
    if (this.pointers.size === 1) {
      // Pinch → one finger: continue orbiting from here without a jump.
      this.vYaw = this.vPitch = 0;
    }
    this.touch();
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoom *= Math.exp(dy * 0.0012);
    this.touch();
  };

  private pinchDistance(): number {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  private touch(): void {
    this.idle = 0;
    this.onInteract();
  }
}
