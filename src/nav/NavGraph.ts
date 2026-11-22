import type { RoadGraph } from '../world/types';

/**
 * Combined navigation graph (city roads + generated highway network) in ABSOLUTE coordinates, so it never needs to
 * move on a floating-origin shift. Nodes of the source graphs closer than `mergeDistance` are merged; dangling ends
 * of one network that stop close to the other network are joined (the edge they touch is split). Directed edges
 * respect one-way roads. A uniform grid indexes every polyline segment for snapping.
 */

const KIND_KMH: Record<string, number> = { highway: 110, ramp: 60, boulevard: 60, street4: 50, street2: 40, lot: 15 };

export interface BaseEdge {
  /** Polyline x,y,z triplets (absolute). */
  pts: Float64Array;
  /** Cumulative length at each polyline point. */
  cum: Float64Array;
  len: number;
  a: number;
  b: number;
  oneWay: boolean;
  /** m/s used for the travel-time cost. */
  speed: number;
  kind: string;
  /** From the highway network (vs the city). */
  hw: boolean;
  dead: boolean;
}

export interface Snap {
  edge: number;
  seg: number;
  /** Distance along the base edge. */
  s: number;
  x: number;
  y: number;
  z: number;
  dist: number;
}

export interface GraphSource {
  graph: RoadGraph;
  /** Origin offset to convert the (local) source coordinates to absolute. */
  ox: number;
  oz: number;
  hw: boolean;
}

/** Raw path from the router: flat xyz points, graph node id per point (-1 = none), offroad flag per segment start. */
export interface RawPath {
  pts: number[];
  node: number[];
  offroad: number[];
  partial: boolean;
  uturnStart: boolean;
  cost: number;
  expansions: number;
}

const CELL = 48;
/** Small-integer grid key (15 bits per axis, wraps every 32768 cells — fine for any realistic network). */
const key = (cx: number, cz: number) => ((cx & 0x7fff) << 15) | (cz & 0x7fff);

export class NavGraph {
  nodeX: number[] = [];
  nodeY: number[] = [];
  nodeZ: number[] = [];
  base: BaseEdge[] = [];
  // directed edges
  dFrom = new Int32Array(0);
  dTo = new Int32Array(0);
  dBase = new Int32Array(0);
  dRev = new Uint8Array(0);
  dCost = new Float64Array(0);
  /** Unit start / end directions (xz) of every directed edge (turn penalties, manoeuvres). */
  dSX = new Float32Array(0);
  dSZ = new Float32Array(0);
  dEX = new Float32Array(0);
  dEZ = new Float32Array(0);
  outStart = new Int32Array(1);
  outList = new Int32Array(0);
  maxSpeed = 10;
  /** Grid cell → flat [edge, seg, edge, seg, …]. */
  private grid = new Map<number, number[]>();
  // A* scratch (reused between searches)
  private g = new Float64Array(0);
  private parent = new Int32Array(0);
  private stamp = new Uint32Array(0);
  private closed = new Uint32Array(0);
  private inX = new Float32Array(0);
  private inZ = new Float32Array(0);
  private search = 0;
  private heapN: number[] = [];
  private heapF: number[] = [];

  get nodeCount(): number {
    return this.nodeX.length;
  }

  // ─────────────────────────────── build ───────────────────────────────
  static build(sources: GraphSource[], mergeDistance: number, joinDistance: number): NavGraph {
    const G = new NavGraph();
    const mcell = Math.max(0.5, mergeDistance * 2);
    const mgrid = new Map<number, number[]>();
    const md2 = mergeDistance * mergeDistance;
    const nodeOf = (x: number, y: number, z: number): number => {
      const cx = Math.floor(x / mcell);
      const cz = Math.floor(z / mcell);
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          const list = mgrid.get(key(cx + i, cz + j));
          if (!list) continue;
          for (const n of list) {
            const dx = G.nodeX[n] - x;
            const dz = G.nodeZ[n] - z;
            const dy = G.nodeY[n] - y;
            // merge only on the same level (bridges over roads keep their own nodes)
            if (dx * dx + dz * dz <= md2 && Math.abs(dy) < 3) return n;
          }
        }
      const id = G.nodeX.length;
      G.nodeX.push(x);
      G.nodeY.push(y);
      G.nodeZ.push(z);
      const k = key(cx, cz);
      const l = mgrid.get(k);
      if (l) l.push(id);
      else mgrid.set(k, [id]);
      return id;
    };

    for (const src of sources) {
      const gr = src.graph;
      if (!gr || !Array.isArray(gr.nodes) || !Array.isArray(gr.edges)) continue;
      const map = new Map<number, number>();
      for (const n of gr.nodes) {
        if (!n || !n.p || !Number.isFinite(n.p.x) || !Number.isFinite(n.p.z)) continue;
        map.set(n.id, nodeOf(n.p.x + src.ox, n.p.y || 0, n.p.z + src.oz));
      }
      for (const e of gr.edges) {
        if (!e) continue;
        const a = map.get(e.a);
        const b = map.get(e.b);
        if (a === undefined || b === undefined) continue;
        const raw = Array.isArray(e.points) && e.points.length >= 2 ? e.points : null;
        const flat: number[] = [];
        if (raw) {
          for (const p of raw) {
            if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
            pushPoint(flat, p.x + src.ox, Number.isFinite(p.y) ? p.y : 0, p.z + src.oz);
          }
        }
        if (flat.length < 6) {
          flat.length = 0;
          pushPoint(flat, G.nodeX[a], G.nodeY[a], G.nodeZ[a]);
          pushPoint(flat, G.nodeX[b], G.nodeY[b], G.nodeZ[b]);
          if (flat.length < 6) continue;
        }
        const kmh = e.speedLimitKmh > 0 ? e.speedLimitKmh : (KIND_KMH[e.kind] ?? 40);
        G.addBase(flat, a, b, !!e.oneWay, kmh / 3.6, e.kind ?? 'street2', src.hw);
      }
    }

    // Join dangling ends of one network to the other one (interchanges that don't share a node exactly).
    if (joinDistance > 0) G.joinDangling(joinDistance);
    G.finish();
    return G;
  }

  private addBase(flat: number[], a: number, b: number, oneWay: boolean, speed: number, kind: string, hw: boolean): number {
    const n = flat.length / 3;
    const pts = new Float64Array(flat);
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const dx = pts[i * 3] - pts[i * 3 - 3];
      const dy = pts[i * 3 + 1] - pts[i * 3 - 2];
      const dz = pts[i * 3 + 2] - pts[i * 3 - 1];
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    this.base.push({ pts, cum, len: Math.max(0.01, cum[n - 1]), a, b, oneWay, speed: Math.max(2, speed), kind, hw, dead: false });
    return this.base.length - 1;
  }

  private joinDangling(dist: number): void {
    const deg = new Int32Array(this.nodeCount);
    const nodeHw = new Int8Array(this.nodeCount); // 1 city, 2 hw, 3 both
    for (const e of this.base) {
      deg[e.a]++;
      deg[e.b]++;
      const f = e.hw ? 2 : 1;
      nodeHw[e.a] |= f;
      nodeHw[e.b] |= f;
    }
    let hasHw = false;
    let hasCity = false;
    for (const e of this.base) (e.hw ? (hasHw = true) : (hasCity = true));
    if (!hasHw || !hasCity) return;
    this.rebuildGrid();
    const n0 = this.nodeCount;
    for (let n = 0; n < n0; n++) {
      if (deg[n] !== 1 || nodeHw[n] === 3) continue;
      const wantHw = nodeHw[n] === 1; // a city end looks for a highway edge and vice versa
      const s = this.nearest(this.nodeX[n], this.nodeZ[n], dist, (e) => e.hw === wantHw && e.a !== n && e.b !== n, this.nodeY[n]);
      if (!s) continue;
      const e = this.base[s.edge];
      let target: number;
      if (s.s < 3) target = e.a;
      else if (e.len - s.s < 3) target = e.b;
      else target = this.split(s.edge, s);
      if (target === n) continue;
      const flat: number[] = [];
      pushPoint(flat, this.nodeX[n], this.nodeY[n], this.nodeZ[n]);
      pushPoint(flat, this.nodeX[target], this.nodeY[target], this.nodeZ[target]);
      if (flat.length >= 6) this.addBase(flat, n, target, false, Math.min(e.speed, 50 / 3.6), 'ramp', e.hw);
    }
  }

  /** Split base edge `ei` at snap `s`; returns the new node id. The old edge is marked dead. */
  private split(ei: number, s: Snap): number {
    const e = this.base[ei];
    const id = this.nodeX.length;
    this.nodeX.push(s.x);
    this.nodeY.push(s.y);
    this.nodeZ.push(s.z);
    const n = e.pts.length / 3;
    const A: number[] = [];
    const B: number[] = [];
    for (let i = 0; i <= s.seg; i++) A.push(e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]);
    pushPoint(A, s.x, s.y, s.z);
    B.push(s.x, s.y, s.z);
    for (let i = s.seg + 1; i < n; i++) pushPoint(B, e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]);
    e.dead = true;
    const ea = A.length >= 6 ? this.addBase(A, e.a, id, e.oneWay, e.speed, e.kind, e.hw) : -1;
    const eb = B.length >= 6 ? this.addBase(B, id, e.b, e.oneWay, e.speed, e.kind, e.hw) : -1;
    if (ea >= 0) this.indexEdge(ea);
    if (eb >= 0) this.indexEdge(eb);
    return id;
  }

  private finish(): void {
    const N = this.nodeCount;
    let m = 0;
    for (const e of this.base) if (!e.dead) m += e.oneWay ? 1 : 2;
    this.dFrom = new Int32Array(m);
    this.dTo = new Int32Array(m);
    this.dBase = new Int32Array(m);
    this.dRev = new Uint8Array(m);
    this.dCost = new Float64Array(m);
    this.dSX = new Float32Array(m);
    this.dSZ = new Float32Array(m);
    this.dEX = new Float32Array(m);
    this.dEZ = new Float32Array(m);
    let k = 0;
    let vmax = 5;
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < this.base.length; i++) {
      const e = this.base[i];
      if (e.dead) continue;
      vmax = Math.max(vmax, e.speed);
      const c = e.len / e.speed;
      // forward start / end directions over the first / last ~10 m
      const n = e.pts.length;
      const look = Math.min(10, e.len);
      this.pointAt(i, look, p);
      let sx = p.x - e.pts[0];
      let sz = p.z - e.pts[2];
      let l = Math.hypot(sx, sz) || 1;
      sx /= l;
      sz /= l;
      this.pointAt(i, e.len - look, p);
      let ex = e.pts[n - 3] - p.x;
      let ez = e.pts[n - 1] - p.z;
      l = Math.hypot(ex, ez) || 1;
      ex /= l;
      ez /= l;
      this.dFrom[k] = e.a;
      this.dTo[k] = e.b;
      this.dBase[k] = i;
      this.dRev[k] = 0;
      this.dSX[k] = sx;
      this.dSZ[k] = sz;
      this.dEX[k] = ex;
      this.dEZ[k] = ez;
      this.dCost[k++] = c;
      if (!e.oneWay) {
        this.dFrom[k] = e.b;
        this.dTo[k] = e.a;
        this.dBase[k] = i;
        this.dRev[k] = 1;
        this.dSX[k] = -ex;
        this.dSZ[k] = -ez;
        this.dEX[k] = -sx;
        this.dEZ[k] = -sz;
        this.dCost[k++] = c;
      }
    }
    this.maxSpeed = vmax;
    const cnt = new Int32Array(N + 1);
    for (let i = 0; i < m; i++) cnt[this.dFrom[i] + 1]++;
    for (let i = 0; i < N; i++) cnt[i + 1] += cnt[i];
    this.outStart = cnt;
    this.outList = new Int32Array(m);
    const fill = cnt.slice(0, N);
    for (let i = 0; i < m; i++) this.outList[fill[this.dFrom[i]]++] = i;
    this.rebuildGrid();
  }

  // ─────────────────────────────── spatial index ───────────────────────────────
  private rebuildGrid(): void {
    this.grid.clear();
    for (let i = 0; i < this.base.length; i++) if (!this.base[i].dead) this.indexEdge(i);
  }

  private indexEdge(i: number): void {
    const p = this.base[i].pts;
    const n = p.length / 3;
    for (let s = 0; s < n - 1; s++) {
      const x0 = Math.floor(Math.min(p[s * 3], p[s * 3 + 3]) / CELL);
      const x1 = Math.floor(Math.max(p[s * 3], p[s * 3 + 3]) / CELL);
      const z0 = Math.floor(Math.min(p[s * 3 + 2], p[s * 3 + 5]) / CELL);
      const z1 = Math.floor(Math.max(p[s * 3 + 2], p[s * 3 + 5]) / CELL);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = key(cx, cz);
          const l = this.grid.get(k);
          if (l) l.push(i, s);
          else this.grid.set(k, [i, s]);
        }
    }
  }

  /**
   * Nearest point on the network to (x, z) within maxR. `score` (optional) adds a penalty per candidate
   * (e.g. heading alignment); `nearY` prefers segments at a similar height (decks vs streets below).
   */
  nearest(x: number, z: number, maxR: number, filter?: (e: BaseEdge) => boolean, nearY?: number, score?: (e: BaseEdge, seg: number, dx: number, dz: number) => number): Snap | null {
    let best: Snap | null = null;
    let bestScore = Infinity;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const rings = Math.ceil(maxR / CELL);
    for (let r = 0; r <= rings; r++) {
      if (best && (r - 1) * CELL > bestScore) break;
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const l = this.grid.get(key(cx + i, cz + j));
          if (!l) continue;
          for (let q = 0; q < l.length; q += 2) {
            const e = this.base[l[q]];
            if (e.dead || (filter && !filter(e))) continue;
            const s = l[q + 1];
            const p = e.pts;
            const ax = p[s * 3], ay = p[s * 3 + 1], az = p[s * 3 + 2];
            const bx = p[s * 3 + 3], by = p[s * 3 + 4], bz = p[s * 3 + 5];
            const dx = bx - ax;
            const dz = bz - az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t;
            const pz = az + dz * t;
            const py = ay + (by - ay) * t;
            const d = Math.hypot(px - x, pz - z);
            if (d > maxR) continue;
            let sc = d;
            if (nearY !== undefined) sc += Math.max(0, Math.abs(py - nearY) - 2) * 3;
            if (score) sc += score(e, s, dx, dz);
            if (sc < bestScore) {
              bestScore = sc;
              const segLen = e.cum[s + 1] - e.cum[s];
              best = { edge: l[q], seg: s, s: e.cum[s] + segLen * t, x: px, y: py, z: pz, dist: d };
            }
          }
        }
    }
    return best;
  }

  /** Heading-aware snap for the car: prefers roads aligned with the heading, and the legal direction of one-ways. */
  snapStart(x: number, z: number, y: number, fx: number, fz: number, near: number, far: number): Snap | null {
    const fl = Math.hypot(fx, fz);
    const hx = fl > 1e-6 ? fx / fl : 0;
    const hz = fl > 1e-6 ? fz / fl : 0;
    const s = this.nearest(x, z, near, undefined, y, (e, _seg, dx, dz) => {
      const l = Math.hypot(dx, dz);
      if (l < 1e-6 || fl < 1e-6) return 0;
      const dot = (dx * hx + dz * hz) / l;
      let p = (1 - Math.abs(dot)) * 6; // crossing roads at a junction: prefer the aligned one
      if (e.oneWay && dot < -0.3) p += 20; // wrong way on a one-way
      return p;
    });
    return s ?? this.nearest(x, z, far, undefined, y);
  }

  /** Point at distance s along base edge e (clamped). */
  pointAt(ei: number, s: number, out: { x: number; y: number; z: number }): void {
    const e = this.base[ei];
    const n = e.cum.length;
    if (s <= 0) {
      out.x = e.pts[0];
      out.y = e.pts[1];
      out.z = e.pts[2];
      return;
    }
    if (s >= e.len) {
      out.x = e.pts[n * 3 - 3];
      out.y = e.pts[n * 3 - 2];
      out.z = e.pts[n * 3 - 1];
      return;
    }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (e.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const seg = e.cum[lo + 1] - e.cum[lo];
    const t = seg > 1e-9 ? (s - e.cum[lo]) / seg : 0;
    out.x = e.pts[lo * 3] + (e.pts[lo * 3 + 3] - e.pts[lo * 3]) * t;
    out.y = e.pts[lo * 3 + 1] + (e.pts[lo * 3 + 4] - e.pts[lo * 3 + 1]) * t;
    out.z = e.pts[lo * 3 + 2] + (e.pts[lo * 3 + 5] - e.pts[lo * 3 + 2]) * t;
  }

  /** Append the polyline of base edge e from distance s0 to s1 (either direction), skipping duplicates. */
  appendRange(out: number[], ei: number, s0: number, s1: number): void {
    const e = this.base[ei];
    const n = e.cum.length;
    const tmp = { x: 0, y: 0, z: 0 };
    this.pointAt(ei, s0, tmp);
    pushPoint(out, tmp.x, tmp.y, tmp.z);
    if (s1 >= s0) {
      for (let i = 0; i < n; i++) if (e.cum[i] > s0 + 0.05 && e.cum[i] < s1 - 0.05) pushPoint(out, e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]);
    } else {
      for (let i = n - 1; i >= 0; i--) if (e.cum[i] < s0 - 0.05 && e.cum[i] > s1 + 0.05) pushPoint(out, e.pts[i * 3], e.pts[i * 3 + 1], e.pts[i * 3 + 2]);
    }
    this.pointAt(ei, s1, tmp);
    pushPoint(out, tmp.x, tmp.y, tmp.z);
  }

  // ─────────────────────────────── A* ───────────────────────────────
  /**
   * Fastest path (travel time) from the start snap to the goal snap. With goal === null (target not on the network
   * yet) the search explores the reachable network and returns the path to the node closest to (destX, destZ),
   * flagged `partial`.
   */
  route(start: Snap, goal: Snap | null, destX: number, destZ: number, hx: number, hz: number, uturnPenalty: number, maxExp: number): RawPath | null {
    const N = this.nodeCount;
    const S = N;
    const T = N + 1;
    const M = N + 2;
    if (this.g.length < M) {
      this.g = new Float64Array(M);
      this.parent = new Int32Array(M);
      this.stamp = new Uint32Array(M);
      this.closed = new Uint32Array(M);
      this.inX = new Float32Array(M);
      this.inZ = new Float32Array(M);
    }
    const inX = this.inX;
    const inZ = this.inZ;
    const g = this.g;
    const parent = this.parent;
    const stamp = this.stamp;
    const closed = this.closed;
    const sid = ++this.search;
    const vmax = this.maxSpeed;
    const se = this.base[start.edge];
    // start direction vs heading: penalize starting against the car
    const tan = this.tangent(start.edge, start.s);
    const fwdDot = tan.x * hx + tan.z * hz;
    const penF = fwdDot < -0.2 ? uturnPenalty : 0;
    const penR = -fwdDot < -0.2 ? uturnPenalty : 0;
    const tx = goal ? goal.x : destX;
    const tz = goal ? goal.z : destZ;
    const hFn = (n: number) => {
      if (n === T) return 0;
      const x = n === S ? start.x : this.nodeX[n];
      const z = n === S ? start.z : this.nodeZ[n];
      return Math.hypot(x - tx, z - tz) / vmax;
    };
    const heapN = this.heapN;
    const heapF = this.heapF;
    heapN.length = 0;
    heapF.length = 0;
    const relax = (v: number, cost: number, par: number, dx: number, dz: number) => {
      if (stamp[v] !== sid) {
        stamp[v] = sid;
        g[v] = Infinity;
      }
      if (cost >= g[v] || closed[v] === sid) return;
      g[v] = cost;
      parent[v] = par;
      inX[v] = dx;
      inZ[v] = dz;
      heapPush(heapN, heapF, v, cost + hFn(v));
    };
    // turn penalty at a junction from the arrival direction to the next edge's start direction (s)
    const turnCost = (c: number) => (c > 0.82 ? 0 : c > -0.2 ? 5 : c > -0.8 ? 12 : 30);
    // parent codes: >= 0 directed edge; -2 start fwd; -3 start rev; -4 start→goal direct fwd; -5 direct rev
    // goal parent encodes the node via goalVia + direction
    let goalVia = -1;
    let goalDir = 0;
    const tryGoal = (c: number, via: number, dir: number) => {
      if (stamp[T] !== sid) {
        stamp[T] = sid;
        g[T] = Infinity;
      }
      if (c >= g[T] || closed[T] === sid) return;
      g[T] = c;
      parent[T] = -6;
      goalVia = via;
      goalDir = dir;
      heapPush(heapN, heapF, T, c);
    };
    stamp[S] = sid;
    g[S] = 0;
    parent[S] = -1;
    {
      const fwd = this.firstDirected(start.edge, 0);
      if (fwd >= 0) relax(se.b, (se.len - start.s) / se.speed + penF, -2, this.dEX[fwd], this.dEZ[fwd]);
      const rev = se.oneWay ? -1 : this.firstDirected(start.edge, 1);
      if (rev >= 0) relax(se.a, start.s / se.speed + penR, -3, this.dEX[rev], this.dEZ[rev]);
    }
    let ge: BaseEdge | null = null;
    if (goal) {
      ge = this.base[goal.edge];
      if (goal.edge === start.edge) {
        if (goal.s >= start.s) relax(T, (goal.s - start.s) / se.speed + penF, -4, 0, 0);
        else if (!se.oneWay) relax(T, (start.s - goal.s) / se.speed + penR, -5, 0, 0);
      }
    }
    let bestNode = -1;
    let bestD = Infinity;
    let exp = 0;
    let found = false;
    while (heapN.length) {
      const u = heapPop(heapN, heapF);
      if (closed[u] === sid) continue;
      closed[u] = sid;
      if (u === T) {
        found = true;
        break;
      }
      if (++exp > maxExp) break;
      if (!goal) {
        const d = Math.hypot(this.nodeX[u] - destX, this.nodeZ[u] - destZ);
        if (d < bestD) {
          bestD = d;
          bestNode = u;
        }
      }
      const gu = g[u];
      if (ge && goal) {
        if (u === ge.a) tryGoal(gu + goal.s / ge.speed, u, 0);
        if (u === ge.b && !ge.oneWay) tryGoal(gu + (ge.len - goal.s) / ge.speed, u, 1);
      }
      const ix = inX[u];
      const iz = inZ[u];
      for (let k = this.outStart[u]; k < this.outStart[u + 1]; k++) {
        const d = this.outList[k];
        relax(this.dTo[d], gu + this.dCost[d] + turnCost(ix * this.dSX[d] + iz * this.dSZ[d]), d, this.dEX[d], this.dEZ[d]);
      }
    }

    // ── reconstruct ──
    let endNode: number;
    if (found) endNode = T;
    else if (!goal && bestNode >= 0) endNode = bestNode;
    else if (!goal) endNode = -1;
    else return null;

    const pts: number[] = [];
    const node: number[] = [];
    const off: number[] = [];
    const push = (from: number[], nodeId: number) => {
      // append flat points, marking only the last one with nodeId
      for (let i = 0; i < from.length; i += 3) {
        const before = pts.length;
        pushPoint(pts, from[i], from[i + 1], from[i + 2]);
        if (pts.length > before) {
          node.push(-1);
          off.push(0);
        }
      }
      if (nodeId >= 0 && node.length) node[node.length - 1] = nodeId;
    };
    const tmp: number[] = [];
    if (endNode === -1) {
      // nothing reachable beyond the start edge: just go along it in the heading's direction
      tmp.length = 0;
      this.appendRange(tmp, start.edge, start.s, fwdDot >= 0 || se.oneWay ? se.len : 0);
      push(tmp, -1);
      return { pts, node, offroad: off, partial: true, uturnStart: false, cost: 0, expansions: exp };
    }
    // chain of nodes back to S
    const chain: number[] = [];
    let v = endNode;
    let guard = 0;
    if (v === T) {
      const pc = parent[T];
      if (pc === -4 || pc === -5) {
        tmp.length = 0;
        this.appendRange(tmp, start.edge, start.s, goal!.s);
        push(tmp, -1);
        return { pts, node, offroad: off, partial: false, uturnStart: pc === -5 ? penR > 0 : penF > 0, cost: g[T], expansions: exp };
      }
      v = goalVia;
    }
    while (v !== S && v >= 0 && guard++ < 1e6) {
      chain.push(v);
      const pc = parent[v];
      if (pc < 0) break;
      v = this.dFrom[pc];
    }
    chain.reverse();
    if (!chain.length) return null;
    // first leg: start projection → first node
    const firstCode = parent[chain[0]];
    tmp.length = 0;
    this.appendRange(tmp, start.edge, start.s, firstCode === -2 ? se.len : 0);
    push(tmp, chain[0]);
    const uturnStart = firstCode === -2 ? penF > 0 : penR > 0;
    for (let i = 1; i < chain.length; i++) {
      const d = parent[chain[i]];
      const bi = this.dBase[d];
      const e = this.base[bi];
      tmp.length = 0;
      if (this.dRev[d]) this.appendRange(tmp, bi, e.len, 0);
      else this.appendRange(tmp, bi, 0, e.len);
      push(tmp, chain[i]);
    }
    if (endNode === T && ge && goal) {
      tmp.length = 0;
      if (goalDir === 0) this.appendRange(tmp, goal.edge, 0, goal.s);
      else this.appendRange(tmp, goal.edge, ge.len, goal.s);
      push(tmp, -1);
    }
    return { pts, node, offroad: off, partial: endNode !== T, uturnStart, cost: endNode === T ? g[T] : g[endNode], expansions: exp };
  }

  /** Index of the directed edge of base edge `ei` in direction `rev` (0 = a→b, 1 = b→a), or -1. */
  private firstDirected(ei: number, rev: number): number {
    const a = rev ? this.base[ei].b : this.base[ei].a;
    for (let k = this.outStart[a]; k < this.outStart[a + 1]; k++) {
      const d = this.outList[k];
      if (this.dBase[d] === ei && this.dRev[d] === rev) return d;
    }
    return -1;
  }

  /** Unit tangent (xz) of base edge e at distance s, in the a→b direction. */
  tangent(ei: number, s: number): { x: number; z: number } {
    const e = this.base[ei];
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const h = Math.min(3, e.len / 2);
    this.pointAt(ei, Math.max(0, s - h), a);
    this.pointAt(ei, Math.min(e.len, s + h), b);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  /** Directions (xz unit vectors) of every edge leaving node n, sampled `ahead` metres along each. */
  outDirections(n: number, ahead: number): { x: number; z: number }[] {
    const res: { x: number; z: number }[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (let k = this.outStart[n]; k < this.outStart[n + 1]; k++) {
      const d = this.outList[k];
      const bi = this.dBase[d];
      const e = this.base[bi];
      const s = Math.min(ahead, e.len);
      this.pointAt(bi, this.dRev[d] ? e.len - s : s, p);
      const dx = p.x - this.nodeX[n];
      const dz = p.z - this.nodeZ[n];
      const l = Math.hypot(dx, dz);
      if (l > 0.5) res.push({ x: dx / l, z: dz / l });
    }
    return res;
  }
}

function pushPoint(out: number[], x: number, y: number, z: number): void {
  const n = out.length;
  if (n >= 3) {
    const dx = out[n - 3] - x;
    const dz = out[n - 1] - z;
    const dy = out[n - 2] - y;
    if (dx * dx + dz * dz + dy * dy < 0.0025) return;
  }
  out.push(x, y, z);
}

// binary min-heap on parallel arrays (node ids, f scores)
function heapPush(N: number[], F: number[], n: number, f: number): void {
  let i = N.length;
  N.push(n);
  F.push(f);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (F[p] <= f) break;
    N[i] = N[p];
    F[i] = F[p];
    i = p;
  }
  N[i] = n;
  F[i] = f;
}

function heapPop(N: number[], F: number[]): number {
  const top = N[0];
  const ln = N.pop()!;
  const lf = F.pop()!;
  const len = N.length;
  if (len > 0) {
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      if (l >= len) break;
      const r = l + 1;
      const c = r < len && F[r] < F[l] ? r : l;
      if (F[c] >= lf) break;
      N[i] = N[c];
      F[i] = F[c];
      i = c;
    }
    N[i] = ln;
    F[i] = lf;
  }
  return top;
}
