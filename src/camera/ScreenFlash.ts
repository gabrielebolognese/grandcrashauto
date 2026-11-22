import { clamp } from '../core/math';

/**
 * Full-screen white-out (SPEC-PART2 §11: middle-split cockpit impact → white flash, then cut outside).
 * A DOM overlay under the UI (z-index 6), pointer-events none. Runs on real time.
 */
export class ScreenFlash {
  private el: HTMLDivElement | null = null;
  private t = -1;
  private rise = 0.06;
  private hold = 0.35;
  private fall = 0.9;
  private shown = -1;

  init(): void {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'camera-flash';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:6;background:#fffdf6;opacity:0;display:none;will-change:opacity';
    document.body.appendChild(el);
    this.el = el;
  }

  /** True while the screen is (nearly) fully white — the moment to cut. */
  get covered(): boolean {
    return this.t >= this.rise && this.t <= this.rise + this.hold;
  }

  flash(rise = 0.06, hold = 0.35, fall = 0.9): void {
    this.rise = rise;
    this.hold = hold;
    this.fall = fall;
    this.t = 0;
  }

  clear(): void {
    this.t = -1;
    this.set(0);
  }

  update(dt: number): void {
    if (this.t < 0) return;
    this.t += dt;
    const { rise, hold, fall } = this;
    let o: number;
    if (this.t < rise) o = this.t / Math.max(1e-3, rise);
    else if (this.t < rise + hold) o = 1;
    else o = 1 - (this.t - rise - hold) / Math.max(1e-3, fall);
    if (this.t > rise + hold + fall) {
      this.t = -1;
      o = 0;
    }
    this.set(o);
  }

  private set(o: number): void {
    if (!this.el) return;
    const q = Math.round(clamp(o, 0, 1) * 100) / 100;
    if (q === this.shown) return;
    this.shown = q;
    this.el.style.opacity = String(q);
    this.el.style.display = q <= 0 ? 'none' : 'block';
  }

  dispose(): void {
    this.el?.remove();
    this.el = null;
  }
}
