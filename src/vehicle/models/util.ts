import * as THREE from 'three';

/** Small math + geometry-accumulation helpers shared by the procedural car builders. */

export type Curve = (x: number) => number;

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Monotone cubic (Fritsch–Carlson) interpolation through sorted [x, y] points. Clamped outside the range. */
export function curve(points: ReadonlyArray<readonly [number, number]>): Curve {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
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

export type RGB = readonly [number, number, number];
export const gray = (v: number): RGB => [v, v, v];
export const WHITE: RGB = [1, 1, 1];

/** Per-vertex material code for "detail" meshes: metalness, roughness, tint amount, light/emissive type. */
export type MatCode = readonly [number, number, number, number];
export const MAT = {
  plastic: [0.0, 0.62, 0, 0] as MatCode,
  satin: [0.1, 0.45, 0, 0] as MatCode,
  rubber: [0.0, 0.88, 0, 0] as MatCode,
  chrome: [1.0, 0.08, 0, 0] as MatCode,
  metal: [0.85, 0.35, 0, 0] as MatCode,
  fabric: [0.0, 0.95, 0, 0] as MatCode,
  gloss: [0.0, 0.2, 0, 0] as MatCode,
};

/** UV that samples the white corner of the trim atlas (see textures.ts). */
export const WHITE_UV: readonly [number, number] = [0.75, 0.82];

export interface AddOpts {
  matrix?: THREE.Matrix4;
  color?: RGB;
  mat?: MatCode;
  roof?: number;
  /** Override uv for every vertex (e.g. WHITE_UV). If omitted, the source geometry's uv is used (or WHITE_UV). */
  uv?: readonly [number, number];
  /** Map source uv into a sub-rect of the atlas: [u0, v0, u1, v1]. */
  uvRect?: readonly [number, number, number, number];
  /** Flip triangle winding (for inward-facing copies). */
  flip?: boolean;
  colorFn?: (p: THREE.Vector3, out: number[]) => void;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/**
 * Geometry accumulator with every attribute any car mesh might need. `toGeometry(kind)` emits only the attributes
 * the material of that kind uses (paint: color/aCar/aRoof, detail: color/uv/aMat, glass: uv, plain: none).
 */
export class GeoAcc {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  mat: number[] = [];
  roof: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, c: RGB = WHITE, u = WHITE_UV[0], v = WHITE_UV[1], m: MatCode = MAT.plastic, roof = 0): number {
    this.pos.push(px, py, pz);
    this.nrm.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
    this.uv.push(u, v);
    this.mat.push(m[0], m[1], m[2], m[3]);
    this.roof.push(roof);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Append a three.js geometry (indexed or not) with a transform and constant attributes. */
  add(g: THREE.BufferGeometry, o: AddOpts = {}): this {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    let n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    if (!n) {
      g.computeVertexNormals();
      n = g.getAttribute('normal') as THREE.BufferAttribute;
    }
    const uvA = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const colA = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const base = this.count;
    if (o.matrix) _nm.getNormalMatrix(o.matrix);
    const c = o.color ?? WHITE;
    const m = o.mat ?? MAT.plastic;
    const tmpCol: number[] = [0, 0, 0];
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      _n.fromBufferAttribute(n, i);
      if (o.matrix) {
        _v.applyMatrix4(o.matrix);
        _n.applyMatrix3(_nm).normalize();
      }
      if (o.flip) _n.negate();
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      if (o.colorFn) {
        o.colorFn(_v, tmpCol);
        this.col.push(tmpCol[0], tmpCol[1], tmpCol[2]);
      } else if (colA) this.col.push(colA.getX(i) * c[0], colA.getY(i) * c[1], colA.getZ(i) * c[2]);
      else this.col.push(c[0], c[1], c[2]);
      if (o.uv) this.uv.push(o.uv[0], o.uv[1]);
      else if (uvA && o.uvRect) {
        const r = o.uvRect;
        this.uv.push(r[0] + (r[2] - r[0]) * uvA.getX(i), r[1] + (r[3] - r[1]) * uvA.getY(i));
      } else this.uv.push(WHITE_UV[0], WHITE_UV[1]);
      this.mat.push(m[0], m[1], m[2], m[3]);
      this.roof.push(o.roof ?? 0);
    }
    const index = g.getIndex();
    const flip = !!o.flip !== (o.matrix ? o.matrix.determinant() < 0 : false);
    const pushTri = (a: number, b: number, cc: number) => {
      if (flip) this.idx.push(base + a, base + cc, base + b);
      else this.idx.push(base + a, base + b, base + cc);
    };
    if (index) for (let i = 0; i < index.count; i += 3) pushTri(index.getX(i), index.getX(i + 1), index.getX(i + 2));
    else for (let i = 0; i < p.count; i += 3) pushTri(i, i + 1, i + 2);
    return this;
  }

  /** Append another accumulator. */
  append(o: GeoAcc): this {
    const base = this.count;
    this.pos.push(...o.pos);
    this.nrm.push(...o.nrm);
    this.col.push(...o.col);
    this.uv.push(...o.uv);
    this.mat.push(...o.mat);
    this.roof.push(...o.roof);
    for (const i of o.idx) this.idx.push(i + base);
    return this;
  }

  toGeometry(kind: 'paint' | 'detail' | 'glass' | 'plain'): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (kind === 'paint') {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('aCar', new THREE.Float32BufferAttribute(this.pos, 3));
      g.setAttribute('aRoof', new THREE.Float32BufferAttribute(this.roof, 1));
    } else if (kind === 'detail') {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 4));
    } else if (kind === 'glass') {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** Build a matrix from position + Euler (radians) + scale. */
export function mtx(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** Matrix that maps local +Z to `dir` and places at `pos` (with optional roll about dir). */
export function mtxLook(pos: THREE.Vector3, dir: THREE.Vector3, up = new THREE.Vector3(0, 1, 0), s = new THREE.Vector3(1, 1, 1)): THREE.Matrix4 {
  const z = dir.clone().normalize();
  let x = new THREE.Vector3().crossVectors(up, z);
  if (x.lengthSq() < 1e-8) x = new THREE.Vector3(1, 0, 0);
  x.normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  m.scale(s);
  m.setPosition(pos);
  return m;
}

/**
 * Sweep a closed or open 2D profile (in the path's normal plane: px along `side`, py along `up`) along a 3D polyline.
 * Returns an indexed geometry with smooth normals (crease-free). Frames: tangent = path direction, side = up × tangent.
 */
export function sweep(
  path: THREE.Vector3[],
  profile: ReadonlyArray<readonly [number, number]>,
  opts: { closed?: boolean; up?: THREE.Vector3 | ((i: number) => THREE.Vector3); capStart?: boolean; capEnd?: boolean; scale?: (i: number) => number } = {},
): THREE.BufferGeometry {
  const P = profile.length;
  const pos: number[] = [];
  const idx: number[] = [];
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    t.subVectors(b, a).normalize();
    const u0 = typeof opts.up === 'function' ? opts.up(i) : opts.up ?? new THREE.Vector3(0, 1, 0);
    side.crossVectors(u0, t).normalize();
    up.crossVectors(t, side).normalize();
    const sc = opts.scale ? opts.scale(i) : 1;
    for (let j = 0; j < P; j++) {
      const [px, py] = profile[j];
      pos.push(path[i].x + (side.x * px + up.x * py) * sc, path[i].y + (side.y * px + up.y * py) * sc, path[i].z + (side.z * px + up.z * py) * sc);
    }
  }
  const segs = opts.closed ? P : P - 1;
  for (let i = 0; i < path.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % P;
      const a = i * P + j;
      const b = i * P + j1;
      const c = (i + 1) * P + j1;
      const d = (i + 1) * P + j;
      // CCW profiles (in side/up coordinates) get outward normals.
      idx.push(a, c, d, a, b, c);
    }
  }
  // Caps use their own vertex copies so the cap edge stays crisp.
  const addCap = (ring: number, reverse: boolean) => {
    const c = new THREE.Vector3();
    const first = pos.length / 3;
    for (let j = 0; j < P; j++) {
      const k = (ring * P + j) * 3;
      pos.push(pos[k], pos[k + 1], pos[k + 2]);
      c.x += pos[k];
      c.y += pos[k + 1];
      c.z += pos[k + 2];
    }
    c.multiplyScalar(1 / P);
    const ci = pos.length / 3;
    pos.push(c.x, c.y, c.z);
    for (let j = 0; j < P; j++) {
      const a = first + j;
      const b = first + ((j + 1) % P);
      if (reverse) idx.push(ci, b, a);
      else idx.push(ci, a, b);
    }
  };
  if (opts.capStart) addCap(0, true);
  if (opts.capEnd) addCap(path.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Non-indexed copy (flat-shading friendly) and vertex normals recomputed. */
export function flatten(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g.clone();
  ng.computeVertexNormals();
  return ng;
}
