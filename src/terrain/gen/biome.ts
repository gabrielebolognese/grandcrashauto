import { CONFIG } from '../../config';
import { hash2, mix, noiseFor, sstep } from './noise';
import type { TerrainInfo } from './height';

/**
 * Biomes, surfaces and vertex colours. PURE + worker-safe.
 * Colours are sRGB bytes (the terrain shader converts to linear) — pastel coastal palette, low-poly friendly.
 */

export const BIOME = {
  ocean: 0, beach: 1, dunes: 2, cliffs: 3, suburbs: 4, farmland: 5, meadow: 6, forest: 7, pine: 8,
  rockyHills: 9, alpine: 10, rock: 11, snow: 12, lake: 13, road: 14,
} as const;
export const BIOME_NAMES = [
  'ocean', 'beach', 'dunes', 'cliffs', 'suburbs', 'farmland', 'meadow', 'forest', 'pine',
  'rockyHills', 'alpine', 'rock', 'snow', 'lake', 'road',
];

/** Surface codes (map to core SurfaceMaterial names via SURF_NAMES). */
export const SURF = { grass: 0, sand: 1, rock: 2, snow: 3, dirt: 4, gravel: 5, asphalt: 6 } as const;
export const SURF_NAMES = ['grass', 'sand', 'rock', 'snow', 'dirt', 'gravel', 'asphalt'] as const;

/** Corridor carve kinds (see carve.ts). */
export const CARVE = { none: 0, road: 1, cut: 2, fill: 3, bridge: 4, tunnel: 5 } as const;

type RGB = [number, number, number];
const hex = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

export const PAL = {
  sand: hex(0xf3dcb2), wetSand: hex(0xdcc49a), dune: hex(0xecd3a2), duneGrass: hex(0xc8c98c),
  seabed: hex(0xe6cfa2), seabedDeep: hex(0xb3a284), lakeBed: hex(0x9c9a78), mud: hex(0xb5a07c),
  grassCoast: hex(0xaed385), grass: hex(0x97c66c), grassLush: hex(0x7fb862), meadowDry: hex(0xc9c97f),
  lawn: hex(0xa6d47f), hedge: hex(0x5f9450),
  forest: hex(0x5e9a52), forestDark: hex(0x4c8749), pine: hex(0x4d7c4e), pineDark: hex(0x3f6a46),
  rockyHill: hex(0xb4a791), rock: hex(0x9d949c), rockDark: hex(0x827b88), cliff: hex(0xccb08e), cliffDark: hex(0xab9176),
  alpine: hex(0xa6c47f), alpineDry: hex(0xbab987),
  dirt: hex(0xb8936a), cut: hex(0xb69e80), gravel: hex(0xbdb6aa),
};

// Crop palette (pastel patchwork) + weights.
const CROPS: RGB[] = [
  hex(0xe9d07a), // wheat
  hex(0x9fcd6b), // green crop
  hex(0xf2df6a), // canola (butter)
  hex(0xb9a7e6), // lavender
  hex(0xa9825d), // ploughed
  hex(0xa3dcae), // pasture (mint)
  hex(0xcbbc8c), // fallow
  hex(0xb6d06d), // corn
  hex(0xffb99a), // poppy/peach meadow (rare)
];
const CROP_W = [0.22, 0.2, 0.09, 0.08, 0.12, 0.15, 0.07, 0.05, 0.02];
const CROP_CUM: number[] = [];
{
  let s = 0;
  for (const w of CROP_W) CROP_CUM.push((s += w));
}
export const CROP_STRIPED = [false, false, false, true, true, false, false, true, false];

export interface Shade {
  r: number;
  g: number;
  b: number;
  biome: number;
  surf: number;
}

/** Farmland block: fields are a rotated grid per 1.4 km block (shared by colours, fences and hay). */
export interface FieldBlock {
  bi: number;
  bj: number;
  angle: number;
  cos: number;
  sin: number;
  W: number;
  L: number;
  salt: number;
}
export const FIELD_BLOCK = 1400;
export function fieldBlock(seed: number, bi: number, bj: number, out: FieldBlock = { bi: 0, bj: 0, angle: 0, cos: 1, sin: 0, W: 50, L: 90, salt: 0 }): FieldBlock {
  const ang = (hash2(seed, bi, bj, 901) - 0.5) * 1.1;
  out.bi = bi;
  out.bj = bj;
  out.angle = ang;
  out.cos = Math.cos(ang);
  out.sin = Math.sin(ang);
  out.W = 36 + 48 * hash2(seed, bi, bj, 902);
  out.L = 60 + 90 * hash2(seed, bi, bj, 903);
  out.salt = (bi * 7 + bj * 13) | 0;
  return out;
}
/** Crop index of field (fi, fj) in a block. */
export function cropOf(seed: number, B: FieldBlock, fi: number, fj: number): number {
  const r = hash2(seed, fi, fj, 904 + B.salt);
  let crop = 0;
  while (crop < CROP_CUM.length - 1 && r > CROP_CUM[crop]) crop++;
  return crop;
}
export const CROP_PASTURE = 5;
export const CROP_WHEAT = 0;
export const CROP_FALLOW = 6;

let blkKey = NaN;
const BLK: FieldBlock = { bi: 0, bj: 0, angle: 0, cos: 1, sin: 0, W: 50, L: 90, salt: 0 };

/** Field / crop at an absolute point. */
export interface FieldInfo {
  crop: number;
  edge: number; // m to the nearest field border
  hedge: boolean;
  u: number;
  v: number;
  fi: number;
  fj: number;
  block: FieldBlock;
}
const FIELD: FieldInfo = { crop: 0, edge: 0, hedge: false, u: 0, v: 0, fi: 0, fj: 0, block: BLK };

export function fieldAt(ax: number, az: number, seed = CONFIG.game.seed): FieldInfo {
  const bi = Math.floor(ax / FIELD_BLOCK);
  const bj = Math.floor(az / FIELD_BLOCK);
  const key = bi * 100003 + bj + seed * 7;
  if (key !== blkKey) {
    blkKey = key;
    fieldBlock(seed, bi, bj, BLK);
  }
  const u = ax * BLK.cos + az * BLK.sin;
  const v = -ax * BLK.sin + az * BLK.cos;
  const fi = Math.floor(u / BLK.W);
  const fj = Math.floor(v / BLK.L);
  const fu = u / BLK.W - fi;
  const fv = v / BLK.L - fj;
  const eu = Math.min(fu, 1 - fu) * BLK.W;
  const ev = Math.min(fv, 1 - fv) * BLK.L;
  FIELD.crop = cropOf(seed, BLK, fi, fj);
  FIELD.edge = Math.min(eu, ev);
  FIELD.hedge = hash2(seed, fi, fj, 905 + BLK.salt) < 0.55;
  FIELD.u = u;
  FIELD.v = v;
  FIELD.fi = fi;
  FIELD.fj = fj;
  return FIELD;
}

/** Temperature / moisture (0..1-ish) for biome decisions. */
export function climate(ax: number, az: number, h: number, coast: number, seed = CONFIG.game.seed): { moist: number; temp: number } {
  const n = noiseFor(seed);
  CLIM.moist = 0.5 + 0.38 * n.fbm(ax / 6200 + 200.5, az / 6200 - 300.2, 2) + 0.18 * (1 - sstep(200, 2500, coast));
  CLIM.temp = 0.62 + 0.25 * n.n(ax / 9000 - 40.1, az / 9000 + 70.7) - h / 1150 - Math.max(0, -az) / 60000;
  return CLIM;
}
const CLIM = { moist: 0.5, temp: 0.5 };

/** Forest density field in [0,1] (shared by colours + scatter). */
export function forestAt(ax: number, az: number, moist: number, seed = CONFIG.game.seed): number {
  const n = noiseFor(seed);
  const f = n.fbm(ax / 900 + 31.1, az / 900 - 12.9, 3) + (moist - 0.5) * 0.9;
  return sstep(0.02, 0.32, f);
}

/** Farmland mask in [0,1] (regional). */
export function farmMaskAt(ax: number, az: number, seed = CONFIG.game.seed): number {
  const n = noiseFor(seed);
  return sstep(-0.3, 0.05, n.n(ax / 3800 + 77.7, az / 3800 - 11.1));
}

const OUT: Shade = { r: 0, g: 0, b: 0, biome: 0, surf: 0 };
let cr = 0;
let cg = 0;
let cb = 0;
function set(c: RGB): void {
  cr = c[0];
  cg = c[1];
  cb = c[2];
}
function blend(c: RGB, t: number): void {
  if (t <= 0) return;
  if (t >= 1) {
    cr = c[0];
    cg = c[1];
    cb = c[2];
    return;
  }
  cr += (c[0] - cr) * t;
  cg += (c[1] - cg) * t;
  cb += (c[2] - cb) * t;
}

/**
 * Colour + biome + surface for a terrain vertex.
 * @param ny face-pair normal Y (1 = flat)
 * @param carve corridor carve kind (CARVE.*)
 * @param cell grid cell size (m) — fine detail (crop rows, hedges) only at small cells
 * @param jit 0..1 per-vertex random (face jitter)
 */
export function shadeAt(ax: number, az: number, info: TerrainInfo, ny: number, carve: number, cell: number, jit: number, seed = CONFIG.game.seed): Shade {
  const n = noiseFor(seed);
  const h = info.h;
  const c = info.coast;
  let biome: number = BIOME.meadow;
  let surf: number = SURF.grass;

  // ── underwater: seabed / lake bed ──
  if (h < 0.15 && c < 40) {
    set(PAL.wetSand);
    blend(PAL.seabed, sstep(0.2, 1.5, -h));
    blend(PAL.seabedDeep, sstep(3, 22, -h));
    if (ny < 0.72) blend(PAL.rockDark, 0.6);
    biome = BIOME.ocean;
    surf = SURF.sand;
    return finish(jit, biome, surf, 0.05);
  }
  const lakeUnder = info.lake === info.lake && h < info.lake - 0.05;
  const cl = climate(ax, az, h, c, seed);
  const moist = cl.moist;
  const temp = cl.temp;

  // ── base grass ──
  set(PAL.meadowDry);
  blend(PAL.grass, sstep(0.2, 0.55, moist));
  blend(PAL.grassLush, sstep(0.55, 0.85, moist) * 0.8);
  blend(PAL.grassCoast, (1 - sstep(150, 900, c)) * 0.55);
  // large-scale tonal patches
  const tone = n.n(ax / 320 + 9.1, az / 320 - 3.3);
  cr *= 1 + tone * 0.035;
  cg *= 1 + tone * 0.05;

  // ── suburbs (lawns) / farmland patchwork ──
  const sub = (1 - sstep(450, 1700, info.city)) * sstep(0.95, 0.99, ny);
  const farm = farmMaskAt(ax, az, seed) * sstep(0.955, 0.985, ny) * (1 - sstep(70, 170, h)) * sstep(110, 260, c) * (1 - info.mtn) * (1 - sub);
  if (sub > 0.05) {
    blend(PAL.lawn, sub * 0.8);
    if (sub > 0.5) biome = BIOME.suburbs;
  }
  if (farm > 0.02) {
    const f = fieldAt(ax, az, seed);
    let crop = CROPS[f.crop];
    let cropSurf: number = f.crop === 4 ? SURF.dirt : SURF.grass;
    const hedge = f.hedge && f.edge < Math.max(1.4, cell * 0.55);
    if (hedge) {
      crop = PAL.hedge;
      cropSurf = SURF.grass;
    }
    blend(crop, farm);
    if (!hedge && cell <= 4 && CROP_STRIPED[f.crop] && farm > 0.5) {
      const row = (f.u / 3.2) - Math.floor(f.u / 3.2);
      if (row < 0.5) {
        cr *= 0.93;
        cg *= 0.93;
        cb *= 0.93;
      }
    }
    if (farm > 0.5) {
      biome = BIOME.farmland;
      surf = cropSurf;
    }
  }

  // ── forests ──
  const fw = forestAt(ax, az, moist, seed) * sstep(0.7, 0.86, ny) * (1 - farm * 0.95) * (1 - sub * 0.75) * (1 - sstep(640, 760, h)) * sstep(30, 160, c);
  if (fw > 0.02) {
    const pineT = sstep(0.44, 0.24, temp);
    let fr = mix(PAL.forest[0], PAL.pine[0], pineT);
    let fg = mix(PAL.forest[1], PAL.pine[1], pineT);
    let fb = mix(PAL.forest[2], PAL.pine[2], pineT);
    const dk = sstep(0.4, 0.9, fw) * 0.6;
    fr = mix(fr, mix(PAL.forestDark[0], PAL.pineDark[0], pineT), dk);
    fg = mix(fg, mix(PAL.forestDark[1], PAL.pineDark[1], pineT), dk);
    fb = mix(fb, mix(PAL.forestDark[2], PAL.pineDark[2], pineT), dk);
    const t = fw * 0.9;
    cr += (fr - cr) * t;
    cg += (fg - cg) * t;
    cb += (fb - cb) * t;
    if (fw > 0.45) biome = pineT > 0.5 ? BIOME.pine : BIOME.forest;
  }

  // ── dry rocky hills ──
  const dry = sstep(0.4, 0.24, moist) * sstep(70, 210, h) * (1 - farm);
  if (dry > 0.02) {
    blend(PAL.rockyHill, dry * 0.75);
    if (dry > 0.55 && biome === BIOME.meadow) biome = BIOME.rockyHills;
  }

  // ── alpine meadows ──
  const alp = sstep(470, 640, h + (jit - 0.5) * 40);
  if (alp > 0.02) {
    blend(PAL.alpine, alp * 0.85);
    blend(PAL.alpineDry, alp * sstep(0.45, 0.2, moist) * 0.6);
    if (alp > 0.5) biome = BIOME.alpine;
  }

  // ── rock: steep slopes, high peaks, sea cliffs ──
  const steep = sstep(0.82, 0.62, ny);
  const high = sstep(760, 900, h + (jit - 0.5) * 60) * sstep(0.95, 0.8, ny);
  const rockW = Math.max(steep, high);
  if (rockW > 0.02) {
    const coastal = (1 - sstep(60, 260, c)) * Math.max(info.cliff, 0.4);
    const rk = sstep(0.3, 0.75, n.n(ax / 90 + 4.4, az / 90 - 2.2) * 0.5 + 0.5 + (jit - 0.5) * 0.3);
    const rr = mix(mix(PAL.rock[0], PAL.rockDark[0], rk), mix(PAL.cliff[0], PAL.cliffDark[0], rk), coastal);
    const rg = mix(mix(PAL.rock[1], PAL.rockDark[1], rk), mix(PAL.cliff[1], PAL.cliffDark[1], rk), coastal);
    const rb = mix(mix(PAL.rock[2], PAL.rockDark[2], rk), mix(PAL.cliff[2], PAL.cliffDark[2], rk), coastal);
    cr += (rr - cr) * rockW;
    cg += (rg - cg) * rockW;
    cb += (rb - cb) * rockW;
    if (rockW > 0.5) {
      biome = coastal > 0.5 ? BIOME.cliffs : BIOME.rock;
      surf = SURF.rock;
    }
  }

  // ── beaches + dunes ──
  const sandW = (1 - sstep(14, 40, c + n.n(ax / 60, az / 60) * 9)) * (1 - info.cliff * sstep(0.65, 0.85, 1 - ny + 0.3)) * (h < 6 ? 1 : 0);
  if (info.dune > 0.05) {
    const dw = info.dune * (0.75 + 0.25 * n.n(ax / 30 + 2.2, az / 30));
    blend(PAL.dune, dw);
    blend(PAL.duneGrass, dw * sstep(0.2, 0.6, n.n(ax / 22 - 3.1, az / 22 + 8.8)) * 0.75);
    if (dw > 0.5) {
      biome = BIOME.dunes;
      surf = SURF.sand;
    }
  }
  if (sandW > 0.02) {
    blend(PAL.sand, sandW);
    blend(PAL.wetSand, sandW * (1 - sstep(0.15, 0.9, h)));
    if (sandW > 0.5) {
      biome = BIOME.beach;
      surf = SURF.sand;
    }
  }

  // ── lakes: muddy/sandy shore, lake bed ──
  if (info.lake === info.lake) {
    if (lakeUnder) {
      set(PAL.mud);
      blend(PAL.lakeBed, sstep(0.3, 3, info.lake - h));
      biome = BIOME.lake;
      surf = SURF.dirt;
    } else if (h < info.lake + 1.2 && info.lakeR < 1.35) {
      blend(PAL.sand, 0.65 * (1 - sstep(0.3, 1.2, h - info.lake)));
      surf = SURF.sand;
    }
  }

  // ── highway corridor formation / cuttings / embankments ──
  if (carve === CARVE.road) {
    set(PAL.gravel);
    biome = BIOME.road;
    surf = SURF.gravel;
  } else if (carve === CARVE.cut) {
    blend(steep > 0.3 ? PAL.rockDark : PAL.cut, 0.85);
    surf = steep > 0.3 ? SURF.rock : SURF.dirt;
  } else if (carve === CARVE.fill) {
    blend(PAL.grass, 0.5);
  }

  return finish(jit, biome, surf, 0.085);
}

function finish(jit: number, biome: number, surf: number, amount: number): Shade {
  const k = 1 + (jit - 0.5) * amount;
  OUT.r = cr * k;
  OUT.g = cg * k;
  OUT.b = cb * k;
  OUT.biome = biome;
  OUT.surf = surf;
  return OUT;
}
