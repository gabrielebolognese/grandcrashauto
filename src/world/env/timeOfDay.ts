import * as THREE from 'three';
import { CONFIG } from '../../config';

/** Time-of-day presets (CONFIG.env.tod) parsed into linear colours, and blending between them. */

export type TodName = 'day' | 'sunset' | 'night';

const COLOR_KEYS = [
  'sunColor', 'hemiSky', 'hemiGround', 'zenith', 'skyMid', 'horizon', 'fog', 'ground', 'glow',
  'cloudLit', 'cloudShade', 'waterDeep', 'waterMid', 'waterShallow',
] as const;
const NUMBER_KEYS = [
  'sunElevation', 'sunAzimuth', 'sunIntensity', 'hemiIntensity', 'envIntensity', 'glowStrength', 'sunDisk', 'sunSize',
  'moon', 'stars', 'exposure', 'night', 'bloomStrength', 'bloomThreshold',
] as const;

type ColorKey = (typeof COLOR_KEYS)[number];
type NumberKey = (typeof NUMBER_KEYS)[number];
export type TodState = Record<ColorKey, THREE.Color> & Record<NumberKey, number>;

export function makeState(): TodState {
  const s = {} as TodState;
  for (const k of COLOR_KEYS) s[k] = new THREE.Color();
  for (const k of NUMBER_KEYS) s[k] = 0;
  return s;
}

const colorCache = new Map<string, THREE.Color>();
function parseColor(hex: string): THREE.Color {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex); // sRGB hex → linear working space
    colorCache.set(hex, c);
  }
  return c;
}

/** Read a preset from CONFIG (live-tunable: called every frame, colour strings are cached). */
export function readPreset(name: TodName, out: TodState): TodState {
  const p = CONFIG.env.tod[name] as unknown as Record<string, string | number>;
  for (const k of COLOR_KEYS) out[k].copy(parseColor(String(p[k])));
  for (const k of NUMBER_KEYS) out[k] = Number(p[k]) || 0;
  return out;
}

export function copyState(out: TodState, a: TodState): TodState {
  for (const k of COLOR_KEYS) out[k].copy(a[k]);
  for (const k of NUMBER_KEYS) out[k] = a[k];
  return out;
}

export function lerpState(out: TodState, a: TodState, b: TodState, t: number): TodState {
  for (const k of COLOR_KEYS) out[k].copy(a[k]).lerp(b[k], t);
  for (const k of NUMBER_KEYS) out[k] = a[k] + (b[k] - a[k]) * t;
  // Shortest way around for the azimuth.
  let d = b.sunAzimuth - a.sunAzimuth;
  d = ((((d + 180) % 360) + 360) % 360) - 180;
  out.sunAzimuth = a.sunAzimuth + d * t;
  // The light never dips under the horizon mid-transition.
  const lowest = Math.min(a.sunElevation, b.sunElevation);
  out.sunElevation = Math.max(out.sunElevation, Math.min(lowest, 4));
  return out;
}

/** World direction TO the sun from elevation/azimuth (deg). Azimuth 0 = +Z, 90 = +X. */
export function sunDirection(elevDeg: number, azDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const e = (elevDeg * Math.PI) / 180;
  const a = (azDeg * Math.PI) / 180;
  return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
}
