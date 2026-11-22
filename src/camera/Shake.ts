import { CONFIG } from '../config';
import { noise1 } from './camMath';

/**
 * Trauma-based camera shake (Squirrel Eiserloh, GDC 2016): trauma 0..1 decays linearly, the visible shake is
 * trauma² driven by smooth noise (rotation mostly, a little translation). A separate low-amplitude, higher
 * frequency "vibration" channel handles continuous rumble (top speed, off-road) without accumulating.
 */
export class Shake {
  trauma = 0;
  /** Extra FOV (degrees) punched out by explosions, decays quickly. */
  fovKick = 0;
  private decay = -1; // custom decay (trauma/s) from the last shake(i, duration), -1 = config default
  private t = Math.random() * 100;

  // Output (radians / meters), read after sample().
  yaw = 0;
  pitch = 0;
  roll = 0;
  x = 0;
  y = 0;
  z = 0;

  add(amount: number, duration = 0): void {
    if (!(amount > 0)) return;
    this.trauma = Math.min(1, this.trauma + amount);
    if (duration > 0) {
      const d = this.trauma / duration;
      this.decay = Math.max(this.decay, Math.min(4, Math.max(0.3, d)));
    }
  }

  kick(fovDeg: number): void {
    this.fovKick = Math.max(this.fovKick, fovDeg);
  }

  reset(): void {
    this.trauma = 0;
    this.fovKick = 0;
    this.decay = -1;
    this.yaw = this.pitch = this.roll = this.x = this.y = this.z = 0;
  }

  /** Advance and compute offsets. `vibration` 0..1 continuous rumble, `scale` per-mode multiplier. */
  sample(dt: number, vibration: number, scale: number): void {
    const c = CONFIG.camera;
    this.t += dt;
    const rate = this.decay > 0 ? this.decay : c.shakeDecay;
    this.trauma = Math.max(0, this.trauma - rate * dt);
    if (this.trauma <= 0) this.decay = -1;
    this.fovKick = Math.max(0, this.fovKick - this.fovKick * Math.min(1, dt * c.fovKickDecay) - dt * 0.5);

    const s = this.trauma * this.trauma * scale;
    const f = c.shakeFreq;
    const t = this.t * f;
    this.yaw = c.shakeMaxAngle * s * noise1(t, 1);
    this.pitch = c.shakeMaxAngle * s * noise1(t, 2);
    this.roll = c.shakeMaxRoll * s * noise1(t * 0.8, 3);
    this.x = c.shakeMaxOffset * s * noise1(t, 4);
    this.y = c.shakeMaxOffset * s * noise1(t, 5);
    this.z = c.shakeMaxOffset * 0.5 * s * noise1(t, 6);

    if (vibration > 0) {
      const v = vibration * scale;
      const tv = this.t * c.vibrationFreq;
      this.pitch += c.vibrationAngle * v * noise1(tv, 7);
      this.roll += c.vibrationAngle * 0.6 * v * noise1(tv, 8);
      this.y += c.vibrationOffset * v * noise1(tv * 1.3, 9);
      this.x += c.vibrationOffset * 0.5 * v * noise1(tv * 1.1, 10);
    }
  }
}
