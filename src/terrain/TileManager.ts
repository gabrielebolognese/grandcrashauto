import * as THREE from 'three';
import { CONFIG } from '../config';
import type { TileMesh } from './gen/tile';
import { tileSize } from './gen/tile';
import type { WorkerPool } from './WorkerPool';

/**
 * Render tiles: a quadtree of LOD levels (level L = 2·2^L m cells, 32×32 cells per tile), selected by distance from
 * the camera, all drawn by ONE BatchedMesh (one multi-draw call). Each slot holds one tile; slots are reserved lazily
 * and recycled (LRU). While a tile streams in, its nearest ready ancestor (or its ready children) keeps the area
 * covered, so there are never holes or overlaps. Visibility uses our own frustum without the far plane (the terrain
 * shader squashes distant vertices inside the far plane).
 */

interface TileRec {
  key: number;
  level: number;
  tx: number;
  tz: number;
  slot: number;
  data: TileMesh | null;
  minY: number;
  maxY: number;
  lastDrawn: number;
  lastWanted: number;
  lakes: TileMesh['lakes'] | null;
}

const OFF = 1 << 20;
export const tileKey = (level: number, tx: number, tz: number) => (level * 2 * OFF + (tx + OFF)) * 2 * OFF + (tz + OFF);
const keyStr = (level: number, tx: number, tz: number) => `t${level}:${tx}:${tz}`;

const _box = new THREE.Box3();
const _m = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _proj = new THREE.Matrix4();
const _pv = new THREE.Matrix4();

export class TileManager {
  readonly mesh: THREE.BatchedMesh;
  private recs = new Map<number, TileRec>();
  private slots: (TileRec | null)[] = [];
  private slotGeom: number[] = [];
  private slotInst: number[] = [];
  private uploadQueue: TileRec[] = [];
  private frame = 0;
  private drawList: TileRec[] = [];
  private leafList: TileRec[] = [];
  private readonly VPT: number;
  private readonly IPT: number;
  private dummy: THREE.BufferGeometry;
  private scratch = new THREE.BufferGeometry();
  /** called with lake descriptors found in uploaded tiles */
  onLakes: ((lakes: NonNullable<TileRec['lakes']>) => void) | null = null;
  stats = { tiles: 0, drawn: 0, visible: 0, tris: 0, slotsUsed: 0, uploads: 0, holes: 0, overflow: 0 };

  constructor(material: THREE.Material, private pool: WorkerPool) {
    const N = CONFIG.terrain.tileCells;
    const V = N + 1;
    this.VPT = V * V + 4 * V;
    this.IPT = N * N * 6 + 4 * N * 6;
    const max = CONFIG.terrain.maxTiles;
    this.mesh = new THREE.BatchedMesh(max, max * this.VPT, max * this.IPT, material);
    this.mesh.name = 'terrain.tiles';
    this.mesh.frustumCulled = false;
    this.mesh.perObjectFrustumCulled = false;
    this.mesh.sortObjects = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.userData.noOriginShift = true; // instance matrices are rebased in onOriginShift()
    // dummy geometry with the full attribute set (reservations are made lazily per slot)
    this.dummy = new THREE.BufferGeometry();
    this.dummy.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.VPT * 3), 3));
    this.dummy.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.VPT * 3), 3, true));
    this.dummy.setAttribute('aSnow', new THREE.BufferAttribute(new Uint8Array(this.VPT * 2), 2, true));
    this.dummy.setIndex(new THREE.BufferAttribute(new Uint16Array(this.IPT), 1));
    this.dummy.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.dummy.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
    // reserve one slot right away so the material compiles with batching during warm-up
    this.reserveSlot();
  }

  private reserveSlot(): number {
    if (this.slots.length >= CONFIG.terrain.maxTiles) return -1;
    const g = this.mesh.addGeometry(this.dummy, this.VPT, this.IPT);
    const inst = this.mesh.addInstance(g);
    this.mesh.setVisibleAt(inst, false);
    this.slots.push(null);
    this.slotGeom.push(g);
    this.slotInst.push(inst);
    return this.slots.length - 1;
  }

  // ─────────────────────────────── selection ───────────────────────────────

  /**
   * Choose the tiles for this frame. cam* = ABSOLUTE camera position; viewDist (m); lod0 = radius of 2 m cells.
   * groundY = ground height below the camera (vertical distance term).
   */
  select(camX: number, camY: number, camZ: number, groundY: number, viewDist: number, lod0: number): void {
    this.frame++;
    const maxL = CONFIG.terrain.maxLevel;
    const S = tileSize(maxL);
    this.leafList.length = 0;
    const dyCam = Math.max(0, camY - groundY);
    const i0 = Math.floor((camX - viewDist) / S);
    const i1 = Math.floor((camX + viewDist) / S);
    const j0 = Math.floor((camZ - viewDist) / S);
    const j1 = Math.floor((camZ + viewDist) / S);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.visit(maxL, i, j, camX, camY, camZ, dyCam, viewDist, lod0);

    // coverage: unready leaves fall back to a ready ancestor, or to ready children
    const fallback = new Set<TileRec>();
    this.drawList.length = 0;
    let holes = 0;
    for (const leaf of this.leafList) {
      if (leaf.slot >= 0) continue;
      let a = this.parentOf(leaf);
      while (a && a.slot < 0) a = this.parentOf(a);
      if (a) fallback.add(a);
    }
    // drop fallback tiles that sit inside another fallback tile
    for (const a of [...fallback]) {
      let p = this.parentOf(a);
      while (p) {
        if (fallback.has(p)) {
          fallback.delete(a);
          break;
        }
        p = this.parentOf(p);
      }
    }
    for (const a of fallback) this.drawList.push(a);
    for (const leaf of this.leafList) {
      if (this.coveredBy(leaf, fallback)) continue;
      if (leaf.slot >= 0) {
        this.drawList.push(leaf);
        continue;
      }
      // children from an earlier, finer selection?
      if (!this.drawChildren(leaf, 2)) holes++;
    }
    this.stats.holes = holes;
    this.stats.drawn = this.drawList.length;
    for (const r of this.drawList) r.lastDrawn = this.frame;
  }

  private visit(level: number, tx: number, tz: number, cx: number, cy: number, cz: number, dyCam: number, viewDist: number, lod0: number): void {
    const size = tileSize(level);
    const x0 = tx * size;
    const z0 = tz * size;
    const dx = Math.max(x0 - cx, 0, cx - (x0 + size));
    const dz = Math.max(z0 - cz, 0, cz - (z0 + size));
    const d2 = Math.sqrt(dx * dx + dz * dz);
    if (d2 > viewDist) return;
    const rec = this.recs.get(tileKey(level, tx, tz));
    let dy = dyCam;
    if (rec && rec.slot >= 0) dy = Math.max(0, cy - rec.maxY);
    const d = Math.sqrt(d2 * d2 + dy * dy);
    if (level > 0 && d < lod0 * (1 << (level - 1))) {
      const l = level - 1;
      this.visit(l, tx * 2, tz * 2, cx, cy, cz, dyCam, viewDist, lod0);
      this.visit(l, tx * 2 + 1, tz * 2, cx, cy, cz, dyCam, viewDist, lod0);
      this.visit(l, tx * 2, tz * 2 + 1, cx, cy, cz, dyCam, viewDist, lod0);
      this.visit(l, tx * 2 + 1, tz * 2 + 1, cx, cy, cz, dyCam, viewDist, lod0);
      return;
    }
    const r = this.getRec(level, tx, tz);
    r.lastWanted = this.frame;
    this.leafList.push(r);
    if (r.slot < 0 && !r.data) {
      // nearer + coarser first (coarse tiles give quick coverage)
      const pr = d + level * -25;
      this.pool.want(keyStr(level, tx, tz), pr, () => ({ type: 'tile', level, tx, tz }));
    }
  }

  private getRec(level: number, tx: number, tz: number): TileRec {
    const k = tileKey(level, tx, tz);
    let r = this.recs.get(k);
    if (!r) {
      r = { key: k, level, tx, tz, slot: -1, data: null, minY: 0, maxY: 0, lastDrawn: -1, lastWanted: -1, lakes: null };
      this.recs.set(k, r);
    }
    return r;
  }

  private parentOf(r: TileRec): TileRec | null {
    if (r.level >= CONFIG.terrain.maxLevel) return null;
    return this.recs.get(tileKey(r.level + 1, Math.floor(r.tx / 2), Math.floor(r.tz / 2))) ?? null;
  }

  private coveredBy(r: TileRec, set: Set<TileRec>): boolean {
    if (!set.size) return false;
    let p = this.parentOf(r);
    while (p) {
      if (set.has(p)) return true;
      p = this.parentOf(p);
    }
    return false;
  }

  /** Draw ready descendants (up to `depth` levels) that fully cover r. Returns false if they don't. */
  private drawChildren(r: TileRec, depth: number): boolean {
    if (r.level === 0 || depth === 0) return false;
    const kids: TileRec[] = [];
    for (let k = 0; k < 4; k++) {
      const c = this.recs.get(tileKey(r.level - 1, r.tx * 2 + (k & 1), r.tz * 2 + (k >> 1)));
      if (!c) return false;
      kids.push(c);
    }
    const start = this.drawList.length;
    for (const c of kids) {
      if (c.slot >= 0) this.drawList.push(c);
      else if (!this.drawChildren(c, depth - 1)) {
        this.drawList.length = start;
        return false;
      }
    }
    return true;
  }

  // ─────────────────────────────── results / uploads ───────────────────────────────

  onTile(key: string, data: TileMesh): void {
    const r = this.recs.get(tileKey(data.level, data.tx, data.tz));
    if (!r) return;
    void key;
    r.data = data;
    r.minY = data.minY;
    r.maxY = data.maxY;
    if (data.lakes.length) r.lakes = data.lakes;
    this.uploadQueue.push(r);
  }

  /** Upload pending tiles within the time budget. Returns ms used. */
  upload(deadline: number, offsetX: number, offsetZ: number): void {
    // nearest-wanted first: they are pushed in priority order already; drop stale ones
    while (this.uploadQueue.length && performance.now() < deadline) {
      const r = this.uploadQueue.shift()!;
      if (!r.data) continue;
      if (this.frame - r.lastWanted > 30) {
        r.data = null; // not needed any more
        continue;
      }
      const slot = this.allocSlot();
      if (slot < 0) {
        this.stats.overflow++;
        r.data = null;
        continue;
      }
      this.fill(slot, r, offsetX, offsetZ);
      if (r.lakes && this.onLakes) this.onLakes(r.lakes);
    }
  }

  private allocSlot(): number {
    for (let i = 0; i < this.slots.length; i++) if (!this.slots[i]) return i;
    const s = this.reserveSlot();
    if (s >= 0) return s;
    // evict the least recently drawn tile that is neither drawn nor wanted now
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const r = this.slots[i]!;
      if (r.lastDrawn === this.frame || r.lastWanted === this.frame) continue;
      const t = Math.max(r.lastDrawn, r.lastWanted);
      if (t < bestT) {
        bestT = t;
        best = i;
      }
    }
    if (best < 0) return -1;
    const old = this.slots[best]!;
    old.slot = -1;
    this.recs.delete(old.key);
    this.slots[best] = null;
    return best;
  }

  private fill(slot: number, r: TileRec, ox: number, oz: number): void {
    const d = r.data!;
    const g = this.scratch;
    g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(d.colors, 3, true));
    g.setAttribute('aSnow', new THREE.BufferAttribute(d.snow, 2, true));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    const h = d.size / 2;
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-h, d.minY, -h), new THREE.Vector3(h, Math.max(d.maxY, d.minY + 1), h));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.mesh.setGeometryAt(this.slotGeom[slot], g);
    _m.makeTranslation(d.cx - ox, 0, d.cz - oz);
    this.mesh.setMatrixAt(this.slotInst[slot], _m);
    this.slots[slot] = r;
    r.slot = slot;
    r.data = null;
    this.stats.uploads++;
  }

  /** Per-frame visibility (call after select + upload). cam = local camera. */
  updateVisibility(camera: THREE.PerspectiveCamera, offsetX: number, offsetZ: number): void {
    // frustum without a far plane
    _proj.copy(camera.projectionMatrix);
    const n = camera.near;
    const f = 1e7;
    _proj.elements[10] = -(f + n) / (f - n);
    _proj.elements[14] = (-2 * f * n) / (f - n);
    _pv.multiplyMatrices(_proj, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    for (let i = 0; i < this.slots.length; i++) {
      const r = this.slots[i];
      if (!r) {
        this.mesh.setVisibleAt(this.slotInst[i], false);
        continue;
      }
      if (r.lastDrawn !== this.frame) {
        this.mesh.setVisibleAt(this.slotInst[i], false);
        continue;
      }
    }
    let vis = 0;
    let tris = 0;
    const N = CONFIG.terrain.tileCells;
    for (const r of this.drawList) {
      const size = tileSize(r.level);
      const x0 = r.tx * size - offsetX;
      const z0 = r.tz * size - offsetZ;
      _box.min.set(x0, r.minY, z0);
      _box.max.set(x0 + size, Math.max(r.maxY, r.minY + 1), z0 + size);
      const v = _frustum.intersectsBox(_box);
      this.mesh.setVisibleAt(this.slotInst[r.slot], v);
      if (v) {
        vis++;
        tris += N * N * 2;
      }
    }
    this.stats.visible = vis;
    this.stats.tris = tris;
    this.stats.tiles = this.recs.size;
    let used = 0;
    for (const s of this.slots) if (s) used++;
    this.stats.slotsUsed = used;
  }

  /** Floating origin: instance matrices are local — move them by -delta. */
  onOriginShift(dx: number, dz: number): void {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]) continue;
      this.mesh.getMatrixAt(this.slotInst[i], _m);
      _m.elements[12] -= dx;
      _m.elements[14] -= dz;
      this.mesh.setMatrixAt(this.slotInst[i], _m);
    }
  }

  /** Forget tile records far from the camera that hold no slot (bounded bookkeeping). */
  prune(): void {
    if (this.recs.size < 4000) return;
    for (const [k, r] of this.recs) if (r.slot < 0 && !r.data && this.frame - r.lastWanted > 120) this.recs.delete(k);
  }

  dispose(): void {
    this.mesh.dispose();
    this.dummy.dispose();
  }
}
