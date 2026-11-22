import { h, setVisible } from '../dom';
import type { Screen, UIHost } from '../host';
import { icon } from '../icons';
import { button, decoTitle } from '../widgets';

const KEYS: [string, string][] = [
  ['W A S D', 'Drive / steer'],
  ['Space', 'Handbrake'],
  ['H', 'Horn'],
  ['C', 'Camera'],
  ['Q', 'Look back'],
  ['X', 'Explode'],
  ['R', 'Reset car'],
  ['F', 'Flip car'],
  ['Esc', 'Pause'],
];
const PAD: [string, string][] = [
  ['RT / LT', 'Gas / brake'],
  ['L-stick', 'Steer'],
  ['X / RB', 'Handbrake'],
  ['Y', 'Explode'],
  ['B', 'Reset car'],
  ['R3', 'Camera'],
  ['LB', 'Look back'],
  ['Start', 'Pause'],
];

/** Pause menu: Resume, Garage, Reset car, Settings, Main menu (+ control hints on desktop). */
export class PauseMenu implements Screen {
  readonly el: HTMLDivElement;
  private hints: HTMLDivElement;
  private stats: HTMLDivElement;
  private resetBtn: HTMLButtonElement;

  constructor(private host: UIHost) {
    const { ctx } = host;
    const g = ctx.game;
    const resume = button('Resume', { variant: 'primary', icon: 'play', cls: 'pm-resume', sound: 'confirm', onClick: () => g.resume() });
    const garage = button('Garage', { icon: 'garage', onClick: () => g.openGarage() });
    const reset = (this.resetBtn = button('Reset car', {
      icon: 'reset',
      onClick: () => {
        g.resume();
        g.requestReset();
      },
    }));
    const map = button('Map', { icon: 'map', onClick: () => ctx.nav?.openMap?.() });
    const world = button('Time & weather', { icon: 'sunset', onClick: () => host.openSettings('world') });
    const settings = button('Settings', { icon: 'settings', onClick: () => host.openSettings() });
    const menu = button('Main menu', { icon: 'home', variant: 'ghost', sound: 'back', onClick: () => g.toMainMenu() });
    this.stats = h('div', { class: 'pm-stats' });
    this.hints = h(
      'div',
      { class: 'panel pm-hints' },
      h('div', { class: 'pm-hints-col' }, h('div', { class: 'pm-hint-h' }, icon('keyboard'), h('span', { text: 'Keyboard' })), ...KEYS.map(([k, v]) => hintRow(k, v))),
      h('div', { class: 'pm-hints-col' }, h('div', { class: 'pm-hint-h' }, icon('controller'), h('span', { text: 'Gamepad' })), ...PAD.map(([k, v]) => hintRow(k, v))),
    );
    this.el = h(
      'div',
      { class: 'screen pause-menu', 'aria-hidden': 'true' },
      h('div', { class: 'pm-backdrop' }),
      h(
        'div',
        { class: 'pm-wrap' },
        h('div', { class: 'panel pm-panel' }, decoTitle('Paused'), h('div', { class: 'pm-grid' }, resume, garage, reset, map, world, settings, menu), this.stats),
        this.hints,
      ),
    );
  }

  setVisible(on: boolean): void {
    if (on) {
      this.hints.style.display = this.host.touchMode() ? 'none' : '';
      const lbl = this.resetBtn.querySelector('.btn-label');
      if (lbl) lbl.textContent = this.host.ctx.game.mode === 'plane' ? 'Respawn plane' : 'Reset car';
      const n = this.host.ctx.save.data.stats.explosions;
      this.stats.textContent = n > 0 ? `💥 ${n} explosion${n === 1 ? '' : 's'} and counting` : 'Nothing exploded yet. Yet.';
    }
    setVisible(this.el, on);
  }

  back(): boolean {
    this.host.ctx.game.resume();
    return true;
  }
}

function hintRow(keys: string, label: string): HTMLDivElement {
  return h('div', { class: 'pm-hint' }, h('span', { class: 'pm-keys' }, ...keys.split(' / ').flatMap((k, i) => [i ? ' / ' : null, h('kbd', { text: k })])), h('span', { text: label }));
}
