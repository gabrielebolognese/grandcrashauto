import * as THREE from 'three';
import { CONFIG } from '../../config';

/**
 * Sky + light palette (SPEC §5 look, PART3 §5/§6): keyframes by sun elevation (CONFIG.env.keys) blended smoothly,
 * then weather applied on top (cloud cover greys + flattens the light, storms darken, fog thickens & greys).
 * All colours are linear (hex strings in config are sRGB).
 */

const COLOR_KEYS = [
  'zenith', 'skyMid', 'horizon', 'fog', 'ground', 'glow', 'sunColor', 'hemiSky', 'hemiGround',
  'cloudLit', 'cloudShade', 'waterDeep', 'waterMid', 'waterShallow',
] as const;
const NUMBER_KEYS = [
  'glowStrength', 'sunIntensity', 'sunDisk', 'sunSize', 'hemiIntensity', 'envIntensity', 'exposure',
  'bloomStrength', 'bloomThreshold', 'stars', 'night',
] as const;

type ColorKey = (typeof COLOR_KEYS)[number];
type NumberKey = (typeof NUMBER_KEYS)[number];
export type Palette = Record<ColorKey, THREE.Color> & Record<NumberKey, number>;

export function makePalette(): Palette {
  const p = {} as Palette;
  for (const k of COLOR_KEYS) p[k] = new THREE.Color();
  for (const k of NUMBER_KEYS) p[k] = 0;
  return p;
}

const cache = new Map<string, THREE.Color>();
function col(hex: unknown): THREE.Color {
  const s = String(hex);
  let c = cache.get(s);
  if (!c) {
    c = new THREE.Color(s);
    cache.set(s, c);
  }
  return c;
}

type Key = Record<string, string | number> & { el: number };

/** Palette for a sun elevation (degrees). Reads CONFIG every call (live tuning). */
export function samplePalette(elevation: number, out: Palette): Palette {
  const keys = CONFIG.env.keys as unknown as Key[];
  let i = 0;
  while (i < keys.length - 2 && elevation > keys[i + 1].el) i++;
  const a = keys[i];
  const b = keys[Math.min(keys.length - 1, i + 1)];
  let t = b.el === a.el ? 0 : (elevation - a.el) / (b.el - a.el);
  t = THREE.MathUtils.clamp(t, 0, 1);
  t = t * t * (3 - 2 * t);
  for (const k of COLOR_KEYS) out[k].copy(col(a[k])).lerp(col(b[k]), t);
  for (const k of NUMBER_KEYS) out[k] = (Number(a[k]) || 0) + ((Number(b[k]) || 0) - (Number(a[k]) || 0)) * t;
  return out;
}

const _grey = new THREE.Color();
const _tmp = new THREE.Color();

function lum(c: THREE.Color): number {
  return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
}

/** Desaturate `c` toward a cool grey of the same luminance × k, by amount t. */
function greyish(c: THREE.Color, t: number, k = 1, tint = 0.04): void {
  const l = lum(c) * k;
  _grey.setRGB(l * (1 - tint), l, l * (1 + tint));
  c.lerp(_grey, t);
}

export interface WeatherMix {
  cover: number;
  rain: number;
  storm: number;
  fog: number;
}

/** Weather on top of the clear-sky palette (in place). */
export function applyWeather(p: Palette, w: WeatherMix): void {
  const oc = THREE.MathUtils.smoothstep(w.cover, 0.35, 1.0); // overcast-ness
  const dark = 1 - 0.32 * oc - 0.3 * w.storm - 0.1 * w.rain;
  // Sky turns to a soft grey dome; storms go slate.
  for (const k of ['zenith', 'skyMid', 'horizon', 'glow'] as const) greyish(p[k], oc * 0.85, dark * (k === 'zenith' ? 1.25 : 1.0));
  p.zenith.lerp(p.skyMid, oc * 0.6);
  p.glowStrength *= 1 - 0.75 * oc;
  p.sunDisk *= 1 - THREE.MathUtils.smoothstep(w.cover, 0.55, 0.92);
  p.stars *= 1 - THREE.MathUtils.smoothstep(w.cover, 0.3, 0.8);
  // Flat grey light: weak sun, stronger & greyer ambient.
  p.sunIntensity *= 1 - 0.88 * oc - 0.08 * w.storm;
  greyish(p.sunColor, oc * 0.6);
  greyish(p.hemiSky, oc * 0.7);
  greyish(p.hemiGround, oc * 0.5);
  p.hemiIntensity *= (1 + 0.3 * oc) * dark;
  p.envIntensity *= 1 + 0.2 * oc;
  // Fog and haze: grey, a bit darker in storms.
  greyish(p.fog, Math.max(oc * 0.8, w.fog * 0.7), dark * (1 - 0.1 * w.fog));
  greyish(p.ground, oc * 0.6, dark);
  // Clouds: from white cumulus to grey rain clouds.
  greyish(p.cloudLit, oc * 0.6, 0.75 + 0.25 * dark);
  greyish(p.cloudShade, oc * 0.5, dark);
  _tmp.copy(p.cloudShade).multiplyScalar(0.55);
  p.cloudShade.lerp(_tmp, w.storm);
  // Sea: greyer and darker under heavy skies.
  greyish(p.waterMid, oc * 0.45, dark);
  greyish(p.waterDeep, oc * 0.35, dark);
  greyish(p.waterShallow, oc * 0.4, dark);
  // Darker exposure balance in rain (slight desaturation comes from the grey light), lights come on in storms.
  p.exposure *= 1 + 0.06 * oc - 0.05 * w.storm;
  p.night = Math.max(p.night, 0.55 * w.storm + 0.25 * w.rain * oc);
  p.bloomThreshold *= 1 - 0.15 * oc;
}

export function copyPalette(out: Palette, a: Palette): Palette {
  for (const k of COLOR_KEYS) out[k].copy(a[k]);
  for (const k of NUMBER_KEYS) out[k] = a[k];
  return out;
}

export function lerpPalette(out: Palette, a: Palette, b: Palette, t: number): Palette {
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of NUMBER_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
