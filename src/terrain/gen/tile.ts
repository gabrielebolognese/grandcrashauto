import { CONFIG } from '../../config';
import { CARVE, shadeAt } from './biome';
import { CorridorSet } from './carve';
import { lakesInRect, newInfo, sampleTerrain, type Lake } from './height';
import { hash2 } from './noise';

/**
 * Render-tile mesh builder (runs in a worker). A level-L tile is a (N+1)² INDEXED grid of (2·2^L) m cells with skirts.
 * Faceted look: the shader uses derivative normals (flat facets) and a FLAT colour varying taken from each triangle's
 * provoking (last) vertex, so colours stay per-face even though vertices are shared.
 * Triangulation matches Rapier's heightfield (diagonal from (x1,z0) to (x0,z1)) so L0 tiles = colliders exactly.
 */

export interface TileMesh {
  level: number;
  tx: number;
  tz: number;
  /** tile centre (absolute) */
  cx: number;
  cz: number;
  size: number;
  positions: Float32Array; // relative to the tile centre (y absolute)
  colors: Uint8Array; // sRGB
  snow: Uint8Array; // x = flatness, y = jitter
  index: Uint16Array;
  indexCount: number;
  minY: number;
  maxY: number;
  lakes: { key: number; x: number; z: number; R: number; W: number; level: number }[];
}

export const tileCellSize = (level: number) => 2 << level;
export const tileSize = (level: number, cells = CONFIG.terrain.tileCells) => cells * (2 << level);

const INFO = newInfo();

export function buildTile(level: number, tx: number, tz: number, seed: number): TileMesh {
  const N = CONFIG.terrain.tileCells;
  const cell = tileCellSize(level);
  const size = N * cell;
  const x0 = tx * size;
  const z0 = tz * size;
  const cx = x0 + size / 2;
  const cz = z0 + size / 2;
  const V = N + 1;
  const M = N + 3; // with a 1-sample border for normals

  const carveOn = level <= CONFIG.terrain.carveMaxLevel;
  const corr = carveOn ? CorridorSet.forRect(x0 - cell, z0 - cell, x0 + size + cell, z0 + size + cell) : null;

  // ── pass 1: heights (bordered), per-vertex info for the interior ──
  const H = new Float64Array(M * M);
  const coast = new Float32Array(V * V);
  const cliff = new Float32Array(V * V);
  const mtn = new Float32Array(V * V);
  const flat = new Float32Array(V * V);
  const city = new Float32Array(V * V);
  const lake = new Float32Array(V * V);
  const lakeR = new Float32Array(V * V);
  const zone = new Float32Array(V * V);
  const dune = new Float32Array(V * V);
  const carve = new Uint8Array(V * V);
  let hasLake = false;
  for (let j = -1; j <= N + 1; j++) {
    const az = z0 + j * cell;
    for (let i = -1; i <= N + 1; i++) {
      const ax = x0 + i * cell;
      let h = sampleTerrain(ax, az, INFO, seed);
      let ck: number = CARVE.none;
      if (corr && !corr.empty && INFO.flat >= 0) {
        h = corr.carve(h, ax, az);
        ck = corr.kind;
      }
      H[(j + 1) * M + (i + 1)] = h;
      if (i >= 0 && i <= N && j >= 0 && j <= N) {
        const v = j * V + i;
        coast[v] = INFO.coast;
        cliff[v] = INFO.cliff;
        mtn[v] = INFO.mtn;
        flat[v] = INFO.flat;
        city[v] = INFO.city;
        lake[v] = INFO.lake;
        if (INFO.lake === INFO.lake) hasLake = true;
        lakeR[v] = INFO.lakeR;
        zone[v] = INFO.zone;
        dune[v] = INFO.dune;
        carve[v] = ck;
      }
    }
  }
  const hAt = (i: number, j: number) => H[(j + 1) * M + (i + 1)];

  // ── cell exclusion: inside the city/airport, or deep under the sea ──
  const keep = new Uint8Array(N * N);
  let cellsKept = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * V + i;
      const inside = flat[a] < 0 && flat[a + 1] < 0 && flat[a + V] < 0 && flat[a + V + 1] < 0;
      const deep = hAt(i, j) < -3.2 && hAt(i + 1, j) < -3.2 && hAt(i, j + 1) < -3.2 && hAt(i + 1, j + 1) < -3.2;
      if (!inside && !deep) {
        keep[j * N + i] = 1;
        cellsKept++;
      }
    }
  }

  // ── vertices ──
  const nV = V * V + 4 * V;
  const positions = new Float32Array(nV * 3);
  const colors = new Uint8Array(nV * 3);
  const snow = new Uint8Array(nV * 2);
  let minY = 1e9;
  let maxY = -1e9;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const v = j * V + i;
      const y = hAt(i, j);
      positions[v * 3] = i * cell - size / 2;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = j * cell - size / 2;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // per-CELL colours: both triangles of cell (i, j) use vertex c = (i, j+1) as their provoking vertex
  const latticeX = Math.round(x0 / cell);
  const latticeZ = Math.round(z0 / cell);
  const cellCol = new Uint8Array(N * N * 3);
  const cellSnow = new Uint8Array(N * N * 2);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const ha = hAt(i, j);
      const hb = hAt(i + 1, j);
      const hc = hAt(i, j + 1);
      const hd = hAt(i + 1, j + 1);
      let gx = (hb - ha) / cell;
      let gz = (hc - ha) / cell;
      let ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      gx = (hd - hc) / cell;
      gz = (hd - hb) / cell;
      ny = (ny + 1 / Math.sqrt(1 + gx * gx + gz * gz)) * 0.5;
      const v = (j + 1) * V + i; // provoking vertex
      const va = j * V + i;
      INFO.h = (ha + hb + hc + hd) * 0.25;
      INFO.coast = coast[va];
      INFO.cliff = cliff[va];
      INFO.mtn = mtn[va];
      INFO.flat = flat[va];
      INFO.city = city[va];
      INFO.lake = lake[va];
      INFO.lakeR = lakeR[va];
      INFO.zone = zone[va];
      INFO.dune = dune[va];
      let ck = carve[v];
      if (carve[va] === CARVE.road || carve[va + 1] === CARVE.road || carve[v] === CARVE.road || carve[v + 1] === CARVE.road) ck = CARVE.road;
      const jit = hash2(seed, latticeX + i, latticeZ + j, 77 + level);
      const sh = shadeAt(x0 + (i + 0.5) * cell, z0 + (j + 0.5) * cell, INFO, ny, ck, cell, jit, seed);
      const k3 = (j * N + i) * 3;
      cellCol[k3] = sh.r < 0 ? 0 : sh.r > 255 ? 255 : sh.r;
      cellCol[k3 + 1] = sh.g < 0 ? 0 : sh.g > 255 ? 255 : sh.g;
      cellCol[k3 + 2] = sh.b < 0 ? 0 : sh.b > 255 ? 255 : sh.b;
      cellSnow[(j * N + i) * 2] = Math.round(Math.max(0, Math.min(1, (ny - 0.55) / 0.4)) * 255);
      cellSnow[(j * N + i) * 2 + 1] = Math.round(jit * 255);
      colors[v * 3] = cellCol[k3];
      colors[v * 3 + 1] = cellCol[k3 + 1];
      colors[v * 3 + 2] = cellCol[k3 + 2];
      snow[v * 2] = cellSnow[(j * N + i) * 2];
      snow[v * 2 + 1] = cellSnow[(j * N + i) * 2 + 1];
    }
  }

  // ── indices ──
  const index = new Uint16Array(N * N * 6 + 4 * N * 6);
  let ic = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!keep[j * N + i]) continue;
      const a = j * V + i;
      const b = a + 1;
      const c = a + V;
      const d = c + 1;
      index[ic++] = b;
      index[ic++] = a;
      index[ic++] = c; // T1 (a, c, b) rotated: provoking c
      index[ic++] = d;
      index[ic++] = b;
      index[ic++] = c; // T2 (b, c, d) rotated: provoking c
    }
  }

  // ── skirts (hide cracks between neighbouring LODs) ──
  const skirt = cell * 1.6 + 3;
  const base = V * V;
  const adjCell = (e: number, k: number): number => {
    if (e === 0) return 0 * N + k;
    if (e === 1) return k * N + (N - 1);
    if (e === 2) return (N - 1) * N + (N - 1 - k);
    return (N - 1 - k) * N;
  };
  // edge e: 0 north (j=0, +x), 1 east (i=N, +z), 2 south (j=N, -x), 3 west (i=0, -z) — outward winding
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k <= N; k++) {
      let i: number, j: number;
      if (e === 0) {
        i = k;
        j = 0;
      } else if (e === 1) {
        i = N;
        j = k;
      } else if (e === 2) {
        i = N - k;
        j = N;
      } else {
        i = 0;
        j = N - k;
      }
      const top = j * V + i;
      const bv = base + e * V + k;
      positions[bv * 3] = positions[top * 3];
      positions[bv * 3 + 1] = positions[top * 3 + 1] - skirt;
      positions[bv * 3 + 2] = positions[top * 3 + 2];
      const cc = adjCell(e, Math.min(k, N - 1));
      colors[bv * 3] = cellCol[cc * 3] * 0.82;
      colors[bv * 3 + 1] = cellCol[cc * 3 + 1] * 0.82;
      colors[bv * 3 + 2] = cellCol[cc * 3 + 2] * 0.82;
      snow[bv * 2] = 0;
      snow[bv * 2 + 1] = cellSnow[cc * 2 + 1];
    }
    for (let k = 0; k < N; k++) {
      const cc = adjCell(e, k);
      if (!keep[cc]) continue;
      const t0 = edgeVertex(e, k, N, V);
      const t1 = edgeVertex(e, k + 1, N, V);
      const b0 = base + e * V + k;
      const b1 = b0 + 1;
      index[ic++] = t0;
      index[ic++] = t1;
      index[ic++] = b1; // provoking b1
      index[ic++] = t0;
      index[ic++] = b1;
      index[ic++] = b0; // provoking b0
    }
  }

  // lakes touching this tile
  const lakes: TileMesh['lakes'] = [];
  if (hasLake) {
    const found: Lake[] = [];
    lakesInRect(x0, z0, x0 + size, z0 + size, seed, found);
    for (const L of found) lakes.push({ key: L.key, x: L.x, z: L.z, R: L.R, W: L.W, level: L.level });
  }

  return {
    level, tx, tz, cx, cz, size, positions, colors, snow,
    index: ic === index.length ? index : index.slice(0, ic),
    indexCount: ic, minY: cellsKept ? minY - skirt : 0, maxY: cellsKept ? maxY : 0, lakes,
  };
}

function edgeVertex(e: number, k: number, N: number, V: number): number {
  if (e === 0) return k;
  if (e === 1) return k * V + N;
  if (e === 2) return N * V + (N - k);
  return (N - k) * V;
}
