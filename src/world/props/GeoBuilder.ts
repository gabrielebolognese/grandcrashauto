import * as THREE from 'three';

/**
 * Tiny merged-geometry builder for the props and parked cars (owner: props).
 * Every part is converted to non-indexed triangles and baked with:
 *  - `color`  (vec3, linear) vertex colour
 *  - `aMat`   (vec4) x = per-instance tint mask (0..1), y = emissive code, z = sway weight, w = surface class
 * Cars use `paintMask` (float: 1 paint, 0.5 glass, 0 other) instead of `aMat` — the same layout as
 * ICarFactory.instancingGeometry, so the parked-car mesh can switch between our fallback and the car-models geometry.
 *
 * Emissive codes / surface classes: see EM / SF below.
 */

/** Emissive codes (prop shader). */
export const EM = { none: 0, lamp: 1, red: 2, amber: 3, green: 4, blink: 5, panel: 6, walk: 7 } as const;
/** Surface classes (prop shader roughness/metalness). */
export const SF = { matte: 0, gloss: 1, metal: 2, glass: 3, foliage: 4, chrome: 5 } as const;

export type ColorFn = (x: number, y: number, z: number, out: THREE.Color) => void;
export type ScalarFn = (x: number, y: number, z: number) => number;

export interface PartOpts {
  /** Per-instance tint mask 0..1 (1 = vertex colour multiplied by the instance colour). */
  tint?: number;
  emit?: number;
  sway?: number | ScalarFn;
  surf?: number;
  /** Recompute flat (faceted) normals after transform. */
  flat?: boolean;
  /** Per-vertex colour override (receives local post-transform position). */
  colorFn?: ColorFn;
  /** Per-triangle brightness jitter amplitude (faceted charm), deterministic. */
  jitter?: number;
  /** Duplicate triangles with flipped winding (thin double-sided surfaces). */
  doubleSided?: boolean;
  /** Car-style paint mask (only used by builders created with mode 'car'). */
  paint?: number;
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();

export class GeoBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private mat: number[] = [];
  private paint: number[] = [];
  private tri = 0;

  /**
   * @param mode 'prop' bakes aMat, 'car' bakes paintMask.
   * @param ao   darken vertices close to the ground (fake ambient occlusion) up to this height (m). 0 disables.
   */
  constructor(private mode: 'prop' | 'car' = 'prop', private ao = 0.35, private aoStrength = 0.28) {}

  get triangles(): number {
    return this.tri;
  }

  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, opts: PartOpts = {}, m?: THREE.Matrix4): this {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) g.applyMatrix4(m);
    const mirrored = !!m && m.determinant() < 0;
    if (opts.flat || !g.getAttribute('normal')) {
      g.deleteAttribute('normal');
      g.computeVertexNormals();
    }
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const vc = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const base = new THREE.Color(color);
    const tint = opts.tint ?? 0;
    const emit = opts.emit ?? 0;
    const surf = opts.surf ?? 0;
    const paint = opts.paint ?? 0;
    const sway = opts.sway ?? 0;
    const jit = opts.jitter ?? 0;
    const count = p.count;
    const sides = opts.doubleSided ? 2 : 1;
    for (let side = 0; side < sides; side++) {
      const flip = (side === 1) !== mirrored;
      for (let t = 0; t + 2 < count; t += 3) {
        const triIdx = this.tri++;
        const j = jit ? 1 + (hashf(triIdx * 7.31 + count) - 0.5) * 2 * jit : 1;
        for (let k = 0; k < 3; k++) {
          const i = flip ? t + 2 - k : t + k;
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          this.pos.push(x, y, z);
          const s = side === 0 ? 1 : -1;
          this.nrm.push(n.getX(i) * s, n.getY(i) * s, n.getZ(i) * s);
          if (opts.colorFn) opts.colorFn(x, y, z, _c.copy(base));
          else _c.copy(base);
          if (vc) _c.setRGB(_c.r * vc.getX(i), _c.g * vc.getY(i), _c.b * vc.getZ(i));
          let shade = j;
          if (this.ao > 0 && y < this.ao) shade *= 1 - this.aoStrength * (1 - Math.max(0, y) / this.ao);
          this.col.push(_c.r * shade, _c.g * shade, _c.b * shade);
          if (this.mode === 'prop') {
            const sw = typeof sway === 'number' ? sway : sway(x, y, z);
            this.mat.push(tint, emit, sw, surf);
          } else {
            this.paint.push(paint);
          }
        }
      }
    }
    g.dispose();
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.mode === 'prop') g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 4));
    else g.setAttribute('paintMask', new THREE.Float32BufferAttribute(this.paint, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** Deterministic hash → [0,1). */
export function hashf(x: number): number {
  const s = Math.sin(x * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Deterministic hash of a 3D point → [0,1) (stable for shared vertices of non-indexed geometry). */
export function hash3(x: number, y: number, z: number): number {
  return hashf(Math.round(x * 1000) * 0.0173 + Math.round(y * 1000) * 0.0311 + Math.round(z * 1000) * 0.0457);
}

// ───────────────────────────── matrix helpers ─────────────────────────────
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Compose a matrix from translation, Euler rotation (XYZ, radians) and scale. Returns a NEW matrix. */
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** Matrix that maps a unit +Y-axis part (height 1, centred) onto the segment a→b; `thick` scales X/Z. */
export function alongSegment(a: THREE.Vector3, b: THREE.Vector3, thick = 1): THREE.Matrix4 {
  const dir = _v.copy(b).sub(a);
  const len = dir.length();
  dir.normalize();
  _q.setFromUnitVectors(_up, dir);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return new THREE.Matrix4().compose(mid, _q, _s.set(thick, len, thick));
}

// ───────────────────────────── primitive helpers ─────────────────────────────
export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rTop: number, rBot: number, h: number, seg = 8, open = false) =>
  new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
/** Cylinder lying along X. */
export const cylX = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2);
/** Cylinder lying along Z. */
export const cylZ = (r: number, len: number, seg = 8, r2 = r) => new THREE.CylinderGeometry(r2, r, len, seg).rotateX(Math.PI / 2);

/**
 * Lathe around +Y from a [radius, y] profile (bottom → top). Normals are smooth around the axis and smooth along the
 * profile only where adjacent profile segments bend less than `smoothDeg` — art-deco steps stay crisp while
 * globes and bellies stay round. Non-indexed output; zero-area pole triangles are skipped.
 */
export function lathe(profile: number[][], seg: number, smoothDeg = 40, phase = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const n = profile.length;
  const sn: number[][] = [];
  for (let i = 0; i < n - 1; i++) {
    const dr = profile[i + 1][0] - profile[i][0];
    const dy = profile[i + 1][1] - profile[i][1];
    const l = Math.hypot(dr, dy) || 1;
    sn.push([dy / l, -dr / l]);
  }
  const cosLim = Math.cos((smoothDeg * Math.PI) / 180);
  const segN = (i: number, end: number): number[] => {
    const a = sn[i];
    const j = end ? i + 1 : i - 1;
    if (j < 0 || j >= sn.length) return a;
    const b = sn[j];
    if (a[0] * b[0] + a[1] * b[1] < cosLim) return a;
    const r = a[0] + b[0], y = a[1] + b[1];
    const l = Math.hypot(r, y) || 1;
    return [r / l, y / l];
  };
  const v: number[][] = [[], [], [], []];
  for (let i = 0; i < n - 1; i++) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    if (Math.abs(r1 - r0) < 1e-6 && Math.abs(y1 - y0) < 1e-6) continue;
    if (r0 < 1e-6 && r1 < 1e-6) continue;
    const n0 = segN(i, 0), n1 = segN(i, 1);
    for (let k = 0; k < seg; k++) {
      const a0 = phase + (k / seg) * Math.PI * 2, a1 = phase + ((k + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      v[0] = [r0 * s0, y0, r0 * c0, n0[0] * s0, n0[1], n0[0] * c0];
      v[1] = [r0 * s1, y0, r0 * c1, n0[0] * s1, n0[1], n0[0] * c1];
      v[2] = [r1 * s1, y1, r1 * c1, n1[0] * s1, n1[1], n1[0] * c1];
      v[3] = [r1 * s0, y1, r1 * c0, n1[0] * s0, n1[1], n1[0] * c0];
      const tris = r0 < 1e-6 ? [[0, 2, 3]] : r1 < 1e-6 ? [[0, 1, 2]] : [[0, 1, 2], [0, 2, 3]];
      for (const t of tris) {
        for (const idx of t) {
          const q = v[idx];
          pos.push(q[0], q[1], q[2]);
          nrm.push(q[3], q[4], q[5]);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Extrude a closed 2D outline (x, y) by `depth` along Z, centred on z = 0, with an optional bevel. */
export function extrude(pts: number[][], depth: number, bevel = 0, curveSegments = 4): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  return extrudeShape(shape, depth, bevel, curveSegments);
}

export function extrudeShape(shape: THREE.Shape, depth: number, bevel = 0, curveSegments = 4): THREE.BufferGeometry {
  const core = Math.max(0.002, depth - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments,
  });
  g.translate(0, 0, -core / 2);
  return g;
}

/**
 * Tube of rings along a curve. radiusFn(t, ringIndex) gives the radius; shadeFn (optional) a per-ring brightness
 * baked into a `color` attribute (multiplied by the part colour in GeoBuilder.add).
 */
export function tubeAlong(
  curve: THREE.Curve<THREE.Vector3>,
  rings: number[],
  radiusFn: (t: number, ringIndex: number) => number,
  radial: number,
  capTop = true,
  shadeFn?: (ringIndex: number) => number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const up = new THREE.Vector3(1, 0, 0);
  const tan = new THREE.Vector3();
  const nA = new THREE.Vector3();
  const nB = new THREE.Vector3();
  const pt = new THREE.Vector3();
  for (let r = 0; r < rings.length; r++) {
    const t = rings[r];
    curve.getPointAt(t, pt);
    curve.getTangentAt(t, tan).normalize();
    nA.crossVectors(tan, up).normalize();
    if (nA.lengthSq() < 1e-6) nA.set(0, 0, 1);
    nB.crossVectors(tan, nA).normalize();
    const rad = radiusFn(t, r);
    const sh = shadeFn ? shadeFn(r) : 1;
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const cx = Math.cos(a), sx = Math.sin(a);
      const nx = nA.x * cx + nB.x * sx, ny = nA.y * cx + nB.y * sx, nz = nA.z * cx + nB.z * sx;
      pos.push(pt.x + nx * rad, pt.y + ny * rad, pt.z + nz * rad);
      nrm.push(nx, ny, nz);
      col.push(sh, sh, sh);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < radial; k++) {
      const a = r * radial + k;
      const b = r * radial + ((k + 1) % radial);
      const c = (r + 1) * radial + k;
      const d = (r + 1) * radial + ((k + 1) % radial);
      idx.push(a, b, c, b, d, c);
    }
  }
  if (capTop) {
    curve.getPointAt(rings[rings.length - 1], pt);
    curve.getTangentAt(rings[rings.length - 1], tan).normalize();
    const ci = pos.length / 3;
    pos.push(pt.x, pt.y, pt.z);
    nrm.push(tan.x, tan.y, tan.z);
    const sh = shadeFn ? shadeFn(rings.length - 1) : 1;
    col.push(sh, sh, sh);
    const r0 = (rings.length - 1) * radial;
    for (let k = 0; k < radial; k++) idx.push(r0 + k, r0 + ((k + 1) % radial), ci);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Raw triangle soup → geometry (normals computed flat by GeoBuilder). */
export function soup(pos: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
