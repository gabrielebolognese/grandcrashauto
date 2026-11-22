import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { CONFIG } from '../../config';
import { G, RAPIER, groups, type ColliderTag, type SurfaceMaterial } from '../../core/Physics';
import type { GameEvents } from '../../core/events';
import type { GameContext, IBreakup, TrailHandle } from '../../game/contracts';
import type { BlastInfo, CrashOutcome, ImpactInfo, ImpactSurface, PlaneTypeId, TrackedPlane, WreckPiece } from '../types';
import { Assembly, PieceImpl } from './assembly';
import { ForceModel } from './forces';
import { components, computeMassProps, getStructure, newMassProps, type MassProps, type Structure } from './structure';

/**
 * BREAKUP & CRASH PHYSICS (SPEC-PART2 §8, §10–§12). Owner: breakup.
 *
 *  - Tracks the player plane body (registered by the plane system) and every wreck piece as an `Assembly`
 *    (one Rapier body + the set of parts it carries). All bodies keep the original ROOT frame as body frame, so part
 *    objects are re-parented without touching their local transforms.
 *  - Breaking joints → union-find components → the main body survives if it keeps the cockpit + most of the mass
 *    (onPartsLost) or is replaced by pieces (onSplit). New pieces spawn at the exact current transform with
 *    v = v_cm + ω × r and ω (momentum conserving — see `stats.lastSplit`), then a clamped, momentum-neutral blast kick.
 *  - Crash detection from contact-force events + contact manifolds (impact normal/tangential speed, angle, first part,
 *    energy, surface). Impacts accumulate joint damage near the contact (weakest first, scaled by severity); pieces
 *    that broke off keep their pre-impact momentum (the crush wave only partly decelerates them) → wreckage streams
 *    forward along the slide path, tumbling and breaking further on its own impacts.
 *  - Water: Newtonian face-pressure model + buoyancy + flooding (forces.ts) for the intact body AND all pieces.
 *  - Fire: momentum-inheriting impact fireball, 2–4 secondaries, burning fuel patches along the path, world-space
 *    fire/smoke trails on burning pieces cooling over 20–60 s, steam/slicks on water, sinking + removal.
 */

type Surface = 'runway' | 'ground' | 'building' | 'other' | 'self';

interface FireRef {
  handle: TrailHandle;
  part: number;
  target: THREE.Object3D;
  local: THREE.Vector3;
  fire: number;
  smoke: number;
  size: number;
  hold: number;
  cool: number;
  t: number;
  smokeAfter: boolean;
}

interface TornEdge {
  part: number;
  local: THREE.Vector3;
  normal: THREE.Vector3; // local, pointing out of the opening
  t: number;
  dur: number;
  fxT: number;
  mist: number;
}

interface SplitCtx {
  blast?: BlastInfo | null;
  impact?: { part: number; point: THREE.Vector3; normal: THREE.Vector3 } | null;
  /** Use the pre-step velocities (water impacts already decelerate continuously → false). */
  reason: 'api' | 'impact' | 'water' | 'gear' | 'total';
}

interface PlaneRT {
  plane: TrackedPlane;
  s: Structure;
  type: PlaneTypeId;
  registered: boolean;
  broken: Uint8Array;
  damage: Float32Array;
  flood: Float32Array;
  floodK: Float32Array;
  /** Per-part lift factor of severed surfaces (bent/damaged asymmetry). */
  liftK: Float32Array;
  fuel: Float32Array;
  gone: Uint8Array;
  owner: (Assembly | null)[];
  hidden: THREE.Object3D[];
  tracked: Assembly | null;
  asms: Assembly[];
  fires: FireRef[];
  torn: TornEdge[];
  pendingDamage: number[];
  pendingCtx: SplitCtx | null;
  crashed: boolean;
  outcome: CrashOutcome | null;
  ignited: boolean;
  exploded: boolean;
  belly: boolean;
  secondaries: number[];
  secCount: number;
  lastSecT: number;
  patches: number;
  t: number;
  airborneAtSplit: boolean;
}

export interface SplitStats {
  kind: string;
  pieces: number;
  massBefore: number;
  massAfter: number;
  pBefore: [number, number, number];
  pAfter: [number, number, number];
  /** |ΔP| / |P| before any blast kick (should be ~0). */
  momentumError: number;
  /** |ΔP| / |P| after the momentum-neutral blast kick. */
  momentumErrorKick: number;
  /** Largest jump of a part's world position on the break frame (m). */
  maxPosJump: number;
  /** Largest difference between a part's velocity before/after the split (excluding kicks) (m/s). */
  maxVelJump: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const HARD: Partial<Record<SurfaceMaterial, number>> = {
  asphalt: 1, concrete: 1, rock: 1, metal: 1, glass: 0.8, wood: 0.7, gravel: 0.8, dirt: 0.75, grass: 0.7, foliage: 0.6, sand: 0.6, snow: 0.5, plastic: 0.6,
};
const SOFT: Partial<Record<SurfaceMaterial, number>> = { grass: 0.25, dirt: 0.3, sand: 0.45, snow: 0.35, gravel: 0.2, foliage: 0.25 };

let nextId = 1;

export class Breakup implements IBreakup {
  readonly name = 'breakup';
  pieces: WreckPiece[] = [];
  focusPiece: WreckPiece | null = null;
  /** Debug/verification numbers (momentum conservation, counts). */
  readonly stats = {
    lastSplit: null as SplitStats | null,
    splits: 0,
    bodiesCreated: 0,
    bodiesRemoved: 0,
    impacts: 0,
    events: [] as string[],
  };
  /** Debug harness hook (installed with ?debug). */
  harness: { fixed?(dt: number): void; post?(dt: number): void; update?(dt: number, alpha: number): void } | null = null;

  private planes: PlaneRT[] = [];
  private colliderMap = new Map<number, { rt: PlaneRT; asm: Assembly; part: number }>();
  private forces = new ForceModel();
  private focusT = 0;
  private offs: (() => void)[] = [];
  private budgetSparks = 0;
  private budgetDust = 0;
  private budgetGouge = 0;
  private mfFound = false;
  private mfNormal = new THREE.Vector3();
  private mfPoint = new THREE.Vector3();
  private mfFlip = false;
  private mfDepth = 0;

  // temps
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private v4 = new THREE.Vector3();
  private v5 = new THREE.Vector3();
  private q1 = new THREE.Quaternion();
  private sumF = new THREE.Vector3();
  private sumT = new THREE.Vector3();
  private evPos = new THREE.Vector3();
  private evVel = new THREE.Vector3();
  private mpTmp: MassProps = newMassProps();
  private tDmg = new THREE.Vector3();
  private tAx = new THREE.Vector3();
  private tNear = new THREE.Vector3();
  private tAtt = new THREE.Vector3();
  private impVel = new THREE.Vector3();

  constructor(private ctx: GameContext) {}

  init(): void {
    const ev = this.ctx.events;
    this.offs.push(ev.on('contact', this.onContact));
    this.offs.push(
      ev.on('originShift', (e) => {
        const dx = e.delta.x;
        const dz = e.delta.z;
        for (const rt of this.planes) {
          for (const a of rt.asms) {
            a.interp.shift(dx, dz);
            a.lastGouge.x -= dx;
            a.lastGouge.z -= dz;
            a.lastPatch.x -= dx;
            a.lastPatch.z -= dz;
            a.cPoint.x -= dx;
            a.cPoint.z -= dz;
            a.pos.x -= dx;
            a.pos.z -= dz;
            a.comW.x -= dx;
            a.comW.z -= dz;
            a.posPre.x -= dx;
            a.posPre.z -= dz;
            a.waterQx = 1e9;
          }
        }
      }),
    );
    if (this.ctx.debug) {
      import('./harness')
        .then((m) => m.installHarness(this, this.ctx))
        .catch((err) => console.warn('[breakup] harness failed', err));
    }
  }

  dispose(): void {
    this.clear();
    for (const off of this.offs) off();
    this.offs = [];
  }

  // ═══════════════════════════════════ registration ═══════════════════════════════════

  track(plane: TrackedPlane): void {
    // A re-track of the same plane (respawn) starts fresh; an old wreck of it stays until clear().
    for (const rt of this.planes) if (rt.plane === plane && rt.registered) this.untrack(plane);
    const s = getStructure(plane.visual);
    const n = s.parts.length;
    const rt: PlaneRT = {
      plane,
      s,
      type: plane.type,
      registered: true,
      broken: new Uint8Array(s.joints.length),
      damage: new Float32Array(s.joints.length),
      flood: new Float32Array(n),
      floodK: new Float32Array(n),
      liftK: new Float32Array(n),
      fuel: new Float32Array(n),
      gone: new Uint8Array(n),
      owner: new Array(n).fill(null),
      hidden: [],
      tracked: null,
      asms: [],
      fires: [],
      torn: [],
      pendingDamage: [],
      pendingCtx: null,
      crashed: false,
      outcome: null,
      ignited: false,
      exploded: false,
      belly: false,
      secondaries: [],
      secCount: 0,
      lastSecT: -9,
      patches: 0,
      t: 0,
      airborneAtSplit: false,
    };
    for (let i = 0; i < n; i++) {
      const p = s.parts[i];
      rt.fuel[i] = p.fuel0;
      const nm = p.name;
      let k = 1;
      if (nm === 'fin') k = 0.28;
      else if (nm === 'tailCone' || nm.startsWith('tailplane')) k = 0.45;
      else if (nm === 'fuselageRear') k = 0.7;
      else if (p.kind === 'engine') k = 2.2;
      else if (p.kind === 'gear') k = 3;
      else if (p.kind === 'wing') k = 0.8;
      else if (p.kind === 'cockpit' || nm === 'nose') k = 1.4;
      rt.floodK[i] = k * rnd(0.75, 1.25);
      rt.liftK[i] = rnd(0.85, 1.15);
    }
    this.planes.push(rt);
    const body = plane.body;
    if (!body) return;
    // Which parts are on the body? (colliders tagged { data: { part } }; fallback: nearest box centre)
    const asm = new Assembly(nextId++, body, true, n, [], plane.visual.root);
    const onBody = new Uint8Array(n);
    for (let c = 0; c < body.numColliders(); c++) {
      const col = body.collider(c);
      const tag = this.ctx.physics.tagOf(col.handle);
      let pi = -1;
      const pn = (tag?.data as { part?: string } | undefined)?.part;
      if (pn !== undefined) pi = s.partIndex.get(pn) ?? -1;
      if (pi < 0) {
        const t = col.translationWrtParent?.() ?? null;
        if (t) {
          let best = Infinity;
          for (const p of s.parts) {
            const d = (p.bc.x - t.x) ** 2 + (p.bc.y - t.y) ** 2 + (p.bc.z - t.z) ** 2;
            if (d < best && !onBody[p.i]) {
              best = d;
              pi = p.i;
            }
          }
        }
      }
      if (pi < 0) continue;
      onBody[pi] = 1;
      asm.colliders[pi] = col;
      this.colliderMap.set(col.handle, { rt, asm, part: pi });
    }
    const parts: number[] = [];
    for (let i = 0; i < n; i++) if (onBody[i] || plane.visual.partByName[s.parts[i].name]?.object.parent === plane.visual.root) parts.push(i);
    asm.setParts(parts);
    for (const p of parts) rt.owner[p] = asm;
    // fresh registration: joints are broken only where a part is missing from the body
    plane.brokenJoints.clear();
    for (const j of s.joints) {
      if (!asm.has[j.a] || !asm.has[j.b]) {
        rt.broken[j.i] = 1;
        plane.brokenJoints.add(j.id);
      }
    }
    computeMassProps(s, parts, asm.mp);
    // Rapier's centre of mass is the velocity reference of linvel.
    const lc = body.localCom();
    asm.mp.com.set(lc.x, lc.y, lc.z);
    asm.read();
    asm.interp.capture(asm.pos, asm.quat);
    asm.vPre.copy(asm.vel);
    asm.wPre.copy(asm.angvel);
    asm.radius = this.radiusOf(s, asm);
    rt.tracked = asm;
    rt.asms.push(asm);
  }

  untrack(plane: TrackedPlane): void {
    for (const rt of this.planes) {
      if (rt.plane !== plane || !rt.registered) continue;
      rt.registered = false;
      const a = rt.tracked;
      if (a) {
        for (const c of a.colliders) if (c) this.colliderMap.delete(c.handle);
        rt.asms.splice(rt.asms.indexOf(a), 1);
        a.removed = true;
        rt.tracked = null;
      }
    }
    this.prunePlanes();
  }

  private findRT(plane: TrackedPlane): PlaneRT | null {
    for (let i = this.planes.length - 1; i >= 0; i--) if (this.planes[i].plane === plane && this.planes[i].registered) return this.planes[i];
    return null;
  }

  private prunePlanes(): void {
    this.planes = this.planes.filter((rt) => rt.registered || rt.asms.length > 0 || rt.fires.length > 0);
  }

  // ═══════════════════════════════════ public API ═══════════════════════════════════

  breakJoints(plane: TrackedPlane, jointIds: string[], blast?: BlastInfo): WreckPiece[] {
    const rt = this.findRT(plane) ?? this.planes.find((r) => r.plane === plane) ?? null;
    if (!rt) return [];
    const idx: number[] = [];
    for (const id of jointIds) {
      const j = rt.s.jointIndex.get(id);
      if (j !== undefined && !rt.broken[j]) idx.push(j);
    }
    if (!idx.length) return [];
    const created = this.breakInternal(rt, idx, { blast: blast ?? null, reason: 'api' });
    if (blast) this.blastExtras(rt, blast, idx, created);
    return created.map((a) => a.piece!).filter(Boolean);
  }

  explodeTotal(plane: TrackedPlane): void {
    const rt = this.findRT(plane) ?? this.planes.find((r) => r.plane === plane) ?? null;
    if (!rt) return;
    const cfgP = CONFIG.planes[rt.type];
    // Centre / velocity of the whole plane (or of its remaining pieces).
    const main = rt.tracked ?? this.biggest(rt);
    if (!main) return;
    main.read();
    const center = main.comW.clone();
    const vel = main.vel.clone();
    const fuelFrac = this.fuelLeft(rt) / Math.max(1, rt.s.fuel);
    const radius = cfgP.explosionRadius * (0.55 + 0.45 * Math.min(1, fuelFrac + 0.3));
    const surf = this.surfaceBelow(center);
    const agl = center.y - surf.y;
    const near: 'ground' | 'water' | null = agl < 100 + radius ? (surf.water ? 'water' : 'ground') : null;
    this.explosionFx(center, vel, radius, 'plane', near, true);
    this.evPos.copy(center);
    this.evVel.copy(vel);
    this.ctx.events.emit('planeExplosion', { position: this.evPos, velocity: this.evVel, radius, kind: 'total' });
    rt.exploded = true;
    rt.ignited = true;
    const all: number[] = [];
    for (const j of rt.s.joints) if (!rt.broken[j.i]) all.push(j.i);
    const blast: BlastInfo = { center, energy: Math.max(50, this.fuelLeft(rt)), kind: 'total' };
    const created = all.length ? this.breakInternal(rt, all, { blast, reason: 'total' }) : [];
    // Fuel mostly burnt in the fireball; char everything.
    for (let i = 0; i < rt.fuel.length; i++) rt.fuel[i] *= 0.35;
    for (const p of rt.s.parts) rt.plane.visual.setCharred(p.name, rnd(0.45, 0.85));
    // Fires: fuel pieces burn long, the rest smoke briefly.
    const burning = rt.asms.filter((a) => !a.removed && !a.tracked);
    burning.sort((a, b) => this.asmFuel(rt, b) - this.asmFuel(rt, a));
    for (const a of burning) {
      const f = this.asmFuel(rt, a);
      if (f > 1) this.igniteAsm(rt, a, Math.min(1, 0.45 + f / Math.max(1, rt.s.fuel * 0.08)), rnd(CONFIG.breakup.fire.coolMin, CONFIG.breakup.fire.coolMax));
      else this.smokeAsm(rt, a, rnd(4, 10));
    }
    if (near === 'ground') this.pushProps(center, radius * 1.6, 14);
    this.emitBreak(rt, center, vel, created.length, 1);
    this.updateFocus(true);
  }

  hardLanding(plane: TrackedPlane, info: ImpactInfo): void {
    const rt = this.findRT(plane);
    if (!rt || !rt.tracked) return;
    let gearDown = true;
    try {
      gearDown = plane.isGearDown();
    } catch {
      gearDown = true;
    }
    if (gearDown) this.collapseGear(rt, info.position);
    else {
      try {
        plane.onGearCollapse();
      } catch (err) {
        console.error('[breakup] onGearCollapse threw', err);
      }
    }
    rt.belly = true;
    this.reportCrash(rt, 'hardLanding', info);
    this.emitImpact(rt, rt.tracked, info.position, info.velocity, 'hardLanding', info.surface, info.energy, info.normalSpeed, true);
    // moderate fire around the wing box / an engine
    const t = rt.tracked;
    const center = rt.s.partIndex.get('fuselageCenter') ?? t.parts[0];
    if (center !== undefined) this.addFire(rt, center, rt.s.parts[center].com, 0.35, 0.7, this.fuselageRadius(rt) * 1.1, rnd(5, 9), rnd(15, 30), false);
    // the fuselage may crack in two on a really hard one
    const cfg = CONFIG.breakup.crash;
    const chance = THREE.MathUtils.clamp((info.normalSpeed - cfg.crackSpeed) / 2, 0, 0.6);
    if (Math.random() < chance) {
      const fus = rt.s.joints.filter(
        (j) => !rt.broken[j.i] && rt.s.parts[j.a].kind === 'fuselage' && rt.s.parts[j.b].kind === 'fuselage',
      );
      fus.sort((a, b) => a.strength - b.strength);
      if (fus[0]) {
        t.read();
        const pt = fus[0].pos.clone().applyQuaternion(t.quat).add(t.pos);
        this.breakInternal(rt, [fus[0].i], { reason: 'impact', impact: { part: fus[0].a, point: pt, normal: UP.clone() } });
      }
    }
  }

  crash(plane: TrackedPlane, outcome: CrashOutcome, info: ImpactInfo): void {
    const rt = this.findRT(plane);
    if (!rt) return;
    if (outcome === 'landing') return;
    if (outcome === 'hardLanding') {
      this.hardLanding(plane, info);
      return;
    }
    if (outcome === 'waterCrash' || outcome === 'ditching') {
      this.reportCrash(rt, outcome, info);
      return;
    }
    const a = rt.tracked;
    if (a && rt.t - a.lastImpactT > 0.15) {
      a.read();
      const hard = info.surface === 'water' ? 1 : HARD[this.ctx.world.surfaceAt(info.position.x, info.position.z)] ?? 1;
      const sev = info.normalSpeed * hard + info.tangentSpeed * hard * CONFIG.breakup.damage.tangentFactor;
      const pi = rt.s.partIndex.get(info.part) ?? this.nearestPart(rt, a, info.position);
      a.lastImpactT = rt.t;
      a.lastImpactVn = info.normalSpeed;
      this.accumulateDamage(rt, a, info.position, sev, true);
      this.flushDamage(rt, a, { reason: 'impact', impact: { part: pi, point: info.position.clone(), normal: UP.clone() } });
    }
    this.reportCrash(rt, outcome, info);
    if (!rt.ignited && info.energy > 0) {
      this.v4.copy(info.velocity);
      this.v4.y = Math.max(0, this.v4.y);
      this.ignite(rt, info.position, this.v4, info.surface === 'water' ? 'water' : 'ground', 1);
    }
    if (outcome === 'building') this.ctx.fx.scorch?.(info.position, this.v5.copy(info.velocity).negate().normalize(), CONFIG.planes[rt.type].explosionRadius * 0.4);
  }

  clear(): void {
    for (const rt of this.planes) {
      for (const f of rt.fires) f.handle.stop();
      rt.fires = [];
      rt.torn = [];
      for (const a of [...rt.asms]) if (!a.tracked) this.removeAsm(rt, a, false);
      for (const o of rt.hidden) o.visible = true;
      rt.hidden = [];
      rt.secondaries = [];
    }
    // Registered planes that still have their body are re-tracked fresh; everything else is dropped.
    const keep = this.planes.filter((rt) => rt.registered && rt.plane.body);
    for (const rt of this.planes) if (rt.tracked) for (const c of rt.tracked.colliders) if (c) this.colliderMap.delete(c.handle);
    this.planes = [];
    this.colliderMap.clear();
    this.pieces = [];
    this.focusPiece = null;
    for (const rt of keep) this.track(rt.plane);
  }

  // ═══════════════════════════════════ simulation ═══════════════════════════════════

  fixedUpdate(dt: number): void {
    this.harness?.fixed?.(dt);
    for (const rt of this.planes) {
      rt.t += dt;
      this.syncTracked(rt);
      for (const a of rt.asms) {
        if (a.removed) continue;
        a.read();
        a.vPre.copy(a.vel);
        a.wPre.copy(a.angvel);
        a.posPre.copy(a.pos);
        a.cThisStep = false;
        a.cForce = 0;
        a.cPart = -1;
        a.age += dt;
        if (a.ghostT > 0) {
          a.ghostT -= dt;
          if (a.ghostT <= 0) this.setGhost(a, false);
        }
        if (!a.tracked && a.body.isSleeping()) continue;
        this.sumF.set(0, 0, 0);
        this.sumT.set(0, 0, 0);
        // water
        const wy = this.waterYFor(a, rt.t);
        if (wy !== null && a.comW.y - a.radius < wy) this.waterStep(rt, a, wy, dt);
        else a.wet = 0;
        // air (free pieces only)
        if (!a.tracked && (a.speed > 1.5 || a.angvel.lengthSq() > 1)) {
          this.forces.air(rt.s, a, rt.broken, rt.liftK, dt);
          this.sumF.add(this.forces.F);
          this.sumT.add(this.forces.T);
          if (a.spinSign !== 0) this.autorotate(rt, a, dt);
          if (a.trimTorque > 0) this.trimStep(a, dt);
        }
        // ploughing drag on soft ground while sliding
        if (a.sliding && a.speed > 2) this.plough(rt, a);
        if (this.sumF.lengthSq() > 0 || this.sumT.lengthSq() > 0) {
          a.body.applyImpulse(this.v1.copy(this.sumF).multiplyScalar(dt), true);
          a.body.applyTorqueImpulse(this.v1.copy(this.sumT).multiplyScalar(dt), true);
        }
      }
      this.flushPending(rt);
    }
  }

  postStep(dt: number): void {
    this.inPost = true;
    const cfx = CONFIG.breakup.fx;
    this.budgetSparks = cfx.maxSparksPerStep;
    this.budgetDust = cfx.maxDustPerStep;
    this.budgetGouge = cfx.maxGougePerStep;
    for (const rt of this.planes) {
      for (let i = 0; i < rt.asms.length; i++) {
        const a = rt.asms[i];
        if (a.removed) continue;
        if (!this.ctx.physics.world.bodies.contains(a.body.handle)) {
          a.removed = true;
          continue;
        }
        a.read();
        a.interp.capture(a.pos, a.quat);
        if (a.cThisStep) {
          this.processContact(rt, a, dt);
          a.cFrames++;
          a.cGap = 0;
        } else {
          a.cFrames = 0;
          a.cGap++;
          a.sliding = false;
        }
        this.postPiece(rt, a, dt);
      }
      this.flushPending(rt);
      this.wreckFxStep(rt, dt);
      // drop removed assemblies
      if (rt.asms.some((a) => a.removed)) {
        for (const a of rt.asms) if (a.removed && !a.tracked) this.removeAsm(rt, a, true);
        rt.asms = rt.asms.filter((a) => !a.removed);
        if (rt.tracked?.removed) rt.tracked = null;
        this.syncPieces();
      }
    }
    this.inPost = false;
    this.harness?.post?.(dt);
  }

  update(dt: number, alpha: number): void {
    for (const rt of this.planes) {
      for (const a of rt.asms) if (!a.tracked && !a.removed) a.interp.apply(a.group, alpha);
      this.updateFires(rt, dt);
    }
    this.focusT -= dt;
    if (this.focusT <= 0) this.updateFocus(false);
    this.harness?.update?.(dt, alpha);
    if (this.planes.length && this.planes.every((rt) => !rt.registered && rt.asms.length === 0 && rt.fires.length === 0)) this.prunePlanes();
  }

  // ═══════════════════════════════════ splitting ═══════════════════════════════════

  /** Break joints (indices) of a plane; splits every affected assembly. Returns the newly created assemblies. */
  private breakInternal(rt: PlaneRT, jointIdx: number[], sctx: SplitCtx): Assembly[] {
    const s = rt.s;
    const affected = new Set<Assembly>();
    const jointsNow: number[] = [];
    for (const ji of jointIdx) {
      if (rt.broken[ji]) continue;
      const j = s.joints[ji];
      rt.broken[ji] = 1;
      rt.plane.brokenJoints.add(j.id);
      jointsNow.push(ji);
      try {
        rt.plane.visual.showBreak(j.id);
      } catch (err) {
        console.warn('[breakup] showBreak failed', err);
      }
      const oa = rt.owner[j.a];
      if (oa && oa === rt.owner[j.b]) affected.add(oa);
    }
    if (!jointsNow.length) return [];
    const created: Assembly[] = [];
    const involved: Assembly[] = [];
    // Momentum bookkeeping over every affected assembly.
    const pB = new THREE.Vector3();
    let mB = 0;
    const partPosBefore = new Map<number, THREE.Vector3>();
    const partVelBefore = new Map<number, THREE.Vector3>();
    for (const a of affected) {
      a.read();
      pB.addScaledVector(a.vel, a.mp.mass);
      mB += a.mp.mass;
      for (const p of a.parts) {
        const c = s.parts[p].com.clone().applyQuaternion(a.quat).add(a.pos);
        partPosBefore.set(p, c);
        partVelBefore.set(p, this.v1.subVectors(c, a.comW).crossVectors(a.angvel, this.v1).add(a.vel).clone());
      }
    }
    const debrisP = new THREE.Vector3();
    for (const a of affected) {
      const res = this.splitAssembly(rt, a, sctx, debrisP);
      if (res.keeper) involved.push(res.keeper);
      for (const c of res.created) {
        created.push(c);
        involved.push(c);
      }
    }
    if (!created.length && !involved.length) return created;
    // momentum after (before kicks)
    const pA = new THREE.Vector3().add(debrisP);
    let mA = 0;
    let maxJump = 0;
    let maxVJump = 0;
    for (const a of involved) {
      a.read();
      pA.addScaledVector(a.vel, a.mp.mass);
      mA += a.mp.mass;
      for (const p of a.parts) {
        const before = partPosBefore.get(p);
        if (!before) continue;
        const c = this.v2.copy(s.parts[p].com).applyQuaternion(a.quat).add(a.pos);
        maxJump = Math.max(maxJump, c.distanceTo(before));
        const vb = partVelBefore.get(p)!;
        const va = this.v3.subVectors(c, a.comW).crossVectors(a.angvel, this.v3).add(a.vel);
        maxVJump = Math.max(maxVJump, va.distanceTo(vb));
      }
    }
    for (const p of partPosBefore.keys()) if (rt.gone[p]) mA += s.parts[p].mass;
    const pmag = Math.max(1e-6, pB.length());
    const stats: SplitStats = {
      kind: sctx.blast?.kind ?? sctx.reason,
      pieces: created.length,
      massBefore: mB,
      massAfter: mA,
      pBefore: [pB.x, pB.y, pB.z],
      pAfter: [pA.x, pA.y, pA.z],
      momentumError: pA.distanceTo(pB) / pmag,
      momentumErrorKick: 0,
      maxPosJump: maxJump,
      maxVelJump: maxVJump,
    };
    // blast kick (momentum neutral), clamped to 10–25 % of airspeed in flight
    if (sctx.blast && involved.length > 1) this.blastKick(rt, involved, sctx.blast);
    if (sctx.blast) {
      const pK = new THREE.Vector3().add(debrisP);
      for (const a of involved) pK.addScaledVector(a.body.linvel() as THREE.Vector3, a.mp.mass);
      stats.momentumErrorKick = pK.distanceTo(pB) / pmag;
    }
    this.stats.lastSplit = stats;
    this.stats.splits++;
    // re-home fires whose part moved, burning fuel pieces in an active crash
    this.rehomeFires(rt);
    if (rt.ignited && sctx.reason !== 'total') {
      for (const c of created) {
        const f = this.asmFuel(rt, c);
        if (f > 5 && !this.asmHasFire(rt, c)) this.igniteAsm(rt, c, 0.7, rnd(20, 45));
      }
    }
    // event
    if (sctx.reason !== 'total' && created.length) {
      const j0 = s.joints[jointsNow[0]];
      const a0 = rt.owner[j0.a] ?? created[0];
      const pos = this.evPos.copy(j0.pos).applyQuaternion(a0.quat).add(a0.pos);
      let lost = 0;
      for (const c of created) lost += c.mp.mass;
      this.emitBreak(rt, pos, a0.vel, created.length, THREE.MathUtils.clamp(0.25 + (1.5 * lost) / rt.s.mass, 0.2, 1));
    }
    this.syncPieces();
    return created;
  }

  /** Split one assembly along its broken joints. */
  private splitAssembly(rt: PlaneRT, A: Assembly, sctx: SplitCtx, debrisP: THREE.Vector3): { keeper: Assembly | null; created: Assembly[] } {
    const s = rt.s;
    const comps = components(s, A.parts, rt.broken);
    if (comps.length <= 1) return { keeper: A, created: [] };
    const massOf = (c: number[]) => c.reduce((m, p) => m + s.parts[p].mass, 0);
    const masses = comps.map(massOf);
    let largest = 0;
    for (let i = 1; i < comps.length; i++) if (masses[i] > masses[largest]) largest = i;
    const cockpitIdx = comps.findIndex((c) => c.some((p) => s.parts[p].isCockpit));
    const mainIdx = cockpitIdx >= 0 ? cockpitIdx : largest;
    let keeperIdx = -1;
    if (A.tracked) {
      if (masses[mainIdx] >= CONFIG.breakup.keepMainFrac * A.mp.mass) keeperIdx = mainIdx;
    } else {
      keeperIdx = cockpitIdx >= 0 ? cockpitIdx : largest;
    }
    A.read();
    rt.airborneAtSplit = A.speed > 25;
    // ---- budget: tiny parts → debris, then merge ----
    let others = comps.filter((_, i) => i !== keeperIdx);
    const maxBodies = this.maxBodies(rt);
    const live = rt.asms.filter((a) => !a.removed).length - (keeperIdx < 0 ? 1 : 0);
    const debrisFrac = CONFIG.breakup.debrisFrac;
    others.sort((x, y) => massOf(x) - massOf(y));
    while (live + others.length > maxBodies && others.length) {
      const c = others[0];
      const m = massOf(c);
      const tiny = m < debrisFrac * s.mass || c.every((p) => s.parts[p].kind === 'gear' || s.parts[p].kind === 'misc');
      if (!tiny) {
        // merge with a neighbouring component (tangled wreckage)
        let merged = false;
        for (let k = 1; k < others.length && !merged; k++) {
          const o = others[k];
          if (s.joints.some((j) => (c.includes(j.a) && o.includes(j.b)) || (c.includes(j.b) && o.includes(j.a)))) {
            o.push(...c);
            merged = true;
          }
        }
        if (merged) {
          others.shift();
          others.sort((x, y) => massOf(x) - massOf(y));
          continue;
        }
      }
      // turn into non-colliding debris
      this.toDebris(rt, A, c, debrisP);
      others.shift();
    }
    // ---- velocities ----
    const cfg = CONFIG.breakup;
    const R = Math.max(1.5, cfg.damage.radiusFrac * s.length);
    const compVel = (c: number[], mp: MassProps, outV: THREE.Vector3, outW: THREE.Vector3, isKeeper: boolean) => {
      const comW = this.v4.copy(mp.com).applyQuaternion(A.quat).add(A.pos);
      const r = this.v5.subVectors(comW, A.comW);
      const vPost = this.v1.crossVectors(A.angvel, r).add(A.vel);
      if (sctx.reason !== 'impact' || !sctx.impact) {
        outV.copy(vPost);
        outW.copy(A.angvel);
        return;
      }
      const vPreC = this.v2.crossVectors(A.wPre, r).add(A.vPre);
      const contains = c.includes(sctx.impact.part);
      if (contains) {
        if (isKeeper) {
          outV.copy(vPost);
          outW.copy(A.angvel);
          return;
        }
        // inelastic crush: the contacting piece loses its into-surface velocity, keeps the tangential part
        outV.copy(vPreC);
        const vn = outV.dot(sctx.impact.normal);
        if (vn < 0) outV.addScaledVector(sctx.impact.normal, -vn);
        outW.copy(A.wPre).lerp(A.angvel, 0.5);
        return;
      }
      const d = comW.distanceTo(sctx.impact.point);
      const t = isKeeper ? cfg.keeperTransmit : cfg.impactTransmit * Math.exp(-d / R);
      outV.copy(vPreC).lerp(vPost, t);
      outW.copy(A.wPre).lerp(A.angvel, t);
    };
    const created: Assembly[] = [];
    const newV = new THREE.Vector3();
    const newW = new THREE.Vector3();
    for (const c of others) {
      const mp = computeMassProps(s, c, newMassProps());
      compVel(c, mp, newV, newW, false);
      const piece = this.createPiece(rt, A, c, mp, newV, newW);
      created.push(piece);
      if (sctx.reason !== 'impact' && A.speed > 30) this.inheritTrim(rt, A, piece);
    }
    let keeper: Assembly | null = null;
    if (keeperIdx >= 0) {
      keeper = A;
      const kc = comps[keeperIdx];
      const lost = A.parts.filter((p) => !kc.includes(p));
      // remove lost colliders
      for (const p of lost) {
        const col = A.colliders[p];
        if (col) {
          this.colliderMap.delete(col.handle);
          this.ctx.physics.removeCollider(col);
          A.colliders[p] = null;
        }
      }
      const mp = computeMassProps(s, kc, this.mpTmp);
      compVel(kc, mp, newV, newW, true);
      A.body.setAdditionalMassProperties(mp.mass, mp.com, mp.principal, mp.frame, true);
      A.body.setLinvel(newV, true);
      A.body.setAngvel(newW, true);
      A.mp.mass = mp.mass;
      A.mp.com.copy(mp.com);
      A.mp.I.set(mp.I);
      A.mp.principal.copy(mp.principal);
      A.mp.frame.copy(mp.frame);
      A.mp.Imin = mp.Imin;
      A.setParts(kc);
      A.radius = this.radiusOf(s, A);
      A.read();
      if (A.piece) {
        A.piece.parts = kc.map((p) => s.parts[p].name);
        A.piece.mass = mp.mass;
        A.piece.hasCockpit = kc.some((p) => s.parts[p].isCockpit);
      }
      A.spinSign = this.wingSpin(rt, A);
      if (A.tracked && lost.length) {
        const names = lost.filter((p) => !rt.gone[p]).map((p) => s.parts[p].name);
        try {
          rt.plane.onPartsLost(lost.map((p) => s.parts[p].name));
        } catch (err) {
          console.error('[breakup] onPartsLost threw', err);
        }
        this.stats.events.push(`partsLost:${names.join(',')}`);
        // new pieces start inside the full-size boxes of the surviving body → brief collision grace
        for (const c of created) this.setGhost(c, true);
      }
    } else {
      // the original body is replaced by pieces
      for (const p of A.parts) {
        const col = A.colliders[p];
        if (col) this.colliderMap.delete(col.handle);
      }
      A.removed = true;
      if (A.tracked) {
        const plane = rt.plane;
        this.ctx.physics.removeBody(A.body);
        rt.asms.splice(rt.asms.indexOf(A), 1);
        rt.tracked = null;
        plane.body = null;
        this.syncPieces();
        const cockpit = created.find((c) => c.piece?.hasCockpit)?.piece ?? null;
        try {
          plane.onSplit(created.map((c) => c.piece!), cockpit);
        } catch (err) {
          console.error('[breakup] onSplit threw', err);
        }
        this.stats.events.push(`split:${created.length}`);
      } else {
        this.removeAsm(rt, A, false);
      }
    }
    return { keeper, created };
  }

  private createPiece(rt: PlaneRT, parent: Assembly, parts: number[], mp: MassProps, v: THREE.Vector3, w: THREE.Vector3): Assembly {
    const s = rt.s;
    const { physics, engine } = this.ctx;
    const cfg = CONFIG.breakup;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(parent.pos.x, parent.pos.y, parent.pos.z)
      .setRotation({ x: parent.quat.x, y: parent.quat.y, z: parent.quat.z, w: parent.quat.w })
      .setLinvel(v.x, v.y, v.z)
      .setAngvel({ x: w.x, y: w.y, z: w.z })
      .setAdditionalMassProperties(mp.mass, { x: mp.com.x, y: mp.com.y, z: mp.com.z }, { x: mp.principal.x, y: mp.principal.y, z: mp.principal.z }, {
        x: mp.frame.x,
        y: mp.frame.y,
        z: mp.frame.z,
        w: mp.frame.w,
      })
      .setCcdEnabled(true)
      .setLinearDamping(0)
      .setAngularDamping(cfg.angularDamping);
    const body = physics.world.createRigidBody(desc);
    this.stats.bodiesCreated++;
    const group = new THREE.Group();
    group.name = `wreck-${rt.type}`;
    engine.scene.add(group);
    const asm = new Assembly(nextId++, body, false, s.parts.length, parts, group);
    asm.mp.mass = mp.mass;
    asm.mp.com.copy(mp.com);
    asm.mp.I.set(mp.I);
    asm.mp.principal.copy(mp.principal);
    asm.mp.frame.copy(mp.frame);
    asm.mp.Imin = mp.Imin;
    const threshold = Math.max(200, mp.mass * Math.abs(CONFIG.physics.gravity) * 0.25);
    for (const p of parts) {
      const pd = s.parts[p];
      const cd = RAPIER.ColliderDesc.cuboid(pd.ch.x, pd.ch.y, pd.ch.z)
        .setTranslation(pd.cc.x, pd.cc.y, pd.cc.z)
        .setDensity(0)
        .setFriction(cfg.friction)
        .setRestitution(cfg.restitution)
        .setCollisionGroups(groups(G.PLANE, this.pieceFilter(false)))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(threshold);
      const col = physics.world.createCollider(cd, body);
      physics.tag(col, { kind: 'wreck', material: 'metal', data: { part: pd.name } });
      asm.colliders[p] = col;
      this.colliderMap.set(col.handle, { rt, asm, part: p });
      rt.owner[p] = asm;
      // re-parent: every assembly uses the root frame as body frame → local transform unchanged
      group.add(pd.info.object);
    }
    asm.interp.copy(parent.interp);
    asm.interp.apply(group, 1);
    asm.read();
    asm.vPre.copy(asm.vel);
    asm.wPre.copy(asm.angvel);
    asm.radius = this.radiusOf(s, asm);
    asm.piece = new PieceImpl(asm.id, body, group, parts.map((p) => s.parts[p].name), mp.mass, parts.some((p) => s.parts[p].isCockpit));
    asm.spinSign = this.wingSpin(rt, asm);
    // contact state inherited (a piece born in contact keeps sliding without a fresh "impact")
    asm.cFrames = 0;
    asm.cGap = 999;
    asm.lastImpactT = parent.lastImpactT;
    asm.entered = parent.entered;
    asm.wetT = parent.wetT;
    asm.sliding = parent.sliding;
    rt.asms.push(asm);
    return asm;
  }

  private pieceFilter(ghost: boolean): number {
    const f = G.WORLD | G.PROP | G.PARKED | G.PLAYER | G.DEBRIS;
    return ghost ? f : f | G.PLANE;
  }

  private setGhost(a: Assembly, on: boolean): void {
    if (a.tracked) return;
    a.ghostT = on ? CONFIG.breakup.ghostTime : 0;
    const g = groups(G.PLANE, this.pieceFilter(on));
    for (const c of a.colliders) if (c) c.setCollisionGroups(g);
  }

  private toDebris(rt: PlaneRT, A: Assembly, comp: number[], debrisP: THREE.Vector3): void {
    const s = rt.s;
    for (const p of comp) {
      const pd = s.parts[p];
      const c = this.v3.copy(pd.com).applyQuaternion(A.quat).add(A.pos);
      const v = this.v4.subVectors(c, A.comW).crossVectors(A.angvel, this.v4).add(A.vel);
      debrisP.addScaledVector(v, pd.mass);
      this.ctx.fx.debrisBurst?.({ position: c, velocity: v, count: Math.round(THREE.MathUtils.clamp(pd.radius * 3, 3, 10)), size: Math.min(1.2, pd.radius * 0.45), kind: 'metal' });
      pd.info.object.visible = false;
      rt.hidden.push(pd.info.object);
      rt.gone[p] = 1;
      rt.owner[p] = null;
      if (A.tracked) {
        const col = A.colliders[p];
        if (col) {
          this.colliderMap.delete(col.handle);
          this.ctx.physics.removeCollider(col);
          A.colliders[p] = null;
        }
      }
    }
  }

  private maxBodies(rt: PlaneRT): number {
    const cfg = CONFIG.breakup;
    const base = (cfg.maxBodies as Record<string, number>)[rt.type] ?? 16;
    const low = this.ctx.quality?.level === 'low';
    return Math.max(3, Math.round(base * (low ? cfg.lowQualityBodyScale : 1)));
  }

  /** Momentum-neutral radial kick + small tumble, clamped to 10–25 % of airspeed in flight. */
  private blastKick(rt: PlaneRT, involved: Assembly[], blast: BlastInfo): void {
    const cfg = CONFIG.breakup.blast;
    const s = rt.s;
    let energy = blast.energy;
    if (!(energy > 50)) energy = Math.max(0.02, energy || 0.1) * Math.max(50, s.fuel);
    let air = 0;
    let mt = 0;
    for (const a of involved) {
      air += a.speed * a.mp.mass;
      mt += a.mp.mass;
    }
    air /= Math.max(1, mt);
    const inFlight = air > 25;
    const dvs: THREE.Vector3[] = [];
    const mean = new THREE.Vector3();
    // distance in units of 10 % of the plane length, so the fall-off reads the same on the prop and the jumbo
    const dRef = Math.max(0.5, 0.1 * s.length);
    for (const a of involved) {
      const d = a.comW.distanceTo(blast.center) / dRef;
      const raw = (cfg.k * energy) / (a.mp.mass * (1 + d * d));
      const cap = inFlight ? rnd(cfg.minFrac, cfg.maxFrac) * air : cfg.groundMax;
      const mag = Math.min(raw, cap);
      const dir = new THREE.Vector3().subVectors(a.comW, blast.center);
      if (dir.lengthSq() < 1e-4) dir.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1));
      dir.normalize();
      if (!inFlight) dir.y = Math.max(dir.y, 0.35);
      dir.normalize().multiplyScalar(mag);
      dvs.push(dir);
      mean.addScaledVector(dir, a.mp.mass);
    }
    mean.multiplyScalar(1 / Math.max(1, mt));
    if (inFlight) for (const dv of dvs) dv.sub(mean); // internal forces conserve momentum
    for (let i = 0; i < involved.length; i++) {
      const a = involved[i];
      const dv = dvs[i];
      if (a.tracked) {
        a.body.applyImpulse(dv.multiplyScalar(a.mp.mass), true);
      } else {
        const v = a.body.linvel();
        a.body.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true);
        const tumble = cfg.tumble / Math.cbrt(1 + a.mp.mass / 2000);
        const w = a.body.angvel();
        a.body.setAngvel({ x: w.x + rnd(-1, 1) * tumble, y: w.y + rnd(-1, 1) * tumble, z: w.z + rnd(-1, 1) * tumble }, true);
      }
      a.read();
    }
  }

  // ═══════════════════════════════════ blast extras (8a–8c) ═══════════════════════════════════

  private blastExtras(rt: PlaneRT, blast: BlastInfo, joints: number[], created: Assembly[]): void {
    const cfgP = CONFIG.planes[rt.type];
    const s = rt.s;
    const fx = this.ctx.fx;
    const anchor = rt.tracked ?? created[0] ?? null;
    if (!anchor) return;
    anchor.read();
    const vel = this.evVel.copy(anchor.vel);
    const surf = this.surfaceBelow(blast.center);
    const near: 'ground' | 'water' | null = blast.center.y - surf.y < 100 ? (surf.water ? 'water' : 'ground') : null;
    if (blast.kind === 'middle' || blast.kind === 'tail') {
      if (CONFIG.breakup.blastFx) {
        const radius = cfgP.explosionRadius * (blast.kind === 'middle' ? 0.38 : 0.3);
        this.explosionFx(blast.center, vel, radius, 'plane', near, true);
        this.evPos.copy(blast.center);
        this.ctx.events.emit('planeExplosion', { position: this.evPos, velocity: vel, radius, kind: blast.kind });
      }
    }
    if (blast.kind === 'middle') {
      // separating kick along the fuselage axis (front forward, rear back), momentum neutral + slight random rotation
      const front = created.find((c) => c.piece?.hasCockpit) ?? null;
      const rears = created.filter((c) => c !== front);
      if (front && rears.length) {
        const ax = this.v3.set(0, 0, 1).applyQuaternion(front.quat);
        const sep = CONFIG.breakup.blast.middleSeparation;
        let mr = 0;
        for (const r of rears) mr += r.mp.mass;
        const mt = mr + front.mp.mass;
        this.kickAsm(front, ax, (sep * mr) / mt);
        for (const r of rears) this.kickAsm(r, ax, (-sep * front.mp.mass) / mt);
        const spin = CONFIG.breakup.blast.middleSpin;
        for (const c of created) {
          const w = c.body.angvel();
          c.body.setAngvel({ x: w.x + rnd(-spin, spin), y: w.y + rnd(-spin, spin), z: w.z + rnd(-spin, spin) * 0.6 }, true);
        }
        // rear engines may keep running for a few seconds → corkscrew
        // (one of them usually chokes on debris right away → asymmetric thrust)
        const eng = this.ctx.planes?.state?.engines ?? [];
        for (const r of rears) {
          let first = true;
          const killFirst = Math.random() < 0.6;
          for (const p of r.parts) {
            const e = s.parts[p].engineIndex;
            if (!e) continue;
            const st = eng[e - 1];
            if (st && st.status !== 'ok') continue;
            const thrust = st?.thrust && st.thrust > 0 ? st.thrust : (rt.s.mass * 2.2) / Math.max(1, rt.plane.visual.engines.length);
            const dur = first && killFirst ? rnd(0.2, 0.8) : rnd(2.5, CONFIG.breakup.air.engineThrustTime + 1.5);
            first = false;
            r.thrust.push({ part: p, force: thrust, t: 0, dur });
          }
        }
      }
    }
    // torn edges: sparks + small fires spraying, then smoke; cabin depressurization for fuselage breaks
    for (const ji of joints) {
      const j = s.joints[ji];
      const fus = (k: string) => k === 'fuselage' || k === 'cockpit';
      const fuselageBreak = fus(s.parts[j.a].kind) && fus(s.parts[j.b].kind);
      const r = this.fuselageRadius(rt);
      for (const side of [0, 1]) {
        const part = side === 0 ? j.a : j.b;
        const nrm = j.normal.clone().multiplyScalar(side === 0 ? 1 : -1); // out of the opening of this side
        const keeperSide = rt.tracked ? rt.owner[part] === rt.tracked : true;
        if (blast.kind === 'middle' || (blast.kind === 'tail' && keeperSide) || fuselageBreak) {
          rt.torn.push({ part, local: j.pos.clone(), normal: nrm, t: 0, dur: CONFIG.breakup.fire.tornEdgeTime * rnd(0.8, 1.3), fxT: 0, mist: fuselageBreak ? 0.6 : 0 });
          if (blast.kind === 'middle' || (fuselageBreak && blast.kind !== 'tail')) {
            this.addFire(rt, part, j.pos, 0.55, 0.5, r * 0.7, CONFIG.breakup.fire.tornEdgeTime, rnd(6, 12), true);
          }
        }
      }
      if (fuselageBreak) {
        const a = rt.owner[j.a] ?? anchor;
        const pos = this.v4.copy(j.pos).applyQuaternion(a.quat).add(a.pos);
        const nW = this.v5.copy(j.normal).applyQuaternion(a.quat);
        const v = this.v1.copy(a.vel).addScaledVector(nW, -12);
        fx.mist?.(pos, v, r * 2.5);
        fx.debrisBurst?.({ position: pos, velocity: v, count: 26, size: 0.35, kind: 'paper' });
        fx.debrisBurst?.({ position: pos, velocity: v, count: 8, size: 0.55, kind: 'cushion' });
        fx.debrisBurst?.({ position: pos, velocity: this.v1.copy(a.vel), count: 12, size: r * 0.35, kind: 'panel' });
        this.ctx.fx.sparks(pos, nW, 1.2);
      }
    }
    if (blast.kind === 'tail') {
      // rear fuselage on fire: dense black trail (re-homed if the plane breaks up later)
      const tc = s.partIndex.get('tailCone') ?? s.partIndex.get('fuselageRear');
      if (tc !== undefined && !rt.gone[tc]) {
        const p = s.parts[tc];
        const local = p.bc.clone();
        local.z -= p.bh.z * 0.6;
        this.addFire(rt, tc, local, 1, 1, this.fuselageRadius(rt) * 1.5, 30, 30, false);
      }
      for (const c of created) if (!this.asmHasFire(rt, c)) this.smokeAsm(rt, c, rnd(6, 12));
    }
    if (blast.kind === 'engine') {
      for (const c of created) if (!this.asmHasFire(rt, c)) this.igniteAsm(rt, c, 0.8, rnd(20, 40));
    }
  }

  private kickAsm(a: Assembly, dir: THREE.Vector3, dv: number): void {
    const v = a.body.linvel();
    a.body.setLinvel({ x: v.x + dir.x * dv, y: v.y + dir.y * dv, z: v.z + dir.z * dv }, true);
    a.read();
  }

  // ═══════════════════════════════════ contacts & crashes ═══════════════════════════════════

  private onContact = (e: GameEvents['contact']): void => {
    const r1 = this.colliderMap.get(e.h1);
    const r2 = this.colliderMap.get(e.h2);
    if (r1) this.noteContact(r1.asm, r1.part, e.h1, e.h2, e.tag2, e.force);
    if (r2) this.noteContact(r2.asm, r2.part, e.h2, e.h1, e.tag1, e.force);
  };

  private noteContact(a: Assembly, part: number, mine: number, other: number, tag: ColliderTag | null, force: number): void {
    if (a.removed) return;
    a.cThisStep = true;
    const isSelf = tag?.kind === 'plane' || tag?.kind === 'wreck';
    // prefer world contacts over self contacts at similar force
    const f = isSelf ? force * 0.5 : force;
    if (f > a.cForce) {
      a.cForce = f;
      a.cPart = part;
      a.cMyHandle = mine;
      a.cOtherHandle = other;
      a.cTag = tag;
    }
  }

  private surfaceOf(tag: ColliderTag | null): { surface: Surface; material: SurfaceMaterial } {
    if (!tag) return { surface: 'ground', material: 'grass' };
    const m = tag.material;
    switch (tag.kind) {
      case 'road':
        return { surface: 'runway', material: m };
      case 'ground':
        return { surface: m === 'asphalt' || m === 'concrete' ? 'runway' : 'ground', material: m };
      case 'building':
        return { surface: 'building', material: m };
      case 'plane':
      case 'wreck':
        return { surface: 'self', material: 'metal' };
      default:
        return { surface: 'other', material: m };
    }
  }

  private onManifold = (m: RAPIER_T.TempContactManifold, flipped: boolean): void => {
    if (this.mfFound) return;
    const n = m.numSolverContacts();
    if (n === 0) return;
    const nr = m.normal();
    this.mfNormal.set(nr.x, nr.y, nr.z);
    this.mfFlip = flipped;
    this.mfPoint.set(0, 0, 0);
    let depth = 0;
    for (let i = 0; i < n; i++) {
      const p = m.solverContactPoint(i);
      if (p) this.mfPoint.x += p.x, this.mfPoint.y += p.y, this.mfPoint.z += p.z;
      depth = Math.min(depth, m.solverContactDist(i));
    }
    this.mfPoint.multiplyScalar(1 / n);
    this.mfDepth = depth;
    this.mfFound = true;
  };

  /** Exact contact point + normal (pointing from the surface toward our body) via the contact manifold. */
  private queryContact(a: Assembly): boolean {
    const world = this.ctx.physics.world;
    if (!world.colliders.contains(a.cMyHandle) || !world.colliders.contains(a.cOtherHandle)) return false;
    const c1 = world.getCollider(a.cMyHandle);
    const c2 = world.getCollider(a.cOtherHandle);
    this.mfFound = false;
    world.contactPair(c1, c2, this.onManifold);
    if (!this.mfFound) return false;
    // manifold normal points from its collider1 to collider2; we want other → mine
    a.cNormal.copy(this.mfNormal).multiplyScalar(this.mfFlip ? 1 : -1).normalize();
    a.cPoint.copy(this.mfPoint);
    return true;
  }

  /** Lowest corner (world) of a part box on an assembly — cheap contact point for sustained contacts. */
  private lowestCorner(rt: PlaneRT, a: Assembly, part: number, out: THREE.Vector3): THREE.Vector3 {
    const p = rt.s.parts[part];
    out.copy(p.bc).applyQuaternion(a.quat).add(a.pos);
    const q = a.quat;
    const ax = this.tAx;
    for (let k = 0; k < 3; k++) {
      ax.set(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0).applyQuaternion(q);
      const h = k === 0 ? p.bh.x : k === 1 ? p.bh.y : p.bh.z;
      out.addScaledVector(ax, -(ax.y >= 0 ? 1 : -1) * h);
    }
    return out;
  }

  private processContact(rt: PlaneRT, a: Assembly, dt: number): void {
    if (a.cPart < 0) return;
    const { surface, material } = this.surfaceOf(a.cTag);
    a.cSurface = surface;
    a.cMaterial = material;
    const g = Math.abs(CONFIG.physics.gravity);
    const fresh = a.cGap > 2 || a.cForce > 3 * a.mp.mass * g;
    if (fresh && this.queryContact(a)) {
      // velocity of the contact point before the step
      const r = this.v1.subVectors(a.cPoint, a.comW);
      const vpt = this.v2.crossVectors(a.wPre, r).add(a.vPre);
      // relative to the other body (self hits / props)
      if (surface === 'self' || surface === 'other') {
        const ref = this.colliderMap.get(a.cOtherHandle);
        if (ref) {
          const o = ref.asm;
          const ro = this.v3.subVectors(a.cPoint, o.comW);
          vpt.sub(this.v4.crossVectors(o.wPre, ro).add(o.vPre));
        }
      }
      const vnSigned = vpt.dot(a.cNormal);
      const vn = Math.max(0, -vnSigned);
      const vt = this.v3.copy(vpt).addScaledVector(a.cNormal, -vnSigned).length();
      const cfgC = CONFIG.breakup.crash;
      if (vn > cfgC.minVn && (rt.t - a.lastImpactT > 0.12 || vn > a.lastImpactVn * 1.5)) {
        this.handleImpact(rt, a, a.cPart, a.cPoint, a.cNormal, vpt, vn, vt, surface, material);
      }
    } else if (!fresh) {
      this.lowestCorner(rt, a, a.cPart, a.cPoint);
    } else {
      this.lowestCorner(rt, a, a.cPart, a.cPoint);
      a.cNormal.copy(UP);
    }
    // sustained contact: sliding (fx + scrape damage + ploughing). The intact plane rolling on its gear is not sliding.
    const pk = rt.s.parts[a.cPart].kind;
    if (surface !== 'self' && !(a.tracked && pk === 'gear')) {
      const vh = this.v4.copy(a.vel).addScaledVector(a.cNormal, -a.vel.dot(a.cNormal)).length();
      a.sliding = vh > 2;
      if (a.sliding) this.slideStep(rt, a, vh, surface, material, dt);
      if (a.tracked && !rt.crashed && !rt.belly && vh > 5 && (surface === 'runway' || surface === 'ground')) {
        let gearDown = true;
        try {
          gearDown = rt.plane.isGearDown();
        } catch {
          gearDown = true;
        }
        if (!gearDown) {
          // gear-up belly landing (even a gentle one) is a hard landing
          const vn = Math.max(0, -a.vel.dot(a.cNormal));
          const info = this.makeInfo(a, a.cPoint, a.vel, vn, vh, (Math.atan2(vn, vh) * 180) / Math.PI, rt.s.parts[a.cPart].name, 0.5 * a.mp.mass * a.speed * a.speed, surface === 'runway' ? 'runway' : 'ground');
          this.hardLanding(rt.plane, info);
        }
      }
    } else a.sliding = false;
  }

  private handleImpact(
    rt: PlaneRT, a: Assembly, part: number, point: THREE.Vector3, normal: THREE.Vector3, vpt: THREE.Vector3,
    vn: number, vt: number, surface: Surface, material: SurfaceMaterial,
  ): void {
    const cfg = CONFIG.breakup;
    vpt = this.impVel.copy(vpt);
    a.lastImpactT = rt.t;
    a.lastImpactVn = vn;
    this.stats.impacts++;
    const hard = surface === 'self' ? cfg.damage.selfHardness : surface === 'other' ? 0.35 : HARD[material] ?? 1;
    const pd = rt.s.parts[part];
    // tracked body touching on its gear: that's the plane system's touchdown logic (it calls hardLanding/crash)
    const gearTouch = a.tracked && pd.kind === 'gear' && vn < 9;
    const energy = 0.5 * a.mp.mass * (vn * vn + vt * vt);
    if (!gearTouch) {
      const sev = vn * hard + vt * hard * cfg.damage.tangentFactor;
      this.accumulateDamage(rt, a, point, sev, true);
    }
    // classification (intact body, cockpit piece or big pieces)
    let outcome: CrashOutcome | null = null;
    const angle = (Math.atan2(vn, Math.max(0.01, vt)) * 180) / Math.PI;
    const big = a.tracked || a.piece?.hasCockpit || a.mp.mass > 0.15 * rt.s.mass;
    if (surface !== 'self' && surface !== 'other' && !gearTouch) {
      if (surface === 'building') outcome = 'building';
      else if (a.tracked) {
        let gearDown = false;
        try {
          gearDown = rt.plane.isGearDown();
        } catch {
          gearDown = false;
        }
        if (vn >= cfg.crash.hardMaxVn || angle >= cfg.crash.hardMaxAngle || Math.abs(this.bankDeg(a)) >= 35) outcome = 'groundCrash';
        else if (!gearDown || vn > 4) outcome = 'hardLanding'; // belly / collapsing gear (a light tail strike is just a scrape)
      } else if (vn > 4) outcome = 'groundCrash';
    }
    if (outcome && big) {
      const info = this.makeInfo(a, point, vpt, vn, vt, angle, pd.name, energy, surface === 'building' ? 'building' : surface === 'runway' ? 'runway' : 'ground');
      if (a.tracked && outcome === 'hardLanding' && !rt.belly) {
        this.hardLanding(rt.plane, info);
      } else {
        this.reportCrash(rt, outcome, info);
        this.emitImpact(rt, a, point, vpt, outcome, info.surface, energy, vn, false);
      }
      if ((outcome === 'groundCrash' || outcome === 'building') && !rt.ignited && this.fuelLeft(rt) > 1 && (vn > 9 || energy > 0.5 * rt.s.mass * 900)) {
        // main fireball rolls on with the wreck's tangential velocity
        this.v4.copy(vpt).addScaledVector(normal, -vpt.dot(normal)).multiplyScalar(0.9);
        this.ignite(rt, point, this.v4, 'ground', THREE.MathUtils.clamp(0.6 + vn / 60, 0.6, 1.1));
      }
    } else if (!a.tracked && surface !== 'self' && vn > 8 && a.mp.mass > 0.03 * rt.s.mass && rt.t - a.lastEventT > 0.3) {
      a.lastEventT = rt.t;
      this.v4.copy(vpt);
      this.emitImpact(rt, a, point, this.v4, surface === 'building' ? 'building' : 'groundCrash', surface === 'building' ? 'building' : surface === 'runway' ? 'runway' : 'ground', energy, vn, false);
    }
    // fx
    const fx = this.ctx.fx;
    const k = THREE.MathUtils.clamp(vn / 25, 0.2, 1.5);
    if (surface === 'building') {
      fx.scorch?.(point, normal, Math.min(14, 2 + a.radius * 0.6));
      fx.sparks(point, normal, k);
      fx.dust(point, k, 0xbdb4a8);
    } else if (surface !== 'self') {
      if ((HARD[material] ?? 1) >= 0.9) fx.sparks(point, normal, k);
      fx.dust(point, k * Math.min(2, 0.4 + a.radius * 0.1), material === 'sand' ? 0xe6d3a8 : material === 'grass' ? 0x9a8a68 : 0xb8b0a4);
    } else if (vn > 4) fx.sparks(point, normal, k * 0.6);
    // a fuel piece taking a hard hit ruptures → secondary explosion
    if (rt.ignited && vn > cfg.fire.hardHitSecondary && this.asmFuel(rt, a) > 20 && rt.t - rt.lastSecT > 0.3 && rt.secCount < 7) this.secondary(rt, a);
  }

  private makeInfo(a: Assembly, point: THREE.Vector3, vel: THREE.Vector3, vn: number, vt: number, angle: number, part: string, energy: number, surface: ImpactSurface): ImpactInfo {
    return { position: point.clone(), velocity: vel.clone(), normalSpeed: vn, tangentSpeed: vt, angleDeg: angle, part, energy, surface };
  }

  private reportCrash(rt: PlaneRT, outcome: CrashOutcome, info: ImpactInfo): void {
    if (rt.crashed) return;
    rt.crashed = true;
    rt.outcome = outcome;
    if (this.stats.events.length > 60) this.stats.events.splice(0, 20);
    this.stats.events.push(`crash:${outcome}:${info.part}:vn${info.normalSpeed.toFixed(1)}:vt${info.tangentSpeed.toFixed(1)}`);
    try {
      rt.plane.onCrash(outcome, info);
    } catch (err) {
      console.error('[breakup] onCrash threw', err);
    }
  }

  private emitImpact(rt: PlaneRT, a: Assembly, pos: THREE.Vector3, vel: THREE.Vector3, outcome: CrashOutcome, surface: ImpactSurface, energy: number, vn: number, force: boolean): void {
    if (!force && rt.t - a.lastEventT < 0.25 && a.lastEventT >= 0) return;
    a.lastEventT = rt.t;
    this.evPos.copy(pos);
    this.evVel.copy(vel);
    this.ctx.events.emit('planeImpact', { position: this.evPos, velocity: this.evVel, outcome, surface, energy, normalSpeed: vn });
  }

  private emitBreak(rt: PlaneRT, pos: THREE.Vector3, vel: THREE.Vector3, pieces: number, intensity: number): void {
    this.evPos.copy(pos);
    this.evVel.copy(vel);
    this.ctx.events.emit('planeBreak', { position: this.evPos, velocity: this.evVel, pieces, intensity });
  }

  private bankDeg(a: Assembly): number {
    const right = this.tAtt.set(-1, 0, 0).applyQuaternion(a.quat);
    return (Math.asin(THREE.MathUtils.clamp(-right.y, -1, 1)) * 180) / Math.PI;
  }

  private pitchDeg(a: Assembly): number {
    const fwd = this.tAtt.set(0, 0, 1).applyQuaternion(a.quat);
    return (Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)) * 180) / Math.PI;
  }

  // ═══════════════════════════════════ joint damage ═══════════════════════════════════

  /**
   * Damage joints of an assembly from an impact of severity `sev` (m/s) at world point p: local term decays with the
   * distance to the joint (radius ∝ plane length), global term shakes the whole frame on violent impacts; both divided
   * by joint strength (weakest first). `offset`: subtract the no-damage threshold v0 (instant impacts).
   */
  private accumulateDamage(rt: PlaneRT, a: Assembly, pWorld: THREE.Vector3, sev: number, offset: boolean): void {
    const cfg = CONFIG.breakup.damage;
    const s = rt.s;
    const local = this.tDmg.copy(pWorld).sub(a.pos).applyQuaternion(this.q1.copy(a.quat).invert());
    const R = Math.max(1.5, cfg.radiusFrac * s.length);
    const sl = offset ? sev - cfg.v0 : sev;
    const sg = offset ? (sev - cfg.globalV0) * cfg.globalFrac : 0;
    if (sl <= 0 && sg <= 0) return;
    for (const j of s.joints) {
      if (rt.broken[j.i] || !a.has[j.a] || !a.has[j.b]) continue;
      const d = j.pos.distanceTo(local);
      let dmg = 0;
      if (sl > 0) dmg += (sl / (cfg.vBreak * j.strength)) * Math.exp(-d / R);
      if (sg > 0) dmg += sg / (cfg.vBreak * j.strength);
      if (dmg <= 0) continue;
      rt.damage[j.i] += dmg;
      if (rt.damage[j.i] >= 1 && !rt.pendingDamage.includes(j.i)) rt.pendingDamage.push(j.i);
    }
  }

  private flushDamage(rt: PlaneRT, a: Assembly, sctx: SplitCtx): void {
    if (!rt.pendingDamage.length) return;
    const idx = rt.pendingDamage.filter((ji) => a.has[rt.s.joints[ji].a]);
    rt.pendingDamage = rt.pendingDamage.filter((ji) => !idx.includes(ji));
    if (idx.length) this.breakInternal(rt, idx, sctx);
  }

  private flushPending(rt: PlaneRT): void {
    if (!rt.pendingDamage.length) return;
    // group by assembly; impact context from the assembly's last contact
    const byAsm = new Map<Assembly, number[]>();
    for (const ji of rt.pendingDamage) {
      const j = rt.s.joints[ji];
      const a = rt.owner[j.a];
      if (!a || rt.broken[ji] || rt.owner[j.b] !== a) continue;
      let l = byAsm.get(a);
      if (!l) byAsm.set(a, (l = []));
      l.push(ji);
    }
    rt.pendingDamage = [];
    for (const [a, idx] of byAsm) {
      const fresh = rt.t - a.lastImpactT < 0.05 && a.cPart >= 0;
      const sctx: SplitCtx = fresh
        ? { reason: 'impact', impact: { part: a.cPart, point: a.cPoint.clone(), normal: a.cNormal.clone() } }
        : { reason: a.wet > 0 ? 'water' : 'api' };
      this.breakInternal(rt, idx, sctx);
    }
  }

  // ═══════════════════════════════════ water ═══════════════════════════════════

  private waterYFor(a: Assembly, t: number): number | null {
    const dx = a.comW.x - a.waterQx;
    const dz = a.comW.z - a.waterQz;
    if (dx * dx + dz * dz < 64 && t - a.waterQt < 0.5) return a.waterY;
    a.waterQx = a.comW.x;
    a.waterQz = a.comW.z;
    a.waterQt = t;
    let y: number | null = null;
    const terrain = this.ctx.terrain;
    if (terrain && typeof terrain.waterAt === 'function') {
      try {
        y = terrain.waterAt(a.comW.x, a.comW.z);
      } catch {
        y = null;
      }
    } else {
      const wl = CONFIG.world.waterLevel;
      y = this.ctx.world.groundHeightAt(a.comW.x, a.comW.z) < wl - 0.3 ? wl : null;
    }
    a.waterY = y;
    return y;
  }

  private surfaceBelow(p: THREE.Vector3): { y: number; water: boolean } {
    let wy: number | null = null;
    try {
      wy = this.ctx.terrain?.waterAt?.(p.x, p.z) ?? null;
    } catch {
      wy = null;
    }
    let gy = 0;
    try {
      gy = this.ctx.world.groundHeightAt(p.x, p.z);
    } catch {
      gy = 0;
    }
    if (wy !== null && wy > gy) return { y: wy, water: true };
    return { y: gy, water: false };
  }

  private waterStep(rt: PlaneRT, a: Assembly, wy: number, dt: number): void {
    const res = this.forces.waterForces(rt.s, a, rt.broken, rt.flood, wy, dt);
    a.wet = res.wetFrac;
    if (!res.wet) return;
    this.sumF.add(this.forces.F);
    this.sumT.add(this.forces.T);
    a.waterF.copy(this.forces.F);
    if (!a.entered) {
      a.entered = true;
      this.waterEntry(rt, a, res.deepest, res.deepestVel, wy);
    }
    a.wetT += dt;
    // continuous hydrodynamic deceleration → joint damage (water ≈ concrete at speed)
    const cfgD = CONFIG.breakup.damage;
    const acc = res.dragMag / a.mp.mass;
    if (acc > cfgD.waterAccel0) {
      a.cPoint.copy(res.centroid);
      this.accumulateDamage(rt, a, res.centroid, (acc - cfgD.waterAccel0) * dt * cfgD.waterScale, false);
    }
    // flooding (submerged parts; open ends flood much faster)
    const floodT = CONFIG.breakup.water.floodTime;
    for (const p of a.parts) {
      if (rt.flood[p] >= 1) continue;
      const pd = rt.s.parts[p];
      const cy = this.v1.copy(pd.bc).applyQuaternion(a.quat).add(a.pos).y;
      if (cy - pd.radius * 0.5 > wy) continue;
      let open = 0;
      for (const js of pd.faceJoints) for (const ji of js) if (rt.broken[ji]) open++;
      rt.flood[p] = Math.min(1, rt.flood[p] + (dt / floodT) * rt.floodK[p] * (1 + 2.5 * Math.min(2, open)) * (a.wetT > CONFIG.breakup.water.maxTime ? 4 : 1));
    }
  }

  private waterEntry(rt: PlaneRT, a: Assembly, point: THREE.Vector3, vel: THREE.Vector3, wy: number): void {
    const cfg = CONFIG.breakup;
    const speed = vel.length();
    const vn = Math.max(0, -vel.y);
    const vh = Math.hypot(vel.x, vel.z);
    const angle = (Math.atan2(vn, Math.max(0.01, vh)) * 180) / Math.PI;
    const fx = this.ctx.fx;
    const pos = this.v3.set(point.x, wy, point.z);
    fx.splash?.({ position: pos, velocity: vel, size: THREE.MathUtils.clamp(Math.cbrt(a.mp.mass) * 0.12, 0.4, 8) * (0.5 + Math.min(1.5, speed / 60)) });
    if (!fx.splash) fx.dust(pos, Math.min(2, speed / 30), 0xffffff);
    // slam: at speed water behaves like concrete
    const hs = cfg.water.slamHardSpeed;
    const hard = THREE.MathUtils.clamp((speed - hs[0]) / (hs[1] - hs[0]), 0.12, 1);
    const sev = vn * hard + vh * hard * cfg.damage.waterTangent;
    this.accumulateDamage(rt, a, point, sev, true);
    if (this.asmHasFire(rt, a)) fx.steam?.(pos, Math.min(10, 2 + a.radius));
    if (rt.ignited && speed > 35 && this.asmFuel(rt, a) > 20 && rt.t - rt.lastSecT > 0.3 && rt.secCount < 7) this.secondary(rt, a);
    const big = a.tracked || a.piece?.hasCockpit || a.mp.mass > 0.15 * rt.s.mass;
    if (!big) return;
    const energy = 0.5 * a.mp.mass * speed * speed;
    let outcome: CrashOutcome = 'waterCrash';
    if (a.tracked) {
      const stall = CONFIG.planes[rt.type].stallKmh / 3.6;
      const pitch = this.pitchDeg(a);
      if (speed < cfg.water.ditchStallFactor * stall && Math.abs(this.bankDeg(a)) < 12 && pitch > -3 && pitch < 15 && vn < 6) outcome = 'ditching';
    }
    const part = rt.s.parts[this.nearestPart(rt, a, point)]?.name ?? 'fuselageCenter';
    const info = this.makeInfo(a, pos, vel, vn, vh, angle, part, energy, 'water');
    this.reportCrash(rt, outcome, info);
    this.emitImpact(rt, a, pos, vel, outcome, 'water', energy, vn, true);
    if (outcome === 'waterCrash' && speed > cfg.water.igniteSpeed && !rt.ignited && this.fuelLeft(rt) > 1) {
      // the impact fireball skims forward over the water with the wreck's momentum
      this.v4.set(vel.x, 0, vel.z).multiplyScalar(0.85);
      this.ignite(rt, pos, this.v4, 'water', THREE.MathUtils.clamp(0.5 + speed / 150, 0.5, 1));
    }
  }

  private nearestPart(rt: PlaneRT, a: Assembly, pWorld: THREE.Vector3): number {
    const local = this.tNear.copy(pWorld).sub(a.pos).applyQuaternion(this.q1.copy(a.quat).invert());
    let best = a.parts[0] ?? 0;
    let bd = Infinity;
    for (const p of a.parts) {
      const d = rt.s.parts[p].bc.distanceToSquared(local);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  // ═══════════════════════════════════ per-piece behaviour ═══════════════════════════════════

  /** Severed wings autorotate like sycamore seeds: spin about the wing normal toward a tip-speed ratio of the descent. */
  private autorotate(rt: PlaneRT, a: Assembly, dt: number): void {
    const cfg = CONFIG.breakup.air;
    if (cfg.wingAutorotate <= 0) return;
    let wing = -1;
    let area = 0;
    for (const p of a.parts) {
      const pd = rt.s.parts[p];
      if (pd.kind === 'wing' && pd.liftArea > area) {
        area = pd.liftArea;
        wing = p;
      }
    }
    if (wing < 0) return;
    const pd = rt.s.parts[wing];
    const descent = -a.vel.y;
    if (descent < 4) return;
    const nAx = pd.liftN;
    const n = this.v1.set(nAx === 0 ? 1 : 0, nAx === 1 ? 1 : 0, 0).applyQuaternion(a.quat);
    const flat = Math.abs(n.y);
    if (flat < 0.25) return;
    const span = Math.max(1, (nAx === 0 ? pd.bh.y : pd.bh.x) * 2 * Math.max(1, a.parts.length * 0.6));
    const target = a.spinSign * Math.sign(n.y) * cfg.autorotateTip * Math.min(descent, 60) / span * flat;
    const cur = a.angvel.dot(n);
    const In = a.mp.I[nAx * 4];
    const k = Math.min(1, cfg.wingAutorotate * dt * 2.5);
    this.sumT.addScaledVector(n, (In * (target - cur) * k) / dt);
  }

  /**
   * A piece that keeps wings + horizontal tail but lost the mass ahead of it (the rear section after a middle split)
   * keeps the tail down-load that trimmed the nose weight: nose-up moment ≈ g·Σ m_lost·(z_lost − z_com), scaled by
   * dynamic pressure, fading as the tail stalls → violent pitch-up, stall, spin.
   */
  private inheritTrim(rt: PlaneRT, parent: Assembly, piece: Assembly): void {
    const s = rt.s;
    let wing = false;
    let tail = false;
    for (const p of piece.parts) {
      const pd = s.parts[p];
      if (pd.kind === 'wing') wing = true;
      if (pd.kind === 'tail' && pd.liftN === 1) tail = true;
    }
    if (!wing || !tail) return;
    const g = Math.abs(CONFIG.physics.gravity);
    let m = 0;
    for (const p of parent.parts) {
      if (piece.has[p] || rt.gone[p]) continue;
      const dz = s.parts[p].com.z - piece.mp.com.z;
      if (dz > 0) m += s.parts[p].mass * dz;
    }
    if (m <= 0) return;
    piece.trimTorque = m * g * CONFIG.breakup.air.trimFactor;
    piece.trimQ0 = Math.max(100, 0.5 * (CONFIG.planes.airDensity ?? 1.225) * parent.speed * parent.speed);
    piece.trimT = 0;
  }

  private trimStep(a: Assembly, dt: number): void {
    a.trimT += dt;
    if (a.trimT > 8) {
      a.trimTorque = 0;
      return;
    }
    const vl = this.v1.copy(a.vel).applyQuaternion(this.q1.copy(a.quat).invert());
    const alpha = Math.abs(Math.atan2(-vl.y, Math.max(0.1, vl.z))); // body angle of attack
    const fly = vl.z <= 0 ? 0 : THREE.MathUtils.clamp(1 - (alpha - 0.26) / 0.35, 0, 1);
    const q = 0.5 * (CONFIG.planes.airDensity ?? 1.225) * a.speed * a.speed;
    const tau = a.trimTorque * Math.min(1.5, q / a.trimQ0) * fly;
    if (tau <= 0) return;
    this.sumT.add(this.v2.set(-tau, 0, 0).applyQuaternion(a.quat));
  }

  private wingSpin(rt: PlaneRT, a: Assembly): number {
    if (a.tracked) return 0;
    let wings = 0;
    let other = 0;
    let side = 0;
    for (const p of a.parts) {
      const pd = rt.s.parts[p];
      if (pd.kind === 'wing') {
        wings++;
        side += pd.com.x;
      } else if (pd.kind === 'fuselage' || pd.kind === 'cockpit') other++;
    }
    if (!wings || other) return 0;
    return side >= 0 ? 1 : -1;
  }

  private plough(rt: PlaneRT, a: Assembly): void {
    const soft = SOFT[a.cMaterial as SurfaceMaterial] ?? 0;
    if (soft <= 0 || a.cPart < 0) return;
    const g = Math.abs(CONFIG.physics.gravity);
    const vh = this.v1.set(a.vel.x, 0, a.vel.z);
    const sp = vh.length();
    if (sp < 1) return;
    vh.multiplyScalar(-1 / sp);
    const mag = soft * a.mp.mass * g * Math.min(1, sp / 6) * (1 + Math.min(1.5, sp / 40));
    const f = vh.multiplyScalar(mag);
    const p = this.lowestCorner(rt, a, a.cPart, this.v2);
    this.sumF.add(f);
    this.sumT.add(this.v3.subVectors(p, a.comW).cross(f));
  }

  private slideStep(rt: PlaneRT, a: Assembly, vh: number, surface: Surface, material: SurfaceMaterial, dt: number): void {
    const fx = this.ctx.fx;
    const cfg = CONFIG.breakup;
    a.slideT += dt;
    // scrape damage near the contacting part (engines scraping off, progressive belly-slide breakup)
    const hard = HARD[material] ?? 1;
    const sev = (vh / cfg.damage.scrapeV) * dt * hard * cfg.damage.vBreak;
    if (sev > 0) this.accumulateDamage(rt, a, a.cPoint, sev, false);
    const p = a.cPoint;
    a.fxT -= dt;
    if (a.fxT <= 0) {
      a.fxT = THREE.MathUtils.clamp(cfg.fx.sparkInterval * (30 / Math.max(5, vh)), 0.03, 0.2) / Math.max(0.4, this.ctx.quality?.current?.particleScale ?? 1);
      const back = this.v4.copy(a.vel).multiplyScalar(-1 / Math.max(0.1, a.speed));
      back.y = 0.45;
      if ((hard >= 0.9 || surface === 'building') && this.budgetSparks-- > 0) fx.sparks(p, back, THREE.MathUtils.clamp(vh / 35, 0.25, 1.3));
      if ((hard < 0.9 || Math.random() < 0.35) && this.budgetDust-- > 0) fx.dust(p, THREE.MathUtils.clamp(vh / 25, 0.3, 1.6) * Math.min(2, 0.5 + a.radius * 0.08), material === 'sand' ? 0xe6d3a8 : material === 'grass' ? 0x8f8060 : 0xb5ada0);
    }
    if (a.gougeValid) {
      const d = a.lastGouge.distanceTo(p);
      if (d > 10) a.lastGouge.copy(p);
      else if (d > cfg.fx.gougeStep && a.mp.mass > 0.015 * rt.s.mass && this.budgetGouge-- > 0) {
        const pd = rt.s.parts[a.cPart];
        const w = THREE.MathUtils.clamp(Math.min(pd.bh.x, pd.bh.z) * 1.4, 0.4, 4);
        fx.gouge?.(a.lastGouge, p, w);
        a.lastGouge.copy(p);
      }
    } else {
      a.lastGouge.copy(p);
      a.gougeValid = true;
    }
  }

  private postPiece(rt: PlaneRT, a: Assembly, dt: number): void {
    if (a.tracked) return;
    const cfg = CONFIG.breakup.water;
    // sinking & removal
    if (a.entered && a.waterY !== null) {
      const depth = a.waterY - a.comW.y;
      a.bubbleT -= dt;
      if (depth > -a.radius * 0.4 && a.vel.y < -0.03 && a.bubbleT <= 0) {
        a.bubbleT = rnd(0.25, 0.5);
        this.ctx.fx.bubbles?.(this.v1.set(a.comW.x, a.waterY, a.comW.z), Math.min(4, 0.5 + a.radius * 0.3));
      }
      if (depth > cfg.removeDepth + a.radius || (a.wetT > cfg.maxTime + 40 && depth > 0)) a.removed = true;
    }
    if (a.comW.y < (CONFIG.world.killY ?? -30) - 170) a.removed = true;
    if (a.speed < 0.3 && a.angvel.lengthSq() < 0.05) a.restT += dt;
    else a.restT = 0;
  }

  private removeAsm(rt: PlaneRT, a: Assembly, fade: boolean): void {
    for (const c of a.colliders) if (c) this.colliderMap.delete(c.handle);
    if (!a.tracked) {
      this.ctx.physics.removeBody(a.body);
      this.stats.bodiesRemoved++;
      a.group.removeFromParent();
      for (const p of a.parts) if (rt.owner[p] === a) rt.owner[p] = null;
      // fires on its parts die with it
      for (const f of rt.fires) {
        if (f.target === a.group) {
          f.handle.stop();
          f.t = 1e9;
        }
      }
      rt.fires = rt.fires.filter((f) => f.t < 1e9);
      rt.torn = rt.torn.filter((e) => rt.owner[e.part] !== null);
    }
    a.removed = true;
    void fade;
    if (!rt.asms.includes(a)) return;
    // the array is filtered by the caller in postStep; for direct removals filter now
    if (!this.inPost) rt.asms.splice(rt.asms.indexOf(a), 1);
    this.syncPieces();
  }

  private inPost = false;

  private syncTracked(rt: PlaneRT): void {
    const a = rt.tracked;
    if (!a) return;
    const b = rt.plane.body;
    if (b !== a.body || !this.ctx.physics.world.bodies.contains(a.body.handle)) {
      // the plane system replaced/removed the body behind our back → drop it (it will re-track)
      for (const c of a.colliders) if (c) this.colliderMap.delete(c.handle);
      a.removed = true;
      rt.asms.splice(rt.asms.indexOf(a), 1);
      rt.tracked = null;
      if (b && rt.registered) {
        rt.registered = false;
        this.track(rt.plane);
      }
    }
  }

  private syncPieces(): void {
    const out: WreckPiece[] = [];
    for (const rt of this.planes) for (const a of rt.asms) if (!a.removed && a.piece) out.push(a.piece);
    this.pieces = out;
    if (this.focusPiece && !out.includes(this.focusPiece)) this.focusPiece = null;
  }

  private updateFocus(force: boolean): void {
    this.focusT = force ? 0.5 : 0.35;
    let best: Assembly | null = null;
    let bs = -1;
    for (const rt of this.planes) {
      for (const a of rt.asms) {
        if (a.removed || !a.piece) continue;
        const score = a.mp.mass * (a.burning > 0.05 ? 1 + a.burning * 2 : 0.4);
        if (score > bs) {
          bs = score;
          best = a;
        }
      }
    }
    const cur = this.focusPiece as PieceImpl | null;
    // hysteresis: keep the current focus unless the new one is clearly better
    if (!force && cur && best && cur !== best.piece) {
      const ca = this.findAsmOfPiece(cur);
      if (ca && !ca.removed && ca.mp.mass * (ca.burning > 0.05 ? 1 + ca.burning * 2 : 0.4) > bs * 0.7) return;
    }
    this.focusPiece = best?.piece ?? null;
  }

  private findAsmOfPiece(p: PieceImpl): Assembly | null {
    for (const rt of this.planes) for (const a of rt.asms) if (a.piece === p) return a;
    return null;
  }

  // ═══════════════════════════════════ fire & fuel ═══════════════════════════════════

  private fuelLeft(rt: PlaneRT): number {
    let f = 0;
    for (let i = 0; i < rt.fuel.length; i++) if (!rt.gone[i]) f += rt.fuel[i];
    return f;
  }

  private asmFuel(rt: PlaneRT, a: Assembly): number {
    let f = 0;
    for (const p of a.parts) f += rt.fuel[p];
    return f;
  }

  private asmHasFire(rt: PlaneRT, a: Assembly): boolean {
    for (const f of rt.fires) if (f.target === a.group && f.fire > 0.05) return true;
    return false;
  }

  private biggest(rt: PlaneRT): Assembly | null {
    let b: Assembly | null = null;
    for (const a of rt.asms) if (!a.removed && (!b || a.mp.mass > b.mp.mass)) b = a;
    return b;
  }

  private fuselageRadius(rt: PlaneRT): number {
    const c = rt.s.partIndex.get('fuselageCenter') ?? rt.s.partIndex.get('fuselageFwd');
    if (c === undefined) return Math.max(0.5, rt.s.length * 0.05);
    const p = rt.s.parts[c];
    return Math.max(0.4, Math.max(p.bh.x, p.bh.y));
  }

  private maxTrails(): number {
    const m = CONFIG.breakup.fire.maxTrails as Record<string, number>;
    return m[this.ctx.quality?.level ?? 'medium'] ?? 8;
  }

  private activeFires(): number {
    let n = 0;
    for (const rt of this.planes) n += rt.fires.length;
    return n;
  }

  /** Attach a world-space fire/smoke trail at a part's local point; re-homed automatically when the part moves to another body. */
  private addFire(rt: PlaneRT, part: number, local: THREE.Vector3, fire: number, smoke: number, size: number, hold: number, cool: number, smokeAfter: boolean): void {
    const owner = rt.owner[part];
    if (!owner || rt.gone[part]) return;
    if (this.activeFires() >= this.maxTrails()) {
      // replace the weakest
      let weakest: FireRef | null = null;
      let wrt: PlaneRT | null = null;
      for (const r of this.planes) for (const f of r.fires) if (!weakest || f.fire + f.smoke * 0.3 < weakest.fire + weakest.smoke * 0.3) (weakest = f), (wrt = r);
      if (!weakest || weakest.fire + weakest.smoke * 0.3 >= fire + smoke * 0.3 || !wrt) return;
      weakest.handle.stop();
      wrt.fires.splice(wrt.fires.indexOf(weakest), 1);
    }
    const handle = this.trail(owner.group, local, fire, smoke, size);
    rt.fires.push({ handle, part, target: owner.group, local: local.clone(), fire, smoke, size, hold, cool, t: 0, smokeAfter });
  }

  private trail(target: THREE.Object3D, local: THREE.Vector3, fire: number, smoke: number, size: number): TrailHandle {
    const fx = this.ctx.fx;
    if (fx.attachTrail) return fx.attachTrail(target, local, { fire, smoke, size });
    const h = fx.attachFire(target, local, size);
    return { stop: () => h.stop(), setIntensity: () => {} };
  }

  private igniteAsm(rt: PlaneRT, a: Assembly, intensity: number, cool: number): void {
    // fire on the part carrying the most fuel
    let best = a.parts[0];
    let bf = -1;
    for (const p of a.parts) if (rt.fuel[p] > bf) (bf = rt.fuel[p]), (best = p);
    if (best === undefined) return;
    const pd = rt.s.parts[best];
    const size = THREE.MathUtils.clamp(Math.cbrt(a.mp.mass) * 0.18, 0.6, 7) * (0.6 + 0.6 * intensity);
    this.addFire(rt, best, pd.com, intensity, 1, size, rnd(3, 8), cool, false);
  }

  private smokeAsm(rt: PlaneRT, a: Assembly, dur: number): void {
    const p = a.parts[0];
    if (p === undefined) return;
    const size = THREE.MathUtils.clamp(Math.cbrt(a.mp.mass) * 0.12, 0.4, 4);
    this.addFire(rt, p, rt.s.parts[p].com, 0.05, 0.7, size, dur * 0.4, dur * 0.6, true);
  }

  private rehomeFires(rt: PlaneRT): void {
    for (const f of rt.fires) {
      const owner = rt.owner[f.part];
      if (!owner) {
        f.handle.stop();
        f.t = 1e9;
        continue;
      }
      if (owner.group !== f.target) {
        f.handle.stop();
        f.target = owner.group;
        f.handle = this.trail(owner.group, f.local, f.fire, f.smoke, f.size);
      }
    }
    rt.fires = rt.fires.filter((f) => f.t < 1e9);
  }

  private updateFires(rt: PlaneRT, dt: number): void {
    if (!rt.fires.length) {
      for (const a of rt.asms) a.burning = 0;
      return;
    }
    for (const a of rt.asms) a.burning = 0;
    for (const f of rt.fires) {
      f.t += dt;
      let k = 1;
      if (f.t > f.hold) k = Math.max(0, 1 - (f.t - f.hold) / Math.max(1, f.cool));
      const owner = rt.owner[f.part];
      // fire under water → steam + out
      if (owner && owner.waterY !== null && f.fire > 0.05) {
        const wp = this.v1.copy(f.local).applyQuaternion(owner.quat).add(owner.pos);
        if (wp.y < owner.waterY - 0.3) {
          this.ctx.fx.steam?.(this.v2.set(wp.x, owner.waterY, wp.z), Math.min(8, 1 + f.size));
          f.fire = 0;
          f.smoke *= 0.5;
          f.hold = Math.min(f.hold, f.t);
          f.cool = Math.min(f.cool, 3);
        }
      }
      const fire = f.smokeAfter && f.t > f.hold ? 0 : f.fire * k;
      const smoke = f.smoke * Math.min(1, 0.25 + k);
      f.handle.setIntensity(fire, smoke);
      if (owner) owner.burning = Math.max(owner.burning, fire);
      if (k <= 0) {
        f.handle.stop();
        f.t = 1e9;
      }
    }
    rt.fires = rt.fires.filter((f) => f.t < 1e9);
    for (const a of rt.asms) if (a.piece) a.piece.burning = a.burning;
  }

  /** Main fuel ignition at the first big impact: fireball moving with the wreck, secondaries, fires on fuel pieces. */
  private ignite(rt: PlaneRT, point: THREE.Vector3, vel: THREE.Vector3, surface: 'ground' | 'water', scale: number): void {
    if (rt.ignited) return;
    rt.ignited = true;
    const cfgF = CONFIG.breakup.fire;
    const fuel = this.fuelLeft(rt);
    const frac = fuel / Math.max(1, rt.s.fuel);
    const radius = CONFIG.planes[rt.type].explosionRadius * (0.5 + 0.4 * Math.min(1, frac)) * scale;
    this.explosionFx(point, vel, radius, 'impact', surface, true);
    this.evPos.copy(point);
    this.evVel.copy(vel);
    this.ctx.events.emit('planeExplosion', { position: this.evPos, velocity: this.evVel, radius, kind: 'secondary' });
    const n = Math.round(rnd(cfgF.secondaries[0], cfgF.secondaries[1]));
    let t = rt.t;
    for (let i = 0; i < n; i++) {
      t += rnd(cfgF.secInterval[0], cfgF.secInterval[1]);
      rt.secondaries.push(t);
    }
    // only wreckage in/near the fireball catches fire now; far pieces ignite at their own impact (secondary)
    const reach = radius * 1.5;
    for (const a of rt.asms) {
      if (a.removed || a.comW.distanceTo(point) > reach + a.radius) continue;
      for (const p of a.parts) rt.fuel[p] *= 0.75;
      const f = this.asmFuel(rt, a);
      if (f > 2) this.igniteAsm(rt, a, a.tracked ? 1 : 0.8, rnd(cfgF.coolMin, cfgF.coolMax));
    }
    if (surface === 'ground') this.pushProps(point, radius * 1.4, 10);
  }

  private secondary(rt: PlaneRT, prefer?: Assembly): void {
    let a = prefer ?? null;
    if (!a) {
      let best = -1;
      for (const x of rt.asms) {
        if (x.removed) continue;
        const f = this.asmFuel(rt, x) * rnd(0.5, 1.5);
        if (f > best) (best = f), (a = x);
      }
    }
    if (!a) return;
    rt.secCount++;
    rt.lastSecT = rt.t;
    const radius = CONFIG.planes[rt.type].explosionRadius * rnd(0.22, 0.42);
    const pos = this.v3.copy(a.comW);
    pos.x += rnd(-1, 1) * a.radius * 0.4;
    pos.z += rnd(-1, 1) * a.radius * 0.4;
    const surf = this.surfaceBelow(pos);
    pos.y = Math.max(pos.y, surf.y + 0.5);
    this.explosionFx(pos, a.vel, radius, 'secondary', pos.y - surf.y < 60 ? (surf.water ? 'water' : 'ground') : null, rt.secCount <= 2);
    this.evPos.copy(pos);
    this.evVel.copy(a.vel);
    this.ctx.events.emit('planeExplosion', { position: this.evPos, velocity: this.evVel, radius, kind: 'secondary' });
    for (const p of a.parts) rt.fuel[p] *= 0.6;
    if (!this.asmHasFire(rt, a) && this.asmFuel(rt, a) > 2) this.igniteAsm(rt, a, 0.8, rnd(CONFIG.breakup.fire.coolMin, CONFIG.breakup.fire.coolMax));
    if (!a.tracked) {
      const k = Math.min(4, 25000 / a.mp.mass + 0.8);
      a.body.applyImpulse({ x: rnd(-0.5, 0.5) * k * a.mp.mass, y: rnd(0.4, 1) * k * a.mp.mass, z: rnd(-0.5, 0.5) * k * a.mp.mass }, true);
    }
  }

  private explosionFx(pos: THREE.Vector3, vel: THREE.Vector3, radius: number, kind: 'plane' | 'secondary' | 'impact', near: 'ground' | 'water' | null, light: boolean): void {
    const fx = this.ctx.fx;
    if (fx.explosionEx) fx.explosionEx({ position: pos, velocity: vel, radius, kind, nearSurface: near, light });
    else fx.explosion(pos, radius / 6);
  }

  private pushProps(center: THREE.Vector3, radius: number, strength: number): void {
    try {
      this.ctx.physics.applyRadialImpulse(center, radius, strength, G.PROP | G.PARKED | G.DEBRIS | G.PLAYER, 0.4);
    } catch {
      /* physics not ready */
    }
  }

  /** Per-step wreck fx & fire bookkeeping: secondaries, fuel patches along the path, torn edges. */
  private wreckFxStep(rt: PlaneRT, dt: number): void {
    const cfgF = CONFIG.breakup.fire;
    const fx = this.ctx.fx;
    // scheduled secondary explosions
    if (rt.secondaries.length && rt.t >= rt.secondaries[0]) {
      rt.secondaries.shift();
      this.secondary(rt);
    }
    // burning fuel patches dropped along the slide / skim path
    if (rt.ignited) {
      const maxP = (cfgF.maxPatches as Record<string, number>)[this.ctx.quality?.level ?? 'medium'] ?? 22;
      for (const a of rt.asms) {
        if (a.removed || rt.patches >= maxP) continue;
        const fuel = this.asmFuel(rt, a);
        if (fuel < 3 || a.speed < 4) continue;
        const near = a.sliding || a.wet > 0 || a.cGap < 20;
        if (!near) continue;
        if (!a.patchValid) {
          a.lastPatch.copy(a.comW);
          a.patchValid = true;
          continue;
        }
        const dx = a.comW.x - a.lastPatch.x;
        const dz = a.comW.z - a.lastPatch.z;
        const spacing = cfgF.patchSpacing * (0.7 + Math.min(1.5, rt.s.length / 40));
        if (dx * dx + dz * dz < spacing * spacing) continue;
        a.lastPatch.copy(a.comW);
        const water = a.wet > 0 && a.waterY !== null;
        const y = water ? a.waterY! : this.surfaceBelow(a.comW).y;
        const size = THREE.MathUtils.clamp(rt.s.length * 0.09, 1.5, 7) * rnd(0.7, 1.3) * Math.min(1, 0.4 + fuel / Math.max(1, rt.s.fuel * 0.05));
        this.v1.set(a.comW.x, y + 0.05, a.comW.z);
        this.v2.copy(a.vel).multiplyScalar(0.25);
        this.v2.y = 0;
        fx.fuelFire?.({ position: this.v1, velocity: this.v2, size, duration: rnd(cfgF.patchDur[0], cfgF.patchDur[1]), onWater: water });
        rt.patches++;
        for (const p of a.parts) rt.fuel[p] *= 0.93;
      }
    }
    // torn edges: sparks + small fires spraying from the break line, cabin mist
    for (const e of rt.torn) {
      e.t += dt;
      const owner = rt.owner[e.part];
      if (!owner || e.t > e.dur) continue;
      e.fxT -= dt;
      if (e.fxT > 0) continue;
      e.fxT = rnd(0.06, 0.14);
      const pos = this.v1.copy(e.local).applyQuaternion(owner.quat).add(owner.pos);
      const n = this.v2.copy(e.normal).applyQuaternion(owner.quat);
      fx.sparks(pos, n, THREE.MathUtils.clamp(1 - e.t / e.dur, 0.2, 1));
      if (e.mist > 0 && e.t < 0.8) {
        fx.mist?.(pos, this.v3.copy(owner.vel).addScaledVector(n, 8), e.mist * 4);
      }
    }
    if (rt.torn.length && rt.torn.every((e) => e.t > e.dur)) rt.torn = [];
  }

  // ═══════════════════════════════════ hard landing helpers ═══════════════════════════════════

  private collapseGear(rt: PlaneRT, at: THREE.Vector3): void {
    const s = rt.s;
    const t = rt.tracked;
    if (!t) return;
    const gearJ: number[] = [];
    for (const j of s.joints) {
      if (rt.broken[j.i]) continue;
      if ((s.parts[j.a].kind === 'gear' || s.parts[j.b].kind === 'gear') && t.has[j.a] && t.has[j.b]) gearJ.push(j.i);
    }
    if (gearJ.length) {
      this.breakInternal(rt, gearJ, { reason: 'gear' });
      for (const ji of gearJ) {
        const j = s.joints[ji];
        const g = s.parts[j.a].kind === 'gear' ? j.a : j.b;
        const owner = rt.owner[g];
        if (owner && owner !== t) {
          // struts fold & snap: small sideways/backwards kick
          const v = owner.body.linvel();
          owner.body.setLinvel({ x: v.x + rnd(-2, 2), y: v.y + rnd(0.5, 2), z: v.z + rnd(-3, 0) }, true);
        }
      }
    }
    this.evPos.copy(at);
    this.ctx.events.emit('gearCollapse', { position: this.evPos });
    try {
      rt.plane.onGearCollapse();
    } catch (err) {
      console.error('[breakup] onGearCollapse threw', err);
    }
  }

  private radiusOf(s: Structure, a: Assembly): number {
    let r = 0.5;
    for (const p of a.parts) {
      const pd = s.parts[p];
      r = Math.max(r, pd.bc.distanceTo(a.mp.com) + pd.radius);
    }
    return r;
  }
}
