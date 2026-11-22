import { Rng } from '../../core/rng';

/**
 * Seeded 2D simplex noise + fractal helpers. PURE + worker-safe (no three.js, no DOM).
 * Only arithmetic + Math.floor in the hot path, so results are bit-identical in workers and on the main thread.
 */

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
// 12 gradient directions (Gustavson's grad3 projected to 2D)
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);

export class Noise2 {
  private perm = new Uint8Array(512);
  private pm12 = new Uint8Array(512);

  constructor(readonly seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = Rng.from(seed, 0x7e44a1);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.pm12[i] = this.perm[i] % 12;
    }
  }

  /** Simplex noise in [-1, 1]. */
  n(x: number, y: number): number {
    const perm = this.perm;
    const pm = this.pm12;
    const s = (x + y) * F2;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const t = (i + j) * G2;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    let i1 = 0;
    let j1 = 1;
    if (x0 > y0) {
      i1 = 1;
      j1 = 0;
    }
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const g = pm[ii + perm[jj]];
      t0 *= t0;
      n += t0 * t0 * (GX[g] * x0 + GY[g] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const g = pm[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n += t1 * t1 * (GX[g] * x1 + GY[g] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const g = pm[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n += t2 * t2 * (GX[g] * x2 + GY[g] * y2);
    }
    return 70 * n;
  }

  /** Fractal sum, roughly [-1, 1]. Octaves are rotated/offset to hide lattice artefacts. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2.03, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.n(fx + o * 17.13, fy - o * 9.71);
      norm += amp;
      amp *= gain;
      // rotate ~37° and scale
      const nx = (fx * 0.8 - fy * 0.6) * lacunarity;
      const ny = (fx * 0.6 + fy * 0.8) * lacunarity;
      fx = nx;
      fy = ny;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1]: sharp crests (mountain ridgelines). */
  ridged(x: number, y: number, octaves: number, lacunarity = 2.1, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let weight = 1;
    let fx = x;
    let fy = y;
    for (let o = 0; o < octaves; o++) {
      let v = 1 - Math.abs(this.n(fx + o * 31.7, fy + o * 13.3));
      v *= v;
      v *= weight;
      weight = v * 1.8;
      if (weight > 1) weight = 1;
      sum += v * amp;
      norm += amp;
      amp *= gain;
      const nx = (fx * 0.8 - fy * 0.6) * lacunarity;
      const ny = (fx * 0.6 + fy * 0.8) * lacunarity;
      fx = nx;
      fy = ny;
    }
    return sum / norm;
  }
}

let cached: Noise2 | null = null;
/** Noise tables for a seed (cached; rebuilt only when the seed changes). */
export function noiseFor(seed: number): Noise2 {
  if (!cached || cached.seed !== seed) cached = new Noise2(seed);
  return cached;
}

// ── small pure helpers ──
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const sstep = (a: number, b: number, v: number) => {
  let t = (v - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Polynomial smooth minimum (k = blend width). */
export const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
/** Integer lattice hash → [0, 1). */
export function hash2(seed: number, x: number, z: number, salt = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
