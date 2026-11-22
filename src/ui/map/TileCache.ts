import { CONFIG } from '../../config';
import { genTerrainTile } from './tileGen';

interface Tile {
  canvas: HTMLCanvasElement;
  used: number;
  /** 0 = not requested, 1 = in flight, 2 = drawn (or failed). */
  roads: number;
}

interface Req {
  key: string;
  level: number;
  tx: number;
  tz: number;
  prio: number;
}

interface WorkerSlot {
  w: Worker;
  busy: number;
  dead: boolean;
}

const tileKey = (l: number, x: number, z: number) => `${l}:${x}:${z}`;

function spawnWorker(onMsg: (slot: WorkerSlot, m: WorkerMsg) => void, onDead: (slot: WorkerSlot) => void): WorkerSlot | null {
  try {
    const w = new Worker(new URL('./tileWorker.ts', import.meta.url), { type: 'module' });
    const slot: WorkerSlot = { w, busy: 0, dead: false };
    w.onmessage = (e) => onMsg(slot, e.data);
    w.onerror = (e) => {
      console.warn('[map] tile worker failed', e.message);
      slot.dead = true;
      onDead(slot);
    };
    w.postMessage({ type: 'init', seed: CONFIG.game.seed, coast: { ...CONFIG.world.coast }, waterLevel: CONFIG.world.waterLevel });
    return slot;
  } catch (err) {
    console.warn('[map] workers unavailable', err);
    return null;
  }
}

interface WorkerMsg {
  type: string;
  id: number;
  pixels?: ArrayBuffer;
  segs?: ArrayBuffer;
  msg?: string;
}

/**
 * Map tile cache: LRU of small canvases. Terrain tiles come from a pool of workers (main-thread time-sliced fallback
 * if workers are unavailable). Seeded highway corridors are stroked on top later by a separate, lazily spawned
 * "roads" worker (the highway generator can take a while on its first queries, and must never block terrain tiles).
 * The renderer calls need()/needRoads() for visible tiles each render, then flush().
 */
export class TileCache {
  private tiles = new Map<string, Tile>();
  private pending = new Map<number, Req>();
  private pendingKeys = new Set<string>();
  private queue: Req[] = [];
  private roadQueue: Req[] = [];
  private roadPending = new Map<number, Req>();
  private workers: WorkerSlot[] = [];
  private roadWorker: WorkerSlot | null = null;
  private roadsDisabled = false;
  private nextId = 1;
  private frame = 0;
  private fallbackTimer = 0;
  private failed = new Set<string>();
  /** Stats for the smoke test / debug. */
  stats = { generated: 0, roads: 0, fallback: 0, workers: 0 };
  /** Called when a tile arrives (the renderer re-renders). */
  onTile: (() => void) | null = null;

  constructor() {
    const n = Math.max(1, Math.min(CONFIG.nav.mapWorkers, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)));
    for (let i = 0; i < n; i++) {
      const s = spawnWorker(
        (slot, m) => this.onMessage(slot, m),
        () => this.requeueAll(),
      );
      if (!s) break;
      this.workers.push(s);
    }
    this.stats.workers = this.workers.length;
  }

  get size(): number {
    return this.tiles.size;
  }

  get busy(): boolean {
    return this.pending.size > 0 || this.queue.length > 0;
  }

  beginFrame(): void {
    this.frame++;
    this.queue.length = 0;
    this.roadQueue.length = 0;
  }

  get(level: number, tx: number, tz: number): HTMLCanvasElement | null {
    const t = this.tiles.get(tileKey(level, tx, tz));
    if (!t) return null;
    t.used = this.frame;
    return t.canvas;
  }

  has(level: number, tx: number, tz: number): boolean {
    return this.tiles.has(tileKey(level, tx, tz));
  }

  need(level: number, tx: number, tz: number, prio: number): void {
    const key = tileKey(level, tx, tz);
    if (this.tiles.has(key) || this.pendingKeys.has(key) || this.failed.has(key)) return;
    this.queue.push({ key, level, tx, tz, prio });
  }

  /** Ask for the seeded highways on an existing tile (low priority, only while the map is open). */
  needRoads(level: number, tx: number, tz: number, prio: number): void {
    if (this.roadsDisabled) return;
    const key = tileKey(level, tx, tz);
    const t = this.tiles.get(key);
    if (!t || t.roads !== 0) return;
    this.roadQueue.push({ key, level, tx, tz, prio });
  }

  flush(): void {
    if (this.queue.length) {
      this.queue.sort((a, b) => a.prio - b.prio);
      const live = this.workers.filter((s) => !s.dead);
      if (live.length) {
        for (const s of live) {
          while (s.busy < 2 && this.queue.length) {
            const r = this.queue.shift()!;
            if (this.pendingKeys.has(r.key)) continue;
            const id = this.nextId++;
            this.pending.set(id, r);
            this.pendingKeys.add(r.key);
            s.busy++;
            s.w.postMessage({ type: 'tile', id, level: r.level, tx: r.tx, tz: r.tz, size: CONFIG.nav.mapTilePx });
          }
        }
      } else if (!this.fallbackTimer) {
        this.fallbackTimer = window.setTimeout(() => this.fallbackSlice(), 0);
      }
    }
    // roads: one at a time on their own worker, once the terrain work is done
    if (this.roadQueue.length && !this.roadPending.size && !this.busy && !this.roadsDisabled) {
      if (!this.roadWorker) {
        this.roadWorker = spawnWorker(
          (slot, m) => this.onMessage(slot, m),
          () => (this.roadsDisabled = true),
        );
        if (!this.roadWorker) {
          this.roadsDisabled = true;
          return;
        }
      }
      if (this.roadWorker.dead) return;
      this.roadQueue.sort((a, b) => a.prio - b.prio);
      const r = this.roadQueue.shift()!;
      const t = this.tiles.get(r.key);
      if (!t) return;
      t.roads = 1;
      const id = this.nextId++;
      this.roadPending.set(id, r);
      this.roadWorker.w.postMessage({ type: 'roads', id, level: r.level, tx: r.tx, tz: r.tz, size: CONFIG.nav.mapTilePx });
    }
  }

  private fallbackSlice(): void {
    this.fallbackTimer = 0;
    const t0 = performance.now();
    // one tile per slice at most (they take tens of ms), then yield to the page
    const r = this.queue.shift();
    if (r && !this.tiles.has(r.key)) {
      try {
        this.storeTerrain(r, genTerrainTile({ level: r.level, tx: r.tx, tz: r.tz, size: CONFIG.nav.mapTilePx }));
        this.stats.fallback++;
      } catch (err) {
        console.warn('[map] tile failed', err);
        this.failed.add(r.key);
      }
    }
    this.onTile?.();
    if (this.queue.length) this.fallbackTimer = window.setTimeout(() => this.fallbackSlice(), Math.max(16, (performance.now() - t0) * 1.5));
  }

  private onMessage(slot: WorkerSlot, m: WorkerMsg): void {
    if (m.type === 'roads' || this.roadPending.has(m.id)) {
      const r = this.roadPending.get(m.id);
      this.roadPending.delete(m.id);
      if (r) {
        const t = this.tiles.get(r.key);
        if (t) {
          t.roads = 2;
          if (m.type === 'roads' && m.segs) {
            this.strokeRoads(t.canvas, new Float32Array(m.segs));
            this.stats.roads++;
          }
        }
      }
      this.onTile?.();
      return;
    }
    const r = this.pending.get(m.id);
    slot.busy = Math.max(0, slot.busy - 1);
    if (r) {
      this.pending.delete(m.id);
      this.pendingKeys.delete(r.key);
      if (m.type === 'tile' && m.pixels) this.storeTerrain(r, new Uint8ClampedArray(m.pixels));
      else {
        this.failed.add(r.key);
        if (m.msg) console.warn('[map] tile error', m.msg);
      }
    }
    this.flush();
    this.onTile?.();
  }

  private requeueAll(): void {
    for (const r of this.pending.values()) this.queue.push(r);
    this.pending.clear();
    this.pendingKeys.clear();
    this.flush();
  }

  private storeTerrain(r: Req, pixels: Uint8ClampedArray): void {
    const size = CONFIG.nav.mapTilePx;
    if (pixels.length !== size * size * 4) return;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(pixels as unknown as Uint8ClampedArray<ArrayBuffer>, size, size), 0, 0);
    this.tiles.set(r.key, { canvas: c, used: this.frame, roads: 0 });
    this.stats.generated++;
    this.evict();
  }

  private strokeRoads(c: HTMLCanvasElement, s: Float32Array): void {
    if (!s.length) return;
    const g = c.getContext('2d');
    if (!g) return;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i + 5 < s.length; i += 6) {
        const kind = s[i + 5];
        const w = s[i + 4];
        g.beginPath();
        g.moveTo(s[i], s[i + 1]);
        g.lineTo(s[i + 2], s[i + 3]);
        if (pass === 0) {
          g.setLineDash([]);
          g.strokeStyle = kind === 1 ? 'rgba(255,255,255,0.95)' : kind === 2 ? 'rgba(70,64,90,0.35)' : 'rgba(150,80,40,0.55)';
          g.lineWidth = w + (kind === 1 ? 2.4 : 1.6);
        } else {
          g.strokeStyle = kind === 2 ? 'rgba(244,162,107,0.6)' : '#f4a26b';
          g.lineWidth = w;
          g.setLineDash(kind === 2 ? [Math.max(2, w * 1.5), Math.max(2, w * 1.2)] : []);
        }
        g.stroke();
      }
    }
    g.setLineDash([]);
  }

  private evict(): void {
    const max = Math.max(32, CONFIG.nav.mapTileCache);
    if (this.tiles.size <= max) return;
    const arr = Array.from(this.tiles.entries()).sort((a, b) => a[1].used - b[1].used);
    const drop = this.tiles.size - Math.floor(max * 0.85);
    for (let i = 0; i < drop; i++) {
      const [k, t] = arr[i];
      t.canvas.width = 0;
      t.canvas.height = 0;
      this.tiles.delete(k);
    }
  }

  /** Drop queued (not in-flight) requests — the map closed. */
  cancelQueued(): void {
    this.queue.length = 0;
    this.roadQueue.length = 0;
  }

  dispose(): void {
    for (const s of this.workers) s.w.terminate();
    this.roadWorker?.w.terminate();
    this.workers.length = 0;
    for (const t of this.tiles.values()) {
      t.canvas.width = 0;
      t.canvas.height = 0;
    }
    this.tiles.clear();
  }
}
