import { clamp } from '../../core/math';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { icon } from '../icons';
import { uiSound } from '../widgets';

const IDLE_DETENT = 0.06; // throttle below this snaps to 0 (idle)
const HOLD_AFTER_MS = 400; // keep throttleSet after release so the plane latches it

/**
 * Flight touch controls (SPEC-PART2 §6): floating stick on the left (up/down pitch honouring settings.invertPitch,
 * left/right bank + nose-wheel steering; optional tilt-to-bank), vertical throttle slider 0–100 % with an idle
 * detent, BRAKE (hold) and GEAR (tap) on the right. Writes ctx.input.touch.{pitch, roll, throttleSet, planeBrake}.
 */
export class FlightControls {
  readonly el: HTMLDivElement;
  private zone: HTMLDivElement;
  private base: HTMLDivElement;
  private knob: HTMLDivElement;
  private thrTrack: HTMLDivElement;
  private thrFill: HTMLDivElement;
  private thrKnob: HTMLDivElement;
  private thrLabel: HTMLSpanElement;
  private brake: HTMLDivElement;
  private gear: HTMLDivElement;
  private gearLabel: HTMLSpanElement;
  private visible = false;
  private stickPtr: number | null = null;
  private cx = 0;
  private cy = 0;
  private stickX = 0;
  private stickY = 0;
  private thrPtr: number | null = null;
  private thrValue = 0;
  private thrReleaseAt = 0;
  private brakePtr: number | null = null;
  private lastGear = '';

  constructor(private host: UIHost) {
    this.knob = h('div', { class: 'fs-knob' }, icon('plane'));
    this.base = h('div', { class: 'fs-base fade-ctl' }, h('i', { class: 'fs-cross' }), h('span', { class: 'fs-lbl up' }), h('span', { class: 'fs-lbl down' }), this.knob);
    this.zone = h('div', { class: 'fs-zone touch-ctl', 'aria-label': 'Flight stick' }, this.base);
    this.thrFill = h('div', { class: 'ft-fill' });
    this.thrLabel = h('span', { class: 'ft-val', text: '0%' });
    this.thrKnob = h('div', { class: 'ft-knob' }, this.thrLabel);
    this.thrTrack = h('div', { class: 'ft-track touch-ctl fade-ctl', 'aria-label': 'Throttle' }, this.thrFill, h('i', { class: 'ft-detent' }), h('span', { class: 'ft-idle', text: 'IDLE' }), h('span', { class: 'ft-max', text: 'MAX' }), this.thrKnob);
    this.brake = h('div', { class: 'fc-btn fc-brake touch-ctl fade-ctl', role: 'button', 'aria-label': 'Brake' }, icon('brakeDisc'), h('span', { text: 'Brake' }));
    this.gearLabel = h('span', { text: 'Gear ▼' });
    this.gear = h('div', { class: 'fc-btn fc-gear touch-ctl fade-ctl', role: 'button', 'aria-label': 'Landing gear' }, icon('gear'), this.gearLabel);
    // User request: only the stick (left) and the throttle (right); gear and brakes are automatic in the plane system.
    this.el = h('div', { class: 'touch-layer flight', 'aria-hidden': 'true' }, this.zone, h('div', { class: 'fc-right' }, this.thrTrack));
    this.bindStick();
    this.bindThrottle();
    this.bindButtons();
    window.addEventListener('blur', () => this.releaseAll());
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    setVisible(this.el, on);
    if (!on) this.releaseAll();
    else if (this.host.ctx.settings.values.flightTilt) this.host.tilt.calibrate();
  }

  releaseAll(): void {
    this.stickPtr = null;
    this.thrPtr = null;
    this.brakePtr = null;
    this.stickX = this.stickY = 0;
    this.knob.style.transform = '';
    this.base.style.transform = '';
    this.base.classList.remove('active');
    this.brake.classList.remove('down');
    this.thrTrack.classList.remove('active');
    const t = this.host.ctx.input.touch;
    t.pitch = 0;
    t.roll = 0;
    t.yaw = 0;
    t.throttleSet = -1;
    t.planeBrake = false;
  }

  private capture(el: Element, id: number): void {
    try {
      el.setPointerCapture(id);
    } catch {
      /* ignore */
    }
  }

  private radius(): number {
    return 46 * this.host.ctx.settings.values.controlsScale;
  }

  private bindStick(): void {
    const z = this.zone;
    z.addEventListener('pointerdown', (e) => {
      if (this.stickPtr !== null) return;
      e.preventDefault();
      this.capture(z, e.pointerId);
      this.stickPtr = e.pointerId;
      // Float the base under the finger (rest centre from layout).
      const zr = z.getBoundingClientRect();
      const rx = zr.left + this.base.offsetLeft + this.base.offsetWidth / 2;
      const ry = zr.top + this.base.offsetTop + this.base.offsetHeight / 2;
      this.cx = e.clientX;
      this.cy = e.clientY;
      this.base.style.transform = `translate3d(${(this.cx - rx).toFixed(1)}px, ${(this.cy - ry).toFixed(1)}px, 0)`;
      this.base.classList.add('active');
      this.moveStick(e.clientX, e.clientY);
    });
    z.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.stickPtr) this.moveStick(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPtr) return;
      this.stickPtr = null;
      this.stickX = this.stickY = 0;
      this.knob.style.transform = '';
      this.base.style.transform = '';
      this.base.classList.remove('active');
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
    z.addEventListener('lostpointercapture', end);
  }

  private moveStick(x: number, y: number): void {
    const R = this.radius();
    let dx = x - this.cx;
    let dy = y - this.cy;
    const d = Math.hypot(dx, dy);
    if (d > R) {
      dx *= R / d;
      dy *= R / d;
    }
    this.knob.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
    const shape = (v: number) => {
      const a = Math.abs(v);
      return a < 0.05 ? 0 : Math.sign(v) * Math.pow((a - 0.05) / 0.95, 1.25);
    };
    this.stickX = shape(dx / R);
    this.stickY = shape(dy / R);
  }

  private bindThrottle(): void {
    const tr = this.thrTrack;
    const setFrom = (y: number) => {
      const r = tr.getBoundingClientRect();
      const pad = 14;
      let v = clamp(1 - (y - r.top - pad) / Math.max(1, r.height - pad * 2), 0, 1);
      if (v < IDLE_DETENT) v = 0;
      if (v > 0.97) v = 1;
      if ((this.thrValue === 0) !== (v === 0)) this.host.vibrate(8); // detent click
      this.thrValue = v;
      this.host.ctx.input.touch.throttleSet = v;
      this.renderThrottle(v);
    };
    tr.addEventListener('pointerdown', (e) => {
      if (this.thrPtr !== null) return;
      e.preventDefault();
      this.capture(tr, e.pointerId);
      this.thrPtr = e.pointerId;
      tr.classList.add('active');
      setFrom(e.clientY);
    });
    tr.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.thrPtr) setFrom(e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.thrPtr) return;
      this.thrPtr = null;
      tr.classList.remove('active');
      this.thrReleaseAt = performance.now();
    };
    tr.addEventListener('pointerup', end);
    tr.addEventListener('pointercancel', end);
    tr.addEventListener('lostpointercapture', end);
  }

  private renderThrottle(v: number): void {
    this.thrTrack.style.setProperty('--v', v.toFixed(3)); // fill height + knob position in CSS
    setText(this.thrLabel, v === 0 ? 'IDLE' : `${Math.round(v * 100)}%`);
    this.thrTrack.classList.toggle('idle', v === 0);
  }

  private bindButtons(): void {
    const b = this.brake;
    b.addEventListener('pointerdown', (e) => {
      if (this.brakePtr !== null) return;
      e.preventDefault();
      this.capture(b, e.pointerId);
      this.brakePtr = e.pointerId;
      b.classList.add('down');
      this.host.ctx.input.touch.planeBrake = true;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.brakePtr) return;
      this.brakePtr = null;
      b.classList.remove('down');
      this.host.ctx.input.touch.planeBrake = false;
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('lostpointercapture', end);
    this.gear.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      uiSound('toggle');
      this.gear.classList.add('down');
      window.setTimeout(() => this.gear.classList.remove('down'), 140);
      this.host.ctx.input.press('gear');
    });
  }

  update(dt: number): void {
    if (!this.visible) return;
    const { ctx } = this.host;
    const t = ctx.input.touch;
    const s = ctx.settings.values;
    // Default: stick pushed up = nose down (like a yoke); invertPitch → stick up = nose up.
    t.pitch = clamp(s.invertPitch ? -this.stickY : this.stickY, -1, 1);
    let roll = this.stickX;
    if (s.flightTilt) {
      const tilt = this.host.tilt;
      if (tilt.permission === 'unknown' && !tilt.needsPermission) void tilt.request();
      const tv = tilt.active ? tilt.update(dt) : 0;
      if (Math.abs(tv) > Math.abs(roll)) roll = tv;
    }
    t.roll = clamp(roll, -1, 1);
    // Throttle: only "set" while the finger is on the slider (+ a short hold so the plane latches it); otherwise
    // the knob follows the plane's commanded throttle (keyboard, respawn, assists…).
    const ps = ctx.planes?.state;
    if (this.thrPtr === null && performance.now() - this.thrReleaseAt > HOLD_AFTER_MS) {
      t.throttleSet = -1;
      const v = ps ? clamp(ps.throttle, 0, 1) : 0;
      if (Math.abs(v - this.thrValue) > 0.004) {
        this.thrValue = v;
        this.renderThrottle(v);
      }
    }
    setText(this.base.querySelector('.fs-lbl.up') as HTMLElement, s.invertPitch ? 'NOSE ▲' : 'NOSE ▼');
    setText(this.base.querySelector('.fs-lbl.down') as HTMLElement, s.invertPitch ? 'NOSE ▼' : 'NOSE ▲');
    if (ps) {
      const g = ps.gear > 0.98 ? 'Gear ▼' : ps.gear < 0.02 ? 'Gear ▲' : 'Gear …';
      if (g !== this.lastGear) {
        this.lastGear = g;
        setText(this.gearLabel, g);
        this.gear.classList.toggle('up', ps.gear < 0.02);
      }
      this.brake.classList.toggle('on', !!ps.brake && this.brakePtr === null);
    }
  }
}
