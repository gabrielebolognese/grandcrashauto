import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { EventBus } from './EventBus';
import type { GameEvents } from './events';

export { RAPIER };

/**
 * Thin wrapper around the Rapier world. Owner: core.
 *  - Fixed 60 Hz step driven by the Engine loop (never call world.step yourself).
 *  - Collider tags: every collider you create should be tagged with physics.tag(collider, {...}) so impacts know
 *    what was hit (material → impact sound/fx).
 *  - Collision groups: use groups(member, filter) with the G bit flags below.
 *  - Contact force events are drained after each step and emitted as 'contact' on the event bus.
 */

export type ColliderKind =
  | 'ground' | 'road' | 'building' | 'prop' | 'staticProp' | 'parkedCar' | 'player' | 'npc' | 'debris' | 'water' | 'misc'
  | 'plane' | 'wreck'; // part 2: intact player plane parts (data: { part }), free wreck pieces
export type SurfaceMaterial =
  | 'concrete' | 'asphalt' | 'metal' | 'plastic' | 'glass' | 'wood' | 'foliage' | 'flesh' | 'sand' | 'grass' | 'water';

export interface ColliderTag {
  kind: ColliderKind;
  material: SurfaceMaterial;
  /** Owner-specific id (prop index, npc index, ...). */
  id?: number;
  /** Optional owner-specific payload. */
  data?: unknown;
}

/** Collision group bits (membership/filter). */
export const G = {
  WORLD: 1 << 0, // static ground, roads, buildings, terrain, static props
  PROP: 1 << 1, // dynamic light props
  PARKED: 1 << 2, // parked cars
  PLAYER: 1 << 3, // player car chassis
  NPC: 1 << 4, // pedestrian capsules / ragdolls
  DEBRIS: 1 << 5, // detached car parts, explosion debris
  SENSOR: 1 << 6,
  PLANE: 1 << 7, // part 2: intact planes + wreck pieces
  ALL: 0xffff,
} as const;

/** Pack Rapier InteractionGroups: membership bits in the high 16, filter bits in the low 16. */
export function groups(member: number, filter: number = G.ALL): number {
  return ((member & 0xffff) << 16) | (filter & 0xffff);
}

export type StepListener = (dt: number) => void;

export class Physics {
  world!: RAPIER.World;
  eventQueue!: RAPIER.EventQueue;
  readonly dt = 1 / CONFIG.physics.hz;
  private tags = new Map<number, ColliderTag>();
  private tmpDir = new THREE.Vector3();
  private postStep = new Set<StepListener>();

  constructor(private events: EventBus<GameEvents>) {}

  async init(): Promise<void> {
    await RAPIER.init();
    this.world = new RAPIER.World({ x: 0, y: CONFIG.physics.gravity, z: 0 });
    this.world.timestep = this.dt;
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  /** Called by the game loop once per fixed tick, after systems' fixedUpdate. */
  step(): void {
    this.world.gravity.y = CONFIG.physics.gravity;
    this.world.step(this.eventQueue);
    this.eventQueue.drainContactForceEvents((e) => {
      const h1 = e.collider1();
      const h2 = e.collider2();
      const d = e.maxForceDirection();
      this.tmpDir.set(d.x, d.y, d.z);
      this.events.emit('contact', {
        h1,
        h2,
        tag1: this.tags.get(h1) ?? null,
        tag2: this.tags.get(h2) ?? null,
        force: e.totalForceMagnitude(),
        dir: this.tmpDir,
      });
    });
    // Collision (start/stop) events are not used globally; drain to keep the queue empty.
    this.eventQueue.drainCollisionEvents(() => {});
    for (const fn of this.postStep) fn(this.dt);
  }

  onPostStep(fn: StepListener): () => void {
    this.postStep.add(fn);
    return () => this.postStep.delete(fn);
  }

  tag(collider: RAPIER.Collider, tag: ColliderTag): RAPIER.Collider {
    this.tags.set(collider.handle, tag);
    return collider;
  }

  tagOf(colliderHandle: number): ColliderTag | null {
    return this.tags.get(colliderHandle) ?? null;
  }

  /** Remove a body and all its colliders (and their tags). Safe to call with null. */
  removeBody(body: RAPIER.RigidBody | null | undefined): void {
    if (!body || !this.world.bodies.contains(body.handle)) return;
    for (let i = 0; i < body.numColliders(); i++) this.tags.delete(body.collider(i).handle);
    this.world.removeRigidBody(body);
  }

  removeCollider(collider: RAPIER.Collider | null | undefined): void {
    if (!collider || !this.world.colliders.contains(collider.handle)) return;
    this.tags.delete(collider.handle);
    this.world.removeCollider(collider, true);
  }

  /** Ray cast; returns hit distance + collider or null. */
  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    filterGroups: number = groups(G.ALL, G.WORLD),
    excludeBody?: RAPIER.RigidBody,
  ): { toi: number; collider: RAPIER.Collider; tag: ColliderTag | null } | null {
    const ray = new RAPIER.Ray(origin, dir);
    const hit = this.world.castRay(ray, maxDist, true, undefined, filterGroups, undefined, excludeBody);
    if (!hit) return null;
    return { toi: hit.timeOfImpact, collider: hit.collider, tag: this.tags.get(hit.collider.handle) ?? null };
  }

  /**
   * Radial impulse falling off linearly with distance, applied to every DYNAMIC body in radius
   * whose collider groups intersect `filterBits`. upBias adds vertical kick (0..1).
   */
  applyRadialImpulse(center: THREE.Vector3, radius: number, strength: number, filterBits: number, upBias = 0.5): number {
    let count = 0;
    const shape = new RAPIER.Ball(radius);
    const seen = new Set<number>();
    this.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, shape, (collider) => {
      const body = collider.parent();
      if (!body || !body.isDynamic() || seen.has(body.handle)) return true;
      seen.add(body.handle);
      const p = body.translation();
      const dx = p.x - center.x, dy = p.y - center.y, dz = p.z - center.z;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      const falloff = Math.max(0, 1 - dist / radius);
      const imp = strength * falloff * body.mass();
      body.applyImpulse({ x: (dx / dist) * imp, y: (Math.max(0, dy / dist) + upBias) * imp, z: (dz / dist) * imp }, true);
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * imp * 0.3, y: (Math.random() - 0.5) * imp * 0.3, z: (Math.random() - 0.5) * imp * 0.3 }, true);
      count++;
      return true;
    }, undefined, groups(G.ALL, filterBits));
    return count;
  }
}

/**
 * Helper for render interpolation (spec §14): call capture() in postStep, apply() in update(alpha).
 */
export class BodyInterpolator {
  /** Weak registry so the floating origin (core/Origin) can shift every interpolator's samples. */
  private static registry = new Set<WeakRef<BodyInterpolator>>();
  static shiftAll(dx: number, dz: number): void {
    for (const ref of BodyInterpolator.registry) {
      const bi = ref.deref();
      if (!bi) {
        BodyInterpolator.registry.delete(ref);
        continue;
      }
      bi.prevP.x -= dx;
      bi.prevP.z -= dz;
      bi.currP.x -= dx;
      bi.currP.z -= dz;
    }
  }

  private prevP = new THREE.Vector3();
  private currP = new THREE.Vector3();
  private prevQ = new THREE.Quaternion();
  private currQ = new THREE.Quaternion();
  private primed = false;

  constructor() {
    BodyInterpolator.registry.add(new WeakRef(this));
  }

  capture(body: RAPIER.RigidBody): void {
    const t = body.translation();
    const r = body.rotation();
    if (!this.primed) {
      this.currP.set(t.x, t.y, t.z);
      this.currQ.set(r.x, r.y, r.z, r.w);
      this.primed = true;
    }
    this.prevP.copy(this.currP);
    this.prevQ.copy(this.currQ);
    this.currP.set(t.x, t.y, t.z);
    this.currQ.set(r.x, r.y, r.z, r.w);
  }

  /** Snap (no interpolation) — call after teleporting a body. */
  reset(body: RAPIER.RigidBody): void {
    this.primed = false;
    this.capture(body);
    this.prevP.copy(this.currP);
    this.prevQ.copy(this.currQ);
  }

  apply(obj: THREE.Object3D, alpha: number): void {
    obj.position.lerpVectors(this.prevP, this.currP, alpha);
    obj.quaternion.slerpQuaternions(this.prevQ, this.currQ, alpha);
  }
}
