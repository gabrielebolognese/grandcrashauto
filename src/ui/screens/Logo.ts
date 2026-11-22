import { CONFIG } from '../../config';
import { h } from '../dom';

/** The game's wordmark: sunburst + striped deco sun + extruded title + rule + tagline. */
export function logo(cls = '', tagline = 'sunny city driving sandbox'): HTMLDivElement {
  const title = CONFIG.game.title.toUpperCase();
  return h(
    'div',
    { class: `logo ${cls}`, role: 'img', 'aria-label': CONFIG.game.title },
    h('div', { class: 'logo-art', 'aria-hidden': 'true' }, h('div', { class: 'logo-burst' }), h('div', { class: 'logo-sun' }), h('div', { class: 'logo-sea' })),
    h('div', { class: 'logo-word', 'aria-hidden': 'true', text: title }),
    h('div', { class: 'logo-rule', 'aria-hidden': 'true' }, h('i'), h('b'), h('i')),
    tagline ? h('div', { class: 'logo-tag', 'aria-hidden': 'true', text: tagline }) : null,
  );
}
