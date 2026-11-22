import * as THREE from 'three';
import { GeoBuilder, type Mat, type RGB } from './builder';

/** Per-cell style of a grid surface. Cells with the same key share their corner vertices (smooth colour regions). */
export interface CellStyle {
  key: number;
  color: RGB;
  mat: Mat;
  /** Atlas UV for a corner (i, j) — only for UV-mapped regions (titles, registration, fin art). */
  uv?: (i: number, j: number) => readonly [number, number];
  /** Procedural window coordinates for a corner (fuselage skin). */
  win?: (i: number, j: number) => readonly [number, number];
  surf?: number;
  variant?: number;
}

/**
 * Emit a structured grid of points P[i][j] with normals N[i][j]. Each quad is wound so its face normal agrees with the
 * supplied vertex normals. cell(i, j) styles the quad (i..i+1, j..j+1); null skips it (openings).
 */
export function emitGrid(
  b: GeoBuilder,
  P: THREE.Vector3[][],
  N: THREE.Vector3[][],
  cell: (i: number, j: number) => CellStyle | null,
  opts: { flip?: boolean; offset?: number } = {},
): void {
  const rows = P.length;
  if (rows < 2) return;
  const cols = P[0].length;
  const cache = new Map<number, number>();
  const off = opts.offset ?? 0;
  const sgn = opts.flip ? -1 : 1;
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const vid = (i: number, j: number, st: CellStyle): number => {
    const k = (st.key * 4096 + i) * 4096 + j;
    let v = cache.get(k);
    if (v !== undefined) return v;
    const p = P[i][j];
    const n = N[i][j];
    b.color = st.color;
    b.mat = st.mat;
    b.surf = st.surf ?? 0;
    b.variant = st.variant ?? 0;
    if (st.win) {
      const w = st.win(i, j);
      b.winS = w[0];
      b.winT = w[1];
    } else {
      b.winS = 0;
      b.winT = 99;
    }
    const uv = st.uv ? st.uv(i, j) : undefined;
    v = b.vtx(p.x + n.x * off, p.y + n.y * off, p.z + n.z * off, n.x * sgn, n.y * sgn, n.z * sgn, uv?.[0], uv?.[1]);
    cache.set(k, v);
    return v;
  };
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const st = cell(i, j);
      if (!st) continue;
      const a = vid(i, j, st);
      const bb = vid(i + 1, j, st);
      const c = vid(i + 1, j + 1, st);
      const d = vid(i, j + 1, st);
      // face normal from the diagonals
      e1.subVectors(P[i + 1][j + 1], P[i][j]);
      e2.subVectors(P[i][j + 1], P[i + 1][j]);
      fn.crossVectors(e1, e2);
      const avgx = N[i][j].x + N[i + 1][j].x + N[i + 1][j + 1].x + N[i][j + 1].x;
      const avgy = N[i][j].y + N[i + 1][j].y + N[i + 1][j + 1].y + N[i][j + 1].y;
      const avgz = N[i][j].z + N[i + 1][j].z + N[i + 1][j + 1].z + N[i][j + 1].z;
      const dot = (fn.x * avgx + fn.y * avgy + fn.z * avgz) * sgn;
      if (dot >= 0) b.quad(a, bb, c, d);
      else b.quad(a, d, c, bb);
    }
  }
  b.surf = 0;
  b.variant = 0;
  b.winS = 0;
  b.winT = 99;
}

/** Numerical normals of a grid (central differences), oriented toward `hint(i, j)` when given. */
export function gridNormals(P: THREE.Vector3[][], hint?: (i: number, j: number, p: THREE.Vector3) => THREE.Vector3, wrapJ = false): THREE.Vector3[][] {
  const rows = P.length;
  const cols = P[0].length;
  const N: THREE.Vector3[][] = [];
  const di = new THREE.Vector3();
  const dj = new THREE.Vector3();
  for (let i = 0; i < rows; i++) {
    const row: THREE.Vector3[] = [];
    for (let j = 0; j < cols; j++) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(rows - 1, i + 1);
      let j0 = j - 1;
      let j1 = j + 1;
      if (wrapJ) {
        if (j0 < 0) j0 = cols - 2;
        if (j1 > cols - 1) j1 = 1;
      } else {
        j0 = Math.max(0, j0);
        j1 = Math.min(cols - 1, j1);
      }
      di.subVectors(P[i1][j], P[i0][j]);
      dj.subVectors(P[i][j1], P[i][j0]);
      const n = new THREE.Vector3().crossVectors(di, dj);
      if (n.lengthSq() < 1e-14) n.set(0, 1, 0);
      n.normalize();
      if (hint && n.dot(hint(i, j, P[i][j])) < 0) n.negate();
      row.push(n);
    }
    N.push(row);
  }
  return N;
}
