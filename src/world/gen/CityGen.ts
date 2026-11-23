import { CONFIG } from '../../config';
import { chunkIndex, type CityData, type DistrictId, type RoadKind, type Vec3 } from '../types';
import { HeightField, SURF, type SurfCode } from '../HeightField';
import * as L from './layout';
import { buildHighway, buildRampStrips, buildSpur, deckY, nearestS, outward, sampleIndexAt } from './highway';
import { Mat, type BlockType, type CityLayout, type Island, type Strip } from './model';
import { PedBuilder } from './ped';
import { DiscSet, inRoundRect, type GenCtx, type GridNode } from './ctx';
import { genBlockBuildings, type BuildingOut } from './buildings';
import { furnish } from './furnish';
import { generateAirport, type PavedRect } from './airport';

/**
 * Deterministic city generator (pure data, no three.js). All coordinates are ABSOLUTE (generation frame); the World
 * converts to local (floating origin) at query time and CityData is shifted in place by core.
 */
export function generateCity(seed: number): { layout: CityLayout; hf: HeightField; ctx: GenCtx } {
  const size = CONFIG.world.size;
  const chunkSize = CONFIG.world.chunkSize;
  const chunkOf = (x: number, z: number) => chunkIndex(x, z, size, chunkSize);

  const data: CityData = {
    seed,
    size,
    chunkSize,
    chunksPerSide: Math.ceil(size / chunkSize),
    roads: { nodes: [], edges: [] },
    ped: { nodes: [], edges: [] },
    benches: [],
    busStops: [],
    wanderAreas: [],
    groupSpots: [],
    buildings: [],
    props: [],
    parkedCars: [],
    spawn: { position: { x: L.HUB.spawnX, y: L.ISLAND_TOP, z: L.HUB.aisleZ }, yaw: Math.PI / 2 },
    garage: { position: { x: L.HUB.garage.x1, y: L.ISLAND_TOP, z: L.HUB.aisleZ }, yaw: Math.PI / 2 },
    jumpRamp: { position: { x: L.JUMP.straightX0 - 10, y: 0.03, z: L.JUMP.z }, yaw: Math.PI / 2 },
    coast: { seaWallZ: L.SEA_WALL_Z, shoreZ: L.SHORE_Z },
    districtGrid: [],
    districtGridSize: Math.round(size / 10),
  };

  const layout: CityLayout = {
    data,
    islands: [],
    segs: [],
    asphalt: [],
    decals: [],
    discs: [],
    ribbons: [],
    solids: [],
    cylinders: [],
    boxParts: [],
    roofs: [],
    tanks: [],
    highway: buildHighway(),
    strips: [],
    noRespawnEdges: new Set(),
    hwEdges: new Set(),
    edgeLaneOffset: new Map(),
    airport: null,
  };

  // ───────────────────────────── road graph helpers ─────────────────────────────
  const R = data.roads;
  const addNode = (x: number, y: number, z: number): number => {
    const id = R.nodes.length;
    R.nodes.push({ id, p: { x, y, z }, kind: 'end', trafficLight: false, edges: [] });
    return id;
  };
  const addEdge = (a: number, b: number, kind: RoadKind, lanes: number, width: number, sidewalk: number, points: Vec3[], oneWay: boolean, speed: number, laneOff: number): number => {
    const id = R.edges.length;
    R.edges.push({ id, a, b, kind, lanes, width, sidewalk, points, oneWay, speedLimitKmh: speed });
    R.nodes[a].edges.push(id);
    R.nodes[b].edges.push(id);
    layout.edgeLaneOffset.set(id, laneOff);
    return id;
  };
  const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

  // ───────────────────────────── street grid ─────────────────────────────
  const NX = L.X_LINES.length, NZ = L.Z_LINES.length;
  const internal = (c: { i0: number; i1: number; j0: number; j1: number }, axis: 'x' | 'z', line: number, cell: number) =>
    axis === 'x' ? line > c.i0 && line <= c.i1 && cell >= c.j0 && cell <= c.j1 : line > c.j0 && line <= c.j1 && cell >= c.i0 && cell <= c.i1;
  const segX = (i: number, j: number) => j >= 0 && j < NZ - 1 && !internal(L.PARK_CELLS, 'x', i, j) && !internal(L.HUB_CELLS, 'x', i, j);
  const segZ = (j: number, i: number) => {
    if (j === L.BEACH_LINE && (i === -1 || i === NX - 1)) return true; // beach boulevard extensions
    return i >= 0 && i < NX - 1 && !internal(L.PARK_CELLS, 'z', j, i) && !internal(L.HUB_CELLS, 'z', j, i);
  };

  const grid: (GridNode | null)[][] = [];
  for (let i = 0; i < NX; i++) {
    grid.push([]);
    for (let j = 0; j < NZ; j++) {
      const arms: [boolean, boolean, boolean, boolean] = [segX(i, j - 1), segZ(j, i), segX(i, j), segZ(j, i - 1)];
      if (!arms.some(Boolean)) {
        grid[i].push(null);
        continue;
      }
      const px = L.X_PROF[i], pz = L.Z_PROF[j];
      const x = L.X_LINES[i], z = L.Z_LINES[j];
      const id = addNode(x, L.ROAD_Y, z);
      const major = (p: L.StreetProfile) => p.kind === 'boulevard' || p.kind === 'street4';
      const nArms = arms.filter(Boolean).length;
      const signal = nArms >= 3 && (px.kind === 'boulevard' || pz.kind === 'boulevard' || (major(px) && major(pz)));
      grid[i].push({ id, i, j, x, z, arms, hx: L.halfW(px), hz: L.halfW(pz), swX: px.sw, swZ: pz.sw, signal });
      R.nodes[id].trafficLight = signal;
    }
  }
  // beach boulevard extension end nodes
  const extW = addNode(-L.BEACH_EXT_X, L.ROAD_Y, L.Z_LINES[L.BEACH_LINE]);
  const extE = addNode(L.BEACH_EXT_X, L.ROAD_Y, L.Z_LINES[L.BEACH_LINE]);

  // split points (mid-street junctions): ramps + hub driveway
  interface Split { axis: 'x' | 'z'; line: number; seg: number; at: number; node: number }
  const splits: Split[] = [];
  const rampNodes: number[] = [];
  for (const r of L.RAMPS) {
    const node = addNode(r.jx, L.ROAD_Y, r.jz);
    rampNodes.push(node);
    if (r.dz === 0) {
      const line = L.X_LINES.indexOf(r.jx);
      const seg = L.Z_LINES.findIndex((z, k) => k < NZ - 1 && r.jz > z && r.jz < L.Z_LINES[k + 1]);
      splits.push({ axis: 'x', line, seg, at: r.jz, node });
    } else {
      const line = L.Z_LINES.indexOf(r.jz);
      const seg = L.X_LINES.findIndex((x, k) => k < NX - 1 && r.jx > x && r.jx < L.X_LINES[k + 1]);
      splits.push({ axis: 'z', line, seg, at: r.jx, node });
    }
  }
  const hubMainNode = addNode(L.HUB.southDriveX, L.ROAD_Y, L.Z_LINES[4]);
  splits.push({ axis: 'z', line: 4, seg: L.X_LINES.findIndex((x, k) => L.HUB.southDriveX > x && L.HUB.southDriveX < L.X_LINES[k + 1]), at: L.HUB.southDriveX, node: hubMainNode });

  const crosswalkAt = (g: GridNode | null): boolean => {
    if (!g) return false;
    const n = g.arms.filter(Boolean).length;
    if (n >= 3) return true;
    return n === 2 && !((g.arms[0] && g.arms[2]) || (g.arms[1] && g.arms[3]));
  };

  const makeSegs = (axis: 'x' | 'z', line: number, seg: number, prof: L.StreetProfile, c: number, a: number, b: number, nA: number, nB: number, gA: GridNode | null, gB: GridNode | null) => {
    const pts: { at: number; node: number; g: GridNode | null }[] = [{ at: a, node: nA, g: gA }];
    for (const s of splits) if (s.axis === axis && s.line === line && s.seg === seg) pts.push({ at: s.at, node: s.node, g: null });
    pts.push({ at: b, node: nB, g: gB });
    pts.sort((p, q) => p.at - q.at);
    for (let k = 0; k + 1 < pts.length; k++) {
      const A = pts[k], B = pts[k + 1];
      const P = (t: number) => (axis === 'x' ? v3(c, L.ROAD_Y, t) : v3(t, L.ROAD_Y, c));
      const edge = addEdge(A.node, B.node, prof.kind, prof.lanes, 2 * L.halfW(prof), prof.sw, [P(A.at), P(B.at)], false, prof.speed, L.innerLaneOffset(prof));
      const boxOf = (g: GridNode | null) => (g ? (axis === 'x' ? g.hz : g.hx) : 0);
      const swOf = (g: GridNode | null) => (g ? (axis === 'x' ? g.swZ : g.swX) : 0);
      layout.segs.push({
        id: layout.segs.length, axis, c, a: A.at, b: B.at, prof, nodeA: A.node, nodeB: B.node, edge,
        boxA: boxOf(A.g), boxB: boxOf(B.g), xwalkA: crosswalkAt(A.g), xwalkB: crosswalkAt(B.g), swA: swOf(A.g), swB: swOf(B.g),
      });
    }
  };
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NZ - 1; j++)
      if (segX(i, j)) makeSegs('x', i, j, L.X_PROF[i], L.X_LINES[i], L.Z_LINES[j], L.Z_LINES[j + 1], grid[i][j]!.id, grid[i][j + 1]!.id, grid[i][j], grid[i][j + 1]);
  for (let j = 0; j < NZ; j++)
    for (let i = -1; i < NX; i++) {
      if (!segZ(j, i)) continue;
      const xa = i < 0 ? -L.BEACH_EXT_X : L.X_LINES[i];
      const xb = i >= NX - 1 ? L.BEACH_EXT_X : L.X_LINES[i + 1];
      const nA = i < 0 ? extW : grid[i][j]!.id;
      const nB = i >= NX - 1 ? extE : grid[i + 1][j]!.id;
      makeSegs('z', j, i, L.Z_PROF[j], L.Z_LINES[j], xa, xb, nA, nB, i < 0 ? null : grid[i][j], i >= NX - 1 ? null : grid[i + 1][j]);
    }

  // ───────────────────────────── highway loop + ramps + spur ─────────────────────────────
  const hw = layout.highway;
  const ramps = buildRampStrips();
  const spur = buildSpur();
  for (const r of ramps) layout.strips.push(r.strip);
  for (const s of spur.strips) layout.strips.push(s);
  const hwJunctions: { s: number; tag: string }[] = [];
  for (const r of ramps) hwJunctions.push({ s: nearestS(hw, r.def.mx, r.def.mz), tag: 'ramp:' + r.def.name });
  hwJunctions.push({ s: nearestS(hw, L.JUMP.divergeX, L.HW.zNorth), tag: 'spurA' });
  hwJunctions.push({ s: nearestS(hw, L.JUMP.mergeX, L.HW.zNorth), tag: 'spurB' });
  // city exits (where external highways attach): north + east + west from the loop; the beach boulevard ends are the
  // coastal exits (east along the south coast, west toward the airport)
  const exitDefs = [
    { tag: 'north', x: 0, z: L.HW.zNorth, dir: v3(0, 0, -1) },
    { tag: 'east', x: L.HW.xEdge, z: -150, dir: v3(1, 0, 0) },
    { tag: 'west', x: -L.HW.xEdge, z: -150, dir: v3(-1, 0, 0) },
  ];
  for (const e of exitDefs) hwJunctions.push({ s: nearestS(hw, e.x, e.z), tag: 'exit:' + e.tag });
  hwJunctions.sort((a, b) => a.s - b.s);
  const hwNodeByTag = new Map<string, number>();
  const hwNodeIds: number[] = [];
  for (const j of hwJunctions) {
    const smp = hw.samples[sampleIndexAt(hw, j.s)];
    const id = addNode(smp.x, deckY(smp, 0), smp.z);
    hwNodeByTag.set(j.tag, id);
    hwNodeIds.push(id);
  }
  const nS = hw.samples.length;
  for (let k = 0; k < hwJunctions.length; k++) {
    const i0 = sampleIndexAt(hw, hwJunctions[k].s);
    const i1 = sampleIndexAt(hw, hwJunctions[(k + 1) % hwJunctions.length].s);
    const pts: Vec3[] = [];
    let i = i0;
    for (let guard = 0; guard <= nS; guard++) {
      const smp = hw.samples[i];
      pts.push(v3(smp.x, deckY(smp, 0), smp.z));
      if (i === i1 && guard > 0) break;
      i = (i + 1) % nS;
    }
    const e = addEdge(hwNodeIds[k], hwNodeIds[(k + 1) % hwNodeIds.length], 'highway', 4, 2 * L.HW.halfW, 0, pts, false, 110, L.HW.laneW / 2);
    layout.hwEdges.add(e);
  }
  // ramps: street junction → highway junction
  ramps.forEach((r, k) => {
    const pts: Vec3[] = [v3(r.def.jx, 0, r.def.jz)];
    for (const [x, z] of r.path) pts.push(v3(x, 0.012, z));
    const hn = hwNodeByTag.get('ramp:' + r.def.name)!;
    pts.push({ ...R.nodes[hn].p });
    addEdge(rampNodes[k], hn, 'ramp', 2, 2 * L.RAMP_HALFW, 0, pts, false, 60, 1.8);
    const s = nearestS(hw, r.def.mx, r.def.mz);
    hw.innerGaps.push([s - (r.def.name === 'north' ? 45 : 62), s + 10]);
  });
  // spur
  {
    const a = hwNodeByTag.get('spurA')!, b = hwNodeByTag.get('spurB')!;
    const pts: Vec3[] = [{ ...R.nodes[a].p }, ...spur.path.map(([x, y, z]) => v3(x, y, z)), { ...R.nodes[b].p }];
    const e = addEdge(a, b, 'ramp', 2, 2 * L.JUMP.halfW, 0, pts, true, 90, 1.8);
    layout.noRespawnEdges.add(e);
    hw.innerGaps.push([nearestS(hw, L.JUMP.divergeX, L.HW.zNorth) - 4, nearestS(hw, L.JUMP.divergeX + 45, L.HW.zNorth)]);
    hw.innerGaps.push([nearestS(hw, L.JUMP.mergeX - 45, L.HW.zNorth), nearestS(hw, L.JUMP.mergeX, L.HW.zNorth) + 4]);
  }
  // exits: short stubs from the loop to the city bounds; the external highway network attaches at the stub end
  const cb = CONFIG.world.cityBounds;
  data.exits = [];
  for (const e of exitDefs) {
    const hn = hwNodeByTag.get('exit:' + e.tag)!;
    const p = R.nodes[hn].p;
    const endX = e.dir.x > 0 ? cb.maxX : e.dir.x < 0 ? cb.minX : p.x;
    const endZ = e.dir.z < 0 ? cb.minZ : e.dir.z > 0 ? cb.maxZ : p.z;
    const end = addNode(endX, L.HW.gradeY, endZ);
    const pts: Vec3[] = [];
    const n = 6;
    for (let k = 0; k <= n; k++) pts.push(v3(p.x + ((endX - p.x) * k) / n, L.HW.gradeY, p.z + ((endZ - p.z) * k) / n));
    const ed = addEdge(hn, end, 'highway', 4, 2 * L.HW.halfW, 0, pts, false, 110, L.HW.laneW / 2);
    layout.hwEdges.add(ed);
    data.exits.push({ node: end, dir: e.dir, tag: e.tag });
    // stub strip from the loop's outer edge to the bounds + outer-barrier gap in the loop
    const sp: number[] = [];
    const sx = p.x + e.dir.x * (L.HW.halfW - 0.6), sz = p.z + e.dir.z * (L.HW.halfW - 0.6);
    for (let k = 0; k <= n; k++) sp.push(sx + ((endX - sx) * k) / n, 0.02, sz + ((endZ - sz) * k) / n);
    layout.strips.push({ pts: sp, halfW: L.HW.halfW, solid: false, paint: 3, capStart: false, capEnd: false });
    const s = nearestS(hw, p.x, p.z);
    hw.outerGaps.push([s - 11, s + 11]);
  }
  data.exits.push({ node: extE, dir: v3(1, 0, 0), tag: 'coastEast' });
  data.exits.push({ node: extW, dir: v3(-1, 0, 0), tag: 'coastWest' });

  // hub lot roads
  const jE = rampNodes[0];
  const nG = addNode(L.HUB.spawnX, L.ISLAND_TOP, L.HUB.aisleZ);
  const nA = addNode(L.HUB.southDriveX, L.ISLAND_TOP, L.HUB.aisleZ);
  const hubMaxX = L.X_LINES[9] - L.halfW(L.P_STREET2);
  const hubMaxZ = L.Z_LINES[4] - L.halfW(L.P_BOULEVARD);
  addEdge(nG, nA, 'lot', 2, 7, 0, [v3(L.HUB.spawnX, L.ISLAND_TOP, L.HUB.aisleZ), v3(L.HUB.southDriveX, L.ISLAND_TOP, L.HUB.aisleZ)], false, 15, 1.75);
  addEdge(nA, jE, 'lot', 2, 7, 0, [v3(L.HUB.southDriveX, L.ISLAND_TOP, L.HUB.aisleZ), v3(hubMaxX, L.ISLAND_TOP, L.HUB.aisleZ), v3(L.X_LINES[9], 0, L.HUB.aisleZ)], false, 15, 1.75);
  addEdge(nA, hubMainNode, 'lot', 2, 7, 0, [v3(L.HUB.southDriveX, L.ISLAND_TOP, L.HUB.aisleZ), v3(L.HUB.southDriveX, L.ISLAND_TOP, hubMaxZ), v3(L.HUB.southDriveX, 0, L.Z_LINES[4])], false, 15, 1.75);


  // ───────────────────────────── islands ─────────────────────────────
  const blockType = (i: number, j: number): BlockType => {
    const inC = (c: { i0: number; i1: number; j0: number; j1: number }) => i >= c.i0 && i <= c.i1 && j >= c.j0 && j <= c.j1;
    if (inC(L.PARK_CELLS)) return 'park';
    if (inC(L.HUB_CELLS)) return 'hub';
    if (i === L.PLAZA_CELL.i && j === L.PLAZA_CELL.j) return 'plaza';
    if (j === 7) return 'hotel';
    if (j === 6) return i >= 2 && i <= 6 ? 'mixed' : 'house';
    if (i >= 3 && i <= 5) return j === 0 ? 'midrise' : 'tower';
    if (i === 2 || i === 6) return 'midrise';
    return 'house';
  };
  const districtOf = (b: BlockType): DistrictId =>
    b === 'park' ? 'park' : b === 'hub' ? 'hub' : b === 'hotel' ? 'beach' : b === 'house' ? 'residential' : 'downtown';
  const interiorOf = (b: BlockType) =>
    b === 'park' ? ('park' as const) : b === 'hub' ? ('lot' as const) : b === 'house' ? ('yard' as const) : b === 'plaza' ? ('plaza' as const) : ('concrete' as const);
  let islandId = 0;
  const blockIslands: Island[] = [];
  let park!: Island, plaza!: Island, hub!: Island;
  for (let j = 0; j < NZ - 1; j++)
    for (let i = 0; i < NX - 1; i++) {
      let c = { i0: i, i1: i, j0: j, j1: j };
      for (const m of [L.PARK_CELLS, L.HUB_CELLS]) {
        if (i >= m.i0 && i <= m.i1 && j >= m.j0 && j <= m.j1) c = m;
      }
      if (c.i0 !== i || c.j0 !== j) continue;
      const b = blockType(i, j);
      const isl: Island = {
        id: islandId++,
        kind: 'block',
        minX: L.X_LINES[c.i0] + L.halfW(L.X_PROF[c.i0]),
        maxX: L.X_LINES[c.i1 + 1] - L.halfW(L.X_PROF[c.i1 + 1]),
        minZ: L.Z_LINES[c.j0] + L.halfW(L.Z_PROF[c.j0]),
        maxZ: L.Z_LINES[c.j1 + 1] - L.halfW(L.Z_PROF[c.j1 + 1]),
        r: L.ISLAND_R,
        top: L.ISLAND_TOP,
        sw: [L.Z_PROF[c.j0].sw, L.X_PROF[c.i1 + 1].sw, L.Z_PROF[c.j1 + 1].sw, L.X_PROF[c.i0].sw],
        interior: interiorOf(b),
        block: b,
        district: districtOf(b),
      };
      blockIslands.push(isl);
      layout.islands.push(isl);
      if (b === 'park') park = isl;
      if (b === 'plaza') plaza = isl;
      if (b === 'hub') hub = isl;
    }
  // medians
  for (const s of layout.segs) {
    if (s.prof.median <= 0) continue;
    const clA = s.boxA > 0 ? s.boxA + (s.xwalkA ? s.swA / 2 + 2.6 : 3) : 7;
    const clB = s.boxB > 0 ? s.boxB + (s.xwalkB ? s.swB / 2 + 2.6 : 3) : 7;
    const a = s.a + clA, b = s.b - clB;
    if (b - a < 6) continue;
    const hm = s.prof.median / 2;
    const isl: Island = {
      id: islandId++, kind: 'median',
      minX: s.axis === 'x' ? s.c - hm : a, maxX: s.axis === 'x' ? s.c + hm : b,
      minZ: s.axis === 'x' ? a : s.c - hm, maxZ: s.axis === 'x' ? b : s.c + hm,
      r: Math.min(1.6, hm), top: L.ISLAND_TOP, sw: [0, 0, 0, 0],
      interior: s.prof === L.P_VIADUCT ? 'concrete' : 'grass', block: 'none', district: s.prof === L.P_BEACH ? 'beach' : 'downtown',
    };
    layout.islands.push(isl);
  }
  // edge verges (outer curb strips) with gaps for the ramps
  const hwE = L.halfW(L.P_STREET2);
  const vw = 1.4;
  const xW = L.X_LINES[0] - hwE, xE = L.X_LINES[NX - 1] + hwE;
  const zN = L.Z_LINES[0] - hwE, zBeachN = L.Z_LINES[L.BEACH_LINE] - L.halfW(L.P_BEACH);
  const verge = (minX: number, maxX: number, minZ: number, maxZ: number) => {
    if (maxX - minX < 1 || maxZ - minZ < 1) return;
    layout.islands.push({ id: islandId++, kind: 'verge', minX, maxX, minZ, maxZ, r: 0.5, top: L.ISLAND_TOP, sw: [0, 0, 0, 0], interior: 'grass', block: 'none', district: 'residential' });
  };
  const gapsAlong = (lo: number, hi: number, gaps: number[], gw: number): [number, number][] => {
    const out: [number, number][] = [];
    let cur = lo;
    for (const g of gaps.sort((p, q) => p - q)) {
      out.push([cur, g - gw]);
      cur = g + gw;
    }
    out.push([cur, hi]);
    return out;
  };
  const exitWZ = R.nodes[hwNodeByTag.get('exit:west')!].p.z;
  void exitWZ;
  for (const [a, b] of gapsAlong(zN, zBeachN - vw, [L.RAMPS[1].jz], 11)) verge(xW - vw, xW, a, b);
  for (const [a, b] of gapsAlong(zN, zBeachN - vw, [L.RAMPS[0].jz], 11)) verge(xE, xE + vw, a, b);
  for (const [a, b] of gapsAlong(xW - vw, xE + vw, [L.RAMPS[2].jx], 11)) verge(a, b, zN - vw, zN);
  verge(-L.BEACH_EXT_X, xW, zBeachN - vw, zBeachN);
  verge(xE, L.BEACH_EXT_X, zBeachN - vw, zBeachN);
  // promenade
  const promenade: Island = {
    id: islandId++, kind: 'promenade', minX: -L.BEACH_EXT_X, maxX: L.BEACH_EXT_X,
    minZ: L.Z_LINES[L.BEACH_LINE] + L.halfW(L.P_BEACH), maxZ: L.PROMENADE_MAXZ,
    r: 0.5, top: L.ISLAND_TOP, sw: [L.P_BEACH.sw, 0, 0, 0], interior: 'plaza', block: 'none', district: 'beach',
  };
  layout.islands.push(promenade);

  layout.asphalt.push([xW, xE, zN, L.Z_LINES[L.BEACH_LINE] + L.halfW(L.P_BEACH)]);
  layout.asphalt.push([-L.BEACH_EXT_X, L.BEACH_EXT_X, zBeachN, L.Z_LINES[L.BEACH_LINE] + L.halfW(L.P_BEACH)]);

  // ───────────────────────────── airport ─────────────────────────────
  const ped = new PedBuilder();
  const airport = generateAirport(seed, data, ped, addNode,
    (a, b, kind, lanes, width, sw, pts, speed, laneOff) => addEdge(a, b, kind, lanes, width, sw, pts, false, speed, laneOff), chunkOf);
  layout.airport = airport;
  data.airport = airport.data;
  for (const isl of airport.islands) layout.islands.push(isl);
  for (const n of R.nodes) n.kind = n.edges.length >= 3 ? 'intersection' : n.edges.length === 2 ? 'junction' : 'end';

  // ───────────────────────────── height field ─────────────────────────────
  const inAsphalt = (x: number, z: number) => layout.asphalt.some(([a, b, c, d]) => x >= a && x <= b && z >= c && z <= d);
  const AB = CONFIG.world.airportBounds;
  const paved = (x: number, z: number): PavedRect | null => {
    if (x < AB.minX || x > AB.maxX || z < AB.minZ || z > AB.maxZ) return null;
    let hit: PavedRect | null = null;
    for (const r of airport.paved) {
      const px = x - r.cx, pz = z - r.cz;
      if (Math.abs(px * r.dx + pz * r.dz) <= r.hl && Math.abs(-px * r.dz + pz * r.dx) <= r.hw) hit = r;
    }
    return hit;
  };
  const hf = new HeightField(
    (x, z) => {
      if (x >= AB.minX && x <= AB.maxX && z >= AB.minZ && z <= AB.maxZ) return airport.data.elevation;
      return z < L.BEACH_START_Z || x < cb.minX - 1 || x > cb.maxX + 1 ? 0 : L.beachHeight(x, z);
    },
    (x, z): SurfCode => {
      if (z >= L.BEACH_START_Z && x >= cb.minX && x <= cb.maxX) return L.beachHeight(x, z) < -0.03 ? SURF.water : SURF.sand;
      if (inAsphalt(x, z)) return SURF.asphalt;
      const p = paved(x, z);
      return p ? (p.surf === 'concrete' ? SURF.concrete : SURF.asphalt) : SURF.grass;
    },
  );
  // allocate the whole city footprint so tile queries are uniform
  hf.forCells(cb.minX, cb.maxX - 0.01, cb.minZ, cb.maxZ - 0.01, () => {});
  for (const isl of layout.islands) {
    hf.forCells(isl.minX, isl.maxX, isl.minZ, isl.maxZ, (x, z, idx, g, s) => {
      if (!inRoundRect(isl, x, z)) return;
      g[idx] = isl.top;
      const [sn, se, ss, sw] = isl.sw;
      const band = z < isl.minZ + sn || x > isl.maxX - se || z > isl.maxZ - ss || x < isl.minX + sw;
      if (band) s[idx] = SURF.concrete;
      else if (isl.kind === 'verge') s[idx] = SURF.grass;
      else if (isl.interior === 'grass' || isl.interior === 'yard' || isl.interior === 'park') s[idx] = SURF.grass;
      else if (isl.interior === 'lot') s[idx] = SURF.asphalt;
      else s[idx] = SURF.concrete;
    });
  }
  // sea wall cells
  hf.forCells(-L.BEACH_EXT_X - 6, L.BEACH_EXT_X + 6, L.PROMENADE_MAXZ, L.BEACH_START_Z, (_x, _z, idx, g, s) => {
    g[idx] = L.SAND_TOP;
    s[idx] = SURF.concrete;
  });
  rasterHighway(hf, layout);
  for (const st of layout.strips) rasterStrip(hf, st);

  // ───────────────────────────── context + furnishing ─────────────────────────────
  const ctx: GenCtx = {
    seed, size, chunkSize, chunkOf, data, layout, hf, ped, grid, blockIslands, promenade, park, plaza, hub,
    space: new DiscSet(8), noPark: new DiscSet(8), wallGaps: [],
  };

  // buildings
  const bout: BuildingOut = { lots: data.buildings, parts: layout.boxParts, roofs: layout.roofs, tanks: layout.tanks, decals: layout.decals, yardSpots: [] };
  const blocked = (x0: number, x1: number, z0: number, z1: number) => {
    for (let z = z0 - 2.5; z <= z1 + 2.5; z += 2)
      for (let x = x0 - 2.5; x <= x1 + 2.5; x += 2) if (!Number.isNaN(hf.upperHeight(x, z))) return true;
    return false;
  };
  for (const isl of blockIslands) genBlockBuildings(isl, seed, bout, chunkOf, blocked);
  for (const b of data.buildings) {
    // reserve building footprints so furniture never ends up inside a building
    const r = Math.min(b.w, b.d) / 2;
    ctx.space.add(b.x, b.z, Math.max(1, r - 0.5));
  }
  stuntRamps(ctx);
  concertGrounds(ctx);
  furnish(ctx, bout.yardSpots);
  ped.finalize();
  data.ped.nodes = ped.nodes;
  data.ped.edges = ped.edges;

  // ───────────────────────────── points of interest (on-road poses) ─────────────────────────────
  const pose = (x: number, y: number, z: number, yaw: number) => ({ position: { x, y, z }, yaw });
  data.pois = [
    { id: 'garage', name: 'Garage', pose: { position: { ...data.spawn.position }, yaw: data.spawn.yaw } },
    { id: 'airport', name: 'Airport', pose: { position: { ...data.airport!.carPark.position }, yaw: data.airport!.carPark.yaw } },
    { id: 'beach', name: 'Beach', pose: pose(60, 0, L.Z_LINES[L.BEACH_LINE] + L.P_BEACH.median / 2 + L.P_BEACH.laneW / 2, Math.PI / 2) },
    { id: 'downtown', name: 'Downtown', pose: pose(-35 + L.P_STREET4.laneW / 2, 0, -48, Math.PI) },
    { id: 'park', name: 'Park', pose: pose(-105 + L.P_BOULEVARD.median / 2 + L.P_BOULEVARD.laneW / 2, 0, -120, Math.PI) },
    { id: 'highway', name: 'Highway Interchange', pose: pose(L.HW.xEdge - L.HW.laneW / 2, L.HW.gradeY, -120, 0) },
    { id: 'jump', name: 'Big Jump', pose: { position: { ...data.jumpRamp!.position }, yaw: data.jumpRamp!.yaw } },
  ];
  if (data.concert) {
    // on the sand behind the crowd, facing the stage (city POI → always teleportable)
    const c = data.concert;
    const px = c.floor.maxX + 9, pz = c.stage.z;
    data.pois.push({ id: 'concert', name: 'Concert', pose: pose(px, L.beachHeight(px, pz) + 0.3, pz, c.stage.yaw + Math.PI) });
  }

  // ───────────────────────────── district grid ─────────────────────────────
  const dg = data.districtGridSize;
  const cell = size / dg;
  for (let iz = 0; iz < dg; iz++)
    for (let ix = 0; ix < dg; ix++) {
      const x = -size / 2 + (ix + 0.5) * cell, z = -size / 2 + (iz + 0.5) * cell;
      data.districtGrid.push(districtAtPoint(layout, hf, blockIslands, x, z));
    }
  return { layout, hf, ctx };
}

/**
 * The beach CONCERT at the west end of the beach: a stage facing east along the sand (deck, LED wall, truss roof,
 * speaker stacks, crowd barrier — all solid), the crowd floor in front of it (NPC module fills it, the stage
 * renderer adds the screen / lights / banner, audio plays the show).
 */
function concertGrounds(ctx: GenCtx): void {
  const { layout, data } = ctx;
  const zc = (L.BEACH_START_Z + L.SHORE_Z) / 2;
  const yaw = Math.PI / 2; // faces +X
  const st = { x: -366, w: 22, d: 12, base: -0.5, top: 1.8 };
  const x0 = st.x - st.d / 2, x1 = st.x + st.d / 2;
  const z0 = zc - st.w / 2, z1 = zc + st.w / 2;
  const box = (cx: number, cy: number, cz: number, w: number, h: number, d: number, col: number, mat: number) =>
    layout.solids.push({ cx, cy, cz, w, h, d, yaw: 0, col, mat, collide: true });
  box(st.x, st.base, zc, st.d, st.top - st.base, st.w, 0x3a3d4c, Mat.Plain); // deck
  box(x1 - 0.15, st.top - 0.02, zc, 0.3, 0.06, st.w, 0xffd166, Mat.Paint); // deck edge stripe
  box(x0 - 0.6, st.base, zc, 1.2, 13.5 - st.base, st.w + 4, 0x2a2c3a, Mat.Plain); // back wall (LED screen frame)
  for (const px of [x0 - 0.1, x1 + 0.5]) for (const pz of [z0 - 1.1, z1 + 1.1]) box(px, st.base, pz, 0.9, 14 - st.base, 0.9, 0xd9dde6, Mat.Metal); // truss towers
  box(st.x - 0.1, 14, zc, st.d + 2.2, 1.6, st.w + 3.4, 0xff7a6b, Mat.Paint); // roof
  for (const pz of [z0 - 3.4, z1 + 3.4]) {
    box(x1 - 1.6, st.base, pz, 3.2, 9 - st.base, 3.2, 0x23252e, Mat.Plain); // speaker stack
    box(x1 - 1.6, 9, pz, 3.4, 0.4, 3.4, 0x5cc8d6, Mat.Paint);
  }
  box(x1 + 3.2, -0.4, zc, 0.35, 1.5, st.w + 6, 0xdfe3ea, Mat.Metal); // crowd barrier
  const floor = { minX: x1 + 4.6, maxX: x1 + 4.6 + 62, minZ: L.BEACH_START_Z + 2.2, maxZ: L.SHORE_Z - 2.4, y: L.SAND_TOP * 0.5 };
  data.concert = {
    stage: { x: st.x, y: 0, z: zc, yaw, w: st.w, d: st.d, top: st.top },
    screen: { x: x0 + 0.02, y: 8, z: zc, w: 19, h: 8.6 },
    floor,
    bounds: { minX: x0 - 2, maxX: floor.maxX, minZ: L.BEACH_START_Z, maxZ: L.SHORE_Z },
  };
  // keep furniture / random spots off the grounds
  for (let x = x0 - 2; x <= floor.maxX + 20; x += 6) for (let z = L.BEACH_START_Z + 2; z <= L.SHORE_Z; z += 6) ctx.space.add(x, z, 3.5);
}

/** A few hand-placed stunt kickers around the city (wedge solids + raster heights + warning signs). */
function stuntRamps(ctx: GenCtx): void {
  const { layout, hf, data } = ctx;
  const ramps: { x: number; z: number; yaw: number; w: number; d: number; h: number; col: number; base?: number }[] = [
    // beach: launch south off the sand into the shallows
    { x: 150, z: 312, yaw: 0, w: 7, d: 11, h: 2.4, col: 0xc9a172 },
    { x: -205, z: 312, yaw: 0, w: 7, d: 11, h: 2.4, col: 0xc9a172 },
    // park lawn: hop over the pond
    { x: -178.5 - 33, z: -118.5, yaw: Math.PI / 2, w: 6, d: 9, h: 2.0, col: 0xb08a5c, base: L.ISLAND_TOP },
    // highway west straight: shoulder kicker (outer side, northbound)
    { x: -L.HW.xEdge - 6.5, z: -60, yaw: Math.PI, w: 4.5, d: 12, h: 1.8, col: 0xffd166, base: L.HW.gradeY },
  ];
  for (const r of ramps) {
    const base = r.base ?? (r.z > L.BEACH_START_Z ? L.beachHeight(r.x, r.z) - 0.15 : 0);
    layout.solids.push({ cx: r.x, cy: base, cz: r.z, w: r.w, h: r.h, d: r.d, yaw: r.yaw, col: r.col, mat: Mat.Concrete, collide: true, h0: 0 });
    // stripes on top
    const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
    for (let k = 0; k < 3; k++) {
      const t = (k - 1) * (r.d / 3.2);
      const y = base + r.h * (0.5 + t / r.d) + 0.03;
      layout.decals.push({ cx: r.x + fx * t, cz: r.z + fz * t, dx: -fz, dz: fx, hl: r.w / 2 - 0.3, hw: 0.25, y, col: 0x2b2d33, mat: Mat.Paint });
    }
    const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
    hf.forCells(r.x - r.d, r.x + r.d, r.z - r.d, r.z + r.d, (x, z, idx, g) => {
      const lx = (x - r.x) * c - (z - r.z) * s, lz = (x - r.x) * s + (z - r.z) * c;
      if (Math.abs(lx) > r.w / 2 || Math.abs(lz) > r.d / 2) return;
      g[idx] = Math.max(g[idx], base + r.h * (lz / r.d + 0.5));
    });
    ctx.space.add(r.x, r.z, Math.max(r.w, r.d) / 2 + 1);
    data.props.push({ kind: 'sign', p: { x: r.x - fx * (r.d / 2 + 6) + fz * (r.w / 2 + 1.2), y: base, z: r.z - fz * (r.d / 2 + 6) - fx * (r.w / 2 + 1.2) }, yaw: r.yaw + Math.PI, variant: 2, chunk: ctx.chunkOf(r.x, r.z) });
  }
}

function districtAtPoint(layout: CityLayout, hf: HeightField, blocks: Island[], x: number, z: number): DistrictId {
  if (z > L.SHORE_Z) return 'water';
  if (z > L.Z_LINES[L.BEACH_LINE] - L.halfW(L.P_BEACH) - 1) return 'beach';
  if (!Number.isNaN(hf.upperHeight(x, z))) return 'highway';
  for (const b of blocks) if (x >= b.minX - 8 && x <= b.maxX + 8 && z >= b.minZ - 8 && z <= b.maxZ + 8) return b.district;
  const s = hf.surface(x, z);
  void layout;
  if (s === SURF.asphalt && (Math.abs(x) > 330 || z < -300)) return 'highway';
  return Math.abs(x) > 330 || z < -300 ? 'highway' : 'residential';
}

/** Rasterize the highway deck: solid parts into the ground layer, open viaduct into the upper layer. */
function rasterHighway(hf: HeightField, layout: CityLayout): void {
  const hw = layout.highway;
  const S = hw.samples;
  const n = S.length;
  const hW = hw.halfW + 0.35;
  for (let i = 0; i < n; i++) {
    const a = S[i], b = S[(i + 1) % n];
    const [oax, oaz] = outward(a);
    const minX = Math.min(a.x, b.x) - hW - 1, maxX = Math.max(a.x, b.x) + hW + 1;
    const minZ = Math.min(a.z, b.z) - hW - 1, maxZ = Math.max(a.z, b.z) + hW + 1;
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const open = (a.e + b.e) / 2 > L.HW.openAbove;
    const write = (x: number, z: number) => {
      const u = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      if (u < -0.02 || u > 1.02) return NaN;
      const t = (x - a.x) * oax + (z - a.z) * oaz;
      if (Math.abs(t) > hW) return NaN;
      const tc = Math.max(-hw.halfW, Math.min(hw.halfW, t));
      const uu = Math.min(1, Math.max(0, u));
      return deckY(a, tc) * (1 - uu) + deckY(b, tc) * uu;
    };
    if (open) {
      hf.forUpperCells(minX, maxX, minZ, maxZ, (x, z, idx, up) => {
        const y = write(x, z);
        if (y === y) up[idx] = Number.isNaN(up[idx]) ? y : Math.max(up[idx], y);
      });
    } else {
      hf.forCells(minX, maxX, minZ, maxZ, (x, z, idx, g, s) => {
        const y = write(x, z);
        if (y === y && y >= g[idx] - 0.05) {
          g[idx] = y;
          s[idx] = SURF.asphalt;
        }
      });
    }
  }
}

function rasterStrip(hf: HeightField, st: Strip): void {
  const P = st.pts;
  for (let i = 0; i + 5 < P.length; i += 3) {
    const ax = P[i], ay = P[i + 1], az = P[i + 2], bx = P[i + 3], by = P[i + 4], bz = P[i + 5];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz) || 1e-6;
    const fx = dx / len, fz = dz / len;
    const h = st.halfW + 0.2;
    hf.forCells(Math.min(ax, bx) - h - 1, Math.max(ax, bx) + h + 1, Math.min(az, bz) - h - 1, Math.max(az, bz) + h + 1, (x, z, idx, g, s) => {
      const u = ((x - ax) * fx + (z - az) * fz) / len;
      if (u < -0.05 || u > 1.05) return;
      const t = -(x - ax) * fz + (z - az) * fx;
      if (Math.abs(t) > h) return;
      const uu = Math.min(1, Math.max(0, u));
      const y = ay + (by - ay) * uu;
      if (y >= g[idx] - 0.05) {
        g[idx] = Math.max(g[idx], y);
        s[idx] = SURF.asphalt;
      }
    });
  }
}
