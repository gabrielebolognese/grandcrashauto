import { isEditable } from './dom';
import type { Screen } from './host';

const FOCUSABLE = 'button:not([disabled]), [role="slider"], [tabindex="0"]';
type Dir = 'up' | 'down' | 'left' | 'right';

/**
 * Keyboard + gamepad navigation for menus: arrows / D-pad / left stick move focus geometrically,
 * Enter / Space / A activate, Escape / Backspace / B go back. Runs in the capture phase so menu keys never
 * reach the driving input layer.
 */
export class MenuNav {
  private scope: Screen | null = null;
  private padPrev: boolean[] = [];
  private heldDir: Dir | null = null;
  private repeatT = 0;
  /** Set when the last menu interaction came from keyboard/gamepad (show focus ring, autofocus). */
  keyboardMode = false;

  constructor() {
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('pointerdown', () => (this.keyboardMode = false), true);
  }

  setScope(s: Screen | null): void {
    if (s === this.scope) return;
    this.scope = s;
    if (s && this.keyboardMode) requestAnimationFrame(() => this.focusFirst());
  }

  private focusables(): HTMLElement[] {
    const root = this.scope?.el;
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null && el.getClientRects().length > 0);
  }

  private focusFirst(): void {
    const list = this.focusables();
    const primary = list.find((el) => el.classList.contains('btn-primary')) ?? list[0];
    primary?.focus({ preventScroll: true });
  }

  private current(): HTMLElement | null {
    const a = document.activeElement as HTMLElement | null;
    return a && this.scope?.el.contains(a) ? a : null;
  }

  private move(dir: Dir): void {
    const cur = this.current();
    const list = this.focusables();
    if (!cur) {
      this.focusFirst();
      return;
    }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const q = el.getBoundingClientRect();
      const x = q.left + q.width / 2 - cx;
      const y = q.top + q.height / 2 - cy;
      const main = dir === 'up' ? -y : dir === 'down' ? y : dir === 'left' ? -x : x;
      const cross = dir === 'up' || dir === 'down' ? Math.abs(x) : Math.abs(y);
      if (main <= 4) continue;
      const score = main + cross * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus({ preventScroll: true });
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private activate(): void {
    const cur = this.current();
    if (!cur) {
      this.focusFirst();
      return;
    }
    if (cur.getAttribute('role') === 'slider') return;
    cur.click();
  }

  private onKey = (e: KeyboardEvent): void => {
    const s = this.scope;
    if (!s || isEditable(e.target)) return;
    const stop = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const cur = this.current();
    const onSlider = cur?.getAttribute('role') === 'slider';
    switch (e.key) {
      case 'Escape':
      case 'Backspace':
        if (s.back?.()) stop();
        break;
      case 'ArrowUp':
      case 'ArrowDown':
        this.keyboardMode = true;
        this.move(e.key === 'ArrowUp' ? 'up' : 'down');
        stop();
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        this.keyboardMode = true;
        if (onSlider) return; // the slider handles its own arrows
        this.move(e.key === 'ArrowLeft' ? 'left' : 'right');
        stop();
        break;
      case 'Tab':
        this.keyboardMode = true;
        break;
      case 'Enter':
      case ' ':
        this.keyboardMode = true;
        if (e.repeat) {
          stop();
          break;
        }
        this.activate();
        stop();
        break;
    }
  };

  /** Gamepad polling for menus (call every frame). */
  update(dt: number): void {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const g of pads) if (g && g.connected) {
      gp = g;
      break;
    }
    if (!gp || !this.scope) {
      this.padPrev = [];
      this.heldDir = null;
      return;
    }
    const btn = (i: number) => gp!.buttons[i]?.pressed ?? false;
    const ax = gp.axes[0] ?? 0;
    const ay = gp.axes[1] ?? 0;
    const dir: Dir | null = btn(12) || ay < -0.55 ? 'up' : btn(13) || ay > 0.55 ? 'down' : btn(14) || ax < -0.55 ? 'left' : btn(15) || ax > 0.55 ? 'right' : null;
    if (dir !== this.heldDir) {
      this.heldDir = dir;
      this.repeatT = 0.38;
      if (dir) this.padDir(dir);
    } else if (dir) {
      this.repeatT -= dt;
      if (this.repeatT <= 0) {
        this.repeatT = 0.12;
        this.padDir(dir);
      }
    }
    const edge = (i: number) => {
      const now = btn(i);
      const was = this.padPrev[i] ?? true; // treat as held on the first poll after a scope change
      this.padPrev[i] = now;
      return now && !was;
    };
    if (edge(0)) {
      this.keyboardMode = true;
      this.activate();
    }
    if (edge(1)) this.scope?.back?.();
  }

  private padDir(dir: Dir): void {
    this.keyboardMode = true;
    const cur = this.current();
    if (cur?.getAttribute('role') === 'slider' && (dir === 'left' || dir === 'right')) {
      (cur as HTMLElement & { __slider?: { nudge(d: number): void } }).__slider?.nudge(dir === 'left' ? -1 : 1);
      return;
    }
    this.move(dir);
  }
}
