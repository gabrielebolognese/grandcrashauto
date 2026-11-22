import * as THREE from 'three';
import { CONFIG } from '../config';
import type { SurfaceMaterial } from '../core/Physics';
import type { GameContext, IWorld } from '../game/contracts';
import type { CityData, DistrictId, Pose } from './types';
import { generateCity } from './gen/CityGen';
import type { CityLayout } from './gen/model';
import * as Lay from './gen/layout';
import { HeightField, SURF } from './HeightField';
import { ChunkBuilder, keyOf } from './render/ChunkBuilder';
import { BuildingRenderer } from './render/Buildings';
import { AirportRenderer } from './render/AirportRenderer';
import { buildHighwayMeshes } from './render/HighwayMesh';
import { createGroundMaterial } from './render/materials';
import { WorldPhysics } from './WorldPhysics';
import { WorldDebug } from './WorldDebug';

const SURF_NAMES: SurfaceMaterial[] = ['asphalt', 'concrete', 'grass', 'sand', 'water', 'metal'];

/**
 * The city (SPEC §5): deterministic generator → CityData + internal layout, chunk-streamed ground meshes with a
 * low-detail layer for everything not loaded (also the altitude LOD), instanced buildings, the highway loop, resident
 * static colliders and fast raster queries.
 *
 * Coordinates: the generator works in ABSOLUTE coordinates; all IWorld queries take LOCAL coordinates (floating
 * origin) and add ctx.origin.offset. All meshes hang off one root group that core shifts with the origin; CityData
 * is shifted in place by core. Outside CONFIG.world.cityBounds the queries delegate to ctx.terrain / ctx.highways.
 *
 * groundHeightAt(x,z) returns the LOWEST drivable surface at x,z (streets under the viaduct, not the deck above).
 * Use groundHeightNear(x, y, z) to get the surface nearest below a reference height (e.g. on the viaduct deck).
 */
export class World implements IWorld {
  readonly name = 'world';
  data!: CityData;
  layout!: CityLayout;
  hf!: HeightField;
  readonly root = new THREE.Group();
  private groundMat!: THREE.MeshStandardMaterial;
  private chunks!: ChunkBuilder;
  private loaded = new Map<string, THREE.Mesh | null>();
  private queue: string[] = [];
  private buildings!: BuildingRenderer;
  private airport: AirportRenderer | null = null;
  private lodMesh!: THREE.Mesh;
  private lodRanges!: Map<string, [number, number]>;
  private lodIndex!: Uint32Array;
  private lodDirty = true;
  private bldDirty = true;
  private bldKeySig = '';
  private focusAbs = new THREE.Vector3();
  private focusLocal = new THREE.Vector3();
  private focusChunk = '';
  private altitudeMode = 0; // 0 street, 1 > 150 m, 2 > 600 m
  private phys!: WorldPhysics;
  private debugView: WorldDebug | null = null;
  private hwMask!: Uint8Array; // 2 m raster over the city: 1 = highway carriageway
  private tmpV = new THREE.Vector3();
  private stats = { genMs: 0, physMs: 0, chunkMs: 0 };

  constructor(private ctx: GameContext) {}

  // ───────────────────────────── init ─────────────────────────────
  init(): void {
    const t0 = performance.now();
    const { layout, hf } = generateCity(CONFIG.game.seed);
    this.layout = layout;
    this.hf = hf;
    this.data = layout.data;
    const t1 = performance.now();
    this.stats.genMs = t1 - t0;

    // materials
    this.groundMat = createGroundMaterial();
    this.ctx.env.patchMaterial?.(this.groundMat, 'road');

    // highway (global mesh) + physics
    const hwb = buildHighwayMeshes(layout, (x, z) => {
      for (const [dx, dz] of [[0, 0], [2, 2], [-2, 2], [2, -2], [-2, -2]]) {
        const s = hf.surface(x + dx, z + dz);
        if (s === SURF.asphalt || s === SURF.concrete) return false;
      }
      return true;
    });
    const hwMesh = new THREE.Mesh(hwb.vis.toGeometry(), this.groundMat);
    hwMesh.receiveShadow = true;
    hwMesh.name = 'world-highway';
    const hwHigh = new THREE.Mesh(hwb.visHigh.toGeometry(), this.groundMat);
    hwHigh.castShadow = true;
    hwHigh.receiveShadow = true;
    hwHigh.name = 'world-highway-elevated';
    this.root.add(hwMesh, hwHigh);
    this.buildHwMask();

    this.phys = new WorldPhysics(this.ctx.physics);
    this.phys.build(layout, hwb);
    this.stats.physMs = performance.now() - t1;

    // buildings
    this.buildings = new BuildingRenderer(layout.boxParts, layout.roofs, layout.tanks, CONFIG.world.chunkSize);
    this.ctx.env.patchMaterial?.(this.buildings.facade, 'building');
    this.ctx.env.patchMaterial?.(this.buildings.roofMat, 'building');
    this.root.add(this.buildings.group);
    if (layout.airport) {
      this.airport = new AirportRenderer(layout.airport, this.groundMat, this.buildings.facade, this.buildings.roofMat);
      this.root.add(this.airport.group);
    }

    // ground chunks + LOD layer
    this.chunks = new ChunkBuilder(layout);
    const lod = this.chunks.buildLOD();
    this.lodRanges = lod.ranges;
    this.lodIndex = lod.index;
    this.lodMesh = new THREE.Mesh(lod.geometry, this.groundMat);
    this.lodMesh.receiveShadow = true;
    this.lodMesh.name = 'world-lod';
    lod.geometry.setIndex(new THREE.Uint32BufferAttribute(new Uint32Array(lod.index.length), 1));
    this.root.add(this.lodMesh);

    this.root.name = 'world-root';
    this.ctx.engine.scene.add(this.root);

    // initial chunks around the spawn so the first frame is complete
    const sp = this.data.spawn.position;
    this.focusAbs.set(sp.x, sp.y, sp.z);
    this.refreshDesired();
    const tc = performance.now();
    while (this.queue.length) this.loadChunk(this.queue.shift()!);
    this.stats.chunkMs = performance.now() - tc;
    this.applyStreamingChanges();

    this.ctx.events.on('qualityChanged', () => {
      this.focusChunk = '';
    });

    if (new URLSearchParams(location.search).has('worlddebug')) {
      this.debugView = new WorldDebug(this.data, layout);
      this.root.add(this.debugView.group);
    }
    if (this.ctx.debug) {
      (window as any).__world = this;
      console.info(`[world] gen ${this.stats.genMs.toFixed(0)} ms, phys ${this.stats.physMs.toFixed(0)} ms (${this.phys.count} colliders), chunks ${this.stats.chunkMs.toFixed(0)} ms; ` +
        `${this.data.buildings.length} buildings, ${layout.boxParts.length} parts, ${this.data.props.length} props, ${this.data.parkedCars.length} parked cars, ` +
        `${this.data.roads.nodes.length}/${this.data.roads.edges.length} road nodes/edges, ${this.data.ped.nodes.length}/${this.data.ped.edges.length} ped, ${this.data.benches.length} benches`);
    }
  }

  private buildHwMask(): void {
    const cb = CONFIG.world.cityBounds;
    const w = Math.ceil((cb.maxX - cb.minX) / 2), d = Math.ceil((cb.maxZ - cb.minZ) / 2);
    this.hwMask = new Uint8Array(w * d);
    const hw = this.layout.highway;
    const H = hw.halfW;
    const S = hw.samples;
    for (let i = 0; i < S.length; i++) {
      const a = S[i], b = S[(i + 1) % S.length];
      const minX = Math.min(a.x, b.x) - H, maxX = Math.max(a.x, b.x) + H, minZ = Math.min(a.z, b.z) - H, maxZ = Math.max(a.z, b.z) + H;
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      for (let z = Math.floor((minZ - cb.minZ) / 2); z <= Math.floor((maxZ - cb.minZ) / 2); z++)
        for (let x = Math.floor((minX - cb.minX) / 2); x <= Math.floor((maxX - cb.minX) / 2); x++) {
          if (x < 0 || z < 0 || x >= w || z >= d) continue;
          const px = cb.minX + x * 2 + 1, pz = cb.minZ + z * 2 + 1;
          const u = Math.min(1, Math.max(0, ((px - a.x) * dx + (pz - a.z) * dz) / l2));
          if ((a.x + dx * u - px) ** 2 + (a.z + dz * u - pz) ** 2 <= H * H) this.hwMask[z * w + x] = 1;
        }
    }
  }

  // ───────────────────────────── streaming ─────────────────────────────
  setFocus(pos: THREE.Vector3): void {
    this.focusLocal.copy(pos);
    const o = this.ctx.origin?.offset;
    this.focusAbs.set(pos.x + (o?.x ?? 0), pos.y, pos.z + (o?.z ?? 0));
  }

  private chunkRadius(): number {
    return this.ctx.quality.current.chunkRadius ?? 3;
  }

  private refreshDesired(): void {
    const cs = CONFIG.world.chunkSize;
    const fcx = Math.floor(this.focusAbs.x / cs), fcz = Math.floor(this.focusAbs.z / cs);
    const key = `${fcx},${fcz},${this.altitudeMode},${this.chunkRadius()}`;
    if (key === this.focusChunk) return;
    this.focusChunk = key;
    const r = this.altitudeMode > 0 ? -1 : this.chunkRadius();
    const want: { k: string; d: number }[] = [];
    for (const k of this.chunks.keys) {
      const [cx, cz] = k.split(',').map(Number);
      const d = Math.max(Math.abs(cx - fcx), Math.abs(cz - fcz));
      if (d <= r && !this.loaded.has(k)) want.push({ k, d });
    }
    want.sort((a, b) => a.d - b.d);
    this.queue = want.map((w) => w.k);
    // unload with hysteresis (r + 1)
    for (const [k, mesh] of this.loaded) {
      const [cx, cz] = k.split(',').map(Number);
      const d = Math.max(Math.abs(cx - fcx), Math.abs(cz - fcz));
      if (d > r + 1 || this.altitudeMode > 0) {
        if (mesh) {
          this.root.remove(mesh);
          mesh.geometry.dispose();
        }
        this.loaded.delete(k);
        this.lodDirty = true;
        this.bldDirty = true;
      }
    }
    this.bldDirty = true;
  }

  private loadChunk(k: string): void {
    const [cx, cz] = k.split(',').map(Number);
    const geo = this.chunks.buildDetail(cx, cz);
    let mesh: THREE.Mesh | null = null;
    if (geo) {
      mesh = new THREE.Mesh(geo, this.groundMat);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.name = 'chunk ' + k;
      this.root.add(mesh);
    }
    this.loaded.set(k, mesh);
    this.lodDirty = true;
    this.bldDirty = true;
  }

  private applyStreamingChanges(): void {
    if (this.lodDirty) {
      this.lodDirty = false;
      const idx = this.lodMesh.geometry.getIndex()!;
      const arr = idx.array as Uint32Array;
      let n = 0;
      for (const [k, [start, count]] of this.lodRanges) {
        if (this.loaded.has(k)) continue;
        arr.set(this.lodIndex.subarray(start, start + count), n);
        n += count;
      }
      this.lodMesh.geometry.setDrawRange(0, n);
      idx.clearUpdateRanges();
      idx.addUpdateRange(0, Math.max(1, n));
      idx.needsUpdate = true;
      this.lodMesh.visible = n > 0;
    }
    if (this.bldDirty) {
      this.bldDirty = false;
      const set = new Set<string>();
      const cs = CONFIG.world.chunkSize;
      const fcx = Math.floor(this.focusAbs.x / cs), fcz = Math.floor(this.focusAbs.z / cs);
      const r = this.chunkRadius() + 1;
      for (const k of this.chunks.keys) {
        const [cx, cz] = k.split(',').map(Number);
        if (this.altitudeMode > 0 || Math.max(Math.abs(cx - fcx), Math.abs(cz - fcz)) <= r) set.add(k);
      }
      const sig = [...set].sort().join('|') + this.altitudeMode;
      if (sig !== this.bldKeySig) {
        this.bldKeySig = sig;
        this.buildings.detail = this.altitudeMode;
        this.buildings.rebuild(set, this.focusAbs.x, this.focusAbs.z);
      }
    }
  }

  update(): void {
    // altitude LOD: focus height above the ground (plane altitude in plane mode)
    let agl = this.focusLocal.y - this.groundHeightAt(this.focusLocal.x, this.focusLocal.z);
    const planes = this.ctx.planes;
    if (this.ctx.game.mode === 'plane' && planes?.active && planes.state) agl = planes.state.altitudeAgl;
    const mode = agl > 600 ? 2 : agl > 150 ? 1 : agl < 120 ? 0 : this.altitudeMode;
    if (mode !== this.altitudeMode) {
      this.altitudeMode = mode;
      this.focusChunk = '';
    }
    this.refreshDesired();
    // time-sliced chunk building: ≤ 1 chunk per frame (2 if the first one was quick)
    const t0 = performance.now();
    let built = 0;
    while (this.queue.length && built < 2) {
      this.loadChunk(this.queue.shift()!);
      built++;
      if (performance.now() - t0 > 3) break;
    }
    this.applyStreamingChanges();
    this.airport?.update(this.focusAbs.x, this.focusAbs.z, this.ctx.engine.size.height);
  }

  // ───────────────────────────── queries ─────────────────────────────
  private ox(): number {
    return this.ctx.origin?.offset.x ?? 0;
  }
  private oz(): number {
    return this.ctx.origin?.offset.z ?? 0;
  }
  /** City or airport (both answered by the world's own rasters/analytic base). */
  private inCity(ax: number, az: number): boolean {
    const cb = CONFIG.world.cityBounds;
    if (ax >= cb.minX && ax <= cb.maxX && az >= cb.minZ && az <= cb.maxZ) return true;
    const ab = CONFIG.world.airportBounds;
    return ax >= ab.minX && ax <= ab.maxX && az >= ab.minZ && az <= ab.maxZ;
  }

  groundHeightAt(x: number, z: number): number {
    const ax = x + this.ox(), az = z + this.oz();
    if (this.inCity(ax, az)) return this.hf.height(ax, az);
    return this.outsideHeight(x, z, undefined);
  }

  /** Surface nearest below `y + 1.5` at (x,z): returns the viaduct deck when on it, the street when under it. */
  groundHeightNear(x: number, y: number, z: number): number {
    const ax = x + this.ox(), az = z + this.oz();
    if (this.inCity(ax, az)) {
      const up = this.hf.upperHeight(ax, az);
      if (up === up && y >= up - 1.5) return up;
      return this.hf.height(ax, az);
    }
    return this.outsideHeight(x, z, y);
  }

  private outsideHeight(x: number, z: number, nearY: number | undefined): number {
    const t = this.ctx.terrain;
    const th = t ? t.heightAt(x, z) : 0;
    const r = this.ctx.highways?.roadHeightAt(x, z, nearY ?? th);
    return r ?? th;
  }

  surfaceAt(x: number, z: number): SurfaceMaterial {
    const ax = x + this.ox(), az = z + this.oz();
    if (this.inCity(ax, az)) return SURF_NAMES[this.hf.surface(ax, az)] ?? 'asphalt';
    if (this.ctx.highways?.isOnHighway(x, z)) return 'asphalt';
    return this.ctx.terrain ? this.ctx.terrain.surfaceAt(x, z) : 'grass';
  }

  districtAt(x: number, z: number): DistrictId {
    const ax = x + this.ox(), az = z + this.oz();
    const d = this.data;
    const half = d.size / 2;
    if (ax >= -half && ax < half && az >= -half && az < half) {
      const n = d.districtGridSize;
      const ix = Math.min(n - 1, Math.floor(((ax + half) / d.size) * n));
      const iz = Math.min(n - 1, Math.floor(((az + half) / d.size) * n));
      return d.districtGrid[iz * n + ix];
    }
    if (this.inCity(ax, az)) return ax < CONFIG.world.cityBounds.minX ? 'hub' : az > Lay.SHORE_Z ? 'water' : 'highway';
    if (this.oceanDistance(x, z) > 0) return 'water';
    if (this.ctx.highways?.isOnHighway(x, z)) return 'highway';
    return 'residential';
  }

  isDeepWater(x: number, z: number): boolean {
    const ax = x + this.ox(), az = z + this.oz();
    const wl = CONFIG.world.waterLevel;
    if (this.inCity(ax, az)) {
      if (az < Lay.BEACH_START_Z || ax < CONFIG.world.cityBounds.minX) return false;
      return wl - this.hf.height(ax, az) > CONFIG.world.deepWaterDepth;
    }
    const t = this.ctx.terrain;
    if (!t) return false;
    const w = t.waterAt(x, z);
    if (w === null) return false;
    if (this.ctx.highways?.roadHeightAt(x, z) != null) return false;
    return w - t.heightAt(x, z) > CONFIG.world.deepWaterDepth;
  }

  oceanDistance(x: number, z: number): number {
    const ax = x + this.ox(), az = z + this.oz();
    if (this.inCity(ax, az)) return ax < CONFIG.world.cityBounds.minX ? 0 : Math.max(0, az - Lay.SHORE_Z);
    return this.ctx.terrain ? this.ctx.terrain.oceanDistance(x, z) : 0;
  }

  isOnHighway(x: number, z: number): boolean {
    const ax = x + this.ox(), az = z + this.oz();
    if (this.inCity(ax, az)) {
      const cb = CONFIG.world.cityBounds;
      const w = Math.ceil((cb.maxX - cb.minX) / 2);
      const ix = Math.floor((ax - cb.minX) / 2), iz = Math.floor((az - cb.minZ) / 2);
      return this.hwMask[iz * w + ix] === 1;
    }
    return this.ctx.highways?.isOnHighway(x, z) ?? false;
  }

  findRespawn(pos: THREE.Vector3, yaw: number): Pose {
    const R = this.data.roads;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let best = Infinity;
    let bx = 0, bz = 0, by = 0, bdx = 0, bdz = 1, bEdge = -1;
    const clearance = (nodeId: number) => {
      const n = R.nodes[nodeId];
      if (n.kind !== 'intersection') return 3;
      let w = 0;
      for (const e of n.edges) w = Math.max(w, R.edges[e].width / 2);
      return w + 7;
    };
    for (const e of R.edges) {
      if (this.layout.noRespawnEdges.has(e.id)) continue;
      const P = e.points;
      let total = 0;
      for (let i = 0; i + 1 < P.length; i++) total += Math.hypot(P[i + 1].x - P[i].x, P[i + 1].z - P[i].z);
      const clA = clearance(e.a), clB = clearance(e.b);
      if (total < clA + clB + 1) continue;
      let acc = 0;
      for (let i = 0; i + 1 < P.length; i++) {
        const a = P[i], b = P[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;
        let t = ((pos.x - a.x) * dx + (pos.z - a.z) * dz) / (len * len);
        t = Math.min(1, Math.max(0, t));
        // clamp along-distance away from intersections
        const along = Math.min(total - clB, Math.max(clA, acc + t * len));
        t = (along - acc) / len;
        if (t < 0 || t > 1) {
          acc += len;
          continue;
        }
        const px = a.x + dx * t, pz = a.z + dz * t, py = a.y + (b.y - a.y) * t;
        const d = (px - pos.x) ** 2 + (pz - pos.z) ** 2 + 9 * Math.min(100, (py - pos.y) ** 2);
        if (d < best) {
          best = d;
          bx = px;
          bz = pz;
          by = py;
          bdx = dx / len;
          bdz = dz / len;
          bEdge = e.id;
        }
        acc += len;
      }
    }
    // highways outside the city may be closer
    const ext = this.ctx.highways?.findRespawn(pos, yaw, Math.sqrt(best));
    if (ext) {
      const d = (ext.position.x - pos.x) ** 2 + (ext.position.z - pos.z) ** 2;
      if (d < best || bEdge < 0) return ext;
    }
    if (bEdge < 0) return { position: { x: pos.x, y: this.groundHeightAt(pos.x, pos.z), z: pos.z }, yaw };
    const edge = R.edges[bEdge];
    let dx = bdx, dz = bdz;
    if (!edge.oneWay && dx * fx + dz * fz < 0) {
      dx = -dx;
      dz = -dz;
    }
    const tyaw = Math.atan2(dx, dz);
    const off = this.layout.edgeLaneOffset.get(bEdge) ?? 1.8;
    // right = (-cos yaw, 0, sin yaw)
    const x = bx - Math.cos(tyaw) * off, z = bz + Math.sin(tyaw) * off;
    const y = this.groundHeightNear(x, by + 1, z);
    return { position: { x, y, z }, yaw: tyaw };
  }

  dispose(): void {
    this.ctx.engine.scene.remove(this.root);
    for (const m of this.loaded.values()) m?.geometry.dispose();
    this.lodMesh.geometry.dispose();
    this.airport?.dispose();
    this.buildings.dispose();
    this.groundMat.dispose();
    this.phys.dispose();
    this.debugView?.dispose();
  }
}
