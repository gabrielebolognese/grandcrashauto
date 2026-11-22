import type * as THREE from 'three';
import type { GameContext, IHighways } from '../game/contracts';
import type { Pose, RoadGraph } from '../world/types';

/** STUB — replaced by the highway module (endless highway network, bridges, tunnels, ramps, rest stops). */
export class Highways implements IHighways {
  readonly name = 'highways';
  graph: RoadGraph = { nodes: [], edges: [] };
  graphVersion = 0;
  pois: { id: string; name: string; icon: string; pose: Pose }[] = [];
  constructor(private ctx: GameContext) {}
  init(): void {}
  roadHeightAt(): number | null {
    return null;
  }
  isOnHighway(): boolean {
    return false;
  }
  inTunnel(_pos: THREE.Vector3): boolean {
    return false;
  }
  restStopAt(): boolean {
    return false;
  }
  findRespawn(): Pose | null {
    return null;
  }
}
