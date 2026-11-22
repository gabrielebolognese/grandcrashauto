import * as THREE from 'three';

/**
 * Geometry accumulator for the procedural planes. Every plane geometry shares ONE vertex format so parts, caps,
 * interiors and the LOD-2 merged mesh can all be merged and drawn with the single plane material:
 *   position(3) normal(3) color(3, linear) uv(2, atlas) aWin(2: fuselage z / y for procedural cabin windows,
 *   t = 99 → none) aRM(2: roughness, metalness) aFx(4: surface id, variant code, sway weight, part id).
 */

export type RGB = readonly [number, number, number];

export const NO_WIN = 99;
/** Atlas UV of the plain white texel block (vertex colour shows through). */
export const WHITE_UV: readonly [number, number] = [4 / 1024, 1 - 4 / 1024];

/** Variant codes (aFx.y) — geometry collapsed in the vertex shader unless its condition holds. */
export const VAR = {
  always: 0,
  /** engine k intact: k (1..4). */
  intact: (k: number) => k,
  /** engine k damaged: 4 + k. */
  damaged: (k: number) => 4 + k,
  /** cockpit aft bulkhead: hidden once the cabin behind is open. */
  bulkhead: 9,
  /** prop blades: hidden when the prop blur disc shows. */
  blades: 10,
} as const;

const _c = new THREE.Color();
export function rgb(hex: number): RGB {
  _c.setHex(hex); // sRGB → linear (ColorManagement)
  return [_c.r, _c.g, _c.b];
}
export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function scale(a: RGB, k: number): RGB {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export interface Mat {
  r: number; // roughness
  m: number; // metalness
}
export const PAINT: Mat = { r: 0.32, m: 0.12 };
export const MATTE: Mat = { r: 0.75, m: 0.0 };
export const GLASS: Mat = { r: 0.06, m: 0.55 };
export const METAL: Mat = { r: 0.28, m: 0.85 };
export const RUBBER: Mat = { r: 0.92, m: 0.0 };
export const DARK: Mat = { r: 0.9, m: 0.0 };

const tv = new THREE.Vector3();
const tn = new THREE.Vector3();

export class GeoBuilder {
  // growable typed storage (cap = vertex capacity)
  pos = new Float32Array(3 * 256);
  nor = new Float32Array(3 * 256);
  col = new Float32Array(3 * 256);
  uv = new Float32Array(2 * 256);
  win = new Float32Array(2 * 256);
  rm = new Float32Array(2 * 256);
  fx = new Float32Array(4 * 256);
  idx = new Uint32Array(768);
  private n = 0;
  private ni = 0;
  private cap = 256;

  // current vertex state
  color: RGB = [1, 1, 1];
  mat: Mat = PAINT;
  surf = 0;
  variant = 0;
  sway = 0;
  part = 0;
  u = WHITE_UV[0];
  v = WHITE_UV[1];
  winS = 0;
  winT = NO_WIN;

  private stack: THREE.Matrix4[] = [];
  private m: THREE.Matrix4 | null = null;
  private nm = new THREE.Matrix3();

  get count(): number {
    return this.n;
  }

  private grow(nv: number): void {
    if (nv <= this.cap) return;
    let c = this.cap;
    while (c < nv) c *= 2;
    const g = (a: Float32Array, k: number) => {
      const b = new Float32Array(c * k);
      b.set(a.subarray(0, this.n * k));
      return b;
    };
    this.pos = g(this.pos, 3);
    this.nor = g(this.nor, 3);
    this.col = g(this.col, 3);
    this.uv = g(this.uv, 2);
    this.win = g(this.win, 2);
    this.rm = g(this.rm, 2);
    this.fx = g(this.fx, 4);
    this.cap = c;
  }
  private growIdx(ni: number): void {
    if (ni <= this.idx.length) return;
    let c = this.idx.length;
    while (c < ni) c *= 2;
    const b = new Uint32Array(c);
    b.set(this.idx.subarray(0, this.ni));
    this.idx = b;
  }

  set(o: { color?: RGB; mat?: Mat; surf?: number; variant?: number; sway?: number }): this {
    if (o.color) this.color = o.color;
    if (o.mat) this.mat = o.mat;
    if (o.surf !== undefined) this.surf = o.surf;
    if (o.variant !== undefined) this.variant = o.variant;
    if (o.sway !== undefined) this.sway = o.sway;
    return this;
  }

  push(m: THREE.Matrix4): void {
    const nm = this.m ? this.m.clone().multiply(m) : m.clone();
    this.stack.push(this.m ?? new THREE.Matrix4());
    this.m = nm;
    this.nm.getNormalMatrix(nm);
  }
  pop(): void {
    const m = this.stack.pop();
    this.m = m && !isIdentity(m) ? m : null;
    if (this.m) this.nm.getNormalMatrix(this.m);
  }

  vtx(x: number, y: number, z: number, nx: number, ny: number, nz: number, u?: number, v?: number): number {
    if (this.m) {
      tv.set(x, y, z).applyMatrix4(this.m);
      tn.set(nx, ny, nz).applyMatrix3(this.nm).normalize();
      x = tv.x; y = tv.y; z = tv.z;
      nx = tn.x; ny = tn.y; nz = tn.z;
    }
    const i = this.n;
    if (i >= this.cap) this.grow(i + 1);
    const i3 = i * 3, i2 = i * 2, i4 = i * 4;
    const P = this.pos, N = this.nor, C = this.col;
    P[i3] = x; P[i3 + 1] = y; P[i3 + 2] = z;
    N[i3] = nx; N[i3 + 1] = ny; N[i3 + 2] = nz;
    C[i3] = this.color[0]; C[i3 + 1] = this.color[1]; C[i3 + 2] = this.color[2];
    this.uv[i2] = u ?? this.u; this.uv[i2 + 1] = v ?? this.v;
    this.win[i2] = this.winS; this.win[i2 + 1] = this.winT;
    this.rm[i2] = this.mat.r; this.rm[i2 + 1] = this.mat.m;
    const F = this.fx;
    F[i4] = this.surf; F[i4 + 1] = this.variant; F[i4 + 2] = this.sway; F[i4 + 3] = this.part;
    this.n = i + 1;
    return i;
  }
  vtxV(p: THREE.Vector3, n: THREE.Vector3, u?: number, v?: number): number {
    return this.vtx(p.x, p.y, p.z, n.x, n.y, n.z, u, v);
  }

  tri(a: number, b: number, c: number): void {
    const j = this.ni;
    if (j + 3 > this.idx.length) this.growIdx(j + 3);
    const I = this.idx;
    I[j] = a; I[j + 1] = b; I[j + 2] = c;
    this.ni = j + 3;
  }
  quad(a: number, b: number, c: number, d: number): void {
    const j = this.ni;
    if (j + 6 > this.idx.length) this.growIdx(j + 6);
    const I = this.idx;
    I[j] = a; I[j + 1] = b; I[j + 2] = c; I[j + 3] = a; I[j + 4] = c; I[j + 5] = d;
    this.ni = j + 6;
  }

  /** Flat-shaded triangle from 3 points (CCW = front). */
  ftri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    const n = tn.copy(c).sub(a).cross(tv.copy(b).sub(a)).negate().normalize().clone();
    const i = this.vtxV(a, n);
    this.vtxV(b, n);
    this.vtxV(c, n);
    this.tri(i, i + 1, i + 2);
  }
  /** Flat-shaded quad from 4 points (CCW = front). */
  fquad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
    const n = new THREE.Vector3().subVectors(c, a).cross(tv.subVectors(d, b));
    if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
    n.normalize();
    const i = this.vtxV(a, n);
    this.vtxV(b, n);
    this.vtxV(c, n);
    this.vtxV(d, n);
    this.quad(i, i + 1, i + 2, i + 3);
  }

  /** Flat quad, re-wound so its normal faces `facing`. */
  fquadF(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, facing: THREE.Vector3): void {
    const n = new THREE.Vector3().subVectors(c, a).cross(tv.subVectors(d, b));
    if (n.dot(facing) < 0) this.fquad(a, d, c, b);
    else this.fquad(a, b, c, d);
  }

  /** Axis-aligned box (in the current matrix frame), flat shaded. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): void {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(cx + x * hx, cy + y * hy, cz + z * hz);
    const p = [V(-1, -1, -1), V(1, -1, -1), V(1, 1, -1), V(-1, 1, -1), V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1)];
    this.fquad(p[4], p[5], p[6], p[7]); // +z
    this.fquad(p[1], p[0], p[3], p[2]); // -z
    this.fquad(p[5], p[1], p[2], p[6]); // +x
    this.fquad(p[0], p[4], p[7], p[3]); // -x
    this.fquad(p[7], p[6], p[2], p[3]); // +y
    this.fquad(p[0], p[1], p[5], p[4]); // -y
  }

  /**
   * Surface of revolution around the local Z axis: profile = [r, z][] (z ascending or descending), seg segments.
   * Smooth normals from the profile slope. closeStart/closeEnd add flat discs. a0..a1 = angular range.
   */
  lathe(profile: ReadonlyArray<readonly [number, number]>, seg: number, opts: { a0?: number; a1?: number; smooth?: boolean; flip?: boolean } = {}): void {
    const a0 = opts.a0 ?? 0;
    const a1 = opts.a1 ?? Math.PI * 2;
    const n = profile.length;
    const base = this.count;
    const smooth = opts.smooth ?? true;
    // profile normals (2D, in r-z plane)
    const pn: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const p0 = profile[Math.max(0, i - 1)];
      const p1 = profile[Math.min(n - 1, i + 1)];
      const dr = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      // normal = rotate tangent (dr, dz) by -90° in (r,z): (dz, -dr)
      let nr = dz;
      let nz = -dr;
      const l = Math.hypot(nr, nz) || 1;
      nr /= l;
      nz /= l;
      pn.push(opts.flip ? [-nr, -nz] : [nr, nz]);
    }
    if (!smooth) {
      for (let i = 0; i < n - 1; i++) {
        for (let s = 0; s < seg; s++) {
          const t0 = a0 + ((a1 - a0) * s) / seg;
          const t1 = a0 + ((a1 - a0) * (s + 1)) / seg;
          const P = (r: number, z: number, t: number) => new THREE.Vector3(Math.cos(t) * r, Math.sin(t) * r, z);
          const A = P(profile[i][0], profile[i][1], t0);
          const B = P(profile[i][0], profile[i][1], t1);
          const C = P(profile[i + 1][0], profile[i + 1][1], t1);
          const D = P(profile[i + 1][0], profile[i + 1][1], t0);
          if (opts.flip) this.fquad(A, D, C, B);
          else this.fquad(A, B, C, D);
        }
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const [r, z] = profile[i];
      for (let s = 0; s <= seg; s++) {
        const t = a0 + ((a1 - a0) * s) / seg;
        const c = Math.cos(t);
        const sn = Math.sin(t);
        this.vtx(c * r, sn * r, z, c * pn[i][0], sn * pn[i][0], pn[i][1]);
      }
    }
    const row = seg + 1;
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < seg; s++) {
        const a = base + i * row + s;
        const b = a + 1;
        const c = a + row + 1;
        const d = a + row;
        // orientation: angular direction × profile direction = outward (normal = (dz, -dr))
        if (opts.flip) this.quad(a, d, c, b);
        else this.quad(a, b, c, d);
      }
    }
  }

  /** Flat disc / ring around local Z at z, facing +Z (dir=1) or -Z (dir=-1). */
  disc(r: number, z: number, seg: number, dir: 1 | -1, rIn = 0, a0 = 0, a1 = Math.PI * 2): void {
    const base = this.count;
    for (let s = 0; s <= seg; s++) {
      const t = a0 + ((a1 - a0) * s) / seg;
      this.vtx(Math.cos(t) * r, Math.sin(t) * r, z, 0, 0, dir);
      this.vtx(Math.cos(t) * rIn, Math.sin(t) * rIn, z, 0, 0, dir);
    }
    for (let s = 0; s < seg; s++) {
      const a = base + s * 2;
      if (dir > 0) this.quad(a, a + 2, a + 3, a + 1);
      else this.quad(a, a + 1, a + 3, a + 2);
    }
  }

  /** Cylinder between two points (smooth sides), optional caps. */
  cylinder(p0: THREE.Vector3, p1: THREE.Vector3, r0: number, r1: number, seg: number, caps = true): void {
    const m = frameAlong(p0, p1);
    const len = p0.distanceTo(p1);
    this.push(m);
    this.lathe([[r0, 0], [r1, len]], seg);
    if (caps) {
      if (r0 > 0) this.disc(r0, 0, seg, -1);
      if (r1 > 0) this.disc(r1, len, seg, 1);
    }
    this.pop();
  }

  /** Tube along a polyline with constant radius (smooth), no caps. */
  tube(pts: THREE.Vector3[], r: number, seg: number): void {
    const n = pts.length;
    const base = this.count;
    let prevN = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const t = new THREE.Vector3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      if (i === 0) {
        prevN = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      }
      const nn = prevN.clone().sub(t.clone().multiplyScalar(prevN.dot(t))).normalize();
      prevN = nn;
      const b = new THREE.Vector3().crossVectors(t, nn);
      for (let s = 0; s <= seg; s++) {
        const a = (s / seg) * Math.PI * 2;
        const d = nn.clone().multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
        this.vtx(pts[i].x + d.x * r, pts[i].y + d.y * r, pts[i].z + d.z * r, d.x, d.y, d.z);
      }
    }
    const row = seg + 1;
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < seg; s++) {
        const a = base + i * row + s;
        this.quad(a, a + 1, a + row + 1, a + row);
      }
    }
  }

  /** Double-sided ribbon along a polyline (cables): width perpendicular to `side`. */
  ribbon(pts: THREE.Vector3[], width: number, side: THREE.Vector3, swayFrom = 0): void {
    const n = pts.length;
    for (const face of [1, -1]) {
      const base = this.count;
      for (let i = 0; i < n; i++) {
        const t = new THREE.Vector3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
        const nrm = new THREE.Vector3().crossVectors(t, side).normalize().multiplyScalar(face);
        const off = side.clone().normalize().multiplyScalar(width / 2);
        this.sway = swayFrom * (i / (n - 1));
        this.vtx(pts[i].x + off.x, pts[i].y + off.y, pts[i].z + off.z, nrm.x, nrm.y, nrm.z);
        this.vtx(pts[i].x - off.x, pts[i].y - off.y, pts[i].z - off.z, nrm.x, nrm.y, nrm.z);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        if (face > 0) this.quad(a, a + 1, a + 3, a + 2);
        else this.quad(a, a + 2, a + 3, a + 1);
      }
    }
    this.sway = 0;
  }

  /** Convex polygon (fan), flat normal, CCW points = front. */
  poly(pts: THREE.Vector3[], normal?: THREE.Vector3): void {
    if (pts.length < 3) return;
    const n = normal ?? new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0])).normalize();
    const base = this.count;
    for (const p of pts) this.vtxV(p, n);
    for (let i = 1; i < pts.length - 1; i++) this.tri(base, base + i, base + i + 1);
  }

  append(o: GeoBuilder): void {
    const base = this.n;
    const on = o.count;
    this.grow(base + on);
    this.pos.set(o.pos.subarray(0, on * 3), base * 3);
    this.nor.set(o.nor.subarray(0, on * 3), base * 3);
    this.col.set(o.col.subarray(0, on * 3), base * 3);
    this.uv.set(o.uv.subarray(0, on * 2), base * 2);
    this.win.set(o.win.subarray(0, on * 2), base * 2);
    this.rm.set(o.rm.subarray(0, on * 2), base * 2);
    this.fx.set(o.fx.subarray(0, on * 4), base * 4);
    this.n = base + on;
    const oi = o.indexCount;
    this.growIdx(this.ni + oi);
    for (let i = 0; i < oi; i++) this.idx[this.ni + i] = o.idx[i] + base;
    this.ni += oi;
  }

  get indexCount(): number {
    return this.ni;
  }

  /** Overwrite the part id of every vertex. */
  setPartAll(id: number): void {
    for (let i = 0; i < this.n; i++) this.fx[i * 4 + 3] = id;
  }

  /** Replace surface id `from` by `to`. */
  remapSurf(from: number, to: number): void {
    for (let i = 0; i < this.n; i++) if (this.fx[i * 4] === from) this.fx[i * 4] = to;
  }

  translateAll(x: number, y: number, z: number): void {
    for (let i = 0; i < this.n * 3; i += 3) {
      this.pos[i] += x;
      this.pos[i + 1] += y;
      this.pos[i + 2] += z;
    }
  }

  /** Area-weighted centroid of the triangles (damaged-variant geometry excluded). */
  areaCentroid(): THREE.Vector3 {
    const c = new THREE.Vector3();
    let A = 0;
    const p = this.pos;
    const ia = new THREE.Vector3(), ib = new THREE.Vector3(), ic = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (let i = 0; i < this.ni; i += 3) {
      const vv = this.fx[this.idx[i] * 4 + 1];
      if (vv > 4.5 && vv < 8.5) continue;
      ia.fromArray(p, this.idx[i] * 3);
      ib.fromArray(p, this.idx[i + 1] * 3);
      ic.fromArray(p, this.idx[i + 2] * 3);
      const area = e1.subVectors(ib, ia).cross(e2.subVectors(ic, ia)).length() * 0.5;
      c.addScaledVector(ia.add(ib).add(ic), area / 3);
      A += area;
    }
    return A > 0 ? c.multiplyScalar(1 / A) : c;
  }

  build(): THREE.BufferGeometry {
    const n = this.n;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, n * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, n * 3), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, n * 2), 2));
    g.setAttribute('aWin', new THREE.BufferAttribute(this.win.slice(0, n * 2), 2));
    g.setAttribute('aRM', new THREE.BufferAttribute(this.rm.slice(0, n * 2), 2));
    g.setAttribute('aFx', new THREE.BufferAttribute(this.fx.slice(0, n * 4), 4));
    const idx = this.idx.subarray(0, this.ni);
    g.setIndex(new THREE.BufferAttribute(n > 65535 ? idx.slice() : Uint16Array.from(idx), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  get triangles(): number {
    return this.ni / 3;
  }
}

function isIdentity(m: THREE.Matrix4): boolean {
  const e = m.elements;
  return e[0] === 1 && e[5] === 1 && e[10] === 1 && e[15] === 1 && e[12] === 0 && e[13] === 0 && e[14] === 0 && e[1] === 0 && e[2] === 0 && e[4] === 0 && e[6] === 0 && e[8] === 0 && e[9] === 0;
}

/** Matrix whose local +Z runs from p0 toward p1 (origin at p0). */
export function frameAlong(p0: THREE.Vector3, p1: THREE.Vector3, upHint = new THREE.Vector3(0, 1, 0)): THREE.Matrix4 {
  const z = new THREE.Vector3().subVectors(p1, p0).normalize();
  let up = upHint.clone();
  if (Math.abs(up.dot(z)) > 0.95) up = new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(p0);
}

export const v3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export type Curve = (x: number) => number;

/** Monotone cubic (Fritsch–Carlson) interpolation through [x, y] points (x ascending). Clamped outside. */
export function curve(points: ReadonlyArray<readonly [number, number]>): Curve {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (n === 1) return () => ys[0];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] > x) hi = mid;
      else lo = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

/** Piecewise-linear interpolation through [x, y] points. */
export function plin(points: ReadonlyArray<readonly [number, number]>): Curve {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  return (x: number) => {
    if (x <= pts[0][0]) return pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      if (x <= pts[i + 1][0]) {
        const t = (x - pts[i][0]) / Math.max(1e-9, pts[i + 1][0] - pts[i][0]);
        return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      }
    }
    return pts[pts.length - 1][1];
  };
}

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
