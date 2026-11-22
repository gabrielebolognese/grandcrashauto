/**
 * Curated colours for the garage (owner: garage). All values are lowercase '#rrggbb' (the form normalizeBuild produces).
 *
 * SHARE_PALETTE_V1 is part of the share-code format (version 1): a colour found in it is encoded as a 6-bit index
 * instead of 24 bits. NEVER reorder or edit existing entries — only append (max 64), or bump the share version.
 */

export interface Swatch {
  hex: string;
  name: string;
}

/** Body paint swatches (sunny coastal pastels → bold classics → neutrals). */
export const PAINT_SWATCHES: readonly Swatch[] = [
  { hex: '#e8574a', name: 'Sunset Red' },
  { hex: '#ff7a6b', name: 'Coral' },
  { hex: '#ff8fb1', name: 'Flamingo' },
  { hex: '#ffb38a', name: 'Peach' },
  { hex: '#f2b134', name: 'Marigold' },
  { hex: '#ffe39a', name: 'Butter' },
  { hex: '#f3dcb2', name: 'Sand' },
  { hex: '#fff4e0', name: 'Cream' },
  { hex: '#9ee0c8', name: 'Mint' },
  { hex: '#4f9a5a', name: 'Palm' },
  { hex: '#2f6b4f', name: 'Racing Green' },
  { hex: '#5cc8d6', name: 'Aqua' },
  { hex: '#4fb6c9', name: 'Lagoon' },
  { hex: '#8fd0ec', name: 'Sky' },
  { hex: '#2aa3c4', name: 'Sea' },
  { hex: '#146c94', name: 'Deep Sea' },
  { hex: '#1f3a68', name: 'Navy' },
  { hex: '#b8a6e8', name: 'Lilac' },
  { hex: '#6a4cff', name: 'Ultraviolet' },
  { hex: '#c0507a', name: 'Raspberry' },
  { hex: '#7a2e3a', name: 'Burgundy' },
  { hex: '#f4f1e8', name: 'Pearl White' },
  { hex: '#d9d2c5', name: 'Stone' },
  { hex: '#8a8f99', name: 'Silver Grey' },
  { hex: '#3e4a5c', name: 'Slate' },
  { hex: '#1c1c22', name: 'Jet' },
];

export const RIM_SWATCHES: readonly Swatch[] = [
  { hex: '#c9ccd2', name: 'Silver' },
  { hex: '#e9edf2', name: 'Chrome' },
  { hex: '#5a5f69', name: 'Gunmetal' },
  { hex: '#1c1c22', name: 'Black' },
  { hex: '#d4b06a', name: 'Gold' },
  { hex: '#b87333', name: 'Bronze' },
  { hex: '#f4f1e8', name: 'White' },
];

export const HEADLIGHT_SWATCHES: readonly Swatch[] = [
  { hex: '#fff6e0', name: 'Warm' },
  { hex: '#ffffff', name: 'Pure' },
  { hex: '#e0f0ff', name: 'Xenon' },
  { hex: '#b8f0ff', name: 'Ice' },
  { hex: '#ffe39a', name: 'Golden' },
  { hex: '#ffb38a', name: 'Amber' },
  { hex: '#d6c8ff', name: 'Lilac' },
  { hex: '#c8ffd8', name: 'Mint' },
];

export const NEON_SWATCHES: readonly Swatch[] = [
  { hex: '#ff4fa3', name: 'Hot Pink' },
  { hex: '#4ff0ff', name: 'Cyan' },
  { hex: '#b06bff', name: 'Violet' },
  { hex: '#7cff6b', name: 'Lime' },
  { hex: '#ff7a3c', name: 'Tangerine' },
  { hex: '#ffe14f', name: 'Lemon' },
  { hex: '#4f7dff', name: 'Electric Blue' },
  { hex: '#ff3b3b', name: 'Red' },
  { hex: '#ffffff', name: 'White' },
];

/** Frozen v1 share palette (append-only, ≤ 64 entries). */
export const SHARE_PALETTE_V1: readonly string[] = [
  // paint (26)
  '#e8574a', '#ff7a6b', '#ff8fb1', '#ffb38a', '#f2b134', '#ffe39a', '#f3dcb2', '#fff4e0', '#9ee0c8', '#4f9a5a',
  '#2f6b4f', '#5cc8d6', '#4fb6c9', '#8fd0ec', '#2aa3c4', '#146c94', '#1f3a68', '#b8a6e8', '#6a4cff', '#c0507a',
  '#7a2e3a', '#f4f1e8', '#d9d2c5', '#8a8f99', '#3e4a5c', '#1c1c22',
  // rims (5 new)
  '#c9ccd2', '#e9edf2', '#5a5f69', '#d4b06a', '#b87333',
  // headlights (6 new)
  '#fff6e0', '#ffffff', '#e0f0ff', '#b8f0ff', '#d6c8ff', '#c8ffd8',
  // neon (7 new)
  '#ff4fa3', '#4ff0ff', '#b06bff', '#7cff6b', '#ff7a3c', '#ffe14f', '#4f7dff',
  '#ff3b3b',
];

const NAME_BY_HEX = new Map<string, string>();
for (const list of [NEON_SWATCHES, HEADLIGHT_SWATCHES, RIM_SWATCHES, PAINT_SWATCHES]) for (const s of list) NAME_BY_HEX.set(s.hex, s.name);

/** Human name for a curated colour, or the hex code for custom colours. */
export function colorName(hex: string): string {
  return NAME_BY_HEX.get(hex.toLowerCase()) ?? hex.toUpperCase();
}

// ── tiny colour helpers (no THREE dependency so the share code / randomizer can run anywhere) ──
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** → [h 0..360, s 0..1, l 0..1] */
export function hexToHsl(hex: string): [number, number, number] {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = r8 / 255, g = g8 / 255, b = b8 / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Relative luminance-ish lightness 0..1 (fast, perceptual enough for UI contrast decisions). */
export function luma(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
