import * as THREE from 'three';
import { CONFIG } from '../config';
import { G, groups, RAPIER as R, type Physics } from '../core/Physics';
import { Rng } from '../core/rng';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { Pose } from '../world/types';
import { features, lakeWobble, SEA_WALL_Z, southShoreZ, type Lake } from './gen/height';
import { noiseFor } from './gen/noise';
import { Geo } from './scatterModels';

/**
 * Hand-placed (seeded) coast & mountain features: the Lighthouse on its headland (rotating beam at night), the
 * Fishing Pier (drivable deck), the sea wall continuing the city promenade, the Summit Viewpoint platform, and the
 * lake water planes. Fixed meshes (top-level, origin-shifted by core) + static colliders.
 */

const C = (hex: number) => new THREE.Color(hex);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface TerrainPoi {
  id: string;
  name: string;
  icon: string;
  pose: Pose;
  /** absolute position (kept for origin shifts) */
  ax: number;
  az: number;
}

const BEAM_VERT = /* glsl */ `
varying float vAlong;
varying vec3 vW;
void main() {
  vAlong = uv.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const BEAM_FRAG = /* glsl */ `
uniform float uNight;
uniform vec3 uFogColor;
varying float vAlong;
varying vec3 vW;
void main() {
  float a = uNight * (1.0 - vAlong) * (0.25 + 0.75 * (1.0 - vAlong)) * 0.42;
  gl_FragColor = vec4(vec3(1.0, 0.93, 0.75) * a, a);
}`;

export class Features {
  readonly group = new THREE.Group();
  readonly pois: TerrainPoi[] = [];
  private lighthouse: THREE.Mesh | null = null;
  private beam: THREE.Mesh | null = null;
  private lamp: THREE.Mesh | null = null;
  private lampMat: THREE.MeshBasicMaterial;
  private beamMat: THREE.ShaderMaterial;
  private colliders: import('@dimforge/rapier3d-compat').Collider[] = [];
  private lakes = new Map<number, THREE.Mesh>();
  private meshes: THREE.Mesh[] = [];
  /** absolute anchors of feature meshes (for distance culling) */
  private anchors: { mesh: THREE.Object3D; ax: number; az: number; range: number }[] = [];

  constructor(private physics: Physics, private solid: THREE.Material, private water: THREE.Material) {
    this.group.name = 'terrain.features';
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xfff1c8, fog: false, toneMapped: false });
    this.lampMat.name = 'terrain.lamp';
    this.beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VERT,
      fragmentShader: BEAM_FRAG,
      uniforms: { uNight: GLOBAL_UNIFORMS.uNight, uFogColor: GLOBAL_UNIFORMS.uFogColor },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.beamMat.name = 'terrain.beam';
  }

  /** Build everything for the current seed (absolute → local with the given offset). */
  build(offX: number, offZ: number): void {
    const F = features();
    // ── lighthouse ──
    {
      const ax = F.lighthouseX;
      const az = F.lighthouseZ;
      const y = 26;
      const g = new Geo();
      const white = C(0xf7f4ee);
      const red = C(0xd9544a);
      const bands = [[0, 3, white], [3, 6, red], [6, 9.5, white], [9.5, 12.5, red], [12.5, 17.5, white]] as const;
      for (const [y0, y1, col] of bands) g.frustum(12, y0, 2.6 - y0 * 0.05, y1, 2.6 - y1 * 0.05, col, null);
      g.frustum(12, 17.5, 3.2, 17.9, 3.2, C(0x3d4450), null);
      g.disc(12, 17.9, 3.2, C(0x3d4450), 1);
      g.disc(12, 17.5, 3.2, C(0x3d4450), -1);
      g.frustum(8, 17.9, 1.5, 20.4, 1.5, C(0x384050), null); // lantern frame (dark); glow mesh inside
      g.frustum(8, 20.4, 1.9, 22.4, 0, red, null);
      // railing posts
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const px = Math.cos(a) * 3.05;
        const pz = Math.sin(a) * 3.05;
        g.box(px - 0.05, 17.9, pz - 0.05, px + 0.05, 18.9, pz + 0.05, C(0x3d4450));
      }
      // keeper's cottage
      g.box(4.5, 0, -3, 11.5, 3.6, 3, white, { shade: 0.05 });
      const rr = C(0xc86450);
      g.quadV(V(4.1, 3.4, -3.4), V(4.1, 3.4, 3.4), V(8, 5.6, 3.4), V(8, 5.6, -3.4), rr, 0.03);
      g.quadV(V(11.9, 3.4, 3.4), V(11.9, 3.4, -3.4), V(8, 5.6, -3.4), V(8, 5.6, 3.4), rr, -0.05);
      g.triV(V(4.5, 3.6, 3), V(11.5, 3.6, 3), V(8, 5.5, 3), white);
      g.triV(V(11.5, 3.6, -3), V(4.5, 3.6, -3), V(8, 5.5, -3), white);
      g.box(-3.4, -0.6, -3.4, 3.4, 0.25, 3.4, C(0xc9c3b8)); // plinth
      const mesh = new THREE.Mesh(g.build(), this.solid);
      mesh.name = 'terrain.lighthouse';
      mesh.position.set(ax - offX, y, az - offZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.add(mesh, ax, az, 6000);
      this.lighthouse = mesh;
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 2.2, 8), this.lampMat);
      lamp.position.set(0, 19.2, 0);
      mesh.add(lamp);
      this.lamp = lamp;
      // beam: two long open cones rotating about the lantern
      const cone = new THREE.ConeGeometry(26, 320, 16, 1, true);
      cone.translate(0, -160, 0);
      cone.rotateZ(Math.PI / 2); // along +X, apex at the origin
      const uv = cone.getAttribute('uv');
      const pos = cone.getAttribute('position');
      for (let i = 0; i < uv.count; i++) uv.setY(i, Math.min(1, Math.abs(pos.getX(i)) / 320));
      const beam = new THREE.Mesh(cone, this.beamMat);
      const beam2 = new THREE.Mesh(cone, this.beamMat);
      beam2.rotation.y = Math.PI;
      beam.add(beam2);
      beam.position.set(0, 19.2, 0);
      beam.frustumCulled = false;
      beam2.frustumCulled = false;
      beam.renderOrder = 5;
      mesh.add(beam);
      this.beam = beam;
      this.addBox(ax, y + 9, az, 2.7, 9.5, 2.7, offX, offZ, 'concrete');
      this.addBox(ax + 8, y + 2, az, 3.5, 2.2, 3, offX, offZ, 'concrete');
      this.pois.push({
        id: 'lighthouse', name: 'Lighthouse', icon: '🗼', ax: ax - 20, az: az - 14,
        pose: { position: { x: ax - 20 - offX, y: y + 0.6, z: az - 14 - offZ }, yaw: Math.atan2(20, 14) },
      });
    }

    // ── fishing pier ──
    {
      const px = F.pierX;
      const shore = southShoreZ(px);
      const dz1 = southShoreZ(px + 20) - southShoreZ(px - 20);
      const yaw = Math.atan2(-dz1 / 40, 1); // perpendicular to the coast, toward the sea (+z)
      const len = 150;
      const w = 3.2; // half width
      const deckY = 2.5;
      const z0 = -10; // starts 10 m inland of the waterline
      const g = new Geo();
      const plank = C(0xb88b5e);
      const plankDark = C(0x9a7350);
      const pile = C(0x6e5641);
      for (let k = 0; k < len / 2; k++) {
        const za = z0 + k * 2;
        g.box(-w, deckY - 0.25, za, w, deckY, za + 2, k % 2 ? plank : plankDark, { bottom: true });
      }
      for (let zz = z0 + 6; zz < z0 + len; zz += 6) {
        for (const xx of [-w + 0.3, w - 0.3]) g.box(xx - 0.2, -7, zz - 0.2, xx + 0.2, deckY - 0.25, zz + 0.2, pile);
      }
      // railings
      for (let zz = z0 + 12; zz <= z0 + len; zz += 3) {
        for (const xx of [-w, w]) g.box(xx - 0.06, deckY, zz - 0.06, xx + 0.06, deckY + 1.0, zz + 0.06, plankDark);
      }
      for (const xx of [-w, w]) g.box(xx - 0.07, deckY + 0.92, z0 + 12, xx + 0.07, deckY + 1.04, z0 + len, plank);
      // hut + lamps at the end
      g.box(-2.4, deckY, z0 + len - 9, 2.4, deckY + 2.8, z0 + len - 3, C(0x6fb3c8), { shade: 0.05 });
      g.quadV(V(-2.8, deckY + 2.6, z0 + len - 9.4), V(-2.8, deckY + 2.6, z0 + len - 2.6), V(0, deckY + 4, z0 + len - 2.6), V(0, deckY + 4, z0 + len - 9.4), C(0xf2efe8));
      g.quadV(V(2.8, deckY + 2.6, z0 + len - 2.6), V(2.8, deckY + 2.6, z0 + len - 9.4), V(0, deckY + 4, z0 + len - 9.4), V(0, deckY + 4, z0 + len - 2.6), C(0xe6e2da));
      // entry ramp from the beach
      const rampLen = 16;
      g.quadV(V(-w, 0.3, z0 - rampLen), V(-w, deckY, z0), V(w, deckY, z0), V(w, 0.3, z0 - rampLen), plankDark);
      const mesh = new THREE.Mesh(g.build(), this.solid);
      mesh.name = 'terrain.pier';
      mesh.position.set(px - offX, 0, shore - offZ);
      mesh.rotation.y = yaw;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.add(mesh, px, shore, 3500);
      // colliders (rotated with the pier)
      const q = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw);
      const at = (lz: number) => V(0, 0, lz).applyQuaternion(q);
      const deckC = at(z0 + len / 2);
      this.addBoxQ(px + deckC.x, deckY - 0.25, shore + deckC.z, w, 0.25, len / 2, q, offX, offZ, 'wood');
      for (const sx of [-1, 1]) {
        const rc = V(sx * w, 0, z0 + 12 + (len - 12) / 2).applyQuaternion(q);
        this.addBoxQ(px + rc.x, deckY + 0.5, shore + rc.z, 0.08, 0.5, (len - 12) / 2, q, offX, offZ, 'wood');
      }
      const rampC = at(z0 - rampLen / 2);
      const pitch = Math.atan2(deckY - 0.3, rampLen);
      const qr = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -pitch));
      this.addBoxQ(px + rampC.x, (deckY + 0.3) / 2 - 0.2, shore + rampC.z, w, 0.2, Math.hypot(rampLen, deckY) / 2, qr, offX, offZ, 'wood');
      const p0 = at(z0 + 6);
      this.pois.push({
        id: 'pier', name: 'Fishing Pier', icon: '🎣', ax: px + p0.x, az: shore + p0.z,
        pose: { position: { x: px + p0.x - offX, y: deckY + 0.4, z: shore + p0.z - offZ }, yaw },
      });
    }

    // ── sea wall continuing the city promenade (outside the city + airport) ──
    {
      const W = CONFIG.world;
      const ranges: [number, number][] = [
        [W.cityBounds.maxX, CONFIG.terrain.seaWallEndX],
        [W.airportBounds.maxX, W.cityBounds.minX],
        [W.coast.westX + 330, W.airportBounds.minX],
      ];
      const g = new Geo();
      const conc = C(0xe9dfcf);
      const cap = C(0xf6efe4);
      for (const [x0, x1] of ranges) {
        if (x1 - x0 < 4) continue;
        g.box(x0, -0.6, SEA_WALL_Z - 0.4, x1, 1.15, SEA_WALL_Z + 0.4, conc, { shade: 0.04 });
        g.box(x0 - 0.1, 1.15, SEA_WALL_Z - 0.5, x1 + 0.1, 1.3, SEA_WALL_Z + 0.5, cap);
        // stairs down to the beach every ~120 m
        for (let x = x0 + 60; x < x1 - 30; x += 120) {
          for (let s = 0; s < 4; s++) g.box(x - 1.5, -0.2, SEA_WALL_Z + 0.4 + s * 0.45, x + 1.5, 1.0 - s * 0.25, SEA_WALL_Z + 0.85 + s * 0.45, conc);
        }
        this.addBox((x0 + x1) / 2, 0.35, SEA_WALL_Z, (x1 - x0) / 2, 0.95, 0.45, offX, offZ, 'concrete');
      }
      const mesh = new THREE.Mesh(g.build(), this.solid);
      mesh.name = 'terrain.seawall';
      mesh.position.set(-offX, 0, -offZ);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      this.add(mesh, 0, SEA_WALL_Z, 1e9);
    }

    // ── summit viewpoint ──
    {
      const sx = F.summitX;
      const sz = F.summitZ;
      const y = F.summitTop;
      const g = new Geo();
      const stone = C(0xb7ada0);
      const dark = C(0x8f877c);
      for (let i = 0; i < 20; i++) {
        if (i === 5 || i === 15) continue; // openings
        const a0 = (i / 20) * Math.PI * 2;
        const a1 = ((i + 1) / 20) * Math.PI * 2;
        const r = 17;
        const p0 = V(Math.cos(a0) * r, 0, Math.sin(a0) * r);
        const p1 = V(Math.cos(a1) * r, 0, Math.sin(a1) * r);
        const n0 = p0.clone().setLength(r - 0.6);
        const n1 = p1.clone().setLength(r - 0.6);
        const h = 0.85;
        g.quadV(V(p0.x, -0.6, p0.z), V(p0.x, h, p0.z), V(p1.x, h, p1.z), V(p1.x, -0.6, p1.z), stone, (i % 2) * 0.05);
        g.quadV(V(n1.x, -0.6, n1.z), V(n1.x, h, n1.z), V(n0.x, h, n0.z), V(n0.x, -0.6, n0.z), dark);
        g.quadV(V(p0.x, h, p0.z), V(n0.x, h, n0.z), V(n1.x, h, n1.z), V(p1.x, h, p1.z), C(0xcfc6b9));
      }
      // telescope
      g.frustum(6, 0, 0.12, 1.2, 0.08, C(0x4d5560), null);
      g.box(-0.18, 1.2, -0.6, 0.18, 1.5, 0.6, C(0x2f6f8f));
      // benches
      for (const a of [0.8, 2.4, 4.0]) {
        const bx = Math.cos(a) * 12;
        const bz = Math.sin(a) * 12;
        g.box(bx - 1.0, 0.45, bz - 0.3, bx + 1.0, 0.55, bz + 0.3, C(0xa77b52));
        g.box(bx - 0.9, 0, bz - 0.2, bx - 0.75, 0.45, bz + 0.2, dark);
        g.box(bx + 0.75, 0, bz - 0.2, bx + 0.9, 0.45, bz + 0.2, dark);
      }
      // flag pole + cairn
      g.frustum(6, 0, 0.08, 9, 0.05, C(0xdedede), null);
      g.box(0.05, 7.6, -0.02, 1.9, 8.8, 0.02, C(0xff7a6b));
      g.blob(-6, 0.6, 4, 1.4, 1.0, 1.4, 0, stone, dark, new Rng(3), 0.3);
      const mesh = new THREE.Mesh(g.build(), this.solid);
      mesh.name = 'terrain.viewpoint';
      mesh.position.set(sx - offX, y, sz - offZ);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.add(mesh, sx, sz, 5000);
      this.pois.push({
        id: 'summit', name: 'Summit Viewpoint', icon: '🏔️', ax: sx, az: sz + 6,
        pose: { position: { x: sx - offX, y: y + 0.6, z: sz + 6 - offZ }, yaw: 0 },
      });
    }
  }

  private add(mesh: THREE.Mesh, ax: number, az: number, range: number): void {
    this.group.add(mesh);
    this.meshes.push(mesh);
    this.anchors.push({ mesh, ax, az, range });
  }

  private addBox(ax: number, y: number, az: number, hx: number, hy: number, hz: number, offX: number, offZ: number, material: 'concrete' | 'wood'): void {
    const desc = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ax - offX, y, az - offZ).setCollisionGroups(groups(G.WORLD));
    const c = this.physics.world.createCollider(desc);
    this.physics.tag(c, { kind: 'building', material });
    this.colliders.push(c);
  }

  private addBoxQ(ax: number, y: number, az: number, hx: number, hy: number, hz: number, q: THREE.Quaternion, offX: number, offZ: number, material: 'wood' | 'concrete'): void {
    const desc = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ax - offX, y, az - offZ).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }).setCollisionGroups(groups(G.WORLD));
    const c = this.physics.world.createCollider(desc);
    this.physics.tag(c, { kind: 'road', material });
    this.colliders.push(c);
  }

  /** Lakes reported by uploaded tiles. */
  addLakes(lakes: { key: number; x: number; z: number; R: number; W: number; level: number }[], offX: number, offZ: number): void {
    const n = noiseFor(CONFIG.game.seed);
    for (const L of lakes) {
      if (this.lakes.has(L.key)) continue;
      const seg = 48;
      const pos: number[] = [];
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const r0 = L.R + 0.5 * L.W;
        const px = L.x + Math.cos(a) * r0;
        const pz = L.z + Math.sin(a) * r0;
        const wob = lakeWobble(n, L as Lake, px, pz);
        ring.push(V(Math.cos(a) * r0 * wob, 0, Math.sin(a) * r0 * wob));
      }
      for (let i = 0; i < seg; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % seg];
        pos.push(0, 0, 0, b.x, 0, b.z, a.x, 0, a.z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const nor = new Float32Array(pos.length);
      for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.water);
      mesh.name = 'terrain.lake';
      // the group is origin-shifted by core: offset + group.position stays constant
      mesh.position.set(L.x - (offX + this.group.position.x), L.level, L.z - (offZ + this.group.position.z));
      mesh.receiveShadow = true;
      mesh.userData.lake = L;
      this.group.add(mesh);
      this.lakes.set(L.key, mesh);
      this.anchors.push({ mesh, ax: L.x, az: L.z, range: 9000 });
    }
  }

  /** Per frame: lighthouse beam + lamp, distance culling, lake pruning. cam* ABSOLUTE. */
  update(dt: number, camX: number, camZ: number): void {
    const night = GLOBAL_UNIFORMS.uNight.value;
    if (this.beam) {
      this.beam.rotation.y += dt * 0.85;
      this.beam.visible = night > 0.05;
    }
    if (this.lamp) this.lampMat.color.setRGB(0.55 + night * 3.5, 0.5 + night * 3.1, 0.38 + night * 2.2);
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const a = this.anchors[i];
      const d = Math.hypot(a.ax - camX, a.az - camZ);
      a.mesh.visible = d < a.range;
      const lake = a.mesh.userData.lake as Lake | undefined;
      if (lake && d > 12000) {
        this.group.remove(a.mesh);
        (a.mesh as THREE.Mesh).geometry.dispose();
        this.lakes.delete(lake.key);
        this.anchors.splice(i, 1);
      }
    }
  }

  /** Floating origin: group is shifted by core (top-level); keep POI local poses in sync. */
  onOriginShift(dx: number, dz: number): void {
    for (const p of this.pois) {
      p.pose.position.x -= dx;
      p.pose.position.z -= dz;
    }
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    for (const m of this.lakes.values()) m.geometry.dispose();
    for (const c of this.colliders) this.physics.removeCollider(c);
    this.beamMat.dispose();
    this.lampMat.dispose();
  }
}
