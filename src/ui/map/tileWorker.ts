import { CONFIG } from '../../config';
import { genTile } from './tileGen';

/** Map tile worker (nav owns): generates terrain-coloured tiles off the main thread. */
interface InitMsg {
  type: 'init';
  seed: number;
  coast?: Record<string, number>;
  waterLevel?: number;
}
interface TileMsg {
  type: 'tile';
  id: number;
  level: number;
  tx: number;
  tz: number;
  size: number;
}

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<InitMsg | TileMsg>) => {
  const m = e.data;
  if (m.type === 'init') {
    CONFIG.game.seed = m.seed;
    if (m.coast) Object.assign(CONFIG.world.coast, m.coast);
    if (typeof m.waterLevel === 'number') CONFIG.world.waterLevel = m.waterLevel;
    return;
  }
  if (m.type === 'tile') {
    try {
      const out = genTile(m);
      post({ type: 'tile', id: m.id, pixels: out.pixels.buffer, segs: out.segs.buffer }, [out.pixels.buffer, out.segs.buffer]);
    } catch (err) {
      post({ type: 'error', id: m.id, msg: String((err as Error)?.message ?? err) });
    }
  }
};
