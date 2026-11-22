import { CONFIG } from '../../config';
import { approach, clamp } from '../../core/math';
import { h, setVisible } from '../dom';
import type { UIHost } from '../host';
import { icon } from '../icons';
import { uiSound } from '../widgets';

type PedalId = 'gas' | 'brake' | 'hand' | 'turbo';
type SteerMode = 'slider' | 'buttons' | 'tilt';

/**
 * Multi-touch driving controls (spec §9) built on Pointer Events. Each finger is tracked by pointerId with pointer
 * capture, so gas + steer + handbrake can be held together, and a thumb can slide between the right-hand pedals.
 * Writes continuous values into ctx.input.touch.
 */
export class TouchControls {
  readonly el: HTMLDivElement;
  private zone: HTMLDivElement;
  private slider: HTMLDivElement;
  private knob: HTMLDivElement;
  private btnL: HTMLDivElement;
  private btnR: HTMLDivElement;
  private tiltWheel: HTMLDivElement;
  private tiltPerm: HTMLButtonElement;
  private pedalEls: Record<PedalId, HTMLDivElement>;
  private pedalPtrs = new Map<number, PedalId>();
  private rects: [PedalId, DOMRect][] = [];

  private mode: SteerMode = 'slider';
  private visible = false;
  // slider
  private steerPtr: number | null = null;
  private x0 = 0;
  private offX = 0;
  private offY = 0;
  private restCX = 0;
  private restCY = 0;
  private sliderSteer = 0;
  // buttons
  private btnPtrs = new Map<number, -1 | 1>();
  private btnTarget = 0;
  private btnSteer = 0;
  private tiltFallbackToasted = false;
  private lastCharge = -1;

  constructor(private host: UIHost) {
    // ── steering zone ──
    this.knob = h('div', { class: 'ss-knob' }, icon('wheel'));
    this.slider = h(
      'div',
      { class: 'steer-slider fade-ctl' },
      h('div', { class: 'ss-track' }, h('i', { class: 'ss-chev l' }, icon('left')), h('i', { class: 'ss-mid' }), h('i', { class: 'ss-chev r' }, icon('right'))),
      this.knob,
    );
    this.btnL = h('div', { class: 'sb-btn l fade-ctl' }, icon('left'));
    this.btnR = h('div', { class: 'sb-btn r fade-ctl' }, icon('right'));
    this.tiltWheel = h('div', { class: 'st-wheel fade-ctl' }, icon('wheel'));
    const cal = h('button', { class: 'st-cal btn btn-sm btn-ghost', type: 'button' }, icon('reset'), h('span', { text: 'Centre' }));
    cal.addEventListener('click', () => {
      uiSound('click');
      host.tilt.calibrate();
      host.toast('Tilt centred');
    });
    this.tiltPerm = h('button', { class: 'st-perm btn btn-sm btn-primary', type: 'button' }, icon('phoneTilt'), h('span', { text: 'Enable tilt' }));
    this.tiltPerm.addEventListener('click', async () => {
      uiSound('confirm');
      const ok = await host.tilt.request();
      host.tilt.calibrate();
      if (!ok) host.toast('Motion access denied — using the slider');
      this.applyMode();
    });
    this.zone = h(
      'div',
      { class: 'steer-zone touch-ctl', 'aria-label': 'Steering' },
      this.slider,
      h('div', { class: 'steer-buttons' }, this.btnL, this.btnR),
      h('div', { class: 'steer-tilt' }, this.tiltWheel, h('div', { class: 'st-actions' }, cal, this.tiltPerm)),
    );

    // ── pedals ──
    const pedal = (id: PedalId, cls: string, ...kids: (Node | string)[]) => {
      const el = h('div', { class: `${id === 'turbo' ? '' : 'pedal '}${cls} touch-ctl fade-ctl`, 'data-id': id, role: 'button', 'aria-label': id }, ...kids);
      this.bindPedal(el, id);
      return el;
    };
    this.pedalEls = {
      hand: pedal('hand', 'p-hand', icon('handbrake'), h('span', { class: 'p-lbl', text: 'Handbrake' })),
      brake: pedal('brake', 'p-brake', h('span', { class: 'p-chev', text: '▼' }), h('span', { class: 'p-lbl', text: 'Brake' }), h('span', { class: 'p-sub', text: 'Reverse' })),
      gas: pedal('gas', 'p-gas', h('span', { class: 'p-chev', text: '▲' }), h('span', { class: 'p-lbl', text: 'Gas' })),
      turbo: pedal('turbo', 'turbo-btn no-turbo', h('span', { class: 'tbo-core' }, icon('flame'), h('span', { text: 'Turbo' }))),
    };
    const pedals = h(
      'div',
      { class: 'pedals' },
      h('div', { class: 'pedal-col' }, this.pedalEls.hand, this.pedalEls.brake),
      h('div', { class: 'gas-col' }, this.pedalEls.turbo, this.pedalEls.gas),
    );

    this.el = h('div', { class: 'touch-layer', 'aria-hidden': 'true' }, this.zone, pedals);
    this.bindSteer();
    window.addEventListener('orientationchange', () => this.releaseAll());
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => document.hidden && this.releaseAll());
  }

  // ─────────────────────────────── visibility & settings ───────────────────────────────
  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    setVisible(this.el, on);
    if (!on) this.releaseAll();
    else {
      this.applyMode();
      if (this.mode === 'tilt') this.host.tilt.calibrate();
    }
  }

  applyMode(): void {
    const s = this.host.ctx.settings.values;
    let mode: SteerMode = s.steeringMode;
    const tilt = this.host.tilt;
    if (mode === 'tilt') {
      if (!tilt.needsPermission && tilt.permission === 'unknown') void tilt.request();
      if (tilt.permission === 'denied' || tilt.permission === 'unsupported' || tilt.timedOut) mode = 'slider';
    }
    if (mode !== this.mode) this.releaseSteer();
    this.mode = mode;
    this.zone.dataset.mode = mode;
    this.tiltPerm.style.display = mode === 'tilt' && tilt.needsPermission ? '' : 'none';
    this.el.classList.toggle('lefty', s.leftHanded);
  }

  releaseAll(): void {
    this.releaseSteer();
    for (const id of [...this.pedalPtrs.keys()]) this.pedalPtrs.delete(id);
    this.applyPedals();
    const t = this.host.ctx.input.touch;
    t.throttle = 0;
    t.brake = 0;
    t.handbrake = false;
    t.turbo = false;
    t.steer = 0;
  }

  private releaseSteer(): void {
    this.steerPtr = null;
    this.sliderSteer = 0;
    this.btnPtrs.clear();
    this.btnTarget = 0;
    this.btnSteer = 0;
    this.host.ctx.input.touch.steer = 0;
    this.springBack();
    this.btnL.classList.remove('down');
    this.btnR.classList.remove('down');
  }

  // ─────────────────────────────── steering ───────────────────────────────
  private bindSteer(): void {
    const z = this.zone;
    z.addEventListener('pointerdown', (e) => {
      if (this.mode === 'tilt') return;
      if ((e.target as Element).closest('button')) return;
      e.preventDefault();
      if (this.mode === 'slider') {
        if (this.steerPtr !== null) return; // one steering finger at a time
        this.capture(z, e.pointerId);
        this.steerPtr = e.pointerId;
        this.slider.classList.add('active');
        // Float the slider so its centre sits under the finger (rest centre from layout, ignoring transforms).
        const zr = z.getBoundingClientRect();
        this.restCX = zr.left + this.slider.offsetLeft + this.slider.offsetWidth / 2;
        this.restCY = zr.top + this.slider.offsetTop + this.slider.offsetHeight / 2;
        this.x0 = e.clientX;
        this.offY = e.clientY - this.restCY;
        this.placeSlider();
        this.setSliderDx(0);
      } else {
        this.capture(z, e.pointerId);
        this.btnPtrs.set(e.pointerId, this.sideAt(e.clientX));
        this.updateBtnTarget();
      }
    });
    z.addEventListener('pointermove', (e) => {
      if (this.mode === 'slider') {
        if (e.pointerId !== this.steerPtr) return;
        const range = this.range();
        let dx = e.clientX - this.x0;
        // Floating origin: past full lock the origin follows the finger, so reversing responds instantly.
        if (dx > range) {
          this.x0 += dx - range;
          dx = range;
          this.placeSlider();
        } else if (dx < -range) {
          this.x0 += dx + range;
          dx = -range;
          this.placeSlider();
        }
        this.setSliderDx(dx);
      } else if (this.mode === 'buttons' && this.btnPtrs.has(e.pointerId)) {
        const side = this.sideAt(e.clientX);
        if (this.btnPtrs.get(e.pointerId) !== side) {
          this.btnPtrs.delete(e.pointerId); // re-insert so the most recent finger wins
          this.btnPtrs.set(e.pointerId, side);
          this.updateBtnTarget();
        }
      }
    });
    const end = (e: PointerEvent) => {
      if (this.mode === 'slider' && e.pointerId === this.steerPtr) {
        this.steerPtr = null;
        this.sliderSteer = 0;
        this.host.ctx.input.touch.steer = 0;
        this.springBack();
      } else if (this.btnPtrs.delete(e.pointerId)) {
        this.updateBtnTarget();
      }
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
    z.addEventListener('lostpointercapture', end);
  }

  private placeSlider(): void {
    this.offX = this.x0 - this.restCX;
    this.slider.style.transform = `translate3d(${this.offX.toFixed(1)}px, ${this.offY.toFixed(1)}px, 0)`;
  }

  private range(): number {
    return CONFIG.ui.steer.sliderRangePx * this.host.ctx.settings.values.controlsScale;
  }

  private setSliderDx(dx: number): void {
    const range = this.range();
    this.knob.style.transform = `translate3d(${dx.toFixed(1)}px, 0, 0)`;
    const c = CONFIG.ui.steer;
    const v = clamp(dx / range, -1, 1);
    const a = Math.abs(v);
    const s = a < c.deadzone ? 0 : Math.sign(v) * Math.pow((a - c.deadzone) / (1 - c.deadzone), c.expo);
    this.sliderSteer = s;
    this.host.ctx.input.touch.steer = s;
    this.slider.classList.toggle('left', s < -0.02);
    this.slider.classList.toggle('right', s > 0.02);
  }

  private springBack(): void {
    this.slider.classList.remove('active', 'left', 'right');
    this.knob.style.transform = '';
    this.slider.style.transform = '';
    this.offX = 0;
    this.offY = 0;
  }

  private sideAt(x: number): -1 | 1 {
    const l = this.btnL.getBoundingClientRect();
    const r = this.btnR.getBoundingClientRect();
    const mid = (l.right + r.left) / 2;
    return x < mid ? -1 : 1;
  }

  private updateBtnTarget(): void {
    let last: -1 | 1 | 0 = 0;
    for (const v of this.btnPtrs.values()) last = v;
    this.btnTarget = last;
    this.btnL.classList.toggle('down', last === -1);
    this.btnR.classList.toggle('down', last === 1);
  }

  // ─────────────────────────────── pedals ───────────────────────────────
  private bindPedal(el: HTMLDivElement, id: PedalId): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.capture(el, e.pointerId);
      this.cacheRects();
      this.pedalPtrs.set(e.pointerId, id);
      this.applyPedals();
      if (id === 'hand') this.host.vibrate(8);
    });
    el.addEventListener('pointermove', (e) => {
      const cur = this.pedalPtrs.get(e.pointerId);
      if (!cur) return;
      const hit = this.hitPedal(e.clientX, e.clientY);
      // Slide between pedals; slipping off every pedal keeps the last one held (thumbs drift).
      if (hit && hit !== cur) {
        this.pedalPtrs.set(e.pointerId, hit);
        this.applyPedals();
      }
    });
    const end = (e: PointerEvent) => {
      if (this.pedalPtrs.delete(e.pointerId)) this.applyPedals();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  private cacheRects(): void {
    this.rects = (Object.keys(this.pedalEls) as PedalId[]).map((k) => [k, this.pedalEls[k].getBoundingClientRect()]);
  }

  private hitPedal(x: number, y: number): PedalId | null {
    const pad = 4;
    for (const [id, r] of this.rects) if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return id;
    return null;
  }

  private applyPedals(): void {
    let gas = false;
    let brake = false;
    let hand = false;
    let turbo = false;
    for (const p of this.pedalPtrs.values()) {
      if (p === 'gas') gas = true;
      else if (p === 'brake') brake = true;
      else if (p === 'turbo') turbo = true;
      else hand = true;
    }
    const t = this.host.ctx.input.touch;
    if (turbo && !t.turbo) this.host.vibrate(18);
    t.throttle = gas || turbo ? 1 : 0; // boosting implies full throttle (thumb can slide gas → turbo)
    t.brake = brake ? 1 : 0;
    t.handbrake = hand;
    t.turbo = turbo;
    this.pedalEls.turbo.classList.toggle('down', turbo);
    this.pedalEls.gas.classList.toggle('down', gas);
    this.pedalEls.brake.classList.toggle('down', brake);
    this.pedalEls.hand.classList.toggle('down', hand);
  }

  private capture(el: Element, id: number): void {
    try {
      el.setPointerCapture(id);
    } catch {
      /* synthetic events / already released */
    }
  }

  // ─────────────────────────────── per frame ───────────────────────────────
  update(dt: number): void {
    if (!this.visible) return;
    const t = this.host.ctx.input.touch;
    // Turbo charge ring (part 3; hidden until the vehicle reports a turbo meter).
    const vs = this.host.ctx.vehicle.state;
    const tb = this.pedalEls.turbo;
    const hasTurbo = typeof vs.turboCharge === 'number';
    tb.classList.toggle('no-turbo', !hasTurbo);
    if (hasTurbo) {
      const c = Math.round(Math.max(0, Math.min(1, vs.turboCharge!)) * 100) / 100;
      if (c !== this.lastCharge) {
        this.lastCharge = c;
        tb.style.setProperty('--charge', String(c));
        tb.classList.toggle('empty', c < 0.03);
      }
      tb.classList.toggle('boosting', !!vs.turboActive);
    }
    if (this.mode === 'buttons') {
      const c = CONFIG.ui.steer;
      const target = this.btnTarget;
      const rate = target === 0 || Math.sign(target) !== Math.sign(this.btnSteer) ? c.buttonReturn : c.buttonRate;
      this.btnSteer = approach(this.btnSteer, target, rate * dt);
      t.steer = this.btnSteer;
    } else if (this.mode === 'tilt') {
      const tilt = this.host.tilt;
      if (tilt.timedOut && !this.tiltFallbackToasted) {
        this.tiltFallbackToasted = true;
        this.host.toast('No motion sensor found — using the slider');
        this.applyMode();
        return;
      }
      const v = tilt.active ? tilt.update(dt) : 0;
      t.steer = v;
      this.tiltWheel.style.transform = `rotate(${clamp(tilt.rollDeg, -90, 90).toFixed(1)}deg)`;
      this.tiltWheel.classList.toggle('live', tilt.active);
    } else if (this.steerPtr !== null) {
      t.steer = this.sliderSteer;
    }
  }
}
