import * as THREE from 'three';

/**
 * Procedural fx textures, generated once at init (no downloads):
 *  - ATLAS: 4x4 sprite cells (128 px each). Channel R = shading detail (lit sprites) or core heat (emissive sprites),
 *    A = coverage. All cells are authored "vertical, tip up" so velocity-stretched sprites trail their tip.
 *  - RAMPS: per-ramp colour-over-life (row 2i: linear RGB + alpha) and params-over-life (row 2i+1: emissive,
 *    additive, sphere-lighting amount). Sampled in the vertex shader with the particle's normalized age.
 */

export const CELL = {
  SMOKE_A: 0,
  SMOKE_B: 1,
  FLAME_A: 2,
  FLAME_B: 3,
  SPARK: 4,
  DUST: 5,
  CHIP: 6,
  SHARD: 7,
  GLOW: 8,
  RING: 9,
  SCORCH: 10,
  STAR: 11,
  BILLOW: 12,
  WISP: 13,
  LEAF: 14,
  DROP: 15,
} as const;

export const RAMP = {
  FIREBALL: 0,
  HOTCORE: 1,
  FLAME: 2,
  SPARK: 3,
  SMOKE_DARK: 4,
  SMOKE_LIGHT: 5,
  DUST: 6,
  SOLID: 7,
  GLASS: 8,
  FLASH: 9,
  SHOCK: 10,
  RING_DUST: 11,
  SCORCH: 12,
  EMBER: 13,
  GLINT: 14,
  FIRE_SMOKE: 15,
  WATER: 16,
  COLUMN: 17,
  TURBO: 18,
  VAPOR: 19,
  HEAT: 20,
  FOAM: 21,
  STEAM: 22,
  TAIL: 23,
  SLICK: 24,
  MIST: 25,
} as const;

/** Rows reserved in the ramp texture (2 per ramp). Room for part-2 ramps (steam, foam, mist, fuel fire...). */
export const RAMP_SLOTS = 32;
export const RAMP_ROWS = RAMP_SLOTS * 2;
const RAMP_W = 128;
const ATLAS_CELLS = 4;
const CELL_PX = 128;

// ─────────────────────────────── noise ───────────────────────────────
function hash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let fx = x - ix;
  let fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(x: number, y: number, seed: number, oct = 4): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f, y * f, seed + i * 17);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a: number, b: number, v: number) => {
  const t = sat((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

type Painter = (u: number, v: number, out: number[]) => void;

// ─────────────────────────────── cell painters (u,v in [-1,1], v up) ───────────────────────────────
function billowPainter(circles: number[][], seed: number): Painter {
  return (u, v, o) => {
    let dens = 0;
    let front = -1;
    let frontNz = 0;
    for (const [cx, cy, r, depth] of circles) {
      const dx = (u - cx) / r;
      const dy = (v - cy) / r;
      const q = 1 - dx * dx - dy * dy;
      if (q > dens) dens = q;
      if (q > 0) {
        const nz = Math.sqrt(q);
        const z = depth + nz * r;
        if (z > front) {
          front = z;
          frontNz = nz;
        }
      }
    }
    const n = fbm(u * 2.6 + 11, v * 2.6 - 3, seed);
    const n2 = fbm(u * 6 + 5, v * 6 + 9, seed + 7, 3);
    const a = sstep(0.0, 0.42, dens + (n - 0.5) * 0.38) * (0.8 + 0.2 * n2);
    // crevices between sub-puffs darker, puff centres brighter
    o[0] = sat((0.5 + 0.5 * frontNz) * (0.82 + 0.36 * (n2 - 0.5)));
    o[1] = a * (1 - sstep(0.93, 1.0, Math.max(Math.abs(u), Math.abs(v))));
  };
}

function flameShape(u: number, v: number, seed: number, wobble: number): [number, number] {
  const uu = u + (fbm(u * 2.2 + 3, v * 1.6 - 7, seed) - 0.5) * wobble * sstep(-0.7, 0.9, v);
  let w: number;
  if (v > -0.45) w = 0.5 * Math.pow(sat((0.92 - v) / 1.37), 0.75);
  else {
    const k = (v + 0.45) / 0.42;
    w = 0.5 * Math.sqrt(sat(1 - k * k));
  }
  if (w <= 0.0001) return [0, 0];
  const inside = 1 - Math.abs(uu) / w;
  const a = sstep(0.0, 0.4, inside);
  const core = sstep(0.15, 0.85, inside) * (1 - sstep(-0.35, 0.65, v));
  return [core, a];
}

const PAINTERS: Painter[] = [];
PAINTERS[CELL.SMOKE_A] = billowPainter(
  [
    [0, -0.08, 0.52, 0.2],
    [-0.42, -0.24, 0.38, 0.0],
    [0.42, -0.2, 0.4, 0.05],
    [-0.2, 0.3, 0.4, 0.1],
    [0.24, 0.34, 0.36, 0.08],
    [0.04, 0.58, 0.26, 0.0],
  ],
  101,
);
PAINTERS[CELL.SMOKE_B] = billowPainter(
  [
    [0, 0, 0.5, 0.2],
    [-0.46, 0.1, 0.34, 0.0],
    [0.45, 0.04, 0.36, 0.04],
    [-0.16, -0.42, 0.36, 0.1],
    [0.26, -0.38, 0.34, 0.06],
    [0.1, 0.44, 0.38, 0.12],
  ],
  202,
);
PAINTERS[CELL.FLAME_A] = (u, v, o) => {
  const [c, a] = flameShape(u, v, 303, 0.5);
  o[0] = c;
  o[1] = a;
};
PAINTERS[CELL.FLAME_B] = (u, v, o) => {
  let c = 0;
  let a = 0;
  const tongues = [
    [0, 0, 1, 0.45],
    [-0.32, -0.25, 0.7, 0.7],
    [0.34, -0.2, 0.75, 0.6],
  ];
  for (const [ox, oy, s, wob] of tongues) {
    const [cc, aa] = flameShape((u - ox) / s, (v - oy) / s + (1 - s) * -0.6, 404 + ox * 10, wob);
    c = Math.max(c, cc);
    a = Math.max(a, aa);
  }
  o[0] = c;
  o[1] = a;
};
PAINTERS[CELL.SPARK] = (u, v, o) => {
  // vertical streak, hot head at the bottom, fading tail upward
  const w = Math.exp(-((u / 0.5) ** 2)) * (1 - sstep(0.85, 1.0, Math.abs(u)));
  let along: number;
  if (v < -0.72) along = sstep(-0.95, -0.72, v);
  else along = Math.pow(sat(1 - (v + 0.72) / 1.64), 1.6);
  o[1] = w * along;
  o[0] = sat(w * w * along * 1.4);
};
PAINTERS[CELL.DUST] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const n = fbm(u * 2.4 + 1, v * 2.4 + 2, 505);
  const n2 = fbm(u * 5 + 7, v * 5 + 3, 506, 3);
  o[1] = sstep(1.0, 0.2, r + (n - 0.5) * 0.6) * (0.55 + 0.45 * n2);
  o[0] = 0.7 + 0.3 * n2;
};
const CHIP_PTS = [
  [-0.72, -0.38],
  [-0.18, -0.82],
  [0.62, -0.52],
  [0.76, 0.22],
  [0.18, 0.78],
  [-0.58, 0.48],
];
function insidePoly(pts: number[][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
PAINTERS[CELL.CHIP] = (u, v, o) => {
  if (!insidePoly(CHIP_PTS, u, v)) {
    o[0] = 0;
    o[1] = 0;
    return;
  }
  const ang = Math.atan2(v - 0.05, u + 0.05);
  const sector = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 3) % 3;
  o[0] = [0.42, 0.72, 1.0][sector];
  o[1] = 1;
};
const SHARD_PTS = [
  [-0.28, -0.86],
  [0.34, -0.58],
  [0.04, 0.9],
];
PAINTERS[CELL.SHARD] = (u, v, o) => {
  if (!insidePoly(SHARD_PTS, u, v)) {
    o[0] = 0;
    o[1] = 0;
    return;
  }
  // highlight along the left edge
  const ex = SHARD_PTS[2][0] - SHARD_PTS[0][0];
  const ey = SHARD_PTS[2][1] - SHARD_PTS[0][1];
  const len = Math.hypot(ex, ey);
  const d = Math.abs((u - SHARD_PTS[0][0]) * ey - (v - SHARD_PTS[0][1]) * ex) / len;
  o[0] = 0.45 + 0.55 * Math.exp(-d * 14);
  o[1] = 0.92;
};
PAINTERS[CELL.GLOW] = (u, v, o) => {
  const r2 = u * u + v * v;
  const e = Math.exp(-4);
  o[1] = sat((Math.exp(-r2 * 4) - e) / (1 - e));
  o[0] = sat(1 - Math.sqrt(r2) * 0.45);
};
PAINTERS[CELL.RING] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const rim = Math.exp(-(((r - 0.8) / 0.07) ** 2));
  const inner = 0.28 * Math.exp(-(((r - 0.72) / 0.2) ** 2));
  o[1] = sat(rim + inner) * (1 - sstep(0.9, 1.0, r));
  o[0] = 1;
};
PAINTERS[CELL.SCORCH] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const ca = u / (r + 1e-6);
  const sa = v / (r + 1e-6);
  const edge = fbm(ca * 1.8 + 3, sa * 1.8 + 3, 1010);
  const rr = r * (1 + (edge - 0.5) * 0.7);
  const streak = vnoise(ca * 7 + 20, sa * 7 + 20, 1011);
  const speck = fbm(u * 9, v * 9, 1012, 3);
  const a = (1 - sstep(0.22, 0.92, rr)) * (0.72 + 0.28 * streak) * (0.8 + 0.2 * speck);
  const tail = (1 - sstep(0.5, 1.0, r)) * sstep(0.62, 0.8, streak) * 0.5; // radial soot streaks
  o[1] = sat(Math.max(a, tail)) * (1 - sstep(0.94, 1.0, r));
  o[0] = 0.5;
};
PAINTERS[CELL.STAR] = (u, v, o) => {
  const r2 = u * u + v * v;
  const core = Math.exp(-r2 * 22);
  const flare = Math.exp(-Math.abs(u) * 26) * Math.exp(-Math.abs(v) * 3.6) + Math.exp(-Math.abs(v) * 26) * Math.exp(-Math.abs(u) * 3.6);
  o[1] = sat(core + 0.55 * flare) * (1 - sstep(0.85, 1.0, Math.max(Math.abs(u), Math.abs(v))));
  o[0] = sat(core * 1.3 + 0.2);
};
PAINTERS[CELL.BILLOW] = (u, v, o) => {
  const r = Math.hypot(u, v);
  const n = fbm(u * 2.3 + 4, v * 2.3 + 8, 1212);
  const t = fbm(u * 3.6 - 2, v * 3.6 + 1, 1213);
  o[1] = sstep(1.0, 0.58, r + (n - 0.5) * 0.55);
  o[0] = sat(0.3 + 0.75 * t * (1 - 0.35 * r));
};
PAINTERS[CELL.WISP] = (u, v, o) => {
  const n = fbm(u * 2 + 9, v * 2 + 1, 1313);
  const n2 = fbm(u * 4.5 + 2, v * 4.5 + 6, 1314, 3);
  const d = Math.hypot(u * 0.85, v * 1.2);
  o[1] = sstep(1.0, 0.05, d + (n - 0.5) * 0.7) * (0.6 + 0.4 * n2);
  o[0] = 0.75 + 0.25 * n2;
};
PAINTERS[CELL.LEAF] = (u, v, o) => {
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  const x = u * c - v * s;
  const y = u * s + v * c;
  const e = (x / 0.38) ** 2 + (y / 0.85) ** 2;
  if (e > 1) {
    o[0] = 0;
    o[1] = 0;
    return;
  }
  o[0] = (0.55 + 0.45 * (y * 0.5 + 0.5)) * (Math.abs(x) < 0.04 ? 0.7 : 1);
  o[1] = 1;
};
PAINTERS[CELL.DROP] = (u, v, o) => {
  const r = Math.hypot(u, v);
  o[1] = sstep(0.9, 0.55, r);
  o[0] = 0.62 + 0.38 * Math.exp(-((u + 0.3) ** 2 + (v - 0.3) ** 2) * 18);
};

const SUPERSAMPLE = new Set<number>([CELL.CHIP, CELL.SHARD, CELL.LEAF]);

export function createAtlas(): THREE.DataTexture {
  const W = ATLAS_CELLS * CELL_PX;
  const data = new Uint8Array(W * W * 4);
  const out = [0, 0];
  const margin = 1.06; // keep content away from cell borders (mip bleeding)
  for (let cell = 0; cell < 16; cell++) {
    const paint = PAINTERS[cell];
    const cx = (cell % ATLAS_CELLS) * CELL_PX;
    const cy = Math.floor(cell / ATLAS_CELLS) * CELL_PX;
    const ss = SUPERSAMPLE.has(cell) ? 3 : 1;
    for (let py = 0; py < CELL_PX; py++) {
      for (let px = 0; px < CELL_PX; px++) {
        let r = 0;
        let a = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const u = ((px + (sx + 0.5) / ss) / CELL_PX) * 2 - 1;
            const v = 1 - ((py + (sy + 0.5) / ss) / CELL_PX) * 2; // first pixel row of the cell = top (v=+1)
            paint(u * margin, v * margin, out);
            r += out[0] * out[1];
            a += out[1];
          }
        }
        const n = ss * ss;
        const alpha = a / n;
        const shade = a > 0 ? r / a : 0;
        const i = ((cy + py) * W + cx + px) * 4;
        const R = Math.round(sat(shade) * 255);
        data[i] = R;
        data[i + 1] = R;
        data[i + 2] = R;
        data[i + 3] = Math.round(sat(alpha) * 255);
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, W, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  tex.name = 'fx-atlas';
  return tex;
}

// ─────────────────────────────── ramps ───────────────────────────────
/** Color keys: [t, r, g, b, a] (linear). Param keys: [t, emissive, additive, sphereLighting]. */
interface RampDef {
  color: number[][] | ((t: number) => number[]);
  params: number[][];
}

function sampleKeys(keys: number[][], t: number, n: number): number[] {
  if (t <= keys[0][0]) return keys[0].slice(1, 1 + n);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const a = keys[i - 1];
      const b = keys[i];
      const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      const s = f * f * (3 - 2 * f); // smooth between keys
      const out: number[] = [];
      for (let k = 1; k <= n; k++) out.push(a[k] + (b[k] - a[k]) * s);
      return out;
    }
  }
  return keys[keys.length - 1].slice(1, 1 + n);
}

const RAMPS: RampDef[] = [];
RAMPS[RAMP.FIREBALL] = {
  color: [
    [0.0, 1.0, 0.82, 0.42, 0.0],
    [0.015, 1.0, 0.7, 0.24, 1.0],
    [0.04, 1.0, 0.48, 0.09, 1.0],
    [0.11, 0.95, 0.3, 0.035, 1.0],
    [0.24, 0.72, 0.12, 0.018, 1.0],
    [0.36, 0.32, 0.055, 0.018, 0.97],
    [0.48, 0.1, 0.065, 0.055, 0.92],
    [0.66, 0.1, 0.095, 0.095, 0.8],
    [0.84, 0.2, 0.19, 0.2, 0.45],
    [1.0, 0.3, 0.3, 0.32, 0.0],
  ],
  params: [
    [0.0, 1, 0.18, 0],
    [0.07, 1, 0.0, 0],
    [0.3, 1, 0, 0.1],
    [0.5, 0, 0, 1],
    [1.0, 0, 0, 1],
  ],
};
RAMPS[RAMP.HOTCORE] = {
  color: (t) => {
    const c = sampleKeys(
      [
        [0, 1, 0.95, 0.8],
        [0.25, 1, 0.7, 0.25],
        [1, 1, 0.35, 0.06],
      ],
      t,
      3,
    );
    return [...c, Math.pow(1 - t, 2) * sstep(0, 0.04, t)];
  },
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.FLAME] = {
  color: [
    [0.0, 1.0, 0.85, 0.5, 0.0],
    [0.08, 1.0, 0.68, 0.22, 1.0],
    [0.25, 1.0, 0.45, 0.08, 0.95],
    [0.6, 0.85, 0.2, 0.03, 0.7],
    [1.0, 0.35, 0.06, 0.02, 0.0],
  ],
  params: [[0, 1, 0.25, 0]],
};
RAMPS[RAMP.SPARK] = {
  color: [
    [0.0, 1.0, 0.88, 0.55, 1.0],
    [0.25, 1.0, 0.66, 0.22, 1.0],
    [0.7, 1.0, 0.38, 0.07, 0.9],
    [1.0, 0.7, 0.13, 0.02, 0.0],
  ],
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.SMOKE_DARK] = {
  color: [
    [0.0, 0.55, 0.3, 0.15, 0.0],
    [0.07, 0.3, 0.2, 0.15, 0.85],
    [0.16, 0.15, 0.135, 0.13, 0.85],
    [0.5, 0.24, 0.23, 0.23, 0.62],
    [1.0, 0.42, 0.42, 0.44, 0.0],
  ],
  params: [
    [0, 0.85, 0, 0.3],
    [0.12, 0, 0, 1],
  ],
};
RAMPS[RAMP.SMOKE_LIGHT] = {
  color: [
    [0.0, 0.9, 0.9, 0.92, 0.0],
    [0.1, 0.9, 0.9, 0.92, 0.55],
    [0.45, 0.9, 0.9, 0.93, 0.32],
    [1.0, 0.92, 0.92, 0.95, 0.0],
  ],
  params: [[0, 0, 0, 1]],
};
RAMPS[RAMP.DUST] = {
  color: [
    [0.0, 1, 1, 1, 0.0],
    [0.08, 1, 1, 1, 0.8],
    [0.45, 1, 1, 1, 0.45],
    [1.0, 1, 1, 1, 0.0],
  ],
  params: [[0, 0, 0, 0.85]],
};
RAMPS[RAMP.SOLID] = {
  color: [
    [0.0, 1, 1, 1, 1],
    [0.85, 1, 1, 1, 1],
    [1.0, 1, 1, 1, 0],
  ],
  params: [[0, 0, 0, 0]],
};
RAMPS[RAMP.GLASS] = {
  color: [
    [0.0, 1, 1, 1, 0.9],
    [0.75, 1, 1, 1, 0.75],
    [1.0, 1, 1, 1, 0],
  ],
  params: [[0, 0.2, 0.25, 0]],
};
RAMPS[RAMP.FLASH] = {
  color: (t) => {
    const c = sampleKeys(
      [
        [0, 1, 0.97, 0.9],
        [0.4, 1, 0.75, 0.4],
        [1, 1, 0.45, 0.15],
      ],
      t,
      3,
    );
    return [...c, (1 - t) * (1 - t)];
  },
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.SHOCK] = {
  color: (t) => [1, 0.95, 0.86, sstep(0, 0.06, t) * Math.pow(1 - t, 1.6)],
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.RING_DUST] = {
  color: (t) => [1, 1, 1, sstep(0, 0.05, t) * 0.8 * Math.pow(1 - t, 1.3)],
  params: [[0, 0, 0, 0]],
};
RAMPS[RAMP.SCORCH] = {
  color: [
    [0.0, 1, 1, 1, 0],
    [0.012, 1, 1, 1, 0.95],
    [0.72, 1, 1, 1, 0.88],
    [1.0, 1, 1, 1, 0],
  ],
  params: [[0, 0, 0, 0]],
};
RAMPS[RAMP.EMBER] = {
  color: (t) => {
    const c = sampleKeys(
      [
        [0, 1, 0.85, 0.5],
        [0.4, 1, 0.5, 0.15],
        [1, 0.65, 0.12, 0.03],
      ],
      t,
      3,
    );
    const flicker = 0.62 + 0.38 * Math.sin(t * 57) * Math.sin(t * 23 + 1);
    return [...c, flicker * sstep(0, 0.05, t) * (1 - sstep(0.65, 1, t))];
  },
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.GLINT] = {
  color: (t) => [0.95, 0.98, 1, Math.pow(0.5 + 0.5 * Math.sin(t * 41), 6) * (1 - t)],
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.FIRE_SMOKE] = {
  color: [
    [0.0, 0.35, 0.2, 0.1, 0.0],
    [0.08, 0.13, 0.11, 0.1, 0.8],
    [0.5, 0.2, 0.19, 0.19, 0.6],
    [1.0, 0.38, 0.38, 0.4, 0.0],
  ],
  params: [
    [0, 0.6, 0, 0.5],
    [0.1, 0, 0, 1],
  ],
};
RAMPS[RAMP.WATER] = {
  color: [
    [0.0, 0.92, 0.96, 1.0, 0.85],
    [0.6, 0.92, 0.96, 1.0, 0.7],
    [1.0, 0.95, 0.98, 1.0, 0.0],
  ],
  params: [[0, 0.1, 0.1, 0.5]],
};
RAMPS[RAMP.COLUMN] = {
  color: [
    [0.0, 0.2, 0.18, 0.17, 0.0],
    [0.1, 0.18, 0.17, 0.17, 0.75],
    [0.6, 0.32, 0.31, 0.32, 0.45],
    [1.0, 0.48, 0.48, 0.5, 0.0],
  ],
  params: [[0, 0, 0, 1]],
};

RAMPS[RAMP.TURBO] = {
  color: [
    [0.0, 0.75, 0.88, 1.0, 0.0],
    [0.05, 0.6, 0.8, 1.0, 1.0],
    [0.2, 0.25, 0.5, 1.0, 0.95],
    [0.55, 0.28, 0.22, 0.95, 0.65],
    [1.0, 0.25, 0.08, 0.6, 0.0],
  ],
  params: [[0, 1, 0.4, 0]],
};
RAMPS[RAMP.VAPOR] = {
  color: [
    [0.0, 0.95, 0.97, 1.0, 0.0],
    [0.06, 0.95, 0.97, 1.0, 0.6],
    [0.55, 0.95, 0.97, 1.0, 0.32],
    [1.0, 0.95, 0.97, 1.0, 0.0],
  ],
  params: [[0, 0.25, 0, 0.5]],
};
RAMPS[RAMP.HEAT] = {
  color: (t) => [1, 0.97, 0.93, 0.035 * sstep(0, 0.15, t) * (1 - sstep(0.4, 1, t))],
  params: [[0, 0.3, 0.3, 0]],
};
RAMPS[RAMP.FOAM] = {
  color: [
    [0.0, 0.95, 0.98, 1.0, 0.0],
    [0.04, 0.95, 0.98, 1.0, 0.8],
    [0.6, 0.95, 0.98, 1.0, 0.55],
    [1.0, 0.95, 0.98, 1.0, 0.0],
  ],
  params: [[0, 0.05, 0, 0]],
};
RAMPS[RAMP.STEAM] = {
  color: [
    [0.0, 0.95, 0.95, 0.97, 0.0],
    [0.06, 0.95, 0.95, 0.97, 0.65],
    [0.45, 0.95, 0.95, 0.97, 0.32],
    [1.0, 0.95, 0.95, 0.97, 0.0],
  ],
  params: [[0, 0.1, 0, 1]],
};
RAMPS[RAMP.TAIL] = {
  color: (t) => [1, 0.12 + 0.1 * (1 - t), 0.06, (1 - t) * (1 - t) * sstep(0, 0.05, t)],
  params: [[0, 1, 1, 0]],
};
RAMPS[RAMP.SLICK] = {
  color: [
    [0.0, 1, 1, 1, 0.0],
    [0.03, 1, 1, 1, 0.85],
    [0.8, 1, 1, 1, 0.75],
    [1.0, 1, 1, 1, 0.0],
  ],
  params: [[0, 0, 0, 0]],
};
RAMPS[RAMP.MIST] = {
  color: [
    [0.0, 0.97, 0.97, 0.98, 0.0],
    [0.04, 0.97, 0.97, 0.98, 0.85],
    [0.35, 0.96, 0.96, 0.98, 0.45],
    [1.0, 0.95, 0.95, 0.97, 0.0],
  ],
  params: [[0, 0.2, 0, 0.8]],
};

/**
 * RGBA8 (universally supported, incl. vertex texture fetch on mobile GPUs). Colour rows are gamma-2 encoded
 * (stored sqrt(c), decoded c = v²) for precision in the darks; param rows are linear.
 */
export function createRamps(): THREE.DataTexture {
  const data = new Uint8Array(RAMP_W * RAMP_ROWS * 4);
  const b = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let r = 0; r < RAMP_SLOTS; r++) {
    const def = RAMPS[r];
    for (let x = 0; x < RAMP_W; x++) {
      const t = x / (RAMP_W - 1);
      let c = [0, 0, 0, 0];
      let p = [0, 0, 0];
      if (def) {
        c = typeof def.color === 'function' ? def.color(t) : sampleKeys(def.color, t, 4);
        p = sampleKeys(def.params, t, 3);
      }
      const i0 = ((r * 2) * RAMP_W + x) * 4;
      const i1 = ((r * 2 + 1) * RAMP_W + x) * 4;
      data[i0] = b(Math.sqrt(Math.max(0, c[0] ?? 0)));
      data[i0 + 1] = b(Math.sqrt(Math.max(0, c[1] ?? 0)));
      data[i0 + 2] = b(Math.sqrt(Math.max(0, c[2] ?? 0)));
      data[i0 + 3] = b(c[3] ?? 0);
      data[i1] = b(p[0] ?? 0);
      data[i1 + 1] = b(p[1] ?? 0);
      data[i1 + 2] = b(p[2] ?? 0);
      data[i1 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, RAMP_W, RAMP_ROWS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'fx-ramps';
  return tex;
}
