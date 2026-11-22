import { CONFIG } from '../../config';
import { clamp, damp, DEG } from '../../core/math';

/**
 * Tilt steering from DeviceOrientation (spec §9). Works for both "steering wheel" (phone upright) and "tray"
 * (phone flat) grips: we rebuild the gravity direction in device space from beta/gamma, project it into the
 * current screen orientation, and use the roll angle in the screen plane. Calibrated to the pose at enable time.
 */
type OrientationPermission = 'unknown' | 'granted' | 'denied' | 'unsupported';

export class Tilt {
  permission: OrientationPermission = 'unknown';
  /** True once at least one real orientation sample arrived. */
  available = false;
  private listening = false;
  private raw = 0; // degrees, right = positive
  private smooth = 0;
  private neutral = 0;
  private needsCalib = true;
  private lastSample = 0;
  private startedAt = 0;

  constructor() {
    window.addEventListener('orientationchange', () => this.calibrate());
    screen.orientation?.addEventListener?.('change', () => this.calibrate());
  }

  get supported(): boolean {
    return typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  }

  /** iOS 13+ requires a permission prompt from a user gesture. Call from a tap handler. */
  async request(): Promise<boolean> {
    if (!this.supported) {
      this.permission = 'unsupported';
      return false;
    }
    const DOE = (window as unknown as { DeviceOrientationEvent: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const r = await DOE.requestPermission();
        this.permission = r === 'granted' ? 'granted' : 'denied';
      } catch {
        this.permission = 'denied';
      }
    } else {
      this.permission = 'granted';
    }
    if (this.permission === 'granted') this.listen();
    return this.permission === 'granted';
  }

  /** Does this platform need an explicit permission tap (iOS)? */
  get needsPermission(): boolean {
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: unknown } }).DeviceOrientationEvent;
    return !!DOE && typeof DOE.requestPermission === 'function' && this.permission !== 'granted';
  }

  listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.startedAt = performance.now();
    window.addEventListener('deviceorientation', this.onOrient);
  }

  /** No samples within 1.5 s of listening → the device has no gyro/accelerometer (desktop). */
  get timedOut(): boolean {
    return this.listening && !this.available && performance.now() - this.startedAt > 1500;
  }

  get active(): boolean {
    return this.listening && this.available && performance.now() - this.lastSample < 1000;
  }

  calibrate(): void {
    this.needsCalib = true;
  }

  private onOrient = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null || e.beta === undefined || e.gamma === undefined) return;
    const b = e.beta * DEG;
    const g = e.gamma * DEG;
    // World "up" expressed in device coordinates (W3C Z-X'-Y'' Euler angles).
    const ux = -Math.cos(b) * Math.sin(g);
    const uy = Math.sin(b);
    const uz = Math.cos(b) * Math.cos(g);
    const angle =
      (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) * DEG;
    const sx = ux * Math.cos(angle) - uy * Math.sin(angle); // up · screen-right
    const sy = ux * Math.sin(angle) + uy * Math.cos(angle); // up · screen-up
    const roll = Math.atan2(-sx, Math.hypot(sy, uz)) / DEG; // rotate the phone clockwise → positive (steer right)
    this.raw = roll;
    this.lastSample = performance.now();
    if (!this.available) {
      this.available = true;
      this.smooth = roll;
    }
    if (this.needsCalib) {
      this.neutral = roll;
      this.smooth = roll;
      this.needsCalib = false;
    }
  };

  /** Smoothed steering value −1..1. Call once per frame. */
  update(dt: number): number {
    const c = CONFIG.ui.steer;
    this.smooth = damp(this.smooth, this.raw, c.tiltSmoothing, dt);
    let d = this.smooth - this.neutral;
    const dz = c.tiltDeadzoneDeg;
    d = Math.abs(d) < dz ? 0 : d - Math.sign(d) * dz;
    return clamp(d / Math.max(1, c.tiltMaxDeg - dz), -1, 1);
  }

  /** Current roll relative to neutral, in degrees (for the on-screen indicator). */
  get rollDeg(): number {
    return this.smooth - this.neutral;
  }
}
