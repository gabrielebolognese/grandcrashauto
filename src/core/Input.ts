import { CONFIG } from '../config';
import { approach, clamp } from './math';

/**
 * One input layer (spec §14): keyboard, gamepad and touch all map into the same actions. Owner: core.
 *  - Continuous actions are read from `input.state` (merged every frame).
 *  - One-shot actions are queued with press() and read with consume().
 *  - Touch UI writes its continuous values into `input.touch` and calls `input.press(...)` for buttons.
 *  - `mode` ('car' | 'plane') decides how keys are interpreted (set by Game.setMode). In plane mode the car fields
 *    read as zero (+ handbrake on, so the parked car stays put) and the flight fields are filled; in car mode the
 *    flight fields read as zero.
 *
 * Keyboard — car: WASD/arrows drive, Space handbrake, H horn, C camera, X explode, R reset, Q/B look back,
 *   F interact (board plane / flip car), N map, Esc/P pause.
 * Keyboard — plane (SPEC-PART2 §6): W/S pitch (W = nose down), A/D bank, Q/E rudder, Shift/Ctrl (or =/-, PgUp/PgDn)
 *   throttle up/down, B or Space brakes, G gear, 1–4 engine explode, X explode, M explode middle, T explode tail,
 *   C camera, R reset, F board/exit, N map, Enter skip sequence.
 */

export type TriggerAction =
  | 'explode' | 'reset' | 'camera' | 'pause' | 'flip' | 'fullscreen'
  | 'interact' | 'map' | 'gear' | 'engine1' | 'engine2' | 'engine3' | 'engine4' | 'explodeMiddle' | 'explodeTail' | 'skip'
  | 'barrelLeft' | 'barrelRight' | 'lights' | 'switchTarget' | 'window';
export type InputDevice = 'keyboard' | 'touch' | 'gamepad';
export type InputMode = 'car' | 'plane';

export interface ControlState {
  // car
  throttle: number; // 0..1
  brake: number; // 0..1 (brake, and reverse when stopped — vehicle decides)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
  horn: boolean;
  lookBack: boolean;
  turbo: boolean; // part 3: hold to boost (Shift; gamepad A/Cross; touch TURBO button)
  // plane
  pitch: number; // -1..1, +1 = pull (nose up)
  roll: number; // -1..1, +1 = bank right
  yaw: number; // -1..1 rudder, +1 = nose right
  throttleAxis: number; // -1..1 throttle change rate request (keys/gamepad triggers)
  throttleSet: number; // 0..1 absolute throttle from the touch slider, or -1 when not set
  planeBrake: boolean;
  // on foot (walking in a plane cabin / on the ground): Input.walking
  moveX: number; // -1..1 strafe right +
  moveY: number; // -1..1 forward +
  run: boolean;
  jump: boolean;
  grab: boolean; // hold: grab / sit in the nearest seat
  lookX: number; // look delta this frame (px-equivalent), + = turn right
  lookY: number; // + = look down
}

const zero = (): ControlState => ({
  throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false, lookBack: false, turbo: false,
  pitch: 0, roll: 0, yaw: 0, throttleAxis: 0, throttleSet: -1, planeBrake: false,
  moveX: 0, moveY: 0, run: false, jump: false, grab: false, lookX: 0, lookY: 0,
});

export class Input {
  /** Merged result, read by the vehicle / plane / camera. */
  readonly state: ControlState = zero();
  /** Written by the touch controls UI. */
  readonly touch: ControlState = zero();
  /** Steering sensitivity multiplier (settings). */
  sensitivity = 1;
  /** Invert flight pitch (settings.invertPitch). */
  invertPitch = false;
  /** When false, state reads as zero (menus, garage). Triggers still queue. */
  enabled = true;
  mode: InputMode = 'car';
  /** Plane mode, on foot (set by Game while the walker is active): flight fields read zero, walk fields filled. */
  walking = false;
  /** Agent mode (?agent): latched holds / autopilot values that override the merged state (only the keys present). */
  agentOverride: Partial<ControlState> | null = null;
  private lookAccX = 0;
  private lookAccY = 0;
  lastDevice: InputDevice = 'keyboard';

  private keys = new Set<string>();
  private triggers = new Set<TriggerAction>();
  private keySteer = 0;
  private keyRoll = 0;
  private keyPitch = 0;
  private pad: ControlState = zero();
  private padPrev: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('touchstart', () => (this.lastDevice = 'touch'), { passive: true, capture: true });
    // mouse look while walking (pointer locked by the walk controls)
    document.addEventListener('mousemove', (e) => {
      if (this.walking && document.pointerLockElement) this.addLook(e.movementX, e.movementY);
    });
  }

  /** Look deltas (pixels) from the mouse / touch look surface; consumed once per frame into state.lookX/Y. */
  addLook(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.lookAccX += dx;
    this.lookAccY += dy;
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
      const plane = this.mode === 'plane';
      switch (e.code) {
        case 'KeyX': this.press('explode'); break;
        case 'KeyR': this.press('reset'); break;
        case 'KeyC': this.press('camera'); break;
        case 'KeyF': this.press('interact'); break;
        case 'KeyN': case 'Tab': this.press('map'); break;
        case 'Escape': case 'KeyP': this.press('pause'); break;
        case 'KeyG': if (plane) this.press('gear'); break;
        case 'KeyM': if (plane) this.press('explodeMiddle'); break;
        case 'KeyT': if (plane) this.press('explodeTail'); break;
        case 'Digit1': case 'Numpad1': if (plane) this.press('engine1'); break;
        case 'Digit2': case 'Numpad2': if (plane) this.press('engine2'); break;
        case 'Digit3': case 'Numpad3': if (plane) this.press('engine3'); break;
        case 'Digit4': case 'Numpad4': if (plane) this.press('engine4'); break;
        case 'Enter': this.press('skip'); break;
        case 'KeyQ': if (!plane) this.press('barrelLeft'); else if (this.walking) this.press('window'); break;
        case 'KeyE': if (!plane) this.press('barrelRight'); break;
        case 'KeyL': if (!plane) this.press('lights'); break;
        case 'KeyV': if (plane) this.press('switchTarget'); break;
      }
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown'].includes(e.code)) e.preventDefault();
    // Block browser shortcuts that fight flight controls (Ctrl+S/D/A…). Ctrl+W can't be blocked: =/- also work.
    if (this.mode === 'plane' && (e.ctrlKey || e.metaKey) && e.code !== 'KeyW') e.preventDefault();
  }

  /** Called once per rendered frame by the game. */
  update(dt: number): void {
    this.merge(dt);
    if (this.enabled && this.agentOverride) Object.assign(this.state, this.agentOverride);
  }

  private merge(dt: number): void {
    const k = this.keys;
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const left = k.has('KeyA') || k.has('ArrowLeft');

    // Car: keyboard steering ramps toward full lock and returns to centre.
    const kSteerTarget = (right ? 1 : 0) - (left ? 1 : 0);
    const rate = kSteerTarget === 0 || Math.sign(kSteerTarget) !== Math.sign(this.keySteer) ? CONFIG.input.keySteerReturn : CONFIG.input.keySteerRate;
    this.keySteer = approach(this.keySteer, kSteerTarget, rate * dt);
    // Plane: smoothed digital stick.
    this.keyRoll = approach(this.keyRoll, kSteerTarget, (kSteerTarget === 0 ? 5 : 3) * dt);
    const kPitchTarget = (down ? 1 : 0) - (up ? 1 : 0); // S = pull (nose up), W = push
    this.keyPitch = approach(this.keyPitch, kPitchTarget, (kPitchTarget === 0 ? 5 : 3) * dt);

    this.pollGamepad();

    const s = this.state;
    const t = this.touch;
    const p = this.pad;
    if (!this.enabled) {
      Object.assign(s, zero());
      return;
    }
    const pick = (...v: number[]) => v.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    // look (consumed every frame, even when idle)
    s.lookX = this.lookAccX + t.lookX + p.lookX * dt * 900;
    s.lookY = this.lookAccY + t.lookY + p.lookY * dt * 700;
    this.lookAccX = this.lookAccY = 0;
    t.lookX = t.lookY = 0;
    if (this.mode === 'plane' && this.walking) {
      s.throttle = s.brake = s.steer = 0;
      s.handbrake = true;
      s.horn = s.lookBack = s.turbo = false;
      s.pitch = s.roll = s.yaw = s.throttleAxis = 0;
      s.throttleSet = -1;
      s.planeBrake = false;
      const kx = (right ? 1 : 0) - (left ? 1 : 0);
      const ky = (up ? 1 : 0) - (down ? 1 : 0);
      s.moveX = clamp(pick(kx, p.moveX, t.moveX), -1, 1);
      s.moveY = clamp(pick(ky, p.moveY, t.moveY), -1, 1);
      s.run = k.has('ShiftLeft') || k.has('ShiftRight') || t.run || p.run;
      s.jump = k.has('Space') || t.jump || p.jump;
      s.grab = k.has('KeyE') || t.grab || p.grab;
      return;
    }
    s.moveX = s.moveY = 0;
    s.run = s.jump = s.grab = false;

    if (this.mode === 'car') {
      s.throttle = Math.max(up ? 1 : 0, t.throttle, p.throttle);
      s.brake = Math.max(down ? 1 : 0, t.brake, p.brake);
      s.steer = clamp(pick(this.keySteer, p.steer, t.steer) * this.sensitivity, -1, 1);
      s.handbrake = k.has('Space') || t.handbrake || p.handbrake;
      s.horn = k.has('KeyH') || t.horn || p.horn;
      s.lookBack = k.has('KeyB') || t.lookBack || p.lookBack;
      s.turbo = k.has('ShiftLeft') || k.has('ShiftRight') || t.turbo || p.turbo;
      s.pitch = s.roll = s.yaw = s.throttleAxis = 0;
      s.throttleSet = -1;
      s.planeBrake = false;
    } else {
      s.throttle = 0;
      s.brake = 0;
      s.steer = 0;
      s.handbrake = true; // the parked car holds still while the player flies
      s.horn = false;
      s.lookBack = false;
      s.turbo = false;
      const inv = this.invertPitch ? -1 : 1;
      s.pitch = clamp(pick(this.keyPitch * inv, p.pitch * inv, t.pitch), -1, 1);
      s.roll = clamp(pick(this.keyRoll, p.roll, t.roll) * this.sensitivity, -1, 1);
      s.yaw = clamp(pick((k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0), p.yaw, t.yaw), -1, 1);
      const kThr =
        (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Equal') || k.has('NumpadAdd') || k.has('PageUp') ? 1 : 0) -
        (k.has('ControlLeft') || k.has('ControlRight') || k.has('Minus') || k.has('NumpadSubtract') || k.has('PageDown') ? 1 : 0);
      s.throttleAxis = clamp(pick(kThr, p.throttleAxis, t.throttleAxis), -1, 1);
      s.throttleSet = t.throttleSet;
      s.planeBrake = k.has('KeyB') || k.has('Space') || t.planeBrake || p.planeBrake;
    }
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
    const axis = (i: number) => {
      const v = gp!.axes[i] ?? 0;
      return Math.abs(v) < dz ? 0 : clamp((v - Math.sign(v) * dz) / (1 - dz), -1, 1);
    };
    const plane = this.mode === 'plane';
    // car
    p.steer = axis(0);
    p.throttle = val(7); // RT
    p.brake = val(6); // LT
    p.turbo = !plane && btn(0); // A / Cross (part 3)
    p.handbrake = !plane && btn(2); // X / Square
    p.horn = !plane && btn(10); // L3
    p.lookBack = !plane && btn(13); // D-pad down
    // plane: left stick = pitch/bank, triggers = throttle, bumpers = rudder, A = brakes
    p.roll = axis(0);
    p.pitch = axis(1); // stick pulled back (+Y) = nose up
    p.yaw = (btn(5) ? 1 : 0) - (btn(4) ? 1 : 0);
    p.throttleAxis = val(7) - val(6);
    p.planeBrake = plane && btn(0);
    // on foot: left stick walk, right stick look, A jump, RB grab, L3 run
    p.moveX = axis(0);
    p.moveY = -axis(1);
    p.lookX = axis(2);
    p.lookY = axis(3);
    p.jump = this.walking && btn(0);
    p.grab = this.walking && (btn(5) || btn(1));
    p.run = this.walking && btn(10);

    const edges: [number, TriggerAction][] = plane && this.walking
      ? [[3, 'camera'], [9, 'pause'], [2, 'interact'], [4, 'window'], [8, 'reset']]
      : plane
      ? [[3, 'explode'], [1, 'reset'], [8, 'reset'], [11, 'camera'], [9, 'pause'], [2, 'gear'], [10, 'interact'],
         [14, 'engine1'], [12, 'engine2'], [13, 'engine3'], [15, 'engine4']]
      : [[3, 'explode'], [1, 'reset'], [8, 'reset'], [11, 'camera'], [9, 'pause'], [12, 'interact'], [4, 'barrelLeft'], [5, 'barrelRight'], [14, 'lights']];
    for (const [i, a] of edges) {
      const now = btn(i);
      if (now && !this.padPrev[i]) this.press(a);
    }
    for (let i = 0; i < gp.buttons.length; i++) this.padPrev[i] = btn(i);
    if (p.throttle || p.brake || p.steer || p.handbrake || p.pitch || p.throttleAxis) this.lastDevice = 'gamepad';
  }
}
