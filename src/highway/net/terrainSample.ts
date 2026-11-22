import { CONFIG } from '../../config';
import * as TH from '../../terrain/gen/height';
const { baseHeight } = TH;

/**
 * Natural terrain sampling for the PURE highway generator (worker-safe: no three.js, no DOM).
 * All coordinates ABSOLUTE. Wrapped so we can count calls (profiling) and reset caches when the seed changes.
 */
export const sampleStats = { calls: 0 };

export function H(ax: number, az: number): number {
  sampleStats.calls++;
  return baseHeight(ax, az);
}

let cacheSeed = NaN;
const resetters: (() => void)[] = [];

/** Register a cache clear function; called whenever CONFIG.game.seed changes (workers may set it after import). */
export function onSeedChange(fn: () => void): void {
  resetters.push(fn);
}

/** Call at the top of every public entry point: clears all caches if the seed changed. */
export function checkSeed(): number {
  const s = CONFIG.game.seed;
  if (s !== cacheSeed) {
    cacheSeed = s;
    for (const fn of resetters) fn();
  }
  return s;
}

const coastZCache = new Map<number, number>();
const coastXCache = new Map<number, number>();
onSeedChange(() => {
  coastZCache.clear();
  coastXCache.clear();
});

const isSea = (h0: number, h1: number, h2: number) => h0 < 0.25 && h1 < -0.4 && h2 < -1.2;

/** z of the south coastline (land → sea going +z) at absolute x. */
export function coastZAt(x: number): number {
  const fn = (TH as { southShoreZ?: (ax: number) => number }).southShoreZ;
  if (fn) return fn(x); // terrain's analytic shoreline (exact, cheap)
  const key = Math.round(x);
  const c = coastZCache.get(key);
  if (c !== undefined) return c;
  const base = CONFIG.world.coast.southZ;
  let lo = NaN;
  for (let z = base - 900; z < base + 1800; z += 30) {
    if (isSea(H(key, z), H(key, z + 60), H(key, z + 150))) {
      lo = z;
      break;
    }
  }
  let res = base;
  if (!Number.isNaN(lo)) {
    let a = lo - 30, b = lo;
    for (let k = 0; k < 6; k++) {
      const m = (a + b) / 2;
      if (H(key, m) < 0.25) b = m;
      else a = m;
    }
    res = (a + b) / 2;
  }
  coastZCache.set(key, res);
  return res;
}

/** x of the west coastline (land → sea going −x) at absolute z. */
export function coastXAt(z: number): number {
  const fn = (TH as { westShoreX?: (az: number) => number }).westShoreX;
  if (fn) return fn(z);
  const key = Math.round(z);
  const c = coastXCache.get(key);
  if (c !== undefined) return c;
  const base = CONFIG.world.coast.westX;
  let hi = NaN;
  for (let x = base + 900; x > base - 1800; x -= 30) {
    if (isSea(H(x, key), H(x - 60, key), H(x - 150, key))) {
      hi = x;
      break;
    }
  }
  let res = base;
  if (!Number.isNaN(hi)) {
    let a = hi + 30, b = hi;
    for (let k = 0; k < 6; k++) {
      const m = (a + b) / 2;
      if (H(m, key) < 0.25) b = m;
      else a = m;
    }
    res = (a + b) / 2;
  }
  coastXCache.set(key, res);
  return res;
}
