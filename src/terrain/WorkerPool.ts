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
  key: string;
  msg: JobMsg;
  priority: number;
  lastWanted: number;
}
export type ResultHandler = (type: JobType, key: string, data: any, ms: number) => void;

const MAX_IN_FLIGHT = 2;

export class WorkerPool {
  private workers: { w: Worker; inFlight: number }[] = [];
  private queue = new Map<string, Job>();
  private inFlight = new Map<number, { key: string; type: JobType; worker: number }>();
  private inFlightKeys = new Set<string>();
  private nextId = 1;
  private frame = 0;
  private fallback = false;
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
    const n = cfg > 0 ? cfg : Math.max(2, Math.min(4, hc - 2));
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
  want(key: string, priority: number, make: () => JobMsg): void {
    if (this.inFlightKeys.has(key)) return;
    const j = this.queue.get(key);
    if (j) {
      j.priority = priority;
      j.lastWanted = this.frame;
      return;
    }
    this.queue.set(key, { key, msg: make(), priority, lastWanted: this.frame });
  }

  isPending(key: string): boolean {
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
    for (let wi = 0; wi < this.workers.length; wi++) {
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
  }

  private popBest(): Job | null {
    let best: Job | null = null;
    for (const j of this.queue.values()) if (!best || j.priority < best.priority) best = j;
    if (best) this.queue.delete(best.key);
    return best;
  }

  private handle(wi: number, m: { type: string; id: number; ms?: number; data?: unknown; message?: string }): void {
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
