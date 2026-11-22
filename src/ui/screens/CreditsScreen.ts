import { CONFIG } from '../../config';
import { h, setVisible } from '../dom';
import type { Screen, UIHost } from '../host';
import { decoTitle, iconButton, uiSound } from '../widgets';
import { logo } from './Logo';

/** Credits: third-party code and licences; everything else is generated in code. */
export class CreditsScreen implements Screen {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private onBack: () => void = () => {};

  constructor(_host: UIHost) {
    const back = iconButton('back', 'Back', () => this.back(), 'set-back');
    const title = CONFIG.game.title;
    const credit = (name: string, what: string, lic: string) =>
      h('div', { class: 'cr-item' }, h('div', { class: 'cr-name', text: name }), h('div', { class: 'cr-what', text: what }), h('div', { class: 'cr-lic chip', text: lic }));
    this.body = h(
      'div',
      { class: 'cr-body scroll' },
      h('div', { class: 'cr-hero' }, logo('logo-credits', '')),
      h('p', { class: 'cr-lead', text: `${title} is a tiny sunny city to cruise, customise and — occasionally — blow up.` }),
      h('div', { class: 'cr-sec' }, decoTitle('Built with')),
      credit('three.js', '3D rendering · © three.js authors', 'MIT License'),
      credit('Rapier', 'Physics (@dimforge/rapier3d-compat) · © Dimforge', 'Apache License 2.0'),
      credit('Vite & TypeScript', 'Build tooling (not shipped in the game)', 'MIT / Apache-2.0'),
      h('div', { class: 'cr-sec' }, decoTitle('Made in code')),
      h(
        'p',
        { class: 'cr-text' },
        'The city, buildings, roads, cars, pedestrians, animations, textures, sky, ocean, sound effects, engine notes and this interface are all generated procedurally at runtime — no downloaded art, audio or fonts.',
      ),
      h(
        'p',
        { class: 'cr-text' },
        'Every car, brand, place and character is fictional. Any resemblance to real cities or vehicles is a happy accident.',
      ),
      h('div', { class: 'cr-sec' }, decoTitle('Thanks')),
      h('p', { class: 'cr-text' }, 'To everyone who builds open-source tools for the web, and to you for playing.'),
      h('div', { class: 'cr-foot' }, h('span', { class: 'chip', text: `${title} v${CONFIG.game.version}` }), h('span', { class: 'chip', text: 'Full licences in CREDITS.md' })),
    );
    this.el = h(
      'div',
      { class: 'screen credits-screen', 'aria-hidden': 'true', role: 'dialog', 'aria-label': 'Credits' },
      h('div', { class: 'sub-backdrop' }),
      h('div', { class: 'panel cr-panel' }, h('div', { class: 'set-head' }, back, h('div', { class: 'set-title' }, decoTitle('Credits'))), this.body),
    );
  }

  open(onBack: () => void): void {
    this.onBack = onBack;
    this.body.scrollTop = 0;
    this.setVisible(true);
  }

  setVisible(on: boolean): void {
    setVisible(this.el, on);
  }

  back(): boolean {
    uiSound('back');
    this.onBack();
    return true;
  }
}
