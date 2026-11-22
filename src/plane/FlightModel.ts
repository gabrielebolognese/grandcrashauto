import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { clamp, lerp, smoothstep, DEG } from '../core/math';
import type { PlaneTypeId, PlaneVisual } from './types';

/**
 * Flight model (SPEC-PART2 §6) for ONE Rapier rigid body. Owner: flight.
 *
 * Body-local frame (= PlaneVisual root): nose +Z, LEFT wing +X, up +Y, origin = centre of mass.
 * Pilot axes used below: pitch-up = rotation about -X, roll-right = about +Z, yaw-right = about -Y.
 *
 * Aerodynamics are a small set of lifting surfaces evaluated at their own points with the local air velocity
 * (v_air + ω × r), so the classic behaviours come out of the physics instead of being scripted:
 *  - two wing halves (dihedral, roll damping, asymmetric stall → wing drop / spin), CL(α) linear up to the stall
 *    angle then a sharp drop to a flat-plate curve, flaps raise CL and CLmax, ground effect;
 *  - left/right tailplane (pitch stability + pitch damping, trimmed by a solved incidence) and a fin (weathervane,
 *    yaw damping, side force). Remove them (tail destroyed) and the destabilising wing/fuselage moments win;
 *  - parasite + induced + gear + flap + wave + damage drag, fuselage Munk moments, camber moment.
 * Controls are torques = deflection × authority × dynamic pressure (clamped), so they are mushy near the stall and
 * crisp at speed. Assists (Assisted mode) are pilot models that move the virtual stick: flight-path hold, pitch-rate
 * command, bank-angle command with soft limits, coordinated turns, stall nudge, rotation help and flare.
 */

export type PlaneCfg = (typeof CONFIG.planes)['prop'];
export const planeCfg = (t: PlaneTypeId): PlaneCfg => CONFIG.planes[t] as PlaneCfg;

interface Surface {
  kind: 'wing' | 'htail' | 'fin';
  pos: THREE.Vector3;
  base: THREE.Vector3;
  n: THREE.Vector3;
  c: THREE.Vector3;
  area: number;
  alive: number; // 0..1 remaining area
  inc: number; // incidence (rad)
  side: number; // +1 left, -1 right, 0 centre
  segs: { part: string; frac: number; lost: boolean }[];
  stalled: number; // 0..1 (telemetry)
}

/** What the plane system feeds the model every fixed step. */
export interface FlightInputs {
  pitch: number; // +1 pull
  roll: number; // +1 right
  yaw: number; // +1 right
  assisted: boolean;
  assistFactor: number; // 0..1 (damage switches assists off progressively)
  onGround: boolean;
  agl: number; // wing height above ground / water
  wheelAgl: number; // lowest wheel above ground
  gear: number; // 0 up .. 1 down
  gearDown: boolean;
  flaps: number;
  thrust: number[]; // N per engine (visual.engines order)
  liftScale: number; // ceiling / failure lift multiplier
  extraCd: number; // damage drag coefficient (× wing area)
  sideDrag: { point: THREE.Vector3; cdA: number }[]; // asymmetric drag (fire spread, open structure), local points
  noseDown: number; // rad/s² forced nose-down (out-of-map failure)
  gammaCap: number; // rad: hands-off flight path cap (failure pushes it down); 99 = none
  turb: THREE.Vector3; // angular accel jolts (pitchUp, yawRight, rollRight) rad/s²
  turbVert: number; // m/s² vertical gust
  wind: THREE.Vector3; // world m/s
  controlScale: THREE.Vector3; // pitch, yaw, roll authority multipliers (damage)
  tailLost: boolean;
  tailTime: number; // s since the tail was lost (oscillation growth)
  rotationHelp: boolean;
}

export function defaultInputs(): FlightInputs {
  return {
    pitch: 0, roll: 0, yaw: 0, assisted: true, assistFactor: 1, onGround: true, agl: 0, wheelAgl: 0, gear: 1, gearDown: true,
    flaps: 0.5, thrust: [], liftScale: 1, extraCd: 0, sideDrag: [], noseDown: 0, gammaCap: 99,
    turb: new THREE.Vector3(), turbVert: 0, wind: new THREE.Vector3(), controlScale: new THREE.Vector3(1, 1, 1),
    tailLost: false, tailTime: 0, rotationHelp: true,
  };
}

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _vl = new THREE.Vector3();
const _wl = new THREE.Vector3();
const _vp = new THREE.Vector3();
const _f = new THREE.Vector3();
const _t = new THREE.Vector3();
const _F = new THREE.Vector3();
const _M = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class FlightModel {
  readonly cfg: PlaneCfg;
  readonly surfaces: Surface[] = [];
  mass: number;
  readonly inertia = new THREE.Vector3();
  /** Centre of mass offset from the body origin after parts were lost (local). */
  readonly comOffset = new THREE.Vector3();
  // derived
  readonly S: number;
  readonly span: number;
  readonly chord: number;
  readonly k: number;
  readonly rho: number;
  readonly vStall: number; // m/s clean
  readonly vRot: number;
  readonly vTop: number;
  readonly clMax: number;
  readonly alphaStallBody: number; // rad (wing stall angle minus incidence)
  qRef = 1;
  Ap = 1; // pitch authority rad/s² per unit stick at qRef (× inertia)
  Ar = 1;
  Ay = 1;
  tailIncidence = 0;
  mainGearArm = 0; // m: main gear behind the CoM (rotation torque)
  tailStrikePitch = 0.2; // rad
  // telemetry (updated every step)
  airspeed = 0;
  qdyn = 0;
  qn = 0;
  alpha = 0;
  beta = 0;
  pitch = 0;
  bank = 0;
  gamma = 0;
  heading = 0;
  p = 0;
  qRate = 0;
  r = 0;
  stall = false;
  stallWarning = false;
  readonly controls = { elevator: 0, aileron: 0, rudder: 0 };
  /** Stabilizer trim (rad, added to the tailplane incidence): auto-trim drives the steady elevator to zero. */
  trim = 0;
  /** Test hook: disable the assisted stall nudge (stall-speed measurement). */
  noStallNudge = false;
  // assist state
  gammaHold = 0;
  private stickWasActive = false;
  private stallBias = 0;
  private wasStalled = false;
  private engines: { point: THREE.Vector3 }[];

  constructor(
    readonly type: PlaneTypeId,
    visual: PlaneVisual,
  ) {
    const cfg = (this.cfg = planeCfg(type));
    const P = CONFIG.planes;
    this.rho = P.airDensity;
    this.mass = cfg.mass;
    this.S = cfg.wingArea;
    this.span = cfg.span;
    this.chord = this.S / this.span;
    const AR = (this.span * this.span) / this.S;
    this.k = 1 / (Math.PI * cfg.oswald * AR);
    this.clMax = cfg.cl0 + cfg.clAlpha * cfg.stallDeg * DEG;
    this.alphaStallBody = (cfg.stallDeg - cfg.incidenceDeg) * DEG;
    this.vStall = cfg.stallKmh / 3.6;
    this.vRot = cfg.rotationKmh / 3.6;
    this.vTop = cfg.topKmh / 3.6;
    this.engines = visual.engines.map((e) => ({ point: e.thrustPoint.clone() }));

    // Inertia: from the visual (box model), with a sane fallback and per-plane character scale.
    const vi = visual.inertia;
    const L = visual.dims.length || 10;
    const fallback = this.mass * L * L * 0.05;
    const s = cfg.inertiaScale;
    this.inertia.set(
      (Number.isFinite(vi.x) && vi.x > 0 ? vi.x : fallback) * s[0],
      (Number.isFinite(vi.y) && vi.y > 0 ? vi.y : fallback * 1.4) * s[1],
      (Number.isFinite(vi.z) && vi.z > 0 ? vi.z : fallback * 0.8) * s[2],
    );

    // Surfaces. Wing aerodynamic centre slightly ahead of the CoM (wing+fuselage alone are unstable).
    const pb = visual.partByName;
    const wingY = pb.wingL1?.com.y ?? pb.wingR1?.com.y ?? 0;
    const zac = cfg.wingAcFrac * this.chord;
    const yw = 0.42 * (this.span / 2);
    const gam = cfg.dihedralDeg * DEG;
    const segNames = (sd: 'L' | 'R') => ['1', '2', '3'].map((i) => `wing${sd}${i}`).filter((n) => pb[n]);
    const segFracs = (n: number) => (n >= 3 ? [0.45, 0.33, 0.22] : n === 2 ? [0.6, 0.4] : [1]);
    for (const [sd, side] of [['L', 1], ['R', -1]] as const) {
      const names = segNames(sd);
      const fr = segFracs(Math.max(1, names.length));
      const pos = new THREE.Vector3(side * yw, wingY, zac);
      this.surfaces.push({
        kind: 'wing', pos, base: pos.clone(), n: new THREE.Vector3(-side * Math.sin(gam), Math.cos(gam), 0), c: new THREE.Vector3(0, 0, 1),
        area: this.S / 2, alive: 1, inc: cfg.incidenceDeg * DEG, side,
        segs: (names.length ? names : [`wing${sd}1`]).map((part, i) => ({ part, frac: fr[i] ?? 0, lost: false })), stalled: 0,
      });
    }
    // Tail arm from the model, clamped to sane proportions; areas from tail volume coefficients so stability is
    // consistent whatever the mesh proportions are.
    const clampArm = (z: number | undefined, def: number) => {
      const v = z === undefined ? def : Math.abs(z);
      return clamp(v, 0.28 * L, 0.62 * L);
    };
    const tpL = pb.tailplaneL ?? pb.tailplaneR;
    const lh = clampArm(tpL ? tpL.com.z - zac : undefined, 0.45 * L);
    const sh = (cfg.tailVolume * this.S * this.chord) / lh;
    const ty = tpL?.com.y ?? 0;
    const tyw = Math.max(0.5, Math.abs(tpL?.com.x ?? this.span * 0.08));
    for (const [nm, side] of [['tailplaneL', 1], ['tailplaneR', -1]] as const) {
      const pos = new THREE.Vector3(side * tyw, ty, zac - lh);
      this.surfaces.push({
        kind: 'htail', pos, base: pos.clone(), n: new THREE.Vector3(0, 1, 0), c: new THREE.Vector3(0, 0, 1),
        area: sh / 2, alive: 1, inc: 0, side, segs: [{ part: nm, frac: 1, lost: false }], stalled: 0,
      });
    }
    const fin = pb.fin;
    const lv = clampArm(fin ? fin.com.z : undefined, 0.45 * L);
    const sv = (cfg.finVolume * this.S * this.span) / lv;
    const fpos = new THREE.Vector3(0, fin?.com.y ?? visual.dims.height * 0.3, -lv);
    this.surfaces.push({
      kind: 'fin', pos: fpos, base: fpos.clone(), n: new THREE.Vector3(1, 0, 0), c: new THREE.Vector3(0, 0, 1),
      area: sv, alive: 1, inc: 0, side: 0, segs: [{ part: 'fin', frac: 1, lost: false }], stalled: 0,
    });

    // Gear geometry: main-gear arm (rotation) and tail-strike attitude.
    const mains = visual.gear.filter((g) => !g.steerable);
    if (mains.length) {
      const zm = mains.reduce((a, g) => a + g.wheel.z, 0) / mains.length;
      const ym = mains.reduce((a, g) => a + g.wheel.y - g.radius, 0) / mains.length;
      this.mainGearArm = Math.max(0, -zm);
      let strike = 0.35;
      for (const part of visual.parts) {
        if (part.kind === 'gear') continue;
        const zb = part.boxCenter.z - part.halfExtents.z; // rearmost point of the box
        const yb = part.boxCenter.y - part.halfExtents.y;
        const dz = zm - zb;
        if (dz < 1) continue;
        strike = Math.min(strike, Math.atan2(Math.max(0.05, yb - ym), dz));
      }
      this.tailStrikePitch = clamp(strike, 0.1, 0.35);
    }
    this.solveTrimAndAuthority();
  }

  /** Air-relative state at a synthetic attitude, used to trim the tail and size control authorities. */
  private pitchMomentAt(alphaBody: number, V: number): number {
    _vl.set(0, -V * Math.sin(alphaBody), V * Math.cos(alphaBody));
    _wl.set(0, 0, 0);
    const inp = this.trimInputs;
    this.aero(_vl, _wl, inp, _F, _M);
    return -_M.x;
  }
  private trimInputs = defaultInputs();

  private solveTrimAndAuthority(): void {
    const cfg = this.cfg;
    const g = CONFIG.planes.gravity;
    const W = this.mass * g;
    const ti = this.trimInputs;
    ti.flaps = 0;
    ti.gear = 0;
    ti.agl = 1000;
    ti.onGround = false;
    // Trim (hands-off, realistic mode) at 1.5 × stall speed, clean.
    const vT = 1.5 * this.vStall;
    const qT = 0.5 * this.rho * vT * vT;
    const clT = W / (qT * this.S);
    const aT = (clT - cfg.cl0) / cfg.clAlpha - cfg.incidenceDeg * DEG;
    let lo = -14 * DEG;
    let hi = 10 * DEG;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      this.setTailIncidence(mid);
      // more incidence → more tail lift → more nose-down moment
      if (this.pitchMomentAt(aT, vT) > 0) lo = mid;
      else hi = mid;
    }
    this.setTailIncidence((lo + hi) / 2);
    // References.
    const vRef = 1.6 * this.vStall;
    this.qRef = 0.5 * this.rho * vRef * vRef;
    const qnT = Math.min(this.qnMax[0], qT / this.qRef);
    // Pitch: full stick reaches ~the stall AoA (+3°) from trim at trim speed. Stiffness is measured in the linear
    // range and extrapolated (past the stall the downwash collapse adds a big nose-down moment: the nose drops).
    const daFull = this.alphaStallBody + 3 * DEG - aT;
    const daLin = Math.max(2 * DEG, this.alphaStallBody - 2 * DEG - aT);
    const dM = (this.pitchMomentAt(aT, vT) - this.pitchMomentAt(aT + daLin, vT)) * (daFull / daLin);
    this.Ap = (cfg.pitchAuthority * Math.max(0, dM)) / (this.inertia.x * qnT);
    // … and rotate the plane about its main gear at Vr.
    const qnR = Math.min(this.qnMax[0], (0.5 * this.rho * this.vRot * this.vRot) / this.qRef);
    this.Ap = Math.max(this.Ap, (1.25 * W * this.mainGearArm) / (this.inertia.x * qnR));
    // Roll: full stick = rollRateDeg steady roll at vRef (wing damping ½ρ V S a yw²).
    const yw = Math.abs(this.surfaces[0].base.x);
    const cRoll = 0.5 * this.rho * vRef * this.S * cfg.clAlpha * yw * yw;
    this.Ar = (cfg.rollRateDeg * DEG * cRoll) / this.inertia.z;
    // Yaw: config, but always enough to hold the worst single-engine-out at 1.25 × Vs.
    let worst = 0;
    for (const e of this.engines) worst = Math.max(worst, Math.abs(e.point.x) * cfg.thrust);
    const qnMc = (0.5 * this.rho * (1.25 * this.vStall) ** 2) / this.qRef;
    this.Ay = Math.max(cfg.yawAccel, (1.05 * worst) / (this.inertia.y * qnMc));
  }

  /** Control authority clamp (× qRef) per axis: pitch, roll, yaw — limits g at speed, keeps roll crisp. */
  readonly qnMax = [1.3, 2.5, 2.0];

  private setTailIncidence(inc: number): void {
    this.tailIncidence = inc;
    for (const s of this.surfaces) if (s.kind === 'htail') s.inc = inc;
  }

  /** Mark parts as lost (wing segments, tailplanes, fin). Returns true if any aero surface changed. */
  loseParts(parts: Iterable<string>): boolean {
    const set = new Set(parts);
    let changed = false;
    for (const s of this.surfaces) {
      let alive = 0;
      let lostInboard = false;
      for (const sg of s.segs) {
        if (set.has(sg.part)) sg.lost = true;
        // a lost segment takes everything outboard of it with it
        if (sg.lost) lostInboard = true;
        if (lostInboard) sg.lost = true;
        else alive += sg.frac;
      }
      if (alive !== s.alive) {
        changed = true;
        s.alive = alive;
        if (s.kind === 'wing') s.pos.x = s.base.x * Math.max(0.35, Math.pow(Math.max(alive, 1e-3), 0.9));
      }
    }
    return changed;
  }

  resetDamage(): void {
    for (const s of this.surfaces) {
      s.alive = 1;
      s.pos.copy(s.base);
      for (const sg of s.segs) sg.lost = false;
    }
    this.comOffset.set(0, 0, 0);
    this.mass = this.cfg.mass;
  }

  get htailAlive(): number {
    let a = 0;
    let n = 0;
    for (const s of this.surfaces) if (s.kind === 'htail') { a += s.alive; n++; }
    return n ? a / n : 0;
  }

  get finAlive(): number {
    for (const s of this.surfaces) if (s.kind === 'fin') return s.alive;
    return 0;
  }

  get tailAlive(): number {
    let a = 0;
    let n = 0;
    for (const s of this.surfaces) if (s.kind !== 'wing') { a += s.alive; n++; }
    return n ? a / n : 0;
  }

  /** Current stall speed (m/s) with the given flaps. */
  stallSpeed(flaps: number): number {
    return this.vStall * Math.sqrt(this.clMax / (this.clMax + this.cfg.flapCL * flaps));
  }

  private st = 0; // stall amount (0..1) written by wingCL/tailCL

  private wingCL(a: number, flapCL: number, bias: number): number {
    const cfg = this.cfg;
    const st = cfg.stallDeg * DEG + bias;
    const neg = -st * 0.75;
    const cl0 = cfg.cl0 + flapCL;
    this.st = 0;
    if (a <= st && a >= neg) return cl0 + cfg.clAlpha * a;
    const fp = 1.15 * Math.sin(2 * a);
    if (a > st) {
      const clMax = cl0 + cfg.clAlpha * st;
      const d = a - st;
      const s = smoothstep(0, 4 * DEG, d);
      const post = Math.max(fp, clMax * 0.6 * Math.max(0, 1 - d / (35 * DEG)));
      this.st = smoothstep(0, 3 * DEG, d);
      return lerp(clMax, post, s);
    }
    const clMin = cl0 + cfg.clAlpha * neg;
    const d = neg - a;
    const s = smoothstep(0, 4 * DEG, d);
    const post = Math.min(fp, clMin * 0.6 * Math.max(0, 1 - d / (35 * DEG)));
    this.st = smoothstep(0, 3 * DEG, d);
    return lerp(clMin, post, s);
  }

  private tailCL(a: number, slope: number): number {
    const st = 15 * DEG;
    this.st = 0;
    if (Math.abs(a) <= st) return slope * a;
    const fp = 1.1 * Math.sin(2 * a);
    const sgn = Math.sign(a);
    const d = Math.abs(a) - st;
    const s = smoothstep(0, 5 * DEG, d);
    const clMax = slope * st;
    const post = sgn * Math.max(Math.abs(fp), clMax * 0.55 * Math.max(0, 1 - d / (30 * DEG)));
    this.st = smoothstep(0, 3 * DEG, d);
    return lerp(sgn * clMax, post, s);
  }

  /**
   * Aerodynamic force and moment (body-local, about the body origin) without control torques.
   * vl = local AIR velocity, wl = local angular velocity.
   */
  private aero(vl: THREE.Vector3, wl: THREE.Vector3, inp: FlightInputs, F: THREE.Vector3, M: THREE.Vector3): void {
    const cfg = this.cfg;
    const rho = this.rho;
    F.set(0, 0, 0);
    M.set(0, 0, 0);
    const V2 = vl.lengthSq();
    if (V2 < 0.25) return;
    const V = Math.sqrt(V2);
    const q = 0.5 * rho * V2;
    // ground effect (wing height / span)
    const h = Math.max(0.05, inp.agl) / this.span;
    const x16 = (16 * h) * (16 * h);
    const phi = x16 / (1 + x16);
    const geLift = 1 + 0.1 * (1 - phi);
    const flapCL = cfg.flapCL * inp.flaps;
    let wingStall = 0;
    let wingAlive = 0;
    let wingCl = 0;
    const AR = (this.span * this.span) / this.S;
    for (const s of this.surfaces) {
      if (s.alive <= 0) {
        s.stalled = 0;
        continue;
      }
      _vp.crossVectors(wl, s.pos).add(vl);
      const vn = _vp.dot(s.n);
      const vc = _vp.dot(s.c);
      const v2 = vn * vn + vc * vc;
      if (v2 < 0.25) continue;
      const vs = Math.sqrt(v2);
      let a = Math.atan2(-vn, vc) + s.inc;
      if (s.kind === 'htail') {
        // downwash from the wing (drops when the wing stalls → natural nose drop), + stabilizer trim
        const eps = wingAlive > 0 ? clamp((2 * (wingCl / wingAlive)) / (Math.PI * AR), -0.3, 0.3) : 0;
        a += this.trim - eps;
      }
      let cl: number;
      let cd: number;
      let st: number;
      if (s.kind === 'wing') {
        cl = this.wingCL(a, flapCL, s.side * this.stallBias) * inp.liftScale * geLift;
        st = this.st;
        const sin = Math.sin(a);
        cd = lerp(this.k * cl * cl * phi, 1.25 * sin * sin, smoothstep(0, 1, st));
        wingStall += st * s.alive;
        wingAlive += s.alive;
        wingCl += cl * s.alive;
      } else {
        cl = this.tailCL(a, s.kind === 'fin' ? 3.0 : 4.6);
        st = this.st;
        const sin = Math.sin(a);
        cd = 0.012 + lerp(0.08 * cl * cl, 1.15 * sin * sin, smoothstep(0, 1, st));
      }
      s.stalled = st;
      const qa = 0.5 * rho * v2 * s.area * s.alive;
      const dc = vc / vs;
      const dn = vn / vs;
      const fc = qa * (-cl * dn - cd * dc);
      const fn = qa * (cl * dc - cd * dn);
      _f.copy(s.c).multiplyScalar(fc).addScaledVector(s.n, fn);
      F.add(_f);
      M.add(_t.crossVectors(s.pos, _f));
    }
    this.stall = wingAlive > 0 && wingStall / wingAlive > 0.5;
    // Parasite drag (+ gear, flaps, transonic wave drag, damage) at the CoM.
    const mach = V / this.vTop - 0.75;
    const cdw = mach > 0 ? cfg.waveDrag * mach * mach : 0;
    const cdp = cfg.cd0 + cfg.gearCD * inp.gear + cfg.flapCD * inp.flaps + cdw + inp.extraCd;
    F.addScaledVector(vl, (-q * this.S * cdp) / V);
    for (const sd of inp.sideDrag) {
      _f.copy(vl).multiplyScalar((-q * sd.cdA) / V);
      F.add(_f);
      M.add(_t.crossVectors(sd.point, _f));
    }
    // Fuselage: side force, Munk moments (destabilising), camber + flap moment, stall break, extra damping.
    const alpha = Math.atan2(-vl.y, vl.z);
    const beta = Math.asin(clamp(-vl.x / V, -1, 1));
    F.x += q * this.S * 0.25 * Math.sin(beta) * Math.cos(beta);
    const qSc = q * this.S * this.chord;
    const qSb = q * this.S * this.span;
    let pitchUp = qSc * cfg.munkPitch * 0.5 * Math.sin(2 * alpha);
    pitchUp += qSc * (cfg.cm0 - 0.1 * inp.flaps) * (wingAlive / 2);
    pitchUp -= qSc * 0.08 * (wingAlive > 0 ? wingStall / wingAlive : 0);
    let yawRight = -qSb * cfg.munkYaw * 0.5 * Math.sin(2 * beta);
    const dmp = cfg.damping;
    const hv = 0.5 * rho * V * this.S;
    pitchUp -= dmp[0] * hv * this.chord * this.chord * -wl.x * 4;
    const rollRight = -dmp[1] * hv * this.span * this.span * wl.z;
    yawRight -= dmp[2] * hv * this.span * this.span * -wl.y;
    if (inp.tailLost) pitchUp += qSc * 0.025 * (1 - this.htailAlive); // centre of pressure moved forward
    M.x -= pitchUp;
    M.y -= yawRight;
    M.z += rollRight;
  }

  /**
   * Compute and apply every force/torque for this fixed step (forces are reset first). Gravity comes from the
   * body's gravity scale; the raycast gear applies its own impulses.
   */
  step(dt: number, body: RAPIER.RigidBody, inp: FlightInputs): void {
    const cfg = this.cfg;
    const A = CONFIG.planes.assist;
    const g = CONFIG.planes.gravity;
    const r = body.rotation();
    const lv = body.linvel();
    const av = body.angvel();
    _q.set(r.x, r.y, r.z, r.w);
    _qi.copy(_q).invert();
    _vl.set(lv.x - inp.wind.x, lv.y - inp.wind.y, lv.z - inp.wind.z).applyQuaternion(_qi);
    _wl.set(av.x, av.y, av.z).applyQuaternion(_qi);
    const V = _vl.length();
    this.airspeed = V;
    this.qdyn = 0.5 * this.rho * V * V;
    this.qn = this.qdyn / this.qRef;
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(-1, 0, 0).applyQuaternion(_q);
    this.pitch = Math.asin(clamp(_fwd.y, -1, 1));
    this.bank = Math.atan2(-_right.y, _up.y);
    this.heading = Math.atan2(_fwd.x, -_fwd.z);
    const gs = Math.hypot(lv.x, lv.y, lv.z);
    this.gamma = gs > 1 ? Math.asin(clamp(lv.y / gs, -1, 1)) : 0;
    this.alpha = V > 1 ? Math.atan2(-_vl.y, _vl.z) : 0;
    this.beta = V > 1 ? Math.asin(clamp(-_vl.x / V, -1, 1)) : 0;
    this.p = _wl.z;
    this.qRate = -_wl.x;
    this.r = -_wl.y;

    // Stall asymmetry: re-rolled each time the wing un-stalls, so each stall drops a different wing.
    if (!this.stall && this.wasStalled) this.stallBias = (Math.random() - 0.5) * 1.6 * DEG;
    this.wasStalled = this.stall;

    this.aero(_vl, _wl, inp, _F, _M);

    // Thrust at each engine, along the body forward axis.
    for (let i = 0; i < this.engines.length; i++) {
      const T = inp.thrust[i] ?? 0;
      if (T === 0) continue;
      _f.set(0, 0, T);
      _F.add(_f);
      _M.add(_t.crossVectors(this.engines[i].point, _f));
    }
    // Everything the assists must fight (aero + thrust line); yaw is deliberately not cancelled (engine-out felt).
    const aeroPitchUp = -_M.x;
    const aeroRoll = _M.z;

    // ---------------- controls ----------------
    const I = this.inertia;
    const qn = this.qn;
    const sP = inp.pitch;
    const sR = inp.roll;
    const sY = inp.yaw;
    const af = inp.assisted ? clamp(inp.assistFactor, 0, 1) : 0;
    let de = sP;
    let da = sR;
    let dr = sY;
    let pitchHelp = 0;
    const vsCur = this.stallSpeed(inp.flaps);
    const alphaWarn = this.alphaStallBody - A.stallMarginDeg * DEG;
    this.stallWarning = !inp.onGround && V > 5 && (this.alpha > alphaWarn || V < vsCur * 1.05);
    if (af > 0 && V > 2) {
      const ctlP = Math.max(1e-3, this.Ap * I.x * Math.min(qn, this.qnMax[0]));
      const ctlR = Math.max(1e-3, this.Ar * I.z * Math.min(qn, this.qnMax[1]));
      const ctlY = Math.max(1e-3, this.Ay * I.y * Math.min(qn, this.qnMax[2]));
      const pitchMax = cfg.pitchRateDeg * DEG;
      const thMax = A.pitchLimitDeg * DEG;
      const active = Math.abs(sP) > 0.06;
      let qCmd: number;
      if (inp.onGround) {
        qCmd = sP * pitchMax * 0.6;
        this.gammaHold = 0;
        const thGround = Math.min(cfg.rotatePitchDeg * DEG + 1 * DEG, this.tailStrikePitch - 1.5 * DEG);
        if (V < 0.9 * this.vRot) qCmd = Math.min(qCmd, 2 * (1 * DEG - this.pitch));
        else if (inp.rotationHelp && sP > 0.1 && V >= 0.95 * this.vRot && this.pitch < cfg.rotatePitchDeg * DEG) {
          qCmd = Math.max(qCmd, cfg.rotateRateDeg * DEG * Math.min(1, sP * 2.5));
          pitchHelp = 1.2 * this.mass * g * this.mainGearArm * Math.min(1, sP * 2.5);
        }
        qCmd = Math.min(qCmd, 2 * (thGround - this.pitch));
      } else {
        const ff = V > 5 ? (g / V) * Math.min(3, 1 / Math.max(0.2, Math.cos(this.bank)) - Math.cos(this.bank)) : 0;
        if (active) {
          qCmd = sP * pitchMax + ff * 0.5;
          this.gammaHold = this.gamma;
        } else {
          if (this.stickWasActive) this.gammaHold = this.gamma;
          this.gammaHold = Math.min(this.gammaHold, inp.gammaCap);
          this.gammaHold = clamp(this.gammaHold, -thMax + 5 * DEG, thMax - 5 * DEG);
          qCmd = cfg.gammaK * (this.gammaHold - this.gamma) + ff;
        }
        // Landing flare: hold a gentle sink rate below flareHeight.
        if (inp.gearDown && inp.wheelAgl < A.flareHeight && lv.y < -0.3 && sP > -0.3) {
          const sink = -Math.max(A.flareMinSink, inp.wheelAgl * A.flareSinkK);
          const gT = Math.asin(clamp(sink / Math.max(5, gs), -1, 1));
          if (this.gamma < gT) qCmd = Math.max(qCmd, 2 * cfg.gammaK * (gT - this.gamma));
          qCmd = Math.min(qCmd, 2 * (this.tailStrikePitch - 1.5 * DEG - this.pitch));
        }
        // Stall nudge (gentle: a strong pull can still stall it).
        if (this.alpha > alphaWarn && !this.noStallNudge) {
          qCmd -= A.stallNudge * (this.alpha - alphaWarn) * 4;
          this.gammaHold = Math.min(this.gammaHold, this.gamma);
        }
        // Soft attitude limits.
        qCmd = clamp(qCmd, A.pitchLimitK * (-thMax - this.pitch), A.pitchLimitK * (thMax - this.pitch));
      }
      this.stickWasActive = active;
      const want = I.x * cfg.pitchRateK * (qCmd - this.qRate) - aeroPitchUp - pitchHelp;
      de = lerp(sP, clamp(want / ctlP, -1, 1), af);

      // Roll: bank-angle command (stick = bank, released = wings level), soft 60° limit.
      const bankMax = A.bankLimitDeg * DEG;
      const phiT = inp.onGround ? 0 : sR * bankMax;
      const pMax = cfg.rollRateDeg * DEG;
      const pCmd = clamp(cfg.bankK * (phiT - this.bank), -pMax, pMax);
      const wantR = I.z * cfg.rollRateK * (pCmd - this.p) - aeroRoll;
      da = lerp(inp.onGround ? 0 : sR, clamp(wantR / ctlR, -1, 1), af);

      // Yaw: coordinated turn + sideslip damping, limited so engine-out yaw is still felt.
      let coord = 0;
      if (!inp.onGround && V > 5) {
        const rCmd = (g / V) * Math.sin(this.bank) * Math.cos(this.pitch);
        coord = (I.y * (A.yawRateK * (rCmd - this.r) + A.betaK * this.beta)) / ctlY;
      } else {
        coord = (I.y * (-A.yawRateK * this.r)) / ctlY;
      }
      const ground = inp.onGround ? sR : 0;
      dr = clamp(sY + ground + af * clamp(coord, -A.rudderAssistMax, A.rudderAssistMax), -1, 1);
    } else {
      this.stickWasActive = Math.abs(sP) > 0.06;
      this.gammaHold = this.gamma;
      if (inp.onGround) dr = clamp(sY + sR, -1, 1);
      de = clamp(de, -1, 1);
    }
    // Auto-trim (stabilizer): steady elevator is trimmed out — fast in Assisted, slow in Realistic.
    // Frozen near the stall and for big deflections (a held full pull must not wind the trim away).
    if (!inp.onGround && V > 0.8 * this.vStall && !inp.tailLost && !this.stallWarning && Math.abs(de) < 0.8) {
      const k = af > 0 ? 0.045 : 0.008;
      this.trim = clamp(this.trim - de * k * dt, -8 * DEG, 8 * DEG);
    } else if (inp.onGround) this.trim *= Math.exp(-dt / 3);
    const cs = inp.controlScale;
    this.controls.elevator = de;
    this.controls.aileron = da;
    this.controls.rudder = dr;
    const pitchT = de * this.Ap * I.x * Math.min(qn, this.qnMax[0]) * cs.x + pitchHelp;
    const rollT = da * this.Ar * I.z * Math.min(qn, this.qnMax[1]) * cs.z;
    const yawT = dr * this.Ay * I.y * Math.min(qn, this.qnMax[2]) * cs.y;
    _M.x -= pitchT;
    _M.z += rollT;
    _M.y -= yawT;
    // Forced nose-down (failure) and tail-off yaw oscillation.
    _M.x += inp.noseDown * I.x;
    if (inp.tailLost) {
      const t = inp.tailTime;
      const amp = Math.min(0.3, 0.02 + 0.008 * t) * Math.min(1, qn + 0.2);
      _M.y += Math.sin(t * 2.2) * amp * I.y;
    }
    // Turbulence jolts.
    _M.x -= inp.turb.x * I.x;
    _M.y -= inp.turb.y * I.y;
    _M.z += inp.turb.z * I.z;
    // Moments were taken about the body origin; Rapier applies the torque about the (possibly shifted) CoM.
    if (this.comOffset.lengthSq() > 1e-6) _M.sub(_tmp.crossVectors(this.comOffset, _F));

    _F.applyQuaternion(_q);
    _M.applyQuaternion(_q);
    _F.y += inp.turbVert * this.mass;
    body.resetForces(true);
    body.resetTorques(true);
    body.addForce(_F, true);
    body.addTorque(_M, true);
  }
}
