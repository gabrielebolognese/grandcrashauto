import { CARVE, shadeAt, SURF } from './biome';
import { CorridorSet } from './carve';
import { newInfo, sampleTerrain } from './height';
import { hash2 } from './noise';

/**
 * Collider / query chunk (runs in a worker): 128 m, 2 m cells → 65×65 samples on the same lattice as the L0 render
 * tiles (identical heights). Heights are COLUMN-MAJOR for Rapier: index = j + i·65 (i along x, j along z).
 */

export const CHUNK = 128;
export const CHUNK_CELL = 2;
export const CHUNK_N = CHUNK / CHUNK_CELL; // 64 cells
export const CHUNK_V = CHUNK_N + 1; // 65 samples

export interface ChunkData {
  cx: number;
  cz: number;
  heights: Float32Array; // column-major (j + i·65)
  surf: Uint8Array; // same layout, SURF codes
  biome: Uint8Array; // same layout, BIOME codes
  /** flatness (ny) per sample 0..255 — snow / surface decisions at query time */
  flat: Uint8Array;
  minY: number;
  maxY: number;
  /** dominant surface code (collider tag) */
  surface: number;
  /** chunk entirely inside the city / airport → no collider needed */
  inside: boolean;
}

const INFO = newInfo();

export function buildChunk(cx: number, cz: number, seed: number): ChunkData {
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  const V = CHUNK_V;
  const M = V + 2;
  const corr = CorridorSet.forRect(x0 - 2, z0 - 2, x0 + CHUNK + 2, z0 + CHUNK + 2);
  const H = new Float64Array(M * M);
  const heights = new Float32Array(V * V);
  const surf = new Uint8Array(V * V);
  const biome = new Uint8Array(V * V);
  const flat = new Uint8Array(V * V);
  // per-sample info needed for shading, kept compactly
  const coast = new Float32Array(V * V);
  const cliff = new Float32Array(V * V);
  const mtn = new Float32Array(V * V);
  const flatD = new Float32Array(V * V);
  const city = new Float32Array(V * V);
  const lake = new Float32Array(V * V);
  const lakeR = new Float32Array(V * V);
  const zone = new Float32Array(V * V);
  const dune = new Float32Array(V * V);
  const carve = new Uint8Array(V * V);
  let inside = true;
  for (let j = -1; j <= V; j++) {
    const az = z0 + j * CHUNK_CELL;
    for (let i = -1; i <= V; i++) {
      const ax = x0 + i * CHUNK_CELL;
      let h = sampleTerrain(ax, az, INFO, seed);
      let ck: number = CARVE.none;
      if (!corr.empty && INFO.flat >= 0) {
        h = corr.carve(h, ax, az);
        ck = corr.kind;
      }
      H[(j + 1) * M + (i + 1)] = h;
      if (i >= 0 && i < V && j >= 0 && j < V) {
        const v = j + i * V;
        if (INFO.flat >= 0) inside = false;
        coast[v] = INFO.coast;
        cliff[v] = INFO.cliff;
        mtn[v] = INFO.mtn;
        flatD[v] = INFO.flat;
        city[v] = INFO.city;
        lake[v] = INFO.lake;
        lakeR[v] = INFO.lakeR;
        zone[v] = INFO.zone;
        dune[v] = INFO.dune;
        carve[v] = ck;
      }
    }
  }
  const hAt = (i: number, j: number) => H[(j + 1) * M + (i + 1)];
  let minY = 1e9;
  let maxY = -1e9;
  const counts = new Int32Array(8);
  for (let i = 0; i < V; i++) {
    for (let j = 0; j < V; j++) {
      const v = j + i * V;
      const h = hAt(i, j);
      heights[v] = h;
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
      const gx = (hAt(i + 1, j) - hAt(i - 1, j)) / (2 * CHUNK_CELL);
      const gz = (hAt(i, j + 1) - hAt(i, j - 1)) / (2 * CHUNK_CELL);
      const ny = 1 / Math.sqrt(1 + gx * gx + gz * gz);
      flat[v] = Math.round(ny * 255);
      INFO.h = h;
      INFO.coast = coast[v];
      INFO.cliff = cliff[v];
      INFO.mtn = mtn[v];
      INFO.flat = flatD[v];
      INFO.city = city[v];
      INFO.lake = lake[v];
      INFO.lakeR = lakeR[v];
      INFO.zone = zone[v];
      INFO.dune = dune[v];
      const s = shadeAt(x0 + i * CHUNK_CELL, z0 + j * CHUNK_CELL, INFO, ny, carve[v], CHUNK_CELL, hash2(seed, i, j, 9), seed);
      surf[v] = s.surf;
      biome[v] = s.biome;
      if (flatD[v] >= 0) counts[s.surf]++;
    }
  }
  let surface: number = SURF.grass;
  let best = -1;
  for (let k = 0; k < counts.length; k++) {
    if (counts[k] > best) {
      best = counts[k];
      surface = k;
    }
  }
  return { cx, cz, heights, surf, biome, flat, minY, maxY, surface, inside };
}
