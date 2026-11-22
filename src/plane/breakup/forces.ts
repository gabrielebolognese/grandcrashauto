import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { Assembly } from './assembly';
import { faceAxis, faceSign, type PartDef, type Structure } from './structure';

/**
 * Cheap per-part force models, accumulated in JS and applied as ONE linear + ONE angular impulse per body per step.
 *
 * AIR (free wreck pieces only — the intact plane is flown by the flight module):
 *   Newtonian face drag ½ρ(v·n)²A on every exposed box face facing the flow (faces shielded by an unbroken neighbour
 *   are skipped; faces on a broken joint are "open" and get extra drag), applied at the part's centre of pressure;
 *   wing/tail parts keep a reduced lift model sampled at two span stations (roll damping, autorotation, the rear
 *   section's violent pitch-up); rear-section engines may keep decaying thrust.
 * WATER (intact body + pieces): per-face pressure ½ρ_w C (v·n)² A at 4 samples per exposed face below the surface
 *   (Newtonian slamming/planing: the face that hits first is dragged hardest → nose-down flips, wing-tip cartwheels,
 *   a flat nose-up ditching planes and skims), skin friction, linear heave damping and buoyancy of the submerged box
 *   volume (air fraction shrinking as each part floods). A limiter never lets a step reverse a pressing sample's
 *   normal velocity (stable for light pieces at 100+ m/s).
 */

const E = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const comp = (v: THREE.Vector3, a: number) => (a === 0 ? v.x : a === 1 ? v.y : v.z);

const MAX_SAMPLES = 2048;

export interface WaterResult {
  /** Any sample wet this step. */
  wet: boolean;
  /** Submerged volume fraction of the whole assembly (0..1). */
  wetFrac: number;
  /** Magnitude of the hydrodynamic (non-buoyant) force after limiting (N). */
  dragMag: number;
  /** World point of the hydrodynamic force centroid (valid when dragMag > 0). */
  centroid: THREE.Vector3;
  /** Deepest wet sample (entry point) and its velocity. */
  deepest: THREE.Vector3;
  deepestVel: THREE.Vector3;
  /** Highest point still above water (for the "tail last above water" bubbles) — not used for physics. */
  buoyancy: number;
}

export class ForceModel {
  readonly F = new THREE.Vector3();
  readonly T = new THREE.Vector3();
  private Fd = new THREE.Vector3();
  private Td = new THREE.Vector3();
  private cW = new THREE.Vector3();
  private r = new THREE.Vector3();
  private v = new THREE.Vector3();
  private vl = new THREE.Vector3();
  private f = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private qInv = new THREE.Quaternion();
  private axW = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private nW = new THREE.Vector3();
  private sl = new THREE.Vector3();
  private sW = new THREE.Vector3();
  // limiter samples
  private sR = new Float32Array(MAX_SAMPLES * 3);
  private sN = new Float32Array(MAX_SAMPLES * 3);
  private sVn = new Float32Array(MAX_SAMPLES);
  private ns = 0;
  readonly water: WaterResult = {
    wet: false,
    wetFrac: 0,
    dragMag: 0,
    centroid: new THREE.Vector3(),
    deepest: new THREE.Vector3(),
    deepestVel: new THREE.Vector3(),
    buoyancy: 0,
  };

  /** Is face f of part p shielded by an unbroken joint to a part on the same body? / on a broken joint (open)? */
  private faceState(s: Structure, asm: Assembly, broken: Uint8Array, p: PartDef, f: number): 0 | 1 | 2 {
    const js = p.faceJoints[f];
    let open = false;
    for (let k = 0; k < js.length; k++) {
      const j = s.joints[js[k]];
      const other = j.a === p.i ? j.b : j.a;
      if (!broken[j.i] && asm.has[other]) return 1; // internal
      if (broken[j.i]) open = true;
    }
    return open ? 2 : 0;
  }

  // ─────────────────────────────── air ───────────────────────────────

  /** Accumulate air forces on a free piece into F/T (world, torque about the world com). */
  air(s: Structure, asm: Assembly, broken: Uint8Array, liftK: Float32Array, dt: number): void {
    const cfg = CONFIG.breakup.air;
    const rho = CONFIG.planes.airDensity ?? 1.225;
    const F = this.F.set(0, 0, 0);
    const T = this.T.set(0, 0, 0);
    const q = asm.quat;
    this.qInv.copy(q).invert();
    for (let a = 0; a < 3; a++) this.axW[a].copy(E[a]).applyQuaternion(q);
    // a horizontal tail flying behind a wing of the same piece sits in its downwash
    let hasWing = false;
    for (const pi of asm.parts) if (s.parts[pi].kind === 'wing') hasWing = true;
    for (const pi of asm.parts) {
      const p = s.parts[pi];
      // part (box) centre velocity
      this.cW.copy(p.bc).applyQuaternion(q).add(asm.pos);
      this.r.subVectors(this.cW, asm.comW);
      this.v.crossVectors(asm.angvel, this.r).add(asm.vel);
      const sp2 = this.v.lengthSq();
      if (sp2 < 0.5) continue;
      this.vl.copy(this.v).applyQuaternion(this.qInv);
      // Newtonian face drag (local frame)
      let fx = 0, fy = 0, fz = 0;
      for (let a = 0; a < 3; a++) {
        const c = comp(this.vl, a);
        if (c * c < 1e-4) continue;
        const f = a * 2 + (c > 0 ? 0 : 1);
        const st = this.faceState(s, asm, broken, p, f);
        if (st === 1) continue;
        const C = (st === 2 ? cfg.openFaceCd : cfg.faceCd) * p.cdScale;
        const mag = -0.5 * rho * C * c * Math.abs(c) * p.faceArea[f];
        if (a === 0) fx += mag;
        else if (a === 1) fy += mag;
        else fz += mag;
      }
      this.f.set(fx, fy, fz).applyQuaternion(q);
      // centre of pressure = box centre + cpOffset
      this.tmp.copy(p.cp).applyQuaternion(q).add(this.r);
      F.add(this.f);
      T.add(this.tmp2.crossVectors(this.tmp, this.f));

      // Open fuselage end = ring wing: normal force linear in the cross-flow angle at the cut (stabilizing behind the
      // centre of mass → the front section flies nose-first like a shuttlecock; destabilizing ahead of it → the rear
      // section's open front end helps it pitch up and tumble).
      if ((p.kind === 'fuselage' || p.kind === 'cockpit') && cfg.ringCn > 0) {
        for (let f = 4; f < 6; f++) {
          if (this.faceState(s, asm, broken, p, f) !== 2) continue;
          const k = -0.5 * rho * Math.sqrt(sp2) * p.faceArea[f] * cfg.ringCn;
          this.f.set(k * this.vl.x, k * this.vl.y, 0).applyQuaternion(q);
          this.tmp.set(0, 0, f === 4 ? p.bh.z : -p.bh.z).add(p.bc).applyQuaternion(q).add(asm.pos).sub(asm.comW);
          F.add(this.f);
          T.add(this.tmp2.crossVectors(this.tmp, this.f));
        }
      }

      // Munk moment of slender fuselage segments: turns the body broadside to the flow (destabilizing → the nose-less
      // rear section diverges, the front section wobbles). Local torque = ρ·k·Vol·v_z·(v_y, −v_x, 0).
      if ((p.kind === 'fuselage' || p.kind === 'cockpit') && cfg.munk > 0) {
        const k = rho * cfg.munk * p.volume * this.vl.z;
        this.f.set(k * this.vl.y, -k * this.vl.x, 0).applyQuaternion(q);
        T.add(this.f);
      }

      // reduced lift on wing/tail parts at two span stations
      if (p.liftN >= 0 && p.liftArea > 0) {
        const nAx = p.liftN;
        const sAx = p.liftS;
        const half = comp(p.bh, sAx) * 0.5;
        for (let st = -1; st <= 1; st += 2) {
          this.sl.copy(p.bc).add(p.cp);
          if (sAx === 0) this.sl.x += st * half;
          else this.sl.y += st * half;
          this.sW.copy(this.sl).applyQuaternion(q).add(asm.pos);
          this.r.subVectors(this.sW, asm.comW);
          this.v.crossVectors(asm.angvel, this.r).add(asm.vel);
          this.vl.copy(this.v).applyQuaternion(this.qInv);
          const un = comp(this.vl, nAx);
          const uc = this.vl.z;
          const u2 = un * un + uc * uc;
          if (u2 < 4) continue;
          // rigging incidence: wings +, horizontal tail − (the trimmed tail down-force that pitches a nose-less rear
          // section up violently once the nose ballast is gone); fins have none
          const inc = p.kind === 'wing' ? cfg.wingIncidence : nAx === 1 ? cfg.tailIncidence : 0;
          const alpha = Math.atan2(-un, uc) + inc;
          const cl = liftCoef(alpha);
          const um = Math.sqrt(u2);
          const dw = hasWing && p.kind === 'tail' && nAx === 1 ? 1 - cfg.downwash : 1;
          const L = 0.5 * rho * u2 * p.liftArea * 0.5 * cl * cfg.liftFactor * dw * liftK[pi];
          // lift direction ⟂ (uc·c + un·n) in the n–c plane: (uc·n − un·c)/|u|
          const ln = uc / um;
          const lc = -un / um;
          this.f.set(0, 0, lc * L);
          if (nAx === 0) this.f.x = ln * L;
          else this.f.y = ln * L;
          this.f.applyQuaternion(q);
          F.add(this.f);
          T.add(this.tmp2.crossVectors(this.r, this.f));
        }
      }
    }
    // decaying engine thrust (rear section after a middle split)
    for (const th of asm.thrust) {
      if (th.t >= th.dur) continue;
      th.t += dt;
      const k = Math.max(0, 1 - th.t / th.dur);
      const p = s.parts[th.part];
      this.f.copy(E[2]).applyQuaternion(q).multiplyScalar(th.force * k * k);
      this.r.copy(p.com).applyQuaternion(q).add(asm.pos).sub(asm.comW);
      F.add(this.f);
      T.add(this.tmp2.crossVectors(this.r, this.f));
    }
    // limit: never more than half the speed per step, bounded angular kick
    const m = asm.mp.mass;
    const dv = (F.length() * dt) / m;
    if (dv > 0.5 * asm.speed + 0.5) F.multiplyScalar((0.5 * asm.speed + 0.5) / dv);
    const dw = (T.length() * dt) / asm.mp.Imin;
    if (dw > cfg.maxSpinKick) T.multiplyScalar(cfg.maxSpinKick / dw);
  }

  // ─────────────────────────────── water ───────────────────────────────

  /**
   * Accumulate water forces into F/T. `flood[p]` is each part's flooded fraction. Returns this.water.
   */
  waterForces(s: Structure, asm: Assembly, broken: Uint8Array, flood: Float32Array, waterY: number, dt: number): WaterResult {
    const cfg = CONFIG.breakup.water;
    const g = Math.abs(CONFIG.physics.gravity);
    const rho = cfg.density;
    const res = this.water;
    res.wet = false;
    res.dragMag = 0;
    res.buoyancy = 0;
    res.centroid.set(0, 0, 0);
    let deepD = -1;
    const F = this.F.set(0, 0, 0);
    const T = this.T.set(0, 0, 0);
    const Fd = this.Fd.set(0, 0, 0);
    const Td = this.Td.set(0, 0, 0);
    const q = asm.quat;
    for (let a = 0; a < 3; a++) this.axW[a].copy(E[a]).applyQuaternion(q);
    this.ns = 0;
    let volSub = 0;
    let volTot = 0;
    let wsum = 0;
    for (const pi of asm.parts) {
      const p = s.parts[pi];
      volTot += p.volume;
      this.cW.copy(p.bc).applyQuaternion(q).add(asm.pos);
      // vertical half extent of the rotated box
      const ext = p.bh.x * Math.abs(this.axW[0].y) + p.bh.y * Math.abs(this.axW[1].y) + p.bh.z * Math.abs(this.axW[2].y);
      if (this.cW.y - ext > waterY) continue;
      const fsub = Math.min(1, Math.max(0, (waterY - (this.cW.y - ext)) / Math.max(0.05, 2 * ext)));
      volSub += p.volume * fsub;
      // buoyancy at the submerged-volume centroid (shifts toward the lowest corner → righting moments)
      const solid = Math.min(0.6, p.mass / (cfg.metalDensity * p.volume));
      const disp = p.airFrac * (1 - flood[pi]) + solid;
      const fb = rho * g * p.volume * fsub * disp;
      if (fb > 0) {
        const k = 1 - fsub;
        this.tmp.copy(this.cW);
        for (let a = 0; a < 3; a++) {
          const sy = this.axW[a].y >= 0 ? 1 : -1;
          this.tmp.addScaledVector(this.axW[a], -k * sy * comp(p.bh, a));
        }
        this.r.subVectors(this.tmp, asm.comW);
        this.f.set(0, fb, 0);
        F.add(this.f);
        T.add(this.tmp2.crossVectors(this.r, this.f));
        res.buoyancy += fb;
      }
      // part-centre velocity, to skip faces trailing the flow
      this.r.subVectors(this.cW, asm.comW);
      this.v.crossVectors(asm.angvel, this.r).add(asm.vel);
      const vpLen = this.v.length();
      const hStrip = Math.max(0.2, ext * 0.5);
      for (let f = 0; f < 6; f++) {
        const a = faceAxis(f);
        const sg = faceSign(f);
        this.nW.copy(this.axW[a]).multiplyScalar(sg);
        if (this.v.dot(this.nW) < -0.35 * vpLen) continue; // back face: no pressure, negligible friction
        const st = this.faceState(s, asm, broken, p, f);
        if (st === 1) continue;
        const b = (a + 1) % 3;
        const c = (a + 2) % 3;
        const area4 = p.faceArea[f] * 0.25 * (st === 2 ? cfg.openFaceFactor : 1);
        for (let k = 0; k < 4; k++) {
          const sb = k & 1 ? 0.5 : -0.5;
          const sc = k & 2 ? 0.5 : -0.5;
          // sample in world: centre + sg*h_a*axis_a + sb*h_b*axis_b + sc*h_c*axis_c
          this.sW
            .copy(this.cW)
            .addScaledVector(this.axW[a], sg * comp(p.bh, a))
            .addScaledVector(this.axW[b], sb * comp(p.bh, b))
            .addScaledVector(this.axW[c], sc * comp(p.bh, c));
          const d = waterY - this.sW.y;
          const w = Math.min(1, d / hStrip + 0.5);
          if (w <= 0) continue;
          res.wet = true;
          this.r.subVectors(this.sW, asm.comW);
          this.tmp.crossVectors(asm.angvel, this.r).add(asm.vel); // sample velocity
          const vn = this.tmp.dot(this.nW);
          if (d > deepD) {
            deepD = d;
            res.deepest.copy(this.sW);
            res.deepestVel.copy(this.tmp);
          }
          // tangential skin friction
          this.f.copy(this.tmp).addScaledVector(this.nW, -vn);
          const vt = this.f.length();
          this.f.multiplyScalar(-0.5 * rho * cfg.frictionCf * vt * area4 * w);
          if (vn > 0) {
            const pr = (0.5 * rho * cfg.pressureCd * vn * vn + rho * cfg.linDamp * vn) * area4 * w;
            this.f.addScaledVector(this.nW, -pr);
            if (this.ns < MAX_SAMPLES) {
              const o = this.ns * 3;
              this.sR[o] = this.r.x;
              this.sR[o + 1] = this.r.y;
              this.sR[o + 2] = this.r.z;
              this.sN[o] = this.nW.x;
              this.sN[o + 1] = this.nW.y;
              this.sN[o + 2] = this.nW.z;
              this.sVn[this.ns] = vn;
              this.ns++;
            }
          }
          const fm = this.f.length();
          Fd.add(this.f);
          Td.add(this.tmp2.crossVectors(this.r, this.f));
          res.centroid.addScaledVector(this.sW, fm);
          wsum += fm;
        }
      }
    }
    res.wetFrac = volTot > 0 ? volSub / volTot : 0;
    if (wsum > 0) res.centroid.multiplyScalar(1 / wsum);
    // Limiter: the hydrodynamic impulse may not reverse any pressing sample's normal velocity.
    if (this.ns > 0) {
      const m = asm.mp.mass;
      const dvx = (Fd.x * dt) / m, dvy = (Fd.y * dt) / m, dvz = (Fd.z * dt) / m;
      const iI = dt / asm.mp.Imin;
      const dwx = Td.x * iI, dwy = Td.y * iI, dwz = Td.z * iI;
      let scale = 1;
      for (let i = 0; i < this.ns; i++) {
        const o = i * 3;
        const rx = this.sR[o], ry = this.sR[o + 1], rz = this.sR[o + 2];
        // Δv_point = dv + dw × r
        const px = dvx + dwy * rz - dwz * ry;
        const py = dvy + dwz * rx - dwx * rz;
        const pz = dvz + dwx * ry - dwy * rx;
        const dvn = px * this.sN[o] + py * this.sN[o + 1] + pz * this.sN[o + 2];
        const vn = this.sVn[i];
        if (vn + dvn < 0 && dvn < 0) {
          const s2 = (0.9 * vn) / -dvn;
          if (s2 < scale) scale = s2;
        }
      }
      if (scale < 1) {
        Fd.multiplyScalar(Math.max(0, scale));
        Td.multiplyScalar(Math.max(0, scale));
      }
    }
    res.dragMag = Fd.length();
    F.add(Fd);
    T.add(Td);
    return res;
  }
}

/** Lift coefficient over the full ±180° range: linear to the stall, flat-plate beyond, weak when flying backwards. */
export function liftCoef(alpha: number): number {
  const cfg = CONFIG.breakup.air;
  const as = cfg.stallAlpha;
  const a = Math.abs(alpha);
  if (a <= as) return cfg.liftSlope * alpha;
  if (a >= Math.PI - as) return cfg.liftSlope * 0.5 * (alpha - Math.sign(alpha) * Math.PI);
  // sharp break just past the stall (negative slope → a dropping wing keeps dropping: spin entry), then flat plate
  const brk = 0.2;
  if (a < as + brk) {
    const peak = cfg.liftSlope * as;
    const post = cfg.postStallCl * Math.sin(2 * (as + brk));
    return Math.sign(alpha) * (peak + ((post - peak) * (a - as)) / brk);
  }
  return cfg.postStallCl * Math.sin(2 * alpha);
}
