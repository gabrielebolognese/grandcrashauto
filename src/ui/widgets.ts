import { h, type Child } from './dom';
import { icon, type IconName } from './icons';
import { clamp } from '../core/math';

/**
 * Reusable themed controls (buttons, switches, sliders, segmented pickers, settings rows).
 * Styles live in theme.css. The garage module may reuse these too.
 */

type UiSound = 'click' | 'confirm' | 'back' | 'toggle';
let sound: (k: UiSound) => void = () => {};
/** UI wires this to ctx.audio.ui once. */
export function setWidgetSound(fn: (k: UiSound) => void): void {
  sound = fn;
}
export const uiSound = (k: UiSound): void => {
  try {
    sound(k);
  } catch {
    /* audio is optional */
  }
};

export interface ButtonOpts {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'mint';
  icon?: IconName;
  sub?: string;
  sound?: UiSound | null;
  cls?: string;
  title?: string;
  onClick?: (e: MouseEvent) => void;
}

export function button(label: Child, opts: ButtonOpts = {}): HTMLButtonElement {
  const b = h(
    'button',
    { class: `btn btn-${opts.variant ?? 'secondary'} ${opts.cls ?? ''}`, type: 'button', title: opts.title },
    opts.icon ? icon(opts.icon) : null,
    h('span', { class: 'btn-label' }, label, opts.sub ? h('small', { class: 'btn-sub', text: opts.sub }) : null),
  );
  b.addEventListener('click', (e) => {
    if (opts.sound !== null) uiSound(opts.sound ?? 'click');
    opts.onClick?.(e);
  });
  return b;
}

export function iconButton(name: IconName, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { class: `btn btn-icon ${cls}`, type: 'button', 'aria-label': label, title: label }, icon(name));
  b.addEventListener('click', () => {
    uiSound('click');
    onClick();
  });
  return b;
}

/** On/off switch. */
export class Toggle {
  readonly el: HTMLButtonElement;
  private on = false;
  constructor(
    label: string,
    private onChange: (v: boolean) => void,
  ) {
    this.el = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': label }, h('i'));
    this.el.addEventListener('click', () => {
      this.set(!this.on);
      uiSound('toggle');
      this.onChange(this.on);
    });
  }
  set(v: boolean): void {
    this.on = v;
    this.el.classList.toggle('on', v);
    this.el.setAttribute('aria-checked', String(v));
  }
}

export interface SliderOpts {
  min: number;
  max: number;
  step: number;
  label: string;
  format?: (v: number) => string;
  /** Called continuously while dragging. */
  onInput: (v: number) => void;
}

/** Pointer-driven slider (native range inputs behave inconsistently under touch-action:none on mobile). */
export class Slider {
  readonly el: HTMLDivElement;
  private track: HTMLDivElement;
  private fill: HTMLDivElement;
  private thumb: HTMLDivElement;
  private val: HTMLSpanElement;
  private value = 0;
  private dragId: number | null = null;

  constructor(private o: SliderOpts) {
    this.fill = h('div', { class: 'slider-fill' });
    this.thumb = h('div', { class: 'slider-thumb' });
    this.track = h('div', { class: 'slider-track' }, this.fill, this.thumb);
    this.val = h('span', { class: 'slider-val' });
    this.el = h(
      'div',
      { class: 'slider', role: 'slider', tabindex: 0, 'aria-label': o.label, 'aria-valuemin': o.min, 'aria-valuemax': o.max },
      this.track,
      this.val,
    );
    (this.el as HTMLDivElement & { __slider?: Slider }).__slider = this; // gamepad nudge (MenuNav)
    this.track.addEventListener('pointerdown', (e) => {
      if (this.dragId !== null) return;
      e.preventDefault();
      this.dragId = e.pointerId;
      try {
        this.track.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.el.classList.add('active');
      this.fromX(e.clientX);
    });
    this.track.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.dragId) this.fromX(e.clientX);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.dragId) return;
      this.dragId = null;
      this.el.classList.remove('active');
      uiSound('click');
    };
    this.track.addEventListener('pointerup', end);
    this.track.addEventListener('pointercancel', end);
    this.track.addEventListener('lostpointercapture', end);
    this.el.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      e.stopPropagation();
      this.commit(this.value + d * this.o.step);
    });
  }

  /** Programmatic adjust used by gamepad/keyboard menu navigation. */
  nudge(dir: number): void {
    this.commit(this.value + dir * this.o.step);
  }

  private fromX(x: number): void {
    const r = this.track.getBoundingClientRect();
    const t = clamp((x - r.left) / Math.max(1, r.width), 0, 1);
    this.commit(this.o.min + t * (this.o.max - this.o.min));
  }

  private commit(v: number): void {
    const prev = this.value;
    this.set(v);
    if (this.value !== prev) this.o.onInput(this.value);
  }

  set(v: number): void {
    const { min, max, step } = this.o;
    v = clamp(Math.round((v - min) / step) * step + min, min, max);
    v = +v.toFixed(4);
    this.value = v;
    const t = (v - min) / (max - min || 1);
    const pct = `${(t * 100).toFixed(2)}%`;
    this.fill.style.width = pct;
    this.thumb.style.left = pct;
    const txt = this.o.format ? this.o.format(v) : String(v);
    if (this.val.textContent !== txt) this.val.textContent = txt;
    this.el.setAttribute('aria-valuenow', String(v));
    this.el.setAttribute('aria-valuetext', txt);
  }
}

export interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

/** Pill-shaped single choice picker. */
export class Segmented<T extends string> {
  readonly el: HTMLDivElement;
  private btns = new Map<T, HTMLButtonElement>();
  private cur: T | null = null;
  constructor(
    label: string,
    options: SegOption<T>[],
    private onChange: (v: T) => void,
  ) {
    this.el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
    for (const o of options) {
      const b = h(
        'button',
        { class: 'seg-opt', type: 'button', role: 'radio', 'aria-checked': 'false' },
        o.icon ? icon(o.icon) : null,
        h('span', { text: o.label }),
      );
      b.addEventListener('click', () => {
        if (this.cur === o.value) return;
        uiSound('toggle');
        this.onChange(o.value);
      });
      this.btns.set(o.value, b);
      this.el.append(b);
    }
  }
  set(v: T | null): void {
    this.cur = v;
    for (const [k, b] of this.btns) {
      b.classList.toggle('on', k === v);
      b.setAttribute('aria-checked', String(k === v));
    }
  }
}

/** Label + description on the left, control on the right. */
export function row(label: string, desc: string | null, control: Child, cls = ''): HTMLDivElement {
  return h(
    'div',
    { class: `set-row ${cls}` },
    h('div', { class: 'set-text' }, h('div', { class: 'set-label', text: label }), desc ? h('div', { class: 'set-desc', text: desc }) : null),
    h('div', { class: 'set-ctl' }, control),
  );
}

export function sectionTitle(text: string): HTMLDivElement {
  return h('div', { class: 'set-section' }, h('span', { text }));
}

/** Deco header used by panels: thin rule — title — thin rule. */
export function decoTitle(text: string, cls = ''): HTMLDivElement {
  return h('div', { class: `deco-title ${cls}` }, h('i'), h('span', { text }), h('i'));
}
