import * as THREE from 'three';
import { GeoBuilder, PAINT, GLASS, MATTE, type Mat, type RGB, type Curve, clamp, mix, prng } from './builder';
import { emitGrid, type CellStyle } from './grid';

/**
 * Fuselage = loft of super-elliptic cross-sections along Z. Ring parameter θ: 0 = top centre, π/2 = LEFT side (+X),
 * π = bottom, 3π/2 = right side. Normalized height h = sign(cosθ)|cosθ|^(2/n) ∈ [-1, 1].
 * Livery bands are horizontal bands in h (boundaries may vary with z — sweeps); rects are (z, θ) rectangles (cockpit
 * glass, anti-glare panel, titles, registration, radome). All their edges are grid lines, so colours are crisp with
 * no decals (no z-fighting at any distance).
 */

export interface FusProfile {
  zTail: number;
  zNose: number;
  w: Curve; // half-width
  yTop: Curve;
  yBot: Curve;
  yMid?: Curve; // height of the widest point (default: 45% of the way up)
  n?: Curve; // super-ellipse exponent (2 = ellipse)
  pinch?: Curve; // upper-lobe narrowing (jumbo hump)
}

export interface FusRect {
  z0: number;
  z1: number;
  t0: number; // θ on the left side (top = 0)
  t1: number;
  kind: 'glass' | 'paint' | 'uv';
  color?: RGB;
  mat?: Mat;
  /** uv region (atlas): u0,v0 (bottom-left) → u1,v1; text reads correctly on both sides. */
  uv?: { u0: number; v0: number; u1: number; v1: number };
  side?: 'both' | 'left' | 'right';
}

export interface FusLivery {
  bounds: Curve[]; // band boundaries h(z), top → bottom
  colors: RGB[]; // bounds.length + 1, top → bottom
  rects: FusRect[];
}

export interface ProfileAt {
  w: number;
  top: number;
  bot: number;
  mid: number;
  n: number;
  pinch: number;
}

const profileCache = new WeakMap<FusProfile, Map<number, ProfileAt>>();

/** Cross-section parameters at z (memoized per profile — rings evaluate the same z many times). */
export function profileAt(P: FusProfile, z: number): ProfileAt {
  let m = profileCache.get(P);
  if (!m) {
    m = new Map();
    profileCache.set(P, m);
  }
  const hit = m.get(z);
  if (hit) return hit;
  const r = computeProfile(P, z);
  if (m.size > 60000) m.clear();
  m.set(z, r);
  return r;
}

function computeProfile(P: FusProfile, z: number): ProfileAt {
  const yt = P.yTop(z);
  const yb = P.yBot(z);
  const mid = P.yMid ? P.yMid(z) : yb + (yt - yb) * 0.45;
  return { w: Math.max(0, P.w(z)), top: Math.max(0, yt - mid), bot: Math.max(0, mid - yb), mid, n: P.n ? P.n(z) : 2, pinch: P.pinch ? P.pinch(z) : 0 };
}

export function fusPoint(P: FusProfile, z: number, th: number, out = new THREE.Vector3(), pa?: ProfileAt): THREE.Vector3 {
  const a = pa ?? profileAt(P, z);
  const s = Math.sin(th);
  const c = Math.cos(th);
  const e = 2 / a.n;
  const xs = Math.sign(s) * Math.pow(Math.abs(s), e);
  const ys = Math.sign(c) * Math.pow(Math.abs(c), e);
  const pinch = a.pinch * Math.max(0, c) * Math.max(0, c);
  return out.set(a.w * xs * (1 - pinch), a.mid + (c >= 0 ? a.top : a.bot) * ys, z);
}

const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _dz = new THREE.Vector3();
const _dt = new THREE.Vector3();

export function fusNormal(P: FusProfile, z: number, th: number, out = new THREE.Vector3()): THREE.Vector3 {
  const R = Math.max(0.2, P.w((P.zNose + P.zTail) / 2));
  const zc = clamp(z, P.zTail + 0.002 * R, P.zNose - 0.03 * R);
  const ez = 0.01 * R;
  const et = 0.01;
  fusPoint(P, zc + ez, th, _p1);
  fusPoint(P, zc - ez, th, _p0);
  _dz.subVectors(_p1, _p0);
  fusPoint(P, zc, th + et, _p1);
  fusPoint(P, zc, th - et, _p0);
  _dt.subVectors(_p1, _p0);
  out.crossVectors(_dz, _dt);
  if (out.lengthSq() < 1e-16) out.set(Math.sin(th), Math.cos(th), 0);
  return out.normalize();
}

/** θ (left side) where the normalized height equals h. */
export function thetaOfH(h: number, n: number): number {
  const hh = clamp(h, -1, 1);
  if (hh >= 0) return Math.acos(Math.pow(hh, n / 2));
  return Math.PI - Math.acos(Math.pow(-hh, n / 2));
}

export function hOfTheta(th: number, n: number): number {
  const c = Math.cos(th);
  return Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
}

/** Livery colour at (z, θ) — bands only. */
export function bandColor(L: FusLivery, z: number, th: number, n: number): { color: RGB; index: number } {
  const h = hOfTheta(th, n);
  for (let k = 0; k < L.bounds.length; k++) if (h > L.bounds[k](z)) return { color: L.colors[k], index: k };
  return { color: L.colors[L.colors.length - 1], index: L.colors.length - 1 };
}

interface Line {
  f: (z: number) => number;
}

export interface LoftOptions {
  ringSeg: number; // base segments around
  step: number; // base station spacing (m)
  exact: boolean; // grid lines on band/rect edges (LOD 0/1)
  win: boolean; // procedural cabin window coordinates
  inner?: { offset: number; color: (h: number, z: number) => RGB; zFront: number };
  damaged?: number; // seed: torn/sooty variant (holes + soot)
  variant?: number;
  extraZ?: number[]; // extra stations
}

/** θ-lines of the whole fuselage (shared by every part so neighbouring rings match exactly). */
export function fuselageLines(P: FusProfile, L: FusLivery, ringSeg: number, exact: boolean): { lines: Line[]; segs: number[] } {
  const lines: Line[] = [{ f: () => 0 }, { f: () => Math.PI }, { f: () => Math.PI * 2 }];
  if (exact) {
    const nAt = (z: number) => (P.n ? P.n(z) : 2);
    for (const b of L.bounds) {
      lines.push({ f: (z) => thetaOfH(b(z), nAt(z)) });
      lines.push({ f: (z) => Math.PI * 2 - thetaOfH(b(z), nAt(z)) });
    }
    for (const r of L.rects) {
      for (const t of [r.t0, r.t1]) {
        if (t > 0.005 && t < Math.PI - 0.005) {
          lines.push({ f: () => t });
          lines.push({ f: () => Math.PI * 2 - t });
        }
      }
    }
  }
  const zRef = (P.zNose + P.zTail) * 0.5;
  lines.sort((a, b) => a.f(zRef) - b.f(zRef));
  // dedupe
  const out: Line[] = [];
  for (const l of lines) if (!out.length || Math.abs(l.f(zRef) - out[out.length - 1].f(zRef)) > 0.012) out.push(l);
  // segment counts from the average angular width
  const segs: number[] = [];
  const dth = (Math.PI * 2) / ringSeg;
  for (let k = 0; k < out.length - 1; k++) {
    let wsum = 0;
    const S = 9;
    for (let s = 0; s < S; s++) {
      const z = P.zTail + ((P.zNose - P.zTail) * (s + 0.5)) / S;
      wsum += Math.max(0, out[k + 1].f(z) - out[k].f(z));
    }
    segs.push(Math.max(1, Math.round(wsum / S / dth)));
  }
  return { lines: out, segs };
}

/** Station z values for [za, zb] (ascending), denser where the profile changes fast. */
export function stations(P: FusProfile, L: FusLivery, za: number, zb: number, step: number, exact: boolean, extra: number[] = []): number[] {
  const R = Math.max(0.2, P.w((P.zNose + P.zTail) / 2));
  const zs: number[] = [za];
  let z = za;
  const slope = (zz: number) => {
    const e = 0.05 * R;
    const a = profileAt(P, zz - e);
    const b = profileAt(P, zz + e);
    return (Math.abs(b.w - a.w) + Math.abs(b.top - a.top) + Math.abs(b.bot - a.bot) + Math.abs(b.mid - a.mid)) / (2 * e);
  };
  while (z < zb - 1e-6) {
    const s = slope(z);
    const pa = profileAt(P, z);
    const local = Math.max(0.04 * R, Math.min(pa.w, pa.top + pa.bot));
    let ds = step / (1 + 2.2 * s);
    ds = Math.min(ds, Math.max(0.12 * R, local * 0.9));
    if (z + ds > zb - ds * 0.3) ds = zb - z;
    z += ds;
    zs.push(Math.min(z, zb));
  }
  const req: number[] = [...extra];
  if (exact) for (const r of L.rects) req.push(r.z0, r.z1);
  for (const q of req) {
    if (q <= za + 1e-4 || q >= zb - 1e-4) continue;
    // replace the nearest station if close, else insert
    let best = -1;
    let bd = Infinity;
    for (let i = 1; i < zs.length - 1; i++) {
      const d = Math.abs(zs[i] - q);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const minGap = step * 0.3;
    if (best >= 0 && bd < minGap) zs[best] = q;
    else zs.push(q);
  }
  zs.sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of zs) if (!out.length || v - out[out.length - 1] > 1e-4) out.push(v);
  return out;
}

const REGION_GLASS = 1000;

/** Region of a cell (rect index or band) at (z, θ). */
function regionAt(L: FusLivery, z: number, th: number, n: number): { key: number; rect: FusRect | null; right: boolean; color: RGB } {
  const right = th > Math.PI;
  const tl = right ? Math.PI * 2 - th : th;
  for (let r = 0; r < L.rects.length; r++) {
    const R = L.rects[r];
    if (R.side === 'left' && right) continue;
    if (R.side === 'right' && !right) continue;
    if (z >= R.z0 && z <= R.z1 && tl >= R.t0 && tl <= R.t1) return { key: 100 + r * 2 + (right ? 1 : 0), rect: R, right, color: R.color ?? [1, 1, 1] };
  }
  const bc = bandColor(L, z, th, n);
  return { key: bc.index, rect: null, right, color: bc.color };
}

/**
 * Build the fuselage skin between za and zb (one part). Returns the grid vertex positions of the first/last ring
 * too (for caps). With opts.inner, builds the inward-facing cockpit shell instead (glass cells become openings).
 */
export function loftFuselage(b: GeoBuilder, P: FusProfile, L: FusLivery, za: number, zb: number, opts: LoftOptions, lines?: { lines: Line[]; segs: number[] }): void {
  const ln = lines ?? fuselageLines(P, L, opts.ringSeg, opts.exact);
  const zs = stations(P, L, za, zb, opts.step, opts.exact, opts.extraZ ?? []);
  const rows = zs.length;
  // ring θ per station
  const TH: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const z = zs[i];
    const th: number[] = [];
    let prev = 0;
    const vals = ln.lines.map((l) => l.f(z));
    for (let k = 0; k < vals.length; k++) {
      vals[k] = Math.max(vals[k], prev);
      prev = vals[k];
    }
    for (let k = 0; k < vals.length - 1; k++) {
      const a = vals[k];
      const bb = vals[k + 1];
      const n = ln.segs[k];
      for (let s = 0; s < n; s++) th.push(a + ((bb - a) * s) / n);
    }
    th.push(Math.PI * 2);
    TH.push(th);
  }
  const cols = TH[0].length;
  const Pg: THREE.Vector3[][] = [];
  const Ng: THREE.Vector3[][] = [];
  for (let i = 0; i < rows; i++) {
    const pa = profileAt(P, zs[i]);
    const pr: THREE.Vector3[] = [];
    const nr: THREE.Vector3[] = [];
    for (let j = 0; j < cols; j++) {
      pr.push(fusPoint(P, zs[i], TH[i][j], new THREE.Vector3(), pa));
      nr.push(fusNormal(P, zs[i], TH[i][j]));
    }
    Pg.push(pr);
    Ng.push(nr);
  }
  const nAt = (z: number) => (P.n ? P.n(z) : 2);
  const rnd = opts.damaged !== undefined ? prng(opts.damaged) : null;
  const holes = new Set<number>();
  if (rnd) {
    // tear a few clusters of cells out of the upper/side cowling
    for (let c = 0; c < 4; c++) {
      const ci = Math.floor(rnd() * (rows - 1));
      const cj = Math.floor(rnd() * (cols - 1));
      const rr = 1 + Math.floor(rnd() * 2);
      for (let di = -rr; di <= rr; di++) for (let dj = -rr - 1; dj <= rr + 1; dj++) if (rnd() > 0.25) holes.add((ci + di) * 10000 + ((cj + dj + cols - 1) % (cols - 1)));
    }
  }
  const inner = opts.inner;
  if (inner) {
    emitGrid(b, Pg, Ng, (i, j) => {
      const zc = (zs[i] + zs[i + 1]) / 2;
      if (zc > inner.zFront) return null;
      const tc = (TH[i][j] + TH[i][j + 1] + TH[i + 1][j] + TH[i + 1][j + 1]) / 4;
      const reg = regionAt(L, zc, tc, nAt(zc));
      if (reg.rect && reg.rect.kind === 'glass') return null;
      const h = hOfTheta(tc, nAt(zc));
      return { key: Math.round(h * 20) + 40, color: inner.color(h, zc), mat: MATTE };
    }, { flip: true, offset: -inner.offset });
    return;
  }
  emitGrid(b, Pg, Ng, (i, j) => {
    const zc = (zs[i] + zs[i + 1]) / 2;
    const tc = (TH[i][j] + TH[i][j + 1] + TH[i + 1][j] + TH[i + 1][j + 1]) / 4;
    if (rnd && holes.has(i * 10000 + j) && Math.cos(tc) > -0.3) return null;
    const reg = regionAt(L, zc, tc, nAt(zc));
    let color = reg.color;
    let mat: Mat = PAINT;
    let key = reg.key;
    let uv: CellStyle['uv'];
    if (reg.rect) {
      const R = reg.rect;
      if (R.kind === 'glass') {
        mat = R.mat ?? GLASS;
        color = R.color ?? [0.03, 0.045, 0.07];
        key = REGION_GLASS + key;
      } else {
        mat = R.mat ?? PAINT;
        if (R.kind === 'uv' && R.uv) {
          const U = R.uv;
          // underlying band colour shows through the white background of the art
          const bc = bandColor(L, zc, tc, nAt(zc));
          color = R.color ?? bc.color;
          const right = reg.right;
          uv = (ii, jj) => {
            const z = zs[ii];
            const t = TH[ii][jj];
            const tl = right ? Math.PI * 2 - t : t;
            const fu = right ? (z - R.z0) / (R.z1 - R.z0) : (R.z1 - z) / (R.z1 - R.z0);
            const fv = 1 - (tl - R.t0) / (R.t1 - R.t0);
            return [U.u0 + (U.u1 - U.u0) * clamp(fu, 0, 1), U.v0 + (U.v1 - U.v0) * clamp(fv, 0, 1)] as const;
          };
        }
      }
    }
    if (rnd) {
      const s = rnd();
      color = mix(color, [0.02, 0.018, 0.016], 0.55 + 0.4 * s);
      mat = MATTE;
      key = 5000 + i * 3000 + j; // unique: faceted soot
    }
    const st: CellStyle = { key, color, mat, uv, variant: opts.variant };
    if (opts.win && (!reg.rect || reg.rect.kind !== 'glass')) st.win = (ii, jj) => [zs[ii], Pg[ii][jj].y];
    return st;
  });
}

/** Closed ring of points at z (n points, θ uniform) for caps. */
export function fusRing(P: FusProfile, z: number, n: number, inset = 0): { p: THREE.Vector3[]; nrm: THREE.Vector3[]; th: number[] } {
  const p: THREE.Vector3[] = [];
  const nrm: THREE.Vector3[] = [];
  const th: number[] = [];
  const pa = profileAt(P, z);
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const q = fusPoint(P, z, t, new THREE.Vector3(), pa);
    const nn = fusNormal(P, z, t);
    if (inset) q.addScaledVector(nn, -inset);
    p.push(q);
    nrm.push(nn);
    th.push(t);
  }
  return { p, nrm, th };
}

/** Tail-end closure (APU exhaust): fan from the last ring to a recessed centre. */
export function closeTail(b: GeoBuilder, P: FusProfile, seg: number, color: RGB, mat: Mat): void {
  const z = P.zTail;
  const pa = profileAt(P, z);
  const ring = fusRing(P, z, seg);
  b.color = color;
  b.mat = mat;
  const c = new THREE.Vector3(0, pa.mid, z + Math.min(pa.w, pa.top) * 0.35);
  const n = new THREE.Vector3(0, 0, -1);
  const ci = b.vtxV(c, n);
  const base = b.count;
  for (const p of ring.p) b.vtxV(p, n);
  for (let k = 0; k < seg; k++) b.tri(ci, base + k, base + ((k + 1) % seg));
}
