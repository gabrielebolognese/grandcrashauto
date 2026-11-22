import { runBake, type BakeArgs, type BakeKind } from './bakes';

interface Job {
  id: number;
  name: string;
  kind: BakeKind;
  args: BakeArgs;
  cb: (chans: Float32Array[]) => void;
  t0: number;
}

/**
 * Bakes procedural buffers in a module worker (no main-thread jank); falls back to the main thread (one job per
 * frame, within a budget) if workers are unavailable or the worker fails to load.
 */
export class Baker {
  private worker: Worker | null = null;
  private inflight = new Map<number, Job>();
  private queue: Job[] = [];
  private nextId = 1;
  /** Compute time per job (ms) for ?debug. */
  readonly ms: Record<string, number> = {};
  usingWorker = false;

  constructor() {
    try {
      const w = new Worker(new URL('./bakeWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ id: number; chans?: Float32Array[]; ms?: number; error?: string }>) => this.onMessage(e.data);
      w.onerror = (e) => {
        console.warn('[audio] bake worker failed, baking on the main thread', e.message);
        this.fallback();
      };
      this.worker = w;
      this.usingWorker = true;
    } catch (err) {
      console.warn('[audio] bake worker unavailable', err);
    }
  }

  bake(name: string, kind: BakeKind, args: BakeArgs, cb: (chans: Float32Array[]) => void): void {
    const job: Job = { id: this.nextId++, name, kind, args, cb, t0: performance.now() };
    if (this.worker) {
      this.inflight.set(job.id, job);
      this.worker.postMessage({ id: job.id, kind, args });
    } else this.queue.push(job);
  }

  private onMessage(d: { id: number; chans?: Float32Array[]; ms?: number; error?: string }): void {
    const job = this.inflight.get(d.id);
    if (!job) return;
    this.inflight.delete(d.id);
    if (!d.chans || d.error) {
      console.warn(`[audio] bake ${job.name} failed in worker, retrying on the main thread`, d.error);
      this.queue.push(job);
      return;
    }
    this.ms[job.name] = +(d.ms ?? 0).toFixed(1);
    try {
      job.cb(d.chans);
    } catch (err) {
      console.warn(`[audio] bake ${job.name} callback failed`, err);
    }
  }

  private fallback(): void {
    try {
      this.worker?.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
    this.usingWorker = false;
    const jobs = [...this.inflight.values()].sort((a, b) => a.id - b.id);
    this.inflight.clear();
    this.queue.unshift(...jobs);
  }

  /** Main-thread fallback: at least one job per call, more while under `budgetMs`. */
  step(budgetMs: number): void {
    if (!this.queue.length) return;
    const t0 = performance.now();
    do {
      const job = this.queue.shift()!;
      const t = performance.now();
      try {
        const chans = runBake(job.kind, job.args);
        this.ms[job.name] = +(performance.now() - t).toFixed(1);
        job.cb(chans);
      } catch (err) {
        console.warn(`[audio] bake ${job.name} failed`, err);
      }
    } while (this.queue.length && performance.now() - t0 < budgetMs);
  }

  get pending(): number {
    return this.queue.length + this.inflight.size;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.queue.length = 0;
    this.inflight.clear();
  }
}
