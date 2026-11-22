import * as THREE from 'three';
import { CONFIG } from '../config';
import type { Engine } from './Engine';
import type { EventBus } from './EventBus';
import type { GameEvents } from './events';
import { BodyInterpolator, type Physics } from './Physics';
import { GLOBAL_UNIFORMS } from './uniforms';

/**
 * FLOATING ORIGIN (SPEC-PART3 §2). Owner: core.
 *
 * Everything at runtime (scene objects, physics, CityData, world queries) uses LOCAL coordinates near the scene
 * origin. `offset` converts: absolute = local + offset (X/Z only, Y never shifts). Seeded generation (terrain,
 * highways) must use ABSOLUTE coordinates so the same seed gives the same world.
 *
 * When the focus (player car/plane) gets farther than CONFIG.world.originShiftDistance from the local origin,
 * shift() moves the world back by `delta` (a multiple of CONFIG.world.originShiftStep), in ONE step between frames:
 *   1. every Rapier rigid body and parentless collider: translation -= delta
 *   2. every top-level child of engine.scene (incl. the camera): position -= delta,
 *      except objects with `userData.noOriginShift = true` (their owner shifts them in the event handler)
 *   3. every BodyInterpolator (prev/curr samples) -= delta
 *   4. GLOBAL_UNIFORMS.uOrigin = new offset (shaders: absolute = worldPos + uOrigin)
 *   5. `beforeEmit` hook (Game uses it to shift CityData in place via shiftCityData)
 *   6. emits 'originShift' { delta, offset } — modules shift their own cached world-space state
 *      (arrays of positions, spatial hashes, camera smoothing state, kinematic targets, route polylines…).
 */
export class Origin {
  /** absolute = local + offset */
  readonly offset = new THREE.Vector3();
  readonly delta = new THREE.Vector3();
  shifts = 0;
  beforeEmit: ((dx: number, dz: number) => void) | null = null;

  constructor(
    private engine: Engine,
    private physics: Physics,
    private events: EventBus<GameEvents>,
  ) {}

  toAbsolute(local: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(local.x + this.offset.x, local.y, local.z + this.offset.z);
  }

  toLocal(abs: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(abs.x - this.offset.x, abs.y, abs.z - this.offset.z);
  }

  /** Called by Game once per frame (between fixed steps and system updates). Returns true if it shifted. */
  maybeShift(focusLocal: THREE.Vector3): boolean {
    const dist = CONFIG.world.originShiftDistance;
    if (Math.abs(focusLocal.x) < dist && Math.abs(focusLocal.z) < dist) return false;
    const step = CONFIG.world.originShiftStep;
    const dx = Math.round(focusLocal.x / step) * step;
    const dz = Math.round(focusLocal.z / step) * step;
    if (dx === 0 && dz === 0) return false;
    this.shift(dx, dz);
    return true;
  }

  /** Move the world by -(dx, 0, dz). Prefer maybeShift(); exposed for tests/teleports. */
  shift(dx: number, dz: number): void {
    const world = this.physics.world;
    world.forEachRigidBody((b) => {
      const t = b.translation();
      b.setTranslation({ x: t.x - dx, y: t.y, z: t.z - dz }, false);
      if (b.isKinematic()) b.setNextKinematicTranslation({ x: t.x - dx, y: t.y, z: t.z - dz });
    });
    world.forEachCollider((c) => {
      if (c.parent()) return;
      const t = c.translation();
      c.setTranslation({ x: t.x - dx, y: t.y, z: t.z - dz });
    });
    for (const child of this.engine.scene.children) {
      if (child.userData.noOriginShift) continue;
      child.position.x -= dx;
      child.position.z -= dz;
    }
    BodyInterpolator.shiftAll(dx, dz);
    this.offset.x += dx;
    this.offset.z += dz;
    GLOBAL_UNIFORMS.uOrigin.value.set(this.offset.x, 0, this.offset.z);
    this.delta.set(dx, 0, dz);
    this.shifts++;
    try {
      this.beforeEmit?.(dx, dz);
    } catch (err) {
      console.error('[origin] beforeEmit failed', err);
    }
    this.events.emit('originShift', { delta: this.delta, offset: this.offset });
  }
}
