import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import type { AirportModel } from '../gen/airport';
import { Mat } from '../gen/model';
import { GeoBuilder } from './GeoBuilder';
import { islandDetail, lerpHex } from './ChunkBuilder';
import { BuildingRenderer } from './Buildings';

/**
 * Airport visuals: detailed mesh (paved surfaces, all paint, fixtures, fence, hangar roofs, terminal curb) shown
 * within CONFIG-ish 1.5 km, a cheap low mesh (grass + paved rects) otherwise, runway/taxiway lights as glowing points
 * (brighter at night), and the airport buildings as their own instanced set (shares the facade material).
 */
export class AirportRenderer {
  readonly group = new THREE.Group();
  readonly detail: THREE.Mesh;
  readonly low: THREE.Mesh;
  readonly lights: THREE.Points;
  readonly buildings: BuildingRenderer;
  private lightMat: THREE.ShaderMaterial;
  private detailed = false;

  constructor(private model: AirportModel, groundMat: THREE.Material, facade: THREE.Material, roofMat: THREE.Material) {
    const AB = CONFIG.world.airportBounds;
    const E = model.data.elevation;
    // ── low ──
    const lo = new GeoBuilder();
    grass(lo, AB, E, 250);
    for (const r of model.paved) lo.decal(r.cx, r.cz, r.dx, r.dz, r.hl, r.hw, r.y, r.col, r.mat);
    this.low = new THREE.Mesh(lo.toGeometry(), groundMat);
    this.low.receiveShadow = true;
    this.low.name = 'airport-low';
    // ── detail ──
    const gb = new GeoBuilder();
    grass(gb, AB, E, 100);
    for (const r of model.paved) gb.decal(r.cx, r.cz, r.dx, r.dz, r.hl, r.hw, r.y, r.col, r.mat);
    for (const d of model.decals) gb.decal(d.cx, d.cz, d.dx, d.dz, d.hl, d.hw, d.y, d.col, d.mat);
    for (const s of model.solids) if (s.col >= 0) gb.box(s.cx, s.cy, s.cz, s.w, s.h, s.d, s.yaw, s.col, s.mat, s.h0 ?? s.h);
    for (const c of model.cylinders) gb.cylinder(c.cx, c.cy, c.cz, c.r, c.h, c.segs, c.col, c.mat, c.open);
    for (const isl of model.islands) islandDetail(gb, isl, -1e9, 1e9, -1e9, 1e9);
    for (const a of model.arches) arch(gb, a.cx, a.cz, a.w, a.d, a.y, a.h, a.col);
    for (const [x0, z0, x1, z1] of model.fence) fence(gb, x0, z0, x1, z1, E);
    this.detail = new THREE.Mesh(gb.toGeometry(), groundMat);
    this.detail.receiveShadow = true;
    this.detail.castShadow = false;
    this.detail.name = 'airport-detail';
    // ── lights ──
    const n = model.lights.length;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
    const c = new THREE.Color();
    model.lights.forEach((l, i) => {
      pos.set([l.x, l.y, l.z], i * 3);
      c.setHex(l.col);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = l.size;
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    lg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.lightMat = new THREE.ShaderMaterial({
      uniforms: { uNight: GLOBAL_UNIFORMS.uNight, uTime: GLOBAL_UNIFORMS.uTime, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec3 color; attribute float aSize; varying vec3 vCol; varying float vA;
        uniform float uNight; uniform float uScale; uniform float uTime;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          float world = aSize * mix(0.55, 2.4, uNight);
          gl_PointSize = clamp(world * uScale / max(1.0, d), 1.5, 48.0);
          vCol = color;
          vA = mix(0.55, 1.0, uNight) * (1.0 - smoothstep(2500.0, 6000.0, d));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol; varying float vA;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float r = length(q) * 2.0;
          float core = smoothstep(1.0, 0.0, r);
          float a = core * core * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol * (1.0 + core * 1.5), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lights = new THREE.Points(lg, this.lightMat);
    this.lights.frustumCulled = false;
    this.lights.name = 'airport-lights';
    // ── buildings ──
    this.buildings = new BuildingRenderer(model.parts, [], [], CONFIG.world.chunkSize, facade, roofMat);
    this.buildings.rebuild(new Set(), 0, 0);
    this.group.add(this.low, this.detail, this.lights, this.buildings.group);
    this.detail.visible = false;
    void lerpHex;
  }

  /** focus: absolute position. */
  update(fx: number, fz: number, viewportH: number): void {
    const AB = CONFIG.world.airportBounds;
    const dx = Math.max(AB.minX - fx, 0, fx - AB.maxX), dz = Math.max(AB.minZ - fz, 0, fz - AB.maxZ);
    const near = Math.hypot(dx, dz) < 1500;
    if (near !== this.detailed) {
      this.detailed = near;
      this.detail.visible = near;
      this.low.visible = !near;
      const all = new Set<string>();
      if (near) for (const p of this.model.parts) all.add(`${Math.floor(p.cx / CONFIG.world.chunkSize)},${Math.floor(p.cz / CONFIG.world.chunkSize)}`);
      this.buildings.rebuild(all, fx, fz);
    }
    this.lightMat.uniforms.uScale.value = viewportH * 0.9;
  }

  dispose(): void {
    this.detail.geometry.dispose();
    this.low.geometry.dispose();
    this.lights.geometry.dispose();
    this.lightMat.dispose();
    this.buildings.dispose(false);
  }
}

function grass(gb: GeoBuilder, AB: { minX: number; maxX: number; minZ: number; maxZ: number }, y: number, cell: number): void {
  for (let z = AB.minZ; z < AB.maxZ - 0.01; z += cell)
    for (let x = AB.minX; x < AB.maxX - 0.01; x += cell) {
      const shade = ((Math.floor(x / cell) + Math.floor(z / cell)) & 1) === 0 ? 0x8fc26c : 0x89bd68;
      gb.rect(x, Math.min(AB.maxX, x + cell), z, Math.min(AB.maxZ, z + cell), y, shade, Mat.Grass);
    }
}

/** Barrel roof along z (the arch spans x). */
function arch(gb: GeoBuilder, cx: number, cz: number, w: number, d: number, y: number, h: number, col: number): void {
  const segs = 14;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const first = gb.vertexCount;
  for (let i = 0; i <= segs; i++) {
    const t = (i / segs) * Math.PI;
    const x = cx + Math.cos(t) * (w / 2), yy = y + Math.sin(t) * h;
    const nx = Math.cos(t) / (w / 2), ny = Math.sin(t) / h;
    const l = Math.hypot(nx, ny);
    const c = i % 2 === 0 ? col : lerpHex(col, 0xffffff, 0.12);
    gb.vert(x, yy, z0, nx / l, ny / l, 0, c, Mat.Metal);
    gb.vert(x, yy, z1, nx / l, ny / l, 0, c, Mat.Metal);
  }
  for (let i = 0; i < segs; i++) {
    const a = first + i * 2;
    const t = ((i + 0.5) / segs) * Math.PI;
    gb.tri(a, a + 2, a + 3, Math.cos(t), Math.sin(t), 0);
    gb.tri(a, a + 3, a + 1, Math.cos(t), Math.sin(t), 0);
  }
  // gable ends
  for (const [zz, nz] of [[z0, -1], [z1, 1]] as [number, number][]) {
    const c = gb.vert(cx, y, zz, 0, 0, nz, 0xd9d4ca, Mat.Concrete);
    const f = gb.vertexCount;
    for (let i = 0; i <= segs; i++) {
      const t = (i / segs) * Math.PI;
      gb.vert(cx + Math.cos(t) * (w / 2), y + Math.sin(t) * h, zz, 0, 0, nz, 0xd9d4ca, Mat.Concrete);
    }
    for (let i = 0; i < segs; i++) gb.tri(c, f + i, f + i + 1, 0, 0, nz);
  }
}

function fence(gb: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
  const ux = dx / l, uz = dz / l;
  const yaw = Math.atan2(ux, uz);
  const seg = 25;
  for (let t = 0; t < l; t += seg) {
    const b = Math.min(l, t + seg);
    const cx = x0 + ux * (t + b) / 2, cz = z0 + uz * (t + b) / 2;
    gb.box(cx, y + 0.1, cz, 0.06, 2.2, b - t, yaw, 0x7d8a86, Mat.Metal);
    gb.box(x0 + ux * t, y, z0 + uz * t, 0.14, 2.6, 0.14, yaw, 0x9aa3a6, Mat.Metal);
  }
}
