import { CONFIG } from '../../config';
import { Rng } from '../../core/rng';
import type { PedEdgeKind, PropKind } from '../types';
import * as L from './layout';
import { Facade, Mat, type Island, type StreetSeg } from './model';
import { inRoundRect, type GenCtx } from './ctx';

/** Pedestrian graph, street furniture, benches, bus stops, parked cars, paint and small solids. Pure data. */

const PI = Math.PI;
const CAR_COLORS = ['#f4f1ea', '#c9ccd1', '#2b2d33', '#d64545', '#3a6fd8', '#2aa3a4', '#f2c14e', '#ff7a6b', '#7ed6b8', '#1f3b70', '#d9c8a6', '#8d5bc7', '#5a6b58', '#e8e8e8'];

interface PSide {
  isl: Island;
  k: number;
  axis: 'x' | 'z';
  edge: number;
  inward: number;
  lo: number;
  hi: number;
  sw: number;
  outYaw: number;
  prof: L.StreetProfile | null;
  occ: [number, number, number][]; // a, b, lane (0 curb, 1 inner, 2 both)
}

export function furnish(ctx: GenCtx, yardSpots: number[]): void {
  const rng = Rng.from(ctx.seed, 0xf00d);
  const { data, layout, ped } = ctx;
  const props = data.props;
  const addProp = (kind: PropKind, x: number, y: number, z: number, yaw: number, variant: number, r = 0.6): number => {
    props.push({ kind, p: { x, y, z }, yaw, variant, chunk: ctx.chunkOf(x, z) });
    ctx.space.add(x, z, r);
    return props.length - 1;
  };
  const top = L.ISLAND_TOP;
  const seatH = CONFIG.props.benchSeatHeight;
  const seatSp = CONFIG.props.benchSeatSpacing;

  // ───────────────────────── pedestrian graph ─────────────────────────
  for (const isl of ctx.blockIslands) ped.addIslandSides(isl);
  ped.addIslandSides(ctx.promenade, 'promenade');

  interface XW { a: number; b: number; ca: [number, number]; cb: [number, number] }
  const xwalks: XW[] = [];
  for (const col of ctx.grid)
    for (const g of col) {
      if (!g) continue;
      const nArms = g.arms.filter(Boolean).length;
      if (nArms < 2) continue;
      if (nArms === 2 && ((g.arms[0] && g.arms[2]) || (g.arms[1] && g.arms[3]))) continue;
      const ox = g.hx + g.swX / 2, oz = g.hz + g.swZ / 2;
      const quads: Record<string, [number, number]> = {
        NW: [g.x - ox, g.z - oz], NE: [g.x + ox, g.z - oz], SE: [g.x + ox, g.z + oz], SW: [g.x - ox, g.z + oz],
      };
      const arm = (q1: string, q2: string, curbAxis: 'x' | 'z') => {
        const p1 = quads[q1], p2 = quads[q2];
        if (!ped.sideAt(p1[0], p1[1]) || !ped.sideAt(p2[0], p2[1])) return;
        const a = ped.onSide(p1[0], p1[1]);
        const b = ped.onSide(p2[0], p2[1]);
        const ca: [number, number] = curbAxis === 'x' ? [g.x + Math.sign(p1[0] - g.x) * g.hx, p1[1]] : [p1[0], g.z + Math.sign(p1[1] - g.z) * g.hz];
        const cbb: [number, number] = curbAxis === 'x' ? [g.x + Math.sign(p2[0] - g.x) * g.hx, p2[1]] : [p2[0], g.z + Math.sign(p2[1] - g.z) * g.hz];
        xwalks.push({ a, b, ca, cb: cbb });
      };
      if (g.arms[0]) arm('NW', 'NE', 'x');
      if (g.arms[2]) arm('SW', 'SE', 'x');
      if (g.arms[1]) arm('NE', 'SE', 'z');
      if (g.arms[3]) arm('NW', 'SW', 'z');
    }

  // park / plaza entrances on their rings
  const park = ctx.park, plaza = ctx.plaza;
  const pcx = (park.minX + park.sw[3] + park.maxX - park.sw[1]) / 2;
  const pcz = (park.minZ + park.sw[0] + park.maxZ - park.sw[2]) / 2;
  const ringN = park.minZ + park.sw[0] / 2, ringS = park.maxZ - park.sw[2] / 2, ringW = park.minX + park.sw[3] / 2, ringE = park.maxX - park.sw[1] / 2;
  const parkEnt = { N: ped.onSide(pcx, ringN), S: ped.onSide(pcx, ringS), W: ped.onSide(ringW, pcz), E: ped.onSide(ringE, pcz) };
  const qcx = 0, qcz = (plaza.minZ + plaza.sw[0] + plaza.maxZ - plaza.sw[2]) / 2;
  const plazaEnt = {
    N: ped.onSide(qcx, plaza.minZ + plaza.sw[0] / 2), S: ped.onSide(qcx, plaza.maxZ - plaza.sw[2] / 2),
    W: ped.onSide(plaza.minX + plaza.sw[3] / 2, qcz), E: ped.onSide(plaza.maxX - plaza.sw[1] / 2, qcz),
  };
  // sea wall gaps: slipways (cars) and stairs (people)
  const promLineZ = ctx.promenade.minZ + ctx.promenade.sw[0] / 2;
  for (const x of [-250, 0, 250]) ctx.wallGaps.push([x - 3.6, x + 3.6, 0]);
  for (const x of [-340, -170, -85, 85, 170, 340]) ctx.wallGaps.push([x - 1.8, x + 1.8, 1]);
  const stairNodes: [number, number][] = [];
  for (const [a, b, kind] of ctx.wallGaps) if (kind === 1) stairNodes.push([(a + b) / 2, ped.onSide((a + b) / 2, promLineZ)]);

  ped.buildSides();
  for (const w of xwalks) {
    const ca = ped.node(w.ca[0], 0.02, w.ca[1]);
    const cbn = ped.node(w.cb[0], 0.02, w.cb[1]);
    ped.edge(w.a, ca, 'crosswalk', 2.6);
    ped.edge(ca, cbn, 'crosswalk', 2.6);
    ped.edge(cbn, w.b, 'crosswalk', 2.6);
  }

  // ───────────────────────── park ─────────────────────────
  const PR = { pondX: 19, pondZ: 29, loopX: 31, loopZ: 44 };
  const parkY = park.top;
  const loopIds: number[] = [];
  const loopN = 22;
  const loopPts: number[] = [];
  for (let k = 0; k < loopN; k++) {
    const a = (k / loopN) * PI * 2;
    const x = pcx + Math.cos(a) * PR.loopX, z = pcz + Math.sin(a) * PR.loopZ;
    loopIds.push(ped.node(x, parkY, z));
    loopPts.push(x, z);
  }
  for (let k = 0; k < loopN; k++) ped.edge(loopIds[k], loopIds[(k + 1) % loopN], 'path', 3);
  const loopAt = (ang: number) => loopIds[Math.round(((ang / (PI * 2)) * loopN + loopN) % loopN) % loopN];
  ped.chain(parkEnt.E, loopAt(0), 'path', 3, 14);
  ped.chain(parkEnt.S, loopAt(PI / 2), 'path', 3, 14);
  ped.chain(parkEnt.W, loopAt(PI), 'path', 3, 14);
  ped.chain(parkEnt.N, loopAt(PI * 1.5), 'path', 3, 14);
  const corners = [
    [ringE, ringN, -PI / 4 + PI * 2],
    [ringE, ringS, PI / 4],
    [ringW, ringS, (3 * PI) / 4],
    [ringW, ringN, (5 * PI) / 4],
  ];
  const ribbons = layout.ribbons;
  const pathCol = 0xe7d6b6;
  ribbons.push({ pts: loopPts, w: 3.4, y: parkY + L.DECAL_Y, col: pathCol, mat: Mat.Plaza, closed: true });
  const spoke = (x0: number, z0: number, x1: number, z1: number) => ribbons.push({ pts: [x0, z0, x1, z1], w: 3.0, y: parkY + L.DECAL_Y - 0.004, col: pathCol, mat: Mat.Plaza, closed: false });
  spoke(ringE, pcz, pcx + PR.loopX, pcz);
  spoke(ringW, pcz, pcx - PR.loopX, pcz);
  spoke(pcx, ringN, pcx, pcz - PR.loopZ);
  spoke(pcx, ringS, pcx, pcz + PR.loopZ);
  for (const [cx, cz, ang] of corners) {
    const lid = loopAt(ang);
    const lp = ped.nodes[lid].p;
    const cid = ped.onSide(cx, cz) >= 0 ? ped.onSide(cx, cz) : ped.node(cx, parkY, cz);
    ped.chain(cid, lid, 'path', 2.6, 14);
    spoke(cx, cz, lp.x, lp.z);
  }
  // pond + rim, south round plaza
  layout.discs.push({ cx: pcx, cz: pcz, rx: PR.pondX + 1.2, rz: PR.pondZ + 1.2, inner: 0, y: parkY + 0.03, col: 0xcfc6b4, mat: Mat.Concrete });
  layout.discs.push({ cx: pcx, cz: pcz, rx: PR.pondX, rz: PR.pondZ, inner: 0, y: parkY + 0.045, col: 0x3fb6c8, mat: Mat.Water });
  const rpz = pcz + PR.loopZ + 16;
  layout.discs.push({ cx: pcx, cz: rpz, rx: 7.5, rz: 7.5, inner: 0, y: parkY + L.DECAL_Y + 0.004, col: 0xead9bd, mat: Mat.Plaza });
  layout.discs.push({ cx: pcx, cz: rpz, rx: 1.6, rz: 1.6, inner: 0, y: parkY + L.DECAL_Y + 0.008, col: 0xcf9a7a, mat: Mat.Plaza });
  layout.cylinders.push({ cx: pcx, cy: parkY, cz: rpz, r: 0.55, h: 3.2, col: 0xf3ede2, mat: Mat.Concrete, segs: 10, collide: true });
  layout.cylinders.push({ cx: pcx, cy: parkY + 3.2, cz: rpz, r: 0.9, h: 0.5, col: 0xffd166, mat: Mat.Metal, segs: 10, collide: false });
  // park water: surface code
  ctx.hf.forCells(pcx - PR.pondX, pcx + PR.pondX, pcz - PR.pondZ, pcz + PR.pondZ, (x, z, idx, _g, s) => {
    if (((x - pcx) / PR.pondX) ** 2 + ((z - pcz) / PR.pondZ) ** 2 <= 1) s[idx] = 4;
  });
  ctx.space.add(pcx, pcz, PR.pondZ + 2);
  ctx.space.add(pcx, rpz, 2);

  // ───────────────────────── plaza ─────────────────────────
  const fx = qcx, fz = qcz;
  const ringR = 9;
  const ringIds: number[] = [];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * PI * 2;
    ringIds.push(ped.node(fx + Math.cos(a) * ringR, top, fz + Math.sin(a) * ringR));
  }
  for (let k = 0; k < 12; k++) ped.edge(ringIds[k], ringIds[(k + 1) % 12], 'plaza', 3);
  ped.chain(plazaEnt.E, ringIds[0], 'plaza', 3, 12);
  ped.chain(plazaEnt.S, ringIds[3], 'plaza', 3, 12);
  ped.chain(plazaEnt.W, ringIds[6], 'plaza', 3, 12);
  ped.chain(plazaEnt.N, ringIds[9], 'plaza', 3, 12);
  layout.discs.push({ cx: fx, cz: fz, rx: 13, rz: 13, inner: 0.82, y: top + L.DECAL_Y, col: 0xd9a58a, mat: Mat.Plaza });
  layout.discs.push({ cx: fx, cz: fz, rx: 6.4, rz: 6.4, inner: 0.9, y: top + L.DECAL_Y, col: 0xc7b9a3, mat: Mat.Plaza });
  layout.cylinders.push({ cx: fx, cy: top, cz: fz, r: 5.6, h: 0.55, col: 0xe9e1d3, mat: Mat.Concrete, segs: 28, collide: true, open: true });
  layout.discs.push({ cx: fx, cz: fz, rx: 5.65, rz: 5.65, inner: 0.9, y: top + 0.56, col: 0xf4eee4, mat: Mat.Concrete });
  layout.discs.push({ cx: fx, cz: fz, rx: 5.1, rz: 5.1, inner: 0, y: top + 0.4, col: 0x46bfd2, mat: Mat.Water });
  layout.cylinders.push({ cx: fx, cy: top, cz: fz, r: 0.9, h: 2.4, col: 0xf1e9dc, mat: Mat.Concrete, segs: 12, collide: true });
  layout.cylinders.push({ cx: fx, cy: top + 2.4, cz: fz, r: 2.0, h: 0.35, col: 0xe9e1d3, mat: Mat.Concrete, segs: 18, collide: false });
  layout.cylinders.push({ cx: fx, cy: top + 2.75, cz: fz, r: 0.45, h: 1.6, col: 0xf6d36b, mat: Mat.Metal, segs: 10, collide: false });
  ctx.space.add(fx, fz, 6.5);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const x = fx + sx * 15.5, z = fz + sz * 15.5;
    layout.cylinders.push({ cx: x, cy: top, cz: z, r: 1.7, h: 0.5, col: 0xe6dccb, mat: Mat.Concrete, segs: 14, collide: true });
    layout.discs.push({ cx: x, cz: z, rx: 1.45, rz: 1.45, inner: 0, y: top + 0.51, col: 0x6b5a45, mat: Mat.Soil });
    addProp('tree', x, top + 0.5, z, rng.range(0, PI * 2), rng.int(0, 999), 1.8);
  }

  // ───────────────────────── sea wall, slipways, stairs ─────────────────────────
  const wz = L.SEA_WALL_Z;
  const gaps = ctx.wallGaps.slice().sort((a, b) => a[0] - b[0]);
  let wx = -L.BEACH_EXT_X;
  const wallCol = 0xf4efe6;
  const wallSeg = (x0: number, x1: number) => {
    if (x1 - x0 < 0.5) return;
    const n = Math.ceil((x1 - x0) / 20); // ≤ 20 m pieces so chunk streaming never drops a long wall
    for (let k = 0; k < n; k++) {
      const a = x0 + ((x1 - x0) * k) / n, b = x0 + ((x1 - x0) * (k + 1)) / n;
      layout.solids.push({ cx: (a + b) / 2, cy: 0, cz: wz, w: b - a, h: L.SEA_WALL_TOP, d: L.SEA_WALL_T, yaw: 0, col: wallCol, mat: Mat.Concrete, collide: true });
      layout.solids.push({ cx: (a + b) / 2, cy: L.SEA_WALL_TOP, cz: wz, w: b - a + 0.02, h: 0.12, d: L.SEA_WALL_T + 0.25, yaw: 0, col: 0xffffff, mat: Mat.Concrete, collide: false });
      // balusters pattern: small pilasters every 2.5 m on the promenade side
      for (let px = a + 1.25; px < b - 0.5; px += 2.5) layout.solids.push({ cx: px, cy: 0, cz: wz - L.SEA_WALL_T / 2 - 0.06, w: 0.35, h: L.SEA_WALL_TOP - 0.05, d: 0.12, yaw: 0, col: 0xfbf8f2, mat: Mat.Concrete, collide: false });
    }
  };
  for (const [a, b, kind] of gaps) {
    wallSeg(wx, a);
    wx = b;
    // gate posts
    for (const px of [a - 0.3, b + 0.3]) layout.solids.push({ cx: px, cy: 0, cz: wz, w: 0.7, h: L.SEA_WALL_TOP + 0.45, d: L.SEA_WALL_T + 0.3, yaw: 0, col: 0x5cc8d6, mat: Mat.Concrete, collide: true });
    if (kind === 0) {
      // slipway wedge from the promenade up to the sand
      const z0 = wz - 9, z1 = L.BEACH_START_Z + 1.5;
      layout.solids.push({ cx: (a + b) / 2, cy: top, cz: (z0 + z1) / 2, w: b - a, h: L.SAND_TOP - top + 0.06, d: z1 - z0, yaw: 0, col: 0xd8cfc0, mat: Mat.Concrete, collide: true, h0: 0 });
      ctx.space.add((a + b) / 2, wz - 4, 5);
      ctx.hf.forCells(a, b, z0, z1, (_x, z, idx, g) => {
        g[idx] = top + ((z - z0) / (z1 - z0)) * (L.SAND_TOP - top + 0.06);
      });
    } else {
      const z0 = wz - 4.2, z1 = L.BEACH_START_Z + 0.2;
      const steps = 6;
      for (let k = 0; k < steps; k++) {
        const za = z0 + ((z1 - z0) * k) / steps;
        const h = ((L.SAND_TOP - top) * (k + 1)) / steps;
        layout.solids.push({ cx: (a + b) / 2, cy: top, cz: za + (z1 - z0) / steps / 2 + ((z1 - z0) * (steps - k - 1)) / steps / 2, w: b - a, h, d: ((z1 - z0) * (steps - k)) / steps, yaw: 0, col: 0xe6ddcf, mat: Mat.Concrete, collide: false });
      }
      layout.solids.push({ cx: (a + b) / 2, cy: top, cz: (z0 + z1) / 2, w: b - a, h: L.SAND_TOP - top, d: z1 - z0, yaw: 0, col: -1, mat: 0, collide: true, h0: 0 });
      ctx.space.add((a + b) / 2, wz - 2, 3);
    }
  }
  wallSeg(wx, L.BEACH_EXT_X);
  // stairs → beach
  for (const [x, nid] of stairNodes) {
    if (nid < 0) continue;
    const t = ped.node(x, top + 0.2, wz - 4.6);
    const bot = ped.node(x, L.SAND_TOP, L.BEACH_START_Z + 2.5);
    ped.edge(nid, t, 'path', 2.4);
    ped.edge(t, bot, 'path', 2.4);
  }

  // ───────────────────────── side furniture ─────────────────────────
  const sides: PSide[] = [];
  const zProfAt = (edgeZ: number, north: boolean): L.StreetProfile | null => {
    for (let j = 0; j < L.Z_LINES.length; j++) {
      const e = north ? L.Z_LINES[j] + L.halfW(L.Z_PROF[j]) : L.Z_LINES[j] - L.halfW(L.Z_PROF[j]);
      if (Math.abs(e - edgeZ) < 0.05) return L.Z_PROF[j];
    }
    return null;
  };
  const xProfAt = (edgeX: number, west: boolean): L.StreetProfile | null => {
    for (let i = 0; i < L.X_LINES.length; i++) {
      const e = west ? L.X_LINES[i] + L.halfW(L.X_PROF[i]) : L.X_LINES[i] - L.halfW(L.X_PROF[i]);
      if (Math.abs(e - edgeX) < 0.05) return L.X_PROF[i];
    }
    return null;
  };
  for (const isl of ctx.blockIslands) {
    const [sn, se, ss, sw] = isl.sw;
    const cl = (s: number) => Math.max(isl.r, s) + 3.2;
    sides.push({ isl, k: 0, axis: 'x', edge: isl.minZ, inward: 1, lo: isl.minX + cl(sw), hi: isl.maxX - cl(se), sw: sn, outYaw: PI, prof: zProfAt(isl.minZ, true), occ: [] });
    sides.push({ isl, k: 1, axis: 'z', edge: isl.maxX, inward: -1, lo: isl.minZ + cl(sn), hi: isl.maxZ - cl(ss), sw: se, outYaw: PI / 2, prof: xProfAt(isl.maxX, false), occ: [] });
    sides.push({ isl, k: 2, axis: 'x', edge: isl.maxZ, inward: -1, lo: isl.minX + cl(sw), hi: isl.maxX - cl(se), sw: ss, outYaw: 0, prof: zProfAt(isl.maxZ, false), occ: [] });
    sides.push({ isl, k: 3, axis: 'z', edge: isl.minX, inward: 1, lo: isl.minZ + cl(sn), hi: isl.maxZ - cl(ss), sw, outYaw: -PI / 2, prof: xProfAt(isl.minX, true), occ: [] });
  }
  const pt = (s: PSide, r: number, o: number): [number, number] => (s.axis === 'x' ? [r, s.edge + s.inward * o] : [s.edge + s.inward * o, r]);
  const occupy = (s: PSide, a: number, b: number, lane: number): boolean => {
    for (const [p, q, l] of s.occ) if (a < q && b > p && (l === 2 || lane === 2 || l === lane)) return false;
    s.occ.push([a, b, lane]);
    return true;
  };
  // hub driveways
  for (const s of sides) {
    if (s.isl !== ctx.hub) continue;
    if (s.k === 1) occupy(s, L.HUB.aisleZ - 5, L.HUB.aisleZ + 5, 2);
    if (s.k === 2) occupy(s, L.HUB.southDriveX - 5, L.HUB.southDriveX + 5, 2);
  }
  const benchRec = (x: number, z: number, yaw: number, seats: number, propIndex: number, pedNode: number, groundY: number) => {
    data.benches.push({ id: data.benches.length, p: { x, y: groundY + seatH, z }, yaw, seats, seatSpacing: seatSp, seatHeight: seatH, propIndex, pedNode });
  };
  const attachPed = (x: number, y: number, z: number, kinds: PedEdgeKind[]) =>
    ped.attach(x, y, z, 'sidewalk', 1.2, (e) => kinds.includes(e.kind), false);

  for (const s of sides) {
    const len = s.hi - s.lo;
    if (len < 4 || s.sw <= 0) continue;
    const blvd = s.prof?.kind === 'boulevard';
    const downtown = s.isl.district === 'downtown' || s.isl.district === 'beach';
    const residential = s.isl.district === 'residential';
    // bus stop
    if (blvd && len > 40 && rng.chance(0.6)) {
      const r = (s.lo + s.hi) / 2 + rng.range(-8, 8);
      if (occupy(s, r - 3.2, r + 3.2, 2)) {
        const [x, z] = pt(s, r, 1.35);
        const pi = addProp('busStop', x, top, z, s.outYaw, rng.int(0, 999), 2.2);
        const [wx2, wz2] = pt(s, r + 3.0, 1.4);
        const pn = attachPed(wx2, top, wz2, ['sidewalk']);
        data.busStops.push({ id: data.busStops.length, p: { x: wx2, y: top, z: wz2 }, yaw: s.outYaw, propIndex: pi, pedNode: pn, benchId: null });
        ctx.noPark.add(x, z, 7);
      }
    }
    // hydrant
    if (len > 30 && rng.chance(0.8)) {
      const r = s.lo + 1.5;
      if (occupy(s, r - 0.6, r + 0.6, 0)) {
        const [x, z] = pt(s, r, 0.6);
        addProp('hydrant', x, top, z, s.outYaw, rng.int(0, 999), 0.4);
        ctx.noPark.add(x, z, 2.2);
      }
    }
    // streetlights + trees/palms between
    const spacing = s.isl.block === 'park' ? 24 : 27;
    const n = Math.max(1, Math.floor(len / spacing));
    const step = len / n;
    for (let k = 0; k <= n; k++) {
      const r = s.lo + k * step;
      if (occupy(s, r - 0.5, r + 0.5, 0)) {
        const [x, z] = pt(s, r, 0.65);
        addProp('streetlight', x, top, z, s.outYaw, rng.int(0, 999), 0.35);
      }
      if (k < n) {
        const rm = r + step / 2;
        const kind: PropKind | null = blvd || s.isl.block === 'hotel' ? 'palm' : residential || s.isl.block === 'park' || s.isl.block === 'plaza' ? 'tree' : downtown && rng.chance(0.55) ? 'tree' : null;
        if (kind && s.sw >= 3.5 && occupy(s, rm - 1.0, rm + 1.0, 0)) {
          const [x, z] = pt(s, rm, 0.95);
          addProp(kind, x, top, z, rng.range(0, PI * 2), rng.int(0, 999), 0.9);
        }
      }
    }
    // benches + bins on wide sidewalks
    if (s.sw >= 4.5 && (downtown || s.isl.block === 'park' || s.isl.block === 'plaza')) {
      for (let r = s.lo + 10; r < s.hi - 6; r += 38) {
        if (!rng.chance(0.55)) continue;
        const rr = r + rng.range(-4, 4);
        if (!occupy(s, rr - 1.4, rr + 2.4, 1)) continue;
        const o = s.sw - 0.85;
        const [x, z] = pt(s, rr, o);
        if (!ctx.space.free(x, z, 0.8)) continue;
        const pi = addProp('bench', x, top, z, s.outYaw, rng.int(0, 999), 1.0);
        const [px2, pz2] = pt(s, rr, s.sw / 2);
        const pn = attachPed(px2, top, pz2, ['sidewalk']);
        benchRec(x, z, s.outYaw, rng.chance(0.5) ? 3 : 2, pi, pn, top);
        const [bx, bz] = pt(s, rr + 1.9, o);
        addProp('bin', bx, top, bz, s.outYaw, rng.int(0, 999), 0.4);
      }
    }
    // a bin near the start of every side
    if (len > 20 && occupy(s, s.lo + 3.5, s.lo + 4.3, 1)) {
      const [x, z] = pt(s, s.lo + 3.9, s.sw - 0.6);
      if (ctx.space.free(x, z, 0.4)) addProp('bin', x, top, z, s.outYaw, rng.int(0, 999), 0.35);
    }
    // group spots on wide downtown sidewalks
    if (s.sw >= 4.5 && downtown && len > 30 && rng.chance(0.45)) {
      const rr = s.lo + rng.range(6, len - 6);
      const [x, z] = pt(s, rr, s.sw * 0.62);
      if (ctx.space.free(x, z, 1.4)) {
        data.groupSpots.push({ x, y: top, z });
        ctx.space.add(x, z, 1.2);
      }
    }
  }

  // medians: palms / trees
  for (const isl of layout.islands) {
    if (isl.kind !== 'median' || isl.interior !== 'grass') continue;
    const alongX = isl.maxX - isl.minX > isl.maxZ - isl.minZ;
    const a = (alongX ? isl.minX : isl.minZ) + 3, b = (alongX ? isl.maxX : isl.maxZ) - 3;
    const c = alongX ? (isl.minZ + isl.maxZ) / 2 : (isl.minX + isl.maxX) / 2;
    for (let r = a; r <= b; r += 12.5) {
      const x = alongX ? r : c, z = alongX ? c : r;
      addProp('palm', x, top, z, rng.range(0, PI * 2), rng.int(0, 999), 0.8);
    }
  }

  // traffic lights / stop signs at intersections
  for (const col of ctx.grid)
    for (const g of col) {
      if (!g) continue;
      const nArms = g.arms.filter(Boolean).length;
      if (nArms < 3) continue;
      const kind: PropKind | null = g.signal ? 'trafficLight' : L.X_PROF[g.i].kind === 'street2' && L.Z_PROF[g.j].kind === 'street2' ? 'sign' : null;
      if (!kind) continue;
      const quadYaw: [number, number, number][] = [[-1, -1, PI], [1, -1, PI / 2], [1, 1, 0], [-1, 1, -PI / 2]];
      for (const [sx, sz, yaw] of quadYaw) {
        const x = g.x + sx * (g.hx + 1.25), z = g.z + sz * (g.hz + 1.25);
        if (!ctx.blockIslands.some((b) => inRoundRect(b, x, z, -0.3))) continue;
        // only the approaches that exist
        const approachArm = yaw === PI ? 0 : yaw === PI / 2 ? 1 : yaw === 0 ? 2 : 3;
        if (!g.arms[approachArm]) continue;
        addProp(kind, x, top, z, yaw, kind === 'sign' ? 0 : rng.int(0, 999), 0.4);
      }
    }

  // promenade: palms row, deco lights, benches facing the sea, bins
  const pr = ctx.promenade;
  const inGap = (x: number, pad: number) => ctx.wallGaps.some(([a, b]) => x > a - pad && x < b + pad);
  for (let x = pr.minX + 6; x < pr.maxX - 6; x += 14) if (!inGap(x, 4)) addProp('palm', x, top, pr.minZ + 7.1, rng.range(0, PI * 2), rng.int(0, 999), 1.0);
  for (let x = pr.minX + 13; x < pr.maxX - 6; x += 28) addProp('streetlight', x, top, pr.minZ + 0.65, PI, rng.int(0, 999), 0.35);
  const promWalkZ = pr.maxZ - 4.6;
  for (let x = pr.minX + 9; x < pr.maxX - 9; x += 16) {
    if (inGap(x, 3.5)) continue;
    const bz = pr.maxZ - 1.25;
    const pi = addProp('bench', x, top, bz, 0, rng.int(0, 999), 1.0);
    const n = ped.node(x, top, promWalkZ);
    const ne = ped.nearestEdge(x, promLineZ, (e) => e.kind === 'promenade');
    if (ne.id >= 0) ped.edge(ped.split(ne.id, ne.t), n, 'promenade', 3);
    benchRec(x, bz, 0, 3, pi, n, top);
    if (((x - pr.minX) / 16) % 2 < 1) addProp('bin', x + 1.9, top, bz, 0, rng.int(0, 999), 0.4);
  }
  layout.decals.push({ cx: 0, cz: pr.maxZ - 4.4, dx: 1, dz: 0, hl: pr.maxX - 1, hw: 1.6, y: top + L.DECAL_Y, col: 0xe9c9a0, mat: Mat.Plaza });
  for (let k = 0; k < 8; k++) {
    const x = rng.range(pr.minX + 20, pr.maxX - 20);
    if (!inGap(x, 5)) data.groupSpots.push({ x, y: top, z: pr.maxZ - 6.5 });
  }

  // park furniture
  for (let k = 0; k < loopN; k += 2) {
    const a = (k / loopN) * PI * 2 + PI / loopN;
    const ix = pcx + Math.cos(a) * (PR.loopX - 3.1), iz = pcz + Math.sin(a) * (PR.loopZ - 3.1);
    const yaw = Math.atan2(pcx - ix, pcz - iz);
    if (k % 4 === 0) {
      const pi = addProp('bench', ix, parkY, iz, yaw, rng.int(0, 999), 1.0);
      const pn = ped.attach(ix, parkY, iz, 'path', 1.5, (e) => e.kind === 'path', false);
      benchRec(ix, iz, yaw, 3, pi, pn, parkY);
    } else {
      const ox = pcx + Math.cos(a) * (PR.loopX + 2.6), oz = pcz + Math.sin(a) * (PR.loopZ + 2.6);
      addProp('streetlight', ox, parkY, oz, Math.atan2(pcx - ox, pcz - oz), rng.int(0, 999), 0.35);
    }
  }
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * PI * 2 + 0.3;
    const x = pcx + Math.cos(a) * 9.5, z = rpz + Math.sin(a) * 9.5;
    const yaw = Math.atan2(pcx - x, rpz - z);
    const pi = addProp('bench', x, parkY, z, yaw, rng.int(0, 999), 1.0);
    const pn = ped.attach(x, parkY, z, 'path', 1.5, (e) => e.kind === 'path', true);
    benchRec(x, z, yaw, 2, pi, pn, parkY);
  }
  // park trees on lawns
  const pathDist = (x: number, z: number) => {
    let d = Infinity;
    for (const rb of ribbons) {
      const P = rb.pts;
      const m = P.length / 2;
      for (let i = 0; i < (rb.closed ? m : m - 1); i++) {
        const ax = P[i * 2], az = P[i * 2 + 1], bx = P[((i + 1) % m) * 2], bz = P[((i + 1) % m) * 2 + 1];
        const dx = bx - ax, dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
        d = Math.min(d, Math.hypot(ax + dx * t - x, az + dz * t - z));
      }
    }
    return d;
  };
  const pIn = { x0: park.minX + park.sw[3] + 2.5, x1: park.maxX - park.sw[1] - 2.5, z0: park.minZ + park.sw[0] + 2.5, z1: park.maxZ - park.sw[2] - 2.5 };
  let placed = 0;
  for (let tries = 0; tries < 900 && placed < 85; tries++) {
    const x = rng.range(pIn.x0, pIn.x1), z = rng.range(pIn.z0, pIn.z1);
    if (((x - pcx) / (PR.pondX + 4)) ** 2 + ((z - pcz) / (PR.pondZ + 4)) ** 2 < 1) continue;
    if (pathDist(x, z) < 3.6 || !ctx.space.free(x, z, 3.2)) continue;
    addProp(rng.chance(0.18) ? 'palm' : 'tree', x, parkY, z, rng.range(0, PI * 2), rng.int(0, 999), 1.2);
    placed++;
  }
  const lawn = (x0: number, x1: number, z0: number, z1: number) => data.wanderAreas.push({ id: data.wanderAreas.length, kind: 'park', minX: x0, maxX: x1, minZ: z0, maxZ: z1, y: parkY });
  lawn(pIn.x0, pcx - PR.loopX - 3, pIn.z0, pIn.z1);
  lawn(pcx + PR.loopX + 3, pIn.x1, pIn.z0, pIn.z1);
  lawn(pcx - 25, pcx + 25, pIn.z0, pcz - PR.loopZ - 3);
  for (let k = 0; k < 8; k++) {
    const x = rng.range(pIn.x0 + 3, pIn.x1 - 3), z = rng.range(pIn.z0 + 3, pIn.z1 - 3);
    if (pathDist(x, z) > 2.5 && pathDist(x, z) < 7 && ctx.space.free(x, z, 1.5)) data.groupSpots.push({ x, y: parkY, z });
  }
  // plaza furniture
  for (let k = 0; k < 12; k += 2) {
    const a = (k / 12) * PI * 2 + PI / 12;
    const x = fx + Math.cos(a) * 7.2, z = fz + Math.sin(a) * 7.2;
    const yaw = Math.atan2(fx - x, fz - z);
    const pi = addProp('bench', x, top, z, yaw, rng.int(0, 999), 0.9);
    const pn = ped.attach(fx + Math.cos(a) * ringR, top, fz + Math.sin(a) * ringR, 'plaza', 1.5, (e) => e.kind === 'plaza', false);
    benchRec(x, z, yaw, 2, pi, pn, top);
  }
  const qIn = { x0: plaza.minX + plaza.sw[3] + 1.5, x1: plaza.maxX - plaza.sw[1] - 1.5, z0: plaza.minZ + plaza.sw[0] + 1.5, z1: plaza.maxZ - plaza.sw[2] - 1.5 };
  const pw = (x0: number, x1: number, z0: number, z1: number) => data.wanderAreas.push({ id: data.wanderAreas.length, kind: 'plaza', minX: x0, maxX: x1, minZ: z0, maxZ: z1, y: top });
  pw(qIn.x0, qIn.x1, qIn.z0, fz - 13.5);
  pw(qIn.x0, qIn.x1, fz + 13.5, qIn.z1);
  pw(qIn.x0, fx - 13.5, qIn.z0, qIn.z1);
  pw(fx + 13.5, qIn.x1, qIn.z0, qIn.z1);
  for (const [gx, gz] of [[-15, -10], [15, 9], [-12, 14], [11, -15]]) data.groupSpots.push({ x: fx + gx, y: top, z: fz + gz });
  // beach wander area
  data.wanderAreas.push({ id: data.wanderAreas.length, kind: 'beach', minX: -400, maxX: 400, minZ: L.BEACH_START_Z + 3, maxZ: L.SHORE_Z - 6, y: L.SAND_TOP * 0.6 });
  data.wanderAreas.push({ id: data.wanderAreas.length, kind: 'plaza', minX: pr.minX + 4, maxX: pr.maxX - 4, minZ: pr.maxZ - 6.5, maxZ: pr.maxZ - 2.5, y: top });

  // residential yard trees
  for (let i = 0; i < yardSpots.length; i += 2) {
    const x = yardSpots[i] + rng.range(-1.5, 1.5), z = yardSpots[i + 1] + rng.range(-1, 1);
    if (rng.chance(0.75) && ctx.space.free(x, z, 2.2) && ctx.blockIslands.some((b) => inRoundRect(b, x, z, -5))) addProp(rng.chance(0.25) ? 'palm' : 'tree', x, top, z, rng.range(0, PI * 2), rng.int(0, 999), 1.2);
  }

  // hub lot: lights + palms
  for (const x of [226, 262, 298]) {
    addProp('streetlight', x, top, -53, 0, rng.int(0, 999), 0.3);
    addProp('streetlight', x, top, -35, PI, rng.int(0, 999), 0.3);
  }
  addProp('sign', L.HUB.garage.x1 + 3, top, L.HUB.aisleZ - 5.5, PI / 2, 3, 0.4);

  // beach parks outside the edge streets (palms on grass)
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 14; k++) {
      const x = sx * rng.range(328, 412), z = rng.range(214, 256);
      if (ctx.space.free(x, z, 3)) addProp('palm', x, 0, z, rng.range(0, PI * 2), rng.int(0, 999), 1.0);
    }
  }

  // jump: warning signs + cones lining the landing, containers in the gap
  const J = L.JUMP;
  addProp('sign', J.straightX0 - 30, 0, J.z - J.halfW - 1.4, PI / 2, 2, 0.4);
  addProp('sign', J.straightX0 - 30, 0, J.z + J.halfW + 1.4, PI / 2, 2, 0.4);
  addProp('sign', J.divergeX - 60, L.HW.gradeY, L.HW.zNorth + L.HW.halfW + 2.2, PI / 2, 2, 0.4);
  for (let x = J.landX1 + 4; x < J.straightX1 - 2; x += 5) {
    addProp('cone', x, 0.012, J.z - J.halfW + 0.5, 0, rng.int(0, 999), 0.3);
    addProp('cone', x, 0.012, J.z + J.halfW - 0.5, 0, rng.int(0, 999), 0.3);
  }
  const contCols = [0xff7a6b, 0x5cc8d6, 0xffd166, 0x4f9a5a];
  for (let k = 0; k < 3; k++) {
    const cx = J.lipX + 7 + k * 6;
    layout.boxParts.push({ cx, cz: J.z, y: 0, w: 12.2, h: 2.6, d: 2.45, yaw: PI / 2, style: Facade.Container, color: contCols[k], accent: 0xffffff, seed: rng.next(), floorH: 3, baseOff: 0, groundH: 0, lit: 0, tower: false });
    layout.solids.push({ cx, cy: 0, cz: J.z, w: 2.45, h: 2.6, d: 12.2, yaw: 0, col: -1, mat: Mat.Metal, collide: true });
  }
  layout.boxParts.push({ cx: J.lipX + 13, cz: J.z - 2.5, y: 2.6, w: 6.1, h: 2.6, d: 2.45, yaw: PI / 2 + 0.08, style: Facade.Container, color: contCols[3], accent: 0xffffff, seed: rng.next(), floorH: 3, baseOff: 0, groundH: 0, lit: 0, tower: false });

  roadworks(ctx, rng, addProp);
  markings(ctx);
  parkedCars(ctx, rng);
}

// ───────────────────────── roadworks ─────────────────────────
function roadworks(ctx: GenCtx, rng: Rng, addProp: (k: PropKind, x: number, y: number, z: number, yaw: number, v: number, r?: number) => number): void {
  const cands = ctx.layout.segs.filter((s) => s.prof.park > 0 && s.b - s.a - s.boxA - s.boxB > 50 && s.prof !== L.P_BEACH);
  for (let k = 0; k < 4 && cands.length; k++) {
    const s = cands.splice(rng.int(0, cands.length - 1), 1)[0];
    const side = rng.chance(0.5) ? 1 : -1;
    const lat = s.c + side * ((s.prof.lanes * s.prof.laneW) / 2 + s.prof.median / 2 + s.prof.park / 2);
    const mid = (s.a + s.boxA + s.b - s.boxB) / 2 + rng.range(-8, 8);
    const P = (r: number): [number, number] => (s.axis === 'x' ? [lat, r] : [r, lat]);
    const yaw = s.axis === 'x' ? 0 : PI / 2;
    for (let r = mid - 8; r <= mid + 8; r += 2.7) {
      const [x, z] = P(r);
      addProp('cone', x, 0, z, yaw, rng.int(0, 999), 0.3);
    }
    for (const r of [mid - 10, mid + 10]) {
      const [x, z] = P(r);
      addProp('barrier', x, 0, z, yaw + PI / 2, rng.int(0, 999), 0.8);
    }
    const [cx, cz] = P(mid);
    ctx.noPark.add(cx, cz, 13);
    const [sx, sz] = P(mid - 13);
    addProp('sign', sx, 0, sz, yaw, 4, 0.4);
  }
}

// ───────────────────────── paint ─────────────────────────
function markings(ctx: GenCtx): void {
  const D = ctx.layout.decals;
  const W = 0xf4f2ec, Y = 0xf2c84b;
  const y = L.MARK_Y;
  const quad = (s: StreetSeg, r0: number, r1: number, lat: number, hw: number, col: number) => {
    // split long paint into ≤ 10 m pieces (chunk assignment by centre)
    const n = Math.max(1, Math.ceil((r1 - r0) / 10));
    for (let k = 0; k < n; k++) {
      const a = r0 + ((r1 - r0) * k) / n, b = r0 + ((r1 - r0) * (k + 1)) / n;
      const c = (a + b) / 2;
      if (s.axis === 'x') D.push({ cx: s.c + lat, cz: c, dx: 0, dz: 1, hl: (b - a) / 2, hw, y, col, mat: Mat.Paint });
      else D.push({ cx: c, cz: s.c + lat, dx: 1, dz: 0, hl: (b - a) / 2, hw, y, col, mat: Mat.Paint });
    }
  };
  const dashed = (s: StreetSeg, r0: number, r1: number, lat: number, hw: number, col: number, dash: number, gap: number) => {
    for (let r = r0 + gap / 2; r + dash <= r1; r += dash + gap) quad(s, r, r + dash, lat, hw, col);
  };
  for (const s of ctx.layout.segs) {
    const p = s.prof;
    const xA = s.xwalkA ? s.swA / 2 + 1.5 : 0, xB = s.xwalkB ? s.swB / 2 + 1.5 : 0;
    const r0 = s.a + s.boxA + xA + (s.xwalkA ? 2.2 : 0.5), r1 = s.b - s.boxB - xB - (s.xwalkB ? 2.2 : 0.5);
    if (r1 - r0 < 2) continue;
    const half = (p.lanes * p.laneW) / 2 + p.median / 2;
    if (p.median <= 0) {
      if (p.lanes === 2) dashed(s, r0, r1, 0, 0.07, Y, 3, 4);
      else {
        quad(s, r0, r1, -0.17, 0.065, Y);
        quad(s, r0, r1, 0.17, 0.065, Y);
      }
    }
    if (p.lanes === 4) {
      const off = p.median / 2 + p.laneW;
      dashed(s, r0, r1, off, 0.07, W, 3, 6);
      dashed(s, r0, r1, -off, 0.07, W, 3, 6);
    }
    if (p.park > 0) {
      quad(s, r0, r1, half, 0.08, W);
      quad(s, r0, r1, -half, 0.08, W);
      // parking bay ticks
      for (let r = r0 + 3; r < r1 - 1; r += 6.2) {
        for (const sg of [-1, 1]) {
          const lat = sg * (half + p.park / 2);
          if (s.axis === 'x') D.push({ cx: s.c + lat, cz: r, dx: 1, dz: 0, hl: p.park / 2 - 0.15, hw: 0.06, y, col: W, mat: Mat.Paint });
          else D.push({ cx: r, cz: s.c + lat, dx: 0, dz: 1, hl: p.park / 2 - 0.15, hw: 0.06, y, col: W, mat: Mat.Paint });
        }
      }
    }
    const hwAll = L.halfW(p);
    const zebra = (along: number, dirSign: number) => {
      // bars across the street, each bar parallel to traffic
      for (let lat = -hwAll + 0.6; lat <= hwAll - 0.5; lat += 1.15) {
        if (s.axis === 'x') D.push({ cx: s.c + lat + 0.3, cz: along, dx: 0, dz: 1, hl: 1.5, hw: 0.3, y, col: W, mat: Mat.Paint });
        else D.push({ cx: along, cz: s.c + lat + 0.3, dx: 1, dz: 0, hl: 1.5, hw: 0.3, y, col: W, mat: Mat.Paint });
      }
      // stop line on the approach (right-hand) half
      const stopAlong = along + dirSign * 2.4;
      // traffic approaching end A moves in the -run direction (dirSign = +1 → line on the +run side of the zebra);
      // its right-hand half: x-street heading -z → +x; z-street heading -x → -z (and mirrored at end B)
      const rightSign = s.axis === 'x' ? (dirSign > 0 ? 1 : -1) : dirSign > 0 ? -1 : 1;
      const latC = rightSign * (p.median / 2 + (p.lanes * p.laneW) / 4);
      const hl = (p.lanes * p.laneW) / 4;
      if (s.axis === 'x') D.push({ cx: s.c + latC, cz: stopAlong, dx: 1, dz: 0, hl, hw: 0.22, y, col: W, mat: Mat.Paint });
      else D.push({ cx: stopAlong, cz: s.c + latC, dx: 0, dz: 1, hl, hw: 0.22, y, col: W, mat: Mat.Paint });
    };
    if (s.xwalkA) zebra(s.a + s.boxA + s.swA / 2, 1);
    if (s.xwalkB) zebra(s.b - s.boxB - s.swB / 2, -1);
  }
  // hub lot stalls
  const top = L.ISLAND_TOP + L.DECAL_Y;
  const rows: [number, number][] = [[-68.25, 0], [-55.75, 0], [-50.25, 0], [-37.75, 0], [-32.25, 0]];
  for (const [zc] of rows) {
    for (let x = 226; x <= 300; x += 2.7) {
      if (Math.abs(x - L.HUB.southDriveX) < 5 && zc > -45) continue;
      D.push({ cx: x, cz: zc, dx: 0, dz: 1, hl: 2.6, hw: 0.06, y: top, col: W, mat: Mat.Paint });
    }
  }
  // garage apron: painted arrow strip toward the exit
  for (let x = 232; x < 300; x += 9) D.push({ cx: x, cz: L.HUB.aisleZ, dx: 1, dz: 0, hl: 2.2, hw: 0.12, y: top, col: Y, mat: Mat.Paint });
}

// ───────────────────────── parked cars ─────────────────────────
function parkedCars(ctx: GenCtx, rng: Rng): void {
  const cars = ctx.data.parkedCars;
  const add = (x: number, y: number, z: number, yaw: number) => {
    cars.push({ p: { x, y, z }, yaw, variant: rng.int(0, 3), color: rng.pick(CAR_COLORS), chunk: ctx.chunkOf(x, z) });
  };
  for (const s of ctx.layout.segs) {
    const p = s.prof;
    if (p.park <= 0) continue;
    const clA = s.boxA > 0 ? s.boxA + (s.xwalkA ? s.swA + 4.5 : 5) : 9;
    const clB = s.boxB > 0 ? s.boxB + (s.xwalkB ? s.swB + 4.5 : 5) : 9;
    const r0 = s.a + clA, r1 = s.b - clB;
    const lat = (p.lanes * p.laneW) / 2 + p.median / 2 + p.park / 2 + 0.05;
    const occ = p === L.P_BEACH ? 0.6 : p.kind === 'boulevard' ? 0.42 : p.kind === 'street4' ? 0.5 : 0.55;
    for (const sg of [-1, 1]) {
      // right-hand traffic: x-street east side (+x) heads north (yaw π); z-street south side (+z) heads east (yaw π/2)
      const yaw = s.axis === 'x' ? (sg > 0 ? PI : 0) : sg > 0 ? PI / 2 : -PI / 2;
      for (let r = r0 + 3; r < r1 - 3; r += 6.2) {
        if (!rng.chance(occ)) continue;
        const x = s.axis === 'x' ? s.c + sg * lat : r;
        const z = s.axis === 'x' ? r : s.c + sg * lat;
        if (!ctx.noPark.free(x, z, 2.2)) continue;
        add(x, 0, z, yaw + rng.range(-0.02, 0.02));
      }
    }
  }
  // hub lot
  const top = L.ISLAND_TOP;
  const rows: [number, number][] = [[-68.25, PI], [-55.75, 0], [-50.25, PI], [-37.75, 0], [-32.25, PI]];
  for (const [zc, yaw] of rows) {
    for (let x = 227.35; x <= 299; x += 2.7) {
      if (Math.abs(x - L.HUB.southDriveX) < 5 && zc > -45) continue;
      if (rng.chance(0.55)) add(x, top, zc, yaw + rng.range(-0.04, 0.04));
    }
  }
}
