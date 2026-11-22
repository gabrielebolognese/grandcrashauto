import { CONFIG } from '../config';
import { approach, clamp } from './math';

/**
 * One input layer (spec §14): keyboard, gamepad and touch all map into the same actions. Owner: core.
 *  - Continuous actions are read from `input.state` (merged every frame).
 *  - One-shot actions (explode, reset, camera, pause, flip, lookBack toggles) are queued with press() and read with consume().
 *  - Touch UI writes its continuous values into `input.touch` and calls `input.press(...)` for buttons.
 */

export type TriggerAction = 'explode' | 'reset' | 'camera' | 'pause' | 'flip' | 'fullscreen';
export type InputDevice = 'keyboard' | 'touch' | 'gamepad';

export interface ControlState {
  throttle: number; // 0..1
  brake: number; // 0..1 (brake, and reverse when stopped — vehicle decides)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
  horn: boolean;
  lookBack: boolean;
}

const zero = (): ControlState => ({ throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false, lookBack: false });

export class Input {
  /** Merged result, read by the vehicle/camera. */
  readonly state: ControlState = zero();
  /** Written by the touch controls UI every frame/touch event. */
  readonly touch: ControlState = zero();
  /** Steering sensitivity multiplier (settings). */
  sensitivity = 1;
  /** When false, state reads as zero (menus, garage). Triggers still queue. */
  enabled = true;
  lastDevice: InputDevice = 'keyboard';

  private keys = new Set<string>();
  private triggers = new Set<TriggerAction>();
  private keySteer = 0;
  private pad: ControlState = zero();
  private padPrev: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('touchstart', () => (this.lastDevice = 'touch'), { passive: true, capture: true });
  }

  press(a: TriggerAction): void {
    this.triggers.add(a);
  }

  consume(a: TriggerAction): boolean {
    return this.triggers.delete(a);
  }

  clearTriggers(): void {
    this.triggers.clear();
  }

  isKeyDown(code: string): boolean {
    return this.keys.has(code);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    this.lastDevice = 'keyboard';
    if (down && !e.repeat) {
      switch (e.code) {
        case 'KeyX': this.press('explode'); break;
        case 'KeyR': this.press('reset'); break;
        case 'KeyC': this.press('camera'); break;
        case 'KeyF': this.press('flip'); break;
        case 'Escape': case 'KeyP': this.press('pause'); break;
      }
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  }

  /** Called once per rendered frame by the game. */
  update(dt: number): void {
    const k = this.keys;
    const kThrottle = k.has('KeyW') || k.has('ArrowUp') ? 1 : 0;
    const kBrake = k.has('KeyS') || k.has('ArrowDown') ? 1 : 0;
    const kSteerTarget = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const rate = kSteerTarget === 0 || Math.sign(kSteerTarget) !== Math.sign(this.keySteer) ? CONFIG.input.keySteerReturn : CONFIG.input.keySteerRate;
    this.keySteer = approach(this.keySteer, kSteerTarget, rate * dt);

    this.pollGamepad();

    const s = this.state;
    const t = this.touch;
    const p = this.pad;
    if (!this.enabled) {
      Object.assign(s, zero());
      return;
    }
    s.throttle = Math.max(kThrottle, t.throttle, p.throttle);
    s.brake = Math.max(kBrake, t.brake, p.brake);
    const steer = Math.abs(p.steer) > Math.abs(this.keySteer) ? p.steer : this.keySteer;
    const steerAll = Math.abs(t.steer) > Math.abs(steer) ? t.steer : steer;
    s.steer = clamp(steerAll * this.sensitivity, -1, 1);
    s.handbrake = k.has('Space') || t.handbrake || p.handbrake;
    s.horn = k.has('KeyH') || t.horn || p.horn;
    s.lookBack = k.has('KeyQ') || k.has('KeyB') || t.lookBack || p.lookBack;
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const g of pads) if (g && g.connected) { gp = g; break; }
    const p = this.pad;
    if (!gp) {
      Object.assign(p, zero());
      return;
    }
    const dz = CONFIG.input.gamepadDeadzone;
    const btn = (i: number) => gp!.buttons[i]?.pressed ?? false;
    const val = (i: number) => gp!.buttons[i]?.value ?? 0;
    let sx = gp.axes[0] ?? 0;
    sx = Math.abs(sx) < dz ? 0 : (sx - Math.sign(sx) * dz) / (1 - dz);
    p.steer = clamp(sx, -1, 1);
    p.throttle = Math.max(val(7), btn(0) ? 1 : 0); // RT or A
    p.brake = val(6); // LT
    p.handbrake = btn(2) || btn(5); // X/Square or RB
    p.horn = btn(10); // L3
    p.lookBack = btn(4); // LB
    const edges: [number, TriggerAction][] = [[3, 'explode'], [8, 'reset'], [11, 'camera'], [9, 'pause'], [12, 'flip']];
    for (const [i, a] of edges) {
      const now = btn(i);
      if (now && !this.padPrev[i]) this.press(a);
      this.padPrev[i] = now;
    }
    // B (1) = reset as well (common layout); Y (3) = explode; R3 (11) = camera; D-pad up (12) = flip; Start (9) = pause.
    const b = btn(1);
    if (b && !this.padPrev[1]) this.press('reset');
    this.padPrev[1] = b;
    if (p.throttle || p.brake || p.steer || p.handbrake) this.lastDevice = 'gamepad';
  }
}
