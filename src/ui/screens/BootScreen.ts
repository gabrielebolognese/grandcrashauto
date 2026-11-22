import { CONFIG } from '../../config';
import { h } from '../dom';

const TIPS = [
  'Hold the handbrake mid-corner to drift.',
  'Long-press ↺ Reset to respawn anywhere, any time.',
  'The big jump ramp lives on the highway loop.',
  'Every car can be repainted, re-wheeled and tuned in the garage.',
  'Honk to make the locals turn around.',
  'Share codes let friends drive your exact car.',
  'Tilt steering can be switched on in Settings → Controls.',
];

/**
 * Restyles the #boot loading screen from index.html (progress bar, label) and adds the animated sun/sea art
 * and rotating tips. Hidden with a fade once the game leaves 'boot'.
 */
export class BootScreen {
  private el: HTMLElement | null;
  private bar: HTMLElement | null;
  private label: HTMLElement | null;
  private tip: HTMLElement | null = null;
  private tipTimer = 0;
  private hidden = false;

  constructor() {
    this.el = document.getElementById('boot');
    this.bar = document.getElementById('boot-bar');
    this.label = document.getElementById('boot-label');
    const el = this.el;
    if (!el) return;
    el.classList.add('boot-styled');
    const h1 = el.querySelector('h1');
    if (h1) {
      h1.textContent = CONFIG.game.title.toUpperCase();
      h1.style.setProperty('--c1', String(CONFIG.game.title.length));
      h1.classList.add('boot-word');
    }
    el.prepend(
      h(
        'div',
        { class: 'boot-art', 'aria-hidden': 'true' },
        h('div', { class: 'boot-burst' }),
        h('div', { class: 'boot-sun' }),
        h('div', { class: 'boot-sea' }, h('i', { class: 'w1' }), h('i', { class: 'w2' }), h('i', { class: 'w3' })),
      ),
    );
    if (h1) h1.after(h('div', { class: 'boot-rule', 'aria-hidden': 'true' }, h('i'), h('b'), h('i')));
    this.tip = h('div', { class: 'boot-tip' });
    el.append(this.tip);
    let i = Math.floor(Math.random() * TIPS.length);
    const showTip = () => {
      if (!this.tip) return;
      this.tip.classList.remove('in');
      void this.tip.offsetWidth;
      this.tip.textContent = TIPS[i++ % TIPS.length];
      this.tip.classList.add('in');
    };
    showTip();
    this.tipTimer = window.setInterval(showTip, 3200);
  }

  setLoading(progress: number, label: string): void {
    const p = Math.max(0, Math.min(1, progress));
    if (this.bar) this.bar.style.width = `${(p * 100).toFixed(1)}%`;
    if (this.label) this.label.textContent = p >= 1 ? label : `${label}…`;
  }

  hide(): void {
    if (this.hidden || !this.el) return;
    this.hidden = true;
    const el = this.el;
    window.clearInterval(this.tipTimer);
    el.classList.add('boot-out');
    window.setTimeout(() => (el.style.display = 'none'), 650);
  }
}
