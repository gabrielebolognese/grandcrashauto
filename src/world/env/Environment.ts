import * as THREE from 'three';
import type { GameContext, IEnvironment } from '../../game/contracts';

/** STUB — replaced by the environment module (sky, sun, water, post, time of day). */
export class Environment implements IEnvironment {
  readonly name = 'env';
  readonly sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  nightFactor = 0;
  envMap: THREE.Texture | null = null;
  constructor(private ctx: GameContext) {}

  init(): void {
    const { scene } = this.ctx.engine;
    scene.background = new THREE.Color(0x8fd0ec);
    scene.fog = new THREE.Fog(0xbfe3f0, 150, 700);
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x9a8a7a, 1.2));
    this.sun.position.set(60, 100, 40);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    Object.assign(this.sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 300 });
    scene.add(this.sun, this.sun.target);
  }

  setShadowFocus(pos: THREE.Vector3): void {
    this.sun.target.position.copy(pos);
    this.sun.position.copy(pos).add(new THREE.Vector3(60, 100, 40));
  }
}
