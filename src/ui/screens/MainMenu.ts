import { CONFIG } from '../../config';
import type { PlaneTypeId } from '../../plane/types';
import { h, setVisible } from '../dom';
import type { Screen, UIHost } from '../host';
import { button } from '../widgets';
import { logo } from './Logo';

/** Main menu: Play, Garage, Settings, Credits — a column on the left so the showcase city stays visible. */
export class MainMenu implements Screen {
  readonly el: HTMLDivElement;
  private garageBtn: HTMLButtonElement;
  private stats: HTMLDivElement;
  private hint: HTMLDivElement;

  constructor(private host: UIHost) {
    const { ctx } = host;
    const play = button('Play', { variant: 'primary', icon: 'play', cls: 'mm-play', sound: 'confirm', onClick: () => ctx.game.play() });
    this.garageBtn = button('Garage', { icon: 'garage', cls: 'mm-garage', sub: 'Paint · wheels · tuning', onClick: () => ctx.game.openGarage() });
    // Click and fly (user request): straight into the air, no driving / boarding / teleport.
    const fly = h('div', { class: 'mm-fly' }, h('div', { class: 'mm-fly-title', text: 'FLY NOW' }));
    const row = h('div', { class: 'mm-fly-row' });
    const planes: [PlaneTypeId, string, string][] = [['prop', '🛩️', 'Prop'], ['bizjet', '🛩️', 'Jet'], ['airliner', '✈️', 'Airliner'], ['jumbo', '✈️', 'Jumbo']];
    for (const [t, em, name] of planes) {
      const b = h('button', { type: 'button', 'aria-label': `Fly the ${name}` }, h('span', { class: 'em', text: em }), h('span', { text: name }));
      b.addEventListener('click', () => ctx.game.quickFly?.(t));
      row.append(b);
    }
    fly.append(row);
    const settings = button('Settings', { icon: 'settings', cls: 'mm-small', onClick: () => host.openSettings() });
    const credits = button('Credits', { icon: 'star', cls: 'mm-small', onClick: () => host.openCredits() });
    this.stats = h('div', { class: 'mm-stats' });
    this.hint = h('div', { class: 'mm-hint' });
    this.el = h(
      'div',
      { class: 'screen main-menu', 'aria-hidden': 'true' },
      h('div', { class: 'mm-scrim' }),
      h(
        'div',
        { class: 'mm-col' },
        logo('logo-menu'),
        h('nav', { class: 'mm-buttons', 'aria-label': 'Main menu' }, play, fly, this.garageBtn, h('div', { class: 'mm-row' }, settings, credits)),
        this.hint,
      ),
      h('div', { class: 'mm-foot' }, this.stats, h('span', { class: 'chip', text: `v${CONFIG.game.version} · seed ${CONFIG.game.seed}` })),
    );
  }

  setVisible(on: boolean): void {
    if (on) this.refresh();
    setVisible(this.el, on);
  }

  private refresh(): void {
    const { ctx } = this.host;
    let carName = '';
    try {
      const model = ctx.save.data.garage.current.model;
      carName = ctx.cars.models?.find((m) => m.id === model)?.name ?? String(model);
    } catch {
      /* cars not ready */
    }
    const sub = this.garageBtn.querySelector('.btn-sub');
    if (sub) sub.textContent = carName ? `Your ride: ${carName}` : 'Paint · wheels · tuning';
    const n = ctx.save.data.stats.explosions;
    this.stats.textContent = '';
    if (n > 0) this.stats.append(h('span', { class: 'chip chip-boom', text: `💥 ${n} explosion${n === 1 ? '' : 's'} so far` }));
    this.hint.textContent = this.host.touchMode()
      ? 'Tip: hold the handbrake while steering to drift'
      : 'WASD / arrows to drive · Space handbrake · X explode';
    // Keep the seed chip accurate (?seed=).
    const chip = this.el.querySelector('.mm-foot .chip:last-child');
    if (chip) chip.textContent = `v${CONFIG.game.version} · seed ${CONFIG.game.seed}`;
  }
}
