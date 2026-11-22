import type { ColliderKind, SurfaceMaterial } from '../../core/Physics';
import { hash32 } from '../../core/rng';
import { CONFIG } from '../../config';
import { K_BRIDGE, K_GALLERY, K_ROAD, K_TUNNEL, laneStart, lanesAt, type EdgeRoute } from '../net/route';
import type { Kicker, MegaJump, RestStop } from '../net/features';
import { GeoBuf, rgb } from './GeoBuf';
import type { SignAtlas } from './materials';

/**
 * Builds one streamed highway chunk (samples i0..i1 of an edge route): flat-shaded vertex-coloured geometry for the
 * shared road material, emissive lamp / tunnel-light / flashing-arrow geometry, textured sign panels and collider
 * specs (road trimesh, barrier/rail/wall/pier cuboids, ramp hulls). All positions ABSOLUTE (GeoBuf stores them
 * relative to the chunk anchor). Seams: the boundary rows of adjacent chunks use the identical route samples.
 */

export interface ColTag {
  kind: ColliderKind;
  material: SurfaceMaterial;
}
export type ColliderSpec =
  | { type: 'trimesh'; verts: number[]; idx: number[]; tag: ColTag }
  | { type: 'cuboid'; c: [number, number, number]; h: [number, number, number]; fx: number; fz: number; pitch: number; tag: ColTag }
  | { type: 'hull'; pts: number[]; tag: ColTag };

export interface AmbientSpotSpec {
  x: number;
  y: number;
  z: number;
  radius: number;
  count: number;
  benches: { x: number; y: number; z: number; yaw: number }[];
}

export interface ChunkOut {
  main: GeoBuf;
  lamp: GeoBuf;
  tun: GeoBuf;
  sign: GeoBuf;
  flash: GeoBuf;
  cols: ColliderSpec[];
  ambient: AmbientSpotSpec[];
}

// ───────────────────────────── palette (linear RGB) ─────────────────────────────
const C_ASPH = rgb(0x4a4d57);
const C_SHOULDER = rgb(0x5b5d66);
const C_FORK = rgb(0x50535c);
const C_LINE = rgb(0xf1efe6);
const C_LINE_Y = rgb(0xead07a);
const C_MEDIAN = rgb(0xb9b4aa);
const C_VERGE = rgb(0xa29a86);
const C_SKIRT = rgb(0x8d8b6a);
const C_JERSEY = rgb(0xd2cdc2);
const C_JERSEY_TOP = rgb(0xe6e1d6);
const C_RAIL = rgb(0xc3cad1);
const C_RAIL_DARK = rgb(0x8e959c);
const C_POST = rgb(0x7c838a);
const C_WHITE = rgb(0xf4f4f0);
const C_BLACK = rgb(0x2a2a30);
const C_ORANGE = rgb(0xff8a3a);
const C_YELLOW = rgb(0xf6c431);
const C_PARAPET = rgb(0xefe6d2);
const C_FASCIA = rgb(0xffb38a);
const C_FASCIA_SEA = rgb(0xff8f7e);
const C_DECK_UNDER = rgb(0x9a958c);
const C_PIER = rgb(0xdcd5c6);
const C_PIER_WET = rgb(0x8f8a80);
const C_TUN_WALL = rgb(0x8a8a90);
const C_TUN_TILE = rgb(0xcfd6d8);
const C_TUN_CEIL = rgb(0x46454e);
const C_PORTAL = rgb(0xf3e6cf);
const C_PORTAL_TRIM = rgb(0xff7a6b);
const C_PORTAL_SAND = rgb(0xf3dcb2);
const C_GAL_ROOF = rgb(0xcfc8b8);
const C_STEEL = rgb(0x6f7985);
const C_SIGN_GREEN = rgb(0x2f7a59);
const C_SIGN_BLUE = rgb(0x2b5fa8);
const C_GRASS = rgb(0x7fae62);
const C_TRUNK = rgb(0x7a5a3c);
const C_LEAF = rgb(0x4f9a5a);
const C_LEAF2 = rgb(0x67b26a);
const C_MINT = rgb(0x9ee0c8);
const C_PEACH = rgb(0xffb38a);
const C_CORAL = rgb(0xff7a6b);
const C_CREAM = rgb(0xfff4e0);
const C_GLASS = rgb(0x3d5f7a);
const C_WOOD = rgb(0xb98a5a);
const KICK_COL: [number, number, number][] = [rgb(0xcfc8bb), rgb(0x7f8fa6), rgb(0xa07a52), rgb(0xc4935e)];
const KICK_SIDE: [number, number, number][] = [rgb(0xb4ad9f), rgb(0x5f6d82), rgb(0x86643f), rgb(0x9c7144)];
const KICK_MAT: SurfaceMaterial[] = ['concrete', 'metal', 'dirt', 'wood'];

const TAG_ROAD: ColTag = { kind: 'road', material: 'asphalt' };
const TAG_CONCRETE: ColTag = { kind: 'staticProp', material: 'concrete' };
const TAG_METAL: ColTag = { kind: 'staticProp', material: 'metal' };
const TAG_BUILDING: ColTag = { kind: 'building', material: 'concrete' };

/** Push quad (a,b,c,d) as two triangles with upward normals (Rapier trimesh / consistent winding). */
function upQuad(verts: number[], idx: number[], a: number, b: number, c: number, d: number): void {
  const ny = (i: number, j: number, k: number) => {
    const ux = verts[3 * j] - verts[3 * i], uz = verts[3 * j + 2] - verts[3 * i + 2];
    const vx = verts[3 * k] - verts[3 * i], vz = verts[3 * k + 2] - verts[3 * i + 2];
    return uz * vx - ux * vz;
  };
  if (ny(a, b, c) >= 0) idx.push(a, b, c);
  else idx.push(a, c, b);
  if (ny(a, c, d) >= 0) idx.push(a, c, d);
  else idx.push(a, d, c);
}

const mulc = (c: ArrayLike<number>, m: number): [number, number, number] => [c[0] * m, c[1] * m, c[2] * m];

export class ChunkBuilder {
  readonly out: ChunkOut;
  private r: EdgeRoute;
  private P = new Array(12).fill(0);
  private t3 = [0, 0, 0];
  private hw: number;
  private a0: number;
  private W: number;
  private salt: number;

  constructor(r: EdgeRoute, private i0: number, private i1: number, anchor: [number, number, number], private atlas: SignAtlas) {
    this.r = r;
    this.out = {
      main: new GeoBuf(anchor[0], anchor[1], anchor[2]),
      lamp: new GeoBuf(anchor[0], anchor[1], anchor[2]),
      tun: new GeoBuf(anchor[0], anchor[1], anchor[2]),
      sign: new GeoBuf(anchor[0], anchor[1], anchor[2], true),
      flash: new GeoBuf(anchor[0], anchor[1], anchor[2]),
      cols: [],
      ambient: [],
    };
    const C = CONFIG.highway;
    this.a0 = laneStart();
    this.hw = this.a0 + r.lanes * C.laneW + C.outerShoulder;
    this.W = this.hw + 0.4;
    this.salt = hash32(r.key.length, r.n, Math.round(r.L));
  }

  // ───────────────────────────── frame helpers ─────────────────────────────
  private sOf(i: number): number {
    return i * this.r.ds;
  }
  private a2At(i: number): number {
    return this.a0 + lanesAt(this.r, this.sOf(i)) * CONFIG.highway.laneW + CONFIG.highway.outerShoulder;
  }
  private a1At(i: number): number {
    return this.a0 + lanesAt(this.r, this.sOf(i)) * CONFIG.highway.laneW;
  }
  /** abs point at sample i, lateral l (+ right of +s), height h above the banked surface. */
  private pt(i: number, l: number, h: number, out: number[], o: number): void {
    const r = this.r;
    out[o] = r.x[i] - r.tz[i] * l;
    out[o + 1] = r.y[i] - r.bank[i] * l + h;
    out[o + 2] = r.z[i] + r.tx[i] * l;
  }
  /** abs point at station s (interpolated). */
  private ptS(s: number, l: number, h: number, out: number[], o: number): void {
    const r = this.r;
    const f = Math.max(0, Math.min(r.n, s / r.ds));
    const i = Math.min(r.n - 1, Math.floor(f));
    const u = f - i;
    let tx = r.tx[i] + (r.tx[i + 1] - r.tx[i]) * u, tz = r.tz[i] + (r.tz[i + 1] - r.tz[i]) * u;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const bank = r.bank[i] + (r.bank[i + 1] - r.bank[i]) * u;
    out[o] = r.x[i] + (r.x[i + 1] - r.x[i]) * u - tz * l;
    out[o + 1] = r.y[i] + (r.y[i + 1] - r.y[i]) * u - bank * l + h;
    out[o + 2] = r.z[i] + (r.z[i + 1] - r.z[i]) * u + tx * l;
  }
  private tanS(s: number): [number, number] {
    const r = this.r;
    const f = Math.max(0, Math.min(r.n, s / r.ds));
    const i = Math.min(r.n - 1, Math.floor(f));
    const u = f - i;
    const tx = r.tx[i] + (r.tx[i + 1] - r.tx[i]) * u, tz = r.tz[i] + (r.tz[i + 1] - r.tz[i]) * u;
    const tl = Math.hypot(tx, tz) || 1;
    return [tx / tl, tz / tl];
  }
  private gradeS(s: number): number {
    const r = this.r;
    const i = Math.max(0, Math.min(r.n - 1, Math.floor(s / r.ds)));
    return (r.y[i + 1] - r.y[i]) / r.ds;
  }
  private inFork(i: number): boolean {
    const s = this.sOf(i);
    return s < this.r.forkA || s > this.r.L - this.r.forkB;
  }
  private noMedian(i: number): boolean {
    const s = this.sOf(i);
    return this.inFork(i) || (this.r.exitA && s < 45) || (this.r.exitB && s > this.r.L - 45);
  }
  private restAt(i: number, side: number): RestStop | null {
    const s = this.sOf(i);
    for (const rs of this.r.features.rest) if (rs.side === side && s >= rs.s0 && s <= rs.s1) return rs;
    return null;
  }
  private megaAt(i: number, side: number): MegaJump | null {
    const s = this.sOf(i);
    for (const m of this.r.features.megas) if (m.side === side && s >= Math.min(m.sA, m.sEnd) && s <= Math.max(m.sA, m.sEnd)) return m;
    return null;
  }
  private jitter(i: number, k: number): number {
    return 0.96 + (hash32(this.salt, i, k) % 1000) / 12500;
  }
  /** segment collider along the road between samples (or stations) at lateral l. */
  private cuboidAlong(sa: number, sb: number, l: number, hc: number, hr: number, hy: number, tag: ColTag): void {
    const A = [0, 0, 0], B = [0, 0, 0];
    this.ptS(sa, l, hc, A, 0);
    this.ptS(sb, l, hc, B, 0);
    const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
    const hl = Math.hypot(dx, dz);
    if (hl < 0.05) return;
    this.out.cols.push({ type: 'cuboid', c: [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2], h: [hr, hy, hl / 2 + 0.06], fx: dx / hl, fz: dz / hl, pitch: dy / hl, tag });
  }

  // ───────────────────────────── build ─────────────────────────────
  build(): ChunkOut {
    const it = this.buildGen();
    while (!it.next().done) {
      /* drain */
    }
    return this.out;
  }

  /** Time-sliced build: yields between phases (the caller checks its frame budget). */
  *buildGen(): Generator<void, ChunkOut> {
    yield* this.pavement();
    yield;
    this.median();
    this.guardrails();
    yield;
    this.reflectors();
    this.bridges();
    yield;
    this.tunnels();
    this.galleries();
    this.portals();
    yield;
    this.gantries();
    this.streetlights();
    yield;
    for (const k of this.r.features.kickers) if (this.ownsStation(k.s)) this.kicker(k);
    for (const m of this.r.features.megas) if (this.ownsStation((m.sA + m.sEnd) / 2)) this.mega(m);
    yield;
    for (const rs of this.r.features.rest) if (this.ownsStation((rs.s0 + rs.s1) / 2)) this.restStop(rs);
    this.roadCollider();
    return this.out;
  }

  private ownsStation(s: number): boolean {
    const i = Math.round(s / this.r.ds);
    return i >= this.i0 && (i < this.i1 || (this.i1 === this.r.n && i <= this.i1));
  }

  // ───────────────────────────── pavement & markings ─────────────────────────────
  private *pavement(): Generator<void, void> {
    const r = this.r, C = CONFIG.highway, P = this.P, g = this.out.main;
    const K = r.lanes;
    const w = C.laneW;
    const mh = C.medianHalf;
    const cols = (i: number): { b: number[]; h: number[] } => {
      const a1 = this.a1At(i), a2 = this.a2At(i);
      const b = [mh, this.a0 - 0.1, this.a0 + 0.1];
      for (let k = 1; k < K; k++) {
        b.push(Math.min(a1 - 0.14, this.a0 + k * w - 0.075), Math.min(a1 - 0.12, this.a0 + k * w + 0.075));
      }
      b.push(a1 - 0.1, a1 + 0.1, a2, a2 + 0.7, a2 + 3.6);
      const h = b.map(() => 0);
      h[h.length - 2] = -0.12;
      h[h.length - 1] = -2.3;
      return { b, h };
    };
    for (let i = this.i0; i < this.i1; i++) {
      const A = cols(i), B = cols(i + 1);
      const s = (this.sOf(i) + this.sOf(i + 1)) / 2;
      const fork = this.inFork(i) || this.inFork(i + 1);
      const kind = r.kind[i] === r.kind[i + 1] ? r.kind[i] : Math.max(r.kind[i], r.kind[i + 1]);
      const dim = kind === K_TUNNEL ? 0.55 : kind === K_GALLERY ? 0.75 : 1;
      const jit = fork ? 1 : this.jitter(i, 0);
      const dashOn = ((s % 18) + 18) % 18 < 6;
      const nLanes = lanesAt(r, s);
      if ((i - this.i0) % 16 === 15) yield;
      // median strip
      this.pt(i, -mh, 0, P, 0);
      this.pt(i, mh, 0, P, 3);
      this.pt(i + 1, mh, 0, P, 6);
      this.pt(i + 1, -mh, 0, P, 9);
      g.quad(P, mulc(fork ? C_FORK : C_MEDIAN, dim));
      for (const side of [1, -1]) {
        const rest = this.restAt(i, side) || this.restAt(i + 1, side);
        const mega = this.megaAt(i, side) || this.megaAt(i + 1, side);
        const nq = A.b.length - 1;
        for (let q = 0; q < nq; q++) {
          // column colour
          let c: ArrayLike<number>;
          const isVerge = q === nq - 2, isSkirt = q === nq - 1;
          if (isVerge || isSkirt) {
            if (kind === K_BRIDGE || kind === K_TUNNEL || kind === K_GALLERY || rest || mega) continue;
            c = isVerge ? C_VERGE : C_SKIRT;
          } else if (fork) c = C_FORK;
          else if (q === 0 || q === nq - 3) c = C_SHOULDER;
          else if (q === 1) c = C_LINE_Y;
          else if (q === nq - 4) c = C_LINE;
          else {
            const k = q - 2; // 0 lane, 1 sep, 2 lane, …
            if (k % 2 === 1) {
              const sepIdx = (k + 1) / 2;
              c = dashOn && nLanes >= sepIdx + 0.9 ? C_LINE : C_ASPH;
            } else c = C_ASPH;
          }
          const lA0 = A.b[q] * side, lA1 = A.b[q + 1] * side, lB0 = B.b[q] * side, lB1 = B.b[q + 1] * side;
          const hA0 = A.h[q], hA1 = A.h[q + 1], hB0 = B.h[q], hB1 = B.h[q + 1];
          if (side > 0) {
            this.pt(i, lA0, hA0, P, 0);
            this.pt(i, lA1, hA1, P, 3);
            this.pt(i + 1, lB1, hB1, P, 6);
            this.pt(i + 1, lB0, hB0, P, 9);
          } else {
            this.pt(i, lA1, hA1, P, 0);
            this.pt(i, lA0, hA0, P, 3);
            this.pt(i + 1, lB0, hB0, P, 6);
            this.pt(i + 1, lB1, hB1, P, 9);
          }
          const m = c === C_ASPH || c === C_SHOULDER ? jit * dim : dim;
          g.quad(P, mulc(c, m));
        }
      }
    }
  }

  // ───────────────────────────── median barrier ─────────────────────────────
  private median(): void {
    const r = this.r, P = this.P, g = this.out.main;
    const prof: [number, number][] = [[-0.3, 0], [-0.13, 0.24], [-0.09, 0.84], [0.09, 0.84], [0.13, 0.24], [0.3, 0]];
    const cols = [C_JERSEY, C_JERSEY, C_JERSEY_TOP, C_JERSEY, C_JERSEY];
    const start = this.i0 - (this.i0 % 2);
    for (let i = start; i < this.i1; i += 2) {
      const ia = Math.max(this.i0, i), ib = Math.min(this.i1, i + 2);
      if (ib <= ia) continue;
      if (this.noMedian(ia) || this.noMedian(ib)) {
        // crash cushion where the barrier ends
        const prevOn = !this.noMedian(Math.max(0, ia - 2)) && this.noMedian(ib);
        const nextOn = this.noMedian(ia) && !this.noMedian(Math.min(r.n, ib + 2));
        if (prevOn || nextOn) {
          const at = prevOn ? ia : ib;
          this.pt(at, 0, 0.5, this.t3, 0);
          const [fx, fz] = [r.tx[at], r.tz[at]];
          g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.45, 0.5, 1.2, C_YELLOW);
          g.box(this.t3[0], this.t3[1] + 0.52, this.t3[2], fx, fz, 0.46, 0.04, 1.21, C_BLACK);
        }
        continue;
      }
      for (let q = 0; q < prof.length - 1; q++) {
        this.pt(ia, prof[q][0], prof[q][1], P, 0);
        this.pt(ia, prof[q + 1][0], prof[q + 1][1], P, 3);
        this.pt(ib, prof[q + 1][0], prof[q + 1][1], P, 6);
        this.pt(ib, prof[q][0], prof[q][1], P, 9);
        g.quad(P, cols[q]);
      }
      this.cuboidAlong(this.sOf(ia), this.sOf(ib), 0, 0.5, 0.32, 0.55, TAG_CONCRETE);
    }
  }

  // ───────────────────────────── guardrails ─────────────────────────────
  private railAllowed(i: number, side: number): boolean {
    const r = this.r;
    if (r.kind[i] !== K_ROAD) return false;
    if (this.inFork(i)) return false;
    const s = this.sOf(i);
    if ((r.exitA && s < 25) || (r.exitB && s > r.L - 25)) return false;
    if (this.restAt(i, side) || this.megaAt(i, side)) return false;
    return true;
  }

  private guardrails(): void {
    const P = this.P, g = this.out.main;
    const start = this.i0 - (this.i0 % 2);
    for (const side of [1, -1]) {
      for (let i = start; i < this.i1; i += 2) {
        const ia = Math.max(this.i0, i), ib = Math.min(this.i1, i + 2);
        if (ib <= ia || !this.railAllowed(ia, side) || !this.railAllowed(ib, side)) continue;
        const ga = this.a2At(ia) + 0.3, gb = this.a2At(ib) + 0.3;
        // rail: inner face, top, outer face (profile left→right over the top)
        const prof = side > 0 ? [[0, 0.48], [0, 0.82], [0.12, 0.82], [0.12, 0.48]] : [[-0.12, 0.48], [-0.12, 0.82], [0, 0.82], [0, 0.48]];
        const colr = side > 0 ? [C_RAIL, C_RAIL_DARK, C_RAIL_DARK] : [C_RAIL_DARK, C_RAIL_DARK, C_RAIL];
        for (let q = 0; q < 3; q++) {
          this.pt(ia, side * ga + prof[q][0], prof[q][1], P, 0);
          this.pt(ia, side * ga + prof[q + 1][0], prof[q + 1][1], P, 3);
          this.pt(ib, side * gb + prof[q + 1][0], prof[q + 1][1], P, 6);
          this.pt(ib, side * gb + prof[q][0], prof[q][1], P, 9);
          g.quad(P, colr[q]);
        }
        // post
        this.pt(ia, side * (ga + 0.2), 0.36, this.t3, 0);
        g.box(this.t3[0], this.t3[1], this.t3[2], this.r.tx[ia], this.r.tz[ia], 0.07, 0.4, 0.07, C_POST);
        this.cuboidAlong(this.sOf(ia), this.sOf(ib), side * (ga + 0.55), 0.45, 0.55, 0.75, TAG_METAL);
      }
    }
  }

  private reflectors(): void {
    const g = this.out.main;
    for (let i = this.i0; i < this.i1; i++) {
      if (i % 8 !== 0) continue;
      for (const side of [1, -1]) {
        if (!this.railAllowed(i, side)) continue;
        const l = side * (this.a2At(i) + 1.15);
        this.pt(i, l, 0.5, this.t3, 0);
        const fx = this.r.tx[i], fz = this.r.tz[i];
        g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.06, 0.5, 0.06, C_WHITE);
        g.box(this.t3[0], this.t3[1] + 0.38, this.t3[2], fx, fz, 0.065, 0.08, 0.065, C_BLACK);
        g.box(this.t3[0], this.t3[1] + 0.22, this.t3[2], fx, fz, 0.068, 0.05, 0.068, C_ORANGE);
      }
    }
  }

  // ───────────────────────────── bridges ─────────────────────────────
  private bridges(): void {
    const r = this.r, P = this.P, g = this.out.main;
    const sea = r.desc.ref.sea || r.desc.ref.coastal !== null;
    const fascia = sea ? C_FASCIA_SEA : C_FASCIA;
    for (let i = this.i0; i < this.i1; i++) {
      if (r.kind[i] !== K_BRIDGE || r.kind[i + 1] !== K_BRIDGE) continue;
      const ea = this.a2At(i), eb = this.a2At(i + 1);
      const prof = (e: number): [number, number, number[]][] => [
        [-e - 0.65, -2.2, C_DECK_UNDER as unknown as number[]],
        [-e - 0.65, 1.0, fascia as unknown as number[]],
        [-e - 0.15, 1.0, C_PARAPET as unknown as number[]],
        [-e - 0.15, 0.0, C_PARAPET as unknown as number[]],
      ];
      // left parapet + fascia (bottom → up → top → inner face)
      const pa = prof(ea), pb = prof(eb);
      for (let q = 0; q < 3; q++) {
        this.pt(i, pa[q][0], pa[q][1], P, 0);
        this.pt(i, pa[q + 1][0], pa[q + 1][1], P, 3);
        this.pt(i + 1, pb[q + 1][0], pb[q + 1][1], P, 6);
        this.pt(i + 1, pb[q][0], pb[q][1], P, 9);
        g.quad(P, pa[q + 1][2]);
      }
      // right parapet (inner face → top → fascia down)
      const ra: [number, number][] = [[ea + 0.15, 0], [ea + 0.15, 1.0], [ea + 0.65, 1.0], [ea + 0.65, -2.2]];
      const rb: [number, number][] = [[eb + 0.15, 0], [eb + 0.15, 1.0], [eb + 0.65, 1.0], [eb + 0.65, -2.2]];
      const rc = [C_PARAPET, C_PARAPET, fascia];
      for (let q = 0; q < 3; q++) {
        this.pt(i, ra[q][0], ra[q][1], P, 0);
        this.pt(i, ra[q + 1][0], ra[q + 1][1], P, 3);
        this.pt(i + 1, rb[q + 1][0], rb[q + 1][1], P, 6);
        this.pt(i + 1, rb[q][0], rb[q][1], P, 9);
        g.quad(P, rc[q]);
      }
      // the pavement stops at a2: fill a2 → a2+0.15 (parapet foot) both sides
      for (const side of [1, -1]) {
        const l0a = side * ea, l1a = side * (ea + 0.15), l0b = side * eb, l1b = side * (eb + 0.15);
        if (side > 0) {
          this.pt(i, l0a, 0, P, 0);
          this.pt(i, l1a, 0, P, 3);
          this.pt(i + 1, l1b, 0, P, 6);
          this.pt(i + 1, l0b, 0, P, 9);
        } else {
          this.pt(i, l1a, 0, P, 0);
          this.pt(i, l0a, 0, P, 3);
          this.pt(i + 1, l0b, 0, P, 6);
          this.pt(i + 1, l1b, 0, P, 9);
        }
        g.quad(P, C_SHOULDER);
      }
      // underside (faces down: right → left)
      this.pt(i, ea + 0.65, -2.2, P, 0);
      this.pt(i, -ea - 0.65, -2.2, P, 3);
      this.pt(i + 1, -eb - 0.65, -2.2, P, 6);
      this.pt(i + 1, eb + 0.65, -2.2, P, 9);
      g.quad(P, C_DECK_UNDER);
      if (i % 2 === 0) {
        const sa = this.sOf(i), sb = this.sOf(Math.min(r.n, i + 2));
        this.cuboidAlong(sa, sb, ea + 0.75, 0.5, 0.6, 0.75, TAG_CONCRETE);
        this.cuboidAlong(sa, sb, -ea - 0.75, 0.5, 0.6, 0.75, TAG_CONCRETE);
      }
      // piers every ~48 m (not right at the abutments)
      const s0 = this.sOf(i), s1 = this.sOf(i + 1);
      if (Math.floor(s1 / 48) !== Math.floor(s0 / 48)) {
        const span = r.spans.find((sp) => sp.kind === K_BRIDGE && s0 >= sp.s0 && s1 <= sp.s1 + 1);
        if (span && s0 - span.s0 > 20 && span.s1 - s1 > 20) this.pier(i);
      }
    }
    // abutments at bridge ends
    for (const sp of r.spans) {
      if (sp.kind !== K_BRIDGE) continue;
      for (const s of [sp.s0, sp.s1]) {
        const i = Math.round(s / r.ds);
        if (i < this.i0 || i > this.i1 || (i === this.i1 && i !== r.n)) continue;
        this.pt(i, 0, -2.6, this.t3, 0);
        const e = this.a2At(i);
        g.box(this.t3[0], this.t3[1] - 1.5, this.t3[2], r.tx[i], r.tz[i], e + 1.2, 2.2, 1.6, C_PIER, this.gradeS(s), false);
      }
    }
  }

  private pier(i: number): void {
    const r = this.r, g = this.out.main;
    const e = this.a2At(i);
    const top = r.y[i] - 2.2;
    const ground = Math.min(r.g[i], top - 1) - 1.5;
    const fx = r.tx[i], fz = r.tz[i];
    const x = r.x[i], z = r.z[i];
    // cap beam
    g.box(x, top - 0.7, z, fx, fz, e - 0.5, 0.7, 1.4, C_PIER);
    const hgt = top - 1.4 - ground;
    if (hgt > 1) {
      const water = r.g[i] < 0.3;
      const cy = ground + hgt / 2;
      // twin columns under the carriageways
      for (const side of [1, -1]) {
        const l = side * (e * 0.45);
        const cx = x - fz * l, cz = z + fx * l;
        g.box(cx, cy, cz, fx, fz, 1.1, hgt / 2, 1.1, C_PIER);
        if (water) g.box(cx, Math.max(ground + 1, CONFIG.world.waterLevel - 0.6), cz, fx, fz, 1.18, 1.2, 1.18, C_PIER_WET);
        this.out.cols.push({ type: 'cuboid', c: [cx, cy, cz], h: [1.1, hgt / 2, 1.1], fx, fz, pitch: 0, tag: TAG_CONCRETE });
      }
    }
  }

  // ───────────────────────────── tunnels ─────────────────────────────
  private tubeProfile(): [number, number][] {
    const W = this.W;
    // right → left over the top so the faces point INTO the tube
    return [[W, -0.1], [W, 1.1], [W, 5.2], [W * 0.72, 7.6], [W * 0.32, 8.7], [-W * 0.32, 8.7], [-W * 0.72, 7.6], [-W, 5.2], [-W, 1.1], [-W, -0.1]];
  }

  private tunnels(): void {
    const r = this.r, P = this.P, g = this.out.main, tl = this.out.tun;
    const prof = this.tubeProfile();
    const cols = [C_TUN_TILE, C_TUN_WALL, C_TUN_CEIL, C_TUN_CEIL, C_TUN_CEIL, C_TUN_CEIL, C_TUN_CEIL, C_TUN_WALL, C_TUN_TILE];
    const W = this.W;
    for (let i = this.i0; i < this.i1; i++) {
      if (r.kind[i] !== K_TUNNEL || r.kind[i + 1] !== K_TUNNEL) continue;
      for (let q = 0; q < prof.length - 1; q++) {
        this.pt(i, prof[q][0], prof[q][1], P, 0);
        this.pt(i, prof[q + 1][0], prof[q + 1][1], P, 3);
        this.pt(i + 1, prof[q + 1][0], prof[q + 1][1], P, 6);
        this.pt(i + 1, prof[q][0], prof[q][1], P, 9);
        g.quad(P, mulc(cols[q], this.jitter(i, q)));
      }
      // light strips on both walls (facing inward)
      for (const side of [1, -1]) {
        const l = side * (W - 0.05);
        if (side > 0) {
          this.pt(i, l, 4.75, P, 0);
          this.pt(i, l, 5.05, P, 3);
          this.pt(i + 1, l, 5.05, P, 6);
          this.pt(i + 1, l, 4.75, P, 9);
        } else {
          this.pt(i + 1, l, 4.75, P, 0);
          this.pt(i + 1, l, 5.05, P, 3);
          this.pt(i, l, 5.05, P, 6);
          this.pt(i, l, 4.75, P, 9);
        }
        tl.quad(P, [1, 1, 1]);
      }
      if (i % 4 === 0) {
        for (const l of [-W * 0.42, W * 0.42]) {
          this.pt(i, l, 8.05, this.t3, 0);
          tl.box(this.t3[0], this.t3[1], this.t3[2], r.tx[i], r.tz[i], 0.35, 0.08, 0.7, [1, 1, 1], 0, false);
        }
      }
      if (i % 2 === 0) {
        const sa = this.sOf(i), sb = this.sOf(Math.min(r.n, i + 2));
        this.cuboidAlong(sa, sb, W + 0.6, 3, 0.6, 3.2, TAG_CONCRETE);
        this.cuboidAlong(sa, sb, -W - 0.6, 3, 0.6, 3.2, TAG_CONCRETE);
      }
    }
  }

  private galleries(): void {
    const r = this.r, P = this.P, g = this.out.main, tl = this.out.tun;
    const W = this.W;
    for (let i = this.i0; i < this.i1; i++) {
      if (r.kind[i] !== K_GALLERY || r.kind[i + 1] !== K_GALLERY) continue;
      const sp = r.spans.find((x) => x.kind === K_GALLERY && this.sOf(i) >= x.s0 - 1 && this.sOf(i) <= x.s1 + 1);
      const open = sp ? sp.side || 1 : 1; // valley side
      const wall = -open;
      // mountain-side wall (inner face toward the road)
      const lw = wall * W;
      if (wall > 0) {
        this.pt(i + 1, lw, -0.1, P, 0);
        this.pt(i, lw, -0.1, P, 3);
        this.pt(i, lw, 7.2, P, 6);
        this.pt(i + 1, lw, 7.2, P, 9);
      } else {
        this.pt(i, lw, -0.1, P, 0);
        this.pt(i + 1, lw, -0.1, P, 3);
        this.pt(i + 1, lw, 7.2, P, 6);
        this.pt(i, lw, 7.2, P, 9);
      }
      g.quad(P, C_TUN_WALL);
      // roof: underside (faces down) and top (faces up)
      const l0 = Math.min(wall * (W + 0.6), open * (W + 1.6)), l1 = Math.max(wall * (W + 0.6), open * (W + 1.6));
      this.pt(i, l1, 7.2, P, 0);
      this.pt(i, l0, 7.2, P, 3);
      this.pt(i + 1, l0, 7.2, P, 6);
      this.pt(i + 1, l1, 7.2, P, 9);
      g.quad(P, C_TUN_CEIL);
      this.pt(i, l0, 8.1, P, 0);
      this.pt(i, l1, 8.1, P, 3);
      this.pt(i + 1, l1, 8.1, P, 6);
      this.pt(i + 1, l0, 8.1, P, 9);
      g.quad(P, C_GAL_ROOF);
      // roof edge (valley side)
      const le = open * (W + 1.6);
      if (open > 0) {
        this.pt(i, le, 7.2, P, 0);
        this.pt(i + 1, le, 7.2, P, 3);
        this.pt(i + 1, le, 8.1, P, 6);
        this.pt(i, le, 8.1, P, 9);
      } else {
        this.pt(i + 1, le, 7.2, P, 0);
        this.pt(i, le, 7.2, P, 3);
        this.pt(i, le, 8.1, P, 6);
        this.pt(i + 1, le, 8.1, P, 9);
      }
      g.quad(P, C_PORTAL_TRIM);
      // light strip on the wall
      const ll = wall * (W - 0.05);
      if (wall > 0) {
        this.pt(i, ll, 5.6, P, 0);
        this.pt(i, ll, 5.9, P, 3);
        this.pt(i + 1, ll, 5.9, P, 6);
        this.pt(i + 1, ll, 5.6, P, 9);
      } else {
        this.pt(i + 1, ll, 5.6, P, 0);
        this.pt(i + 1, ll, 5.9, P, 3);
        this.pt(i, ll, 5.9, P, 6);
        this.pt(i, ll, 5.6, P, 9);
      }
      tl.quad(P, [1, 1, 1]);
      if (i % 2 === 0) {
        // valley-side columns
        this.pt(i, open * (W + 0.9), 3.6, this.t3, 0);
        g.box(this.t3[0], this.t3[1], this.t3[2], r.tx[i], r.tz[i], 0.4, 3.6, 0.4, C_PORTAL);
        this.out.cols.push({ type: 'cuboid', c: [this.t3[0], this.t3[1], this.t3[2]], h: [0.4, 3.6, 0.4], fx: r.tx[i], fz: r.tz[i], pitch: 0, tag: TAG_CONCRETE });
        const sa = this.sOf(i), sb = this.sOf(Math.min(r.n, i + 2));
        this.cuboidAlong(sa, sb, wall * (W + 0.6), 3.4, 0.6, 3.6, TAG_CONCRETE);
      }
    }
  }

  /** Art-deco portal facades at tunnel / gallery ends. */
  private portals(): void {
    const r = this.r, g = this.out.main;
    for (let k = 0; k < r.spans.length; k++) {
      const sp = r.spans[k];
      if (sp.kind !== K_TUNNEL && sp.kind !== K_GALLERY) continue;
      for (const [s, face] of [[sp.s0, -1], [sp.s1, 1]] as [number, number][]) {
        const i = Math.round(s / r.ds);
        if (i < this.i0 || i > this.i1 || (i === this.i1 && i !== r.n)) continue;
        if (sp.kind === K_TUNNEL) this.tunnelPortal(s, face);
        else this.galleryPortal(s, face, sp.side || 1);
      }
    }
    void g;
  }

  private tunnelPortal(s: number, face: number): void {
    const g = this.out.main;
    const W = this.W;
    const [fx, fz] = this.tanS(s);
    // frame: outward = face·f; the facade occupies [s, s − face·1.6] (into the tunnel)
    const sc = s - face * 0.8;
    const block = (l0: number, l1: number, h0: number, h1: number, c: ArrayLike<number>, depth = 0.8) => {
      this.ptS(sc, (l0 + l1) / 2, (h0 + h1) / 2, this.t3, 0);
      g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, (l1 - l0) / 2, (h1 - h0) / 2, depth, c, 0, false);
    };
    block(-W - 9, -W, -3, 15, C_PORTAL);
    block(W, W + 9, -3, 15, C_PORTAL);
    block(-W, W, 9.3, 15, C_PORTAL);
    block(-W - 9.6, W + 9.6, 14.6, 15.4, C_PORTAL_SAND, 0.95);
    block(-W * 0.55, W * 0.55, 15.4, 18.2, C_PORTAL_TRIM, 0.7);
    block(-W * 0.3, W * 0.3, 18.2, 19.6, C_PORTAL, 0.6);
    // vertical coral fins on the piers
    for (const l of [-W - 6, -W - 3, W + 3, W + 6]) block(l - 0.4, l + 0.4, 2, 14.6, C_PORTAL_TRIM, 0.95);
    // spandrels between the arch and the lintel
    const arch = this.tubeProfile().slice(2, 8); // (W,5.2) … (−W,5.2)
    const P = this.P;
    for (const zf of [-face, face]) {
      const sOff = sc + zf * 0.8;
      for (let q = 0; q < arch.length - 1; q++) {
        const [la, ha] = arch[q], [lb, hb] = arch[q + 1];
        const outward = zf === face ? face : -face; // +1 → faces +f
        if (outward > 0) {
          this.ptS(sOff, la, ha, P, 0);
          this.ptS(sOff, lb, hb, P, 3);
          this.ptS(sOff, lb, 9.4, P, 6);
          this.ptS(sOff, la, 9.4, P, 9);
        } else {
          this.ptS(sOff, lb, hb, P, 0);
          this.ptS(sOff, la, ha, P, 3);
          this.ptS(sOff, la, 9.4, P, 6);
          this.ptS(sOff, lb, 9.4, P, 9);
        }
        g.quad(P, C_PORTAL);
      }
    }
    // wall caps beside the opening (between the tube walls and the piers, up to the arch spring)
  }

  private galleryPortal(s: number, face: number, open: number): void {
    const g = this.out.main;
    const W = this.W;
    const [fx, fz] = this.tanS(s);
    const sc = s - face * 0.6;
    this.ptS(sc, -open * (W + 2.5), 4.8, this.t3, 0);
    g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 2.4, 5.2, 0.6, C_PORTAL, 0, false);
    this.ptS(sc, open * 0.5, 8.6, this.t3, 0);
    g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, W + 2.4, 0.55, 0.65, C_PORTAL_TRIM, 0, false);
  }

  // ───────────────────────────── gantries & signs ─────────────────────────────
  private gantries(): void {
    const r = this.r, g = this.out.main;
    for (const gt of r.features.gantries) {
      if (!this.ownsStation(gt.s)) continue;
      const side = gt.side;
      const s = gt.s;
      const [fx, fz] = this.tanS(s);
      const i = Math.round(s / r.ds);
      const a2 = this.a2At(i), a1 = this.a1At(i);
      // posts
      for (const l of [side * 0.75, side * (a2 + 1.3)]) {
        this.ptS(s, l, 3.9, this.t3, 0);
        g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.22, 3.9, 0.22, C_STEEL);
        this.out.cols.push({ type: 'cuboid', c: [this.t3[0], this.t3[1], this.t3[2]], h: [0.25, 3.9, 0.25], fx, fz, pitch: 0, tag: TAG_METAL });
      }
      // truss beam
      const lc = side * (a2 + 1.3 + 0.75) / 2;
      this.ptS(s, lc, 7.45, this.t3, 0);
      g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, (a2 + 1.3 - 0.75) / 2 + 0.3, 0.42, 0.32, C_STEEL);
      // panels facing the approaching traffic (traffic travels side·f → panel front faces −side·f)
      const np = gt.panels.length;
      const lane0 = this.a0, lane1 = a1;
      const pw = (lane1 - lane0) / np;
      const sP = s - side * 0.45;
      for (let k = 0; k < np; k++) {
        const [name, arrow] = gt.panels[k];
        const lm0 = lane0 + k * pw + 0.25, lm1 = lane0 + (k + 1) * pw - 0.25;
        const lmid = side * (lm0 + lm1) / 2;
        const half = (lm1 - lm0) / 2;
        this.ptS(sP, lmid, 6.7, this.t3, 0);
        g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, half, 1.25, 0.08, C_SIGN_GREEN);
        // text (upper part) — textured quad just in front of the panel
        const uv = this.atlas.slot(name, 0);
        const sF = sP - side * 0.1;
        this.signQuad(sF, side, lmid, half - 0.15, 6.85, 7.75, uv);
        // arrow (lower part), white geometry
        this.arrow(sF - side * 0.01, side, lmid, 6.05, arrow, C_WHITE, this.out.main);
      }
    }
  }

  /** Textured sign quad at station s facing −side·f, centred at lateral lc, half width hw, from h0 to h1. */
  private signQuad(s: number, side: number, lc: number, hw: number, h0: number, h1: number, uv: [number, number, number, number]): void {
    const P = this.P;
    // facing −side·f: the viewer looks along +side·f; their right is side·r → left edge at lc − side·hw
    const lL = lc - side * hw, lR = lc + side * hw;
    this.ptS(s, lL, h0, P, 0);
    this.ptS(s, lR, h0, P, 3);
    this.ptS(s, lR, h1, P, 6);
    this.ptS(s, lL, h1, P, 9);
    // viewer-relative BL, BR, TR, TL → CCW as seen by the approaching driver for either side
    this.out.sign.quadUV(P, uv);
  }

  /** Arrow glyph (shaft + head) on a panel facing −side·f. dir: 0 up, ±1 diagonal (+1 = toward the viewer's right). */
  private arrow(s: number, side: number, lc: number, hc: number, dir: number, c: ArrayLike<number>, gb: GeoBuf): void {
    const ang = dir * 0.7;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    // local 2D arrow in (x right, y up) of the viewer
    const shape: [number, number][][] = [
      [[-0.09, -0.42], [0.09, -0.42], [0.09, 0.08], [-0.09, 0.08]],
      [[-0.3, 0.08], [0.3, 0.08], [0.0, 0.46], [0.0, 0.46]],
    ];
    const P = this.P;
    for (const poly of shape) {
      for (let k = 0; k < 4; k++) {
        const [x0, y0] = poly[k];
        const x = x0 * ca + y0 * sa, y = -x0 * sa + y0 * ca;
        // viewer right = side·r (lateral +side)
        this.ptS(s, lc + side * x, hc + y, P, 3 * k);
      }
      gb.quad(P, c); // viewer-relative CCW → faces the approaching driver
    }
  }

  // ───────────────────────────── streetlights ─────────────────────────────
  private streetlights(): void {
    const r = this.r, g = this.out.main, lamp = this.out.lamp;
    const f = r.features;
    for (let i = this.i0; i < this.i1; i++) {
      if (i % 8 !== 4) continue;
      const s = this.sOf(i);
      const near = (f.lightsA && s < 650) || (f.lightsB && s > r.L - 650);
      if (!near || r.kind[i] === K_TUNNEL || r.kind[i] === K_GALLERY) continue;
      const fx = r.tx[i], fz = r.tz[i];
      if (!this.noMedian(i)) {
        this.pt(i, 0, 6.3, this.t3, 0);
        g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.13, 5.5, 0.13, C_STEEL);
        for (const side of [1, -1]) {
          this.pt(i, side * 2.4, 11.6, this.t3, 0);
          g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 2.4, 0.07, 0.07, C_STEEL);
          this.pt(i, side * 4.7, 11.45, this.t3, 0);
          lamp.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.5, 0.1, 0.25, [1, 1, 1], 0, false);
        }
      } else {
        for (const side of [1, -1]) {
          const lp = side * (this.a2At(i) + 1.6);
          this.pt(i, lp, 5.6, this.t3, 0);
          g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.13, 5.6, 0.13, C_STEEL);
          this.pt(i, lp - side * 1.6, 11.2, this.t3, 0);
          g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 1.6, 0.07, 0.07, C_STEEL);
          this.pt(i, lp - side * 3.1, 11.05, this.t3, 0);
          lamp.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.5, 0.1, 0.25, [1, 1, 1], 0, false);
        }
      }
    }
  }

  // ───────────────────────────── kickers ─────────────────────────────
  private kicker(k: Kicker): void {
    const g = this.out.main, P = this.P;
    const side = k.side; // travel direction = side·(+s)
    const steps = 7;
    const col = KICK_COL[k.variant], colS = KICK_SIDE[k.variant];
    const tag: ColTag = { kind: 'road', material: KICK_MAT[k.variant] };
    const l0 = k.l - k.w / 2, l1 = k.l + k.w / 2;
    const prof = (j: number) => {
      const u = j / steps;
      return { s: k.s + side * k.len * u, y: k.h * u * u };
    };
    for (let j = 0; j < steps; j++) {
      const A = prof(j), B = prof(j + 1);
      const sa = Math.min(A.s, B.s), sb = Math.max(A.s, B.s);
      const ya = A.s < B.s ? A.y : B.y, yb = A.s < B.s ? B.y : A.y;
      // top surface (normal up): (sa,l0) (sa,l1) (sb,l1) (sb,l0)
      const stripes = j === steps - 1 ? 6 : 1;
      for (let q = 0; q < stripes; q++) {
        const la = l0 + ((l1 - l0) * q) / stripes, lb = l0 + ((l1 - l0) * (q + 1)) / stripes;
        this.ptS(sa, la, ya + 0.02, P, 0);
        this.ptS(sa, lb, ya + 0.02, P, 3);
        this.ptS(sb, lb, yb + 0.02, P, 6);
        this.ptS(sb, la, yb + 0.02, P, 9);
        g.quad(P, stripes > 1 ? (q % 2 === 0 ? C_YELLOW : C_BLACK) : col);
      }
      // sides
      this.ptS(sa, l1, 0, P, 0);
      this.ptS(sb, l1, 0, P, 3);
      this.ptS(sb, l1, yb + 0.02, P, 6);
      this.ptS(sa, l1, ya + 0.02, P, 9);
      g.quad(P, colS);
      this.ptS(sb, l0, 0, P, 0);
      this.ptS(sa, l0, 0, P, 3);
      this.ptS(sa, l0, ya + 0.02, P, 6);
      this.ptS(sb, l0, yb + 0.02, P, 9);
      g.quad(P, colS);
      // collider hull for this slice
      const pts: number[] = [];
      for (const [ss, yy] of [[sa, ya], [sb, yb]] as [number, number][]) {
        for (const ll of [l0, l1]) {
          this.ptS(ss, ll, yy + 0.02, this.t3, 0);
          pts.push(this.t3[0], this.t3[1], this.t3[2]);
          this.ptS(ss, ll, -0.35, this.t3, 0);
          pts.push(this.t3[0], this.t3[1], this.t3[2]);
        }
      }
      this.out.cols.push({ type: 'hull', pts, tag });
    }
    // lip face (vertical, facing the travel direction)
    const lip = prof(steps);
    if (side > 0) {
      this.ptS(lip.s, l1, 0, P, 0);
      this.ptS(lip.s, l0, 0, P, 3);
      this.ptS(lip.s, l0, lip.y + 0.02, P, 6);
      this.ptS(lip.s, l1, lip.y + 0.02, P, 9);
    } else {
      this.ptS(lip.s, l0, 0, P, 0);
      this.ptS(lip.s, l1, 0, P, 3);
      this.ptS(lip.s, l1, lip.y + 0.02, P, 6);
      this.ptS(lip.s, l0, lip.y + 0.02, P, 9);
    }
    g.quad(P, colS);
    // approach: painted chevrons on the lane + roadside chevron boards + flashing arrows
    for (let d = 25; d <= 200; d += 25) {
      const s = k.s - side * d;
      this.chevronPaint(s, side, k.l, C_YELLOW);
    }
    for (const d of [200, 110]) this.chevronBoard(k.s - side * d, side, k.side * (this.hw + 1.6));
    for (const d of [170, 80, 25]) this.flashArrow(k.s - side * d, side, k.side * (this.hw + 2.2));
  }

  private chevronPaint(s: number, side: number, lc: number, c: ArrayLike<number>): void {
    const P = this.P, g = this.out.main;
    // "^" pointing along travel: two bars
    for (const sgn of [1, -1]) {
      const la = lc + sgn * 0.15, lb = lc + sgn * 1.3;
      const sa = s, sb = s - side * 1.6;
      const w = 0.22;
      const pts: [number, number][] = [[sa, la], [sa + side * w, la], [sb + side * w, lb], [sb, lb]];
      for (let k = 0; k < 4; k++) this.ptS(pts[k][0], pts[k][1], 0.025, P, 3 * k);
      // ensure upward normal: compute and flip if needed
      const ux = P[3] - P[0], uz = P[5] - P[2], vx = P[6] - P[0], vz = P[8] - P[2];
      const ny = uz * vx - ux * vz;
      if (ny < 0) {
        const Q = [P[9], P[10], P[11], P[6], P[7], P[8], P[3], P[4], P[5], P[0], P[1], P[2]];
        g.quad(Q, c);
      } else g.quad(P, c);
    }
  }

  private chevronBoard(s: number, side: number, l: number): void {
    const g = this.out.main;
    const [fx, fz] = this.tanS(s);
    this.ptS(s, l, 1.1, this.t3, 0);
    g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.07, 1.1, 0.07, C_STEEL);
    this.ptS(s, l, 2.6, this.t3, 0);
    g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 1.3, 0.5, 0.05, C_YELLOW);
    for (const off of [-0.7, 0, 0.7]) this.arrowFlat(s - side * 0.07, side, l + off, 2.6, C_BLACK, g);
  }

  /** Small chevron ">" pointing toward the ramp side, facing approaching traffic. */
  private arrowFlat(s: number, side: number, lc: number, hc: number, c: ArrayLike<number>, gb: GeoBuf): void {
    this.arrow(s, side, lc, hc, 0, c, gb);
  }

  private flashArrow(s: number, side: number, l: number): void {
    const g = this.out.main;
    const [fx, fz] = this.tanS(s);
    this.ptS(s, l, 1.3, this.t3, 0);
    g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.07, 1.3, 0.07, C_STEEL);
    this.ptS(s, l, 2.95, this.t3, 0);
    g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.75, 0.55, 0.08, C_BLACK);
    this.arrow(s - side * 0.1, side, l, 2.95, 0, [1, 1, 1], this.out.flash);
  }

  // ───────────────────────────── mega jump ─────────────────────────────
  private mega(m: MegaJump): void {
    const r = this.r, g = this.out.main, P = this.P;
    const side = m.side;
    const l0 = m.laneL - m.laneW / 2, l1 = m.laneL + m.laneW / 2;
    const sLo = (a: number, b: number) => Math.min(a, b), sHi = (a: number, b: number) => Math.max(a, b);
    const lane = (sa: number, sb: number, tag: ColTag) => {
      const n = Math.max(1, Math.ceil((sb - sa) / 12));
      const verts: number[] = [], idx: number[] = [];
      for (let k = 0; k <= n; k++) {
        const s = sa + ((sb - sa) * k) / n;
        for (const ll of [Math.min(l0, side * this.hw), Math.max(l1, side * this.hw)]) {
          this.ptS(s, ll, 0, this.t3, 0);
          verts.push(this.t3[0], this.t3[1], this.t3[2]);
        }
        if (k < n) upQuad(verts, idx, 2 * k, 2 * k + 1, 2 * k + 3, 2 * k + 2);
        if (k < n) {
          const s2 = sa + ((sb - sa) * (k + 1)) / n;
          // lane surface + fill between the shoulder edge and the lane
          const la = Math.min(l0, side * this.hw), lb = Math.max(l1, side * this.hw);
          this.ptS(s, la, 0, P, 0);
          this.ptS(s, lb, 0, P, 3);
          this.ptS(s2, lb, 0, P, 6);
          this.ptS(s2, la, 0, P, 9);
          g.quad(P, mulc(C_ASPH, this.jitter(k, 7)));
          // outer skirt
          const lo = side > 0 ? l1 : l0;
          const lo2 = lo + side * 3;
          if (side > 0) {
            this.ptS(s, lo, 0, P, 0);
            this.ptS(s, lo2, -2.4, P, 3);
            this.ptS(s2, lo2, -2.4, P, 6);
            this.ptS(s2, lo, 0, P, 9);
          } else {
            this.ptS(s, lo2, -2.4, P, 0);
            this.ptS(s, lo, 0, P, 3);
            this.ptS(s2, lo, 0, P, 6);
            this.ptS(s2, lo2, -2.4, P, 9);
          }
          g.quad(P, C_SKIRT);
        }
      }
      this.out.cols.push({ type: 'trimesh', verts, idx, tag });
    };
    // approach (up to the kicker toe) and runout (from the landing ramp end)
    lane(sLo(m.sA, m.sKick), sHi(m.sA, m.sKick), TAG_ROAD);
    lane(sLo(m.sLand1, m.sEnd), sHi(m.sLand1, m.sEnd), TAG_ROAD);
    // big kicker (curved), solid sides down to the ground
    const tagK: ColTag = { kind: 'road', material: 'concrete' };
    const steps = 10;
    const kLen = Math.abs(m.sLip - m.sKick);
    for (let j = 0; j < steps; j++) {
      const ua = j / steps, ub = (j + 1) / steps;
      const sa0 = m.sKick + side * kLen * ua, sb0 = m.sKick + side * kLen * ub;
      const ya0 = m.kickH * ua * ua, yb0 = m.kickH * ub * ub;
      const sa = Math.min(sa0, sb0), sb = Math.max(sa0, sb0);
      const ya = sa0 < sb0 ? ya0 : yb0, yb = sa0 < sb0 ? yb0 : ya0;
      const stripes = j === steps - 1 ? 8 : 1;
      for (let q = 0; q < stripes; q++) {
        const la = l0 + ((l1 - l0) * q) / stripes, lb = l0 + ((l1 - l0) * (q + 1)) / stripes;
        this.ptS(sa, la, ya + 0.02, P, 0);
        this.ptS(sa, lb, ya + 0.02, P, 3);
        this.ptS(sb, lb, yb + 0.02, P, 6);
        this.ptS(sb, la, yb + 0.02, P, 9);
        g.quad(P, stripes > 1 ? (q % 2 === 0 ? C_YELLOW : C_BLACK) : j % 2 === 0 ? C_CORAL : C_PEACH);
      }
      const base = m.canyon ? -3 : -1;
      this.ptS(sa, l1, base, P, 0);
      this.ptS(sb, l1, base, P, 3);
      this.ptS(sb, l1, yb, P, 6);
      this.ptS(sa, l1, ya, P, 9);
      g.quad(P, C_CREAM);
      this.ptS(sb, l0, base, P, 0);
      this.ptS(sa, l0, base, P, 3);
      this.ptS(sa, l0, ya, P, 6);
      this.ptS(sb, l0, yb, P, 9);
      g.quad(P, C_CREAM);
      const pts: number[] = [];
      for (const [ss, yy] of [[sa, ya], [sb, yb]] as [number, number][]) {
        for (const ll of [l0, l1]) {
          this.ptS(ss, ll, yy + 0.02, this.t3, 0);
          pts.push(this.t3[0], this.t3[1], this.t3[2]);
          this.ptS(ss, ll, -0.4, this.t3, 0);
          pts.push(this.t3[0], this.t3[1], this.t3[2]);
        }
      }
      this.out.cols.push({ type: 'hull', pts, tag: tagK });
    }
    // lip face
    {
      const base = m.canyon ? -3 : -m.pitDepth - 1;
      const sl = m.sLip;
      if (side > 0) {
        this.ptS(sl, l1, base, P, 0);
        this.ptS(sl, l0, base, P, 3);
        this.ptS(sl, l0, m.kickH, P, 6);
        this.ptS(sl, l1, m.kickH, P, 9);
      } else {
        this.ptS(sl, l0, base, P, 0);
        this.ptS(sl, l1, base, P, 3);
        this.ptS(sl, l1, m.kickH, P, 6);
        this.ptS(sl, l0, m.kickH, P, 9);
      }
      g.quad(P, C_CREAM);
    }
    // landing ramp: front face toward the gap, slope down to the runout
    {
      const sF = m.sLand0, sE = m.sLand1;
      const base = m.canyon ? -3 : -m.pitDepth - 1;
      const n = 6;
      for (let j = 0; j < n; j++) {
        const ua = j / n, ub = (j + 1) / n;
        const sa0 = sF + (sE - sF) * ua, sb0 = sF + (sE - sF) * ub;
        const ya0 = m.landH * (1 - ua), yb0 = m.landH * (1 - ub);
        const sa = Math.min(sa0, sb0), sb = Math.max(sa0, sb0);
        const ya = sa0 < sb0 ? ya0 : yb0, yb = sa0 < sb0 ? yb0 : ya0;
        this.ptS(sa, l0, ya + 0.02, P, 0);
        this.ptS(sa, l1, ya + 0.02, P, 3);
        this.ptS(sb, l1, yb + 0.02, P, 6);
        this.ptS(sb, l0, yb + 0.02, P, 9);
        g.quad(P, j % 2 === 0 ? C_MINT : C_CREAM);
        this.ptS(sa, l1, base, P, 0);
        this.ptS(sb, l1, base, P, 3);
        this.ptS(sb, l1, yb, P, 6);
        this.ptS(sa, l1, ya, P, 9);
        g.quad(P, C_PORTAL);
        this.ptS(sb, l0, base, P, 0);
        this.ptS(sa, l0, base, P, 3);
        this.ptS(sa, l0, ya, P, 6);
        this.ptS(sb, l0, yb, P, 9);
        g.quad(P, C_PORTAL);
        const pts: number[] = [];
        for (const [ss, yy] of [[sa, ya], [sb, yb]] as [number, number][]) {
          for (const ll of [l0, l1]) {
            this.ptS(ss, ll, yy + 0.02, this.t3, 0);
            pts.push(this.t3[0], this.t3[1], this.t3[2]);
            this.ptS(ss, ll, base, this.t3, 0);
            pts.push(this.t3[0], this.t3[1], this.t3[2]);
          }
        }
        this.out.cols.push({ type: 'hull', pts, tag: tagK });
      }
      // front face (faces the kicker: −travel)
      if (side > 0) {
        this.ptS(sF, l0, base, P, 0);
        this.ptS(sF, l1, base, P, 3);
        this.ptS(sF, l1, m.landH, P, 6);
        this.ptS(sF, l0, m.landH, P, 9);
      } else {
        this.ptS(sF, l1, base, P, 0);
        this.ptS(sF, l0, base, P, 3);
        this.ptS(sF, l0, m.landH, P, 6);
        this.ptS(sF, l1, m.landH, P, 9);
      }
      g.quad(P, C_CORAL);
    }
    // separation barrier between the carriageway and the jump lane (kicker → landing end), lane guardrail outside
    const bl = side * (this.hw + 0.8);
    const bA = m.sKick - side * 40, bB = m.sLand1 + side * 40;
    const nB = Math.ceil(Math.abs(bB - bA) / 12);
    const prof: [number, number][] = [[-0.3, 0], [-0.13, 0.24], [-0.09, 0.84], [0.09, 0.84], [0.13, 0.24], [0.3, 0]];
    for (let k = 0; k < nB; k++) {
      const sa = sLo(bA, bB) + (Math.abs(bB - bA) * k) / nB, sb = sLo(bA, bB) + (Math.abs(bB - bA) * (k + 1)) / nB;
      for (let q = 0; q < prof.length - 1; q++) {
        this.ptS(sa, bl + prof[q][0], prof[q][1], P, 0);
        this.ptS(sa, bl + prof[q + 1][0], prof[q + 1][1], P, 3);
        this.ptS(sb, bl + prof[q + 1][0], prof[q + 1][1], P, 6);
        this.ptS(sb, bl + prof[q][0], prof[q][1], P, 9);
        g.quad(P, C_JERSEY);
      }
      this.cuboidAlong(sa, sb, bl, 0.5, 0.32, 0.55, TAG_CONCRETE);
    }
    // outer rail along approach + runout
    const gl = side > 0 ? l1 + 0.4 : l0 - 0.4;
    for (const [a, b] of [[m.sA, m.sKick], [m.sLand1, m.sEnd]] as [number, number][]) {
      const lo = sLo(a, b), hi = sHi(a, b);
      const n = Math.ceil((hi - lo) / 12);
      for (let k = 0; k < n; k++) {
        const sa = lo + ((hi - lo) * k) / n, sb = lo + ((hi - lo) * (k + 1)) / n;
        const pr = side > 0 ? [[0, 0.48], [0, 0.82], [0.12, 0.82], [0.12, 0.48]] : [[-0.12, 0.48], [-0.12, 0.82], [0, 0.82], [0, 0.48]];
        for (let q = 0; q < 3; q++) {
          this.ptS(sa, gl + pr[q][0], pr[q][1], P, 0);
          this.ptS(sa, gl + pr[q + 1][0], pr[q + 1][1], P, 3);
          this.ptS(sb, gl + pr[q + 1][0], pr[q + 1][1], P, 6);
          this.ptS(sb, gl + pr[q][0], pr[q][1], P, 9);
          g.quad(P, C_RAIL);
        }
        this.cuboidAlong(sa, sb, gl + side * 0.55, 0.45, 0.55, 0.75, TAG_METAL);
      }
    }
    // signage: MEGA JUMP banner + flashing arrows + giant chevron boards at the lip
    const sBan = m.sA + side * 30;
    {
      const [fx, fz] = this.tanS(sBan);
      for (const l of [l0 - side * 0.6, l1 + side * 0.6]) {
        this.ptS(sBan, l, 3.6, this.t3, 0);
        g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, 0.2, 3.6, 0.2, C_STEEL);
      }
      this.ptS(sBan, m.laneL, 7.1, this.t3, 0);
      g.box(this.t3[0], this.t3[1], this.t3[2], fx, fz, m.laneW / 2 + 0.8, 0.9, 0.1, C_CORAL);
      this.signQuad(sBan - side * 0.12, side, m.laneL, m.laneW / 2 + 0.5, 6.4, 7.8, this.atlas.slot('MEGA JUMP', 2));
    }
    for (const d of [220, 140, 60]) this.flashArrow(m.sKick - side * d, side, side > 0 ? l1 + 1.6 : l0 - 1.6);
    void r;
  }

  // ───────────────────────────── rest stop ─────────────────────────────
  private restStop(rs: RestStop): void {
    const r = this.r, g = this.out.main, P = this.P;
    const side = rs.side;
    const lIn = this.hw, lOut = rs.lOff + rs.w;
    const yEdge = (s: number) => {
      this.ptS(s, side * lIn, 0, this.t3, 0);
      return this.t3[1];
    };
    // pad rows (level across at the road edge height)
    const n = Math.max(2, Math.ceil((rs.s1 - rs.s0) / 12));
    const bands: [number, number, ArrayLike<number>][] = [
      [lIn, rs.lOff + 3, C_SHOULDER], [rs.lOff + 3, rs.lOff + 11, C_ASPH], [rs.lOff + 11, rs.lOff + 18, C_SHOULDER],
      [rs.lOff + 18, lOut - 9, C_ASPH], [lOut - 9, lOut, C_GRASS],
    ];
    const verts: number[] = [], idx: number[] = [];
    const flat = (s: number, l: number, h: number, out: number[], o: number) => {
      const y = yEdge(s);
      this.ptS(s, l, 0, out, o);
      out[o + 1] = y + h;
    };
    for (let k = 0; k <= n; k++) {
      const s = rs.s0 + ((rs.s1 - rs.s0) * k) / n;
      for (const ll of [side * lIn, side * lOut]) {
        flat(s, ll, 0, this.t3, 0);
        verts.push(this.t3[0], this.t3[1], this.t3[2]);
      }
      if (k < n) {
        upQuad(verts, idx, 2 * k, 2 * k + 1, 2 * k + 3, 2 * k + 2);
        const s2 = rs.s0 + ((rs.s1 - rs.s0) * (k + 1)) / n;
        for (const [a, b2, c] of bands) {
          const la = side > 0 ? a : -b2, lb = side > 0 ? b2 : -a;
          const hh = c === C_GRASS ? 0.03 : 0;
          flat(s, la, hh, P, 0);
          flat(s, lb, hh, P, 3);
          flat(s2, lb, hh, P, 6);
          flat(s2, la, hh, P, 9);
          const gore = c === C_SHOULDER && a === lIn && s > rs.s0 + 40 && s2 < rs.s1 - 40 && k % 2 === 0;
          g.quad(P, gore ? C_LINE : c);
        }
        // outer skirt
        const lo = side * lOut, lo2 = side * (lOut + 4);
        if (side > 0) {
          flat(s, lo, 0, P, 0);
          flat(s, lo2, -2.5, P, 3);
          flat(s2, lo2, -2.5, P, 6);
          flat(s2, lo, 0, P, 9);
        } else {
          flat(s, lo2, -2.5, P, 0);
          flat(s, lo, 0, P, 3);
          flat(s2, lo, 0, P, 6);
          flat(s2, lo2, -2.5, P, 9);
        }
        g.quad(P, C_SKIRT);
      }
    }
    this.out.cols.push({ type: 'trimesh', verts, idx, tag: TAG_ROAD });
    // stall lines
    for (let s = rs.s0 + 60; s <= rs.s1 - 60; s += 3.2) {
      const la = side * (rs.lOff + 11.3), lb = side * (rs.lOff + 17.6);
      const l0 = Math.min(la, lb), l1 = Math.max(la, lb);
      flat(s, l0, 0.02, P, 0);
      flat(s, l1, 0.02, P, 3);
      flat(s + 0.14, l1, 0.02, P, 6);
      flat(s + 0.14, l0, 0.02, P, 9);
      g.quad(P, C_LINE);
    }
    const mid = (rs.s0 + rs.s1) / 2;
    const [fx, fz] = this.tanS(mid);
    const yb = yEdge(mid);
    const at = (s: number, l: number, h: number) => {
      this.ptS(s, side * l, 0, this.t3, 0);
      this.t3[1] = yb + h;
      return this.t3;
    };
    // shop building
    {
      const p = at(mid - 38, lOut - 15, 2.4);
      g.box(p[0], p[1], p[2], fx, fz, 4.5, 2.4, 10, C_MINT, 0, false);
      this.out.cols.push({ type: 'cuboid', c: [p[0], p[1], p[2]], h: [4.5, 2.4, 10], fx, fz, pitch: 0, tag: TAG_BUILDING });
      const roof = at(mid - 38, lOut - 15, 5.0);
      g.box(roof[0], roof[1], roof[2], fx, fz, 5.4, 0.25, 10.8, C_CORAL);
      const win = at(mid - 38, lOut - 15 - side * 0 - 4.55, 2.2);
      const wl = side * (lOut - 19.55);
      this.ptS(mid - 38, wl, 0, this.t3, 0);
      g.box(this.t3[0], yb + 2.3, this.t3[2], fx, fz, 0.08, 1.0, 8, C_GLASS);
      void win;
    }
    // fuel canopy + pumps
    {
      const c = at(mid + 30, rs.lOff + 22, 5.6);
      g.box(c[0], c[1], c[2], fx, fz, 6.5, 0.35, 8.5, C_CREAM);
      const t = at(mid + 30, rs.lOff + 22, 5.95);
      g.box(t[0], t[1], t[2], fx, fz, 6.6, 0.12, 8.6, C_CORAL);
      for (const dl of [-4.5, 4.5])
        for (const ds of [-6.5, 6.5]) {
          const p = at(mid + 30 + ds, rs.lOff + 22 + dl, 2.75);
          g.box(p[0], p[1], p[2], fx, fz, 0.22, 2.75, 0.22, C_WHITE);
          this.out.cols.push({ type: 'cuboid', c: [p[0], p[1], p[2]], h: [0.22, 2.75, 0.22], fx, fz, pitch: 0, tag: TAG_METAL });
        }
      for (const ds of [-3, 3]) {
        const p = at(mid + 30 + ds, rs.lOff + 22, 0.8);
        g.box(p[0], p[1], p[2], fx, fz, 0.35, 0.8, 0.55, C_PEACH);
        this.out.cols.push({ type: 'cuboid', c: [p[0], p[1], p[2]], h: [0.35, 0.8, 0.55], fx, fz, pitch: 0, tag: TAG_METAL });
      }
      // canopy light panel (emissive at night)
      const lp = at(mid + 30, rs.lOff + 22, 5.22);
      this.out.lamp.box(lp[0], lp[1], lp[2], fx, fz, 4.5, 0.04, 6.5, [1, 1, 1], 0, false);
    }
    // picnic tables + trees on the grass strip
    const benches: { x: number; y: number; z: number; yaw: number }[] = [];
    const yawRoad = Math.atan2(fx, fz);
    for (let k = 0; k < 3; k++) {
      const s = rs.s0 + 50 + k * 22;
      const t = at(s, lOut - 4.5, 0.76);
      g.box(t[0], t[1], t[2], fx, fz, 0.45, 0.05, 1.0, C_WOOD);
      for (const dl of [-0.75, 0.75]) {
        const b = at(s, lOut - 4.5 + dl, 0.45);
        g.box(b[0], b[1], b[2], fx, fz, 0.16, 0.04, 1.0, C_WOOD);
        benches.push({ x: b[0], y: b[1], z: b[2], yaw: yawRoad + (dl * side > 0 ? -Math.PI / 2 : Math.PI / 2) });
      }
      const leg = at(s, lOut - 4.5, 0.36);
      g.box(leg[0], leg[1], leg[2], fx, fz, 0.06, 0.36, 0.8, C_TRUNK);
    }
    for (let k = 0; k < 6; k++) {
      const s = rs.s0 + 20 + k * ((rs.s1 - rs.s0 - 40) / 5);
      const p = at(s, lOut - 1.5 - (k % 2) * 2.5, 1.3);
      g.box(p[0], p[1], p[2], fx, fz, 0.18, 1.3, 0.18, C_TRUNK);
      this.cone(p[0], p[1] + 1.2, p[2], 1.6 + (k % 3) * 0.3, 3.6 + (k % 2), k % 2 ? C_LEAF : C_LEAF2);
    }
    // lights
    for (const ds of [-80, 0, 80]) {
      const p = at(mid + ds, rs.lOff + 14.5, 4.5);
      g.box(p[0], p[1], p[2], fx, fz, 0.1, 4.5, 0.1, C_STEEL);
      const hd = at(mid + ds, rs.lOff + 14.5, 9.0);
      this.out.lamp.box(hd[0], hd[1], hd[2], fx, fz, 0.35, 0.12, 0.35, [1, 1, 1], 0, false);
    }
    // outer guardrail + end rails
    const gr = (sa: number, sb: number, la: number, lb: number) => {
      const A = [0, 0, 0], B = [0, 0, 0];
      flat(sa, la, 0.65, A, 0);
      flat(sb, lb, 0.65, B, 0);
      const dx = B[0] - A[0], dz = B[2] - A[2], hl = Math.hypot(dx, dz);
      if (hl < 0.1) return;
      g.box((A[0] + B[0]) / 2, A[1], (A[2] + B[2]) / 2, dx / hl, dz / hl, 0.06, 0.17, hl / 2, C_RAIL);
      this.out.cols.push({ type: 'cuboid', c: [(A[0] + B[0]) / 2, A[1] - 0.2, (A[2] + B[2]) / 2], h: [0.4, 0.75, hl / 2], fx: dx / hl, fz: dz / hl, pitch: 0, tag: TAG_METAL });
    };
    const nG = Math.ceil((rs.s1 - rs.s0) / 16);
    for (let k = 0; k < nG; k++) {
      const sa = rs.s0 + ((rs.s1 - rs.s0) * k) / nG, sb = rs.s0 + ((rs.s1 - rs.s0) * (k + 1)) / nG;
      gr(sa, sb, side * (lOut + 0.4), side * (lOut + 0.4));
    }
    gr(rs.s0, rs.s0, side * (rs.lOff + 10), side * (lOut + 0.4));
    gr(rs.s1, rs.s1, side * (rs.lOff + 10), side * (lOut + 0.4));
    // advance + entrance signs (blue service sign)
    const tdir = side; // traffic travels side·(+s)
    for (const sS of [rs.s0 - tdir * 300, tdir > 0 ? rs.s0 - 10 : rs.s1 + 10]) {
      if (sS < 5 || sS > r.L - 5) continue;
      const l = side * (this.hw + 2.2);
      const [sfx, sfz] = this.tanS(sS);
      this.ptS(sS, l, 1.6, this.t3, 0);
      g.box(this.t3[0], this.t3[1], this.t3[2], sfx, sfz, 0.08, 1.6, 0.08, C_STEEL);
      this.ptS(sS, l, 3.6, this.t3, 0);
      g.box(this.t3[0], this.t3[1], this.t3[2], sfx, sfz, 1.9, 0.62, 0.06, C_SIGN_BLUE);
      this.signQuad(sS - side * 0.08, side, l, 1.75, 3.05, 4.15, this.atlas.slot('REST AREA · ' + rs.name, 1));
    }
    // NPCs at the picnic area
    const pc = at((rs.s0 + 50 + rs.s0 + 94) / 2, lOut - 6, 0);
    this.out.ambient.push({ x: pc[0], y: pc[1], z: pc[2], radius: 14, count: 4, benches });
  }

  private cone(x: number, y: number, z: number, rad: number, h: number, c: ArrayLike<number>): void {
    const g = this.out.main;
    const n = 6;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
      const x0 = x + Math.cos(a0) * rad, z0 = z + Math.sin(a0) * rad;
      const x1 = x + Math.cos(a1) * rad, z1 = z + Math.sin(a1) * rad;
      g.tri(x0, y, z0, x, y + h, z, x1, y, z1, c[0] * (0.9 + 0.1 * (k % 2)), c[1], c[2]);
    }
  }

  // ───────────────────────────── road collider ─────────────────────────────
  private roadCollider(): void {
    const r = this.r;
    const verts: number[] = [], idx: number[] = [];
    let n = 0;
    for (let i = this.i0; i <= this.i1; i++) {
      const e = this.a2At(i) + 0.45;
      for (const l of [-e, 0, e]) {
        this.pt(i, l, 0, this.t3, 0);
        verts.push(this.t3[0], this.t3[1], this.t3[2]);
      }
      if (i < this.i1) {
        const b = 3 * n;
        // two quads per row (left, right); CCW from above
        idx.push(b, b + 1, b + 4, b, b + 4, b + 3, b + 1, b + 2, b + 5, b + 1, b + 5, b + 4);
      }
      n++;
    }
    this.out.cols.push({ type: 'trimesh', verts, idx, tag: TAG_ROAD });
    void r;
  }
}
