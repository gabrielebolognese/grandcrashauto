import type { CityData, DistrictId } from '../types';
import type { StreetProfile } from './layout';
import type { AirportModel } from './airport';

/** Internal layout model shared by the generator, renderers, physics and queries. Pure data (no three.js). */

export type IslandKind = 'block' | 'median' | 'verge' | 'promenade';
export type Interior = 'plaza' | 'grass' | 'yard' | 'lot' | 'park' | 'concrete';
export type BlockType = 'tower' | 'midrise' | 'mixed' | 'house' | 'hotel' | 'park' | 'plaza' | 'hub' | 'none';

export interface Island {
  id: number;
  kind: IslandKind;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  r: number;
  top: number;
  /** Sidewalk band widths: N (-z), E (+x), S (+z), W (-x). 0 = curb only. */
  sw: [number, number, number, number];
  interior: Interior;
  block: BlockType;
  district: DistrictId;
}

/** Straight street segment between two road-graph nodes. axis 'x' = constant x (runs along z). */
export interface StreetSeg {
  id: number;
  axis: 'x' | 'z';
  c: number;
  a: number; // running coordinate at node A (a < b)
  b: number;
  prof: StreetProfile;
  nodeA: number;
  nodeB: number;
  edge: number;
  /** Box half extents (along the running axis) of the node boxes at each end (0 = no box, e.g. a mid-street junction). */
  boxA: number;
  boxB: number;
  /** Crosswalk at each end? */
  xwalkA: boolean;
  xwalkB: boolean;
  /** Sidewalk width of the perpendicular street at each end (positions the crosswalk). */
  swA: number;
  swB: number;
}

/** Flat paint / surface decal quad. dir = unit running direction, hl/hw half length/width. */
export interface Decal {
  cx: number;
  cz: number;
  dx: number;
  dz: number;
  hl: number;
  hw: number;
  y: number;
  col: number;
  mat: number;
}

export interface Disc {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  /** Inner radius fraction (0 = full disc, else ring). */
  inner: number;
  y: number;
  col: number;
  mat: number;
}

/** Polyline ribbon (park paths). */
export interface Ribbon {
  pts: number[]; // x,z pairs
  w: number;
  y: number;
  col: number;
  mat: number;
  closed: boolean;
}

/** Static box solid (sea wall, fountain parts, planters...). cy = bottom. */
export interface Solid {
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
  yaw: number;
  col: number;
  mat: number;
  /** Add a static collider? */
  collide: boolean;
  /** Optional top-surface slope: height at local -z end = cy + h0, at +z end = cy + h (wedge). */
  h0?: number;
  /** Also part of the low-detail layer (long structures visible from afar: sea wall). */
  lod?: boolean;
}

export interface Cylinder {
  cx: number;
  cy: number;
  cz: number;
  r: number;
  h: number;
  col: number;
  mat: number;
  segs: number;
  collide: boolean;
  /** Open tube (no caps), for basins. */
  open?: boolean;
}

/** Building render parts (instanced). */
export interface BoxPart {
  cx: number;
  cz: number;
  y: number; // bottom
  w: number;
  h: number;
  d: number;
  yaw: number;
  style: number; // FacadeStyle
  color: number;
  accent: number;
  seed: number;
  floorH: number;
  /** Height of this part's bottom above the building's ground (floor numbering / storefront). */
  baseOff: number;
  /** Ground floor height (storefront) — 0 = none. */
  groundH: number;
  /** Lit-window fraction at night (0..1). */
  lit: number;
  tower: boolean;
}

export interface RoofPart {
  cx: number;
  cz: number;
  y: number;
  w: number; // along the ridge
  d: number; // across
  h: number;
  yaw: number;
  color: number;
}

export interface TankPart {
  cx: number;
  cz: number;
  y: number;
  r: number;
  h: number;
  color: number;
}

export interface HwSample {
  s: number;
  x: number;
  z: number;
  fx: number;
  fz: number;
  /** Deck height at the inner edge (absolute y). */
  e: number;
  /** Bank angle (rad), outer edge raised. */
  bank: number;
}

export interface Highway {
  samples: HwSample[];
  length: number;
  halfW: number;
  /** s ranges with no inner barrier (ramp merges, spur). */
  innerGaps: [number, number][];
  /** s ranges with no outer barrier (exits). */
  outerGaps: [number, number][];
  pillars: { x: number; z: number; s: number }[];
}

/** Generic road strip (ramps, jump spur pieces). */
export interface Strip {
  /** x,y,z triples along the centreline (y = surface). */
  pts: number[];
  halfW: number;
  /** Render side walls down to the ground and close the ends (kicker / landing). */
  solid: boolean;
  /** Paint style: 0 = ramp (edge lines + dashed centre), 1 = kicker stripes, 2 = landing. */
  paint: number;
  capStart: boolean;
  capEnd: boolean;
}

export interface CityLayout {
  data: CityData;
  islands: Island[];
  segs: StreetSeg[];
  /** Asphalt base zones (y = 0) inside the city: [minX, maxX, minZ, maxZ]. */
  asphalt: [number, number, number, number][];
  decals: Decal[];
  discs: Disc[];
  ribbons: Ribbon[];
  solids: Solid[];
  cylinders: Cylinder[];
  boxParts: BoxPart[];
  roofs: RoofPart[];
  tanks: TankPart[];
  highway: Highway;
  strips: Strip[];
  /** Road edge ids findRespawn must never use (jump spur). */
  noRespawnEdges: Set<number>;
  /** Edge ids that are elevated (highway) — y from the polyline. */
  hwEdges: Set<number>;
  /** Per-edge profile lookup (lane offset for respawn). */
  edgeLaneOffset: Map<number, number>;
  /** Airport (part 2/3). */
  airport: AirportModel | null;
}

export const Mat = {
  Plain: 0,
  Asphalt: 1,
  Sidewalk: 2,
  Grass: 3,
  Sand: 4,
  Paint: 5,
  Concrete: 6,
  Water: 7,
  Metal: 8,
  Plaza: 9,
  Soil: 10,
} as const;

export const Facade = {
  Deco: 0,
  Glass: 1,
  House: 2,
  Hotel: 3,
  Solid: 4,
  Awning: 5,
  Neon: 6,
  Garage: 7,
  Container: 8,
  Shop: 9,
  Apartment: 10,
  Roof: 11,
} as const;
