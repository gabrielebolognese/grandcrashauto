import { CONFIG } from '../../config';
import { hash32 } from '../../core/rng';
import { H, checkSeed, coastXAt, coastZAt, onSeedChange } from './terrainSample';

/**
 * Macro network topology (PURE, worker-safe, ABSOLUTE coordinates, order-independent).
 *
 * A jittered lattice of junction nodes (one per `cell` km², placed at local low points) with sparse seeded edges,
 * plus fixed trunks:
 *  - row j = 0 (i ≥ 1): south-coast nodes chained east forever (coastal highway, with the Coastal Bridge node `bCB`)
 *  - column i = −1 (j ≥ 1): west-coast nodes chained north forever (coastal highway west of the airport)
 *  - column i = 0 (j ≥ 1): the mountain highway north of the city (exit `xN` → (0,1) → (0,2) → …)
 *  - (−1,1)–(0,1): the coastal highway west, passing north of the airport
 *  - city exits `xE` → junction `jCE` → (1,0) (coastal highway east) and the beach-boulevard link `xCE` → `jCE`.
 * Every function here is a pure function of (seed, key) with memo caches (cleared when the seed changes).
 */

export interface V2 {
  x: number;
  z: number;
}
export type NodeKind = 'exit' | 'junction' | 'coast' | 'lattice' | 'bridge';
export type EdgeClass = 'trunk' | 'branch' | 'link';
export type CoastKind = 'south' | 'west' | null;

export interface MNode {
  key: string;
  x: number;
  z: number;
  /** natural ground at the node */
  baseY: number;
  kind: NodeKind;
  name: string;
  i: number;
  j: number;
  /** exits: departure direction into the network */
  fixedDir: V2 | null;
  /** exits / bridge midpoint: road height is fixed */
  fixedY: number | null;
  exitTag?: string;
}

export interface EdgeRef {
  key: string;
  a: string;
  b: string;
  cls: EdgeClass;
  forced: boolean;
  coastal: CoastKind;
  sea: boolean;
  /** optional-edge hash in [0,1) */
  h: number;
}

/** How an edge leaves a node. */
export interface EdgeEnd {
  dir: V2; // unit departure direction (into the edge)
  grade: number; // rise per metre moving away from the node along the edge
  lin: number; // m of exactly linear profile (and straight plan for main edges) from the node
  main: boolean; // through road (straight start) vs branch (peels off)
  fork: number; // m of fork zone (no median / barriers / markings, flat, unbanked) — junctions only
  lanes: number; // lanes per direction at the node
  exit: boolean; // node is a city exit (world road continues)
}

export interface EdgeDesc {
  ref: EdgeRef;
  a: MNode;
  b: MNode;
  ya: number;
  yb: number;
  endA: EdgeEnd;
  endB: EdgeEnd;
  lanes: number;
}

/** City exits (absolute) — must match the world module's CityData.exits (verified at runtime). */
export const EXITS: Record<string, { x: number; y: number; z: number; dir: V2; tag: string; name: string }> = {
  xN: { x: 0, y: 0.03, z: -420, dir: { x: 0, z: -1 }, tag: 'north', name: 'Coastline North' },
  xE: { x: 420, y: 0.03, z: -150, dir: { x: 1, z: 0 }, tag: 'east', name: 'Coastline East' },
  xCE: { x: 394, y: 0, z: 272, dir: { x: 1, z: 0 }, tag: 'coastEast', name: 'Beach Boulevard' },
};

const PLACE_NAMES = [
  'Saltmere', 'Pinecrest', 'Cobalt Bay', 'Highridge', 'Larkspur', 'Marlow Pass', 'Vista Alta', 'Driftwood',
  'Coral Point', 'Ember Falls', 'Northgate', 'Sundown', 'Gullhaven', 'Brightwater', 'Juniper Gap', 'Stonebrook',
  'Aster Vale', 'Redcliff', 'Moonharbor', 'Fernwick', 'Glassmere', 'Kestrel Rock', 'Lumen Ridge', 'Oakhollow',
  'Pebble Cove', 'Quillon', 'Ravensford', 'Silverpine', 'Tidewater', 'Umber Flats', 'Velvet Hills', 'Willowmere',
  'Yarrow Heights', 'Zephyr Point', 'Amberlee', 'Bluehaven', 'Cinder Peak', 'Dunmore', 'Elderglen', 'Foxbridge',
  'Granite Run', 'Hollowell', 'Ivory Coast Rd', 'Jasper Lake', 'Kingsfold', 'Lowtide', 'Mistral', 'Nettlefield',
];

export const cfg = () => CONFIG.highway;

const hash01 = (...v: number[]) => hash32(...v) / 4294967296;

export function parseIJ(key: string): [number, number] | null {
  const c = key.indexOf(',');
  if (c < 0) return null;
  return [Number(key.slice(0, c)), Number(key.slice(c + 1))];
}

const ij = (i: number, j: number) => `${i},${j}`;

export function nodeExistsIJ(i: number, j: number): boolean {
  return (j >= 1 && i >= -1) || (j === 0 && i >= 1);
}

/** Lattice column of the coastal-bridge edge (row 0). */
const bridgeCol = () => Math.max(1, Math.floor(cfg().bridgeCenterX / cfg().cell));

// ───────────────────────────── caches ─────────────────────────────
const nodeCache = new Map<string, MNode>();
const incidentCache = new Map<string, EdgeRef[]>();
const rescueCache = new Map<string, Set<string>>();
const presentCache = new Map<string, EdgeRef[]>();
const yCache = new Map<string, number>();
const frameCache = new Map<string, Map<string, EdgeEnd>>();
const descCache = new Map<string, EdgeDesc>();
onSeedChange(() => {
  nodeCache.clear();
  incidentCache.clear();
  rescueCache.clear();
  presentCache.clear();
  yCache.clear();
  frameCache.clear();
  descCache.clear();
});
function trimCaches(): void {
  // bounded memory for endless travel (workers keep these forever otherwise)
  const lim = 6000;
  for (const m of [nodeCache, incidentCache, rescueCache, presentCache, yCache, frameCache, descCache] as Map<string, unknown>[]) {
    if (m.size > lim) {
      let n = m.size - lim * 0.75;
      for (const k of m.keys()) {
        m.delete(k);
        if (--n <= 0) break;
      }
    }
  }
}

// ───────────────────────────── nodes ─────────────────────────────
export function getNode(key: string): MNode | null {
  const seed = checkSeed();
  const c = nodeCache.get(key);
  if (c) return c;
  const n = buildNode(key, seed);
  if (n) nodeCache.set(key, n);
  return n;
}

function buildNode(key: string, seed: number): MNode | null {
  const C = cfg();
  const ex = EXITS[key];
  if (ex) {
    return { key, x: ex.x, z: ex.z, baseY: ex.y, kind: 'exit', name: ex.name, i: NaN, j: NaN, fixedDir: ex.dir, fixedY: ex.y, exitTag: ex.tag };
  }
  if (key === 'bCB') {
    const x = C.bridgeCenterX;
    const z = coastZAt(x) + C.bridgeOffshore;
    return { key, x, z, baseY: H(x, z), kind: 'bridge', name: 'Coastal Bridge', i: NaN, j: NaN, fixedDir: null, fixedY: C.bridgeDeckY };
  }
  if (key === 'jCE') {
    const x = 1750;
    const z = Math.max(-400, Math.min(60, coastZAt(x) - 300));
    return { key, x, z, baseY: H(x, z), kind: 'junction', name: 'Seaview Junction', i: NaN, j: NaN, fixedDir: null, fixedY: null };
  }
  const p = parseIJ(key);
  if (!p) return null;
  const [i, j] = p;
  if (!nodeExistsIJ(i, j)) return null;
  const cell = C.cell;
  const name = PLACE_NAMES[hash32(seed, 0x4e41, i, j) % PLACE_NAMES.length];
  if (j === 0) {
    const x = i * cell + (hash01(seed, 21, i) * 2 - 1) * 0.08 * cell;
    const z = coastZAt(x) - C.coastInland;
    return { key, x, z, baseY: H(x, z), kind: 'coast', name, i, j, fixedDir: null, fixedY: null };
  }
  if (i === -1) {
    const z = C.rowZ0 - j * cell + (hash01(seed, 22, j) * 2 - 1) * 0.08 * cell;
    const x = coastXAt(z) + C.coastInland;
    return { key, x, z, baseY: H(x, z), kind: 'coast', name, i, j, fixedDir: null, fixedY: null };
  }
  let jit = C.jitter;
  if (i === 0 && j === 1) jit *= 0.3;
  let x0 = i * cell + (hash01(seed, 11, i, j) * 2 - 1) * jit * cell;
  let z0 = C.rowZ0 - j * cell + (hash01(seed, 12, i, j) * 2 - 1) * jit * cell;
  const R = C.lowSearch * (i === 0 && j === 1 ? 0.5 : 1);
  let best = Infinity, bx = x0, bz = z0, by = 0;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      const px = x0 + (a * R) / 2, pz = z0 + (b * R) / 2;
      const h = H(px, pz);
      let v = h + 0.05 * Math.hypot(a, b) * (R / 2);
      if (h < 2) v += 2000; // never in the sea / a lake bed
      if (v < best) {
        best = v;
        bx = px;
        bz = pz;
        by = h;
      }
    }
  }
  x0 = bx;
  z0 = bz;
  return { key, x: x0, z: z0, baseY: by, kind: 'lattice', name, i, j, fixedDir: null, fixedY: null };
}

// ───────────────────────────── edges ─────────────────────────────
function mkEdge(a: string, b: string, cls: EdgeClass, forced: boolean, coastal: CoastKind, sea: boolean, h: number): EdgeRef {
  return { key: `${a}>${b}`, a, b, cls, forced, coastal, sea, h };
}

function latticeEdge(i0: number, j0: number, i1: number, j1: number, seed: number): EdgeRef | null {
  if (!nodeExistsIJ(i0, j0) || !nodeExistsIJ(i1, j1)) return null;
  const a = ij(i0, j0), b = ij(i1, j1);
  const h = hash01(seed, 0x5eed, i0, j0, i1, j1);
  const horiz = j0 === j1;
  if (horiz && j0 === 0) return mkEdge(a, b, 'trunk', true, 'south', false, h); // south coast chain
  if (!horiz && i0 === -1) return mkEdge(a, b, 'trunk', true, 'west', false, h); // west coast chain
  if (horiz && i0 === -1 && j0 === 1) return mkEdge(a, b, 'trunk', true, null, false, h); // coastal west past the airport
  if (!horiz && i0 === 0 && j0 >= 1) return mkEdge(a, b, 'trunk', true, null, false, h); // mountain highway north
  return mkEdge(a, b, 'branch', false, null, false, h);
}

/** All potential edges touching a node (present or not). */
export function incident(key: string): EdgeRef[] {
  const seed = checkSeed();
  const c = incidentCache.get(key);
  if (c) return c;
  const out: EdgeRef[] = [];
  const ib = bridgeCol();
  switch (key) {
    case 'xN':
      out.push(mkEdge('xN', '0,1', 'trunk', true, null, false, 0));
      break;
    case 'xE':
      out.push(mkEdge('xE', 'jCE', 'trunk', true, null, false, 0));
      break;
    case 'xCE':
      out.push(mkEdge('xCE', 'jCE', 'link', true, null, false, 0));
      break;
    case 'jCE':
      out.push(mkEdge('xE', 'jCE', 'trunk', true, null, false, 0));
      out.push(mkEdge('jCE', '1,0', 'trunk', true, 'south', false, 0));
      out.push(mkEdge('xCE', 'jCE', 'link', true, null, false, 0));
      break;
    case 'bCB':
      out.push(mkEdge(ij(ib, 0), 'bCB', 'trunk', true, 'south', true, 0));
      out.push(mkEdge('bCB', ij(ib + 1, 0), 'trunk', true, 'south', true, 0));
      break;
    default: {
      const p = parseIJ(key);
      if (!p || !nodeExistsIJ(p[0], p[1])) break;
      const [i, j] = p;
      // right
      if (j === 0 && i === ib) out.push(mkEdge(key, 'bCB', 'trunk', true, 'south', true, 0));
      else {
        const e = latticeEdge(i, j, i + 1, j, seed);
        if (e) out.push(e);
      }
      // left
      if (j === 0 && i - 1 === ib) out.push(mkEdge('bCB', key, 'trunk', true, 'south', true, 0));
      else if (j === 0 && i === 1) out.push(mkEdge('jCE', key, 'trunk', true, 'south', false, 0));
      else {
        const e = latticeEdge(i - 1, j, i, j, seed);
        if (e) out.push(e);
      }
      // up (north = j + 1)
      {
        const e = latticeEdge(i, j, i, j + 1, seed);
        if (e) out.push(e);
      }
      // down
      if (i === 0 && j === 1) out.push(mkEdge('xN', key, 'trunk', true, null, false, 0));
      else {
        const e = latticeEdge(i, j - 1, i, j, seed);
        if (e) out.push(e);
      }
    }
  }
  incidentCache.set(key, out);
  return out;
}

function rescueSet(key: string): Set<string> {
  const c = rescueCache.get(key);
  if (c) return c;
  const chance = cfg().edgeChance;
  const inc = incident(key);
  let deg0 = 0;
  const absent: EdgeRef[] = [];
  for (const e of inc) {
    if (e.forced || e.h < chance) deg0++;
    else absent.push(e);
  }
  const set = new Set<string>();
  if (deg0 < 2) {
    absent.sort((a, b) => a.h - b.h);
    for (let k = 0; k < Math.min(2 - deg0, absent.length); k++) set.add(absent[k].key);
  }
  rescueCache.set(key, set);
  return set;
}

export function edgePresent(e: EdgeRef): boolean {
  if (e.forced) return true;
  if (e.h < cfg().edgeChance) return true;
  return rescueSet(e.a).has(e.key) || rescueSet(e.b).has(e.key);
}

/** Present edges touching a node. */
export function presentIncident(key: string): EdgeRef[] {
  checkSeed();
  const c = presentCache.get(key);
  if (c) return c;
  const out = incident(key).filter(edgePresent);
  presentCache.set(key, out);
  return out;
}

export function otherEnd(e: EdgeRef, key: string): string {
  return e.a === key ? e.b : e.a;
}

/** Edge by key (null if it does not exist / is not present). */
export function edgeByKey(key: string): EdgeRef | null {
  const k = key.indexOf('>');
  if (k < 0) return null;
  const a = key.slice(0, k);
  for (const e of presentIncident(a)) if (e.key === key) return e;
  return null;
}

// ───────────────────────────── heights ─────────────────────────────
const RELAX_ROUNDS = 4;

function initialY(n: MNode): number {
  if (n.fixedY !== null) return n.fixedY;
  let y = n.baseY;
  if (n.kind === 'coast' || n.key === 'jCE') y = Math.max(y, cfg().coastMinY);
  return Math.max(y, 3);
}

/** Road height at a node (relaxed so neighbouring nodes are reachable within the grade limit). */
export function nodeY(key: string, round = RELAX_ROUNDS): number {
  checkSeed();
  const ck = key + '#' + round;
  const c = yCache.get(ck);
  if (c !== undefined) return c;
  const n = getNode(key)!;
  let y: number;
  if (round === 0 || n.fixedY !== null) y = initialY(n);
  else {
    const y0 = nodeY(key, round - 1);
    let lo = -Infinity, hi = Infinity;
    const G = cfg().designGrade * 0.85;
    for (const e of presentIncident(key)) {
      const o = getNode(otherEnd(e, key));
      if (!o) continue;
      const d = Math.max(200, Math.hypot(o.x - n.x, o.z - n.z) * 1.02 - 480);
      const yo = nodeY(o.key, round - 1);
      lo = Math.max(lo, yo - G * d);
      hi = Math.min(hi, yo + G * d);
    }
    // pull high nodes down (tunnels under mountains) rather than lifting valley nodes onto viaducts
    y = Math.min(y0, hi);
    if (lo <= hi && y < lo) y = lo;
  }
  yCache.set(ck, y);
  return y;
}

// ───────────────────────────── node frames ─────────────────────────────
const CLASS_RANK: Record<EdgeClass, number> = { trunk: 2, branch: 1, link: 0 };

/** Departure direction/grade/linear-zone of every present edge at a node. */
export function nodeFrame(key: string): Map<string, EdgeEnd> {
  checkSeed();
  const c = frameCache.get(key);
  if (c) return c;
  const n = getNode(key)!;
  const C = cfg();
  const edges = presentIncident(key);
  const out = new Map<string, EdgeEnd>();
  const lanesOf = (e: EdgeRef) => (e.cls === 'link' ? 2 : C.lanes);
  const u = edges.map((e) => {
    const o = getNode(otherEnd(e, key))!;
    const dx = o.x - n.x, dz = o.z - n.z, l = Math.hypot(dx, dz) || 1;
    return { e, o, x: dx / l, z: dz / l, d: l };
  });
  if (n.fixedDir) {
    for (const it of u) out.set(it.e.key, { dir: n.fixedDir, grade: 0, lin: 170, main: true, fork: 0, lanes: 2, exit: true });
  } else if (u.length === 1) {
    out.set(u[0].e.key, { dir: { x: u[0].x, z: u[0].z }, grade: 0, lin: 120, main: true, fork: 0, lanes: lanesOf(u[0].e), exit: false });
  } else if (u.length === 2) {
    const [p, q] = u;
    let tx = q.x - p.x, tz = q.z - p.z;
    let tl = Math.hypot(tx, tz);
    if (tl < 1e-3) {
      tx = -p.z;
      tz = p.x;
      tl = 1;
    }
    tx /= tl;
    tz /= tl;
    const yp = nodeY(p.o.key), yq = nodeY(q.o.key);
    const g = Math.max(-0.03, Math.min(0.03, (yq - yp) / (p.d + q.d)));
    out.set(q.e.key, { dir: { x: tx, z: tz }, grade: g, lin: 90, main: true, fork: 0, lanes: lanesOf(q.e), exit: false });
    out.set(p.e.key, { dir: { x: -tx, z: -tz }, grade: -g, lin: 90, main: true, fork: 0, lanes: lanesOf(p.e), exit: false });
  } else {
    // junction: main pair = highest class, most opposite
    let best = -Infinity, bp = 0, bq = 1;
    for (let a = 0; a < u.length; a++)
      for (let b = a + 1; b < u.length; b++) {
        const score = (CLASS_RANK[u[a].e.cls] + CLASS_RANK[u[b].e.cls]) * 10 - (u[a].x * u[b].x + u[a].z * u[b].z);
        if (score > best) {
          best = score;
          bp = a;
          bq = b;
        }
      }
    const p = u[bp], q = u[bq];
    let tx = q.x - p.x, tz = q.z - p.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const FORK = 230;
    out.set(q.e.key, { dir: { x: tx, z: tz }, grade: 0, lin: FORK, main: true, fork: FORK, lanes: lanesOf(q.e), exit: false });
    out.set(p.e.key, { dir: { x: -tx, z: -tz }, grade: 0, lin: FORK, main: true, fork: FORK, lanes: lanesOf(p.e), exit: false });
    const branches = u.filter((_, k) => k !== bp && k !== bq);
    // each branch peels off along +t or −t (whichever is closer to its chord); two branches take opposite sides
    const pref = branches.map((b) => b.x * tx + b.z * tz);
    const sides: number[] = pref.map((d) => (d >= 0 ? 1 : -1));
    if (branches.length >= 2 && sides[0] === sides[1]) {
      if (Math.abs(pref[0]) < Math.abs(pref[1])) sides[0] = -sides[0];
      else sides[1] = -sides[1];
    }
    branches.forEach((b, k) => {
      out.set(b.e.key, { dir: { x: tx * sides[k], z: tz * sides[k] }, grade: 0, lin: FORK, main: false, fork: FORK, lanes: lanesOf(b.e), exit: false });
    });
  }
  frameCache.set(key, out);
  return out;
}

export function edgeDesc(key: string): EdgeDesc | null {
  checkSeed();
  const c = descCache.get(key);
  if (c) return c;
  const ref = edgeByKey(key);
  if (!ref) return null;
  const a = getNode(ref.a), b = getNode(ref.b);
  if (!a || !b) return null;
  const endA = nodeFrame(a.key).get(key)!, endB = nodeFrame(b.key).get(key)!;
  const d: EdgeDesc = { ref, a, b, ya: nodeY(a.key), yb: nodeY(b.key), endA, endB, lanes: ref.cls === 'link' ? 2 : cfg().lanes };
  descCache.set(key, d);
  trimCaches();
  return d;
}

/** Lattice index range covering an absolute rectangle (inclusive). */
export function latticeRange(minX: number, minZ: number, maxX: number, maxZ: number): { i0: number; i1: number; j0: number; j1: number } {
  const C = cfg();
  return {
    i0: Math.floor(minX / C.cell) - 1,
    i1: Math.ceil(maxX / C.cell) + 1,
    j0: Math.floor((C.rowZ0 - maxZ) / C.cell) - 1,
    j1: Math.ceil((C.rowZ0 - minZ) / C.cell) + 1,
  };
}

/** Keys of all present edges whose endpoints' lattice cells intersect the (expanded) rectangle. */
export function edgesNearRect(minX: number, minZ: number, maxX: number, maxZ: number, reach: number): EdgeRef[] {
  checkSeed();
  const r = latticeRange(minX - reach, minZ - reach, maxX + reach, maxZ + reach);
  const seen = new Map<string, EdgeRef>();
  const consider = (key: string) => {
    for (const e of presentIncident(key)) if (!seen.has(e.key)) seen.set(e.key, e);
  };
  for (let j = Math.max(0, r.j0); j <= r.j1; j++)
    for (let i = Math.max(-1, r.i0); i <= r.i1; i++) if (nodeExistsIJ(i, j)) consider(ij(i, j));
  // specials near the city / south coast
  if (minX - reach < 9000 && maxX + reach > -1000 && minZ - reach < 1500 && maxZ + reach > -3500) {
    for (const k of ['xN', 'xE', 'xCE', 'jCE', 'bCB']) consider(k);
  }
  const out: EdgeRef[] = [];
  for (const e of seen.values()) {
    const a = getNode(e.a), b = getNode(e.b);
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const pad = reach + 0.42 * len + 900;
    if (Math.max(a.x, b.x) + pad < minX || Math.min(a.x, b.x) - pad > maxX) continue;
    if (Math.max(a.z, b.z) + pad < minZ || Math.min(a.z, b.z) - pad > maxZ) continue;
    out.push(e);
  }
  return out;
}
