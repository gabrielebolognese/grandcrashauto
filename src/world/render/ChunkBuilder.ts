import * as THREE from 'three';
import { CONFIG } from '../../config';
import * as L from '../gen/layout';
import { Mat, type CityLayout, type Island } from '../gen/model';
import { GeoBuilder, darken } from './GeoBuilder';

/**
 * Builds the static ground geometry of one 100 m chunk (terrain base, raised islands with bevelled curbs, sidewalks,
 * paint, park paths, fountain, sea wall...) and a cheap low-detail version of every chunk (flat islands) used for
 * unloaded chunks and the altitude LOD. Shapes spanning several chunks (promenade, verges, park paths) are generated
 * whole and only the triangles whose centroid falls in the chunk are kept (sides are subdivided, so this is exact).
 */

export const COLORS = {
  asphalt: 0x4a4d57,
  grass: 0x8cc06b,
  yard: 0x93c46e,
  park: 0x86bf66,
  sidewalk: 0xd9d2c5,
  curbTop: 0xece7de,
  curbFace: 0xcfc8bb,
  plaza: 0xe8dcc6,
  courtyard: 0xd6cfc2,
  lot: 0x575a61,
  sand: 0xf3dcb2,
  wetSand: 0xd8bd92,
};

type Bucket = { islands: Island[]; decals: number[]; discs: number[]; ribbons: number[]; solids: number[]; cyl: number[] };

export const keyOf = (cx: number, cz: number) => `${cx},${cz}`;

export class ChunkBuilder {
  private buckets = new Map<string, Bucket>();
  readonly cs: number;
  /** Every chunk key covering the city bounds. */
  readonly keys: string[] = [];
  private tmp = new GeoBuilder();

  constructor(private layout: CityLayout) {
    const cs = (this.cs = CONFIG.world.chunkSize);
    const get = (k: string) => {
      let v = this.buckets.get(k);
      if (!v) this.buckets.set(k, (v = { islands: [], decals: [], discs: [], ribbons: [], solids: [], cyl: [] }));
      return v;
    };
    const at = (x: number, z: number) => get(keyOf(Math.floor(x / cs), Math.floor(z / cs)));
    const span = (x0: number, x1: number, z0: number, z1: number, fn: (b: Bucket) => void) => {
      for (let cz = Math.floor(z0 / cs); cz <= Math.floor(z1 / cs); cz++) for (let cx = Math.floor(x0 / cs); cx <= Math.floor(x1 / cs); cx++) fn(get(keyOf(cx, cz)));
    };
    for (const isl of layout.islands) span(isl.minX, isl.maxX, isl.minZ, isl.maxZ, (b) => b.islands.push(isl));
    layout.decals.forEach((d, i) => at(d.cx, d.cz).decals.push(i));
    layout.discs.forEach((d, i) => span(d.cx - d.rx, d.cx + d.rx, d.cz - d.rz, d.cz + d.rz, (b) => b.discs.push(i)));
    layout.ribbons.forEach((r, i) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < r.pts.length; k += 2) {
        x0 = Math.min(x0, r.pts[k]);
        x1 = Math.max(x1, r.pts[k]);
        z0 = Math.min(z0, r.pts[k + 1]);
        z1 = Math.max(z1, r.pts[k + 1]);
      }
      span(x0 - r.w, x1 + r.w, z0 - r.w, z1 + r.w, (b) => b.ribbons.push(i));
    });
    layout.solids.forEach((s, i) => at(s.cx, s.cz).solids.push(i));
    layout.cylinders.forEach((c, i) => at(c.cx, c.cz).cyl.push(i));
    const cb = CONFIG.world.cityBounds;
    for (let cz = Math.floor(cb.minZ / cs); cz <= Math.floor((cb.maxZ - 0.01) / cs); cz++)
      for (let cx = Math.floor(cb.minX / cs); cx <= Math.floor((cb.maxX - 0.01) / cs); cx++) this.keys.push(keyOf(cx, cz));
  }

  /** Chunk rect clipped to the city bounds. */
  private rectOf(cx: number, cz: number): [number, number, number, number] | null {
    const cb = CONFIG.world.cityBounds;
    const x0 = Math.max(cb.minX, cx * this.cs), x1 = Math.min(cb.maxX, (cx + 1) * this.cs);
    const z0 = Math.max(cb.minZ, cz * this.cs), z1 = Math.min(cb.maxZ, (cz + 1) * this.cs);
    if (x1 <= x0 || z1 <= z0) return null;
    return [x0, x1, z0, z1];
  }

  private base(gb: GeoBuilder, r: [number, number, number, number], coarse: boolean): void {
    const [x0, x1, z0, z1] = r;
    const zl = Math.min(z1, L.BEACH_START_Z);
    if (zl > z0) {
      const xs = new Set([x0, x1]), zs = new Set([z0, zl]);
      for (const [a, b, c, d] of this.layout.asphalt) {
        for (const x of [a, b]) if (x > x0 && x < x1) xs.add(x);
        for (const z of [c, d]) if (z > z0 && z < zl) zs.add(z);
      }
      const X = [...xs].sort((p, q) => p - q), Z = [...zs].sort((p, q) => p - q);
      for (let j = 0; j + 1 < Z.length; j++)
        for (let i = 0; i + 1 < X.length; i++) {
          const mx = (X[i] + X[i + 1]) / 2, mz = (Z[j] + Z[j + 1]) / 2;
          const asph = this.layout.asphalt.some(([a, b, c, d]) => mx >= a && mx <= b && mz >= c && mz <= d);
          gb.rect(X[i], X[i + 1], Z[j], Z[j + 1], 0, asph ? COLORS.asphalt : COLORS.grass, asph ? Mat.Asphalt : Mat.Grass);
        }
    }
    if (z1 > L.BEACH_START_Z) this.beach(gb, x0, x1, Math.max(z0, L.BEACH_START_Z), z1, coarse);
  }

  private beach(gb: GeoBuilder, x0: number, x1: number, z0: number, z1: number, coarse: boolean): void {
    const dx = coarse ? 12.5 : 6.25;
    const zs: number[] = [];
    for (let z = z0; z < z1 - 0.01; ) {
      zs.push(z);
      z += coarse ? 8 : z < 370 ? 3 : 8;
    }
    zs.push(z1);
    const nx = Math.max(1, Math.round((x1 - x0) / dx));
    const first = gb.vertexCount;
    const col = (h: number) => {
      if (h > 0.4) return COLORS.sand;
      if (h > -0.05) return lerpHex(COLORS.wetSand, COLORS.sand, Math.max(0, h / 0.4));
      return lerpHex(0xc9b083, 0x5f8f8c, Math.min(1, -h / 4));
    };
    const n = new THREE.Vector3();
    for (const z of zs)
      for (let i = 0; i <= nx; i++) {
        const x = x0 + ((x1 - x0) * i) / nx;
        const h = L.beachHeight(x, z);
        const e = 0.6;
        n.set(-(L.beachHeight(x + e, z) - L.beachHeight(x - e, z)), 2 * e, -(L.beachHeight(x, z + e) - L.beachHeight(x, z - e))).normalize();
        gb.vert(x, h, z, n.x, n.y, n.z, col(h), Mat.Sand);
      }
    const row = nx + 1;
    for (let j = 0; j + 1 < zs.length; j++)
      for (let i = 0; i < nx; i++) {
        const a = first + j * row + i, b = a + 1, c = a + row + 1, d = a + row;
        gb.tri(a, d, c, 0, 1, 0);
        gb.tri(a, c, b, 0, 1, 0);
      }
  }

  /** Detailed geometry of one chunk (null if empty). */
  buildDetail(cx: number, cz: number): THREE.BufferGeometry | null {
    const r = this.rectOf(cx, cz);
    const bk = this.buckets.get(keyOf(cx, cz));
    if (!r && !bk) return null;
    const gb = new GeoBuilder();
    if (r) this.base(gb, r, false);
    const x0 = cx * this.cs, x1 = x0 + this.cs, z0 = cz * this.cs, z1 = z0 + this.cs;
    if (bk) {
      const Ly = this.layout;
      const tmp = this.tmp;
      for (const isl of bk.islands) {
        tmp.reset();
        islandDetail(tmp, isl, x0, x1, z0, z1);
        gb.appendClipped(tmp, x0, x1, z0, z1);
      }
      for (const i of bk.discs) {
        const d = Ly.discs[i];
        tmp.reset();
        tmp.disc(d.cx, d.cz, d.rx, d.rz, d.inner, d.y, d.col, d.mat, Math.max(16, Math.min(56, Math.round((d.rx + d.rz) * 1.4))));
        gb.appendClipped(tmp, x0, x1, z0, z1);
      }
      for (const i of bk.ribbons) {
        const rb = Ly.ribbons[i];
        tmp.reset();
        tmp.ribbon(rb.pts, rb.w, rb.y, rb.closed, rb.col, rb.mat);
        gb.appendClipped(tmp, x0, x1, z0, z1);
      }
      for (const i of bk.decals) {
        const d = Ly.decals[i];
        gb.decal(d.cx, d.cz, d.dx, d.dz, d.hl, d.hw, d.y, d.col, d.mat);
      }
      for (const i of bk.solids) {
        const s = Ly.solids[i];
        if (s.col < 0) continue;
        gb.box(s.cx, s.cy, s.cz, s.w, s.h, s.d, s.yaw, s.col, s.mat, s.h0 ?? s.h);
      }
      for (const i of bk.cyl) {
        const c = Ly.cylinders[i];
        gb.cylinder(c.cx, c.cy, c.cz, c.r, c.h, c.segs, c.col, c.mat, c.open);
      }
    }
    if (gb.vertexCount === 0) return null;
    return gb.toGeometry();
  }

  /** Low-detail geometry of every chunk merged into one buffer + per-chunk index ranges. */
  buildLOD(): { geometry: THREE.BufferGeometry; ranges: Map<string, [number, number]>; index: Uint32Array } {
    const gb = new GeoBuilder();
    const ranges = new Map<string, [number, number]>();
    for (const k of this.keys) {
      const [cx, cz] = k.split(',').map(Number);
      const start = gb.idx.length;
      const r = this.rectOf(cx, cz);
      if (r) this.base(gb, r, true);
      const bk = this.buckets.get(k);
      const x0 = cx * this.cs, x1 = x0 + this.cs, z0 = cz * this.cs, z1 = z0 + this.cs;
      if (bk)
        for (const isl of bk.islands) {
          const a = Math.max(x0, isl.minX), b = Math.min(x1, isl.maxX), c = Math.max(z0, isl.minZ), d = Math.min(z1, isl.maxZ);
          if (b <= a || d <= c) continue;
          const green = isl.kind === 'verge' || isl.interior === 'yard' || isl.interior === 'park' || isl.interior === 'grass';
          const col = isl.interior === 'yard' ? lerpHex(COLORS.yard, COLORS.sidewalk, 0.2) : green ? COLORS.park : isl.interior === 'lot' ? COLORS.lot : isl.interior === 'plaza' ? COLORS.plaza : COLORS.sidewalk;
          gb.rect(a, b, c, d, isl.top, col, green ? Mat.Grass : Mat.Sidewalk);
        }
      if (bk)
        for (const i of bk.solids) {
          const sd = this.layout.solids[i];
          if (sd.lod && sd.col >= 0) gb.box(sd.cx, sd.cy, sd.cz, sd.w, sd.h, sd.d, sd.yaw, sd.col, sd.mat, sd.h0 ?? sd.h);
        }
      ranges.set(k, [start, gb.idx.length - start]);
    }
    const geometry = gb.toGeometry();
    return { geometry, ranges, index: new Uint32Array(gb.idx) };
  }
}

export function lerpHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

interface CPt {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

/**
 * Rounded-rect contour with per-side insets, corners NW → NE → SE → SW, straight sides subdivided into `k[side]`
 * extra points (sides N, E, S, W) so all contours of one island correspond point by point.
 */
function contour(isl: Island, iN: number, iE: number, iS: number, iW: number, rr: number, segs: number, k: number[]): CPt[] {
  const out: CPt[] = [];
  const cs: [number, number, number][] = [
    [isl.minX + iW + rr, isl.minZ + iN + rr, Math.PI],
    [isl.maxX - iE - rr, isl.minZ + iN + rr, Math.PI * 1.5],
    [isl.maxX - iE - rr, isl.maxZ - iS - rr, 0],
    [isl.minX + iW + rr, isl.maxZ - iS - rr, Math.PI * 0.5],
  ];
  const sideN: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let c = 0; c < 4; c++) {
    const [cx, cz, a0] = cs[c];
    for (let s = 0; s <= segs; s++) {
      const a = a0 + (s / segs) * (Math.PI / 2);
      const nx = Math.cos(a), nz = Math.sin(a);
      out.push({ x: cx + nx * rr, z: cz + nz * rr, nx, nz });
    }
    // straight side c (N, E, S, W) toward the next corner
    const last = out[out.length - 1];
    const [nx2, nz2, a1] = cs[(c + 1) % 4];
    const nextX = nx2 + Math.cos(a1) * rr, nextZ = nz2 + Math.sin(a1) * rr;
    for (let i = 1; i <= k[c]; i++) {
      const t = i / (k[c] + 1);
      out.push({ x: last.x + (nextX - last.x) * t, z: last.z + (nextZ - last.z) * t, nx: sideN[c][0], nz: sideN[c][1] });
    }
  }
  return out;
}

function ring(gb: GeoBuilder, A: CPt[], ya: number, B: CPt[], yb: number, color: number, m: number, mode: 'up' | 'side' | 'chamfer'): void {
  const n = A.length;
  const first = gb.vertexCount;
  for (let i = 0; i < n; i++) {
    const a = A[i], b = B[i];
    const nx = mode === 'up' ? 0 : mode === 'side' ? a.nx : a.nx * 0.7;
    const ny = mode === 'up' ? 1 : mode === 'side' ? 0 : 0.7;
    const nz = mode === 'up' ? 0 : mode === 'side' ? a.nz : a.nz * 0.7;
    gb.vert(a.x, ya, a.z, nx, ny, nz, color, m);
    gb.vert(b.x, yb, b.z, nx, ny, nz, color, m);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a0 = first + i * 2, b0 = a0 + 1, a1 = first + j * 2, b1 = a1 + 1;
    const p = A[i], q = A[j];
    const mx = p.nx + q.nx, mz = p.nz + q.nz;
    const nn = mode === 'up' ? [0, 1, 0] : mode === 'side' ? [mx, 0, mz] : [mx, 1, mz];
    gb.tri(a0, a1, b1, nn[0], nn[1], nn[2]);
    gb.tri(a0, b1, b0, nn[0], nn[1], nn[2]);
  }
}

export function islandDetail(gb: GeoBuilder, isl: Island, x0: number, x1: number, z0: number, z1: number): void {
  const t = isl.top;
  const r = isl.r;
  const segs = r >= 2 ? 6 : 3;
  const ch = 0.07;
  const step = 10;
  const k = [
    Math.floor((isl.maxX - isl.minX - 2 * r) / step),
    Math.floor((isl.maxZ - isl.minZ - 2 * r) / step),
    Math.floor((isl.maxX - isl.minX - 2 * r) / step),
    Math.floor((isl.maxZ - isl.minZ - 2 * r) / step),
  ].map((v) => Math.max(0, v));
  const Ce = contour(isl, 0, 0, 0, 0, r, segs, k);
  const C0 = contour(isl, ch, ch, ch, ch, Math.max(0.05, r - ch), segs, k);
  ring(gb, Ce, -0.03, Ce, t - ch, COLORS.curbFace, Mat.Concrete, 'side');
  ring(gb, Ce, t - ch, C0, t, COLORS.curbTop, Mat.Concrete, 'chamfer');
  const cw = 0.32;
  const C1 = contour(isl, cw, cw, cw, cw, Math.max(0.05, r - cw), segs, k);
  ring(gb, C0, t, C1, t, COLORS.curbTop, Mat.Concrete, 'up');
  const [sn, se, ss, sw] = isl.sw;
  const hasSw = sn > 0 || se > 0 || ss > 0 || sw > 0;
  const ins = (s: number) => Math.max(cw, s);
  let col = COLORS.courtyard, m: number = Mat.Sidewalk;
  if (isl.kind === 'verge' || isl.interior === 'grass') [col, m] = [COLORS.grass, Mat.Grass];
  else if (isl.interior === 'yard') [col, m] = [COLORS.yard, Mat.Grass];
  else if (isl.interior === 'park') [col, m] = [COLORS.park, Mat.Grass];
  else if (isl.interior === 'lot') [col, m] = [COLORS.lot, Mat.Asphalt];
  else if (isl.interior === 'plaza') [col, m] = [COLORS.plaza, Mat.Plaza];
  else if (isl.kind === 'median' && isl.interior === 'concrete') [col, m] = [darken(COLORS.sidewalk, 0.97), Mat.Concrete];
  if (isl.kind === 'median') {
    // short: rounded interior fan
    const cx = (isl.minX + isl.maxX) / 2, cz = (isl.minZ + isl.maxZ) / 2;
    const c = gb.vert(cx, t, cz, 0, 1, 0, col, m);
    const first = gb.vertexCount;
    for (const p of C1) gb.vert(p.x, t, p.z, 0, 1, 0, col, m);
    for (let i = 0; i < C1.length; i++) gb.tri(c, first + i, first + ((i + 1) % C1.length), 0, 1, 0);
    return;
  }
  let iN = cw, iE = cw, iS = cw, iW = cw;
  if (hasSw) {
    [iN, iE, iS, iW] = [ins(sn), ins(se), ins(ss), ins(sw)];
    const C2 = contour(isl, iN, iE, iS, iW, 0, segs, k);
    ring(gb, C1, t, C2, t, COLORS.sidewalk, Mat.Sidewalk, 'up');
  }
  // interior: grid (cell ≤ 12.5 m, split at chunk lines) so chunk routing stays exact
  const ax = isl.minX + iW, bx = isl.maxX - iE, az = isl.minZ + iN, bz = isl.maxZ - iS;
  if (bx <= ax || bz <= az) return;
  const xs = splitLine(ax, bx, x0, x1), zs = splitLine(az, bz, z0, z1);
  for (let j = 0; j + 1 < zs.length; j++) for (let i = 0; i + 1 < xs.length; i++) gb.rect(xs[i], xs[i + 1], zs[j], zs[j + 1], t, col, m);
}

function splitLine(a: number, b: number, c0: number, c1: number): number[] {
  const pts = new Set<number>([a, b]);
  for (const c of [c0, c1]) if (c > a && c < b) pts.add(c);
  const sorted = [...pts].sort((p, q) => p - q);
  const out: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const s = sorted[i], e = sorted[i + 1];
    const n = Math.max(1, Math.ceil((e - s) / 12.5));
    for (let k = 0; k < n; k++) out.push(s + ((e - s) * k) / n);
  }
  out.push(sorted[sorted.length - 1]);
  return out;
}
