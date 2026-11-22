/**
 * Shared PURE generation types (owner: core). Used by worker-safe code in src/terrain/gen/** and src/highway/net/**.
 * All coordinates here are ABSOLUTE (seeded generation must not depend on the floating origin).
 */

/** One straight piece of a highway centreline, as needed for terrain corridor carving. */
export interface CorridorSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Road surface height at a and b. */
  ya: number;
  yb: number;
  /** Half width of the paved formation incl. shoulders and barriers (m); terrain blends to the road beyond it. */
  halfWidth: number;
  /** road = cut/fill to the road level; bridge = leave terrain natural below; tunnel = natural above (cut portals); gallery = like road on the valley side. */
  kind: 'road' | 'bridge' | 'tunnel' | 'gallery';
}

/** Natural terrain height before any carving (src/terrain/gen owns the implementation). */
export type BaseHeightFn = (ax: number, az: number) => number;
/** Highway corridor segments intersecting an absolute rectangle (src/highway/net owns the implementation). */
export type CorridorFn = (minX: number, minZ: number, maxX: number, maxZ: number) => CorridorSegment[];
