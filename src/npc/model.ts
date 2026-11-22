import * as THREE from 'three';
import { BONE, MIRROR, PIVOTS } from './rig';

/**
 * Original low-poly pedestrian meshes, generated in code. One mesh contains every optional part (hairstyles, hats,
 * bags, skirt, phone...) tagged with a part id; the vertex shader collapses parts an instance doesn't wear.
 * Vertex attributes: position, normal, aSkin = (bone0, bone1, weight0, region), aPart (0 = always, n = flag bit n-1).
 * Regions are colour slots resolved per instance in the shader (see REGION).
 */

export const REGION = {
  skin: 0,
  top: 1,
  bottom: 2, // pelvis / shorts top (top colour when wearing a dress)
  shoes: 3,
  hair: 4,
  acc: 5, // hats, bags
  eyes: 6,
  sleeve: 7, // upper-arm sleeve: top colour unless tank top
  armLow: 8, // lower arm: top colour with long sleeves, else skin
  shorts: 9, // thigh: bottom colour unless skirt/dress
  legLow: 10, // knee..ankle: bottom colour with trousers, else skin
  skirt: 11, // skirt: bottom colour (top colour for dresses)
  dark: 12, // sunglasses, phone body
  inner: 13, // shirt visible under an open jacket
  sole: 14, // sneaker soles
  brow: 15, // eyebrows (darker hair)
  mouth: 16,
  screen: 17,
  white: 18, // eye whites
  cheek: 19,
} as const;

/** Part flag bits (aPart = bit + 1). Style bits (no geometry) start at 16. */
export const PART = {
  hairShort: 0,
  hairLong: 1,
  hairBun: 2,
  hairPony: 3,
  cap: 4,
  sunHat: 5,
  glasses: 6,
  bag: 7,
  backpack: 8,
  skirt: 9,
  phone: 10,
  jacket: 11,
  beard: 12,
  longSkirt: 13,
} as const;
export const STYLE = {
  sleeves: 16, // short sleeves (else tank top)
  longSleeves: 17,
  trousers: 18,
  skirtLegs: 19, // thighs show skin (skirt / dress)
  dress: 20,
} as const;

const TAU = Math.PI * 2;

interface Ring {
  y: number;
  rx: number;
  rz: number;
  cx?: number;
  cz?: number;
  b0: number;
  b1?: number;
  w?: number;
}

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  skin: number[] = [];
  part: number[] = [];
  idx: number[] = [];
  region = 0;
  partId = 0;

  get vcount(): number {
    return this.pos.length / 3;
  }

  vtx(x: number, y: number, z: number, b0: number, b1 = b0, w = 1): number {
    this.pos.push(x, y, z);
    this.nor.push(0, 0, 0);
    this.skin.push(b0, b1, w, this.region);
    this.part.push(this.partId);
    return this.vcount - 1;
  }

  /** Add a triangle oriented so its normal points away from the reference point. */
  triOut(a: number, b: number, c: number, rx: number, ry: number, rz: number): void {
    const P = this.pos;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const e1x = P[b * 3] - ax, e1y = P[b * 3 + 1] - ay, e1z = P[b * 3 + 2] - az;
    const e2x = P[c * 3] - ax, e2y = P[c * 3 + 1] - ay, e2z = P[c * 3 + 2] - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const cx = (ax + P[b * 3] + P[c * 3]) / 3 - rx;
    const cy = (ay + P[b * 3 + 1] + P[c * 3 + 1]) / 3 - ry;
    const cz = (az + P[b * 3 + 2] + P[c * 3 + 2]) / 3 - rz;
    if (nx * cx + ny * cy + nz * cz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /** Smooth (area-weighted) normals for vertices [v0, vcount) from triangles [i0, idx.length). */
  smooth(v0: number, i0: number): void {
    const P = this.pos, N = this.nor, I = this.idx;
    for (let i = i0; i < I.length; i += 3) {
      const a = I[i], b = I[i + 1], c = I[i + 2];
      const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
      const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        if (v < v0) continue;
        N[v * 3] += nx;
        N[v * 3 + 1] += ny;
        N[v * 3 + 2] += nz;
      }
    }
    for (let v = v0; v < this.vcount; v++) {
      const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
      N[v * 3] /= l;
      N[v * 3 + 1] /= l;
      N[v * 3 + 2] /= l;
    }
  }

  /** Apply a matrix to vertex positions [v0, vcount) (before normals are computed). */
  transform(v0: number, m: THREE.Matrix4): void {
    const v = new THREE.Vector3();
    for (let i = v0; i < this.vcount; i++) {
      v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]).applyMatrix4(m);
      this.pos[i * 3] = v.x;
      this.pos[i * 3 + 1] = v.y;
      this.pos[i * 3 + 2] = v.z;
    }
  }

  /** Duplicate vertices [v0,v1) / triangles [i0,i1) mirrored across X (left ↔ right bones, flipped winding). */
  mirror(v0: number, v1: number, i0: number, i1: number): void {
    const base = this.vcount;
    for (let v = v0; v < v1; v++) {
      this.pos.push(-this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]);
      this.nor.push(-this.nor[v * 3], this.nor[v * 3 + 1], this.nor[v * 3 + 2]);
      this.skin.push(MIRROR[this.skin[v * 4]], MIRROR[this.skin[v * 4 + 1]], this.skin[v * 4 + 2], this.skin[v * 4 + 3]);
      this.part.push(this.part[v]);
    }
    for (let i = i0; i < i1; i += 3) {
      const a = this.idx[i] - v0 + base, b = this.idx[i + 1] - v0 + base, c = this.idx[i + 2] - v0 + base;
      this.idx.push(a, c, b);
    }
  }

  // ───────────── primitives ─────────────
  /** Vertical tube through elliptic rings (bottom → top), smooth shaded, optional domed caps. */
  tube(rings: Ring[], sides: number, phase = 0, capTop: number | null = null, capBottom: number | null = null): void {
    const v0 = this.vcount, i0 = this.idx.length;
    const ids: number[][] = [];
    for (const r of rings) {
      const row: number[] = [];
      for (let k = 0; k < sides; k++) {
        const th = phase + (k / sides) * TAU;
        row.push(this.vtx((r.cx ?? 0) + r.rx * Math.sin(th), r.y, (r.cz ?? 0) + r.rz * Math.cos(th), r.b0, r.b1 ?? r.b0, r.w ?? 1));
      }
      ids.push(row);
    }
    for (let j = 0; j < rings.length - 1; j++) {
      const ra = rings[j], rb = rings[j + 1];
      const ry = (ra.y + rb.y) / 2, rcx = ((ra.cx ?? 0) + (rb.cx ?? 0)) / 2, rcz = ((ra.cz ?? 0) + (rb.cz ?? 0)) / 2;
      for (let k = 0; k < sides; k++) {
        const a = ids[j][k], b = ids[j][(k + 1) % sides], c = ids[j + 1][(k + 1) % sides], d = ids[j + 1][k];
        this.triOut(a, b, c, rcx, ry, rcz);
        this.triOut(a, c, d, rcx, ry, rcz);
      }
    }
    const cap = (r: Ring, row: number[], dome: number) => {
      const c = this.vtx(r.cx ?? 0, r.y + dome, r.cz ?? 0, r.b0, r.b1 ?? r.b0, r.w ?? 1);
      const refY = r.y - Math.sign(dome) * 0.05;
      for (let k = 0; k < sides; k++) this.triOut(row[k], row[(k + 1) % sides], c, r.cx ?? 0, refY, r.cz ?? 0);
    };
    if (capTop !== null) cap(rings[rings.length - 1], ids[ids.length - 1], capTop);
    if (capBottom !== null) cap(rings[0], ids[0], -capBottom);
    this.smooth(v0, i0);
  }

  /** Ellipsoid (lat-long), smooth. */
  ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg: number, rings: number, b0: number, b1 = b0, w = 1, deform?: (v: THREE.Vector3) => void): void {
    const v0 = this.vcount, i0 = this.idx.length;
    this.ellipsoidInner(cx, cy, cz, rx, ry, rz, seg, rings, b0, b1, w);
    if (deform) {
      const v = new THREE.Vector3();
      for (let i = v0; i < this.vcount; i++) {
        v.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
        deform(v);
        this.pos[i * 3] = v.x;
        this.pos[i * 3 + 1] = v.y;
        this.pos[i * 3 + 2] = v.z;
        this.nor[i * 3] = this.nor[i * 3 + 1] = this.nor[i * 3 + 2] = 0;
      }
    }
    this.smooth(v0, i0);
  }

  private ellipsoidInner(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg: number, rings: number, b0: number, b1: number, w: number): void {
    const top = this.vtx(cx, cy + ry, cz, b0, b1, w);
    const rows: number[][] = [];
    for (let j = 1; j < rings; j++) {
      const ph = (j / rings) * Math.PI;
      const row: number[] = [];
      for (let k = 0; k < seg; k++) {
        const th = (k / seg) * TAU;
        row.push(this.vtx(cx + rx * Math.sin(ph) * Math.sin(th), cy + ry * Math.cos(ph), cz + rz * Math.sin(ph) * Math.cos(th), b0, b1, w));
      }
      rows.push(row);
    }
    const bot = this.vtx(cx, cy - ry, cz, b0, b1, w);
    for (let k = 0; k < seg; k++) {
      const k1 = (k + 1) % seg;
      this.triOut(top, rows[0][k], rows[0][k1], cx, cy, cz);
      for (let j = 0; j < rows.length - 1; j++) {
        this.triOut(rows[j][k], rows[j][k1], rows[j + 1][k1], cx, cy, cz);
        this.triOut(rows[j][k], rows[j + 1][k1], rows[j + 1][k], cx, cy, cz);
      }
      this.triOut(bot, rows[rows.length - 1][k1], rows[rows.length - 1][k], cx, cy, cz);
    }
  }

  /**
   * Open shell over an ellipsoid: each column (longitude θ, 0 = front) runs from the top pole down to polar angle
   * phiEnd(θ) and then optionally straight down by ext(θ) metres (long hair). inward = flipped (inner side).
   */
  shell(
    cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, seg: number, rowsE: number, rowsX: number,
    phiEnd: (th: number) => number, ext: (th: number) => number, b0: number, inward = false,
    thMin = 0, thMax = TAU, scale = 1,
  ): void {
    const v0 = this.vcount, i0 = this.idx.length;
    const full = thMax - thMin >= TAU - 1e-6;
    const cols = full ? seg : seg + 1;
    const grid: number[][] = [];
    const startPole = thMin === 0 && full;
    let pole = -1;
    if (startPole) pole = this.vtx(cx, cy + ry * scale, cz, b0);
    for (let k = 0; k < cols; k++) {
      const th = thMin + ((thMax - thMin) * k) / seg;
      const pe = phiEnd(th);
      const ex = ext(th);
      const col: number[] = [];
      const j0 = startPole ? 1 : 0;
      for (let j = j0; j <= rowsE; j++) {
        const ph = startPole ? (j / rowsE) * pe : pe * 0.62 + (pe - pe * 0.62) * (j / rowsE);
        col.push(this.vtx(cx + rx * scale * Math.sin(ph) * Math.sin(th), cy + ry * scale * Math.cos(ph), cz + rz * scale * Math.sin(ph) * Math.cos(th), b0));
      }
      const yEnd = cy + ry * scale * Math.cos(pe);
      for (let j = 1; j <= rowsX; j++) {
        const f = j / rowsX;
        const taper = 1 - 0.06 * f;
        col.push(this.vtx(cx + rx * scale * Math.sin(pe) * Math.sin(th) * taper, yEnd - ex * f, cz + rz * scale * Math.sin(pe) * Math.cos(th) * taper - 0.008 * f, b0));
      }
      grid.push(col);
    }
    const rows = grid[0].length;
    const tri = (a: number, b: number, c: number) => {
      // orient relative to the shell axis at the triangle height
      const y = (this.pos[a * 3 + 1] + this.pos[b * 3 + 1] + this.pos[c * 3 + 1]) / 3;
      const ref = Math.min(cy, y);
      if (!inward) this.triOut(a, b, c, cx, ref, cz);
      else {
        this.triOut(a, b, c, cx, ref, cz);
        const n = this.idx.length;
        const t = this.idx[n - 1];
        this.idx[n - 1] = this.idx[n - 2];
        this.idx[n - 2] = t;
      }
    };
    for (let k = 0; k < (full ? cols : cols - 1); k++) {
      const k1 = (k + 1) % cols;
      if (pole >= 0) tri(pole, grid[k][0], grid[k1][0]);
      for (let j = 0; j < rows - 1; j++) {
        tri(grid[k][j], grid[k1][j], grid[k1][j + 1]);
        tri(grid[k][j], grid[k1][j + 1], grid[k][j + 1]);
      }
    }
    this.smooth(v0, i0);
  }

  /** Flat-shaded box (optionally transformed by m around its centre). */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, b0: number, b1 = b0, w = 1, m?: THREE.Matrix4): void {
    this.frustum(cx, cy, cz, hx, hz, hx, hz, hy, b0, b1, w, m);
  }

  /** Flat-shaded tapered box: bottom half-size (bx,bz), top half-size (tx,tz), half height hy. */
  frustum(cx: number, cy: number, cz: number, bx: number, bz: number, tx: number, tz: number, hy: number, b0: number, b1 = b0, w = 1, m?: THREE.Matrix4): void {
    const c = [
      [-bx, -hy, -bz], [bx, -hy, -bz], [bx, -hy, bz], [-bx, -hy, bz],
      [-tx, hy, -tz], [tx, hy, -tz], [tx, hy, tz], [-tx, hy, tz],
    ].map(([x, y, z]) => {
      const v = new THREE.Vector3(x, y, z);
      if (m) v.applyMatrix4(m);
      return v.add(new THREE.Vector3(cx, cy, cz));
    });
    const faces = [
      [0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5],
    ];
    for (const f of faces) {
      const v0 = this.vcount, i0 = this.idx.length;
      const ids = f.map((i) => this.vtx(c[i].x, c[i].y, c[i].z, b0, b1, w));
      this.triOut(ids[0], ids[1], ids[2], cx, cy, cz);
      this.triOut(ids[0], ids[2], ids[3], cx, cy, cz);
      this.smooth(v0, i0);
    }
  }

  /** Flat quad (4 corners in order) facing away from ref point. */
  quad(p: THREE.Vector3[], ref: THREE.Vector3, b0: number): void {
    const v0 = this.vcount, i0 = this.idx.length;
    const ids = p.map((v) => this.vtx(v.x, v.y, v.z, b0));
    this.triOut(ids[0], ids[1], ids[2], ref.x, ref.y, ref.z);
    this.triOut(ids[0], ids[2], ids[3], ref.x, ref.y, ref.z);
    this.smooth(v0, i0);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aSkin', new THREE.Float32BufferAttribute(this.skin, 4));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 1));
    g.setIndex(this.idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.2);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.6, -0.1, -0.6), new THREE.Vector3(0.6, 2.0, 0.6));
    return g;
  }
}

// ─────────────────────────────── head helpers ───────────────────────────────
const HEAD = { cx: 0, cy: 1.645, cz: 0.012, rx: 0.098, ry: 0.12, rz: 0.11 };
/** Point on the head ellipsoid surface in front (z > 0) at (x, y), pushed out by `off`. */
function headSurface(x: number, y: number, off: number): { p: THREE.Vector3; n: THREE.Vector3 } {
  const u = x / HEAD.rx, v = (y - HEAD.cy) / HEAD.ry;
  const z = HEAD.cz + HEAD.rz * Math.sqrt(Math.max(0, 1 - u * u - v * v));
  const n = new THREE.Vector3(x / (HEAD.rx * HEAD.rx), (y - HEAD.cy) / (HEAD.ry * HEAD.ry), (z - HEAD.cz) / (HEAD.rz * HEAD.rz)).normalize();
  const p = new THREE.Vector3(x, y, z);
  shapeHead(p);
  return { p: p.addScaledVector(n, off), n };
}
/** A small flat decal quad on the face. */
function faceDecal(B: GeoBuilder, x: number, y: number, hw: number, hh: number, tilt: number, off: number): void {
  const { p, n } = headSurface(x, y, off);
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, n).normalize();
  const u2 = new THREE.Vector3().crossVectors(n, right).normalize();
  const r = right.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(u2, Math.sin(tilt));
  const u = u2.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(right, -Math.sin(tilt));
  const pts = [
    p.clone().addScaledVector(r, -hw).addScaledVector(u, -hh),
    p.clone().addScaledVector(r, hw).addScaledVector(u, -hh),
    p.clone().addScaledVector(r, hw).addScaledVector(u, hh),
    p.clone().addScaledVector(r, -hw).addScaledVector(u, hh),
  ];
  B.quad(pts, p.clone().addScaledVector(n, -0.05), BONE.Head);
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** f = 0 at the front, 0.5 at the sides, 1 at the back. */
const backness = (th: number) => (1 - Math.cos(th)) / 2;

// Torso ring table (shared by the shirt tube and the jacket strip so they line up exactly).
const TORSO: Ring[] = [
  { y: 0.955, rx: 0.162, rz: 0.112, cz: 0.005, b0: BONE.Pelvis, b1: BONE.Spine, w: 0.65 },
  { y: 1.05, rx: 0.148, rz: 0.103, cz: 0.008, b0: BONE.Spine },
  { y: 1.2, rx: 0.16, rz: 0.108, cz: 0.01, b0: BONE.Spine, b1: BONE.Chest, w: 0.5 },
  { y: 1.32, rx: 0.172, rz: 0.118, cz: 0.012, b0: BONE.Chest },
  { y: 1.41, rx: 0.168, rz: 0.105, cz: 0, b0: BONE.Chest },
  { y: 1.465, rx: 0.12, rz: 0.082, cz: -0.005, b0: BONE.Chest },
];
/** Head shaping: narrower jaw / chin, fuller back of the skull (applied to the head ellipsoid). */
function shapeHead(v: THREE.Vector3): void {
  const t = (HEAD.cy - v.y) / HEAD.ry; // 0 at the centre line, 1 at the chin
  if (t > 0) {
    v.x = HEAD.cx + (v.x - HEAD.cx) * (1 - 0.2 * t * t);
    const dz = v.z - HEAD.cz;
    v.z = HEAD.cz + dz * (dz > 0 ? 1 - 0.04 * t : 1 - 0.3 * t);
  } else if (v.z < HEAD.cz) {
    v.z = HEAD.cz + (v.z - HEAD.cz) * (1 + 0.06 * -t);
  }
}

// ─────────────────────────────── LOD0 / LOD1 (smooth, 2-bone skinned) ───────────────────────────────
/** hero = detailed close-up mesh (~2.5k tris incl. optional parts), mid = ~1.2k tris. */
export const buildHero = () => buildBody(true);
export const buildMid = () => buildBody(false);
export const buildFar = () => buildLod1();

function buildBody(hd: boolean): THREE.BufferGeometry {
  const B = new GeoBuilder();
  const R = REGION;
  const TORSO_SIDES = hd ? 14 : 10;
  const TORSO_PHASE = Math.PI / TORSO_SIDES; // flat facet facing front
  const ARM = hd ? 9 : 7, HAND = hd ? 8 : 6, LEG = hd ? 10 : 8, SHOE = hd ? 10 : 8;
  const HS = hd ? 14 : 10, HR = hd ? 6 : 4; // hair shell segments / rows

  // Head, neck, face
  B.region = R.skin;
  B.ellipsoid(HEAD.cx, HEAD.cy, HEAD.cz, HEAD.rx, HEAD.ry, HEAD.rz, hd ? 16 : 10, hd ? 12 : 8, BONE.Head, BONE.Head, 1, shapeHead);
  B.tube([
    { y: 1.44, rx: 0.047, rz: 0.045, cz: -0.004, b0: BONE.Head, b1: BONE.Chest, w: 0.4 },
    { y: 1.565, rx: 0.045, rz: 0.044, cz: 0, b0: BONE.Head },
  ], hd ? 8 : 6);
  // ears
  if (hd) {
    B.ellipsoid(0.097, 1.638, 0.0, 0.013, 0.027, 0.018, 6, 4, BONE.Head);
    B.ellipsoid(-0.097, 1.638, 0.0, 0.013, 0.027, 0.018, 6, 4, BONE.Head);
  } else {
    B.box(0.097, 1.638, 0.0, 0.012, 0.024, 0.016, BONE.Head);
    B.box(-0.097, 1.638, 0.0, 0.012, 0.024, 0.016, BONE.Head);
  }
  // nose (small pyramid)
  {
    const { p, n } = headSurface(0, 1.628, -0.004);
    const tip = p.clone().addScaledVector(n, 0.024).add(new THREE.Vector3(0, -0.006, 0));
    const corners = [
      p.clone().add(new THREE.Vector3(-0.012, -0.012, 0)), p.clone().add(new THREE.Vector3(0.012, -0.012, 0)),
      p.clone().add(new THREE.Vector3(0.008, 0.016, -0.004)), p.clone().add(new THREE.Vector3(-0.008, 0.016, -0.004)),
    ];
    const ref = p.clone().addScaledVector(n, -0.03);
    for (let i = 0; i < 4; i++) {
      const v0 = B.vcount, i0 = B.idx.length;
      const a = B.vtx(corners[i].x, corners[i].y, corners[i].z, BONE.Head);
      const b = B.vtx(corners[(i + 1) % 4].x, corners[(i + 1) % 4].y, corners[(i + 1) % 4].z, BONE.Head);
      const c = B.vtx(tip.x, tip.y, tip.z, BONE.Head);
      B.triOut(a, b, c, ref.x, ref.y, ref.z);
      B.smooth(v0, i0);
    }
  }
  if (hd) {
    // eye whites behind the pupils
    B.region = R.white;
    faceDecal(B, 0.037, 1.655, 0.017, 0.012, 0, 0.0012);
    faceDecal(B, -0.037, 1.655, 0.017, 0.012, 0, 0.0012);
  }
  B.region = R.eyes;
  faceDecal(B, hd ? 0.035 : 0.037, 1.655, hd ? 0.0085 : 0.011, hd ? 0.0115 : 0.016, 0, hd ? 0.0026 : 0.0015);
  faceDecal(B, hd ? -0.035 : -0.037, 1.655, hd ? 0.0085 : 0.011, hd ? 0.0115 : 0.016, 0, hd ? 0.0026 : 0.0015);
  B.region = R.brow;
  faceDecal(B, 0.039, 1.689, 0.018, 0.0055, -0.12, 0.002);
  faceDecal(B, -0.039, 1.689, 0.018, 0.0055, 0.12, 0.002);
  B.region = R.mouth;
  faceDecal(B, 0, 1.589, 0.017, 0.0045, 0, 0.0015);
  if (hd) {
    // cheeks: a touch of warmth
    B.region = R.cheek;
    faceDecal(B, 0.06, 1.615, 0.014, 0.009, 0, 0.001);
    faceDecal(B, -0.06, 1.615, 0.014, 0.009, 0, 0.001);
  }

  // Torso (shirt) + pelvis (shorts/trousers top)
  B.region = R.top;
  B.tube(TORSO, TORSO_SIDES, TORSO_PHASE, 0.022, null);
  if (hd) {
    // collar ring and a slightly flared hem lip
    B.tube([
      { y: 1.445, rx: 0.06, rz: 0.058, cz: 0.0, b0: BONE.Chest },
      { y: 1.478, rx: 0.056, rz: 0.054, cz: -0.003, b0: BONE.Chest },
    ], 10, 0, null, null);
    B.tube([
      { y: 0.948, rx: 0.166, rz: 0.116, cz: 0.005, b0: BONE.Pelvis, b1: BONE.Spine, w: 0.7 },
      { y: 0.975, rx: 0.166, rz: 0.116, cz: 0.005, b0: BONE.Pelvis, b1: BONE.Spine, w: 0.6 },
    ], TORSO_SIDES, TORSO_PHASE, null, null);
  }
  B.region = R.bottom;
  B.tube([
    { y: 0.84, rx: 0.118, rz: 0.088, b0: BONE.Pelvis },
    { y: 0.925, rx: 0.157, rz: 0.106, cz: 0.002, b0: BONE.Pelvis },
    { y: 1.0, rx: 0.148, rz: 0.1, cz: 0.006, b0: BONE.Pelvis, b1: BONE.Spine, w: 0.6 },
  ], TORSO_SIDES, TORSO_PHASE, null, 0.035);

  // Left arm (mirrored to the right)
  {
    const v0 = B.vcount, i0 = B.idx.length;
    const ax = PIVOTS[BONE.UArmL][0];
    B.region = R.sleeve;
    B.tube([
      { y: 1.27, rx: 0.057, rz: 0.056, cx: ax, b0: BONE.UArmL },
      { y: 1.39, rx: 0.061, rz: 0.06, cx: ax, b0: BONE.UArmL },
      { y: 1.445, rx: 0.056, rz: 0.056, cx: ax - 0.004, b0: BONE.UArmL },
    ], ARM, 0, 0.028, null);
    B.region = R.armLow;
    B.tube([
      { y: 0.895, rx: 0.03, rz: 0.027, cx: ax, cz: 0.004, b0: BONE.LArmL },
      { y: 0.99, rx: 0.038, rz: 0.035, cx: ax, cz: 0.004, b0: BONE.LArmL },
      { y: 1.135, rx: 0.043, rz: 0.041, cx: ax, b0: BONE.UArmL, b1: BONE.LArmL, w: 0.5 },
      { y: 1.3, rx: 0.047, rz: 0.046, cx: ax, b0: BONE.UArmL },
    ], ARM);
    B.region = R.skin;
    B.tube([
      { y: 0.80, rx: 0.024, rz: 0.033, cx: ax - 0.002, cz: 0.006, b0: BONE.LArmL },
      { y: 0.848, rx: 0.025, rz: 0.04, cx: ax, cz: 0.006, b0: BONE.LArmL },
      { y: 0.9, rx: 0.026, rz: 0.03, cx: ax, cz: 0.004, b0: BONE.LArmL },
    ], HAND, 0, null, 0.026);
    // thumb
    B.box(ax - 0.022, 0.855, 0.03, 0.01, 0.022, 0.01, BONE.LArmL, BONE.LArmL, 1, new THREE.Matrix4().makeRotationZ(0.25));
    B.mirror(v0, B.vcount, i0, B.idx.length);
  }

  // Left leg (mirrored)
  {
    const v0 = B.vcount, i0 = B.idx.length;
    const lx = PIVOTS[BONE.ULegL][0];
    B.region = R.shorts;
    B.tube([
      { y: 0.62, rx: 0.079, rz: 0.08, cx: lx + 0.004, cz: 0.004, b0: BONE.ULegL },
      { y: 0.86, rx: 0.089, rz: 0.09, cx: lx + 0.004, b0: BONE.ULegL },
      { y: 0.965, rx: 0.084, rz: 0.086, cx: lx, b0: BONE.ULegL, b1: BONE.Pelvis, w: 0.6 },
    ], LEG, Math.PI / LEG, 0.02, null);
    B.region = R.legLow;
    B.tube([
      { y: 0.095, rx: 0.036, rz: 0.037, cx: lx, cz: -0.002, b0: BONE.LLegL, b1: BONE.FootL, w: 0.7 },
      { y: 0.16, rx: 0.039, rz: 0.04, cx: lx, cz: -0.004, b0: BONE.LLegL },
      { y: 0.36, rx: 0.056, rz: 0.06, cx: lx, cz: -0.012, b0: BONE.LLegL },
      { y: 0.5, rx: 0.056, rz: 0.058, cx: lx, cz: 0.006, b0: BONE.ULegL, b1: BONE.LLegL, w: 0.5 },
      { y: 0.645, rx: 0.068, rz: 0.07, cx: lx + 0.003, cz: 0.004, b0: BONE.ULegL },
    ], LEG, Math.PI / LEG);
    // shoe: tube along +Z built vertically then rotated
    B.region = R.shoes;
    {
      const sv0 = B.vcount;
      B.tube([
        { y: -0.068, rx: 0.042, rz: 0.036, cz: 0.045, b0: BONE.FootL },
        { y: 0.0, rx: 0.046, rz: 0.047, cz: 0.05, b0: BONE.FootL },
        { y: 0.09, rx: 0.048, rz: 0.035, cz: 0.04, b0: BONE.FootL },
        { y: 0.163, rx: 0.04, rz: 0.024, cz: 0.028, b0: BONE.FootL },
      ], SHOE, Math.PI / SHOE, 0.024, 0.02);
      // tube local (x, y=forward, z=up) → world (x, up, forward)
      const m = new THREE.Matrix4().set(-1, 0, 0, lx, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
      B.transform(sv0, m);
      // normals were computed before the transform: recompute
      for (let v = sv0; v < B.vcount; v++) B.nor[v * 3] = B.nor[v * 3 + 1] = B.nor[v * 3 + 2] = 0;
      recomputeRange(B, sv0);
    }
    B.region = R.sole;
    B.box(lx, 0.009, 0.05, 0.046, 0.009, 0.118, BONE.FootL);
    B.mirror(v0, B.vcount, i0, B.idx.length);
  }

  // ───────── optional parts ─────────
  const H = HEAD;
  // short hair
  B.region = R.hair;
  B.partId = PART.hairShort + 1;
  B.shell(H.cx, H.cy + 0.007, H.cz - 0.006, 0.108, 0.13, 0.12, HS, HR, 0, (th) => {
    const f = backness(th);
    return Math.PI * (f < 0.5 ? 0.34 + (0.48 - 0.34) * (f / 0.5) : 0.48 + (0.66 - 0.48) * ((f - 0.5) / 0.5));
  }, () => 0, BONE.Head);
  // long hair (outer + inner curtain)
  B.partId = PART.hairLong + 1;
  const longPhi = (th: number) => Math.PI * (0.36 + 0.14 * smoothstep(0, 0.3, backness(th)));
  const longExt = (th: number) => {
    const f = backness(th);
    return smoothstep(0.18, 0.42, f) * (0.1 + 0.14 * smoothstep(0.5, 1, f));
  };
  B.shell(H.cx, H.cy + 0.008, H.cz - 0.01, 0.112, 0.133, 0.124, HS + 2, HR, 3, longPhi, longExt, BONE.Head);
  B.shell(H.cx, H.cy + 0.008, H.cz - 0.01, 0.112, 0.133, 0.124, HS + 2, 1, 3, (th) => longPhi(th), longExt, BONE.Head, true, 0, TAU, 0.94);
  // bun
  B.partId = PART.hairBun + 1;
  B.ellipsoid(0, 1.742, -0.082, 0.052, 0.048, 0.05, hd ? 10 : 7, hd ? 7 : 5, BONE.Head);
  // ponytail
  B.partId = PART.hairPony + 1;
  B.tube([
    { y: 1.455, rx: 0.014, rz: 0.014, cz: -0.152, b0: BONE.Head },
    { y: 1.53, rx: 0.03, rz: 0.03, cz: -0.152, b0: BONE.Head },
    { y: 1.62, rx: 0.038, rz: 0.036, cz: -0.137, b0: BONE.Head },
    { y: 1.7, rx: 0.032, rz: 0.03, cz: -0.112, b0: BONE.Head },
  ], hd ? 8 : 6, 0, 0.01, 0.018);
  // beard
  B.partId = PART.beard + 1;
  B.shell(H.cx, H.cy - 0.025, H.cz + 0.002, 0.104, 0.11, 0.117, hd ? 12 : 8, hd ? 3 : 2, 0, () => Math.PI * 0.86, () => 0, BONE.Head, false, -1.75, 1.75);

  // baseball cap
  B.region = R.acc;
  B.partId = PART.cap + 1;
  B.shell(H.cx, H.cy + 0.02, H.cz - 0.004, 0.113, 0.118, 0.124, HS, 3, 0, (th) => Math.PI * (0.44 + 0.08 * backness(th)), () => 0, BONE.Head);
  {
    // brim: curved strip in front, two-sided
    const segs = hd ? 10 : 6;
    const top: THREE.Vector3[] = [];
    const out: THREE.Vector3[] = [];
    for (let k = 0; k <= segs; k++) {
      const th = -1.15 + (2.3 * k) / segs;
      const ph = Math.PI * 0.44;
      const p = new THREE.Vector3(H.cx + 0.113 * Math.sin(ph) * Math.sin(th), H.cy + 0.02 + 0.118 * Math.cos(ph), H.cz - 0.004 + 0.124 * Math.sin(ph) * Math.cos(th));
      top.push(p);
      out.push(p.clone().add(new THREE.Vector3(Math.sin(th) * 0.05, -0.014, Math.cos(th) * 0.085)));
    }
    for (const side of [1, -1]) {
      const v0 = B.vcount, i0 = B.idx.length;
      const a = top.map((p) => B.vtx(p.x, p.y + side * 0.002, p.z, BONE.Head));
      const b = out.map((p) => B.vtx(p.x, p.y + side * 0.002, p.z, BONE.Head));
      for (let k = 0; k < segs; k++) {
        const ref = new THREE.Vector3(top[k].x, top[k].y - side * 0.2, top[k].z);
        B.triOut(a[k], a[k + 1], b[k + 1], ref.x, ref.y, ref.z);
        B.triOut(a[k], b[k + 1], b[k], ref.x, ref.y, ref.z);
      }
      B.smooth(v0, i0);
    }
  }
  // sun hat: crown + wide brim
  B.partId = PART.sunHat + 1;
  B.tube([
    { y: 1.695, rx: 0.115, rz: 0.124, cz: 0.0, b0: BONE.Head },
    { y: 1.805, rx: 0.103, rz: 0.11, cz: -0.004, b0: BONE.Head },
  ], HS, 0, 0.018, null);
  {
    const segs = hd ? 18 : 12;
    for (const side of [1, -1]) {
      const v0 = B.vcount, i0 = B.idx.length;
      const inner: number[] = [], outer: number[] = [];
      for (let k = 0; k < segs; k++) {
        const th = (k / segs) * TAU;
        inner.push(B.vtx(0.11 * Math.sin(th), 1.705 + side * 0.002, -0.002 + 0.12 * Math.cos(th), BONE.Head));
        outer.push(B.vtx(0.215 * Math.sin(th), 1.682 + side * 0.002, -0.002 + 0.225 * Math.cos(th), BONE.Head));
      }
      for (let k = 0; k < segs; k++) {
        const k1 = (k + 1) % segs;
        B.triOut(inner[k], inner[k1], outer[k1], 0, 1.7 - side * 0.3, 0);
        B.triOut(inner[k], outer[k1], outer[k], 0, 1.7 - side * 0.3, 0);
      }
      B.smooth(v0, i0);
    }
  }
  // sunglasses
  B.region = R.dark;
  B.partId = PART.glasses + 1;
  for (const sx of [1, -1]) {
    const { p, n } = headSurface(sx * 0.038, 1.657, 0.012);
    const r = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).normalize();
    B.quad([
      p.clone().addScaledVector(r, -0.021).add(new THREE.Vector3(0, -0.013, 0)),
      p.clone().addScaledVector(r, 0.021).add(new THREE.Vector3(0, -0.013, 0)),
      p.clone().addScaledVector(r, 0.021).add(new THREE.Vector3(0, 0.012, 0)),
      p.clone().addScaledVector(r, -0.021).add(new THREE.Vector3(0, 0.012, 0)),
    ], p.clone().addScaledVector(n, -0.05), BONE.Head);
  }
  B.box(0, 1.664, headSurface(0, 1.664, 0.012).p.z, 0.02, 0.004, 0.003, BONE.Head);
  B.box(0.104, 1.664, 0.03, 0.003, 0.004, 0.06, BONE.Head);
  B.box(-0.104, 1.664, 0.03, 0.003, 0.004, 0.06, BONE.Head);

  // shoulder bag + strap
  B.region = R.acc;
  B.partId = PART.bag + 1;
  B.box(0.208, 0.93, 0.035, 0.026, 0.085, 0.11, BONE.Pelvis, BONE.Pelvis, 1, new THREE.Matrix4().makeRotationZ(-0.08));
  {
    const a = new THREE.Vector3(-0.14, 1.44, 0.03);
    const b = new THREE.Vector3(0.2, 1.0, 0.125);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.z = 0.133;
    const dir = b.clone().sub(a);
    const len = dir.length();
    const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    B.box(mid.x, mid.y, mid.z, 0.018, len / 2, 0.004, BONE.Chest, BONE.Spine, 0.7, m);
  }
  // backpack + straps
  B.partId = PART.backpack + 1;
  B.box(0, 1.235, -0.158, 0.125, 0.165, 0.06, BONE.Chest);
  B.box(0, 1.39, -0.13, 0.1, 0.02, 0.04, BONE.Chest);
  for (const sx of [1, -1]) {
    const m = new THREE.Matrix4().makeRotationX(0.32);
    B.box(sx * 0.085, 1.3, 0.11, 0.016, 0.15, 0.004, BONE.Chest, BONE.Chest, 1, m);
  }

  // skirt (short) and long skirt / dress
  B.region = R.skirt;
  const skirtRings = (hemY: number, hemRx: number, hemRz: number, mid: { y: number; rx: number; rz: number }[]) => {
    const sides = hd ? 14 : 10;
    const v0 = B.vcount, i0 = B.idx.length;
    const ringsY = [{ y: 1.0, rx: 0.158, rz: 0.11 }, ...mid, { y: hemY, rx: hemRx, rz: hemRz }];
    const ids: number[][] = [];
    for (let j = 0; j < ringsY.length; j++) {
      const r = ringsY[j];
      const legW = j === 0 ? 0 : (j / (ringsY.length - 1)) * 0.75;
      const row: number[] = [];
      for (let k = 0; k < sides; k++) {
        const th = Math.PI / sides + (k / sides) * TAU;
        const x = r.rx * Math.sin(th), z = 0.005 + r.rz * Math.cos(th);
        const front = Math.max(0, Math.cos(th));
        const wl = legW * (0.3 + 0.7 * front);
        const leg = x >= 0 ? BONE.ULegL : BONE.ULegR;
        row.push(B.vtx(x, r.y, z, BONE.Pelvis, leg, 1 - wl));
      }
      ids.push(row);
    }
    for (let j = 0; j < ids.length - 1; j++) {
      const y = (ringsY[j].y + ringsY[j + 1].y) / 2;
      for (let k = 0; k < sides; k++) {
        const k1 = (k + 1) % sides;
        B.triOut(ids[j][k], ids[j][k1], ids[j + 1][k1], 0, y, 0.005);
        B.triOut(ids[j][k], ids[j + 1][k1], ids[j + 1][k], 0, y, 0.005);
      }
    }
    B.smooth(v0, i0);
  };
  B.partId = PART.skirt + 1;
  skirtRings(0.66, 0.205, 0.175, [{ y: 0.87, rx: 0.178, rz: 0.13 }]);
  B.partId = PART.longSkirt + 1;
  skirtRings(0.4, 0.215, 0.2, [{ y: 0.87, rx: 0.178, rz: 0.132 }, { y: 0.64, rx: 0.2, rz: 0.17 }]);

  // phone (right hand; screen faces +Z in the rest pose → faces up when the forearm is raised)
  B.region = R.dark;
  B.partId = PART.phone + 1;
  const phx = -PIVOTS[BONE.UArmL][0] + 0.004;
  B.box(phx, 0.8, 0.044, 0.031, 0.064, 0.0055, BONE.LArmR);
  B.region = R.screen;
  B.quad([
    new THREE.Vector3(phx - 0.026, 0.745, 0.0502), new THREE.Vector3(phx + 0.026, 0.745, 0.0502),
    new THREE.Vector3(phx + 0.026, 0.855, 0.0502), new THREE.Vector3(phx - 0.026, 0.855, 0.0502),
  ], new THREE.Vector3(phx, 0.8, 0), BONE.LArmR);

  // open jacket: inner shirt strip hugging the torso's front facet
  B.region = R.inner;
  B.partId = PART.jacket + 1;
  {
    const v0 = B.vcount, i0 = B.idx.length;
    const rows: number[][] = [];
    const use = TORSO.slice(0, 5);
    // follow the faceted torso across the front facets: polygon vertices at ±k·π/sides (odd k)
    const span = hd ? 3 : 1;
    const angles: number[] = [];
    for (let k = -span; k <= span; k += 2) angles.push((k * Math.PI) / TORSO_SIDES);
    for (const r of use) {
      const row: number[] = [];
      for (const th of angles) {
        const x = r.rx * Math.sin(th) * (Math.abs(th) > 0 ? 0.97 : 1), z = (r.cz ?? 0) + r.rz * Math.cos(th);
        const nl = Math.hypot(x / (r.rx * r.rx), (z - (r.cz ?? 0)) / (r.rz * r.rz));
        const nx = x / (r.rx * r.rx) / nl, nz = (z - (r.cz ?? 0)) / (r.rz * r.rz) / nl;
        row.push(B.vtx(x + nx * 0.0035, r.y + 0.004, z + nz * 0.0035, r.b0, r.b1 ?? r.b0, r.w ?? 1));
      }
      rows.push(row);
    }
    for (let j = 0; j < rows.length - 1; j++) {
      for (let c = 0; c < angles.length - 1; c++) {
        B.triOut(rows[j][c], rows[j][c + 1], rows[j + 1][c + 1], 0, use[j].y, 0);
        B.triOut(rows[j][c], rows[j + 1][c + 1], rows[j + 1][c], 0, use[j].y, 0);
      }
    }
    B.smooth(v0, i0);
  }
  B.partId = 0;
  return B.build();
}

function recomputeRange(B: GeoBuilder, v0: number): void {
  // find triangles that reference the range (they were appended after v0 began)
  let i0 = B.idx.length;
  for (let i = B.idx.length - 3; i >= 0; i -= 3) {
    if (B.idx[i] >= v0 && B.idx[i + 1] >= v0 && B.idx[i + 2] >= v0) i0 = i;
    else break;
  }
  B.smooth(v0, i0);
}

// ─────────────────────────────── LOD1 (rigid boxes) ───────────────────────────────
export function buildLod1(): THREE.BufferGeometry {
  const B = new GeoBuilder();
  const R = REGION;
  B.region = R.skin;
  B.box(0, 1.645, 0.012, 0.094, 0.116, 0.104, BONE.Head);
  B.region = R.top;
  B.frustum(0, 1.08, 0.008, 0.158, 0.11, 0.152, 0.104, 0.125, BONE.Spine);
  B.frustum(0, 1.335, 0.008, 0.155, 0.106, 0.168, 0.11, 0.13, BONE.Chest);
  B.region = R.bottom;
  B.box(0, 0.905, 0.003, 0.152, 0.07, 0.1, BONE.Pelvis);
  {
    const v0 = B.vcount, i0 = B.idx.length;
    const ax = PIVOTS[BONE.UArmL][0];
    B.region = R.sleeve;
    B.frustum(ax, 1.29, 0, 0.046, 0.045, 0.056, 0.055, 0.15, BONE.UArmL);
    B.region = R.armLow;
    B.frustum(ax, 1.015, 0.003, 0.032, 0.03, 0.042, 0.04, 0.12, BONE.LArmL);
    B.region = R.skin;
    B.box(ax, 0.85, 0.005, 0.024, 0.05, 0.034, BONE.LArmL);
    const lx = PIVOTS[BONE.ULegL][0];
    B.region = R.shorts;
    B.frustum(lx + 0.003, 0.72, 0, 0.06, 0.062, 0.085, 0.087, 0.23, BONE.ULegL);
    B.region = R.legLow;
    B.frustum(lx, 0.3, -0.004, 0.038, 0.039, 0.058, 0.06, 0.2, BONE.LLegL);
    B.region = R.shoes;
    B.box(lx, 0.04, 0.05, 0.045, 0.04, 0.115, BONE.FootL);
    B.mirror(v0, B.vcount, i0, B.idx.length);
  }
  B.region = R.hair;
  B.partId = PART.hairShort + 1;
  B.box(0, 1.722, -0.005, 0.104, 0.052, 0.116, BONE.Head);
  B.partId = PART.hairLong + 1;
  B.box(0, 1.63, -0.032, 0.108, 0.15, 0.1, BONE.Head);
  B.region = R.acc;
  B.partId = PART.cap + 1;
  B.box(0, 1.742, 0.035, 0.108, 0.04, 0.135, BONE.Head);
  B.partId = PART.sunHat + 1;
  B.box(0, 1.69, 0, 0.21, 0.012, 0.215, BONE.Head);
  B.box(0, 1.75, 0, 0.105, 0.055, 0.112, BONE.Head);
  B.partId = PART.backpack + 1;
  B.box(0, 1.235, -0.158, 0.125, 0.165, 0.06, BONE.Chest);
  B.region = R.skirt;
  B.partId = PART.skirt + 1;
  B.frustum(0, 0.83, 0.005, 0.2, 0.17, 0.158, 0.11, 0.17, BONE.Pelvis);
  B.partId = PART.longSkirt + 1;
  B.frustum(0, 0.7, 0.005, 0.212, 0.195, 0.158, 0.11, 0.3, BONE.Pelvis);
  B.partId = 0;
  return B.build();
}
