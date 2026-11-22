import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Engine } from '../core/Engine';
import type { EventBus } from '../core/EventBus';
import type { GameEvents, GameState } from '../core/events';
import type { Input } from '../core/Input';
import type { Physics, SurfaceMaterial } from '../core/Physics';
import type { Quality } from '../core/Quality';
import type { SaveStore } from '../core/Save';
import type { SettingsStore } from '../core/Settings';
import type { CarBuild, CarModelId } from '../vehicle/CarBuild';
import type { CityData, Pose, DistrictId } from '../world/types';

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
  /** True when ?debug is in the URL. */
  debug: boolean;
}

/** High-level game actions (implemented by Game.ts), used by UI / garage. */
export interface GameActions {
  readonly state: GameState;
  /** From title screen / menu: start driving with the saved current car. */
  play(): void;
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
}

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
}
