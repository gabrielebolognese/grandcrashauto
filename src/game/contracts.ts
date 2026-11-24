import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Engine } from '../core/Engine';
import type { Origin } from '../core/Origin';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, GameState } from '../core/events';
import type { Input } from '../core/Input';
import type { Physics, SurfaceMaterial } from '../core/Physics';
import type { Quality } from '../core/Quality';
import type { SaveStore } from '../core/Save';
import type { SettingsStore } from '../core/Settings';
import type { CarBuild, CarModelId } from '../vehicle/CarBuild';
import type { CityData, Pose, DistrictId } from '../world/types';
import type {
  BlastInfo, CrashOutcome, ImpactInfo, PlaneState, PlaneTypeId, PlaneVisual, TrackedPlane, WreckPiece,
} from '../plane/types';

/**
 * MODULE CONTRACTS. Owner: core. Every module implements one interface below in its own directory and is wired in
 * src/game/Game.ts. Modules talk to each other ONLY through these interfaces (via ctx) and through events.
 * If you need something new from another module, add an OPTIONAL member here and note it in your report.
 */

export interface GameSystem {
  readonly name: string;
  /** Called once, in dependency order (see Game.ts). ctx is fully populated with all systems (not yet initialized ones too). */
  init(): Promise<void> | void;
  /** Fixed 60 Hz tick BEFORE physics step: apply forces, gameplay logic. */
  fixedUpdate?(dt: number): void;
  /** Fixed tick AFTER physics step: read body transforms (capture for interpolation). */
  postStep?(dt: number): void;
  /** Every rendered frame. dt = game dt (scaled by slow-mo), alpha = interpolation factor in [0,1). */
  update?(dt: number, alpha: number): void;
  dispose?(): void;
  /**
   * Optional pre-warm hook, called once after every system's init() and before the title screen: make sure every
   * material/pool you will use later EXISTS in the scene (even hidden) so the lead's shader pre-compilation covers it,
   * and do any other one-time GPU work (texture uploads, PMREM). Avoids first-seconds hitches.
   */
  warmup?(): Promise<void> | void;
}

export interface GameContext {
  engine: Engine;
  physics: Physics;
  input: Input;
  events: EventBus<GameEvents>;
  save: SaveStore;
  settings: SettingsStore;
  quality: Quality;
  game: GameActions;
  world: IWorld;
  env: IEnvironment;
  props: IProps;
  npcs: INpcSystem;
  cars: ICarFactory;
  vehicle: IPlayerVehicle;
  cameraRig: ICameraRig;
  fx: IFx;
  audio: IAudio;
  garage: IGarage;
  ui: IUI;
  /** Part 2: plane meshes, flyable planes, breakup/crash physics, GPS navigation + map screen. */
  planeModels: IPlaneFactory;
  planes: IPlaneSystem;
  breakup: IBreakup;
  nav: INav;
  /** The player on foot (cabin walking, falling, landing). */
  walker: IWalker;
  /** Crash replay with many cameras. */
  replay: IReplay;
  /** Agent mode (?agent): text view + forecasts + tap-to-hold controls + command API (window.gca) for AI agents. */
  agent?: IAgent;
  /** Medieval + fantasy towers (src/towers): teleport places, crashable. */
  towers?: GameSystem & { readonly pois: { id: string; name: string; icon: string; pose: Pose }[]; aimAt(ax: number, az: number): number | null };
  /** Missiles, nukes, air-defence sites and the perpetual sky traffic (src/missiles). */
  missiles?: IMissiles;
  /** Part 3: floating origin (absolute = local + origin.offset), endless terrain, highway network. */
  origin: Origin;
  terrain: ITerrain;
  highways: IHighways;
  /** True when ?debug is in the URL. */
  debug: boolean;
}

/** High-level game actions (implemented by Game.ts), used by UI / garage. */
export interface GameActions {
  readonly state: GameState;
  /** From title screen / menu: start driving with the saved current car. */
  play(): void;
  /** Menu "click and fly": start playing straight in the air in this plane. */
  quickFly?(type: PlaneTypeId): void;
  openGarage(): void;
  /** Leave garage and drive the given build (garage "Drive" button). */
  driveFromGarage(build: CarBuild): void;
  pause(): void;
  resume(): void;
  toMainMenu(): void;
  /** Explode if driving & intact, otherwise reset. Same as the 💥/↺ button. */
  explodeOrReset(): void;
  requestReset(): void;
  /** Called by the title screen after the first user gesture. */
  titleDone(): void;
  /** Part 2: who the player controls while in the 'driving' state. */
  readonly mode: PlayerMode;
  /** Switch control between the car and a plane (called by the plane system on board/exit). Emits 'modeChanged'. */
  setMode(mode: PlayerMode): void;
  /** Slow-motion dip: timeScale drops to `scale` and eases back to 1 over `duration` real seconds. */
  slowMo(scale: number, duration: number): void;
  /** Teleport the CAR to a pose with a fade (map teleport). Ignored while the car is exploded. */
  teleportCar(pose: Pose): void;
}

export type PlayerMode = 'car' | 'plane';

// ─────────────────────────────── world (src/world) ───────────────────────────────
export interface IWorld extends GameSystem {
  readonly data: CityData;
  /** Height of the drivable/walkable surface at x,z (roads, highway decks, terrain, seabed). */
  groundHeightAt(x: number, z: number): number;
  surfaceAt(x: number, z: number): SurfaceMaterial;
  districtAt(x: number, z: number): DistrictId;
  /** Nearest safe road pose to `pos`, oriented along the road in the direction closest to `yaw` (spec §10 reset). */
  findRespawn(pos: THREE.Vector3, yaw: number): Pose;
  /** Is (x,z) in water deeper than CONFIG.world.deepWaterDepth? */
  isDeepWater(x: number, z: number): boolean;
  /** Streaming focus (player car or menu camera). Called by Game every frame. */
  setFocus(pos: THREE.Vector3): void;
  // -- Part 3 (all coordinates LOCAL). The world delegates outside the city/airport to ctx.terrain / ctx.highways. --
  /** Metres offshore over the ocean (0 over land). Planes' out-of-map uses it (ocean side only). */
  oceanDistance?(x: number, z: number): number;
  /** Is (x,z) on a highway carriageway (turbo recharge bonus)? */
  isOnHighway?(x: number, z: number): boolean;
  /**
   * (world) Drivable surface nearest below `y + 1.5` at x,z: the viaduct deck when on it, the street when under it.
   * groundHeightAt() always returns the LOWEST surface (street under an elevated deck).
   */
  groundHeightNear?(x: number, y: number, z: number): number;
}

// ─────────────────────────── environment (src/world/env) ─────────────────────────
export interface IEnvironment extends GameSystem {
  readonly sun: THREE.DirectionalLight;
  /** 0 = day, 1 = full night (lights, emissive windows should follow). */
  readonly nightFactor: number;
  /** PMREM env map for reflective materials (cars). May be null until ready. */
  readonly envMap: THREE.Texture | null;
  /** Shadow camera follows this point (player car). */
  setShadowFocus(pos: THREE.Vector3): void;
  /** Build an env map/lighting rig suitable for a separate scene (garage). Optional. */
  applyTo?(scene: THREE.Scene): void;
  // -- Part 3: day/night clock + weather (optional until the env module implements them; read with fallbacks) --
  /** Game clock in hours 0..24 (day length from settings.dayLengthMin; settings.timeLocked pauses it). */
  readonly clockHours?: number;
  setTime?(hours: number): void;
  readonly weather?: WeatherState;
  /** World wind (m/s incl. gusts), same as GLOBAL_UNIFORMS.uWind. */
  readonly wind?: THREE.Vector3;
  /** 0..1 puddle depth at (x,z) local (noise mask × wetness) — aquaplaning + puddle shading. */
  puddleAt?(x: number, z: number): number;
  /** Patch a road/ground/foliage MeshStandardMaterial so it shows wetness, puddles and snow (onBeforeCompile). */
  patchMaterial?(material: THREE.Material, kind: 'road' | 'ground' | 'foliage' | 'building' | 'vehicle'): void;
}

export type WeatherKind = 'clear' | 'fewClouds' | 'cloudy' | 'overcast' | 'lightRain' | 'heavyRain' | 'storm' | 'fog' | 'snow';
export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'fewClouds', 'cloudy', 'overcast', 'lightRain', 'heavyRain', 'storm', 'fog', 'snow'];

export interface WeatherState {
  kind: WeatherKind; // current (target) state
  transition: number; // 0..1 progress toward `kind`
  cloudCover: number; // 0..1
  rain: number; // 0..1 precipitation intensity (rain or snow by altitude)
  snow: number; // 0..1 (falling snow at the focus)
  fog: number; // 0..1 (1 = ~80 m visibility)
  wetness: number; // 0..1 road wetness (fades in ~1 min, dries over minutes)
  storm: number; // 0..1 (lightning, gusts, turbulence)
  /** Tyre grip multiplier at the focus (1 clear, ~0.75 rain, ~0.65 storm, ~0.45 snow). */
  grip: number;
  visibility: number; // metres
  windSpeed: number; // m/s mean
  gust: number; // m/s current gust on top of the mean
}

// ───────────────────────── props & parked cars (src/world/props) ──────────────────
export interface IProps extends GameSystem {
  /** True once a prop (by CityData.props index) has been knocked from its original place. */
  isDisturbed(propIndex: number): boolean;
  /** Remove debris/reset knocked props near pos (optional cleanup). */
  resetAll?(): void;
}

// ─────────────────────────────── pedestrians (src/npc) ───────────────────────────
export interface INpcSystem extends GameSystem {
  readonly activeCount: number;
  /** Part 3: register a small ambient spot (rest stop, viewpoint) where a few NPCs idle/wander; returns an id. */
  addAmbientSpot?(spot: { position: THREE.Vector3; radius: number; count: number; benches?: { p: THREE.Vector3; yaw: number }[] }): number;
  removeAmbientSpot?(id: number): void;
  /** Crowd sites for the map / minimap (LOCAL x/z; one entry per mini crowd, the concert as a single entry). */
  crowdSpots?(): readonly { x: number; z: number; count: number; concert: boolean }[];
  /** The player's on-foot character (same skinned mesh as the pedestrians). The caller adds .object to the scene. */
  createAvatar?(): AvatarHandle | null;
  /** A group of animated people in one draw call (plane passengers / flight attendants), same seed = same people. */
  createAvatarGroup?(looks: ('passenger' | 'hostess')[], seed: number): AvatarGroupHandle | null;
}

/** A single directly-driven pedestrian-style character (the player on foot). */
/** A plane of the perpetual sky traffic (map / agent). ax/az ABSOLUTE, alt = absolute y, heading deg (0 = north). */
export interface SkyPlaneInfo {
  id: number;
  type: import('../plane/types').PlaneTypeId;
  name: string;
  ax: number;
  az: number;
  alt: number;
  heading: number;
  speed: number;
  hit: boolean;
}

/** An air-defence site (map / agent). */
export interface LauncherInfo {
  id: string;
  name: string;
  kind: string;
  ax: number;
  az: number;
  tubes: number;
  ready: number;
  warhead: string;
  blurb: string;
}

/** Missiles + nukes + sky traffic + the control room (src/missiles). */
export interface IMissiles extends GameSystem {
  readonly sky: SkyPlaneInfo[];
  readonly sites: LauncherInfo[];
  readonly pois: { id: string; name: string; icon: string; pose: Pose }[];
  readonly controlling: boolean;
  /** Streaming focus while in the control room, else null. */
  readonly focus: THREE.Vector3 | null;
  /** Into the control room of a site, aiming at a sky plane. Returns '' or an error. */
  enterControl(siteId: string, planeId: number): string;
  exitControl(): void;
  fire(n?: number, opts?: { all?: boolean; spread?: boolean }): string;
  steer(u: number, v: number): void;
  ram(planeId: number | null): string;
  nuke(planeId: number | null, at?: { x: number; z: number }): string;
  /** Aim the control room's launcher exactly at its target. */
  autoAim?(): void;
}

/** Several independently animated people in one mesh (src/npc/AvatarGroup). Matrices are absolute world matrices. */
export interface AvatarGroupHandle {
  readonly object: THREE.Object3D;
  readonly count: number;
  play(i: number, clip: string, fade?: number, rate?: number, restart?: boolean): void;
  clipDone(i: number): boolean;
  setMatrix(i: number, m: THREE.Matrix4): void;
  hide(i: number): void;
  setFill(level: number): void;
  update(dt: number): void;
  dispose(): void;
}

export interface AvatarHandle {
  readonly object: THREE.Object3D;
  visible: boolean;
  /** Clip name from the pedestrian set: idle, walk, run, sit, tumble, fallBack, lieBack, getUpBack, flinch, cheer… */
  play(clip: string, fade?: number, rate?: number, restart?: boolean): void;
  /** The current non-looping clip has finished. */
  readonly clipDone: boolean;
  /** World matrix of the feet origin (yaw included; the avatar applies its own body scale). */
  setMatrix(m: THREE.Matrix4): void;
  /** Emissive fill (0..1): cabin lights at night etc. */
  setFill?(level: number): void;
  update(dt: number): void;
  dispose(): void;
}

/**
 * Agent mode (src/agent, ?agent): lets an AI agent play from text. A live text view (state, held controls, autopilot,
 * a forecast of the next seconds, queued commands), keys that latch (a tap = a timed hold), a command language with
 * timing ("pitch up 2; wait 2; split") and a turn-based freeze. window.gca is the JS entry point.
 */
export interface IAgent extends GameSystem {
  /** Simulation frozen (turn-based): fixed updates stop, the frame stays on screen. */
  readonly frozen: boolean;
  /** Run a command string; returns a report (results + the new forecast). */
  run(cmds: string): string;
  /** The current text view. */
  text(): string;
}

/** Live flight internals for agent forecasts (the agent clones them; never mutate). */
export interface FlightSnapshot {
  model: unknown; // FlightModel
  inputs: unknown; // FlightInputs
  body: RAPIER.RigidBody;
  rest: number; // wheel rest height below the body origin
  throttle: number;
  spool: number; // mean spool of the working engines
  idle: number; // idle thrust fraction
  tailExplodeIn: number | null;
}

/** Crash replay (src/replay): records the flown plane, plays the crash back from many cameras (sim frozen). */
export interface IReplay extends GameSystem {
  readonly active: boolean;
  readonly canReplay: boolean;
  readonly camName: string;
  /** Playback speed this frame (slow motion around explosions / impacts). */
  readonly speed: number;
  start(): void;
  stop(): void;
  restart(): void;
  nextCam(): void;
  /** Per frame while replaying (Game calls it instead of the simulation). */
  play(realDt: number): void;
  /** Record another plane (a sky plane hit by a missile) + extra objects (the missiles) instead of yours. */
  watch?(visual: import('../plane/types').PlaneVisual, extra: THREE.Object3D[]): void;
  addExtra?(obj: THREE.Object3D): void;
  /** While replaying: where the world should stream around (the replayed plane), else null. */
  readonly focus?: THREE.Vector3 | null;
}

/** The player on foot (walking in plane cabins, falling out, landing): owner core/lead (src/walk). */
export interface IWalker extends GameSystem {
  readonly active: boolean;
  readonly mode: 'off' | 'cabin' | 'fall' | 'ground';
  readonly firstPerson: boolean;
  /** Where the character is (streaming / shadow focus) while active, else null. */
  readonly focus: THREE.Vector3 | null;
  readonly seated: boolean;
  /** Context actions for the UI. */
  readonly canTakeControls: boolean;
  readonly canStepOut: boolean;
  canStart(): boolean;
  start(): boolean;
  stop(): void;
  /** F: take the controls back (near the cockpit) / step out of a stopped wreck. */
  interact(): void;
  toggleView(): void;
  lookOutWindow(): void;
  /** On the ground after falling out: a new plane in the air right here / back to the car. */
  flyAgain(): void;
}

// ─────────────────────────── car models (src/vehicle/models) ─────────────────────
export interface CarModelInfo {
  id: CarModelId;
  name: string; // original, fictional name
  description: string;
}

export interface CarDimensions {
  /** Local wheel centers at stock ride height: FL, FR, RL, RR. Car faces +Z, left side is +X. */
  wheelPositions: THREE.Vector3[];
  wheelRadius: number; // includes the build's wheel size
  wheelWidth: number;
  /** Chassis collider half extents (box) and its center offset in local space. */
  halfExtents: THREE.Vector3;
  colliderOffset: THREE.Vector3;
  /** Approx mass in kg for this body style. */
  mass: number;
}

export interface WheelVisual {
  /** Positioned at the wheel center (local to car root); vehicle sets .position.y for suspension and .rotation.y for steering. */
  pivot: THREE.Object3D;
  /** Child of pivot; vehicle sets .rotation.x for rolling. */
  spin: THREE.Object3D;
}

export interface CarVisual {
  readonly root: THREE.Group;
  readonly dims: CarDimensions;
  readonly wheels: WheelVisual[]; // FL, FR, RL, RR
  /** Named detachable parts (hood, doorL, doorR, bumperF, bumperR, trunk, spoiler...). Values are children of root. */
  readonly parts: Record<string, THREE.Object3D>;
  applyBuild(build: CarBuild): void;
  setLights(state: { brake: boolean; reverse: boolean; headlights: boolean; underglow: boolean }): void;
  /** Deform the body near a local-space point. */
  dent(localPoint: THREE.Vector3, localDir: THREE.Vector3, strength: number): void;
  /** 0 intact, 1 cracked, 2 shattered (all windows). */
  setGlassDamage(level: 0 | 1 | 2): void;
  /** 0..1 charred black (explosion). */
  setCharred(amount: number): void;
  /** Remove a part from the car root and return it (world transform preserved by the caller). */
  detachPart(name: string): THREE.Object3D | null;
  /** Restore all parts/damage to pristine. */
  repair(): void;
  update(dt: number): void;
  dispose(): void;
  /** Part 3 (carmodels): exhaust tip outlets in root-local space, pointing -Z (turbo flames). */
  readonly exhaustPoints?: THREE.Vector3[];
  /** Part 3 (carmodels): rear upper body corners (left, right) in root-local space (glide vapour trails). */
  readonly rearCorners?: THREE.Vector3[];
  /** Part 3 (carmodels): headlight lamp centres (left, right) in root-local space, facing +Z (spotlight mounts). */
  readonly headlightPoints?: THREE.Vector3[];
}

export interface ICarFactory extends GameSystem {
  readonly models: CarModelInfo[];
  create(build: CarBuild, opts?: { lod?: 'high' | 'low' }): CarVisual;
  /**
   * One merged low-poly geometry (~1-3k tris) per model for INSTANCED parked cars. Must have 'position', 'normal',
   * 'color' (baked vertex colours for non-paint parts) and a float attribute 'paintMask' (1 = body paint, tinted per
   * instance; 0.5 = glass; 0 = other). Car faces +Z, origin on the ground under the car center. Return null if unsupported.
   */
  instancingGeometry?(model: CarModelId): THREE.BufferGeometry | null;
  /**
   * Part 3 (carmodels): fake headlight beams matching instancingGeometry (same local frame) for night traffic /
   * parked cars: non-indexed position/normal/color (pre-faded intensity) — draw additive, depthWrite off.
   * Note instancingGeometry's paintMask 0.25 marks lamp lenses (baked warm-white front / red rear): emissive at night.
   */
  instancingBeamGeometry?(model: CarModelId): THREE.BufferGeometry | null;
}

// ─────────────────────────── player vehicle (src/vehicle) ─────────────────────────
export interface WheelState {
  position: THREE.Vector3; // world contact point (or hard point if airborne)
  normal: THREE.Vector3;
  contact: boolean;
  slip: number; // 0..1 combined slip (skid intensity)
  surface: SurfaceMaterial;
  rpm: number;
}

export interface VehicleState {
  position: THREE.Vector3; // interpolated visual position
  quaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  speed: number; // m/s, signed along forward
  speedKmh: number; // absolute
  rpm: number;
  rpmNorm: number; // 0..1 idle..redline
  gear: number; // -1 R, 0 N, 1..5
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  airborne: boolean;
  upsideDown: boolean;
  exploded: boolean;
  boost: number; // 0..1 turbo spool (upgraded engine)
  wheels: WheelState[];
  // -- Part 3 (optional until the vehicle module fills them) --
  turboCharge?: number; // 0..1 meter
  turboActive?: boolean; // boosting right now
  airborne3?: { active: boolean; time: number; distance: number; predicted: number; gliding: boolean; rolling: boolean; rolls: number };
  headlights?: 'off' | 'low' | 'high';
  aquaplaning?: boolean;
}

export interface IPlayerVehicle extends GameSystem {
  readonly active: boolean;
  readonly state: VehicleState;
  /** Interpolated visual root (null when not spawned). */
  readonly object: THREE.Object3D | null;
  readonly visual: CarVisual | null;
  readonly chassis: RAPIER.RigidBody | null;
  readonly build: CarBuild | null;
  spawn(build: CarBuild, pose: Pose): void;
  despawn(): void;
  /** Live-apply a new build (visuals + physics tuning) without respawning. */
  applyBuild(build: CarBuild): void;
  explode(): void;
  /** Respawn repaired, upright, still, at the nearest safe road pose (or at `pose` if given). */
  reset(pose?: Pose): void;
  flip(): void;
}

// ─────────────────────────────── camera (src/camera) ─────────────────────────────
export type CameraMode = 'chase' | 'hood' | 'orbit' | 'cinematic' | 'showcase';

export interface ICameraRig extends GameSystem {
  readonly mode: CameraMode;
  /** Cycle chase → hood → orbit → chase (C / camera button). */
  cycleMode(): void;
  setMode(mode: CameraMode): void;
  shake(intensity: number, duration: number): void;
  /** Short orbit around a point (explosion); ends by itself or on skipCinematic(). */
  startCinematic(target: THREE.Vector3, duration: number): void;
  skipCinematic(): void;
  /** Snap behind the car (after reset/spawn). */
  snap(): void;
  /** Feed orbit-drag input (pixels) from UI pointer events in orbit mode. */
  orbitDrag?(dx: number, dy: number): void;
  /**
   * Part 2 (camera): the concrete view, for HUD labels. In plane mode `mode` maps cockpit/wing → 'hood' and
   * crash/explosion shots → 'cinematic'; `view` names them exactly.
   */
  readonly view?: 'chase' | 'hood' | 'orbit' | 'cockpit' | 'wing' | 'cinematic' | 'showcase';
}

// ─────────────────────────────── effects (src/fx) ────────────────────────────────
export interface FireHandle {
  stop(): void;
}

export interface IFx extends GameSystem {
  explosion(pos: THREE.Vector3, scale: number): void;
  sparks(pos: THREE.Vector3, normal: THREE.Vector3, intensity: number): void;
  dust(pos: THREE.Vector3, intensity: number, color?: THREE.ColorRepresentation): void;
  smoke(pos: THREE.Vector3, intensity: number): void;
  glassShards(pos: THREE.Vector3, count: number): void;
  /** Persistent fire+smoke attached to an object (burning wreck). */
  attachFire(target: THREE.Object3D, localOffset?: THREE.Vector3, scale?: number): FireHandle;
  /** Remove all transient effects, fires and skid marks (on reset). */
  clearAll(): void;

  // -- Part 2 (planes). All optional until the fx module implements them; callers use optional chaining. --
  /**
   * Momentum-correct explosion (SPEC-PART2 section 12): particles inherit `velocity` (fireball ~90%, smoke ~60%,
   * sparks 100%) then drag toward the wind. `radius` = fireball radius (car ~6, prop ~10, bizjet ~25, airliner ~45,
   * jumbo ~70). nearSurface adds a dust ring ('ground') or spray ring ('water') when within ~100 m of it.
   */
  explosionEx?(o: { position: THREE.Vector3; velocity?: THREE.Vector3; radius: number; kind?: 'car' | 'engine' | 'plane' | 'secondary' | 'impact'; nearSurface?: 'ground' | 'water' | null; light?: boolean }): void;
  /** World-space fire+smoke trail on a moving object (burning engine/tail/wreck): flames stretched by airflow, smoke ribbon left in the sky. */
  attachTrail?(target: THREE.Object3D, localOffset: THREE.Vector3, o: { fire: number; smoke: number; size: number; cap?: number }): TrailHandle;
  /** Water impact: spray plume (height ~ speed squared), splash ring, foam. */
  splash?(o: { position: THREE.Vector3; velocity: THREE.Vector3; size: number }): void;
  /** Continuous spray sheet behind a skimming object (call every frame while skimming). */
  spraySheet?(position: THREE.Vector3, velocity: THREE.Vector3, intensity: number): void;
  steam?(position: THREE.Vector3, size: number): void;
  bubbles?(position: THREE.Vector3, size: number): void;
  /** Burning fuel patch on the ground or floating on water (slick); burns `duration` s. */
  fuelFire?(o: { position: THREE.Vector3; velocity?: THREE.Vector3; size: number; duration: number; onWater: boolean }): void;
  /** Ground scrape / plough gouge decal segment from a to b (call repeatedly while sliding). */
  gouge?(a: THREE.Vector3, b: THREE.Vector3, width: number): void;
  /** Small non-colliding debris fragments (fan blades, cowling, panels, paper-like insulation) inheriting velocity. */
  debrisBurst?(o: { position: THREE.Vector3; velocity: THREE.Vector3; count: number; size: number; kind?: 'metal' | 'panel' | 'paper' | 'cushion' }): void;
  /** White mist puff (cabin depressurization). */
  mist?(position: THREE.Vector3, velocity: THREE.Vector3, size: number): void;
  /** Scorch decal on a building facade (vertical surface). */
  scorch?(position: THREE.Vector3, normal: THREE.Vector3, size: number): void;
  /** The fx clock (crash replay records it). */
  readonly clock?: number;
  /** Pooled light flash (explosions, launches, the nuke). */
  flash?(x: number, y: number, z: number, peak: number, decay: number, distance: number): void;
  /** Crash replay rewind: the fx clock of the replayed moment, or null when the replay ends (see Fx.replayClock). */
  replayClock?(fxClock: number | null, restart?: boolean): void;
}

export interface TrailHandle extends FireHandle {
  setIntensity(fire: number, smoke: number, size?: number): void;
}

// ─────────────────────────────── audio (src/audio) ───────────────────────────────
export interface IAudio extends GameSystem {
  /** Resume the AudioContext — call from a user gesture. */
  unlock(): void;
  readonly unlocked: boolean;
  /** One-shot UI click/confirm sounds. */
  ui(kind: 'click' | 'confirm' | 'back' | 'toggle'): void;
}

// ─────────────────────────────── garage (src/ui/garage) ──────────────────────────
export interface IGarage extends GameSystem {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

// ─────────────────────────────── UI (src/ui) ─────────────────────────────────────
export interface IUI extends GameSystem {
  /** Loading screen progress 0..1 with label (before 'title' state). */
  setLoading(progress: number, label: string): void;
  /** Fade to black, run cb at full black, fade back (reset swap). */
  fade(cb: () => void): void;
  showFatal(message: string): void;
  /** Recording mode: every button tiny and gathered in one corner, the rest of the screen clear. */
  setRecMode?(on: boolean): void;
  readonly recMode?: boolean;
}

// =============================== PART 2: planes, breakup, navigation ===============================

// --------------------------- plane meshes (src/plane/models) ---------------------------
export interface PlaneModelInfo {
  type: PlaneTypeId;
  name: string; // fictional model name
  livery: string; // fictional operator
  description: string;
}

export interface IPlaneFactory extends GameSystem {
  readonly models: PlaneModelInfo[];
  /** Build a complete plane (named parts, joints, caps, cockpit interior, 3 LODs). */
  create(type: PlaneTypeId): PlaneVisual;
}

// --------------------------- flyable planes (src/plane) ---------------------------
export interface PlaneCameraTarget {
  object: THREE.Object3D; // follow this (already interpolated)
  kind: 'plane' | 'cockpitPiece' | 'wreck';
  size: number; // characteristic length (m) for camera distance
  velocity: THREE.Vector3;
  /** Local-space cockpit eye of `object` (for the cockpit camera), if any. */
  cockpitEye?: THREE.Vector3;
  /** Local-space wing camera of `object`, if any. */
  wingCam?: { position: THREE.Vector3; target: THREE.Vector3 };
}

export interface IPlaneSystem extends GameSystem {
  /** The player is controlling (or riding in the wreck of) a plane. */
  readonly active: boolean;
  readonly state: PlaneState;
  readonly visual: PlaneVisual | null;
  readonly cameraTarget: PlaneCameraTarget | null;
  /** Non-null when the car is close/slow enough to board (UI shows BOARD). */
  readonly boardCandidate: { type: PlaneTypeId; name: string } | null;
  /** True after a crash/destruction; UI shows Back to car / Respawn plane / Retry in air when crashTime > 3 s. */
  readonly crashed: boolean;
  /** Ram autopilot (missiles / map "RAM"): where to fly into, or null. */
  ramTarget?: (() => THREE.Vector3 | null) | null;
  /** Crashed OR otherwise wrecked (gear collapsed in a hard landing, split, hit the ground): no more engine blasts. */
  readonly wrecked?: boolean;
  readonly crashTime: number;
  /** In the explode-middle cockpit sequence (camera free-look, Skip button). */
  readonly inCockpitSequence: boolean;
  board(): boolean;
  exit(): boolean;
  explodeEngine(index: number): void;
  explode(): void;
  explodeMiddle(): void;
  explodeTail(): void;
  respawnPlane(): void;
  retryInAir(): void;
  backToCar(): void;
  skipSequence(): void;
  /** Quick placement (user request, crash-first design): move the intact plane `forward` m along its heading and `up` m
   * vertically, keeping velocity/attitude (clamped above the ground). Spammable. */
  nudge?(forward: number, up: number): void;
  /** "AIRBORNE" button: from standstill on the ground, put the plane in flight right here (~300 m up, cruise speed,
   * gear up, engines spooled), facing its current heading. */
  takeOff?(): void;
  /** After a split: cycle the camera between the big wreck pieces (front half, rear half, wings…). V / Switch button. */
  cycleTarget?(): void;
  /** True when there are at least two big pieces to switch between. */
  readonly canCycleTarget?: boolean;
  /** Fire build-up from re-pressing a burning engine's button (null when nothing to show). */
  readonly fireMeter?: { points: number; needed: number } | null;
  /** Menu "click and fly": straight into the air in this plane, no boarding. */
  quickFly?(type: PlaneTypeId, at?: { x: number; z: number; dirX: number; dirZ: number }): void;
  /** Swap to another plane type mid-air (same place, heading; cruise speed). */
  switchType?(type: PlaneTypeId): void;
  /** Current plane type (null when not flying). */
  readonly currentType?: PlaneTypeId | null;
  /** The tracked plane (broken joints) while flying / riding the wreck. */
  readonly currentTracked?: TrackedPlane | null;
  /**
   * Wing break buttons (user request): 'far' tears the wingtip off (hard to control, still flies); 'half' tears the
   * wing in half — control fades over ~30 s into a full stall and an unrecoverable spin.
   */
  breakWing?(side: 'L' | 'R', mode: 'far' | 'half'): void;
  /** Current wing failure (HUD), or null. */
  readonly wingFailure?: { side: 'L' | 'R'; mode: 'far' | 'half'; t: number } | null;
  /** The pilot is walking in the cabin: neutral stick + assisted flight (autopilot). Set by the walker. */
  walking?: boolean;
  /** Agent autopilot: flight-path angle (rad) the assists hold while the stick is neutral, or null (set every step). */
  autopilotGamma?: number | null;
  /** Agent: gear held up (0) / down (1) in the air instead of the automatic schedule, or null (reset per flight). */
  gearLock?: 0 | 1 | null;
  /** Agent forecasts: the live flight model / inputs / body. */
  flightSnapshot?(): FlightSnapshot | null;
  /** Agent: start in the air at local (x, z), agl m above the ground (wheels), heading (dirX, dirZ), speed m/s. */
  spawnAir?(type: PlaneTypeId, x: number, z: number, agl: number, dirX: number, dirZ: number, speed?: number): void;
}

// --------------------------- breakup & crash physics (src/plane/breakup) ---------------------------
export interface IBreakup extends GameSystem {
  /** Register the intact player plane: crash detection, water forces and breakup apply to it from now on. */
  track(plane: TrackedPlane): void;
  untrack(plane: TrackedPlane): void;
  /**
   * Break joints of a tracked plane (momentum-conserving split + clamped blast kick). Returns the newly created
   * free pieces. If the main body is replaced, plane.onSplit() is called; if only parts fell off, plane.onPartsLost().
   */
  breakJoints(plane: TrackedPlane, jointIds: string[], blast?: BlastInfo): WreckPiece[];
  /** Total fuel explosion: break every joint, fireball, burning pieces (8a). */
  explodeTotal(plane: TrackedPlane): void;
  /** Gear collapse + belly slide (hard landing) - the plane system calls it on a 3-6 m/s touchdown. */
  hardLanding(plane: TrackedPlane, info: ImpactInfo): void;
  /** Ground/water/building crash at an impact (e.g. > 6 m/s touchdown); fuselage/water contacts are detected internally. */
  crash(plane: TrackedPlane, outcome: CrashOutcome, info: ImpactInfo): void;
  readonly pieces: readonly WreckPiece[];
  /** Largest burning piece (camera follow after a total explosion). */
  readonly focusPiece: WreckPiece | null;
  /** Remove every piece, fire and slick (respawn). */
  clear(): void;
  /**
   * The crashed plane's wreck stays in the world (user request): its pieces keep settling, its fires fade on their own
   * schedule; it no longer counts for the camera focus / pieces list. clear() keeps it; dropRetired() removes it.
   */
  retire?(plane: TrackedPlane): void;
  dropRetired?(plane: TrackedPlane): void;
}

// --------------------------- navigation + map screen (src/nav, src/ui/map) ---------------------------
export interface PointOfInterest {
  id: string; // 'airport' | 'garage' | 'beach' | 'downtown' | 'park' | 'highway' | ...
  name: string;
  icon: string; // emoji or short glyph
  /** On-road destination pose (airport: the car park facing the planes). */
  pose: Pose;
}

export interface INav extends GameSystem {
  readonly pois: PointOfInterest[];
  /** Active route polyline (world points, y = road height), or null. */
  readonly route: THREE.Vector3[] | null;
  readonly destination: PointOfInterest | null;
  /** Next manoeuvre for the turn card. */
  readonly nextTurn: { direction: 'left' | 'right' | 'straight' | 'uturn' | 'arrive'; distance: number } | null;
  setDestination(poiId: string | null): void;
  teleport(poiId: string): void;
  openMap(): void;
  closeMap(): void;
  readonly mapOpen: boolean;
}

// =============================== PART 3: endless terrain + highway network ===============================

/** Procedural terrain beyond the city/airport (src/terrain). All query coordinates are LOCAL (scene) coordinates. */
export interface ITerrain extends GameSystem {
  /** Nuke: every tree within radius of a LOCAL ground point is flattened (smashed near, knocked outward further). */
  blastTrees?(center: THREE.Vector3, radius: number): number;
  /**
   * Planes vs trees (user request): trees whose trunk crosses the oriented box (LOCAL centre, rotation, half extents)
   * fall over, or are smashed on fast low hits. Returns the tree "mass" hit (1 smashed, 0.35 knocked) for momentum.
   */
  hitTrees?(center: THREE.Vector3, quat: THREE.Quaternion, half: THREE.Vector3, vel: THREE.Vector3): number;
  /** Final ground height (after highway corridor carving) at local x,z. Inside the city/airport bounds: their flat level. */
  heightAt(x: number, z: number): number;
  /** Surface material for tyres/fx (grass, sand, rock→concrete, snow→sand-like, asphalt on carved roads…). */
  surfaceAt(x: number, z: number): SurfaceMaterial;
  biomeAt(x: number, z: number): string;
  /** Water surface height if (x,z) is in the ocean or a lake, else null. */
  waterAt(x: number, z: number): number | null;
  /** Metres offshore (0 over land). */
  oceanDistance(x: number, z: number): number;
  /** True once colliders around (x,z) within radius are loaded (teleports wait for it). */
  isReady(x: number, z: number, radius: number): boolean;
  /** Points of interest discovered/generated so far (Lighthouse, Summit Viewpoint, Fishing Pier…), local poses. */
  readonly pois: { id: string; name: string; icon: string; pose: Pose }[];
  /** Streaming focus (Game calls it every frame with the player/camera position, LOCAL). */
  setFocus?(pos: THREE.Vector3): void;
}

/** Endless highway network + ramps + rest stops (src/highway). LOCAL coordinates. */
export interface IHighways extends GameSystem {
  /** Road surface height if (x,z) is on a highway deck/carriageway near height `nearY`, else null. */
  roadHeightAt(x: number, z: number, nearY?: number): number | null;
  isOnHighway(x: number, z: number): boolean;
  inTunnel(pos: THREE.Vector3): boolean;
  /** Inside a rest stop / gas station area (turbo refills instantly). */
  restStopAt(x: number, z: number): boolean;
  /** Nearest safe highway pose (right lane, along travel direction closest to yaw) within maxDist, or null. */
  findRespawn(pos: THREE.Vector3, yaw: number, maxDist: number): Pose | null;
  /** Generated highway network so far as a road graph (LOCAL coords) — joined to the city graph at interchanges, for A*. */
  readonly graph: import('../world/types').RoadGraph;
  /** Bumps whenever `graph` grows (nav re-indexes). */
  readonly graphVersion: number;
  /** Points of interest so far (Mountain Pass, Coastal Bridge, Big Jump, Rest Stop n…), local poses on the road. */
  readonly pois: { id: string; name: string; icon: string; pose: Pose }[];
  setFocus?(pos: THREE.Vector3): void;
}
