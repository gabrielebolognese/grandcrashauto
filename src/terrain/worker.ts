import { CONFIG } from '../config';
import { buildChunk } from './gen/chunk';
import { buildRing } from './gen/ring';
import { buildScatter } from './gen/scatter';
import { buildTile } from './gen/tile';

/**
 * Terrain generation worker (Vite module worker). Pure generation code only; results are transferred back.
 * Messages: {type:'init', seed, config} then {type:'tile'|'chunk'|'scatter'|'ring', id, ...}.
 */

type Msg =
  | { type: 'init'; seed: number; config: { world: unknown; terrain: unknown; highway?: unknown } }
  | { type: 'tile'; id: number; level: number; tx: number; tz: number }
  | { type: 'chunk'; id: number; cx: number; cz: number }
  | { type: 'scatter'; id: number; cx: number; cz: number }
  | { type: 'ring'; id: number; cx: number; cz: number; rIn: number; rOut: number; segments: number; rings: number };

const scope = self as unknown as {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
};

let seed = CONFIG.game.seed;

function assignDeep(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object') assignDeep(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    else dst[k] = v;
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  const t0 = performance.now();
  try {
    switch (m.type) {
      case 'init': {
        seed = m.seed;
        CONFIG.game.seed = m.seed;
        const cfg = CONFIG as unknown as Record<string, Record<string, unknown>>;
        if (m.config.world) assignDeep(cfg.world, m.config.world as Record<string, unknown>);
        if (m.config.terrain) assignDeep(cfg.terrain, m.config.terrain as Record<string, unknown>);
        if (m.config.highway && cfg.highway) assignDeep(cfg.highway, m.config.highway as Record<string, unknown>);
        return;
      }
      case 'tile': {
        const r = buildTile(m.level, m.tx, m.tz, seed);
        scope.postMessage({ type: 'tile', id: m.id, ms: performance.now() - t0, data: r }, [r.positions.buffer, r.colors.buffer, r.snow.buffer, r.index.buffer]);
        return;
      }
      case 'chunk': {
        const r = buildChunk(m.cx, m.cz, seed);
        scope.postMessage({ type: 'chunk', id: m.id, ms: performance.now() - t0, data: r }, [r.heights.buffer, r.surf.buffer, r.biome.buffer, r.flat.buffer]);
        return;
      }
      case 'scatter': {
        const r = buildScatter(m.cx, m.cz, seed);
        scope.postMessage({ type: 'scatter', id: m.id, ms: performance.now() - t0, data: r }, [r.counts.buffer, r.offsets.buffer, r.mats.buffer, r.cols.buffer]);
        return;
      }
      case 'ring': {
        const r = buildRing(m.cx, m.cz, m.rIn, m.rOut, m.segments, m.rings, seed);
        scope.postMessage({ type: 'ring', id: m.id, ms: performance.now() - t0, data: r }, [r.positions.buffer, r.colors.buffer, r.index.buffer]);
        return;
      }
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: (m as { id?: number }).id ?? -1, message: String((err as Error)?.stack ?? err) });
  }
};
