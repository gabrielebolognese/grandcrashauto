import type { CorridorSegment } from '../../core/genTypes';
import { edgesNearRect } from './lattice';
import { KIND_NAMES, getRoute } from './route';
import { checkSeed } from './terrainSample';

/**
 * Highway corridor segments intersecting an ABSOLUTE rectangle (PURE, deterministic from CONFIG.game.seed and
 * order-independent — terrain workers call this to carve cuttings / embankments / tunnel portals).
 *
 * Each segment is ~18 m of carriageway centreline (or a rest-stop pad / mega-jump lane strip) with road surface
 * heights ya/yb and the half width of the formation (pavement + shoulders + barriers + ~2 m verge). Callers should
 * pass the rectangle already expanded by their own blend distance (cut/fill slopes extend beyond halfWidth).
 * Kinds: road = cut/fill to the road level; bridge = keep terrain natural (deck above); tunnel = keep terrain natural
 * (road runs inside the mountain; the cut up to each portal is 'road'); gallery = like road (half-open roof on the
 * valley side).
 *
 * Cost: the first query near an unexplored area routes the nearby macro edges (~1–2k baseHeight samples each); results
 * are cached per edge (LRU), so later queries are cheap.
 */
export function corridorsInRect(minX: number, minZ: number, maxX: number, maxZ: number): CorridorSegment[] {
  checkSeed();
  const out: CorridorSegment[] = [];
  for (const e of edgesNearRect(minX, minZ, maxX, maxZ, 0)) {
    const r = getRoute(e.key);
    if (!r) continue;
    if (r.maxX < minX || r.minX > maxX || r.maxZ < minZ || r.minZ > maxZ) continue;
    const s = r.segs;
    for (let k = 0; k < r.nSegs; k++) {
      const o = k * 8;
      const hw = s[o + 6];
      const ax = s[o], az = s[o + 1], bx = s[o + 2], bz = s[o + 3];
      if (Math.max(ax, bx) + hw < minX || Math.min(ax, bx) - hw > maxX) continue;
      if (Math.max(az, bz) + hw < minZ || Math.min(az, bz) - hw > maxZ) continue;
      out.push({ ax, az, bx, bz, ya: s[o + 4], yb: s[o + 5], halfWidth: hw, kind: KIND_NAMES[s[o + 7]] });
    }
  }
  return out;
}
