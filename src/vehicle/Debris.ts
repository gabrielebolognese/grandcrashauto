import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups, BodyInterpolator, type SurfaceMaterial } from '../core/Physics';
import type { GameContext } from '../game/contracts';

/**
 * Physics debris for detached car parts (bumpers, hood, doors, wheels). Owner: src/vehicle.
 *  - Each piece = its existing mesh (no new geometry) + a cuboid rigid body fitted to its local bounds.
 *  - 'part' pieces came from CarVisual.detachPart() (we own them until the next reset decides whether repair() took them
 *    back); 'clone' pieces are clones sharing geometry/materials with the car (wheels) — nothing to dispose.
 *  - Fresh debris doesn't collide with the player car for a moment (it spawns overlapping the chassis).
 */
export type DebrisKind = 'part' | 'clone';

interface DebrisItem {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  obj: THREE.Object3D;
  kind: DebrisKind;
  interp: BodyInterpolator;
  age: number;
  playerCollides: boolean;
}

const DEBRIS_FILTER = G.WORLD | G.PROP | G.PARKED | G.DEBRIS;

export class DebrisSystem {
  private items: DebrisItem[] = [];
  /** 'part' objects whose bodies were retired early (cap) — kept until the next clear() for the ownership check. */
  private retired: THREE.Object3D[] = [];
  private box = new THREE.Box3();
  private tmpBox = new THREE.Box3();
  private m4 = new THREE.Matrix4();
  private inv = new THREE.Matrix4();

  constructor(private ctx: GameContext) {}

  get count(): number {
    return this.items.length;
  }

  /**
   * Turn an object that is already in the scene (world transform set on position/quaternion/scale) into debris.
   */
  spawn(
    obj: THREE.Object3D,
    kind: DebrisKind,
    material: SurfaceMaterial,
    linvel: THREE.Vector3,
    angvel: THREE.Vector3,
    massOverride?: number,
  ): void {
    const { physics } = this.ctx;
    const X = CONFIG.vehicle.explosion;
    while (this.items.length >= X.maxDebris) this.retire(0);

    // Local-space bounds of the object's meshes.
    obj.updateMatrixWorld(true);
    this.inv.copy(obj.matrixWorld).invert();
    this.box.makeEmpty();
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      this.m4.multiplyMatrices(this.inv, mesh.matrixWorld);
      this.tmpBox.copy(mesh.geometry.boundingBox).applyMatrix4(this.m4);
      this.box.union(this.tmpBox);
    });
    if (this.box.isEmpty()) this.box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(0.4, 0.2, 0.4));
    const s = obj.scale;
    const size = this.box.getSize(new THREE.Vector3()).multiply(s);
    const center = this.box.getCenter(new THREE.Vector3()).multiply(s);
    const hx = Math.max(0.04, size.x * 0.5);
    const hy = Math.max(0.04, size.y * 0.5);
    const hz = Math.max(0.04, size.z * 0.5);
    const mass = massOverride ?? THREE.MathUtils.clamp(hx * hy * hz * 8 * 220, 4, 40);

    const p = obj.position;
    const q = obj.quaternion;
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel({ x: angvel.x, y: angvel.y, z: angvel.z })
        .setLinearDamping(0.05)
        .setAngularDamping(0.4),
    );
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setTranslation(center.x, center.y, center.z)
        .setMass(mass)
        .setFriction(0.7)
        .setRestitution(0.25)
        .setCollisionGroups(groups(G.DEBRIS, DEBRIS_FILTER)),
      body,
    );
    physics.tag(collider, { kind: 'debris', material });
    const interp = new BodyInterpolator();
    interp.reset(body);
    this.items.push({ body, collider, obj, kind, interp, age: 0, playerCollides: false });
  }

  fixedUpdate(dt: number): void {
    const t = CONFIG.vehicle.explosion.debrisNoPlayerTime;
    for (const it of this.items) {
      it.age += dt;
      if (!it.playerCollides && it.age > t) {
        it.playerCollides = true;
        it.collider.setCollisionGroups(groups(G.DEBRIS, DEBRIS_FILTER | G.PLAYER));
      }
    }
  }

  postStep(): void {
    for (const it of this.items) it.interp.capture(it.body);
  }

  update(alpha: number): void {
    for (const it of this.items) it.interp.apply(it.obj, alpha);
  }

  private retire(index: number): void {
    const it = this.items[index];
    this.items.splice(index, 1);
    this.ctx.physics.removeBody(it.body);
    it.obj.removeFromParent();
    if (it.kind === 'part') this.retired.push(it.obj);
  }

  /** Remove every debris body and mesh. Returns the 'part' objects (the caller decides whether they must be disposed). */
  clear(): THREE.Object3D[] {
    const parts = this.retired;
    this.retired = [];
    for (const it of this.items) {
      this.ctx.physics.removeBody(it.body);
      it.obj.removeFromParent();
      if (it.kind === 'part') parts.push(it.obj);
    }
    this.items.length = 0;
    return parts;
  }
}
