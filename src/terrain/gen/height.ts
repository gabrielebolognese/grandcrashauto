import { CONFIG } from '../../config';
import { hash2, mix, noiseFor, smin, sstep, type Noise2 } from './noise';

/**
 * NATURAL terrain height (before highway corridor carving) in ABSOLUTE coordinates. PURE + worker-safe.
 *
 * Layers: coastline (west + south ocean, procedural wiggle, headland, cove, cliffs, dunes, islets) → continentalness
 * (flat suburbs/farmland near the city and coast, rolling hills, ridged mountains up to ~950 m, valleys, mesas) →
 * the Summit peak → lakes in basins → flat zones blended to the city/airport ground.
 *
 * `baseHeight(ax, az)` is imported by the highway generator (route planning): keep it fast (~1–2 µs).
 */

// City beach profile (mirrors the world module's city beach so the coast continues seamlessly).
export const SHORE_Z = 335; // y = 0 water line next to the city
export const SEA_WALL_Z = 300; // promenade sea wall centre line
export const SAND_TOP = 0.85;
const BEACH_START_Z = SEA_WALL_Z + 0.4;

export interface TerrainInfo {
  h: number;
  /** Signed inland distance from the coastline (m); < 0 offshore. */
  coast: number;
  /** 0..1 cliffiness of the nearest coast. */
  cliff: number;
  /** 0..1 mountain mask. */
  mtn: number;
  /** Signed distance to the city/airport rectangles (m); < 0 inside. */
  flat: number;
  /** Signed distance to the city rectangle only. */
  city: number;
  /** Lake water level, or NaN. */
  lake: number;
  /** Normalised radius inside the nearest lake (r / R); 9 when none. */
  lakeR: number;
  /** 0..1 weight of the city sea-wall coast zone. */
  zone: number;
  /** 0..1 dune factor. */
  dune: number;
  /** 0..1 relief scale (0 next to the city/airport). */
  relief: number;
}

export function newInfo(): TerrainInfo {
  return { h: 0, coast: 0, cliff: 0, mtn: 0, flat: 0, city: 0, lake: NaN, lakeR: 9, zone: 0, dune: 0, relief: 0 };
}

const SCRATCH = newInfo();

/** Natural terrain height (m) at ABSOLUTE (ax, az). */
export function baseHeight(ax: number, az: number, seed = CONFIG.game.seed): number {
  return sampleTerrain(ax, az, SCRATCH, seed);
}

// ─────────────────────────────── features (seeded, analytic) ───────────────────────────────

export interface FeatureSet {
  seed: number;
  lighthouseX: number;
  pierX: number;
  coveX: number;
  summitX: number;
  summitZ: number;
  summitTop: number;
  /** z of the lighthouse (70 m inland of the headland tip). */
  lighthouseZ: number;
}

let featCache: FeatureSet | null = null;
export function features(seed = CONFIG.game.seed): FeatureSet {
  if (featCache && featCache.seed === seed) return featCache;
  const T = CONFIG.terrain;
  featCache = {
    seed,
    lighthouseX: T.lighthouseX + (hash2(seed, 1, 2, 51) - 0.5) * 500,
    pierX: T.pierX + (hash2(seed, 3, 4, 52) - 0.5) * 300,
    coveX: T.coveX,
    summitX: 4300 + (hash2(seed, 5, 6, 53) - 0.5) * 1800,
    summitZ: -9400 + (hash2(seed, 7, 8, 54) - 0.5) * 1800,
    summitTop: 978,
    lighthouseZ: 0,
  };
  featCache.lighthouseZ = southShoreZ(featCache.lighthouseX, seed) - 70;
  return featCache;
}

// ─────────────────────────────── coastline ───────────────────────────────

/** z of the south coastline at absolute x (ocean at larger z). */
export function southShoreZ(ax: number, seed = CONFIG.game.seed): number {
  const n = noiseFor(seed);
  const F = features(seed);
  const T = CONFIG.terrain;
  const ramp = sstep(T.seaWallEndX, T.seaWallEndX + 1300, ax);
  let w = 0;
  if (ramp > 0) {
    const dp = (ax - F.pierX) / 380;
    const calm = 1 - 0.75 * Math.exp(-dp * dp);
    w = ramp * calm * CONFIG.world.coast.wiggle * (0.68 * n.n(ax / 1350, 11.3) + 0.32 * n.n(ax / 430, 37.9));
    const dl = (ax - F.lighthouseX) / 230;
    w += 300 * Math.exp(-dl * dl); // the lighthouse headland
    const dc = (ax - F.coveX) / 520;
    w -= 200 * Math.exp(-dc * dc); // shallow cove (the Coastal Bridge crosses its mouth)
  }
  return SHORE_Z + w;
}

/** x of the west coastline at absolute z (ocean at smaller x). */
export function westShoreX(az: number, seed = CONFIG.game.seed): number {
  const n = noiseFor(seed);
  const ramp = sstep(-1300, -2700, az);
  let w = 0;
  if (ramp > 0) w = ramp * CONFIG.world.coast.wiggle * (0.65 * n.n(az / 1400, 71.1) + 0.35 * n.n(az / 450, 93.3));
  return CONFIG.world.coast.westX - w;
}

function cliffSouth(n: Noise2, F: FeatureSet, ax: number): number {
  const T = CONFIG.terrain;
  let c = sstep(0.0, 0.42, n.n(ax / 2600, 5.5)) * sstep(T.seaWallEndX + 300, T.seaWallEndX + 1600, ax);
  const dl = (ax - F.lighthouseX) / 420;
  c = Math.max(c, Math.exp(-dl * dl));
  const dp = (ax - F.pierX) / 420;
  c *= 1 - Math.exp(-dp * dp);
  return c;
}

function cliffWest(n: Noise2, az: number): number {
  return sstep(-0.05, 0.38, n.n(az / 2800, 15.5)) * sstep(-1500, -2900, az);
}

/** Signed inland distance to the coastline (m, < 0 offshore) — cheap (no relief). */
export function coastDistance(ax: number, az: number, seed = CONFIG.game.seed): number {
  const dW = ax - westShoreX(az, seed);
  const dS = southShoreZ(ax, seed) - az;
  return smin(dW, dS, 260);
}

/** Metres offshore (0 over land). */
export function oceanDistanceAbs(ax: number, az: number, seed = CONFIG.game.seed): number {
  const c = coastDistance(ax, az, seed);
  return c < 0 ? -c : 0;
}

/** The world module's city beach profile (z only + a gentle x undulation), valid for z > the sea wall. */
export function cityBeach(ax: number, az: number): number {
  const und = 0.1 * Math.sin(ax * 0.021 + 1.3) + 0.06 * Math.sin(ax * 0.057 + 0.4);
  if (az <= BEACH_START_Z) return SAND_TOP;
  if (az < SHORE_Z) {
    const t = (az - BEACH_START_Z) / (SHORE_Z - BEACH_START_Z);
    return SAND_TOP * (1 - t) + und * Math.sin(t * Math.PI);
  }
  if (az < 365) return -0.9 * ((az - SHORE_Z) / 30) + und * 0.5;
  if (az < 420) {
    const t = (az - 365) / 55;
    return -0.9 - 5.1 * (t * t * (3 - 2 * t));
  }
  return -6 - Math.min(3, (az - 420) * 0.012);
}

/** Signed distance to an axis-aligned rectangle (> 0 outside). */
export function rectDist(ax: number, az: number, r: { minX: number; maxX: number; minZ: number; maxZ: number }): number {
  const dx = Math.max(r.minX - ax, ax - r.maxX);
  const dz = Math.max(r.minZ - az, az - r.maxZ);
  if (dx <= 0 && dz <= 0) return Math.max(dx, dz);
  const ox = dx > 0 ? dx : 0;
  const oz = dz > 0 ? dz : 0;
  return Math.sqrt(ox * ox + oz * oz);
}

// ─────────────────────────────── islets ───────────────────────────────

interface Islet {
  x: number;
  z: number;
  R: number;
  H: number;
}
const isletCache = new Map<number, Islet | null>();
let isletSeed = NaN;

function isletAt(seed: number, ci: number, cj: number): Islet | null {
  if (isletSeed !== seed || isletCache.size > 30000) {
    isletCache.clear();
    isletSeed = seed;
  }
  const key = ci * 131071 + cj;
  const hit = isletCache.get(key);
  if (hit !== undefined) return hit;
  let res: Islet | null = null;
  const T = CONFIG.terrain.islet;
  if (hash2(seed, ci, cj, 301) < T.chance) {
    const x = (ci + 0.15 + 0.7 * hash2(seed, ci, cj, 302)) * T.cell;
    const z = (cj + 0.15 + 0.7 * hash2(seed, ci, cj, 303)) * T.cell;
    const c = coastDistance(x, z, seed);
    const F = features(seed);
    const nearCove = Math.abs(x - F.coveX) < 900 && z > SHORE_Z - 400 && z < SHORE_Z + 1200;
    const nearPier = Math.abs(x - F.pierX) < 500 && z < SHORE_Z + 800;
    const nearCity = x > -800 && x < 1600 && z < 1100; // keep the city's sea view to the env's own islands
    if (c < -170 && c > -1900 && !nearCove && !nearPier && !nearCity) {
      const hR = hash2(seed, ci, cj, 304);
      res = { x, z, R: 38 + 125 * hR, H: 6 + 30 * Math.pow(hash2(seed, ci, cj, 305), 1.4) * (0.5 + hR) };
    }
  }
  isletCache.set(key, res);
  return res;
}

function isletHeight(n: Noise2, seed: number, ax: number, az: number): number {
  const cell = CONFIG.terrain.islet.cell;
  const ci = Math.floor(ax / cell);
  const cj = Math.floor(az / cell);
  let best = -1e9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const isl = isletAt(seed, ci + di, cj + dj);
      if (!isl) continue;
      const dx = ax - isl.x;
      const dz = az - isl.z;
      const r2 = (dx * dx + dz * dz) / (isl.R * isl.R);
      if (r2 >= 1.44) continue;
      const wob = 1 + 0.28 * n.n(ax / 48 + isl.x * 0.013, az / 48 - isl.z * 0.011);
      const q = 1 - r2 / 1.44;
      const s = isl.H * Math.pow(q, 1.6) * wob - 3.5;
      if (s > best) best = s;
    }
  }
  return best;
}

// ─────────────────────────────── lakes ───────────────────────────────

export interface Lake {
  key: number;
  x: number;
  z: number;
  R: number;
  W: number;
  level: number;
  depth: number;
}
const lakeCache = new Map<number, Lake | null>();
let lakeSeed = NaN;
const LAKE_INFO = newInfo();

export function lakeAtCell(seed: number, ci: number, cj: number): Lake | null {
  if (lakeSeed !== seed || lakeCache.size > 20000) {
    lakeCache.clear();
    lakeSeed = seed;
  }
  const key = ci * 65521 + cj;
  const hit = lakeCache.get(key);
  if (hit !== undefined) return hit;
  let res: Lake | null = null;
  const T = CONFIG.terrain.lake;
  if (hash2(seed, ci, cj, 401) < T.chance) {
    const R = 110 + 230 * hash2(seed, ci, cj, 402);
    let x = (ci + 0.22 + 0.56 * hash2(seed, ci, cj, 403)) * T.cell;
    let z = (cj + 0.22 + 0.56 * hash2(seed, ci, cj, 404)) * T.cell;
    const c0 = coastDistance(x, z, seed);
    const cityD = rectDist(x, z, CONFIG.world.cityBounds);
    const airD = rectDist(x, z, CONFIG.world.airportBounds);
    const F = features(seed);
    const sd = Math.hypot(x - F.summitX, z - F.summitZ);
    if (c0 > 1300 && cityD > 1500 && airD > 1200 && sd > 2900) {
      // settle into the lowest of 7 candidates (basins)
      let h0 = rawHeight(x, z, LAKE_INFO, seed);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3;
        const px = x + Math.cos(a) * R * 0.6;
        const pz = z + Math.sin(a) * R * 0.6;
        const hk = rawHeight(px, pz, LAKE_INFO, seed);
        if (hk < h0) {
          h0 = hk;
          x = px;
          z = pz;
        }
      }
      let rimMin = 1e9;
      let rimMax = -1e9;
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const hk = rawHeight(x + Math.cos(a) * R * 1.3, z + Math.sin(a) * R * 1.3, LAKE_INFO, seed);
        if (hk < rimMin) rimMin = hk;
        if (hk > rimMax) rimMax = hk;
      }
      const level = h0 + 2.2;
      if (level > 4 && level < 720 && rimMin > level - 3.0 && rimMax - rimMin < 120) {
        res = { key, x, z, R, W: 46 + 0.15 * R, level, depth: 3 + 7 * hash2(seed, ci, cj, 405) };
      }
    }
  }
  lakeCache.set(key, res);
  return res;
}

/** Lakes whose influence may touch the absolute rectangle. */
export function lakesInRect(minX: number, minZ: number, maxX: number, maxZ: number, seed = CONFIG.game.seed, out: Lake[] = []): Lake[] {
  const cell = CONFIG.terrain.lake.cell;
  const m = 420;
  const i0 = Math.floor((minX - m) / cell);
  const i1 = Math.floor((maxX + m) / cell);
  const j0 = Math.floor((minZ - m) / cell);
  const j1 = Math.floor((maxZ + m) / cell);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const L = lakeAtCell(seed, i, j);
      if (!L) continue;
      const ext = (L.R + L.W) * 1.3;
      if (L.x + ext < minX || L.x - ext > maxX || L.z + ext < minZ || L.z - ext > maxZ) continue;
      out.push(L);
    }
  }
  return out;
}

/** Lake wobble radius multiplier at an absolute point (organic shorelines). */
export function lakeWobble(n: Noise2, L: Lake, ax: number, az: number): number {
  return 1 + 0.2 * n.n(ax / 140 + L.x * 0.0007, az / 140 - L.z * 0.0009);
}

// ─────────────────────────────── main sampler ───────────────────────────────

/**
 * Everything except lakes: coast, relief, mountains, features. Fills `out` (coast, cliff, mtn, zone, dune, relief).
 * The city/airport flattening is applied in sampleTerrain().
 */
export function rawHeight(ax: number, az: number, out: TerrainInfo, seed = CONFIG.game.seed): number {
  const n = noiseFor(seed);
  const F = features(seed);
  const W = CONFIG.world;
  const T = CONFIG.terrain;

  // ── coastline ──
  const dW = ax - westShoreX(az, seed);
  const dS = southShoreZ(ax, seed) - az;
  const c = smin(dW, dS, 260);
  const tSouth = sstep(-150, 150, dW - dS); // 1 → the south coast is the nearer one
  const cl = mix(cliffWest(n, az), cliffSouth(n, F, ax), tSouth);
  const zone = (1 - sstep(T.seaWallEndX, T.seaWallEndX + 450, ax)) * sstep(W.coast.westX + 140, W.coast.westX + 420, ax) * tSouth;

  // ── flat zones (city + airport) ──
  const city = rectDist(ax, az, W.cityBounds);
  const air = rectDist(ax, az, W.airportBounds);
  const flat = city < air ? city : air;
  const relief = sstep(40, 2300, flat);

  out.coast = c;
  out.cliff = cl;
  out.flat = flat;
  out.city = city;
  out.zone = zone;
  out.relief = relief;
  out.lake = NaN;
  out.lakeR = 9;
  out.dune = 0;
  out.mtn = 0;

  let h: number;
  if (c >= 0) {
    const inland = c;
    const cont = n.fbm(ax / 11000 + 13.7, az / 11000 - 4.1, 3);
    // domain-warped coordinates for natural ridgelines
    const wx = ax + 480 * n.fbm(ax / 2700 + 3.1, az / 2700 - 1.7, 2);
    const wz = az + 480 * n.fbm(ax / 2700 - 7.3, az / 2700 + 4.9, 2);
    // long valleys through the hills/mountains (the highway likes them)
    const vn = Math.abs(n.n(wx / 5600 + 21.1, wz / 5600 - 8.8));
    const valley = sstep(0.015, 0.17, vn);
    // rolling hills
    const hillAmp = (9 + 78 * sstep(300, 4200, inland + cont * 1400)) * relief;
    let hills = hillAmp * (0.5 + 0.5 * n.fbm(wx / 1500, wz / 1500, 5));
    hills *= 0.35 + 0.65 * valley;
    const detail = (0.8 + 2.6 * relief) * n.fbm(ax / 170 + 5.5, az / 170 + 2.2, 3);
    // mountains: ridged multifractal, gated by continentalness and distance from the flat zones
    const mtn = sstep(1800, 7600, inland + cont * 2600) * sstep(1800, 5000, flat);
    let mount = 0;
    if (mtn > 0.001) {
      const r = n.ridged(wx / 3500, wz / 3500, 6);
      mount = 1010 * Math.pow(r, 1.6) * mtn * (0.28 + 0.72 * valley);
      const pm = sstep(0.2, 0.42, n.n(ax / 7200 + 50.5, az / 7200 - 30.1)); // mesas / plateaus
      if (pm > 0) {
        const L = 250 + 160 * n.n(ax / 4000 + 9.9, az / 4000);
        if (mount > L) mount = L + (mount - L) * mix(1, 0.14, pm);
      }
    }
    out.mtn = mtn;
    let land = 1.0 + 1.2 * relief + hills + detail + mount;

    // the Summit: a dedicated tall peak (max with the natural ridges) with a viewpoint platform on top
    const sdx = ax - F.summitX;
    const sdz = az - F.summitZ;
    const sr2 = sdx * sdx + sdz * sdz;
    if (sr2 < 2700 * 2700) {
      const sr = Math.sqrt(sr2);
      const q = 1 - sr / 2700;
      const rid = n.ridged(ax / 900 + 3.7, az / 900 - 1.9, 3);
      const peak = (F.summitTop + 10) * Math.pow(q, 1.55) * (0.9 + 0.1 * rid);
      if (peak > land) land = mix(land, peak, sstep(0, 0.25, q));
      if (sr < 60) land = mix(F.summitTop, land, sstep(20, 55, sr));
    }

    // coast shaping: beach rise, dunes, cliffs
    const beach = Math.min(2.4, c * 0.065);
    const duneF = (1 - cl) * sstep(18, 55, c) * (1 - sstep(170, 330, c)) * (1 - zone);
    const dunes = duneF * 3.4 * Math.max(0, n.fbm(ax / 55 + 1.3, az / 55 - 7.7, 2) + 0.2);
    out.dune = duneF;
    const landW = mix(650, 80, cl);
    const t = sstep(mix(25, 0, cl), landW, c);
    const cliffBoost = cl * (15 + 22 * (0.5 + 0.5 * n.n(ax / 900 + 3.3, az / 900 - 5.1))) * sstep(4, 55, c);
    h = beach + dunes + (land + cliffBoost) * t;

    // the lighthouse headland: a flat grassy top
    const ldx = ax - F.lighthouseX;
    const ldz = az - F.lighthouseZ;
    const lr2 = ldx * ldx + ldz * ldz;
    if (lr2 < 90 * 90) h = mix(26, h, sstep(32, 80, Math.sqrt(lr2)));
  } else {
    const d = -c;
    const steep = 1 + cl * 1.3;
    h = -(1.4 * sstep(0, 40, d) + 7 * sstep(15, 320, d * steep) + 24 * sstep(150, 1700, d)) - cl * 9 * sstep(0, 35, d);
    if (d > 60) {
      const isl = isletHeight(n, seed, ax, az);
      if (isl > h) h = isl;
    }
  }

  // the promenade coast next to the city / airport: city beach profile + low land behind the sea wall
  if (zone > 0) {
    if (az > BEACH_START_Z) h = mix(h, cityBeach(ax, az), zone);
    else h = mix(h, mix(0.12, h, sstep(0, 170, SEA_WALL_Z - az)), zone);
  }
  return h;
}

/** Full natural height with lakes and flat-zone blending; fills `out`. */
export function sampleTerrain(ax: number, az: number, out: TerrainInfo, seed = CONFIG.game.seed): number {
  let h = rawHeight(ax, az, out, seed);
  const flat = out.flat;
  // Ground level of the nearer flat zone: the airport is raised to CONFIG.world.airportElevation (world module).
  const zoneGround = flat !== out.city ? (CONFIG.world.airportElevation ?? 0) : 0;
  if (flat < 0) {
    // inside the city / airport: below their ground (never rendered; colliders stay under the world's ground)
    h = (out.zone > 0 && az > BEACH_START_Z ? Math.min(zoneGround, cityBeach(ax, az)) : zoneGround) - 1.0;
    out.h = h;
    return h;
  }
  // lakes (inland only)
  if (out.coast > 1100 && flat > 900) {
    const n = noiseFor(seed);
    const near = lakeNeighbourhood(seed, ax, az);
    for (let k = 0; k < near.length; k++) {
      {
        const L = near[k];
        const dx = ax - L.x;
        const dz = az - L.z;
        const lim = (L.R + L.W) * 1.25 + 30;
        if (dx * dx + dz * dz > lim * lim) continue;
        const re = Math.sqrt(dx * dx + dz * dz) / (L.R * lakeWobble(n, L, ax, az));
        const outer = 1 + L.W / L.R;
        if (re >= outer + 0.4) continue;
        // bowl + gentle banks (only lowers)
        const bowl = re < 1 ? L.level - 0.45 - L.depth * (1 - re * re) : L.level - 0.45 + (re - 1) * L.R * 0.12;
        if (bowl < h) h = bowl;
        // closed rim (only raises): the water plane never floats over lower ground
        if (re >= 1 && re < outer) {
          const u = (re - 1) / (outer - 1);
          const levee = mix(L.level + 0.35, h, sstep(0.55, 1, u));
          if (levee > h) h = levee;
        }
        if (re < out.lakeR) {
          out.lakeR = re;
          out.lake = L.level;
        }
      }
    }
  }
  // blend into the flat zones' ground level at their borders
  if (flat < 300) {
    const edge = out.zone > 0 && az > BEACH_START_Z ? cityBeach(ax, az) : zoneGround;
    h = mix(edge, h, sstep(0, 300, flat));
  }
  out.h = h;
  return h;
}

// 3×3 lake-cell neighbourhood cache (consecutive samples are almost always in the same cell)
let nbKey = NaN;
let nbSeed = NaN;
const nbList: Lake[] = [];
function lakeNeighbourhood(seed: number, ax: number, az: number): Lake[] {
  const cell = CONFIG.terrain.lake.cell;
  const ci = Math.floor(ax / cell);
  const cj = Math.floor(az / cell);
  const key = ci * 65521 + cj;
  if (key === nbKey && seed === nbSeed && lakeSeed === seed) return nbList;
  nbKey = key;
  nbSeed = seed;
  nbList.length = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const L = lakeAtCell(seed, ci + di, cj + dj);
      if (L) nbList.push(L);
    }
  }
  return nbList;
}

/** Lake water level at an absolute point (inside the lake's shoreline), or NaN. */
export function lakeLevelAt(ax: number, az: number, seed = CONFIG.game.seed): number {
  const cell = CONFIG.terrain.lake.cell;
  const ci = Math.floor(ax / cell);
  const cj = Math.floor(az / cell);
  const n = noiseFor(seed);
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const L = lakeAtCell(seed, ci + di, cj + dj);
      if (!L) continue;
      const dx = ax - L.x;
      const dz = az - L.z;
      const lim = (L.R + L.W) * 1.3;
      if (dx * dx + dz * dz > lim * lim) continue;
      const re = Math.sqrt(dx * dx + dz * dz) / (L.R * lakeWobble(n, L, ax, az));
      if (re < 1.05) return L.level;
    }
  }
  return NaN;
}
