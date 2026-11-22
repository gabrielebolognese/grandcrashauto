# Coastline — browser 3D city driving sandbox

Read `docs/SPEC.md` (part 1 brief: city driving sandbox) and `docs/SPEC-PART2.md` (part 2 brief: island, airport,
flyable planes, engine explosions, breakups, crashes, GPS map) — the sources of truth for features — before working. This file covers architecture,
conventions, ownership and how to verify your work.

## Commands
- `npm run dev` — dev server (http://localhost:5173). `npm run dev:lan` exposes it on the LAN for phone testing.
- `npm run typecheck` — `tsc` (TypeScript 7, strict). Must stay clean for files you own.
- `npm run build` — static build into `dist/` (base `./`, works from any static host/sub-path).
- `node scripts/smoke.mjs --tag <yourname>` — headless Chromium (SwiftShader) smoke test: builds into a private temp dir,
  loads `?debug&autostart`, drives (W, D, Space), explodes (X), resets (R), screenshots to `.smoke/<tag>/*.png` and prints
  a JSON summary (fps, draw calls, triangles, errors, car position…). **Always use your own `--tag`** (parallel agents).
  Options: `--mobile` (adds a 844×390 touch phone run), `--mobile-only`, `--scenario idle|menu|garage|none`,
  `--params "seed=7&foo"`, `--quality low|medium|high`, `--seconds N`, `--script my-scenario.mjs` (see header of smoke.mjs).
  View screenshots with the Read tool. SwiftShader is a slow CPU renderer: fps numbers in smoke runs are NOT representative,
  but draw calls / triangles are. Don't loop smoke runs back-to-back; the machine is shared by several agents.
- URL params: `?debug` (error overlay, `window.__game = {game, ctx, CONFIG}`, debug panel), `?autostart` (skip title/menu),
  `?seed=N`, `?quality=low|medium|high`, `?car=<share code>`.

## Architecture (contract-first, stub-wired)
- `src/main.ts` → `src/game/Game.ts` (orchestrator: builds `GameContext`, state machine, update order, explode/reset flow).
- `src/game/contracts.ts` — **interfaces of every module** (`IWorld`, `IEnvironment`, `IProps`, `INpcSystem`, `ICarFactory`,
  `IPlayerVehicle`, `ICameraRig`, `IFx`, `IAudio`, `IGarage`, `IUI`) + `GameContext` + `GameActions`.
  Each module implements its interface in its own directory; Game.ts already constructs and wires them all.
- `src/core/events.ts` — all cross-module events (`impact`, `scrape`, `explosion`, `carReset`, `horn`, `npcHit`, `propHit`,
  `stateChanged`, `settingsChanged`, `qualityChanged`, `prompt`, `toast`, `vibrate`, …). Prefer events over direct calls.
- `src/config.ts` — every tunable number, one section per module. Read values at use time (live tuning via `?debug` panel).
- `src/core/`: `Engine` (renderer, loop, dynamic res, `disposeObject`), `Physics` (Rapier wrapper, collider tags, collision
  groups `G`, `groups()`, `raycast`, `applyRadialImpulse`, `BodyInterpolator`), `Input` (unified actions), `Settings`, `Save`
  (one versioned localStorage key + migrations), `Quality` (presets, auto-detect, probe, dynamic resolution), `rng` (seeded
  `Rng`, `hash32`), `math`, `uniforms` (`GLOBAL_UNIFORMS`: uTime, uNight, uSunDir… written by env only), `debugOverlay`.
- `src/world/types.ts` — `CityData` contract (road graph, pedestrian graph, benches, bus stops, wander areas, buildings,
  prop & parked-car placements, spawn, coast, district grid).
- `src/vehicle/CarBuild.ts` — `CarBuild` (customization data model), `normalizeBuild`, `stockBuild`.
- Loop: fixed 60 Hz `fixedUpdate(dt)` → `physics.step()` → `postStep(dt)` (capture transforms) → per frame `update(dt, alpha)`
  (interpolate with alpha). `dt` in update is game time (slowed during explosion slow-mo); `ctx.engine.realDt` is real time.
- Game states: `boot → title → menu ⇄ garage`, `menu → driving ⇄ paused`. Simulation (world/props/npcs/vehicle/camera/fx/audio
  updates + physics) runs in `title`, `menu`, `driving`. In `garage` only garage+ui (+audio) update; in `paused` only ui+audio.
- Explode/Reset flow (Game.ts): `explodeOrReset()` → `vehicle.explode()` (vehicle emits `explosion`; fx/audio/camera/npcs/props
  react to that event) + slow-mo dip. `requestReset()` → `ui.fade(cb)` → `vehicle.reset()` → `fx.clearAll()` →
  `cameraRig.snap()` → Game emits `carReset`. Out-of-world / deep water → vehicle calls `ctx.game.requestReset()`.
- Robustness: Game wraps each system's init/update in try/catch and reports to the debug overlay, so one broken module
  doesn't kill the game. Don't rely on that — fix your errors.

## Part 2 architecture (planes) — see `src/plane/types.ts` and the PART 2 section of `src/game/contracts.ts`
- `ctx.game.mode` is `'car' | 'plane'` inside the `driving` state (`setMode()` emits `modeChanged`). `ctx.input.mode`
  follows it: in plane mode the car fields of `input.state` read zero (+ handbrake on) and the flight fields
  (`pitch` +1 = pull/nose up, `roll` +1 = bank right, `yaw`, `throttleAxis`, `throttleSet` (touch slider, -1 = unset),
  `planeBrake`) are filled. New triggers: `interact` (F: board/exit), `map` (N), `gear` (G, consumed by the plane
  system), `engine1..4` (1–4), `explodeMiddle` (M), `explodeTail` (T), `skip` (Enter). Game.ts routes them.
- `ctx.planeModels: IPlaneFactory` (src/plane/models) builds `PlaneVisual`s: named parts (`PlanePartInfo`: mass, com,
  box, fuel, cdA, cpOffset), break joints with hidden torn caps, break modes, engines (button order 1..n, left→right
  from the cockpit — left = +X), gear, cockpit eye, wing cam. Root origin = centre of mass; nose +Z.
- `ctx.planes: IPlaneSystem` (src/plane) owns the parked planes on the airport stands, boarding/exit, the flight
  model (one Rapier body + raycast gear), engines, assists, out-of-map sequence, crash flow (respawn / retry / back
  to car) and `PlaneState` (HUD/audio/camera read it). It registers the player plane with the breakup system as a
  `TrackedPlane`.
- `ctx.breakup: IBreakup` (src/plane/breakup) owns crash detection & outcomes (landing / hard / ground / water /
  building), water forces, momentum-conserving splits into `WreckPiece`s, piece aerodynamics, wreck fires/slicks,
  sinking, budgets and cleanup.
- `ctx.nav: INav` (src/nav + src/ui/map) owns POIs, A* routes, the road ribbon, turn card, the Map screen and teleport.
- Part-2 FX/audio hooks: optional `IFx` members (`explosionEx`, `attachTrail`, `splash`, `fuelFire`, …) — call with
  `?.`; part-2 events (`engineExplode`, `planeExplosion`, `planeBreak`, `planeImpact`, `touchdown`, `stallWarning`,
  `masterCaution`, `outOfMap`, `modeChanged`, `planeSpawned`).
- Island: `CONFIG.world.island` (land ~x∈[-2000,2000], z∈[-2600,400], centre (0,-1100), warn 5.5 km, fail 6.5 km,
  ceiling 3 km). Airport data: optional `CityData.airport` (runways, 4 stands, car park pose). Heading 0 = north (-Z).
- Plane spec numbers (mass, rotation/stall/top speed, fuel, explosion radius) are in `CONFIG.planes` (flight owns it).

## Conventions
- Units: meters, seconds, kilograms, newtons, radians. Y is up. City spans [-400, 400] on X and Z; the ocean is at +Z (south).
- Yaw: rotation about +Y; yaw 0 faces +Z; forward = (sin yaw, 0, cos yaw); right = (-cos yaw, 0, sin yaw).
- Cars face +Z in local space; their LEFT side is +X. Wheel order everywhere: FL, FR, RL, RR (FL at +X, +Z).
- Rapier raycast vehicle: `indexUpAxis = 1`, `setIndexForwardAxis = 2` (sic — that's the setter's name in 0.21),
  wheel direction (0,-1,0), axle (-1,0,0). Positive steering angle turns toward +X (left) → steer right = negative angle.
- Collision groups: `groups(member, filter)` with bits `G.WORLD | G.PROP | G.PARKED | G.PLAYER | G.NPC | G.DEBRIS`.
  Tag every collider: `physics.tag(collider, { kind, material, id? })` so impacts get the right sound/fx.
- Deterministic generation: `Rng.from(CONFIG.game.seed, …)`; per-chunk randomness `Rng.from(seed, chunkIndex, salt)`.
  Never use `Math.random()` for anything that affects city layout or placement (fine for particles/audio jitter).
- Three.js r187, WebGL2 only. Imports from `three/examples/jsm/...` are allowed (e.g. `BufferGeometryUtils.mergeGeometries`,
  `EffectComposer`, `RoomEnvironment`). **No new npm dependencies.** No external asset downloads at runtime; everything
  is generated in code (CC0/MIT sources only if listed in CREDITS.md — ask the lead first).

## Performance rules (mobile is the target — see SPEC §4)
- Budgets on mobile: < 150 draw calls, < 300k visible triangles, 1 shadow-casting light (the sun), DPR ≤ 1.5.
- Instancing (`InstancedMesh`) or merged geometry for anything repeated (buildings, props, palms, parked cars, NPCs).
  Share materials and geometries. Merge static per-chunk geometry. Frustum/distance cull; LOD where it matters.
- **Never add/remove lights at runtime** (it recompiles every shader → hitches). Pre-create pooled lights at init and toggle
  `intensity`/`visible`. Avoid changing material `defines`/features at runtime for the same reason.
- No per-frame allocations in hot paths (reuse `THREE.Vector3` temps). Pool particles, NPCs, debris.
- Dispose geometries/materials/textures you create when removing them (`disposeObject` in core/Engine; careful with shared
  materials). Explode→Reset 50× must not grow memory.
- Respect `ctx.quality.current` (shadows, bloom, npcCount, viewDistance, chunkRadius, propDensity, particleScale, clouds,
  waterDetail) and listen to `qualityChanged`.
- Cast shadows only from things that matter (car, buildings near the player, big props). Cheap materials far away.

## Look (SPEC §5): sun-drenched pastel coastal art-deco
- Warm sun (#fff1dc), cool lavender-blue shade (shadows never black: hemisphere ground ~#8a86b0, sky ~#bfe0ff),
  soft distance haze (fog ~#cfe6f0), big cumulus clouds, ACES tone mapping, glossy cars and water.
- Palette ideas: coral #ff7a6b, peach #ffb38a, sand #f3dcb2, mint #9ee0c8, aqua #5cc8d6, lilac #b8a6e8, butter #ffe39a,
  cream #fff4e0, sky #8fd0ec, sea #2aa3c4, deep sea #146c94, palm green #4f9a5a, asphalt #4a4d57, sidewalk #d9d2c5.

## Ownership (parallel agents — edit ONLY what you own)
| Module | Owns |
|---|---|
| core / lead | `src/core/**`, `src/game/**`, `src/main.ts`, `index.html`, `scripts/**`, `CLAUDE.md`, `README.md`, `CREDITS.md` |
| world | `src/world/**` except `env/` and `props/` (city gen, roads, buildings, terrain, highway, colliders, streaming) |
| env | `src/world/env/**` (sky, sun, shadows, fog, clouds, env map, ocean, post/bloom, time of day, distant scenery) |
| props | `src/world/props/**` (street furniture, knockable props, parked cars) |
| vehicle | `src/vehicle/**` except `models/` and `customization/` (physics, tuning, damage, explosion debris) |
| camera | `src/camera/**` |
| carmodels | `src/vehicle/models/**` |
| garage | `src/ui/garage/**`, `src/vehicle/customization/**` |
| npc | `src/npc/**` |
| fx | `src/fx/**` |
| audio | `src/audio/**` |
| ui | `src/ui/**` except `src/ui/garage/` and `src/ui/map/` |
| planemodels (part 2) | `src/plane/models/**` |
| flight (part 2) | `src/plane/**` except `models/`, `breakup/` and `types.ts` |
| breakup (part 2) | `src/plane/breakup/**` |
| nav (part 2) | `src/nav/**`, `src/ui/map/**` |

Shared files: `src/config.ts` (edit only your section; re-read right before editing — others edit it concurrently),
`src/game/contracts.ts`, `src/core/events.ts`, `src/world/types.ts`, `src/plane/types.ts` (only ADD optional members/events if you truly need them,
never change or remove existing ones; mention every such change in your final report).
Do not run git commands (the lead commits). Do not edit `Game.ts`; if you need a hook there, say so in your report.
When `npm run typecheck` shows errors in files you don't own, ignore them (another agent is mid-edit).
