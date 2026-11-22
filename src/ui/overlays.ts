import { CONFIG } from '../config';
import { h, setVisible } from './dom';
import { icon } from './icons';

/**
 * Reset flash (spec §10): ~150 ms fade in → run the callbacks exactly once at full cover → ~250 ms fade out.
 * Overlapping calls share the same cover. Timers (not transitionend) so it can't get stuck in a hidden tab.
 */
export class Fader {
  readonly el: HTMLDivElement;
  private queue: (() => void)[] = [];
  private phase: 'idle' | 'in' | 'out' = 'idle';
  private timer = 0;

  constructor() {
    this.el = h('div', { class: 'fader', 'aria-hidden': 'true' }, h('div', { class: 'fader-burst' }));
  }

  fade(cb: () => void): void {
    this.queue.push(cb);
    if (this.phase === 'in') return;
    this.phase = 'in';
    window.clearTimeout(this.timer);
    const ms = CONFIG.ui.fadeInMs;
    this.el.style.transition = `opacity ${ms}ms ease-out`;
    this.el.classList.add('on');
    this.timer = window.setTimeout(() => this.atFull(), ms + 16);
  }

  private atFull(): void {
    const q = this.queue;
    this.queue = [];
    for (const f of q) {
      try {
        f();
      } catch (err) {
        console.error('[ui] fade callback threw', err);
      }
    }
    this.phase = 'out';
    // Hold briefly so the swapped scene renders before we reveal it.
    this.timer = window.setTimeout(() => {
      const ms = CONFIG.ui.fadeOutMs;
      this.el.style.transition = `opacity ${ms}ms ease-in`;
      this.el.classList.remove('on');
      this.timer = window.setTimeout(() => {
        if (this.phase === 'out') this.phase = 'idle';
      }, ms);
    }, 50);
  }
}

/** "Rotate your phone" overlay for portrait on touch devices. Blocks input; a tap tries fullscreen + landscape lock. */
export class RotateOverlay {
  readonly el: HTMLDivElement;
  shown = false;

  constructor(onTap: () => void) {
    this.el = h(
      'div',
      { class: 'rotate-overlay', 'aria-hidden': 'true', role: 'alert' },
      h('div', { class: 'ro-phone' }, h('div', { class: 'ro-screen' }, icon('wheel'))),
      h('div', { class: 'ro-title', text: 'Rotate your phone' }),
      h('div', { class: 'ro-sub', text: `${CONFIG.game.title} plays in landscape` }),
    );
    this.el.addEventListener('pointerup', (e) => {
      e.preventDefault();
      onTap();
    });
  }

  set(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    setVisible(this.el, on);
  }
}

/** Friendly fatal error (WebGL/physics failed). Reuses #fatal from index.html, restyled. */
export function showFatal(message: string): void {
  const boot = document.getElementById('boot');
  if (boot) boot.style.display = 'none';
  const el = document.getElementById('fatal');
  if (!el) return;
  el.classList.add('fatal-styled');
  const p = el.querySelector('p');
  if (p) p.textContent = message;
  if (!el.querySelector('.fatal-reload')) {
    const b = h('button', { class: 'btn btn-primary fatal-reload', type: 'button' }, icon('reset'), h('span', { class: 'btn-label', text: 'Reload' }));
    b.addEventListener('click', () => location.reload());
    el.append(b);
  }
  el.style.display = 'flex';
}
