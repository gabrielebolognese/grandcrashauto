import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups, type SurfaceMaterial } from '../core/Physics';
import type { GameContext, IWorld } from '../game/contracts';
import type { CityData, DistrictId, Pose } from './types';

/** STUB — replaced by the world module (city generation, roads, buildings, streaming). */
export class World implements IWorld {
  readonly name = 'world';
  data!: CityData;
  constructor(private ctx: GameContext) {}

  init(): void {
    const { engine, physics } = this.ctx;
    const size = CONFIG.world.size;
    this.data = {
      seed: CONFIG.game.seed, size, chunkSize: CONFIG.world.chunkSize, chunksPerSide: size / CONFIG.world.chunkSize,
      roads: { nodes: [], edges: [] }, ped: { nodes: [], edges: [] }, benches: [], busStops: [], wanderAreas: [], groupSpots: [],
      buildings: [], props: [], parkedCars: [],
      spawn: { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, garage: { position: { x: 0, y: 0, z: -10 }, yaw: 0 }, jumpRamp: null,
      districtGrid: ['downtown'], districtGridSize: 1, coast: { seaWallZ: 330, shoreZ: 360 },
    };
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9aa0a6 }));
    ground.receiveShadow = true;
    engine.scene.add(ground);
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.tag(physics.world.createCollider(RAPIER.ColliderDesc.cuboid(size / 2, 0.5, size / 2).setTranslation(0, -0.5, 0).setCollisionGroups(groups(G.WORLD)), body), { kind: 'ground', material: 'asphalt' });
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2c6a0 });
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2, r = 60 + (i % 5) * 30, h = 8 + (i % 7) * 6;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const m = new THREE.Mesh(new THREE.BoxGeometry(12, h, 12), mat);
      m.position.set(x, h / 2, z);
      m.castShadow = m.receiveShadow = true;
      engine.scene.add(m);
      physics.tag(physics.world.createCollider(RAPIER.ColliderDesc.cuboid(6, h / 2, 6).setTranslation(x, h / 2, z).setCollisionGroups(groups(G.WORLD)), body), { kind: 'building', material: 'concrete' });
    }
  }

  groundHeightAt(): number { return 0; }
  surfaceAt(): SurfaceMaterial { return 'asphalt'; }
  districtAt(): DistrictId { return 'downtown'; }
  findRespawn(pos: THREE.Vector3, yaw: number): Pose { return { position: { x: pos.x, y: 0, z: pos.z }, yaw }; }
  isDeepWater(): boolean { return false; }
  setFocus(): void {}
}
