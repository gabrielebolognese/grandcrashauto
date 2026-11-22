import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RingMesh } from './gen/ring';
import type { WorkerPool } from './WorkerPool';

/**
 * Distant mountain ring: one cheap low-poly silhouette band beyond the loaded tiles (view distance × 0.92 → ~16 km),
 * regenerated in a worker when the camera moves far enough; drawn with the terrain material (haze + depth squash).
 */
export class MountainRing {
  readonly mesh: THREE.Mesh;
  private cx = 1e18;
  private cz = 1e18;
  private rIn = 0;
  private pendingKey = '';
  private gen = 0;

  constructor(material: THREE.Material, private pool: WorkerPool) {
    const g = new THREE.BufferGeometry();
    // placeholder geometry with the full attribute set (compiles the program during warm-up)
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(9), 3, true));
    g.setAttribute('aSnow', new THREE.BufferAttribute(new Uint8Array(6), 2, true));
    g.setIndex([0, 1, 2]);
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.name = 'terrain.ring';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
  }

  /** cam ABSOLUTE; request a rebuild when needed. */
  update(camX: number, camZ: number, viewDist: number): void {
    const R = CONFIG.terrain.ring;
    const rIn = viewDist * 0.92;
    const moved = Math.hypot(camX - this.cx, camZ - this.cz);
    const need = moved > R.rebuildDistance || Math.abs(rIn - this.rIn) > this.rIn * 0.18;
    if (!need) return;
    // snap the centre to a coarse grid so requests are stable while moving
    const snap = 256;
    const cx = Math.round(camX / snap) * snap;
    const cz = Math.round(camZ / snap) * snap;
    const rOut = Math.max(R.outer, viewDist * 3.2);
    const rq = Math.round(rIn / 50) * 50;
    const key = `r${cx}:${cz}:${rq}`;
    if (key !== this.pendingKey) {
      this.pendingKey = key;
      this.gen++;
    }
    this.pool.want(key, 900, () => ({ type: 'ring', cx, cz, rIn: rq, rOut, segments: R.segments, rings: R.rings }));
  }

  onRing(key: string, d: RingMesh, offX: number, offZ: number): void {
    if (key !== this.pendingKey) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3, true));
    const n = d.positions.length / 3;
    const snow = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      snow[i * 2] = 210;
      snow[i * 2 + 1] = (i * 97) & 255;
    }
    g.setAttribute('aSnow', new THREE.BufferAttribute(snow, 2, true));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), d.rOut);
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.mesh.position.set(d.cx - offX, 0, d.cz - offZ);
    this.cx = d.cx;
    this.cz = d.cz;
    this.rIn = d.rIn;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
