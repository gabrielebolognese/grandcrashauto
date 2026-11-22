import * as THREE from 'three';

/**
 * Tiny merged-geometry builder for the low-poly props and parked cars.
 * Every part is converted to non-indexed triangles and baked with:
 *  - `color`  (vec3, linear) vertex colour
 *  - `aMat`   (vec4) x = per-instance tint mask (0..1), y = emissive code, z = sway weight, w = surface class
 * Cars use `paintMask` (float) instead of `aMat` (see buildCar()).
 *
 * Emissive codes (prop shader): 0 none, 1 night lamp, 2/3/4 traffic red/amber/green, 5 blinking amber, 6 night panel.
 * Surface classes: 0 matte, 1 glossy paint, 2 metal, 3 glass.
 */

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
  /** Duplicate triangles with flipped winding (thin double-sided surfaces like palm fronds). */
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
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (m) g.applyMatrix4(m);
    if (opts.flat || !g.getAttribute('normal')) {
      g.deleteAttribute('normal');
      g.computeVertexNormals();
    }
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
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
      for (let t = 0; t < count; t += 3) {
        const triIdx = this.tri++;
        const j = jit ? 1 + (hashf(triIdx * 7.31 + count) - 0.5) * 2 * jit : 1;
        for (let k = 0; k < 3; k++) {
          const i = side === 0 ? t + k : t + 2 - k;
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
          this.pos.push(x, y, z);
          const s = side === 0 ? 1 : -1;
          this.nrm.push(n.getX(i) * s, n.getY(i) * s, n.getZ(i) * s);
          if (opts.colorFn) opts.colorFn(x, y, z, _c.copy(base));
          else _c.copy(base);
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

// ───────────────────────────── matrix helpers ─────────────────────────────
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();

/** Compose a matrix from translation, Euler rotation (XYZ, radians) and scale. Returns a NEW matrix. */
export function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  _v.set(x, y, z);
  _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_v, _q, _s);
}

/** Matrix that maps the unit +Y axis onto the segment a→b (for cylinders built along Y with height 1, centered). */
export function alongSegment(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const dir = _v.copy(b).sub(a);
  const len = dir.length();
  dir.normalize();
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return _m.clone().compose(mid, _q, _s.set(1, len, 1));
}

// ───────────────────────────── primitive helpers ─────────────────────────────
export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rTop: number, rBot: number, h: number, seg = 8, open = false) =>
  new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);

/**
 * Tube of rings along a sampled curve. radiusFn(t) gives the radius at t in [0,1].
 * Returns an indexed geometry (converted by the builder).
 */
export function tubeAlong(
  curve: THREE.Curve<THREE.Vector3>,
  rings: number[],
  radiusFn: (t: number, ringIndex: number) => number,
  radial: number,
  capTop = true,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
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
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * Math.PI * 2;
      const cx = Math.cos(a), sx = Math.sin(a);
      const nx = nA.x * cx + nB.x * sx, ny = nA.y * cx + nB.y * sx, nz = nA.z * cx + nB.z * sx;
      pos.push(pt.x + nx * rad, pt.y + ny * rad, pt.z + nz * rad);
      nrm.push(nx, ny, nz);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) {
    for (let k = 0; k < radial; k++) {
      const a = r * radial + k;
      const b = r * radial + ((k + 1) % radial);
      const c = (r + 1) * radial + k;
      const d = (r + 1) * radial + ((k + 1) % radial);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (capTop) {
    curve.getPointAt(rings[rings.length - 1], pt);
    curve.getTangentAt(rings[rings.length - 1], tan).normalize();
    const ci = pos.length / 3;
    pos.push(pt.x, pt.y, pt.z);
    nrm.push(tan.x, tan.y, tan.z);
    const r0 = (rings.length - 1) * radial;
    for (let k = 0; k < radial; k++) idx.push(r0 + k, r0 + ((k + 1) % radial), ci);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

/**
 * Leaf/frond ribbon: a spine (array of points) with a width per station; V-folded (centre raised by `fold`).
 * Builds 3 vertices per station (left, spine, right). Normals computed flat by the builder.
 */
export function ribbon(spine: THREE.Vector3[], widths: number[], side: THREE.Vector3, fold: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i];
    const w = widths[i];
    pos.push(p.x - side.x * w, p.y - side.y * w, p.z - side.z * w);
    pos.push(p.x + up.x * fold * (w > 0 ? 1 : 0), p.y + fold * (w > 0 ? 1 : 0), p.z);
    pos.push(p.x + side.x * w, p.y + side.y * w, p.z + side.z * w);
  }
  for (let i = 0; i < spine.length - 1; i++) {
    const a = i * 3;
    const b = (i + 1) * 3;
    // left half
    idx.push(a, b, a + 1, a + 1, b, b + 1);
    // right half
    idx.push(a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
