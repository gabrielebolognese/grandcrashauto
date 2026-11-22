import type { CityData } from '../types';
import type { HeightField } from '../HeightField';
import type { CityLayout, Island } from './model';
import type { PedBuilder } from './ped';

/** Grid intersection node (i = X_LINES index, j = Z_LINES index). arms: N, E, S, W. */
export interface GridNode {
  id: number;
  i: number;
  j: number;
  x: number;
  z: number;
  arms: [boolean, boolean, boolean, boolean];
  /** Asphalt half widths of the x-street (across x) and z-street (across z) at this node. */
  hx: number;
  hz: number;
  swX: number;
  swZ: number;
  signal: boolean;
}

/** Simple 2D spatial hash of discs for overlap tests. */
export class DiscSet {
  private cells = new Map<number, number[]>();
  constructor(private cell = 8) {}
  private k(ix: number, iz: number) {
    return (ix + 4096) * 8192 + (iz + 4096);
  }
  add(x: number, z: number, r: number): void {
    const c = this.cell;
    const ix = Math.floor(x / c), iz = Math.floor(z / c);
    const key = this.k(ix, iz);
    let a = this.cells.get(key);
    if (!a) this.cells.set(key, (a = []));
    a.push(x, z, r);
  }
  free(x: number, z: number, r: number): boolean {
    const c = this.cell;
    const ix = Math.floor(x / c), iz = Math.floor(z / c);
    const span = Math.ceil((r + 4) / c);
    for (let dz = -span; dz <= span; dz++)
      for (let dx = -span; dx <= span; dx++) {
        const a = this.cells.get(this.k(ix + dx, iz + dz));
        if (!a) continue;
        for (let i = 0; i < a.length; i += 3) {
          const rr = r + a[i + 2];
          if ((a[i] - x) ** 2 + (a[i + 1] - z) ** 2 < rr * rr) return false;
        }
      }
    return true;
  }
}

export interface GenCtx {
  seed: number;
  size: number;
  chunkSize: number;
  chunkOf(x: number, z: number): number;
  data: CityData;
  layout: CityLayout;
  hf: HeightField;
  ped: PedBuilder;
  grid: (GridNode | null)[][];
  blockIslands: Island[];
  promenade: Island;
  park: Island;
  plaza: Island;
  hub: Island;
  /** Props / furniture occupancy. */
  space: DiscSet;
  /** Points where parking is not allowed (hydrants, bus stops, roadworks) with radius. */
  noPark: DiscSet;
  /** Sea wall gaps: [x0, x1, kind] kind 0 = slipway, 1 = stairs. */
  wallGaps: [number, number, number][];
}

export function inRoundRect(isl: Island, x: number, z: number, pad = 0): boolean {
  const minX = isl.minX - pad, maxX = isl.maxX + pad, minZ = isl.minZ - pad, maxZ = isl.maxZ + pad;
  if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
  const r = Math.max(0, isl.r + pad);
  const cx = Math.min(Math.max(x, minX + r), maxX - r);
  const cz = Math.min(Math.max(z, minZ + r), maxZ - r);
  return (x - cx) ** 2 + (z - cz) ** 2 <= r * r + 1e-6;
}
