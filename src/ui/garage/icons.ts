import type { CarModelId, SpoilerStyle } from '../../vehicle/CarBuild';

/** Inline SVG icons for the garage UI (owner: garage). Stroke icons use currentColor. */

const svg = (body: string, vb = '0 0 24 24', cls = 'gar-ico') =>
  `<svg class="${cls}" viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  car: svg('<path d="M3 15.5v-3l2.2-4.6c.3-.6.9-.9 1.5-.9h9.1c.6 0 1.1.3 1.4.8l3 4.7h.8c.6 0 1 .4 1 1v2"/><path d="M5.2 12h15.2"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>'),
  paint: svg('<path d="M12 3.2s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/><path d="M9.2 14.5a2.8 2.8 0 0 0 2.8 2.8"/>'),
  wheel: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.4"/><path d="M12 3v6.6M12 14.4V21M3.4 9.2l6.3 2M14.3 12.8l6.3 2M6.7 19.3l3.9-5.4M13.4 10.1l3.9-5.4"/>'),
  kit: svg('<path d="M2.5 8.5h19l-1.6 3.2H4.1z"/><path d="M8 11.7v4.8M16 11.7v4.8"/><path d="M4.5 19.5h15"/>'),
  stance: svg('<path d="M4 13.5l2-4h12l2 4"/><path d="M2.5 13.5h19v2.5h-19z"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="18.5" r="2"/><path d="M12 1.8v4.6M10 4.6l2 2 2-2"/>'),
  extras: svg('<path d="M11 3.5l1.7 4.9 4.9 1.7-4.9 1.7L11 16.7l-1.7-4.9-4.9-1.7 4.9-1.7z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>'),
  perf: svg('<path d="M3.5 17a8.5 8.5 0 1 1 17 0"/><path d="M12 17l4.2-5.2"/><circle cx="12" cy="17" r="1.6"/><path d="M6.3 11.2l1 .8M12 8.4v1.3M17.7 11.2l-1 .8"/>'),
  save: svg('<path d="M6.5 3.5h11a1 1 0 0 1 1 1v16l-6.5-4-6.5 4v-16a1 1 0 0 1 1-1z"/>'),
  back: svg('<path d="M14.5 5l-7 7 7 7"/>'),
  dice: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="8.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.2" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.2" fill="currentColor"/>'),
  reset: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.4-5.5"/><path d="M4.5 3.8v4.9h4.9"/>'),
  drive: svg('<path d="M5 5.5l6.5 6.5L5 18.5M12 5.5l6.5 6.5-6.5 6.5"/>'),
  link: svg('<path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  load: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>'),
  store: svg('<path d="M12 20V9M7 13.5l5-5 5 5M5 4h14"/>'),
  trash: svg('<path d="M4.5 7h15M10 7V4.5h4V7M6.8 7l1 12.5h8.4l1-12.5"/>'),
  paste: svg('<rect x="5.5" y="5" width="13" height="16" rx="2.2"/><path d="M9 5V3.5h6V5M9 11h6M9 15h4"/>'),
  off: svg('<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>'),
  bolt: svg('<path d="M13 2.5L5 13.5h6l-1 8 8-11h-6z"/>'),
};

export type IconName = keyof typeof ICONS;

// ───────────────────────────── rims ─────────────────────────────
/** Same order/names as the car models' rim designs (src/vehicle/models/wheels.ts RIM_NAMES). */
export const RIM_NAMES = ['Velo 5', 'Lattice', 'Deep Dish', 'Turbine', 'Split Ten', 'Steelie'];

/** Small procedural rim drawing for each design index (40×40), mirroring the 3D designs. */
export function rimIcon(i: number): string {
  const c = 20;
  const tau = Math.PI * 2;
  const parts: string[] = [`<circle cx="${c}" cy="${c}" r="17" fill="none" stroke="currentColor" stroke-width="3.2"/>`];
  const spoke = (a: number, w: number, r0 = 4, r1 = 15.5) => {
    const ca = Math.cos(a), sa = Math.sin(a);
    return `<line x1="${(c + ca * r0).toFixed(2)}" y1="${(c + sa * r0).toFixed(2)}" x2="${(c + ca * r1).toFixed(2)}" y2="${(c + sa * r1).toFixed(2)}" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/>`;
  };
  switch (i) {
    case 0: // Velo 5: five wide spokes
      for (let k = 0; k < 5; k++) parts.push(spoke((k / 5) * tau - Math.PI / 2, 4.6));
      break;
    case 1: // Lattice: twelve slim spokes
      for (let k = 0; k < 12; k++) parts.push(spoke((k / 12) * tau, 1.6));
      break;
    case 2: // Deep Dish: polished lip + small spoked centre
      parts.push(`<circle cx="${c}" cy="${c}" r="13.6" fill="none" stroke="currentColor" stroke-width="4" opacity=".45"/>`);
      parts.push(`<circle cx="${c}" cy="${c}" r="11" fill="none" stroke="currentColor" stroke-width="1.6"/>`);
      for (let k = 0; k < 8; k++) parts.push(spoke((k / 8) * tau, 2.2, 3.5, 10.5));
      break;
    case 3: // Turbine: ten twisted vanes
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * tau;
        const x0 = c + Math.cos(a) * 5, y0 = c + Math.sin(a) * 5;
        const x1 = c + Math.cos(a + 0.75) * 15, y1 = c + Math.sin(a + 0.75) * 15;
        const qx = c + Math.cos(a + 0.18) * 11.5, qy = c + Math.sin(a + 0.18) * 11.5;
        parts.push(`<path d="M${x0.toFixed(2)} ${y0.toFixed(2)} Q${qx.toFixed(2)} ${qy.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}" stroke="currentColor" stroke-width="2.3" fill="none" stroke-linecap="round"/>`);
      }
      break;
    case 4: // Split Ten: five split pairs
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * tau - Math.PI / 2;
        parts.push(spoke(a - 0.16, 1.9), spoke(a + 0.16, 1.9));
      }
      break;
    default: // Steelie: solid disc with eight round holes
      parts.push(`<circle cx="${c}" cy="${c}" r="15" fill="currentColor" opacity=".9"/>`);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * tau + Math.PI / 8;
        parts.push(`<circle cx="${(c + Math.cos(a) * 9.4).toFixed(2)}" cy="${(c + Math.sin(a) * 9.4).toFixed(2)}" r="2" fill="var(--gar-chipbg, #fff)"/>`);
      }
      parts.push(`<circle cx="${c}" cy="${c}" r="4.2" fill="var(--gar-chipbg, #fff)"/><circle cx="${c}" cy="${c}" r="2.4" fill="currentColor"/>`);
  }
  parts.push(`<circle cx="${c}" cy="${c}" r="2.6" fill="currentColor"/>`);
  return `<svg class="gar-rimico" viewBox="0 0 40 40" aria-hidden="true">${parts.join('')}</svg>`;
}

// ───────────────────────────── spoilers / kit ─────────────────────────────
export function spoilerIcon(s: SpoilerStyle): string {
  const body = '<path d="M4 26 L4 19 Q6 16 14 15.5 L34 14.5" stroke-width="2.2"/>';
  const extra: Record<SpoilerStyle, string> = {
    none: '',
    lip: '<path d="M33 14.5 L38 13" stroke-width="3"/>',
    ducktail: '<path d="M28 14.8 Q36 14 40 9.5" stroke-width="3"/>',
    gt: '<path d="M26 14.8 L27 8.5 M35 14.2 L36 8.5" stroke-width="1.8"/><path d="M22 8.5 L42 7.5 L41 5 L23 6 Z" fill="currentColor" stroke-width="1.4"/>',
  };
  return svg(`${body}${extra[s]}<path d="M2 26h44" stroke-width="1.4" opacity=".35"/>`, '0 0 48 28', 'gar-kitico');
}

export function kitIcon(kind: 'splitter' | 'skirts' | 'scoop'): string {
  if (kind === 'splitter')
    return svg('<path d="M44 22 L44 15 Q42 12 34 11.5 L12 11" stroke-width="2.2"/><path d="M30 23.5 L46 23.5" stroke-width="3.4"/><path d="M2 26h44" stroke-width="1.4" opacity=".35"/>', '0 0 48 28', 'gar-kitico');
  if (kind === 'skirts')
    return svg('<path d="M4 19 Q6 12 16 11 L32 11 Q42 12 44 19" stroke-width="2.2"/><circle cx="11" cy="21" r="3.5" stroke-width="2"/><circle cx="37" cy="21" r="3.5" stroke-width="2"/><path d="M15.5 22.5 L32.5 22.5" stroke-width="3.4"/>', '0 0 48 28', 'gar-kitico');
  return svg('<path d="M3 20 Q6 15 18 14 L46 13" stroke-width="2.2"/><path d="M24 13.6 L27 9.5 L36 9.5 L37 13.2" fill="currentColor" stroke-width="1.6"/><path d="M2 26h44" stroke-width="1.4" opacity=".35"/>', '0 0 48 28', 'gar-kitico');
}

// ───────────────────────────── model silhouettes ─────────────────────────────
const SILHOUETTES: Record<CarModelId, { body: string; wheels: [number, number][]; glass: string }> = {
  coupe: {
    body: 'M7 33 L8 27 Q10 23.5 26 22 L42 14.5 Q56 10 72 12 L90 20.5 Q107 21.5 112 26 L113 33 Z',
    glass: 'M45 15.5 Q56 12 70 13.5 L83 20 L42 21 Z',
    wheels: [[29, 33], [93, 33]],
  },
  muscle: {
    body: 'M5 33 L6 25.5 Q8 22 24 21.5 L46 20.5 L58 12.5 Q70 10.5 82 13 L98 21 Q111 21.5 115 25.5 L115 33 Z',
    glass: 'M60 13.5 Q70 11.8 80 14 L91 20.5 L56 20.8 Z',
    wheels: [[26, 33], [96, 33]],
  },
  hatch: {
    body: 'M13 33 L14 25.5 Q17 21 30 20 L43 11.5 Q60 8 86 9.5 L95 11.5 Q101 18 103 24.5 L103 33 Z',
    glass: 'M46 12.5 Q60 9.6 84 10.8 L92 19.5 L36 20 Z',
    wheels: [[32, 33], [88, 33]],
  },
  suv: {
    body: 'M8 34 L8 22.5 Q10 19 22 18 L34 8 Q60 6 98 6.8 L107 8.8 Q111 15 112.5 22 L112.5 34 Z',
    glass: 'M37 9 Q60 7.4 96 8 L102 17 L26 17.6 Z',
    wheels: [[29, 34], [93, 34]],
  },
};

export function modelSilhouette(id: CarModelId): string {
  const s = SILHOUETTES[id] ?? SILHOUETTES.coupe;
  const wheels = s.wheels
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7.4" class="gar-sil-tyre"/><circle cx="${x}" cy="${y}" r="3.4" class="gar-sil-rim"/>`)
    .join('');
  return `<svg class="gar-sil" viewBox="0 0 120 44" aria-hidden="true"><ellipse cx="60" cy="40.5" rx="52" ry="2.6" class="gar-sil-shadow"/><path d="${s.body}" class="gar-sil-body"/><path d="${s.glass}" class="gar-sil-glass"/>${wheels}</svg>`;
}
