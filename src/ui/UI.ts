import type { GameContext, IUI } from '../game/contracts';

/** STUB — replaced by the UI module (HUD, minimap, menus, settings, touch controls, debug panel). */
export class UI implements IUI {
  readonly name = 'ui';
  private hud!: HTMLDivElement;
  constructor(private ctx: GameContext) {}

  init(): void {
    this.hud = document.createElement('div');
    this.hud.style.cssText = 'position:fixed;right:12px;top:12px;color:#fff;font:600 18px system-ui;text-shadow:0 1px 3px #000;z-index:20';
    document.body.appendChild(this.hud);
    this.ctx.events.on('stateChanged', ({ to }) => {
      if (to !== 'title') return;
      document.getElementById('boot')!.style.display = 'none';
      const tap = document.createElement('div');
      tap.id = 'tap-to-start';
      tap.textContent = 'Tap to start';
      tap.style.cssText =
        'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:800 32px system-ui;color:#fff;text-shadow:0 2px 8px #000;z-index:50;pointer-events:auto';
      tap.onclick = () => {
        tap.remove();
        this.ctx.game.titleDone();
        this.ctx.game.play();
      };
      document.body.appendChild(tap);
    });
  }

  update(): void {
    const s = this.ctx.vehicle.state;
    const st = this.ctx.engine.stats;
    this.hud.textContent = `${Math.round(s.speedKmh)} km/h · ${st.fps.toFixed(0)} fps · ${st.calls} calls`;
  }

  setLoading(progress: number, label: string): void {
    const bar = document.getElementById('boot-bar');
    const lab = document.getElementById('boot-label');
    if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    if (lab) lab.textContent = label;
  }

  fade(cb: () => void): void {
    cb();
  }

  showFatal(message: string): void {
    const el = document.getElementById('fatal');
    if (el) {
      el.querySelector('p')!.textContent = message;
      el.style.display = 'flex';
    }
  }
}
