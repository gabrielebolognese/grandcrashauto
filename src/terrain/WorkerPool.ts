import { CONFIG } from '../config';
import { buildChunk } from './gen/chunk';
import { buildRing } from './gen/ring';
import { buildScatter } from './gen/scatter';
import { buildTile } from './gen/tile';

/**
 * Pool of 2–4 terrain generation workers with a de-duplicated, re-prioritised job queue.
 * Callers `want(key, priority, msg)` every frame for what they still need; jobs not wanted for a few frames are dropped
 * before dispatch. Lower priority value = sooner. Falls back to (time-sliced) main-thread generation if workers fail.
 */

export type JobType = 'tile' | 'chunk' | 'scatter' | 'ring';
export interface JobMsg {
  type: JobType;
  [k: string]: unknown;
}
interface Job {
  key: number;
  msg: JobMsg;
  priority: number;
  lastWanted: number;
}
export type ResultHandler = (type: JobType, key: number, data: any, ms: number) => void;
/** Key namespaces (all numeric: no per-frame string allocations). */
export const KEY_CHUNK = 2 ** 46;
export const KEY_SCATTER = 2 ** 47;
export const KEY_RING = 2 ** 48;

const MAX_IN_FLIGHT = 3;

export class WorkerPool {
  private workers: { w: Worker; inFlight: number }[] = [];
  private queue = new Map<number, Job>();
  private inFlight = new Map<number, { key: number; type: JobType; worker: number }>();
  private inFlightKeys = new Set<number>();
  private nextId = 1;
  private frame = 0;
  private fallback = false;
  private oneOff = new Map<number, (data: unknown) => void>();
  stats = { done: 0, ms: 0, errors: 0, dropped: 0 };

  constructor(private onResult: ResultHandler) {}

  get size(): number {
    return this.workers.length;
  }

  get busy(): boolean {
    return this.inFlight.size > 0 || this.queue.size > 0;
  }

  get pending(): number {
    return this.queue.size + this.inFlight.size;
  }

  start(seed: number): void {
    if (this.workers.length || this.fallback) return;
    const cfg = CONFIG.terrain.workers;
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    // leave cores for the main thread / audio / physics (smooth frames beat faster streaming)
    const n = cfg > 0 ? cfg : Math.max(2, Math.min(3, Math.floor(hc / 2)));
    const config = JSON.parse(JSON.stringify({ world: CONFIG.world, terrain: CONFIG.terrain, highway: (CONFIG as Record<string, unknown>).highway ?? null }));
    try {
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: `terrain-${i}` });
        const idx = i;
        w.onmessage = (e) => this.handle(idx, e.data);
        w.onerror = (e) => {
          console.error('[terrain] worker error', e.message);
          this.stats.errors++;
        };
        w.postMessage({ type: 'init', seed, config });
        this.workers.push({ w, inFlight: 0 });
      }
    } catch (err) {
      console.warn('[terrain] workers unavailable, generating on the main thread', err);
      for (const { w } of this.workers) w.terminate();
      this.workers = [];
      this.fallback = true;
    }
  }

  /** Request (or refresh) a job. */
  /** Allocation-free request for tile / chunk / scatter jobs (tile: a=level, b=tx, c=tz; others: a=cx, b=cz). */
  wantJob(key: number, priority: number, type: JobType, a: number, b: number, c = 0): void {
    if (this.inFlightKeys.has(key)) return;
    const j = this.queue.get(key);
    if (j) {
      j.priority = priority;
      j.lastWanted = this.frame;
      return;
    }
    const msg: JobMsg = type === 'tile' ? { type, level: a, tx: b, tz: c } : { type, cx: a, cz: b };
    this.queue.set(key, { key, msg, priority, lastWanted: this.frame });
  }

  want(key: number, priority: number, make: () => JobMsg): void {
    if (this.inFlightKeys.has(key)) return;
    const j = this.queue.get(key);
    if (j) {
      j.priority = priority;
      j.lastWanted = this.frame;
      return;
    }
    this.queue.set(key, { key, msg: make(), priority, lastWanted: this.frame });
  }

  isPending(key: number): boolean {
    return this.queue.has(key) || this.inFlightKeys.has(key);
  }

  /** Dispatch queued jobs to idle workers (call once per frame). */
  pump(budgetMs = 2): void {
    this.frame++;
    // drop jobs nobody asked for recently
    for (const [k, j] of this.queue) {
      if (this.frame - j.lastWanted > 4) {
        this.queue.delete(k);
        this.stats.dropped++;
      }
    }
    if (this.fallback) {
      const t0 = performance.now();
      while (this.queue.size && performance.now() - t0 < budgetMs) {
        const j = this.popBest();
        if (!j) break;
        this.runLocal(j);
      }
      return;
    }
    for (let wi = 0; wi < this.workers.length; wi++) this.refill(wi);
  }

  /** Keep a worker busy (also called right when it returns a result, independent of the frame rate). */
  private refill(wi: number): void {
    const wk = this.workers[wi];
    while (wk.inFlight < MAX_IN_FLIGHT && this.queue.size) {
      const j = this.popBest();
      if (!j) break;
      const id = this.nextId++;
      this.inFlight.set(id, { key: j.key, type: j.msg.type, worker: wi });
      this.inFlightKeys.add(j.key);
      wk.inFlight++;
      wk.w.postMessage({ ...j.msg, id });
    }
  }

  private popBest(): Job | null {
    let best: Job | null = null;
    for (const j of this.queue.values()) if (!best || j.priority < best.priority) best = j;
    if (best) this.queue.delete(best.key);
    return best;
  }

  /** One-off job outside the queue (debug / determinism checks). Resolves with the raw result. */
  runOnce(msg: JobMsg, worker = 0): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (!this.workers.length) {
        const m = msg as Record<string, number> & { type: JobType };
        const seed = CONFIG.game.seed;
        if (m.type === 'tile') resolve(buildTile(m.level, m.tx, m.tz, seed));
        else if (m.type === 'chunk') resolve(buildChunk(m.cx, m.cz, seed));
        else if (m.type === 'scatter') resolve(buildScatter(m.cx, m.cz, seed));
        else resolve(null);
        return;
      }
      this.oneOff.set(id, resolve);
      this.workers[worker % this.workers.length].w.postMessage({ ...msg, id });
    });
  }

  private handle(wi: number, m: { type: string; id: number; ms?: number; data?: unknown; message?: string }): void {
    const one = this.oneOff.get(m.id);
    if (one) {
      this.oneOff.delete(m.id);
      one(m.data ?? null);
      return;
    }
    const job = this.inFlight.get(m.id);
    if (job) {
      this.inFlight.delete(m.id);
      this.inFlightKeys.delete(job.key);
      this.workers[wi].inFlight = Math.max(0, this.workers[wi].inFlight - 1);
    }
    if (m.type === 'error') {
      this.stats.errors++;
      if (this.stats.errors < 5) console.error('[terrain] worker job failed', m.message);
      return;
    }
    if (!job) return;
    this.refill(wi);
    this.stats.done++;
    this.stats.ms += m.ms ?? 0;
    try {
      this.onResult(job.type, job.key, m.data, m.ms ?? 0);
    } catch (err) {
      console.error('[terrain] result handler failed', err);
    }
  }

  private runLocal(j: Job): void {
    const m = j.msg as Record<string, number> & { type: JobType };
    const seed = CONFIG.game.seed;
    const t0 = performance.now();
    let data: unknown = null;
    if (m.type === 'tile') data = buildTile(m.level, m.tx, m.tz, seed);
    else if (m.type === 'chunk') data = buildChunk(m.cx, m.cz, seed);
    else if (m.type === 'scatter') data = buildScatter(m.cx, m.cz, seed);
    else if (m.type === 'ring') data = buildRing(m.cx, m.cz, m.rIn, m.rOut, m.segments, m.rings, seed);
    this.stats.done++;
    this.onResult(m.type, j.key, data, performance.now() - t0);
  }

  dispose(): void {
    for (const { w } of this.workers) w.terminate();
    this.workers = [];
    this.queue.clear();
    this.inFlight.clear();
    this.inFlightKeys.clear();
  }
}
