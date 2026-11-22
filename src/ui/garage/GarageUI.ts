import {
  CAR_MODEL_IDS,
  PAINT_FINISHES,
  RIM_COUNT,
  SPOILER_STYLES,
  STRIPE_STYLES,
  TYRE_PROFILES,
  sanitizePlate,
  type CarBuild,
  type CarModelId,
  type PaintFinish,
  type SpoilerStyle,
  type StripeStyle,
  type TyreProfile,
} from '../../vehicle/CarBuild';
import type { CarModelInfo } from '../../game/contracts';
import { computeStats, type CarStats } from '../../vehicle/tuning';
import { HEADLIGHT_SWATCHES, NEON_SWATCHES, PAINT_SWATCHES, RIM_SWATCHES, colorName, luma, type Swatch } from '../../vehicle/customization/palette';
import { CAMBER_STEPS, RIDE_STEPS, TINT_STEPS, quantizeCamber, quantizeRide, quantizeTint } from '../../vehicle/customization/shareCode';
import { CONFIG } from '../../config';
import { ICONS, RIM_NAMES, kitIcon, modelSilhouette, rimIcon, spoilerIcon } from './icons';
import './garage.css';

/**
 * Garage customization UI (owner: garage). Plain DOM, mobile-first (landscape phone 844×390), prefixed `gar-`.
 * Layout: floating top bar (back · title · randomize · stock · DRIVE), bottom dock = option panel (2 rows) + tab bar.
 * Every control registers a refresher; `refresh(build)` re-syncs the whole UI after any change.
 */

export type GarageTab = 'car' | 'paint' | 'wheels' | 'kit' | 'stance' | 'extras' | 'perf' | 'save';
export type UISound = 'click' | 'toggle' | 'confirm' | 'back';
export type ColorTarget = 'color' | 'shiftColor' | 'roofColor' | 'stripeColor' | 'rimColor' | 'headlightColor' | 'underglow';

export interface GarageHost {
  getBuild(): CarBuild;
  readonly models: CarModelInfo[];
  change(fn: (b: CarBuild) => void, sound?: UISound | null): void;
  setModel(id: CarModelId): void;
  drive(): void;
  back(): void;
  randomize(): void;
  stock(): void;
  slots(): (CarBuild | null)[];
  saveSlot(i: number): void;
  loadSlot(i: number): void;
  clearSlot(i: number): void;
  shareCode(): string;
  copyLink(): Promise<boolean>;
  shareLinkText(): string;
  loadCode(text: string): boolean;
  sound(kind: UISound): void;
  speedUnit(): 'kmh' | 'mph';
  layoutChanged(): void;
}

const TABS: { id: GarageTab; label: string; short?: string; icon: string }[] = [
  { id: 'car', label: 'Car', icon: ICONS.car },
  { id: 'paint', label: 'Paint', icon: ICONS.paint },
  { id: 'wheels', label: 'Wheels', icon: ICONS.wheel },
  { id: 'kit', label: 'Body kit', short: 'Kit', icon: ICONS.kit },
  { id: 'stance', label: 'Stance', icon: ICONS.stance },
  { id: 'extras', label: 'Extras', icon: ICONS.extras },
  { id: 'perf', label: 'Performance', short: 'Perf', icon: ICONS.perf },
  { id: 'save', label: 'Save', icon: ICONS.save },
];

const FINISH_LABEL: Record<PaintFinish, string> = { gloss: 'Gloss', metallic: 'Metallic', matte: 'Matte', pearl: 'Pearl', shift: 'Colour-shift' };
const STRIPE_LABEL: Record<StripeStyle, string> = { none: 'None', center: 'Center', twin: 'Twin', side: 'Side' };
const SPOILER_LABEL: Record<SpoilerStyle, string> = { none: 'None', lip: 'Lip', ducktail: 'Ducktail', gt: 'GT wing' };
const TYRE_LABEL: Record<TyreProfile, string> = { low: 'Low', mid: 'Mid', high: 'High' };
const SIZE_LABEL = ['S', 'M', 'L'];
const SIZE_TITLE = ['Small wheels', 'Medium wheels', 'Large wheels'];
const PERF_LEVELS_LABEL = ['Stock', 'Street', 'Race'];
const TARGET_LABEL: Record<ColorTarget, string> = {
  color: 'Body colour',
  shiftColor: 'Shift colour',
  roofColor: 'Roof colour',
  stripeColor: 'Stripe colour',
  rimColor: 'Rim colour',
  headlightColor: 'Headlights',
  underglow: 'Underglow',
};

function getColor(b: CarBuild, t: ColorTarget): string | null {
  switch (t) {
    case 'color': return b.paint.color;
    case 'shiftColor': return b.paint.shiftColor;
    case 'roofColor': return b.paint.twoTone ? b.paint.roofColor : null;
    case 'stripeColor': return b.paint.stripes === 'none' ? null : b.paint.stripeColor;
    case 'rimColor': return b.wheels.rimColor;
    case 'headlightColor': return b.extras.headlightColor;
    case 'underglow': return b.extras.underglow;
  }
}

/** Raw stored colour (also when the feature is off) — used to seed the native colour picker. */
function rawColor(b: CarBuild, t: ColorTarget): string {
  if (t === 'roofColor') return b.paint.roofColor;
  if (t === 'stripeColor') return b.paint.stripeColor;
  if (t === 'underglow') return b.extras.underglow ?? '#ff4fa3';
  return getColor(b, t) ?? '#ffffff';
}

function setColor(b: CarBuild, t: ColorTarget, hex: string | null): void {
  switch (t) {
    case 'color': if (hex) b.paint.color = hex; break;
    case 'shiftColor':
      if (hex) b.paint.shiftColor = hex;
      b.paint.finish = 'shift';
      break;
    case 'roofColor':
      if (hex) {
        b.paint.roofColor = hex;
        b.paint.twoTone = true;
      } else b.paint.twoTone = false;
      break;
    case 'stripeColor':
      if (hex) {
        b.paint.stripeColor = hex;
        if (b.paint.stripes === 'none') b.paint.stripes = 'center';
      } else b.paint.stripes = 'none';
      break;
    case 'rimColor': if (hex) b.wheels.rimColor = hex; break;
    case 'headlightColor': if (hex) b.extras.headlightColor = hex; break;
    case 'underglow': b.extras.underglow = hex; break;
  }
}

function swatchesFor(t: ColorTarget): { off: boolean; list: readonly Swatch[] } {
  switch (t) {
    case 'rimColor': {
      const seen = new Set<string>();
      return { off: false, list: [...RIM_SWATCHES, ...PAINT_SWATCHES].filter((s) => !seen.has(s.hex) && !!seen.add(s.hex)) };
    }
    case 'headlightColor': return { off: false, list: HEADLIGHT_SWATCHES };
    case 'underglow': return { off: true, list: NEON_SWATCHES };
    case 'roofColor': return { off: true, list: PAINT_SWATCHES };
    case 'stripeColor': return { off: true, list: PAINT_SWATCHES };
    default: return { off: false, list: PAINT_SWATCHES };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function button(cls: string, html: string, title?: string): HTMLButtonElement {
  const b = el('button', cls, html);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  return b;
}

const stripeIcon = (s: StripeStyle) => {
  const bands: Record<StripeStyle, string> = {
    none: '',
    center: '<rect x="11" y="3" width="6" height="34" rx="1" fill="currentColor"/>',
    twin: '<rect x="9" y="3" width="3" height="34" rx="1" fill="currentColor"/><rect x="16" y="3" width="3" height="34" rx="1" fill="currentColor"/>',
    side: '<rect x="4.5" y="9" width="2.5" height="22" rx="1" fill="currentColor"/><rect x="21" y="9" width="2.5" height="22" rx="1" fill="currentColor"/>',
  };
  return `<svg class="gar-stripeico" viewBox="0 0 28 40" aria-hidden="true"><rect x="3" y="2" width="22" height="36" rx="8" fill="none" stroke="currentColor" stroke-width="2"/>${bands[s]}</svg>`;
};

export class GarageUI {
  readonly root: HTMLDivElement;
  /** Transparent full-screen layer under the panels — orbit input goes here. */
  readonly stage: HTMLDivElement;
  private top!: HTMLDivElement;
  private dock!: HTMLDivElement;
  private panel!: HTMLDivElement;
  private carName!: HTMLSpanElement;
  private hint!: HTMLDivElement;
  private pages = new Map<GarageTab, HTMLDivElement>();
  private tabButtons = new Map<GarageTab, HTMLButtonElement>();
  private refreshers: ((b: CarBuild) => void)[] = [];
  private tab: GarageTab = 'car';
  private collapsed = false;
  private paintSection: 'body' | 'roof' | 'stripes' = 'body';
  private paintTarget: ColorTarget = 'color';
  private extrasTarget: 'headlightColor' | 'underglow' = 'headlightColor';
  private resizeObs: ResizeObserver | null = null;
  private hintTimer = 0;

  constructor(private host: GarageHost) {
    this.root = el('div', 'gar-root gar-hidden');
    this.root.id = 'gar-root';
    this.root.setAttribute('aria-hidden', 'true');
    this.stage = el('div', 'gar-stage');
    this.root.appendChild(this.stage);
    this.buildTop();
    this.buildHint();
    this.buildDock();
    document.body.appendChild(this.root);
    this.selectTab('car', false);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObs = new ResizeObserver(() => this.host.layoutChanged());
      this.resizeObs.observe(this.dock);
      this.resizeObs.observe(this.top);
    }
  }

  // ───────────────────────────── public ─────────────────────────────
  show(): void {
    this.root.classList.remove('gar-hidden');
    this.root.setAttribute('aria-hidden', 'false');
    this.root.classList.add('gar-entering');
    window.setTimeout(() => this.root.classList.remove('gar-entering'), 700);
    this.hint.classList.remove('is-gone');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.hideHint(), 4500);
    this.host.layoutChanged();
  }

  hide(): void {
    this.root.classList.add('gar-hidden');
    this.root.setAttribute('aria-hidden', 'true');
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  hideHint(): void {
    this.hint.classList.add('is-gone');
  }

  refresh(b: CarBuild): void {
    const info = this.host.models.find((m) => m.id === b.model);
    this.carName.textContent = info?.name ?? b.model;
    for (const r of this.refreshers) r(b);
  }

  /** Screen insets (CSS px) covered by UI at the top and bottom — the camera frames the car in between. */
  getInsets(): { top: number; bottom: number } {
    const H = window.innerHeight;
    const topRect = this.top.getBoundingClientRect();
    const dockRect = this.dock.getBoundingClientRect();
    const panelRect = this.panel.getBoundingClientRect();
    const dockTop = this.collapsed ? dockRect.top + panelRect.height : dockRect.top;
    return { top: Math.max(0, topRect.bottom * 0.55), bottom: Math.max(0, H - dockTop + 4) };
  }

  get activeTab(): GarageTab {
    return this.tab;
  }

  selectTab(id: GarageTab, sound = true): void {
    if (id === this.tab && sound) {
      // Tapping the active tab collapses / expands the panel for a bigger view.
      this.setCollapsed(!this.collapsed);
      this.host.sound('toggle');
      return;
    }
    this.tab = id;
    if (this.collapsed) this.setCollapsed(false);
    for (const [t, b] of this.tabButtons) {
      const on = t === id;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const [t, p] of this.pages) p.classList.toggle('is-active', t === id);
    if (sound) this.host.sound('click');
    this.refresh(this.host.getBuild());
  }

  private setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.root.classList.toggle('gar-collapsed', c);
    window.setTimeout(() => this.host.layoutChanged(), 380);
    this.host.layoutChanged();
  }

  dispose(): void {
    this.resizeObs?.disconnect();
    this.root.remove();
  }

  // ───────────────────────────── top bar ─────────────────────────────
  private buildTop(): void {
    this.top = el('div', 'gar-top');
    const left = el('div', 'gar-tl');
    const back = button('gar-iconbtn gar-back', ICONS.back, 'Back to menu');
    back.addEventListener('click', () => this.host.back());
    const title = el('div', 'gar-title');
    title.innerHTML = '<span class="gar-kicker">GARAGE</span>';
    this.carName = el('span', 'gar-carname');
    title.appendChild(this.carName);
    left.append(back, title);

    const right = el('div', 'gar-tr');
    const rnd = button('gar-iconbtn gar-rnd', ICONS.dice, 'Randomize');
    rnd.addEventListener('click', () => {
      rnd.classList.remove('is-spin');
      void rnd.offsetWidth;
      rnd.classList.add('is-spin');
      this.host.randomize();
    });
    const stock = button('gar-iconbtn gar-stock', ICONS.reset, 'Reset to stock');
    stock.addEventListener('click', () => {
      stock.classList.remove('is-spin');
      void stock.offsetWidth;
      stock.classList.add('is-spin');
      this.host.stock();
    });
    const drive = button('gar-drive', `<span>DRIVE</span>${ICONS.drive}`, 'Drive this car');
    drive.addEventListener('click', () => this.host.drive());
    right.append(rnd, stock, drive);
    this.top.append(left, right);
    this.root.appendChild(this.top);
  }

  private buildHint(): void {
    this.hint = el('div', 'gar-hint', `<span>Drag to rotate</span><i></i><span>Pinch or scroll to zoom</span>`);
    this.root.appendChild(this.hint);
  }

  // ───────────────────────────── dock ─────────────────────────────
  private buildDock(): void {
    this.dock = el('div', 'gar-dock');
    this.panel = el('div', 'gar-panel');
    this.panel.innerHTML = '<i class="gar-deco" aria-hidden="true"></i>';
    const tabs = el('nav', 'gar-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const t of TABS) {
      const b = button('gar-tab', `${t.icon}<span class="gar-tl-long">${t.label}</span><span class="gar-tl-short">${t.short ?? t.label}</span>`);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', t.label);
      b.dataset.tab = t.id;
      b.addEventListener('click', () => this.selectTab(t.id));
      this.tabButtons.set(t.id, b);
      tabs.appendChild(b);
    }
    const builders: Record<GarageTab, () => HTMLDivElement> = {
      car: () => this.pageCar(),
      paint: () => this.pagePaint(),
      wheels: () => this.pageWheels(),
      kit: () => this.pageKit(),
      stance: () => this.pageStance(),
      extras: () => this.pageExtras(),
      perf: () => this.pagePerf(),
      save: () => this.pageSave(),
    };
    for (const t of TABS) {
      const p = builders[t.id]();
      p.classList.add('gar-page', `gar-page-${t.id}`);
      p.setAttribute('role', 'tabpanel');
      this.pages.set(t.id, p);
      this.panel.appendChild(p);
    }
    this.dock.append(this.panel, tabs);
    this.root.appendChild(this.dock);
  }

  // ───────────────────────────── generic controls ─────────────────────────────
  private row(...children: (HTMLElement | null)[]): HTMLDivElement {
    const r = el('div', 'gar-row');
    for (const c of children) if (c) r.appendChild(c);
    return r;
  }

  private label(text: string): HTMLSpanElement {
    return el('span', 'gar-glabel', text);
  }

  private sep(): HTMLElement {
    return el('i', 'gar-sep');
  }

  /** Exclusive chip group bound to a build field. */
  private chips<T>(
    options: { value: T; label: string; icon?: string; title?: string }[],
    get: (b: CarBuild) => T,
    set: (b: CarBuild, v: T) => void,
    cls = '',
  ): HTMLDivElement {
    const wrap = el('div', 'gar-chips');
    const btns = options.map((o) => {
      const b = button(`gar-chip ${cls}`, `${o.icon ?? ''}<span>${o.label}</span>`, o.title ?? o.label);
      b.addEventListener('click', () => {
        if (get(this.host.getBuild()) === o.value) return;
        this.host.change((x) => set(x, o.value), 'click');
      });
      wrap.appendChild(b);
      return b;
    });
    this.refreshers.push((b) => {
      const v = get(b);
      options.forEach((o, i) => {
        const on = o.value === v;
        btns[i].classList.toggle('is-on', on);
        btns[i].setAttribute('aria-pressed', String(on));
      });
    });
    return wrap;
  }

  private toggle(label: string, icon: string, get: (b: CarBuild) => boolean, set: (b: CarBuild, v: boolean) => void): HTMLButtonElement {
    const b = button('gar-chip gar-toggle', `${icon}<span>${label}</span><i class="gar-switch"></i>`, label);
    b.addEventListener('click', () => this.host.change((x) => set(x, !get(x)), 'toggle'));
    this.refreshers.push((x) => {
      const on = get(x);
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    return b;
  }

  /** A chip that selects which colour the palette row edits. */
  private targetChip(label: string, target: ColorTarget, isActive: () => boolean, activate: () => void): HTMLButtonElement {
    const b = button('gar-chip gar-target', `<i class="gar-dot"></i><span>${label}</span>`, `Edit ${TARGET_LABEL[target].toLowerCase()}`);
    const dot = b.querySelector('.gar-dot') as HTMLElement;
    b.addEventListener('click', () => {
      activate();
      this.host.sound('click');
      this.refresh(this.host.getBuild());
    });
    this.refreshers.push((x) => {
      const c = getColor(x, target);
      dot.style.setProperty('--sw', c ?? 'transparent');
      dot.classList.toggle('is-off', c === null);
      const on = isActive();
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-pressed', String(on));
    });
    return b;
  }

  /** Colour palette row editing whatever `target()` returns. */
  private paletteRow(target: () => ColorTarget): HTMLDivElement {
    const r = el('div', 'gar-row gar-palette');
    const lab = el('div', 'gar-rowlabel', '<small></small><b></b>');
    const small = lab.querySelector('small') as HTMLElement;
    const big = lab.querySelector('b') as HTMLElement;
    const custom = el('label', 'gar-swatch gar-custom', `${ICONS.plus}`);
    custom.title = 'Custom colour';
    const input = el('input', 'gar-colorinput');
    input.type = 'color';
    input.setAttribute('aria-label', 'Custom colour');
    custom.appendChild(input);
    const list = el('div', 'gar-swatches');
    r.append(lab, custom, list);

    let shownFor: ColorTarget | null = null;
    let buttons: { b: HTMLButtonElement; hex: string | null }[] = [];
    const rebuild = (t: ColorTarget) => {
      list.innerHTML = '';
      buttons = [];
      const { off, list: sw } = swatchesFor(t);
      if (off) {
        const b = button('gar-swatch gar-swatch-off', ICONS.off, 'Off');
        b.addEventListener('click', () => this.host.change((x) => setColor(x, target(), null), 'toggle'));
        list.appendChild(b);
        buttons.push({ b, hex: null });
      }
      for (const s of sw) {
        const b = button('gar-swatch', '', s.name);
        b.style.setProperty('--sw', s.hex);
        if (luma(s.hex) > 0.72) b.classList.add('is-light');
        b.addEventListener('click', () => this.host.change((x) => setColor(x, target(), s.hex), 'click'));
        list.appendChild(b);
        buttons.push({ b, hex: s.hex });
      }
      r.scrollLeft = 0;
      shownFor = t;
    };
    let pickerT = 0;
    input.addEventListener('input', () => {
      const v = input.value.toLowerCase();
      // Native pickers fire `input` continuously — the garage applies visuals once per frame anyway.
      this.host.change((x) => setColor(x, target(), v), null);
      const now = performance.now();
      if (now - pickerT > 400) this.host.sound('click');
      pickerT = now;
    });
    this.refreshers.push((b) => {
      const t = target();
      if (t !== shownFor) rebuild(t);
      const cur = getColor(b, t);
      small.textContent = TARGET_LABEL[t];
      big.textContent = cur === null ? 'Off' : colorName(cur);
      let matched = false;
      for (const { b: btn, hex } of buttons) {
        const on = hex === cur;
        matched ||= on;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-pressed', String(on));
      }
      const raw = rawColor(b, t);
      if (document.activeElement !== input && input.value !== raw) input.value = raw;
      custom.classList.toggle('is-on', !matched && cur !== null);
      custom.style.setProperty('--sw', !matched && cur !== null ? cur : 'transparent');
    });
    return r;
  }

  /** Custom slider (pointer + keyboard), quantized by `step`. */
  private slider(opts: {
    label: string;
    min: number;
    max: number;
    step: number;
    center?: number;
    get: (b: CarBuild) => number;
    set: (b: CarBuild, v: number) => void;
    format: (v: number) => string;
    cls?: string;
  }): HTMLDivElement {
    const wrap = el('div', `gar-slider ${opts.cls ?? ''}`);
    wrap.innerHTML = `<div class="gar-sl-head"><span>${opts.label}</span><b></b></div><div class="gar-sl-track" role="slider" tabindex="0" aria-label="${opts.label}"><div class="gar-sl-rail"><i class="gar-sl-fill"></i>${opts.center !== undefined ? '<i class="gar-sl-mark"></i>' : ''}</div><i class="gar-sl-thumb"></i></div>`;
    const track = wrap.querySelector('.gar-sl-track') as HTMLDivElement;
    const fill = wrap.querySelector('.gar-sl-fill') as HTMLElement;
    const thumb = wrap.querySelector('.gar-sl-thumb') as HTMLElement;
    const val = wrap.querySelector('b') as HTMLElement;
    const mark = wrap.querySelector('.gar-sl-mark') as HTMLElement | null;
    track.setAttribute('aria-valuemin', String(opts.min));
    track.setAttribute('aria-valuemax', String(opts.max));
    const range = opts.max - opts.min;
    const pct = (v: number) => ((v - opts.min) / range) * 100;
    if (mark && opts.center !== undefined) mark.style.left = `${pct(opts.center)}%`;
    const q = (v: number) => {
      const n = Math.round((Math.min(opts.max, Math.max(opts.min, v)) - opts.min) / opts.step);
      const r = opts.min + n * opts.step;
      return Math.round(r * 1e6) / 1e6;
    };
    let lastSound = 0;
    const apply = (v: number, sound: boolean) => {
      const nv = q(v);
      if (Math.abs(nv - opts.get(this.host.getBuild())) < 1e-9) return;
      this.host.change((x) => opts.set(x, nv), null);
      const now = performance.now();
      if (sound && now - lastSound > 60) {
        this.host.sound('click');
        lastSound = now;
      }
    };
    const fromX = (clientX: number) => {
      const r = track.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - r.left - 12) / Math.max(1, r.width - 24)));
      return opts.min + t * range;
    };
    let dragging = -1;
    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = e.pointerId;
      try {
        track.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      wrap.classList.add('is-drag');
      track.focus({ preventScroll: true });
      apply(fromX(e.clientX), true);
    });
    track.addEventListener('pointermove', (e) => {
      if (e.pointerId !== dragging) return;
      apply(fromX(e.clientX), true);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== dragging) return;
      dragging = -1;
      wrap.classList.remove('is-drag');
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('keydown', (e) => {
      const cur = opts.get(this.host.getBuild());
      let v: number | null = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = cur + opts.step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = cur - opts.step;
      else if (e.key === 'Home') v = opts.min;
      else if (e.key === 'End') v = opts.max;
      if (v !== null) {
        e.preventDefault();
        e.stopPropagation();
        apply(v, true);
      }
    });
    this.refreshers.push((b) => {
      const v = opts.get(b);
      const p = pct(v);
      thumb.style.left = `calc(12px + (100% - 24px) * ${(p / 100).toFixed(4)})`;
      if (opts.center !== undefined) {
        const c = pct(opts.center);
        fill.style.left = `${Math.min(c, p)}%`;
        fill.style.width = `${Math.abs(p - c)}%`;
      } else {
        fill.style.left = '0%';
        fill.style.width = `${p}%`;
      }
      val.textContent = opts.format(v);
      track.setAttribute('aria-valuenow', String(v));
      track.setAttribute('aria-valuetext', opts.format(v));
    });
    return wrap;
  }

  private statBars(getStats: (b: CarBuild) => { s: CarStats; base: CarStats }, mini: boolean): HTMLDivElement {
    const wrap = el('div', mini ? 'gar-stats gar-stats-mini' : 'gar-stats');
    const defs: { key: keyof CarStats; label: string }[] = [
      { key: 'topSpeed', label: 'Top speed' },
      { key: 'accel', label: 'Acceleration' },
      { key: 'grip', label: 'Grip' },
      { key: 'braking', label: 'Braking' },
    ];
    const rows = defs.map((d) => {
      const r = el('div', 'gar-stat', `<span>${d.label}</span><div class="gar-bar"><i class="gar-bar-base"></i><i class="gar-bar-fill"></i></div><b></b>`);
      wrap.appendChild(r);
      return {
        d,
        base: r.querySelector('.gar-bar-base') as HTMLElement,
        fill: r.querySelector('.gar-bar-fill') as HTMLElement,
        val: r.querySelector('b') as HTMLElement,
      };
    });
    const shown = new Map<string, number>();
    this.refreshers.push((b) => {
      const { s, base } = getStats(b);
      for (const r of rows) {
        const v = Math.max(0, Math.min(1, s[r.d.key] as number));
        const bv = Math.max(0, Math.min(1, base[r.d.key] as number));
        r.fill.style.width = `${(v * 100).toFixed(1)}%`;
        r.base.style.width = `${(bv * 100).toFixed(1)}%`;
        r.fill.classList.toggle('is-up', v > bv + 0.005);
        if (!mini) {
          if (r.d.key === 'topSpeed') {
            const mph = this.host.speedUnit() === 'mph';
            const target = Math.round(mph ? s.topSpeedKmh * 0.621371 : s.topSpeedKmh);
            this.countUp(r.val, `ts`, target, (n) => `${n} ${mph ? 'mph' : 'km/h'}`, shown);
          } else this.countUp(r.val, r.d.key, Math.round(v * 100), (n) => `${n}`, shown);
        }
      }
    });
    return wrap;
  }

  private countUp(node: HTMLElement, key: string, target: number, fmt: (n: number) => string, shown: Map<string, number>): void {
    const from = shown.get(key);
    shown.set(key, target);
    if (from === undefined || from === target || !this.isVisible()) {
      node.textContent = fmt(target);
      return;
    }
    const t0 = performance.now();
    const dur = 420;
    const step = () => {
      if (shown.get(key) !== target) return; // superseded
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3);
      node.textContent = fmt(Math.round(from + (target - from) * e));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private isVisible(): boolean {
    return !this.root.classList.contains('gar-hidden');
  }

  // ───────────────────────────── pages ─────────────────────────────
  private pageCar(): HTMLDivElement {
    const p = el('div');
    const r = el('div', 'gar-row gar-row-tall gar-models');
    for (const id of CAR_MODEL_IDS) {
      const info = this.host.models.find((m) => m.id === id);
      const card = button('gar-model', '', info?.name ?? id);
      card.innerHTML = `<div class="gar-model-art">${modelSilhouette(id)}</div><div class="gar-model-text"><b>${info?.name ?? id}</b><small>${info?.description ?? ''}</small></div><i class="gar-model-check">${ICONS.check}</i>`;
      const bars = this.statBars((b) => {
        const mb = { ...b, model: id };
        return { s: computeStats(mb), base: computeStats({ ...mb, perf: { engine: 0, tyres: 0, brakes: 0, suspension: 0 } }) };
      }, true);
      card.querySelector('.gar-model-text')!.appendChild(bars);
      card.addEventListener('click', () => {
        if (this.host.getBuild().model !== id) this.host.setModel(id);
      });
      this.refreshers.push((b) => {
        const on = b.model === id;
        card.classList.toggle('is-on', on);
        card.setAttribute('aria-pressed', String(on));
        card.style.setProperty('--sw', on ? b.paint.color : '#c9c3d6');
      });
      r.appendChild(card);
    }
    p.appendChild(r);
    return p;
  }

  private pagePaint(): HTMLDivElement {
    const p = el('div');
    p.appendChild(this.paletteRow(() => this.paintTarget));

    const seg = el('div', 'gar-seg');
    const sections: { id: 'body' | 'roof' | 'stripes'; label: string; target: ColorTarget }[] = [
      { id: 'body', label: 'Body', target: 'color' },
      { id: 'roof', label: 'Roof', target: 'roofColor' },
      { id: 'stripes', label: 'Stripes', target: 'stripeColor' },
    ];
    const segBtns = sections.map((s) => {
      const b = button('gar-segbtn', `<i class="gar-dot"></i><span>${s.label}</span>`, s.label);
      b.addEventListener('click', () => {
        this.paintSection = s.id;
        this.paintTarget = s.target;
        this.host.sound('click');
        this.refresh(this.host.getBuild());
      });
      seg.appendChild(b);
      return b;
    });

    // Body: finish chips (+ main/shift colour targets when colour-shift).
    const body = el('div', 'gar-ctx');
    body.append(this.sep(), this.label('Finish'));
    const finishChips = this.chips(
      PAINT_FINISHES.map((f) => ({ value: f, label: FINISH_LABEL[f], icon: `<i class="gar-fin gar-fin-${f}"></i>` })),
      (b) => b.paint.finish,
      (b, v) => {
        b.paint.finish = v;
        if (v !== 'shift' && this.paintTarget === 'shiftColor') this.paintTarget = 'color';
      },
    );
    body.appendChild(finishChips);
    const shiftGroup = el('div', 'gar-chips gar-shiftgroup');
    shiftGroup.append(
      this.sep(),
      this.targetChip('Main', 'color', () => this.paintTarget === 'color', () => (this.paintTarget = 'color')),
      this.targetChip('Shift', 'shiftColor', () => this.paintTarget === 'shiftColor', () => (this.paintTarget = 'shiftColor')),
    );
    body.appendChild(shiftGroup);

    const roof = el('div', 'gar-ctx');
    roof.append(
      this.sep(),
      this.toggle('Two-tone roof', '', (b) => b.paint.twoTone, (b, v) => (b.paint.twoTone = v)),
      el('span', 'gar-note', 'Pick the roof colour above'),
    );

    const stripes = el('div', 'gar-ctx');
    stripes.append(
      this.sep(),
      this.label('Style'),
      this.chips(
        STRIPE_STYLES.map((s) => ({ value: s, label: STRIPE_LABEL[s], icon: stripeIcon(s) })),
        (b) => b.paint.stripes,
        (b, v) => (b.paint.stripes = v),
      ),
    );

    const finishSwatches = finishChips.querySelectorAll<HTMLElement>('.gar-fin');
    this.refreshers.push((b) => {
      sections.forEach((s, i) => {
        const on = s.id === this.paintSection;
        segBtns[i].classList.toggle('is-on', on);
        segBtns[i].setAttribute('aria-pressed', String(on));
        const c = getColor(b, s.target);
        const dot = segBtns[i].querySelector('.gar-dot') as HTMLElement;
        dot.style.setProperty('--sw', c ?? 'transparent');
        dot.classList.toggle('is-off', c === null);
      });
      body.hidden = this.paintSection !== 'body';
      roof.hidden = this.paintSection !== 'roof';
      stripes.hidden = this.paintSection !== 'stripes';
      shiftGroup.hidden = b.paint.finish !== 'shift';
      for (const f of finishSwatches) {
        f.style.setProperty('--sw', b.paint.color);
        f.style.setProperty('--sw2', b.paint.shiftColor);
      }
    });
    p.appendChild(this.row(seg, body, roof, stripes));
    return p;
  }

  private pageWheels(): HTMLDivElement {
    const p = el('div');
    const rims = this.chips(
      Array.from({ length: RIM_COUNT }, (_, i) => ({ value: i, label: RIM_NAMES[i] ?? `Rim ${i + 1}`, icon: rimIcon(i) })),
      (b) => b.wheels.rim,
      (b, v) => (b.wheels.rim = v),
      'gar-rim',
    );
    const size = this.chips(
      [0, 1, 2].map((v) => ({ value: v, label: SIZE_LABEL[v], title: SIZE_TITLE[v] })),
      (b) => b.wheels.size,
      (b, v) => (b.wheels.size = v),
      'gar-sq',
    );
    const tyre = this.chips(
      TYRE_PROFILES.map((t) => ({ value: t, label: TYRE_LABEL[t], icon: `<i class="gar-tyre gar-tyre-${t}"></i>`, title: `${TYRE_LABEL[t]} profile tyres` })),
      (b) => b.wheels.tyre,
      (b, v) => (b.wheels.tyre = v),
    );
    // Rim icons follow the rim colour.
    const rimRow = this.row(this.label('Rims'), rims, this.sep(), this.label('Size'), size, this.sep(), this.label('Profile'), tyre);
    this.refreshers.push((b) => rims.style.setProperty('--rim', b.wheels.rimColor));
    p.append(rimRow, this.paletteRow(() => 'rimColor'));
    return p;
  }

  private pageKit(): HTMLDivElement {
    const p = el('div');
    p.appendChild(
      this.row(
        this.label('Aero'),
        this.toggle('Front splitter', kitIcon('splitter'), (b) => b.kit.splitter, (b, v) => (b.kit.splitter = v)),
        this.toggle('Side skirts', kitIcon('skirts'), (b) => b.kit.skirts, (b, v) => (b.kit.skirts = v)),
        this.toggle('Hood scoop', kitIcon('scoop'), (b) => b.kit.scoop, (b, v) => (b.kit.scoop = v)),
      ),
    );
    p.appendChild(
      this.row(
        this.label('Rear spoiler'),
        this.chips(
          SPOILER_STYLES.map((s) => ({ value: s, label: SPOILER_LABEL[s], icon: spoilerIcon(s) })),
          (b) => b.kit.spoiler,
          (b, v) => (b.kit.spoiler = v),
          'gar-kitchip',
        ),
      ),
    );
    return p;
  }

  private pageStance(): HTMLDivElement {
    const p = el('div');
    const rideFmt = (v: number) => (v === 0 ? 'Stock' : v <= -0.75 ? `Slammed ${v.toFixed(1)}` : v >= 0.75 ? `Lifted +${v.toFixed(1)}` : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
    const ride = this.slider({
      label: 'Ride height',
      min: -1,
      max: 1,
      step: 1 / RIDE_STEPS,
      center: 0,
      get: (b) => b.stance.rideHeight,
      set: (b, v) => (b.stance.rideHeight = quantizeRide(v)),
      format: rideFmt,
      cls: 'gar-slider-wide',
    });
    const presets = this.chips(
      [
        { value: -1, label: 'Slammed' },
        { value: 0, label: 'Stock' },
        { value: 1, label: 'Lifted' },
      ],
      (b) => b.stance.rideHeight,
      (b, v) => (b.stance.rideHeight = v),
    );
    const camber = this.slider({
      label: 'Camber',
      min: 0,
      max: 1,
      step: 1 / CAMBER_STEPS,
      get: (b) => b.stance.camber,
      set: (b, v) => (b.stance.camber = quantizeCamber(v)),
      format: (v) => (v === 0 ? '0°' : `−${(v * CONFIG.garage.camberMaxDeg).toFixed(1)}°`),
      cls: 'gar-slider-wide',
    });
    const camberPresets = this.chips(
      [
        { value: 0, label: 'Straight' },
        { value: 0.35, label: 'Street' },
        { value: 1, label: 'Stance' },
      ],
      (b) => b.stance.camber,
      (b, v) => (b.stance.camber = v),
    );
    p.append(this.row(ride, presets), this.row(camber, camberPresets));
    return p;
  }

  private pageExtras(): HTMLDivElement {
    const p = el('div');
    p.appendChild(this.paletteRow(() => this.extrasTarget));
    const head = this.targetChip('Headlights', 'headlightColor', () => this.extrasTarget === 'headlightColor', () => (this.extrasTarget = 'headlightColor'));
    const glow = this.targetChip('Underglow', 'underglow', () => this.extrasTarget === 'underglow', () => (this.extrasTarget = 'underglow'));
    const tint = this.slider({
      label: 'Window tint',
      min: 0,
      max: 1,
      step: 1 / TINT_STEPS,
      get: (b) => b.extras.tint,
      set: (b, v) => (b.extras.tint = quantizeTint(v)),
      format: (v) => (v <= 0.001 ? 'Clear' : v >= 0.999 ? 'Limo' : `${Math.round(v * 100)}%`),
      cls: 'gar-slider-compact',
    });
    const plateWrap = el('label', 'gar-plate');
    plateWrap.innerHTML = '<span class="gar-plate-label">Plate</span>';
    const plate = el('input', 'gar-plate-input');
    plate.type = 'text';
    plate.maxLength = 8;
    plate.autocomplete = 'off';
    plate.spellcheck = false;
    plate.setAttribute('autocapitalize', 'characters');
    plate.setAttribute('aria-label', 'Licence plate text');
    plate.placeholder = 'CSTL 01';
    plate.addEventListener('input', () => {
      const pos = plate.selectionStart ?? plate.value.length;
      const clean = sanitizePlate(plate.value);
      if (clean !== plate.value) {
        plate.value = clean;
        plate.setSelectionRange(Math.min(pos, clean.length), Math.min(pos, clean.length));
      }
      this.host.change((b) => (b.extras.plate = clean), null);
    });
    plate.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') plate.blur();
    });
    plate.addEventListener('change', () => this.host.sound('click'));
    plateWrap.appendChild(plate);
    this.refreshers.push((b) => {
      if (document.activeElement !== plate && plate.value !== b.extras.plate) plate.value = b.extras.plate;
    });
    p.appendChild(this.row(this.label('Lights'), head, glow, this.sep(), tint, this.sep(), plateWrap));
    return p;
  }

  private pagePerf(): HTMLDivElement {
    const p = el('div', 'gar-perf');
    const grid = el('div', 'gar-perfgrid');
    const cats: { key: keyof CarBuild['perf']; label: string }[] = [
      { key: 'engine', label: 'Engine' },
      { key: 'tyres', label: 'Tyres' },
      { key: 'brakes', label: 'Brakes' },
      { key: 'suspension', label: 'Suspension' },
    ];
    for (const c of cats) {
      const ctl = el('div', 'gar-perfctl');
      ctl.appendChild(el('span', 'gar-perflabel', c.label));
      ctl.appendChild(
        this.chips(
          [0, 1, 2].map((lvl) => ({ value: lvl, label: PERF_LEVELS_LABEL[lvl], icon: `<i class="gar-pips gar-pips-${lvl}"><i></i><i></i><i></i></i>`, title: `${c.label}: ${PERF_LEVELS_LABEL[lvl]}` })),
          (b) => b.perf[c.key],
          (b, v) => (b.perf[c.key] = v),
          'gar-perfchip',
        ),
      );
      grid.appendChild(ctl);
    }
    const stats = this.statBars((b) => ({ s: computeStats(b), base: computeStats({ ...b, perf: { engine: 0, tyres: 0, brakes: 0, suspension: 0 } }) }), false);
    p.append(grid, stats);
    return p;
  }

  private pageSave(): HTMLDivElement {
    const p = el('div');
    const slotsRow = el('div', 'gar-row gar-slots');
    for (let i = 0; i < 3; i++) {
      const card = el('div', 'gar-slot');
      card.innerHTML = `<i class="gar-slot-chip"></i><div class="gar-slot-text"><b></b><small></small></div>`;
      const save = button('gar-mini gar-mini-save', ICONS.store, `Save to slot ${i + 1}`);
      const load = button('gar-mini', ICONS.load, `Load slot ${i + 1}`);
      const clear = button('gar-mini gar-mini-clear', ICONS.trash, `Clear slot ${i + 1}`);
      let armT = 0;
      save.addEventListener('click', () => {
        this.host.saveSlot(i);
        card.classList.remove('is-flash');
        void card.offsetWidth;
        card.classList.add('is-flash');
      });
      load.addEventListener('click', () => this.host.loadSlot(i));
      clear.addEventListener('click', () => {
        if (!clear.classList.contains('is-armed')) {
          clear.classList.add('is-armed');
          this.host.sound('toggle');
          clearTimeout(armT);
          armT = window.setTimeout(() => clear.classList.remove('is-armed'), 2500);
          return;
        }
        clearTimeout(armT);
        clear.classList.remove('is-armed');
        this.host.clearSlot(i);
      });
      card.append(save, load, clear);
      const chip = card.querySelector('.gar-slot-chip') as HTMLElement;
      const title = card.querySelector('b') as HTMLElement;
      const sub = card.querySelector('small') as HTMLElement;
      this.refreshers.push(() => {
        const s = this.host.slots()[i];
        card.classList.toggle('is-empty', !s);
        load.disabled = !s;
        clear.disabled = !s;
        if (s) {
          const info = this.host.models.find((m) => m.id === s.model);
          chip.style.setProperty('--c1', s.paint.color);
          chip.style.setProperty('--c2', s.paint.twoTone ? s.paint.roofColor : s.paint.stripes !== 'none' ? s.paint.stripeColor : s.paint.color);
          title.textContent = `${i + 1} · ${info?.name ?? s.model}`;
          sub.textContent = s.extras.plate.trim() || colorName(s.paint.color);
        } else {
          chip.style.removeProperty('--c1');
          chip.style.removeProperty('--c2');
          title.textContent = `${i + 1} · Empty`;
          sub.textContent = 'Save your build here';
        }
      });
      slotsRow.appendChild(card);
    }

    // Share: copy link + code + paste box.
    const copy = button('gar-chip gar-copy', `${ICONS.link}<span>Copy link</span>`, 'Copy a share link for this car');
    const code = el('output', 'gar-code');
    code.title = 'Share code';
    const paste = el('input', 'gar-paste');
    paste.type = 'text';
    paste.placeholder = 'Paste a code or link';
    paste.autocomplete = 'off';
    paste.spellcheck = false;
    paste.setAttribute('aria-label', 'Paste a share code or link');
    const loadCode = button('gar-chip gar-loadcode', `${ICONS.paste}<span>Load</span>`, 'Load a shared car');
    const flash = (b: HTMLElement, cls: string) => {
      b.classList.remove(cls);
      void b.offsetWidth;
      b.classList.add(cls);
      window.setTimeout(() => b.classList.remove(cls), 1600);
    };
    copy.addEventListener('click', async () => {
      const ok = await this.host.copyLink();
      const span = copy.querySelector('span')!;
      span.textContent = ok ? 'Copied!' : 'Copy failed';
      flash(copy, ok ? 'is-done' : 'is-bad');
      if (!ok) {
        // Let the player copy it by hand.
        paste.value = this.host.shareLinkText();
        paste.focus();
        paste.select();
      }
      window.setTimeout(() => (span.textContent = 'Copy link'), 1600);
    });
    const tryLoad = () => {
      const ok = this.host.loadCode(paste.value);
      if (ok) {
        paste.value = '';
        paste.blur();
        flash(loadCode, 'is-done');
      } else flash(paste, 'is-bad');
    };
    loadCode.addEventListener('click', tryLoad);
    paste.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') tryLoad();
    });
    this.refreshers.push(() => {
      if (this.tab === 'save') code.textContent = this.host.shareCode();
    });
    p.append(slotsRow, this.row(this.label('Share'), copy, code, paste, loadCode));
    return p;
  }
}
