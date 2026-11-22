import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { RAPIER, G, groups, BodyInterpolator } from '../core/Physics';
import { approach, clamp, damp, DEG, lerp, smoothstep } from '../core/math';
import { reportError } from '../core/debugOverlay';
import type { GameContext, IPlaneSystem, PlaneCameraTarget, TrailHandle } from '../game/contracts';
import {
  PLANE_TYPES, type CrashOutcome, type ImpactInfo, type ImpactSurface, type PlaneEngineInfo, type PlaneEngineState,
  type PlaneEngineStatus, type PlaneState, type PlaneTypeId, type PlaneVisual, type TrackedPlane, type WreckPiece,
} from './types';
import { FlightModel, defaultInputs, planeCfg, type FlightInputs, type PlaneCfg } from './FlightModel';
import { PlaneGear } from './PlaneGear';
import { TempAirfield, airfieldFromCity, shiftAirfield, type AirfieldInfo } from './airfield';

/**
 * Flyable planes (SPEC-PART2 §4–§9, §11 flow; SPEC-PART3 §2/§6 geography, weather, night lights). Owner: flight.
 *
 *  - Parked planes: one per type on the airport stands (CityData.airport, or a temporary test airfield until the
 *    world ships one). Static fixed-body colliders + LOD; they stay where the player leaves them.
 *  - Boarding/exit, the player plane (one Rapier dynamic body, compound collider, raycast gear), the flight model
 *    (FlightModel.ts), engines (spool, explosions, fire trails, spread, tear-off), out-of-map over the ocean,
 *    destruction commands (whole / middle / tail) via the breakup system, crash flow and PlaneState.
 *  - Floating origin: bodies, interpolators and scene roots shift automatically; cached stand/runway/parked poses are
 *    shifted in the 'originShift' handler.
 * Debug: `?plane=prop|bizjet|airliner|jumbo` spawns into that plane on the runway after autostart, `&air` at 500 m.
 */

export function emptyPlaneState(): PlaneState {
  return {
    type: null, phase: 'none',
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1),
    airspeed: 0, airspeedKmh: 0, groundSpeedKmh: 0, altitude: 0, altitudeAgl: 0, verticalSpeed: 0, heading: 0, pitch: 0, bank: 0, aoa: 0,
    throttle: 0, flaps: 0, gear: 1, onGround: true, brake: false, stall: false, stallWarning: false,
    rotationSpeedKmh: 0, stallSpeedKmh: 0, engines: [], assisted: true,
    outOfMap: { state: 'ok', countdown: 0, distance: 0, failed: 0, total: 0 },
    damage: { tailLost: false, split: false, drag: 0 },
    canExit: false,
  };
}

interface Parked {
  type: PlaneTypeId;
  visual: PlaneVisual;
  body: RAPIER_T.RigidBody | null;
  pos: THREE.Vector3; // ground point under the CoM
  yaw: number;
  occupied: boolean;
  lod: number;
  lights: number;
}

interface EngineRt {
  drag: { point: THREE.Vector3; cdA: number };
  info: PlaneEngineInfo;
  st: PlaneEngineState;
  propAngle: number;
  propSpeed: number;
  windmill: boolean;
  trail: TrailHandle | null;
  trailSize: number;
  spreadAt: number;
  spreadWill: boolean;
  spread: boolean;
  tearAt: number;
}

type SpawnWhere = 'parked' | 'stand' | 'runway' | 'air';

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const KMH = 3.6;

export class PlaneSystem implements IPlaneSystem {
  readonly name = 'planes';
  active = false;
  readonly state: PlaneState = emptyPlaneState();
  visual: PlaneVisual | null = null;
  cameraTarget: PlaneCameraTarget | null = null;
  boardCandidate: { type: PlaneTypeId; name: string } | null = null;
  crashed = false;
  crashTime = 0;
  inCockpitSequence = false;

  // world data
  private parked = new Map<PlaneTypeId, Parked>();
  private airfield: AirfieldInfo | null = null;
  private tempField: TempAirfield | null = null;
  private ray: RAPIER_T.Ray | null = null;

  // current flight
  private type: PlaneTypeId | null = null;
  private rec: Parked | null = null;
  private cfg: PlaneCfg | null = null;
  private body: RAPIER_T.RigidBody | null = null;
  private gear: PlaneGear | null = null;
  private model: FlightModel | null = null;
  private interp = new BodyInterpolator();
  private inputs: FlightInputs = defaultInputs();
  private engines: EngineRt[] = [];
  private tracked: TrackedPlane | null = null;
  private colliderByPart = new Map<string, RAPIER_T.Collider>();
  private lostParts = new Set<string>();
  private throttle = 0;
  private flaps = 0.5;
  private flapsTarget = 0.5;
  /** Test hook: force a flap setting (null = automatic schedule). */
  flapsOverride: number | null = null;
  private gearPos = 1;
  private gearTarget = 1;
  private gearCollapsed = false;
  private autoGearUpDone = false;
  private manualGearT = -99;
  private autoGearUpT = -99;
  private parking = true;
  private holdStillT = 0;
  private onGround = true;
  private agl = 0;
  private groundY = 0;
  private airborneT = 0;
  private maxAglAir = 0;
  private simTime = 0;
  private split = false;
  private tailLost = false;
  private tailT = 0;
  private tailExplodeAt = Infinity;
  private tailTrails: TrailHandle[] = [];
  private tailStage = 0;
  private damageDrag = 0;
  private assistPenalty = 0;
  private sideDrag: { point: THREE.Vector3; cdA: number }[] = [];
  private dragList: { point: THREE.Vector3; cdA: number }[] = [];
  private cockpitPiece: WreckPiece | null = null;
  private cockpitEyePart = new THREE.Vector3();
  private cockpitPartName = 'cockpit';
  private cockpitCutT = -1;
  private cockpitRideT = 0;
  private cockpitPrevSpeed = 0;
  private lastPieces: WreckPiece[] = [];
  private submergedT = 0;
  private stallWarnOn = false;
  private oom = { state: 'ok' as 'ok' | 'warning' | 'failing', countdown: 0, distance: 0, failT: 0, nextT: 0, failed: 0, lastEngineT: -1, aglAtLast: 0, liftScale: 1, checkT: 0 };
  private turbT = 0;
  private busy = false;
  private pending: { type: PlaneTypeId; air: boolean } | null = null;
  private instT = 0;
  private lightsKey = -1;
  private lodLevel = -1;
  private readonly target: PlaneCameraTarget = { object: new THREE.Object3D(), kind: 'plane', size: 10, velocity: new THREE.Vector3() };
  private readonly propAngles: number[] = [];
  private readonly instEngines: PlaneEngineStatus[] = [];

  constructor(private ctx: GameContext) {}

  // ─────────────────────────────── lifecycle ───────────────────────────────
  init(): void {
    const { ctx } = this;
    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.setupAirfield();
    for (const type of PLANE_TYPES) {
      try {
        const visual = ctx.planeModels.create(type);
        ctx.engine.scene.add(visual.root);
        const st = this.standFor(type);
        const rec: Parked = { type, visual, body: null, pos: st.p.clone(), yaw: st.yaw, occupied: false, lod: -1, lights: -1 };
        this.parked.set(type, rec);
        this.placeParked(rec);
      } catch (err) {
        reportError(`[planes] could not create ${type}`, err);
      }
    }
    ctx.events.on('originShift', ({ delta }) => this.onOriginShift(delta.x, delta.z));
    const params = new URLSearchParams(location.search);
    const p = params.get('plane') as PlaneTypeId | null;
    if (p && (PLANE_TYPES as readonly string[]).includes(p)) this.pending = { type: p, air: params.has('air') };
  }

  dispose(): void {
    this.teardownFlight();
    for (const rec of this.parked.values()) {
      this.ctx.physics.removeBody(rec.body);
      this.ctx.engine.scene.remove(rec.visual.root);
      rec.visual.dispose();
    }
    this.parked.clear();
    this.tempField?.dispose();
    this.tempField = null;
  }

  private setupAirfield(): void {
    const ap = this.ctx.world.data?.airport;
    if (ap && ap.stands?.length) {
      this.tempField?.dispose();
      this.tempField = null;
      this.airfield = airfieldFromCity(ap);
    } else if (!this.tempField) {
      this.tempField = new TempAirfield(this.ctx);
      this.airfield = this.tempField.info;
    }
  }

  private standFor(type: PlaneTypeId): { p: THREE.Vector3; yaw: number } {
    const s = this.airfield?.stands.find((x) => x.type === type) ?? this.airfield?.stands[PLANE_TYPES.indexOf(type)];
    if (s) return s;
    return { p: new THREE.Vector3(PLANE_TYPES.indexOf(type) * 80, 0, -600), yaw: Math.PI };
  }

  private onOriginShift(dx: number, dz: number): void {
    if (this.airfield) shiftAirfield(this.airfield, dx, dz);
    for (const rec of this.parked.values()) {
      rec.pos.x -= dx;
      rec.pos.z -= dz;
    }
  }

  // ─────────────────────────────── helpers ───────────────────────────────
  /**
   * Ground (or water surface) height below (x, z), searching down from `fromY`. Rapier only sees colliders after a
   * physics step, so callers that know the expected height (stands, runway) pass it as `fallback`.
   */
  private groundAt(x: number, z: number, fromY: number, fallback = -Infinity): number {
    const { physics, world, terrain } = this.ctx;
    let gy = -Infinity;
    const ray = this.ray;
    if (ray) {
      ray.origin.x = x;
      ray.origin.y = fromY;
      ray.origin.z = z;
      ray.dir.x = 0;
      ray.dir.y = -1;
      ray.dir.z = 0;
      const hit = physics.world.castRay(ray, 600, true, undefined, groups(G.ALL, G.WORLD));
      if (hit) gy = fromY - hit.timeOfImpact;
    }
    if (gy === -Infinity) {
      try {
        gy = world.groundHeightAt(x, z);
      } catch {
        gy = 0;
      }
      gy = Math.max(gy, fallback);
    }
    try {
      const w = terrain?.waterAt?.(x, z);
      if (w !== null && w !== undefined) gy = Math.max(gy, w);
    } catch {
      /* terrain not ready */
    }
    return gy;
  }

  private offshore(x: number, z: number): number {
    const { world, terrain } = this.ctx;
    try {
      return world.oceanDistance?.(x, z) ?? terrain.oceanDistance(x, z);
    } catch {
      return 0;
    }
  }

  private fadeThen(cb: () => void): void {
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      try {
        cb();
      } catch (err) {
        reportError('[planes] transition failed', err);
      } finally {
        this.busy = false;
      }
    };
    this.busy = true;
    try {
      this.ctx.ui.fade(run);
    } catch {
      run();
    }
    window.setTimeout(run, 1500);
  }

  private createColliders(body: RAPIER_T.RigidBody, visual: PlaneVisual, dynamic: boolean, type: PlaneTypeId): void {
    const { physics } = this.ctx;
    const mass = planeCfg(type).mass;
    for (const part of visual.parts) {
      if (dynamic && part.kind === 'gear') continue; // raycast wheels do the gear
      const h = part.halfExtents;
      if (!(h.x > 0.01 && h.y > 0.01 && h.z > 0.01)) continue;
      let desc = RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setTranslation(part.boxCenter.x, part.boxCenter.y, part.boxCenter.z)
        .setDensity(0)
        .setFriction(0.5)
        .setRestitution(0.05);
      if (dynamic) {
        desc = desc
          .setCollisionGroups(groups(G.PLANE, G.WORLD | G.PROP | G.PARKED | G.PLAYER | G.DEBRIS | G.PLANE))
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(mass * CONFIG.planes.contactForceFactor);
      } else {
        desc = desc.setCollisionGroups(groups(G.PARKED, G.ALL));
      }
      const col = physics.world.createCollider(desc, body);
      if (dynamic) {
        physics.tag(col, { kind: 'plane', material: 'metal', data: { part: part.name } });
        this.colliderByPart.set(part.name, col);
      } else {
        physics.tag(col, { kind: 'staticProp', material: 'metal', data: { parkedPlane: type, part: part.name } });
      }
    }
  }

  /** Put a parked plane at rec.pos/yaw on the ground with a fixed collider. */
  private placeParked(rec: Parked): void {
    const { physics } = this.ctx;
    physics.removeBody(rec.body);
    rec.body = null;
    const cfg = planeCfg(rec.type);
    const gy = this.groundAt(rec.pos.x, rec.pos.z, rec.pos.y + 60, rec.pos.y);
    rec.pos.y = gy;
    const y = gy + PlaneGear.restHeight(rec.visual, cfg);
    const root = rec.visual.root;
    root.position.set(rec.pos.x, y, rec.pos.z);
    root.quaternion.setFromAxisAngle(UP, rec.yaw);
    rec.visual.setControls({ aileron: 0, elevator: 0, rudder: 0, flaps: 0, gear: 1, propAngle: rec.visual.engines.map(() => 0) });
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(root.position.x, root.position.y, root.position.z).setRotation(root.quaternion),
    );
    this.createColliders(body, rec.visual, false, rec.type);
    rec.body = body;
    rec.lights = -1;
  }

  // ─────────────────────────────── flight start / end ───────────────────────────────
  private startFlight(type: PlaneTypeId, where: SpawnWhere): void {
    const { ctx } = this;
    const rec = this.parked.get(type);
    if (!rec) return;
    this.teardownFlight();
    ctx.physics.removeBody(rec.body);
    rec.body = null;
    rec.occupied = true;
    const visual = rec.visual;
    visual.repair();
    if (!visual.root.parent) ctx.engine.scene.add(visual.root);
    const cfg = planeCfg(type);
    const model = new FlightModel(type, visual);
    this.type = type;
    this.rec = rec;
    this.cfg = cfg;
    this.visual = visual;
    this.model = model;

    // Pose.
    const pos = new THREE.Vector3();
    let yaw = rec.yaw;
    const vel = new THREE.Vector3();
    let air = false;
    const rest = PlaneGear.restHeight(visual, cfg);
    if (where === 'runway' || where === 'air') {
      const rw = this.takeoffRunway();
      if (where === 'runway' && rw) {
        pos.copy(rw.start).addScaledVector(rw.dir, visual.dims.length * 0.5 + 25);
        yaw = Math.atan2(rw.dir.x, rw.dir.z);
        pos.y = this.groundAt(pos.x, pos.z, rw.start.y + 60, rw.start.y) + rest;
      } else {
        air = true;
        const dir = rw ? rw.dir : new THREE.Vector3(-1, 0, 0);
        const from = rw ? rw.start : new THREE.Vector3(-1100, 0, -300);
        pos.copy(from).addScaledVector(dir, -9000);
        yaw = Math.atan2(dir.x, dir.z);
        pos.y = Math.max(0, this.groundAt(pos.x, pos.z, 1500)) + 500;
        vel.set(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(cfg.cruiseKmh / KMH);
      }
    } else {
      const p = where === 'stand' ? this.standFor(type).p : rec.pos;
      if (where === 'stand') yaw = this.standFor(type).yaw;
      pos.set(p.x, 0, p.z);
      pos.y = this.groundAt(pos.x, pos.z, p.y + 60, p.y) + rest + 0.03;
    }
    _q.setFromAxisAngle(UP, yaw);

    // Body.
    const gScale = CONFIG.planes.gravity / Math.abs(CONFIG.physics.gravity || -9.81);
    const I = model.inertia;
    const body = ctx.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation(_q)
        .setLinvel(vel.x, vel.y, vel.z)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setGravityScale(gScale)
        .setLinearDamping(0)
        .setAngularDamping(0)
        .setAdditionalMassProperties(cfg.mass, { x: 0, y: 0, z: 0 }, { x: I.x, y: I.y, z: I.z }, { x: 0, y: 0, z: 0, w: 1 }),
    );
    this.colliderByPart.clear();
    this.lostParts.clear();
    this.createColliders(body, visual, true, type);
    this.body = body;
    this.gear = new PlaneGear(ctx.physics, body, visual, cfg, cfg.mass);
    this.interp.reset(body);
    visual.root.position.set(pos.x, pos.y, pos.z);
    visual.root.quaternion.copy(_q);

    // Engines.
    this.engines = visual.engines.map((info) => ({
      drag: { point: info.thrustPoint.clone(), cdA: 0.3 * Math.PI * Math.max(0.3, info.radius) ** 2 },
      info, st: { status: 'ok', spool: 0, thrust: 0, fire: 0 }, propAngle: 0, propSpeed: 0, windmill: false, trail: null, trailSize: 1,
      spreadAt: Infinity, spreadWill: false, spread: false, tearAt: Infinity,
    }));
    this.state.engines = this.engines.map((e) => e.st);
    this.propAngles.length = this.engines.length;
    this.instEngines.length = this.engines.length;

    // Flight state.
    this.inputs = defaultInputs();
    this.throttle = 0;
    this.flaps = this.flapsTarget = air ? 0 : 0.5;
    this.gearPos = this.gearTarget = air && cfg.retractable ? 0 : 1;
    this.gearCollapsed = false;
    this.autoGearUpDone = air;
    this.manualGearT = -99;
    this.parking = !air && where !== 'runway';
    this.holdStillT = 0;
    this.onGround = !air;
    this.airborneT = air ? 5 : 0;
    this.maxAglAir = air ? 500 : 0;
    this.split = false;
    this.tailLost = false;
    this.tailT = 0;
    this.tailExplodeAt = Infinity;
    this.tailStage = 0;
    this.damageDrag = 0;
    this.assistPenalty = 0;
    this.sideDrag = [];
    this.cockpitPiece = null;
    this.cockpitCutT = -1;
    this.lastPieces = [];
    this.submergedT = 0;
    this.crashed = false;
    this.crashTime = 0;
    this.inCockpitSequence = false;
    this.oom = { state: 'ok', countdown: 0, distance: 0, failT: 0, nextT: 0, failed: 0, lastEngineT: -1, aglAtLast: 0, liftScale: 1, checkT: 0 };
    this.lightsKey = -1;
    this.lodLevel = -1;
    if (air) {
      // Cruise power: enough thrust for level flight at the spawn speed.
      const thr = this.levelThrottle(cfg.cruiseKmh / KMH);
      this.throttle = thr;
      for (const e of this.engines) e.st.spool = thr;
    }
    this.prepareCockpitEye(visual);

    // Breakup tracking.
    this.tracked = this.makeTracked(type, visual, body);
    try {
      ctx.breakup.track(this.tracked);
    } catch (err) {
      reportError('[planes] breakup.track failed', err);
    }
    this.active = true;
    if (ctx.game.mode !== 'plane') ctx.game.setMode('plane');
    this.updateCameraTarget();
    try {
      ctx.cameraRig.snap();
    } catch {
      /* camera not ready */
    }
    ctx.events.emit('planeSpawned', { type, inAir: air });
  }

  private levelThrottle(v: number): number {
    const m = this.model;
    const cfg = this.cfg;
    if (!m || !cfg) return 0.6;
    const q = 0.5 * m.rho * v * v;
    const cl = (cfg.mass * CONFIG.planes.gravity) / (q * m.S);
    const mach = v / m.vTop - 0.75;
    const cd = cfg.cd0 + m.k * cl * cl + (mach > 0 ? cfg.waveDrag * mach * mach : 0) + 0.004;
    const D = q * m.S * cd;
    const n = Math.max(1, this.engines.length);
    const T = cfg.thrust * n * this.lapse(v) * 0.98;
    return clamp((D / Math.max(1, T) - cfg.idle) / (1 - cfg.idle), 0.15, 1);
  }

  private takeoffRunway(): { start: THREE.Vector3; dir: THREE.Vector3 } | null {
    const rw = this.airfield?.runways[0];
    if (!rw) return null;
    const dir = _v.copy(rw.b).sub(rw.a).setY(0).normalize().clone();
    const beyondA = this.offshore(rw.a.x - dir.x * 4000, rw.a.z - dir.z * 4000);
    const beyondB = this.offshore(rw.b.x + dir.x * 4000, rw.b.z + dir.z * 4000);
    // Take off toward the sea: start at the end farther from the ocean.
    if (beyondB >= beyondA) return { start: rw.a.clone(), dir };
    return { start: rw.b.clone(), dir: dir.negate() };
  }

  private prepareCockpitEye(visual: PlaneVisual): void {
    const part = visual.partByName.cockpit ?? visual.partByName.nose ?? visual.parts[0];
    this.cockpitPartName = part?.name ?? 'cockpit';
    if (!part) return;
    _m.compose(part.object.position, part.object.quaternion, part.object.scale).invert();
    this.cockpitEyePart.copy(visual.cockpitEye).applyMatrix4(_m);
  }

  private makeTracked(type: PlaneTypeId, visual: PlaneVisual, body: RAPIER_T.RigidBody): TrackedPlane {
    const self = this;
    const t: TrackedPlane = {
      type,
      visual,
      body,
      brokenJoints: new Set<string>(),
      isGearDown: () => self.gearPos >= 0.98 && !self.gearCollapsed && !!self.gear && self.gear.wheels.some((w) => w.alive),
      onGearCollapse: () => self.onGearCollapse(t),
      onPartsLost: (parts) => self.onPartsLost(t, parts),
      onSplit: (pieces, cockpit) => self.onSplit(t, pieces, cockpit),
      onCrash: (outcome, info) => self.onCrash(t, outcome, info),
    };
    return t;
  }

  /** Remove the player plane's body/gear/trails and tracking (does NOT re-park it). */
  private teardownFlight(): void {
    const { ctx } = this;
    for (const e of this.engines) e.trail?.stop();
    for (const tr of this.tailTrails) tr.stop();
    this.tailTrails = [];
    this.engines = [];
    if (this.tracked) {
      try {
        ctx.breakup.untrack(this.tracked);
      } catch (err) {
        reportError('[planes] breakup.untrack failed', err);
      }
    }
    if (this.visual) {
      this.visual.repair();
      if (!this.visual.root.parent) ctx.engine.scene.add(this.visual.root);
    }
    if (this.tracked) {
      try {
        ctx.breakup.clear();
      } catch (err) {
        reportError('[planes] breakup.clear failed', err);
      }
    }
    this.tracked = null;
    this.gear?.dispose();
    this.gear = null;
    if (this.body) ctx.physics.removeBody(this.body);
    this.body = null;
    this.colliderByPart.clear();
    this.model = null;
    this.cockpitPiece = null;
    this.lastPieces = [];
    if (this.stallWarnOn) {
      this.stallWarnOn = false;
      ctx.events.emit('stallWarning', { on: false });
    }
    if (this.oom.state !== 'ok') ctx.events.emit('outOfMap', { state: 'ok', countdown: 0 });
    this.oom.state = 'ok';
  }

  /** Current plane goes back to its stand (repaired, parked) — the flight is over. */
  private endFlightToStand(): void {
    const rec = this.rec;
    this.teardownFlight();
    if (rec) {
      const st = this.standFor(rec.type);
      rec.pos.copy(st.p);
      rec.yaw = st.yaw;
      rec.occupied = false;
      this.placeParked(rec);
    }
    this.clearFlightRefs();
  }

  private clearFlightRefs(): void {
    this.active = false;
    this.type = null;
    this.rec = null;
    this.cfg = null;
    this.visual = null;
    this.cameraTarget = null;
    this.crashed = false;
    this.crashTime = 0;
    this.inCockpitSequence = false;
    this.split = false;
    Object.assign(this.state, emptyPlaneState());
  }

  // ─────────────────────────────── public API ───────────────────────────────
  board(): boolean {
    const c = this.boardCandidate;
    if (!c || this.busy || this.ctx.game.mode !== 'car' || this.ctx.game.state !== 'driving') return false;
    this.boardCandidate = null;
    this.fadeThen(() => this.startFlight(c.type, 'parked'));
    return true;
  }

  exit(): boolean {
    const { ctx } = this;
    if (!this.active || !this.state.canExit || this.busy || !this.body || !this.rec || !this.visual) return false;
    const car = ctx.vehicle;
    const bt = this.body.translation();
    const far = car.active && Math.hypot(car.state.position.x - bt.x, car.state.position.z - bt.z) > CONFIG.planes.carTeleportDist;
    const doExit = () => {
      if (!this.body || !this.rec || !this.visual) return;
      const t = this.body.translation();
      const fwd = _v.set(0, 0, 1).applyQuaternion(this.visual.root.quaternion);
      const yaw = Math.atan2(fwd.x, fwd.z);
      const rec = this.rec;
      const visual = this.visual;
      // Car pose: beside the boarding point, a few metres out from the fuselage.
      const bp = visual.boardPoint;
      const side = bp.x >= 0 ? 1 : -1;
      const local = _v2.set(bp.x + side * 6, 0, bp.z);
      local.applyAxisAngle(UP, yaw);
      const cx = t.x + local.x;
      const cz = t.z + local.z;
      this.teardownFlight();
      rec.pos.set(t.x, t.y - PlaneGear.restHeight(visual, planeCfg(rec.type)), t.z);
      rec.yaw = yaw;
      rec.occupied = false;
      this.placeParked(rec);
      this.clearFlightRefs();
      if (far && car.active) {
        const cy = this.groundAt(cx, cz, t.y + 30);
        car.reset({ position: { x: cx, y: cy, z: cz }, yaw });
      }
      ctx.game.setMode('car');
      try {
        ctx.cameraRig.setMode('chase');
        ctx.cameraRig.snap();
      } catch {
        /* camera */
      }
    };
    if (far) this.fadeThen(doExit);
    else doExit();
    return true;
  }

  respawnPlane(): void {
    const type = this.type;
    if (!this.active || !type || this.busy) return;
    this.fadeThen(() => {
      this.ctx.fx.clearAll();
      this.startFlight(type, 'stand');
    });
  }

  retryInAir(): void {
    const type = this.type;
    if (!this.active || !type || this.busy) return;
    this.fadeThen(() => {
      this.ctx.fx.clearAll();
      this.startFlight(type, 'air');
    });
  }

  backToCar(): void {
    const { ctx } = this;
    if (this.active) this.endFlightToStand();
    if (ctx.game.mode === 'plane') ctx.game.setMode('car');
    try {
      ctx.cameraRig.setMode('chase');
      ctx.cameraRig.snap();
    } catch {
      /* camera */
    }
  }

  explodeEngine(index: number, failure = false): void {
    const { ctx } = this;
    const body = this.body;
    const visual = this.visual;
    if (!this.active || !body || !visual || this.split || (this.crashed && !failure)) return;
    const e = this.engines[index - 1];
    if (!e || e.st.status !== 'ok') return;
    e.st.status = 'fire';
    e.st.spool = 0;
    e.st.thrust = 0;
    e.st.fire = 0.6;
    visual.setEngineDamaged(index, true);
    const pos = this.worldPoint(e.info.thrustPoint, new THREE.Vector3());
    const pv = body.velocityAtPoint(pos);
    const vel = new THREE.Vector3(pv.x, pv.y, pv.z);
    const r = Math.max(0.4, e.info.radius);
    const blastR = Math.max(2.5, r * 3.2);
    ctx.fx.explosionEx?.({ position: pos, velocity: vel, radius: blastR, kind: 'engine' });
    ctx.fx.debrisBurst?.({ position: pos, velocity: vel, count: 6 + Math.floor(Math.random() * 7), size: r * 0.5, kind: 'metal' });
    const out = _v2.set(Math.sign(e.info.thrustPoint.x) || 1, 0.4, 0).applyQuaternion(visual.root.quaternion).normalize();
    ctx.fx.sparks(pos, out, 1.2);
    const part = visual.partByName[e.info.part];
    if (part && ctx.fx.attachTrail) {
      _m.compose(part.object.position, part.object.quaternion, part.object.scale).invert();
      const off = e.info.exhaustPoint.clone().applyMatrix4(_m);
      e.trailSize = r * 1.6;
      e.trail = ctx.fx.attachTrail(part.object, off, { fire: 0.8, smoke: 1, size: e.trailSize });
    }
    // The blast and the suddenly dead, windmilling nacelle yaw the nose toward the dead side.
    const side = Math.sign(e.info.thrustPoint.x);
    if (side !== 0 && this.model) {
      const I = this.model.inertia;
      const up = _v.set(0, 1, 0).applyQuaternion(visual.root.quaternion);
      const fwd = _v2.set(0, 0, 1).applyQuaternion(visual.root.quaternion);
      const ky = I.y * 0.05 * side;
      const kr = -I.z * 0.03 * side;
      body.applyTorqueImpulse({ x: up.x * ky + fwd.x * kr, y: up.y * ky + fwd.y * kr, z: up.z * ky + fwd.z * kr }, true);
    }
    e.windmill = e.info.propeller ? Math.random() < 0.5 : true;
    e.spreadAt = this.simTime + 6 + Math.random() * 6;
    e.spreadWill = Math.random() < 0.3;
    if ((this.type === 'jumbo' || this.type === 'bizjet') && Math.random() < 0.15) e.tearAt = this.simTime + 0.3 + Math.random() * 0.9;
    this.assistPenalty += 0.12;
    ctx.events.emit('engineExplode', { type: this.type!, engine: index, position: pos, velocity: vel, radius: blastR });
    if (!failure) ctx.events.emit('masterCaution', { text: `ENGINE ${index} FIRE`, level: 'warning' });
    ctx.events.emit('vibrate', { pattern: [40, 30, 90] });
    try {
      ctx.cameraRig.shake(0.35, 0.6);
    } catch {
      /* camera */
    }
  }

  explode(): void {
    const { ctx } = this;
    if (!this.active || !this.tracked || this.split) return;
    const body = this.body;
    const visual = this.visual;
    this.inCockpitSequence = false;
    const pos = new THREE.Vector3();
    const vel = new THREE.Vector3();
    if (body) {
      const t = body.translation();
      const v = body.linvel();
      pos.set(t.x, t.y, t.z);
      vel.set(v.x, v.y, v.z);
    }
    try {
      ctx.breakup.explodeTotal(this.tracked);
    } catch (err) {
      reportError('[planes] explodeTotal failed', err);
    }
    ctx.game.slowMo(0.3, 1.5);
    // Fallback when the breakup module did not split the plane (stub): fireball + charred, still crashed.
    if (this.tracked && this.tracked.body && ctx.breakup.pieces.length === 0 && body && visual) {
      ctx.fx.explosionEx?.({ position: pos, velocity: vel, radius: this.cfg?.explosionRadius ?? 20, kind: 'plane' });
      if (!ctx.fx.explosionEx) ctx.fx.explosion(pos, (this.cfg?.explosionRadius ?? 20) / 6);
      visual.setCharred('*', 1);
      for (const e of this.engines) if (e.st.status === 'ok') e.st.status = 'destroyed';
    }
    this.markCrashed();
  }

  explodeMiddle(): void {
    const { ctx } = this;
    const visual = this.visual;
    const body = this.body;
    if (!this.active || !this.tracked || !visual || !body || this.split || this.crashed) return;
    const ids = visual.breakModes.middle;
    const j = visual.joints.find((x) => x.id === ids[0]);
    const center = this.worldPoint(j ? j.position : ZERO, new THREE.Vector3());
    const v = body.linvel();
    const vel = new THREE.Vector3(v.x, v.y, v.z);
    const r = Math.max(2, visual.dims.height * 0.35);
    this.inCockpitSequence = true;
    let pieces: WreckPiece[] = [];
    try {
      pieces = ctx.breakup.breakJoints(this.tracked, ids, { center, energy: this.blastEnergy(0.35), kind: 'middle' });
    } catch (err) {
      reportError('[planes] breakJoints(middle) failed', err);
    }
    if (!pieces.length) {
      // The breakup module does the ring blast, mist and debris; this is only the fallback.
      ctx.fx.explosionEx?.({ position: center, velocity: vel, radius: r * 2.2, kind: 'plane' });
      ctx.fx.mist?.(center, vel, r * 2);
      ctx.fx.debrisBurst?.({ position: center, velocity: vel, count: 14, size: r * 0.25, kind: 'panel' });
      ctx.fx.debrisBurst?.({ position: center, velocity: vel, count: 18, size: r * 0.15, kind: 'paper' });
      ctx.events.emit('planeExplosion', { position: center, velocity: vel, radius: r * 2.2, kind: 'middle' });
    }
    if (!this.split) {
      // No split happened (breakup stub): nothing to ride in.
      this.inCockpitSequence = false;
    }
    ctx.game.slowMo(0.45, 1.2);
  }

  explodeTail(): void {
    const { ctx } = this;
    const visual = this.visual;
    const body = this.body;
    if (!this.active || !this.tracked || !visual || !body || this.split || this.crashed || this.tailLost) return;
    const bm = visual.breakModes;
    const ids = [...bm.tailRequired, ...bm.tailOptional.filter(() => Math.random() < 0.5)];
    const tailPart = visual.partByName.tailCone ?? visual.partByName.fuselageRear;
    const center = this.worldPoint(tailPart ? tailPart.com : new THREE.Vector3(0, 0, -visual.dims.length * 0.4), new THREE.Vector3());
    const v = body.linvel();
    const vel = new THREE.Vector3(v.x, v.y, v.z);
    const r = Math.max(2, visual.dims.height * 0.3);
    // Flight-model side: the tail surfaces are gone whatever the breakup does with the meshes.
    const lost = new Set<string>(['fin']);
    for (const id of ids) {
      const jj = visual.joints.find((x) => x.id === id);
      if (jj) lost.add(jj.b);
    }
    for (const jj of visual.joints) if (jj.a === 'fin' && jj.b.startsWith('tailplane')) lost.add(jj.b); // T-tail goes with the fin
    let pieces: WreckPiece[] = [];
    try {
      pieces = ctx.breakup.breakJoints(this.tracked, ids, { center, energy: this.blastEnergy(0.25), kind: 'tail' });
    } catch (err) {
      reportError('[planes] breakJoints(tail) failed', err);
    }
    if (!pieces.length) {
      ctx.fx.explosionEx?.({ position: center, velocity: vel, radius: r * 2, kind: 'plane' });
      ctx.fx.debrisBurst?.({ position: center, velocity: vel, count: 12, size: r * 0.25, kind: 'metal' });
      ctx.events.emit('planeExplosion', { position: center, velocity: vel, radius: r * 2, kind: 'tail' });
    }
    if (!this.split) {
      this.model?.loseParts(lost);
      this.setTailLost();
      if (!pieces.length && tailPart && ctx.fx.attachTrail) {
        const target = (visual.partByName.fuselageRear ?? tailPart).object;
        this.tailTrails.push(ctx.fx.attachTrail(target, new THREE.Vector3(0, 0, 0), { fire: 1, smoke: 1, size: r * 0.9 }));
      }
      this.tailExplodeAt = 25 + Math.random() * 15;
    }
    ctx.game.slowMo(0.5, 1.0);
    ctx.events.emit('masterCaution', { text: 'FIRE — TAIL', level: 'warning' });
  }

  skipSequence(): void {
    if (!this.inCockpitSequence) return;
    this.inCockpitSequence = false;
    this.cockpitCutT = -1;
    this.markCrashed();
    this.updateCameraTarget();
  }

  // ─────────────────────────────── breakup callbacks ───────────────────────────────
  private onGearCollapse(t: TrackedPlane): void {
    if (t !== this.tracked) return;
    this.gearCollapsed = true;
  }

  private onPartsLost(t: TrackedPlane, parts: string[]): void {
    if (t !== this.tracked || !this.visual) return;
    const { physics } = this.ctx;
    const fresh = parts.filter((p) => !this.lostParts.has(p));
    if (!fresh.length) return;
    for (const p of fresh) {
      this.lostParts.add(p);
      const col = this.colliderByPart.get(p);
      if (col) {
        physics.removeCollider(col);
        this.colliderByPart.delete(p);
      }
      const ei = this.engines.findIndex((e) => e.info.part === p);
      if (ei >= 0) {
        const e = this.engines[ei];
        if (e.st.status === 'ok') this.visual.setEngineDamaged(ei + 1, true);
        e.st.status = 'detached';
        e.st.thrust = 0;
        e.st.spool = 0;
      }
      this.gear?.setWheelAlive(p, false);
    }
    this.model?.loseParts(fresh);
    if (fresh.some((p) => p === 'fin' || p.startsWith('tailplane') || p === 'tailCone')) this.setTailLost();
    this.damageDrag += 0.004 * fresh.length;
    this.assistPenalty += 0.1 * fresh.length;
    this.syncMassFromBody();
  }

  private onSplit(t: TrackedPlane, pieces: WreckPiece[], cockpit: WreckPiece | null): void {
    if (t !== this.tracked) return;
    t.body = null;
    this.gear?.dispose();
    this.gear = null;
    this.body = null;
    this.split = true;
    this.lastPieces = pieces.slice();
    this.cockpitPiece = cockpit;
    this.cockpitRideT = 0;
    this.cockpitPrevSpeed = this.state.velocity.length();
    if (this.inCockpitSequence && cockpit) {
      // stay in the cockpit (explode middle)
    } else {
      this.inCockpitSequence = false;
      this.markCrashed();
    }
    if (this.stallWarnOn) {
      this.stallWarnOn = false;
      this.ctx.events.emit('stallWarning', { on: false });
    }
    this.updateCameraTarget();
  }

  private onCrash(t: TrackedPlane, outcome: CrashOutcome, info: ImpactInfo): void {
    if (t !== this.tracked || outcome === 'landing') return;
    if (this.inCockpitSequence) {
      // Only the cockpit section's own impact ends the ride; the rear half landing first doesn't.
      if (this.cockpitPiece && this.cockpitPiece.parts.includes(info.part)) this.cockpitImpact();
      return;
    }
    this.markCrashed();
  }

  /** Cockpit section hit: violent shake inside, then a cut to the outside shot (SPEC-PART2 §11). */
  private cockpitImpact(): void {
    if (this.cockpitCutT >= 0) return;
    this.cockpitCutT = 1.1;
    this.ctx.events.emit('vibrate', { pattern: [80, 40, 160] });
    try {
      this.ctx.cameraRig.shake(1, 1);
    } catch {
      /* camera */
    }
  }

  /** Watch the cockpit piece during the explode-middle ride: a sudden velocity loss = it hit something. */
  private watchCockpit(realDt: number): void {
    const pc = this.cockpitPiece;
    if (!pc) return;
    this.cockpitRideT += realDt;
    let speed = 0;
    let alive = false;
    try {
      if (this.ctx.physics.world.bodies.contains(pc.body.handle)) {
        const v = pc.body.linvel();
        speed = Math.hypot(v.x, v.y, v.z);
        alive = true;
      }
    } catch {
      alive = false;
    }
    const drop = this.cockpitPrevSpeed - speed;
    this.cockpitPrevSpeed = speed;
    if (!alive || drop > 10 || (this.cockpitRideT > 3 && speed < 3) || this.cockpitRideT > 75) this.cockpitImpact();
  }

  private markCrashed(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTime = 0;
    this.throttle = 0;
    this.ctx.game.slowMo(0.3, 1.5);
  }

  private setTailLost(): void {
    if (this.tailLost) return;
    this.tailLost = true;
    this.tailT = 0;
    if (this.tailExplodeAt === Infinity) this.tailExplodeAt = 25 + Math.random() * 15;
    this.state.damage.tailLost = true;
  }

  private blastEnergy(f: number): number {
    return (this.cfg?.fuelKg ?? 1000) * f;
  }

  /**
   * The breakup system owns the surviving body's mass properties (it sets them before calling onPartsLost);
   * read them back so the flight model's torques/CoM stay consistent.
   */
  private syncMassFromBody(): void {
    const body = this.body;
    const model = this.model;
    if (!body || !model) return;
    const m = body.mass();
    if (!(m > 0)) return;
    model.mass = m;
    const c = body.localCom();
    model.comOffset.set(c.x, c.y, c.z);
    // Principal inertia → diagonal in body axes (the principal frame may be rotated/permuted).
    const pi = body.principalInertia();
    const f = body.principalInertiaLocalFrame();
    _q.set(f.x, f.y, f.z, f.w);
    const ax = [_v.set(1, 0, 0).applyQuaternion(_q).clone(), _v.set(0, 1, 0).applyQuaternion(_q).clone(), _v.set(0, 0, 1).applyQuaternion(_q).clone()];
    const pv = [pi.x, pi.y, pi.z];
    const I = model.inertia;
    I.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      const a = ax[k];
      I.x += pv[k] * a.x * a.x;
      I.y += pv[k] * a.y * a.y;
      I.z += pv[k] * a.z * a.z;
    }
  }

  private worldPoint(local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const body = this.body;
    if (body) {
      const t = body.translation();
      const r = body.rotation();
      _q.set(r.x, r.y, r.z, r.w);
      return out.copy(local).applyQuaternion(_q).add(_v2.set(t.x, t.y, t.z));
    }
    if (this.visual) return this.visual.root.localToWorld(out.copy(local));
    return out.copy(local);
  }

  private lapse(v: number): number {
    const cfg = this.cfg!;
    if (cfg.propV0 > 0) return Math.max(0, 1 - v / cfg.propV0);
    return Math.max(0.1, 1 - (cfg.thrustLapse * v) / (cfg.topKmh / KMH));
  }

  // ─────────────────────────────── fixed step ───────────────────────────────
  fixedUpdate(dt: number): void {
    this.simTime += dt;
    const body = this.body;
    const model = this.model;
    const cfg = this.cfg;
    const gear = this.gear;
    const visual = this.visual;
    if (!body || !model || !cfg || !gear || !visual) return;
    const { ctx } = this;
    if (!ctx.physics.world.bodies.contains(body.handle)) {
      // The body was removed behind our back (breakup replaced it without onSplit): treat as split.
      if (this.tracked) this.onSplit(this.tracked, [], null);
      return;
    }
    const A = CONFIG.planes.assist;
    const t = body.translation();
    const lv = body.linvel();
    const vyPre = lv.y;
    const gs = Math.hypot(lv.x, lv.z);
    const inp = ctx.input.state;
    const controllable = !this.crashed && ctx.game.mode === 'plane' && ctx.game.state === 'driving';
    const assisted = ctx.settings.values.flightAssisted !== false;

    // Throttle.
    if (controllable) {
      if (inp.throttleSet >= 0) this.throttle = clamp(inp.throttleSet, 0, 1);
      else if (inp.throttleAxis !== 0) this.throttle = clamp(this.throttle + inp.throttleAxis * 0.55 * dt, 0, 1);
    } else if (this.crashed) this.throttle = 0;

    // Height above ground / water.
    this.groundY = this.groundAt(t.x, t.z, t.y + 2);
    const rest = PlaneGear.restHeight(visual, cfg);
    this.agl = Math.max(0, t.y - rest - this.groundY);

    // Engines.
    const V = model.airspeed;
    const ceil = 1 - 0.92 * smoothstep(CONFIG.planes.ceiling - 300, CONFIG.planes.ceiling + 500, t.y);
    const thrusts = this.inputs.thrust;
    thrusts.length = this.engines.length;
    for (let i = 0; i < this.engines.length; i++) {
      const e = this.engines[i];
      const ok = e.st.status === 'ok';
      const target = ok ? this.throttle : 0;
      const rate = (target > e.st.spool ? 1 : 1.5) / cfg.spoolS;
      e.st.spool = approach(e.st.spool, target, rate * dt);
      const T = ok ? cfg.thrust * (cfg.idle + (1 - cfg.idle) * e.st.spool) * this.lapse(V) * ceil : 0;
      e.st.thrust = T;
      thrusts[i] = T;
      const spinT = ok ? (e.info.propeller ? lerp(45, 260, e.st.spool) : lerp(20, 90, e.st.spool)) : e.windmill ? V * (e.info.propeller ? 0.9 : 0.4) : 0;
      e.propSpeed = damp(e.propSpeed, spinT, ok ? 2 : e.windmill ? 1 : 6, dt);
      e.propAngle = (e.propAngle + e.propSpeed * dt) % (Math.PI * 2);
      // fire spread / tear-off
      if (e.st.status === 'fire') {
        if (!e.spread && this.simTime >= e.spreadAt) {
          e.spreadAt = Infinity;
          if (e.spreadWill) {
            e.spread = true;
            e.st.fire = 1;
            const p = e.info.thrustPoint;
            this.sideDrag.push({ point: new THREE.Vector3(p.x * 0.7, p.y, p.z), cdA: 0.012 * model.S });
            this.assistPenalty += 0.15;
            this.ctx.events.emit('engineFireSpread', { engine: i + 1, position: this.worldPoint(p, new THREE.Vector3()) });
          }
        }
        if (this.simTime >= e.tearAt) {
          e.tearAt = Infinity;
          const mount = visual.breakModes.engineMount[i + 1];
          if (mount && this.tracked) {
            try {
              const c = this.worldPoint(e.info.thrustPoint, new THREE.Vector3());
              ctx.breakup.breakJoints(this.tracked, [mount], { center: c, energy: this.blastEnergy(0.02), kind: 'engine' });
            } catch (err) {
              reportError('[planes] engine tear-off failed', err);
            }
            if (!this.body) return;
          }
        }
      }
    }

    // Gear (G toggles; assisted auto retract/extend).
    if (cfg.retractable && controllable && assisted && !this.gearCollapsed) {
      if (!this.onGround && this.gearTarget === 1 && !this.autoGearUpDone && this.agl > A.autoGearUpAgl && vyPre > 0) {
        this.gearTarget = 0;
        this.autoGearUpDone = true;
        this.autoGearUpT = this.simTime;
      }
      if (!this.onGround && this.gearTarget === 0 && this.agl < A.autoGearDownAgl && vyPre < -1.5 && V < A.autoGearDownSpeed * model.vStall && this.simTime - this.manualGearT > 8 && this.simTime - this.autoGearUpT > 12) {
        this.gearTarget = 1;
      }
    }
    if (!cfg.retractable) this.gearTarget = 1;
    if (this.onGround && !this.gearCollapsed) this.gearTarget = 1;
    this.gearPos = approach(this.gearPos, this.gearTarget, dt / (this.type === 'jumbo' ? 7 : 5));

    // Flaps (automatic schedule by speed; the HUD shows them).
    const kmh = V * KMH;
    if (this.flapsOverride !== null) this.flapsTarget = this.flapsOverride;
    else if (this.onGround) this.flapsTarget = gs > 25 && this.throttle < 0.3 && this.airborneT === 0 && this.maxAglAir === 0 && this.flaps > 0.75 ? 1 : 0.5;
    else if (kmh > cfg.flapsUpKmh) this.flapsTarget = 0;
    else if (kmh < cfg.flapsLandKmh && (this.gearPos > 0.5 || !cfg.retractable) && this.airborneT > 10 && (vyPre < -1 || this.agl < 300)) this.flapsTarget = 1;
    else if (kmh < cfg.flapsUpKmh - 25 && this.flapsTarget === 0) this.flapsTarget = 0.5;
    this.flaps = approach(this.flaps, this.flapsTarget, 0.22 * dt);

    // Brakes.
    const brakeIn = controllable && inp.planeBrake ? 1 : 0;
    if (this.parking && (this.throttle > Math.max(0.12, cfg.idle + 0.05) || !controllable)) this.parking = this.crashed ? this.parking : false;
    if (this.onGround && gs < 0.3 && this.throttle < 0.03 && controllable) {
      this.holdStillT += dt;
      if (this.holdStillT > 2) this.parking = true;
    } else this.holdStillT = 0;

    // Nose-wheel steering: tiller below 60 km/h, pedal steering above; assisted heading hold.
    const gkmh = gs * KMH;
    let steer = 0;
    if (controllable) {
      const maxSteer = lerp(cfg.steerDeg, 4, smoothstep(10, 60, gkmh)) * DEG * (gkmh > 160 ? 0.5 : 1);
      const cmd = clamp(inp.roll + inp.yaw, -1, 1);
      steer = -cmd * maxSteer;
      if (assisted && gs > 3) steer += (A.groundSteerK * model.r) / Math.max(1, gs / 8);
      steer = clamp(steer, -cfg.steerDeg * DEG, cfg.steerDeg * DEG);
    }
    const grip = ctx.env.weather?.grip ?? 1;
    const gearActive = this.gearPos >= 0.98 && !this.gearCollapsed;
    gear.update(dt, gearActive, steer, brakeIn, this.parking, clamp(grip, 0.3, 1));
    const wasGround = this.onGround;
    this.onGround = gear.contacts > 0;

    // Touchdown classification (SPEC-PART2 §11).
    if (gear.contacts > 0) {
      if (!wasGround && this.airborneT > 0.5 && this.maxAglAir > 2.5 && !this.crashed) this.classifyTouchdown(vyPre, gs, t);
      this.airborneT = 0;
      this.maxAglAir = 0;
      this.autoGearUpDone = false;
    } else {
      this.airborneT += dt;
      this.maxAglAir = Math.max(this.maxAglAir, this.agl);
    }
    if (!this.body) return; // a crash call may have split the plane

    // Out of map (ocean side only).
    this.updateOutOfMap(dt, t);
    if (!this.body) return;

    // Weather: wind + storm turbulence.
    const wind = ctx.env.wind;
    if (wind) this.inputs.wind.copy(wind);
    else this.inputs.wind.set(0, 0, 0);
    const wx = ctx.env.weather;
    const storm = clamp((wx?.storm ?? 0) + (wx?.gust ?? 0) * CONFIG.planes.turbulence.gustToStorm, 0, 1);
    const tb = this.inputs.turb;
    tb.multiplyScalar(Math.exp(-dt / 0.3));
    this.inputs.turbVert *= Math.exp(-dt / 0.4);
    if (storm > 0.02 && !this.onGround) {
      this.turbT -= dt;
      if (this.turbT <= 0) {
        this.turbT = (0.25 + Math.random() * 0.9) / (0.4 + storm);
        const k = storm * cfg.turbulence * CONFIG.planes.turbulence.jolt * Math.min(1, V / Math.max(1, model.vStall));
        tb.x += (Math.random() - 0.5) * 2.4 * k;
        tb.z += (Math.random() - 0.5) * 3.2 * k;
        tb.y += (Math.random() - 0.5) * 1.0 * k;
        this.inputs.turbVert += (Math.random() - 0.5) * 2 * CONFIG.planes.turbulence.vertical * storm * cfg.turbulence * 2;
      }
    }

    // Failure-sequence forcing: after the last engine, the plane must reach the sea within ~40 s.
    let liftScale = 1 - 0.4 * smoothstep(CONFIG.planes.ceiling, CONFIG.planes.ceiling + 800, t.y);
    let noseDown = 0;
    let gammaCap = 99;
    let failCd = 0;
    if (this.oom.state === 'failing' && this.oom.lastEngineT >= 0) {
      const tau = this.simTime - this.oom.lastEngineT;
      const within = CONFIG.planes.outOfMap.crashWithin;
      // ~40 s after the last engine; from very high up the dive is capped at ~30 m/s sink instead
      const total = Math.max(within, this.oom.aglAtLast / 30 + 5);
      const remaining = Math.max(3, total - 5 - tau);
      const vsReq = -this.agl / remaining;
      const Vg = Math.max(20, V);
      const gReq = Math.asin(clamp(vsReq / Vg, -0.7, 0));
      gammaCap = Math.min(-(3 + 0.5 * tau) * DEG, gReq * 1.15);
      noseDown = 0.02 + 0.004 * tau;
      failCd = 0.008 + 0.0015 * tau;
      // backup: if the pilot fights it (holding altitude), the wing gives up progressively
      if (vyPre > vsReq + 4) this.oom.liftScale = Math.max(0.15, this.oom.liftScale - 0.12 * dt);
      else this.oom.liftScale = Math.min(1, this.oom.liftScale + 0.06 * dt);
      liftScale *= this.oom.liftScale;
    }

    // Tail lost: timer, fire spreading forward, final explosion if still airborne.
    if (this.tailLost) {
      this.tailT += dt;
      this.updateTailFire(visual);
      if (!this.onGround && !this.crashed && this.tailT >= this.tailExplodeAt) {
        this.explode();
        return;
      }
    }

    // Flight model.
    const fi = this.inputs;
    fi.pitch = controllable ? inp.pitch : 0;
    fi.roll = controllable ? inp.roll : 0;
    fi.yaw = controllable ? inp.yaw : 0;
    fi.assisted = assisted && !this.crashed;
    const failFade = this.oom.state === 'failing' && this.oom.lastEngineT >= 0 ? Math.max(0.4, 1 - (this.simTime - this.oom.lastEngineT) / 60) : 1;
    const ht = model.htailAlive;
    const fin = model.finAlive;
    fi.assistFactor = clamp(1 - this.assistPenalty, 0, 1) * failFade * (this.tailLost ? 0.35 * ht : 1);
    fi.onGround = this.onGround;
    fi.agl = Math.max(0, t.y - this.groundY + (model.surfaces[0]?.pos.y ?? 0));
    fi.wheelAgl = this.agl;
    fi.gear = cfg.retractable ? this.gearPos : 1;
    fi.gearDown = gearActive;
    fi.flaps = this.flaps;
    fi.liftScale = liftScale;
    fi.extraCd = this.damageDrag + failCd + (this.tailLost ? 0.004 + 0.0004 * this.tailT : 0);
    // asymmetric drag: fire spread + dead (windmilling / torn-open) nacelles still on the wing
    const dl = this.dragList;
    dl.length = 0;
    for (const sd of this.sideDrag) dl.push(sd);
    for (const e of this.engines) if (e.st.status === 'fire' || e.st.status === 'destroyed') dl.push(e.drag);
    fi.sideDrag = dl;
    fi.noseDown = noseDown;
    fi.gammaCap = gammaCap;
    fi.tailLost = this.tailLost;
    fi.tailTime = this.tailT;
    fi.controlScale.set(0.3 + 0.7 * ht, fin, this.tailLost ? 0.6 + 0.3 * ht : 1);
    fi.rotationHelp = true;
    model.step(dt, body, fi);

    // Fallbacks when nobody else classified the crash: under water, or falling out of the world.
    const water = this.waterAt(t.x, t.z);
    if (water !== null && t.y < water - 1.2) {
      this.submergedT += dt;
      if (this.submergedT > 0.25 && !this.crashed && this.tracked) {
        const info = this.impactInfo(body, 'water', 'fuselageCenter');
        try {
          ctx.breakup.crash(this.tracked, 'waterCrash', info);
        } catch (err) {
          reportError('[planes] breakup.crash(water) failed', err);
        }
        this.markCrashed();
      }
      // Last-resort water drag so a body nobody handles doesn't sink forever.
      if (this.body && t.y < water - 15) {
        const v = this.body.linvel();
        this.body.setLinvel({ x: v.x * 0.9, y: Math.max(v.y * 0.85, -0.5), z: v.z * 0.9 }, true);
        this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    } else this.submergedT = 0;
    if (this.body && t.y < CONFIG.world.killY - 200) this.markCrashed();
  }

  private waterAt(x: number, z: number): number | null {
    try {
      return this.ctx.terrain?.waterAt?.(x, z) ?? null;
    } catch {
      return null;
    }
  }

  private impactInfo(body: RAPIER_T.RigidBody, surface: ImpactSurface, part: string, at?: THREE.Vector3): ImpactInfo {
    const t = body.translation();
    const v = body.linvel();
    const vel = new THREE.Vector3(v.x, v.y, v.z);
    const h = Math.hypot(v.x, v.z);
    return {
      position: at ? at.clone() : new THREE.Vector3(t.x, t.y, t.z),
      velocity: vel,
      normalSpeed: Math.max(0, -v.y),
      tangentSpeed: h,
      angleDeg: Math.atan2(-v.y, Math.max(0.01, h)) / DEG,
      part,
      energy: 0.5 * (this.model?.mass ?? 1) * vel.lengthSq(),
      surface,
    };
  }

  private classifyTouchdown(vyPre: number, gs: number, t: { x: number; y: number; z: number }): void {
    const { ctx } = this;
    const body = this.body;
    const model = this.model;
    const gear = this.gear;
    if (!body || !model || !gear || !this.tracked) return;
    const L = CONFIG.planes.landing;
    const vs = Math.max(0, -vyPre);
    const bank = Math.abs(model.bank) / DEG;
    const tag = gear.groundHandle >= 0 ? ctx.physics.tagOf(gear.groundHandle) : null;
    const water = this.waterAt(t.x, t.z);
    if (water !== null && gear.contactPoint.y < water - 0.1) return; // in the sea: the breakup handles water
    const surface: ImpactSurface =
      tag?.material === 'water' ? 'water' : tag && (tag.kind === 'road' || tag.material === 'asphalt' || tag.material === 'concrete') ? 'runway' : 'ground';
    const wheel = gear.wheels[Math.max(0, gear.firstContact)]?.name ?? 'gearL';
    const info = this.impactInfo(body, surface, wheel, gear.contactPoint);
    info.normalSpeed = vs;
    info.tangentSpeed = gs;
    if (vs < L.normalVs && bank < L.maxBankDeg && model.pitch > -3 * DEG) {
      ctx.events.emit('touchdown', { position: info.position, verticalSpeed: vs, hard: false });
      for (const w of gear.wheels) {
        if (w.steerable || !w.contact) continue;
        ctx.fx.smoke(info.position, 0.5 + vs * 0.25 + gs * 0.005);
      }
      ctx.fx.dust(info.position, 0.3 + vs * 0.1);
    } else if (vs < L.hardVs) {
      ctx.events.emit('touchdown', { position: info.position, verticalSpeed: vs, hard: true });
      ctx.fx.smoke(info.position, 1.2);
      try {
        ctx.breakup.hardLanding(this.tracked, info);
      } catch (err) {
        reportError('[planes] hardLanding failed', err);
      }
    } else {
      ctx.events.emit('touchdown', { position: info.position, verticalSpeed: vs, hard: true });
      try {
        ctx.breakup.crash(this.tracked, 'groundCrash', info);
      } catch (err) {
        reportError('[planes] crash failed', err);
      }
      this.markCrashed();
    }
  }

  private updateOutOfMap(dt: number, t: { x: number; y: number; z: number }): void {
    const o = this.oom;
    const C = CONFIG.planes.outOfMap;
    const { events } = this.ctx;
    o.checkT -= dt;
    if (o.checkT <= 0) {
      o.checkT = 0.1;
      o.distance = this.offshore(t.x, t.z);
    }
    if (this.crashed || this.split) return;
    const warn = CONFIG.world.planeWarnOffshore;
    const fail = CONFIG.world.planeFailOffshore;
    if (o.state === 'ok') {
      if (o.distance > fail) this.startFailure();
      else if (o.distance > warn) {
        o.state = 'warning';
        o.countdown = C.countdown;
        events.emit('outOfMap', { state: 'warning', countdown: o.countdown });
        events.emit('masterCaution', { text: 'OUT OF MAP — TURN BACK', level: 'caution' });
      }
    } else if (o.state === 'warning') {
      o.countdown = Math.max(0, o.countdown - dt);
      if (o.distance < warn) {
        o.state = 'ok';
        o.countdown = 0;
        events.emit('outOfMap', { state: 'ok', countdown: 0 });
      } else if (o.countdown <= 0 || o.distance > fail) this.startFailure();
    } else {
      o.failT += dt;
      if (o.failT >= o.nextT) {
        const next = this.engines.findIndex((e) => e.st.status === 'ok');
        if (next >= 0) {
          o.nextT = o.failT + C.engineInterval;
          o.failed++;
          this.explodeEngine(next + 1, true);
          events.emit('masterCaution', { text: `ENGINE FAILURE — ${o.failed}/${this.engines.length}`, level: 'warning' });
        }
      }
      if (o.lastEngineT < 0 && !this.engines.some((e) => e.st.status === 'ok')) {
        o.lastEngineT = this.simTime;
        o.aglAtLast = this.agl;
      }
    }
  }

  private startFailure(): void {
    const o = this.oom;
    o.state = 'failing';
    o.countdown = 0;
    o.failT = 0;
    o.nextT = 0;
    o.failed = this.engines.filter((e) => e.st.status !== 'ok').length;
    this.ctx.events.emit('outOfMap', { state: 'failing', countdown: 0 });
  }

  private updateTailFire(visual: PlaneVisual): void {
    const fx = this.ctx.fx;
    if (!fx.attachTrail) return;
    const r = Math.max(2, visual.dims.height * 0.3);
    const grow = Math.min(1.8, 1 + this.tailT / 20);
    for (const tr of this.tailTrails) tr.setIntensity(1, 1, r * 0.9 * grow);
    const stages: [number, string][] = [[8, 'fuselageRear'], [16, 'fuselageCenter']];
    if (this.tailStage < stages.length && this.tailT >= stages[this.tailStage][0]) {
      const part = visual.partByName[stages[this.tailStage][1]];
      if (part && !this.lostParts.has(part.name)) this.tailTrails.push(fx.attachTrail(part.object, new THREE.Vector3(0, part.halfExtents.y * 0.5, 0), { fire: 0.9, smoke: 1, size: r * 0.8 }));
      this.tailStage++;
    }
  }

  postStep(): void {
    if (this.body) this.interp.capture(this.body);
  }

  // ─────────────────────────────── per frame ───────────────────────────────
  update(dt: number, alpha: number): void {
    const { ctx } = this;
    const realDt = ctx.engine.realDt;
    // Real airport appeared after init → drop the temporary airfield and re-park.
    if (this.tempField && ctx.world.data?.airport?.stands?.length) {
      this.setupAirfield();
      for (const rec of this.parked.values()) {
        if (rec.occupied) continue;
        const st = this.standFor(rec.type);
        rec.pos.copy(st.p);
        rec.yaw = st.yaw;
        this.placeParked(rec);
      }
    }
    if (this.pending && ctx.game.state === 'driving' && !this.busy) {
      const p = this.pending;
      this.pending = null;
      this.startFlight(p.type, p.air ? 'air' : 'runway');
    }
    if (ctx.game.mode === 'plane' && ctx.input.consume('gear')) this.toggleGear();

    const cam = ctx.engine.camera.position;
    const night = ctx.env.nightFactor ?? 0;
    for (const rec of this.parked.values()) {
      if (rec.occupied) continue;
      this.applyLod(rec.visual, cam, rec);
      const key = night > 0.3 ? 1 : 0;
      if (rec.lights !== key) {
        rec.lights = key;
        rec.visual.setLights({ nav: key === 1, strobe: false, beacon: false, landing: false });
      }
      rec.visual.update(dt);
    }

    if (this.active && this.visual) {
      const visual = this.visual;
      if (this.body) this.interp.apply(visual.root, alpha);
      this.updateVisual(dt, realDt, visual, night);
      this.fillState();
    }
    if (this.active) {
      if (this.crashed) this.crashTime += realDt;
      if (this.inCockpitSequence && this.cockpitCutT < 0) this.watchCockpit(realDt);
      if (this.cockpitCutT >= 0) {
        this.cockpitCutT -= realDt;
        if (this.cockpitCutT < 0) {
          this.fadeThen(() => {
            this.inCockpitSequence = false;
            this.markCrashed();
            this.updateCameraTarget();
          });
        }
      }
      this.updateCameraTarget();
    }
    this.updateBoardCandidate();
  }

  private toggleGear(): void {
    const cfg = this.cfg;
    if (!cfg || !cfg.retractable || this.crashed || this.gearCollapsed || !this.body) return;
    if (this.gearTarget === 1) {
      if (this.onGround) return;
      this.gearTarget = 0;
    } else this.gearTarget = 1;
    this.manualGearT = this.simTime;
  }

  private applyLod(visual: PlaneVisual, cam: THREE.Vector3, rec?: Parked): void {
    const L = Math.max(8, visual.dims.length);
    const d = cam.distanceTo(visual.root.position);
    const lod = CONFIG.planes.lod;
    const level: 0 | 1 | 2 = d < L * lod.high || d < 60 ? 0 : d < L * lod.medium ? 1 : 2;
    if (rec) {
      if (rec.lod !== level) {
        rec.lod = level;
        visual.setLod(level);
      }
    } else if (this.lodLevel !== level) {
      this.lodLevel = level;
      visual.setLod(level);
    }
  }

  private updateVisual(dt: number, realDt: number, visual: PlaneVisual, night: number): void {
    const model = this.model;
    this.applyLod(visual, this.ctx.engine.camera.position, undefined);
    for (let i = 0; i < this.engines.length; i++) this.propAngles[i] = this.engines[i].propAngle;
    const c = model?.controls;
    visual.setControls({
      aileron: c?.aileron ?? 0, elevator: c?.elevator ?? 0, rudder: c?.rudder ?? 0,
      flaps: this.flaps, gear: this.cfg?.retractable ? this.gearPos : 1, propAngle: this.propAngles,
    });
    // Lights: nav/strobe/beacon in flight; landing lights low (and at night / gear down).
    const flying = !!this.body && !this.onGround;
    const running = !!this.body && this.engines.some((e) => e.st.status === 'ok');
    const gsp = this.state.groundSpeedKmh;
    const nav = !!this.body && (running || night > 0.3);
    const strobe = flying || (running && gsp > 40);
    const beacon = running || flying;
    const landing = !!this.body && (this.agl < 450 || (this.onGround && gsp > 15)) && (night > 0.2 || (this.gearPos > 0.9 && (flying || gsp > 15)));
    const key = (nav ? 1 : 0) | (strobe ? 2 : 0) | (beacon ? 4 : 0) | (landing ? 8 : 0);
    if (key !== this.lightsKey) {
      this.lightsKey = key;
      visual.setLights({ nav, strobe, beacon, landing });
    }
    // Cockpit instruments (~15 Hz; flicker in the explode-middle sequence or with failing engines).
    this.instT -= realDt;
    if (this.instT <= 0) {
      this.instT = 1 / 15;
      for (let i = 0; i < this.engines.length; i++) this.instEngines[i] = this.engines[i].st.status;
      const s = this.state;
      const flicker = this.inCockpitSequence ? 0.5 + Math.random() * 0.5 : this.oom.state === 'failing' ? 0.25 : this.tailLost ? 0.35 : 0;
      visual.setInstruments({
        airspeedKmh: s.airspeedKmh, altitude: s.altitude, verticalSpeed: s.verticalSpeed, heading: s.heading, throttle: this.throttle,
        engines: this.instEngines, stall: s.stallWarning, flicker,
      });
    }
    // Fire trails stretch and grow with airspeed.
    const V = model?.airspeed ?? 0;
    for (const e of this.engines) {
      if (!e.trail) continue;
      const k = Math.min(1, V / 60);
      e.trail.setIntensity(e.st.fire * (0.7 + 0.3 * k), 1, e.trailSize * (e.spread ? 1.8 : 1) * (1 + Math.min(1.2, V / 160)));
    }
    visual.update(dt);
  }

  private fillState(): void {
    const s = this.state;
    const model = this.model;
    const visual = this.visual;
    const cfg = this.cfg;
    if (!visual || !cfg) return;
    s.type = this.type;
    s.rotationSpeedKmh = cfg.rotationKmh;
    s.stallSpeedKmh = cfg.stallKmh;
    s.assisted = this.ctx.settings.values.flightAssisted !== false;
    s.damage.tailLost = this.tailLost;
    s.damage.split = this.split;
    s.damage.drag = this.damageDrag;
    const o = this.oom;
    s.outOfMap.state = o.state;
    s.outOfMap.countdown = o.countdown;
    s.outOfMap.distance = o.distance;
    s.outOfMap.failed = o.failed;
    s.outOfMap.total = this.engines.length;
    const body = this.body;
    if (body && model) {
      s.position.copy(visual.root.position);
      s.quaternion.copy(visual.root.quaternion);
      const v = body.linvel();
      s.velocity.set(v.x, v.y, v.z);
      s.forward.set(0, 0, 1).applyQuaternion(s.quaternion);
      s.airspeed = model.airspeed;
      s.airspeedKmh = model.airspeed * KMH;
      s.groundSpeedKmh = Math.hypot(v.x, v.z) * KMH;
      s.altitude = s.position.y;
      s.altitudeAgl = this.agl;
      s.verticalSpeed = v.y;
      s.heading = ((model.heading / DEG) % 360 + 360) % 360;
      s.pitch = model.pitch / DEG;
      s.bank = model.bank / DEG;
      s.aoa = model.alpha / DEG;
      s.onGround = this.onGround;
      s.stall = model.stall && !this.onGround;
      s.stallWarning = model.stallWarning && !this.crashed;
    } else {
      const obj = this.cameraTarget?.object;
      if (obj) obj.getWorldPosition(s.position);
      s.velocity.copy(this.cameraTarget?.velocity ?? ZERO);
      s.airspeed = s.velocity.length();
      s.airspeedKmh = s.airspeed * KMH;
      s.altitude = s.position.y;
      s.stall = false;
      s.stallWarning = false;
    }
    s.throttle = this.throttle;
    s.flaps = this.flaps;
    s.gear = cfg.retractable ? (this.gearCollapsed ? 0 : this.gearPos) : 1;
    s.brake = this.parking || this.ctx.input.state.planeBrake;
    s.canExit = !!body && !this.crashed && this.onGround && s.groundSpeedKmh < CONFIG.planes.exitMaxKmh && !this.busy;
    s.phase = this.split ? 'destroyed' : this.crashed ? 'crashed' : this.onGround ? (this.parking && s.groundSpeedKmh < 1 ? 'parked' : 'ground') : 'flying';
    if (s.stallWarning !== this.stallWarnOn) {
      this.stallWarnOn = s.stallWarning;
      this.ctx.events.emit('stallWarning', { on: s.stallWarning });
    }
  }

  private updateCameraTarget(): void {
    const visual = this.visual;
    if (!this.active || !visual) {
      this.cameraTarget = null;
      return;
    }
    const tg = this.target;
    if (this.body) {
      tg.object = visual.root;
      tg.kind = 'plane';
      tg.size = visual.dims.length;
      const v = this.body.linvel();
      tg.velocity.set(v.x, v.y, v.z);
      tg.cockpitEye = visual.cockpitEye;
      tg.wingCam = visual.wingCam;
    } else if (this.inCockpitSequence && this.cockpitPiece) {
      const pc = this.cockpitPiece;
      tg.object = pc.object;
      tg.kind = 'cockpitPiece';
      tg.size = Math.max(4, visual.dims.length * 0.35);
      this.pieceVelocity(pc, tg.velocity);
      const part = visual.partByName[this.cockpitPartName];
      const eye = (tg.cockpitEye && tg.cockpitEye !== visual.cockpitEye ? tg.cockpitEye : new THREE.Vector3());
      if (part) {
        pc.object.updateMatrixWorld(true);
        part.object.localToWorld(eye.copy(this.cockpitEyePart));
        pc.object.worldToLocal(eye);
      }
      tg.cockpitEye = eye;
      tg.wingCam = undefined;
    } else {
      let focus: WreckPiece | null = null;
      try {
        focus = this.ctx.breakup.focusPiece;
      } catch {
        focus = null;
      }
      if (!focus && this.lastPieces.length) focus = this.lastPieces.reduce((a, b) => (b.mass > a.mass ? b : a));
      if (focus) {
        tg.object = focus.object;
        tg.size = Math.max(5, visual.dims.length * Math.cbrt(focus.mass / Math.max(1, visual.mass)));
        this.pieceVelocity(focus, tg.velocity);
      } else {
        tg.object = visual.root;
        tg.size = visual.dims.length;
        tg.velocity.set(0, 0, 0);
      }
      tg.kind = 'wreck';
      tg.cockpitEye = undefined;
      tg.wingCam = undefined;
    }
    this.cameraTarget = tg;
  }

  private pieceVelocity(p: WreckPiece, out: THREE.Vector3): void {
    try {
      if (this.ctx.physics.world.bodies.contains(p.body.handle)) {
        const v = p.body.linvel();
        out.set(v.x, v.y, v.z);
        return;
      }
    } catch {
      /* body gone */
    }
    out.set(0, 0, 0);
  }

  private updateBoardCandidate(): void {
    const { ctx } = this;
    this.boardCandidate = null;
    if (ctx.game.mode !== 'car' || ctx.game.state !== 'driving' || this.busy) return;
    const car = ctx.vehicle;
    if (!car.active || car.state.exploded || car.state.speedKmh > CONFIG.planes.boardMaxKmh) return;
    const cp = car.state.position;
    let best = CONFIG.planes.boardRadius;
    for (const rec of this.parked.values()) {
      if (rec.occupied) continue;
      const root = rec.visual.root;
      _v.copy(rec.visual.boardPoint).applyQuaternion(root.quaternion).add(root.position);
      const d = Math.hypot(_v.x - cp.x, _v.z - cp.z);
      if (d < best) {
        best = d;
        this.boardCandidate = { type: rec.type, name: rec.visual.name };
      }
    }
  }

  // ─────────────────────────────── test / debug helpers ───────────────────────────────
  /** Snapshot of the flight state straight from the body (tests read this while stepping the sim manually). */
  telemetry(): Record<string, number | string | boolean> | null {
    const body = this.body;
    const m = this.model;
    if (!body || !m) return null;
    const t = body.translation();
    const v = body.linvel();
    return {
      t: +this.simTime.toFixed(3), x: t.x, y: t.y, z: t.z, vx: v.x, vy: v.y, vz: v.z,
      kmh: m.airspeed * KMH, gs: Math.hypot(v.x, v.z) * KMH, agl: this.agl, pitch: m.pitch / DEG, bank: m.bank / DEG,
      heading: m.heading / DEG, aoa: m.alpha / DEG, beta: m.beta / DEG, gamma: m.gamma / DEG, onGround: this.onGround, stall: m.stall,
      stallWarn: m.stallWarning, flaps: this.flaps, gear: this.gearPos, throttle: this.throttle, thrust: this.engines.reduce((a, e) => a + e.st.thrust, 0),
      de: m.controls.elevator, da: m.controls.aileron, dr: m.controls.rudder, crashed: this.crashed, oom: this.oom.state, failed: this.oom.failed,
      offshore: this.oom.distance, liftScale: this.oom.liftScale, p: m.p / DEG, q: m.qRate / DEG, r: m.r / DEG,
    };
  }
}
