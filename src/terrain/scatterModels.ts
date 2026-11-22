import * as THREE from 'three';
import { Rng } from '../core/rng';

/**
 * Procedural low/medium-poly scatter models (flat-shaded, per-face vertex colours, non-indexed: position + normal +
 * color). Trees have 3 LODs; everything is small (≤ ~200 triangles). Origins on the ground; +Z forward.
 */

const C = (hex: number) => new THREE.Color(hex);

export class Geo {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private c = new THREE.Vector3();
  private n = new THREE.Vector3();

  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, col: THREE.Color, jitter = 0): void {
    this.a.set(ax, ay, az);
    this.b.set(bx, by, bz);
    this.c.set(cx, cy, cz);
    this.n.subVectors(this.b, this.a).cross(this.c.clone().sub(this.a)).normalize();
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) this.nor.push(this.n.x, this.n.y, this.n.z);
    const k = 1 + jitter;
    for (let i = 0; i < 3; i++) this.col.push(col.r * k, col.g * k, col.b * k);
  }
  triV(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, col: THREE.Color, jitter = 0): void {
    this.tri(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, col, jitter);
  }
  quadV(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, col: THREE.Color, jitter = 0): void {
    this.triV(a, b, c, col, jitter);
    this.triV(a, c, d, col, jitter);
  }
  /** Axis-aligned box (optionally without bottom). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: THREE.Color, opts: { bottom?: boolean; top?: THREE.Color; shade?: number } = {}): void {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const s = opts.shade ?? 0;
    // +X
    this.quadV(v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1), col, -s);
    // -X
    this.quadV(v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), v(x0, y0, z0), col, -s);
    // +Z
    this.quadV(v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), v(x0, y0, z1), col, 0);
    // -Z
    this.quadV(v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), col, 0);
    // top
    this.quadV(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), opts.top ?? col, 0);
    if (opts.bottom) this.quadV(v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1), col, 0);
  }
  /** Cone/frustum ring from (r0 at y0) to (r1 at y1), `seg` sides, jittered radii, optional apex. */
  frustum(seg: number, y0: number, r0: number, y1: number, r1: number, col: THREE.Color, rng: Rng | null, jit = 0, colTop?: THREE.Color, rot = 0): void {
    const p0: THREE.Vector3[] = [];
    const p1: THREE.Vector3[] = [];
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2 + rot;
      const j0 = rng ? 1 + (rng.next() - 0.5) * jit : 1;
      const j1 = rng ? 1 + (rng.next() - 0.5) * jit : 1;
      p0.push(new THREE.Vector3(Math.cos(a) * r0 * j0, y0, Math.sin(a) * r0 * j0));
      p1.push(new THREE.Vector3(Math.cos(a) * r1 * j1, y1, Math.sin(a) * r1 * j1));
    }
    for (let i = 0; i < seg; i++) {
      const k = (i + 1) % seg;
      const sh = rng ? (rng.next() - 0.5) * 0.12 : 0;
      if (r1 <= 1e-4) this.triV(p0[i], p1[i], p0[k], col, sh);
      else {
        this.triV(p0[i], p1[i], p1[k], colTop ?? col, sh);
        this.triV(p0[i], p1[k], p0[k], col, sh);
      }
    }
  }
  /** Fan cap (disc) at y, facing down (dir -1) or up (+1). */
  disc(seg: number, y: number, r: number, col: THREE.Color, dir: 1 | -1, rot = 0): void {
    const c = new THREE.Vector3(0, y, 0);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2 + rot;
      const a1 = ((i + 1) / seg) * Math.PI * 2 + rot;
      const p0 = new THREE.Vector3(Math.cos(a0) * r, y, Math.sin(a0) * r);
      const p1 = new THREE.Vector3(Math.cos(a1) * r, y, Math.sin(a1) * r);
      if (dir < 0) this.triV(c, p0, p1, col);
      else this.triV(c, p1, p0, col);
    }
  }
  /** Jittered icosphere blob (detail 0 or 1) at centre with radii. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, detail: number, col: THREE.Color, colDark: THREE.Color, rng: Rng, jit = 0.18): void {
    const ico = new THREE.IcosahedronGeometry(1, detail);
    const p = ico.getAttribute('position');
    // weld for consistent jitter
    const key = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
    const jm = new Map<string, number>();
    const tmp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = tmp[k].fromBufferAttribute(p, i + k);
        const kk = key(v.x, v.y, v.z);
        let j = jm.get(kk);
        if (j === undefined) {
          j = 1 + (rng.next() - 0.5) * jit;
          jm.set(kk, j);
        }
        v.multiplyScalar(j);
        v.set(cx + v.x * rx, cy + v.y * ry, cz + v.z * rz);
      }
      // darker underside
      const ny = (tmp[0].y + tmp[1].y + tmp[2].y) / 3 - cy;
      const t = THREE.MathUtils.clamp(0.5 - ny / (ry * 1.6), 0, 1);
      const c = col.clone().lerp(colDark, t);
      this.triV(tmp[0], tmp[1], tmp[2], c, (rng.next() - 0.5) * 0.1);
    }
    ico.dispose();
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const TRUNK = C(0x8a6a4f);
const TRUNK_DARK = C(0x6d5440);
const PINE = C(0x3f7a4f);
const PINE_HI = C(0x4f9259);
const PINE_DARK = C(0x2f5f41);
const LEAF = C(0x66a957);
const LEAF_HI = C(0x7dbd62);
const LEAF_DARK = C(0x467f45);

// ─────────────────────────────── trees ───────────────────────────────

export function pineGeometry(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const g = new Geo();
  const rng = new Rng(4242);
  if (lod === 0) {
    g.frustum(6, 0, 0.32, 2.4, 0.22, TRUNK, rng, 0.1, TRUNK_DARK);
    const tiers = [
      [1.6, 3.3, 2.6],
      [3.4, 2.7, 2.3],
      [5.1, 2.1, 2.0],
      [6.6, 1.45, 2.4],
    ];
    for (let t = 0; t < tiers.length; t++) {
      const [y, r, h] = tiers[t];
      const rot = t * 0.6;
      // drooping skirt ring then the cone
      g.frustum(9, y, r, y + h * 0.35, r * 0.72, t % 2 ? PINE : PINE_DARK, rng, 0.22, PINE, rot);
      g.frustum(9, y + h * 0.35, r * 0.72, y + h, 0, t === tiers.length - 1 ? PINE_HI : PINE, rng, 0.15, undefined, rot);
      g.disc(9, y, r * 0.95, PINE_DARK, -1, rot);
    }
  } else if (lod === 1) {
    g.frustum(4, 0, 0.3, 2.0, 0.2, TRUNK, null);
    g.frustum(6, 1.5, 3.1, 5.0, 0, PINE_DARK, rng, 0.15);
    g.frustum(6, 4.2, 2.1, 9.0, 0, PINE, rng, 0.15, undefined, 0.5);
  } else {
    g.frustum(4, 0.6, 2.8, 8.8, 0, PINE, null, 0, undefined, 0.4);
  }
  return g.build();
}

export function roundTreeGeometry(lod: 0 | 1 | 2): THREE.BufferGeometry {
  const g = new Geo();
  const rng = new Rng(777);
  if (lod === 0) {
    g.frustum(6, 0, 0.36, 3.2, 0.24, TRUNK, rng, 0.1, TRUNK_DARK);
    // a couple of branches
    g.frustum(4, 2.4, 0.14, 3.6, 0.08, TRUNK_DARK, null, 0, undefined, 0.3);
    g.blob(0, 5.0, 0, 2.9, 2.5, 2.9, 1, LEAF, LEAF_DARK, rng, 0.22);
    g.blob(1.3, 6.2, 0.6, 1.7, 1.5, 1.7, 0, LEAF_HI, LEAF, rng, 0.2);
    g.blob(-1.4, 4.3, -0.7, 1.6, 1.3, 1.6, 0, LEAF, LEAF_DARK, rng, 0.2);
  } else if (lod === 1) {
    g.frustum(4, 0, 0.32, 3.0, 0.22, TRUNK, null);
    g.blob(0, 5.1, 0, 3.0, 2.6, 3.0, 0, LEAF, LEAF_DARK, rng, 0.15);
  } else {
    const ico = new THREE.OctahedronGeometry(1, 0);
    const p = ico.getAttribute('position');
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < p.count; i += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(p, i + k).multiply(new THREE.Vector3(3.1, 2.8, 3.1)).add(new THREE.Vector3(0, 4.9, 0));
      g.triV(v[0], v[1], v[2], v[0].y + v[1].y + v[2].y < 3 * 4.9 ? LEAF_DARK : LEAF);
    }
    ico.dispose();
  }
  return g.build();
}

export function bushGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const rng = new Rng(99);
  g.blob(0, 0.55, 0, 1.0, 0.75, 1.0, 0, C(0x6aa85a), C(0x4a8048), rng, 0.25);
  g.blob(0.6, 0.45, 0.3, 0.65, 0.5, 0.65, 0, C(0x78b562), C(0x527f48), rng, 0.25);
  return g.build();
}

export function rockGeometry(big: boolean): THREE.BufferGeometry {
  const g = new Geo();
  const rng = new Rng(big ? 31 : 13);
  g.blob(0, 0.45, 0, 1, 0.75, 1, big ? 1 : 0, C(0xa8a1a6), C(0x7f7984), rng, big ? 0.32 : 0.4);
  return g.build();
}

// ─────────────────────────────── farm / houses ───────────────────────────────

function gableRoof(g: Geo, x0: number, x1: number, z0: number, z1: number, y0: number, ridge: number, col: THREE.Color, overhang = 0.4, gableCol?: THREE.Color): void {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const xm = (x0 + x1) / 2;
  const ox = overhang;
  // ridge along Z
  g.quadV(v(x0 - ox, y0 - 0.2, z0 - ox), v(x0 - ox, y0 - 0.2, z1 + ox), v(xm, ridge, z1 + ox), v(xm, ridge, z0 - ox), col, 0.04);
  g.quadV(v(x1 + ox, y0 - 0.2, z1 + ox), v(x1 + ox, y0 - 0.2, z0 - ox), v(xm, ridge, z0 - ox), v(xm, ridge, z1 + ox), col, -0.06);
  // gable ends
  const gc = gableCol ?? col;
  g.triV(v(x0, y0, z1), v(x1, y0, z1), v(xm, ridge - 0.1, z1), gc);
  g.triV(v(x1, y0, z0), v(x0, y0, z0), v(xm, ridge - 0.1, z0), gc);
  // undersides (seen from below the overhang)
  g.quadV(v(x0 - ox, y0 - 0.2, z0 - ox), v(xm, ridge, z0 - ox), v(xm, ridge, z1 + ox), v(x0 - ox, y0 - 0.2, z1 + ox), col, -0.2);
  g.quadV(v(x1 + ox, y0 - 0.2, z1 + ox), v(xm, ridge, z1 + ox), v(xm, ridge, z0 - ox), v(x1 + ox, y0 - 0.2, z0 - ox), col, -0.2);
}

function windows(g: Geo, x0: number, x1: number, z: number, y0: number, y1: number, n: number, col: THREE.Color, faceSign: 1 | -1): void {
  const v = (x: number, y: number, zz: number) => new THREE.Vector3(x, y, zz);
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + w * (i + 0.28);
    const b = x0 + w * (i + 0.72);
    const zz = z + faceSign * 0.03;
    if (faceSign > 0) g.quadV(v(b, y0, zz), v(b, y1, zz), v(a, y1, zz), v(a, y0, zz), col);
    else g.quadV(v(a, y0, zz), v(a, y1, zz), v(b, y1, zz), v(b, y0, zz), col);
  }
}

export function farmhouseGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const wall = C(0xf6ead6);
  g.box(-5, 0, -4, 5, 5.2, 4, wall, { shade: 0.06 });
  gableRoof(g, -5, 5, -4, 4, 5.2, 8.6, C(0xc8604c), 0.5, wall);
  g.box(2.2, 6.4, -1.2, 3.2, 9.6, -0.2, C(0xb9a28c));
  windows(g, -4.5, 4.5, 4, 1.5, 3.2, 4, C(0x5d7fa0), 1);
  windows(g, -4.5, 4.5, -4, 1.5, 3.2, 3, C(0x5d7fa0), -1);
  g.box(-0.8, 0, 3.98, 0.8, 2.4, 4.08, C(0x7b5a43));
  // porch
  g.box(-3.5, 0, 4, 3.5, 0.3, 6, C(0xd9cbb5));
  return g.build();
}

export function barnGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const red = C(0xc9524a);
  const trim = C(0xfaf3e6);
  g.box(-6, 0, -9, 6, 6.5, 9, red, { shade: 0.05 });
  // gambrel roof (ridge along Z)
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const roof = C(0x5b5f6a);
  const pts = [[-6.5, 6.3], [-4.4, 9.4], [0, 11.2], [4.4, 9.4], [6.5, 6.3]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [xa, ya] = pts[i];
    const [xb, yb] = pts[i + 1];
    g.quadV(v(xa, ya, -9.5), v(xa, ya, 9.5), v(xb, yb, 9.5), v(xb, yb, -9.5), roof, i < 2 ? 0.03 : -0.05);
    g.quadV(v(xa, ya, -9.5), v(xb, yb, -9.5), v(xb, yb, 9.5), v(xa, ya, 9.5), roof, -0.25);
  }
  for (const z of [9, -9]) {
    const s = z > 0 ? 1 : -1;
    const poly = [[-6, 6.5], [-4.2, 9.2], [0, 11], [4.2, 9.2], [6, 6.5]];
    for (let i = 1; i < poly.length - 1; i++) {
      const a = v(poly[0][0], poly[0][1], z);
      const b = v(poly[i][0], poly[i][1], z);
      const c = v(poly[i + 1][0], poly[i + 1][1], z);
      if (s > 0) g.triV(a, c, b, red);
      else g.triV(a, b, c, red);
    }
    // big door with white X trim
    const zz = z + s * 0.04;
    if (s > 0) g.quadV(v(2.4, 0, zz), v(2.4, 4.6, zz), v(-2.4, 4.6, zz), v(-2.4, 0, zz), trim);
    else g.quadV(v(-2.4, 0, zz), v(-2.4, 4.6, zz), v(2.4, 4.6, zz), v(2.4, 0, zz), trim);
    const zz2 = z + s * 0.08;
    if (s > 0) g.quadV(v(2.0, 0.4, zz2), v(2.0, 4.2, zz2), v(-2.0, 4.2, zz2), v(-2.0, 0.4, zz2), C(0xb24a43));
    else g.quadV(v(-2.0, 0.4, zz2), v(-2.0, 4.2, zz2), v(2.0, 4.2, zz2), v(2.0, 0.4, zz2), C(0xb24a43));
  }
  return g.build();
}

export function houseGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const wall = C(0xffffff);
  g.box(-4, 0, -3.5, 4, 4.6, 3.5, wall, { shade: 0.05 });
  // hip-ish roof
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const roof = C(0xd0705a);
  const y0 = 4.5;
  const yr = 6.9;
  const o = 0.5;
  const A = v(-4 - o, y0, -3.5 - o), B = v(4 + o, y0, -3.5 - o), Cc = v(4 + o, y0, 3.5 + o), D = v(-4 - o, y0, 3.5 + o);
  const R0 = v(-1.6, yr, 0), R1 = v(1.6, yr, 0);
  g.quadV(D, Cc, R1, R0, roof, 0.03);
  g.quadV(B, A, R0, R1, roof, -0.06);
  g.triV(A, D, R0, roof, -0.02);
  g.triV(Cc, B, R1, roof, 0);
  windows(g, -3.4, 3.4, 3.5, 1.4, 3.1, 3, C(0x5f86a8), 1);
  windows(g, -3.4, 3.4, -3.5, 1.4, 3.1, 2, C(0x5f86a8), -1);
  g.box(-0.6, 0, 3.48, 0.6, 2.3, 3.58, C(0x8c6a52));
  return g.build();
}

export function cabinGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const log = C(0x9a6b45);
  g.box(-3.5, 0, -3, 3.5, 3.2, 3, log, { shade: 0.08 });
  // log stripes
  for (let y = 0.5; y < 3.2; y += 0.8) g.box(-3.6, y, -3.08, 3.6, y + 0.14, 3.08, C(0x7d5536));
  gableRoof(g, -3.5, 3.5, -3, 3, 3.2, 6.2, C(0x4f6b55), 0.6, log);
  g.box(1.6, 3.5, 0.8, 2.5, 7.0, 1.7, C(0x9a958f));
  g.box(-0.6, 0, 2.98, 0.6, 2.1, 3.1, C(0x5a3d29));
  windows(g, -3, 3, -3, 1.2, 2.3, 2, C(0xf2c879), -1);
  return g.build();
}

export function hayGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const straw = C(0xe8c977);
  const end = C(0xd9b25e);
  // cylinder lying along X, radius 0.75, length 1.4
  const seg = 8;
  const r = 0.75;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const y0 = r + Math.sin(a0) * r, z0 = Math.cos(a0) * r;
    const y1 = r + Math.sin(a1) * r, z1 = Math.cos(a1) * r;
    g.quadV(v(0.7, y0, z0), v(0.7, y1, z1), v(-0.7, y1, z1), v(-0.7, y0, z0), straw, (i % 2) * 0.05);
    g.triV(v(0.7, r, 0), v(0.7, y1, z1), v(0.7, y0, z0), end);
    g.triV(v(-0.7, r, 0), v(-0.7, y0, z0), v(-0.7, y1, z1), end);
  }
  return g.build();
}

// ─────────────────────────────── infrastructure ───────────────────────────────

export function turbineGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const white = C(0xf4f6f8);
  g.frustum(8, 0, 2.1, 60, 1.1, white, null);
  g.box(-1.3, 59.5, -2.6, 1.3, 62.6, 4.4, white);
  g.box(-2.2, 0, -2.2, 2.2, 0.6, 2.2, C(0xc9c6c2));
  return g.build();
}

export function rotorGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const white = C(0xf7f8fa);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // hub (pointing +Z)
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    g.triV(v(Math.cos(a0) * 1.0, Math.sin(a0) * 1.0, 0), v(Math.cos(a1) * 1.0, Math.sin(a1) * 1.0, 0), v(0, 0, 2.2), white);
  }
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    const px = -dy, py = dx; // blade width direction
    const p0 = v(dx * 0.8 + px * 0.9, dy * 0.8 + py * 0.9, 0.3);
    const p1 = v(dx * 0.8 - px * 0.5, dy * 0.8 - py * 0.5, 0.3);
    const p2 = v(dx * 30 - px * 0.15, dy * 30 - py * 0.15, 0.1);
    const p3 = v(dx * 30 + px * 0.35, dy * 30 + py * 0.35, 0.1);
    g.quadV(p0, p1, p2, p3, white);
    g.quadV(p3, p2, p1, p0, C(0xe4e7ea));
  }
  return g.build();
}

export function pylonGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const steel = C(0x9aa0a8);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // tapered square body (open lattice suggested by darker diagonals)
  const lv = [[2.6, 0], [1.2, 18], [0.8, 30]];
  for (let s = 0; s < lv.length - 1; s++) {
    const [r0, y0] = lv[s];
    const [r1, y1] = lv[s + 1];
    const c0 = [v(-r0, y0, -r0), v(r0, y0, -r0), v(r0, y0, r0), v(-r0, y0, r0)];
    const c1 = [v(-r1, y1, -r1), v(r1, y1, -r1), v(r1, y1, r1), v(-r1, y1, r1)];
    for (let i = 0; i < 4; i++) {
      const k = (i + 1) % 4;
      // thin legs: a narrow quad per corner instead of solid faces
      const w = 0.28;
      const a = c0[i], b = c1[i];
      const na = a.clone().add(c0[k].clone().sub(a).normalize().multiplyScalar(w));
      const nb = b.clone().add(c1[k].clone().sub(b).normalize().multiplyScalar(w));
      g.quadV(a, b, nb, na, steel);
      g.quadV(na, nb, b, a, steel, -0.2);
      // diagonal brace
      const d0 = b.clone();
      const d1 = c1[k].clone();
      const brace = C(0x80868e);
      const a2 = a.clone().add(v(0, 0.5, 0));
      const k2 = c0[k].clone().add(v(0, 0.5, 0));
      g.triV(a, d1, a2, brace);
      g.triV(a, a2, d1, brace);
      g.triV(c0[k], d0, k2, brace);
      g.triV(c0[k], k2, d0, brace);
    }
  }
  // cross arms (along X — the line runs along Z after the instance yaw)
  g.box(-6.2, 26.5, -0.25, 6.2, 27.2, 0.25, steel, { bottom: true });
  g.box(-4.2, 22.0, -0.22, 4.2, 22.6, 0.22, steel, { bottom: true });
  // insulators
  for (const x of [-5.6, 0, 5.6]) g.box(x - 0.12, 25.6, -0.12, x + 0.12, 26.5, 0.12, C(0x6c7a8a));
  return g.build();
}

/** Unit cable span: local x ∈ [0,1] along the chord, sag baked in metres, 3 wires at z = -5.6, 0, 5.6. */
export function cableGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const col = C(0x3a3d44);
  const seg = 10;
  const sag = 7;
  const t = 0.09;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (const wz of [-5.6, 0, 5.6]) {
    const yo = wz === 0 ? -0.9 : 0;
    for (let i = 0; i < seg; i++) {
      const a = i / seg;
      const b = (i + 1) / seg;
      const ya = yo - sag * 4 * a * (1 - a);
      const yb = yo - sag * 4 * b * (1 - b);
      // vertical ribbon (both sides) + horizontal ribbon (both sides)
      g.quadV(v(a, ya - t, wz), v(b, yb - t, wz), v(b, yb + t, wz), v(a, ya + t, wz), col);
      g.quadV(v(a, ya + t, wz), v(b, yb + t, wz), v(b, yb - t, wz), v(a, ya - t, wz), col);
      g.quadV(v(a, ya, wz - t), v(a, ya, wz + t), v(b, yb, wz + t), v(b, yb, wz - t), col);
      g.quadV(v(a, ya, wz + t), v(a, ya, wz - t), v(b, yb, wz - t), v(b, yb, wz + t), col);
    }
  }
  return g.build();
}

/** Unit fence segment: local x ∈ [0,1] along the chord (≈4 m), post at x=0, two rails. */
export function fenceGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const wood = C(0xb48a62);
  const dark = C(0x8f6a49);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // post (in local x units the post width must be tiny: 0.12 m of a 4 m chord = 0.03)
  const pw = 0.03;
  const pz = 0.07;
  g.box(-pw / 2, -0.2, -pz, pw / 2, 1.25, pz, dark);
  for (const y of [0.5, 0.95]) {
    const h = 0.11;
    g.quadV(v(0, y, 0.05), v(1, y, 0.05), v(1, y + h, 0.05), v(0, y + h, 0.05), wood);
    g.quadV(v(0, y + h, -0.05), v(1, y + h, -0.05), v(1, y, -0.05), v(0, y, -0.05), wood, -0.1);
    g.quadV(v(0, y + h, 0.05), v(1, y + h, 0.05), v(1, y + h, -0.05), v(0, y + h, -0.05), wood, 0.05);
  }
  return g.build();
}

export function palmGeometry(): THREE.BufferGeometry {
  const g = new Geo();
  const rng = new Rng(555);
  const trunk = C(0xa98a66);
  const frond = C(0x5aa25c);
  const frondDark = C(0x3f7f48);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // gently curved segmented trunk
  const segs = 5;
  const H = 8.5;
  let prev: THREE.Vector3[] = [];
  const top = v(0, 0, 0);
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const cx = Math.pow(t, 2) * 1.6;
    const y = t * H;
    const r = 0.32 - 0.1 * t;
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ring.push(v(cx + Math.cos(a) * r, y, Math.sin(a) * r));
    }
    if (s > 0) for (let i = 0; i < 5; i++) {
      const k = (i + 1) % 5;
      g.quadV(prev[i], ring[i], ring[k], prev[k], trunk, (s % 2) * 0.06 - 0.03);
    }
    prev = ring;
    top.set(cx, y, 0);
  }
  // fronds: drooping two-segment strips
  for (let f = 0; f < 7; f++) {
    const a = (f / 7) * Math.PI * 2 + rng.next() * 0.3;
    const dx = Math.cos(a), dz = Math.sin(a);
    const px = -dz * 0.55, pz = dx * 0.55;
    const L = 3.6 + rng.next() * 0.8;
    const p0 = top.clone();
    const p1 = v(top.x + dx * L * 0.55, top.y + 0.7, top.z + dz * L * 0.55);
    const p2 = v(top.x + dx * L, top.y - 1.3, top.z + dz * L);
    const w1 = v(px, 0, pz);
    g.triV(p0, p1.clone().add(w1), p1.clone().sub(w1), frond);
    g.triV(p0, p1.clone().sub(w1), p1.clone().add(w1), frondDark);
    g.triV(p1.clone().add(w1), p2, p1.clone().sub(w1), frond, -0.05);
    g.triV(p1.clone().sub(w1), p2, p1.clone().add(w1), frondDark);
  }
  return g.build();
}
