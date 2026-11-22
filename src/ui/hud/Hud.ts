import { MPH, KMH } from '../../core/math';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { icon } from '../icons';
import { uiSound } from '../widgets';
import { Minimap } from './Minimap';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC = 'M27.25 142 A84 84 0 1 1 172.75 142'; // 240° gauge arc, r = 84 around (100,100)
const REDLINE = 0.86;

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

/** Driving HUD: minimap, speed/gear/rev gauge, prompts (flip car), post-explosion hint, FPS counter. */
export class Hud {
  readonly el: HTMLDivElement;
  readonly minimap: Minimap;
  readonly fps: HTMLDivElement;
  private gauge: HTMLDivElement;
  private speed: HTMLDivElement;
  private unit: HTMLDivElement;
  private gear: HTMLDivElement;
  private rev: SVGPathElement;
  private boost: SVGPathElement;
  private prompts: HTMLDivElement;
  private hint: HTMLDivElement;
  private promptEls = new Map<string, HTMLElement>();
  private lastSpeed = -1;
  private lastGear = 99;
  private lastRev = -1;
  private lastBoost = -1;
  private wasExploded = false;
  private hintT = 0;
  private fpsT = 0;

  constructor(private host: UIHost) {
    const { ctx } = host;
    this.minimap = new Minimap(ctx);
    this.fps = h('div', { class: 'fps-counter', 'aria-hidden': 'true' });

    // ── gauge ──
    const svg = svgEl('svg', { viewBox: '0 0 200 200', class: 'g-svg', 'aria-hidden': 'true' });
    const defs = svgEl('defs', {});
    const grad = svgEl('linearGradient', { id: 'cl-g-rev', x1: '0', y1: '0', x2: '1', y2: '0' });
    grad.append(svgEl('stop', { offset: '0', 'stop-color': '#5cc8d6' }), svgEl('stop', { offset: '0.55', 'stop-color': '#ffd36e' }), svgEl('stop', { offset: '1', 'stop-color': '#ff6a59' }));
    defs.append(grad);
    svg.append(defs);
    svg.append(svgEl('circle', { class: 'g-plate', cx: 100, cy: 100, r: 97 }));
    svg.append(svgEl('circle', { class: 'g-plate-ring', cx: 100, cy: 100, r: 90 }));
    svg.append(svgEl('path', { class: 'g-track', d: ARC, pathLength: 100 }));
    svg.append(svgEl('path', { class: 'g-red', d: ARC, pathLength: 100, 'stroke-dasharray': `0 ${REDLINE * 100} ${(1 - REDLINE) * 100} 100` }));
    this.rev = svgEl('path', { class: 'g-rev', d: ARC, pathLength: 100, 'stroke-dasharray': '0 100' });
    svg.append(this.rev);
    this.boost = svgEl('path', { class: 'g-boost', d: 'M45 132 A62 62 0 1 1 155 132', pathLength: 100, 'stroke-dasharray': '0 100' });
    svg.append(this.boost);
    const ticks = svgEl('g', { class: 'g-ticks' });
    for (let i = 0; i <= 10; i++) {
      const a = ((150 + i * 24) * Math.PI) / 180;
      const r0 = i % 5 === 0 ? 66 : 70;
      ticks.append(
        svgEl('line', {
          x1: (100 + Math.cos(a) * r0).toFixed(2),
          y1: (100 + Math.sin(a) * r0).toFixed(2),
          x2: (100 + Math.cos(a) * 75).toFixed(2),
          y2: (100 + Math.sin(a) * 75).toFixed(2),
          class: i / 10 >= REDLINE ? 'hot' : '',
        }),
      );
    }
    svg.append(ticks);
    this.speed = h('div', { class: 'g-speed', text: '0' });
    this.unit = h('div', { class: 'g-unit', text: 'KM/H' });
    this.gear = h('div', { class: 'g-gear', text: 'N' });
    this.gauge = h('div', { class: 'gauge' }, svg, h('div', { class: 'g-center' }, this.speed, this.unit), this.gear);

    this.prompts = h('div', { class: 'hud-prompts' });
    this.hint = h('div', { class: 'hud-hint' });
    this.el = h('div', { class: 'hud', 'aria-hidden': 'true' }, h('div', { class: 'hud-tl' }, this.minimap.el), this.gauge, this.prompts, this.hint);

    ctx.events.on('prompt', ({ id, show, text }) => this.setPrompt(id, show, text));
    ctx.events.on('gearShift', () => {
      this.gear.classList.remove('shift');
      void this.gear.offsetWidth;
      this.gear.classList.add('shift');
    });
    ctx.events.on('carReset', () => {
      this.hintT = 0;
      this.hint.classList.remove('show');
      this.setPrompt('flip', false);
    });
  }

  setVisible(on: boolean): void {
    setVisible(this.el, on);
  }

  setPrompt(id: string, show: boolean, text?: string): void {
    let el = this.promptEls.get(id);
    if (!show) {
      if (el) {
        el.classList.remove('show');
        const dead = el;
        window.setTimeout(() => !dead.classList.contains('show') && dead.remove(), 300);
        this.promptEls.delete(id);
      }
      return;
    }
    const { ctx } = this.host;
    if (!el) {
      if (id === 'flip') {
        const b = h('button', { class: 'prompt-btn touch-ctl', type: 'button' }, icon('flip'), h('span', { class: 'pb-label', text: text ?? 'Flip car' }), h('kbd', { class: 'pb-key', text: 'F' }));
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          uiSound('confirm');
          ctx.input.press('flip');
          this.host.vibrate(20);
        });
        el = b;
      } else {
        el = h('div', { class: 'prompt-pill' }, h('span', { text: text ?? id }));
      }
      this.promptEls.set(id, el);
      this.prompts.append(el);
      void el.offsetWidth;
    } else if (text) {
      const lbl = el.querySelector('.pb-label, span');
      if (lbl) setText(lbl as HTMLElement, text);
    }
    el.classList.add('show');
  }

  update(dt: number): void {
    const { ctx } = this.host;
    const s = ctx.vehicle.state;
    const mph = ctx.settings.values.units === 'mph';
    const spd = Math.round(Math.abs(s.speed) * (mph ? MPH : KMH));
    if (spd !== this.lastSpeed) {
      this.lastSpeed = spd;
      this.speed.textContent = String(spd);
      setText(this.unit, mph ? 'MPH' : 'KM/H');
    }
    const gear = s.gear | 0;
    if (gear !== this.lastGear) {
      this.lastGear = gear;
      this.gear.textContent = gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear);
      this.gear.classList.toggle('rev', gear < 0);
    }
    const rev = Math.round(Math.max(0, Math.min(1, s.rpmNorm || 0)) * 200) / 2;
    if (rev !== this.lastRev) {
      this.lastRev = rev;
      this.rev.style.strokeDasharray = `${rev} 100`;
      this.gauge.classList.toggle('redline', rev >= REDLINE * 100);
    }
    const boost = Math.round(Math.max(0, Math.min(1, s.boost || 0)) * 50) * 2;
    if (boost !== this.lastBoost) {
      this.lastBoost = boost;
      this.boost.style.strokeDasharray = `${boost} 100`;
      this.gauge.classList.toggle('boosting', boost > 4);
    }
    // After an explosion, explain how to get back on the road.
    if (s.exploded && !this.wasExploded) {
      this.hintT = 3.2;
      this.hint.textContent = this.host.touchMode() ? 'Tap ↺ Reset to respawn' : 'Press R or click ↺ Reset to respawn';
      this.hint.classList.add('show');
    }
    this.wasExploded = s.exploded;
    if (this.hintT > 0) {
      this.hintT -= dt;
      if (this.hintT <= 0) this.hint.classList.remove('show');
    }
    this.minimap.update(dt);
  }

  /** FPS counter runs in every state when enabled. */
  updateFps(dt: number): void {
    const on = this.host.ctx.settings.values.showFps;
    this.fps.classList.toggle('visible', on);
    if (!on) return;
    this.fpsT -= dt;
    if (this.fpsT > 0) return;
    this.fpsT = 0.25;
    const st = this.host.ctx.engine.stats;
    const fps = Math.round(st.fps);
    this.fps.textContent = `${fps} FPS`;
    this.fps.dataset.tier = fps >= 50 ? 'good' : fps >= 28 ? 'ok' : 'bad';
  }
}

/** Stacked short messages (anyone → 'toast' event). Visible in every state. */
export class Toasts {
  readonly el: HTMLDivElement;
  constructor() {
    this.el = h('div', { class: 'toasts', 'aria-live': 'polite' });
  }
  show(text: string, ms: number): void {
    // De-duplicate identical toasts that are still visible.
    for (const c of Array.from(this.el.children)) if (c.textContent === text && !c.classList.contains('out')) c.remove();
    const t = h('div', { class: 'toast' }, h('span', { text }));
    this.el.append(t);
    while (this.el.children.length > 3) this.el.firstElementChild?.remove();
    window.setTimeout(() => {
      t.classList.add('out');
      window.setTimeout(() => t.remove(), 320);
    }, Math.max(600, ms));
  }
}
