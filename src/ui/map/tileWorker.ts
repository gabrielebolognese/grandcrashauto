import { CONFIG } from '../../config';
import { genRoads, genTerrainTile } from './tileGen';

/** Map tile worker (nav owns): terrain-coloured tiles ('tile') or seeded highway corridors ('roads'), off the main thread. */
interface InitMsg {
  type: 'init';
  seed: number;
  coast?: Record<string, number>;
  waterLevel?: number;
}
interface TileMsg {
  type: 'tile' | 'roads';
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
  try {
    if (m.type === 'tile') {
      const px = genTerrainTile(m);
      post({ type: 'tile', id: m.id, pixels: px.buffer }, [px.buffer]);
    } else if (m.type === 'roads') {
      const segs = genRoads(m);
      post({ type: 'roads', id: m.id, segs: segs.buffer }, [segs.buffer]);
    }
  } catch (err) {
    post({ type: 'error', id: m.id, msg: String((err as Error)?.message ?? err) });
  }
};
