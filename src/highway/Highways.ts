import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups } from '../core/Physics';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { GameContext, IHighways } from '../game/contracts';
import type { Pose, RoadEdge, RoadGraph, RoadNode, Vec3 } from '../world/types';
import { EXITS, edgesNearRect, getNode, type MNode } from './net/lattice';
import { K_GALLERY, K_TUNNEL, laneStart, lanesAt, peekRoute, routeGen, storeRoute, type EdgeRoute } from './net/route';
import { ChunkBuilder, type ChunkOut, type ColliderSpec } from './build/chunkBuild';
import { createHighwayMaterials, type HighwayMaterials } from './build/materials';
import { GeoBuf, rgb } from './build/GeoBuf';
import { Traffic } from './Traffic';

/**
 * Endless highway network (SPEC-PART3 §4, §8). Generation is PURE and ABSOLUTE (src/highway/net — also used by the
 * terrain workers for corridor carving); this class streams it into the scene around the focus:
 *  - routes macro edges within `routeRadius` (time-sliced generator jobs),
 *  - builds detailed chunks (≈384 m of road: pavement, markings, barriers, rails, bridges, tunnels, galleries,
 *    gantries, lights, kickers, mega jumps, rest stops) within `nearRadius`, colliders within `physRadius`,
 *  - one merged far-LOD ribbon mesh for everything else (visible from planes),
 *  - answers road queries from an absolute spatial hash, keeps a LOCAL RoadGraph joined to the city exits + POIs.
 * Main-thread work is limited to CONFIG.highway.buildBudgetMs per frame.
 */

interface ChunkRec {
  key: string;
  rec: RouteRec;
  k: number;
  i0: number;
  i1: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  state: 'idle' | 'queued' | 'built';
  meshes: THREE.Mesh[];
  cols: ColliderSpec[] | null;
  body: RAPIER.RigidBody | null;
  physQueued: boolean;
  ambient: number[];
  ambientSpecs: ChunkOut['ambient'];
  anchor: [number, number, number];
}

interface RouteRec {
  key: string;
  r: EdgeRoute;
  chunks: ChunkRec[];
  cells: number[];
}

interface GridItem {
  rec: RouteRec;
  i0: number;
  i1: number;
}

interface Job {
  pri: number;
  key: string;
  it: Iterator<void, unknown>;
}

interface Hit {
  rec: RouteRec;
  s: number;
  l: number;
  d: number;
  i: number;
}

const CELL = 64;
const cellKey = (cx: number, cz: number) => (cx + 50000) * 100000 + (cz + 50000);

export class Highways implements IHighways {
  readonly name = 'highways';
  graph: RoadGraph = { nodes: [], edges: [] };
  graphVersion = 0;
  pois: { id: string; name: string; icon: string; pose: Pose }[] = [];

  private mats!: HighwayMaterials;
  private traffic: Traffic | null = null;
  private routes = new Map<string, RouteRec>();
  private routeJobs = new Map<string, Job>();
  private jobs: Job[] = [];
  private grid = new Map<number, GridItem[]>();
  private focusAbs = new THREE.Vector3(0, 0, -400);
  private lastRefreshPos = new THREE.Vector3(1e9, 0, 1e9);
  private refreshT = 0;
  private farMesh: THREE.Mesh | null = null;
  private farSig = '';
  private farT = 0;
  private farJob: Job | null = null;
  private warmGroup = new THREE.Group();
  private graphNodeByKey = new Map<string, RoadNode>();
  private graphEdgeKeys = new Set<string>();
  private poiIds = new Set<string>();
  private time = 0;
  private ready = false;
  private exitWarned = false;
  private tmpV = new THREE.Vector3();
  private prevFocus = new THREE.Vector3();
  private jobMax: Record<string, number> = {};
  private stats = { routes: 0, chunks: 0, bodies: 0, jobsMs: 0, routeMs: 0, built: 0, maxJobMs: 0 };

  constructor(private ctx: GameContext) {}

  // ───────────────────────────── lifecycle ─────────────────────────────
  init(): void {
    const { engine, events } = this.ctx;
    this.mats = createHighwayMaterials();
    this.ctx.env?.patchMaterial?.(this.mats.road, 'road');
    this.ctx.env?.patchMaterial?.(this.mats.far, 'road');
    // warm-up meshes (hidden): every material compiled behind the loading bar
    const tiny = new THREE.BufferGeometry();
    tiny.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -900, 0, 0.01, -900, 0, 0, -900, 0.01]), 3));
    tiny.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]), 3));
    tiny.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9).fill(1), 3));
    tiny.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
    for (const m of [this.mats.road, this.mats.far, this.mats.lamp, this.mats.tunnel, this.mats.sign, this.mats.flash]) {
      const mesh = new THREE.Mesh(tiny, m);
      mesh.castShadow = m === this.mats.road;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.warmGroup.add(mesh);
    }
    this.warmGroup.visible = false;
    this.warmGroup.name = 'highway-warmup';
    engine.scene.add(this.warmGroup);

    events.on('originShift', ({ delta }) => this.onOriginShift(delta.x, delta.z));
    // optional traffic (settings.traffic, off by default)
    try {
      this.traffic = new Traffic(this.ctx, () => this.routeList());
      this.traffic.setEnabled(!!this.ctx.settings?.values?.traffic);
      events.on('settingsChanged', ({ settings }) => this.traffic?.setEnabled(!!settings.traffic));
    } catch (err) {
      console.error('[highways] traffic init failed', err);
      this.traffic = null;
    }
    events.on('qualityChanged', () => {
      this.farSig = '';
      this.lastRefreshPos.set(1e9, 0, 1e9);
    });

    // Pre-route the network around the city behind the loading bar (graph + POIs for the map from the start).
    const t0 = performance.now();
    const o = this.ctx.origin.offset;
    this.focusAbs.set(o.x, 0, o.z - 300);
    const near = edgesNearRect(-6500, -9500, 9000, 1500, 0);
    near.sort((a, b) => this.edgeDist(a.a, a.b) - this.edgeDist(b.a, b.b));
    // fixed set (no time cap) so the Big Jump choice below is deterministic
    for (const e of near) this.routeNow(e.key);
    this.pickBigJump();
    this.stats.routeMs = performance.now() - t0;
    this.ready = true;
    if (this.ctx.debug) {
      (window as unknown as { __highways: Highways }).__highways = this;
      console.info(`[highways] init: ${this.routes.size} edges routed in ${this.stats.routeMs.toFixed(0)} ms, graph ${this.graph.nodes.length}/${this.graph.edges.length}`);
    }
  }

  warmup(): void {
    // build the chunks around the spawn so the first frames are complete
    const t0 = performance.now();
    this.refresh(true);
    while (this.jobs.length && performance.now() - t0 < 1500) this.runJobs(50);
  }

  dispose(): void {
    for (const rec of this.routes.values()) for (const c of rec.chunks) this.unloadChunk(c);
    if (this.farMesh) {
      this.farMesh.geometry.dispose();
      this.farMesh.removeFromParent();
    }
  }

  setFocus(pos: THREE.Vector3): void {
    const o = this.ctx.origin.offset;
    this.focusAbs.set(pos.x + o.x, pos.y, pos.z + o.z);
  }

  fixedUpdate(dt: number): void {
    if (this.ready) this.traffic?.fixedUpdate(dt, this.focusAbs);
  }

  private *routeListGen(): Generator<EdgeRoute> {
    for (const rec of this.routes.values()) yield rec.r;
  }

  private routeList(): Iterable<EdgeRoute> {
    return { [Symbol.iterator]: () => this.routeListGen() };
  }

  update(_dt: number, alpha: number): void {
    if (!this.ready) return;
    this.traffic?.update(alpha);
    const realDt = this.ctx.engine.realDt;
    this.time += realDt;
    this.refreshT -= realDt;
    this.farT -= realDt;
    const moved = Math.hypot(this.focusAbs.x - this.lastRefreshPos.x, this.focusAbs.z - this.lastRefreshPos.z);
    if (this.refreshT <= 0 || moved > 60) this.refresh(false);
    // teleport (map / reset far away): stream the surroundings at once, behind the fade, so the car never lands on
    // a missing deck; normal driving stays within the per-frame budget
    const jump = Math.hypot(this.focusAbs.x - this.prevFocus.x, this.focusAbs.z - this.prevFocus.z) > 300;
    this.prevFocus.copy(this.focusAbs);
    this.runJobs(jump ? 120 : CONFIG.highway.buildBudgetMs);
    // materials: lamps follow the night factor, warning arrows blink
    const night = GLOBAL_UNIFORMS.uNight.value;
    const lv = 0.55 + night * 1.25;
    this.mats.lamp.color.setRGB(lv, lv * 0.9, lv * 0.72);
    this.mats.sign.emissiveIntensity = 0.1 + night * 0.55;
    const on = Math.sin(this.time * Math.PI * 2 * CONFIG.highway.flashHz) > -0.2;
    this.mats.flash.color.setRGB(on ? 1.9 : 0.12, on ? 1.05 : 0.07, on ? 0.15 : 0.02);
  }

  // ───────────────────────────── streaming ─────────────────────────────
  private qScale(): number {
    const lvl = this.ctx.quality?.current?.viewDistance ?? 360;
    return lvl < 300 ? 0.75 : lvl > 450 ? 1.15 : 1;
  }

  private edgeDist(a: string, b: string): number {
    const A = getNode(a), B = getNode(b);
    if (!A || !B) return 1e9;
    const fx = this.focusAbs.x, fz = this.focusAbs.z;
    const dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((fx - A.x) * dx + (fz - A.z) * dz) / l2));
    return Math.hypot(A.x + dx * t - fx, A.z + dz * t - fz);
  }

  private boxDist(minX: number, minZ: number, maxX: number, maxZ: number): number {
    const fx = this.focusAbs.x, fz = this.focusAbs.z;
    const dx = Math.max(minX - fx, 0, fx - maxX), dz = Math.max(minZ - fz, 0, fz - maxZ);
    return Math.hypot(dx, dz);
  }

  private refresh(force: boolean): void {
    const C = CONFIG.highway;
    this.refreshT = 0.3;
    this.lastRefreshPos.copy(this.focusAbs);
    const fx = this.focusAbs.x, fz = this.focusAbs.z;
    const RR = C.routeRadius;
    // 1. routes
    for (const e of edgesNearRect(fx - RR, fz - RR, fx + RR, fz + RR, 0)) {
      if (this.routes.has(e.key) || this.routeJobs.has(e.key)) continue;
      const cached = peekRoute(e.key);
      if (cached) {
        this.register(cached);
        continue;
      }
      const job: Job = { pri: this.edgeDist(e.a, e.b), key: 'route:' + e.key, it: this.routeJobIter(e.key) };
      this.routeJobs.set(e.key, job);
      this.jobs.push(job);
    }
    // 2. chunks
    const nearR = C.nearRadius * this.qScale();
    const physR = C.physRadius;
    const altitude = this.focusAbs.y;
    for (const rec of this.routes.values()) {
      const rd = this.boxDist(rec.r.minX, rec.r.minZ, rec.r.maxX, rec.r.maxZ);
      if (rd > RR * 1.7) {
        this.unregister(rec);
        continue;
      }
      if (rd > nearR + 400) {
        for (const c of rec.chunks) if (c.state !== 'idle') this.unloadChunk(c);
        continue;
      }
      for (const c of rec.chunks) {
        const d = this.boxDist(c.minX, c.minZ, c.maxX, c.maxZ);
        if (d < nearR) {
          if (c.state === 'idle') {
            c.state = 'queued';
            this.jobs.push({ pri: d, key: 'chunk:' + c.key, it: this.chunkJobIter(c) });
          }
        } else if (d > nearR + 250 && c.state !== 'idle') this.unloadChunk(c);
        if (c.state === 'built') {
          const wantPhys = d < physR && altitude < 2500;
          if (wantPhys && !c.body && !c.physQueued) {
            c.physQueued = true;
            this.jobs.push({ pri: d - 2000, key: 'phys:' + c.key, it: this.physJobIter(c) });
          } else if (!wantPhys && c.body && d > physR + 150) this.removeBody(c);
          const shadow = d < 320;
          for (const m of c.meshes) if (m.material === this.mats.road) m.castShadow = shadow;
        }
      }
    }
    // 3. far ribbon
    const farR = (this.ctx.quality?.current?.terrainViewDistance ?? 2200) + C.farExtra;
    const parts: string[] = [];
    for (const rec of this.routes.values()) {
      if (this.boxDist(rec.r.minX, rec.r.minZ, rec.r.maxX, rec.r.maxZ) > farR) continue;
      let mask = '';
      for (const c of rec.chunks) mask += c.state === 'built' ? '1' : '0';
      parts.push(rec.key + ':' + mask);
    }
    const sig = parts.sort().join('|');
    if (sig !== this.farSig && (this.farT <= 0 || force) && !this.farJob) {
      this.farSig = sig;
      this.farT = 1.2;
      this.farJob = { pri: 500, key: 'far', it: this.farJobIter(farR) };
      this.jobs.push(this.farJob);
    }
    this.jobs.sort((a, b) => a.pri - b.pri);
  }

  private runJobs(budgetMs: number): void {
    const t0 = performance.now();
    while (this.jobs.length) {
      const job = this.jobs[0];
      const tj = performance.now();
      let done = false;
      try {
        done = !!job.it.next().done;
      } catch (err) {
        console.error('[highways] job failed', job.key, err);
        done = true;
      }
      const dtj = performance.now() - tj;
      if (dtj > this.stats.maxJobMs) this.stats.maxJobMs = dtj;
      const kind = job.key.slice(0, job.key.indexOf(':') + 1 || job.key.length);
      if (dtj > (this.jobMax[kind] ?? 0)) this.jobMax[kind] = dtj;
      if (done) this.jobs.shift();
      if (performance.now() - t0 > budgetMs) break;
    }
    this.stats.jobsMs = performance.now() - t0;
  }

  private *routeJobIter(key: string): Generator<void, void> {
    const it = routeGen(key);
    let r = it.next();
    while (!r.done) {
      yield;
      r = it.next();
    }
    this.routeJobs.delete(key);
    storeRoute(key, r.value);
    if (r.value) this.register(r.value);
  }

  private routeNow(key: string): void {
    if (this.routes.has(key)) return;
    let r = peekRoute(key);
    if (r === undefined) {
      const it = routeGen(key);
      let s = it.next();
      while (!s.done) s = it.next();
      r = s.value;
      storeRoute(key, r);
    }
    if (r) this.register(r);
  }

  // ───────────────────────────── route registration ─────────────────────────────
  private register(r: EdgeRoute): void {
    if (this.routes.has(r.key)) return;
    const rec: RouteRec = { key: r.key, r, chunks: [], cells: [] };
    const per = Math.max(8, Math.round(CONFIG.highway.chunkLen / r.ds));
    const nChunks = Math.max(1, Math.ceil(r.n / per));
    for (let k = 0; k < nChunks; k++) {
      const i0 = k * per, i1 = Math.min(r.n, (k + 1) * per);
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let i = i0; i <= i1; i++) {
        minX = Math.min(minX, r.x[i]);
        maxX = Math.max(maxX, r.x[i]);
        minZ = Math.min(minZ, r.z[i]);
        maxZ = Math.max(maxZ, r.z[i]);
      }
      const pad = 60;
      const mi = (i0 + i1) >> 1;
      rec.chunks.push({
        key: `${r.key}#${k}`, rec, k, i0, i1, minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad,
        state: 'idle', meshes: [], cols: null, body: null, physQueued: false, ambient: [], ambientSpecs: [],
        anchor: [Math.round(r.x[mi] / 256) * 256, Math.round(r.y[mi]), Math.round(r.z[mi] / 256) * 256],
      });
    }
    // spatial hash
    const reach = CONFIG.highway.laneW * r.lanes + 60;
    const ranges = new Map<number, [number, number]>();
    for (let i = 0; i <= r.n; i++) {
      const cx0 = Math.floor((r.x[i] - reach) / CELL), cx1 = Math.floor((r.x[i] + reach) / CELL);
      const cz0 = Math.floor((r.z[i] - reach) / CELL), cz1 = Math.floor((r.z[i] + reach) / CELL);
      for (let cx = cx0; cx <= cx1; cx++)
        for (let cz = cz0; cz <= cz1; cz++) {
          const k = cellKey(cx, cz);
          const rg = ranges.get(k);
          if (rg) {
            rg[0] = Math.min(rg[0], i);
            rg[1] = Math.max(rg[1], i);
          } else ranges.set(k, [i, i]);
        }
    }
    for (const [k, [i0, i1]] of ranges) {
      let arr = this.grid.get(k);
      if (!arr) this.grid.set(k, (arr = []));
      arr.push({ rec, i0: Math.max(0, i0 - 1), i1: Math.min(r.n, i1 + 1) });
      rec.cells.push(k);
    }
    this.routes.set(r.key, rec);
    this.stats.routes = this.routes.size;
    this.addToGraph(r);
    this.addPois(r);
  }

  private unregister(rec: RouteRec): void {
    for (const c of rec.chunks) this.unloadChunk(c);
    for (const k of rec.cells) {
      const arr = this.grid.get(k);
      if (!arr) continue;
      const j = arr.findIndex((g) => g.rec === rec);
      if (j >= 0) arr.splice(j, 1);
      if (arr.length === 0) this.grid.delete(k);
    }
    this.routes.delete(rec.key);
    this.stats.routes = this.routes.size;
  }

  // ───────────────────────────── chunk build ─────────────────────────────
  private *chunkJobIter(c: ChunkRec): Generator<void, void> {
    if (c.state !== 'queued') return;
    const b = new ChunkBuilder(c.rec.r, c.i0, c.i1, c.anchor, this.mats.atlas);
    const gen = b.buildGen();
    let st = gen.next();
    while (!st.done) {
      yield;
      if (c.state !== 'queued') return;
      st = gen.next();
    }
    const out = st.value;
    yield;
    if (c.state !== 'queued') return; // unloaded meanwhile
    const o = this.ctx.origin.offset;
    const add = (gb: GeoBuf, mat: THREE.Material, shadow: boolean) => {
      const geo = gb.toGeometry();
      if (!geo) return;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(c.anchor[0] - o.x, c.anchor[1], c.anchor[2] - o.z);
      m.castShadow = shadow;
      m.receiveShadow = mat === this.mats.road;
      m.matrixAutoUpdate = true;
      m.name = 'hw:' + c.key;
      this.ctx.engine.scene.add(m);
      c.meshes.push(m);
    };
    add(out.main, this.mats.road, true);
    add(out.lamp, this.mats.lamp, false);
    add(out.tun, this.mats.tunnel, false);
    add(out.sign, this.mats.sign, false);
    add(out.flash, this.mats.flash, false);
    c.cols = out.cols;
    c.ambientSpecs = out.ambient;
    c.state = 'built';
    this.stats.chunks++;
    this.stats.built++;
    for (const a of out.ambient) {
      const id = this.ctx.npcs?.addAmbientSpot?.({
        position: new THREE.Vector3(a.x - o.x, a.y, a.z - o.z),
        radius: a.radius,
        count: a.count,
        benches: a.benches.map((b) => ({ p: new THREE.Vector3(b.x - o.x, b.y, b.z - o.z), yaw: b.yaw })),
      });
      if (typeof id === 'number') c.ambient.push(id);
    }
    this.farSig = ''; // far ribbon gets a hole here on its next rebuild
  }

  private *physJobIter(c: ChunkRec): Generator<void, void> {
    c.physQueued = false;
    if (c.state !== 'built' || c.body || !c.cols) return;
    const { physics } = this.ctx;
    const o = this.ctx.origin.offset;
    const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(c.anchor[0] - o.x, c.anchor[1], c.anchor[2] - o.z));
    const ax = c.anchor[0], ay = c.anchor[1], az = c.anchor[2];
    const grp = groups(G.WORLD);
    const q = new THREE.Quaternion();
    const e = new THREE.Euler(0, 0, 0, 'YXZ');
    let n = 0;
    for (const s of c.cols) {
      let desc: RAPIER.ColliderDesc | null = null;
      if (s.type === 'trimesh') {
        const v = new Float32Array(s.verts.length);
        for (let k = 0; k < s.verts.length; k += 3) {
          v[k] = s.verts[k] - ax;
          v[k + 1] = s.verts[k + 1] - ay;
          v[k + 2] = s.verts[k + 2] - az;
        }
        desc = RAPIER.ColliderDesc.trimesh(v, new Uint32Array(s.idx), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
      } else if (s.type === 'cuboid') {
        e.set(-Math.atan(s.pitch), Math.atan2(s.fx, s.fz), 0, 'YXZ');
        q.setFromEuler(e);
        desc = RAPIER.ColliderDesc.cuboid(s.h[0], s.h[1], s.h[2]).setTranslation(s.c[0] - ax, s.c[1] - ay, s.c[2] - az).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      } else {
        const v = new Float32Array(s.pts.length);
        for (let k = 0; k < s.pts.length; k += 3) {
          v[k] = s.pts[k] - ax;
          v[k + 1] = s.pts[k + 1] - ay;
          v[k + 2] = s.pts[k + 2] - az;
        }
        desc = RAPIER.ColliderDesc.convexHull(v);
      }
      if (!desc) continue;
      desc.setCollisionGroups(grp).setFriction(s.tag.kind === 'road' ? 1.0 : 0.45);
      const col = physics.world.createCollider(desc, body);
      physics.tag(col, { kind: s.tag.kind, material: s.tag.material, data: { highway: c.rec.key } });
      if (++n % 60 === 0) yield;
      if (c.state !== 'built') break;
    }
    if (c.state !== 'built') {
      physics.removeBody(body);
      return;
    }
    c.body = body;
    this.stats.bodies++;
  }

  private removeBody(c: ChunkRec): void {
    if (!c.body) return;
    this.ctx.physics.removeBody(c.body);
    c.body = null;
    this.stats.bodies--;
  }

  private unloadChunk(c: ChunkRec): void {
    this.removeBody(c);
    for (const m of c.meshes) {
      m.geometry.dispose();
      m.removeFromParent();
    }
    if (c.state === 'built') this.stats.chunks--;
    c.meshes = [];
    c.cols = null;
    for (const id of c.ambient) this.ctx.npcs?.removeAmbientSpot?.(id);
    c.ambient = [];
    c.state = 'idle';
    c.physQueued = false;
  }

  // ───────────────────────────── far LOD ribbon ─────────────────────────────
  private *farJobIter(farR: number): Generator<void, void> {
    const o0 = this.ctx.origin.offset;
    const ax = Math.round(this.focusAbs.x / 512) * 512, az = Math.round(this.focusAbs.z / 512) * 512;
    const gb = new GeoBuf(ax, 0, az);
    const cA = rgb(0x50535c), cM = rgb(0xc9c4ba), cB = rgb(0xd8d0c0);
    const P = new Array(12).fill(0);
    let count = 0;
    const mh = CONFIG.highway.medianHalf;
    for (const rec of this.routes.values()) {
      const r = rec.r;
      if (this.boxDist(r.minX, r.minZ, r.maxX, r.maxZ) > farR) continue;
      const hw = laneStart() + r.lanes * CONFIG.highway.laneW + CONFIG.highway.outerShoulder;
      for (const c of rec.chunks) {
        if (c.state === 'built') continue;
        const step = 4;
        for (let i = c.i0; i < c.i1; i += step) {
          const j = Math.min(c.i1, i + step);
          if (r.kind[i] === K_TUNNEL && r.kind[j] === K_TUNNEL) continue;
          const pt = (k: number, l: number, h: number, o: number) => {
            P[o] = r.x[k] - r.tz[k] * l;
            P[o + 1] = r.y[k] - r.bank[k] * l + h;
            P[o + 2] = r.z[k] + r.tx[k] * l;
          };
          const strips: [number, number, number, number[]][] = [[-hw, -mh, 0, cA], [-mh, mh, 0.05, cM], [mh, hw, 0, cA]];
          for (const [l0, l1, h, col] of strips) {
            pt(i, l0, h, 0);
            pt(i, l1, h, 3);
            pt(j, l1, h, 6);
            pt(j, l0, h, 9);
            gb.quad(P, col);
          }
          if (r.kind[i] === 1 && r.kind[j] === 1) {
            // bridge deck sides so viaducts read from the air
            for (const side of [-1, 1]) {
              const l = side * (hw + 0.5);
              if (side > 0) {
                pt(i, l, -2.2, 0);
                pt(j, l, -2.2, 3);
                pt(j, l, 1, 6);
                pt(i, l, 1, 9);
              } else {
                pt(j, l, -2.2, 0);
                pt(i, l, -2.2, 3);
                pt(i, l, 1, 6);
                pt(j, l, 1, 9);
              }
              gb.quad(P, cB);
            }
          }
          if (++count % 400 === 0) yield;
        }
      }
    }
    yield;
    const geo = gb.toGeometry();
    if (this.farMesh) {
      this.farMesh.geometry.dispose();
      this.farMesh.removeFromParent();
      this.farMesh = null;
    }
    if (geo) {
      const o = this.ctx.origin.offset;
      const m = new THREE.Mesh(geo, this.mats.far);
      m.position.set(ax - o.x, 0, az - o.z);
      m.receiveShadow = false;
      m.castShadow = false;
      m.name = 'hw:far';
      this.ctx.engine.scene.add(m);
      this.farMesh = m;
    }
    void o0;
    this.farJob = null;
  }

  // ───────────────────────────── queries ─────────────────────────────
  /** Nearest route samples around absolute (ax, az): returns hits sorted by |l|. */
  private hitsAt(ax: number, az: number, out: Hit[]): Hit[] {
    out.length = 0;
    const arr = this.grid.get(cellKey(Math.floor(ax / CELL), Math.floor(az / CELL)));
    if (!arr) return out;
    for (const g of arr) {
      const r = g.rec.r;
      let best = Infinity, bi = -1, bu = 0;
      for (let i = g.i0; i < g.i1; i++) {
        const x0 = r.x[i], z0 = r.z[i], dx = r.x[i + 1] - x0, dz = r.z[i + 1] - z0;
        const l2 = dx * dx + dz * dz || 1;
        const u = Math.max(0, Math.min(1, ((ax - x0) * dx + (az - z0) * dz) / l2));
        const ex = x0 + dx * u - ax, ez = z0 + dz * u - az;
        const d2 = ex * ex + ez * ez;
        if (d2 < best) {
          best = d2;
          bi = i;
          bu = u;
        }
      }
      if (bi < 0) continue;
      const tx = r.tx[bi] + (r.tx[bi + 1] - r.tx[bi]) * bu, tz = r.tz[bi] + (r.tz[bi + 1] - r.tz[bi]) * bu;
      const px = r.x[bi] + (r.x[bi + 1] - r.x[bi]) * bu, pz = r.z[bi] + (r.z[bi + 1] - r.z[bi]) * bu;
      const tl = Math.hypot(tx, tz) || 1;
      const l = ((ax - px) * -tz + (az - pz) * tx) / tl;
      out.push({ rec: g.rec, s: (bi + bu) * r.ds, l, d: Math.sqrt(best), i: bi });
    }
    return out;
  }

  private surfaceY(r: EdgeRoute, s: number, l: number): number {
    const f = Math.max(0, Math.min(r.n, s / r.ds));
    const i = Math.min(r.n - 1, Math.floor(f));
    const u = f - i;
    return r.y[i] + (r.y[i + 1] - r.y[i]) * u - (r.bank[i] + (r.bank[i + 1] - r.bank[i]) * u) * l;
  }

  private halfAt(r: EdgeRoute, s: number): number {
    return laneStart() + lanesAt(r, s) * CONFIG.highway.laneW + CONFIG.highway.outerShoulder;
  }

  private hitBuf: Hit[] = [];

  roadHeightAt(x: number, z: number, nearY?: number): number | null {
    const o = this.ctx.origin.offset;
    const ax = x + o.x, az = z + o.z;
    let best: number | null = null;
    let bestD = Infinity;
    const consider = (y: number) => {
      const d = nearY === undefined ? -y : Math.abs(y - nearY);
      if (d < bestD) {
        bestD = d;
        best = y;
      }
    };
    for (const h of this.hitsAt(ax, az, this.hitBuf)) {
      const r = h.rec.r;
      const hw = this.halfAt(r, h.s);
      if (Math.abs(h.l) <= hw + 0.45) {
        consider(this.surfaceY(r, h.s, h.l));
        continue;
      }
      const side = h.l > 0 ? 1 : -1;
      const al = Math.abs(h.l);
      for (const rs of r.features.rest) {
        if (rs.side === side && h.s >= rs.s0 && h.s <= rs.s1 && al <= rs.lOff + rs.w) consider(this.surfaceY(r, h.s, side * hw));
      }
      for (const m of r.features.megas) {
        if (m.side !== side) continue;
        const lo = Math.min(m.sA, m.sEnd), hi = Math.max(m.sA, m.sEnd);
        const gLo = Math.min(m.sLip, m.sLand0), gHi = Math.max(m.sLip, m.sLand0);
        if (h.s >= lo && h.s <= hi && !(h.s > gLo && h.s < gHi) && al <= Math.abs(m.laneL) + m.laneW / 2) consider(this.surfaceY(r, h.s, h.l));
      }
    }
    return best;
  }

  isOnHighway(x: number, z: number): boolean {
    const o = this.ctx.origin.offset;
    for (const h of this.hitsAt(x + o.x, z + o.z, this.hitBuf)) if (Math.abs(h.l) <= this.halfAt(h.rec.r, h.s) + 0.3) return true;
    return false;
  }

  inTunnel(pos: THREE.Vector3): boolean {
    const o = this.ctx.origin.offset;
    for (const h of this.hitsAt(pos.x + o.x, pos.z + o.z, this.hitBuf)) {
      const r = h.rec.r;
      const i = Math.min(r.n, Math.round(h.s / r.ds));
      if (r.kind[i] !== K_TUNNEL && r.kind[i] !== K_GALLERY) continue;
      if (Math.abs(h.l) > this.halfAt(r, h.s) + 1) continue;
      const y = this.surfaceY(r, h.s, h.l);
      if (pos.y > y - 3 && pos.y < y + 9) return true;
    }
    return false;
  }

  restStopAt(x: number, z: number): boolean {
    const o = this.ctx.origin.offset;
    for (const h of this.hitsAt(x + o.x, z + o.z, this.hitBuf)) {
      const side = h.l > 0 ? 1 : -1;
      for (const rs of h.rec.r.features.rest) if (rs.side === side && h.s >= rs.s0 - 10 && h.s <= rs.s1 + 10 && Math.abs(h.l) <= rs.lOff + rs.w + 1) return true;
    }
    return false;
  }

  findRespawn(pos: THREE.Vector3, yaw: number, maxDist: number): Pose | null {
    const o = this.ctx.origin.offset;
    const ax = pos.x + o.x, az = pos.z + o.z;
    const R = Math.min(maxDist, 700);
    const c0x = Math.floor((ax - R) / CELL), c1x = Math.floor((ax + R) / CELL);
    const c0z = Math.floor((az - R) / CELL), c1z = Math.floor((az + R) / CELL);
    let best: { r: EdgeRoute; i: number; d: number } | null = null;
    const seen = new Set<GridItem>();
    for (let cx = c0x; cx <= c1x; cx++)
      for (let cz = c0z; cz <= c1z; cz++) {
        const arr = this.grid.get(cellKey(cx, cz));
        if (!arr) continue;
        for (const g of arr) {
          if (seen.has(g)) continue;
          seen.add(g);
          const r = g.rec.r;
          for (let i = g.i0; i <= g.i1; i++) {
            const d = Math.hypot(r.x[i] - ax, r.z[i] - az);
            if (d < R && (!best || d < best.d)) best = { r, i, d };
          }
        }
      }
    if (!best) return null;
    const r = best.r;
    let s = best.i * r.ds;
    const lo = Math.min(r.L / 2, r.forkA + 40), hi = Math.max(r.L / 2, r.L - r.forkB - 40);
    s = Math.max(lo, Math.min(hi, s));
    const i = Math.max(0, Math.min(r.n, Math.round(s / r.ds)));
    const fYaw = Math.atan2(r.tx[i], r.tz[i]);
    const dA = Math.abs(Math.atan2(Math.sin(yaw - fYaw), Math.cos(yaw - fYaw)));
    const side = dA <= Math.PI / 2 ? 1 : -1;
    const lanes = lanesAt(r, s);
    let laneIdx = lanes - 0.5; // right (outer) lane
    for (const k of r.features.kickers) if (k.side === side && Math.abs(k.s - s) < 320) laneIdx = Math.max(0.5, lanes - 1.5);
    const l = side * (laneStart() + laneIdx * CONFIG.highway.laneW);
    const px = r.x[i] - r.tz[i] * l, pz = r.z[i] + r.tx[i] * l;
    const y = this.surfaceY(r, s, l);
    return { position: { x: px - o.x, y: y + 0.05, z: pz - o.z }, yaw: side > 0 ? fYaw : fYaw + Math.PI };
  }

  // ───────────────────────────── graph (LOCAL) ─────────────────────────────
  private cityExit(tag: string): Vec3 | null {
    const data = this.ctx.world?.data;
    const ex = data?.exits?.find((e) => e.tag === tag);
    if (!data || !ex) return null;
    const n = data.roads.nodes[ex.node];
    return n ? n.p : null;
  }

  private graphNode(n: MNode): RoadNode {
    let node = this.graphNodeByKey.get(n.key);
    if (node) return node;
    const o = this.ctx.origin.offset;
    const y = n.fixedY ?? 0;
    let p: Vec3 = { x: n.x - o.x, y: y, z: n.z - o.z };
    if (n.kind === 'exit' && n.exitTag) {
      const cp = this.cityExit(n.exitTag);
      if (cp) {
        const d = Math.hypot(cp.x - p.x, cp.z - p.z);
        if (d < 8) p = { x: cp.x, y: cp.y, z: cp.z };
        else if (!this.exitWarned && this.ctx.debug) {
          this.exitWarned = true;
          console.warn(`[highways] city exit '${n.exitTag}' is ${d.toFixed(1)} m from the highway attach point`);
        }
      }
    }
    node = { id: this.graph.nodes.length, p, kind: 'end', trafficLight: false, edges: [] };
    this.graph.nodes.push(node);
    this.graphNodeByKey.set(n.key, node);
    return node;
  }

  private addToGraph(r: EdgeRoute): void {
    if (this.graphEdgeKeys.has(r.key)) return;
    this.graphEdgeKeys.add(r.key);
    const A = this.graphNode(r.desc.a), B = this.graphNode(r.desc.b);
    const o = this.ctx.origin.offset;
    const pts: Vec3[] = [{ x: A.p.x, y: A.p.y, z: A.p.z }];
    for (let i = 5; i < r.n - 2; i += 5) pts.push({ x: r.x[i] - o.x, y: r.y[i], z: r.z[i] - o.z });
    pts.push({ x: B.p.x, y: B.p.y, z: B.p.z });
    if (r.desc.a.kind !== 'exit') A.p.y = r.y[0];
    if (r.desc.b.kind !== 'exit') B.p.y = r.y[r.n];
    const link = r.desc.ref.cls === 'link';
    const e: RoadEdge = {
      id: this.graph.edges.length, a: A.id, b: B.id, kind: link ? 'ramp' : 'highway', lanes: r.lanes * 2,
      width: 2 * this.halfAt(r, r.L / 2), sidewalk: 0, points: pts, oneWay: false, speedLimitKmh: link ? 80 : 130,
    };
    this.graph.edges.push(e);
    A.edges.push(e.id);
    B.edges.push(e.id);
    for (const n of [A, B]) n.kind = n.edges.length >= 3 ? 'intersection' : n.edges.length === 2 ? 'junction' : 'end';
    this.graphVersion++;
  }

  // ───────────────────────────── POIs ─────────────────────────────
  private addPoi(id: string, name: string, icon: string, r: EdgeRoute, s: number, l: number, travel: number): void {
    if (this.poiIds.has(id)) return;
    this.poiIds.add(id);
    const o = this.ctx.origin.offset;
    const i = Math.max(0, Math.min(r.n, Math.round(s / r.ds)));
    const x = r.x[i] - r.tz[i] * l, z = r.z[i] + r.tx[i] * l;
    const yaw = Math.atan2(r.tx[i], r.tz[i]) + (travel > 0 ? 0 : Math.PI);
    this.pois.push({ id, name, icon, pose: { position: { x: x - o.x, y: this.surfaceY(r, s, l) + 0.05, z: z - o.z }, yaw } });
  }

  private addPois(r: EdgeRoute): void {
    const lane = (side: number) => side * (laneStart() + 1.5 * CONFIG.highway.laneW);
    if (r.desc.b.key === 'bCB') this.addPoi('hw-coastal-bridge', 'Coastal Bridge', '🌉', r, r.L - 30, lane(1), 1);
    for (const m of r.features.megas) this.addPoi(`hw-jump-${r.key}`, 'Mega Jump', '🚀', r, m.sA + m.side * 10, m.laneL, m.side);
    for (const rs of r.features.rest) {
      this.addPoi(`hw-rest-${r.key}`, `Rest Stop ${rs.name}`, '⛽', r, (rs.s0 + rs.s1) / 2, rs.side * (rs.lOff + 7), rs.side);
    }
    // Mountain Pass: highest point of the mountain highway's first two edges (deterministic once both exist)
    const a = this.routes.get('0,1>0,2')?.r, b = this.routes.get('0,2>0,3')?.r;
    if (a && b && !this.poiIds.has('hw-mountain-pass')) {
      let best = { r: a, i: 0, y: -Infinity };
      for (const rr of [a, b]) for (let i = 0; i <= rr.n; i++) if (rr.y[i] > best.y && rr.kind[i] !== K_TUNNEL) best = { r: rr, i, y: rr.y[i] };
      this.addPoi('hw-mountain-pass', 'Mountain Pass', '⛰️', best.r, best.i * best.r.ds, lane(1), 1);
    }
  }

  /** The mega jump nearest the city (among the fixed init set) becomes the 'Big Jump' POI (deterministic). */
  private pickBigJump(): void {
    let best: { id: string; d: number } | null = null;
    for (const rec of this.routes.values()) {
      const r = rec.r;
      for (const m of r.features.megas) {
        const i = Math.max(0, Math.min(r.n, Math.round(m.sA / r.ds)));
        const d = Math.hypot(r.x[i], r.z[i]);
        if (!best || d < best.d) best = { id: `hw-jump-${r.key}`, d };
      }
    }
    const id = best?.id;
    const p = id ? this.pois.find((q) => q.id === id) : undefined;
    if (p) {
      this.poiIds.delete(p.id);
      p.id = 'hw-big-jump';
      p.name = 'Big Jump';
      this.poiIds.add(p.id);
    }
  }

  // ───────────────────────────── floating origin ─────────────────────────────
  private onOriginShift(dx: number, dz: number): void {
    const seen = new Set<Vec3>();
    const sh = (p: Vec3) => {
      if (seen.has(p)) return;
      seen.add(p);
      p.x -= dx;
      p.z -= dz;
    };
    // exit nodes may share the city node's coordinates by value (not by reference) — shift ours independently
    for (const n of this.graph.nodes) sh(n.p);
    for (const e of this.graph.edges) for (const p of e.points) sh(p);
    for (const p of this.pois) sh(p.pose.position);
    this.traffic?.shift(dx, dz);
    void EXITS;
    // meshes (top-level) and bodies are shifted by core; absolute caches need nothing
  }

  /** Debug stats (also used by smoke scripts). */
  debugStats(): Record<string, number> {
    let tris = 0;
    let meshes = 0;
    for (const rec of this.routes.values())
      for (const c of rec.chunks)
        for (const m of c.meshes) {
          meshes++;
          tris += (m.geometry.getAttribute('position')?.count ?? 0) / 3;
        }
    if (this.farMesh) tris += (this.farMesh.geometry.getAttribute('position')?.count ?? 0) / 3;
    for (const [k, v] of Object.entries(this.jobMax)) (this.stats as Record<string, number>)['max_' + k] = Math.round(v * 10) / 10;
    return { ...this.stats, traffic: this.traffic?.activeCount ?? 0, meshes, tris: Math.round(tris), jobs: this.jobs.length, gridCells: this.grid.size, graphNodes: this.graph.nodes.length, graphEdges: this.graph.edges.length, pois: this.pois.length };
  }

  /** Debug: route/sample info for smoke scripts (absolute coords). */
  debugRoute(key: string): { L: number; n: number; ds: number; x: number[]; y: number[]; z: number[]; tx: number[]; tz: number[]; spans: unknown; features: unknown } | null {
    const rec = this.routes.get(key);
    if (!rec) return null;
    const r = rec.r;
    return { L: r.L, n: r.n, ds: r.ds, x: Array.from(r.x), y: Array.from(r.y), z: Array.from(r.z), tx: Array.from(r.tx), tz: Array.from(r.tz), spans: r.spans, features: r.features };
  }

  /** Debug / test scripts: refresh around the current focus and run streaming jobs synchronously for up to ms. */
  debugFlush(ms = 2000, x?: number, z?: number): number {
    const t0 = performance.now();
    if (x !== undefined && z !== undefined) this.setFocus(this.tmpV.set(x, this.focusAbs.y, z));
    this.refresh(true);
    while (this.jobs.length && performance.now() - t0 < ms) {
      this.runJobs(40);
      if (this.jobs.length === 0) this.refresh(true);
    }
    return this.jobs.length;
  }

  debugRouteKeys(): string[] {
    return [...this.routes.keys()];
  }
}

