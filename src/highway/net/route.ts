import { CONFIG } from '../../config';
import { Rng, hashString } from '../../core/rng';
import { cfg, edgeDesc, type EdgeDesc } from './lattice';
import { H, checkSeed, onSeedChange, sampleStats } from './terrainSample';
import { placeFeatures, type Features } from './features';

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
  stats: { minRadius: number; maxGrade: number; samples: number; ms: number };
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

// ───────────────────────────── plan ─────────────────────────────
interface PlanOut {
  x: Float64Array;
  z: Float64Array;
  tx: Float32Array;
  tz: Float32Array;
  n: number;
  ds: number;
  L: number;
  minRadius: number;
}

function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Arc from (x,z) heading `ang` (yaw: x = sin, z = cos) turning toward a target until roughly aimed at it. */
function arcToward(x: number, z: number, ang: number, txp: number, tzp: number, R: number, maxLen: number, out: number[]): { x: number; z: number; ang: number } {
  const step = 25;
  let len = 0, k = 0;
  while (len < maxLen) {
    const toT = Math.atan2(txp - x, tzp - z);
    const diff = wrap(toT - ang);
    if (Math.abs(diff) < 0.2) break;
    ang += Math.sign(diff) * Math.min(Math.abs(diff), step / R);
    x += Math.sin(ang) * step;
    z += Math.cos(ang) * step;
    len += step;
    if (++k % 4 === 0) out.push(x, z);
  }
  if (k % 4 !== 0) out.push(x, z);
  return { x, z, ang };
}

function inForbidden(x: number, z: number): boolean {
  const cb = CONFIG.world.cityBounds, ab = CONFIG.world.airportBounds;
  if (x > cb.minX - 60 && x < cb.maxX + 60 && z > cb.minZ - 60 && z < cb.maxZ + 60) return true;
  if (x > ab.minX - 90 && x < ab.maxX + 90 && z > ab.minZ - 90 && z < ab.maxZ + 90) return true;
  return false;
}

function* planGen(d: EdgeDesc, rng: Rng): Generator<void, PlanOut> {
  const C = cfg();
  const A = d.a, B = d.b, eA = d.endA, eB = d.endB;
  // ── lead-ins ──
  const headA: number[] = [A.x, A.z, A.x, A.z, A.x, A.z];
  let lenA = 0;
  const leadIn = (head: number[], px: number, pz: number, dir: { x: number; z: number }, main: boolean, lin: number) => {
    let L = 0;
    if (main) {
      const sp = Math.max(40, lin / 3);
      for (let s = sp; s <= lin + sp + 1; s += sp) head.push(px + dir.x * s, pz + dir.z * s);
      L = lin + sp;
    } else {
      head.push(px + dir.x * 45, pz + dir.z * 45);
      L = 45;
    }
    return L;
  };
  lenA = leadIn(headA, A.x, A.z, eA.dir, eA.main, eA.lin);
  const headB: number[] = [B.x, B.z, B.x, B.z, B.x, B.z];
  let lenB = leadIn(headB, B.x, B.z, eB.dir, eB.main, eB.lin);
  // arcs toward each other
  const aEndX = headA[headA.length - 2], aEndZ = headA[headA.length - 1];
  const bEndX = headB[headB.length - 2], bEndZ = headB[headB.length - 1];
  const arcA: number[] = [], arcB: number[] = [];
  const RA = eA.main ? C.designRadius * 1.25 : C.designRadius * 1.15;
  const RB = eB.main ? C.designRadius * 1.25 : C.designRadius * 1.15;
  const ra = arcToward(aEndX, aEndZ, Math.atan2(eA.dir.x, eA.dir.z), bEndX, bEndZ, RA, 1500, arcA);
  const rb = arcToward(bEndX, bEndZ, Math.atan2(eB.dir.x, eB.dir.z), ra.x, ra.z, RB, 1500, arcB);
  lenA += (arcA.length / 2) * 100;
  lenB += (arcB.length / 2) * 100;
  yield;
  // ── DP through the middle ──
  const P0x = ra.x, P0z = ra.z, P1x = rb.x, P1z = rb.z;
  const Lc = Math.hypot(P1x - P0x, P1z - P0z);
  const mid: number[] = [];
  if (Lc > 450) {
    const K = Math.max(2, Math.round(Lc / 200));
    const Mh = 12, M = 2 * Mh + 1;
    const step = Math.min(110, Math.max(20, (0.36 * Lc) / Mh));
    const T = Math.max(1, Math.floor(170 / step));
    const ux = (P1x - P0x) / Lc, uz = (P1z - P0z) / Lc;
    const vx = -uz, vz = ux;
    const total = lenA + Lc + lenB;
    const y0 = d.ya + ((d.yb - d.ya) * lenA) / total, y1 = d.ya + ((d.yb - d.ya) * (lenA + Lc)) / total;
    const hg = new Float64Array((K + 1) * M);
    const nodeC = new Float64Array((K + 1) * M);
    const sea = d.ref.sea;
    for (let k = 1; k < K; k++) {
      const s = (k / K) * Lc;
      const href = y0 + ((y1 - y0) * k) / K;
      for (let m = 0; m < M; m++) {
        const o = (m - Mh) * step;
        const px = P0x + ux * s + vx * o, pz = P0z + uz * s + vz * o;
        const h = H(px, pz);
        hg[k * M + m] = h;
        let c: number;
        if (sea && h < 0.5) c = 0;
        else {
          const dh = h - href;
          c = Math.abs(dh) + 0.5 * Math.max(0, dh);
          if (!sea && h < 1.5) c += 80 + (1.5 - h) * 3;
        }
        if (inForbidden(px, pz)) c += 1e5;
        c += 0.4 * (o / 100) * (o / 100);
        nodeC[k * M + m] = c;
      }
      if (k % 4 === 0) yield;
    }
    hg[Mh] = y0;
    hg[K * M + Mh] = y1;
    const cost = new Float64Array((K + 1) * M).fill(Infinity);
    const back = new Int16Array((K + 1) * M).fill(-1);
    cost[Mh] = 0;
    const segLen = Lc / K;
    for (let k = 0; k < K; k++) {
      for (let m = 0; m < M; m++) {
        const c0 = cost[k * M + m];
        if (c0 === Infinity) continue;
        const h0 = hg[k * M + m];
        const lo = Math.max(0, m - T), hi = Math.min(M - 1, m + T);
        for (let m2 = lo; m2 <= hi; m2++) {
          if (k + 1 === K && m2 !== Mh) continue;
          const dOff = (m2 - m) * step;
          const seg = Math.hypot(segLen, dOff);
          const h1 = hg[(k + 1) * M + m2];
          let c = c0 + (k + 1 < K ? nodeC[(k + 1) * M + m2] : 0);
          const dh = Math.abs(h1 - h0);
          const seaPair = sea && (h0 < 0.5 || h1 < 0.5);
          if (!seaPair) c += 1.5 * Math.max(0, dh - 0.045 * seg);
          c += 0.8 * (dOff / 100) * (dOff / 100) + 0.01 * seg;
          const idx = (k + 1) * M + m2;
          if (c < cost[idx]) {
            cost[idx] = c;
            back[idx] = m;
          }
        }
      }
    }
    const offs = new Int16Array(K + 1);
    offs[K] = Mh;
    for (let k = K; k > 0; k--) offs[k - 1] = back[k * M + offs[k]] < 0 ? Mh : back[k * M + offs[k]];
    for (let k = 1; k < K; k++) {
      const s = (k / K) * Lc, o = (offs[k] - Mh) * step;
      mid.push(P0x + ux * s + vx * o, P0z + uz * s + vz * o);
    }
  }
  yield;
  // ── raw polyline → uniform control polygon ──
  const raw: number[] = [A.x, A.z];
  for (let k = 6; k < headA.length; k += 2) raw.push(headA[k], headA[k + 1]);
  raw.push(...arcA, ...mid);
  for (let k = arcB.length - 2; k >= 0; k -= 2) raw.push(arcB[k], arcB[k + 1]);
  for (let k = headB.length - 2; k >= 6; k -= 2) raw.push(headB[k], headB[k + 1]);
  raw.push(B.x, B.z);
  const rawCum: number[] = [0];
  for (let k = 2; k < raw.length; k += 2) rawCum.push(rawCum[rawCum.length - 1] + Math.hypot(raw[k] - raw[k - 2], raw[k + 1] - raw[k - 1]));
  const rawLen = rawCum[rawCum.length - 1];
  const m = Math.max(6, Math.round(rawLen / 50));
  const h = rawLen / m;
  const Q = new Float64Array(2 * (m + 1));
  {
    let seg = 0;
    for (let k = 0; k <= m; k++) {
      const s = k * h;
      while (seg < rawCum.length - 2 && rawCum[seg + 1] < s) seg++;
      const f = rawCum[seg + 1] > rawCum[seg] ? (s - rawCum[seg]) / (rawCum[seg + 1] - rawCum[seg]) : 0;
      Q[2 * k] = raw[2 * seg] + (raw[2 * seg + 2] - raw[2 * seg]) * f;
      Q[2 * k + 1] = raw[2 * seg + 1] + (raw[2 * seg + 3] - raw[2 * seg + 1]) * f;
    }
  }
  const fixed = new Uint8Array(m + 1);
  const P = Float64Array.from(Q);
  // ends: exact node, first control point on the tangent, straight lead-ins of main edges
  const pinLead = (k0: number, step: number, px: number, pz: number, dir: { x: number; z: number }, main: boolean, lin: number) => {
    const nLead = main ? Math.max(1, Math.floor(lin / h) + 1) : 1;
    for (let q = 0; q <= nLead && q <= m; q++) {
      const k = k0 + q * step;
      P[2 * k] = Q[2 * k] = px + dir.x * h * q;
      P[2 * k + 1] = Q[2 * k + 1] = pz + dir.z * h * q;
      fixed[k] = 1;
    }
  };
  pinLead(0, 1, A.x, A.z, eA.dir, eA.main, eA.lin);
  pinLead(m, -1, B.x, B.z, eB.dir, eB.main, eB.lin);
  // straight windows (for kickers / mega jumps): runs of collinear control points
  const windows: [number, number][] = [];
  const nWin = Math.floor(rawLen / 1800);
  const winOf = new Int16Array(m + 1).fill(-1);
  for (let w = 0; w < nWin; w++) {
    const c = ((w + 0.5) / nWin) * rawLen + rng.range(-250, 250);
    const k0 = Math.round((c - 600) / h), k1 = Math.round((c + 600) / h);
    if (k0 < 2 || k1 > m - 2) continue;
    let clash = false;
    for (let k = k0 - 2; k <= k1 + 2; k++) if (fixed[k] || winOf[k] >= 0) clash = true;
    if (clash) continue;
    const ax = Q[2 * k0], az = Q[2 * k0 + 1], bx = Q[2 * k1], bz = Q[2 * k1 + 1];
    const lx = bx - ax, lz = bz - az, l2 = lx * lx + lz * lz || 1;
    for (let k = k0; k <= k1; k++) {
      const t = ((Q[2 * k] - ax) * lx + (Q[2 * k + 1] - az) * lz) / l2;
      P[2 * k] = ax + lx * t;
      P[2 * k + 1] = az + lz * t;
      winOf[k] = windows.length;
    }
    windows.push([k0, k1]);
  }
  const dropWindow = (wi: number) => {
    const [k0, k1] = windows[wi];
    for (let k = k0; k <= k1; k++) winOf[k] = -1;
  };
  // fairing: minimise Σ|Δ²P|² + μ Σ|P − Q|² (bi-Laplacian Jacobi steps); curvature ≈ |Δ²P| / h²
  const tmp = new Float64Array(P.length);
  const fair = (iters: number, mu: number) => {
    for (let it = 0; it < iters; it++) {
      tmp.set(P);
      for (let k = 2; k <= m - 2; k++) {
        if (fixed[k] || winOf[k] >= 0) continue;
        for (let c = 0; c < 2; c++) {
          const b = P[2 * (k - 2) + c] - 4 * P[2 * (k - 1) + c] + 6 * P[2 * k + c] - 4 * P[2 * (k + 1) + c] + P[2 * (k + 2) + c];
          tmp[2 * k + c] = P[2 * k + c] - 0.07 * (b + mu * (P[2 * k + c] - Q[2 * k + c]));
        }
      }
      P.set(tmp);
    }
  };
  const R = C.designRadius;
  const kapLimit = (h * h) / R;
  const worstDD = (): { v: number; at: number } => {
    let v = 0, at = 1;
    for (let k = 1; k < m; k++) {
      const ddx = P[2 * k - 2] - 2 * P[2 * k] + P[2 * k + 2], ddz = P[2 * k - 1] - 2 * P[2 * k + 1] + P[2 * k + 3];
      const dd = Math.hypot(ddx, ddz);
      if (dd > v) {
        v = dd;
        at = k;
      }
    }
    return { v, at };
  };
  // fairing slides points along the curve: keep them uniformly spaced and re-pin the lead-ins on their tangent lines
  const reparam = () => {
    const cum = new Float64Array(m + 1);
    for (let k = 1; k <= m; k++) cum[k] = cum[k - 1] + Math.hypot(P[2 * k] - P[2 * k - 2], P[2 * k + 1] - P[2 * k - 1]);
    const hh = cum[m] / m;
    const out = new Float64Array(P.length);
    let seg = 0;
    for (let k = 0; k <= m; k++) {
      const s = k * hh;
      while (seg < m - 1 && cum[seg + 1] < s) seg++;
      const f = cum[seg + 1] > cum[seg] ? (s - cum[seg]) / (cum[seg + 1] - cum[seg]) : 0;
      out[2 * k] = P[2 * seg] + (P[2 * seg + 2] - P[2 * seg]) * f;
      out[2 * k + 1] = P[2 * seg + 1] + (P[2 * seg + 3] - P[2 * seg + 1]) * f;
    }
    P.set(out);
    const pin = (k0: number, step: number, px: number, pz: number, dir: { x: number; z: number }) => {
      for (let q = 0; q <= m; q++) {
        const k = k0 + q * step;
        if (k < 0 || k > m || !fixed[k]) break;
        P[2 * k] = px + dir.x * hh * q;
        P[2 * k + 1] = pz + dir.z * hh * q;
      }
    };
    pin(0, 1, A.x, A.z, eA.dir);
    pin(m, -1, B.x, B.z, eB.dir);
  };
  // clamped B-spline control array [A, A, P…, B, B] and its exact curvature
  const N = m + 5;
  const Pc = new Float64Array(2 * N);
  const buildPc = () => {
    Pc[0] = Pc[2] = A.x;
    Pc[1] = Pc[3] = A.z;
    Pc.set(P, 4);
    Pc[2 * N - 4] = Pc[2 * N - 2] = B.x;
    Pc[2 * N - 3] = Pc[2 * N - 1] = B.z;
  };
  const curvWorst = (): { kap: number; at: number } => {
    buildPc();
    let kap = 0, at = 1;
    const SUB = 12;
    for (let sgi = 1; sgi < N - 4; sgi++) {
      const o = 2 * sgi;
      for (let q = 0; q < SUB; q++) {
        const u = q / SUB;
        const dx = (-(1 - u) * (1 - u) * Pc[o] + (3 * u * u - 4 * u) * Pc[o + 2] + (-3 * u * u + 2 * u + 1) * Pc[o + 4] + u * u * Pc[o + 6]) / 2;
        const dz = (-(1 - u) * (1 - u) * Pc[o + 1] + (3 * u * u - 4 * u) * Pc[o + 3] + (-3 * u * u + 2 * u + 1) * Pc[o + 5] + u * u * Pc[o + 7]) / 2;
        const ddx = (1 - u) * Pc[o] + (3 * u - 2) * Pc[o + 2] + (-3 * u + 1) * Pc[o + 4] + u * Pc[o + 6];
        const ddz = (1 - u) * Pc[o + 1] + (3 * u - 2) * Pc[o + 3] + (-3 * u + 1) * Pc[o + 5] + u * Pc[o + 7];
        const sp = Math.hypot(dx, dz);
        if (sp < h * 0.25) continue;
        const kk = Math.abs(dx * ddz - dz * ddx) / (sp * sp * sp);
        if (kk > kap) {
          kap = kk;
          at = sgi - 1;
        }
      }
    }
    return { kap, at };
  };
  let mu = 0.05;
  fair(60, mu);
  reparam();
  let cw = curvWorst();
  for (let round = 0; round < 18 && cw.kap > 1 / R; round++) {
    for (let k = cw.at - 4; k <= cw.at + 4; k++) {
      const wi = winOf[Math.max(0, Math.min(m, k))];
      if (wi >= 0) dropWindow(wi);
    }
    mu *= 0.45;
    fair(80, mu);
    reparam();
    cw = curvWorst();
    if (round % 3 === 2) yield;
  }
  buildPc();
  const worstK = cw.kap;
  void kapLimit;
  void worstDD;
  yield;
  // ── arc-length table and resampling ──
  const S = N - 3;
  const D = 32;
  const tabS = new Float64Array(S * D + 1);
  let px = Pc[0], pz = Pc[1], acc = 0;
  const evalPos = (t: number, out: number[]) => {
    let sgi = Math.floor(t);
    if (sgi >= S) sgi = S - 1;
    if (sgi < 0) sgi = 0;
    const u = t - sgi;
    const b0 = (1 - u) * (1 - u) * (1 - u) / 6, b1 = (3 * u * u * u - 6 * u * u + 4) / 6, b2 = (-3 * u * u * u + 3 * u * u + 3 * u + 1) / 6, b3 = (u * u * u) / 6;
    const d0 = -(1 - u) * (1 - u) / 2, d1 = (3 * u * u - 4 * u) / 2, d2 = (-3 * u * u + 2 * u + 1) / 2, d3 = (u * u) / 2;
    const o = 2 * sgi;
    out[0] = b0 * Pc[o] + b1 * Pc[o + 2] + b2 * Pc[o + 4] + b3 * Pc[o + 6];
    out[1] = b0 * Pc[o + 1] + b1 * Pc[o + 3] + b2 * Pc[o + 5] + b3 * Pc[o + 7];
    out[2] = d0 * Pc[o] + d1 * Pc[o + 2] + d2 * Pc[o + 4] + d3 * Pc[o + 6];
    out[3] = d0 * Pc[o + 1] + d1 * Pc[o + 3] + d2 * Pc[o + 5] + d3 * Pc[o + 7];
  };
  const tmp4 = [0, 0, 0, 0];
  for (let k = 1; k <= S * D; k++) {
    evalPos(k / D, tmp4);
    acc += Math.hypot(tmp4[0] - px, tmp4[1] - pz);
    px = tmp4[0];
    pz = tmp4[1];
    tabS[k] = acc;
  }
  const L = acc;
  const n = Math.max(4, Math.round(L / 6));
  const ds = L / n;
  const x = new Float64Array(n + 1), z = new Float64Array(n + 1);
  const tx = new Float32Array(n + 1), tz = new Float32Array(n + 1);
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const s = i * ds;
    while (j < S * D - 1 && tabS[j + 1] < s) j++;
    const s0 = tabS[j], s1 = tabS[j + 1];
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    evalPos((j + Math.min(1, Math.max(0, f))) / D, tmp4);
    x[i] = tmp4[0];
    z[i] = tmp4[1];
    const l = Math.hypot(tmp4[2], tmp4[3]);
    if (l > 1e-6) {
      tx[i] = tmp4[2] / l;
      tz[i] = tmp4[3] / l;
    }
  }
  x[0] = A.x;
  z[0] = A.z;
  tx[0] = eA.dir.x;
  tz[0] = eA.dir.z;
  x[n] = B.x;
  z[n] = B.z;
  tx[n] = -eB.dir.x;
  tz[n] = -eB.dir.z;
  // patch near-zero-speed tangents at the clamped ends
  for (let i = 1; i < n; i++) if (tx[i] === 0 && tz[i] === 0) {
    const l = Math.hypot(x[i + 1] - x[i - 1], z[i + 1] - z[i - 1]) || 1;
    tx[i] = (x[i + 1] - x[i - 1]) / l;
    tz[i] = (z[i + 1] - z[i - 1]) / l;
  }
  return { x, z, tx, tz, n, ds, L, minRadius: worstK > 0 ? 1 / worstK : Infinity };
}

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
    stats: { minRadius: plan.minRadius, maxGrade, samples: 0, ms: 0 },
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
