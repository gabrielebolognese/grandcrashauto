import { CONFIG } from '../../config';
import { climate, cropOf, CROP_FALLOW, CROP_PASTURE, CROP_WHEAT, farmMaskAt, FIELD_BLOCK, fieldAt, fieldBlock, forestAt, type FieldBlock } from './biome';
import { CorridorSet } from './carve';
import { features, newInfo, sampleTerrain, SEA_WALL_Z, type TerrainInfo } from './height';
import { hash2, noiseFor, sstep } from './noise';
import { ST, ST_COL, ST_COUNT, ST_MAT, type ScatterData } from './scatterTypes';

/**
 * Seeded scatter for one 128 m chunk (runs in a worker): trees, bushes, rocks, fences, farmsteads, suburb houses,
 * cabins, wind turbines on ridges, power lines (pylons + cable spans), palms, boulders, hay bales.
 * Point-evaluated against the exact terrain function (+ corridor carving), so results never depend on LOD and every
 * chunk is generated identically in any order. Every instance carries a `rank` (0..1): the renderer keeps instances
 * with rank < quality.treeDensity, so quality changes don't need regeneration.
 */

const CH = 128;
const INFO = newInfo();
const PROBE = newInfo();
const CEN = newInfo();

class Out {
  m: number[][] = [];
  c: number[][] = [];
  constructor() {
    for (let i = 0; i < ST_COUNT; i++) {
      this.m.push([]);
      this.c.push([]);
    }
  }
  trs(t: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, r: number, g: number, b: number, rank: number): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.m[t].push(c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1);
    this.c[t].push(r, g, b, rank);
  }
  /** Affine span: local x ∈ [0,1] along the chord p0→p1, y up (m), z along `side` (m). */
  span(t: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, rank: number): void {
    const l = Math.hypot(dx, dz) || 1;
    const sx = -dz / l;
    const sz = dx / l;
    this.m[t].push(dx, dy, dz, 0, 0, 1, 0, 0, sx, 0, sz, 0, x, y, z, 1);
    this.c[t].push(1, 1, 1, rank);
  }
  pack(cx: number, cz: number): ScatterData {
    const counts = new Int32Array(ST_COUNT);
    const offsets = new Int32Array(ST_COUNT);
    let total = 0;
    for (let t = 0; t < ST_COUNT; t++) {
      offsets[t] = total;
      counts[t] = this.m[t].length / ST_MAT;
      total += counts[t];
    }
    const mats = new Float32Array(total * ST_MAT);
    const cols = new Float32Array(total * ST_COL);
    for (let t = 0; t < ST_COUNT; t++) {
      mats.set(this.m[t], offsets[t] * ST_MAT);
      cols.set(this.c[t], offsets[t] * ST_COL);
    }
    return { cx, cz, counts, offsets, mats, cols };
  }
}

const PASTELS = [
  [1.0, 0.62, 0.55], [1.0, 0.78, 0.62], [1.0, 0.9, 0.62], [0.68, 0.9, 0.8], [0.6, 0.85, 0.9], [0.8, 0.74, 0.95], [1.0, 0.96, 0.88],
];

function groundAt(corr: CorridorSet, ax: number, az: number, info: TerrainInfo, seed: number): number {
  let h = sampleTerrain(ax, az, info, seed);
  if (!corr.empty && info.flat >= 0) h = corr.carve(h, ax, az);
  return h;
}

/** Feature exclusion (lighthouse, pier root, summit platform, sea wall strip). */
function excluded(ax: number, az: number, info: TerrainInfo, seed: number, pad: number): boolean {
  const F = features(seed);
  const lx = ax - F.lighthouseX;
  const lz = az - F.lighthouseZ;
  if (lx * lx + lz * lz < (45 + pad) * (45 + pad)) return true;
  const sx = ax - F.summitX;
  const sz = az - F.summitZ;
  if (sx * sx + sz * sz < (60 + pad) * (60 + pad)) return true;
  if (Math.abs(ax - F.pierX) < 18 + pad && info.coast < 60) return true;
  if (info.zone > 0.3 && az > SEA_WALL_Z - 25) return true;
  return false;
}

export function buildScatter(cx: number, cz: number, seed: number): ScatterData {
  const out = new Out();
  const x0 = cx * CH;
  const z0 = cz * CH;
  const n = noiseFor(seed);
  const S = CONFIG.terrain.scatter;
  const corr = CorridorSet.forRect(x0 - 30, z0 - 30, x0 + CH + 30, z0 + CH + 30);
  sampleTerrain(x0 + CH / 2, z0 + CH / 2, CEN, seed);
  // whole chunk inside the city/airport, or open sea far from any islet → nothing
  if (CEN.flat < -120 || CEN.coast < -2400) return out.pack(cx, cz);

  // ── natural cover: jittered candidate grid ──
  const G = 26;
  const step = CH / G;
  const area = step * step;
  const dens = (S.forestDensity / 100) * area;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      const gx = cx * G + i;
      const gz = cz * G + j;
      const r0 = hash2(seed, gx, gz, 501);
      const ax = x0 + (i + 0.1 + 0.8 * hash2(seed, gx, gz, 502)) * step;
      const az = z0 + (j + 0.1 + 0.8 * hash2(seed, gx, gz, 503)) * step;
      const h = groundAt(corr, ax, az, INFO, seed);
      if (INFO.flat < 6 || h < 0.6) continue;
      if (INFO.lake === INFO.lake && h < INFO.lake + 0.5) continue;
      const cl = climate(ax, az, h, INFO.coast, seed);
      const f = forestAt(ax, az, cl.moist, seed);
      const pineT = sstep(0.44, 0.24, cl.temp + (hash2(seed, gx, gz, 504) - 0.5) * 0.12);
      // cheap upper bound before slope probes
      if (r0 > 0.28) continue;
      const e = corr.empty ? 1e9 : corr.edgeDistance(ax, az);
      if (e < 6) continue;
      if (excluded(ax, az, INFO, seed, 0)) continue;
      const hx = groundAt(corr, ax + 1.5, az, PROBE, seed);
      const hz = groundAt(corr, ax, az + 1.5, PROBE, seed);
      const gxs = (hx - h) / 1.5;
      const gzs = (hz - h) / 1.5;
      const ny = 1 / Math.sqrt(1 + gxs * gxs + gzs * gzs);
      const sub = 1 - sstep(450, 1700, INFO.city);
      const farm = farmMaskAt(ax, az, seed) * sstep(0.955, 0.985, ny) * (1 - sstep(70, 170, h)) * sstep(110, 260, INFO.coast) * (1 - INFO.mtn) * (1 - sub);
      const treeLine = sstep(760, 640, h + (hash2(seed, gx, gz, 505) - 0.5) * 60);
      const steep = sstep(0.8, 0.6, ny);
      const rocky = Math.max(steep, sstep(700, 860, h)) + sstep(0.4, 0.24, cl.moist) * sstep(70, 210, h) * 0.5;
      const rank = hash2(seed, gx, gz, 506);
      const yaw = hash2(seed, gx, gz, 507) * Math.PI * 2;
      const sc = 0.72 + 0.6 * hash2(seed, gx, gz, 508);
      const tint = 0.88 + 0.24 * hash2(seed, gx, gz, 509);
      const beachy = INFO.coast < 200 && INFO.dune > 0.2;

      // trees
      let pTree = 0;
      if (ny > 0.74 && treeLine > 0) {
        pTree = dens * Math.pow(f, 1.4) * (1 - farm * 0.97) * (1 - sub * 0.5);
        pTree += 0.006 * (1 - farm) + sub * 0.022;
        if (farm > 0.5) {
          const fi = fieldAt(ax, az, seed);
          if (fi.hedge && fi.edge < 3) pTree += 0.07;
        }
        pTree *= treeLine * sstep(25, 90, INFO.coast);
      }
      if (r0 < pTree) {
        const isPine = pineT > 0.5 || h > 520;
        const autumn = !isPine && hash2(seed, gx, gz, 510) < 0.1;
        const t = isPine ? ST.pine : ST.round;
        const sy = sc * (0.9 + 0.3 * hash2(seed, gx, gz, 511));
        out.trs(t, ax - x0, h - 0.25, az - z0, yaw, sc, sy, sc, autumn ? tint * 1.18 : tint, autumn ? tint * 0.98 : tint, autumn ? tint * 0.72 : tint * (0.95 + 0.1 * pineT), rank);
        continue;
      }
      let acc = pTree;
      // palms on warm beaches / dunes
      const pPalm = INFO.coast > 18 && INFO.coast < 170 && cl.temp > 0.45 && INFO.zone < 0.3 && ny > 0.85 ? 0.02 + 0.03 * INFO.dune : 0;
      if (r0 < acc + pPalm) {
        out.trs(ST.palm, ax - x0, h - 0.2, az - z0, yaw, sc, sc * (0.85 + 0.4 * hash2(seed, gx, gz, 512)), sc, 1, 1, 1, rank);
        continue;
      }
      acc += pPalm;
      // bushes
      let pBush = 0;
      if (ny > 0.7 && treeLine > 0) pBush = 0.05 * sstep(0.05, 0.25, f) * (1 - sstep(0.45, 0.8, f)) + 0.012 * (1 - farm) + (beachy ? 0.05 : 0) + 0.02 * sstep(450, 600, h);
      if (r0 < acc + pBush) {
        const bs = 0.7 + 0.7 * hash2(seed, gx, gz, 513);
        out.trs(ST.bush, ax - x0, h - 0.15, az - z0, yaw, bs, bs * 0.8, bs, tint * (beachy ? 1.1 : 1), tint, tint * (beachy ? 0.85 : 1), rank);
        continue;
      }
      acc += pBush;
      // rocks / boulders
      const pRock = 0.06 * rocky + (INFO.coast < 60 && INFO.cliff > 0.4 ? 0.04 : 0) + (beachy ? 0.004 : 0);
      if (r0 < acc + pRock) {
        const big = hash2(seed, gx, gz, 514) < 0.08 && ny > 0.6;
        const rs = big ? 2.2 + 2.5 * hash2(seed, gx, gz, 515) : 0.5 + 1.4 * hash2(seed, gx, gz, 515);
        out.trs(big ? ST.boulder : ST.rock, ax - x0, h - rs * 0.25, az - z0, yaw, rs, rs * (0.6 + 0.4 * hash2(seed, gx, gz, 516)), rs * (0.8 + 0.4 * hash2(seed, gx, gz, 517)), tint, tint, tint, rank);
      }
    }
  }

  // ── farmsteads (house + barn + yard fence + hay) ──
  if (hash2(seed, cx, cz, 520) < 0.17 && CEN.coast > 260 && CEN.mtn < 0.2 && CEN.flat > 300) {
    const px = x0 + 34 + 60 * hash2(seed, cx, cz, 521);
    const pz = z0 + 34 + 60 * hash2(seed, cx, cz, 522);
    const fm = farmMaskAt(px, pz, seed);
    const h = groundAt(corr, px, pz, INFO, seed);
    const hx = groundAt(corr, px + 12, pz, PROBE, seed);
    const hz = groundAt(corr, px, pz + 12, PROBE, seed);
    const flatOk = Math.abs(hx - h) < 1.2 && Math.abs(hz - h) < 1.2;
    const e = corr.empty ? 1e9 : corr.edgeDistance(px, pz);
    if (fm > 0.55 && flatOk && e > 30 && h > 1 && h < 170 && INFO.lake !== INFO.lake && !excluded(px, pz, INFO, seed, 20)) {
      const fi = fieldAt(px, pz, seed);
      const yaw = fi.block.angle + (hash2(seed, cx, cz, 523) < 0.5 ? 0 : Math.PI / 2);
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const loc = (lx: number, lz: number) => [px + lx * c + lz * s, pz - lx * s + lz * c];
      const rank = hash2(seed, cx, cz, 524) * 0.3;
      out.trs(ST.farmhouse, px - x0, h - 0.1, pz - z0, yaw, 1, 1, 1, 1, 1, 1, rank);
      const [bx, bz] = loc(22, 4);
      out.trs(ST.barn, bx - x0, groundAt(corr, bx, bz, PROBE, seed) - 0.1, bz - z0, yaw + Math.PI / 2, 1, 1, 1, 1, 1, 1, rank);
      // yard trees
      for (let k = 0; k < 3; k++) {
        const [tx, tz] = loc(-14 + 8 * k + 4 * hash2(seed, cx, cz, 530 + k), -15 - 4 * hash2(seed, cx, cz, 540 + k));
        const ts = 0.9 + 0.4 * hash2(seed, cx, cz, 550 + k);
        out.trs(ST.round, tx - x0, groundAt(corr, tx, tz, PROBE, seed) - 0.25, tz - z0, k * 2.1, ts, ts, ts, 1, 1, 1, rank);
      }
      // yard fence (rectangle 46 × 34 around the buildings, gap at the front)
      const fx0 = -14;
      const fx1 = 34;
      const fz0 = -12;
      const fz1 = 22;
      const edges: [number, number, number, number][] = [[fx0, fz0, fx1, fz0], [fx1, fz0, fx1, fz1], [fx1, fz1, fx0, fz1], [fx0, fz1, fx0, fz0]];
      for (let ei = 0; ei < 4; ei++) {
        const [ax0, az0, ax1, az1] = edges[ei];
        const len = Math.hypot(ax1 - ax0, az1 - az0);
        const segs = Math.round(len / 4);
        for (let k = 0; k < segs; k++) {
          if (ei === 0 && (k === 5 || k === 6)) continue; // gate
          const t0 = k / segs;
          const t1 = (k + 1) / segs;
          const [p0x, p0z] = loc(ax0 + (ax1 - ax0) * t0, az0 + (az1 - az0) * t0);
          const [p1x, p1z] = loc(ax0 + (ax1 - ax0) * t1, az0 + (az1 - az0) * t1);
          const y0 = groundAt(corr, p0x, p0z, PROBE, seed);
          const y1 = groundAt(corr, p1x, p1z, PROBE, seed);
          out.span(ST.fence, p0x - x0, y0, p0z - z0, p1x - p0x, y1 - y0, p1z - p0z, rank);
        }
      }
      // hay bales in the field beyond
      const nh = 3 + Math.floor(hash2(seed, cx, cz, 560) * 5);
      for (let k = 0; k < nh; k++) {
        const [hx2, hz2] = loc(-30 - 40 * hash2(seed, cx, cz, 570 + k), -10 + 50 * hash2(seed, cx, cz, 580 + k));
        const hy = groundAt(corr, hx2, hz2, PROBE, seed);
        if (PROBE.flat < 30 || hy < 0.8) continue;
        out.trs(ST.hay, hx2 - x0, hy, hz2 - z0, hash2(seed, cx, cz, 590 + k) * 6.28, 1, 1, 1, 1, 1, 1, rank);
      }
    }
  }

  // ── suburb houses near the city (pastel, on a loose lattice) ──
  if (CEN.city < 1900 && CEN.city > -100) {
    const L = 30;
    const i0 = Math.ceil(x0 / L);
    const i1 = Math.floor((x0 + CH - 0.001) / L);
    const j0 = Math.ceil(z0 / L);
    const j1 = Math.floor((z0 + CH - 0.001) / L);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const ax = i * L + (hash2(seed, i, j, 601) - 0.5) * 8;
        const az = j * L + (hash2(seed, i, j, 602) - 0.5) * 8;
        if (ax < x0 || ax >= x0 + CH || az < z0 || az >= z0 + CH) continue;
        const h = groundAt(corr, ax, az, INFO, seed);
        const p = 0.62 * (1 - sstep(400, 1750, INFO.city));
        if (hash2(seed, i, j, 603) > p || INFO.flat < 25 || h < 0.8) continue;
        const e = corr.empty ? 1e9 : corr.edgeDistance(ax, az);
        if (e < 16 || excluded(ax, az, INFO, seed, 10)) continue;
        const h2 = groundAt(corr, ax + 6, az + 6, PROBE, seed);
        if (Math.abs(h2 - h) > 1.6) continue;
        const col = PASTELS[Math.floor(hash2(seed, i, j, 604) * PASTELS.length)];
        const yaw = Math.floor(hash2(seed, i, j, 605) * 4) * (Math.PI / 2);
        const s = 0.9 + 0.25 * hash2(seed, i, j, 606);
        out.trs(ST.house, ax - x0, h - 0.1, az - z0, yaw, s, s * (0.9 + 0.3 * hash2(seed, i, j, 607)), s, col[0], col[1], col[2], hash2(seed, i, j, 608) * 0.4);
      }
    }
  }

  // ── cabins in pine forests / by lakes ──
  {
    const lakeNear = CEN.lake === CEN.lake || CEN.lakeR < 2.5;
    const pc = lakeNear ? 0.35 : 0.05;
    if (hash2(seed, cx, cz, 620) < pc && CEN.coast > 400 && CEN.flat > 600) {
      for (let k = 0; k < 6; k++) {
        const ax = x0 + 15 + 98 * hash2(seed, cx, cz, 621 + k);
        const az = z0 + 15 + 98 * hash2(seed, cx, cz, 631 + k);
        const h = groundAt(corr, ax, az, INFO, seed);
        if (h < 2 || (INFO.lake === INFO.lake && h < INFO.lake + 1)) continue;
        const cl = climate(ax, az, h, INFO.coast, seed);
        if (!lakeNear && forestAt(ax, az, cl.moist, seed) < 0.3) continue;
        const h2 = groundAt(corr, ax + 7, az + 5, PROBE, seed);
        if (Math.abs(h2 - h) > 1.4) continue;
        const e = corr.empty ? 1e9 : corr.edgeDistance(ax, az);
        if (e < 18) continue;
        out.trs(ST.cabin, ax - x0, h - 0.15, az - z0, hash2(seed, cx, cz, 640) * 6.28, 1, 1, 1, 1, 1, 1, 0.2);
        break;
      }
    }
  }

  // ── wind turbines on ridges ──
  {
    const L = 110;
    const i0 = Math.ceil(x0 / L);
    const i1 = Math.floor((x0 + CH - 0.001) / L);
    const j0 = Math.ceil(z0 / L);
    const j1 = Math.floor((z0 + CH - 0.001) / L);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const ax = i * L + (hash2(seed, i, j, 701) - 0.5) * 30;
        const az = j * L + (hash2(seed, i, j, 702) - 0.5) * 30;
        if (ax < x0 || ax >= x0 + CH || az < z0 || az >= z0 + CH) continue;
        const wind = n.n(ax / 5200 + 333.3, az / 5200 - 111.1);
        if (wind < 0.3 || hash2(seed, i, j, 703) > 0.75) continue;
        const h = groundAt(corr, ax, az, INFO, seed);
        if (h < 30 || h > 620 || INFO.coast < 350 || INFO.flat < 900) continue;
        let mean = 0;
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2 + 0.4;
          mean += groundAt(corr, ax + Math.cos(a) * 85, az + Math.sin(a) * 85, PROBE, seed);
        }
        mean /= 4;
        if (h < mean + 4) continue;
        const e = corr.empty ? 1e9 : corr.edgeDistance(ax, az);
        if (e < 40 || excluded(ax, az, INFO, seed, 30)) continue;
        const s = 0.9 + 0.25 * hash2(seed, i, j, 704);
        const yaw = -2.2 + (hash2(seed, i, j, 705) - 0.5) * 0.2;
        out.trs(ST.turbine, ax - x0, h - 0.5, az - z0, yaw, s, s, s, 1, 1, 1, 0);
        // rotor hub: 62 m up, 3.2 m in front of the tower axis
        const fx = Math.sin(yaw) * 3.2 * s;
        const fz = Math.cos(yaw) * 3.2 * s;
        out.trs(ST.rotor, ax - x0 + fx, h - 0.5 + 62 * s, az - z0 + fz, yaw, s, s, s, hash2(seed, i, j, 706), 1, 1, 0);
      }
    }
  }

  // ── power lines (pylons + cable spans) ──
  powerLines(out, corr, cx, cz, seed);

  // ── pasture fences along field borders ──
  if (CEN.coast > 150 && CEN.mtn < 0.3 && CEN.flat > 200) fences(out, corr, x0, z0, seed);

  return out.pack(cx, cz);
}

// ─────────────────────────────── power lines ───────────────────────────────

const PL_CELL = 4600;
const PL_SPAN = 290;
const PYLON_ATTACH = 27;

function powerNode(seed: number, i: number, j: number): { x: number; z: number } | null {
  if (hash2(seed, i, j, 801) > 0.72) return null;
  const x = (i + 0.5 + (hash2(seed, i, j, 802) - 0.5) * 0.55) * PL_CELL;
  const z = (j + 0.5 + (hash2(seed, i, j, 803) - 0.5) * 0.55) * PL_CELL;
  sampleTerrain(x, z, PROBE, seed);
  if (PROBE.coast < 500 || PROBE.flat < 400 || PROBE.h > 700) return null;
  return { x, z };
}

function pylonValid(corr: CorridorSet, x: number, z: number, info: TerrainInfo, seed: number): number {
  const h = groundAt(corr, x, z, info, seed);
  if (info.flat < 30 || h < 1 || info.coast < 120) return NaN;
  if (info.lake === info.lake && h < info.lake + 1) return NaN;
  const e = corr.empty ? 1e9 : corr.edgeDistance(x, z);
  if (e < 10) return NaN;
  return h;
}

const PYL = newInfo();
function powerLines(out: Out, corr: CorridorSet, cx: number, cz: number, seed: number): void {
  const x0 = cx * CH;
  const z0 = cz * CH;
  const ci = Math.floor((x0 + CH / 2) / PL_CELL);
  const cj = Math.floor((z0 + CH / 2) / PL_CELL);
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = ci + di;
      const j = cj + dj;
      const A = powerNode(seed, i, j);
      if (!A) continue;
      for (let dir = 0; dir < 2; dir++) {
        const ni = dir === 0 ? i + 1 : i;
        const nj = dir === 0 ? j : j + 1;
        if (hash2(seed, i, j, 810 + dir) > (dir === 0 ? 0.55 : 0.45)) continue;
        const B = powerNode(seed, ni, nj);
        if (!B) continue;
        const dx = B.x - A.x;
        const dz = B.z - A.z;
        const len = Math.hypot(dx, dz);
        // bbox reject
        const m = 20;
        if (Math.max(A.x, B.x) < x0 - m || Math.min(A.x, B.x) > x0 + CH + m || Math.max(A.z, B.z) < z0 - m || Math.min(A.z, B.z) > z0 + CH + m) continue;
        const spans = Math.max(1, Math.round(len / PL_SPAN));
        const yaw = Math.atan2(dx, dz) + Math.PI / 2; // arms across the line
        for (let k = 0; k <= spans; k++) {
          const px = A.x + (dx * k) / spans;
          const pz = A.z + (dz * k) / spans;
          if (px < x0 || px >= x0 + CH || pz < z0 || pz >= z0 + CH) continue;
          const y = pylonValid(corr, px, pz, PYL, seed);
          if (y !== y) continue;
          out.trs(ST.pylon, px - x0, y - 0.3, pz - z0, yaw, 1, 1, 1, 1, 1, 1, 0);
          if (k < spans) {
            const qx = A.x + (dx * (k + 1)) / spans;
            const qz = A.z + (dz * (k + 1)) / spans;
            const y2 = pylonValid(corr, qx, qz, PYL, seed);
            if (y2 === y2) out.span(ST.cable, px - x0, y + PYLON_ATTACH, pz - z0, qx - px, y2 - y, qz - pz, 0);
          }
        }
      }
    }
  }
}

// ─────────────────────────────── fences ───────────────────────────────

const FB: FieldBlock = { bi: 0, bj: 0, angle: 0, cos: 1, sin: 0, W: 50, L: 90, salt: 0 };
function fenced(seed: number, B: FieldBlock, fi: number, fj: number): boolean {
  const crop = cropOf(seed, B, fi, fj);
  if (crop !== CROP_PASTURE && crop !== CROP_FALLOW && crop !== CROP_WHEAT) return false;
  return hash2(seed, fi, fj, 906 + B.salt) < (crop === CROP_PASTURE ? 0.85 : 0.18);
}

function fences(out: Out, corr: CorridorSet, x0: number, z0: number, seed: number): void {
  const bi0 = Math.floor(x0 / FIELD_BLOCK);
  const bi1 = Math.floor((x0 + CH) / FIELD_BLOCK);
  const bj0 = Math.floor(z0 / FIELD_BLOCK);
  const bj1 = Math.floor((z0 + CH) / FIELD_BLOCK);
  const SEG = 4;
  for (let bj = bj0; bj <= bj1; bj++) {
    for (let bi = bi0; bi <= bi1; bi++) {
      const B = fieldBlock(seed, bi, bj, FB);
      // chunk corners in (u, v)
      let umin = 1e18, umax = -1e18, vmin = 1e18, vmax = -1e18;
      for (const [x, z] of [[x0, z0], [x0 + CH, z0], [x0, z0 + CH], [x0 + CH, z0 + CH]]) {
        const u = x * B.cos + z * B.sin;
        const v = -x * B.sin + z * B.cos;
        if (u < umin) umin = u;
        if (u > umax) umax = u;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
      for (let axis = 0; axis < 2; axis++) {
        const Wl = axis === 0 ? B.W : B.L; // spacing of border lines
        const Ws = axis === 0 ? B.L : B.W; // field size along the line
        const a0 = axis === 0 ? umin : vmin;
        const a1 = axis === 0 ? umax : vmax;
        const b0 = axis === 0 ? vmin : umin;
        const b1 = axis === 0 ? vmax : umax;
        for (let k = Math.ceil(a0 / Wl); k <= Math.floor(a1 / Wl); k++) {
          const a = k * Wl;
          for (let b = Math.floor(b0 / SEG) * SEG; b < b1; b += SEG) {
            const bm = b + SEG / 2;
            const fAlong = Math.floor(bm / Ws);
            // fields on both sides of this border segment
            const fa = axis === 0 ? fenced(seed, B, k - 1, fAlong) || fenced(seed, B, k, fAlong) : fenced(seed, B, fAlong, k - 1) || fenced(seed, B, fAlong, k);
            if (!fa) continue;
            const u0 = axis === 0 ? a : b;
            const v0 = axis === 0 ? b : a;
            const u1 = axis === 0 ? a : b + SEG;
            const v1 = axis === 0 ? b + SEG : a;
            const px = u0 * B.cos - v0 * B.sin;
            const pz = u0 * B.sin + v0 * B.cos;
            const qx = u1 * B.cos - v1 * B.sin;
            const qz = u1 * B.sin + v1 * B.cos;
            const mx = (px + qx) / 2;
            const mz = (pz + qz) / 2;
            if (mx < x0 || mx >= x0 + CH || mz < z0 || mz >= z0 + CH) continue;
            if (Math.floor(mx / FIELD_BLOCK) !== bi || Math.floor(mz / FIELD_BLOCK) !== bj) continue;
            const y0 = groundAt(corr, px, pz, INFO, seed);
            const fm = farmMaskAt(mx, mz, seed);
            if (fm < 0.6 || INFO.flat < 200 || y0 < 1 || y0 > 165 || INFO.coast < 120) continue;
            const e = corr.empty ? 1e9 : corr.edgeDistance(mx, mz);
            if (e < 5) continue;
            const y1 = groundAt(corr, qx, qz, PROBE, seed);
            if (Math.abs(y1 - y0) > 2.5) continue;
            out.span(ST.fence, px - x0, y0, pz - z0, qx - px, y1 - y0, qz - pz, 0);
          }
        }
      }
    }
  }
}
