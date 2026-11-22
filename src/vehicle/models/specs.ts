import type { CarModelId } from '../CarBuild';
import { curve, type Curve } from './util';
import { R } from './regions';

/**
 * The four original body designs. All numbers are metres in car space: +Z forward, +X = left side, Y up,
 * origin on the ground under the car centre. Profile curves are monotone cubics through [z, value] points.
 */

export interface QuadInfo {
  /** 0 loft, 1 front cap, -1 rear cap */
  kind: 0 | 1 | -1;
  /** Half-ring band (lower slot index). */
  band: number;
  side: 1 | -1;
  z: number;
  y: number;
  x: number;
  /** Cap column centre as a fraction of the rung half-width (0 centre .. 1 edge). Loft: 1. */
  cf: number;
  /** Greenhouse height at this z. */
  H: number;
}

export interface EndSpec {
  /** Plan-view corner radius. */
  round: number;
  pow: number;
  /** Length over which the rake shear fades in. */
  zone: number;
  /** z shear per metre above rakeY: front > 0 sets the top back; rear > 0 sets the top forward. */
  rake: number;
  rakeY: number;
  /** Cap convexity (m at the centre). */
  bulge: number;
  crease: boolean;
}

export type ExhaustKind = 'twinCenter' | 'dualSides' | 'single' | 'twinSquare';
export type GrilleKind = 'blades' | 'eggcrate' | 'bars' | 'slats';

export interface CarSpec {
  id: CarModelId;
  name: string;
  description: string;
  zRear: number;
  zFront: number;
  axleF: number;
  axleR: number;
  halfTrack: number;
  /** Overall wheel radius at size 1 / mid profile. */
  wheelR: number;
  wheelW: number;
  mass: number;
  sill: Curve;
  belt: Curve;
  halfW: Curve;
  crown: Curve;
  floorDrop: number;
  sideT: number[];
  sideInset: number[];
  shoulderIn: number;
  topR: number;
  hoodEdge: number;
  creases: number[];
  flare?: { front: number; rear: number; len: number };
  hoodBulge?: { h: number; w: number; z0: number; z1: number };
  cabin: { H: Curve; cabinW: Curve; roofW: Curve; zBl: number; zRoofRear: number; zWsTop: number; zCowl: number; cornerR: number; crown: number };
  front: EndSpec;
  rear: EndSpec;
  capCols: number[];
  capColsLow: number[];
  breaks: number[];
  classify: (q: QuadInfo) => number;
  doors: { f0: number; f1: number; r0?: number; r1?: number };
  hood: { z0: number; z1: number };
  trunk: { z0: number; z1: number; hatch: boolean };
  bumperChrome: boolean;
  /** Paint-shader stripe geometry: center half-width, twin inner/outer, side band y0/y1 + slope, side z range. */
  stripe: { center: number; twinIn: number; twinOut: number; sideY0: number; sideY1: number; sideSlope: number; sideZ0: number; sideZ1: number };
  details: {
    mirrorZ: number;
    handleZ: number;
    handleSlot: number;
    exhaust: ExhaustKind;
    exhaustX: number;
    exhaustY: number;
    plateFY: number;
    plateRY: number;
    plateROnTrunk: boolean;
    grille: GrilleKind;
    /** Grille bar area on the front cap: band range and half-width fraction. */
    grilleBands: [number, number];
    grilleCf: number;
    roundLamps?: { y: number; cfs: number[]; r: number };
    roofRails: boolean;
    archFlares: boolean;
    seats4: boolean;
    cabinRear: number;
    pillarBlack: boolean;
  };
  kit: {
    spoilerZ: number;
    spoilerRoof: boolean;
    scoop: { z0: number; z1: number; w: number; h: number };
    splitterDepth: number;
  };
}

const inZ = (q: QuadInfo, a: number, b: number) => q.z > a && q.z < b;

/** Shared greenhouse logic (bands ≥ 15 where the cabin exists). Returns -1 if not applicable. */
function greenhouse(
  q: QuadInfo,
  c: CarSpec['cabin'],
  o: { cowlStrip: number; sideF: number; sideR: number; pillars: [number, number][]; pillarBlack: boolean; aPillarBlack?: boolean },
): number {
  if (q.band < 15 || q.H <= 1e-4 || q.kind !== 0) return -1;
  const top = q.band >= 19;
  const corner = q.band === 17 || q.band === 18;
  const ws = inZ(q, c.zWsTop, c.zCowl);
  const bl = inZ(q, c.zBl, c.zRoofRear);
  if (top) {
    if (ws) return q.z > o.cowlStrip ? R.BLACK : R.GLASS;
    if (bl) return R.GLASS;
    return R.ROOF;
  }
  if (corner) {
    if (o.aPillarBlack && (ws || bl)) return R.BLACK;
    return R.ROOF;
  }
  // side rows
  if (inZ(q, o.sideR, o.sideF)) {
    for (const [a, b] of o.pillars) if (inZ(q, a, b)) return o.pillarBlack ? R.BLACK : R.ROOF;
    return R.GLASS;
  }
  return R.ROOF;
}

/** Shared lower-body logic: hood, trunk lid, doors, bumpers. */
function lowerBody(
  q: QuadInfo,
  s: { axleF: number; axleR: number; wheelR: number },
  o: { hood: [number, number]; trunk?: [number, number]; door: [number, number]; rdoor?: [number, number]; bumperTopF: number; bumperTopR: number },
): number {
  const Ra = s.wheelR * 1.143 + 0.022;
  const deckish = q.band >= 13 && (q.band < 15 || q.H <= 1e-4);
  if (q.kind === 0) {
    if (deckish && inZ(q, o.hood[0], o.hood[1])) return R.HOOD;
    if (deckish && o.trunk && inZ(q, o.trunk[0], o.trunk[1])) return R.TRUNK;
    if (q.band >= 3 && q.band < o.bumperTopF && q.z > s.axleF + Ra - 1e-4) return R.BUMPER_F;
    if (q.band >= 3 && q.band < o.bumperTopR && q.z < s.axleR - Ra + 1e-4) return R.BUMPER_R;
    if (q.band >= 5 && q.band < 15 && inZ(q, o.door[0], o.door[1])) return q.side > 0 ? R.DOOR_L : R.DOOR_R;
    if (o.rdoor && q.band >= 5 && q.band < 15 && inZ(q, o.rdoor[0], o.rdoor[1])) return q.side > 0 ? R.RDOOR_L : R.RDOOR_R;
    return -1;
  }
  if (q.kind === 1 && q.band >= 3 && q.band < o.bumperTopF) return R.BUMPER_F;
  if (q.kind === -1 && q.band >= 3 && q.band < o.bumperTopR) return R.BUMPER_R;
  return -1;
}

// ───────────────────────────── Tidewing GT (coupe) ─────────────────────────────
const CZ = {
  cowlStrip: 0.935,
  sideF: 0.86,
  sideR: -1.02,
  bA: -0.45,
  bB: -0.39,
  doorF: 0.9,
  doorR: -0.42,
  hoodF: 2.1,
  trunkF: -1.76,
  trunkR: -2.1,
  headZ: 1.96,
  tailZ: -2.06,
};
const coupe: CarSpec = {
  id: 'coupe',
  name: 'Tidewing GT',
  description: 'Low fastback coupe with wide rear haunches and a full-width light bar. Light, sharp and eager to rotate.',
  zRear: -2.18,
  zFront: 2.22,
  axleF: 1.34,
  axleR: -1.26,
  halfTrack: 0.8,
  wheelR: 0.335,
  wheelW: 0.245,
  mass: 1250,
  sill: curve([
    [-2.18, 0.31],
    [-1.98, 0.25],
    [-1.72, 0.215],
    [1.7, 0.205],
    [2.0, 0.2],
    [2.22, 0.21],
  ]),
  belt: curve([
    [-2.18, 0.73],
    [-2.02, 0.8],
    [-1.62, 0.845],
    [-1.26, 0.862],
    [-0.75, 0.835],
    [0.1, 0.8],
    [0.85, 0.785],
    [1.34, 0.808],
    [1.75, 0.765],
    [2.02, 0.655],
    [2.22, 0.53],
  ]),
  halfW: curve([
    [-2.18, 0.86],
    [-1.92, 0.93],
    [-1.3, 0.958],
    [-0.65, 0.925],
    [0.2, 0.9],
    [0.95, 0.905],
    [1.4, 0.912],
    [1.9, 0.89],
    [2.22, 0.84],
  ]),
  crown: curve([
    [-2.18, 0.02],
    [-1.7, 0.012],
    [0.9, 0.02],
    [1.15, -0.022],
    [1.75, -0.012],
    [2.22, 0.012],
  ]),
  floorDrop: 0.06,
  sideT: [0.06, 0.22, 0.42, 0.6, 0.82],
  sideInset: [0.085, 0.06, 0.02, 0.0, 0.004, 0.03],
  shoulderIn: 0.075,
  topR: 0.06,
  hoodEdge: 0.3,
  creases: [1, 2, 4, 8, 15, 17],
  flare: { front: 0.006, rear: 0.022, len: 0.42 },
  cabin: {
    H: curve([
      [-1.72, 0],
      [-1.42, 0.115],
      [-1.0, 0.265],
      [-0.55, 0.365],
      [-0.1, 0.4],
      [0.3, 0.388],
      [0.58, 0.29],
      [0.98, 0],
    ]),
    cabinW: curve([
      [-2.18, 0.5],
      [-1.72, 0.6],
      [-0.8, 0.735],
      [0.3, 0.765],
      [0.98, 0.745],
      [2.22, 0.6],
    ]),
    roofW: curve([
      [-1.72, 0.42],
      [-0.8, 0.59],
      [0.2, 0.62],
      [0.98, 0.6],
    ]),
    zBl: -1.72,
    zRoofRear: -0.55,
    zWsTop: 0.3,
    zCowl: 0.98,
    cornerR: 0.07,
    crown: 0.045,
  },
  front: { round: 0.32, pow: 2.2, zone: 0.42, rake: 0.55, rakeY: 0.33, bulge: 0.045, crease: false },
  rear: { round: 0.22, pow: 2.4, zone: 0.3, rake: 0.3, rakeY: 0.5, bulge: 0.02, crease: true },
  capCols: [0, 0.16, 0.32, 0.46, 0.6, 0.74, 0.86, 1],
  capColsLow: [0, 0.5, 1],
  breaks: Object.values(CZ),
  classify(q) {
    const s = coupe;
    if (q.band <= 2) return R.UNDER;
    // Lamps
    if (q.kind === 0 && q.z > CZ.headZ && (q.band === 10 || q.band === 11)) return q.band === 11 ? R.DRL : R.HEAD;
    if (q.kind === 1) {
      if ((q.band === 10 || q.band === 11) && q.cf > 0.46) return q.band === 11 ? R.DRL : R.HEAD;
      if (q.band === 9 && q.cf < 0.6) return R.GRILLE;
      if (q.band >= 4 && q.band <= 6 && q.cf < 0.74) return R.BUMPER_F_BLACK;
      if (q.band === 4 && q.cf > 0.74) return R.BUMPER_F_BLACK;
    }
    if (q.kind === 0 && q.z < CZ.tailZ && (q.band === 9 || q.band === 10)) return R.BRAKE;
    if (q.kind === -1) {
      if (q.band === 9 || q.band === 10) return q.cf > 0.74 ? R.BRAKE : R.TAIL;
      if (q.band === 8 && q.cf > 0.32 && q.cf < 0.46) return R.REVERSE;
      if (q.band >= 3 && q.band <= 5 && q.cf < 0.74) return R.BUMPER_R_BLACK;
    }
    const g = greenhouse(q, s.cabin, { cowlStrip: CZ.cowlStrip, sideF: CZ.sideF, sideR: CZ.sideR, pillars: [[CZ.bA, CZ.bB]], pillarBlack: true });
    if (g >= 0) return g;
    const l = lowerBody(q, s, { hood: [s.cabin.zCowl, CZ.hoodF], trunk: [CZ.trunkR, CZ.trunkF], door: [CZ.doorR, CZ.doorF], bumperTopF: 8, bumperTopR: 8 });
    if (l >= 0) return l;
    return R.BODY;
  },
  doors: { f0: CZ.doorR, f1: CZ.doorF },
  hood: { z0: 0.98, z1: CZ.hoodF },
  trunk: { z0: CZ.trunkR, z1: CZ.trunkF, hatch: false },
  bumperChrome: false,
  stripe: { center: 0.16, twinIn: 0.07, twinOut: 0.2, sideY0: 0.36, sideY1: 0.42, sideSlope: 0.02, sideZ0: -1.95, sideZ1: 1.95 },
  details: {
    mirrorZ: 0.8,
    handleZ: -0.3,
    handleSlot: 9.4,
    exhaust: 'twinCenter',
    exhaustX: 0.13,
    exhaustY: 0.27,
    plateFY: 0.3,
    plateRY: 0.46,
    plateROnTrunk: false,
    grille: 'blades',
    grilleBands: [9, 10],
    grilleCf: 0.6,
    roofRails: false,
    archFlares: false,
    seats4: false,
    cabinRear: -1.15,
    pillarBlack: true,
  },
  kit: { spoilerZ: -2.04, spoilerRoof: false, scoop: { z0: 1.15, z1: 1.75, w: 0.2, h: 0.05 }, splitterDepth: 0.07 },
};

// ───────────────────────────── Saltrunner 77 (muscle) ─────────────────────────────
const MZ = {
  cowlStrip: 0.765,
  sideF: 0.66,
  sideR: -0.82,
  bA: -0.57,
  bB: -0.53,
  doorF: 1.04,
  doorR: -0.55,
  hoodF: 2.3,
  trunkF: -1.48,
  trunkR: -2.27,
  tailZ: -2.3,
};
const muscle: CarSpec = {
  id: 'muscle',
  name: 'Saltrunner 77',
  description: 'Long-hood, short-deck boulevard bruiser with a power-dome hood, quad lamps and chrome bumpers.',
  zRear: -2.36,
  zFront: 2.42,
  axleF: 1.5,
  axleR: -1.3,
  halfTrack: 0.815,
  wheelR: 0.345,
  wheelW: 0.27,
  mass: 1500,
  sill: curve([
    [-2.36, 0.3],
    [-2.15, 0.25],
    [-1.8, 0.235],
    [1.95, 0.235],
    [2.42, 0.26],
  ]),
  belt: curve([
    [-2.36, 0.83],
    [-2.25, 0.875],
    [-1.3, 0.91],
    [-0.7, 0.885],
    [0.6, 0.875],
    [1.5, 0.885],
    [2.3, 0.87],
    [2.42, 0.835],
  ]),
  halfW: curve([
    [-2.36, 0.925],
    [-2.2, 0.955],
    [-1.3, 0.978],
    [-0.75, 0.952],
    [0.45, 0.94],
    [1.5, 0.955],
    [2.25, 0.948],
    [2.42, 0.93],
  ]),
  crown: curve([
    [-2.36, 0.012],
    [-1.5, 0.018],
    [0.8, 0.018],
    [1.0, 0.0],
    [2.2, 0.0],
    [2.42, 0.008],
  ]),
  floorDrop: 0.065,
  sideT: [0.06, 0.24, 0.45, 0.68, 0.86],
  sideInset: [0.07, 0.05, 0.016, 0.0, 0.0, 0.015],
  shoulderIn: 0.032,
  topR: 0.035,
  hoodEdge: 0.22,
  creases: [1, 2, 4, 8, 12, 15, 17],
  flare: { front: 0.004, rear: 0.03, len: 0.5 },
  hoodBulge: { h: 0.048, w: 0.36, z0: 0.85, z1: 2.15 },
  cabin: {
    H: curve([
      [-1.48, 0],
      [-1.22, 0.2],
      [-0.86, 0.39],
      [-0.3, 0.43],
      [0.22, 0.418],
      [0.5, 0.25],
      [0.8, 0],
    ]),
    cabinW: curve([
      [-2.36, 0.62],
      [-1.48, 0.76],
      [0.8, 0.79],
      [2.42, 0.7],
    ]),
    roofW: curve([
      [-1.48, 0.6],
      [-0.5, 0.665],
      [0.8, 0.645],
    ]),
    zBl: -1.48,
    zRoofRear: -0.86,
    zWsTop: 0.22,
    zCowl: 0.8,
    cornerR: 0.05,
    crown: 0.032,
  },
  front: { round: 0.14, pow: 2.6, zone: 0.32, rake: -0.12, rakeY: 0.3, bulge: 0.02, crease: true },
  rear: { round: 0.12, pow: 2.6, zone: 0.25, rake: 0.0, rakeY: 0.5, bulge: 0.012, crease: true },
  capCols: [0, 0.14, 0.3, 0.48, 0.66, 0.82, 0.93, 1],
  capColsLow: [0, 0.5, 1],
  breaks: Object.values(MZ),
  classify(q) {
    const s = muscle;
    if (q.band <= 2) return R.UNDER;
    if (q.kind === 1) {
      if (q.band >= 8 && q.band <= 11 && q.cf < 0.93) return R.GRILLE;
      if (q.band === 7 && q.cf > 0.82) return R.INDICATOR;
    }
    if (q.kind === -1) {
      if ((q.band === 9 || q.band === 10) && q.cf > 0.14 && q.cf < 0.93) return q.cf > 0.66 ? R.BRAKE : q.cf < 0.3 ? R.REVERSE : R.TAIL;
      if ((q.band === 9 || q.band === 10) && q.cf <= 0.14) return R.BLACK;
    }
    const g = greenhouse(q, s.cabin, { cowlStrip: MZ.cowlStrip, sideF: MZ.sideF, sideR: MZ.sideR, pillars: [[MZ.bA, MZ.bB]], pillarBlack: true });
    if (g >= 0) return g;
    const l = lowerBody(q, s, { hood: [s.cabin.zCowl, MZ.hoodF], trunk: [MZ.trunkR, MZ.trunkF], door: [MZ.doorR, MZ.doorF], bumperTopF: 8, bumperTopR: 8 });
    if (l >= 0) return l;
    return R.BODY;
  },
  doors: { f0: MZ.doorR, f1: MZ.doorF },
  hood: { z0: 0.8, z1: MZ.hoodF },
  trunk: { z0: MZ.trunkR, z1: MZ.trunkF, hatch: false },
  bumperChrome: true,
  stripe: { center: 0.2, twinIn: 0.09, twinOut: 0.24, sideY0: 0.62, sideY1: 0.69, sideSlope: 0, sideZ0: -2.1, sideZ1: 2.2 },
  details: {
    mirrorZ: 0.62,
    handleZ: -0.38,
    handleSlot: 9.3,
    exhaust: 'dualSides',
    exhaustX: 0.62,
    exhaustY: 0.26,
    plateFY: 0.37,
    plateRY: 0.42,
    plateROnTrunk: false,
    grille: 'eggcrate',
    grilleBands: [8, 12],
    grilleCf: 0.93,
    roundLamps: { y: 0.0, cfs: [0.58, 0.8], r: 0.082 },
    roofRails: false,
    archFlares: false,
    seats4: true,
    cabinRear: -1.4,
    pillarBlack: true,
  },
  kit: { spoilerZ: -2.27, spoilerRoof: false, scoop: { z0: 1.1, z1: 1.85, w: 0.24, h: 0.065 }, splitterDepth: 0.08 },
};

// ───────────────────────────── Sandpiper Zip (hatch) ─────────────────────────────
const HZ = {
  cowlStrip: 0.94,
  sideF: 0.86,
  sideR: -1.5,
  bA: -0.36,
  bB: -0.27,
  doorF: 0.88,
  doorR: -0.31,
  hoodF: 1.94,
  headZ: 1.8,
  tailZ: -1.8,
};
const hatch: CarSpec = {
  id: 'hatch',
  name: 'Sandpiper Zip',
  description: 'Cheerful three-door hatchback. Short overhangs, big friendly lamps and a tight turning circle for darting through gaps.',
  zRear: -1.9,
  zFront: 2.02,
  axleF: 1.3,
  axleR: -1.22,
  halfTrack: 0.75,
  wheelR: 0.31,
  wheelW: 0.215,
  mass: 1050,
  sill: curve([
    [-1.9, 0.3],
    [-1.68, 0.26],
    [1.7, 0.255],
    [2.02, 0.28],
  ]),
  belt: curve([
    [-1.9, 0.87],
    [-1.72, 0.925],
    [-1.2, 0.935],
    [0.0, 0.9],
    [1.0, 0.87],
    [1.35, 0.86],
    [1.75, 0.8],
    [2.02, 0.69],
  ]),
  halfW: curve([
    [-1.9, 0.835],
    [-1.62, 0.875],
    [-1.2, 0.885],
    [0.0, 0.872],
    [1.3, 0.875],
    [1.8, 0.86],
    [2.02, 0.81],
  ]),
  crown: curve([
    [-1.9, 0.03],
    [0.98, 0.035],
    [1.3, 0.045],
    [2.02, 0.03],
  ]),
  floorDrop: 0.06,
  sideT: [0.07, 0.25, 0.46, 0.58, 0.82],
  sideInset: [0.085, 0.06, 0.018, 0.0, 0.004, 0.035],
  shoulderIn: 0.085,
  topR: 0.085,
  hoodEdge: 0.35,
  creases: [1, 2, 4, 15, 17],
  flare: { front: 0.012, rear: 0.016, len: 0.36 },
  cabin: {
    H: curve([
      [-1.9, 0.4],
      [-1.76, 0.475],
      [-1.56, 0.515],
      [-0.6, 0.548],
      [0.3, 0.528],
      [0.6, 0.38],
      [0.98, 0],
    ]),
    cabinW: curve([
      [-1.9, 0.69],
      [0.0, 0.72],
      [0.98, 0.715],
      [2.02, 0.6],
    ]),
    roofW: curve([
      [-1.9, 0.6],
      [-1.0, 0.64],
      [0.98, 0.6],
    ]),
    zBl: -1.9,
    zRoofRear: -1.58,
    zWsTop: 0.3,
    zCowl: 0.98,
    cornerR: 0.1,
    crown: 0.05,
  },
  front: { round: 0.3, pow: 2.0, zone: 0.4, rake: 0.38, rakeY: 0.36, bulge: 0.05, crease: false },
  rear: { round: 0.17, pow: 2.2, zone: 0.22, rake: 0.1, rakeY: 0.9, bulge: 0.025, crease: false },
  capCols: [0, 0.16, 0.32, 0.46, 0.6, 0.72, 0.86, 1],
  capColsLow: [0, 0.5, 1],
  breaks: Object.values(HZ),
  classify(q) {
    const s = hatch;
    if (q.band <= 2) return R.UNDER;
    if (q.kind === 0 && q.z > HZ.headZ && q.band >= 9 && q.band <= 11) return q.band === 9 ? R.INDICATOR : R.HEAD;
    if (q.kind === 1) {
      if (q.band >= 9 && q.band <= 11 && q.cf > 0.46) return q.band === 9 && q.cf > 0.72 ? R.INDICATOR : R.HEAD;
      if (q.band === 10 && q.cf < 0.46) return R.GRILLE;
      if (q.band >= 4 && q.band <= 6 && q.cf < 0.6) return R.BUMPER_F_BLACK;
      if (q.band === 5 && q.cf > 0.72 && q.cf < 0.86) return R.DRL;
    }
    if (q.kind === 0 && q.z < HZ.tailZ && q.band >= 9 && q.band <= 14) return q.band === 9 ? R.REVERSE : R.BRAKE;
    if (q.kind === -1) {
      if (q.band >= 9 && q.band <= 14 && q.cf > 0.72) return q.band === 9 ? R.REVERSE : q.band >= 13 ? R.TAIL : R.BRAKE;
      if (q.band >= 15) return q.cf < 0.86 ? R.GLASS : R.ROOF;
      if (q.band >= 8 && q.band < 15 && q.cf < 0.72) return R.TRUNK;
      if (q.band >= 3 && q.band <= 4 && q.cf < 0.86) return R.BUMPER_R_BLACK;
    }
    if (q.kind === 0 && q.band >= 19 && q.z < s.cabin.zRoofRear) return R.GLASS;
    const g = greenhouse(q, s.cabin, { cowlStrip: HZ.cowlStrip, sideF: HZ.sideF, sideR: HZ.sideR, pillars: [[HZ.bA, HZ.bB]], pillarBlack: true });
    if (g >= 0) return g;
    const l = lowerBody(q, s, { hood: [s.cabin.zCowl, HZ.hoodF], door: [HZ.doorR, HZ.doorF], bumperTopF: 8, bumperTopR: 8 });
    if (l >= 0) return l;
    return R.BODY;
  },
  doors: { f0: HZ.doorR, f1: HZ.doorF },
  hood: { z0: 0.98, z1: HZ.hoodF },
  trunk: { z0: -1.9, z1: -1.9, hatch: true },
  bumperChrome: false,
  stripe: { center: 0.14, twinIn: 0.06, twinOut: 0.17, sideY0: 0.42, sideY1: 0.47, sideSlope: 0.03, sideZ0: -1.7, sideZ1: 1.75 },
  details: {
    mirrorZ: 0.8,
    handleZ: -0.2,
    handleSlot: 9.4,
    exhaust: 'single',
    exhaustX: 0.45,
    exhaustY: 0.28,
    plateFY: 0.36,
    plateRY: 0.62,
    plateROnTrunk: true,
    grille: 'bars',
    grilleBands: [10, 11],
    grilleCf: 0.46,
    roofRails: false,
    archFlares: false,
    seats4: true,
    cabinRear: -1.75,
    pillarBlack: true,
  },
  kit: { spoilerZ: -1.6, spoilerRoof: true, scoop: { z0: 1.1, z1: 1.65, w: 0.18, h: 0.045 }, splitterDepth: 0.06 },
};

// ───────────────────────────── Headland Cairn (SUV) ─────────────────────────────
const SZ = {
  cowlStrip: 1.06,
  sideF: 0.98,
  sideR: -1.95,
  bA: 0.0,
  bB: 0.11,
  cA: -0.9,
  cB: -0.8,
  doorF: 1.0,
  doorR: 0.05,
  rdoorF: 0.06,
  rdoorR: -0.86,
  hoodF: 2.28,
  headZ: 2.12,
  tailZ: -2.12,
};
const suv: CarSpec = {
  id: 'suv',
  name: 'Headland Cairn',
  description: 'Tall, square-shouldered SUV on chunky tyres, with arch cladding and roof rails. Shrugs off kerbs and parked cars alike.',
  zRear: -2.25,
  zFront: 2.37,
  axleF: 1.42,
  axleR: -1.34,
  halfTrack: 0.835,
  wheelR: 0.385,
  wheelW: 0.265,
  mass: 1900,
  sill: curve([
    [-2.25, 0.46],
    [-2.0, 0.41],
    [-1.75, 0.395],
    [1.85, 0.395],
    [2.15, 0.42],
    [2.37, 0.47],
  ]),
  belt: curve([
    [-2.25, 1.02],
    [-2.05, 1.065],
    [-1.3, 1.085],
    [0.0, 1.065],
    [1.0, 1.045],
    [1.42, 1.045],
    [1.95, 1.0],
    [2.25, 0.93],
    [2.37, 0.87],
  ]),
  halfW: curve([
    [-2.25, 0.935],
    [-2.05, 0.975],
    [-1.3, 0.985],
    [0.0, 0.97],
    [1.42, 0.975],
    [2.05, 0.962],
    [2.37, 0.925],
  ]),
  crown: curve([
    [-2.25, 0.02],
    [1.1, 0.025],
    [2.37, 0.02],
  ]),
  floorDrop: 0.07,
  sideT: [0.08, 0.26, 0.46, 0.6, 0.84],
  sideInset: [0.07, 0.05, 0.018, 0.0, 0.002, 0.025],
  shoulderIn: 0.06,
  topR: 0.065,
  hoodEdge: 0.3,
  creases: [1, 2, 4, 8, 15, 17],
  flare: { front: 0.01, rear: 0.012, len: 0.45 },
  cabin: {
    H: curve([
      [-2.25, 0.5],
      [-2.12, 0.56],
      [-1.92, 0.6],
      [0.0, 0.625],
      [0.45, 0.605],
      [0.76, 0.42],
      [1.1, 0],
    ]),
    cabinW: curve([
      [-2.25, 0.8],
      [0.0, 0.83],
      [1.1, 0.81],
      [2.37, 0.7],
    ]),
    roofW: curve([
      [-2.25, 0.74],
      [0.0, 0.765],
      [1.1, 0.72],
    ]),
    zBl: -2.25,
    zRoofRear: -2.02,
    zWsTop: 0.45,
    zCowl: 1.1,
    cornerR: 0.09,
    crown: 0.035,
  },
  front: { round: 0.22, pow: 2.4, zone: 0.34, rake: 0.14, rakeY: 0.5, bulge: 0.03, crease: true },
  rear: { round: 0.15, pow: 2.4, zone: 0.28, rake: 0.08, rakeY: 1.0, bulge: 0.015, crease: true },
  capCols: [0, 0.16, 0.32, 0.46, 0.62, 0.76, 0.88, 1],
  capColsLow: [0, 0.5, 1],
  breaks: Object.values(SZ),
  classify(q) {
    const s = suv;
    if (q.band <= 2) return R.UNDER;
    if (q.kind === 0 && (q.band === 4 || q.band === 5) && q.z > s.axleR && q.z < s.axleF) return R.CLAD;
    if (q.kind === 0 && q.z > SZ.headZ && (q.band === 10 || q.band === 11)) return q.band === 11 ? R.DRL : R.HEAD;
    if (q.kind === 1) {
      if ((q.band === 10 || q.band === 11) && q.cf > 0.62) return q.band === 11 ? R.DRL : R.HEAD;
      if (q.band >= 7 && q.band <= 11 && q.cf < 0.62) return R.GRILLE;
      if (q.band >= 3 && q.band <= 4) return R.BUMPER_F_BLACK;
      if (q.band === 6 && q.cf > 0.76) return R.INDICATOR;
    }
    if (q.kind === 0 && q.z < SZ.tailZ && q.band >= 9 && q.band <= 14) return q.band === 9 ? R.REVERSE : R.BRAKE;
    if (q.kind === -1) {
      if (q.band >= 9 && q.band <= 14 && q.cf > 0.76) return q.band === 9 ? R.REVERSE : q.band >= 13 ? R.TAIL : R.BRAKE;
      if (q.band >= 15) return q.cf < 0.88 ? R.GLASS : R.ROOF;
      if (q.band >= 8 && q.band < 15 && q.cf < 0.76) return R.TRUNK;
      if (q.band >= 3 && q.band <= 4) return R.BUMPER_R_BLACK;
    }
    if (q.kind === 0 && q.band >= 19 && q.z < s.cabin.zRoofRear) return R.GLASS;
    const g = greenhouse(q, s.cabin, {
      cowlStrip: SZ.cowlStrip,
      sideF: SZ.sideF,
      sideR: SZ.sideR,
      pillars: [
        [SZ.bA, SZ.bB],
        [SZ.cA, SZ.cB],
      ],
      pillarBlack: true,
    });
    if (g >= 0) return g;
    const l = lowerBody(q, s, { hood: [s.cabin.zCowl, SZ.hoodF], door: [SZ.doorR, SZ.doorF], rdoor: [SZ.rdoorR, SZ.rdoorF], bumperTopF: 7, bumperTopR: 7 });
    if (l >= 0) return l;
    return R.BODY;
  },
  doors: { f0: SZ.doorR, f1: SZ.doorF, r0: SZ.rdoorR, r1: SZ.rdoorF },
  hood: { z0: 1.1, z1: SZ.hoodF },
  trunk: { z0: -2.25, z1: -2.25, hatch: true },
  bumperChrome: false,
  stripe: { center: 0.2, twinIn: 0.09, twinOut: 0.23, sideY0: 0.66, sideY1: 0.73, sideSlope: 0, sideZ0: -2.0, sideZ1: 2.1 },
  details: {
    mirrorZ: 0.9,
    handleZ: 0.25,
    handleSlot: 9.4,
    exhaust: 'twinSquare',
    exhaustX: 0.55,
    exhaustY: 0.43,
    plateFY: 0.52,
    plateRY: 0.78,
    plateROnTrunk: true,
    grille: 'slats',
    grilleBands: [7, 12],
    grilleCf: 0.62,
    roofRails: true,
    archFlares: true,
    seats4: true,
    cabinRear: -2.0,
    pillarBlack: true,
  },
  kit: { spoilerZ: -2.02, spoilerRoof: true, scoop: { z0: 1.3, z1: 1.95, w: 0.26, h: 0.05 }, splitterDepth: 0.07 },
};

export const SPECS: Record<CarModelId, CarSpec> = { coupe, muscle, hatch, suv };
