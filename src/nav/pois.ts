import type { PointOfInterest } from '../game/contracts';
import type { Pose } from '../world/types';

export type PoiSource = 'city' | 'terrain' | 'highway' | 'saved';

/** A point of interest as the nav module tracks it. `pose` is LOCAL (contract), ax/ay/az are ABSOLUTE. */
export interface NavPoi extends PointOfInterest {
  ax: number;
  ay: number;
  az: number;
  source: PoiSource;
  discovered: boolean;
  /** Present in a live list this refresh (vs only known from the save). */
  live: boolean;
}

const ICON_BY_KEY: [RegExp, string][] = [
  [/airport|apron|terminal/, '✈️'],
  [/garage/, '🔧'],
  [/beach|shore/, '🏖️'],
  [/downtown|city|centre|center/, '🏙️'],
  [/park|garden/, '🌳'],
  [/jump|ramp/, '🚀'],
  [/highway|interchange|motorway/, '🛣️'],
  [/lighthouse/, '🗼'],
  [/pier|fishing|harbou?r|marina/, '🎣'],
  [/summit|viewpoint|peak|lookout/, '🏔️'],
  [/pass/, '⛰️'],
  [/bridge/, '🌉'],
  [/rest|gas|fuel|stop/, '⛽'],
  [/lake/, '🏞️'],
  [/tunnel/, '🚇'],
];

export function iconFor(id: string, name: string, given?: string): string {
  if (given && given.trim()) return given;
  const k = `${id} ${name}`.toLowerCase();
  for (const [re, ic] of ICON_BY_KEY) if (re.test(k)) return ic;
  return '📍';
}

/**
 * save.data.discovered entries: plain ids for city POIs (always regenerated), and for generated POIs an id plus its
 * ABSOLUTE pose / icon / name so teleport works after a reload even before the network regenerates there:
 *   "lighthouse|-3412.5|12.3|-1880.2|1.571|🗼|Lighthouse"
 * Readers that only need ids: entry.split('|')[0].
 */
export function encodeDiscovered(p: NavPoi): string {
  if (p.source === 'city') return p.id;
  const clean = (s: string) => s.replace(/\|/g, '/');
  return [clean(p.id), p.ax.toFixed(1), p.ay.toFixed(1), p.az.toFixed(1), p.pose.yaw.toFixed(3), clean(p.icon), clean(p.name)].join('|');
}

export interface SavedPoi {
  id: string;
  pose?: { ax: number; ay: number; az: number; yaw: number; icon: string; name: string };
}

export function decodeDiscovered(s: string): SavedPoi | null {
  if (typeof s !== 'string' || !s) return null;
  const parts = s.split('|');
  const id = parts[0];
  if (!id) return null;
  if (parts.length < 5) return { id };
  const ax = Number(parts[1]);
  const ay = Number(parts[2]);
  const az = Number(parts[3]);
  const yaw = Number(parts[4]);
  if (![ax, ay, az, yaw].every(Number.isFinite)) return { id };
  return { id, pose: { ax, ay, az, yaw, icon: parts[5] || '📍', name: parts.slice(6).join('|') || id } };
}

export function makePoi(id: string, name: string, icon: string, pose: Pose, ox: number, oz: number, source: PoiSource): NavPoi {
  return {
    id,
    name,
    icon,
    pose: { position: { x: pose.position.x, y: pose.position.y, z: pose.position.z }, yaw: pose.yaw },
    ax: pose.position.x + ox,
    ay: pose.position.y,
    az: pose.position.z + oz,
    source,
    discovered: source === 'city',
    live: source !== 'saved',
  };
}
