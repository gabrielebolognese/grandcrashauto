import { cloneBuild, type CarBuild, type SpoilerStyle, type StripeStyle, type TyreProfile, RIM_COUNT } from '../CarBuild';
import { HEADLIGHT_SWATCHES, NEON_SWATCHES, PAINT_SWATCHES, RIM_SWATCHES, hexToHsl, hueDistance, luma } from './palette';
import { quantizeBuild } from './shareCode';

/**
 * "Randomize" (spec §7): tasteful random looks with harmonious colours. Keeps the model and the performance parts
 * (those are deliberate choices, not looks). Colours come from the curated palettes so share codes stay short.
 */

type Rnd = () => number;

const pick = <T>(rnd: Rnd, list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
function weighted<T>(rnd: Rnd, entries: [T, number][]): T {
  const total = entries.reduce((s, e) => s + e[1], 0);
  let r = rnd() * total;
  for (const [v, w] of entries) if ((r -= w) <= 0) return v;
  return entries[entries.length - 1][0];
}

const PAINTS = PAINT_SWATCHES.map((s) => s.hex);
const CHROMATIC = PAINTS.filter((h) => hexToHsl(h)[1] > 0.25 && luma(h) > 0.12 && luma(h) < 0.93);
const NEUTRAL_DARK = ['#1c1c22', '#3e4a5c', '#1f3a68'];
const NEUTRAL_LIGHT = ['#f4f1e8', '#fff4e0', '#d9d2c5'];

/** Palette colour whose hue is closest to `targetHue` while contrasting with `base` in lightness. */
function harmonious(rnd: Rnd, base: string, offset: number, minContrast = 0.18): string {
  const [h] = hexToHsl(base);
  const target = (h + offset + 360) % 360;
  const lb = luma(base);
  const scored = CHROMATIC.filter((c) => c !== base && Math.abs(luma(c) - lb) >= minContrast)
    .map((c) => ({ c, d: hueDistance(hexToHsl(c)[0], target) + rnd() * 25 }))
    .sort((a, b) => a.d - b.d);
  return scored[0]?.c ?? (lb > 0.55 ? pick(rnd, NEUTRAL_DARK) : pick(rnd, NEUTRAL_LIGHT));
}

function contrastNeutral(rnd: Rnd, base: string): string {
  return luma(base) > 0.6 ? pick(rnd, NEUTRAL_DARK) : pick(rnd, NEUTRAL_LIGHT);
}

const PLATE_WORDS = [
  'SUNNY', 'DECO 88', 'PALMS', 'SURF UP', 'WAVES', 'CORAL 9', 'SEA BRZ', 'BEACH 7', 'PASTEL', 'NEON 77', 'SALTY',
  'COAST 1', 'TIDE', 'LAGOON', 'MARINA', 'SHELLS', 'GULL 42', 'BOARDWK', 'DRIFT', 'TURBO', 'VROOM', 'GO FAST',
  'CRUISIN', 'LOWRIDE', 'SUNSET', 'DUNES', 'OCEAN 5', 'PIER 39', 'BREEZY', 'ZOOM',
];

function randomPlate(rnd: Rnd): string {
  if (rnd() < 0.55) return pick(rnd, PLATE_WORDS);
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 3; i++) s += L[Math.floor(rnd() * L.length)];
  s += rnd() < 0.5 ? ' ' : '-';
  for (let i = 0; i < 3; i++) s += Math.floor(rnd() * 10);
  return s;
}

export function randomizeBuild(current: CarBuild, rnd: Rnd = Math.random): CarBuild {
  const b = cloneBuild(current);
  const model = b.model;

  // Body colour + scheme.
  const body = pick(rnd, PAINTS);
  const scheme = weighted(rnd, [['complement', 3], ['analogous', 3], ['triad', 2], ['neutral', 3]] as [string, number][]);
  const accent =
    scheme === 'neutral'
      ? contrastNeutral(rnd, body)
      : harmonious(rnd, body, scheme === 'complement' ? 180 : scheme === 'triad' ? (rnd() < 0.5 ? 120 : -120) : rnd() < 0.5 ? 40 : -40);

  b.paint.color = body;
  b.paint.finish = weighted(rnd, [['metallic', 34], ['gloss', 24], ['pearl', 16], ['matte', 12], ['shift', 14]]);
  b.paint.shiftColor = harmonious(rnd, body, rnd() < 0.5 ? 70 : -70, 0);
  b.paint.twoTone = rnd() < 0.3;
  b.paint.roofColor = rnd() < 0.6 ? contrastNeutral(rnd, body) : accent;
  b.paint.stripes = rnd() < 0.42 ? pick<StripeStyle>(rnd, ['center', 'twin', 'side']) : 'none';
  b.paint.stripeColor = rnd() < 0.65 ? accent : contrastNeutral(rnd, body);
  if (b.paint.stripeColor === body) b.paint.stripeColor = contrastNeutral(rnd, body);

  // Wheels.
  b.wheels.rim = Math.floor(rnd() * RIM_COUNT);
  const rimRoll = rnd();
  b.wheels.rimColor = rimRoll < 0.62 ? pick(rnd, RIM_SWATCHES).hex : rimRoll < 0.85 ? accent : contrastNeutral(rnd, body);
  b.wheels.size = weighted(rnd, [[0, 1], [1, 4], [2, 4]]);
  b.wheels.tyre = model === 'suv' ? weighted<TyreProfile>(rnd, [['mid', 2], ['high', 3]]) : weighted<TyreProfile>(rnd, [['low', 4], ['mid', 4], ['high', 1]]);

  // Body kit.
  b.kit.splitter = rnd() < 0.5;
  b.kit.skirts = rnd() < 0.5;
  b.kit.scoop = rnd() < (model === 'muscle' ? 0.6 : 0.3);
  b.kit.spoiler = weighted<SpoilerStyle>(rnd, [['none', 3], ['lip', 3], ['ducktail', model === 'suv' ? 1 : 2], ['gt', model === 'suv' ? 0.5 : 2]]);

  // Stance (quantized below).
  b.stance.rideHeight = model === 'suv' ? pick(rnd, [-0.2, 0, 0.3, 0.5, 0.7]) : pick(rnd, [-0.7, -0.5, -0.3, -0.2, 0, 0, 0.2]);
  b.stance.camber = pick(rnd, [0, 0, 0.1, 0.2, 0.3, 0.45, 0.6]);

  // Extras.
  b.extras.tint = pick(rnd, [0.1, 0.25, 0.35, 0.5, 0.65, 0.8]);
  b.extras.headlightColor = rnd() < 0.55 ? '#fff6e0' : pick(rnd, HEADLIGHT_SWATCHES).hex;
  if (rnd() < 0.35) {
    // Neon close to the accent hue looks intentional.
    const [ah] = hexToHsl(accent);
    const neon = NEON_SWATCHES.filter((n) => n.hex !== '#ffffff')
      .map((n) => ({ n: n.hex, d: hueDistance(hexToHsl(n.hex)[0], ah) + rnd() * 60 }))
      .sort((a, c) => a.d - c.d);
    b.extras.underglow = neon[0]?.n ?? '#4ff0ff';
  } else b.extras.underglow = null;
  b.extras.plate = randomPlate(rnd);

  return quantizeBuild(b);
}
