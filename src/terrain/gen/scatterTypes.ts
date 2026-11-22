/** Scatter prop types shared by the worker generator and the main-thread renderer. PURE. */
export const ST = {
  pine: 0,
  round: 1,
  bush: 2,
  rock: 3,
  fence: 4,
  rotor: 5,
  farmhouse: 6,
  barn: 7,
  house: 8,
  cabin: 9,
  turbine: 10,
  pylon: 11,
  cable: 12,
  palm: 13,
  boulder: 14,
  hay: 15,
} as const;
export const ST_COUNT = 16;
/** Types drawn with the structures BatchedMesh (few, varied); the rest are InstancedMeshes. */
export const ST_IS_STRUCTURE = [false, false, false, false, false, false, true, true, true, true, true, true, true, true, true, true];
/** Floats per instance: 16 (matrix, translation relative to the chunk corner, y absolute) + 3 (rgb tint) + 1 (rank). */
export const ST_MAT = 16;
export const ST_COL = 3;

export interface ScatterData {
  cx: number;
  cz: number;
  counts: Int32Array; // per type
  offsets: Int32Array; // per type, instance offset into mats/cols
  mats: Float32Array;
  cols: Float32Array;
  /** per instance, ascending within each type (so "rank < density" is a prefix → memcpy rebuilds) */
  ranks: Float32Array;
}
