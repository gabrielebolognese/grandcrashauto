import { Rng, hashString } from '../../core/rng';
import { cfg, edgeDesc, type EdgeDesc } from './lattice';
import { H, checkSeed, onSeedChange, sampleStats } from './terrainSample';
import { placeFeatures, type Features } from './features';
import { planGen, type PlanOut } from './plan';

/**
 * Edge routing (PURE, worker-safe, ABSOLUTE coordinates). For one macro edge:
 *  1. plan: straight/arc lead-ins that leave each node along its tangent, a dynamic-programming search through a
 *     lateral corridor that prefers terrain at the ideal grade line (valleys, passes, contours along the coast), then a
 *     clamped cubic B-spline smoothed until its curvature radius ≥ designRadius; resampled every ~6 m by arc length.
 *  2. profile: ground → G-Lipschitz envelopes (cut vs fill balance) → linear node zones → two box passes (vertical
 *     curves) → water clearance. |grade| ≤ designGrade by construction.
 *  3. structures by road height vs ground: bridge / tunnel / gallery / road (cut & fill).
 *  4. features (rest stops, kickers, mega jumps, gantries, lights) — see features.ts.
 *  5. corridor segments for terrain carving.
 * The computation is a generator so the main thread can time-slice it; workers drain it synchronously.
 */

export const K_ROAD = 0;
export const K_BRIDGE = 1;
export const K_TUNNEL = 2;
export const K_GALLERY = 3;
export const KIND_NAMES = ['road', 'bridge', 'tunnel', 'gallery'] as const;

export interface Span {
  s0: number;
  s1: number;
  kind: number;
  /** galleries: +1 = open toward +l (valley on the right), −1 = open toward −l */
  side: number;
}

export interface EdgeRoute {
  key: string;
  desc: EdgeDesc;
  /** intervals: samples 0..n */
  n: number;
  ds: number;
  L: number;
  x: Float64Array;
  z: Float64Array;
  tx: Float32Array;
  tz: Float32Array;
  /** centreline road surface height */
  y: Float64Array;
  /** natural ground */
  g: Float32Array;
  /** superelevation: surface height at lateral l (+ = right of +s) is y − bank·l */
  bank: Float32Array;
  kind: Uint8Array;
  spans: Span[];
  forkA: number;
  forkB: number;
  exitA: boolean;
  exitB: boolean;
  lanes: number;
  features: Features;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** corridor segments: [ax, az, bx, bz, ya, yb, halfWidth, kind] × nSegs */
  segs: Float64Array;
  nSegs: number;
  stats: { minRadius: number; maxGrade: number; samples: number; ms: number; windows: number };
}

// ───────────────────────────── cross-section helpers ─────────────────────────────
export function laneStart(): number {
  const C = cfg();
  return C.medianHalf + C.innerShoulder;
}
/** Lanes per direction at station s (tapers from the 2-lane city stubs at exits). */
export function lanesAt(r: EdgeRoute, s: number): number {
  let n = r.lanes;
  if (r.exitA) n = 2 + (n - 2) * smooth01((s - 60) / 220);
  if (r.exitB) n = Math.min(n, 2 + (r.lanes - 2) * smooth01((r.L - s - 60) / 220));
  return n;
}
export function halfPavedAt(r: EdgeRoute, s: number): number {
  return laneStart() + lanesAt(r, s) * cfg().laneW + cfg().outerShoulder;
}
export function halfPavedMax(lanes: number): number {
  return laneStart() + lanes * cfg().laneW + cfg().outerShoulder;
}
const smooth01 = (t: number) => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

// ───────────────────────────── profile ─────────────────────────────
function boxSmooth(y: Float64Array, hw: number, ds: number, gA: number, gB: number): void {
  const n = y.length - 1;
  // padded copy with linear extrapolation at both ends
  const pad = new Float64Array(n + 1 + 2 * hw);
  for (let i = 0; i < pad.length; i++) {
    const k = i - hw;
    if (k < 0) pad[i] = y[0] + gA * k * ds;
    else if (k > n) pad[i] = y[n] - gB * (k - n) * ds;
    else pad[i] = y[k];
  }
  const pre = new Float64Array(pad.length + 1);
  for (let i = 0; i < pad.length; i++) pre[i + 1] = pre[i] + pad[i];
  const w = 2 * hw + 1;
  for (let k = 0; k <= n; k++) y[k] = (pre[k + w] - pre[k]) / w;
}

// ───────────────────────────── main generator ─────────────────────────────
export function* routeGen(key: string): Generator<void, EdgeRoute | null> {
  const seed = checkSeed();
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const calls0 = sampleStats.calls;
  const d = edgeDesc(key);
  if (!d) return null;
  const C = cfg();
  const rng = Rng.from(seed, hashString(key), 0x726f75);
  const plan: PlanOut = yield* planGen(d, rng);
  const { n, ds, L, x, z, tx, tz } = plan;
  // ── ground ──
  const g = new Float32Array(n + 1);
  const PS = 3;
  let last = -1;
  for (let i = 0; i <= n; i += PS) {
    g[i] = H(x[i], z[i]);
    if (last >= 0) for (let k = last + 1; k < i; k++) g[k] = g[last] + ((g[i] - g[last]) * (k - last)) / (i - last);
    last = i;
    if (i % 90 === 0) yield;
  }
  if (last !== n) {
    g[n] = H(x[n], z[n]);
    for (let k = last + 1; k < n; k++) g[k] = g[last] + ((g[n] - g[last]) * (k - last)) / (n - last);
  }
  // ── profile ──
  const G = C.designGrade;
  const t = new Float64Array(n + 1);
  {
    const hw = Math.max(1, Math.round(42 / ds));
    const pre = new Float64Array(n + 2);
    for (let i = 0; i <= n; i++) pre[i + 1] = pre[i] + g[i];
    for (let i = 0; i <= n; i++) {
      const a = Math.max(0, i - hw), b = Math.min(n, i + hw);
      t[i] = (pre[b + 1] - pre[a]) / (b - a + 1);
      if (d.ref.coastal) t[i] = Math.max(t[i], C.coastMinY * 0.75);
      if (g[i] < 0.3) t[i] = Math.max(t[i], 10);
      t[i] = Math.max(t[i], 2.5);
    }
  }
  const below = new Float64Array(t), above = new Float64Array(t);
  const gs = G * ds;
  for (let i = 1; i <= n; i++) {
    below[i] = Math.min(below[i], below[i - 1] + gs);
    above[i] = Math.max(above[i], above[i - 1] - gs);
  }
  for (let i = n - 1; i >= 0; i--) {
    below[i] = Math.min(below[i], below[i + 1] + gs);
    above[i] = Math.max(above[i], above[i + 1] - gs);
  }
  const y = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) y[i] = 0.47 * below[i] + 0.53 * above[i];
  const waterLift = () => {
    const w = new Float64Array(n + 1).fill(-1e9);
    for (let i = 0; i <= n; i++) if (g[i] < 0.3) w[i] = 8.5;
    for (let i = 1; i <= n; i++) w[i] = Math.max(w[i], w[i - 1] - gs);
    for (let i = n - 1; i >= 0; i--) w[i] = Math.max(w[i], w[i + 1] - gs);
    for (let i = 0; i <= n; i++) if (w[i] > y[i]) y[i] = w[i];
  };
  waterLift();
  const HW_S = Math.max(2, Math.round(90 / ds));
  const reach = 2 * HW_S * ds + ds;
  const gA = d.endA.grade, gB = d.endB.grade;
  const clampEnds = (extra: number) => {
    const LeA = d.endA.lin + extra, LeB = d.endB.lin + extra;
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      const ca = d.ya + gA * Math.min(s, LeA), ea = G * Math.max(0, s - LeA);
      let v = Math.min(ca + ea, Math.max(ca - ea, y[i]));
      const r = L - s;
      const cb = d.yb + gB * Math.min(r, LeB), eb = G * Math.max(0, r - LeB);
      v = Math.min(cb + eb, Math.max(cb - eb, v));
      y[i] = v;
    }
  };
  clampEnds(reach);
  boxSmooth(y, HW_S, ds, gA, gB);
  boxSmooth(y, HW_S, ds, gA, gB);
  waterLift();
  clampEnds(0);
  yield;
  let maxGrade = 0;
  for (let i = 0; i < n; i++) maxGrade = Math.max(maxGrade, Math.abs(y[i + 1] - y[i]) / ds);
  // ── structures ──
  const kind = new Uint8Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const dd = y[i] - g[i];
    if (dd > C.bridgeDrop || (g[i] < 0.3 && dd > 2)) kind[i] = K_BRIDGE;
    else if (dd < -C.tunnelRise) kind[i] = K_TUNNEL;
  }
  const runs = (k: number): [number, number][] => {
    const out: [number, number][] = [];
    let s0 = -1;
    for (let i = 0; i <= n + 1; i++) {
      const on = i <= n && kind[i] === k;
      if (on && s0 < 0) s0 = i;
      if (!on && s0 >= 0) {
        out.push([s0, i - 1]);
        s0 = -1;
      }
    }
    return out;
  };
  const fill = (i0: number, i1: number, k: number) => {
    for (let i = Math.max(0, i0); i <= Math.min(n, i1); i++) kind[i] = k;
  };
  const tidy = (k: number, minLen: number, maxGap: number) => {
    let rs = runs(k);
    for (let r = 1; r < rs.length; r++) if ((rs[r][0] - rs[r - 1][1]) * ds < maxGap) fill(rs[r - 1][1], rs[r][0], k);
    rs = runs(k);
    for (const [a, b] of rs) if ((b - a + 1) * ds < minLen) fill(a, b, K_ROAD);
  };
  tidy(K_BRIDGE, 42, 70);
  tidy(K_TUNNEL, 130, 160);
  // no tunnels in fork / exit zones; extend bridges by one sample (abutments)
  const noTunA = Math.ceil((d.endA.fork + (d.endA.exit ? 250 : 120)) / ds);
  const noTunB = Math.ceil((d.endB.fork + (d.endB.exit ? 250 : 120)) / ds);
  for (let i = 0; i <= n; i++) if (kind[i] === K_TUNNEL && (i < noTunA || i > n - noTunB)) kind[i] = K_ROAD;
  tidy(K_TUNNEL, 130, 0);
  for (const [a, b] of runs(K_BRIDGE)) {
    if (a > 0 && kind[a - 1] === K_ROAD) kind[a - 1] = K_BRIDGE;
    if (b < n && kind[b + 1] === K_ROAD) kind[b + 1] = K_BRIDGE;
  }
  // galleries on steep side slopes
  const gallerySide = new Int8Array(n + 1);
  {
    const off = halfPavedMax(d.lanes) + 30;
    let i0 = -1, side0 = 0;
    const cand: [number, number, number][] = [];
    for (let i = 0; i <= n; i += 6) {
      let side = 0;
      if (kind[i] === K_ROAD) {
        const rx = -tz[i], rz = tx[i];
        const gr = H(x[i] + rx * off, z[i] + rz * off), gl = H(x[i] - rx * off, z[i] - rz * off);
        const up = Math.max(gr, gl), down = Math.min(gr, gl);
        if (up - y[i] > 9 && (up - down) / (2 * off) > 0.45 && down < y[i] + 4) side = gr > gl ? -1 : 1; // open toward the downhill side
      }
      if (side !== 0 && i0 < 0) {
        i0 = i;
        side0 = side;
      } else if ((side === 0 || side !== side0) && i0 >= 0) {
        cand.push([i0, i - 1, side0]);
        i0 = side !== 0 ? i : -1;
        side0 = side;
      }
      if (i % 120 === 0) yield;
    }
    if (i0 >= 0) cand.push([i0, n, side0]);
    for (const [a, b, side] of cand) {
      if ((b - a) * ds < 120 || !rng.chance(C.galleryChance)) continue;
      const a2 = a + 2, b2 = Math.min(b - 2, a2 + Math.round(420 / ds));
      if (a2 < noTunA || b2 > n - noTunB) continue;
      for (let i = a2; i <= b2; i++) if (kind[i] === K_ROAD) {
        kind[i] = K_GALLERY;
        gallerySide[i] = side;
      }
    }
  }
  const spans: Span[] = [];
  {
    let s0 = 0;
    for (let i = 1; i <= n + 1; i++) {
      if (i > n || kind[i] !== kind[s0] || (kind[i] === K_GALLERY && gallerySide[i] !== gallerySide[s0])) {
        spans.push({ s0: s0 * ds, s1: (i - 1) * ds, kind: kind[s0], side: gallerySide[s0] });
        s0 = i;
      }
    }
  }
  // ── superelevation ──
  const bank = new Float32Array(n + 1);
  {
    const K = C.bankMax * C.designRadius;
    for (let i = 1; i < n; i++) {
      const cr = tx[i - 1] * tz[i + 1] - tz[i - 1] * tx[i + 1];
      const kap = cr / (2 * ds);
      bank[i] = Math.max(-C.bankMax, Math.min(C.bankMax, kap * K));
    }
    const zA = (d.endA.fork > 0 ? d.endA.fork : d.endA.exit ? d.endA.lin : 0), zB = (d.endB.fork > 0 ? d.endB.fork : d.endB.exit ? d.endB.lin : 0);
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      const f = Math.min(smooth01((s - zA) / 120), smooth01((L - s - zB) / 120));
      bank[i] *= f;
    }
    const hw = 8;
    const src = Float64Array.from(bank);
    boxSmooth(src, hw, ds, 0, 0);
    for (let i = 0; i <= n; i++) {
      const s = i * ds;
      bank[i] = s < zA || L - s < zB ? 0 : src[i];
    }
  }
  const route: EdgeRoute = {
    key, desc: d, n, ds, L, x, z, tx, tz, y, g, bank, kind, spans,
    forkA: d.endA.fork, forkB: d.endB.fork, exitA: d.endA.exit, exitB: d.endB.exit, lanes: d.lanes,
    features: { rest: [], kickers: [], megas: [], gantries: [], lightsA: false, lightsB: false },
    minX: 0, minZ: 0, maxX: 0, maxZ: 0, segs: new Float64Array(0), nSegs: 0,
    stats: { minRadius: plan.minRadius, maxGrade, samples: 0, ms: 0, windows: plan.windows },
  };
  yield;
  // ── features ──
  route.features = placeFeatures(route, rng);
  // ── corridor segments + bbox ──
  buildSegments(route);
  route.stats.samples = sampleStats.calls - calls0;
  route.stats.ms = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
  return route;
}

function buildSegments(r: EdgeRoute): void {
  const segs: number[] = [];
  const hwMain = halfPavedMax(r.lanes) + 2.2;
  const STEP = 3;
  for (let i = 0; i < r.n; i += STEP) {
    const j = Math.min(r.n, i + STEP);
    const mid = (i + j) >> 1;
    segs.push(r.x[i], r.z[i], r.x[j], r.z[j], r.y[i], r.y[j], hwMain, r.kind[mid]);
  }
  const lateral = (s: number, l: number, out: number[]) => {
    const f = s / r.ds;
    const i = Math.max(0, Math.min(r.n - 1, Math.floor(f)));
    const u = f - i;
    const px = r.x[i] + (r.x[i + 1] - r.x[i]) * u, pz = r.z[i] + (r.z[i + 1] - r.z[i]) * u;
    const ttx = r.tx[i] + (r.tx[i + 1] - r.tx[i]) * u, ttz = r.tz[i] + (r.tz[i + 1] - r.tz[i]) * u;
    const tl = Math.hypot(ttx, ttz) || 1;
    out[0] = px + (-ttz / tl) * l;
    out[1] = pz + (ttx / tl) * l;
    out[2] = r.y[i] + (r.y[i + 1] - r.y[i]) * u - (r.bank[i] + (r.bank[i + 1] - r.bank[i]) * u) * l;
  };
  const a3 = [0, 0, 0], b3 = [0, 0, 0];
  const strip = (s0: number, s1: number, l: number, hw: number, kind: number, dy: number) => {
    const steps = Math.max(1, Math.ceil((s1 - s0) / 18));
    for (let k = 0; k < steps; k++) {
      lateral(s0 + ((s1 - s0) * k) / steps, l, a3);
      lateral(s0 + ((s1 - s0) * (k + 1)) / steps, l, b3);
      segs.push(a3[0], a3[1], b3[0], b3[1], a3[2] + dy, b3[2] + dy, hw, kind);
    }
  };
  for (const rs of r.features.rest) {
    const lc = rs.side * (rs.lOff + rs.w / 2);
    strip(rs.s0 - 30, rs.s1 + 30, lc, rs.w / 2 + 5, K_ROAD, 0);
  }
  for (const m of r.features.megas) {
    const lo = Math.min(m.sA, m.sEnd), hi = Math.max(m.sA, m.sEnd);
    const gLo = Math.min(m.sLip, m.sLand0), gHi = Math.max(m.sLip, m.sLand0);
    strip(lo, gLo, m.laneL, m.laneW / 2 + 3, K_ROAD, 0);
    strip(gLo, gHi, m.laneL, m.laneW / 2 + 3, m.canyon ? K_BRIDGE : K_ROAD, m.canyon ? 0 : -m.pitDepth);
    strip(gHi, hi, m.laneL, m.laneW / 2 + 3, K_ROAD, 0);
  }
  r.segs = Float64Array.from(segs);
  r.nSegs = segs.length / 8;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < r.nSegs; k++) {
    const o = k * 8, hw = r.segs[o + 6];
    minX = Math.min(minX, r.segs[o] - hw, r.segs[o + 2] - hw);
    maxX = Math.max(maxX, r.segs[o] + hw, r.segs[o + 2] + hw);
    minZ = Math.min(minZ, r.segs[o + 1] - hw, r.segs[o + 3] - hw);
    maxZ = Math.max(maxZ, r.segs[o + 1] + hw, r.segs[o + 3] + hw);
  }
  r.minX = minX;
  r.minZ = minZ;
  r.maxX = maxX;
  r.maxZ = maxZ;
}

// ───────────────────────────── cache ─────────────────────────────
const routeCache = new Map<string, EdgeRoute | null>();
onSeedChange(() => routeCache.clear());
export const ROUTE_CACHE_LIMIT = { value: 220 };

export function peekRoute(key: string): EdgeRoute | null | undefined {
  checkSeed();
  return routeCache.get(key);
}

export function storeRoute(key: string, r: EdgeRoute | null): void {
  routeCache.set(key, r);
  if (routeCache.size > ROUTE_CACHE_LIMIT.value) {
    for (const k of routeCache.keys()) {
      routeCache.delete(k);
      if (routeCache.size <= ROUTE_CACHE_LIMIT.value * 0.85) break;
    }
  }
}

/** Synchronous route (workers / tests). */
export function getRoute(key: string): EdgeRoute | null {
  const c = peekRoute(key);
  if (c !== undefined) {
    // refresh LRU position
    routeCache.delete(key);
    routeCache.set(key, c);
    return c;
  }
  const it = routeGen(key);
  let r = it.next();
  while (!r.done) r = it.next();
  storeRoute(key, r.value);
  return r.value;
}
