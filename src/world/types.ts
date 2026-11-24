/**
 * City data contract (spec §5). Generated deterministically from the seed by the world module, consumed by
 * props, npc, minimap, vehicle reset, environment. Owner: core contract (world module fills it; extend by ADDING
 * optional fields only — other modules depend on the existing ones).
 *
 * Coordinates: meters, Y up, origin at the city center, city spans [-size/2, size/2] on X and Z.
 * Yaw: rotation about +Y; yaw 0 faces +Z; forward = (sin yaw, 0, cos yaw).
 * The ocean / beach is on the +Z (south) edge of the map.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Pose {
  position: Vec3;
  yaw: number;
}

export type DistrictId = 'downtown' | 'residential' | 'beach' | 'park' | 'hub' | 'highway' | 'water';

export type RoadKind = 'street2' | 'street4' | 'boulevard' | 'highway' | 'ramp' | 'lot';

export interface RoadNode {
  id: number;
  p: Vec3;
  kind: 'intersection' | 'junction' | 'end';
  trafficLight: boolean;
  /** ids of edges touching this node */
  edges: number[];
}

export interface RoadEdge {
  id: number;
  a: number; // node id
  b: number; // node id
  kind: RoadKind;
  lanes: number; // total lanes (2 or 4, highway 4)
  width: number; // asphalt width, curb to curb (m)
  sidewalk: number; // sidewalk width each side (0 = none, e.g. highway)
  /** Centerline polyline from node a to node b inclusive (y = road surface height). */
  points: Vec3[];
  oneWay: boolean;
  speedLimitKmh: number;
}

export interface RoadGraph {
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export type PedEdgeKind = 'sidewalk' | 'crosswalk' | 'path' | 'promenade' | 'plaza';

export interface PedNode {
  id: number;
  p: Vec3;
  edges: number[];
}

export interface PedEdge {
  id: number;
  a: number;
  b: number;
  kind: PedEdgeKind;
  width: number; // walkable width (NPCs may offset laterally within ±width/2 - margin)
}

/** Pedestrian navigation graph: sidewalks, crosswalks, park paths, beach promenade. NPCs walk ONLY on this. */
export interface PedGraph {
  nodes: PedNode[];
  edges: PedEdge[];
}

export interface Bench {
  id: number;
  /** Center of the seat surface at seat height (world). */
  p: Vec3;
  /** Direction a seated person faces. */
  yaw: number;
  seats: number; // 2 or 3
  seatSpacing: number; // m between seat centers along the bench (local X axis)
  seatHeight: number; // m above ground
  /** Index into CityData.props for the bench prop (so NPCs can stand up if it gets knocked). */
  propIndex: number;
  /** Nearest ped node id (NPCs path here first). */
  pedNode: number;
}

export interface BusStop {
  id: number;
  p: Vec3; // waiting spot center (ground level)
  yaw: number; // facing the road
  propIndex: number; // shelter prop
  pedNode: number;
  benchId: number | null; // shelter bench, if any
}

export interface WanderArea {
  id: number;
  kind: 'park' | 'beach' | 'plaza';
  /** Axis-aligned rectangle (world) at ground height y. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
}

export type PropKind =
  | 'streetlight' | 'palm' | 'tree' | 'bench' | 'bin' | 'hydrant' | 'cone' | 'barrier' | 'busStop' | 'trafficLight' | 'sign'
  // part 2/3 (airport) — rendered by the props agent
  | 'fuelTruck' | 'baggageCart' | 'windsock';

export interface PropPlacement {
  kind: PropKind;
  p: Vec3; // base position on the ground
  yaw: number;
  /** Variation seed for the prop (colour/size). */
  variant: number;
  chunk: number; // chunk index (see chunkIndex())
}

export interface ParkedCarPlacement {
  p: Vec3; // ground position under the car center
  yaw: number;
  variant: number;
  color: string;
  chunk: number;
}

export interface BuildingLot {
  id: number;
  /** Footprint center (world) and size; rotation is a yaw about Y (usually 0 or a multiple of 90°). */
  x: number;
  z: number;
  w: number; // size along local X
  d: number; // size along local Z
  h: number; // height
  yaw: number;
  y: number; // ground height at base
  district: DistrictId;
  style: number; // facade/colour style index
  chunk: number;
}

export interface RunwayData {
  id: string;
  a: Vec3; // threshold A centre (y = surface)
  b: Vec3; // threshold B centre
  width: number;
  designatorA: string; // e.g. '27' painted at end A
  designatorB: string;
}

export interface StandData {
  id: number;
  type: 'prop' | 'bizjet' | 'airliner' | 'jumbo'; // which plane parks here
  p: Vec3; // stand centre on the ground (plane centre-of-mass ground projection goes here)
  yaw: number; // plane nose direction
}

export interface AirportData {
  runways: RunwayData[]; // [0] = main 2200 × 45 m, [1] = crosswind 1200 m
  stands: StandData[]; // one per plane type
  /** Car park next to the apron (~40 m from it), facing the planes: directions/teleport destination. */
  carPark: Pose;
  terminal: Vec3;
  tower: Vec3;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  elevation: number; // airport ground height (m)
}

/** Beach concert grounds (LOCAL coordinates, shifted with the floating origin). */
export interface ConcertData {
  /** Deck footprint centre (x, z), sand level y, deck top height, facing yaw (toward the crowd), w across × d deep. */
  stage: { x: number; y: number; z: number; yaw: number; w: number; d: number; top: number };
  /** LED screen centre + size (faces along the stage yaw). */
  screen: { x: number; y: number; z: number; w: number; h: number };
  /** Axis-aligned crowd floor at height y. */
  floor: { minX: number; maxX: number; minZ: number; maxZ: number; y: number };
  /** The whole grounds incl. stage + speakers (random crowds / props keep out). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /**
   * Breakable stage boxes (user request): bottom-centre (cx, cy, cz), size, colour, metal, role. Built and simulated
   * by the world's ConcertStage (fixed until a crash / blast hits them, then they collapse).
   */
  parts?: { cx: number; cy: number; cz: number; w: number; h: number; d: number; col: number; metal: boolean; role: 'deck' | 'trim' | 'wall' | 'truss' | 'roof' | 'speaker' | 'barrier' }[];
}

export interface CityData {
  seed: number;
  size: number;
  chunkSize: number;
  chunksPerSide: number;
  roads: RoadGraph;
  ped: PedGraph;
  benches: Bench[];
  busStops: BusStop[];
  wanderAreas: WanderArea[];
  /** Spots where small groups of NPCs stand chatting (on sidewalks/plazas, off the road). */
  groupSpots: Vec3[];
  buildings: BuildingLot[];
  props: PropPlacement[];
  parkedCars: ParkedCarPlacement[];
  /** Player spawn at the garage exit in the parking-lot hub. */
  spawn: Pose;
  /** Garage building location (for the menu camera / visuals). */
  garage: Pose;
  /** The big jump ramp (for minimap marker / debug teleport). */
  jumpRamp: Pose | null;
  /** Part 2: the airport (optional until the world module builds it). */
  airport?: AirportData;
  /** The beach concert (stage + crowd floor): NPC crowd, stage renderer, music, map POI. */
  concert?: ConcertData;
  /** Part 2: points of interest for the map / directions (on-road poses). */
  pois?: { id: string; name: string; pose: Pose }[];
  /** Part 2: island land bounds (the ocean surrounds it). */
  island?: { minX: number; maxX: number; minZ: number; maxZ: number };
  /**
   * Part 3: road-graph nodes at the city/airport edge where the external highway network attaches (world module).
   * `dir` = unit direction the road leaves in (x/z). Tags: 'north' (inland), 'east' (inland), 'coastEast' (beach
   * boulevard → south-coast road), 'coastWest' (beach boulevard west), 'west' (toward the airport), 'airport' (airport
   * access road east end).
   */
  exits?: { node: number; dir: Vec3; tag?: string }[];
  /** Coastline: the beach/ocean is on the +Z side. Sand starts at seaWallZ, water line (y = waterLevel) at shoreZ. */
  coast: { seaWallZ: number; shoreZ: number };
  /** Coarse district map: districtGrid[iz * districtGridSize + ix], cell = size / districtGridSize meters. */
  districtGrid: DistrictId[];
  districtGridSize: number;
}

export function chunkIndex(x: number, z: number, size: number, chunkSize: number): number {
  const n = Math.ceil(size / chunkSize);
  const cx = Math.min(n - 1, Math.max(0, Math.floor((x + size / 2) / chunkSize)));
  const cz = Math.min(n - 1, Math.max(0, Math.floor((z + size / 2) / chunkSize)));
  return cz * n + cx;
}
