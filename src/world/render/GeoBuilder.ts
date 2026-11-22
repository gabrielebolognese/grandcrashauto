import * as THREE from 'three';

/**
 * Growable merged-geometry builder: position / normal / color / aMat (surface class for the ground shader) + index.
 * Faces are auto-wound to match the requested normal. Used for chunk ground meshes, the highway and LOD layers.
 */
export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  mat: number[] = [];
  idx: number[] = [];
  private c = new THREE.Color();

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, color: number, m: number): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.c.setHex(color); // sRGB hex → linear working space (three's colour management)
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.mat.push(m);
    return this.pos.length / 3 - 1;
  }

  /** Triangle by vertex ids, wound so its face normal agrees with (nx,ny,nz). */
  tri(a: number, b: number, c: number, nx: number, ny: number, nz: number): void {
    const P = this.pos;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /** Quad a-b-c-d (in order around the perimeter) with a flat normal. */
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, color: number, m: number): void {
    const a = this.vert(ax, ay, az, nx, ny, nz, color, m);
    const b = this.vert(bx, by, bz, nx, ny, nz, color, m);
    const c = this.vert(cx, cy, cz, nx, ny, nz, color, m);
    const d = this.vert(dx, dy, dz, nx, ny, nz, color, m);
    this.tri(a, b, c, nx, ny, nz);
    this.tri(a, c, d, nx, ny, nz);
  }

  /** Flat up-facing oriented rectangle (paint, decals). dir = unit running direction. */
  decal(cx: number, cz: number, dx: number, dz: number, hl: number, hw: number, y: number, color: number, m: number): void {
    const px = -dz * hw, pz = dx * hw; // perpendicular
    const lx = dx * hl, lz = dz * hl;
    this.quad(cx - lx - px, y, cz - lz - pz, cx + lx - px, y, cz + lz - pz, cx + lx + px, y, cz + lz + pz, cx - lx + px, y, cz - lz + pz, 0, 1, 0, color, m);
  }

  rect(minX: number, maxX: number, minZ: number, maxZ: number, y: number, color: number, m: number): void {
    this.quad(minX, y, minZ, minX, y, maxZ, maxX, y, maxZ, maxX, y, minZ, 0, 1, 0, color, m);
  }

  /** Ellipse disc or ring (inner = fraction of the radii) facing up. */
  disc(cx: number, cz: number, rx: number, rz: number, inner: number, y: number, color: number, m: number, segs = 32): void {
    if (inner <= 0) {
      const c = this.vert(cx, y, cz, 0, 1, 0, color, m);
      const first = this.vertexCount;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz, 0, 1, 0, color, m);
      }
      for (let i = 0; i < segs; i++) this.tri(c, first + i, first + ((i + 1) % segs), 0, 1, 0);
    } else {
      const first = this.vertexCount;
      for (let i = 0; i < segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        this.vert(cx + Math.cos(a) * rx, y, cz + Math.sin(a) * rz, 0, 1, 0, color, m);
        this.vert(cx + Math.cos(a) * rx * inner, y, cz + Math.sin(a) * rz * inner, 0, 1, 0, color, m);
      }
      for (let i = 0; i < segs; i++) {
        const o0 = first + i * 2, i0 = o0 + 1, o1 = first + ((i + 1) % segs) * 2, i1 = o1 + 1;
        this.tri(o0, o1, i1, 0, 1, 0);
        this.tri(o0, i1, i0, 0, 1, 0);
      }
    }
  }

  /** Flat ribbon along a polyline (x,z pairs). */
  ribbon(pts: number[], w: number, y: number, closed: boolean, color: number, m: number): void {
    const n = pts.length / 2;
    const first = this.vertexCount;
    for (let i = 0; i < n; i++) {
      const ip = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
      const inx = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      let dx = pts[inx * 2] - pts[ip * 2], dz = pts[inx * 2 + 1] - pts[ip * 2 + 1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const px = -dz * (w / 2), pz = dx * (w / 2);
      this.vert(pts[i * 2] + px, y, pts[i * 2 + 1] + pz, 0, 1, 0, color, m);
      this.vert(pts[i * 2] - px, y, pts[i * 2 + 1] - pz, 0, 1, 0, color, m);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = first + i * 2, b = a + 1, c = first + ((i + 1) % n) * 2, d = c + 1;
      this.tri(a, c, d, 0, 1, 0);
      this.tri(a, d, b, 0, 1, 0);
    }
  }

  /** Oriented box (bottom at cy). Optional wedge: top height at local -z end = h0, at +z = h. Bottom face omitted. */
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number, yaw: number, color: number, m: number, h0 = h, shade = true): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const P = (lx: number, ly: number, lz: number): [number, number, number] => [cx + lx * c + lz * s, cy + ly, cz - lx * s + lz * c];
    const N = (lx: number, ly: number, lz: number): [number, number, number] => [lx * c + lz * s, ly, -lx * s + lz * c];
    const hw = w / 2, hd = d / 2;
    const yb = h0, yf = h; // top heights back (-z) / front (+z)
    const side = (col: number) => (shade ? darken(col, 0.93) : col);
    // top
    {
      const slope = Math.atan2(yf - yb, d);
      const n = N(0, Math.cos(slope), -Math.sin(slope));
      const a = P(-hw, yb, -hd), b = P(-hw, yf, hd), cc = P(hw, yf, hd), dd = P(hw, yb, -hd);
      this.quad(...a, ...b, ...cc, ...dd, ...n, color, m);
    }
    // front (+z)
    {
      const n = N(0, 0, 1);
      if (yf > 0.001) this.quad(...P(-hw, 0, hd), ...P(hw, 0, hd), ...P(hw, yf, hd), ...P(-hw, yf, hd), ...n, side(color), m);
    }
    // back (-z)
    {
      const n = N(0, 0, -1);
      if (yb > 0.001) this.quad(...P(-hw, 0, -hd), ...P(-hw, yb, -hd), ...P(hw, yb, -hd), ...P(hw, 0, -hd), ...n, side(color), m);
    }
    // left/right (trapezoids for wedges)
    for (const sx of [-1, 1]) {
      const n = N(sx, 0, 0);
      this.quad(...P(sx * hw, 0, -hd), ...P(sx * hw, yb, -hd), ...P(sx * hw, yf, hd), ...P(sx * hw, 0, hd), ...n, side(color), m);
    }
  }

  cylinder(cx: number, cy: number, cz: number, r: number, h: number, segs: number, color: number, m: number, open = false): void {
    const first = this.vertexCount;
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      this.vert(cx + nx * r, cy, cz + nz * r, nx, 0, nz, darken(color, 0.92), m);
      this.vert(cx + nx * r, cy + h, cz + nz * r, nx, 0, nz, color, m);
    }
    for (let i = 0; i < segs; i++) {
      const a = first + i * 2, b = a + 1, c = a + 2, d = a + 3;
      const am = ((i + 0.5) / segs) * Math.PI * 2;
      this.tri(a, c, d, Math.cos(am), 0, Math.sin(am));
      this.tri(a, d, b, Math.cos(am), 0, Math.sin(am));
    }
    if (open) {
      // inner wall
      const f2 = this.vertexCount;
      const ri = r * 0.9;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const nx = -Math.cos(a), nz = -Math.sin(a);
        this.vert(cx - nx * ri, cy, cz - nz * ri, nx, 0, nz, darken(color, 0.85), m);
        this.vert(cx - nx * ri, cy + h, cz - nz * ri, nx, 0, nz, darken(color, 0.95), m);
      }
      for (let i = 0; i < segs; i++) {
        const a = f2 + i * 2, b = a + 1, c = a + 2, d = a + 3;
        const am = ((i + 0.5) / segs) * Math.PI * 2;
        this.tri(a, c, d, -Math.cos(am), 0, -Math.sin(am));
        this.tri(a, d, b, -Math.cos(am), 0, -Math.sin(am));
      }
      return;
    }
    this.disc(cx, cz, r, r, 0, cy + h, color, m, segs);
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    const n = this.pos.length / 3;
    g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Copy triangles of `src` whose centroid lies in [x0,x1)×[z0,z1) (exact chunk routing of shared geometry). */
  appendClipped(src: GeoBuilder, x0: number, x1: number, z0: number, z1: number): void {
    const remap = new Map<number, number>();
    const SP = src.pos, SI = src.idx;
    const cp = (v: number): number => {
      let r = remap.get(v);
      if (r !== undefined) return r;
      r = this.pos.length / 3;
      this.pos.push(SP[v * 3], SP[v * 3 + 1], SP[v * 3 + 2]);
      this.nrm.push(src.nrm[v * 3], src.nrm[v * 3 + 1], src.nrm[v * 3 + 2]);
      this.col.push(src.col[v * 3], src.col[v * 3 + 1], src.col[v * 3 + 2]);
      this.mat.push(src.mat[v]);
      remap.set(v, r);
      return r;
    };
    for (let i = 0; i < SI.length; i += 3) {
      const a = SI[i], b = SI[i + 1], c = SI[i + 2];
      const cx = (SP[a * 3] + SP[b * 3] + SP[c * 3]) / 3;
      const cz = (SP[a * 3 + 2] + SP[b * 3 + 2] + SP[c * 3 + 2]) / 3;
      if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue;
      this.idx.push(cp(a), cp(b), cp(c));
    }
  }

  reset(): void {
    this.pos.length = 0;
    this.nrm.length = 0;
    this.col.length = 0;
    this.mat.length = 0;
    this.idx.length = 0;
  }

  /** Raw arrays for physics trimesh. */
  positions(): Float32Array {
    return new Float32Array(this.pos);
  }
  indices(): Uint32Array {
    return new Uint32Array(this.idx);
  }
}

export function darken(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}
