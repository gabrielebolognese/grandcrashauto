import { CONFIG } from '../config';
import type { SurfaceMaterial } from '../core/Physics';
import type { GameContext, ITerrain } from '../game/contracts';
import type { Pose } from '../world/types';

/** STUB — replaced by the terrain module (worker-generated endless low-poly terrain, biomes, props, coast). */
export class Terrain implements ITerrain {
  readonly name = 'terrain';
  pois: { id: string; name: string; icon: string; pose: Pose }[] = [];
  constructor(private ctx: GameContext) {}
  init(): void {}
  heightAt(): number {
    return 0;
  }
  surfaceAt(): SurfaceMaterial {
    return 'grass';
  }
  biomeAt(): string {
    return 'plains';
  }
  waterAt(x: number, z: number): number | null {
    return this.oceanDistance(x, z) > 0 ? CONFIG.world.waterLevel : null;
  }
  oceanDistance(x: number, z: number): number {
    const o = this.ctx.origin.offset;
    const c = CONFIG.world.coast;
    const ax = x + o.x;
    const az = z + o.z;
    const west = c.westX - ax;
    const south = az - c.southZ;
    if (west > 0 && south > 0) return Math.hypot(west, south);
    return Math.max(0, west, south);
  }
  isReady(): boolean {
    return true;
  }
}
