import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { BodyInterpolator, G, RAPIER, groups } from '../core/Physics';
import type { GameContext } from '../game/contracts';
import type { PlaneTypeId, PlaneVisual, TrackedPlane } from '../plane/types';

export interface SkyPlane {
  id: number;
  type: PlaneTypeId;
  name: string;
  visual: PlaneVisual;
  tracked: TrackedPlane;
  interp: BodyInterpolator;
  yaw: number; // heading (forward = sin yaw, 0, cos yaw)
  speed: number;
  alt: number; // target altitude (absolute y)
  bank: number;
  turn: number; // rad/s
  turnT: number;
  climbCheck: number;
  hit: boolean;
  hitT: number;
  down: boolean; // reached the ground
  pos: THREE.Vector3; // world (LOCAL coords)
  vel: THREE.Vector3;
  prev: THREE.Vector3;
  collHandles: Set<number>;
  ramNear?: boolean;
  cruise: number;
}

const TYPES: PlaneTypeId[] = ['jumbo', 'airliner', 'airliner', 'bizjet', 'jumbo', 'airliner', 'bizjet', 'prop', 'airliner', 'bizjet'];
const LABEL: Record<PlaneTypeId, string> = { prop: 'Prop plane', bizjet: 'Private jet', airliner: 'Airliner', jumbo: 'Jumbo 747' };
const ALT: Record<PlaneTypeId, [number, number]> = { prop: [380, 750], bizjet: [1100, 1900], airliner: [1300, 2400], jumbo: [1500, 2600] };
const SPEED: Record<PlaneTypeId, number> = { prop: 58, bizjet: 165, airliner: 150, jumbo: 160 };

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

/**
 * PERPETUAL SKY TRAFFIC (user request): jumbos, airliners, private jets and a few prop planes always flying across the
 * area around you in different directions, at their own heights, shown on the map. Each is a real plane (the same
 * visual, colliders and breakup registration as yours): a missile, a nuke or a mid-air collision breaks it apart and it
 * falls and crashes like any other plane. Planes that leave the area are recycled into new arrivals at the edge.
 */
export class AirTraffic {
  readonly planes: SkyPlane[] = [];
  private nextId = 1;
  private pool = new Map<PlaneTypeId, PlaneVisual[]>();
  private spawnIdx = 0;
  /** The plane being rammed by you: it holds its course and drifts to your height (crash toy: it should connect). */
  ramId: number | null = null;
  ramAlt = 0;
  readonly ramFrom = new THREE.Vector3();
  readonly ramVel = new THREE.Vector3();
  private started = false;

  constructor(private ctx: GameContext) {}

  init(): void {
    this.ctx.events.on('originShift', ({ delta }) => {
      for (const p of this.planes) {
        p.pos.sub(delta);
        p.prev.sub(delta);
      }
    });
  }

  private target(): number {
    const T = CONFIG.missiles.traffic;
    return (T.count as Record<string, number>)[this.ctx.quality.level] ?? 10;
  }

  private ground(x: number, z: number): number {
    try {
      const g = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(g) ? Math.max(0, g) : 0;
    } catch {
      return 0;
    }
  }

  /** Highest ground along a line ahead (for a safe cruise height over the mountains). */
  private groundAhead(x: number, z: number, yaw: number, dist: number): number {
    let m = 0;
    for (let d = 0; d <= dist; d += dist / 6) m = Math.max(m, this.ground(x + Math.sin(yaw) * d, z + Math.cos(yaw) * d));
    return m;
  }

  private spawn(initial: boolean): void {
    const { ctx } = this;
    const T = CONFIG.missiles.traffic;
    const f = ctx.engine.camera.position;
    const type = TYPES[this.spawnIdx++ % TYPES.length];
    const ang = Math.random() * Math.PI * 2;
    const r = initial ? T.spawnR * (0.25 + 0.75 * Math.random()) : T.spawnR;
    const x = f.x + Math.cos(ang) * r;
    const z = f.z + Math.sin(ang) * r;
    // across the area: roughly toward the middle, never straight at it
    const yaw = Math.atan2(f.x - x, f.z - z) + (Math.random() - 0.5) * 1.6;
    const [a0, a1] = ALT[type];
    let alt = a0 + Math.random() * (a1 - a0);
    alt = Math.max(alt, this.groundAhead(x, z, yaw, 3000) + 380);
    const speed = SPEED[type] * (0.9 + Math.random() * 0.2);
    let visual = this.pool.get(type)?.pop() ?? null;
    if (visual) visual.repair();
    else visual = ctx.planeModels.create(type);
    if (!visual.root.parent) ctx.engine.scene.add(visual.root);
    visual.root.visible = true;
    visual.setLights({ nav: true, strobe: true, beacon: true, landing: false });
    _e.set(0, yaw, 0);
    _q.setFromEuler(_e);
    const vel = new THREE.Vector3(Math.sin(yaw) * speed, 0, Math.cos(yaw) * speed);
    const body = ctx.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, alt, z)
        .setRotation(_q)
        .setLinvel(vel.x, 0, vel.z)
        .setCanSleep(false)
        .setGravityScale(0)
        .setLinearDamping(0)
        .setAngularDamping(0.3)
        .setAdditionalMassProperties(visual.mass, { x: 0, y: 0, z: 0 }, { x: visual.inertia.x, y: visual.inertia.y, z: visual.inertia.z }, { x: 0, y: 0, z: 0, w: 1 }),
    );
    const id = this.nextId++;
    const coll = new Set<number>();
    for (const part of visual.parts) {
      if (part.kind === 'gear') continue;
      const h = part.halfExtents;
      if (!(h.x > 0.01 && h.y > 0.01 && h.z > 0.01)) continue;
      const desc = RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setTranslation(part.boxCenter.x, part.boxCenter.y, part.boxCenter.z)
        .setDensity(0)
        .setFriction(0.5)
        .setRestitution(0.05)
        .setCollisionGroups(groups(G.PLANE, G.WORLD | G.PLANE | G.DEBRIS))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(visual.mass * CONFIG.planes.contactForceFactor);
      const col = ctx.physics.world.createCollider(desc, body);
      ctx.physics.tag(col, { kind: 'plane', material: 'metal', data: { part: part.name, sky: id } });
      coll.add(col.handle);
    }
    visual.root.position.set(x, alt, z);
    visual.root.quaternion.copy(_q);
    const p: SkyPlane = {
      id, type, name: `${LABEL[type]} · ${visual.livery}`, visual, tracked: null as unknown as TrackedPlane, interp: new BodyInterpolator(),
      yaw, speed, cruise: speed, alt, bank: 0, turn: 0, turnT: 6 + Math.random() * 12, climbCheck: 0, hit: false, hitT: 0, down: false,
      pos: new THREE.Vector3(x, alt, z), vel, prev: new THREE.Vector3(x, alt, z), collHandles: coll,
    };
    const t: TrackedPlane & { persistent?: boolean; sky?: number } = {
      type, visual, body, brokenJoints: new Set<string>(), persistent: true, sky: id,
      isGearDown: () => false,
      onGearCollapse: () => {},
      onPartsLost: () => {},
      onSplit: () => this.markHit(p),
      onCrash: () => {
        this.markHit(p);
        p.down = true;
      },
    };
    p.tracked = t;
    p.interp.reset(body);
    try {
      ctx.breakup.track(t);
    } catch {
      /* breakup not ready */
    }
    this.planes.push(p);
  }

  /** The plane was hit (missile, nuke, collision): it stops flying and falls with its momentum. */
  markHit(p: SkyPlane): void {
    if (p.hit) return;
    p.hit = true;
    p.hitT = 0;
    const b = this.body(p);
    if (b) {
      b.setGravityScale(CONFIG.planes.gravity / Math.abs(CONFIG.physics.gravity || -9.81), true);
      b.setAngularDamping(0.05);
      // a damaged plane rolls off and noses down
      b.setAngvel({ x: (Math.random() - 0.5) * 0.4, y: (Math.random() - 0.5) * 0.3, z: (Math.random() - 0.5) * 0.9 }, true);
      b.enableCcd(true);
    }
    p.visual.setLights({ nav: false, strobe: false, beacon: false, landing: false });
  }

  /** The plane's live body (null once split / removed). */
  body(p: SkyPlane): RAPIER_T.RigidBody | null {
    const b = p.tracked.body;
    if (!b) return null;
    try {
      return this.ctx.physics.world.bodies.contains(b.handle) ? b : null;
    } catch {
      return null;
    }
  }

  byCollider(handle: number): SkyPlane | null {
    for (const p of this.planes) if (p.collHandles.has(handle)) return p;
    return null;
  }

  // ───────────────────────────── simulation ─────────────────────────────
  fixedUpdate(dt: number): void {
    if (this.ctx.game.state !== 'driving') return;

    for (const p of this.planes) {
      const b = this.body(p);
      if (!b) continue;
      if (p.hit) {
        // fell where there are no ground colliders (far from you): the analytic ground catches it — total breakup
        const t = b.translation();
        if (!p.down && t.y < this.ground(t.x, t.z) + 2) {
          p.down = true;
          try {
            this.ctx.breakup.explodeTotal(p.tracked);
          } catch {
            /* already gone */
          }
        }
        continue;
      }
      if (p.id === this.ramId) {
        // unaware, it drifts onto a collision course with you (spectacle over realism: a ram should connect)
        const t0 = b.translation();
        const dist = Math.hypot(this.ramFrom.x - t0.x, this.ramFrom.y - t0.y, this.ramFrom.z - t0.z);
        const near = dist < 2500;
        // lead you: where you will be when it gets there
        const tgo = near ? dist / Math.max(60, p.speed + this.ramVel.length()) : 0;
        const aimX = this.ramFrom.x + this.ramVel.x * tgo, aimZ = this.ramFrom.z + this.ramVel.z * tgo;
        const want = Math.atan2(aimX - t0.x, aimZ - t0.z);
        p.speed = near ? Math.max(p.cruise, this.ramVel.length() + 60) : p.cruise;
        let err = want - p.yaw;
        err = Math.atan2(Math.sin(err), Math.cos(err));
        // the last few hundred metres: it swerves straight into you (no pursuit orbit)
        const lim = near ? (dist < 700 ? 0.5 : 0.25) : 0.07;
        p.turn = THREE.MathUtils.clamp(err * (near ? 2.5 : 0.4), -lim, lim);
        p.turnT = 5;
        p.alt = near ? this.ramFrom.y + this.ramVel.y * tgo : p.alt + (this.ramAlt - p.alt) * Math.min(1, dt * 0.35);
        p.ramNear = near;
      }
      // cruise: gentle random turns, altitude hold over the terrain
      p.turnT -= dt;
      if (p.turnT <= 0) {
        p.turnT = 10 + Math.random() * 25;
        p.turn = Math.random() < 0.45 ? 0 : (Math.random() - 0.5) * 0.05;
      }
      p.climbCheck -= dt;
      const t = b.translation();
      if (p.climbCheck <= 0) {
        p.climbCheck = 2;
        p.alt = Math.max(p.alt, this.groundAhead(t.x, t.z, p.yaw, 2500) + 350);
      }
      p.yaw += p.turn * dt;
      const vy = p.ramNear && p.id === this.ramId ? THREE.MathUtils.clamp((p.alt - t.y) * 1.2, -45, 45) : THREE.MathUtils.clamp((p.alt - t.y) * 0.15, -12, 12);
      const bankT = Math.atan((p.turn * p.speed) / 9.81);
      p.bank += (bankT - p.bank) * Math.min(1, dt * 0.8);
      const pitch = Math.asin(THREE.MathUtils.clamp(vy / p.speed, -0.3, 0.3));
      _e.set(-pitch, p.yaw, p.bank);
      _q.setFromEuler(_e);
      b.setRotation(_q, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.vel.set(Math.sin(p.yaw) * p.speed, vy, Math.cos(p.yaw) * p.speed);
      b.setLinvel(p.vel, true);
    }
  }

  postStep(): void {
    for (const p of this.planes) {
      const b = this.body(p);
      if (b) p.interp.capture(b);
    }
  }

  update(dt: number, alpha: number): void {
    const { ctx } = this;
    if (ctx.game.state !== 'driving') return;
    if (!this.started) {
      this.started = true;
      for (let i = 0; i < this.target(); i++) this.spawn(true);
    }
    const cam = ctx.engine.camera.position;
    const T = CONFIG.missiles.traffic;
    for (const p of this.planes) {
      const b = this.body(p);
      if (b) {
        p.interp.apply(p.visual.root, alpha);
        p.pos.copy(p.visual.root.position);
      } else {
        // split: follow the biggest piece holding the centre fuselage (else any part still in the scene)
        const part = p.visual.partByName.fuselageCenter ?? p.visual.parts[0];
        if (part?.object.parent) {
          part.object.updateWorldMatrix(true, false);
          p.pos.setFromMatrixPosition(part.object.matrixWorld);
        }
      }
      if (dt > 0) {
        if (!b || p.hit) p.vel.subVectors(p.pos, p.prev).divideScalar(dt).clampLength(0, 600);
        p.prev.copy(p.pos);
      }
      if (p.hit) p.hitT += dt;
      const lod = p.visual.lodForDistance?.(cam.distanceTo(p.pos));
      if (lod !== undefined) p.visual.setLod?.(lod);
      p.visual.update(dt);
    }
    // recycle: intact planes that left the area; wrecks after a while (or far away)
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const p = this.planes[i];
      const d = Math.hypot(p.pos.x - cam.x, p.pos.z - cam.z);
      const done = p.hit ? p.hitT > T.wreckKeepS || d > T.despawnR * 1.6 : d > T.despawnR;
      if (!done) continue;
      this.remove(p, !p.hit);
      this.planes.splice(i, 1);
    }
    let alive = 0;
    for (const p of this.planes) if (!p.hit) alive++;
    for (let k = alive; k < this.target(); k++) this.spawn(false);
  }

  private remove(p: SkyPlane, reuse: boolean): void {
    const { ctx } = this;
    try {
      ctx.breakup.untrack(p.tracked);
      (ctx.breakup as { drop?: (t: TrackedPlane) => void }).drop?.(p.tracked);
    } catch {
      /* gone */
    }
    const b = this.body(p);
    if (b) ctx.physics.removeBody(b);
    p.tracked.body = null;
    if (reuse) {
      p.visual.root.visible = false;
      let list = this.pool.get(p.type);
      if (!list) this.pool.set(p.type, (list = []));
      if (list.length < 2) list.push(p.visual);
      else p.visual.dispose();
    } else p.visual.dispose();
  }

  dispose(): void {
    for (const p of this.planes) this.remove(p, false);
    this.planes.length = 0;
    for (const list of this.pool.values()) for (const v of list) v.dispose();
    this.pool.clear();
  }

  /** Where a sky plane will be in `t` seconds (straight-line lead). */
  lead(p: SkyPlane, t: number, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(p.pos).addScaledVector(p.vel, t);
  }
}
void _v;
