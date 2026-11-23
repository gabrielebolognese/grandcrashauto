import './walk.css';
import { CONFIG } from '../../config';
import { clamp } from '../../core/math';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { uiSound } from '../widgets';

/**
 * On-foot controls (walking in a plane cabin, falling, on the ground). Everywhere: a full-screen look surface (drag to
 * look; with a mouse, click to lock the pointer for FPS look) and the action buttons — GRAB (hold a seat), JUMP, VIEW
 * (1st / 3rd person), WINDOW (sit in a window seat), PILOT (take the controls back), STEP OUT, FLY AGAIN, CAR.
 * Touch adds a floating move joystick on the left. Desktop shows a key hint line.
 * Writes ctx.input.touch.{moveX, moveY, run, jump, grab} and input.addLook().
 */
export class WalkControls {
  readonly el: HTMLDivElement;
  private look: HTMLDivElement;
  private zone: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private hint: HTMLDivElement;
  private btnGrab: HTMLButtonElement;
  private btnJump: HTMLButtonElement;
  private btnView: HTMLButtonElement;
  private btnWindow: HTMLButtonElement;
  private btnPilot: HTMLButtonElement;
  private btnOut: HTMLButtonElement;
  private btnFly: HTMLButtonElement;
  private btnCar: HTMLButtonElement;
  private visible = false;
  private stickPtr: number | null = null;
  private lookPtr: number | null = null;
  private lx = 0;
  private ly = 0;
  private cx = 0;
  private cy = 0;
  private holdGrab = false;
  private holdJump = false;

  constructor(private host: UIHost) {
    const { ctx } = host;
    this.look = h('div', { class: 'wk-look' });
    this.knob = h('div', { class: 'wk-knob' });
    this.base = h('div', { class: 'wk-base' }, this.knob);
    this.zone = h('div', { class: 'wk-zone touch-ctl', 'aria-label': 'Walk' }, this.base);
    const btn = (label: string, cls: string, key: string) =>
      h('button', { class: `wk-btn ${cls}`, type: 'button' }, h('span', { text: label }), key ? h('kbd', { text: key }) : null);
    this.btnGrab = btn('✋ GRAB', 'wk-grab', 'E');
    this.btnJump = btn('JUMP', 'wk-jump', 'Space');
    this.btnView = btn('👁 VIEW', 'wk-view', 'C');
    this.btnWindow = btn('🪟 WINDOW', 'wk-window', 'Q');
    this.btnPilot = btn('✈ TAKE CONTROLS', 'wk-pilot', 'F');
    this.btnOut = btn('🚪 STEP OUT', 'wk-out', 'F');
    this.btnFly = btn('✈ FLY AGAIN', 'wk-fly', '');
    this.btnCar = btn('🚗 CAR', 'wk-car', '');
    this.hint = h('div', { class: 'wk-hint', text: 'WASD walk · Shift run · Space jump · hold E grab a seat · Q window seat · C view · F pilot · click to look' });
    this.el = h(
      'div',
      { class: 'walk-layer', 'aria-hidden': 'true' },
      this.look,
      this.zone,
      h('div', { class: 'wk-actions' }, this.btnWindow, this.btnView, this.btnJump, this.btnGrab),
      h('div', { class: 'wk-context' }, this.btnPilot, this.btnOut, this.btnFly, this.btnCar),
      this.hint,
    );

    // look surface: drag to look; mouse click → pointer lock
    this.look.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') {
        try {
          (ctx.engine.renderer.domElement as HTMLCanvasElement).requestPointerLock?.();
        } catch {
          /* unsupported */
        }
        return;
      }
      if (this.lookPtr !== null) return;
      this.lookPtr = e.pointerId;
      this.lx = e.clientX;
      this.ly = e.clientY;
      this.look.setPointerCapture?.(e.pointerId);
    });
    this.look.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookPtr) return;
      const k = CONFIG.walk.touchLook;
      ctx.input.addLook((e.clientX - this.lx) * k, (e.clientY - this.ly) * k);
      this.lx = e.clientX;
      this.ly = e.clientY;
    });
    const endLook = (e: PointerEvent) => {
      if (e.pointerId === this.lookPtr) this.lookPtr = null;
    };
    this.look.addEventListener('pointerup', endLook);
    this.look.addEventListener('pointercancel', endLook);

    // joystick (touch)
    this.zone.addEventListener('pointerdown', (e) => {
      if (this.stickPtr !== null) return;
      e.preventDefault();
      this.stickPtr = e.pointerId;
      const r = this.zone.getBoundingClientRect();
      this.cx = clamp(e.clientX, r.left + 60, r.right - 60);
      this.cy = clamp(e.clientY, r.top + 60, r.bottom - 60);
      this.base.style.left = `${this.cx - r.left}px`;
      this.base.style.top = `${this.cy - r.top}px`;
      this.base.classList.add('on');
      this.zone.setPointerCapture?.(e.pointerId);
      this.moveStick(e.clientX, e.clientY);
    });
    this.zone.addEventListener('pointermove', (e) => e.pointerId === this.stickPtr && this.moveStick(e.clientX, e.clientY));
    const endStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPtr) return;
      this.stickPtr = null;
      this.base.classList.remove('on');
      this.knob.style.transform = '';
      ctx.input.touch.moveX = 0;
      ctx.input.touch.moveY = 0;
      ctx.input.touch.run = false;
    };
    this.zone.addEventListener('pointerup', endStick);
    this.zone.addEventListener('pointercancel', endStick);

    // hold buttons
    const hold = (b: HTMLButtonElement, set: (on: boolean) => void) => {
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.setPointerCapture?.(e.pointerId);
        b.classList.add('down');
        set(true);
        host.vibrate(10);
      });
      const up = () => {
        b.classList.remove('down');
        set(false);
      };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    };
    hold(this.btnGrab, (on) => (this.holdGrab = on));
    hold(this.btnJump, (on) => (this.holdJump = on));
    const tap = (b: HTMLButtonElement, fn: () => void) =>
      b.addEventListener('click', () => {
        uiSound('click');
        fn();
      });
    tap(this.btnView, () => ctx.walker.toggleView());
    tap(this.btnWindow, () => ctx.walker.lookOutWindow());
    tap(this.btnPilot, () => ctx.walker.interact());
    tap(this.btnOut, () => ctx.walker.interact());
    tap(this.btnFly, () => ctx.walker.flyAgain());
    tap(this.btnCar, () => ctx.planes.backToCar());
    window.addEventListener('blur', () => this.releaseAll());
  }

  private moveStick(x: number, y: number): void {
    const R = 52;
    let dx = x - this.cx, dy = y - this.cy;
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx *= R / d;
      dy *= R / d;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const t = this.host.ctx.input.touch;
    t.moveX = dx / R;
    t.moveY = -dy / R;
    t.run = d > R * 1.25;
  }

  releaseAll(): void {
    const t = this.host.ctx.input.touch;
    t.moveX = t.moveY = 0;
    t.run = t.jump = t.grab = false;
    this.holdGrab = this.holdJump = false;
    this.stickPtr = this.lookPtr = null;
    this.base.classList.remove('on');
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    setVisible(this.el, on);
    if (!on) {
      this.releaseAll();
      try {
        if (document.pointerLockElement) document.exitPointerLock();
      } catch {
        /* ignore */
      }
    }
  }

  update(): void {
    if (!this.visible) return;
    const { ctx } = this.host;
    const w = ctx.walker;
    const t = ctx.input.touch;
    t.grab = this.holdGrab;
    t.jump = this.holdJump;
    const touch = this.host.touchMode();
    this.el.classList.toggle('touch', touch);
    const cabin = w.mode === 'cabin';
    const ground = w.mode === 'ground';
    setVisible(this.zone, touch);
    setVisible(this.hint, !touch && cabin);
    setVisible(this.btnGrab, cabin);
    setVisible(this.btnWindow, cabin);
    setVisible(this.btnJump, cabin || ground);
    setVisible(this.btnPilot, w.canTakeControls);
    setVisible(this.btnOut, !w.canTakeControls && w.canStepOut);
    setVisible(this.btnFly, ground || w.mode === 'fall');
    setVisible(this.btnCar, ground);
    this.btnGrab.classList.toggle('active', w.seated);
    setText(this.btnView.querySelector('span')!, w.firstPerson ? '👁 1ST' : '👁 3RD');
  }
}
