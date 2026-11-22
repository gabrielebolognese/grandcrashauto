import { CONFIG } from '../../config';
import { h } from '../dom';

/** Split a title into ≤ 2 balanced lines (for narrow placements like the menu column). */
export function titleLines(title: string): string[] {
  const words = title.trim().split(/\s+/);
  if (words.length < 2 || title.length <= 10) return [title];
  let best = [title];
  let bestLen = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const m = Math.max(a.length, b.length);
    if (m < bestLen) {
      bestLen = m;
      best = [a, b];
    }
  }
  return best;
}

/**
 * The game's wordmark: sunburst + striped deco sun + extruded title + rule + tagline. Works for any
 * CONFIG.game.title length: CSS fits the font size to the available width (--fit) using the character counts
 * --c1 (one line) and --c2 (longest of two balanced lines, used by narrow variants).
 */
export function logo(cls = '', tagline = 'sunny city driving sandbox'): HTMLDivElement {
  const title = CONFIG.game.title.toUpperCase();
  const lines = titleLines(title);
  const c2 = Math.max(...lines.map((l) => l.length));
  return h(
    'div',
    { class: `logo ${cls}`, role: 'img', 'aria-label': CONFIG.game.title },
    h('div', { class: 'logo-art', 'aria-hidden': 'true' }, h('div', { class: 'logo-burst' }), h('div', { class: 'logo-sun' })),
    h('div', { class: 'logo-word', 'aria-hidden': 'true', style: `--c1:${title.length};--c2:${c2}` }, ...lines.map((l) => h('span', { class: 'lw-line', text: l }))),
    h('div', { class: 'logo-rule', 'aria-hidden': 'true' }, h('i'), h('b'), h('i')),
    tagline ? h('div', { class: 'logo-tag', 'aria-hidden': 'true', text: tagline }) : null,
  );
}
