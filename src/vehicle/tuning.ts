import { CONFIG } from '../config';
import type { CarBuild, CarModelId } from './CarBuild';

/**
 * Build → physics parameters and garage stat bars (spec §7 Performance). Owner: src/vehicle.
 *
 * Every number comes from CONFIG.vehicle (read at call time, so the ?debug panel tunes live). The player vehicle calls
 * resolveParams() every fixed step into a reused object; computeStats() runs the same params through a small
 * longitudinal simulation so the garage bars always agree with what the car actually does.
 */
export interface CarStats {
  topSpeedKmh: number; // predicted top speed
  topSpeed: number; // 0..1 bar
  accel: number; // 0..1 bar
  grip: number; // 0..1 bar
  braking: number; // 0..1 bar
}

/** Fully resolved physics parameters for one build (+ actual model dimensions when spawned). */
export interface VehicleParams {
  model: CarModelId;
  mass: number; // kg
  wheelRadius: number; // m
  // engine
  peakTorque: number; // Nm
  idleRpm: number;
  redlineRpm: number;
  launchRpm: number;
  turbo: number; // extra torque fraction at full boost (0 = no turbo)
  // gearbox
  gears: number[]; // 5 forward ratios
  reverseRatio: number;
  finalDrive: number; // effective (already scaled by wheel radius / ref radius)
  efficiency: number;
  maxReverseSpeed: number; // m/s
  // resistances
  drag: number; // N per (m/s)²
  rolling: number; // N
  downforce: number; // N per (m/s)²
  engineBraking: number; // N at redline
  // brakes
  brakeForce: number; // N total at full pedal
  brakeFrontBias: number;
  // tyres
  gripFront: number; // Rapier friction slip (≈ μ)
  gripRear: number;
  sideFront: number; // Rapier side friction stiffness
  sideRear: number;
  // suspension
  restLength: number; // includes ride height offset
  rideOffset: number; // m the body sits higher (+) / lower (-) than stock
  travel: number;
  stiffness: number;
  compression: number;
  relaxation: number;
  maxSuspForce: number; // N per wheel
  rollAssist: number; // multiplier on anti-roll assist
  // chassis
  comHeight: number;
  comForward: number;
  driveFront: number; // 0 = RWD, 1 = FWD, between = AWD split
  steerMax: number; // rad at standstill
}

export function createParams(): VehicleParams {
  return {
    model: 'coupe', mass: 1300, wheelRadius: 0.34,
    peakTorque: 300, idleRpm: 900, redlineRpm: 7000, launchRpm: 3400, turbo: 0,
    gears: [3, 2, 1.5, 1.2, 1], reverseRatio: 3.3, finalDrive: 4, efficiency: 0.88, maxReverseSpeed: 10,
    drag: 0.8, rolling: 200, downforce: 2, engineBraking: 1500,
    brakeForce: 12000, brakeFrontBias: 0.64,
    gripFront: 1.5, gripRear: 1.5, sideFront: 1, sideRear: 1,
    restLength: 0.32, rideOffset: 0, travel: 0.22, stiffness: 38, compression: 2.7, relaxation: 3.9, maxSuspForce: 1e5, rollAssist: 1,
    comHeight: 0.4, comForward: 0.08, driveFront: 0, steerMax: 0.6,
  };
}

const lvl = (level: number, l1: number, l2: number) => (level >= 2 ? l2 : level >= 1 ? l1 : 1);

/**
 * Resolve the physics parameters of a build. `dims` = the spawned visual's real mass / wheel radius (falls back to the
 * model's reference values for the garage stats). Writes into `out` (no allocation when reused).
 */
export function resolveParams(build: CarBuild, dims?: { mass: number; wheelRadius: number } | null, out: VehicleParams = createParams()): VehicleParams {
  const V = CONFIG.vehicle;
  const m = V.models[build.model] ?? V.models.coupe;
  const pf = V.perf;
  const perf = build.perf;
  const E = V.engine;
  const S = V.suspension;
  const g = Math.abs(CONFIG.physics.gravity);

  const mass = dims?.mass && dims.mass > 50 ? dims.mass : m.refMass;
  const radius = dims?.wheelRadius && dims.wheelRadius > 0.1 ? dims.wheelRadius : E.refWheelRadius;
  const tons = mass / 1000;

  out.model = build.model;
  out.mass = mass;
  out.wheelRadius = radius;

  // Engine
  out.peakTorque = m.torque * tons * lvl(perf.engine, pf.engineTorque1, pf.engineTorque2);
  out.idleRpm = E.idleRpm;
  out.redlineRpm = m.redline + (perf.engine >= 2 ? pf.engineRedline2 : perf.engine >= 1 ? pf.engineRedline1 : 0);
  out.launchRpm = Math.min(E.launchRpm, out.redlineRpm * 0.7);
  out.turbo = perf.engine >= 2 ? pf.turbo2 : perf.engine >= 1 ? pf.turbo1 : 0;

  // Gearbox — final drive scaled with wheel radius so wheel size doesn't change the gearing.
  for (let i = 0; i < 5; i++) out.gears[i] = E.gears[i] ?? 1;
  out.reverseRatio = E.reverseRatio;
  out.finalDrive = m.finalDrive * lvl(perf.engine, pf.engineFinal1, pf.engineFinal2) * (radius / E.refWheelRadius);
  out.efficiency = E.efficiency;
  out.maxReverseSpeed = E.maxReverseKmh / 3.6;

  // Resistances
  out.drag = m.drag * tons;
  out.rolling = V.aero.rolling * mass * g;
  out.downforce = V.aero.downforce * m.downforce * tons;
  out.engineBraking = E.engineBraking * mass;

  // Brakes
  out.brakeForce = V.brakes.decel * m.brake * lvl(perf.brakes, pf.brake1, pf.brake2) * mass;
  out.brakeFrontBias = V.brakes.frontBias;

  // Tyres (suspension upgrades add a little mechanical grip too)
  const tyreGrip = lvl(perf.tyres, pf.tyreGrip1, pf.tyreGrip2) * lvl(perf.suspension, pf.suspGrip1, pf.suspGrip2);
  const tyreSide = lvl(perf.tyres, pf.tyreSide1, pf.tyreSide2);
  out.gripFront = m.gripFront * tyreGrip;
  out.gripRear = m.gripRear * tyreGrip;
  out.sideFront = m.sideFront * tyreSide;
  out.sideRear = m.sideRear * tyreSide;

  // Suspension
  out.rideOffset = (build.stance?.rideHeight ?? 0) * S.rideHeightRange;
  out.restLength = Math.max(0.12, S.restLength + out.rideOffset);
  out.travel = Math.min(S.travel, out.restLength - 0.04);
  out.stiffness = S.stiffness * m.stiffness * lvl(perf.suspension, pf.suspStiff1, pf.suspStiff2);
  const damp = m.damping * lvl(perf.suspension, pf.suspDamp1, pf.suspDamp2);
  out.compression = S.compression * damp;
  out.relaxation = S.relaxation * damp;
  out.maxSuspForce = S.maxForceG * mass * g;
  out.rollAssist = lvl(perf.suspension, pf.suspRoll1, pf.suspRoll2);

  // Chassis
  out.comHeight = m.comHeight;
  out.comForward = V.chassis.comForward;
  out.driveFront = m.driveFront;
  out.steerMax = m.steerMax;
  return out;
}

/** Normalised engine torque (0..1) at rpm/redline = n. */
export function torqueFactor(n: number): number {
  const c = CONFIG.vehicle.engine.torqueCurve;
  const xs = TORQUE_X;
  if (n <= 0) return c[0];
  for (let i = 1; i < xs.length; i++) {
    if (n <= xs[i]) {
      const t = (n - xs[i - 1]) / (xs[i] - xs[i - 1]);
      return c[i - 1] + (c[i] - c[i - 1]) * t;
    }
  }
  return c[c.length - 1];
}
const TORQUE_X = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 1];

/** Engine rpm for a road speed (m/s) in a gear (ratio). */
export function rpmAtSpeed(p: VehicleParams, ratio: number, speed: number): number {
  return (Math.abs(speed) / (2 * Math.PI * p.wheelRadius)) * 60 * ratio * p.finalDrive;
}

/** Drive force (N) at the wheels at full throttle for an engine rpm and gear ratio. */
export function forceAtRpm(p: VehicleParams, ratio: number, rpm: number, boost = 1): number {
  if (rpm > p.redlineRpm) return 0;
  const torque = p.peakTorque * torqueFactor(rpm / p.redlineRpm) * (1 + boost * p.turbo);
  return (torque * ratio * p.finalDrive * p.efficiency) / p.wheelRadius;
}

/** Total drive force (N) at full throttle and a road speed in a given gear (no turbo lag: full boost). */
export function driveForceAt(p: VehicleParams, gearIndex: number, speed: number, boost = 1): number {
  const ratio = p.gears[gearIndex];
  return forceAtRpm(p, ratio, Math.max(p.idleRpm, rpmAtSpeed(p, ratio, speed)), boost);
}

/** Predicted top speed (m/s): highest speed where some gear's drive force still beats drag + rolling resistance. */
export function predictTopSpeed(p: VehicleParams): number {
  let top = 0;
  for (let v = 5; v < 120; v += 0.25) {
    const resist = p.drag * v * v + p.rolling;
    let best = 0;
    for (let gi = 0; gi < 5; gi++) best = Math.max(best, driveForceAt(p, gi, v));
    if (best >= resist) top = v;
    else if (top > 0) break;
  }
  return top;
}

/** Simulated 0-100 km/h time (s), same shift logic/torque cut as the drivetrain. */
export function simulateZeroToHundred(p: VehicleParams): number {
  const E = CONFIG.vehicle.engine;
  const dt = 1 / 60;
  let v = 0;
  let gear = 0;
  let shiftT = 0;
  let boost = 0;
  for (let t = 0; t < 30; t += dt) {
    const ratio = p.gears[gear];
    let rpm = rpmAtSpeed(p, ratio, v);
    if (gear === 0) rpm = Math.max(rpm, p.launchRpm);
    if (shiftT <= 0 && gear < 4 && rpm > E.shiftUp * p.redlineRpm) {
      gear++;
      shiftT = E.shiftTime;
    }
    boost = p.turbo > 0 && rpm > 0.4 * p.redlineRpm ? Math.min(1, boost + E.turboSpool * dt) : Math.max(0, boost - E.turboDecay * dt);
    let force = 0;
    if (shiftT > 0) shiftT -= dt;
    else force = forceAtRpm(p, ratio, Math.max(p.idleRpm, rpm), boost);
    force -= p.drag * v * v + p.rolling;
    v += (force / p.mass) * dt;
    if (v >= 100 / 3.6) return t;
  }
  return 30;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const statParams = createParams();

export function computeStats(build: CarBuild): CarStats {
  const p = resolveParams(build, null, statParams);
  const top = predictTopSpeed(p) * 3.6;
  const t100 = simulateZeroToHundred(p);
  const mu = (p.gripFront + p.gripRear) * 0.5 * Math.sqrt((p.sideFront + p.sideRear) * 0.5);
  const decel = p.brakeForce / p.mass;
  return {
    topSpeedKmh: Math.round(top),
    topSpeed: clamp01((top - 140) / (250 - 140)),
    accel: clamp01((11 - t100) / (11 - 3.5)),
    grip: clamp01((mu - 1.0) / (2.0 - 1.0)),
    braking: clamp01((decel - 6) / (15 - 6)),
  };
}
