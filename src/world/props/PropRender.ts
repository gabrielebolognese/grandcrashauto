import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import type { GameContext } from '../../game/contracts';
import { F, type ItemStore } from './store';
import { farCarGeometry, impostorGeometry, kinds, type KindDef } from './registry';
import type { NightLights } from './NightLights';

type BatchType = 'lod' | 'impostor' | 'farCar';

class Batch {
  mesh: THREE.InstancedMesh;
  aTint: THREE.InstancedBufferAttribute;
  aInst: THREE.InstancedBufferAttribute;
  count = 0;
  idx = -1;
  lo = Infinity;
  hi = -1;
  constructor(
    readonly type: BatchType,
    readonly kind: KindDef | null,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly cap: number,
    readonly isCar: boolean,
    shadow: boolean,
  ) {
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.aInst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.aTint.setUsage(THREE.DynamicDrawUsage);
    this.aInst.setUsage(THREE.DynamicDrawUsage);
    this.mesh = new THREE.InstancedMesh(this.attach(geo), mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.noOriginShift = true; // instance matrices are world-space; we shift our data instead
    this.mesh.name = `props:${kind?.name ?? type}`;
  }

  /** Bind our per-instance attributes onto a (possibly shared) geometry — always on a clone. */
  attach(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const g = geo.clone();
    g.setAttribute(this.isCar ? 'aPaint' : 'aTint', this.aTint);
    g.setAttribute(this.isCar ? 'aCar' : 'aInst', this.aInst);
    return g;
  }

  setGeometry(geo: THREE.BufferGeometry): void {
    const old = this.mesh.geometry;
    this.mesh.geometry = this.attach(geo);
    old.dispose();
  }
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();

/**
 * Instanced rendering of every prop and parked car (owner: props): one InstancedMesh per kind LOD, two shared far
 * impostor batches (box / frustum) for small props and one shared far-car batch. Grid-cell frustum + distance culling,
 * rebuilt every few frames (or on camera jumps); moving bodies rewrite only their own slots in between.
 */
export class PropRender {
  readonly root = new THREE.Group();
  private batches: Batch[] = [];
  private kindBatches: Batch[][] = [];
  private impBox: Batch | null = null;
  private impCyl: Batch | null = null;
  private farCar: Batch | null = null;
  private impLocal: (THREE.Matrix4 | null)[] = [];
  private impColor: (THREE.Color | null)[] = [];
  private farLocal: (THREE.Matrix4 | null)[] = [];
  gen = 1;
  dirty = true;
  private frame = 0;
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private maxCull = 0;

  constructor(
    private ctx: GameContext,
    private store: ItemStore,
    private lights: NightLights,
    private mats: { prop: THREE.Material; foliage: THREE.Material; car: THREE.Material },
  ) {
    this.root.name = 'props';
    this.root.userData.noOriginShift = true;
    this.root.matrixAutoUpdate = false;
  }

  build(): void {
    const K = kinds();
    const s = this.store;
    const perKind = new Int32Array(K.length);
    let nImpBox = 0, nImpCyl = 0, nCars = 0;
    for (let i = 0; i < s.n; i++) {
      const k = s.kind[i];
      if (k < 0) continue;
      perKind[k]++;
      const def = K[k];
      if (def.impostor?.shape === 'box') nImpBox++;
      if (def.impostor?.shape === 'cyl') nImpCyl++;
      if (def.car) nCars++;
    }
    for (const def of K) {
      const list: Batch[] = [];
      const n = perKind[def.id];
      if (n > 0) {
        def.lods.forEach((lod) => {
          const mat = def.material === 'car' ? this.mats.car : def.material === 'foliage' ? this.mats.foliage : this.mats.prop;
          const b = new Batch('lod', def, lod.geo, mat, n, def.material === 'car', lod.shadow);
          list.push(b);
          this.add(b);
        });
      }
      this.kindBatches[def.id] = list;
      if (def.impostor) {
        const im = def.impostor;
        this.impLocal[def.id] = new THREE.Matrix4().compose(_p.set(0, im.oy, im.oz), _q.identity(), _s.set(im.sx, im.sy, im.sz));
        this.impColor[def.id] = im.color ? new THREE.Color(im.color) : null;
      }
      this.maxCull = Math.max(this.maxCull, def.cull);
    }
    if (nImpBox) this.add((this.impBox = new Batch('impostor', null, impostorGeometry('box'), this.mats.prop, nImpBox, false, false)));
    if (nImpCyl) this.add((this.impCyl = new Batch('impostor', null, impostorGeometry('cyl'), this.mats.prop, nImpCyl, false, false)));
    if (nCars) this.add((this.farCar = new Batch('farCar', null, farCarGeometry(), this.mats.car, nCars, true, false)));
    for (const def of K) if (def.car) this.updateFarScale(def);
    this.ctx.engine.scene.add(this.root);
  }

  private add(b: Batch): void {
    b.idx = this.batches.length;
    this.batches.push(b);
    this.root.add(b.mesh);
  }

  /** Far-car instance scale from the near geometry's bounding box (generic far car is 4.3 × 1.82 × 1.3). */
  updateFarScale(def: KindDef): void {
    const g = this.kindBatches[def.id]?.[0]?.mesh.geometry ?? def.lods[0].geo;
    if (!g.boundingBox) g.computeBoundingBox();
    const bb = g.boundingBox!;
    const L = bb.max.z - bb.min.z, W = bb.max.x - bb.min.x, H = bb.max.y - Math.max(0, bb.min.y);
    this.farLocal[def.id] = new THREE.Matrix4().makeScale(W / 1.82, H / 1.27, L / 4.3);
  }

  /** Swap a kind's near geometry (car-models instancing geometry arriving). */
  setKindGeometry(def: KindDef, geo: THREE.BufferGeometry): void {
    const b = this.kindBatches[def.id]?.[0];
    if (!b) return;
    b.setGeometry(geo);
    this.updateFarScale(def);
    this.dirty = true;
  }

  get drawBatches(): number {
    let n = 0;
    for (const b of this.batches) if (b.mesh.visible) n++;
    return n;
  }

  get triangles(): number {
    let t = 0;
    for (const b of this.batches) {
      if (!b.mesh.visible) continue;
      const g = b.mesh.geometry;
      const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      t += tri * b.count;
    }
    return t;
  }

  /** Debug: visible batches with instance counts and triangles. */
  batchStats(): { name: string; count: number; tris: number; shadow: boolean }[] {
    const out: { name: string; count: number; tris: number; shadow: boolean }[] = [];
    for (const b of this.batches) {
      if (!b.mesh.visible) continue;
      const g = b.mesh.geometry;
      const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      out.push({ name: b.mesh.name + (b.type === 'lod' ? `#${this.kindBatches[b.kind!.id].indexOf(b)}` : ''), count: b.count, tris: tri * b.count, shadow: b.mesh.castShadow });
    }
    return out;
  }

  // ───────────────────────────── culling ─────────────────────────────
  /** Per frame. Returns true if a full re-cull happened. */
  update(camera: THREE.PerspectiveCamera): boolean {
    this.frame++;
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camDir);
    const moved = _camPos.distanceToSquared(this.lastCam) > 16 || _camDir.dot(this.lastDir) < 0.985;
    if (this.dirty || moved || this.frame % Math.max(1, CONFIG.props.rebuildFrames) === 0) {
      this.cull(camera);
      return true;
    }
    return false;
  }

  private cull(camera: THREE.PerspectiveCamera): void {
    const s = this.store;
    const K = kinds();
    this.dirty = false;
    this.gen++;
    if (this.gen > 0xfffffff0) this.gen = 1;
    this.lastCam.copy(_camPos);
    this.lastDir.copy(_camDir);
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, _m.copy(camera.matrixWorld).invert());
    _frustum.setFromProjectionMatrix(_pv);
    const q = this.ctx.quality;
    const lodMul = (CONFIG.props.lodScale as Record<string, number>)[q.level] ?? 1;
    let maxD = q.current.viewDistance;
    const vis = this.ctx.env.weather?.visibility;
    if (vis !== undefined && vis > 0) maxD = Math.min(maxD, vis * 1.3 + 30);
    for (const b of this.batches) b.count = 0;
    const night = GLOBAL_UNIFORMS.uNight.value;
    this.lights.begin(night > 0.02, _camPos);

    const cx = _camPos.x, cz = _camPos.z;
    const R = Math.min(maxD, this.maxCull * lodMul);
    const cell = s.cell;
    const x0 = Math.max(0, Math.floor((cx - R - s.gx0) / cell));
    const x1 = Math.min(s.gw - 1, Math.floor((cx + R - s.gx0) / cell));
    const z0 = Math.max(0, Math.floor((cz - R - s.gz0) / cell));
    const z1 = Math.min(s.gh - 1, Math.floor((cz + R - s.gz0) / cell));
    const cellR = cell * 0.71 + 12;
    const R2 = (R + cellR) * (R + cellR);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const ci = gz * s.gw + gx;
        const a = s.cellStart[ci], e = s.cellStart[ci + 1];
        if (a === e) continue;
        const ccx = s.gx0 + (gx + 0.5) * cell, ccz = s.gz0 + (gz + 0.5) * cell;
        const dx = ccx - cx, dz = ccz - cz;
        if (dx * dx + dz * dz > R2) continue;
        _sphere.center.set(ccx, s.cellY[ci] + 3, ccz);
        _sphere.radius = cellR;
        if (!_frustum.intersectsSphere(_sphere)) continue;
        for (let k = a; k < e; k++) {
          const i = s.cellItems[k];
          if (s.flags[i] & (F.HIDDEN | F.MOVED)) continue;
          this.emit(i, K[s.kind[i]], lodMul, maxD, night, true);
        }
      }
    }
    for (let m = 0; m < s.movedList.length; m++) {
      const i = s.movedList[m];
      if (s.flags[i] & F.HIDDEN || s.kind[i] < 0) continue;
      const def = K[s.kind[i]];
      _sphere.center.set(s.pos[i * 3], s.pos[i * 3 + 1] + def.height * 0.5, s.pos[i * 3 + 2]);
      _sphere.radius = def.height + def.radius + 1;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      this.emit(i, def, lodMul, maxD, night, false);
    }
    for (const b of this.batches) this.flush(b, true);
    this.lights.end();
  }

  private emit(i: number, def: KindDef, lodMul: number, maxD: number, night: number, fromCell: boolean): void {
    const s = this.store;
    const px = s.pos[i * 3], py = s.pos[i * 3 + 1], pz = s.pos[i * 3 + 2];
    const dx = px - _camPos.x, dy = py - _camPos.y, dz = pz - _camPos.z;
    const d2 = dx * dx + dy * dy * 0.25 + dz * dz;
    const cull = Math.min(maxD, def.cull * lodMul);
    if (d2 > cull * cull) return;
    const d = Math.sqrt(d2);
    // small items in visible cells still get an individual frustum test (cheap, saves vertices)
    if (fromCell && def.radius < 1.5) {
      _sphere.center.set(px, py + def.height * 0.5, pz);
      _sphere.radius = def.height * 0.6 + def.radius;
      if (!_frustum.intersectsSphere(_sphere)) return;
    }
    const list = this.kindBatches[def.id];
    let batch: Batch | null = null;
    for (let l = 0; l < list.length; l++) {
      const last = l === list.length - 1;
      if (d < def.lods[l].dist * lodMul || (last && !def.impostor && !def.car)) {
        batch = list[l];
        break;
      }
    }
    if (!batch) {
      if (def.car) batch = this.farCar;
      else if (def.impostor) batch = def.impostor.shape === 'box' ? this.impBox : this.impCyl;
    }
    if (!batch || batch.count >= batch.cap) return;
    const slot = batch.count++;
    s.slotB[i] = batch.idx;
    s.slot[i] = slot;
    s.slotGen[i] = this.gen;
    this.write(batch, slot, i, def);
    // lamps
    if (night > 0.02 && d < 260) {
      const lit = def.car ? s.inst[i * 4 + 3] > 0.5 : s.inst[i * 4 + 2] > 0.5;
      if (lit) {
        if (def.glows.length) {
          _q.fromArray(s.quat, i * 4);
          const sc = s.scale[i];
          for (const g of def.glows) {
            _v.set(g.x * sc, g.y * sc, g.z * sc).applyQuaternion(_q);
            this.lights.lamp(px + _v.x, py + _v.y, pz + _v.z, g.size * sc, g.pool, py, g.light, d2);
          }
        } else if (def.carLamps && d < 140) {
          _q.fromArray(s.quat, i * 4);
          const cl = def.carLamps;
          for (let sx = -1; sx <= 1; sx += 2) {
            _v.set(sx * cl.front[0], cl.front[1], cl.front[2]).applyQuaternion(_q);
            this.lights.carGlow(px + _v.x, py + _v.y, pz + _v.z, false);
            _v.set(sx * cl.rear[0], cl.rear[1], cl.rear[2]).applyQuaternion(_q);
            this.lights.carGlow(px + _v.x, py + _v.y, pz + _v.z, true);
          }
        }
      }
    }
  }

  private write(b: Batch, slot: number, i: number, def: KindDef): void {
    const s = this.store;
    const arr = b.mesh.instanceMatrix.array as Float32Array;
    const o = slot * 16;
    if (b.type === 'lod' && !(s.flags[i] & F.MOVED)) {
      const src = i * 16;
      for (let k = 0; k < 16; k++) arr[o + k] = s.mat[src + k];
    } else {
      const sc = s.scale[i];
      _m.compose(_p.fromArray(s.pos, i * 3), _q.fromArray(s.quat, i * 4), _s.set(sc, sc, sc));
      if (b.type === 'impostor') {
        const l = this.impLocal[def.id];
        if (l) _m.multiply(l);
      } else if (b.type === 'farCar') {
        const l = this.farLocal[def.id];
        if (l) _m.multiply(l);
      }
      const e = _m.elements;
      for (let k = 0; k < 16; k++) arr[o + k] = e[k];
    }
    const t = b.aTint.array as Float32Array;
    const ic = b.type === 'impostor' ? this.impColor[def.id] : null;
    if (ic) {
      t[slot * 3] = ic.r;
      t[slot * 3 + 1] = ic.g;
      t[slot * 3 + 2] = ic.b;
    } else {
      t[slot * 3] = s.tint[i * 3];
      t[slot * 3 + 1] = s.tint[i * 3 + 1];
      t[slot * 3 + 2] = s.tint[i * 3 + 2];
    }
    const a = b.aInst.array as Float32Array;
    for (let k = 0; k < 4; k++) a[slot * 4 + k] = s.inst[i * 4 + k];
    if (slot < b.lo) b.lo = slot;
    if (slot > b.hi) b.hi = slot;
  }

  /** Rewrite the slot of a moving item (between full culls). */
  writeItem(i: number): void {
    const s = this.store;
    if (s.slotGen[i] !== this.gen || s.slotB[i] < 0) return;
    const b = this.batches[s.slotB[i]];
    if (!b || s.slot[i] >= b.count) return;
    this.write(b, s.slot[i], i, kinds()[s.kind[i]]);
  }

  /** Upload dirty ranges (call once per frame after writes). */
  flushAll(): void {
    for (const b of this.batches) this.flush(b, false);
  }

  private flush(b: Batch, full: boolean): void {
    const im = b.mesh.instanceMatrix;
    if (full) {
      b.mesh.count = b.count;
      b.mesh.visible = b.count > 0;
      if (b.count > 0) {
        im.clearUpdateRanges();
        im.addUpdateRange(0, b.count * 16);
        im.needsUpdate = true;
        b.aTint.clearUpdateRanges();
        b.aTint.addUpdateRange(0, b.count * 3);
        b.aTint.needsUpdate = true;
        b.aInst.clearUpdateRanges();
        b.aInst.addUpdateRange(0, b.count * 4);
        b.aInst.needsUpdate = true;
      }
    } else if (b.hi >= b.lo) {
      im.clearUpdateRanges();
      im.addUpdateRange(b.lo * 16, (b.hi - b.lo + 1) * 16);
      im.needsUpdate = true;
      b.aInst.clearUpdateRanges();
      b.aInst.addUpdateRange(b.lo * 4, (b.hi - b.lo + 1) * 4);
      b.aInst.needsUpdate = true;
    }
    b.lo = Infinity;
    b.hi = -1;
  }

  /** Warm-up: one far-below instance per batch so the lead's hidden frames upload buffers and build programs. */
  warmup(): void {
    for (const b of this.batches) {
      _m.makeTranslation(0, -500, 0).toArray(b.mesh.instanceMatrix.array as Float32Array, 0);
      (b.aInst.array as Float32Array).fill(0, 0, 4);
      b.count = 1;
      this.flush(b, true);
    }
    this.dirty = true;
  }

  /** Is a world-space sphere inside the last culling frustum? */
  inView(x: number, y: number, z: number, r: number): boolean {
    _sphere.center.set(x, y, z);
    _sphere.radius = r;
    return _frustum.intersectsSphere(_sphere);
  }

  dispose(): void {
    this.ctx.engine.scene.remove(this.root);
    for (const b of this.batches) {
      b.mesh.geometry.dispose();
      b.mesh.dispose();
    }
    this.batches.length = 0;
  }
}

