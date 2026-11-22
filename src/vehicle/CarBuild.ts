/**
 * CarBuild — the complete, serializable description of a customized car (spec §7).
 * Contract shared by garage (UI + save slots + share code), car models (visuals) and vehicle physics (tuning).
 * Owner: core. Adding fields: add a default in STOCK_BUILD, bump CAR_BUILD_VERSION and handle it in normalizeBuild().
 */

export const CAR_BUILD_VERSION = 1;

export type CarModelId = 'coupe' | 'muscle' | 'hatch' | 'suv';
export const CAR_MODEL_IDS: readonly CarModelId[] = ['coupe', 'muscle', 'hatch', 'suv'];

export type PaintFinish = 'gloss' | 'metallic' | 'matte' | 'pearl' | 'shift';
export const PAINT_FINISHES: readonly PaintFinish[] = ['gloss', 'metallic', 'matte', 'pearl', 'shift'];

export type StripeStyle = 'none' | 'center' | 'twin' | 'side';
export const STRIPE_STYLES: readonly StripeStyle[] = ['none', 'center', 'twin', 'side'];

export type SpoilerStyle = 'none' | 'lip' | 'ducktail' | 'gt';
export const SPOILER_STYLES: readonly SpoilerStyle[] = ['none', 'lip', 'ducktail', 'gt'];

export type TyreProfile = 'low' | 'mid' | 'high';
export const TYRE_PROFILES: readonly TyreProfile[] = ['low', 'mid', 'high'];

/** Number of procedural rim designs (indices 0..RIM_COUNT-1). */
export const RIM_COUNT = 6;
/** Perf upgrade levels per category: 0 = stock, 1 = street, 2 = race. */
export const PERF_LEVELS = 3;

export interface CarBuild {
  v: number;
  model: CarModelId;
  paint: {
    color: string; // '#rrggbb'
    finish: PaintFinish;
    shiftColor: string; // second colour for 'shift' (colour-shift) finish
    twoTone: boolean; // roof in roofColor
    roofColor: string;
    stripes: StripeStyle;
    stripeColor: string;
  };
  wheels: {
    rim: number; // 0..RIM_COUNT-1
    rimColor: string;
    tyre: TyreProfile;
    size: number; // 0 small, 1 medium, 2 large (visual radius; physics radius follows)
  };
  kit: {
    splitter: boolean;
    skirts: boolean;
    spoiler: SpoilerStyle;
    scoop: boolean;
  };
  stance: {
    rideHeight: number; // -1 (slammed) .. 0 (stock) .. 1 (lifted) — also changes suspension rest length
    camber: number; // 0 .. 1  (visual only, 0..~8 degrees)
  };
  extras: {
    tint: number; // 0 clear .. 1 limo
    headlightColor: string;
    underglow: string | null; // null = off
    plate: string; // up to 8 chars, A-Z 0-9 space -
  };
  perf: {
    engine: number; // 0..2
    tyres: number;
    brakes: number;
    suspension: number;
    turbo: number; // part 3: 0..2 turbo upgrade (more boost force + top speed)
  };
}

export const STOCK_BUILD: CarBuild = {
  v: CAR_BUILD_VERSION,
  model: 'coupe',
  paint: {
    color: '#e8574a',
    finish: 'metallic',
    shiftColor: '#6a4cff',
    twoTone: false,
    roofColor: '#1c1c22',
    stripes: 'none',
    stripeColor: '#f4f1e8',
  },
  wheels: { rim: 0, rimColor: '#c9ccd2', tyre: 'mid', size: 1 },
  kit: { splitter: false, skirts: false, spoiler: 'none', scoop: false },
  stance: { rideHeight: 0, camber: 0 },
  extras: { tint: 0.35, headlightColor: '#fff6e0', underglow: null, plate: 'CSTL 01' },
  perf: { engine: 0, tyres: 0, brakes: 0, suspension: 0, turbo: 0 },
};

/** Stock build of a given model (each model may have its own default colour). */
export function stockBuild(model: CarModelId = 'coupe'): CarBuild {
  const b = cloneBuild(STOCK_BUILD);
  b.model = model;
  b.paint.color = ({ coupe: '#e8574a', muscle: '#f2b134', hatch: '#4fb6c9', suv: '#3e4a5c' } as const)[model];
  return b;
}

export function cloneBuild(b: CarBuild): CarBuild {
  return JSON.parse(JSON.stringify(b));
}

const HEX = /^#[0-9a-f]{6}$/i;
const clampInt = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
const clampNum = (v: unknown, lo: number, hi: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
const color = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d);
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Validate/repair any (possibly old or hostile) object into a valid CarBuild. Never throws. */
export function normalizeBuild(input: unknown): CarBuild {
  const i = (input && typeof input === 'object' ? input : {}) as Partial<CarBuild> & Record<string, any>;
  const d = STOCK_BUILD;
  const p = (i.paint ?? {}) as Partial<CarBuild['paint']>;
  const w = (i.wheels ?? {}) as Partial<CarBuild['wheels']>;
  const k = (i.kit ?? {}) as Partial<CarBuild['kit']>;
  const s = (i.stance ?? {}) as Partial<CarBuild['stance']>;
  const e = (i.extras ?? {}) as Partial<CarBuild['extras']>;
  const f = (i.perf ?? {}) as Partial<CarBuild['perf']>;
  return {
    v: CAR_BUILD_VERSION,
    model: oneOf(i.model, CAR_MODEL_IDS, d.model),
    paint: {
      color: color(p.color, d.paint.color),
      finish: oneOf(p.finish, PAINT_FINISHES, d.paint.finish),
      shiftColor: color(p.shiftColor, d.paint.shiftColor),
      twoTone: bool(p.twoTone, d.paint.twoTone),
      roofColor: color(p.roofColor, d.paint.roofColor),
      stripes: oneOf(p.stripes, STRIPE_STYLES, d.paint.stripes),
      stripeColor: color(p.stripeColor, d.paint.stripeColor),
    },
    wheels: {
      rim: clampInt(w.rim, 0, RIM_COUNT - 1, d.wheels.rim),
      rimColor: color(w.rimColor, d.wheels.rimColor),
      tyre: oneOf(w.tyre, TYRE_PROFILES, d.wheels.tyre),
      size: clampInt(w.size, 0, 2, d.wheels.size),
    },
    kit: {
      splitter: bool(k.splitter, d.kit.splitter),
      skirts: bool(k.skirts, d.kit.skirts),
      spoiler: oneOf(k.spoiler, SPOILER_STYLES, d.kit.spoiler),
      scoop: bool(k.scoop, d.kit.scoop),
    },
    stance: {
      rideHeight: clampNum(s.rideHeight, -1, 1, d.stance.rideHeight),
      camber: clampNum(s.camber, 0, 1, d.stance.camber),
    },
    extras: {
      tint: clampNum(e.tint, 0, 1, d.extras.tint),
      headlightColor: color(e.headlightColor, d.extras.headlightColor),
      underglow: e.underglow === null ? null : typeof e.underglow === 'string' && HEX.test(e.underglow) ? e.underglow.toLowerCase() : d.extras.underglow,
      plate: typeof e.plate === 'string' ? sanitizePlate(e.plate) : d.extras.plate,
    },
    perf: {
      engine: clampInt(f.engine, 0, PERF_LEVELS - 1, 0),
      tyres: clampInt(f.tyres, 0, PERF_LEVELS - 1, 0),
      brakes: clampInt(f.brakes, 0, PERF_LEVELS - 1, 0),
      suspension: clampInt(f.suspension, 0, PERF_LEVELS - 1, 0),
      turbo: clampInt(f.turbo, 0, PERF_LEVELS - 1, 0),
    },
  };
}

export function sanitizePlate(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 \-]/g, '').slice(0, 8);
}
