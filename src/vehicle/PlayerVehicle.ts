import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups, BodyInterpolator, type SurfaceMaterial } from '../core/Physics';
import { KMH, approach, clamp, damp, lerp, smoothstep } from '../core/math';
import type { CarBuild } from './CarBuild';
import type { CarVisual, FireHandle, GameContext, IPlayerVehicle, VehicleState, WheelState } from '../game/contracts';
import type { Pose } from '../world/types';
import { createParams, predictTopSpeed, resolveParams } from './tuning';
import { Drivetrain } from './Drivetrain';
import { DebrisSystem } from './Debris';
import { Damage, type DamageHost } from './Damage';
import { Turbo } from './Turbo';
import { Stunts, type StuntFrame, type StuntHost } from './Stunts';
import { Headlights } from './Headlights';

/**
 * The player car (spec §6, §10, part 3 §6–§8b). Owner: src/vehicle.
 *
 * Rapier DynamicRayCastVehicleController (4 wheels) + our own layer on top:
 *  - drivetrain (torque curve, auto 5-speed + reverse, shift cuts, limiter, soft top-gear governor) → driven wheels,
 *  - brakes with ABS cap, brake-to-reverse, engine braking, parking hold, handbrake that locks the rear and drops grip,
 *  - per-wheel grip from surface × weather, aquaplaning, handbrake / power-slide rear grip state,
 *  - speed-sensitive steering with rate smoothing (keys/touch) and auto-countersteer on the body slip angle,
 *  - assists as impulses: aero drag, rolling resistance, downforce, anti-roll + body roll, yaw-rate ESC, slip limiter,
 *    bump stops, crosswind, air control with auto-level and takeoff pitch damping,
 *  - turbo (meter, push, raised top speed, the "semi-uncontrollable" wobble/shake/lift-off kick), glide, airborne mode,
 *    barrel rolls and landing verdicts (Turbo, Stunts), headlight spot pair (Headlights),
 *  - impacts/damage (Damage), debris (DebrisSystem), explosion & repair-on-reset, flip & stuck recovery,
 *  - frozen chassis after reset/teleport until terrain colliders are loaded; parked & frozen while the player flies.
 * Coordinates: car faces +Z, left = +X, wheels FL FR RL RR. Positive Rapier steering turns toward +X (left).
 */

const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];
const DETACH_ON_EXPLODE = /hood|bonnet|door|bumper|trunk|boot|tailgate|spoiler|wing/i;
const UP = new THREE.Vector3(0, 1, 0);

interface FlipAnim {
  t: number;
  fromP: THREE.Vector3;
  fromQ: THREE.Quaternion;
  toP: THREE.Vector3;
  toQ: THREE.Quaternion;
}

interface PristinePart {
  p: THREE.Vector3;
  q: THREE.Quaternion;
  s: THREE.Vector3;
}

interface Freeze {
  t: number;
  x: number;
  y: number;
  z: number;
  park: boolean;
}

export class PlayerVehicle implements IPlayerVehicle, DamageHost, StuntHost {
  readonly name = 'vehicle';
  active = false;
  object: THREE.Object3D | null = null;
  visual: CarVisual | null = null;
  chassis: RAPIER.RigidBody | null = null;
  chassisCollider: RAPIER.Collider | null = null;
  build: CarBuild | null = null;
  readonly state: VehicleState;
  /** Chassis velocity before the current physics step (impact speeds). */
  readonly preVelocity = new THREE.Vector3();
  halfLength = 2.1;

  private controller: RAPIER.DynamicRayCastVehicleController | null = null;
  private interp = new BodyInterpolator();
  private params = createParams();
  private drivetrain: Drivetrain;
  private debris: DebrisSystem;
  private damage: Damage;
  private turbo: Turbo;
  private stunts: Stunts;
  private headlights: Headlights | null = null;
  private fire: FireHandle | null = null;
  private flipAnim: FlipAnim | null = null;
  private frozen: Freeze | null = null;
  private pristine = new Map<THREE.Object3D, PristinePart>();

  // driving state
  private time = 0;
  private throttleS = 0;
  private brakeS = 0;
  private steerS = 0;
  private steerAngle = 0;
  private reverse = false;
  private dirTimer = 0;
  private rearSide = 1;
  private esc = 1;
  private airTime = 0;
  private nContact = 0;
  private drivePedal = 0;
  private brakePedal = 0;
  private stuckT = 0;
  private parkStill = 0;
  private promptShown = false;
  private resetRequested = false;
  private charT = 1;
  private stepCount = 0;
  private wheelbase = 2.6;
  private inertia = new THREE.Vector3(1, 1, 1);
  private massSig = '';
  private eventThreshold = 0;
  private lastLights = { brake: false, reverse: false, headlights: false, underglow: false };
  private lightsDirty = true;
  private yawRate = 0;
  private slipAngle = 0;
  private latAcc = 0;
  private turboTop = 90;
  private onHighway = false;
  private restStop = false;
  private onBridge = false;
  private inTunnel = false;
  private aquaT = 0;
  private wild = 1;
  private liftAccel = 0;

  // per wheel
  private hardY = [0, 0, 0, 0];
  private suspPrev = [0, 0, 0, 0];
  private suspCurr = [0, 0, 0, 0];
  private suspForce = [0, 0, 0, 0];
  private contact = [false, false, false, false];
  private wheelNormal = [0, 1, 2, 3].map(() => new THREE.Vector3(0, 1, 0));
  private contactPoint = [0, 1, 2, 3].map(() => new THREE.Vector3());
  private surfaceGrip = [1, 1, 1, 1];
  private surfaceDrag = [0, 0, 0, 0];
  private spinAngle = [0, 0, 0, 0];
  private spinVel = [0, 0, 0, 0];
  private absActive = [false, false, false, false];

  // temps (no per-frame allocation)
  private rv = { x: 0, y: 0, z: 0 };
  private rq = { x: 0, y: 0, z: 0, w: 1 };
  private q = new THREE.Quaternion();
  private fwd = new THREE.Vector3();
  private left = new THREE.Vector3();
  private up = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private w = new THREE.Vector3();
  private groundN = new THREE.Vector3();
  private landingN = new THREE.Vector3(0, 1, 0);
  private imp = new THREE.Vector3();
  private torque = new THREE.Vector3();
  private aW = new THREE.Vector3();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private m4 = new THREE.Matrix4();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private wheelGroups = groups(G.ALL, G.WORLD | G.PARKED);
  private wheelPredicate = (col: RAPIER.Collider) => col.parent()?.handle !== this.chassis?.handle;
  private frame: StuntFrame;

  constructor(readonly ctx: GameContext) {
    this.drivetrain = new Drivetrain(ctx.events);
    this.debris = new DebrisSystem(ctx);
    this.damage = new Damage(this);
    this.turbo = new Turbo(ctx.events);
    this.stunts = new Stunts(this);
    this.state = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      forward: new THREE.Vector3(0, 0, 1),
      speed: 0,
      speedKmh: 0,
      rpm: 900,
      rpmNorm: 0,
      gear: 1,
      throttle: 0,
      brake: 0,
      steer: 0,
      handbrake: false,
      airborne: false,
      upsideDown: false,
      exploded: false,
      boost: 0,
      wheels: [0, 1, 2, 3].map(
        (): WheelState => ({ position: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), contact: false, slip: 0, surface: 'asphalt', rpm: 0 }),
      ),
      turboCharge: 1,
      turboActive: false,
      airborne3: this.stunts.info,
      headlights: 'off',
      aquaplaning: false,
    };
    this.frame = {
      body: null as unknown as RAPIER.RigidBody,
      nContact: 0,
      pos: this.pos,
      vel: this.vel,
      fwd: this.fwd,
      left: this.left,
      up: this.up,
      groundN: this.groundN,
      gravity: 14,
      liftAccel: 0,
      barrel: 0,
    };
  }

  get exploded(): boolean {
    return this.state.exploded;
  }

  get mass(): number {
    return this.params.mass;
  }

  /** Live numbers for tuning / tests (not part of the contract). */
  get telemetry() {
    return {
      yawRate: this.yawRate,
      slipDeg: this.slipAngle * 57.2958,
      contacts: this.nContact,
      rearSide: this.rearSide,
      esc: this.esc,
      steerAngle: this.steerAngle,
      reverse: this.reverse,
      airTime: this.airTime,
      debris: this.debris.count,
      glass: this.damage.glassLevel,
      stuck: this.stuckT,
      flipping: !!this.flipAnim,
      frozen: !!this.frozen,
      suspension: this.suspCurr.slice(),
      turboLevel: this.turbo.level,
      turboTopKmh: this.turboTop * 3.6,
      wild: this.wild,
      liftAccel: this.liftAccel,
      params: this.params,
    };
  }

  init(): void {
    if (this.ctx.debug) (window as unknown as { __RAPIER: typeof RAPIER }).__RAPIER = RAPIER; // test scripts build tracks
    this.headlights = new Headlights(this.ctx.engine.scene);
    this.ctx.events.on('contact', (e) => {
      const col = this.chassisCollider;
      if (!this.active || !col) return;
      if (e.h1 === col.handle) this.damage.onContact(e.h2, e.tag2, e.force);
      else if (e.h2 === col.handle) this.damage.onContact(e.h1, e.tag1, e.force);
    });
    this.ctx.events.on('originShift', ({ delta }) => this.onOriginShift(delta.x, delta.z));
  }

  /** Floating origin: bodies/scene/interpolators are shifted by core — shift the world positions we cache. */
  private onOriginShift(dx: number, dz: number): void {
    if (this.frozen) {
      this.frozen.x -= dx;
      this.frozen.z -= dz;
    }
    if (this.flipAnim) {
      this.flipAnim.fromP.x -= dx;
      this.flipAnim.fromP.z -= dz;
      this.flipAnim.toP.x -= dx;
      this.flipAnim.toP.z -= dz;
    }
    this.stunts.shift(dx, dz);
    for (const p of this.contactPoint) (p.x -= dx), (p.z -= dz);
    const s = this.state;
    s.position.x -= dx;
    s.position.z -= dz;
    for (const w of s.wheels) (w.position.x -= dx), (w.position.z -= dz);
  }

  // ─────────────────────────────── lifecycle ───────────────────────────────
  spawn(build: CarBuild, pose: Pose): void {
    this.despawn();
    const { physics, engine } = this.ctx;
    const V = CONFIG.vehicle;
    this.build = build;
    const visual = (this.visual = this.ctx.cars.create(build));
    engine.scene.add(visual.root);
    this.object = visual.root;
    const d = visual.dims;
    const P = resolveParams(build, d, this.params);
    this.halfLength = d.halfExtents.z;
    this.updateWheelbase();

    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pose.position.x, pose.position.y + 1, pose.position.z)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setAngularDamping(V.chassis.angularDamping),
    );
    this.chassis = body;
    this.frame.body = body;
    const br = Math.min(V.chassis.borderRadius, d.halfExtents.y * 0.45, d.halfExtents.x * 0.45);
    const colDesc = RAPIER.ColliderDesc.roundCuboid(d.halfExtents.x - br, d.halfExtents.y - br, d.halfExtents.z - br, br)
      .setTranslation(d.colliderOffset.x, d.colliderOffset.y, d.colliderOffset.z)
      .setDensity(0)
      .setFriction(V.chassis.friction)
      .setRestitution(V.chassis.restitution)
      .setCollisionGroups(groups(G.PLAYER, G.WORLD | G.PROP | G.PARKED | G.DEBRIS))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    const col = physics.world.createCollider(colDesc, body);
    physics.tag(col, { kind: 'player', material: 'metal' });
    this.chassisCollider = col;
    this.massSig = '';
    this.applyMassProps(true);

    const c = physics.world.createVehicleController(body);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (let i = 0; i < 4; i++) {
      const wp = d.wheelPositions[i];
      c.addWheel({ x: wp.x, y: wp.y + P.restLength, z: wp.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, P.restLength, P.wheelRadius);
    }
    this.controller = c;
    this.active = true;
    this.hardY.fill(0);
    this.syncSetup();
    this.drivetrain.reset(P);
    this.damage.reset();
    this.turbo.reset();
    this.stunts.reset();
    this.turboTop = predictTopSpeed(P) * this.turbo.topFactorFor(build.perf.turbo ?? 0);
    this.headlights?.setColor(build.extras.headlightColor);
    this.state.exploded = false;
    this.charT = 1;
    this.placeAt(pose);
    this.lightsDirty = true;
    this.ctx.events.emit('carSpawned', { build });
  }

  despawn(): void {
    if (!this.active) return;
    const { physics, engine } = this.ctx;
    this.flipAnim = null;
    this.frozen = null;
    this.turbo.cut();
    const parts = this.debris.clear();
    this.fire?.stop();
    this.fire = null;
    if (this.controller) physics.world.removeVehicleController(this.controller);
    physics.removeBody(this.chassis);
    const orphans = parts.filter((o) => !o.parent);
    const used = orphans.length && this.visual ? collectResources(this.visual.root) : null;
    if (this.visual) {
      engine.scene.remove(this.visual.root);
      this.visual.dispose();
    }
    for (const obj of orphans) disposeUnused(obj, used);
    this.pristine.clear();
    this.setPrompt(false);
    this.headlights?.update(null, 0, false, false);
    this.controller = null;
    this.chassis = null;
    this.chassisCollider = null;
    this.visual = null;
    this.object = null;
    this.active = false;
  }

  applyBuild(build: CarBuild): void {
    if (!this.active || !this.visual || !this.chassis) {
      this.build = build;
      return;
    }
    if (this.build && build.model !== this.build.model) {
      const t = this.chassis.translation();
      this.spawn(build, { position: { x: t.x, y: t.y - this.params.rideOffset, z: t.z }, yaw: this.currentYaw() });
      return;
    }
    this.build = build;
    this.visual.applyBuild(build);
    this.halfLength = this.visual.dims.halfExtents.z;
    this.updateWheelbase();
    this.headlights?.setColor(build.extras.headlightColor);
    this.turboTop = predictTopSpeed(resolveParams(build, this.visual.dims, this.params)) * this.turbo.topFactorFor(build.perf.turbo ?? 0);
    this.lightsDirty = true;
  }

  private updateWheelbase(): void {
    const wp = this.visual?.dims.wheelPositions;
    this.wheelbase = wp && wp.length >= 4 ? Math.max(1.5, (wp[0].z + wp[1].z - wp[2].z - wp[3].z) * 0.5) : CONFIG.vehicle.assist.wheelbaseFallback;
  }

  /** Mass, centre of mass and inertia on the body (collider has zero density). Re-applied when tuning changes. */
  private applyMassProps(force = false): void {
    const body = this.chassis;
    const visual = this.visual;
    if (!body || !visual) return;
    const C = CONFIG.vehicle.chassis;
    const P = this.params;
    const h = visual.dims.halfExtents;
    const sig = `${P.mass}|${P.comHeight}|${P.comForward}|${C.inertiaPitch}|${C.inertiaYaw}|${C.inertiaRoll}|${h.x}|${h.y}|${h.z}`;
    if (!force && sig === this.massSig) return;
    this.massSig = sig;
    const m = P.mass;
    const w = 2 * h.x, hh = 2 * h.y, l = 2 * h.z;
    this.inertia.set(
      (m / 12) * (hh * hh + l * l) * C.inertiaPitch,
      (m / 12) * (w * w + l * l) * C.inertiaYaw,
      (m / 12) * (w * w + hh * hh) * C.inertiaRoll,
    );
    body.setAdditionalMassProperties(m, { x: 0, y: P.comHeight, z: P.comForward }, { x: this.inertia.x, y: this.inertia.y, z: this.inertia.z }, { x: 0, y: 0, z: 0, w: 1 }, true);
    body.setAngularDamping(C.angularDamping);
    this.eventThreshold = (CONFIG.vehicle.impact.eventDv * m) / this.ctx.physics.dt;
    this.chassisCollider?.setContactForceEventThreshold(this.eventThreshold);
  }

  /** Push the resolved params into the Rapier wheels (cheap; done every step so live tuning works). */
  private syncSetup(): void {
    const c = this.controller;
    const visual = this.visual;
    if (!c || !visual) return;
    const P = this.params;
    const S = CONFIG.vehicle.suspension;
    const g = Math.abs(CONFIG.physics.gravity);
    const sag = Math.min(P.travel * 0.9, g / (4 * Math.max(1, P.stiffness)));
    for (let i = 0; i < 4; i++) {
      const wp = visual.dims.wheelPositions[i];
      // Hard point chosen so the wheel sits exactly at the modelled position at static sag (stock ride height).
      const hy = wp.y + S.restLength - sag;
      if (Math.abs(hy - this.hardY[i]) > 1e-5) {
        this.hardY[i] = hy;
        this.rv.x = wp.x;
        this.rv.y = hy;
        this.rv.z = wp.z;
        c.setWheelChassisConnectionPointCs(i, this.rv);
      }
      c.setWheelSuspensionRestLength(i, P.restLength);
      c.setWheelMaxSuspensionTravel(i, P.travel);
      c.setWheelRadius(i, P.wheelRadius);
      c.setWheelSuspensionStiffness(i, P.stiffness);
      c.setWheelSuspensionCompression(i, P.compression);
      c.setWheelSuspensionRelaxation(i, P.relaxation);
      c.setWheelMaxSuspensionForce(i, P.maxSuspForce);
    }
    this.applyMassProps();
  }

  // ─────────────────────────────── simulation ───────────────────────────────
  fixedUpdate(dt: number): void {
    const body = this.chassis;
    const c = this.controller;
    if (!this.active || !body || !c || !this.build || !this.visual) return;
    this.time += dt;
    this.stepCount++;
    this.debris.fixedUpdate(dt);
    this.damage.tick(dt);
    const lv = body.linvel(this.rv);
    this.preVelocity.set(lv.x, lv.y, lv.z);
    const input = this.ctx.input;
    const carMode = (this.ctx.game.mode ?? 'car') === 'car';
    // one-shot stunt triggers: always consume so a press on the ground doesn't fire later in the air
    const barrel = input.consume('barrelLeft') ? -1 : input.consume('barrelRight') ? 1 : 0;
    if (this.frozen) {
      this.stepFrozen(dt, carMode);
      return;
    }
    if (this.flipAnim) {
      this.stepFlip(dt);
      return;
    }
    if (this.state.exploded) return;

    const V = CONFIG.vehicle;
    const P = resolveParams(this.build, this.visual.dims, this.params);
    this.syncSetup();
    const g = Math.abs(CONFIG.physics.gravity);
    if (this.stepCount % 60 === 0) this.turboTop = predictTopSpeed(P) * this.turbo.topFactorFor(this.build.perf.turbo ?? 0);

    // ── pose & velocities
    const t0 = body.translation(this.rv);
    const pos = this.pos.set(t0.x, t0.y, t0.z);
    const r = body.rotation(this.rq);
    this.q.set(r.x, r.y, r.z, r.w);
    const fwd = this.fwd.set(0, 0, 1).applyQuaternion(this.q);
    const left = this.left.set(1, 0, 0).applyQuaternion(this.q);
    const up = this.up.set(0, 1, 0).applyQuaternion(this.q);
    const vel = this.vel.copy(this.preVelocity);
    const av = body.angvel(this.rv);
    const w = this.w.set(av.x, av.y, av.z);
    const vF = vel.dot(fwd);
    const vL = vel.dot(left);
    const absV = Math.abs(vF);
    const speed = vel.length();

    // ── contacts from the previous controller update
    let nContact = 0;
    this.groundN.set(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      if (this.contact[i]) {
        nContact++;
        this.groundN.add(this.wheelNormal[i]);
      }
    }
    if (nContact > 0) this.groundN.normalize();
    else this.groundN.copy(this.landingN);
    const grounded = nContact >= 2 && up.dot(this.groundN) > 0.5;

    // ── environment (throttled queries)
    if (this.stepCount % 15 === 0) this.queryEnvironment(pos);
    const weather = this.ctx.env?.weather;
    const weatherGrip = clamp(weather?.grip ?? 1, 0.2, 1.2);
    let surfAvg = 0;
    for (let i = 0; i < 4; i++) surfAvg += this.surfaceGrip[i];
    surfAvg *= 0.25;
    this.wild = 1 + V.turbo.lowGripWild * Math.max(0, 1 - weatherGrip * surfAvg);

    // ── inputs (smoothed for keys / near-digital touch); in plane mode the car is parked
    const inp = input.state;
    const S = V.steer;
    const parked = !carMode;
    const inThrottle = parked ? 0 : inp.throttle;
    const inBrake = parked ? 0 : inp.brake;
    const inSteer = parked ? 0 : inp.steer;
    const hb = parked ? false : inp.handbrake;

    // ── turbo meter / envelope
    const perfTurbo = this.build.perf.turbo ?? 0;
    const rechargeMul = this.onHighway && speed * KMH > V.turbo.highwayRechargeKmh ? V.turbo.highwayRecharge : 1;
    this.turbo.step(dt, !parked && !this.reverse && inp.turbo, nContact === 0, perfTurbo, rechargeMul, this.restStop);
    const tl = this.turbo.level;
    const T = V.tyres;
    const A = V.assist;

    const B = V.brakes;
    // pedal smoothing: the gas ramps in (no wheelspin spikes); whichever pedal brakes bites fast
    this.throttleS = approach(this.throttleS, inThrottle, (inThrottle > this.throttleS ? (this.reverse ? B.pedalRate : 6) : 10) * dt);
    this.brakeS = approach(this.brakeS, inBrake, (inBrake > this.brakeS ? (this.reverse ? 6 : B.pedalRate) : 12) * dt);
    const steerReturning = Math.abs(inSteer) < Math.abs(this.steerS) || inSteer * this.steerS < 0;
    const steerRate = (steerReturning ? S.returnRate : lerp(S.rate, S.rateHighSpeed, clamp(absV / S.rateSpeed, 0, 1))) * (1 + V.turbo.steerGain * tl);
    this.steerS = approach(this.steerS, inSteer, steerRate * dt);

    // ── brake pedal = brake when rolling forward, reverse when (nearly) stopped (and gas brakes while rolling back)
    let drive: number;
    let brake: number;
    if (!this.reverse) {
      drive = this.throttleS;
      brake = this.brakeS;
      if (inBrake > 0.1 && inThrottle < 0.1 && vF < 0.4 && nContact > 0) {
        this.dirTimer += dt;
        if (this.dirTimer > 0.12) (this.reverse = true), (this.dirTimer = 0);
      } else this.dirTimer = 0;
    } else {
      drive = this.brakeS;
      brake = this.throttleS;
      if (inThrottle > 0.1 && inBrake < 0.1 && vF > -0.4 && nContact > 0) {
        this.dirTimer += dt;
        if (this.dirTimer > 0.12) (this.reverse = false), (this.dirTimer = 0);
      } else this.dirTimer = 0;
    }
    // rolling against the selected direction: the drive pedal brakes hard first
    if (drive > 0.05 && (this.reverse ? vF > B.oppositeBrake : vF < -B.oppositeBrake)) {
      brake = Math.max(brake, drive);
      drive = 0;
    }
    this.drivePedal = drive;
    this.brakePedal = brake;

    // ── drivetrain
    const clutchIn = hb && P.driveFront < 0.01;
    const driveForce = this.drivetrain.step(dt, P, drive, this.reverse, vF, nContact > 0, clutchIn);
    const frontF = driveForce * P.driveFront * 0.5;
    const rearF = hb ? 0 : driveForce * (1 - P.driveFront) * 0.5;

    // ── grip states: handbrake / power slide / lift-off kick / ESC
    const beta = absV > 2.5 && grounded ? Math.atan2(vL, absV) : 0;
    this.slipAngle = beta;
    const slipDeg = Math.abs(beta) * 57.2958;
    const lockBase = Math.max(S.minAngle, P.steerMax / (1 + Math.pow(absV / S.falloffSpeed, S.falloffPow)));
    const lock = lockBase * (1 + V.turbo.steerGain * tl);
    const playerAngle = -this.steerS * lock;
    const steeringInto = playerAngle * w.dot(up) > 0 && Math.abs(this.steerS) > 0.3;
    const powerSlide = !hb && !this.reverse && drive > 0.3 && slipDeg > T.driftSlipDeg && grounded && steeringInto;
    if (this.turbo.justReleased && grounded && absV > 20 && Math.abs(this.yawRate) > V.turbo.liftOffMinYawRate) {
      this.turbo.liftOffT = V.turbo.liftOffTime;
      body.applyTorqueImpulse(this.v1.copy(up).multiplyScalar(Math.sign(this.yawRate) * V.turbo.liftOffYaw * this.wild * this.inertia.y), true);
    }
    let rearTarget = hb ? T.handbrakeRearSide : powerSlide ? Math.max(Math.min(this.rearSide, T.driftRearSide), T.handbrakeRearSide) : 1;
    if (this.turbo.liftOffT > 0) rearTarget = Math.min(rearTarget, 1 - (1 - V.turbo.liftOffRearSide) * Math.min(1.6, this.wild));
    this.rearSide = rearTarget < this.rearSide ? approach(this.rearSide, rearTarget, T.gripDropRate * dt) : approach(this.rearSide, rearTarget, T.gripRecoverRate * dt);
    const hbBlend = clamp((1 - this.rearSide) / Math.max(0.01, 1 - T.handbrakeRearSide), 0, 1);
    const rearGripMul = lerp(1, T.handbrakeRearGrip, hb ? 1 : hbBlend * 0.5);
    const escTarget = hb ? A.handbrakeEsc : powerSlide ? A.driftEsc : 1;
    this.esc = escTarget < this.esc ? escTarget : approach(this.esc, escTarget, A.escRecover * dt);
    const escNow = this.esc * lerp(1, V.turbo.escScale, tl);

    // ── steering: lock shrinks with speed, auto-countersteer on the slip angle
    let cs = 0;
    if (vF > 3 && grounded) {
      cs = clamp(beta * S.countersteer, -S.countersteerMax, S.countersteerMax) * smoothstep(3, 8, vF);
      const into = playerAngle * beta < 0 ? Math.min(1, Math.abs(this.steerS)) : 0;
      cs *= (1 - 0.7 * into) * (hb ? 0.4 : 1);
    }
    const angle = clamp(playerAngle + cs, -P.steerMax, P.steerMax);
    this.steerAngle = angle;

    // ── aquaplaning (puddles at speed → light steering for a moment)
    if (this.aquaT > 0) this.aquaT -= dt;
    else if (this.stepCount % 3 === 0 && (weather?.wetness ?? 0) > 0.05 && absV * KMH > V.weather.aquaMinKmh && this.ctx.env?.puddleAt) {
      for (let i = 0; i < 2; i++) {
        if (!this.contact[i]) continue;
        const p = this.contactPoint[i];
        let d = 0;
        try {
          d = this.ctx.env.puddleAt(p.x, p.z);
        } catch {
          /* env not ready */
        }
        if (d > V.weather.aquaThreshold) {
          this.aquaT = V.weather.aquaTime;
          break;
        }
      }
    }
    const aqua = this.aquaT > 0;

    // ── per-wheel forces
    const brakeTotal = brake * P.brakeForce;
    // coasting (no pedal): engine braking + rolling drag, total decel (aero included) ≈ coastBase + coastPerSpeed·v
    let engineBrake = 0;
    if (drive < 0.05 && brake < 0.05 && !hb && !parked && nContact > 0 && absV > 1 && tl <= 0) {
      const target = Math.min(B.coastMax, B.coastBase + B.coastPerSpeed * absV) * P.mass;
      engineBrake = Math.max(0, target - P.drag * absV * absV - P.rolling) * smoothstep(1, 4, absV);
    }
    const absMod = 1 - B.absPulse * (0.5 + 0.5 * Math.sin(this.time * B.absHz * Math.PI * 2));
    const hold = parked || (drive < 0.05 && brake < 0.05 && absV < B.parkHold && nContact >= 3 && !hb);
    const nDriven = (P.driveFront > 0 ? 2 : 0) + (P.driveFront < 1 ? 2 : 0);
    const speedSide = lerp(1, T.highSpeedSide, clamp(absV / 55, 0, 1));
    const turboSide = Math.max(0.5, 1 - (1 - V.turbo.sideGrip) * tl * Math.min(2, this.wild));
    const staticN = (P.mass * g) / 4;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const N = this.contact[i] ? Math.max(this.suspForce[i], staticN * 0.25) : staticN;
      const surf = this.surfaceGrip[i] * weatherGrip;
      let mu = (front ? P.gripFront : P.gripRear * rearGripMul) * surf;
      let side = (front ? P.sideFront : P.sideRear * this.rearSide) * speedSide * Math.sqrt(surf) * turboSide;
      if (front && aqua) {
        mu *= V.weather.aquaGrip;
        side *= V.weather.aquaSide;
      }
      const limit = 2 * mu * N * dt; // forward impulse at which the tyre saturates (Rapier fwd factor 0.5)
      // ABS: each wheel may use up to absLimit of its real grip (μ·load), pulsing gently at the limit — no lock-up
      const want = brakeTotal * (front ? B.frontBias : 1 - B.frontBias) * 0.5 * dt;
      const absCap = B.absLimit * mu * N * dt;
      let bImp = want > absCap ? absCap * absMod : want;
      this.absActive[i] = want > absCap && absV > 3;
      const driven = front ? P.driveFront > 0 : P.driveFront < 1;
      if (driven && engineBrake > 0) bImp += (engineBrake * dt) / nDriven;
      if (!front && hb) bImp = Math.max(bImp, B.handbrake * limit);
      if (hold) bImp = Math.max(bImp, P.mass * g * 0.3 * dt);
      c.setWheelBrake(i, bImp);
      c.setWheelEngineForce(i, parked ? 0 : front ? frontF : rearF);
      c.setWheelSteering(i, front ? angle : 0);
      c.setWheelFrictionSlip(i, mu);
      c.setWheelSideFrictionStiffness(i, side);
    }

    c.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, this.wheelGroups, this.wheelPredicate);

    // ── read wheel results
    nContact = 0;
    let dragSurf = 0;
    for (let i = 0; i < 4; i++) {
      const inContact = c.wheelIsInContact(i);
      this.contact[i] = inContact;
      this.suspForce[i] = c.wheelSuspensionForce(i) ?? 0;
      this.suspPrev[i] = this.suspCurr[i];
      this.suspCurr[i] = c.wheelSuspensionLength(i) ?? P.restLength;
      if (inContact) {
        nContact++;
        const n = c.wheelContactNormal(i, this.rv);
        if (n) this.wheelNormal[i].set(n.x, n.y, n.z);
        const p = c.wheelContactPoint(i, this.rv);
        if (p) this.contactPoint[i].set(p.x, p.y, p.z);
        dragSurf += this.surfaceDrag[i];
        if ((this.stepCount + i) % 4 === 0) this.updateSurface(i);
      } else this.wheelNormal[i].copy(up);
    }
    this.nContact = nContact;
    this.airTime = nContact === 0 ? this.airTime + dt : 0;
    const airborne = nContact === 0;

    // ── extra forces (impulses): drag, rolling resistance, surface drag, downforce, crosswind, turbo, glide
    const imp = this.imp.copy(vel).multiplyScalar(-P.drag * speed * dt);
    if (nContact > 0 && absV > 0.2) {
      imp.addScaledVector(fwd, -Math.sign(vF) * Math.min(P.rolling * dt, absV * P.mass * 0.25));
      if (dragSurf > 0 && speed > 0.3) imp.addScaledVector(vel, (-Math.min(dragSurf * 0.25 * P.mass * dt, speed * P.mass * 0.5)) / speed);
    }
    if (grounded) imp.addScaledVector(up, -P.downforce * vF * vF * dt);
    const wind = this.ctx.env?.wind;
    if (wind && speed * KMH > V.weather.crosswindMinKmh) {
      const lat = wind.dot(left);
      const k = V.weather.crosswind * smoothstep(V.weather.crosswindMinKmh, V.weather.crosswindFullKmh, speed * KMH) * (this.onBridge ? V.weather.bridgeWind : 1);
      imp.addScaledVector(left, lat * Math.abs(lat) * k * dt);
    }
    // turbo push: cancels resistances and adds `accel`, fading out just below the turbo top speed
    if (tl > 0) {
      const dir = this.v1.copy(fwd);
      if (grounded) dir.addScaledVector(this.groundN, -dir.dot(this.groundN)).normalize();
      const vAlong = vel.dot(dir);
      const resist = P.drag * vAlong * Math.abs(vAlong) + (grounded ? P.rolling : 0);
      const fade = clamp((this.turboTop - vAlong) / Math.max(0.5, V.turbo.fadeSpeed), 0, 1);
      const push = (Math.max(0, resist) + P.mass * this.turbo.accelFor(perfTurbo)) * fade * tl;
      imp.addScaledVector(dir, push * dt);
    }
    // glide: turbo held in the air → lift ∝ v² along the car's up axis + a little drag
    let gliding = false;
    this.liftAccel = 0;
    if (airborne && this.airTime > 0.1 && this.turbo.active) {
      const Gl = V.glide;
      const vf = Math.max(0, vel.dot(fwd));
      const ref = Gl.refKmh / KMH;
      const liftG = Math.min(Gl.maxLift, Gl.liftAtRef * (vf / ref) * (vf / ref));
      this.liftAccel = liftG * g;
      imp.addScaledVector(up, P.mass * this.liftAccel * dt);
      imp.addScaledVector(vel, -Gl.drag * (P.mass / 1000) * speed * dt);
      gliding = true;
    }
    body.applyImpulse(imp, true);

    // ── torques (as impulses): anti-roll, body roll, ESC, slip limiter, turbo wobble / air control
    const tq = this.torque.set(0, 0, 0);
    const I = this.inertia;
    const yawRate = w.dot(up);
    this.yawRate = yawRate;
    if (nContact >= 1 && up.dot(this.groundN) > 0.3) {
      // anti-roll relative to the ground (banked roads included)
      const rollErr = Math.asin(clamp(left.dot(this.groundN), -1, 1));
      const rollRate = w.dot(fwd);
      const k = A.rollStiffness * P.rollAssist * (Math.abs(rollErr) > A.rollLimitDeg / 57.2958 ? 3 : 1);
      tq.addScaledVector(fwd, (-k * rollErr - A.rollDamping * P.rollAssist * rollRate) * I.z);
    }
    // visible body roll: the cornering roll moment Rapier's raycast wheels don't produce (springs resist it naturally)
    this.latAcc = damp(this.latAcc, grounded ? clamp(yawRate * vF, -30, 30) : 0, 12, dt);
    if (grounded) tq.addScaledVector(fwd, (P.mass * this.latAcc * A.bodyRoll) / P.rollAssist);
    if (grounded && absV > 4) {
      // ESC: damp yaw rate beyond what the steering asks for (oversteer only)
      const muG = (P.gripFront + P.gripRear) * 0.5 * g * weatherGrip;
      const maxYaw = (muG / Math.max(absV, 4)) * 1.1;
      const want = clamp((vF * Math.tan(playerAngle)) / this.wheelbase, -maxYaw, maxYaw);
      const err = yawRate - want;
      let acc = 0;
      if (err * yawRate > 0) acc -= A.yawDamping * escNow * (1 + (A.escHighSpeed * absV) / 50) * err;
      // slip-angle limiter: no spin-outs at speed (rotate the nose back toward the velocity); tighter the faster we go
      const maxSlip = lerp(A.maxSlipDeg, A.maxSlipHighDeg, smoothstep(60, A.maxSlipHighKmh, absV * KMH)) / 57.2958;
      if (absV > 7 && Math.abs(beta) > maxSlip) {
        acc += Math.sign(beta) * (Math.abs(beta) - maxSlip) * A.slipLimiter;
        if (yawRate * beta < 0) acc -= yawRate * 2.5;
      }
      // turbo: low-frequency yaw wobble + high-frequency body shake, growing with speed (stronger on low grip)
      if (tl > 0) {
        const Tb = V.turbo;
        const sf = smoothstep(Tb.wobbleStartKmh, Tb.wobbleFullKmh, absV * KMH) * tl;
        acc += Tb.wobbleYaw * this.turbo.noise(Tb.wobbleFreq) * sf * this.wild;
        const sh = Tb.shake * sf;
        tq.addScaledVector(fwd, sh * this.turbo.noise(Tb.shakeFreq, 1) * I.z);
        tq.addScaledVector(left, sh * 0.6 * this.turbo.noise(Tb.shakeFreq * 1.3, 2) * I.x);
      }
      tq.addScaledVector(up, acc * I.y);
    }
    // ramp lip: front wheels already off, rear still pushing → damp the nose-down pitch so jumps keep their angle
    const frontOff = !this.contact[0] && !this.contact[1];
    if (absV > 10 && ((frontOff && nContact > 0) || (airborne && this.airTime < V.air.takeoffTime))) {
      const pr = w.dot(left);
      if (pr > 0) tq.addScaledVector(left, -pr * V.air.takeoffPitchDamp * I.x);
    }
    if (this.airTime > V.air.delay) this.airControl(inThrottle - inBrake, inSteer, hb, tq, this.stunts.rolling);
    // turbo kick: slight nose lift on activation
    if (this.turbo.justStarted && grounded) tq.addScaledVector(left, (-V.turbo.noseLift * I.x) / dt);
    if (tq.lengthSq() > 0) body.applyTorqueImpulse(tq.multiplyScalar(dt), true);

    // ── bump stops: fully compressed wheels push harder (hard landings don't slam the chassis)
    if (nContact > 0) {
      const minLen = P.restLength - P.travel + 0.01;
      for (let i = 0; i < 4; i++) {
        if (!this.contact[i] || this.suspCurr[i] > minLen) continue;
        const wp = this.visual.dims.wheelPositions[i];
        const hp = this.v1.set(wp.x, this.hardY[i], wp.z).applyQuaternion(this.q).add(pos);
        const vUp = Math.max(0, -body.velocityAtPoint(hp, this.rv).y);
        const mag = P.mass * 0.25 * (V.suspension.bumpStop * g + vUp * 6) * dt;
        body.applyImpulseAtPoint(this.v2.copy(up).multiplyScalar(mag), hp, true);
      }
    }

    // ── airborne mode / barrel roll / landing verdict
    const f = this.frame;
    f.nContact = nContact;
    f.gravity = g;
    f.liftAccel = this.liftAccel;
    f.barrel = carMode ? barrel : 0;
    if (airborne) this.groundN.copy(this.landingN);
    this.stunts.step(dt, f);
    this.stunts.setGliding(gliding);
  }

  private queryEnvironment(pos: THREE.Vector3): void {
    const { world, highways, terrain } = this.ctx;
    try {
      this.onHighway = world.isOnHighway ? world.isOnHighway(pos.x, pos.z) : (highways?.isOnHighway(pos.x, pos.z) ?? false);
    } catch {
      this.onHighway = false;
    }
    try {
      this.restStop = highways?.restStopAt(pos.x, pos.z) ?? false;
    } catch {
      this.restStop = false;
    }
    try {
      const road = this.onHighway ? highways?.roadHeightAt(pos.x, pos.z, pos.y) : null;
      this.onBridge = road != null && terrain != null && road - terrain.heightAt(pos.x, pos.z) > CONFIG.vehicle.weather.bridgeHeight;
    } catch {
      this.onBridge = false;
    }
    try {
      this.inTunnel = highways?.inTunnel(pos) ?? false;
    } catch {
      this.inTunnel = false;
    }
  }

  private airControl(pitchIn: number, steerIn: number, hb: boolean, tq: THREE.Vector3, rolling: boolean): void {
    const body = this.chassis!;
    const Ai = CONFIG.vehicle.air;
    const left = this.left;
    const up = this.up;
    const fwd = this.fwd;
    const w = this.w;
    // landing surface normal (ray down every few steps)
    if (this.stepCount % 3 === 0) {
      const t = body.translation();
      this.ray.origin.x = t.x;
      this.ray.origin.y = t.y + 0.5;
      this.ray.origin.z = t.z;
      this.ray.dir.x = 0;
      this.ray.dir.y = -1;
      this.ray.dir.z = 0;
      const hit = this.ctx.physics.world.castRayAndGetNormal(this.ray, 40, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.ALL, G.WORLD), undefined, body);
      if (hit && hit.normal.y > 0.5) this.landingN.set(hit.normal.x, hit.normal.y, hit.normal.z);
      else this.landingN.copy(UP);
    }
    const yawIn = hb ? 0 : -steerIn;
    const rollIn = hb && !rolling ? steerIn : 0;
    const activity = Math.min(1, Math.abs(pitchIn) + Math.abs(steerIn));
    const aW = this.aW.set(0, 0, 0);
    aW.addScaledVector(left, pitchIn * Ai.pitch);
    aW.addScaledVector(up, yawIn * Ai.yaw);
    aW.addScaledVector(fwd, rollIn * Ai.roll);
    // auto-level toward the landing normal (pitch/roll only) + damping of pitch/roll spin
    const axis = this.v1.crossVectors(up, this.landingN);
    aW.addScaledVector(axis, Ai.autoLevel * (1 - 0.6 * activity));
    const wPR = this.v2.copy(w).addScaledVector(up, -w.dot(up));
    aW.addScaledVector(wPR, -Ai.damping * (1 - 0.5 * activity));
    if (rolling) aW.addScaledVector(fwd, -aW.dot(fwd)); // the barrel roll owns the roll axis
    const I = this.inertia;
    tq.addScaledVector(left, aW.dot(left) * I.x);
    tq.addScaledVector(up, aW.dot(up) * I.y);
    tq.addScaledVector(fwd, aW.dot(fwd) * I.z);
  }

  private updateSurface(i: number): void {
    const p = this.contactPoint[i];
    let s: SurfaceMaterial = 'asphalt';
    try {
      s = this.ctx.world.surfaceAt(p.x, p.z);
    } catch {
      /* world not ready */
    }
    this.state.wheels[i].surface = s;
    const T = CONFIG.vehicle.tyres;
    this.surfaceGrip[i] = (T.surface as Record<string, number>)[s] ?? 1;
    this.surfaceDrag[i] = (T.surfaceDrag as Record<string, number>)[s] ?? 0;
  }

  postStep(dt: number): void {
    const body = this.chassis;
    if (!this.active || !body) return;
    this.interp.capture(body);
    this.debris.postStep();
    this.damage.flushScrape();
    const s = this.state;
    const P = this.params;
    const carMode = (this.ctx.game.mode ?? 'car') === 'car';
    s.turboCharge = this.turbo.charge;
    s.turboActive = this.turbo.active && this.turbo.level > 0;
    s.aquaplaning = this.aquaT > 0;
    if (this.frozen) return;
    const lv = body.linvel(this.rv);
    s.velocity.set(lv.x, lv.y, lv.z);
    const r = body.rotation(this.rq);
    this.q.set(r.x, r.y, r.z, r.w);
    const fwd = this.fwd.set(0, 0, 1).applyQuaternion(this.q);
    const upY = this.up.set(0, 1, 0).applyQuaternion(this.q).y;
    s.speed = s.velocity.dot(fwd);
    s.speedKmh = Math.hypot(s.velocity.x, s.velocity.z) * KMH;
    const t = body.translation();

    // Out of the world / deep water → reset (not while the player flies a plane)
    if (!this.resetRequested && carMode) {
      const deep = this.stepCount % 6 === 0 && t.y < CONFIG.world.waterLevel + 0.6 && this.safeDeepWater(t.x, t.z);
      if (t.y < CONFIG.world.killY || deep) {
        this.resetRequested = true;
        this.ctx.game.requestReset();
      }
    }

    if (s.exploded || this.flipAnim) {
      s.throttle = s.brake = 0;
      s.airborne = false;
      return;
    }

    s.rpm = this.drivetrain.rpm;
    s.rpmNorm = this.drivetrain.normRpm(P);
    s.gear = this.drivetrain.gear;
    s.boost = Math.max(this.drivetrain.boost, this.turbo.level);
    s.throttle = this.drivePedal;
    s.brake = this.brakePedal;
    s.steer = this.steerS;
    s.handbrake = carMode && this.ctx.input.state.handbrake;
    s.airborne = this.airTime > 0.1;
    s.upsideDown = upY < CONFIG.vehicle.recovery.upDot;

    // Wheel slip (skids/smoke/squeal) and visual wheel spin
    const T = CONFIG.vehicle.tyres;
    const left = this.left.set(1, 0, 0).applyQuaternion(this.q);
    const hb = s.handbrake;
    const vF = s.speed;
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const ws = s.wheels[i];
      ws.contact = this.contact[i];
      const r0 = P.wheelRadius;
      const driven = front ? P.driveFront > 0 : P.driveFront < 1;
      let slip = 0;
      if (this.contact[i]) {
        const a = front ? this.steerAngle : 0;
        const ca = Math.cos(a), sa = Math.sin(a);
        const vp = body.velocityAtPoint(this.contactPoint[i], this.rv);
        const wfx = fwd.x * ca + left.x * sa, wfy = fwd.y * ca + left.y * sa, wfz = fwd.z * ca + left.z * sa;
        const axx = left.x * ca - fwd.x * sa, axy = left.y * ca - fwd.y * sa, axz = left.z * ca - fwd.z * sa;
        const lon = vp.x * wfx + vp.y * wfy + vp.z * wfz;
        const lat = vp.x * axx + vp.y * axy + vp.z * axz;
        slip = smoothstep(T.slipLatStart, T.slipLatFull, Math.abs(lat));
        if (this.absActive[i]) slip = Math.max(slip, 0.3); // ABS chatter at the grip limit
        let spin = lon / r0;
        if (!front && hb && Math.abs(lon) > 1.2) {
          slip = Math.max(slip, 0.85 * smoothstep(1.2, 7, Math.abs(lon)));
          spin = 0;
        } else if (driven && this.drivetrain.gear === 1 && this.drivePedal > 0.7 && vF >= -0.5 && vF < T.launchSlipSpeed) {
          const ls = (1 - Math.max(0, vF) / T.launchSlipSpeed) * this.drivePedal * T.launchSlip;
          slip = Math.max(slip, ls);
          spin = Math.max(spin, (T.launchSlipSpeed * 1.6) / r0);
        }
        this.spinVel[i] = spin;
      } else {
        const target = driven && this.drivePedal > 0.1 && !(hb && !front) ? ((this.drivetrain.rpm / 60) * 2 * Math.PI) / Math.max(1, this.drivetrain.ratio(P) * P.finalDrive) * (this.reverse ? -1 : 1) : this.spinVel[i] * 0.985;
        this.spinVel[i] = damp(this.spinVel[i], target, 4, dt);
      }
      ws.slip = damp(ws.slip, slip, 20, dt);
      ws.rpm = (this.spinVel[i] * 60) / (2 * Math.PI);
    }

    // Recovery: upside down / stuck for a while → "Flip car" prompt (car mode only)
    const R = CONFIG.vehicle.recovery;
    const pressing = this.ctx.input.state.throttle > 0.3 || this.ctx.input.state.brake > 0.3;
    const slow = s.velocity.length() < R.stuckSpeed;
    const candidate = carMode && slow && (upY < R.upDot || (this.nContact <= 1 && this.airTime > 0.3) || (pressing && this.nContact < 4 && upY < 0.75));
    this.stuckT = candidate ? this.stuckT + dt : Math.max(0, this.stuckT - dt * 3);
    if (!this.promptShown && this.stuckT >= R.stuckTime) this.setPrompt(true);
    else if (this.promptShown && (this.stuckT <= 0 || !carMode)) this.setPrompt(false);

    // Plane mode: once the parked car is still, freeze it (terrain may stream away under it while flying)
    if (!carMode) {
      this.parkStill = s.velocity.length() < 0.5 && this.nContact >= 3 ? this.parkStill + dt : 0;
      if (this.parkStill > CONFIG.vehicle.freeze.parkSettle) this.freezeHere(true);
    } else this.parkStill = 0;
  }

  private safeDeepWater(x: number, z: number): boolean {
    try {
      return this.ctx.world.isDeepWater(x, z);
    } catch {
      return false;
    }
  }

  update(dt: number, alpha: number): void {
    const visual = this.visual;
    const obj = this.object;
    if (!this.active || !visual || !obj || !this.build) return;
    this.interp.apply(obj, alpha);
    const s = this.state;
    s.position.copy(obj.position);
    s.quaternion.copy(obj.quaternion);
    s.forward.set(0, 0, 1).applyQuaternion(obj.quaternion);

    // Wheels: suspension travel, steering, spin, camber; world contact points for fx
    const P = this.params;
    const camber = (clamp(this.build.stance?.camber ?? 0, 0, 1) * CONFIG.vehicle.wheelVisual.camberMaxDeg * Math.PI) / 180;
    for (let i = 0; i < 4; i++) {
      const wv = visual.wheels[i];
      const ws = s.wheels[i];
      const len = lerp(this.suspPrev[i], this.suspCurr[i], alpha);
      const wp = visual.dims.wheelPositions[i];
      if (wv) {
        wv.pivot.position.y = this.hardY[i] - len;
        wv.pivot.rotation.y = i < 2 ? this.steerAngle : 0;
        wv.pivot.rotation.z = wp.x > 0 ? camber : -camber; // left (+X) wheels: + tilts the top inward
        this.spinAngle[i] = (this.spinAngle[i] + this.spinVel[i] * dt) % (Math.PI * 2);
        wv.spin.rotation.x = this.spinAngle[i];
      }
      ws.position.set(wp.x, this.hardY[i] - len - P.wheelRadius, wp.z).applyQuaternion(obj.quaternion).add(obj.position);
      if (this.contact[i]) ws.normal.copy(this.wheelNormal[i]);
      else ws.normal.set(0, 1, 0).applyQuaternion(obj.quaternion);
    }
    this.debris.update(alpha);

    if (s.exploded && this.charT < 1) {
      this.charT = Math.min(1, this.charT + dt / Math.max(0.05, CONFIG.vehicle.explosion.charTime));
      visual.setCharred(this.charT);
    }

    // Headlights: automatic at night / in fog / tunnels; 'lights' cycles low → high → auto
    const H = CONFIG.vehicle.headlights;
    const autoOn = (this.ctx.env?.nightFactor ?? 0) > H.autoNight || (this.ctx.env?.weather?.fog ?? 0) > H.autoFog || this.inTunnel;
    if (this.ctx.input.consume('lights')) this.headlights?.cycle(autoOn);
    s.headlights = this.headlights ? this.headlights.update(obj, this.halfLength, autoOn, !s.exploded) : 'off';
    this.updateLights();
    visual.update(dt);
  }

  private updateLights(): void {
    const visual = this.visual;
    if (!visual || !this.build) return;
    const s = this.state;
    const L = this.lastLights;
    const brake = !s.exploded && this.brakePedal > 0.05;
    const reverse = !s.exploded && this.reverse;
    const headlights = !s.exploded && s.headlights !== 'off';
    const underglow = !s.exploded && !!this.build.extras.underglow;
    if (this.lightsDirty || brake !== L.brake || reverse !== L.reverse || headlights !== L.headlights || underglow !== L.underglow) {
      L.brake = brake;
      L.reverse = reverse;
      L.headlights = headlights;
      L.underglow = underglow;
      this.lightsDirty = false;
      visual.setLights(L);
    }
  }

  private setPrompt(show: boolean): void {
    if (show === this.promptShown) return;
    this.promptShown = show;
    this.ctx.events.emit('prompt', show ? { id: 'flip', show: true, text: 'Flip car' } : { id: 'flip', show: false });
  }

  private currentYaw(): number {
    const body = this.chassis;
    if (!body) return Math.atan2(this.state.forward.x, this.state.forward.z);
    const r = body.rotation(this.rq);
    this.q.set(r.x, r.y, r.z, r.w);
    const f = this.v1.set(0, 0, 1).applyQuaternion(this.q);
    if (Math.hypot(f.x, f.z) > 0.25) return Math.atan2(f.x, f.z);
    const u = this.v2.set(0, 1, 0).applyQuaternion(this.q);
    const sg = f.y < 0 ? 1 : -1;
    return Math.atan2(u.x * sg, u.z * sg);
  }

  // ─────────────────────────────── damage / stunt hooks ───────────────────────────────
  onChassisHit(belly: boolean): void {
    if (!belly) this.stunts.chassisContact();
  }

  crashLanding(impactSpeed: number): void {
    if (this.state.exploded) return;
    const S = CONFIG.vehicle.stunts;
    this.damage.crash(Math.min(1, Math.max(0.3, impactSpeed / S.crashExplodeSpeed)) * S.crashDamage);
    this.ctx.events.emit('vibrate', { pattern: [60, 30, 90] });
    if (impactSpeed > S.crashExplodeSpeed) {
      if (this.ctx.game.state === 'driving') this.ctx.game.explodeOrReset();
      else this.explode();
    }
  }

  hangBumper(end: 'F' | 'R'): void {
    const part = this.findPart(end === 'F' ? /bumper.?f|front.?bumper|bumperfront/i : /bumper.?r|rear.?bumper|bumperrear/i, end === 'F' ? 'bumperF' : 'bumperR');
    if (!part || !part.obj.parent) return;
    const obj = part.obj;
    this.rememberPristine(obj);
    // droop: drop one side and tilt, around the part's own bounds centre
    const box = new THREE.Box3().setFromObject(obj);
    const centerW = box.getCenter(new THREE.Vector3());
    const center = obj.parent!.worldToLocal(centerW.clone());
    const side = Math.random() < 0.5 ? -1 : 1;
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(end === 'F' ? 0.12 : -0.12, 0, 0.1 * side));
    obj.position.sub(center).applyQuaternion(rot).add(center);
    obj.position.y -= 0.05;
    obj.quaternion.premultiply(rot);
    this.ctx.events.emit('partDetached', { part: part.name + ':hang', position: centerW });
  }

  detachBumper(end: 'F' | 'R'): void {
    const part = this.findPart(end === 'F' ? /bumper.?f|front.?bumper|bumperfront/i : /bumper.?r|rear.?bumper|bumperrear/i, end === 'F' ? 'bumperF' : 'bumperR');
    if (!part || !this.chassis) return;
    const v = this.chassis.linvel(this.rv);
    const dir = this.state.forward;
    const sgn = end === 'F' ? 1 : -1;
    this.detachAsDebris(part.name, this.v1.set(v.x - dir.x * sgn * 1.5, v.y + 1.2, v.z - dir.z * sgn * 1.5), this.v2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4));
  }

  private findPart(re: RegExp, preferred: string): { name: string; obj: THREE.Object3D } | null {
    const parts = this.visual?.parts;
    if (!parts) return null;
    if (parts[preferred]) return { name: preferred, obj: parts[preferred] };
    for (const name of Object.keys(parts)) if (re.test(name)) return { name, obj: parts[name] };
    return null;
  }

  private rememberPristine(obj: THREE.Object3D): void {
    if (!this.pristine.has(obj)) this.pristine.set(obj, { p: obj.position.clone(), q: obj.quaternion.clone(), s: obj.scale.clone() });
  }

  /** Detach a named visual part into a physics debris piece. */
  private detachAsDebris(name: string, linvel: THREE.Vector3, angvel: THREE.Vector3): boolean {
    const visual = this.visual;
    if (!visual) return false;
    const part = visual.parts[name];
    if (!part || !part.parent) return false;
    this.rememberPristine(part);
    visual.root.updateMatrixWorld(true);
    this.m4.copy(part.matrixWorld);
    const obj = visual.detachPart(name);
    if (!obj) return false;
    this.m4.decompose(obj.position, obj.quaternion, obj.scale);
    this.ctx.engine.scene.add(obj);
    this.debris.spawn(obj, 'part', /bumper|spoiler|wing/i.test(name) ? 'plastic' : 'metal', linvel, angvel);
    this.ctx.events.emit('partDetached', { part: name, position: obj.position });
    return true;
  }

  // ─────────────────────────────── explode / reset / flip ───────────────────────────────
  explode(): void {
    const body = this.chassis;
    const visual = this.visual;
    if (!this.active || !body || !visual || this.state.exploded) return;
    if (this.flipAnim) this.endFlip();
    if (this.frozen) this.unfreeze();
    const X = CONFIG.vehicle.explosion;
    const s = this.state;
    s.exploded = true;
    this.turbo.cut();
    this.stunts.reset();
    this.setPrompt(false);
    this.stuckT = 0;
    const com = body.worldCom(this.rv);
    const center = new THREE.Vector3(com.x, com.y, com.z);

    // Push what's around (props, parked cars, earlier debris) before our own debris exists.
    this.ctx.physics.applyRadialImpulse(center, X.radius, X.radialStrength, G.PROP | G.PARKED | G.DEBRIS, X.radialUpBias);

    // Detach panels and wheels → debris flying outward
    const lv = body.linvel(this.rv);
    const carVel = new THREE.Vector3(lv.x, lv.y, lv.z);
    visual.root.updateMatrixWorld(true);
    const rnd = () => Math.random() * 2 - 1;
    const outward = (p: THREE.Vector3, out: THREE.Vector3) => {
      out.copy(p).sub(center);
      out.y = 0;
      if (out.lengthSq() < 1e-4) out.set(rnd(), 0, rnd());
      out.normalize();
      return out
        .multiplyScalar(X.debrisSpeed * (0.6 + Math.random() * 0.6))
        .add(carVel)
        .add(new THREE.Vector3(0, X.debrisUp * (0.6 + Math.random() * 0.6), 0));
    };
    for (const name of Object.keys(visual.parts)) {
      if (!DETACH_ON_EXPLODE.test(name)) continue;
      const part = visual.parts[name];
      if (!part?.parent) continue;
      const wp = part.getWorldPosition(new THREE.Vector3());
      this.detachAsDebris(name, outward(wp, new THREE.Vector3()), new THREE.Vector3(rnd(), rnd(), rnd()).multiplyScalar(X.debrisSpin));
    }
    for (let i = 0; i < visual.wheels.length; i++) {
      const wv = visual.wheels[i];
      if (!wv || !wv.pivot.visible) continue;
      wv.spin.updateWorldMatrix(true, false);
      const clone = wv.spin.clone(true);
      wv.spin.matrixWorld.decompose(clone.position, clone.quaternion, clone.scale);
      this.ctx.engine.scene.add(clone);
      wv.pivot.visible = false;
      this.debris.spawn(clone, 'clone', 'plastic', outward(clone.position, new THREE.Vector3()), new THREE.Vector3(rnd(), rnd(), rnd()).multiplyScalar(X.debrisSpin), 18);
      this.ctx.events.emit('partDetached', { part: 'wheel' + WHEEL_NAMES[i], position: clone.position });
    }

    // Throw the chassis up, tumbling. The controller is no longer updated: it's just a rigid body now.
    const m = this.params.mass;
    body.applyImpulse({ x: rnd() * X.sideSpeed * m, y: X.upSpeed * m, z: rnd() * X.sideSpeed * m }, true);
    const av = body.angvel(this.rv);
    body.setAngvel({ x: av.x + rnd() * X.spin, y: av.y + rnd() * X.spin * 0.6, z: av.z + rnd() * X.spin }, true);
    for (let i = 0; i < 4; i++) {
      this.controller?.setWheelEngineForce(i, 0);
      this.controller?.setWheelBrake(i, 0);
      this.contact[i] = false;
      s.wheels[i].contact = false;
      s.wheels[i].slip = 0;
    }
    this.drivePedal = this.brakePedal = 0;
    this.charT = 0;
    this.fire?.stop();
    this.fire = this.ctx.fx.attachFire(visual.root, new THREE.Vector3(0, visual.dims.colliderOffset.y + visual.dims.halfExtents.y * 0.6, visual.dims.halfExtents.z * 0.35), 1);
    this.lightsDirty = true;
    this.ctx.events.emit('explosion', { position: center, radius: X.radius, force: X.force });
    this.ctx.events.emit('vibrate', { pattern: [120, 50, 220] });
  }

  reset(pose?: Pose): void {
    const body = this.chassis;
    if (!this.active || !body || !this.build || !this.visual) return;
    if (this.flipAnim) this.endFlip();
    const p = pose ?? this.ctx.world.findRespawn(this.state.position, this.currentYaw());
    this.restoreCar();
    this.placeAt(p);
  }

  /** Remove debris & fire, repair the visual, restore wheels/parts, reset damage and driving state. */
  private restoreCar(): void {
    const visual = this.visual!;
    const parts = this.debris.clear();
    this.fire?.stop();
    this.fire = null;
    visual.repair();
    visual.setCharred(0);
    for (const wv of visual.wheels) if (wv) wv.pivot.visible = true;
    // Parts we moved (hung) or detached: restore their local transform if the visual took them back.
    for (const [obj, pr] of this.pristine) {
      if (obj.parent && obj.parent !== this.ctx.engine.scene) {
        obj.position.copy(pr.p);
        obj.quaternion.copy(pr.q);
        obj.scale.copy(pr.s);
      }
    }
    this.pristine.clear();
    // Detached parts repair() did not take back are orphans: free what the car no longer uses.
    const orphans = parts.filter((o) => !o.parent);
    if (orphans.length) {
      const used = collectResources(visual.root);
      for (const o of orphans) disposeUnused(o, used);
    }
    this.damage.reset();
    this.stunts.reset();
    this.turbo.cut();
    this.state.exploded = false;
    this.charT = 1;
    this.resetRequested = false;
    this.lightsDirty = true;
  }

  /** Teleport upright and still onto `pose` (ground position), reset the driving state, freeze until terrain is ready. */
  private placeAt(pose: Pose): void {
    const body = this.chassis;
    if (!body) return;
    const P = this.params;
    const C = CONFIG.vehicle.chassis;
    const qy = new THREE.Quaternion().setFromAxisAngle(UP, pose.yaw);
    const y = pose.position.y + P.rideOffset + C.spawnLift;
    body.setTranslation({ x: pose.position.x, y, z: pose.position.z }, true);
    body.setRotation({ x: qy.x, y: qy.y, z: qy.z, w: qy.w }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.resetForces(true);
    body.resetTorques(true);
    this.interp.reset(body);
    if (this.object) this.interp.apply(this.object, 1);
    const s = this.state;
    s.position.set(pose.position.x, y, pose.position.z);
    s.quaternion.copy(qy);
    s.forward.set(Math.sin(pose.yaw), 0, Math.cos(pose.yaw));
    s.velocity.set(0, 0, 0);
    s.speed = s.speedKmh = 0;
    s.exploded = false;
    s.airborne = false;
    s.upsideDown = false;
    this.preVelocity.set(0, 0, 0);
    this.drivetrain.reset(P);
    s.gear = 1;
    s.rpm = P.idleRpm;
    s.rpmNorm = 0;
    s.boost = 0;
    this.throttleS = this.brakeS = this.steerS = this.steerAngle = 0;
    this.reverse = false;
    this.dirTimer = 0;
    this.rearSide = 1;
    this.esc = 1;
    this.airTime = 0;
    this.stuckT = 0;
    this.aquaT = 0;
    this.latAcc = 0;
    this.landingN.copy(UP);
    this.stunts.reset();
    this.setPrompt(false);
    const g = Math.abs(CONFIG.physics.gravity);
    const eq = P.restLength - Math.min(P.travel * 0.9, g / (4 * Math.max(1, P.stiffness)));
    for (let i = 0; i < 4; i++) {
      this.suspPrev[i] = this.suspCurr[i] = eq;
      this.contact[i] = false;
      this.suspForce[i] = 0;
      this.spinVel[i] = 0;
      s.wheels[i].slip = 0;
      s.wheels[i].contact = false;
    }
    this.frozen = null;
    this.freezeHere(false);
    this.stepFrozen(0, (this.ctx.game.mode ?? 'car') === 'car'); // unfreezes at once when terrain is already there
  }

  // ─────────────────────────────── terrain-ready freeze ───────────────────────────────
  private freezeHere(park: boolean): void {
    const body = this.chassis;
    if (!body || this.frozen) return;
    const t = body.translation();
    this.frozen = { t: 0, x: t.x, y: t.y, z: t.z, park };
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    body.setEnabled(false);
  }

  private terrainReady(x: number, z: number): boolean {
    try {
      return this.ctx.terrain?.isReady ? this.ctx.terrain.isReady(x, z, CONFIG.vehicle.freeze.radius) : true;
    } catch {
      return true;
    }
  }

  private stepFrozen(dt: number, carMode: boolean): void {
    const f = this.frozen;
    if (!f) return;
    f.t += dt;
    if (f.park && !carMode) return; // the player is flying: stay parked
    if (this.terrainReady(f.x, f.z) || f.t >= CONFIG.vehicle.freeze.maxTime) this.unfreeze();
  }

  /** Re-enable the chassis, snapped onto the (now loaded) ground under it. */
  private unfreeze(): void {
    const body = this.chassis;
    const f = this.frozen;
    this.frozen = null;
    if (!body || !f) return;
    const P = this.params;
    const lift = P.rideOffset + CONFIG.vehicle.chassis.spawnLift;
    const flt = groups(G.ALL, G.WORLD);
    const cast = (fromY: number, len: number) => {
      this.ray.origin.x = f.x;
      this.ray.origin.y = fromY;
      this.ray.origin.z = f.z;
      this.ray.dir.x = 0;
      this.ray.dir.y = -1;
      this.ray.dir.z = 0;
      const hit = this.ctx.physics.world.castRay(this.ray, len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, flt, undefined, body);
      return hit ? fromY - hit.timeOfImpact : null;
    };
    // ground near the expected height first (no snapping onto a bridge above), else the first surface from high above
    const base = f.y - lift;
    const g = cast(base + 2.5, 10) ?? cast(base + 600, 1500);
    const y = (g ?? base) + lift;
    body.setEnabled(true);
    body.setTranslation({ x: f.x, y: f.park ? Math.max(y, f.y) : y, z: f.z }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.interp.reset(body);
    if (this.object) this.interp.apply(this.object, 1);
    this.state.position.set(f.x, y, f.z);
  }

  flip(): void {
    const body = this.chassis;
    if (!this.active || !body || this.state.exploded || this.flipAnim || this.frozen) return;
    const R = CONFIG.vehicle.recovery;
    const t = body.translation();
    const r = body.rotation();
    const yaw = this.currentYaw();
    // ground under the car (ignoring the car itself)
    let groundY = t.y - 1;
    try {
      groundY = this.ctx.world.groundHeightAt(t.x, t.z);
    } catch {
      /* world not ready */
    }
    this.ray.origin.x = t.x;
    this.ray.origin.y = t.y + 1.5;
    this.ray.origin.z = t.z;
    this.ray.dir.x = 0;
    this.ray.dir.y = -1;
    this.ray.dir.z = 0;
    const hit = this.ctx.physics.world.castRay(this.ray, 12, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.ALL, G.WORLD), undefined, body);
    if (hit) groundY = t.y + 1.5 - hit.timeOfImpact;
    this.flipAnim = {
      t: 0,
      fromP: new THREE.Vector3(t.x, t.y, t.z),
      fromQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      toP: new THREE.Vector3(t.x, Math.max(groundY + R.flipLift + this.params.rideOffset, t.y + 0.3), t.z),
      toQ: new THREE.Quaternion().setFromAxisAngle(UP, yaw),
    };
    body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.stuckT = 0;
    this.setPrompt(false);
  }

  private stepFlip(dt: number): void {
    const a = this.flipAnim!;
    const body = this.chassis!;
    a.t = Math.min(1, a.t + dt / Math.max(0.05, CONFIG.vehicle.recovery.flipDuration));
    const e = a.t * a.t * (3 - 2 * a.t);
    const lift = Math.sin(Math.PI * a.t) * 0.4;
    const p = this.v1.lerpVectors(a.fromP, a.toP, e);
    p.y += lift;
    const q = new THREE.Quaternion().slerpQuaternions(a.fromQ, a.toQ, e);
    body.setNextKinematicTranslation(p);
    body.setNextKinematicRotation(q);
    if (a.t >= 1) this.endFlip();
  }

  private endFlip(): void {
    const body = this.chassis;
    this.flipAnim = null;
    if (!body) return;
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.applyMassProps(true);
    this.rearSide = 1;
    this.esc = 1;
  }
}

/** Geometries and materials used under `root`. */
function collectResources(root: THREE.Object3D): Set<unknown> {
  const used = new Set<unknown>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) used.add(mesh.geometry);
    const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (mat) for (const mm of Array.isArray(mat) ? mat : [mat]) used.add(mm);
  });
  return used;
}

/** Dispose geometries/materials (and their textures) of `root` that aren't in `keep` (shared with the car). */
function disposeUnused(root: THREE.Object3D, keep: Set<unknown> | null): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !keep?.has(mesh.geometry)) mesh.geometry.dispose();
    const mat = (mesh as { material?: THREE.Material | THREE.Material[] }).material;
    if (!mat) return;
    for (const mm of Array.isArray(mat) ? mat : [mat]) {
      if (keep?.has(mm)) continue;
      for (const v of Object.values(mm)) if (v instanceof THREE.Texture) v.dispose();
      mm.dispose();
    }
  });
}
