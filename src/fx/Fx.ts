import type * as THREE from 'three';
import type { FireHandle, GameContext, IFx } from '../game/contracts';

/** STUB — replaced by the fx module (particles, explosion, skid marks). */
export class Fx implements IFx {
  readonly name = 'fx';
  constructor(private ctx: GameContext) {}
  init(): void {}
  explosion(_pos: THREE.Vector3, _scale: number): void {}
  sparks(_pos: THREE.Vector3, _normal: THREE.Vector3, _intensity: number): void {}
  dust(_pos: THREE.Vector3, _intensity: number): void {}
  smoke(_pos: THREE.Vector3, _intensity: number): void {}
  glassShards(_pos: THREE.Vector3, _count: number): void {}
  attachFire(): FireHandle { return { stop() {} }; }
  clearAll(): void {}
}
