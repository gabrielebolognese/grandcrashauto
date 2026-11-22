/** Original inline SVG icons (24×24, stroke = currentColor). */

const svg = (body: string, extra = ''): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${extra}>${body}</svg>`;

export const ICON = {
  camera: svg('<path d="M3.5 8.5h3.2l1.8-2.8h7l1.8 2.8h3.2v10.3h-17z"/><circle cx="12" cy="13.3" r="3.4"/>'),
  horn: svg('<path d="M3.5 10v4h3.2l6.3 4.2V5.8L6.7 10z"/><path d="M16.3 9a4.4 4.4 0 0 1 0 6"/><path d="M18.8 6.4a8 8 0 0 1 0 11.2"/>'),
  pause: svg('<path d="M9 5.5v13M15 5.5v13" stroke-width="3"/>'),
  play: svg('<path d="M8 5.2l11 6.8-11 6.8z" fill="currentColor"/>'),
  fullscreen: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  fullscreenExit: svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>'),
  back: svg('<path d="M14.5 5l-7 7 7 7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  left: svg('<path d="M15 4.5L7.5 12l7.5 7.5" stroke-width="3"/>'),
  right: svg('<path d="M9 4.5l7.5 7.5L9 19.5" stroke-width="3"/>'),
  lookBack: svg('<rect x="3" y="6.5" width="18" height="8" rx="4"/><path d="M12 14.5v4M8.5 19h7"/><path d="M8 10.5h8"/>'),
  garage: svg('<path d="M3 10.5L12 4.5l9 6V20H3z"/><path d="M7 20v-6.5h10V20M7 16.5h10"/>'),
  settings: svg('<path d="M4 7h9M18 7h2M4 17h3M12 17h8"/><circle cx="15.5" cy="7" r="2.4"/><circle cx="9.5" cy="17" r="2.4"/>'),
  star: svg('<path d="M12 3.5l2.5 5.4 5.9.7-4.4 4 1.2 5.8L12 16.6l-5.2 2.8 1.2-5.8-4.4-4 5.9-.7z"/>'),
  flip: svg('<path d="M4.5 11a7.5 7.5 0 0 1 13.4-4.2L19.5 8.5"/><path d="M19.5 3.8v4.7h-4.7"/><path d="M19.5 13a7.5 7.5 0 0 1-13.4 4.2L4.5 15.5"/><path d="M4.5 20.2v-4.7h4.7"/>'),
  reset: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 3.8v4.7h4.7"/>'),
  home: svg('<path d="M4 11l8-6.5 8 6.5"/><path d="M6 9.5V20h12V9.5"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>'),
  sunset: svg('<path d="M7 16a5 5 0 0 1 10 0"/><path d="M3 16h18M6 19.5h12"/><path d="M12 4.5v3M5.2 8.8l1.8 1.8M18.8 8.8L17 10.6"/>'),
  moon: svg('<path d="M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z"/>'),
  wheel: svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M3.8 10.5c3 .9 5.4 1 8.2 1s5.2-.1 8.2-1M12 14.2v6.2"/>'),
  handbrake: svg('<path d="M7 20l7.5-13"/><rect x="12" y="2.8" width="6.5" height="5.2" rx="2.4" transform="rotate(30 15.2 5.4)"/><path d="M4.5 20h7"/>'),
  sliderSteer: svg('<rect x="3" y="9" width="18" height="6" rx="3"/><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/>'),
  arrows: svg('<path d="M9 6L3.5 12 9 18M15 6l5.5 6-5.5 6"/>'),
  phoneTilt: svg('<rect x="4" y="7" width="16" height="10" rx="2.4" transform="rotate(-14 12 12)"/><path d="M2.5 20.5c3-1.6 6-2.2 9.5-2.2s6.5.6 9.5 2.2"/>'),
  volume: svg('<path d="M4 10v4h3.5L13 18.5V5.5L7.5 10z"/><path d="M16.5 9a4.2 4.2 0 0 1 0 6M19 6.5a7.8 7.8 0 0 1 0 11"/>'),
  mute: svg('<path d="M4 10v4h3.5L13 18.5V5.5L7.5 10z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>'),
  trash: svg('<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>'),
  controller: svg('<path d="M7 8h10a4.5 4.5 0 0 1 4.3 5.8l-1 3.4a2.4 2.4 0 0 1-4.1.9L14.5 16h-5l-1.7 2.1a2.4 2.4 0 0 1-4.1-.9l-1-3.4A4.5 4.5 0 0 1 7 8z"/><path d="M7.5 11v3M6 12.5h3"/><circle cx="16" cy="11.5" r=".6" fill="currentColor"/><circle cx="17.5" cy="13.5" r=".6" fill="currentColor"/>'),
  keyboard: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.4"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M7.5 14h9"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12" rx="2.4"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>'),
  bolt: svg('<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" fill="currentColor" stroke="none"/>'),
  pin: svg('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
} as const;

export type IconName = keyof typeof ICON;

export function icon(name: IconName, cls = 'ic'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = ICON[name];
  return s;
}
