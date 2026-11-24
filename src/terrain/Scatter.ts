import * as THREE from 'three';
import { CONFIG } from '../config';
import type { GameContext } from '../game/contracts';
import { ST, ST_COL, ST_COUNT, ST_IS_STRUCTURE, ST_MAT, type ScatterData } from './gen/scatterTypes';
import * as M from './scatterModels';
import { KEY_SCATTER, type WorkerPool } from './WorkerPool';

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
  lastBuilt: number;
}

// bucket bits: 0-2 pine bands, 3-5 round bands, 6 bush, 7 rock, 8 fence, 9 rotor
const BIT = (i: number) => 1 << i;

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _c = new THREE.Color();
const _qi = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ax = new THREE.Vector3();
const _q = new THREE.Quaternion();
const TREE_H = [9, 7.5]; // pine, round: model height at scale 1

/** A tree knocked over by a plane (user request): falls about its base, then lies there. */
interface Fallen {
  type: 0 | 1; // 0 pine, 1 round
  x: number; // base, LOCAL coords
  y: number;
  z: number;
  basis: THREE.Matrix4; // yaw + scale of the standing tree (no translation)
  axis: THREE.Vector3; // horizontal axis it rotates about
  ang: number;
  vel: number;
  len: number;
  rest: boolean;
}

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
  private structQueue: SChunk[] = [];
  private fresh: SChunk[] = [];
  /** warm-up: no per-frame limits */
  unlimited = false;
  private shadows = true;
  stats = { chunks: 0, instances: 0, structures: 0, rebuilds: 0, tris: 0 };
  private triCounts: number[] = [];
  // trees broken by planes: persistent keys (re-applied when a chunk is regenerated) + the fallen-tree pool
  private broken = new Set<string>();
  private fallenMesh: THREE.InstancedMesh[] = [];
  private fallen: Fallen[][] = [[], []];
  private fallenDirty = false;

  constructor(
    private ctx: GameContext,
    private pool: WorkerPool,
    mats: { foliage: THREE.Material; rock: THREE.Material; solid: THREE.Material; rotor: THREE.Material },
  ) {
    this.group.name = 'terrain.scatter';
    this.group.userData.noOriginShift = true; // we shift / rebuild our instances ourselves
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, type: number, band: number, scale = 1, density = 1, name = '') => {
      if (scale !== 1) geo.scale(scale, scale, scale); // far impostors: bigger, baked into the geometry
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
      this.buckets.push({ mesh, cap, dirty: true, type, band, scale, density, lastBuilt: -100 });
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
    // fallen trees: two small instanced pools (pine, round), LOD0 models, ring buffers
    for (const [i, geo] of [M.pineGeometry(0), M.roundTreeGeometry(0)].entries()) {
      const mesh = new THREE.InstancedMesh(geo, mats.foliage, CONFIG.terrain.scatter.fallenMax);
      mesh.name = i ? 'terrain.fallenRound' : 'terrain.fallenPine';
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.terrain.scatter.fallenMax * 3).fill(1), 3);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.fallenMesh.push(mesh);
    }
    this.applyQuality();
  }

  /**
   * Plane parts vs trees (user request): every drawn pine / round tree whose trunk crosses the oriented box falls over
   * (glancing or slow hits: tops clipped by a wing, a sliding wreck) or is smashed to bits (fast hits low on the
   * trunk). center / vel LOCAL; returns the "tree mass" hit (1 per smashed tree, 0.35 per knocked one) so the caller
   * can take momentum out of the hitting body.
   */
  hitTrees(center: THREE.Vector3, quat: THREE.Quaternion, half: THREE.Vector3, vel: THREE.Vector3, offX: number, offZ: number): number {
    const S = CONFIG.terrain.scatter;
    const r = half.length();
    const ax = center.x + offX;
    const az = center.z + offZ;
    const c0 = Math.floor((ax - r - 6) / CH), c1 = Math.floor((ax + r + 6) / CH);
    const r0 = Math.floor((az - r - 6) / CH), r1 = Math.floor((az + r + 6) / CH);
    _qi.copy(quat).invert();
    const speed = vel.length();
    let mass = 0;
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const c = this.chunks.get(ck(cx, cz));
        const D = c?.data;
        if (!D) continue;
        for (const type of [ST.pine, ST.round] as const) {
          const cnt = D.counts[type];
          if (!cnt) continue;
          const off = D.offsets[type];
          const H = TREE_H[type === ST.pine ? 0 : 1];
          for (let i = 0; i < cnt; i++) {
            if (D.ranks[off + i] >= this.density) continue; // not drawn
            const o = (off + i) * ST_MAT;
            const M2 = D.mats;
            const sy = M2[o + 5];
            if (sy === 0) continue; // already down
            const tx = cx * CH + M2[o + 12], tz = cz * CH + M2[o + 14];
            const sc = Math.hypot(M2[o], M2[o + 2]);
            const crown = 2.6 * sc;
            const dx = tx - ax, dz = tz - az;
            if (dx * dx + dz * dz > (r + crown) * (r + crown)) continue;
            const ty = M2[o + 13];
            // trunk segment (base to top) in box space vs the box grown by a trunk/crown radius
            _a.set(tx - offX, ty, tz - offZ).sub(center).applyQuaternion(_qi);
            _b.set(tx - offX, ty + H * sy, tz - offZ).sub(center).applyQuaternion(_qi);
            const rad = 0.9 * sc;
            let t0 = 0, t1 = 1;
            let hit = true;
            for (let k = 0; k < 3 && hit; k++) {
              const a = k === 0 ? _a.x : k === 1 ? _a.y : _a.z;
              const b = k === 0 ? _b.x : k === 1 ? _b.y : _b.z;
              const h = (k === 0 ? half.x : k === 1 ? half.y : half.z) + rad;
              const d = b - a;
              if (Math.abs(d) < 1e-6) {
                if (a < -h || a > h) hit = false;
              } else {
                let u0 = (-h - a) / d, u1 = (h - a) / d;
                if (u0 > u1) [u0, u1] = [u1, u0];
                t0 = Math.max(t0, u0);
                t1 = Math.min(t1, u1);
                if (t0 > t1) hit = false;
              }
            }
            if (!hit) continue;
            const hard = speed > S.treeSmashSpeed && t0 < S.treeSmashLow;
            // the standing tree goes (persistently)
            const key = cx + ',' + cz + ',' + type + ',' + i;
            this.broken.add(key);
            _m2.fromArray(M2, o);
            for (let e = 0; e < 11; e++) M2[o + e] = 0;
            for (const b of this.buckets) if (b.type === type) b.dirty = true;
            const fx = this.ctx.fx;
            _a.set(tx - offX, ty + H * sy * 0.55, tz - offZ);
            if (hard) {
              mass += 1;
              fx.dust(_a, 1.2 + sc * 0.6, type === ST.pine ? 0x3d6b3a : 0x5a8f3c);
              fx.dust(_b.set(tx - offX, ty + 1.5, tz - offZ), 0.9, 0x6b4f32);
              fx.debrisBurst?.({ position: _a.clone(), velocity: vel.clone().multiplyScalar(0.4), count: 10, size: 0.5 * sc, kind: 'panel' });
            } else {
              mass += 0.35;
              this.addFallen(type === ST.pine ? 0 : 1, tx - offX, ty, tz - offZ, _m2, vel, H * sy, speed);
              fx.dust(_a, 0.6 + sc * 0.3, type === ST.pine ? 0x3d6b3a : 0x5a8f3c);
            }
          }
        }
      }
    }
    return mass;
  }

  private addFallen(type: 0 | 1, x: number, y: number, z: number, m: THREE.Matrix4, vel: THREE.Vector3, len: number, speed: number): void {
    const list = this.fallen[type];
    const max = CONFIG.terrain.scatter.fallenMax;
    const f: Fallen = list.length >= max ? list.shift()! : { type, x: 0, y: 0, z: 0, basis: new THREE.Matrix4(), axis: new THREE.Vector3(), ang: 0, vel: 0, len: 1, rest: false };
    f.x = x;
    f.y = y;
    f.z = z;
    f.basis.copy(m).setPosition(0, 0, 0);
    // falls the way it was pushed: rotate about the horizontal axis perpendicular to the push
    _ax.set(vel.x, 0, vel.z);
    if (_ax.lengthSq() < 1e-4) _ax.set(1, 0, 0);
    _ax.normalize();
    f.axis.set(_ax.z, 0, -_ax.x); // up x push
    f.ang = 0.04;
    f.vel = Math.min(2.2, 0.3 + (speed / Math.max(4, len)) * 0.35);
    f.len = Math.max(2, len);
    f.rest = false;
    list.push(f);
    this.fallenDirty = true;
  }

  /** Falling trees: a rigid rod tipping over its base (angular accel = 1.5 g / L * sin angle), resting on its crown. */
  updateFallen(dt: number): void {
    let any = this.fallenDirty;
    for (const list of this.fallen) {
      for (const f of list) {
        if (f.rest) continue;
        f.vel += ((1.5 * 9.81) / f.len) * Math.sin(f.ang) * dt;
        f.ang += f.vel * dt;
        if (f.ang >= 1.47) {
          f.ang = 1.47;
          if (f.vel > 0.6) f.vel *= -0.18; // a small bounce on the crown
          else f.rest = true;
        }
        any = true;
      }
    }
    if (!any) return;
    this.fallenDirty = false;
    for (let t = 0; t < 2; t++) {
      const mesh = this.fallenMesh[t];
      const list = this.fallen[t];
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        _q.setFromAxisAngle(f.axis, f.ang);
        _m.makeRotationFromQuaternion(_q).multiply(f.basis);
        _m.elements[12] = f.x;
        _m.elements[13] = f.y;
        _m.elements[14] = f.z;
        mesh.setMatrixAt(i, _m);
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
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
        if (!c.data) this.pool.wantJob(KEY_SCATTER + ck(cx, cz), 80 + d2 * 1.1 + dy, 'scatter', cx, cz);
      }
    }
    // re-evaluate bands when the camera moved enough
    const moved = Math.hypot(camX - this.lastEvalX, camZ - this.lastEvalZ) > 10 || Math.abs(camY - this.lastEvalY) > 15;
    if (moved) {
      this.lastEvalX = camX;
      this.lastEvalZ = camZ;
      this.lastEvalY = camY;
      for (const c of this.chunks.values()) this.evalChunk(c, camX, camZ, dy, R, offX, offZ);
      this.fresh.length = 0;
    } else if (this.fresh.length) {
      for (const c of this.fresh) this.evalChunk(c, camX, camZ, dy, R, offX, offZ);
      this.fresh.length = 0;
    }
    // structures entering range: a couple of chunks per frame (smooth frame times)
    let adds = 0;
    while (this.structQueue.length && adds < (this.unlimited ? 1e9 : 2)) {
      const c = this.structQueue.shift()!;
      if (c.structIds || !c.data || !(c.mask & BIT(9))) continue;
      this.addStructures(c, offX, offZ);
      adds++;
    }
    // rebuild ONE dirty bucket per frame (near buckets first; mid/far ones throttled), more only within the budget
    let did = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      const b = this.buckets[i];
      if (!b.dirty) continue;
      const minGap = b.band === 2 ? 24 : b.band === 1 ? 6 : 0;
      if (!this.unlimited && this.frame - b.lastBuilt < minGap) continue;
      if (did > 0 && (performance.now() > deadline || b.band >= 1)) break;
      this.rebuild(b, offX, offZ);
      b.lastBuilt = this.frame;
      did++;
      if (!this.unlimited && b.mesh.count > 1500) break;
    }
    // forget far chunks (LRU), every 30 frames
    if (this.frame % 30 === 0 && this.chunks.size > CONFIG.terrain.cacheScatter) {
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
    // trees broken by planes stay broken when a chunk is generated again
    if (this.broken.size) {
      const pre = data.cx + ',' + data.cz + ',';
      for (const k of this.broken) {
        if (!k.startsWith(pre)) continue;
        const parts = k.split(',').map(Number);
        const o = (data.offsets[parts[2]] + parts[3]) * ST_MAT;
        for (let e = 0; e < 11; e++) data.mats[o + e] = 0;
      }
    }
    c.data = data;
    c.mask = 0;
    c.band = 3;
    this.fresh.push(c); // evaluated individually next update (no full re-evaluation)
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
    if (inStruct && !c.structIds) {
      if (!this.structQueue.includes(c)) this.structQueue.push(c);
    } else if (!inStruct && c.structIds) this.removeStructures(c);
  }

  private rebuild(b: Bucket, offX: number, offZ: number): void {
    b.dirty = false;
    const bit = BIT(this.buckets.indexOf(b));
    const mesh = b.mesh;
    const mat = mesh.instanceMatrix.array as Float32Array;
    const col = mesh.instanceColor!.array as Float32Array;
    const isTree = b.type === ST.pine || b.type === ST.round || b.type === ST.bush;
    const keep = isTree ? this.density * b.density : 2;
    let n = 0;
    for (const c of this.chunks.values()) {
      if (!(c.mask & bit) || !c.data) continue;
      const D = c.data;
      const cnt = D.counts[b.type];
      if (!cnt) continue;
      const off = D.offsets[b.type];
      // ranks ascend within a type: keep a prefix (binary search)
      let m = cnt;
      if (keep < 1) {
        let lo = 0;
        let hi = cnt;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (D.ranks[off + mid] < keep) lo = mid + 1;
          else hi = mid;
        }
        m = lo;
      }
      if (n + m > b.cap) m = b.cap - n;
      if (m <= 0) continue;
      mat.set(D.mats.subarray(off * ST_MAT, (off + m) * ST_MAT), n * 16);
      col.set(D.cols.subarray(off * ST_COL, (off + m) * ST_COL), n * 3);
      const tx = c.cx * CH - offX;
      const tz = c.cz * CH - offZ;
      for (let i = n * 16, e = (n + m) * 16; i < e; i += 16) {
        mat[i + 12] += tx;
        mat[i + 14] += tz;
      }
      n += m;
      if (n >= b.cap) break;
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
    for (const list of this.fallen)
      for (const f of list) {
        f.x -= dx;
        f.z -= dz;
      }
    this.fallenDirty = true;
  }

  dispose(): void {
    for (const b of this.buckets) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.structures.dispose();
  }
}

