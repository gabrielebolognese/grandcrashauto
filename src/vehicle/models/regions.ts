import { MAT, gray, type MatCode, type RGB } from './util';

/**
 * Surface regions of the lofted body. Every quad of the body surface gets one region; each region decides which mesh
 * it lands in (paint panels, glass, lamps, trim), its baked colour / material code, and which panel-gap group it is in.
 */
export const R = {
  BODY: 0,
  ROOF: 1, // painted greenhouse metal (roof panel + pillars) — roof colour when two-tone
  BLACK: 2, // gloss-black painted trim (cowl, pillar appliqué, intakes)
  UNDER: 3, // underbody / wheel wells (matte, trim mesh)
  CLAD: 4, // satin black plastic cladding (trim mesh)
  GRILLE: 5, // grille backing (trim mesh)
  HOOD: 6,
  TRUNK: 7,
  DOOR_L: 8,
  DOOR_R: 9,
  RDOOR_L: 10,
  RDOOR_R: 11,
  BUMPER_F: 12,
  BUMPER_F_BLACK: 13,
  BUMPER_R: 14,
  BUMPER_R_BLACK: 15,
  GLASS: 16,
  HEAD: 17,
  DRL: 18,
  TAIL: 19,
  BRAKE: 20,
  REVERSE: 21,
  INDICATOR: 22,
  SKIP: 23,
} as const;
export type RegionId = (typeof R)[keyof typeof R];
export const REGION_COUNT = 24;

/** Light/emissive type codes stored in aMat.w (detail material, see materials.ts). 7 = glass (low LOD). */
export const LT = { NONE: 0, HEAD: 1, DRL: 2, TAIL: 3, BRAKE: 4, REVERSE: 5, INDICATOR: 6, GLASS: 7, UNDERGLOW: 8 } as const;
export const LIGHT_TYPES = 9;

export type MeshKey = 'body' | 'hood' | 'trunk' | 'doorL' | 'doorR' | 'bumperF' | 'bumperR' | 'glass' | 'lights' | 'trim' | 'none';

export interface RegionInfo {
  mesh: MeshKey;
  color: RGB;
  mat: MatCode;
  roof: number;
  /** Panel-gap group: regions in different groups get a small gap between them (0 = no gap group, i.e. 'body'). */
  gap: number;
}

const LAMP_GAP = 20;
const GLASS_GAP = 21;
const lamp = (c: RGB, metal: number, rough: number, type: number): MatCode => [metal, rough, 0, type];

export const REGION_INFO: RegionInfo[] = [];
REGION_INFO[R.BODY] = { mesh: 'body', color: gray(1), mat: MAT.plastic, roof: 0, gap: 0 };
REGION_INFO[R.ROOF] = { mesh: 'body', color: gray(1), mat: MAT.plastic, roof: 1, gap: 0 };
REGION_INFO[R.BLACK] = { mesh: 'body', color: gray(0.03), mat: MAT.plastic, roof: 0, gap: 0 };
REGION_INFO[R.UNDER] = { mesh: 'trim', color: gray(0.045), mat: MAT.rubber, roof: 0, gap: 0 };
REGION_INFO[R.CLAD] = { mesh: 'trim', color: gray(0.05), mat: [0, 0.72, 0, 0], roof: 0, gap: 0 };
REGION_INFO[R.GRILLE] = { mesh: 'trim', color: gray(0.018), mat: [0.2, 0.55, 0, 0], roof: 0, gap: 3 };
REGION_INFO[R.HOOD] = { mesh: 'hood', color: gray(1), mat: MAT.plastic, roof: 0, gap: 4 };
REGION_INFO[R.TRUNK] = { mesh: 'trunk', color: gray(1), mat: MAT.plastic, roof: 0, gap: 5 };
REGION_INFO[R.DOOR_L] = { mesh: 'doorL', color: gray(1), mat: MAT.plastic, roof: 0, gap: 6 };
REGION_INFO[R.DOOR_R] = { mesh: 'doorR', color: gray(1), mat: MAT.plastic, roof: 0, gap: 7 };
REGION_INFO[R.RDOOR_L] = { mesh: 'body', color: gray(1), mat: MAT.plastic, roof: 0, gap: 8 };
REGION_INFO[R.RDOOR_R] = { mesh: 'body', color: gray(1), mat: MAT.plastic, roof: 0, gap: 9 };
REGION_INFO[R.BUMPER_F] = { mesh: 'bumperF', color: gray(1), mat: MAT.plastic, roof: 0, gap: 10 };
REGION_INFO[R.BUMPER_F_BLACK] = { mesh: 'bumperF', color: gray(0.03), mat: MAT.plastic, roof: 0, gap: 10 };
REGION_INFO[R.BUMPER_R] = { mesh: 'bumperR', color: gray(1), mat: MAT.plastic, roof: 0, gap: 11 };
REGION_INFO[R.BUMPER_R_BLACK] = { mesh: 'bumperR', color: gray(0.03), mat: MAT.plastic, roof: 0, gap: 11 };
REGION_INFO[R.GLASS] = { mesh: 'glass', color: gray(0.05), mat: [0, 0.05, 0, LT.GLASS], roof: 0, gap: GLASS_GAP };
REGION_INFO[R.HEAD] = { mesh: 'lights', color: [0.9, 0.92, 0.95], mat: lamp([1, 1, 1], 0.9, 0.12, LT.HEAD), roof: 0, gap: LAMP_GAP };
REGION_INFO[R.DRL] = { mesh: 'lights', color: [1, 1, 1], mat: lamp([1, 1, 1], 0.1, 0.2, LT.DRL), roof: 0, gap: LAMP_GAP };
REGION_INFO[R.TAIL] = { mesh: 'lights', color: [0.5, 0.025, 0.035], mat: lamp([1, 1, 1], 0.25, 0.16, LT.TAIL), roof: 0, gap: LAMP_GAP };
REGION_INFO[R.BRAKE] = { mesh: 'lights', color: [0.55, 0.03, 0.04], mat: lamp([1, 1, 1], 0.25, 0.16, LT.BRAKE), roof: 0, gap: LAMP_GAP };
REGION_INFO[R.REVERSE] = { mesh: 'lights', color: [0.8, 0.8, 0.84], mat: lamp([1, 1, 1], 0.5, 0.12, LT.REVERSE), roof: 0, gap: LAMP_GAP };
REGION_INFO[R.INDICATOR] = { mesh: 'lights', color: [0.95, 0.45, 0.05], mat: lamp([1, 1, 1], 0.3, 0.15, LT.INDICATOR), roof: 0, gap: LAMP_GAP };
REGION_INFO[R.SKIP] = { mesh: 'none', color: gray(1), mat: MAT.plastic, roof: 0, gap: 0 };

/** Gap width (m) between two gap groups. */
export function gapBetween(a: number, b: number): number {
  if (a === b) return 0;
  if (a === GLASS_GAP || b === GLASS_GAP) return 0.008;
  if (a === LAMP_GAP || b === LAMP_GAP) return 0.005;
  return 0.0055;
}

/** Paint regions that count as "paint" for the instancing paintMask (others bake their colour). */
export function isPaintRegion(r: number): boolean {
  return r === R.BODY || r === R.ROOF || r === R.HOOD || r === R.TRUNK || r === R.DOOR_L || r === R.DOOR_R || r === R.RDOOR_L || r === R.RDOOR_R || r === R.BUMPER_F || r === R.BUMPER_R;
}
