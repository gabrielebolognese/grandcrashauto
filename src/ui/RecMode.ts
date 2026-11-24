import './rec.css';

/**
 * Recording mode (user request): every button tiny and gathered in ONE spot (top-left corner, stacked), everything
 * else hidden (speed card, clock, alerts, toasts, hints, stunt pops; touch sticks/pedals fade to ghosts but still work)
 * so the rest of the screen is clear for filming. Toggle: ?rec, U, the ● button in the top cluster, agent "rec on".
 * The groups keep their own visibility logic; this only re-positions the visible ones into one column.
 */
const STACK = [
  '.topbar .tb-cluster',
  '.topbar .boom-wrap',
  '.flight-hud .fl-engines',
  '.flight-hud .fl-dock',
  '.flight-hud .switch-part-btn',
  '.flight-hud .airborne-btn',
  '.flight-hud .skip-btn',
  '.hud .hud-prompts',
  '.walk-layer .wk-context',
  '.walk-layer .wk-actions',
  '.replay-bar .rp-btns',
  '.flight-hud .crash-panel',
];

export class RecMode {
  on = false;
  private t = 0;

  constructor(private root: HTMLElement) {}

  set(on: boolean): void {
    this.on = on;
    this.root.classList.toggle('rec', on);
    this.t = 0;
    if (!on) for (const s of STACK) this.root.querySelector<HTMLElement>(s)?.style.removeProperty('--rec-top');
    else this.layout();
  }

  update(dt: number): void {
    if (!this.on) return;
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 0.2;
    this.layout();
  }

  /** Stack the visible groups top to bottom (their scaled heights), so nothing overlaps and nothing leaves gaps. */
  private layout(): void {
    let y = 0;
    for (const s of STACK) {
      const el = this.root.querySelector<HTMLElement>(s);
      if (!el) continue;
      const top = `${Math.round(y)}px`;
      if (el.style.getPropertyValue('--rec-top') !== top) el.style.setProperty('--rec-top', top);
      if (el.offsetParent === null) continue; // display: none (itself or a parent)
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      y += r.height + 5;
    }
  }
}
