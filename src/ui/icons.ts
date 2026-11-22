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
  map: svg('<path d="M3.5 6.5l5.5-2 6 2 5.5-2v13l-5.5 2-6-2-5.5 2z"/><path d="M9 4.5v13M15 6.5v13"/>'),
  plane: svg('<path d="M12 2.8c.9 0 1.5.8 1.5 2v4.6l7 4.1v2l-7-2.1v4l2.2 1.7v1.6L12 19.8l-3.7.9v-1.6l2.2-1.7v-4l-7 2.1v-2l7-4.1V4.8c0-1.2.6-2 1.5-2z" fill="currentColor" stroke="none"/>'),
  flame: svg('<path d="M12 2.5c.6 3.2 4.8 5.6 4.8 10.3A4.8 4.8 0 0 1 12 17.6a4.8 4.8 0 0 1-4.8-4.8c0-2.2 1.1-3.7 2.3-4.8.2 1.6.9 2.6 1.9 3.1-.3-3.2.2-6 .6-8.6z" fill="currentColor" stroke="none"/><path d="M12 21.5a3 3 0 0 0 3-3c0-1.6-1.4-2.6-1.9-4-.9 1.2-2.1 1.8-2.1 1.8s-2 .6-2 2.2a3 3 0 0 0 3 3z" fill="rgba(255,255,255,.55)" stroke="none"/>'),
  split: svg('<path d="M2.5 12h6M15.5 12h6"/><path d="M9 7.5l2 3-1.4 1.5 1.4 1.5-2 3"/><path d="M15 7.5l-2 3 1.4 1.5-1.4 1.5 2 3"/><circle cx="12" cy="4" r="1" fill="currentColor"/><circle cx="12" cy="20" r="1" fill="currentColor"/>'),
  tail: svg('<path d="M3 15h10l3-8h3l-1.5 8H21v2H3z"/><path d="M14 4l1.5-1.5M18 4.5l1-2M10 6l.5-2"/>'),
  skip: svg('<path d="M5 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor" stroke="none"/>'),
  headlight: svg('<path d="M10 6.5c-3.6 0-6 2.4-6 5.5s2.4 5.5 6 5.5c1 0 1.5-.6 1.5-1.5v-8c0-.9-.5-1.5-1.5-1.5z"/><path d="M14.5 8l6-1.5M14.5 12h6.5M14.5 16l6 1.5"/>'),
  cloud: svg('<path d="M7 18.5h10.5a4 4 0 0 0 .4-8A6 6 0 0 0 6.4 9.6 4.5 4.5 0 0 0 7 18.5z"/>'),
  rain: svg('<path d="M7 14.5h10.5a3.6 3.6 0 0 0 .4-7.2A5.5 5.5 0 0 0 6.6 6.5 4 4 0 0 0 7 14.5z"/><path d="M8 17.5l-1 2.5M12 17.5l-1 2.5M16 17.5l-1 2.5"/>'),
  storm: svg('<path d="M7 13.5h10.5a3.6 3.6 0 0 0 .4-7.2A5.5 5.5 0 0 0 6.6 5.5 4 4 0 0 0 7 13.5z"/><path d="M12.5 13.5l-2.5 4h3.5l-2 4" stroke-width="2.4"/>'),
  fog: svg('<path d="M3.5 9h17M5.5 13h13M3.5 17h17"/>'),
  snow: svg('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5L12 6l2.5-1.5M9.5 19.5L12 18l2.5 1.5"/>'),
  gear: svg('<circle cx="12" cy="15" r="4.5"/><circle cx="12" cy="15" r="1.5"/><path d="M12 10.5V3.5M9 6.5l3-3 3 3"/>'),
  brakeDisc: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M17.5 5.5l2-2M6.5 18.5l-2 2"/>'),
  crack: svg('<path d="M12 3l-2 5 3 2.5-3.5 3 2.5 2.5-1.5 5"/>', 'stroke-width="2.6"'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/>'),
  car: svg('<path d="M4 16.5v-3.2l1.6-4.3A2 2 0 0 1 7.5 7.7h9a2 2 0 0 1 1.9 1.3l1.6 4.3v3.2z"/><circle cx="7.8" cy="16.8" r="1.8"/><circle cx="16.2" cy="16.8" r="1.8"/><path d="M5.5 12.5h13"/>'),
} as const;

export type IconName = keyof typeof ICON;

export function icon(name: IconName, cls = 'ic'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = ICON[name];
  return s;
}
