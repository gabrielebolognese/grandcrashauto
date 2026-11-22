import { CONFIG } from '../../config';
import type { Rng } from '../../core/rng';
import { cfg, type EdgeDesc } from './lattice';
import { H } from './terrainSample';

/**
 * Plan (x/z centreline) of one macro edge — PURE, worker-safe, ABSOLUTE coordinates.
 *  1. straight lead-ins along each node's departure tangent (through roads) or a short tangent stub (branches),
 *  2. a DUBINS path between the lead-in ends (radius-bounded by construction),
 *  3. a 2nd-order DP over lateral offsets in the Dubins path's curvilinear frame (terrain at the ideal grade line,
 *     valleys / passes / coastal contours; no sea, city or airport),
 *  4. uniform control polygon + bi-Laplacian fairing (+ seeded straight windows for jumps), clamped cubic B-spline,
 *     exact curvature verification (offsets are scaled down and retried if the design radius is violated),
 *  5. arc-length resampling every ~6 m.
 */

export interface PlanOut {
  x: Float64Array;
  z: Float64Array;
  tx: Float32Array;
  tz: Float32Array;
  n: number;
  ds: number;
  L: number;
  minRadius: number;
  windows: number;
}

const TAU = Math.PI * 2;
const mod2pi = (a: number) => a - TAU * Math.floor(a / TAU);

interface Dubins {
  type: string;
  seg: [number, number, number]; // normalised lengths
  len: number;
}

/** Shortest Dubins path in the (X = x, Y = z) plane; th = math heading (atan2(dz, dx)); L = counter-clockwise. */
function dubins(x0: number, y0: number, th0: number, x1: number, y1: number, th1: number, rho: number): Dubins[] {
  const dx = x1 - x0, dy = y1 - y0;
  const D = Math.hypot(dx, dy);
  const d = D / rho;
  const phi = D > 1e-9 ? Math.atan2(dy, dx) : 0;
  const a = mod2pi(th0 - phi), b = mod2pi(th1 - phi);
  const sa = Math.sin(a), sb = Math.sin(b), ca = Math.cos(a), cb = Math.cos(b), cab = Math.cos(a - b);
  const out: Dubins[] = [];
  const push = (type: string, t: number, p: number, q: number) => {
    if (!Number.isFinite(t + p + q)) return;
    out.push({ type, seg: [t, p, q], len: (t + p + q) * rho });
  };
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sa - sb);
    if (p2 >= 0) {
      const t1 = Math.atan2(cb - ca, d + sa - sb);
      push('LSL', mod2pi(-a + t1), Math.sqrt(p2), mod2pi(b - t1));
    }
  }
  {
    const p2 = 2 + d * d - 2 * cab + 2 * d * (sb - sa);
    if (p2 >= 0) {
      const t1 = Math.atan2(ca - cb, d - sa + sb);
      push('RSR', mod2pi(a - t1), Math.sqrt(p2), mod2pi(-b + t1));
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab + 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const t2 = Math.atan2(-ca - cb, d + sa + sb) - Math.atan2(-2, p);
      push('LSR', mod2pi(-a + t2), p, mod2pi(-mod2pi(b) + t2));
    }
  }
  {
    const p2 = -2 + d * d + 2 * cab - 2 * d * (sa + sb);
    if (p2 >= 0) {
      const p = Math.sqrt(p2);
      const t2 = Math.atan2(ca + cb, d - sa - sb) - Math.atan2(2, p);
      push('RSL', mod2pi(a - t2), p, mod2pi(b - t2));
    }
  }
  {
    const t0 = (6 - d * d + 2 * cab + 2 * d * (sa - sb)) / 8;
    if (Math.abs(t0) <= 1) {
      const ph = Math.atan2(ca - cb, d - sa + sb);
      const p = mod2pi(TAU - Math.acos(t0));
      const t = mod2pi(a - ph + mod2pi(p / 2));
      push('RLR', t, p, mod2pi(a - b - t + mod2pi(p)));
    }
  }
  {
    const t0 = (6 - d * d + 2 * cab + 2 * d * (sb - sa)) / 8;
    if (Math.abs(t0) <= 1) {
      const ph = Math.atan2(ca - cb, d + sa - sb);
      const p = mod2pi(TAU - Math.acos(t0));
      const t = mod2pi(-a - ph + p / 2);
      push('LRL', t, p, mod2pi(mod2pi(b) - a - t + mod2pi(p)));
    }
  }
  out.sort((u, v) => u.len - v.len);
  return out;
}

/** Sample a Dubins path every `step` m → flat [x, z, th, ...]. */
function sampleDubins(x0: number, y0: number, th0: number, dp: Dubins, rho: number, step: number): number[] {
  const out: number[] = [x0, y0, th0];
  let x = x0, y = y0, th = th0;
  for (let k = 0; k < 3; k++) {
    const c = dp.type[k];
    let rem = dp.seg[k] * rho;
    while (rem > 1e-6) {
      const ds = Math.min(step, rem);
      rem -= ds;
      if (c === 'S') {
        x += Math.cos(th) * ds;
        y += Math.sin(th) * ds;
      } else {
        const sgn = c === 'L' ? 1 : -1;
        const dth = (sgn * ds) / rho;
        // exact arc integration
        const cx = x - sgn * rho * Math.sin(th), cy = y + sgn * rho * Math.cos(th);
        th += dth;
        x = cx + sgn * rho * Math.sin(th);
        y = cy - sgn * rho * Math.cos(th);
      }
      out.push(x, y, th);
    }
  }
  return out;
}

function inForbidden(x: number, z: number): boolean {
  const cb = CONFIG.world.cityBounds, ab = CONFIG.world.airportBounds;
  if (x > cb.minX - 60 && x < cb.maxX + 60 && z > cb.minZ - 60 && z < cb.maxZ + 60) return true;
  if (x > ab.minX - 90 && x < ab.maxX + 90 && z > ab.minZ - 90 && z < ab.maxZ + 90) return true;
  return false;
}

export function* planGen(d: EdgeDesc, rng: Rng): Generator<void, PlanOut> {
  const C = cfg();
  const A = d.a, B = d.b, eA = d.endA, eB = d.endB;
  const R = C.designRadius;
  const leadLen = (e: typeof eA) => (e.main ? e.lin + 20 : 40);
  const lA = leadLen(eA), lB = leadLen(eB);
  const Ax = A.x + eA.dir.x * lA, Az = A.z + eA.dir.z * lA;
  const Bx = B.x + eB.dir.x * lB, Bz = B.z + eB.dir.z * lB;
  const th0 = Math.atan2(eA.dir.z, eA.dir.x);
  const th1 = Math.atan2(-eB.dir.z, -eB.dir.x); // arrival heading at B'
  const rho = R * 1.32;
  // ── Dubins base (verified numerically: the endpoint must match) ──
  let base: number[] | null = null;
  for (const cand of dubins(Ax, Az, th0, Bx, Bz, th1, rho)) {
    const smp = sampleDubins(Ax, Az, th0, cand, rho, 10);
    const ex = smp[smp.length - 3], ez = smp[smp.length - 2];
    if (Math.hypot(ex - Bx, ez - Bz) < 1.5) {
      base = smp;
      break;
    }
  }
  if (!base) base = [Ax, Az, th0, Bx, Bz, th1];
  const nb = base.length / 3;
  const bcum = new Float64Array(nb);
  for (let k = 1; k < nb; k++) bcum[k] = bcum[k - 1] + Math.hypot(base[3 * k] - base[3 * k - 3], base[3 * k + 1] - base[3 * k - 2]);
  const Lb = bcum[nb - 1];
  const baseAt = (s: number, out: number[]) => {
    let lo = 0, hi = nb - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (bcum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = bcum[hi] > bcum[lo] ? (s - bcum[lo]) / (bcum[hi] - bcum[lo]) : 0;
    out[0] = base![3 * lo] + (base![3 * hi] - base![3 * lo]) * f;
    out[1] = base![3 * lo + 1] + (base![3 * hi + 1] - base![3 * lo + 1]) * f;
    const t0 = base![3 * lo + 2], t1 = t0 + Math.atan2(Math.sin(base![3 * hi + 2] - t0), Math.cos(base![3 * hi + 2] - t0));
    out[2] = t0 + (t1 - t0) * f;
  };
  yield;
  // ── 2nd-order DP over lateral offsets (state = offset, previous step) ──
  const K = Math.max(2, Math.round(Lb / 200));
  const Mh = 18, M = 2 * Mh + 1, T = 3, NS = 2 * T + 1;
  const step = Math.max(10, Math.min(26, (0.12 * Lb) / Mh));
  const offs = new Float64Array(K + 1);
  if (Lb > 500) {
    const total = lA + Lb + lB;
    const sea = d.ref.sea;
    const nodeC = new Float64Array((K + 1) * M);
    const hg = new Float64Array((K + 1) * M);
    const tmp = [0, 0, 0];
    for (let k = 1; k < K; k++) {
      const s = (k / K) * Lb;
      baseAt(s, tmp);
      const nx = -Math.sin(tmp[2]), nz = Math.cos(tmp[2]);
      const href = d.ya + ((d.yb - d.ya) * (lA + s)) / total;
      for (let m = 0; m < M; m++) {
        const o = (m - Mh) * step;
        const px = tmp[0] + nx * o, pz = tmp[1] + nz * o;
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
        c += 0.25 * (o / 100) * (o / 100);
        nodeC[k * M + m] = c;
      }
      if (k % 4 === 0) yield;
    }
    hg[Mh] = d.ya;
    hg[K * M + Mh] = d.yb;
    const NSt = M * NS;
    const cost = new Float64Array((K + 1) * NSt).fill(Infinity);
    const back = new Int32Array((K + 1) * NSt).fill(-1);
    cost[Mh * NS + T] = 0; // k = 0: offset 0, previous step 0
    const segLen = Lb / K;
    for (let k = 0; k < K; k++) {
      for (let m = 0; m < M; m++) {
        for (let q = 0; q < NS; q++) {
          const c0 = cost[k * NSt + m * NS + q];
          if (c0 === Infinity) continue;
          const dm0 = q - T;
          const h0 = hg[k * M + m];
          for (let dm = Math.max(-T, dm0 - 1); dm <= Math.min(T, dm0 + 1); dm++) {
            const m2 = m + dm;
            if (m2 < 0 || m2 >= M) continue;
            if (k + 1 === K && (m2 !== Mh || dm !== 0)) continue; // arrive tangent to the base
            const dOff = dm * step;
            const seg = Math.hypot(segLen, dOff);
            let c = c0 + (k + 1 < K ? nodeC[(k + 1) * M + m2] : 0);
            const h1 = hg[(k + 1) * M + m2];
            const seaPair = d.ref.sea && (h0 < 0.5 || h1 < 0.5);
            if (!seaPair) c += 1.5 * Math.max(0, Math.abs(h1 - h0) - 0.045 * seg);
            c += 0.4 * (dOff / 100) * (dOff / 100) + 0.01 * seg + 0.3 * (dm - dm0) * (dm - dm0);
            const idx = (k + 1) * NSt + m2 * NS + (dm + T);
            if (c < cost[idx]) {
              cost[idx] = c;
              back[idx] = m * NS + q;
            }
          }
        }
      }
    }
    let bestQ = -1, bestC = Infinity;
    for (let q = 0; q < NS; q++) {
      const c = cost[K * NSt + Mh * NS + q];
      if (c < bestC) {
        bestC = c;
        bestQ = q;
      }
    }
    if (bestQ >= 0) {
      let st = Mh * NS + bestQ;
      for (let k = K; k >= 0; k--) {
        offs[k] = (Math.floor(st / NS) - Mh) * step;
        if (k > 0) st = back[k * NSt + st];
        if (st < 0) break;
      }
    }
    offs[0] = 0;
    offs[K] = 0;
  }
  yield;
  // ── build, fair, verify (scale offsets down on failure) ──
  let result: { P: Float64Array; m: number; h: number; worst: number; windows: number } | null = null;
  for (const scale of [1, 0.55, 0.25, 0]) {
    result = buildAndFair(d, rng, baseAt, Lb, offs, K, scale, lA, lB);
    if (result.worst <= 1 / R || scale === 0) break;
    yield;
  }
  const { P, m, h } = result!;
  // ── clamped B-spline [A, A, P…, B, B], arc-length resampling ──
  const N = m + 5;
  const Pc = new Float64Array(2 * N);
  Pc[0] = Pc[2] = A.x;
  Pc[1] = Pc[3] = A.z;
  Pc.set(P, 4);
  Pc[2 * N - 4] = Pc[2 * N - 2] = B.x;
  Pc[2 * N - 3] = Pc[2 * N - 1] = B.z;
  void h;
  const S = N - 3;
  const Dd = 32;
  const tabS = new Float64Array(S * Dd + 1);
  const evalPos = (t: number, out: number[]) => {
    let sgi = Math.floor(t);
    if (sgi >= S) sgi = S - 1;
    if (sgi < 0) sgi = 0;
    const u = t - sgi;
    const b0 = ((1 - u) * (1 - u) * (1 - u)) / 6, b1 = (3 * u * u * u - 6 * u * u + 4) / 6, b2 = (-3 * u * u * u + 3 * u * u + 3 * u + 1) / 6, b3 = (u * u * u) / 6;
    const d0 = -((1 - u) * (1 - u)) / 2, d1 = (3 * u * u - 4 * u) / 2, d2 = (-3 * u * u + 2 * u + 1) / 2, d3 = (u * u) / 2;
    const o = 2 * sgi;
    out[0] = b0 * Pc[o] + b1 * Pc[o + 2] + b2 * Pc[o + 4] + b3 * Pc[o + 6];
    out[1] = b0 * Pc[o + 1] + b1 * Pc[o + 3] + b2 * Pc[o + 5] + b3 * Pc[o + 7];
    out[2] = d0 * Pc[o] + d1 * Pc[o + 2] + d2 * Pc[o + 4] + d3 * Pc[o + 6];
    out[3] = d0 * Pc[o + 1] + d1 * Pc[o + 3] + d2 * Pc[o + 5] + d3 * Pc[o + 7];
  };
  const t4 = [0, 0, 0, 0];
  let px = Pc[0], pz = Pc[1], acc = 0;
  for (let k = 1; k <= S * Dd; k++) {
    evalPos(k / Dd, t4);
    acc += Math.hypot(t4[0] - px, t4[1] - pz);
    px = t4[0];
    pz = t4[1];
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
    while (j < S * Dd - 1 && tabS[j + 1] < s) j++;
    const s0 = tabS[j], s1 = tabS[j + 1];
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    evalPos((j + Math.min(1, Math.max(0, f))) / Dd, t4);
    x[i] = t4[0];
    z[i] = t4[1];
    const l = Math.hypot(t4[2], t4[3]);
    if (l > 1e-6) {
      tx[i] = t4[2] / l;
      tz[i] = t4[3] / l;
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
  for (let i = 1; i < n; i++) {
    if (tx[i] === 0 && tz[i] === 0) {
      const l = Math.hypot(x[i + 1] - x[i - 1], z[i + 1] - z[i - 1]) || 1;
      tx[i] = (x[i + 1] - x[i - 1]) / l;
      tz[i] = (z[i + 1] - z[i - 1]) / l;
    }
  }
  return { x, z, tx, tz, n, ds, L, minRadius: result!.worst > 0 ? 1 / result!.worst : Infinity, windows: result!.windows };
}

function buildAndFair(
  d: EdgeDesc, rng: Rng, baseAt: (s: number, out: number[]) => void, Lb: number, offs: Float64Array, K: number, scale: number,
  lA: number, lB: number,
): { P: Float64Array; m: number; h: number; worst: number; windows: number } {
  const C = cfg();
  const A = d.a, B = d.b, eA = d.endA, eB = d.endB;
  const R = C.designRadius;
  // raw polyline: lead A, offset Dubins base (Catmull-Rom offsets), lead B
  const raw: number[] = [A.x, A.z];
  const nLeadA = Math.max(1, Math.round(lA / 25));
  for (let q = 1; q < nLeadA; q++) raw.push(A.x + (eA.dir.x * lA * q) / nLeadA, A.z + (eA.dir.z * lA * q) / nLeadA);
  const tmp = [0, 0, 0];
  const steps = Math.max(2, Math.ceil(Lb / 25));
  const offAt = (s: number) => {
    const f = (s / Lb) * K;
    const k = Math.min(K - 1, Math.max(0, Math.floor(f)));
    const u = f - k;
    const p0 = offs[Math.max(0, k - 1)], p1 = offs[k], p2 = offs[k + 1], p3 = offs[Math.min(K, k + 2)];
    return scale * 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
  };
  for (let q = 0; q <= steps; q++) {
    const s = (q / steps) * Lb;
    baseAt(s, tmp);
    const o = offAt(s);
    raw.push(tmp[0] - Math.sin(tmp[2]) * o, tmp[1] + Math.cos(tmp[2]) * o);
  }
  const nLeadB = Math.max(1, Math.round(lB / 25));
  for (let q = nLeadB - 1; q >= 1; q--) raw.push(B.x + (eB.dir.x * lB * q) / nLeadB, B.z + (eB.dir.z * lB * q) / nLeadB);
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
  const pinLead = (k0: number, stp: number, px: number, pz: number, dir: { x: number; z: number }, main: boolean, lin: number, hh: number) => {
    const nLead = main ? Math.max(1, Math.floor(lin / hh) + 1) : 0; // branches: node only (a pinned tangent point next to the clamped end doubles the curvature)
    for (let q = 0; q <= nLead && q <= m; q++) {
      const k = k0 + q * stp;
      P[2 * k] = Q[2 * k] = px + dir.x * hh * q;
      P[2 * k + 1] = Q[2 * k + 1] = pz + dir.z * hh * q;
      fixed[k] = 1;
    }
  };
  pinLead(0, 1, A.x, A.z, eA.dir, eA.main, eA.lin, h);
  pinLead(m, -1, B.x, B.z, eB.dir, eB.main, eB.lin, h);
  // straight windows (kickers / mega jumps)
  const windows: [number, number][] = [];
  const winOf = new Int16Array(m + 1).fill(-1);
  const nWin = Math.floor(rawLen / 1800);
  for (let w = 0; w < nWin; w++) {
    const c = ((w + 0.5) / nWin) * rawLen + rng.range(-250, 250);
    const k0 = Math.round((c - 620) / h), k1 = Math.round((c + 620) / h);
    if (k0 < 3 || k1 > m - 3) continue;
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
  const tmpP = new Float64Array(P.length);
  const fair = (iters: number, mu: number) => {
    for (let it = 0; it < iters; it++) {
      tmpP.set(P);
      for (let k = 2; k <= m - 2; k++) {
        if (fixed[k] || winOf[k] >= 0) continue;
        for (let c = 0; c < 2; c++) {
          const b = P[2 * (k - 2) + c] - 4 * P[2 * (k - 1) + c] + 6 * P[2 * k + c] - 4 * P[2 * (k + 1) + c] + P[2 * (k + 2) + c];
          tmpP[2 * k + c] = P[2 * k + c] - 0.07 * (b + mu * (P[2 * k + c] - Q[2 * k + c]));
        }
      }
      P.set(tmpP);
    }
  };
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
    const pin = (k0: number, stp: number, px: number, pz: number, dir: { x: number; z: number }) => {
      for (let q = 0; q <= m; q++) {
        const k = k0 + q * stp;
        if (k < 0 || k > m || !fixed[k]) break;
        P[2 * k] = px + dir.x * hh * q;
        P[2 * k + 1] = pz + dir.z * hh * q;
      }
    };
    pin(0, 1, A.x, A.z, eA.dir);
    pin(m, -1, B.x, B.z, eB.dir);
  };
  const N = m + 5;
  const Pc = new Float64Array(2 * N);
  const curvWorst = (): { kap: number; at: number } => {
    Pc[0] = Pc[2] = A.x;
    Pc[1] = Pc[3] = A.z;
    Pc.set(P, 4);
    Pc[2 * N - 4] = Pc[2 * N - 2] = B.x;
    Pc[2 * N - 3] = Pc[2 * N - 1] = B.z;
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
  let mu = 0.08;
  fair(40, mu);
  reparam();
  let cw = curvWorst();
  for (let round = 0; round < 10 && cw.kap > 1 / R; round++) {
    for (let k = cw.at - 4; k <= cw.at + 4; k++) {
      const wi = winOf[Math.max(0, Math.min(m, k))];
      if (wi >= 0) {
        const [k0, k1] = windows[wi];
        for (let kk = k0; kk <= k1; kk++) winOf[kk] = -1;
      }
    }
    mu *= 0.5;
    fair(60, mu);
    reparam();
    cw = curvWorst();
  }
  let wins = 0;
  for (let w = 0; w < windows.length; w++) if (winOf[windows[w][0]] === w) wins++;
  return { P, m, h, worst: cw.kap, windows: wins };
}
