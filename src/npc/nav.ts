import type { Bench, BuildingLot, BusStop, CityData, PedEdgeKind, PropKind, PropPlacement, Vec3, WanderArea } from '../world/types';

/**
 * Pedestrian navigation data: ped graph with index-based adjacency, a uniform grid over edges (nearest point /
 * spawn sampling), node → bench / bus stop lookups, and a static obstacle grid (props + building footprints)
 * for local avoidance. Built once from CityData (or from the NPC test environment).
 */

export interface NavNode {
  x: number;
  y: number;
  z: number;
  edges: number[]; // edge indices
}

export interface NavEdge {
  a: number; // node index
  b: number;
  kind: PedEdgeKind;
  width: number;
  len: number;
  dx: number; // unit direction a → b
  dz: number;
  cross: boolean;
}

export interface NavSource {
  ped: CityData['ped'];
  benches: Bench[];
  busStops: BusStop[];
  wanderAreas: WanderArea[];
  groupSpots: Vec3[];
  buildings: BuildingLot[];
  props: PropPlacement[];
}

const OBSTACLE_R: Partial<Record<PropKind, number>> = {
  streetlight: 0.35,
  palm: 0.5,
  tree: 0.65,
  hydrant: 0.3,
  bin: 0.4,
  trafficLight: 0.35,
  sign: 0.3,
  busStop: 0.0, // shelter: handled as walkable
};

export class PedNav {
  readonly nodes: NavNode[] = [];
  readonly edges: NavEdge[] = [];
  readonly benches: Bench[];
  readonly busStops: BusStop[];
  readonly wanderAreas: WanderArea[];
  readonly groupSpots: Vec3[];
  /** bench indices / bus stop indices per node index */
  readonly nodeBenches = new Map<number, number[]>();
  readonly nodeStops = new Map<number, number[]>();
  readonly benchIndexById = new Map<number, number>();
  totalLen = 0;

  // edge grid (CSR)
  private gMinX = 0;
  private gMinZ = 0;
  private gN = 1;
  private gCell = 16;
  private gStart = new Int32Array(1);
  private gItems = new Int32Array(0);
  // obstacles (props: circles; buildings: oriented boxes) grid (CSR)
  private oMinX = 0;
  private oMinZ = 0;
  private oN = 1;
  private readonly oCell = 12;
  private oStart = new Int32Array(1);
  private oItems = new Int32Array(0);
  /** obstacle data: [type(0 circle,1 box), x, z, r | hw, hd, cos, sin] stride 7 */
  private obs = new Float32Array(0);
  readonly obstaclePropIndex: Int32Array = new Int32Array(0);

  constructor(src: NavSource) {
    const idToIndex = new Map<number, number>();
    src.ped.nodes.forEach((n, i) => {
      idToIndex.set(n.id, i);
      this.nodes.push({ x: n.p.x, y: n.p.y, z: n.p.z, edges: [] });
    });
    for (const e of src.ped.edges) {
      const a = idToIndex.get(e.a);
      const b = idToIndex.get(e.b);
      if (a === undefined || b === undefined || a === b) continue;
      const na = this.nodes[a], nb = this.nodes[b];
      const dx = nb.x - na.x, dz = nb.z - na.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;
      const idx = this.edges.length;
      this.edges.push({ a, b, kind: e.kind, width: Math.max(0.8, e.width), len, dx: dx / len, dz: dz / len, cross: e.kind === 'crosswalk' });
      na.edges.push(idx);
      nb.edges.push(idx);
      this.totalLen += len;
    }
    this.benches = src.benches;
    this.busStops = src.busStops;
    this.wanderAreas = src.wanderAreas;
    this.groupSpots = src.groupSpots;
    src.benches.forEach((b, i) => {
      this.benchIndexById.set(b.id, i);
      const ni = idToIndex.get(b.pedNode) ?? this.nearestNode(b.p.x, b.p.z);
      if (ni >= 0) {
        const arr = this.nodeBenches.get(ni) ?? [];
        arr.push(i);
        this.nodeBenches.set(ni, arr);
      }
    });
    src.busStops.forEach((s, i) => {
      const ni = idToIndex.get(s.pedNode) ?? this.nearestNode(s.p.x, s.p.z);
      if (ni >= 0) {
        const arr = this.nodeStops.get(ni) ?? [];
        arr.push(i);
        this.nodeStops.set(ni, arr);
      }
    });
    this.buildEdgeGrid();
    this.buildObstacleGrid(src);
  }

  get empty(): boolean {
    return this.edges.length === 0;
  }

  /** Floating origin: move every cached coordinate by -(dx, dz). Grids keep their cell lists (uniform shift). */
  shift(dx: number, dz: number): void {
    for (const n of this.nodes) {
      n.x -= dx;
      n.z -= dz;
    }
    this.gMinX -= dx;
    this.gMinZ -= dz;
    this.oMinX -= dx;
    this.oMinZ -= dz;
    for (let o = 0; o < this.obs.length; o += 7) {
      this.obs[o + 1] -= dx;
      this.obs[o + 2] -= dz;
    }
  }

  nearestNode(x: number, z: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.nodes.length; i++) {
      const n = this.nodes[i];
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  private buildEdgeGrid(): void {
    if (!this.edges.length) return;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x);
      minZ = Math.min(minZ, n.z);
      maxX = Math.max(maxX, n.x);
      maxZ = Math.max(maxZ, n.z);
    }
    const pad = 8;
    this.gMinX = minX - pad;
    this.gMinZ = minZ - pad;
    const span = Math.max(maxX - minX, maxZ - minZ) + pad * 2;
    this.gN = Math.max(1, Math.min(128, Math.ceil(span / this.gCell)));
    this.gCell = span / this.gN;
    const lists: number[][] = Array.from({ length: this.gN * this.gN }, () => []);
    this.edges.forEach((e, i) => {
      const a = this.nodes[e.a], b = this.nodes[e.b];
      const r = e.width / 2 + 1;
      const x0 = this.cellX(Math.min(a.x, b.x) - r), x1 = this.cellX(Math.max(a.x, b.x) + r);
      const z0 = this.cellZ(Math.min(a.z, b.z) - r), z1 = this.cellZ(Math.max(a.z, b.z) + r);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) lists[cz * this.gN + cx].push(i);
    });
    this.gStart = new Int32Array(lists.length + 1);
    let total = 0;
    lists.forEach((l, i) => {
      this.gStart[i] = total;
      total += l.length;
    });
    this.gStart[lists.length] = total;
    this.gItems = new Int32Array(total);
    let k = 0;
    for (const l of lists) for (const e of l) this.gItems[k++] = e;
  }

  private cellX(x: number): number {
    return Math.min(this.gN - 1, Math.max(0, Math.floor((x - this.gMinX) / this.gCell)));
  }
  private cellZ(z: number): number {
    return Math.min(this.gN - 1, Math.max(0, Math.floor((z - this.gMinZ) / this.gCell)));
  }

  /**
   * Nearest point on the graph to (x,z) within maxDist. Writes into out: {edge, t (0..len from a), dist, x, z}.
   * Returns false when nothing is in range.
   */
  nearest(x: number, z: number, maxDist: number, out: NearestHit, skipCross = false): boolean {
    if (!this.edges.length) return false;
    const x0 = this.cellX(x - maxDist), x1 = this.cellX(x + maxDist);
    const z0 = this.cellZ(z - maxDist), z1 = this.cellZ(z + maxDist);
    let best = maxDist * maxDist;
    out.edge = -1;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * this.gN + cx;
        for (let k = this.gStart[c]; k < this.gStart[c + 1]; k++) {
          const ei = this.gItems[k];
          const e = this.edges[ei];
          if (skipCross && e.cross) continue;
          const a = this.nodes[e.a];
          let t = (x - a.x) * e.dx + (z - a.z) * e.dz;
          t = t < 0 ? 0 : t > e.len ? e.len : t;
          const px = a.x + e.dx * t, pz = a.z + e.dz * t;
          const d = (px - x) ** 2 + (pz - z) ** 2;
          if (d < best) {
            best = d;
            out.edge = ei;
            out.t = t;
            out.x = px;
            out.z = pz;
          }
        }
      }
    }
    out.dist = Math.sqrt(best);
    return out.edge >= 0;
  }

  /** Random edge whose cell contains (x,z) (or a nearby one). Returns -1 if none. */
  edgeNear(x: number, z: number, rand: number): number {
    if (!this.edges.length) return -1;
    const c = this.cellZ(z) * this.gN + this.cellX(x);
    const n = this.gStart[c + 1] - this.gStart[c];
    if (n === 0) return -1;
    return this.gItems[this.gStart[c] + Math.min(n - 1, Math.floor(rand * n))];
  }

  // ───────────── obstacles ─────────────
  private buildObstacleGrid(src: NavSource): void {
    const items: number[] = [];
    const propIdx: number[] = [];
    src.props.forEach((p, i) => {
      const r = OBSTACLE_R[p.kind];
      if (!r) return;
      items.push(0, p.p.x, p.p.z, r, 0, 0, 0);
      propIdx.push(i);
    });
    for (const b of src.buildings) {
      items.push(1, b.x, b.z, b.w / 2, b.d / 2, Math.cos(b.yaw), Math.sin(b.yaw));
      propIdx.push(-1);
    }
    this.obs = new Float32Array(items);
    (this as { obstaclePropIndex: Int32Array }).obstaclePropIndex = new Int32Array(propIdx);
    const count = propIdx.length;
    if (!count) return;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      const r = this.obs[o] === 0 ? this.obs[o + 3] : Math.hypot(this.obs[o + 3], this.obs[o + 4]);
      minX = Math.min(minX, this.obs[o + 1] - r);
      maxX = Math.max(maxX, this.obs[o + 1] + r);
      minZ = Math.min(minZ, this.obs[o + 2] - r);
      maxZ = Math.max(maxZ, this.obs[o + 2] + r);
    }
    this.oMinX = minX - 2;
    this.oMinZ = minZ - 2;
    this.oN = Math.max(1, Math.min(160, Math.ceil((Math.max(maxX - minX, maxZ - minZ) + 4) / this.oCell)));
    const lists: number[][] = Array.from({ length: this.oN * this.oN }, () => []);
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      const r = (this.obs[o] === 0 ? this.obs[o + 3] : Math.hypot(this.obs[o + 3], this.obs[o + 4])) + 1;
      const x0 = this.oCellX(this.obs[o + 1] - r), x1 = this.oCellX(this.obs[o + 1] + r);
      const z0 = this.oCellZ(this.obs[o + 2] - r), z1 = this.oCellZ(this.obs[o + 2] + r);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) lists[cz * this.oN + cx].push(i);
    }
    this.oStart = new Int32Array(lists.length + 1);
    let total = 0;
    lists.forEach((l, i) => {
      this.oStart[i] = total;
      total += l.length;
    });
    this.oStart[lists.length] = total;
    this.oItems = new Int32Array(total);
    let k = 0;
    for (const l of lists) for (const e of l) this.oItems[k++] = e;
  }
  private oCellX(x: number): number {
    return Math.min(this.oN - 1, Math.max(0, Math.floor((x - this.oMinX) / this.oCell)));
  }
  private oCellZ(z: number): number {
    return Math.min(this.oN - 1, Math.max(0, Math.floor((z - this.oMinZ) / this.oCell)));
  }

  /**
   * Static avoidance at (x,z) for a body of radius r. Writes a push/steer vector into out (x,z) and returns true if
   * something is near. `inside` is set when the point is inside an obstacle (must be pushed out hard).
   */
  avoid(x: number, z: number, r: number, look: number, out: AvoidOut, disturbed?: (propIndex: number) => boolean): boolean {
    out.x = 0;
    out.z = 0;
    out.inside = false;
    if (!this.oItems.length) return false;
    const c = this.oCellZ(z) * this.oN + this.oCellX(x);
    let any = false;
    for (let k = this.oStart[c]; k < this.oStart[c + 1]; k++) {
      const i = this.oItems[k];
      const o = i * 7;
      if (this.obs[o] === 0) {
        const pi = this.obstaclePropIndex[i];
        if (disturbed && pi >= 0 && disturbed(pi)) continue;
        const dx = x - this.obs[o + 1], dz = z - this.obs[o + 2];
        const d = Math.hypot(dx, dz) || 0.001;
        const rr = this.obs[o + 3] + r;
        if (d < rr + look) {
          const s = d < rr ? (rr - d) * 4 + 1 : (rr + look - d) / look;
          out.x += (dx / d) * s;
          out.z += (dz / d) * s;
          if (d < rr) out.inside = true;
          any = true;
        }
      } else {
        // oriented box (yaw), local coords: x' = cos*dx - sin*dz ... (yaw rotates +Z toward +X)
        const cs = this.obs[o + 5], sn = this.obs[o + 6];
        const dx = x - this.obs[o + 1], dz = z - this.obs[o + 2];
        const lx = cs * dx - sn * dz;
        const lz = sn * dx + cs * dz;
        const hw = this.obs[o + 3] + r, hd = this.obs[o + 4] + r;
        const qx = Math.abs(lx) - hw, qz = Math.abs(lz) - hd;
        if (qx < look && qz < look) {
          let px = 0, pz = 0, s = 0;
          if (qx < 0 && qz < 0) {
            // inside: push out along the shallowest axis
            if (qx > qz) {
              px = Math.sign(lx) || 1;
              s = -qx * 6 + 1;
            } else {
              pz = Math.sign(lz) || 1;
              s = -qz * 6 + 1;
            }
            out.inside = true;
          } else {
            const ex = Math.max(qx, 0), ez = Math.max(qz, 0);
            const d = Math.hypot(ex, ez) || 0.001;
            if (d > look) continue;
            px = (ex / d) * (Math.sign(lx) || 1);
            pz = (ez / d) * (Math.sign(lz) || 1);
            s = (look - d) / look;
          }
          // back to world: inverse rotation
          out.x += (cs * px + sn * pz) * s;
          out.z += (-sn * px + cs * pz) * s;
          any = true;
        }
      }
    }
    return any;
  }

  /** Is (x,z) inside a building footprint (expanded by r)? */
  insideBuilding(x: number, z: number, r: number): boolean {
    if (!this.oItems.length) return false;
    const c = this.oCellZ(z) * this.oN + this.oCellX(x);
    for (let k = this.oStart[c]; k < this.oStart[c + 1]; k++) {
      const o = this.oItems[k] * 7;
      if (this.obs[o] !== 1) continue;
      const cs = this.obs[o + 5], sn = this.obs[o + 6];
      const dx = x - this.obs[o + 1], dz = z - this.obs[o + 2];
      const lx = cs * dx - sn * dz, lz = sn * dx + cs * dz;
      if (Math.abs(lx) < this.obs[o + 3] + r && Math.abs(lz) < this.obs[o + 4] + r) return true;
    }
    return false;
  }
}

export interface NearestHit {
  edge: number;
  t: number;
  dist: number;
  x: number;
  z: number;
}

export interface AvoidOut {
  x: number;
  z: number;
  inside: boolean;
}
