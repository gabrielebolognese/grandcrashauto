import * as THREE from 'three';
import { GeoBuilder, PAINT, METAL, DARK, type Mat, type RGB, lerp } from './builder';
import { emitGrid, gridNormals, type CellStyle } from './grid';

/**
 * Lifting surfaces (wings, tailplanes, fin, winglets): ruled lofts between airfoil sections. Trailing-edge pieces
 * (flaps, ailerons, elevators, rudder) are separate closed sub-shells tagged with a surface id so the vertex shader
 * rotates them about their hinge; the fixed box gets a cove wall so deflected surfaces show a gap.
 */

export interface WingStation {
  s: number; // spanwise coordinate (bookkeeping)
  le: THREE.Vector3;
  chordDir: THREE.Vector3; // unit LE → TE
  up: THREE.Vector3; // unit, upper-surface side
  chord: number;
  thick: number; // t/c
  camber?: number;
}

export interface TEPiece {
  s0: number;
  s1: number;
  uh: number; // hinge chord fraction
  surf: number; // surface id (0 = fixed)
  color?: RGB;
}

export interface SurfaceStyle {
  top: RGB;
  bottom: RGB;
  le?: RGB; // leading-edge strip (u < leU)
  leU?: number;
  mat?: Mat;
  /** optional atlas mapping (fin art) */
  uv?: (p: THREE.Vector3, upper: boolean) => readonly [number, number];
  tip?: 'round' | 'flat' | 'none';
  root?: 'flat' | 'none';
  /** colour override by spanwise position s (e.g. coloured tips) */
  spanColor?: (s: number, upper: boolean) => RGB | null;
}

export interface HingeInfo {
  surf: number;
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  chord: number;
}

const yt = (u: number, t: number) => 5 * t * (0.2969 * Math.sqrt(Math.max(0, u)) - 0.126 * u - 0.3516 * u * u + 0.2843 * u * u * u - 0.1036 * u * u * u * u);

export function lerpStation(a: WingStation, b: WingStation, s: number): WingStation {
  const t = (s - a.s) / (b.s - a.s || 1);
  return {
    s,
    le: a.le.clone().lerp(b.le, t),
    chordDir: a.chordDir.clone().lerp(b.chordDir, t).normalize(),
    up: a.up.clone().lerp(b.up, t).normalize(),
    chord: lerp(a.chord, b.chord, t),
    thick: lerp(a.thick, b.thick, t),
    camber: lerp(a.camber ?? 0, b.camber ?? 0, t),
  };
}

/** Station at an arbitrary s along a station list. */
export function stationAt(st: WingStation[], s: number): WingStation {
  if (s <= st[0].s) return { ...st[0], le: st[0].le.clone(), s };
  for (let k = 0; k < st.length - 1; k++) if (s <= st[k + 1].s) return lerpStation(st[k], st[k + 1], s);
  const L = st[st.length - 1];
  return { ...L, le: L.le.clone(), s };
}

export function airfoilPoint(st: WingStation, u: number, side: 1 | -1, out = new THREE.Vector3()): THREE.Vector3 {
  const c = st.chord;
  const camber = (st.camber ?? 0) * 4 * u * (1 - u);
  return out.copy(st.le).addScaledVector(st.chordDir, u * c).addScaledVector(st.up, (side * yt(u, st.thick) + camber) * c);
}

function cosineU(n: number, extra: number[]): number[] {
  const us: number[] = [];
  for (let i = 0; i <= n; i++) us.push(0.5 * (1 - Math.cos((Math.PI * i) / n)));
  for (const e of extra) us.push(e);
  us.sort((a, b) => a - b);
  const out: number[] = [];
  for (const u of us) if (!out.length || u - out[out.length - 1] > 0.012) out.push(u);
  else if (extra.includes(u)) out[out.length - 1] = u;
  return out;
}

interface ProfPt {
  u: number;
  side: 1 | -1;
}

/**
 * Build a lifting surface. Returns hinge lines of the movable pieces.
 * n = chordwise points per side (LOD).
 */
export function buildSurface(b: GeoBuilder, stationsIn: WingStation[], pieces: TEPiece[], style: SurfaceStyle, n: number): HingeInfo[] {
  // insert stations at piece boundaries
  const cuts = new Set<number>(stationsIn.map((s) => s.s));
  for (const p of pieces) {
    cuts.add(p.s0);
    cuts.add(p.s1);
  }
  const sList = [...cuts].filter((s) => s >= stationsIn[0].s - 1e-6 && s <= stationsIn[stationsIn.length - 1].s + 1e-6).sort((a, c) => a - c);
  const st = sList.map((s) => stationAt(stationsIn, s));
  const leU = style.leU ?? 0.05;
  const extras = [leU, ...pieces.map((p) => p.uh)];
  const us = cosineU(n, extras);
  const hinges: HingeInfo[] = [];
  const mat = style.mat ?? PAINT;
  const colorFor = (u: number, side: 1 | -1, s: number, piece: TEPiece | null): RGB => {
    const span = style.spanColor?.(s, side > 0);
    if (span) return span;
    if (piece?.color && piece.surf) return piece.color;
    if (style.le && u < leU) return style.le;
    return side > 0 ? style.top : style.bottom;
  };

  for (let k = 0; k < st.length - 1; k++) {
    const A = st[k];
    const B = st[k + 1];
    const sm = (A.s + B.s) / 2;
    const piece = pieces.find((p) => p.s0 <= sm && p.s1 >= sm) ?? null;
    const uh = piece ? piece.uh : 1;
    // main shell profile: lower (uh → 0) then upper (0 → uh)
    const prof: ProfPt[] = [];
    const usMain = us.filter((u) => u <= uh + 1e-6);
    for (let i = usMain.length - 1; i >= 1; i--) prof.push({ u: usMain[i], side: -1 });
    prof.push({ u: 0, side: 1 });
    for (let i = 1; i < usMain.length; i++) prof.push({ u: usMain[i], side: 1 });
    shell(b, A, B, prof, (pp, s) => colorFor(pp.u, pp.side, s, null), mat, 0, style.uv);
    if (piece) {
      // cove wall (fixed, facing aft) at uh
      const pl = [airfoilPoint(A, uh, -1), airfoilPoint(B, uh, -1), airfoilPoint(B, uh, 1), airfoilPoint(A, uh, 1)];
      b.set({ color: [0.32, 0.34, 0.37], mat: DARK, surf: 0 });
      quadFacing(b, pl, A.chordDir);
      // the moving piece: upper uh → 1, lower 1 → uh
      const usTE = us.filter((u) => u >= uh - 1e-6);
      const tp: ProfPt[] = [];
      for (let i = 0; i < usTE.length; i++) tp.push({ u: usTE[i], side: 1 });
      for (let i = usTE.length - 1; i >= 0; i--) tp.push({ u: usTE[i], side: -1 });
      const gap = 0.006;
      const shrink = (s0: WingStation, inward: number): WingStation => ({ ...s0, le: s0.le.clone().addScaledVector(s0.chordDir, gap * s0.chord), s: s0.s + inward });
      const A2 = shrink(A, 0);
      const B2 = shrink(B, 0);
      shell(b, A2, B2, tp, (pp, s) => colorFor(pp.u, pp.side, s, piece), mat, piece.surf, style.uv);
      b.set({ color: piece.color ?? style.top, mat, surf: piece.surf });
      // front wall facing forward
      quadFacing(b, [airfoilPoint(A2, uh, 1), airfoilPoint(B2, uh, 1), airfoilPoint(B2, uh, -1), airfoilPoint(A2, uh, -1)], A.chordDir.clone().negate());
      // side walls
      sideWall(b, A2, usTE, uh);
      sideWall(b, B2, usTE, uh);
      b.surf = 0;
      if (piece.surf && !hinges.find((h) => h.surf === piece.surf)) {
        const p0 = A.le.clone().addScaledVector(A.chordDir, uh * A.chord).addScaledVector(A.up, (A.camber ?? 0) * A.chord);
        hinges.push({ surf: piece.surf, p0, p1: p0.clone(), chord: A.chord });
      }
      const h = hinges.find((x) => x.surf === piece.surf);
      if (h) h.p1 = B.le.clone().addScaledVector(B.chordDir, uh * B.chord).addScaledVector(B.up, (B.camber ?? 0) * B.chord);
    } else {
      // fixed trailing edge already included (uh = 1)
    }
  }
  // tip
  const T = st[st.length - 1];
  const tipKind = style.tip ?? 'round';
  if (tipKind !== 'none') {
    const prev = st[st.length - 2];
    const spanDir = T.le.clone().sub(prev.le).addScaledVector(T.chordDir, -T.chordDir.dot(T.le.clone().sub(prev.le))).normalize();
    let last = T;
    if (tipKind === 'round') {
      const R: WingStation = {
        s: T.s + 0.001,
        le: T.le.clone().addScaledVector(spanDir, T.thick * T.chord * 0.55).addScaledVector(T.chordDir, T.chord * 0.06),
        chordDir: T.chordDir.clone(),
        up: T.up.clone(),
        chord: T.chord * 0.9,
        thick: T.thick * 0.38,
        camber: 0,
      };
      const prof: ProfPt[] = [];
      for (let i = us.length - 1; i >= 1; i--) prof.push({ u: us[i], side: -1 });
      prof.push({ u: 0, side: 1 });
      for (let i = 1; i < us.length; i++) prof.push({ u: us[i], side: 1 });
      shell(b, T, R, prof, (pp, s) => colorFor(pp.u, pp.side, s, null), mat, 0, style.uv);
      last = R;
    }
    capSection(b, last, us, spanDir, colorFor(0.5, 1, T.s, null), mat);
  }
  if (style.root === 'flat') {
    const R0 = st[0];
    const spanDir = st[1].le.clone().sub(R0.le).normalize().negate();
    capSection(b, R0, us, spanDir, colorFor(0.5, 1, R0.s, null), mat);
  }
  return hinges;
}

function shell(
  b: GeoBuilder,
  A: WingStation,
  B: WingStation,
  prof: ProfPt[],
  color: (p: ProfPt, s: number) => RGB,
  mat: Mat,
  surf: number,
  uvf?: (p: THREE.Vector3, upper: boolean) => readonly [number, number],
): void {
  const P: THREE.Vector3[][] = [];
  const H: THREE.Vector3[][] = [];
  for (const pp of prof) {
    const pa = airfoilPoint(A, pp.u, pp.side);
    const pb = airfoilPoint(B, pp.u, pp.side);
    P.push([pa, pb]);
    const ha = pp.u < 0.004 ? A.chordDir.clone().negate() : A.up.clone().multiplyScalar(pp.side);
    const hb = pp.u < 0.004 ? B.chordDir.clone().negate() : B.up.clone().multiplyScalar(pp.side);
    H.push([ha, hb]);
  }
  const N = gridNormals(P, (i, j) => H[i][j]);
  const keys = new Map<string, number>();
  emitGrid(b, P, N, (i) => {
    const pp = prof[i];
    const pn = prof[i + 1];
    const mid: ProfPt = { u: (pp.u + pn.u) / 2, side: pp.side === pn.side ? pp.side : 1 };
    const c = color(mid.side === pp.side ? mid : pn, (A.s + B.s) / 2);
    const ks = c.join(',') + (pp.side === pn.side ? pp.side : 0);
    let key = keys.get(ks);
    if (key === undefined) {
      key = keys.size;
      keys.set(ks, key);
    }
    const st: CellStyle = { key, color: c, mat, surf };
    if (uvf) st.uv = (ii, jj) => uvf(P[ii][jj], prof[ii].side > 0);
    return st;
  });
}

function quadFacing(b: GeoBuilder, p: THREE.Vector3[], facing: THREE.Vector3): void {
  const n = new THREE.Vector3().subVectors(p[2], p[0]).cross(new THREE.Vector3().subVectors(p[3], p[1]));
  if (n.dot(facing) < 0) p = [p[0], p[3], p[2], p[1]];
  b.fquad(p[0], p[1], p[2], p[3]);
}

function sideWall(b: GeoBuilder, S: WingStation, usTE: number[], uh: number): void {
  // polygon of the TE piece section at this station (upper uh→1 then lower 1→uh)
  const pts: THREE.Vector3[] = [];
  for (const u of usTE) pts.push(airfoilPoint(S, u, 1));
  for (let i = usTE.length - 2; i >= 1; i--) pts.push(airfoilPoint(S, usTE[i], -1));
  pts.push(airfoilPoint(S, uh, -1));
  const c = airfoilPoint(S, (uh + 1) / 2, 1).add(airfoilPoint(S, (uh + 1) / 2, -1)).multiplyScalar(0.5);
  fanBoth(b, c, pts);
}

/** Double-sided fan (small closures — cheap, avoids orientation bookkeeping). */
function fanBoth(b: GeoBuilder, c: THREE.Vector3, pts: THREE.Vector3[]): void {
  const n = new THREE.Vector3().subVectors(pts[0], c).cross(new THREE.Vector3().subVectors(pts[1], c)).normalize();
  for (const sgn of [1, -1]) {
    const nn = n.clone().multiplyScalar(sgn);
    const ci = b.vtxV(c, nn);
    const base = b.count;
    for (const p of pts) b.vtxV(p, nn);
    for (let i = 0; i < pts.length; i++) {
      const a = base + i;
      const d = base + ((i + 1) % pts.length);
      if (sgn > 0) b.tri(ci, a, d);
      else b.tri(ci, d, a);
    }
  }
}

function capSection(b: GeoBuilder, S: WingStation, us: number[], facing: THREE.Vector3, color: RGB, mat: Mat): void {
  const pts: THREE.Vector3[] = [];
  for (let i = us.length - 1; i >= 0; i--) pts.push(airfoilPoint(S, us[i], -1));
  for (let i = 1; i < us.length - 1; i++) pts.push(airfoilPoint(S, us[i], 1));
  const c = airfoilPoint(S, 0.35, 1).add(airfoilPoint(S, 0.35, -1)).multiplyScalar(0.5);
  b.set({ color, mat, surf: 0 });
  const ci = b.vtxV(c, facing);
  const base = b.count;
  for (const p of pts) b.vtxV(p, facing);
  for (let i = 0; i < pts.length; i++) {
    const a = base + i;
    const d = base + ((i + 1) % pts.length);
    const nrm = new THREE.Vector3().subVectors(pts[i], c).cross(new THREE.Vector3().subVectors(pts[(i + 1) % pts.length], c));
    if (nrm.dot(facing) >= 0) b.tri(ci, a, d);
    else b.tri(ci, d, a);
  }
}

/** Airfoil outline (closed, n per side) of a station — for caps. */
export function sectionOutline(S: WingStation, n: number): THREE.Vector3[] {
  const us = cosineU(n, []);
  const pts: THREE.Vector3[] = [];
  for (let i = us.length - 1; i >= 0; i--) pts.push(airfoilPoint(S, us[i], -1));
  for (let i = 1; i < us.length - 1; i++) pts.push(airfoilPoint(S, us[i], 1));
  return pts;
}

export { METAL };
