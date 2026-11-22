import { MPH, KMH } from '../../core/math';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { ICON, icon, type IconName } from '../icons';
import { uiSound } from '../widgets';
import { Minimap } from './Minimap';

const REDLINE = 0.86;
const WEATHER_ICON: Record<string, IconName> = {
  clear: 'sun',
  fewClouds: 'cloud',
  cloudy: 'cloud',
  overcast: 'cloud',
  lightRain: 'rain',
  heavyRain: 'rain',
  storm: 'storm',
  fog: 'fog',
  snow: 'snow',
};

/**
 * Driving HUD: minimap + clock (top-left), compact speed card with gear, rev bar and turbo meter (top-right),
 * prompts (flip car, board/exit plane), post-explosion hint and the FPS counter.
 */
export class Hud {
  readonly el: HTMLDivElement;
  readonly minimap: Minimap;
  readonly fps: HTMLDivElement;
  private speedo: HTMLDivElement;
  private speed: HTMLDivElement;
  private unit: HTMLDivElement;
  private gear: HTMLDivElement;
  private revFill: HTMLElement;
  private turboFill: HTMLElement;
  private clock: HTMLDivElement;
  private clockIcon: HTMLSpanElement;
  private clockText: HTMLSpanElement;
  private prompts: HTMLDivElement;
  private hint: HTMLDivElement;
  private promptEls = new Map<string, HTMLElement>();
  private lastSpeed = -1;
  private lastGear = 99;
  private lastRev = -1;
  private lastTurbo = -1;
  private lastClock = '';
  private lastWeather = '';
  private wasExploded = false;
  private hintT = 0;
  private fpsT = 0;
  private boardKey = '';
  private exitShown = false;

  constructor(private host: UIHost) {
    const { ctx } = host;
    this.minimap = new Minimap(ctx);
    this.fps = h('div', { class: 'fps-counter', 'aria-hidden': 'true' });

    // ── speed card ──
    this.speed = h('div', { class: 'sp-speed', text: '0' });
    this.unit = h('div', { class: 'sp-unit', text: 'KM/H' });
    this.gear = h('div', { class: 'sp-gear', text: 'N' });
    this.revFill = h('i', { class: 'fill' });
    this.turboFill = h('i');
    this.speedo = h(
      'div',
      { class: 'speedo only-car' },
      h('div', { class: 'sp-row' }, this.speed, h('div', { class: 'sp-side' }, this.unit, this.gear)),
      h('div', { class: 'sp-rev' }, this.revFill, h('i', { class: 'red' })),
      h('div', { class: 'sp-turbo' }, icon('flame'), h('div', { class: 'sp-tbar' }, this.turboFill), h('kbd', { text: 'Shift' })),
    );

    this.clockIcon = icon('sun');
    this.clockText = h('span');
    this.clock = h('div', { class: 'hud-chip hud-clock off' }, this.clockIcon, this.clockText);
    this.prompts = h('div', { class: 'hud-prompts' });
    this.hint = h('div', { class: 'hud-hint' });
    this.el = h('div', { class: 'hud', 'aria-hidden': 'true' }, h('div', { class: 'hud-tl' }, this.minimap.el, this.clock), this.speedo, this.prompts, this.hint);

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
    ctx.events.on('originShift', () => this.minimap.onOriginShift());
  }

  setVisible(on: boolean): void {
    setVisible(this.el, on);
  }

  /** Generic prompt API: 'flip' (and 'board' / 'exit' from the UI itself) become big buttons, others text pills. */
  setPrompt(id: string, show: boolean, text?: string, sub?: string): void {
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
      const action = (name: IconName, label: string, key: string, cls: string, fn: () => void) => {
        const b = h(
          'button',
          { class: `prompt-btn touch-ctl ${cls}`, type: 'button' },
          icon(name),
          h('span', { class: 'pb-label', text: label }),
          sub ? h('small', { class: 'pb-sub', text: sub }) : null,
          h('kbd', { class: 'pb-key', text: key }),
        );
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          uiSound('confirm');
          fn();
          this.host.vibrate(15);
        });
        return b;
      };
      if (id === 'flip') el = action('flip', text ?? 'Flip car', 'F', '', () => ctx.input.press('flip'));
      else if (id === 'board') el = action('plane', text ?? 'Board', 'F', 'blue', () => ctx.input.press('interact'));
      else if (id === 'exit') el = action('car', text ?? 'Exit plane', 'F', 'mint', () => ctx.input.press('interact'));
      else el = h('div', { class: 'prompt-pill' }, h('span', { text: text ?? id }));
      this.promptEls.set(id, el);
      this.prompts.append(el);
      void el.offsetWidth;
    } else if (text) {
      const lbl = el.querySelector('.pb-label') ?? el.querySelector('span');
      if (lbl) setText(lbl as HTMLElement, text);
    }
    el.classList.add('show');
  }

  update(dt: number): void {
    const { ctx } = this.host;
    const plane = ctx.game.mode === 'plane';
    const s = ctx.vehicle.state;
    if (!plane) {
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
      const rev = Math.round(Math.max(0, Math.min(1, s.rpmNorm || 0)) * 100) / 100;
      if (rev !== this.lastRev) {
        this.lastRev = rev;
        this.revFill.style.transform = `scaleX(${rev})`;
        this.speedo.classList.toggle('redline', rev >= REDLINE);
      }
      const hasTurbo = typeof s.turboCharge === 'number';
      this.speedo.classList.toggle('has-turbo', hasTurbo);
      if (hasTurbo) {
        const t = Math.round(Math.max(0, Math.min(1, s.turboCharge!)) * 100) / 100;
        if (t !== this.lastTurbo) {
          this.lastTurbo = t;
          this.turboFill.style.transform = `scaleX(${t})`;
        }
        this.speedo.classList.toggle('turbo-on', !!s.turboActive);
      }
      // After an explosion, explain how to get back on the road.
      if (s.exploded && !this.wasExploded) {
        this.hintT = 3.2;
        this.hint.textContent = this.host.touchMode() ? 'Tap ↺ Reset to respawn' : 'Press R or click ↺ Reset to respawn';
        this.hint.classList.add('show');
      }
      this.wasExploded = s.exploded;
    }
    if (this.hintT > 0) {
      this.hintT -= dt;
      if (this.hintT <= 0) this.hint.classList.remove('show');
    }
    // BOARD (car near a parked plane) / EXIT (plane stopped on the ground).
    const cand = !plane ? ctx.planes?.boardCandidate ?? null : null;
    const key = cand ? `${cand.type}|${cand.name}` : '';
    if (key !== this.boardKey) {
      this.boardKey = key;
      this.setPrompt('board', false);
      if (cand) this.setPrompt('board', true, `Board`, cand.name);
    }
    const canExit = plane && !!ctx.planes?.state?.canExit && !ctx.planes.crashed;
    if (canExit !== this.exitShown) {
      this.exitShown = canExit;
      this.setPrompt('exit', canExit, 'Exit plane');
    }
    // Clock + weather chip (part 3 env; hidden until the env provides a clock).
    const hours = ctx.env?.clockHours;
    if (typeof hours === 'number' && Number.isFinite(hours)) {
      const hh = Math.floor(((hours % 24) + 24) % 24);
      const mm = Math.floor((((hours % 1) + 1) % 1) * 60);
      const txt = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      const kind = ctx.env.weather?.kind ?? 'clear';
      const night = hh < 6 || hh >= 20;
      const wkey = `${kind}|${night}`;
      if (wkey !== this.lastWeather) {
        this.lastWeather = wkey;
        const name: IconName = kind === 'clear' || kind === 'fewClouds' ? (night ? 'moon' : 'sun') : WEATHER_ICON[kind] ?? 'cloud';
        this.clockIcon.innerHTML = ICON[name];
        this.clockIcon.className = `ic ${name}`;
      }
      if (txt !== this.lastClock) {
        this.lastClock = txt;
        this.clockText.textContent = txt;
        this.clock.classList.remove('off');
      }
    }
    // Hide the minimap until there is road data to show.
    const d = ctx.world?.data;
    const hasRoads = !!d && ((d.roads?.edges?.length ?? 0) > 0 || (ctx.highways?.graph?.edges?.length ?? 0) > 0);
    this.minimap.el.classList.toggle('nodata', !hasRoads);
    if (hasRoads) this.minimap.update(dt);
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
