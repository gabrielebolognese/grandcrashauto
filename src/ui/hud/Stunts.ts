import './stunts.css';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { icon } from '../icons';
import { uiSound } from '../widgets';

const POPUPS: Record<string, { text: string; cls: string } | undefined> = {
  cleanLanding: { text: 'Clean landing', cls: 'mint' },
  barrelRoll: { text: 'Barrel roll!', cls: 'coral' },
  airGlide: { text: 'Air glide', cls: 'aqua' },
  crashLanding: { text: 'Crash landing', cls: 'red' },
};

/**
 * Part 3 stunt layer (SPEC-PART3 §7/§8): turbo speed lines at the screen edges, air-time + distance counter,
 * the BARREL ROLL button (swipe left/right on it, or tap its arrows; Q/E on desktop) while airborne with enough
 * predicted air time, and stunt pop-ups (CLEAN LANDING, BARREL ROLL!, AIR GLIDE, CRASH LANDING).
 */
export class Stunts {
  readonly el: HTMLDivElement;
  readonly lines: HTMLDivElement;
  private air: HTMLDivElement;
  private airTime: HTMLSpanElement;
  private airDist: HTMLSpanElement;
  private airTag: HTMLSpanElement;
  private roll: HTMLDivElement;
  private pops: HTMLDivElement;
  private visible = false;
  private rollPtr: number | null = null;
  private rollX0 = 0;
  private rollShown = false;
  private linesReady = false;

  constructor(private host: UIHost) {
    const { ctx } = host;
    this.lines = h('div', { class: 'speedlines', 'aria-hidden': 'true' }, h('i', { class: 'sl1' }), h('i', { class: 'sl2' }));
    this.airTime = h('span', { class: 'air-t' });
    this.airDist = h('span', { class: 'air-d' });
    this.airTag = h('span', { class: 'air-tag', text: 'GLIDE' });
    this.air = h('div', { class: 'air-counter' }, h('span', { class: 'air-lbl', text: 'AIR' }), this.airTime, h('i'), this.airDist, this.airTag);
    const arrowL = h('span', { class: 'br-arrow l' }, icon('left'));
    const arrowR = h('span', { class: 'br-arrow r' }, icon('right'));
    this.roll = h(
      'div',
      { class: 'barrel-btn touch-ctl', role: 'button', 'aria-label': 'Barrel roll (swipe left or right)' },
      arrowL,
      h('span', { class: 'br-core' }, h('b', { text: 'Barrel' }), h('b', { text: 'roll' }), h('small', { text: '‹ swipe ›' })),
      arrowR,
      h('kbd', { class: 'br-key l', text: 'Q' }),
      h('kbd', { class: 'br-key r', text: 'E' }),
    );
    this.bindRoll();
    this.pops = h('div', { class: 'stunt-pops', 'aria-live': 'polite' });
    this.el = h('div', { class: 'stunts', 'aria-hidden': 'true' }, this.air, this.roll, this.pops);

    ctx.events.on('stunt', ({ kind, airTime, distance, rolls }) => {
      const p = POPUPS[kind];
      if (!p || !this.visible) return;
      const title = kind === 'barrelRoll' && rolls && rolls > 1 ? `${rolls}× barrel roll!` : p.text;
      const sub = airTime > 0.2 ? `${airTime.toFixed(1)} s · ${Math.round(distance)} m` : '';
      this.popup(title, sub, p.cls);
      if (kind === 'barrelRoll' || kind === 'cleanLanding') this.host.vibrate(kind === 'barrelRoll' ? [20, 30, 20] : 25);
    });
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    setVisible(this.el, on);
    if (!on) {
      this.lines.classList.remove('on');
      this.rollPtr = null;
    }
  }

  private press(dir: -1 | 1): void {
    uiSound('confirm');
    this.host.ctx.input.press(dir < 0 ? 'barrelLeft' : 'barrelRight');
    this.host.vibrate(15);
    this.roll.classList.remove('fire-l', 'fire-r');
    void this.roll.offsetWidth;
    this.roll.classList.add(dir < 0 ? 'fire-l' : 'fire-r');
  }

  private bindRoll(): void {
    const b = this.roll;
    b.addEventListener('pointerdown', (e) => {
      if (this.rollPtr !== null) return;
      e.preventDefault();
      this.rollPtr = e.pointerId;
      this.rollX0 = e.clientX;
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      b.classList.add('down');
    });
    b.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.rollPtr) return;
      const dx = e.clientX - this.rollX0;
      if (Math.abs(dx) > 26) {
        this.rollPtr = null;
        b.classList.remove('down');
        this.press(dx < 0 ? -1 : 1);
      }
    });
    b.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.rollPtr) return;
      this.rollPtr = null;
      b.classList.remove('down');
      // A plain tap picks the side that was touched.
      const r = b.getBoundingClientRect();
      this.press(e.clientX < r.left + r.width / 2 ? -1 : 1);
    });
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === this.rollPtr) {
        this.rollPtr = null;
        b.classList.remove('down');
      }
    };
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('lostpointercapture', cancel);
  }

  popup(title: string, sub: string, cls: string): void {
    const p = h('div', { class: `stunt-pop ${cls}` }, h('div', { class: 'sp-title', text: title }), sub ? h('div', { class: 'sp-sub', text: sub }) : null);
    this.pops.append(p);
    while (this.pops.children.length > 2) this.pops.firstElementChild?.remove();
    window.setTimeout(() => p.classList.add('out'), 1500);
    window.setTimeout(() => p.remove(), 1900);
  }

  /** Radial streaks near the screen edges, drawn once into a small bitmap (scaled by the GPU afterwards). */
  private buildLines(): void {
    this.linesReady = true;
    try {
      const N = 512;
      const c = document.createElement('canvas');
      c.width = c.height = N;
      const g = c.getContext('2d')!;
      const R = N * 0.72;
      g.translate(N / 2, N / 2);
      for (let i = 0; i < 110; i++) {
        const a = Math.random() * Math.PI * 2;
        const r0 = R * (0.5 + Math.random() * 0.3);
        const r1 = R * (0.85 + Math.random() * 0.25);
        const w = 0.6 + Math.random() * 1.8;
        const grad = g.createLinearGradient(Math.cos(a) * r0, Math.sin(a) * r0, Math.cos(a) * r1, Math.sin(a) * r1);
        grad.addColorStop(0, 'rgba(255,255,255,0)');
        grad.addColorStop(0.5, `rgba(255,255,255,${(0.35 + Math.random() * 0.45).toFixed(2)})`);
        grad.addColorStop(1, 'rgba(255,240,220,0)');
        g.strokeStyle = grad;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        g.stroke();
      }
      const url = `url(${c.toDataURL('image/png')})`;
      for (const el of Array.from(this.lines.children)) (el as HTMLElement).style.backgroundImage = url;
    } catch {
      /* canvas unavailable: no speed lines */
    }
  }

  update(): void {
    if (!this.visible) return;
    const { ctx } = this.host;
    const car = ctx.game.mode !== 'plane';
    const s = ctx.vehicle.state;
    const lines = car && !!s.turboActive && !s.exploded;
    if (lines && !this.linesReady) this.buildLines();
    this.lines.classList.toggle('on', lines);
    const a = car ? s.airborne3 : undefined;
    const airOn = !!a?.active && a.time > 0.25 && !s.exploded;
    this.air.classList.toggle('show', airOn);
    if (airOn && a) {
      setText(this.airTime, `${a.time.toFixed(2)} s`);
      setText(this.airDist, `${Math.round(a.distance)} m`);
      this.airTag.classList.toggle('on', a.gliding);
    }
    // `predicted` = remaining predicted air time (s).
    const canRoll = !!a?.active && !a.rolling && a.predicted >= 0.8 && !s.exploded;
    if (canRoll !== this.rollShown) {
      this.rollShown = canRoll;
      this.roll.classList.toggle('show', canRoll);
      if (!canRoll) this.rollPtr = null;
    }
  }
}
