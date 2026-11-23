import type * as THREE from 'three';
import type { ColliderTag, SurfaceMaterial } from './Physics';
import type { Settings } from './Settings';
import type { QualityLevel } from '../config';
import type { CarBuild } from '../vehicle/CarBuild';
import type { PlayerMode } from '../game/contracts';
import type { CrashOutcome, ImpactSurface, PlaneTypeId } from '../plane/types';

export type GameState = 'boot' | 'title' | 'menu' | 'garage' | 'driving' | 'paused';

/**
 * Every cross-module event. Emitters and listeners only depend on this file.
 * Vectors in payloads are owned by the emitter and may be reused after the call —
 * clone them if you need to keep them.
 */
export interface GameEvents extends Record<string, unknown> {
  /** Raw physics contact-force event for colliders that requested CONTACT_FORCE_EVENTS (emitted by core Physics). */
  contact: { h1: number; h2: number; tag1: ColliderTag | null; tag2: ColliderTag | null; force: number; dir: THREE.Vector3 };

  /** Player car hit something (emitted by vehicle). strength is 0..1 normalized, force is in N. */
  impact: { position: THREE.Vector3; normal: THREE.Vector3; strength: number; force: number; material: SurfaceMaterial; other: ColliderTag | null; speed: number };
  /** Metal scraping along a surface, emitted every fixed step while scraping (vehicle). intensity 0..1 */
  scrape: { position: THREE.Vector3; intensity: number };
  /** Horn pressed/released (vehicle or game). */
  horn: { position: THREE.Vector3; on: boolean };
  /** A big explosion happened (vehicle emits for the player car). */
  explosion: { position: THREE.Vector3; radius: number; force: number };
  /** The player car was respawned repaired (game/vehicle). */
  carReset: { position: THREE.Vector3; yaw: number };
  /** The player car was spawned into the world (vehicle). */
  carSpawned: { build: CarBuild };
  /** Glass broke on the player car or a parked car. */
  glassBreak: { position: THREE.Vector3; shattered: boolean };
  /** A car part detached (bumper, hood, door, wheel...). */
  partDetached: { part: string; position: THREE.Vector3 };
  /** Automatic gearbox changed gear (vehicle). gear: -1 = R, 0 = N, 1..5 */
  gearShift: { gear: number; up: boolean };

  /** A light prop was knocked (props). speed in m/s of the hit. */
  propHit: { position: THREE.Vector3; kind: string; speed: number };
  /** A parked car was shoved (props). */
  parkedCarHit: { position: THREE.Vector3; speed: number };

  /** A pedestrian was knocked down by the car (npc). */
  npcHit: { position: THREE.Vector3; speed: number };
  /** Pedestrians were startled (npc) — audio plays short reactions. */
  npcStartled: { position: THREE.Vector3; count: number; scream: boolean };

  /** Game state machine transitions (game). */
  stateChanged: { from: GameState; to: GameState };
  /** Settings changed (core Settings). keys = changed keys. */
  settingsChanged: { settings: Settings; keys: (keyof Settings)[] };
  /** Effective quality changed (core Quality). */
  qualityChanged: { level: QualityLevel };
  /** Show/hide a contextual prompt in the HUD, e.g. id 'flip' (vehicle → ui). */
  prompt: { id: string; show: boolean; text?: string };
  /** Short toast message (anyone → ui). */
  toast: { text: string; ms?: number };
  /** Haptics request (anyone → ui, which checks the vibration setting). */
  vibrate: { pattern: number | number[] };
  /** First user gesture happened (ui) — audio unlocks on this. */
  userGesture: Record<string, never>;

  // ── Part 2: planes ──
  /** Player switched between car and plane (game). */
  modeChanged: { mode: PlayerMode };
  /** A plane was spawned / respawned for the player (planes). */
  planeSpawned: { type: PlaneTypeId; inAir: boolean };
  /** An engine exploded (planes). velocity = plane velocity at the nacelle. radius = fireball radius. */
  engineExplode: { type: PlaneTypeId; engine: number; position: THREE.Vector3; velocity: THREE.Vector3; radius: number; replay?: boolean };
  /** Engine fire spread along the wing (planes). */
  engineFireSpread: { engine: number; position: THREE.Vector3 };
  /** Whole-plane / middle / tail explosion (planes or breakup). */
  /** replay: re-fired by the crash replay — effects / sound only (props, pedestrians, cameras ignore it). */
  planeExplosion: { position: THREE.Vector3; velocity: THREE.Vector3; radius: number; kind: 'total' | 'middle' | 'tail' | 'secondary'; replay?: boolean };
  /** Airframe tore apart (breakup) — metal tearing sound, camera shake. intensity 0..1 */
  planeBreak: { position: THREE.Vector3; velocity: THREE.Vector3; pieces: number; intensity: number };
  /** Classified impact of the plane or a big piece (breakup). */
  planeImpact: { position: THREE.Vector3; velocity: THREE.Vector3; outcome: CrashOutcome; surface: ImpactSurface; energy: number; normalSpeed: number; replay?: boolean };
  /** Wheels touched the ground (planes). */
  touchdown: { position: THREE.Vector3; verticalSpeed: number; hard: boolean };
  gearCollapse: { position: THREE.Vector3 };
  /** Stall warning horn on/off (planes). */
  stallWarning: { on: boolean };
  /** Master caution banner + tone, e.g. 'ENGINE 2 FIRE', 'ENGINE FAILURE — 2/4' (planes → ui/audio). */
  masterCaution: { text: string; level: 'caution' | 'warning' };
  /** Out-of-map sequence state changes (planes → ui/audio). */
  outOfMap: { state: 'ok' | 'warning' | 'failing'; countdown: number };

  // ── Part 3 ──
  /** Floating origin moved the world by -delta (core). Shift your cached world-space state by -delta. */
  originShift: { delta: THREE.Vector3; offset: THREE.Vector3 };
  /** Weather state changed target (env). */
  weatherChanged: { kind: string };
  /** Lightning strike (env) — audio plays thunder delayed by distance / 343 m/s. */
  lightning: { position: THREE.Vector3; intensity: number };
  /** Stunt moments (vehicle → ui pop-ups, audio, camera). */
  stunt: { kind: 'airborne' | 'cleanLanding' | 'crashLanding' | 'barrelRoll' | 'airGlide'; airTime: number; distance: number; rolls?: number };
  /** Turbo started/stopped (vehicle → fx/audio/camera/ui). */
  turbo: { on: boolean };
  /** A point of interest was discovered (nav → ui toast, save). */
  poiDiscovered: { id: string; name: string };
}
