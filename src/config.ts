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
    title: 'Grand Crash Auto', // game title — rename here only (the in-world city is called Coastline)
    domain: 'grandcrashauto.lol',
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
    // Phones: multipliers applied on top of the chosen preset (visible-triangle budget ~300k on mobile).
    mobileScale: { view: 0.75, density: 0.7, trees: 0.6, npc: 0.75, particles: 0.8 },
    dynRes: { upAfter: 4, downAfter: 1.5, step: 0.1, hysteresis: 0.78 },
    presets: {
      low: {
        pixelRatioCap: 1.0, renderScaleMin: 0.6, targetFps: 30,
        shadows: false, shadowMapSize: 1024, bloom: false,
        npcCount: 30, viewDistance: 260, chunkRadius: 2,
        propDensity: 0.6, parkedCarDensity: 0.5, particleScale: 0.5,
        clouds: false, waterDetail: 0, antialias: false,
        terrainViewDistance: 1400, treeDensity: 0.45, weatherLevel: 0, realtimeLights: 2, postFx: false,
      },
      medium: {
        pixelRatioCap: 1.5, renderScaleMin: 0.65, targetFps: 40,
        shadows: true, shadowMapSize: 1024, bloom: false,
        npcCount: 60, viewDistance: 360, chunkRadius: 3,
        propDensity: 0.85, parkedCarDensity: 0.8, particleScale: 0.75,
        clouds: true, waterDetail: 1, antialias: false,
        terrainViewDistance: 2200, treeDensity: 0.75, weatherLevel: 1, realtimeLights: 4, postFx: true,
      },
      high: {
        pixelRatioCap: 2.0, renderScaleMin: 0.75, targetFps: 55,
        shadows: true, shadowMapSize: 2048, bloom: true,
        npcCount: 130, viewDistance: 520, chunkRadius: 4,
        propDensity: 1.0, parkedCarDensity: 1.0, particleScale: 1.0,
        clouds: true, waterDetail: 2, antialias: true,
        terrainViewDistance: 3600, treeDensity: 1.0, weatherLevel: 2, realtimeLights: 8, postFx: true,
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
    // Part 3: floating origin — shift the world when the focus is this far from the local origin (m), in steps of:
    originShiftDistance: 2000,
    originShiftStep: 128,
    // Part 3 geography (overrides the part-2 island): ocean on the WEST and SOUTH, endless land NORTH/EAST.
    // Base coast lines in ABSOLUTE coordinates (terrain adds wiggle, headlands, cliffs, islets around them).
    coast: {
      westX: -3800, // west coast runs north–south near this x (ocean at x < westX)
      southZ: 350, // south coast runs east–west near this z (the city beach); ocean at z > southZ
      wiggle: 160, // m of procedural coastline variation
    },
    cityBounds: { minX: -420, maxX: 420, minZ: -420, maxZ: 420 }, // flat, owned by the city generator
    airportBounds: { minX: -3500, maxX: -700, minZ: -900, maxZ: 300 }, // flat, west of the city by the west coast
    airportElevation: 1.2, // m: airport ground level (= CityData.airport.elevation); terrain blends to it at airportBounds
    // Planes: out-of-map applies only over the OCEAN: distance offshore from the coast (part 2 numbers).
    planeWarnOffshore: 5500,
    planeFailOffshore: 6500,
    // Part 2: the city sits on an island surrounded by ocean. Map boundary = circle around the island centre.
    island: {
      minX: -2000, maxX: 2000, minZ: -2600, maxZ: 400, // land bounds (~4 × 3 km); the city occupies [-400,400]²
      centerX: 0, centerZ: -1100,
      warnRadius: 5500, // m from centre: OUT OF MAP warning + 10 s countdown
      failRadius: 6500, // m: failure sequence starts immediately
      ceiling: 3000, // m soft altitude ceiling
    },
  },

  // ───────────────────────────── environment (owner: src/world/env) ─────────────
  env: {
    // Directions: north = -Z, east = +X, south = +Z (ocean south + west). Sun & moon come from the game clock.
    exposure: 1.0, // global exposure multiplier (× the keyframed exposure)
    latitudeDeg: 40, // sun arc: noon elevation = 90 - latitude + declination (seasonal tilt)
    declinationDeg: 9,
    moonCycleDays: 8, // game days per lunar cycle (phases)
    presetHours: { day: 10.5, sunset: 18.55, night: 23.5 }, // legacy settings.timeOfDay → setTime() shortcuts
    clockSaveInterval: 12, // s (real) between clock persists
    envRefreshGameMinutes: 10, // PMREM env map refresh cadence (+ on weather / big sky changes) — never per frame
    fogNearFrac: 0.06, // linear fog near = far × this
    fogFarMul: 1.0, // linear fog far = max(viewDistance, terrainViewDistance × 0.9) × this (grows with altitude)
    altitudeFog: 0.012, // fog distance gain per metre of camera height
    maxFar: 14000, // m, ocean grid radius (must cover the camera rig's largest far plane at altitude)
    envMapSize: 256,
    shadow: {
      extent: 60, // m, half size of the ortho shadow frustum around the focus (grows with camera distance)
      lookAhead: 0.3, // × extent: shift the frustum toward where the camera looks
      distance: 260, // m, light camera distance from the focus
      bias: -0.0004,
      normalBiasTexels: 1.1, // normalBias = texel world size × this
      radius: 1.4, // PCF disk radius in texels
    },
    ocean: {
      shoreSlope: 0.03, // analytic seabed slope (m depth per m offshore) outside the baked depth field
      waveScale: 1.0, // amplitude multiplier (× storm choppiness)
      waveSpeed: 1.0,
      hazeDist: 1000, // m, e-folding distance of the sea haze (grows with altitude)
      shallowDepth: 2.5, // m, turquoise shallows → mid blue
      deepDepth: 14, // m, mid blue → deep blue
      clearDepth: 1.4, // m, water becomes fully opaque past this depth (sand visible under the shallows)
      foamWidth: 0.15, // m of depth covered by the shoreline foam band (beach slope ~1:30 → ~5 m)
      glitter: 1.0,
      seabedRes: 256, // texels per side of the camera-following depth field
      seabedExtent: 1536, // m covered near the ground (grows with altitude, up to seabedExtentMax)
      seabedExtentMax: 9000,
      seabedBudgetMs: 1.5, // per-frame time budget for baking depth from world.groundHeightAt
    },
    clouds: {
      count: 49, // clouds in the field (Medium draws up to 70 % of them; Low has none)
      puffsMin: 6,
      puffsMax: 10,
      altitudeMin: 560, // m, cloud base (fly under / through / above them)
      altitudeMax: 820,
      spread: 4200, // m, half size of the wrapping cloud field around the camera (layout is fixed at init)
      windDrift: 1.0, // × the weather wind
    },
    scenery: {
      hazeDist: 1500, // m, e-folding distance of the haze on islands / boats (grows with altitude)
      boats: 7,
      islands: [
        { x: -1250, z: 1650, radius: 260, height: 74, elong: 1.5, seed: 11, lighthouse: false },
        { x: 900, z: 1450, radius: 130, height: 36, elong: 1.2, seed: 23, lighthouse: false },
        { x: 260, z: 1050, radius: 40, height: 9, elong: 1.0, seed: 37, lighthouse: true },
      ],
    },
    bloom: { radius: 0.45 },
    turbo: { blur: 0.075, aberration: 0.0045, rampIn: 0.25, rampOut: 0.7, speedRef: 70 },
    moon: { color: '#a3b8ff', intensity: 0.42, minLight: 0.35, minElevation: 24 },
    weather: {
      initial: 'fewClouds',
      transitionMin: 60, // s (real) auto transitions
      transitionMax: 180,
      durationMin: 200, // s (real) auto state durations
      durationMax: 620,
      lockedTransition: 8, // s when the player picks a weather
      wetIn: 60, // s to soak in rain
      dryOut: 260, // s to dry
      snowIn: 90,
      snowOut: 420,
      snowLine: 600, // m
      lightningMin: 3, // s between strikes at full storm
      lightningMax: 13,
      drops: [450, 1400, 2800], // rain/snow streaks by quality weatherLevel
      weights: { clear: 26, fewClouds: 26, cloudy: 18, overcast: 9, lightRain: 8, heavyRain: 4, storm: 3, fog: 4, snow: 2 },
      kinds: {
        clear: { cover: 0.04, rain: 0, storm: 0, fog: 0, wind: 2.5, clouds: 0.22, snowAll: 0 },
        fewClouds: { cover: 0.22, rain: 0, storm: 0, fog: 0, wind: 4, clouds: 0.62, snowAll: 0 },
        cloudy: { cover: 0.58, rain: 0, storm: 0, fog: 0.04, wind: 6, clouds: 1, snowAll: 0 },
        overcast: { cover: 0.9, rain: 0, storm: 0, fog: 0.14, wind: 7, clouds: 1, snowAll: 0 },
        lightRain: { cover: 0.95, rain: 0.42, storm: 0, fog: 0.2, wind: 7.5, clouds: 1, snowAll: 0 },
        heavyRain: { cover: 1, rain: 0.85, storm: 0.15, fog: 0.34, wind: 10, clouds: 1, snowAll: 0 },
        storm: { cover: 1, rain: 1, storm: 1, fog: 0.3, wind: 15, clouds: 1, snowAll: 0 },
        fog: { cover: 0.4, rain: 0, storm: 0, fog: 1, wind: 1.2, clouds: 0.3, snowAll: 0 },
        snow: { cover: 0.94, rain: 0.6, storm: 0, fog: 0.32, wind: 5, clouds: 1, snowAll: 1 },
      },
    },
    // Sky / light keyframes by SUN ELEVATION (deg), blended smoothly; weather is applied on top.
    keys: [
      {
        el: -18, zenith: '#040a1c', skyMid: '#0b1736', horizon: '#1c2c54', fog: '#0e1730', ground: '#0d111c', glow: '#3d5288',
        glowStrength: 0.2, sunColor: '#ff8a50', sunIntensity: 0, sunDisk: 0, sunSize: 1.8,
        hemiSky: '#3a4f8c', hemiGround: '#1e1c34', hemiIntensity: 0.4, envIntensity: 0.6, exposure: 1.06,
        cloudLit: '#3c4670', cloudShade: '#11162a', waterDeep: '#03142a', waterMid: '#072240', waterShallow: '#103c56',
        bloomStrength: 0.45, bloomThreshold: 1.1, stars: 1, night: 1,
      },
      {
        el: -7, zenith: '#11285f', skyMid: '#2c4b8c', horizon: '#6d7fb8', fog: '#3f4c7c', ground: '#262b46', glow: '#9a86c8',
        glowStrength: 0.55, sunColor: '#ff7a48', sunIntensity: 0, sunDisk: 0, sunSize: 1.8,
        hemiSky: '#5a6fb0', hemiGround: '#363052', hemiIntensity: 0.7, envIntensity: 0.65, exposure: 1.12,
        cloudLit: '#857eb2', cloudShade: '#2a3052', waterDeep: '#071d3a', waterMid: '#15345c', waterShallow: '#285874',
        bloomStrength: 0.42, bloomThreshold: 1.15, stars: 0.55, night: 0.85,
      },
      {
        el: -1.5, zenith: '#2a4590', skyMid: '#8a78b8', horizon: '#ff9e74', fog: '#c4919a', ground: '#5a4c66', glow: '#ff7845',
        glowStrength: 1.6, sunColor: '#ff6a30', sunIntensity: 0.35, sunDisk: 14, sunSize: 2.0,
        hemiSky: '#8f8fd0', hemiGround: '#6a4c6e', hemiIntensity: 0.85, envIntensity: 0.55, exposure: 1.1,
        cloudLit: '#ff9a7a', cloudShade: '#5d4f86', waterDeep: '#16345e', waterMid: '#2e5480', waterShallow: '#4f8098',
        bloomStrength: 0.5, bloomThreshold: 1.2, stars: 0.12, night: 0.5,
      },
      {
        el: 4, zenith: '#3a62ae', skyMid: '#b090c4', horizon: '#ffc08e', fog: '#e8b69e', ground: '#7d6a86', glow: '#ff9a52',
        glowStrength: 1.4, sunColor: '#ffa868', sunIntensity: 2.4, sunDisk: 20, sunSize: 1.6,
        hemiSky: '#c6b6e8', hemiGround: '#b08690', hemiIntensity: 1.15, envIntensity: 0.5, exposure: 1.08,
        cloudLit: '#ffc09a', cloudShade: '#8f78a8', waterDeep: '#1d4a7a', waterMid: '#36709e', waterShallow: '#58a8b2',
        bloomStrength: 0.4, bloomThreshold: 1.3, stars: 0, night: 0.12,
      },
      {
        el: 14, zenith: '#2f72c8', skyMid: '#84b8e2', horizon: '#f0dcc6', fog: '#e4dbcf', ground: '#9aa2b0', glow: '#ffd2a0',
        glowStrength: 0.9, sunColor: '#ffd9ae', sunIntensity: 3.0, sunDisk: 24, sunSize: 1.2,
        hemiSky: '#b8d4f8', hemiGround: '#8f80a8', hemiIntensity: 1.35, envIntensity: 0.55, exposure: 0.97,
        cloudLit: '#fff0e0', cloudShade: '#aaa4cc', waterDeep: '#0f5a88', waterMid: '#2190b8', waterShallow: '#4cccc2',
        bloomStrength: 0.32, bloomThreshold: 1.5, stars: 0, night: 0,
      },
      {
        el: 32, zenith: '#2a7bd2', skyMid: '#68b3e6', horizon: '#cde6f1', fog: '#cfe6f0', ground: '#a9b8c4', glow: '#fff1d6',
        glowStrength: 0.55, sunColor: '#fff1dc', sunIntensity: 3.3, sunDisk: 26, sunSize: 1.0,
        hemiSky: '#bfe0ff', hemiGround: '#8a86b0', hemiIntensity: 1.5, envIntensity: 0.55, exposure: 0.94,
        cloudLit: '#ffffff', cloudShade: '#b4b5d8', waterDeep: '#0f5f8c', waterMid: '#1f97bd', waterShallow: '#47d3c6',
        bloomStrength: 0.3, bloomThreshold: 1.6, stars: 0, night: 0,
      },
    ],
  },

  // ───────────────────────────── props & parked cars (owner: src/world/props) ───
  props: {
    // Shared with src/world (bench placement) — keep the bench model matching these numbers.
    benchSeatHeight: 0.46, // m, seat surface above ground
    benchSeatSpacing: 0.62, // m between seat centers
    // Bus-stop shelter (PropPlacement 'busStop', p = shelter base centre, yaw = facing the road): its built-in 3-seat
    // bench seat centre sits at local (0, benchSeatHeight, busStopBenchOffset) — world can use it for Bench entries.
    busStopBenchOffset: -0.42,
    busStopBenchSeats: 3,
    // rendering
    lodScale: { low: 0.6, medium: 0.8, high: 1.0 }, // × per-kind LOD/cull distances
    rebuildFrames: 3, // re-cull instanced batches at least every N frames (and on camera jumps)
    shadowDistance: 60, // m — near-LOD casters beyond this don't cast
    sway: 1.0, // palm/tree/windsock sway multiplier (× wind from GLOBAL_UNIFORMS.uWind)
    traffic: { green: 7, amber: 2, allRed: 1 }, // s, per direction (2-phase intersections)
    // night lights
    glowIntensity: 1.0,
    poolIntensity: 0.24,
    lightIntensity: 55, // pooled real PointLight intensity (candela-ish, decay 2)
    lightDistance: 24,
    lightUpdate: 0.5, // s between nearest-streetlight reassignments
    carLightsChance: 0.35, // share of parked cars with parking lights on at night
    // physics
    activeRadius: 60, // m around the focus where props / parked cars get pooled bodies
    releaseRadius: 75,
    maxLightBodies: 150,
    maxHeavyBodies: 140,
    maxCarBodies: 40,
    planeParkAltitude: 80, // m AGL: above this (flying) all prop / parked-car bodies are parked
    respawnDistance: 80, // m: disturbed props respawn when this far AND out of view…
    respawnDelay: 5, // …for this long (s)
    hitWakeSpeed: 1.2, // m/s: a prop woken faster than this counts as hit
    kickUp: 0.3, // × hit speed added upward for a satisfying launch
    kickUpMax: 7,
    kickSpin: 0.6,
    lightLinearDamping: 0.15,
    lightAngularDamping: 0.4,
    carLinearDamping: 0.55,
    carAngularDamping: 1.4,
    carHitDv: 2.0, // m/s velocity change that counts as a parked-car hit
    carGlassDv: 7.5, // m/s velocity change that shatters a parked car's windows
    blastLightDv: 20, // m/s at the blast centre for light props
    blastCarDv: 9, // m/s at the blast centre for parked cars
    blastTopple: 0.35, // falloff above which heavy props topple in a blast
    blastRadiusMul: 1.3, // × explosion radius for the impulse
  },

  // ───────────────────────────── vehicle physics (owner: src/vehicle) ───────────
  vehicle: {
    /** Rigid body / chassis collider. */
    chassis: {
      comHeight: 0.4, // m above the ground plane (car local) — low centre of mass = stable, never tippy
      comForward: 0.08, // m forward bias of the centre of mass (slight nose weight = stable at speed)
      inertiaPitch: 1.35, // multipliers on the collider-box inertia (bigger = calmer rotation)
      inertiaYaw: 1.1,
      inertiaRoll: 1.7,
      angularDamping: 0.2,
      friction: 0.3, // collider friction: low so the car slides along walls instead of snagging
      restitution: 0.1,
      borderRadius: 0.14, // rounded collider edges ride over kerbs instead of catching
      spawnLift: 0.12, // m dropped onto the suspension at spawn/reset
    },
    /** Suspension (per-model stiffness/damping multipliers live in `models`). Stiffness/damping are per unit mass (Rapier). */
    suspension: {
      restLength: 0.32, // m
      travel: 0.22, // m each way around rest length
      stiffness: 38, // → ~2 Hz ride, static sag = |g| / (4 * stiffness)
      compression: 2.7, // damping while compressing
      relaxation: 3.9, // damping while extending
      maxForceG: 8, // per-wheel force cap, in multiples of (mass * g)
      rideHeightRange: 0.06, // m of rest-length change for stance.rideHeight = ±1
      bumpStop: 2.2, // extra upward accel (×|g|) when a wheel is fully compressed (hard landings)
    },
    /** Engine & gearbox (shared). Per-model torque/redline/final drive in `models`. */
    engine: {
      idleRpm: 900,
      launchRpm: 3400, // clutch-slip rpm when pulling away in 1st at full throttle
      // Normalised torque at rpm/redline = 0, .15, .35, .55, .75, .9, 1
      torqueCurve: [0.55, 0.64, 0.86, 1.0, 0.98, 0.9, 0.8],
      gears: [2.85, 1.92, 1.45, 1.17, 0.97],
      reverseRatio: 3.3,
      efficiency: 0.88,
      refWheelRadius: 0.34, // final drive is scaled by wheelRadius/ref so wheel size doesn't change gearing
      shiftUp: 0.93, // upshift at this fraction of redline (full throttle)
      shiftUpLight: 0.5, // … and at light throttle
      shiftDown: 0.52, // downshift below this fraction (full throttle)
      shiftDownLight: 0.28,
      shiftTime: 0.2, // s torque cut on upshift
      downshiftTime: 0.12,
      limiterCut: 0.07, // s of fuel cut when bouncing off the rev limiter
      rpmResponse: 16, // 1/s rpm smoothing on the ground
      freeRevResponse: 5, // 1/s rpm smoothing when airborne / clutch in
      engineBraking: 1.3, // (legacy, unused: coasting decel lives in brakes.coast*)
      turboSpool: 1.3, // 1/s turbo spool-up (perf engine ≥ 1)
      turboDecay: 3.5, // 1/s spool-down
      maxReverseKmh: 30,
      topGearSoftLimit: 0.035, // top gear: torque fades over the last 3.5% below redline (smooth top speed, no limiter bounce)
    },
    /** Per-model base parameters. torque = Nm per tonne of car mass (so models' masses keep their feel). */
    models: {
      // coupe = aggressive two-seater: quickest, sharpest, rev-happy (7.6k redline, short gearing), ≈205 km/h governed
      coupe: { refMass: 1300, torque: 240, redline: 7600, finalDrive: 4.74, drag: 0.45, gripFront: 1.14, gripRear: 1.22, sideFront: 1.1, sideRear: 1.08, stiffness: 1.12, damping: 1.05, comHeight: 0.38, driveFront: 0, steerMax: 0.62, brake: 1.05, downforce: 1.15 },
      muscle: { refMass: 1550, torque: 232, redline: 6400, finalDrive: 4.0, drag: 0.45, gripFront: 1.0, gripRear: 1.04, sideFront: 0.95, sideRear: 0.9, stiffness: 0.9, damping: 0.95, comHeight: 0.42, driveFront: 0, steerMax: 0.58, brake: 0.95, downforce: 0.8 },
      hatch: { refMass: 1080, torque: 205, redline: 7400, finalDrive: 5.05, drag: 0.55, gripFront: 1.06, gripRear: 1.14, sideFront: 1.05, sideRear: 1.02, stiffness: 1.05, damping: 1.0, comHeight: 0.4, driveFront: 1, steerMax: 0.64, brake: 1.0, downforce: 0.8 },
      suv: { refMass: 1900, torque: 214, redline: 6200, finalDrive: 4.4, drag: 0.62, gripFront: 0.98, gripRear: 1.06, sideFront: 0.95, sideRear: 0.98, stiffness: 0.78, damping: 1.05, comHeight: 0.52, driveFront: 0.45, steerMax: 0.56, brake: 0.95, downforce: 0.6 },
    },
    /** Performance upgrades (perf levels 1 and 2; level 0 = stock = ×1). */
    perf: {
      engineTorque1: 1.14, engineTorque2: 1.3,
      engineRedline1: 250, engineRedline2: 500, // +rpm
      engineFinal1: 0.97, engineFinal2: 0.94, // taller gearing → higher top speed
      turbo1: 0.08, turbo2: 0.15, // extra torque at full spool
      tyreGrip1: 1.09, tyreGrip2: 1.18,
      tyreSide1: 1.06, tyreSide2: 1.12,
      brake1: 1.2, brake2: 1.4,
      suspStiff1: 1.12, suspStiff2: 1.25,
      suspDamp1: 1.1, suspDamp2: 1.2,
      suspRoll1: 1.25, suspRoll2: 1.5,
      suspGrip1: 1.03, suspGrip2: 1.06,
    },
    /** Steering. Angle shrinks with speed: max / (1 + (v/falloffSpeed)^falloffPow), never below minAngle. */
    steer: {
      minAngle: 0.07, // rad at top speed
      falloffSpeed: 15, // m/s at which the lock is halved
      falloffPow: 1.3,
      rate: 5.5, // input units/s toward target at low speed (smooths digital touch/keys)
      rateHighSpeed: 2.8, // … at high speed
      returnRate: 8, // toward centre
      rateSpeed: 40, // m/s where rateHighSpeed applies
      countersteer: 0.75, // auto-countersteer gain on body slip angle (drift recovery)
      countersteerMax: 0.5, // rad
    },
    brakes: {
      decel: 11.0, // m/s² at full pedal (≈ 100→0 km/h in 2.4 s), capped per wheel by the tyre grip (ABS)
      frontBias: 0.64,
      absLimit: 0.92, // fraction of each tyre's grip (μ·load) the brakes may use — ABS: no lock-up, steering stays alive
      absPulse: 0.08, // ABS modulation depth when a wheel is at its grip limit
      absHz: 12,
      pedalRate: 14, // 1/s brake pedal ramp (fast bite)
      coastBase: 0.5, // m/s² coasting decel (engine braking + rolling drag, aero included) with no pedal pressed…
      coastPerSpeed: 0.1, // … + this × speed (m/s) …
      coastMax: 4.0, // … capped (≈ 14 km/h per second at high speed)
      oppositeBrake: 1.5, // m/s: rolling against the selected direction faster than this → the drive pedal brakes first
      handbrake: 0.9, // rear lock impulse in multiples of the rear axle's grip
      reverseBelow: 1.2, // m/s: brake pedal engages reverse below this forward speed
      parkHold: 0.6, // m/s: below this with no pedal the car holds still (no creeping)
    },
    tyres: {
      handbrakeRearSide: 0.08, // rear side-grip multiplier while the handbrake is held
      handbrakeRearGrip: 0.45, // rear friction multiplier while the handbrake is held
      driftRearSide: 0.5, // rear side grip held while power-sliding (slip > driftSlipDeg, throttle, steering into the turn)
      driftSlipDeg: 9,
      driftTargetDeg: 30, // drift assist: rear grip is modulated to hold about this slip angle while power-sliding
      driftGripGain: 0.035, // rear side-grip change per degree of slip error
      driftThrust: 3.2, // m/s² arcade push along the velocity while power-sliding (drifts keep their flow instead of scrubbing)
      gripDropRate: 10, // 1/s rear grip falls when the handbrake is pulled
      gripRecoverRate: 1.3, // 1/s rear grip returns after the handbrake/drift
      highSpeedSide: 0.85, // side stiffness multiplier at top speed (calmer at speed)
      slipLatStart: 1.2, // m/s lateral slip at which skid output begins
      slipLatFull: 6, // m/s lateral slip for full skid
      launchSlip: 0.65, // wheelspin/smoke intensity when launching flat out in 1st
      launchSlipSpeed: 7, // m/s below which launch wheelspin happens
      surface: { asphalt: 1, concrete: 1, metal: 0.9, wood: 0.95, plastic: 0.9, glass: 0.85, foliage: 0.75, grass: 0.72, sand: 0.62, water: 0.45, flesh: 0.8, rock: 0.9, snow: 0.5, dirt: 0.78, gravel: 0.72 },
      surfaceDrag: { sand: 2.2, grass: 1.0, water: 5, foliage: 1.2, dirt: 0.5, gravel: 0.8, snow: 1.0 }, // extra m/s² rolling drag
    },
    aero: {
      rolling: 0.012, // rolling resistance (× m g)
      downforce: 1.5, // N per (m/s)² per tonne (scaled by model downforce)
    },
    /** Stability assists. */
    assist: {
      bodyRoll: 0.36, // m: lateral-accel roll moment arm (Rapier suppresses tyre roll moments → add visible, weighty body roll)
      rollStiffness: 10, // 1/s² righting accel per rad of roll (relative to ground) when grounded
      rollDamping: 4.5, // 1/s
      rollLimitDeg: 14, // beyond this roll, righting gets 3× stronger (curbs/two-wheeling)
      yawDamping: 3.2, // ESC: 1/s correction of yaw rate beyond what the steering asks for
      handbrakeEsc: 0.0, // ESC multiplier while the handbrake is held
      driftEsc: 0.25, // ESC multiplier while power sliding
      escRecover: 1.2, // 1/s ESC fade-back after handbrake/drift
      maxSlipDeg: 52, // body slip angle limiter (no spin-outs unless forced) at low speed…
      maxSlipHighDeg: 24, // … shrinking to this at maxSlipHighKmh
      maxSlipHighKmh: 200,
      escHighSpeed: 1.0, // extra ESC gain per 50 m/s of speed
      slipLimiter: 7, // 1/s² per rad beyond maxSlip
      wheelbaseFallback: 2.6,
    },
    /** Air control. Accelerations in rad/s². */
    air: {
      pitch: 5,
      roll: 4.5,
      yaw: 3,
      autoLevel: 5, // pulls toward the landing surface normal for clean landings
      takeoffPitchDamp: 7, // 1/s pitch-rate damping right after leaving a ramp (keeps the ramp angle, no nose dive)
      takeoffTime: 0.35, // s
      damping: 1.4, // 1/s angular velocity damping (pitch/roll) while airborne
      delay: 0.15, // s without wheel contact before air control engages
    },
    recovery: {
      stuckTime: 2, // s upside down / stuck before the "Flip car" prompt
      upDot: 0.35, // car up·world up below this = on its side / roof
      stuckSpeed: 1.0, // m/s
      flipLift: 1.1, // m above the ground
      flipDuration: 0.5, // s righting animation
    },
    impact: {
      eventDv: 0.15, // m/s per step: contact-force event threshold (Δv = F·dt/m)
      minDv: 1.0, // m/s Δv for an impact event
      maxDv: 20, // m/s Δv = strength 1 (≈ a 70 km/h wall hit)
      cooldown: 0.22, // s per partner
      scrapeSpeed: 2.5, // m/s sliding speed along a surface for a scrape
      scrapeFull: 18, // m/s = scrape intensity 1
      vibrateMin: 0.35, // strength above which we ask for haptics
      groundScale: 0.35, // strength multiplier for belly/landing hits on the ground
    },
    damage: {
      dentMin: 0.12, // impact strength needed to dent
      dentScale: 1.0,
      glassCrack: 0.45, // single-hit strength to crack the glass
      glassShatter: 0.8,
      glassCrackAccum: 1.2, // accumulated strength
      glassShatterAccum: 2.6,
      bumperHang: 0.6, // accumulated strength per end → bumper hangs
      bumperDetach: 1.5, // → bumper falls off
      bumperZone: 0.45, // |local z| > halfLength × this = bumper zone
    },
    explosion: {
      radius: 14,
      force: 1,
      upSpeed: 9, // m/s thrown up
      sideSpeed: 2.5, // m/s random horizontal
      spin: 3.2, // rad/s random tumble
      radialStrength: 13, // m/s at the centre (props / parked cars / old debris)
      radialUpBias: 0.6,
      debrisSpeed: 8, // m/s outward for detached parts
      debrisUp: 6,
      debrisSpin: 8,
      charTime: 0.7, // s to fully char the body
      maxDebris: 18,
      debrisNoPlayerTime: 0.6, // s before fresh debris can collide with the car
    },
    // ─── Part 3 ───
    /** Turbo (SPEC-PART3 §7). */
    turbo: {
      drainTime: 6, // s of continuous boost from full
      rechargeTime: 10, // s to refill when not boosting
      highwayRecharge: 2, // recharge multiplier above highwayRechargeKmh on a highway
      highwayRechargeKmh: 120,
      airDrain: 1.5, // drain multiplier while airborne (glide)
      minRestart: 0.12, // charge needed to restart after running dry
      buildIn: 0.3, // s for the push to build in
      release: 0.12, // s to fade out on release
      accel: 7.5, // m/s² extra push (≈2.5× normal acceleration) — perf.turbo multiplies
      topFactor: 1.58, // turbo top speed = car's normal top speed × this (stock coupe ≈ 205 → ≈ 320 km/h)
      fadeSpeed: 8, // m/s below turbo top speed where the push fades out
      noseLift: 0.8, // rad/s pitch-up kick on activation (≈2–3° nose lift, then settles)
      steerGain: 0.25, // +25% steering response / lock while boosting
      sideGrip: 0.85, // tyre side-grip ratio while boosting (−15%)
      escScale: 0.5, // stability assist halved while boosting
      wobbleYaw: 6, // rad/s² low-frequency yaw wobble at wobbleFullKmh (tyres damp most of it → a few degrees)
      wobbleFreq: 0.55, // Hz
      shake: 9, // rad/s² high-frequency roll/pitch body shake at wobbleFullKmh
      shakeFreq: 8, // Hz
      wobbleStartKmh: 90,
      wobbleFullKmh: 320,
      lowGripWild: 1.1, // wobble/kick multiplier per unit of lost grip (rain ≈ ×1.3, snow ≈ ×1.6) — softened: snow was 16° slip
      liftOffYaw: 0.3, // rad/s yaw kick when releasing turbo mid-corner
      liftOffRearSide: 0.55, // rear side grip during the lift-off kick
      liftOffTime: 0.45, // s
      liftOffMinYawRate: 0.1, // rad/s cornering needed for the kick
      perfAccel1: 1.15, perfAccel2: 1.3, // perf.turbo levels
      perfTop1: 0.08, perfTop2: 0.16, // + topFactor
      perfDrain1: 1.15, perfDrain2: 1.3, // × drainTime
    },
    /** Airborne mode, landings, barrel roll (SPEC-PART3 §8, §8a). */
    stunts: {
      minKmh: 60, // takeoff speed for airborne mode
      enterAir: 0.12, // s with no wheel contact before checking
      minPredicted: 0.45, // s predicted total air time to enter airborne mode
      minStuntAir: 0.5, // s air time for landing pop-ups
      badLandingDeg: 45, // roll/pitch beyond this (or roof/nose first) = crash landing
      crashExplodeSpeed: 24, // m/s impact speed of a crash landing that blows the car up
      crashDamage: 0.7, // dent/glass strength of a crash landing
      rollMinAir: 0.8, // s predicted air time needed for a barrel roll
      rollTimeFrac: 0.7, // finish the 360° in this fraction of the remaining air time
      rollMinTime: 0.45, // s fastest roll
      rollMaxTime: 1.4, // s slowest roll
      rollStabiliseDeg: 60, // last degrees auto-stabilised to come out level
      megaAirTime: 2.2, // s predicted air time = mega jump (slow-mo dip on rolls)
      slowMoScale: 0.6,
      slowMoTime: 0.4,
      predictStep: 0.1, // s ballistic prediction step (ray per step)
      predictMax: 6, // s
    },
    /** Turbo in the air = glide (SPEC-PART3 §8b). */
    glide: {
      liftAtRef: 0.85, // lift as a fraction of weight at refKmh
      refKmh: 250,
      maxLift: 0.88, // cap (fraction of weight) — always a slow descent
      drag: 0.35, // extra N per (m/s)² per tonne while gliding
    },
    /** Weather & environment effects on the car. */
    weather: {
      aquaThreshold: 0.35, // puddle depth that triggers aquaplaning
      aquaMinKmh: 60,
      aquaTime: 0.3, // s of light steering
      aquaGrip: 0.35, // front grip multiplier while aquaplaning
      aquaSide: 0.25, // front side-grip multiplier while aquaplaning
      crosswind: 3.2, // N per (m/s)² of lateral wind at full effect
      crosswindMinKmh: 60,
      crosswindFullKmh: 220,
      bridgeWind: 2.2, // multiplier on bridges
      bridgeHeight: 6, // m of road above terrain = bridge
    },
    /** Player headlights: ONE SpotLight pair created at init (intensity 0 when off). */
    headlights: {
      autoNight: 0.3, // env.nightFactor above this → lights on automatically
      autoFog: 0.5, // weather.fog above this → lights on
      lowIntensity: 28, lowDistance: 48, lowAngle: 0.52, lowPitch: -0.07,
      highIntensity: 55, highDistance: 110, highAngle: 0.36, highPitch: -0.015,
      penumbra: 0.55,
      decay: 1.4,
      height: 0.62, // m above the car origin
      inset: 0.12, // m behind the front of the chassis box
      spread: 0.58, // m from the centre line
    },
    /** Wheel visuals while driving. */
    wheelVisual: {
      camberMaxDeg: 8, // stance.camber = 1 → tops tilted inward by this (matches the garage preview)
    },
    /** Frozen chassis after reset/teleport until terrain colliders are ready. */
    freeze: {
      radius: 60, // m of terrain that must be loaded
      maxTime: 5, // s
      parkSettle: 1.5, // s still in plane mode before the parked car is frozen
    },
  },

  // ───────────────────────────── camera (owner: src/camera) ─────────────────────
  camera: {
    fov: 62, // chase FOV at rest (vertical, designed for 16:9 — see aspect* below). Engine reads fov/near/far at boot.
    near: 0.1,
    far: 1500,
    // chase
    fovMax: 78, // chase FOV at speedRef
    speedRef: 55, // m/s (~200 km/h) where speed-driven effects max out
    distance: 6.3, // m behind the car's center at rest (scaled by car length)
    distanceMax: 8.6, // at speedRef
    height: 1.7, // m above the car's center at rest (scaled by car height)
    heightMax: 2.05,
    lookHeight: 0.5, // aim point above the car's center
    lookAhead: 1.5, // m ahead of the car at rest
    lookAheadMax: 6.5,
    headingSmooth: 0.22, // s, heading spring at speed
    headingSmoothSlow: 0.42, // s, heading spring at low speed
    headingSmoothAir: 0.65, // s, airborne / tumbling (follows the flight path)
    velFollow: 0.22, // 0..1 lean toward the velocity direction while gripping
    driftFollow: 0.62, // 0..1 lean toward the velocity direction while sliding (shows the drift angle)
    turnLead: 0.14, // s of yaw rate → aim into the turn
    turnLeadMax: 0.12, // rad
    turnRoll: 0.03, // rad max bank into turns
    inertia: 5.5, // 1/s stiffness of the inertia offset (crash surge, acceleration lag, landing dip)
    inertiaMax: 1.5, // m soft limit of the inertia offset
    inertiaVertical: 0.55, // vertical share of the inertia
    pivotSmooth: 0.07, // s vertical filtering of the follow point (suspension jitter)
    pivotSmoothAir: 0.14,
    distSmooth: 2.2, // 1/s distance/height response
    fovSmooth: 2.4, // 1/s FOV response
    boostFov: 3, // extra degrees at full turbo boost
    airPullback: 0.14, // extra distance fraction on long jumps
    sizeScale: 1, // global multiplier for car-size distance scaling
    zoomMin: 0.75, // mouse-wheel zoom range (multiplier on distance)
    zoomMax: 1.6,
    zoomStep: 0.1, // per 100 px of wheel delta
    wreckDistance: 1.35, // distance multiplier around a burning wreck
    wreckHeight: 1.55,
    wreckOrbit: 0.1, // rad/s slow orbit around the wreck
    // occlusion & ground
    occlusionMargin: 0.35, // m kept between the camera and a wall
    occlusionMinDist: 1.6, // m closest pull-in
    occlusionIn: 22, // 1/s pull-in speed
    occlusionOut: 2.0, // 1/s ease-back speed
    occlusionLift: 1.0, // m raised when fully pulled in (look over the car)
    groundClearance: 0.45, // m above ground / water
    // hood
    hoodFov: 70,
    hoodFovMax: 84,
    hoodHeight: 0.3, // m above the hood surface (auto-detected)
    hoodForward: 0.4, // m forward of the windshield base
    hoodPitch: 0.0, // rad look-down
    nearHood: 0.08, // near plane in the hood cam (chase uses `near`)
    hoodSmooth: 18, // 1/s pitch/roll smoothing
    hoodStabilize: 0.55, // 0..1 roll horizon stabilization
    hoodShake: 0.45, // shake multiplier in the hood cam
    freeLookReturn: 1.6, // s idle before hood free-look recenters
    // orbit / look-back
    orbitSensitivity: 0.0055, // rad per pixel dragged
    orbitReturnDelay: 2.5, // s idle before returning to chase
    orbitBlend: 0.9, // s glide back to chase
    orbitAutoRotate: 0.14, // rad/s turntable when parked in orbit mode
    orbitPitchMin: -0.05,
    orbitPitchMax: 1.25,
    lookBackBlend: 0.16, // s whip-around (0 = cut)
    // explosion cinematic
    cineEnabled: 1, // 0 = no cinematic, shake only
    cineDuration: 3.0, // s (real time)
    cineRadius: 8, // m orbit radius at start
    cineRadiusEnd: 13,
    cineHeight: 0.9, // m above the blast at start (low angle)
    cineHeightEnd: 3.2,
    cineSpin: 0.5, // rad/s orbit speed
    cineFov: 64,
    cineFovEnd: 52,
    cineRoll: 0.07, // rad dutch tilt at mid-shot
    cineBlendIn: 0.35, // s
    cineBlendOut: 1.0, // s back to chase
    // shake
    shakeDecay: 1.1, // trauma per second
    shakeFreq: 16, // Hz-ish noise speed
    shakeMaxAngle: 0.05, // rad yaw/pitch at full trauma
    shakeMaxRoll: 0.07, // rad
    shakeMaxOffset: 0.18, // m
    explosionShake: 1.0, // trauma added by a point-blank explosion
    explosionShakeRange: 70, // m where explosion shake fades out
    explosionShakeTime: 1.6, // s for that trauma to decay
    fovKick: 9, // degrees punched out by a point-blank blast
    fovKickDecay: 4, // 1/s
    impactShake: 0.55, // trauma per unit impact strength
    impactMin: 0.06, // ignore weaker impacts
    landingShake: 0.4, // trauma for a hard landing
    vibrationFreq: 30,
    vibrationAngle: 0.0035, // rad at full vibration
    vibrationOffset: 0.012, // m
    speedShake: 1, // vibration amount at top speed
    speedShakeStart: 0.6, // fraction of speedRef where vibration starts
    offroadShake: 0.8, // vibration on grass / sand
    // showcase (title / menu tour)
    showcaseShot: 8.5, // s per shot
    showcaseFadeOut: 0.6,
    showcaseHold: 0.3, // s held dark at a cut (lets streaming catch up)
    showcaseFadeIn: 0.9,
    // aspect-aware FOV
    aspectRef: 1.7778, // aspect the FOVs are designed for
    aspectWideK: 0.5, // 0 = keep vertical FOV, 1 = keep horizontal FOV (wider screens)
    aspectNarrowK: 0.6, // same, for narrower screens (tablets)
    // part 3: turbo, stunts, tunnels
    turboFov: 15, // degrees kicked in while turbo is active (SPEC-PART3: +12–18°)
    turboPullback: 0.14, // extra chase distance fraction while boosting
    turboLower: 0.2, // chase height reduction fraction while boosting
    turboShake: 0.22, // trauma on turbo activation
    turboPunch: 5, // FOV punch (deg) on activation
    turboVibration: 0.6, // continuous body-shake vibration while boosting
    airFov: 4, // extra degrees in big air
    rollOrbit: 0.9, // rad side swing to show a barrel roll
    rollShowTime: 1.2, // s of swing when the roll is only reported by event
    landingBump: 3, // m/s vertical camera kick on a clean landing
    tunnelCloser: 0.12, // distance reduction fraction in tunnels
    tunnelLower: 0.3, // height reduction fraction in tunnels
    // part 2: planes
    planeFar: 14000, // max far plane at altitude
    planeBoardBlend: 1.5, // s camera move car → plane
    planeExitBlend: 1.0, // s plane → car
    planeDistBase: 6, // chase distance = base + size × K (closer: user wants to see the plane)
    planeDistK: 0.78,
    planeHeightK: 0.22, // chase height = 2 + size × K
    planeFov: 60,
    planeFovSpeed: 10, // extra degrees at planeSpeedRef
    planeSpeedRef: 140, // m/s
    planeYawSmooth: 0.35, // s
    planePitchSmooth: 0.45,
    planeRollSmooth: 0.5,
    planePitchFollow: 0.75, // share of the plane's pitch the chase follows
    planeRollFollow: 0.35, // share of the bank the chase follows (horizon tilts a little)
    planeTailWiden: 0.6, // extra distance with the tail blown off (keep the smoke ribbon in frame)
    planeInertiaMax: 4, // m
    planeCockpitFov: 70,
    planeWingFov: 58,
    planeCockpitShake: 0.6, // shake multiplier in mounted plane views
    planeLookReturn: 2, // s idle before free look recentres
    planeEngineShake: 0.45, // trauma for a nearby engine explosion
    cockpitSeqShake: 0.42, // minimum trauma during the middle-split cockpit fall
    planeCineDuration: 2.6, // s orbit around the fireball before following the biggest piece
    planeCineDrag: 1.6, // s drag time constant of the streaking fireball
    crashShotTime: 4, // s of crash shot before settling on the wreck
    crashWaterHeight: 0.8, // m above the waves for water-level crash shots
  },

  // ───────────────────────────── car models (owner: src/vehicle/models) ─────────
  carModels: {
    maxDent: 0.12, // m, deepest single dent
    maxDeform: 0.16, // m, cap on accumulated vertex displacement
    dentScale: 1.0, // multiplier on dent(strength) (strength ~0..1 normal hit, up to 2)
    lampIntensity: 1.0, // global emissive multiplier for lamps
    headOn: 6.0, // headlight lens emissive when on
    drlOn: 3.0, // daytime-running strip with headlights on
    drlDay: 1.4, // daytime-running strip during the day
    tailOn: 1.6, // taillights with headlights on (×1.4 at full night)
    tailDay: 0.45,
    brakeOn: 4.5,
    reverseOn: 5.0,
    underglowDay: 0.35, // ground glow strength by day
    underglowNight: 1.15, // ...and at full night
    fakeBeam: true, // ground beam decal for low-LOD cars with headlights on at night
    beamNight: 0.55,
  },

  // ───────────────────────────── garage (owner: src/ui/garage) ──────────────────
  garage: {
    fov: 34, // deg, product-shot lens
    turntableSpeed: 0.16, // rad/s
    idleResume: 2.6, // s after the last orbit/zoom before the turntable resumes
    orbitSpeed: 0.0085, // rad per dragged px
    orbitInertia: 4.5, // 1/s decay of the orbit fling
    pitchMinDeg: 2,
    pitchMaxDeg: 58,
    zoomMin: 0.6, // × the per-model framing distance
    zoomMax: 1.75,
    defaultYawDeg: 38, // camera 3/4 front-left
    defaultPitchDeg: 12,
    rideHeightVisual: 1.4, // preview body offset = vehicle.suspension.rideHeightRange × this (slightly exaggerated)
    camberMaxDeg: 8,
    showroomSteerDeg: 12, // front wheels turned for the showroom pose
    reflectionScale: 0.5, // floor mirror resolution × drawing buffer (medium/high quality)
    reflectionStrength: 1.0, // × fresnel reflectance of floor / lacquered disc
    envIntensity: 1.0,
    exposure: 1.0, // tone-mapping exposure while the garage is open (restored on close)
    keyLight: 2.2,
    fillLight: 0.75,
    rimLight: 1.7,
  },

  // ───────────────────────────── crash replay (owner: src/replay) ──────────────────
  // seconds recorded (hz samples/s), playback starts leadIn s before the first big moment, slow motion (slowSpeed)
  // within slowWindow s of explosions / impacts, the auto-director cuts every shotSeconds.
  replay: { seconds: 14, hz: 30, leadIn: 3.5, slowSpeed: 0.3, slowWindow: 1.4, shotSeconds: 2.8 },

  // ───────────────────────────── missiles, nukes, sky traffic (owner: src/missiles) ─────────────────────
  missiles: {
    // perpetual traffic: planes kept in the sky per quality, spawn ring / despawn distance (m), wrecks kept (s)
    traffic: { count: { low: 6, medium: 10, high: 14 }, spawnR: 5600, despawnR: 7600, wreckKeepS: 150 },
    // rad between the aim and the target for a lock-on (no lock needed to fire). The reticle circle is drawn exactly this
    // big, so "the box inside the circle" = locked (it was 0.35: you started locked, aiming changed nothing you could see)
    lockCone: 0.15,
    seekCone: 0.45, // rad: an unlocked missile's seeker picks the plane up inside this cone…
    seekRange: 6000, // …within this distance (m)
    unguidedS: 18, // s an unlocked missile flies before self-destructing
    terminal: 140, // m: inside this the missile flies straight at its aim point (it never misses)
    impactHold: 6, // s watching the hit plane go down before the control room view returns
    nuke: { fireball: 240, skyRadius: 1800, groundRadius: 700 },
  },

  // ───────────────────────────── on foot (owner: src/walk) ─────────────────────
  // Walking in plane cabins / falling out / on the ground. splitCoupling: share of a SPLIT piece's acceleration you
  // feel (the rest: you fall faster than the wreck — cinematic); minFallG: a split/diving plane never lets you float
  // up (min downward pull, × g). suction: m/s² pull toward a torn-open end at speed (within suctionRange m).
  walk: {
    // user: the old sprint is the walk now; outside the plane everything is twice as fast (room to walk around)
    walk: 3.6, run: 5.4, outsideMul: 2, accel: 14, jump: 3.4, eye: 1.62, sitEye: 1.16, friction: 0.85, minSupport: 2.5,
    splitCoupling: 0.35, minFallG: 0.35, maxFrameAccel: 60, suction: 14, suctionRange: 9, maxSpeed: 26,
    airDrag: 0.0036, skydiveSteer: 4, hardLanding: 9, lookSens: 0.0024, touchLook: 1.9,
    tpDist: 2.4, tpDistWorld: 4.2, fovFP: 74, fovTP: 66,
    // passengers + crew (user request): share of seats taken, max per type, share out of their seats (unbelted),
    // flight attendants, scream loudness (mild), crew walking speed, max camera distance to draw them when torn open
    cabin: { share: 0.3, max: { prop: 0, bizjet: 3, airliner: 26, jumbo: 40 }, looseShare: 0.1, crew: 2, screamLevel: 0.55, crewSpeed: 1.1, showDist: 260 },
  },

  // ───────────────────────────── pedestrians (owner: src/npc) ───────────────────
  npc: {
    poolSize: 240, // max simultaneous dynamic NPCs (incl. crowd members taken over after a hit / scare)
    spawnMin: 40, // m: spawn ring around the focus (never pops in view inside farSpawn)
    spawnMax: 150,
    despawn: 172, // m: recycled beyond this
    farSpawn: 125, // m: in-view spawns allowed beyond this distance (dither fade-in)
    fadeTime: 0.6, // s dither fade in/out
    lod0Dist: 14, // m: hero mesh (detailed)
    lod1Dist: 46, // m: mid mesh; beyond = boxy far LOD
    maxLod0: { low: 6, medium: 14, high: 32 }, // nearest N only get the hero mesh
    shadowDist: 85, // m: blob shadows
    castShadows: true, // hero LOD casts real shadows on 'high' (blob shadows elsewhere)
    walkSpeed: 1.32, // m/s base (× personal pace)
    runSpeed: 4.4,
    rainHurry: 1.35, // walk speed multiplier in heavy rain
    dangerKmh: 14, // car faster than this predicted to hit → step aside / dive / run
    predictTime: 1.7, // s of swept car path checked
    dangerMargin: 1.2, // m added around the car box for the predicted path
    calmDodgeKmh: 34, // below this car speed people jog out of the way instead of diving
    freezeMax: 0.4, // max share of people who freeze in front of a very fast car (they get hit)
    hitKmh: 5, // knockdown above this (shove/stumble below)
    hitInflate: 0.45, // m the car box is inflated for pedestrian hits (forgiving)
    hitRadius: 0.34, // m pedestrian cylinder radius for hits
    hornRadius: 25,
    lookRadius: 14, // NPCs track a passing car with their heads within this
    maxRagdolls: 5, // pooled Rapier capsules for the closest car hits (everyone else: analytic tumble)
    maxReactPerFrame: 8, // staggered reaction starts (explosions, crowd take-overs)
    launchMax: 15, // m/s cap on knockdown launch speed
    carBump: 0.05, // fraction of car speed removed per pedestrian hit (a bump, never a wall)
    carBumpMax: 1.3, // m/s
    lieMin: 2,
    lieMax: 4,
    explosionFlee: 2.2, // × blast radius: flee + scream
    altitudeHide: 80, // m AGL in plane mode: crowd disabled
    nightDensity: 0.28, // density multiplier in the dead of night (clock 1-4 h)
    rainDensity: 0.35, // density multiplier in heavy rain / storm
    mix: { walker: 0.5, group: 0.15, bench: 0.13, bus: 0.08, wander: 0.14 },
    crowds: {
      sizeMin: 10,
      sizeMax: 30,
      materializeR: 260, // m: static crowds appear within this radius (nearest first; far LOD is cheap)
      midDist: 40, // m: mid mesh closer than this (from the crowd edge), far mesh beyond
      budget: { low: 70, medium: 150, high: 260 }, // max static crowd members at once (concert: own budget)
      rejoinAfter: 14, // s: a calmed-down member walks back into its crowd (when unseen)
      // The beach CONCERT (CityData.concert): the floor in front of the stage is split into ~tile-m blocks, packed
      // areaFront m² per fan at the barrier → areaBack at the back; own member budget, seen from much farther.
      // midDist: concert tiles switch to the detailed mid mesh only this close (1780 vs 288 tris per fan); phones ×mobile.
      concert: { tile: 7.5, areaFront: 1.2, areaBack: 1.9, materializeR: 520, perFrame: 4, budget: { low: 420, medium: 950, high: 1150 }, midDist: { low: 4, medium: 12, high: 22 }, mobile: 0.5 },
    },
    testWorld: 'auto', // 'auto' = temporary ped graph when the world has none (also ?npctest)
  },

  // ───────────────────────────── effects (owner: src/fx) ────────────────────────
  fx: {
    // particle caps per quality level (total, split main/glow), skid segments; pools are resized on quality change
    caps: { low: 3000, medium: 8000, high: 20000 },
    glowShare: 0.45, // fraction of the cap given to the glow pool (fire, sparks, embers)
    decalCap: 32,
    skidCap: { low: 1000, medium: 1600, high: 2000 },
    lights: { low: 1, medium: 2, high: 3 }, // pooled point lights, created once at init (count fixed per session)
    nearFade: [0.25, 1.4], // m: sprites whose front is closer than this to the camera fade (fill-rate + clipping)
    nightDim: 0.2, // lit smoke brightness at full night
    minPixels: 2, // minimum on-screen sprite size (px) so sparks/embers never vanish
    windScale: 1, // × env wind (GLOBAL_UNIFORMS.uWind / env.wind) for smoke & fire drift
    fallbackBlast: true, // simple mesh fireball if the particle path fails (init error / shader failure)
    ambient: '#7d7fa6', // smoke shade colour (lavender, never black)
    clearJump: 12, // s the fx clock jumps on clearAll (> max spawn delay)
    explosion: {
      refRadius: 14, // event blast radius that maps to fireballRadius (fireball scales with sqrt of the ratio)
      fireballRadius: 6, // m, car explosion fireball radius at scale 1
      counts: { fireball: 34, smoke: 26, sparks: 72, debris: 34, embers: 46, dust: 34, streamers: 7, secondary: 2 },
      fireballSpeed: 2.4, // × radius m/s radial expansion speed
      fireballDrag: 3.6,
      fireballLift: 2.8, // × radius^0.75 m/s² buoyancy
      fireballLife: [1.1, 1.9],
      fireballHeat: [1.5, 2.2],
      smokeLife: [4.5, 7.5],
      sparkSpeed: [9, 28],
      debrisSpeed: [5, 17],
      shockLife: 0.34,
      shockGrow: 3.4, // × radius: shock dome final radius
      ringLife: 1.25,
      ringGrow: 4.2, // × radius: ground dust ring final radius
      scorchSize: 1.15, // × radius (diameter)
      scorchLife: 45,
      columnSeconds: 9,
      columnRate: 6, // puffs/s at start
      flashIntensity: 1500, // candela at scale 1
      flashDecay: 7, // 1/s
      flashDistance: 12, // × radius light range
      groundMaxHeight: 1.6, // × radius: no ground ring/scorch above this altitude
      inherit: { fireball: 0.9, smoke: 0.6, sparks: 1.0, debris: 1.0 },
    },
    fire: {
      flameRate: 40, // /s at size 1
      smokeRate: 11,
      emberRate: 7,
      spread: 0.55, // × size jitter radius
      flameSize: [1.4, 2.1],
      flameLife: [0.45, 0.85],
      smokeSize: [4.5, 6],
      smokeLife: [3, 4.6],
      inheritFlame: 0.85,
      inheritSmoke: 0.6,
      airStretch: 0.03, // s of motion stretch on flames when the emitter moves fast
      fadeIn: 0.4,
      fadeOut: 1.2,
      glowIntensity: 35, // candela at size 1
      maxFires: 8,
      maxPerFrame: 40, // spawn cap per emitter per frame
      autoWreckFire: true, // attach a fire to the exploded player car if nobody else does
      autoDelay: 0.3,
      autoOffset: [0, 0.55, 0.85],
    },
    skid: { slipThreshold: 0.32, minSegment: 0.2, maxSegment: 4, width: 0.24, lift: 0.025, opacity: 0.62, fadeTime: 22, color: '#141418', gougeFade: 60, gougeOpacity: 0.85, gougeColor: '#2a2118' },
    tyreSmoke: { slipThreshold: 0.45, rate: 26, size: [0.6, 3.2], life: [1.4, 2.6] },
    dust: { rate: 24, minSpeed: 2.5, size: [0.5, 2.6], life: [0.9, 1.8], sand: '#e6d1a4', grass: '#a69a6c', other: '#c9bfae', snow: '#f4f7fb' },
    spray: { rate: 30, minSpeed: 2, wetRate: 34 },
    water: { foamLife: 14, sheetRate: 160 },
    rain: { splashRate: 90, radius: 14 },
    turbo: { flameRate: 110, size: 1, popInterval: [0.35, 1.1], heatRate: 26 },
    glide: { spacing: 0.22, life: [1.1, 1.7], size: [0.14, 0.7] },
    sparks: { impactThreshold: 0.22, impactCount: 26, scrapeRate: 110, size: [0.05, 0.09], stretch: 0.035, life: [0.3, 0.85] },
    glass: { life: [1.3, 2.4] },
    propBits: 7,
  },

  // ───────────────────────────── audio (owner: src/audio) ───────────────────────
  audio: {
    // mix — bus gains are multiplied by settings volumes (slider^volumeCurve) and state ducking
    masterGain: 0.9,
    volumeCurve: 1.7,
    busGain: { engine: 0.85, sfx: 0.85, ambience: 0.65, ui: 0.5 },
    // beach concert live music (ambience bus): level at the stage, 1 / (1 + (d / refDist)^1.5) falloff, silent past maxDist
    concert: { level: 0.6, refDist: 45, maxDist: 850 },
    compressor: { threshold: -18, knee: 12, ratio: 3.5, attack: 0.004, release: 0.22 },
    limiter: { threshold: -2.5, knee: 0, ratio: 20, attack: 0.001, release: 0.09 },
    reverb: { seconds: 2.6, secondsLow: 1.4, lowDecay: 0.62, highDecay: 0.22, returnGain: 0.55, earlyTaps: 7 },
    // state ducking: bus multipliers + world lowpass cutoff (Hz)
    duck: {
      driving: { engine: 1, sfx: 1, ambience: 1, cutoff: 20000 },
      paused: { engine: 0, sfx: 0, ambience: 0.45, cutoff: 650 },
      garage: { engine: 0, sfx: 0, ambience: 0.22, cutoff: 500 },
      menu: { engine: 0.6, sfx: 0.7, ambience: 0.8, cutoff: 20000 },
      title: { engine: 0.6, sfx: 0.7, ambience: 0.8, cutoff: 20000 },
      boot: { engine: 0, sfx: 0, ambience: 0, cutoff: 20000 },
      duckTau: 0.25, // s smoothing of state ducking
      explosionAmbience: 0.25, // ambience multiplier right after a blast (recovers over explosionRecover s)
      explosionRecover: 2.5,
    },
    maxVoices: { low: 14, medium: 22, high: 30 },
    spatial: { refDistance: 7, rolloff: 0.9, maxDistance: 190, panWidth: 0.85, airNear: 25, airFarHz: 2200 },

    engine: {
      level: 1.3,
      rpmSmooth: 22, // 1/s
      loadAttack: 10, // 1/s throttle → load smoothing
      loadRelease: 5,
      idleLoad: 0.22, // minimum load blend (an idling engine still fires)
      offLevel: 0.62, // off-throttle layer level relative to on-load
      lpMin: 1500, // runtime lowpass: closed throttle, low rpm
      lpMax: 13000,
      intakeLevel: 0.12,
      limiterNorm: 0.985, // rpmNorm above which the rev-limiter bounce kicks in (with throttle)
      limiterHz: 13,
      limiterDepth: 0.6,
      shiftDip: 0.32, // gain during an upshift cut
      shiftCutMs: 110,
      reverseWhine: 0.05,
      turboWhistle: 0.05,
      turboWhoosh: 0.07,
      superchargerWhine: 0.045,
      blowoffLevel: 0.32,
      popLevel: 0.5,
      starterLevel: 0.35,
      sleepAfter: 2.5, // s without a car before the engine graph is torn down
      bakeBudgetMs: 6, // per-frame time budget for baking engine loops
      loopSeconds: 1.2,
    },
    // per-model engine character (baked through a pulse-train → exhaust resonator → formants model)
    models: {
      muscle: {
        cylinders: 8, banks: [0, 1, 1, 0, 1, 0, 0, 1], bankDelayMs: 0.9, // cross-plane V8 bank pattern → burble
        bakeRpm: [750, 1600, 2700, 4000, 5700],
        attackMs: 0.25, decayOnMs: 2.0, decayOffMs: 3.4, ringHz: 420, ringMs: 2.6, ringOn: 0.55, ringOff: 0.2,
        noiseOn: 0.35, noiseOff: 0.14, jitterOn: 0.1, jitterOff: 0.3, timingJitter: 0.02, cylVariance: 0.09,
        misfireOff: 0.07, popOff: 0.06,
        pipeHz: [68, 75], pipeFb: 0.55, pipeDampHz: 900,
        formants: [[95, 1.4, 1.3], [260, 2.4, 0.6], [720, 3, 0.32]], dry: 0.55,
        lowpassOn: 1900, lowpassOff: 950, drive: 1.8,
        level: 1.0, popiness: 1.0, burble: 1.0, shiftPop: 0.3, horn: [311, 392], squeal: 1.0,
      },
      coupe: {
        cylinders: 6, banks: [0, 0, 0, 0, 0, 0], bankDelayMs: 0,
        bakeRpm: [850, 2000, 3400, 5000, 7000],
        attackMs: 0.15, decayOnMs: 1.2, decayOffMs: 2.2, ringHz: 950, ringMs: 2.0, ringOn: 0.8, ringOff: 0.25,
        noiseOn: 0.45, noiseOff: 0.16, jitterOn: 0.06, jitterOff: 0.18, timingJitter: 0.012, cylVariance: 0.04,
        misfireOff: 0.03, popOff: 0.05,
        pipeHz: [112, 112], pipeFb: 0.45, pipeDampHz: 2200,
        formants: [[180, 1.5, 0.9], [620, 2.5, 0.6], [1500, 3, 0.42]], dry: 0.6,
        lowpassOn: 4300, lowpassOff: 1800, drive: 1.6,
        level: 0.95, popiness: 0.8, burble: 0.6, shiftPop: 0.35, horn: [415, 523], squeal: 1.05,
      },
      hatch: {
        cylinders: 4, banks: [0, 0, 0, 0], bankDelayMs: 0,
        bakeRpm: [900, 2100, 3500, 5100, 6900],
        attackMs: 0.12, decayOnMs: 0.9, decayOffMs: 1.8, ringHz: 1300, ringMs: 1.6, ringOn: 0.6, ringOff: 0.22,
        noiseOn: 0.5, noiseOff: 0.18, jitterOn: 0.07, jitterOff: 0.2, timingJitter: 0.015, cylVariance: 0.05,
        misfireOff: 0.03, popOff: 0.03,
        pipeHz: [150, 150], pipeFb: 0.35, pipeDampHz: 3000,
        formants: [[260, 1.5, 0.8], [900, 2.5, 0.6], [2100, 3, 0.45]], dry: 0.6,
        lowpassOn: 5000, lowpassOff: 2200, drive: 2.2,
        level: 0.85, popiness: 0.5, burble: 0.35, shiftPop: 0.15, horn: [494, 622], squeal: 1.15,
      },
      suv: {
        cylinders: 8, banks: [0, 1, 0, 1, 0, 1, 0, 1], bankDelayMs: 0.4, // even-fire, heavily muffled → smooth deep rumble
        bakeRpm: [700, 1500, 2500, 3600, 5000],
        attackMs: 0.3, decayOnMs: 2.8, decayOffMs: 4.0, ringHz: 260, ringMs: 3.0, ringOn: 0.25, ringOff: 0.1,
        noiseOn: 0.2, noiseOff: 0.1, jitterOn: 0.07, jitterOff: 0.15, timingJitter: 0.012, cylVariance: 0.05,
        misfireOff: 0.02, popOff: 0.01,
        pipeHz: [58, 62], pipeFb: 0.6, pipeDampHz: 600,
        formants: [[80, 1.3, 1.3], [210, 2, 0.6], [500, 3, 0.25]], dry: 0.5,
        lowpassOn: 1150, lowpassOff: 650, drive: 1.4,
        level: 1.0, popiness: 0.15, burble: 0.15, shiftPop: 0.05, horn: [277, 349], squeal: 0.9,
      },
    },

    tyres: {
      squealLevel: 0.32,
      squealToneOn: [0.3, 0.9], // slip range mapped to tone (smoothstep)
      squealNoiseOn: [0.14, 0.65],
      squealHz: 920,
      squealHzSlip: 280, // + Hz at full slip
      roadLevel: 0.16, // rolling noise on asphalt at ~100 km/h
      offroadLevel: 0.34,
      landingMinAir: 0.3, // s airborne before a landing thump
    },
    wind: { level: 0.2, startKmh: 45, fullKmh: 200, airborneBoost: 1.4 },
    scrape: { level: 0.42, holdMs: 90 },
    horn: { level: 0.27 },

    impacts: {
      minStrength: 0.03,
      cooldownMs: 55,
      crunchFrom: 0.3, // strength above which our own body crunch layer is added
      level: 0.95,
      propLevel: 0.7,
      parkedLevel: 0.85,
      glassLevel: 0.7,
      partLevel: 0.6,
      alarmChance: 0.45,
      alarmMinSpeed: 4, // m/s
      alarmSeconds: 5,
      alarmCooldown: 14,
      alarmLevel: 0.13,
    },
    explosion: { boomLevel: 1.0, debrisLevel: 0.55, fireLevel: 0.32, reverbSend: 0.65, fireDelay: 0.5, fireFadeIn: 1.6 },

    ambience: {
      trafficLevel: 0.32,
      oceanLevel: 0.5,
      oceanNear: 25, // m from the shoreline at full level
      oceanFar: 220, // m where the ocean becomes inaudible
      waveMin: 7, // s between wave crashes
      waveMax: 12,
      crowdLevel: 0.12,
      cricketLevel: 0.035,
      breezeLevel: 0.05,
      gullEvery: [6, 16], // s (scaled by daylight + beach proximity)
      songbirdEvery: [4, 11],
      farHornEvery: [10, 28],
      passbyEvery: [7, 18],
      birdLevel: 0.11,
      farHornLevel: 0.05,
      passbyLevel: 0.07,
      district: {
        downtown: { traffic: 1.0, crowd: 1.0, birds: 0.3 },
        residential: { traffic: 0.55, crowd: 0.5, birds: 1.0 },
        beach: { traffic: 0.45, crowd: 0.9, birds: 0.8 },
        park: { traffic: 0.4, crowd: 0.7, birds: 1.2 },
        hub: { traffic: 0.7, crowd: 0.6, birds: 0.5 },
        highway: { traffic: 0.85, crowd: 0.1, birds: 0.3 },
        water: { traffic: 0.25, crowd: 0.2, birds: 0.8 },
      },
    },
    npc: { level: 0.32, maxConcurrent: 3, cooldownMs: 140, screamLevel: 0.26 },
    ui: { level: 0.5 },

    // ── part 2/3 ──
    speedOfSound: 343, // m/s: explosions, crashes and thunder are delayed by distance / speedOfSound
    farMaxDistance: 9000, // m: audibility limit for big explosions / thunder (custom gentle rolloff)
    turbo: { whine: 0.055, rush: 0.12, whoosh: 0.28, glideRush: 0.16 },
    stunt: { whoosh: 0.3, slam: 0.95 },
    snowMuffle: 0.65, // tyre/road noise reduction in snow (0..1)
    wetHiss: 0.13, // tyre spray hiss on wet roads at ~100 km/h
    plane: {
      engineLevel: 0.85,
      maxDistance: 3500,
      interiorCutoff: 1700, // Hz: engines heard from the cockpit
      // per type: ref distance, engine tones (Hz at full spool) and layer levels
      prop: { ref: 9, idleRpm: 700, maxRpm: 2700, blades: 2, piston: 0.32, buzz: 0.16, wash: 0.1, roar: 0, whine: 0, whineHz: 0, fanHz: 0, fan: 0, rumble: 0.1 },
      bizjet: { ref: 14, idleRpm: 0, maxRpm: 0, blades: 0, piston: 0, buzz: 0, wash: 0, roar: 0.32, whine: 0.06, whineHz: 5400, fanHz: 980, fan: 0.07, rumble: 0.12 },
      airliner: { ref: 22, idleRpm: 0, maxRpm: 0, blades: 0, piston: 0, buzz: 0, wash: 0, roar: 0.4, whine: 0.05, whineHz: 3900, fanHz: 650, fan: 0.09, rumble: 0.2 },
      jumbo: { ref: 30, idleRpm: 0, maxRpm: 0, blades: 0, piston: 0, buzz: 0, wash: 0, roar: 0.42, whine: 0.045, whineHz: 3150, fanHz: 440, fan: 0.1, rumble: 0.28 },
      windLevel: 0.3,
      windFullKmh: 750,
      fireLevel: 0.42,
      wreckFireLevel: 0.4,
      stallLevel: 0.11,
      cautionLevel: 0.15,
      beepLevel: 0.11,
      alarmLevel: 0.1,
      sequenceWind: 0.5,
      bangLevel: 0.9,
      boomLevel: 1.0,
      tearLevel: 0.8,
      waterLevel: 0.95,
      touchdownLevel: 0.45,
      snapLevel: 0.8,
    },
    weather: {
      rainLevel: 0.32,
      roofLevel: 0.3, // extra roof drumming in the hood/cockpit view
      wiperLevel: 0.11,
      thunderLevel: 1.0,
      nearThunder: 700, // m: closer strikes get the crack layer
      howlLevel: 0.11,
      howlAltStart: 150, // m above sea level: wind starts howling
      howlAltFull: 1000,
      stormWind: 0.16,
    },
    tunnel: { echoSend: 0.5, delay1: 0.053, delay2: 0.087, feedback: 0.36, ambienceDuck: 0.2, reverbBoost: 1.2, check: 0.15 },
  },

  // ───────────────────────────── planes: flight model (owner: src/plane) ────────
  // Spec table targets (SPEC-PART2 §5). The flight module adds the aero/thrust/gear numbers per plane.
  planes: {
    airDensity: 1.225,
    // Fire escalation (user idea): with 2+ burning engines (or a spread fire) the airframe engulfs, then comes apart.
    engulf: { secondsToFull: 26, spreadBonus: 0.6, stage1: 0.3, stage2: 0.62, flameGrow: 1.6, selfSustain: 0.8,
        // Tail lost (user feedback): the tail fire feeds the escalation and the plane slowly comes apart — no final explosion.
        tailDelay: 3, tailDrive: 1.0, tailExplodes: false,
        // Pieces come off one at a time once the airframe burns: first after firstS, each next wait × factor (≥ minS).
        disintegrate: { firstS: 8, factor: 2 / 3, minS: 0.5 },
        // Engine fires never escalate on their own: re-pressing a burning engine's button adds a fire point; at
        // pointsBase + pointsPerEngine × engines the airframe is engulfed and the disintegration starts.
        // A burning engine falling off resets the build-up.
        pointsBase: 5, pointsPerEngine: 1, maxSpots: 4 },
    // Crippled fall (user feedback): doomed planes lose lift and gravity ramps up so they accelerate into the ground.
    fall: { startSinkMs: 3, rampS: 5, liftLoss: 0.95, maxGravityScale: 2.2 },
    // Wing break buttons. far: roll-assist / assist kept at these shares (hard to fly, still flies) + light jolts.
    // half: over spinAfterS seconds the assist, control authority and lift fade while a roll/yaw pull toward the broken
    // side grows (rad/s² from rollStart to rollEnd), then a full stall: forced spin (local rad/s: pitch-down, yaw, roll).
    wingBreak: {
      farRollAssist: 0.45, farAssist: 0.75, farJolt: 0.25,
      // holdBank / holdRate: a stabiliser that fights the torn wing at first and fades to nothing at spinAfterS
      spinAfterS: 30, rollStart: 0.15, rollEnd: 2.6, yawPull: 0.3, liftLoss: 0.55, controlLoss: 0.85, holdBank: 6.5, holdRate: 4.5,
      spin: { pitch: 0.35, yaw: 1.1, roll: 2.1, gain: 2.5, lift: 0.12 },
      // fire at the break (user request): a lost tip burns tipFireS s then fades; a wing torn in half keeps burning;
      // the piece that falls away burns pieceFireS s
      tipFireS: 15, pieceFireS: 8,
    },
    // Crashed planes stay in the world after a respawn (user request): the last `keep` wrecks per quality level, their
    // fires burn on for fireHold s then fade over fireFade s (smoke lingers longer than flames).
    wreck: { keep: { low: 1, medium: 2, high: 3 }, fireHold: [20, 40], fireFade: [90, 180], settleS: 40 },
    // Menu "click and fly" start (absolute x/z, height above ground, heading): east of the city, west along the coast.
    quickFly: { x: 1500, z: 170, agl: 380, dirX: -1, dirZ: 0 },
    // Plane bodies fly with real gravity (gravityScale = gravity / |physics.gravity|) even though the arcade world uses -14.
    gravity: 9.81,
    ceiling: 3000, // m: soft ceiling, thrust and lift fade above it
    boardRadius: 8, // m from the board point (ground-projected) to the car
    boardMaxKmh: 5,
    exitMaxKmh: 3, // EXIT only when the plane is (almost) stopped on the ground
    carTeleportDist: 50, // m: on exit, the car is brought next to the plane if farther than this
    contactForceFactor: 0.8, // contact-force event threshold on plane colliders = mass × this (N)
    rollingFriction: 0.02,
    outOfMap: { countdown: 10, engineInterval: 10, crashWithin: 40 }, // s
    landing: { normalVs: 3, hardVs: 6, maxBankDeg: 10 }, // m/s touchdown classification
    assist: {
      pitchLimitDeg: 30, bankLimitDeg: 60, pitchLimitK: 1.2, // soft attitude limits (1/s)
      stallMarginDeg: 2.5, stallNudge: 2.2, // nose-down nudge (1/s per rad of AoA above the stall-warning AoA)
      flareHeight: 10, flareSinkK: 0.32, flareMinSink: 0.45, // m, 1/s, m/s
      autoGearUpAgl: 60, autoGearUpAglRealistic: 30, autoGearDownAgl: 150, autoGearDownSpeed: 1.6, autoGearNearAgl: 40, // m, × stall speed
      autoBrakeThrottle: 0.08, // on the ground at/below this throttle the brakes apply automatically
      rudderAssistMax: 0.25, betaK: 0.6, yawRateK: 3, rollRateK: 6, pitchRateK: 5,
      groundSteerK: 1.5, // heading hold on the runway (1/s yaw-rate damping into the nose wheel)
    },
    turbulence: { jolt: 1.0, vertical: 2.2, gustToStorm: 0.04 },
    // Speed follows the throttle (user request: "i cannot change the speed"): in the air, a push along the flight path
    // brings the airspeed toward minStall × Vs (idle) … topKmh (full power), gain 1/s, at most accel × spool m/s²
    // faster and brake m/s² slower, scaled by the share of working engines (dead engines: real physics only).
    speedResponse: { minStall: 1.3, gain: 0.5, accel: 8, brake: 6 },
    lod: { high: 3, medium: 12 }, // × plane length (camera distance)
    // Per plane: spec table (mass … glideRatio) + flight-model tuning. Speeds km/h, areas m², forces N per engine.
    // takeoffRollM/takeoffS are reported vs measured; the brief's pairs are not physically consistent (see report),
    // tuning targets: lift-off time ≈ takeoffS, distance to clear 35 ft ≈ takeoffRollM.
    prop: {
      mass: 1100, rotationKmh: 105, stallKmh: 85, topKmh: 340, takeoffRollM: 250, takeoffS: 8, engines: 1, fuelKg: 150, explosionRadius: 10, glideRatio: 9,
      cruiseKmh: 210, wingArea: 18, span: 11, oswald: 0.75, cl0: 0.35, clAlpha: 5.0, stallDeg: 14.7, cd0: 0.051, cm0: -0.04,
      incidenceDeg: 2, dihedralDeg: 5, wingAcFrac: 0.08, tailVolume: 0.6, finVolume: 0.07, munkPitch: 0.25, munkYaw: 0.07,
      flapCL: 0.7, flapCD: 0.04, gearCD: 0, retractable: false, flapsUpKmh: 150, flapsLandKmh: 120,
      thrust: 5933, propV0: 195, thrustLapse: 0, waveDrag: 0, spoolS: 1, idle: 0.06,
      inertiaScale: [1, 1, 1], pitchAuthority: 1.35, rollRateDeg: 85, yawAccel: 1.6, damping: [0.05, 0.02, 0.04],
      pitchRateDeg: 20, gammaK: 1.1, bankK: 2.2, pitchRateK: 6, rollRateK: 8,
      rotatePitchDeg: 9, rotateRateDeg: 8, brakeDecel: 4.5, steerDeg: 40, suspension: [0.32, 0.3, 1.1], turbulence: 1.0,
    },
    bizjet: {
      mass: 16000, rotationKmh: 200, stallKmh: 170, topKmh: 920, takeoffRollM: 900, takeoffS: 16, engines: 2, fuelKg: 4000, explosionRadius: 25, glideRatio: 15,
      cruiseKmh: 520, wingArea: 70, span: 16, oswald: 0.8, cl0: 0.25, clAlpha: 4.6, stallDeg: 15.2, cd0: 0.0072, cm0: -0.04,
      incidenceDeg: 2, dihedralDeg: 4, wingAcFrac: 0.08, tailVolume: 0.65, finVolume: 0.07, munkPitch: 0.25, munkYaw: 0.07,
      flapCL: 0.7, flapCD: 0.03, gearCD: 0.012, retractable: true, flapsUpKmh: 290, flapsLandKmh: 235,
      thrust: 34900, propV0: 0, thrustLapse: 0.3, waveDrag: 0.17, spoolS: 2.5, idle: 0.06,
      inertiaScale: [1, 1, 1], pitchAuthority: 1.35, rollRateDeg: 65, yawAccel: 1.0, damping: [0.05, 0.02, 0.04],
      pitchRateDeg: 14, gammaK: 0.9, bankK: 1.8, pitchRateK: 5, rollRateK: 6,
      rotatePitchDeg: 9, rotateRateDeg: 5.5, brakeDecel: 4, steerDeg: 45, suspension: [0.42, 0.3, 1.1], turbulence: 0.6,
    },
    airliner: {
      mass: 70000, rotationKmh: 260, stallKmh: 215, topKmh: 980, takeoffRollM: 1500, takeoffS: 22, engines: 2, fuelKg: 18000, explosionRadius: 45, glideRatio: 15,
      cruiseKmh: 520, wingArea: 180, span: 35, oswald: 0.8, cl0: 0.25, clAlpha: 5.0, stallDeg: 15.5, cd0: 0.0138, cm0: -0.04,
      incidenceDeg: 2, dihedralDeg: 5, wingAcFrac: 0.08, tailVolume: 0.7, finVolume: 0.075, munkPitch: 0.25, munkYaw: 0.07,
      flapCL: 0.7, flapCD: 0.03, gearCD: 0.012, retractable: true, flapsUpKmh: 350, flapsLandKmh: 290,
      thrust: 146000, propV0: 0, thrustLapse: 0.3, waveDrag: 0.22, spoolS: 3.5, idle: 0.06,
      inertiaScale: [1, 1, 1], pitchAuthority: 1.3, rollRateDeg: 32, yawAccel: 0.6, damping: [0.06, 0.03, 0.05],
      pitchRateDeg: 8, gammaK: 0.65, bankK: 1.1, pitchRateK: 3.5, rollRateK: 3.5,
      rotatePitchDeg: 8.5, rotateRateDeg: 4.5, brakeDecel: 3.5, steerDeg: 50, suspension: [0.55, 0.3, 1.1], turbulence: 0.35,
    },
    jumbo: {
      mass: 330000, rotationKmh: 295, stallKmh: 245, topKmh: 1050, takeoffRollM: 1900, takeoffS: 30, engines: 4, fuelKg: 150000, explosionRadius: 70, glideRatio: 15,
      cruiseKmh: 540, wingArea: 650, span: 64, oswald: 0.8, cl0: 0.25, clAlpha: 5.0, stallDeg: 15.9, cd0: 0.0125, cm0: -0.04,
      incidenceDeg: 2, dihedralDeg: 6, wingAcFrac: 0.08, tailVolume: 0.75, finVolume: 0.08, munkPitch: 0.25, munkYaw: 0.07,
      flapCL: 0.7, flapCD: 0.03, gearCD: 0.012, retractable: true, flapsUpKmh: 390, flapsLandKmh: 320,
      thrust: 292000, propV0: 0, thrustLapse: 0.3, waveDrag: 0.25, spoolS: 4, idle: 0.06,
      inertiaScale: [1.15, 1.1, 1.35], pitchAuthority: 1.25, rollRateDeg: 17, yawAccel: 0.35, damping: [0.07, 0.04, 0.06],
      pitchRateDeg: 5, gammaK: 0.45, bankK: 0.7, pitchRateK: 2.5, rollRateK: 2.2,
      rotatePitchDeg: 8, rotateRateDeg: 3.5, brakeDecel: 3, steerDeg: 55, suspension: [0.7, 0.3, 1.1], turbulence: 0.25,
    },
  },

  // ───────────────────────────── plane meshes (owner: src/plane/models) ─────────
  planeModels: {
    instrumentHz: 10, // cockpit instrument canvas redraw rate
    /** Recommended LOD switch distances (m from the camera): [LOD0→1, LOD1→2] — see PlaneVisual.lodForDistance. */
    lodDistance: { prop: [70, 260], bizjet: [120, 480], airliner: [170, 750], jumbo: [200, 950] } as Record<'prop' | 'bizjet' | 'airliner' | 'jumbo', [number, number]>,
  },

  // ───────────────────────────── breakup & crashes (owner: src/plane/breakup) ───
  breakup: {
    maxBodies: { prop: 8, bizjet: 16, airliner: 22, jumbo: 24 }, // hard cap of wreck bodies per plane (incl. the main body)
    lowQualityBodyScale: 0.75,
    keepMainFrac: 0.6, // the intact body survives a break if the cockpit/main component keeps ≥ this mass fraction
    debrisFrac: 0.012, // over budget: components lighter than this × plane mass become non-colliding debris
    friction: 0.85, // metal gouging into the ground (user: wrecks must not glide on after the impact)
    restitution: 0.0,
    // Doomed fall (user feedback): falling wreck pieces must keep ACCELERATING — after a short drift their lift/drag
    // fades and gravity ramps toward maxG (× world gravity) until they hit something.
    // (delayS of free flight first — gliding halves too — then the ramp; terminal speed maxSpeed via overDrag /s)
    doomFall: { delayS: 1.2, rampS: 4, aeroLoss: 0.85, maxG: 2.1, maxSpeed: 140, overDrag: 1.5 },
    // Smash: a hard hit into the ground/buildings digs in instead of bouncing and gliding — no rebound, most of the
    // sliding speed is lost (keepTangent hi→lo between minVn and fullVn), the momentum goes into a forward tumble.
    smash: { minVn: 12, fullVn: 45, keepTangentHi: 0.65, keepTangentLo: 0.2, maxRebound: 0.4, tumble: 2.2 },
    // Splatter (user feedback): fast ground/building hits explode and shatter the piece, scaled by the impact speed
    // (minVn → fullVn): fireball radius = explosionRadius × radiusMin..radiusMax × cbrt(piece mass share), share of
    // the piece's joints broken shatterMin..1, outward splatter kick up to kickMax m/s. Never on/under water.
    fastHitFallback: true, // process fast (CCD) hits that leave no queryable contact
    splat: { minVn: 30, fullVn: 110, radiusMin: 0.25, radiusMax: 0.9, shatterMin: 0.25, energy: 0.08, kickMax: 22, maxPerPlane: 10, minGap: 0.15 },
    angularDamping: 0.03,
    ghostTime: 0.35, // s without plane-vs-plane collisions for parts torn off a surviving body
    impactTransmit: 0.55, // share of the impact deceleration a broken-off piece still received (× exp(-d/R))
    keeperTransmit: 0.6, // same for the surviving body when the contacting part tore off (cartwheel yank)
    blastFx: true, // breakJoints with a 'middle'/'tail' blast spawns the fireball + emits planeExplosion
    guardGain: 4, // m/s a piece may gain per physics step (solver depenetration guard)
    guardRestitution: 0.03, // max bounce-back speed as a fraction of the recent impact speed (smash, no bounce)
    focusMinMassFrac: 0.04, // camera focus ignores pieces lighter than this × the biggest piece
    maxAngvel: 30, // rad/s cap for wreck pieces
    damage: {
      vBreak: 14, // m/s of impact severity that breaks a strength-1 joint at the contact
      v0: 4, // no damage below this impact speed
      globalV0: 26, // above this the whole frame is shaken (weak joints anywhere break)
      globalFrac: 0.15,
      radiusFrac: 0.22, // damage fall-off radius = × plane length
      tangentFactor: 0.12, // share of the sliding speed that counts as impact severity
      scrapeV: 420, // sliding wear of the dragging part's joints: rate = v/scrapeV × vBreak per s × hardness
      scrapeFuselage: 0.2, // fuselage-to-fuselage joints wear this much slower
      waterAccel0: 45, // m/s² of hydrodynamic deceleration before water damages joints
      waterScale: 1.0,
      waterTangent: 0.05,
      selfHardness: 0.5, // wreck vs wreck
    },
    blast: {
      k: 20, // Δv = k·energy/(m·(1+d²)), energy ≈ fuel kg involved, d in units of 10 % of the plane length
      minFrac: 0.1, // kick clamped to 10–25 % of airspeed in flight
      maxFrac: 0.25,
      groundMax: 12, // m/s cap when not flying
      tumble: 1.6, // rad/s random tumble (scaled down for heavy pieces)
      middleSeparation: 12, // m/s total separation speed of the two halves along the fuselage
      middlePitch: 0.3, // rad/s: the cut levers the halves apart (front nose-down, rear nose-up)
      middleSpin: 0.35,
    },
    air: {
      faceCd: 1.0,
      openFaceCd: 1.7, // open fuselage end (cup) drag
      liftFactor: 0.75, // reduced lift of severed wing/tail parts
      liftSlope: 4.6, // per rad
      stallAlpha: 0.26, // rad
      postStallCl: 0.8,
      wingIncidence: 0.05, // rad
      tailIncidence: -0.06, // rad (horizontal tail down-force of the trimmed aircraft)
      downwash: 0.45, // tail lift lost to the wing's downwash (only while a wing is on the same piece)
      munk: 0.55, // slender-body (Munk) moment factor × box volume for fuselage parts
      ringCn: 4, // normal-force slope (per rad, × face area) of an open fuselage end (ring wing)
      trimFactor: 1.0, // inherited tail trim load of a nose-less rear section (× lost forward mass moment)
      maxSpinKick: 1.2, // rad/s per step cap on aero torque
      wingAutorotate: 1.0, // severed-wing sycamore spin gain (0 = off)
      autorotateTip: 1.6, // target tip-speed ratio vs descent speed
      engineThrustTime: 4, // s a rear-section engine keeps (decaying) thrust after a middle split
    },
    water: {
      density: 1000,
      pressureCd: 0.42, // Newtonian face pressure (softened: water no longer feels like concrete)
      frictionCf: 0.02,
      linDamp: 1.5, // m/s, linear heave damping term
      roundedEnd: 0.35, // pressure factor of closed (rounded) fuselage nose / tail-cone faces
      bowLift: 0.6, // share of a submerged nose's frontal pressure turned into lift (planing bow)
      metalDensity: 2700,
      floodTime: 14, // s for a closed part to flood (open ends ×3.5 faster, fin ×0.28) — sinks sooner
      removeDepth: 60, // m below the surface (+ radius) → piece removed (sinks into the abyss first)
      abyssDepth: 4, // m below the surface: stop colliding with the seabed, keep sinking
      abyssMinWater: 10, // …only over the open ocean with at least this much water (never lakes/shallows)
      noExplosions: true, // user: water crashes break + burn, but never explode
      maxTime: 60, // s in water before flooding is forced
      ditchStallFactor: 1.3, // ditching if slower than this × stall, wings level, nose slightly up
      slamHardSpeed: [35, 120], // water damage hardness ramps between these speeds (m/s) — still breaks, less brutal
      igniteSpeed: 55, // m/s: water crash fast enough to ignite the fuel
    },
    crash: {
      minVn: 2.5, // m/s into the surface to count as an impact
      hardMaxVn: 6.5, // above → ground crash
      hardMaxAngle: 22, // deg flight-path angle above → ground crash
      crackSpeed: 4.5, // hard landing: fuselage may crack in two above this
    },
    fire: {
      // wreck fires fade slowly and progressively (user request)
      coolMin: 60,
      coolMax: 140,
      maxTrails: { low: 5, medium: 8, high: 12 },
      patchSpacing: 14, // m between burning fuel patches along the slide path (× plane size)
      patchDur: [40, 90],
      maxPatches: { low: 12, medium: 22, high: 36 },
      secondaries: [2, 4],
      secInterval: [0.3, 1.5],
      hardHitSecondary: 15, // m/s impact of a fuel piece → secondary explosion
      igniteVn: 9, // m/s normal impact speed that ignites the fuel (main fireball)
      tornEdgeTime: 3.5,
    },
    fx: {
      sparkInterval: 0.06,
      gougeStep: 1.8,
      maxSparksPerStep: 4, // fx call budgets across all sliding pieces
      maxDustPerStep: 3,
      maxGougePerStep: 4,
    },
  },

  // ───────────────────────────── terrain (owner: src/terrain) ───────────────────
  // Pure generation (src/terrain/gen) runs in workers with a snapshot of this block taken at init.
  terrain: {
    workers: 0, // 0 = auto (2–4 by navigator.hardwareConcurrency)
    tileCells: 32, // cells per render-tile edge; level L tile = tileCells × (2·2^L) m (L0: 64 m tiles of 2 m cells)
    maxLevel: 6, // coarsest render level (128 m cells, 4 km tiles)
    lodRadius: { low: 90, medium: 115, high: 160 }, // m of 2 m cells around the camera; every level doubles it
    maxTiles: 420, // render-tile slots in the terrain BatchedMesh
    altitudeView: 1.6, // view distance × (1 + this × altitude/1000) when flying
    maxViewDistance: 9000, // m cap (flying)
    selectEvery: 2, // frames between quadtree re-selections
    uploadBudgetMs: 2.6, // main-thread budget per frame for uploads / colliders / scatter rebuilds
    colliderRadius: 300, // m around the focus with heightfield colliders (128 m chunks, 2 m cells)
    colliderDrop: 400, // m: colliders beyond this are removed
    cacheTiles: 700, // LRU of generated tile meshes (CPU)
    cacheChunks: 260, // LRU of collider chunks
    cacheScatter: 520, // LRU of scatter chunks
    carveMaxLevel: 3, // highway corridors carved up to this render level (16 m cells)
    hazeMul: 0.95, // atmospheric haze e-folding distance = view distance × this
    snowJitter: 45, // m of per-face jitter of the snow line
    scatter: {
      radius: { low: 600, medium: 850, high: 1300 }, // m: trees beyond this are not drawn
      lod0: 150, // m: full trees
      lod1: 430, // m: low trees; beyond = far impostors (half density)
      bushRadius: 320,
      fenceRadius: 260,
      structureRadius: 1100, // houses, barns, turbines, pylons…
      cableRadius: 700,
      forestDensity: 1.0, // trees per 100 m² in dense forest (× quality.treeDensity)
      castShadows: true,
      // planes vs trees (user request): hits faster than treeSmashSpeed m/s low on the trunk (below this fraction of
      // its height) smash the tree; everything else knocks it over. fallenMax = fallen trees kept per kind.
      treeSmashSpeed: 40,
      treeSmashLow: 0.55,
      fallenMax: 160,
      treeDrag: 900, // kg of momentum taken per smashed tree (knocked: x0.35)
    },
    ring: { segments: 160, rings: 9, outer: 16000, rebuildDistance: 700 },
    lake: { cell: 3200, chance: 0.55 },
    islet: { cell: 900, chance: 0.32 },
    // Coast features (ABSOLUTE x on the south coast; seeded jitter is added).
    lighthouseX: 3500,
    pierX: 2250,
    coveX: 6100, // shallow cove under the highway's Coastal Bridge (CONFIG.highway.bridgeCenterX)
    seaWallEndX: 1500, // the city sea wall + promenade beach continue east to here (and west to the airport)
  },

  // ───────────────────────────── highway network (owner: src/highway) ──────────
  // Pure generation (src/highway/net, also run inside terrain workers) reads the network block in ABSOLUTE coords.
  highway: {
    cell: 4000, // m macro lattice cell: one junction node per cell → branches ≥ 3 km apart
    rowZ0: 1300, // lattice row j centre z = rowZ0 − j·cell (row 1 ≈ −2700: north of the city and the airport)
    jitter: 0.11, // node jitter (fraction of a cell)
    lowSearch: 340, // m radius of the low-point/pass search around each jittered node
    edgeChance: 0.5, // probability of an optional lattice edge (nodes always keep ≥ 2)
    coastInland: 280, // m inland of the coastline for coastal nodes
    coastMinY: 8, // m minimum road height along the coast
    bridgeCenterX: 6100, // absolute x of the long Coastal Bridge midpoint (south coast, east of the city)
    bridgeOffshore: 240, // m offshore at the bridge midpoint
    bridgeDeckY: 15, // m deck height at the bridge midpoint
    minRadius: 400, // spec minimum curve radius (m)
    designRadius: 560, // routing target radius (margin over minRadius)
    maxGrade: 0.06, // spec maximum gradient
    designGrade: 0.058, // profile Lipschitz bound (spec max 6 %)
    bankMax: 0.04, // superelevation on the tightest curves (rise per metre)
    lanes: 3, // lanes per direction (links: 2)
    laneW: 3.6,
    medianHalf: 0.45,
    innerShoulder: 0.9,
    outerShoulder: 2.9,
    bridgeDrop: 25, // m ground below the road → bridge
    tunnelRise: 40, // m ground above the road → tunnel
    galleryChance: 0.4, // chance a steep side-slope stretch gets an avalanche gallery
    restStopChance: 0.9, // per edge (~one every 4–6 km)
    kickerGap: [1500, 3000], // m between highway kickers (seeded)
    megaEvery: 10000, // m average spacing of mega jumps
    // streaming (main thread)
    chunkLen: 384, // m of road per mesh/collider chunk
    nearRadius: 950, // m detailed chunks
    physRadius: 450, // m chunks with colliders
    routeRadius: 7500, // m edges routed around the focus (graph, POIs, far ribbon)
    farExtra: 1500, // m far ribbon beyond quality.terrainViewDistance
    buildBudgetMs: 2.5, // main-thread generation/upload budget per frame
    flashHz: 2.2, // ramp warning arrows
    traffic: { perKm: 2.2, speedKmh: [95, 140], maxCars: 26, radius: 900 },
  },

  // ───────────────────────────── navigation / map (owner: src/nav) ──────────────
  nav: {
    arriveRadius: 30, // m — "Arrived"
    offRouteDistance: 25, // m from the route polyline → recalculate
    offRouteTime: 1.2, // s continuously off-route (or driving against it) before recalculating
    recalcMinInterval: 1.5, // s between two recalculations
    partialRefresh: 4, // s between re-routes of a partial route (network still generating toward the target)
    teleportFade: 0.4, // s
    discoverRadius: 150, // m — a POI is discovered when the player gets this close
    // graph
    mergeDistance: 2, // m — nodes of the city + highway graphs closer than this are merged
    joinDistance: 10, // m — dangling highway/city ends this close to the other network are joined
    snapStart: 30, // m — heading-aware snap of the car onto the network
    snapFar: 3000, // m — farthest network snap (off-road start / off-network target)
    goalSnap: 180, // m — a target farther than this from any road is routed to the closest reachable point
    uturnPenalty: 25, // s of travel-time penalty for starting against the car's heading
    turnAngleDeg: 35, // junction angle that counts as a turn
    maxExpansions: 400000, // A* safety limit
    // ribbon
    ribbonLength: 150, // m of chevron ribbon painted ahead of the car
    ribbonWidth: 2.6, // m
    ribbonLift: 0.16, // m above the road
    ribbonFlow: 8, // m/s chevron flow speed
    ribbonSpacing: 6, // m between chevrons
    ribbonOpacity: 0.95,
    // map screen
    mapMinPpm: 0.012, // px per metre (zoomed out ≈ 80 km across a phone)
    mapMaxPpm: 5, // px per metre (zoomed in)
    mapStartPpm: 0.35,
    mapTilePx: 128,
    mapTileCache: 240, // tiles kept in memory (LRU)
    mapWorkers: 2,
  },

  // ───────────────────────────── ui / hud / touch (owner: src/ui) ───────────────
  ui: {
    longPressResetMs: 600, // hold the 💥/↺ button this long to reset at any time
    toastMs: 2200, // default toast lifetime
    fadeInMs: 150, // reset flash: fade in, run the swap, fade out
    fadeOutMs: 250,
    steer: {
      sliderRangePx: 62, // finger travel (px at controls size 1) for full lock on the drag slider
      deadzone: 0.04, // fraction of the range ignored around the centre
      expo: 1.15, // response curve (1 = linear)
      buttonRate: 4.2, // /s ramp toward full lock with the arrow buttons
      buttonReturn: 7, // /s return to centre with the arrow buttons
      tiltMaxDeg: 24, // device tilt for full lock
      tiltDeadzoneDeg: 1.5,
      tiltSmoothing: 16, // 1/s low-pass on the tilt angle
    },
    minimap: {
      pxPerMeter: 1.5, // offscreen map resolution (low quality uses 1)
      radiusMin: 90, // m visible around the car when slow
      radiusMax: 170, // m visible at speed
      speedForMaxZoom: 45, // m/s
    },
    vibrateImpactMin: 0.3, // impact strength (0..1) that buzzes the phone
    fadeMovingKmh: 5, // controls fade to settings.controlsOpacity above this speed (and back below fadeMovingKmh * 0.6)
    orbitDragScale: 1, // multiplier on pixels sent to cameraRig.orbitDrag
  },
};

export type Config = typeof CONFIG;
export type QualityLevel = keyof typeof CONFIG.quality.presets;
export type QualityPreset = (typeof CONFIG.quality.presets)['low'];
