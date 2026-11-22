/**
 * Sparse 1 m rasters of the drivable/walkable ground (height + surface code), stored in 100 m tiles that are only
 * allocated where the city put something; everywhere else the analytic base terrain answers. A second, separate
 * "upper" layer holds elevated decks (open viaduct) so ground queries under the viaduct stay on the street.
 * Queries are allocation-free. Pure data (no three.js) — part 2 can add tiles anywhere on the island.
 */

export const SURF = { asphalt: 0, concrete: 1, grass: 2, sand: 3, water: 4, metal: 5 } as const;
export type SurfCode = (typeof SURF)[keyof typeof SURF];

const TILE = 100; // m (matches the chunk size)
const RES = 1; // m per cell
const N = TILE / RES;
const OFF = 1024;
const key = (tx: number, tz: number) => (tx + OFF) * 4096 + (tz + OFF);

export class HeightField {
  private ground = new Map<number, Float32Array>();
  private surf = new Map<number, Uint8Array>();
  private upper = new Map<number, Float32Array>();
  // single-entry caches for the hot query path
  private lgKey = -1;
  private lg: Float32Array | null = null;
  private lsKey = -1;
  private ls: Uint8Array | null = null;
  private luKey = -1;
  private lu: Float32Array | null | undefined = undefined;

  constructor(
    readonly baseHeight: (x: number, z: number) => number,
    readonly baseSurf: (x: number, z: number) => SurfCode,
  ) {}

  // ───────────── tile access ─────────────
  private tileG(tx: number, tz: number, create: boolean): Float32Array | null {
    const k = key(tx, tz);
    let t = this.ground.get(k);
    if (!t && create) {
      t = new Float32Array(N * N);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) t[j * N + i] = this.baseHeight(tx * TILE + (i + 0.5) * RES, tz * TILE + (j + 0.5) * RES);
      this.ground.set(k, t);
      const s = new Uint8Array(N * N);
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) s[j * N + i] = this.baseSurf(tx * TILE + (i + 0.5) * RES, tz * TILE + (j + 0.5) * RES);
      this.surf.set(k, s);
    }
    return t ?? null;
  }

  private tileU(tx: number, tz: number, create: boolean): Float32Array | null {
    const k = key(tx, tz);
    let t = this.upper.get(k);
    if (!t && create) {
      t = new Float32Array(N * N).fill(NaN);
      this.upper.set(k, t);
    }
    return t ?? null;
  }

  /** Iterate cells whose centre lies in the rect; cb(x, z, index, groundTile, surfTile). Creates tiles. */
  forCells(minX: number, maxX: number, minZ: number, maxZ: number, cb: (x: number, z: number, idx: number, g: Float32Array, s: Uint8Array) => void): void {
    const i0 = Math.ceil(minX / RES - 0.5), i1 = Math.floor(maxX / RES - 0.5);
    const j0 = Math.ceil(minZ / RES - 0.5), j1 = Math.floor(maxZ / RES - 0.5);
    for (let j = j0; j <= j1; j++) {
      const tz = Math.floor(j / N), lj = j - tz * N;
      for (let i = i0; i <= i1; i++) {
        const tx = Math.floor(i / N), li = i - tx * N;
        const g = this.tileG(tx, tz, true)!;
        const s = this.surf.get(key(tx, tz))!;
        cb((i + 0.5) * RES, (j + 0.5) * RES, lj * N + li, g, s);
      }
    }
  }

  forUpperCells(minX: number, maxX: number, minZ: number, maxZ: number, cb: (x: number, z: number, idx: number, u: Float32Array) => void): void {
    const i0 = Math.ceil(minX / RES - 0.5), i1 = Math.floor(maxX / RES - 0.5);
    const j0 = Math.ceil(minZ / RES - 0.5), j1 = Math.floor(maxZ / RES - 0.5);
    for (let j = j0; j <= j1; j++) {
      const tz = Math.floor(j / N), lj = j - tz * N;
      for (let i = i0; i <= i1; i++) {
        const tx = Math.floor(i / N), li = i - tx * N;
        cb((i + 0.5) * RES, (j + 0.5) * RES, lj * N + li, this.tileU(tx, tz, true)!);
      }
    }
  }

  // ───────────── queries ─────────────
  private gCell(i: number, j: number): number {
    const tx = Math.floor(i / N), tz = Math.floor(j / N);
    const k = key(tx, tz);
    if (k !== this.lgKey) {
      this.lgKey = k;
      this.lg = this.ground.get(k) ?? null;
    }
    if (!this.lg) return this.baseHeight((i + 0.5) * RES, (j + 0.5) * RES);
    return this.lg[(j - tz * N) * N + (i - tx * N)];
  }

  private uCell(i: number, j: number): number {
    const tx = Math.floor(i / N), tz = Math.floor(j / N);
    const k = key(tx, tz);
    if (k !== this.luKey) {
      this.luKey = k;
      this.lu = this.upper.get(k) ?? null;
    }
    if (!this.lu) return NaN;
    return this.lu[(j - tz * N) * N + (i - tx * N)];
  }

  /** Bilinear ground height (lowest drivable layer). */
  height(x: number, z: number): number {
    const fx = x / RES - 0.5, fz = z / RES - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const ax = fx - i, az = fz - j;
    const h00 = this.gCell(i, j), h10 = this.gCell(i + 1, j), h01 = this.gCell(i, j + 1), h11 = this.gCell(i + 1, j + 1);
    return (h00 * (1 - ax) + h10 * ax) * (1 - az) + (h01 * (1 - ax) + h11 * ax) * az;
  }

  /** Elevated deck height at x,z or NaN. Bilinear where all 4 cells are valid, else nearest valid. */
  upperHeight(x: number, z: number): number {
    const fx = x / RES - 0.5, fz = z / RES - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    const ax = fx - i, az = fz - j;
    const h00 = this.uCell(i, j), h10 = this.uCell(i + 1, j), h01 = this.uCell(i, j + 1), h11 = this.uCell(i + 1, j + 1);
    if (h00 === h00 && h10 === h10 && h01 === h01 && h11 === h11) {
      return (h00 * (1 - ax) + h10 * ax) * (1 - az) + (h01 * (1 - ax) + h11 * ax) * az;
    }
    const ni = ax < 0.5 ? i : i + 1, nj = az < 0.5 ? j : j + 1;
    return this.uCell(ni, nj);
  }

  surface(x: number, z: number): SurfCode {
    const i = Math.floor(x / RES), j = Math.floor(z / RES);
    const tx = Math.floor(i / N), tz = Math.floor(j / N);
    const k = key(tx, tz);
    if (k !== this.lsKey) {
      this.lsKey = k;
      this.ls = this.surf.get(k) ?? null;
    }
    if (!this.ls) return this.baseSurf(x, z);
    return this.ls[(j - tz * N) * N + (i - tx * N)] as SurfCode;
  }

  /** Memory used by tiles (bytes) — for the debug summary. */
  get bytes(): number {
    return this.ground.size * N * N * 5 + this.upper.size * N * N * 4;
  }
}
