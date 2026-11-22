import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { G, groups, RAPIER as R, type Physics, type SurfaceMaterial } from '../core/Physics';
import { CHUNK, CHUNK_CELL, CHUNK_V, type ChunkData } from './gen/chunk';
import { SURF_NAMES } from './gen/biome';
import type { WorkerPool } from './WorkerPool';

/**
 * 128 m query/collider chunks (2 m samples, identical to the L0 render tiles). Heightfield colliders (G.WORLD, tagged
 * 'ground' + dominant surface) exist only within CONFIG.terrain.colliderRadius of the focus, created/removed
 * progressively (≤ 1–2 per frame). The sample data also answers heightAt/surfaceAt/biomeAt exactly (same triangles).
 */

interface ChunkRec {
  cx: number;
  cz: number;
  data: ChunkData | null;
  collider: RAPIER.Collider | null;
  lastWanted: number;
  lastUsed: number;
}

const ck = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
const cks = (cx: number, cz: number) => `c${cx}:${cz}`;

export class ColliderChunks {
  private recs = new Map<number, ChunkRec>();
  private frame = 0;
  private colliderCount = 0;
  /** remote areas to prefetch (teleport targets), absolute, with expiry frame */
  private prefetch: { x: number; z: number; r: number; until: number }[] = [];
  // single-entry cache for hot queries
  private lastKey = -1;
  private lastRec: ChunkRec | null = null;
  stats = { chunks: 0, colliders: 0, created: 0, removed: 0 };

  constructor(private physics: Physics, private pool: WorkerPool) {}

  get count(): number {
    return this.colliderCount;
  }

  /** Request + build colliders around the focus (ABSOLUTE coords). */
  update(focusX: number, focusZ: number, offsetX: number, offsetZ: number, deadline: number, priorityBoost = 0): void {
    this.frame++;
    const T = CONFIG.terrain;
    const rad = T.colliderRadius;
    this.want(focusX, focusZ, rad, -1e6 + priorityBoost);
    // prefetch areas (teleport targets) — requested with top priority
    for (let i = this.prefetch.length - 1; i >= 0; i--) {
      const p = this.prefetch[i];
      if (this.frame > p.until) {
        this.prefetch.splice(i, 1);
        continue;
      }
      this.want(p.x, p.z, p.r, -2e6);
    }
    // build colliders for wanted chunks that have data (nearest first)
    let built = 0;
    const cand: ChunkRec[] = [];
    for (const r of this.recs.values()) if (r.data && !r.collider && r.lastWanted === this.frame && !r.data.inside) cand.push(r);
    if (cand.length) {
      cand.sort((a, b) => dist2(a, focusX, focusZ) - dist2(b, focusX, focusZ));
      for (const r of cand) {
        if (built >= 2 || (built >= 1 && performance.now() > deadline)) break;
        this.build(r, offsetX, offsetZ);
        built++;
      }
    }
    // drop far colliders
    const drop = T.colliderDrop;
    for (const r of this.recs.values()) {
      if (!r.collider) continue;
      if (r.lastWanted === this.frame) continue;
      const d = Math.sqrt(dist2(r, focusX, focusZ));
      let keep = d < drop;
      for (const p of this.prefetch) if (Math.hypot(chunkCx(r) - p.x, chunkCz(r) - p.z) < p.r + CHUNK) keep = true;
      if (!keep) {
        this.physics.removeCollider(r.collider);
        r.collider = null;
        this.colliderCount--;
        this.stats.removed++;
      }
    }
    // LRU on data
    if (this.recs.size > T.cacheChunks) {
      const list = [...this.recs.values()].filter((r) => !r.collider && r.lastWanted !== this.frame);
      list.sort((a, b) => a.lastUsed - b.lastUsed);
      const n = this.recs.size - T.cacheChunks;
      for (let i = 0; i < n && i < list.length; i++) {
        this.recs.delete(ck(list[i].cx, list[i].cz));
        if (this.lastRec === list[i]) {
          this.lastRec = null;
          this.lastKey = -1;
        }
      }
    }
    this.stats.chunks = this.recs.size;
    this.stats.colliders = this.colliderCount;
  }

  private want(x: number, z: number, rad: number, basePriority: number): void {
    const c0 = Math.floor((x - rad) / CHUNK);
    const c1 = Math.floor((x + rad) / CHUNK);
    const r0 = Math.floor((z - rad) / CHUNK);
    const r1 = Math.floor((z + rad) / CHUNK);
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const dx = Math.max(cx * CHUNK - x, 0, x - (cx + 1) * CHUNK);
        const dz = Math.max(cz * CHUNK - z, 0, z - (cz + 1) * CHUNK);
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > rad) continue;
        const r = this.get(cx, cz);
        r.lastWanted = this.frame;
        r.lastUsed = this.frame;
        if (!r.data) this.pool.want(cks(cx, cz), basePriority + d, () => ({ type: 'chunk', cx, cz }));
      }
    }
  }

  private get(cx: number, cz: number): ChunkRec {
    const k = ck(cx, cz);
    let r = this.recs.get(k);
    if (!r) {
      r = { cx, cz, data: null, collider: null, lastWanted: -1, lastUsed: -1 };
      this.recs.set(k, r);
    }
    return r;
  }

  onChunk(data: ChunkData): void {
    const r = this.recs.get(ck(data.cx, data.cz));
    if (!r) return;
    r.data = data;
  }

  private build(r: ChunkRec, ox: number, oz: number): void {
    const d = r.data!;
    const N = CHUNK_V - 1;
    const desc = R.ColliderDesc.heightfield(N, N, d.heights, { x: CHUNK, y: 1, z: CHUNK }, R.HeightFieldFlags.FIX_INTERNAL_EDGES)
      .setTranslation(r.cx * CHUNK + CHUNK / 2 - ox, 0, r.cz * CHUNK + CHUNK / 2 - oz)
      .setCollisionGroups(groups(G.WORLD))
      .setFriction(0.9);
    const col = this.physics.world.createCollider(desc);
    this.physics.tag(col, { kind: 'ground', material: SURF_NAMES[d.surface] as SurfaceMaterial });
    r.collider = col;
    this.colliderCount++;
    this.stats.created++;
  }

  /** Teleport target: request colliders there with top priority for a few seconds. */
  requestArea(x: number, z: number, r: number): void {
    for (const p of this.prefetch) {
      if (Math.abs(p.x - x) < 1 && Math.abs(p.z - z) < 1 && p.r >= r) {
        p.until = this.frame + 600;
        return;
      }
    }
    this.prefetch.push({ x, z, r, until: this.frame + 600 });
    if (this.prefetch.length > 4) this.prefetch.shift();
  }

  /** All chunks overlapping the square around (x, z) have colliders (or need none). ABSOLUTE. */
  isReady(x: number, z: number, r: number): boolean {
    const c0 = Math.floor((x - r) / CHUNK);
    const c1 = Math.floor((x + r) / CHUNK);
    const r0 = Math.floor((z - r) / CHUNK);
    const r1 = Math.floor((z + r) / CHUNK);
    for (let cz = r0; cz <= r1; cz++) {
      for (let cx = c0; cx <= c1; cx++) {
        const rec = this.recs.get(ck(cx, cz));
        if (!rec || !rec.data) return false;
        if (!rec.collider && !rec.data.inside) return false;
      }
    }
    return true;
  }

  private rec(ax: number, az: number): ChunkRec | null {
    const cx = Math.floor(ax / CHUNK);
    const cz = Math.floor(az / CHUNK);
    const k = ck(cx, cz);
    if (k === this.lastKey) return this.lastRec;
    const r = this.recs.get(k) ?? null;
    this.lastKey = k;
    this.lastRec = r;
    return r;
  }

  /** Exact surface height (same triangles as the collider) or NaN when the chunk isn't loaded. ABSOLUTE. */
  heightAt(ax: number, az: number): number {
    const r = this.rec(ax, az);
    if (!r || !r.data) return NaN;
    r.lastUsed = this.frame;
    const H = r.data.heights;
    const lx = (ax - r.cx * CHUNK) / CHUNK_CELL;
    const lz = (az - r.cz * CHUNK) / CHUNK_CELL;
    let i = Math.floor(lx);
    let j = Math.floor(lz);
    if (i > CHUNK_V - 2) i = CHUNK_V - 2;
    if (j > CHUNK_V - 2) j = CHUNK_V - 2;
    if (i < 0) i = 0;
    if (j < 0) j = 0;
    const fu = lx - i;
    const fv = lz - j;
    const V = CHUNK_V;
    const h00 = H[j + i * V];
    const h10 = H[j + (i + 1) * V];
    const h01 = H[j + 1 + i * V];
    const h11 = H[j + 1 + (i + 1) * V];
    // diagonal (x1,z0)–(x0,z1), matching Rapier's heightfield and the render tiles
    if (fu + fv < 1) return h00 + (h10 - h00) * fu + (h01 - h00) * fv;
    return h11 + (h01 - h11) * (1 - fu) + (h10 - h11) * (1 - fv);
  }

  /** Nearest-sample codes (surface, biome, flatness 0..255) or null. ABSOLUTE. */
  sampleCodes(ax: number, az: number): { surf: number; biome: number; flat: number } | null {
    const r = this.rec(ax, az);
    if (!r || !r.data) return null;
    let i = Math.round((ax - r.cx * CHUNK) / CHUNK_CELL);
    let j = Math.round((az - r.cz * CHUNK) / CHUNK_CELL);
    i = i < 0 ? 0 : i >= CHUNK_V ? CHUNK_V - 1 : i;
    j = j < 0 ? 0 : j >= CHUNK_V ? CHUNK_V - 1 : j;
    const v = j + i * CHUNK_V;
    CODES.surf = r.data.surf[v];
    CODES.biome = r.data.biome[v];
    CODES.flat = r.data.flat[v];
    return CODES;
  }

  dispose(): void {
    for (const r of this.recs.values()) if (r.collider) this.physics.removeCollider(r.collider);
    this.recs.clear();
    this.colliderCount = 0;
  }
}

const CODES = { surf: 0, biome: 0, flat: 255 };
const chunkCx = (r: ChunkRec) => r.cx * CHUNK + CHUNK / 2;
const chunkCz = (r: ChunkRec) => r.cz * CHUNK + CHUNK / 2;
function dist2(r: ChunkRec, x: number, z: number): number {
  const dx = chunkCx(r) - x;
  const dz = chunkCz(r) - z;
  return dx * dx + dz * dz;
}
