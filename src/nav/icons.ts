/** Inline SVG icons for the turn card and the map screen (stroke icons, 24×24, currentColor). */
const S = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const NAV_ICONS = {
  straight: S('<path d="M12 20.5V4.5"/><path d="M5.5 10.5 12 4l6.5 6.5"/>'),
  right: S('<path d="M7 21v-7.5A4.5 4.5 0 0 1 11.5 9H20"/><path d="M14.5 3.5 20 9l-5.5 5.5"/>'),
  left: S('<path d="M17 21v-7.5A4.5 4.5 0 0 0 12.5 9H4"/><path d="M9.5 3.5 4 9l5.5 5.5"/>'),
  uturn: S('<path d="M16.5 21V9.5a5 5 0 0 0-10 0V15"/><path d="M2.5 11.5 6.5 15.5l4-4"/>'),
  arrive: S('<path d="M6 21.5V3.5"/><path d="M6 4h11.5l-2.8 4 2.8 4H6" fill="currentColor"/>'),
  close: S('<path d="M6 6l12 12M18 6 6 18"/>'),
  back: S('<path d="M15 5l-7 7 7 7"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  minus: S('<path d="M5 12h14"/>'),
  locate: S('<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  list: S('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>'),
  route: S('<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>'),
  teleport: S('<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><circle cx="12" cy="12" r="3.2"/><path d="M5.6 5.6l2.2 2.2M16.2 16.2l2.2 2.2M5.6 18.4l2.2-2.2M16.2 7.8l2.2-2.2"/>'),
  lock: S('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="2.5"/>'),
  world: S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>'),
} as const;

export type NavIconName = keyof typeof NAV_ICONS;

export function navIcon(name: NavIconName, cls = 'nv-ic'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = NAV_ICONS[name];
  return s;
}
