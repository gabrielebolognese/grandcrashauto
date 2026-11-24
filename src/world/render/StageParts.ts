import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { G, RAPIER, groups } from '../../core/Physics';
import type { GameContext } from '../../game/contracts';
import type { ConcertData } from '../types';

type Part = NonNullable<ConcertData['parts']>[number];

// kg/m³ per role (the boxes are hollow-ish structures, not solid blocks)
const DENSITY: Record<Part['role'], number> = { deck: 60, trim: 200, wall: 40, truss: 110, roof: 16, speaker: 45, barrier: 70 };

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();

/**
 * The concert stage as breakable parts (user request: "the stage cannot be immovable, it has to break on impact"):
 * deck, back wall, truss towers, roof, speaker stacks, barrier — one instanced mesh, one Rapier body each. Fixed (and
 * solid: a plane crashing into it crashes) until a plane impact / explosion / car blast lands close enough; then every
 * part turns dynamic and is thrown away from the hit (harder the closer), the roof and wall topple, and the dressing
 * (LED screen, lamps, banner) rides the part it hangs on while the light show dies.
 */
export class StageParts {
  readonly mesh: THREE.InstancedMesh;
  readonly broken = { value: false };
  private bodies: RAPIER_T.RigidBody[] = [];
  private half: THREE.Vector3[] = [];
  private center = new THREE.Vector3();
  private riders: { obj: THREE.Object3D; part: number; rel: THREE.Matrix4 | null }[] = [];
  private onBreak: (() => void) | null = null;
  private settle = 0;

  constructor(private ctx: GameContext, private parts: Part[], private stageGroup: THREE.Object3D) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.08 });
    this.mesh = new THREE.InstancedMesh(geo, mat, parts.length);
    this.mesh.name = 'concert-stage-parts';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.noOriginShift = true; // matrices come from the bodies (which core shifts)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const physics = ctx.physics;
    const grp = groups(G.WORLD, G.ALL);
    parts.forEach((p, i) => {
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.cx, p.cy + p.h / 2, p.cz));
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(p.w / 2, p.h / 2, p.d / 2).setDensity(DENSITY[p.role]).setFriction(0.8).setCollisionGroups(grp),
        body,
      );
      physics.tag(col, { kind: p.role === 'truss' || p.role === 'barrier' ? 'misc' : 'building', material: p.metal ? 'metal' : 'concrete' });
      this.bodies.push(body);
      this.half.push(new THREE.Vector3(p.w, p.h, p.d));
      this.mesh.setColorAt(i, new THREE.Color(p.col));
      this.center.x += p.cx / parts.length;
      this.center.z += p.cz / parts.length;
    });
    this.center.y = 4;
    this.write();
    ctx.engine.scene.add(this.mesh);
    const ev = ctx.events;
    ev.on('planeImpact', (e) => {
      if (!e.replay && e.outcome !== 'landing') this.hit(e.position, e.velocity, 45, Math.min(1.6, 0.5 + e.energy * 1e-7));
    });
    ev.on('planeExplosion', (e) => {
      if (!e.replay) this.hit(e.position, e.velocity, e.radius + 30, e.kind === 'secondary' ? 0.8 : 1.3);
    });
    ev.on('explosion', (e) => this.hit(e.position, null, (e.radius ?? 6) + 12, 0.8));
    ev.on('originShift', ({ delta }) => this.center.sub(delta));
  }

  /** Dressing that rides a part once the stage breaks (screen on the back wall, lamps + banner under the roof). */
  ride(obj: THREE.Object3D, role: Part['role']): void {
    const i = this.parts.findIndex((p) => p.role === role);
    if (i >= 0) this.riders.push({ obj, part: i, rel: null });
  }

  onBroken(cb: () => void): void {
    this.onBreak = cb;
  }

  /** A crash / blast at `pos`: within `reach` m of the stage it collapses (k = violence). */
  hit(pos: THREE.Vector3, vel: THREE.Vector3 | null, reach: number, k: number): void {
    if (this.broken.value) return;
    const d0 = Math.hypot(pos.x - this.center.x, pos.z - this.center.z);
    if (d0 > reach + 14 || pos.y - this.center.y > reach) return;
    this.broken.value = true;
    // dressing: remember where it hangs relative to its part
    this.stageGroup.updateMatrixWorld(true);
    for (const r of this.riders) {
      const b = this.bodies[r.part];
      const t = b.translation(), q = b.rotation();
      _m.compose(_p.set(t.x, t.y, t.z), _q.set(q.x, q.y, q.z, q.w), _s.set(1, 1, 1));
      r.rel = new THREE.Matrix4().copy(_m).invert().multiply(r.obj.matrixWorld);
      r.obj.matrixAutoUpdate = false;
    }
    this.bodies.forEach((b, i) => {
      b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      const t = b.translation();
      _d.set(t.x - pos.x, Math.max(0, t.y - pos.y) + 2, t.z - pos.z);
      const dist = _d.length() || 1;
      _d.divideScalar(dist);
      const fall = Math.max(0, 1 - dist / (reach + 20));
      const role = this.parts[i].role;
      const light = role === 'deck' ? 0.25 : role === 'wall' ? 0.6 : 1;
      const dv = (4 + 14 * fall) * k * light;
      const carry = vel ? 0.25 * fall * light : 0;
      b.setLinvel({ x: _d.x * dv + (vel?.x ?? 0) * carry, y: _d.y * dv * 0.6 + 1.5 * fall, z: _d.z * dv + (vel?.z ?? 0) * carry }, true);
      b.setAngvel({ x: (Math.random() - 0.5) * 2.4 * fall * light, y: (Math.random() - 0.5) * 1.2 * fall, z: (Math.random() - 0.5) * 2.4 * fall * light }, true);
    });
    const fx = this.ctx.fx;
    fx.dust(_p.set(this.center.x, 1, this.center.z), 3, 0xcfc2a5);
    fx.sparks(_p.set(this.center.x, 8, this.center.z), _d.set(0, 1, 0), 1.5);
    fx.debrisBurst?.({ position: _p.set(this.center.x, 6, this.center.z), velocity: vel?.clone().multiplyScalar(0.3) ?? new THREE.Vector3(), count: 18, size: 0.9, kind: 'panel' });
    this.ctx.events.emit('concertStageBroken', { position: this.center.clone() });
    this.onBreak?.();
  }

  private write(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      const t = b.translation(), q = b.rotation();
      _m.compose(_p.set(t.x, t.y, t.z), _q.set(q.x, q.y, q.z, q.w), this.half[i]);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Per frame: follow the bodies while anything moves (and after an origin shift: fixed bodies move too). */
  update(dt: number): void {
    this.settle -= dt;
    if (!this.broken.value) {
      // fixed: only an origin shift moves them (cheap to just rewrite every half second)
      if (this.settle <= 0) {
        this.settle = 0.5;
        this.write();
      }
      return;
    }
    this.write();
    if (!this.riders.length) return;
    const inv = _m.copy(this.stageGroup.matrixWorld).invert();
    for (const r of this.riders) {
      if (!r.rel) continue;
      const b = this.bodies[r.part];
      const t = b.translation(), q = b.rotation();
      const w = new THREE.Matrix4().compose(_p.set(t.x, t.y, t.z), _q.set(q.x, q.y, q.z, q.w), _s.set(1, 1, 1)).multiply(r.rel);
      r.obj.matrix.multiplyMatrices(inv, w);
      r.obj.matrixWorldNeedsUpdate = true;
    }
  }

  dispose(): void {
    for (const b of this.bodies) this.ctx.physics.removeBody(b);
    this.bodies = [];
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
