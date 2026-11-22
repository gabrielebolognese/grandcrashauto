import type { RoadKind } from '../types';

/**
 * Hand-designed city plan (the seed varies buildings, colours, props and parked cars — the street plan is fixed so
 * the hub, ramps and jump always line up). Pure data, no three.js.
 *
 * Coordinates: x east, z south (ocean at +Z), y up. Roads at y = 0, raised islands (blocks, sidewalks) at ISLAND_TOP.
 */

export interface StreetProfile {
  kind: RoadKind;
  lanes: number;
  laneW: number;
  /** Raised median island width (0 = painted centre line). */
  median: number;
  /** Parking lane width on each side (0 = none). */
  park: number;
  /** Sidewalk band width on islands that border this street. */
  sw: number;
  speed: number;
}

export const P_STREET2: StreetProfile = { kind: 'street2', lanes: 2, laneW: 3.25, median: 0, park: 2.25, sw: 3.5, speed: 40 };
export const P_STREET4: StreetProfile = { kind: 'street4', lanes: 4, laneW: 3.25, median: 0, park: 2.25, sw: 4.5, speed: 50 };
export const P_BOULEVARD: StreetProfile = { kind: 'boulevard', lanes: 4, laneW: 3.3, median: 4, park: 2.3, sw: 5, speed: 50 };
export const P_VIADUCT: StreetProfile = { kind: 'street4', lanes: 4, laneW: 3.25, median: 2.5, park: 0, sw: 4, speed: 50 };
export const P_BEACH: StreetProfile = { kind: 'boulevard', lanes: 4, laneW: 3.4, median: 5, park: 2.4, sw: 5, speed: 40 };

/** Asphalt half width, curb to centre. */
export const halfW = (p: StreetProfile): number => (p.lanes * p.laneW) / 2 + p.median / 2 + p.park;
/** Distance from the centreline to the centre of the right-hand inner driving lane. */
export const innerLaneOffset = (p: StreetProfile): number => p.median / 2 + p.laneW / 2;

export const ISLAND_TOP = 0.15;
export const ISLAND_R = 3; // block corner radius
export const MARK_Y = 0.025; // paint above its surface
export const DECAL_Y = 0.035; // paths / pond / lot paint above an island top

/** N-S streets (constant x). */
export const X_LINES = [-315, -245, -175, -105, -35, 35, 105, 175, 245, 315];
export const X_PROF: StreetProfile[] = [P_STREET2, P_STREET2, P_STREET2, P_BOULEVARD, P_STREET4, P_STREET4, P_BOULEVARD, P_STREET2, P_STREET2, P_STREET2];
/** E-W streets (constant z). Index 7 runs under the highway viaduct, index 8 is the beach boulevard. */
export const Z_LINES = [-290, -220, -150, -80, -10, 60, 130, 200, 272];
export const Z_PROF: StreetProfile[] = [P_STREET2, P_STREET2, P_STREET4, P_STREET2, P_BOULEVARD, P_STREET2, P_STREET4, P_VIADUCT, P_BEACH];
export const BEACH_LINE = 8;
export const VIADUCT_LINE = 7;
/** The beach boulevard continues past the edge streets to the map edge. */
export const BEACH_EXT_X = 420;

/** Cell merges (park, hub) — cells are [i0..i1] x [j0..j1] (cell i is between X_LINES[i] and X_LINES[i+1]). */
export const PARK_CELLS = { i0: 1, i1: 2, j0: 1, j1: 3 };
export const HUB_CELLS = { i0: 7, i1: 8, j0: 3, j1: 3 };
export const PLAZA_CELL = { i: 4, j: 3 };

// ── coast ──
export const SEA_WALL_Z = 300; // promenade ends / wall centre
export const SEA_WALL_T = 0.8; // wall thickness
export const SAND_TOP = 0.85; // sand height against the wall
export const SHORE_Z = 335; // y = 0 water line
export const SEA_WALL_TOP = 1.25;
export const PROMENADE_MAXZ = SEA_WALL_Z - SEA_WALL_T / 2;
export const BEACH_START_Z = SEA_WALL_Z + SEA_WALL_T / 2;

/** Height of the beach / seabed as a function of z (and a gentle x undulation). */
export function beachHeight(x: number, z: number): number {
  const und = 0.1 * Math.sin(x * 0.021 + 1.3) + 0.06 * Math.sin(x * 0.057 + 0.4);
  if (z <= BEACH_START_Z) return SAND_TOP;
  if (z < SHORE_Z) {
    const t = (z - BEACH_START_Z) / (SHORE_Z - BEACH_START_Z);
    return SAND_TOP * (1 - t) + und * Math.sin(t * Math.PI);
  }
  if (z < 365) return -0.9 * ((z - SHORE_Z) / 30) + und * 0.5;
  if (z < 420) {
    const t = (z - 365) / 55;
    return -0.9 - 5.1 * (t * t * (3 - 2 * t));
  }
  return -6 - Math.min(3, (z - 420) * 0.012);
}

// ── highway loop ── (rounded rectangle, traversed east along the north leg, i.e. clockwise on a north-up map)
export const HW = {
  xEdge: 360, // west/east legs at x = ±360
  zNorth: -360,
  zSouth: 200, // south leg = viaduct over Z_LINES[7]
  radius: 80,
  halfW: 9, // 4 lanes x 3.6 + 1.8 shoulders
  laneW: 3.6,
  elevation: 8, // south leg deck height
  riseZ0: 40, // elevation ramps up between these z values on the west/east legs
  riseZ1: 175,
  bankDeg: 10,
  bankRamp: 40, // m of bank transition before/after each arc
  openAbove: 4, // deck height above which it is an open viaduct (pillars) instead of a solid embankment
  deckThickness: 1.2,
  sampleStep: 2,
  gradeY: 0.03, // at-grade deck top (just above the 0-level terrain & ramps)
};

/** Viaduct pillar x positions under the south leg (in the median of Z_LINES[7], clear of intersections). */
export const VIADUCT_PILLARS_X = [-265, -225, -195, -155, -125, -85, -55, -15, 15, 55, 85, 125, 155, 195, 225, 265];

/** On-ramps: start on an edge street (outer curb), merge into the highway's inner (right-hand) lanes. */
export interface RampDef {
  name: string;
  /** Street junction (centreline) point. */
  jx: number;
  jz: number;
  /** Start point on the outer curb and direction (unit) leaving the city. */
  sx: number;
  sz: number;
  dx: number;
  dz: number;
  /** Merge point and highway direction there. */
  mx: number;
  mz: number;
  mdx: number;
  mdz: number;
}

const edgeHW = halfW(P_STREET2);
export const RAMPS: RampDef[] = [
  { name: 'east', jx: 315, jz: -44, sx: 315 + edgeHW, sz: -44, dx: 1, dz: 0, mx: 353.5, mz: 22, mdx: 0, mdz: 1 },
  { name: 'west', jx: -315, jz: -44, sx: -315 - edgeHW, sz: -44, dx: -1, dz: 0, mx: -353.5, mz: -110, mdx: 0, mdz: -1 },
  { name: 'north', jx: -210, jz: -290, sx: -210, sz: -290 - edgeHW, dx: 0, dz: -1, mx: -158, mz: -353.5, mdx: 1, mdz: 0 },
];
export const RAMP_HALFW = 3.6;

/** Jump spur on the inner side of the north leg (eastbound). Kicker launches east over a row of containers. */
export const JUMP = {
  divergeX: -125,
  mergeX: 155,
  laneZ: -353.5, // highway eastbound right lane centre
  z: -330, // spur straight centreline
  straightX0: -75,
  straightX1: 100,
  kickerX0: -38,
  lipX: 0,
  lipHeight: 4.0,
  lipAngleDeg: 14,
  landX0: 26,
  landHeight: 4.2,
  landX1: 81,
  halfW: 4.5,
};

/** Hub: garage + parking lot (cells HUB_CELLS). */
export const HUB = {
  garage: { x0: 186, x1: 221, z0: -61.5, z1: -26.5, h: 11 },
  aisleZ: -44,
  spawnX: 228,
  southDriveX: 265,
};

export const ROAD_Y = 0;
