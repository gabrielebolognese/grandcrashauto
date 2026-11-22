import type { PedEdge, PedEdgeKind, PedNode } from '../types';
import type { Island } from './model';

/** Incremental pedestrian-graph builder: island sidewalk rings, crosswalks, paths, edge splitting. Pure data. */

interface Side {
  island: Island;
  k: number; // 0 N, 1 E, 2 S, 3 W
  axis: 'x' | 'z'; // running axis
  fixed: number;
  from: number;
  to: number;
  y: number;
  width: number;
  kind: PedEdgeKind;
  pts: { t: number; id: number }[];
}

export class PedBuilder {
  readonly nodes: PedNode[] = [];
  readonly edges: PedEdge[] = [];
  private keyMap = new Map<string, number>();
  private edgeKeys = new Set<string>();
  readonly sides: Side[] = [];

  node(x: number, y: number, z: number): number {
    const k = `${Math.round(x * 20)},${Math.round(z * 20)},${Math.round(y * 4)}`;
    const ex = this.keyMap.get(k);
    if (ex !== undefined) return ex;
    const id = this.nodes.length;
    this.nodes.push({ id, p: { x, y, z }, edges: [] });
    this.keyMap.set(k, id);
    return id;
  }

  edge(a: number, b: number, kind: PedEdgeKind, width: number): number {
    if (a === b) return -1;
    const k = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (this.edgeKeys.has(k)) return -1;
    this.edgeKeys.add(k);
    const id = this.edges.length;
    this.edges.push({ id, a, b, kind, width });
    return id;
  }

  /** Connect a→b, inserting intermediate nodes so no edge is longer than maxLen. */
  chain(a: number, b: number, kind: PedEdgeKind, width: number, maxLen = 30): void {
    const pa = this.nodes[a].p, pb = this.nodes[b].p;
    const len = Math.hypot(pb.x - pa.x, pb.z - pa.z);
    const n = Math.max(1, Math.ceil(len / maxLen));
    let prev = a;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const m = this.node(pa.x + (pb.x - pa.x) * t, pa.y + (pb.y - pa.y) * t, pa.z + (pb.z - pa.z) * t);
      this.edge(prev, m, kind, width);
      prev = m;
    }
    this.edge(prev, b, kind, width);
  }

  /** Register the sidewalk ring sides of an island (only sides with sw > 0). */
  addIslandSides(isl: Island, kind: PedEdgeKind = 'sidewalk'): void {
    const [sn, se, ss, sw] = isl.sw;
    const y = isl.top;
    const x0 = sw > 0 ? isl.minX + sw / 2 : isl.minX + 1.5;
    const x1 = se > 0 ? isl.maxX - se / 2 : isl.maxX - 1.5;
    const z0 = sn > 0 ? isl.minZ + sn / 2 : isl.minZ + 1.5;
    const z1 = ss > 0 ? isl.maxZ - ss / 2 : isl.maxZ - 1.5;
    const mk = (k: number, axis: 'x' | 'z', fixed: number, from: number, to: number, w: number) =>
      this.sides.push({ island: isl, k, axis, fixed, from, to, y, width: Math.max(1.2, w - 0.6), kind, pts: [] });
    if (sn > 0) mk(0, 'x', z0, x0, x1, sn);
    if (se > 0) mk(1, 'z', x1, z0, z1, se);
    if (ss > 0) mk(2, 'x', z1, x0, x1, ss);
    if (sw > 0) mk(3, 'z', x0, z0, z1, sw);
  }

  /** Find the side containing (x,z) (on its line, within its extent). */
  sideAt(x: number, z: number, tol = 0.08): Side | null {
    for (const s of this.sides) {
      const f = s.axis === 'x' ? z : x;
      const r = s.axis === 'x' ? x : z;
      if (Math.abs(f - s.fixed) <= tol && r >= s.from - tol && r <= s.to + tol) return s;
    }
    return null;
  }

  /** Add a node on a side at (x,z); returns its id or -1 if no side contains the point. */
  onSide(x: number, z: number): number {
    const s = this.sideAt(x, z);
    if (!s) return -1;
    const t = Math.min(s.to, Math.max(s.from, s.axis === 'x' ? x : z));
    for (const p of s.pts) if (Math.abs(p.t - t) < 0.4) return p.id;
    const px = s.axis === 'x' ? t : s.fixed;
    const pz = s.axis === 'x' ? s.fixed : t;
    const id = this.node(px, s.y, pz);
    s.pts.push({ t, id });
    return id;
  }

  /** After all side nodes are registered: add corners/ends and connect each side. */
  buildSides(): void {
    for (const s of this.sides) {
      const ends = [s.from, s.to];
      for (const t of ends) {
        if (!s.pts.some((p) => Math.abs(p.t - t) < 0.4)) {
          const px = s.axis === 'x' ? t : s.fixed;
          const pz = s.axis === 'x' ? s.fixed : t;
          s.pts.push({ t, id: this.node(px, s.y, pz) });
        }
      }
      s.pts.sort((a, b) => a.t - b.t);
      for (let i = 0; i + 1 < s.pts.length; i++) this.chain(s.pts[i].id, s.pts[i + 1].id, s.kind, s.width, 28);
    }
  }

  /** Nearest edge to (x,z) (optionally filtered). Returns edge id, param t and squared distance. */
  nearestEdge(x: number, z: number, filter?: (e: PedEdge) => boolean): { id: number; t: number; d2: number } {
    let best = { id: -1, t: 0, d2: Infinity };
    for (const e of this.edges) {
      if (filter && !filter(e)) continue;
      const a = this.nodes[e.a].p, b = this.nodes[e.b].p;
      const dx = b.x - a.x, dz = b.z - a.z;
      const l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const px = a.x + dx * t - x, pz = a.z + dz * t - z;
      const d2 = px * px + pz * pz;
      if (d2 < best.d2) best = { id: e.id, t, d2 };
    }
    return best;
  }

  /** Split edge at param t; returns the new (or an existing end) node id. */
  split(edgeId: number, t: number): number {
    const e = this.edges[edgeId];
    const a = this.nodes[e.a].p, b = this.nodes[e.b].p;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (t * len < 0.6) return e.a;
    if ((1 - t) * len < 0.6) return e.b;
    const id = this.node(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
    const oldB = e.b;
    e.b = id; // reuse the edge record for a→mid
    const k = e.a < oldB ? `${e.a}-${oldB}` : `${oldB}-${e.a}`;
    this.edgeKeys.delete(k);
    this.edgeKeys.add(e.a < id ? `${e.a}-${id}` : `${id}-${e.a}`);
    this.edge(id, oldB, e.kind, e.width);
    return id;
  }

  /** Attach a point to the graph: node on the nearest edge (split), plus an optional spur node at (x,z). */
  attach(x: number, y: number, z: number, kind: PedEdgeKind, width: number, filter?: (e: PedEdge) => boolean, spur = true): number {
    const ne = this.nearestEdge(x, z, filter);
    if (ne.id < 0) return -1;
    const on = this.split(ne.id, ne.t);
    if (!spur || ne.d2 < 0.25) return on;
    const n = this.node(x, y, z);
    this.edge(on, n, kind, width);
    return n;
  }

  finalize(): void {
    for (const n of this.nodes) n.edges.length = 0;
    for (const e of this.edges) {
      this.nodes[e.a].edges.push(e.id);
      this.nodes[e.b].edges.push(e.id);
    }
  }
}
