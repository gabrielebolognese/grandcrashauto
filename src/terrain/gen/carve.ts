import type { CorridorSegment } from '../../core/genTypes';
import { corridorsInRect } from '../../highway/net/corridors';
import { CARVE } from './biome';

/**
 * Highway corridor carving (PURE + worker-safe): final height = carve(natural, corridors).
 *  - 'road' / 'gallery': the formation (halfWidth + margin) sits just under the road surface; beyond it the ground is
 *    clamped between a fill slope (embankment) and a cut slope (cutting) that meet the natural terrain.
 *  - 'bridge': natural ground below, only kept under the deck (clearance).
 *  - 'tunnel': natural ground above, but at least `TUNNEL_COVER` over the tube (portals get a vertical-ish face).
 * Segments are applied farthest-first so the nearest road wins; the result only depends on the segment set, so any
 * query rectangle that contains a sample's influence zone gives identical heights (seamless chunks).
 */

export const CARVE_MARGIN = 150; // m: max influence distance beyond a segment's half width
const FORMATION_PAD = 1.4; // m of flat formation beyond halfWidth
const BELOW_ROAD = 0.22; // m the ground sits under the road surface
const CUT_SLOPE = 1.05; // rise per metre (cuttings)
const FILL_SLOPE = 0.62; // drop per metre (embankments)
const BRIDGE_CLEAR = 2.5;
const TUNNEL_COVER = 10;

/** Safe wrapper: the highway generator may be mid-development; never let it break terrain generation. */
export function fetchCorridors(minX: number, minZ: number, maxX: number, maxZ: number): CorridorSegment[] {
  try {
    const r = corridorsInRect(minX - CARVE_MARGIN, minZ - CARVE_MARGIN, maxX + CARVE_MARGIN, maxZ + CARVE_MARGIN);
    return Array.isArray(r) ? r : [];
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[terrain] corridorsInRect failed', err);
    }
    return [];
  }
}
let warned = false;

const MAXN = 64;

/** Corridor segments of one rectangle, binned for fast per-sample lookup. */
export class CorridorSet {
  readonly segs: CorridorSegment[];
  private bins: Int32Array[] = [];
  private B = 8;
  private minX: number;
  private minZ: number;
  private bw: number;
  private bh: number;
  // last-sample outputs
  kind: number = CARVE.none;
  /** distance (m) from the sample to the nearest segment's paved edge (negative = on the formation). */
  edgeDist = 1e9;
  // scratch
  private cand = new Int32Array(MAXN);
  private candD = new Float64Array(MAXN);
  private candT = new Float64Array(MAXN);

  constructor(segs: CorridorSegment[], minX: number, minZ: number, maxX: number, maxZ: number) {
    this.segs = segs;
    this.minX = minX;
    this.minZ = minZ;
    this.bw = Math.max(1, (maxX - minX) / this.B);
    this.bh = Math.max(1, (maxZ - minZ) / this.B);
    if (!segs.length) return;
    const lists: number[][] = [];
    for (let i = 0; i < this.B * this.B; i++) lists.push([]);
    for (let s = 0; s < segs.length; s++) {
      const g = segs[s];
      const m = g.halfWidth + FORMATION_PAD + CARVE_MARGIN;
      const i0 = Math.max(0, Math.floor((Math.min(g.ax, g.bx) - m - minX) / this.bw));
      const i1 = Math.min(this.B - 1, Math.floor((Math.max(g.ax, g.bx) + m - minX) / this.bw));
      const j0 = Math.max(0, Math.floor((Math.min(g.az, g.bz) - m - minZ) / this.bh));
      const j1 = Math.min(this.B - 1, Math.floor((Math.max(g.az, g.bz) + m - minZ) / this.bh));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * this.B + i].push(s);
    }
    this.bins = lists.map((l) => Int32Array.from(l));
  }

  static forRect(minX: number, minZ: number, maxX: number, maxZ: number): CorridorSet {
    return new CorridorSet(fetchCorridors(minX, minZ, maxX, maxZ), minX, minZ, maxX, maxZ);
  }

  get empty(): boolean {
    return this.segs.length === 0;
  }

  private bin(ax: number, az: number): Int32Array | null {
    if (!this.segs.length) return null;
    let i = Math.floor((ax - this.minX) / this.bw);
    let j = Math.floor((az - this.minZ) / this.bh);
    i = i < 0 ? 0 : i >= this.B ? this.B - 1 : i;
    j = j < 0 ? 0 : j >= this.B ? this.B - 1 : j;
    return this.bins[j * this.B + i];
  }

  /** Carve the natural height `h` at (ax, az). Sets `kind` and `edgeDist`. */
  carve(h: number, ax: number, az: number): number {
    this.kind = CARVE.none;
    this.edgeDist = 1e9;
    const list = this.bin(ax, az);
    if (!list || !list.length) return h;
    const segs = this.segs;
    // gather segments within influence
    let nc = 0;
    for (let k = 0; k < list.length && nc < MAXN; k++) {
      const s = list[k];
      const g = segs[s];
      const dx = g.bx - g.ax;
      const dz = g.bz - g.az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((ax - g.ax) * dx + (az - g.az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = g.ax + dx * t - ax;
      const pz = g.az + dz * t - az;
      const d = Math.sqrt(px * px + pz * pz);
      if (d > g.halfWidth + FORMATION_PAD + CARVE_MARGIN) continue;
      // insertion sort by descending distance (farthest first); ties broken by segment coordinates
      let p = nc++;
      while (p > 0) {
        const q = this.cand[p - 1];
        const dq = this.candD[p - 1];
        if (dq > d || (dq === d && cmpSeg(segs[q], g) > 0)) break;
        this.cand[p] = q;
        this.candD[p] = dq;
        this.candT[p] = this.candT[p - 1];
        p--;
      }
      this.cand[p] = s;
      this.candD[p] = d;
      this.candT[p] = t;
    }
    if (!nc) return h;
    const h0 = h;
    let formation = false;
    let tunnelPass = false;
    for (let k = 0; k < nc; k++) {
      const g = segs[this.cand[k]];
      const d = this.candD[k];
      const t = this.candT[k];
      const edge = d - g.halfWidth;
      if (edge < this.edgeDist) this.edgeDist = edge;
      if (g.kind === 'tunnel') {
        tunnelPass = true;
        continue;
      }
      const yr = g.ya + (g.yb - g.ya) * t;
      const w = Math.max(0, edge - FORMATION_PAD);
      if (g.kind === 'bridge') {
        const hi = yr - BRIDGE_CLEAR + w * CUT_SLOPE;
        if (h > hi) h = hi;
        continue;
      }
      const base = yr - BELOW_ROAD;
      const lo = base - w * FILL_SLOPE;
      const hi = base + w * CUT_SLOPE;
      if (h < lo) h = lo;
      else if (h > hi) h = hi;
      if (w === 0) formation = true;
    }
    if (tunnelPass) {
      for (let k = 0; k < nc; k++) {
        const g = segs[this.cand[k]];
        if (g.kind !== 'tunnel') continue;
        const t = this.candT[k];
        if (t <= 0 || t >= 1) continue;
        const edge = this.candD[k] - g.halfWidth;
        if (edge > 4) continue;
        const yr = g.ya + (g.yb - g.ya) * t;
        const cover = yr + TUNNEL_COVER;
        if (h < cover) h = cover;
      }
    }
    if (formation) this.kind = CARVE.road;
    else if (h < h0 - 0.3) this.kind = CARVE.cut;
    else if (h > h0 + 0.3) this.kind = CARVE.fill;
    return h;
  }

  /** Distance (m) from (ax, az) to the nearest segment's paved edge (scatter avoidance). 1e9 when none near. */
  edgeDistance(ax: number, az: number): number {
    const list = this.bin(ax, az);
    if (!list || !list.length) return 1e9;
    let best = 1e9;
    for (let k = 0; k < list.length; k++) {
      const g = this.segs[list[k]];
      const dx = g.bx - g.ax;
      const dz = g.bz - g.az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((ax - g.ax) * dx + (az - g.az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = g.ax + dx * t - ax;
      const pz = g.az + dz * t - az;
      const e = Math.sqrt(px * px + pz * pz) - g.halfWidth;
      if (e < best) best = e;
    }
    return best;
  }
}

function cmpSeg(a: CorridorSegment, b: CorridorSegment): number {
  return a.ax - b.ax || a.az - b.az || a.bx - b.bx || a.bz - b.bz || a.ya - b.ya;
}
