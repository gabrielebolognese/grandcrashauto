import * as THREE from 'three';

/**
 * Non-indexed flat-shaded triangle accumulator (low-poly look: one normal + one colour per face).
 * Positions are given in ABSOLUTE coordinates and stored relative to `anchor` (float precision), so the mesh is
 * placed at (anchor − origin offset).
 */
export class GeoBuf {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] | null;
  constructor(readonly ax: number, readonly ay: number, readonly az: number, withUv = false) {
    this.uv = withUv ? [] : null;
  }

  get triCount(): number {
    return this.pos.length / 9;
  }

  /** Triangle (CCW seen from the front). */
  tri(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, r: number, g: number, b: number): void {
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return;
    nx /= l;
    ny /= l;
    nz /= l;
    const P = this.pos, N = this.nor, C = this.col;
    P.push(x0 - this.ax, y0 - this.ay, z0 - this.az, x1 - this.ax, y1 - this.ay, z1 - this.az, x2 - this.ax, y2 - this.ay, z2 - this.az);
    N.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    C.push(r, g, b, r, g, b, r, g, b);
  }

  /** Quad p0..p3 CCW seen from the front (two triangles 012, 023). `p` = flat [x0,y0,z0, …, x3,y3,z3]. */
  quad(p: ArrayLike<number>, c: ArrayLike<number>): void {
    this.tri(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], c[0], c[1], c[2]);
    this.tri(p[0], p[1], p[2], p[6], p[7], p[8], p[9], p[10], p[11], c[0], c[1], c[2]);
  }

  /** Textured quad (sign panels): uv rect [u0,v0,u1,v1] mapped p0=(u0,v0) p1=(u1,v0) p2=(u1,v1) p3=(u0,v1). */
  quadUV(p: ArrayLike<number>, uvr: ArrayLike<number>): void {
    const before = this.pos.length;
    this.quad(p, [1, 1, 1]);
    if (!this.uv || this.pos.length === before) return;
    const [u0, v0, u1, v1] = [uvr[0], uvr[1], uvr[2], uvr[3]];
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  }

  /**
   * Oriented box. Frame: f = forward (fx, fz) horizontal unit, up = +Y, r = (−fz, 0, fx). Centre (cx, cy, cz);
   * half sizes hr (along r), hy, hf (along f). `pitch` tilts f upward by atan(pitch) (rise per metre). skipBottom by default.
   */
  box(cx: number, cy: number, cz: number, fx: number, fz: number, hr: number, hy: number, hf: number, c: ArrayLike<number>, pitch = 0, skipBottom = true): void {
    const rx = -fz, rz = fx;
    const fy = pitch;
    const corner = (sr: number, sy: number, sf: number, out: number[], o: number) => {
      out[o] = cx + rx * hr * sr + fx * hf * sf;
      out[o + 1] = cy + hy * sy + fy * hf * sf;
      out[o + 2] = cz + rz * hr * sr + fz * hf * sf;
    };
    const q = BOX_Q;
    const face = (a: number[], b: number[], cc: number[], d: number[]) => {
      corner(a[0], a[1], a[2], q, 0);
      corner(b[0], b[1], b[2], q, 3);
      corner(cc[0], cc[1], cc[2], q, 6);
      corner(d[0], d[1], d[2], q, 9);
      this.quad(q, c);
    };
    // +r
    face([1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]);
    // −r
    face([-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]);
    // top
    face([-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]);
    // +f
    face([1, -1, 1], [-1, -1, 1], [-1, 1, 1], [1, 1, 1]);
    // −f
    face([-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]);
    if (!skipBottom) face([-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]);
  }

  toGeometry(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    else g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const BOX_Q: number[] = new Array(12).fill(0);

/** Linear-space RGB triple from an sRGB hex colour (vertex colours are linear). */
export function rgb(hex: number, mul = 1): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r * mul, c.g * mul, c.b * mul];
}
