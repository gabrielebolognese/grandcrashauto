import { NAV_ICONS } from './icons';
import type { TurnDir } from './Route';

/**
 * Top-centre GPS card ("↱ 120 m"): big manoeuvre arrow + distance, destination + remaining distance underneath.
 * Own DOM element inside #ui-root, sits under the 💥 button (clear of the minimap top-left and the buttons top-right).
 */
export class TurnCard {
  readonly el: HTMLDivElement;
  private arrow: HTMLDivElement;
  private dist: HTMLDivElement;
  private sub: HTMLDivElement;
  private shown = false;
  private dir: TurnDir | null = null;
  private lastDist = '';
  private lastSub = '';

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'nav-turn';
    this.el.setAttribute('aria-live', 'polite');
    this.el.setAttribute('aria-hidden', 'true');
    this.arrow = document.createElement('div');
    this.arrow.className = 'nt-arrow';
    const txt = document.createElement('div');
    txt.className = 'nt-text';
    this.dist = document.createElement('div');
    this.dist.className = 'nt-dist';
    this.sub = document.createElement('div');
    this.sub.className = 'nt-sub';
    txt.append(this.dist, this.sub);
    this.el.append(this.arrow, txt);
  }

  setVisible(on: boolean): void {
    if (on === this.shown) return;
    this.shown = on;
    this.el.classList.toggle('show', on);
    this.el.setAttribute('aria-hidden', on ? 'false' : 'true');
    document.getElementById('ui-root')?.classList.toggle('nav-routing', on);
  }

  set(dir: TurnDir, dist: string, sub: string, soon: boolean, partial: boolean): void {
    if (dir !== this.dir) {
      this.dir = dir;
      this.arrow.innerHTML = NAV_ICONS[dir];
      this.el.dataset.dir = dir;
      // re-trigger the pop animation on a new manoeuvre
      this.el.classList.remove('pop');
      void this.el.offsetWidth;
      this.el.classList.add('pop');
    }
    if (dist !== this.lastDist) {
      this.lastDist = dist;
      this.dist.textContent = dist;
    }
    if (sub !== this.lastSub) {
      this.lastSub = sub;
      this.sub.textContent = sub;
    }
    this.el.classList.toggle('soon', soon);
    this.el.classList.toggle('partial', partial);
  }
}
