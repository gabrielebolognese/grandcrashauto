/**
 * Every tunable number lives here (spec §3, §6). Each module owns ONE section below.
 * Rules for contributors (see CLAUDE.md):
 *  - Only edit the section your module owns. Re-read the file right before editing (other agents edit it too).
 *  - Keep values plain data (numbers / strings / booleans / arrays / nested objects) so the ?debug panel can tweak them live.
 *  - Code must read config values at use-time (e.g. CONFIG.vehicle.engineForce inside update), not cache them at import, so live tuning works.
 */

export const CONFIG = {
  // ───────────────────────────── game (owner: core) ─────────────────────────────
  game: {
    title: 'Coastline', // working title — rename here only
    version: '0.1.0',
    seed: 1337, // city seed (override with ?seed=)
    saveKey: 'coastline.save', // single versioned localStorage key
    autoResetDelay: 6, // s after explosion when auto-reset setting is on
    slowMoScale: 0.3, // explosion slow-motion dip time scale
    slowMoDuration: 0.9, // s (real time) to ramp back to 1
  },

  // ───────────────────────────── physics (owner: core) ──────────────────────────
  physics: {
    hz: 60,
    maxSubSteps: 4, // per rendered frame; extra time is dropped (prevents spiral of death)
    gravity: -14, // arcade-leaning: snappier jumps than -9.81
    contactForceThreshold: 4000, // N — default threshold for contact force events
  },

  // ───────────────────────────── input (owner: core) ────────────────────────────
  input: {
    keySteerRate: 3.2, // /s ramp toward full lock with keys
    keySteerReturn: 5.5, // /s return to center with keys
    gamepadDeadzone: 0.12,
  },

  // ───────────────────────────── quality (owner: core) ──────────────────────────
  quality: {
    probeSeconds: 3,
    dynRes: { upAfter: 4, downAfter: 1.5, step: 0.1, hysteresis: 0.78 },
    presets: {
      low: {
        pixelRatioCap: 1.0, renderScaleMin: 0.6, targetFps: 30,
        shadows: false, shadowMapSize: 1024, bloom: false,
        npcCount: 30, viewDistance: 260, chunkRadius: 2,
        propDensity: 0.6, parkedCarDensity: 0.5, particleScale: 0.5,
        clouds: false, waterDetail: 0, antialias: false,
      },
      medium: {
        pixelRatioCap: 1.5, renderScaleMin: 0.65, targetFps: 40,
        shadows: true, shadowMapSize: 1024, bloom: false,
        npcCount: 60, viewDistance: 360, chunkRadius: 3,
        propDensity: 0.85, parkedCarDensity: 0.8, particleScale: 0.75,
        clouds: true, waterDetail: 1, antialias: false,
      },
      high: {
        pixelRatioCap: 2.0, renderScaleMin: 0.75, targetFps: 55,
        shadows: true, shadowMapSize: 2048, bloom: true,
        npcCount: 130, viewDistance: 520, chunkRadius: 4,
        propDensity: 1.0, parkedCarDensity: 1.0, particleScale: 1.0,
        clouds: true, waterDetail: 2, antialias: true,
      },
    },
  },

  // ───────────────────────────── world / city (owner: src/world) ────────────────
  world: {
    size: 800, // m, city spans [-size/2, size/2] on X and Z
    chunkSize: 100,
    waterLevel: 0, // y of the ocean surface
    deepWaterDepth: 1.1, // m of water above the ground that triggers a reset
    killY: -30, // below this the car auto-resets
  },

  // ───────────────────────────── environment (owner: src/world/env) ─────────────
  env: {
    sunElevationDeg: 52,
    sunAzimuthDeg: 135,
    exposure: 1.0,
    fogNear: 120,
    fogFar: 700,
  },

  // ───────────────────────────── props & parked cars (owner: src/world/props) ───
  props: {
    // Shared with src/world (bench placement) — keep the bench model matching these numbers.
    benchSeatHeight: 0.46, // m, seat surface above ground
    benchSeatSpacing: 0.62, // m between seat centers
  },

  // ───────────────────────────── vehicle physics (owner: src/vehicle) ───────────
  vehicle: {},

  // ───────────────────────────── camera (owner: src/camera) ─────────────────────
  camera: {
    fov: 62,
    near: 0.1,
    far: 1500,
  },

  // ───────────────────────────── car models (owner: src/vehicle/models) ─────────
  carModels: {},

  // ───────────────────────────── garage (owner: src/ui/garage) ──────────────────
  garage: {},

  // ───────────────────────────── pedestrians (owner: src/npc) ───────────────────
  npc: {},

  // ───────────────────────────── effects (owner: src/fx) ────────────────────────
  fx: {},

  // ───────────────────────────── audio (owner: src/audio) ───────────────────────
  audio: {},

  // ───────────────────────────── ui / hud / touch (owner: src/ui) ───────────────
  ui: {
    longPressResetMs: 600,
  },
};

export type Config = typeof CONFIG;
export type QualityLevel = keyof typeof CONFIG.quality.presets;
export type QualityPreset = (typeof CONFIG.quality.presets)['low'];
