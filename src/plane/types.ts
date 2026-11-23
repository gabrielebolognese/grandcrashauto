import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';

/**
 * PLANE CONTRACTS (part 2). Owner: core/lead. Shared by:
 *  - planemodels (src/plane/models)  → builds PlaneVisual (meshes, named parts, break joints, torn caps, cockpit)
 *  - flight      (src/plane/*)       → PlaneSystem: flight model, gear, engines, boarding, out-of-map, assists
 *  - breakup     (src/plane/breakup) → crash detection/outcomes, water forces, breakup into pieces, wreck fires, sinking
 * Extend by ADDING optional members only.
 *
 * Local frame (same as cars): nose points +Z, LEFT wing is +X, up is +Y. Root origin = centre of mass of the
 * intact plane (all parts). Units: m, kg, s, N.
 */

export type PlaneTypeId = 'prop' | 'bizjet' | 'airliner' | 'jumbo';
export const PLANE_TYPES: readonly PlaneTypeId[] = ['prop', 'bizjet', 'airliner', 'jumbo'];

/**
 * Canonical part names (a plane uses the subset it has):
 * nose, cockpit, fuselageFwd, fuselageCenter (incl. wing box), fuselageRear, tailCone, fin, tailplaneL, tailplaneR,
 * wingL1 (root), wingL2, wingL3 (tip), wingR1, wingR2, wingR3, engine1..engine4 (button order, left→right from the
 * cockpit), gearNose, gearL, gearR (extra: gearL2, gearR2), strutL, strutR (prop plane wing struts).
 */
export type PlanePartKind = 'fuselage' | 'cockpit' | 'wing' | 'tail' | 'engine' | 'gear' | 'misc';

export interface PlanePartInfo {
  name: string;
  kind: PlanePartKind;
  /** Child of PlaneVisual.root at rest (re-parented into wreck pieces by the breakup system). */
  object: THREE.Object3D;
  mass: number; // kg; sum over all parts == plane mass
  com: THREE.Vector3; // centre of mass, root space
  /** Collision/inertia box in root space (axis-aligned in root space). */
  boxCenter: THREE.Vector3;
  halfExtents: THREE.Vector3;
  fuelKg: number; // fuel carried (fire/explosion size); 0 = none
  cdA: number; // drag area (m²) when falling free
  cpOffset: THREE.Vector3; // centre of pressure offset from com (root space) — makes pieces tumble/flutter
  liftArea?: number; // wing/tail pieces: area for a reduced lift model (autorotation)
}

export interface BreakJoint {
  id: string; // `${a}|${b}`
  a: string; // part name
  b: string; // part name
  position: THREE.Vector3; // root-space centre of the break line
  normal: THREE.Vector3; // root-space break-plane normal, pointing from a toward b
  strength: number; // relative (0.3 weak … 2 strong); crashes break the weakest joints near the impact first
  /** Torn-edge cap meshes (jagged skin ring, frames, dark interior), children of part a / part b objects, hidden until broken. */
  capA?: THREE.Object3D;
  capB?: THREE.Object3D;
}

export interface PlaneEngineInfo {
  index: number; // 1-based button number (left → right as seen from the cockpit)
  part: string; // part name ('engine1'…)
  thrustPoint: THREE.Vector3; // root space
  exhaustPoint: THREE.Vector3; // root space (fire/smoke trail origin)
  radius: number; // nacelle radius (fx scale)
  propeller: boolean;
}

export interface PlaneGearInfo {
  name: string; // part name (gearNose, gearL, …)
  wheel: THREE.Vector3; // root-space wheel centre with gear down at rest (strut uncompressed)
  radius: number;
  steerable: boolean;
}

export interface PlaneBreakModes {
  /** Joints broken by "Explode middle" (front section: cockpit + forward cabin, no wings; rear: wings, engines, tail). */
  middle: string[];
  /** Joints broken by "Explode tail" (fin always; tailplanes: tailRequired always, tailOptional randomly). */
  tailRequired: string[];
  tailOptional: string[];
  /** Joint that tears an engine off its mount, per engine index (1-based) — for engine tear-off. */
  engineMount: Record<number, string>;
}

export interface PlaneInstruments {
  airspeedKmh: number;
  altitude: number;
  verticalSpeed: number;
  heading: number;
  throttle: number;
  engines: PlaneEngineStatus[];
  stall: boolean;
  flicker: number; // 0..1 (failing electrics)
}

/**
 * Walkable cabin (root space at rest): the main-deck floor of the fuselage sections, sampled half-width / ceiling,
 * seats and aisles. Sections are listed nose → tail; a section's part object carries it (and its interior mesh).
 */
export interface PlaneCabin {
  floorY: number;
  sections: { part: string; z0: number; z1: number }[];
  /** Cabin front wall (cockpit door) and rear pressure bulkhead, root z. */
  frontZ: number;
  rearZ: number;
  /** Samples every `step` m from z = rearZ: walkable half-width at standing height, ceiling height (root y). */
  step: number;
  halfW: Float32Array;
  ceil: Float32Array;
  /** Seat pan centres (root space, at floor level), facing +Z. */
  seats: { x: number; y: number; z: number }[];
  /** Seat pitch (m) and aisle centre lines (root x). */
  pitch: number;
  aisles: number[];
}

/** Procedural plane visual built by the planemodels module. */
export interface PlaneVisual {
  readonly type: PlaneTypeId;
  readonly root: THREE.Group;
  readonly parts: PlanePartInfo[];
  readonly partByName: Record<string, PlanePartInfo>;
  readonly joints: BreakJoint[];
  readonly breakModes: PlaneBreakModes;
  readonly engines: PlaneEngineInfo[];
  readonly gear: PlaneGearInfo[];
  readonly mass: number;
  /** Diagonal inertia tensor (kg·m²) about the root origin, root axes. */
  readonly inertia: THREE.Vector3;
  readonly dims: { length: number; span: number; height: number };
  /** Root space: boarding marker (by the door, or the cockpit for the small plane), cockpit eye, wing camera. */
  readonly boardPoint: THREE.Vector3;
  readonly cockpitEye: THREE.Vector3;
  readonly wingCam: { position: THREE.Vector3; target: THREE.Vector3 };
  readonly name: string; // fictional model name
  /** Walkable cabin data (null for the small prop plane). */
  readonly cabin?: PlaneCabin | null;
  /** Show every cabin interior (walking inside), or back to "only when torn open". */
  setInteriorVisible?(on: boolean): void;
  readonly livery: string; // fictional operator name
  /** Control surfaces / gear / props animation. Values in -1..1 (flaps & gear 0..1). propAngle per engine (rad). */
  setControls(c: { aileron: number; elevator: number; rudder: number; flaps: number; gear: number; propAngle?: number[] }): void;
  setEngineDamaged(index: number, damaged: boolean): void;
  setLights(l: { nav: boolean; strobe: boolean; beacon: boolean; landing: boolean }): void;
  setInstruments(i: PlaneInstruments): void;
  /** Show the torn caps of a broken joint. */
  showBreak(jointId: string): void;
  setCharred(partName: string, amount: number): void;
  /** Crumple deformation of a part near a root-space point (nose-first crash). */
  crumple?(partName: string, point: THREE.Vector3, amount: number): void;
  /** 0 = high, 1 = medium, 2 = low. */
  setLod(level: 0 | 1 | 2): void;
  /** Recommended LOD for a camera distance in metres (planemodels: CONFIG.planeModels.lodDistance). */
  lodForDistance?(distance: number): 0 | 1 | 2;
  /** Reattach every part to root with original transforms, hide caps, clear damage/charring. */
  repair(): void;
  update(dt: number): void;
  dispose(): void;
}

export type PlaneEngineStatus = 'ok' | 'fire' | 'destroyed' | 'detached';

export interface PlaneEngineState {
  status: PlaneEngineStatus;
  spool: number; // 0..1
  thrust: number; // N, current
  fire: number; // 0..1 fire size (spreads)
}

export type PlanePhase = 'none' | 'parked' | 'ground' | 'flying' | 'crashed' | 'destroyed';

export interface PlaneState {
  type: PlaneTypeId | null;
  phase: PlanePhase;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  airspeed: number; // m/s
  airspeedKmh: number;
  groundSpeedKmh: number;
  altitude: number; // m above sea level
  altitudeAgl: number;
  verticalSpeed: number; // m/s
  heading: number; // deg, 0 = north (-Z), 90 = east (+X)
  pitch: number; // deg, + nose up
  bank: number; // deg, + right wing down
  aoa: number; // deg
  throttle: number; // 0..1 commanded
  flaps: number; // 0..1
  gear: number; // 0 up .. 1 down
  onGround: boolean;
  brake: boolean;
  stall: boolean;
  stallWarning: boolean;
  rotationSpeedKmh: number;
  stallSpeedKmh: number;
  engines: PlaneEngineState[];
  assisted: boolean;
  outOfMap: { state: 'ok' | 'warning' | 'failing'; countdown: number; distance: number; failed: number; total: number };
  damage: { tailLost: boolean; split: boolean; drag: number };
  canExit: boolean;
}

export type CrashOutcome = 'landing' | 'hardLanding' | 'groundCrash' | 'waterCrash' | 'ditching' | 'building';
export type ImpactSurface = 'runway' | 'ground' | 'water' | 'building' | 'other';

export interface ImpactInfo {
  position: THREE.Vector3; // world
  velocity: THREE.Vector3; // body velocity at impact
  normalSpeed: number; // m/s into the surface
  tangentSpeed: number;
  angleDeg: number; // flight path angle to the surface
  part: string; // first part to touch
  energy: number; // J
  surface: ImpactSurface;
}

/** A free-flying wreck piece (one rigid body made of one or more parts). Owned by the breakup system. */
export interface WreckPiece {
  readonly id: number;
  readonly body: RAPIER.RigidBody;
  readonly object: THREE.Group; // contains the re-parented part objects
  readonly parts: string[];
  readonly mass: number;
  readonly hasCockpit: boolean;
  burning: number; // 0..1
}

/**
 * The intact (or partially broken) plane, as registered by the PlaneSystem with the breakup system.
 * The breakup system calls the callbacks; the PlaneSystem keeps flying `body` while it is non-null.
 */
export interface TrackedPlane {
  readonly type: PlaneTypeId;
  readonly visual: PlaneVisual;
  /** Intact body (null once the plane has split into pieces). */
  body: RAPIER.RigidBody | null;
  readonly brokenJoints: Set<string>;
  isGearDown(): boolean;
  /** Breakup → plane system: the gear collapsed (hard landing); plane continues as one body sliding on its belly. */
  onGearCollapse(): void;
  /** Breakup → plane system: parts detached but the main body survives (e.g. engine torn off, wing tip lost). */
  onPartsLost(parts: string[]): void;
  /** Breakup → plane system: the intact body was replaced by pieces (body is now null). cockpit = piece with the cockpit. */
  onSplit(pieces: WreckPiece[], cockpit: WreckPiece | null): void;
  /** Breakup → plane system: crash outcome classified (for camera/UI/slow-mo flow). */
  onCrash(outcome: CrashOutcome, info: ImpactInfo): void;
}

export interface BlastInfo {
  center: THREE.Vector3; // world
  energy: number; // relative blast energy (fuel-scaled)
  kind: 'total' | 'middle' | 'tail' | 'engine' | 'impact';
}
