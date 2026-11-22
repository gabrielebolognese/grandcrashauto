/** Tiny DOM helpers for the UI module (no framework). */

export type Child = Node | string | number | null | undefined | false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (e: any) => void;
export type Attrs = Record<string, string | number | boolean | Handler | null | undefined>;

/**
 * h('button', { class: 'btn', onClick: fn, 'aria-label': 'x' }, 'Label', child)
 *  - `on*` keys with function values become event listeners (onPointerDown → 'pointerdown')
 *  - `class`, `text`, `html`, `style` are shortcuts; `true` sets an empty attribute; false/null/undefined are skipped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k.length > 2 && k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'style') el.style.cssText = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: (Child | Child[])[]): void {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Parse an SVG/HTML string into a single element. */
export function frag(html: string): Element {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as Element;
}

export function setVisible(el: HTMLElement, on: boolean): void {
  el.classList.toggle('visible', on);
  el.setAttribute('aria-hidden', on ? 'false' : 'true');
}

/** Only touch the DOM when the text actually changes (HUD runs every frame). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export const isEditable = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export const isTouchPrimary = (): boolean =>
  matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1 && !matchMedia('(pointer: fine)').matches;
