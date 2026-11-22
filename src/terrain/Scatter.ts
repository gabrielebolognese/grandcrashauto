import * as THREE from 'three';
import { CONFIG } from '../config';
import type { GameContext } from '../game/contracts';
import { ST, ST_COL, ST_COUNT, ST_IS_STRUCTURE, ST_MAT, type ScatterData } from './gen/scatterTypes';
import * as M from './scatterModels';
import type { WorkerPool } from './WorkerPool';

/**
 * Scatter renderer. Trees: 3 LODs (full ≤ lod0, low ≤ lod1, far impostors at half density with bigger instances) as
 * InstancedMeshes rebuilt per distance band; bushes / rocks / fences / turbine rotors as InstancedMeshes; houses,
 * barns, cabins, turbines, pylons, cables, palms, boulders and hay in ONE BatchedMesh (per-instance culling).
 * Everything is created at init (warm-up compiles all variants); instance buffers are preallocated and reused.
 */

const CH = 128;
const ck = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

interface SChunk {
  cx: number;
  cz: number;
  data: ScatterData | null;
  band: number; // 0 near, 1 mid, 2 far, 3 out of tree range
  dist: number;
  mask: number; // bucket membership bits
  structIds: number[] | null;
  lastWanted: number;
  lastUsed: number;
}

interface Bucket {
  mesh: THREE.InstancedMesh;
  cap: number;
  dirty: boolean;
  /** which chunks + instances belong: decided by `member(chunk)` */
  type: number;
  band: number; // tree band (0..2) or -1
  scale: number;
  density: number; // fraction of rank kept (× treeDensity for trees)
}

// bucket bits: 0-2 pine bands, 3-5 round bands, 6 bush, 7 rock, 8 fence, 9 rotor
const BIT = (i: number) => 1 << i;

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

export class ScatterRenderer {
  readonly group = new THREE.Group();
  private chunks = new Map<number, SChunk>();
  private buckets: Bucket[] = [];
  private structures: THREE.BatchedMesh;
  private structGeom = new Map<number, number>();
  private frame = 0;
  private lastEvalX = 1e18;
  private lastEvalZ = 1e18;
  private lastEvalY = 1e18;
  private density = 1;
  private shadows = true;
  stats = { chunks: 0, instances: 0, structures: 0, rebuilds: 0, tris: 0 };
  private triCounts: number[] = [];

  constructor(
    private ctx: GameContext,
    private pool: WorkerPool,
    mats: { foliage: THREE.Material; rock: THREE.Material; solid: THREE.Material; rotor: THREE.Material },
  ) {
    this.group.name = 'terrain.scatter';
    this.group.userData.noOriginShift = true; // we shift / rebuild our instances ourselves
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, type: number, band: number, scale = 1, density = 1, name = '') => {
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.name = 'terrain.' + name;
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      mesh.receiveShadow = band <= 0;
      mesh.castShadow = false;
      this.group.add(mesh);
      this.buckets.push({ mesh, cap, dirty: true, type, band, scale, density });
      this.triCounts.push(geo.getAttribute('position').count / 3);
    };
    // order matters: bucket index = bit
    mk(M.pineGeometry(0), mats.foliage, 3000, ST.pine, 0, 1, 1, 'pine0');
    mk(M.pineGeometry(1), mats.foliage, 9000, ST.pine, 1, 1, 1, 'pine1');
    mk(M.pineGeometry(2), mats.foliage, 14000, ST.pine, 2, 1.28, 0.5, 'pine2');
    mk(M.roundTreeGeometry(0), mats.foliage, 3000, ST.round, 0, 1, 1, 'round0');
    mk(M.roundTreeGeometry(1), mats.foliage, 9000, ST.round, 1, 1, 1, 'round1');
    mk(M.roundTreeGeometry(2), mats.foliage, 14000, ST.round, 2, 1.28, 0.5, 'round2');
    mk(M.bushGeometry(), mats.foliage, 6000, ST.bush, -1, 1, 1, 'bush');
    mk(M.rockGeometry(false), mats.rock, 6000, ST.rock, -1, 1, 1, 'rock');
    mk(M.fenceGeometry(), mats.solid, 5000, ST.fence, -1, 1, 1, 'fence');
    mk(M.rotorGeometry(), mats.rotor, 400, ST.rotor, -1, 1, 1, 'rotor');

    // structures
    const geos: [number, THREE.BufferGeometry][] = [
      [ST.farmhouse, M.farmhouseGeometry()],
      [ST.barn, M.barnGeometry()],
      [ST.house, M.houseGeometry()],
      [ST.cabin, M.cabinGeometry()],
      [ST.turbine, M.turbineGeometry()],
      [ST.pylon, M.pylonGeometry()],
      [ST.cable, M.cableGeometry()],
      [ST.palm, M.palmGeometry()],
      [ST.boulder, M.rockGeometry(true)],
      [ST.hay, M.hayGeometry()],
    ];
    let vc = 0;
    for (const [, g] of geos) vc += g.getAttribute('position').count;
    this.structures = new THREE.BatchedMesh(5000, vc, 0, mats.solid);
    this.structures.name = 'terrain.structures';
    this.structures.sortObjects = false;
    this.structures.castShadow = true;
    this.structures.receiveShadow = true;
    this.structures.userData.noOriginShift = true;
    for (const [t, g] of geos) {
      this.structGeom.set(t, this.structures.addGeometry(g));
      g.dispose();
    }
    // a hidden instance so the colour texture + program exist from the start (warm-up)
    const hid = this.structures.addInstance(this.structGeom.get(ST.hay)!);
    this.structures.setColorAt(hid, _c.set(1, 1, 1));
    this.structures.setMatrixAt(hid, _m.makeTranslation(0, -1e4, 0));
    this.structures.setVisibleAt(hid, false);
    this.group.add(this.structures);
    this.applyQuality();
  }

  applyQuality(): void {
    const q = this.ctx.quality.current as typeof this.ctx.quality.current & { treeDensity?: number };
    const d = q.treeDensity ?? 0.75;
    const sh = q.shadows && CONFIG.terrain.scatter.castShadows;
    if (d !== this.density || sh !== this.shadows) {
      this.density = d;
      this.shadows = sh;
      for (const b of this.buckets) b.dirty = true;
    }
    this.buckets[0].mesh.castShadow = sh;
    this.buckets[3].mesh.castShadow = sh;
    this.structures.castShadow = sh;
  }

  private radius(): number {
    const lvl = this.ctx.quality.level;
    const R = CONFIG.terrain.scatter.radius;
    return lvl === 'low' ? R.low : lvl === 'high' ? R.high : R.medium;
  }

  /** cam* ABSOLUTE; groundY = ground under the camera. */
  update(camX: number, camY: number, camZ: number, groundY: number, offX: number, offZ: number, deadline: number): void {
    this.frame++;
    const S = CONFIG.terrain.scatter;
    const R = this.radius();
    const dy = Math.max(0, camY - groundY - 30);
    // request scatter chunks (every frame — the pool drops what's no longer wanted)
    const reqR = R + 96;
    const c0 = Math.floor((camX - reqR) / CH);
    const c1 = Math.floor((camX + reqR) / CH);
    const r0 = Math.floor((camZ - reqR) / CH);
    const r1 = Math.floor((camZ + reqR) / CH);
    const structR = Math.max(S.structureRadius, reqR);
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const dx = cx * CH + CH / 2 - camX;
        const dz = cz * CH + CH / 2 - camZ;
        const d2 = Math.sqrt(dx * dx + dz * dz);
        if (d2 > reqR && d2 > structR) continue;
        let c = this.chunks.get(ck(cx, cz));
        if (!c) {
          c = { cx, cz, data: null, band: 3, dist: 1e9, mask: 0, structIds: null, lastWanted: 0, lastUsed: 0 };
          this.chunks.set(ck(cx, cz), c);
        }
        c.lastWanted = this.frame;
        if (!c.data) this.pool.want(`s${cx}:${cz}`, 400 + d2 * 1.15 + dy, () => ({ type: 'scatter', cx, cz }));
      }
    }
    // re-evaluate bands when the camera moved enough
    const moved = Math.hypot(camX - this.lastEvalX, camZ - this.lastEvalZ) > 10 || Math.abs(camY - this.lastEvalY) > 15;
    if (moved) {
      this.lastEvalX = camX;
      this.lastEvalZ = camZ;
      this.lastEvalY = camY;
      for (const c of this.chunks.values()) this.evalChunk(c, camX, camZ, dy, R, offX, offZ);
    }
    // rebuild dirty buckets within the budget (at least one per frame)
    let did = 0;
    for (const b of this.buckets) {
      if (!b.dirty) continue;
      if (did > 0 && performance.now() > deadline) break;
      this.rebuild(b, offX, offZ);
      did++;
    }
    // forget far chunks (LRU)
    if (this.chunks.size > CONFIG.terrain.cacheScatter) {
      const list = [...this.chunks.values()].filter((c) => c.lastWanted !== this.frame && !c.structIds);
      list.sort((a, b) => a.lastUsed - b.lastUsed);
      const n = this.chunks.size - CONFIG.terrain.cacheScatter;
      for (let i = 0; i < n && i < list.length; i++) {
        const c = list[i];
        if (c.mask) for (let k = 0; k < this.buckets.length; k++) if (c.mask & BIT(k)) this.buckets[k].dirty = true;
        this.chunks.delete(ck(c.cx, c.cz));
      }
    }
    let inst = 0;
    let tris = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      inst += this.buckets[i].mesh.count;
      tris += this.buckets[i].mesh.count * this.triCounts[i];
    }
    this.stats.instances = inst;
    this.stats.tris = tris;
    this.stats.chunks = this.chunks.size;
  }

  onScatter(data: ScatterData): void {
    const c = this.chunks.get(ck(data.cx, data.cz));
    if (!c) return;
    c.data = data;
    c.mask = 0;
    c.band = 3;
    this.lastEvalX = 1e18; // force re-evaluation (cheap)
  }

  private evalChunk(c: SChunk, camX: number, camZ: number, dy: number, R: number, offX: number, offZ: number): void {
    const S = CONFIG.terrain.scatter;
    const dx = c.cx * CH + CH / 2 - camX;
    const dz = c.cz * CH + CH / 2 - camZ;
    const d2 = Math.sqrt(dx * dx + dz * dz);
    const d = Math.sqrt(d2 * d2 + dy * dy);
    c.dist = d;
    if (!c.data) return;
    c.lastUsed = this.frame;
    const band = d < S.lod0 ? 0 : d < S.lod1 ? 1 : d < R ? 2 : 3;
    let mask = 0;
    if (band < 3) {
      mask |= BIT(band) | BIT(3 + band);
    }
    if (d < S.bushRadius) mask |= BIT(6);
    if (d < S.lod1 + 60) mask |= BIT(7);
    if (d < S.fenceRadius) mask |= BIT(8);
    const inStruct = d2 < S.structureRadius;
    if (inStruct) mask |= BIT(9);
    // only mark buckets whose membership changed (and that this chunk actually has instances for)
    const changed = mask ^ c.mask;
    if (changed) {
      for (let k = 0; k < this.buckets.length; k++) {
        if (!(changed & BIT(k))) continue;
        if (c.data.counts[this.buckets[k].type] > 0) this.buckets[k].dirty = true;
      }
    }
    c.mask = mask;
    c.band = band;
    // structures enter / leave
    if (inStruct && !c.structIds) this.addStructures(c, offX, offZ);
    else if (!inStruct && c.structIds) this.removeStructures(c);
  }

  private rebuild(b: Bucket, offX: number, offZ: number): void {
    b.dirty = false;
    const bit = BIT(this.buckets.indexOf(b));
    const mesh = b.mesh;
    const mat = mesh.instanceMatrix.array as Float32Array;
    const col = mesh.instanceColor!.array as Float32Array;
    const isTree = b.type === ST.pine || b.type === ST.round || b.type === ST.bush;
    const keep = isTree ? this.density * b.density : 2;
    const s = b.scale;
    let n = 0;
    for (const c of this.chunks.values()) {
      if (!(c.mask & bit) || !c.data) continue;
      const D = c.data;
      const cnt = D.counts[b.type];
      if (!cnt) continue;
      const off = D.offsets[b.type];
      const tx = c.cx * CH - offX;
      const tz = c.cz * CH - offZ;
      for (let i = 0; i < cnt && n < b.cap; i++) {
        const ii = off + i;
        if (D.cols[ii * ST_COL + 3] >= keep) continue;
        const src = ii * ST_MAT;
        const dst = n * 16;
        for (let k = 0; k < 16; k++) mat[dst + k] = D.mats[src + k];
        if (s !== 1) {
          mat[dst] *= s;
          mat[dst + 1] *= s;
          mat[dst + 2] *= s;
          mat[dst + 4] *= s;
          mat[dst + 5] *= s;
          mat[dst + 6] *= s;
          mat[dst + 8] *= s;
          mat[dst + 9] *= s;
          mat[dst + 10] *= s;
        }
        mat[dst + 12] += tx;
        mat[dst + 14] += tz;
        col[n * 3] = D.cols[ii * ST_COL];
        col[n * 3 + 1] = D.cols[ii * ST_COL + 1];
        col[n * 3 + 2] = D.cols[ii * ST_COL + 2];
        n++;
      }
    }
    mesh.count = n;
    mesh.position.set(0, 0, 0);
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceMatrix.addUpdateRange(0, Math.max(1, n) * 16);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.clearUpdateRanges();
    mesh.instanceColor!.addUpdateRange(0, Math.max(1, n) * 3);
    mesh.instanceColor!.needsUpdate = true;
    this.stats.rebuilds++;
  }

  private addStructures(c: SChunk, offX: number, offZ: number): void {
    const D = c.data!;
    const ids: number[] = [];
    const tx = c.cx * CH - offX;
    const tz = c.cz * CH - offZ;
    for (let t = 0; t < ST_COUNT; t++) {
      if (!ST_IS_STRUCTURE[t] || !D.counts[t]) continue;
      const g = this.structGeom.get(t);
      if (g === undefined) continue;
      for (let i = 0; i < D.counts[t]; i++) {
        const ii = D.offsets[t] + i;
        let id: number;
        try {
          id = this.structures.addInstance(g);
        } catch {
          break; // full
        }
        _m.fromArray(D.mats, ii * ST_MAT);
        _m.elements[12] += tx;
        _m.elements[14] += tz;
        this.structures.setMatrixAt(id, _m);
        this.structures.setColorAt(id, _c.setRGB(D.cols[ii * ST_COL], D.cols[ii * ST_COL + 1], D.cols[ii * ST_COL + 2]));
        ids.push(id);
      }
    }
    c.structIds = ids;
    this.stats.structures += ids.length;
  }

  private removeStructures(c: SChunk): void {
    for (const id of c.structIds!) this.structures.deleteInstance(id);
    this.stats.structures -= c.structIds!.length;
    c.structIds = null;
  }

  onOriginShift(dx: number, dz: number): void {
    // structures: rebase instance matrices; instanced buckets: core shifted their position, rebuilt lazily
    for (const c of this.chunks.values()) {
      if (!c.structIds) continue;
      for (const id of c.structIds) {
        this.structures.getMatrixAt(id, _m);
        _m.elements[12] -= dx;
        _m.elements[14] -= dz;
        this.structures.setMatrixAt(id, _m);
      }
    }
    for (const b of this.buckets) {
      b.mesh.position.x -= dx;
      b.mesh.position.z -= dz;
      b.dirty = true;
    }
  }

  dispose(): void {
    for (const b of this.buckets) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.structures.dispose();
  }
}

