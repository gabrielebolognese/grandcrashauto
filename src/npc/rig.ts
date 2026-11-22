/**
 * Pedestrian skeleton (original, built in code). 14 bones, rest pose = standing upright, arms hanging straight down,
 * facing +Z, character's LEFT is +X. Every bone's rest orientation is identity, so clip rotations are plain Euler
 * angles around world-aligned axes (see clips.ts for the sign conventions).
 */

export const BONE = {
  Pelvis: 0,
  Spine: 1,
  Chest: 2,
  Head: 3,
  UArmL: 4,
  LArmL: 5,
  UArmR: 6,
  LArmR: 7,
  ULegL: 8,
  LLegL: 9,
  FootL: 10,
  ULegR: 11,
  LLegR: 12,
  FootR: 13,
} as const;

export const NUM_BONES = 14;

export const PARENT: readonly number[] = [-1, 0, 1, 2, 2, 4, 2, 6, 0, 8, 9, 0, 11, 12];

/** Bone → mirrored bone (left/right swap). */
export const MIRROR: readonly number[] = [0, 1, 2, 3, 6, 7, 4, 5, 11, 12, 13, 8, 9, 10];

/** Rest-pose pivot (joint) positions in model space (meters, scale 1 ≈ 1.78 m tall adult). */
export const PIVOTS: readonly (readonly [number, number, number])[] = [
  [0, 0.95, 0], // pelvis (root)
  [0, 1.05, 0], // spine / waist
  [0, 1.22, 0], // chest
  [0, 1.47, 0], // head (neck base)
  [0.2, 1.415, 0], // upper arm L (shoulder)
  [0.2, 1.13, 0], // lower arm L (elbow)
  [-0.2, 1.415, 0], // upper arm R
  [-0.2, 1.13, 0], // lower arm R
  [0.093, 0.92, 0], // upper leg L (hip joint)
  [0.093, 0.5, 0.004], // lower leg L (knee)
  [0.093, 0.085, -0.004], // foot L (ankle)
  [-0.093, 0.92, 0], // upper leg R
  [-0.093, 0.5, 0.004], // lower leg R
  [-0.093, 0.085, -0.004], // foot R
];

/** Pelvis pivot height when standing. */
export const HIP_H = PIVOTS[0][1];
/** Pelvis pivot height above the ground when lying flat (back or front). */
export const LIE_H = 0.12;
/** Approximate standing height at scale 1. */
export const BODY_H = 1.78;
