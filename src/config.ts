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
    // Azimuth convention: degrees about +Y, 0 = toward +Z (south, over the ocean), 90 = toward +X (east).
    exposure: 1.0, // global exposure multiplier (× the time-of-day preset's exposure)
    todTransition: 2.0, // s, smooth blend when the time-of-day setting changes
    fogNearFrac: 0.16, // linear fog near = viewDistance × this
    fogFarMul: 1.05, // linear fog far = viewDistance × this
    envMapSize: 256, // PMREM cube size (regenerated only on time-of-day change)
    envRefreshInterval: 0.35, // s between PMREM refreshes while a time-of-day transition runs
    shadow: {
      extent: 60, // m, half size of the ortho shadow frustum around the focus
      lookAhead: 0.3, // × extent: shift the frustum toward where the camera looks
      distance: 260, // m, light camera distance from the focus
      bias: -0.0004,
      normalBiasTexels: 1.1, // normalBias = texel world size × this
      radius: 1.4, // PCF disk radius in texels
    },
    ocean: {
      radius: 1400, // m, camera-following polar grid radius
      shoreSlope: 0.045, // analytic seabed slope (m depth per m from shoreZ) when the world gives no seabed
      waveScale: 1.0, // amplitude multiplier
      waveSpeed: 1.0,
      hazeDist: 650, // m, e-folding distance of the sea haze
      shallowDepth: 2.5, // m, turquoise shallows → mid blue
      deepDepth: 14, // m, mid blue → deep blue
      clearDepth: 1.4, // m, water becomes fully opaque past this depth (sand visible under the shallows)
      foamWidth: 0.55, // m of depth covered by the shoreline foam band
      glitter: 1.0,
    },
    clouds: {
      count: 26,
      puffsMin: 6,
      puffsMax: 11,
      altitudeMin: 150,
      altitudeMax: 250,
      spread: 1100, // m, half size of the wrapping cloud field around the camera
      wind: 3.0, // m/s drift
      windAngleDeg: 70,
    },
    bloom: {
      radius: 0.45,
    },
    tod: {
      day: {
        sunElevation: 47, sunAzimuth: -28, sunColor: '#fff1dc', sunIntensity: 3.3,
        hemiSky: '#bfe0ff', hemiGround: '#8a86b0', hemiIntensity: 1.05, envIntensity: 0.42,
        zenith: '#3f8fd8', skyMid: '#86c6ea', horizon: '#d3eaf2', fog: '#cfe6f0', ground: '#a9b8c4', glow: '#fff1d6',
        glowStrength: 0.55, sunDisk: 26, sunSize: 1.0, moon: 0, stars: 0,
        exposure: 1.0, night: 0,
        cloudLit: '#ffffff', cloudShade: '#b4b5d8',
        waterDeep: '#0f5f8c', waterMid: '#1f97bd', waterShallow: '#47d3c6',
        bloomStrength: 0.3, bloomThreshold: 1.6,
      },
      sunset: {
        sunElevation: 7, sunAzimuth: -42, sunColor: '#ffb07a', sunIntensity: 2.6,
        hemiSky: '#a9b6ee', hemiGround: '#9a6f8f', hemiIntensity: 0.95, envIntensity: 0.5,
        zenith: '#3d5fa8', skyMid: '#b48ec4', horizon: '#ffc59a', fog: '#e8b9a4', ground: '#7d6a86', glow: '#ff9a5c',
        glowStrength: 1.4, sunDisk: 20, sunSize: 1.6, moon: 0, stars: 0.05,
        exposure: 1.05, night: 0.25,
        cloudLit: '#ffc3a0', cloudShade: '#8f78a8',
        waterDeep: '#1d4a7a', waterMid: '#3b6f9e', waterShallow: '#5aa8b0',
        bloomStrength: 0.4, bloomThreshold: 1.3,
      },
      night: {
        sunElevation: 38, sunAzimuth: -18, sunColor: '#a9bfff', sunIntensity: 0.55,
        hemiSky: '#3a4f8c', hemiGround: '#2a2440', hemiIntensity: 0.55, envIntensity: 0.6,
        zenith: '#050b1f', skyMid: '#0f1d42', horizon: '#26385f', fog: '#1d2b4a', ground: '#141a2c', glow: '#5d78b8',
        glowStrength: 0.35, sunDisk: 0, sunSize: 1.0, moon: 1, stars: 1,
        exposure: 1.15, night: 1,
        cloudLit: '#5d6a96', cloudShade: '#1c2340',
        waterDeep: '#04182c', waterMid: '#0a2a46', waterShallow: '#164c5c',
        bloomStrength: 0.75, bloomThreshold: 0.85,
      },
    },
  },

  // ───────────────────────────── props & parked cars (owner: src/world/props) ───
  props: {
    // Shared with src/world (bench placement) — keep the bench model matching these numbers.
    benchSeatHeight: 0.46, // m, seat surface above ground
    benchSeatSpacing: 0.62, // m between seat centers
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
      gears: [3.1, 2.05, 1.52, 1.2, 0.98],
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
      engineBraking: 1.3, // m/s² decel at redline with the throttle released
      turboSpool: 1.3, // 1/s turbo spool-up (perf engine ≥ 1)
      turboDecay: 3.5, // 1/s spool-down
      maxReverseKmh: 36,
    },
    /** Per-model base parameters. torque = Nm per tonne of car mass (so models' masses keep their feel). */
    models: {
      coupe: { refMass: 1300, torque: 262, redline: 7200, finalDrive: 4.0, drag: 0.66, gripFront: 1.55, gripRear: 1.52, sideFront: 1.0, sideRear: 1.0, stiffness: 1.0, damping: 1.0, comHeight: 0.4, driveFront: 0, steerMax: 0.6, brake: 1.0, downforce: 1.0 },
      muscle: { refMass: 1550, torque: 285, redline: 6400, finalDrive: 3.75, drag: 0.64, gripFront: 1.45, gripRear: 1.32, sideFront: 0.95, sideRear: 0.88, stiffness: 0.9, damping: 0.95, comHeight: 0.42, driveFront: 0, steerMax: 0.58, brake: 0.95, downforce: 0.8 },
      hatch: { refMass: 1080, torque: 232, redline: 7400, finalDrive: 4.3, drag: 0.8, gripFront: 1.55, gripRear: 1.48, sideFront: 1.05, sideRear: 1.0, stiffness: 1.05, damping: 1.0, comHeight: 0.4, driveFront: 1, steerMax: 0.64, brake: 1.0, downforce: 0.8 },
      suv: { refMass: 1900, torque: 248, redline: 6200, finalDrive: 4.15, drag: 0.86, gripFront: 1.45, gripRear: 1.45, sideFront: 0.95, sideRear: 0.98, stiffness: 0.78, damping: 1.05, comHeight: 0.52, driveFront: 0.45, steerMax: 0.56, brake: 0.95, downforce: 0.6 },
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
      decel: 9.8, // m/s² at full pedal (wheel brakes, before ABS)
      frontBias: 0.64,
      absLimit: 0.78, // fraction of the tyre limit the brakes may use (keeps steering under braking)
      handbrake: 0.9, // rear lock impulse in multiples of the rear axle's grip
      reverseBelow: 1.2, // m/s: brake pedal engages reverse below this forward speed
      parkHold: 0.6, // m/s: below this with no pedal the car holds still (no creeping)
    },
    tyres: {
      handbrakeRearSide: 0.3, // rear side-grip multiplier while the handbrake is held
      handbrakeRearGrip: 0.65, // rear friction multiplier while the handbrake is held
      driftRearSide: 0.62, // rear side grip held while power-sliding (slip > driftSlipDeg with throttle)
      driftSlipDeg: 9,
      gripDropRate: 10, // 1/s rear grip falls when the handbrake is pulled
      gripRecoverRate: 1.8, // 1/s rear grip returns after the handbrake/drift
      highSpeedSide: 0.85, // side stiffness multiplier at top speed (calmer at speed)
      slipLatStart: 1.2, // m/s lateral slip at which skid output begins
      slipLatFull: 6, // m/s lateral slip for full skid
      surface: { asphalt: 1, concrete: 1, metal: 0.9, wood: 0.95, plastic: 0.9, glass: 0.85, foliage: 0.75, grass: 0.72, sand: 0.62, water: 0.45, flesh: 0.8 },
      surfaceDrag: { sand: 2.2, grass: 1.0, water: 5, foliage: 1.2 }, // extra m/s² rolling drag
    },
    aero: {
      rolling: 0.012, // rolling resistance (× m g)
      downforce: 1.5, // N per (m/s)² per tonne (scaled by model downforce)
    },
    /** Stability assists. */
    assist: {
      rollStiffness: 10, // 1/s² righting accel per rad of roll (relative to ground) when grounded
      rollDamping: 4.5, // 1/s
      rollLimitDeg: 14, // beyond this roll, righting gets 3× stronger (curbs/two-wheeling)
      yawDamping: 3.2, // ESC: 1/s correction of yaw rate beyond what the steering asks for
      handbrakeEsc: 0.0, // ESC multiplier while the handbrake is held
      driftEsc: 0.25, // ESC multiplier while power sliding
      escRecover: 1.2, // 1/s ESC fade-back after handbrake/drift
      maxSlipDeg: 52, // body slip angle limiter (no spin-outs unless forced)
      slipLimiter: 7, // 1/s² per rad beyond maxSlip
      wheelbaseFallback: 2.6,
    },
    /** Air control. Accelerations in rad/s². */
    air: {
      pitch: 5,
      roll: 4.5,
      yaw: 3,
      autoLevel: 2.6, // pulls toward upright for clean landings
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
      minDv: 0.9, // m/s Δv for an impact event
      maxDv: 12, // m/s Δv = strength 1
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
  },

  // ───────────────────────────── camera (owner: src/camera) ─────────────────────
  camera: {
    fov: 62,
    near: 0.1,
    far: 1500,
  },

  // ───────────────────────────── car models (owner: src/vehicle/models) ─────────
  carModels: {},

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
    rideHeightLift: 0.1, // m of body lift per +1 stance.rideHeight (preview)
    rideHeightDrop: 0.07, // m of body drop per -1
    camberMaxDeg: 8,
    showroomSteerDeg: 12, // front wheels turned for the showroom pose
    reflectionScale: 0.5, // turntable mirror resolution × drawing buffer (medium/high quality)
    reflectionStrength: 0.6,
    envIntensity: 1.0,
    keyLight: 2.4,
    fillLight: 0.8,
    rimLight: 1.9,
  },

  // ───────────────────────────── pedestrians (owner: src/npc) ───────────────────
  npc: {},

  // ───────────────────────────── effects (owner: src/fx) ────────────────────────
  fx: {},

  // ───────────────────────────── audio (owner: src/audio) ───────────────────────
  audio: {
    // mix — bus gains are multiplied by settings volumes (slider^volumeCurve) and state ducking
    masterGain: 0.9,
    volumeCurve: 1.7,
    busGain: { engine: 0.62, sfx: 0.85, ambience: 0.55, ui: 0.5 },
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
      level: 0.95,
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
    horn: { level: 0.34 },

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
  },

  // ───────────────────────────── planes: flight model (owner: src/plane) ────────
  // Spec table targets (SPEC-PART2 §5). The flight module adds the aero/thrust/gear numbers per plane.
  planes: {
    airDensity: 1.225,
    prop: { mass: 1100, rotationKmh: 105, stallKmh: 85, topKmh: 280, takeoffRollM: 250, takeoffS: 8, engines: 1, fuelKg: 150, explosionRadius: 10, glideRatio: 9 },
    bizjet: { mass: 16000, rotationKmh: 200, stallKmh: 170, topKmh: 850, takeoffRollM: 900, takeoffS: 16, engines: 2, fuelKg: 4000, explosionRadius: 25, glideRatio: 15 },
    airliner: { mass: 70000, rotationKmh: 260, stallKmh: 215, topKmh: 880, takeoffRollM: 1500, takeoffS: 22, engines: 2, fuelKg: 18000, explosionRadius: 45, glideRatio: 15 },
    jumbo: { mass: 330000, rotationKmh: 295, stallKmh: 245, topKmh: 920, takeoffRollM: 1900, takeoffS: 30, engines: 4, fuelKg: 150000, explosionRadius: 70, glideRatio: 15 },
  },

  // ───────────────────────────── plane meshes (owner: src/plane/models) ─────────
  planeModels: {},

  // ───────────────────────────── breakup & crashes (owner: src/plane/breakup) ───
  breakup: {},

  // ───────────────────────────── navigation / map (owner: src/nav) ──────────────
  nav: {
    arriveRadius: 30, // m — "Arrived"
    offRouteDistance: 25, // m from the route polyline → recalculate
    ribbonLength: 150, // m of chevron ribbon painted ahead of the car
    teleportFade: 0.4, // s
  },

  // ───────────────────────────── ui / hud / touch (owner: src/ui) ───────────────
  ui: {
    longPressResetMs: 600, // hold the 💥/↺ button this long to reset at any time
    toastMs: 2200, // default toast lifetime
    fadeInMs: 150, // reset flash: fade in, run the swap, fade out
    fadeOutMs: 250,
    steer: {
      sliderRangePx: 78, // finger travel (px at controls size 1) for full lock on the drag slider
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
    orbitDragScale: 1, // multiplier on pixels sent to cameraRig.orbitDrag
  },
};

export type Config = typeof CONFIG;
export type QualityLevel = keyof typeof CONFIG.quality.presets;
export type QualityPreset = (typeof CONFIG.quality.presets)['low'];
