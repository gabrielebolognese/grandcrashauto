import { clamp, lerp, smoothstep } from './util';
import { R, REGION_INFO, REGION_COUNT, gapBetween } from './regions';
import type { CarSpec, QuadInfo } from './specs';

/**
 * Procedural car body: a loft of cross-section rings along Z (rear → front) closed by "ladder" end caps.
 *
 * Every ring has S points on the left half (x ≥ 0) from the bottom centre up the side to the roof centre:
 *   0 bottom centre · 1-2 wheel-well inner wall · 3-4 sill / arch lip · 5-9 body side · 10-12 shoulder radius ·
 *   13-14 deck (hood / trunk shut line at 13) · 15 beltline / glass base · 16 glass mid · 17 glass top (rail) ·
 *   18-20 roof corner radius · 21 roof mid · 22 roof centre.
 * The right half is mirrored, giving a closed ring of N = 2(S-1) points. Wheel arches are cut by raising the
 * sill line around each axle; outside the cabin the greenhouse slots collapse onto the deck. Each quad gets a
 * region (see regions.ts / spec.classify) → separate meshes with panel gaps, glass, lamps and trim.
 */

export const S = 23;
export const N = 2 * (S - 1);

export interface Station {
  z: number;
  /** 0 auto, 1 force inside wheel arch, 2 force outside (duplicate stations at the vertical arch edges). */
  mode: 0 | 1 | 2;
  crease: boolean;
  order: number;
}

export interface RingOut {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  H: number;
}

export const newRing = (): RingOut => ({ x: new Float64Array(S), y: new Float64Array(S), z: new Float64Array(S), H: 0 });

export const archRadius = (s: CarSpec): number => s.wheelR * 1.143 + 0.022;
export const archCenterY = (s: CarSpec): number => s.wheelR * 1.04;

const GH_COLLAPSED = [0, 0.14, 0.28, 0.42, 0.56, 0.7, 0.85, 1];
const FLARE_W = [0.8, 0.9, 1, 1, 0.9, 0.6, 0.35, 0.2, 0.1]; // slots 4..12
const PX = new Float64Array(40);
const PY = new Float64Array(40);
const PA = new Float64Array(40);
const NX = new Float64Array(S);
const NY = new Float64Array(S);

function flareAt(s: CarSpec, z: number): number {
  const f = s.flare;
  if (!f) return 0;
  const a = (z - s.axleF) / f.len;
  const b = (z - s.axleR) / f.len;
  return f.front * Math.exp(-a * a) + f.rear * Math.exp(-b * b);
}

function bulgeAt(s: CarSpec, x: number, z: number): number {
  const b = s.hoodBulge;
  if (!b) return 0;
  const zw = smoothstep(b.z0, b.z0 + 0.25, z) * (1 - smoothstep(b.z1 - 0.2, b.z1, z));
  return b.h * zw * (1 - smoothstep(b.w * 0.55, b.w, Math.abs(x)));
}

function endScale(d: number, round: number, pow: number, W: number): number {
  if (round <= 0 || d >= round) return 1;
  const u = clamp(d / round, 0, 1);
  const se = Math.pow(1 - Math.pow(1 - u, pow), 1 / pow);
  return 1 - (round / W) * (1 - se);
}

function rakeW(d: number, zone: number): number {
  if (d >= zone) return 0;
  const u = 1 - Math.max(0, d) / zone;
  return u * u;
}

/** Interpolate x on the nominal side polyline (slots 4..12) at height y. */
function sideXAt(y: number): number {
  if (y <= NY[4]) return NX[4];
  for (let k = 4; k < 12; k++) {
    if (y <= NY[k + 1]) {
      const t = (y - NY[k]) / Math.max(1e-9, NY[k + 1] - NY[k]);
      return lerp(NX[k], NX[k + 1], t);
    }
  }
  return NX[12];
}

/** Evaluate the half ring at station z. */
export function evalRing(s: CarSpec, z: number, mode: number, o: RingOut): void {
  const sill = s.sill(z);
  const belt = s.belt(z);
  const crown = s.crown(z);
  const W = s.halfW(z);
  const floor = sill - s.floorDrop;
  const Ra = archRadius(s);
  const yA = archCenterY(s);
  let low = sill;
  if (mode !== 2) {
    for (const az of [s.axleF, s.axleR]) {
      const dz = Math.abs(z - az);
      if (dz < Ra - 1e-6 || (mode === 1 && dz <= Ra + 1e-6)) low = Math.max(low, yA + Math.sqrt(Math.max(0, Ra * Ra - dz * dz)));
    }
  }
  const X = o.x;
  const Y = o.y;
  const r = s.topR;
  const xs10 = W - s.shoulderIn;
  const flare = flareAt(s, z);
  // Nominal side profile.
  NY[4] = sill + 0.012;
  NX[4] = W - s.sideInset[0];
  for (let k = 5; k <= 9; k++) {
    NY[k] = sill + s.sideT[k - 5] * (belt - r - sill);
    NX[k] = W - s.sideInset[k - 4];
  }
  NY[10] = belt - r;
  NX[10] = xs10;
  NY[11] = belt - r + r * Math.SQRT1_2;
  NX[11] = xs10 - r + r * Math.SQRT1_2;
  NY[12] = belt;
  NX[12] = xs10 - r;
  for (let k = 4; k <= 12; k++) NX[k] += flare * FLARE_W[k - 4];
  for (let k = 4; k <= 12; k++) {
    X[k] = NX[k];
    Y[k] = NY[k];
  }
  // Wheel arch: lift the lip and collapse side slots below it onto the lip.
  if (low > sill + 1e-6) {
    Y[4] = Math.min(low + 0.012, NY[11] - 0.01);
    X[4] = sideXAt(Y[4]);
    for (let k = 5; k <= 12; k++) {
      const minY = Y[4] + 0.0005 * (k - 4);
      if (Y[k] < minY) {
        Y[k] = minY;
        X[k] = sideXAt(minY);
      }
    }
  }
  const lowY = Y[4] - 0.012;
  // Underbody & wheel well.
  const wellX = s.halfTrack - s.wheelW * 0.5 - 0.045;
  X[3] = X[4] - 0.025;
  Y[3] = lowY;
  X[2] = Math.min(wellX, X[3] - 0.01);
  Y[2] = lowY;
  X[1] = X[2];
  Y[1] = floor;
  X[0] = 0;
  Y[0] = floor;
  // Deck.
  const x12 = X[12];
  const deckY = (x: number) => belt + crown * (1 - (x / x12) ** 2) + bulgeAt(s, x, z);
  const cW = Math.min(s.cabin.cabinW(z), x12 - 0.03);
  X[13] = lerp(x12, cW, s.hoodEdge);
  Y[13] = deckY(X[13]);
  X[14] = lerp(x12, cW, 0.5 + s.hoodEdge * 0.5);
  Y[14] = deckY(X[14]);
  const baseY = deckY(cW);
  const H = Math.max(0, s.cabin.H(z));
  o.H = H;
  // Greenhouse profile polyline (or the deck when there is no cabin here).
  let n = 0;
  const push = (x: number, y: number) => {
    PX[n] = x;
    PY[n] = y;
    n++;
  };
  const feat = new Array<number>(8);
  if (H > 1e-4) {
    const rw = Math.min(s.cabin.roofW(z), cW - 0.004);
    const rr = Math.min(s.cabin.cornerR, H * 0.45, rw * 0.45);
    const rc = Math.min(s.cabin.crown, H * 0.25);
    const yTop = baseY + H - rc;
    push(cW, baseY);
    push(rw, yTop - rr);
    for (let i = 1; i <= 8; i++) {
      const a = (i / 8) * (Math.PI / 2);
      push(rw - rr + rr * Math.cos(a), yTop - rr + rr * Math.sin(a));
    }
    const xr = rw - rr;
    for (let i = 1; i <= 8; i++) {
      const x = xr * (1 - i / 8);
      push(x, yTop + rc * (1 - (x / Math.max(1e-6, xr)) ** 2));
    }
  } else {
    for (let i = 0; i <= 8; i++) {
      const x = cW * (1 - i / 8);
      push(x, deckY(x));
    }
  }
  PA[0] = 0;
  for (let i = 1; i < n; i++) PA[i] = PA[i - 1] + Math.hypot(PX[i] - PX[i - 1], PY[i] - PY[i - 1]);
  const total = PA[n - 1];
  if (H > 1e-4) {
    const rr = Math.min(s.cabin.cornerR, H * 0.45, Math.min(s.cabin.roofW(z), cW - 0.004) * 0.45);
    feat[0] = 0;
    feat[1] = PA[1] * 0.5;
    feat[2] = PA[1];
    feat[3] = PA[1] + rr * (35 * Math.PI / 180);
    feat[4] = PA[1] + rr * (70 * Math.PI / 180);
    feat[5] = PA[9];
    feat[6] = PA[13];
    feat[7] = total;
  } else for (let k = 0; k < 8; k++) feat[k] = GH_COLLAPSED[k] * total;
  const b = smoothstep(0, 0.1, H);
  let seg = 0;
  for (let k = 0; k < 8; k++) {
    const a = lerp(GH_COLLAPSED[k] * total, feat[k], b);
    while (seg < n - 2 && PA[seg + 1] < a) seg++;
    const t = clamp((a - PA[seg]) / Math.max(1e-9, PA[seg + 1] - PA[seg]), 0, 1);
    X[15 + k] = lerp(PX[seg], PX[seg + 1], t);
    Y[15 + k] = lerp(PY[seg], PY[seg + 1], t);
  }
  X[22] = 0;
  // Plan-view corner rounding at both ends + rake (z shear by height).
  const sx = endScale(s.zFront - z, s.front.round, s.front.pow, W) * endScale(z - s.zRear, s.rear.round, s.rear.pow, W);
  const wF = rakeW(s.zFront - z, s.front.zone);
  const wR = rakeW(z - s.zRear, s.rear.zone);
  for (let k = 0; k < S; k++) {
    X[k] *= sx;
    o.z[k] = z - s.front.rake * Math.max(0, Y[k] - s.front.rakeY) * wF + s.rear.rake * Math.max(0, Y[k] - s.rear.rakeY) * wR;
  }
}

/** Station list: dense at ends, wheel arches (angular), windshield/backlight; region edges from the spec. */
export function buildStations(s: CarSpec, lod: 'high' | 'low'): Station[] {
  const hi = lod === 'high';
  const list: Station[] = [];
  const add = (z: number, mode: 0 | 1 | 2 = 0, crease = false, order = 0) => {
    if (z >= s.zRear - 1e-6 && z <= s.zFront + 1e-6) list.push({ z: clamp(z, s.zRear, s.zFront), mode, crease, order });
  };
  const endN = hi ? 8 : 3;
  for (const [zEnd, sign, e] of [
    [s.zFront, -1, s.front],
    [s.zRear, 1, s.rear],
  ] as const) {
    for (let k = 0; k <= endN; k++) {
      const th = (k / endN) * (Math.PI / 2);
      add(zEnd + sign * e.round * (1 - Math.cos(th)), 0, k === 0 && e.crease);
    }
    if (hi) for (let k = 1; k <= 3; k++) add(zEnd + sign * (e.round + (e.zone - e.round) * (k / 4)));
  }
  const Ra = archRadius(s);
  const archN = hi ? 14 : 4;
  for (const az of [s.axleF, s.axleR]) {
    for (let k = 1; k < archN; k++) add(az + Ra * Math.cos((k / archN) * Math.PI), 0);
    add(az + Ra, 1, true, 0);
    add(az + Ra, 2, true, 1);
    add(az - Ra, 2, true, 0);
    add(az - Ra, 1, true, 1);
  }
  const c = s.cabin;
  for (const z of [c.zCowl, c.zWsTop, c.zRoofRear, c.zBl, ...s.breaks]) add(z);
  list.sort((a, b) => a.z - b.z || a.order - b.order);
  // De-duplicate (keep explicit arch pairs).
  const dd: Station[] = [];
  for (const st of list) {
    const prev = dd[dd.length - 1];
    if (prev && Math.abs(st.z - prev.z) < (hi ? 0.006 : 0.02)) {
      if (st.mode !== 0 && prev.mode !== 0 && st.mode !== prev.mode) {
        dd.push(st);
        continue;
      }
      if (prev.mode === 0 && st.mode !== 0) dd[dd.length - 1] = { ...st, crease: st.crease || prev.crease };
      else prev.crease = prev.crease || st.crease;
      continue;
    }
    dd.push(st);
  }
  // Fill gaps.
  const maxStep = (z: number) => {
    const slope = (z > c.zWsTop - 0.05 && z < c.zCowl + 0.05) || (z > c.zBl - 0.05 && z < c.zRoofRear + 0.05);
    const nearEnd = s.zFront - z < s.front.zone || z - s.zRear < s.rear.zone;
    if (hi) return slope ? 0.036 : nearEnd ? 0.045 : 0.068;
    return slope ? 0.16 : nearEnd ? 0.2 : 0.42;
  };
  const out: Station[] = [dd[0]];
  for (let i = 1; i < dd.length; i++) {
    const a = dd[i - 1];
    const b = dd[i];
    const gap = b.z - a.z;
    const step = maxStep((a.z + b.z) / 2);
    if (gap > step) {
      const n = Math.ceil(gap / step);
      for (let k = 1; k < n; k++) out.push({ z: a.z + (gap * k) / n, mode: 0, crease: false, order: 0 });
    }
    out.push(b);
  }
  return out;
}

export interface RegionGeo {
  pos: Float32Array;
  nrm: Float32Array;
  idx: Uint32Array;
  /** Base grid vertex of each region vertex. */
  base: Int32Array;
}

export interface BodyGrid {
  spec: CarSpec;
  lod: 'high' | 'low';
  stations: Station[];
  M: number;
  C: number;
  K: number;
  colCf: number[];
  /** Base vertex positions: loft (M*N), front cap interior (S*(C-1)), rear cap interior (S*(C-1)). */
  P: Float32Array;
  /** Accumulated (unnormalized) normals per base vertex and crease variant (4 per base). */
  NA: Float64Array;
  H: Float32Array;
  numBase: number;
  /** Quads: 4 base ids, 4 variants, region, band, kind (0 loft, 1 front cap, -1 rear cap), station/rung index. */
  qv: Int32Array;
  qvar: Uint8Array;
  qreg: Uint8Array;
  qband: Uint8Array;
  qkind: Int8Array;
  qi: Int32Array;
  qz: Float32Array;
  quadCount: number;
  regions: Map<number, RegionGeo>;
}

const capOffset = (M: number, C: number, front: boolean) => M * N + (front ? 0 : S * (C - 1));

/** Build the full body grid, classify regions and emit per-region geometry (positions in car space). */
export function buildGrid(s: CarSpec, lod: 'high' | 'low'): BodyGrid {
  const stations = buildStations(s, lod);
  const M = stations.length;
  const half = lod === 'high' ? s.capCols : s.capColsLow;
  const K = half.length - 1;
  const C = 2 * K;
  const colCf: number[] = [];
  for (let c = 0; c <= C; c++) colCf.push(c <= K ? half[K - c] : half[c - K]);
  const numBase = M * N + 2 * S * (C - 1);
  const P = new Float32Array(numBase * 3);
  const H = new Float32Array(M);
  const ring = newRing();
  const creaseSlot = new Uint8Array(S);
  for (const k of s.creases) creaseSlot[k] = 1;
  const endRings: RingOut[] = [newRing(), newRing()];

  for (let i = 0; i < M; i++) {
    evalRing(s, stations[i].z, stations[i].mode, ring);
    H[i] = ring.H;
    for (let k = 0; k < N; k++) {
      const left = k <= S - 1;
      const j = left ? k : N - k;
      const o = (i * N + k) * 3;
      P[o] = (left ? 1 : -1) * ring.x[j];
      P[o + 1] = ring.y[j];
      P[o + 2] = ring.z[j];
    }
    if (i === 0 || i === M - 1) {
      const er = endRings[i === 0 ? 1 : 0];
      er.x.set(ring.x);
      er.y.set(ring.y);
      er.z.set(ring.z);
      er.H = ring.H;
    }
  }
  // Cap interior points.
  for (const front of [true, false]) {
    const er = endRings[front ? 0 : 1];
    const e = front ? s.front : s.rear;
    const sign = front ? 1 : -1;
    let xmax = 1e-6;
    for (let j = 0; j < S; j++) xmax = Math.max(xmax, er.x[j]);
    const off = capOffset(M, C, front);
    for (let j = 0; j < S; j++) {
      for (let c = 1; c < C; c++) {
        const cf = colCf[c];
        const xs = c < K ? 1 : c > K ? -1 : 0;
        const o = (off + j * (C - 1) + (c - 1)) * 3;
        P[o] = xs * cf * er.x[j];
        P[o + 1] = er.y[j];
        P[o + 2] = er.z[j] + sign * e.bulge * (1 - cf * cf) * (er.x[j] / xmax);
      }
    }
  }
  const capVert = (front: boolean, j: number, c: number): number => {
    const iEnd = front ? M - 1 : 0;
    if (c === 0) return iEnd * N + j;
    if (c === C) return iEnd * N + ((N - j) % N);
    return capOffset(M, C, front) + j * (C - 1) + (c - 1);
  };

  // Quads.
  const maxQuads = (M - 1) * N + 2 * (S - 1) * C;
  const qv = new Int32Array(maxQuads * 4);
  const qvar = new Uint8Array(maxQuads * 4);
  const qreg = new Uint8Array(maxQuads);
  const qband = new Uint8Array(maxQuads);
  const qkind = new Int8Array(maxQuads);
  const qi = new Int32Array(maxQuads);
  const qz = new Float32Array(maxQuads);
  let q = 0;
  const info: QuadInfo = { kind: 0, band: 0, side: 1, z: 0, y: 0, x: 0, cf: 1, H: 0 };
  const midOf = (q4: number[]) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const b of q4) {
      x += P[b * 3];
      y += P[b * 3 + 1];
      z += P[b * 3 + 2];
    }
    info.x = Math.abs(x / 4);
    info.y = y / 4;
    info.z = z / 4;
  };
  const tmp4 = [0, 0, 0, 0];
  for (let i = 0; i < M - 1; i++) {
    for (let k = 0; k < N; k++) {
      const k1 = (k + 1) % N;
      const left = k < S - 1;
      const band = left ? k : N - k - 1;
      const corners = [
        [i, k],
        [i, k1],
        [i + 1, k1],
        [i + 1, k],
      ];
      for (let c = 0; c < 4; c++) {
        const [ii, kk] = corners[c];
        const jj = kk <= S - 1 ? kk : N - kk;
        const sideK = creaseSlot[jj] ? (jj === band ? 1 : 0) : 0;
        const sideI = stations[ii].crease ? (ii === i ? 1 : 0) : 0;
        qv[q * 4 + c] = tmp4[c] = ii * N + kk;
        qvar[q * 4 + c] = sideK | (sideI << 1);
      }
      midOf(tmp4);
      info.kind = 0;
      info.band = band;
      info.side = left ? 1 : -1;
      info.cf = 1;
      info.H = (H[i] + H[i + 1]) / 2;
      info.z = (stations[i].z + stations[i + 1].z) / 2;
      qreg[q] = s.classify(info);
      qband[q] = band;
      qkind[q] = 0;
      qi[q] = i;
      qz[q] = info.z;
      q++;
    }
  }
  for (const front of [true, false]) {
    const iEnd = front ? M - 1 : 0;
    const loftSide = iEnd === 0 ? 1 : 0;
    const capSideI = stations[iEnd].crease ? 1 - loftSide : 0;
    for (let j = 0; j < S - 1; j++) {
      for (let c = 0; c < C; c++) {
        const corners: [number, number][] = front
          ? [
              [j, c],
              [j + 1, c],
              [j + 1, c + 1],
              [j, c + 1],
            ]
          : [
              [j, c],
              [j, c + 1],
              [j + 1, c + 1],
              [j + 1, c],
            ];
        for (let t = 0; t < 4; t++) {
          const [jj, cc] = corners[t];
          const sideK = creaseSlot[jj] ? (jj === j ? 1 : 0) : 0;
          const onLoft = cc === 0 || cc === C;
          qv[q * 4 + t] = tmp4[t] = capVert(front, jj, cc);
          qvar[q * 4 + t] = sideK | ((onLoft ? capSideI : 0) << 1);
        }
        midOf(tmp4);
        info.kind = front ? 1 : -1;
        info.band = j;
        info.side = c < K ? 1 : -1;
        info.cf = (colCf[c] + colCf[c + 1]) / 2;
        info.H = H[iEnd];
        info.z = stations[iEnd].z;
        qreg[q] = s.classify(info);
        qband[q] = j;
        qkind[q] = front ? 1 : -1;
        qi[q] = j;
        qz[q] = info.z;
        q++;
      }
    }
  }
  const quadCount = q;

  // Normals (area-weighted, per crease variant).
  const NA = new Float64Array(numBase * 4 * 3);
  const triN = (a: number, b: number, c: number, out: number[]) => {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    out[0] = uy * vz - uz * vy;
    out[1] = uz * vx - ux * vz;
    out[2] = ux * vy - uy * vx;
  };
  const n1 = [0, 0, 0];
  const n2 = [0, 0, 0];
  for (let t = 0; t < quadCount; t++) {
    const a = qv[t * 4], b = qv[t * 4 + 1], c = qv[t * 4 + 2], d = qv[t * 4 + 3];
    triN(a, b, c, n1);
    triN(a, c, d, n2);
    const tri = [
      [a, 0, n1, n2],
      [b, 1, n1, null],
      [c, 2, n1, n2],
      [d, 3, n2, null],
    ] as const;
    for (const [v, ci, f1, f2] of tri) {
      const o = (v * 4 + qvar[t * 4 + ci]) * 3;
      NA[o] += f1[0] + (f2 ? f2[0] : 0);
      NA[o + 1] += f1[1] + (f2 ? f2[1] : 0);
      NA[o + 2] += f1[2] + (f2 ? f2[2] : 0);
    }
  }

  // Gap groups & region centroids per base vertex.
  const groupMask = new Uint32Array(numBase);
  const cent = new Map<number, Float64Array>();
  for (let t = 0; t < quadCount; t++) {
    const r = qreg[t];
    if (r === R.SKIP) continue;
    const g = REGION_INFO[r].gap;
    let cx = 0, cy = 0, cz = 0;
    for (let c = 0; c < 4; c++) {
      const v = qv[t * 4 + c];
      cx += P[v * 3];
      cy += P[v * 3 + 1];
      cz += P[v * 3 + 2];
    }
    cx /= 4;
    cy /= 4;
    cz /= 4;
    for (let c = 0; c < 4; c++) {
      const v = qv[t * 4 + c];
      groupMask[v] |= 1 << g;
      const key = r * numBase + v;
      let e = cent.get(key);
      if (!e) cent.set(key, (e = new Float64Array(4)));
      e[0] += cx;
      e[1] += cy;
      e[2] += cz;
      e[3]++;
    }
  }

  // Emit region geometry.
  const regions = new Map<number, RegionGeo>();
  const builders = new Map<number, { map: Map<number, number>; pos: number[]; nrm: number[]; idx: number[]; base: number[] }>();
  const gapOff = new Map<number, [number, number, number]>();
  const vertexFor = (r: number, v: number, variant: number, bld: { map: Map<number, number>; pos: number[]; nrm: number[]; base: number[] }) => {
    const key = v * 4 + variant;
    let id = bld.map.get(key);
    if (id !== undefined) return id;
    let nx = NA[key * 3], ny = NA[key * 3 + 1], nz = NA[key * 3 + 2];
    let len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) {
      // fall back to any variant with data
      for (let vv = 0; vv < 4 && len < 1e-12; vv++) {
        nx = NA[(v * 4 + vv) * 3];
        ny = NA[(v * 4 + vv) * 3 + 1];
        nz = NA[(v * 4 + vv) * 3 + 2];
        len = Math.hypot(nx, ny, nz);
      }
      if (len < 1e-12) {
        nx = 0;
        ny = 1;
        nz = 0;
        len = 1;
      }
    }
    nx /= len;
    ny /= len;
    nz /= len;
    let px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
    const gk = r * numBase + v;
    let off = gapOff.get(gk);
    if (!off) {
      off = [0, 0, 0];
      const my = REGION_INFO[r].gap;
      const mask = groupMask[v];
      let g = 0;
      for (let b = 0; b < 32; b++) if (mask & (1 << b) && b !== my) g = Math.max(g, gapBetween(my, b));
      const e = cent.get(gk);
      if (g > 0 && e && e[3] > 0) {
        let dx = e[0] / e[3] - px, dy = e[1] / e[3] - py, dz = e[2] / e[3] - pz;
        const dn = dx * nx + dy * ny + dz * nz;
        dx -= dn * nx;
        dy -= dn * ny;
        dz -= dn * nz;
        const dl = Math.hypot(dx, dy, dz);
        if (dl > 1e-6) {
          const m = Math.min(g * 0.5, dl * 0.45) / dl;
          off = [dx * m, dy * m, dz * m];
        }
      }
      gapOff.set(gk, off);
    }
    px += off[0];
    py += off[1];
    pz += off[2];
    id = bld.pos.length / 3;
    bld.pos.push(px, py, pz);
    bld.nrm.push(nx, ny, nz);
    bld.base.push(v);
    bld.map.set(key, id);
    return id;
  };
  const triArea2 = (pos: number[], a: number, b: number, c: number) => {
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  for (let t = 0; t < quadCount; t++) {
    const r = qreg[t];
    if (r === R.SKIP || r >= REGION_COUNT) continue;
    let bld = builders.get(r);
    if (!bld) builders.set(r, (bld = { map: new Map(), pos: [], nrm: [], idx: [], base: [] }));
    const ids = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) ids[c] = vertexFor(r, qv[t * 4 + c], qvar[t * 4 + c], bld);
    if (triArea2(bld.pos, ids[0], ids[1], ids[2]) > 1e-8) bld.idx.push(ids[0], ids[1], ids[2]);
    if (triArea2(bld.pos, ids[0], ids[2], ids[3]) > 1e-8) bld.idx.push(ids[0], ids[2], ids[3]);
  }
  for (const [r, b] of builders) {
    if (!b.idx.length) continue;
    regions.set(r, { pos: new Float32Array(b.pos), nrm: new Float32Array(b.nrm), idx: new Uint32Array(b.idx), base: new Int32Array(b.base) });
  }

  return {
    spec: s,
    lod,
    stations,
    M,
    C,
    K,
    colCf,
    P,
    NA,
    H,
    numBase,
    qv,
    qvar,
    qreg,
    qband,
    qkind,
    qi,
    qz,
    quadCount,
    regions,
  };
}

/** Normalized normal of a base vertex (variant-agnostic average). */
export function baseNormal(g: BodyGrid, v: number, out: number[]): number[] {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 4; k++) {
    x += g.NA[(v * 4 + k) * 3];
    y += g.NA[(v * 4 + k) * 3 + 1];
    z += g.NA[(v * 4 + k) * 3 + 2];
  }
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}

/** Normal of a specific (base, variant). */
export function variantNormal(g: BodyGrid, v: number, variant: number, out: number[]): number[] {
  const o = (v * 4 + variant) * 3;
  const l = Math.hypot(g.NA[o], g.NA[o + 1], g.NA[o + 2]);
  if (l < 1e-12) return baseNormal(g, v, out);
  out[0] = g.NA[o] / l;
  out[1] = g.NA[o + 1] / l;
  out[2] = g.NA[o + 2] / l;
  return out;
}

/** Point on the analytic surface: half-ring slot (fractional) at z, left side (x ≥ 0). */
export function surfacePoint(s: CarSpec, z: number, slot: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const ring = _ring;
  evalRing(s, z, 0, ring);
  const j = clamp(Math.floor(slot), 0, S - 2);
  const t = clamp(slot - j, 0, 1);
  out.x = lerp(ring.x[j], ring.x[j + 1], t);
  out.y = lerp(ring.y[j], ring.y[j + 1], t);
  out.z = lerp(ring.z[j], ring.z[j + 1], t);
  return out;
}
const _ring = newRing();

/** Ring at z (fresh copy). */
export function ringAt(s: CarSpec, z: number): RingOut {
  const r = newRing();
  evalRing(s, z, 0, r);
  return r;
}
