import * as THREE from 'three';
import { CONFIG } from '../config';
import { G, groups } from '../core/Physics';
import type { GameContext } from '../game/contracts';
import { expK } from './camMath';

const _dir = new THREE.Vector3();
const _o = new THREE.Vector3();
const WORLD_FILTER = groups(G.ALL, G.WORLD);

/**
 * Camera collision: raycast from the subject toward the wanted camera position against static world geometry.
 * When something solid is in the way the allowed distance snaps in fast, then eases back out slowly once clear.
 * Thin static props (lamp posts, palms) are ignored so the camera doesn't pump when passing them.
 */
export class Occluder {
  /** Smoothed allowed distance; < 0 = not initialized (next apply snaps). */
  private dist = -1;
  /** 0 = unobstructed, → 1 = pulled all the way in. */
  pull = 0;

  reset(): void {
    this.dist = -1;
    this.pull = 0;
  }

  apply(ctx: GameContext, origin: THREE.Vector3, desired: THREE.Vector3, dt: number, out: THREE.Vector3): void {
    const c = CONFIG.camera;
    _dir.subVectors(desired, origin);
    const full = _dir.length();
    if (full < 1e-3) {
      out.copy(desired);
      this.pull = 0;
      return;
    }
    _dir.divideScalar(full);
    const margin = c.occlusionMargin;
    let allowed = full;
    const hitDist = castSolid(ctx, origin, _dir, full + margin);
    if (hitDist !== null) allowed = Math.max(Math.min(c.occlusionMinDist, full), hitDist - margin);
    allowed = Math.min(allowed, full);

    if (this.dist < 0 || dt <= 0) this.dist = allowed;
    else if (allowed < this.dist) this.dist += (allowed - this.dist) * expK(c.occlusionIn, dt);
    else this.dist += (allowed - this.dist) * expK(c.occlusionOut, dt);
    // Never sit beyond a wall: a hard limit slightly behind the hit keeps the near plane out of buildings.
    if (hitDist !== null) this.dist = Math.min(this.dist, Math.max(0.3, hitDist - margin * 0.35));
    this.dist = Math.min(this.dist, full);
    this.pull = 1 - this.dist / full;
    out.copy(origin).addScaledVector(_dir, this.dist);
  }
}

/** First solid static hit distance along a ray (skips up to two thin static props), or null. */
export function castSolid(ctx: GameContext, origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number | null {
  const phys = ctx.physics;
  if (!phys?.world) return null;
  _o.copy(origin);
  let travelled = 0;
  for (let i = 0; i < 3; i++) {
    const remaining = maxDist - travelled;
    if (remaining <= 0.05) return null;
    let hit: ReturnType<typeof phys.raycast> = null;
    try {
      hit = phys.raycast(_o, dir, remaining, WORLD_FILTER);
    } catch {
      return null;
    }
    if (!hit) return null;
    const kind = hit.tag?.kind;
    if (kind === 'staticProp' || kind === 'prop' || kind === 'debris' || kind === 'npc' || kind === 'water') {
      const step = hit.toi + 0.25;
      travelled += step;
      _o.addScaledVector(dir, step);
      continue;
    }
    return travelled + hit.toi;
  }
  return null;
}

/**
 * Keep a camera position above the ground / water surface. `refY` is the subject's height: a "ground" more than
 * a few meters above it is an overhead deck (highway overpass), not something to climb on top of.
 */
export function clampAboveGround(ctx: GameContext, p: THREE.Vector3, refY: number, clearance: number): void {
  let g = -Infinity;
  try {
    g = ctx.world.groundHeightAt(p.x, p.z);
  } catch {
    /* world not ready */
  }
  if (!Number.isFinite(g) || g > refY + 3) g = -Infinity;
  const water = CONFIG.world.waterLevel;
  const floor = Math.max(g, water) + clearance;
  if (p.y < floor) p.y = floor;
}
