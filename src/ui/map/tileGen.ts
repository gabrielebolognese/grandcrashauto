import { CONFIG } from '../../config';
import * as TH from '../../terrain/gen/height';
import * as TB from '../../terrain/gen/biome';
import { corridorsInRect } from '../../highway/net/corridors';

/**
 * PURE, worker-safe map tile generator (nav owns). A tile at `level` covers (size · 2^level) metres square in
 * ABSOLUTE coordinates, one pixel per 2^level metres, starting at (tx, tz) · tileWorld. Colours come from the seeded
 * terrain functions (the same ones the 3D terrain uses — its sampler incl. lakes and its vertex palette when
 * available, else the plain height function + our palette): sea depth, lakes, beaches, farmland, forest, rock, snow,
 * with hillshading, contour lines and a foam coast line. Highway corridors (seeded, order-independent) come from a
 * separate request (genRoads) because the highway generator can be slow on its first queries.
 */

export interface TileRequest {
  level: number;
  tx: number;
  tz: number;
  size: number;
}

// The terrain module's richer samplers are looked up dynamically so a rename on their side degrades to the plain
// height function + our palette instead of breaking the build.
type SampleFn = (ax: number, az: number, out: Record<string, number>, seed?: number) => number;
type ShadeFn = (ax: number, az: number, info: Record<string, number>, ny: number, carve: number, cell: number, jit: number, seed?: number) => { r: number; g: number; b: number };
const TH_ = TH as unknown as Record<string, unknown>;
const TB_ = TB as unknown as Record<string, unknown>;
const pick = <T>(m: Record<string, unknown>, k: string): T | null => (typeof m[k] === 'function' ? (m[k] as T) : null);

const KIND_CODE: Record<string, number> = { road: 0, bridge: 1, tunnel: 2, gallery: 3 };

// palette (sRGB 0..255)
const C_SHALLOW = [126, 214, 228];
const C_SEA = [42, 163, 196];
const C_DEEP = [20, 108, 148];
const C_FOAM = [236, 251, 255];
const C_LAKE = [104, 200, 216];
const C_LAKE_D = [46, 150, 186];
const C_SAND = [243, 220, 178];
const C_MEADOW = [194, 222, 146];
const C_FIELDS = [
  [214, 226, 150],
  [186, 214, 132],
  [232, 214, 152],
  [170, 204, 126],
  [222, 232, 170],
];
const C_FOREST = [111, 168, 98];
const C_PINE = [79, 138, 92];
const C_ALPINE = [158, 176, 132];
const C_ROCK = [168, 160, 146];
const C_SNOW = [244, 247, 251];

function hash2(x: number, z: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function mix(out: number[], a: number[], b: number[], t: number): void {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/** Fallback palette from height + slope only. */
function fallbackColor(col: number[], h: number, slope: number, ax: number, az: number, mpp: number): void {
  if (h < 2.2 && slope < 0.25) {
    col[0] = C_SAND[0];
    col[1] = C_SAND[1];
    col[2] = C_SAND[2];
  } else if (h < 160) {
    mix(col, C_MEADOW, C_FOREST, smooth(60, 160, h));
    if (mpp <= 8 && h > 3 && h < 150 && slope < 0.12) {
      const f = C_FIELDS[Math.floor(hash2(Math.floor(ax / 62), Math.floor(az / 47)) * C_FIELDS.length)];
      mix(col, col, f, 0.55 * (1 - smooth(110, 150, h)));
    }
    if (h < 4) mix(col, C_SAND, col, smooth(2.2, 4, h));
  } else if (h < 380) mix(col, C_FOREST, C_PINE, smooth(160, 380, h));
  else if (h < 560) mix(col, C_PINE, C_ALPINE, smooth(380, 560, h));
  else mix(col, C_ALPINE, C_ROCK, smooth(560, 640, h));
  const steep = smooth(0.45, 0.9, slope);
  if (steep > 0) mix(col, col, C_ROCK, steep);
}

/** RGBA pixels of a terrain tile (size × size). */
export function genTerrainTile(req: TileRequest): Uint8ClampedArray {
  const { level, tx, tz, size } = req;
  const mpp = Math.pow(2, level);
  const tw = size * mpp;
  const x0 = tx * tw;
  const z0 = tz * tw;
  const seed = CONFIG.game.seed;
  const sample = pick<SampleFn>(TH_, 'sampleTerrain');
  const mkInfo = pick<() => Record<string, number>>(TH_, 'newInfo');
  const shadeFn = pick<ShadeFn>(TB_, 'shadeAt');
  const base = pick<(ax: number, az: number, seed?: number) => number>(TH_, 'baseHeight');
  const info: Record<string, number> | null = sample && mkInfo ? mkInfo() : null;
  // numeric info fields, cached per grid sample so every pixel is sampled once
  const keys = info ? Object.keys(info).filter((k) => typeof info[k] === 'number') : [];
  const K = keys.length;
  const iLake = keys.indexOf('lake');
  const iCoast = keys.indexOf('coast');
  const G = size + 2;
  const hgt = new Float32Array(G * G);
  const fields = K ? new Float32Array(G * G * K) : null;
  for (let j = 0; j < G; j++) {
    const az = z0 + (j - 0.5) * mpp;
    for (let i = 0; i < G; i++) {
      const ax = x0 + (i - 0.5) * mpp;
      let h: number;
      if (sample && info) {
        h = sample(ax, az, info, seed);
        if (fields) {
          const o = (j * G + i) * K;
          for (let k = 0; k < K; k++) fields[o + k] = info[keys[k]];
        }
      } else h = base ? base(ax, az, seed) : 0;
      hgt[j * G + i] = Number.isFinite(h) ? h : 0;
    }
  }
  const wl = CONFIG.world.waterLevel ?? 0;
  const px = new Uint8ClampedArray(size * size * 4);
  const col = [0, 0, 0];
  const tmp = [0, 0, 0];
  const ex = 1.4 + level * 0.18; // relief exaggeration grows when zoomed out
  const lx = -0.55;
  const ly = 0.72;
  const lz = -0.42;
  const contour = level <= 1 ? 50 : level <= 4 ? 100 : 200;
  for (let j = 0; j < size; j++) {
    const az = z0 + (j + 0.5) * mpp;
    for (let i = 0; i < size; i++) {
      const ax = x0 + (i + 0.5) * mpp;
      const k = (j + 1) * G + (i + 1);
      const h = hgt[k];
      const hl = hgt[k - 1];
      const hr = hgt[k + 1];
      const hu = hgt[k - G];
      const hd = hgt[k + G];
      let lake = NaN;
      let coastD = 1e9;
      if (fields && info) {
        const o = k * K;
        for (let q = 0; q < K; q++) info[keys[q]] = fields[o + q];
        if (iLake >= 0) lake = fields[o + iLake];
        if (iCoast >= 0 && Number.isFinite(fields[o + iCoast])) coastD = fields[o + iCoast];
      }
      const inLake = lake === lake && h < lake - 0.02;
      const water = !inLake && h < wl && (info ? coastD < 60 : true);
      let shade = 1;
      if (inLake) {
        mix(col, C_LAKE, C_LAKE_D, smooth(0.5, 8, lake - h));
        if (hl >= lake || hr >= lake || hu >= lake || hd >= lake) mix(col, col, C_FOAM, 0.6);
      } else if (water) {
        const depth = wl - h;
        // shallow → sea → deep; uniform beyond ~18 m so the seabed's large-scale shapes don't band the open ocean
        if (depth < 5) mix(col, C_SHALLOW, C_SEA, smooth(0, 5, depth));
        else mix(col, C_SEA, C_DEEP, smooth(5, 18, depth));
        if (hl >= wl || hr >= wl || hu >= wl || hd >= wl) mix(col, col, C_FOAM, 0.75);
      } else {
        const dx = (hr - hl) / (2 * mpp);
        const dz = (hd - hu) / (2 * mpp);
        const slope = Math.sqrt(dx * dx + dz * dz);
        let shaded = false;
        if (shadeFn && info) {
          try {
            const sh = shadeFn(ax, az, info, 1 / Math.sqrt(1 + slope * slope), 0, mpp, hash2(i + tx * 977, j + tz * 911), seed);
            if (Number.isFinite(sh.r)) {
              col[0] = sh.r;
              col[1] = sh.g;
              col[2] = sh.b;
              shaded = true;
            }
          } catch {
            /* fall back to our palette */
          }
        }
        if (!shaded) fallbackColor(col, h, slope, ax, az, mpp);
        // snow above ~600 m (less on steep faces)
        const snow = smooth(600, 660, h) * (1 - 0.6 * smooth(0.45, 0.9, slope));
        if (snow > 0) mix(col, col, C_SNOW, snow);
        // hillshade (light from the north-west)
        let nx = -dx * ex;
        let ny = 1;
        let nz = -dz * ex;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= nl;
        ny /= nl;
        nz /= nl;
        const d = nx * lx + ny * ly + nz * lz;
        shade = Math.min(1.25, Math.max(0.55, 0.42 + 0.58 * (d / ly)));
        // contour lines
        if (h > 20 && (Math.floor(h / contour) !== Math.floor(hr / contour) || Math.floor(h / contour) !== Math.floor(hd / contour))) {
          tmp[0] = col[0] * 0.86;
          tmp[1] = col[1] * 0.86;
          tmp[2] = col[2] * 0.88;
          mix(col, col, tmp, 0.7);
        }
      }
      const o = (j * size + i) * 4;
      px[o] = col[0] * shade;
      px[o + 1] = col[1] * shade;
      px[o + 2] = col[2] * shade;
      px[o + 3] = 255;
    }
  }
  return px;
}

/**
 * Seeded highway corridors in (and slightly around) a tile, as tile-pixel segments:
 * x0, y0, x1, y1, width (px), kind (0 road, 1 bridge, 2 tunnel, 3 gallery).
 */
export function genRoads(req: TileRequest): Float32Array {
  const { level, tx, tz, size } = req;
  const mpp = Math.pow(2, level);
  const tw = size * mpp;
  const x0 = tx * tw;
  const z0 = tz * tw;
  const pad = 40;
  const list = corridorsInRect(x0 - pad, z0 - pad, x0 + tw + pad, z0 + tw + pad);
  if (!list || !list.length) return new Float32Array(0);
  const segs = new Float32Array(list.length * 6);
  let n = 0;
  for (const s of list) {
    if (!s || !Number.isFinite(s.ax) || !Number.isFinite(s.bx)) continue;
    segs[n++] = (s.ax - x0) / mpp;
    segs[n++] = (s.az - z0) / mpp;
    segs[n++] = (s.bx - x0) / mpp;
    segs[n++] = (s.bz - z0) / mpp;
    segs[n++] = Math.max(1.6, (2 * (s.halfWidth || 10)) / mpp);
    segs[n++] = KIND_CODE[s.kind] ?? 0;
  }
  return n < segs.length ? segs.slice(0, n) : segs;
}
