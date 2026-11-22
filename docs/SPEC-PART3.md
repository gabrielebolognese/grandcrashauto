# Build brief, part 3: world expansion, highways, day/night, weather, turbo and ramps

> The user's part-3 brief, verbatim (the user's LAST prompt — everything must be completed autonomously). Overrides part 2's "island" geography. Architecture notes: `CLAUDE.md` (Part 3 section).

This extends the existing **"Coastline"** web game, built from the part 1 brief (city driving sandbox, garage, pedestrians, Explode/Reset) and the part 2 brief (airport, flyable planes, crashes). **Read the codebase first** and reuse what exists: chunk streaming, road graph, vehicle physics, input layer, FX and explosion system, audio engine, HUD, map menu with directions, settings and quality presets, save system. All earlier rules still apply: **original content only (no real brands, logos, places or copied game content), no gore, and 30 fps on a mid-range phone.**

The art direction for everything new is **low-poly**: flat-shaded facets, vertex colours instead of textures wherever possible, simple silhouettes, strong lighting and atmosphere doing the heavy lifting. Performance first: if a feature can't hold the frame rate on a phone, it gets a cheaper Low-quality version, never a frame-rate drop.

## 1. Scope

**Add in this update**
- **World expansion:** beyond the city, the land splits into an **ocean coast** on one side and **procedurally generated mountains** on the other, generated chunk by chunk from a seed as you travel (Minecraft-style generation, low-poly look), endless inland.
- **Highways:** a coastal highway and mountain highways with bridges, tunnels, cuttings and interchanges, connected to the city.
- **Day/night cycle:** sun and moon, sunrise and sunset colours, stars, streetlights, lit windows, headlights.
- **Weather cycle:** clear, cloudy, overcast, rain, thunderstorm, fog, and snow in the high mountains. Weather affects grip, visibility and planes.
- **Turbo:** a boost that makes the car go much faster and a little wild, for that "woah" moment on the highway.
- **Ramps:** occasional jump ramps. In the air: a **Barrel roll** button, and **turbo in the air makes the car glide** (stays airborne longer, almost like lift).

**Not in this update:** on-foot player, missions, police, destructible terrain or buildings, seasons, rivers you can drive in. Light highway traffic is an optional stretch goal (section 6).

## 2. Geography changes (overrides part 2's "island")

- The city and airport stay where they are, on the coast. The world is no longer a closed island:
  - **West and south (the ocean side):** open sea, as before. The **out-of-map ring for planes stays on this side only** (part 2's warning and engine-failure sequence, ending in a sea crash).
  - **North and east (the land side):** the land continues past the city edge: suburbs and farmland first, then rolling hills, then **mountains**, generated forever as you travel inland. No out-of-map limit inland, for cars or planes.
  - **The coast:** it continues in both directions along the ocean side: beaches, cliffs, small offshore islets, a lighthouse on a headland, a fishing pier. The **coastal highway** follows it.
- **Floating origin (required for an endless world):** when the player is more than ~2 km from the scene origin, shift the whole world (all objects, physics bodies, particles, camera) back so the player is near the origin again, and keep a world-offset value for generation and saves. Rapier bodies must be shifted in the same step. This prevents the jitter that 32-bit floats cause far from the origin.
- Update the **map menu**: a zoomable map generated from the same seed, with the new regions, highways and points of interest (Lighthouse, Mountain Pass, Summit Viewpoint, Coastal Bridge, Big Jump, Rest Stops). **Directions** work on the highway network too, and **teleport** to any discovered point of interest.

## 3. Procedural terrain ("Minecraft-style" generation, low-poly look)

Generation works like Minecraft: a **seed**, **noise-based biomes and heightmaps**, **chunks generated on demand** around the player and unloaded behind, the **same seed always giving the same world**. The look is **not blocky voxels** but **faceted low-poly terrain** (flat-shaded triangles with vertex colours).

- **Chunks:** 128 × 128 m, generated in a **Web Worker pool** (never on the main thread) and streamed in by distance. The main thread only uploads the finished geometry and colliders.
- **Heightmap:**
  - **Layers:** layered noise (fractal value or simplex noise plus domain warping) with a "continentalness" mask: flat near the city and coast, rising inland. Mountains use ridged noise for sharp ridgelines.
  - **Shape:** peaks up to ~900 m, with occasional plateaus, valleys and a few lakes in basins (flat water planes).
- **Biomes** (from temperature/moisture noise plus altitude): coastal dunes and beaches, cliffs where the land meets the sea steeply, farmland plains (patchwork fields as vertex-colour quads), forest, rocky hills, pine mountainsides, alpine meadows, bare rock, **snow above ~600 m**. Biome edges blend in the vertex colours.
- **Mesh:** a grid with 4 LOD levels (2 m, 4 m, 8 m, 16 m cells) chosen by distance, seams hidden with skirts. Non-indexed geometry or derivative normals for the faceted look. Colours come from biome, height and slope (steep = rock, flat = grass or snow), with a tiny per-face colour jitter for that hand-made low-poly feel.
- **Colliders:** Rapier heightfield colliders for the nearby chunks only (within ~300 m of the player); farther chunks are visual only.
- **Props** (instanced, low-poly, a few hundred triangles each): pine trees, round trees, bushes, rocks and boulders, fences, farmhouses and barns, wind turbines on ridges, power-line pylons, a few cabins. Scattered by noise with seeded randomness, never on roads, density by biome and quality preset. Far trees become billboards or merged clumps.
- **Distance:** fog and an atmospheric-perspective tint hide the generation edge. A cheap **distant mountain ring** (one low-poly silhouette mesh, regenerated as you move) fills the horizon beyond loaded chunks.
- **Caching:** keep recently generated chunks in memory (LRU). Optionally store them in IndexedDB so revisits don't regenerate.

## 4. Highways

- **Network:**
  - **Coastal highway:** leaves the city along the shore in both directions, with cliffside sections, a long **coastal bridge** across a bay, sea views. It continues endlessly along the generated coast.
  - **Mountain highway:** leaves the city inland, climbs through hills into the mountains with sweeping curves, then splits into branches (generated as you reach them) that keep going forever.
  - **Interchanges:** at least two between the highways and the city road network, with on/off ramps.
- **Generating highway routes:** each highway is a spline generated **ahead of the player chunk by chunk** from the seed, using a guided random walk:
  - **Geometry:** a minimum curve radius of ~400 m (gentle, fast curves for turbo) and a maximum gradient of ~6%.
  - **Steering:** it steers around peaks using the heightmap and prefers valleys and passes.
  - **Branches:** occasionally a branch spawns, each at least 3 km apart.
  - **Integrity:** branches never self-intersect; when one would cross another, place a bridge over the other.
- **Shaping the land:** the terrain is carved along a corridor around each highway:
  - **Cuttings and embankments:** flatten and blend the heightmap to the road level with sloped sides.
  - **Bridges:** where the ground falls more than ~25 m below the road (deck, piers, railings).
  - **Tunnels:** where the ground rises more than ~40 m above it (a tunnel tube mesh with portal facades, lights along the walls, darker inside, the echoing sound changes).
  - **Avalanche galleries:** occasional half-open galleries on steep slopes.
- **Road surface:** 2 × 2 or 2 × 3 lanes with a concrete median barrier, lane markings, shoulders, guardrails (instanced segments), reflector posts, overhead gantries and signs (shapes and arrows only, or short invented place names in the game's world), streetlights near interchanges and in tunnels.
- **Stops:** occasional **rest stops** and gas stations (a parking loop, a small building, a few NPCs, picnic benches) every ~4–6 km.
- **Physics:** road colliders follow the spline (segmented convex strips or a trimesh per chunk). Guardrails are solid and spark when scraped. The car must be able to drive the whole network at full turbo speed without hitting invisible bumps at chunk seams.

## 5. Day/night cycle

- **Clock:** a game clock with a full day in **24 real minutes by default** (adjustable from 4 to 120 minutes, pausable). Settings and the pause menu offer **set time**, **day length** and **lock time**. The clock shows on the HUD.
- **Sky:**
  - **Sun:** a sun arc with a seasonal tilt, a physically based sky gradient (scattering or a tuned gradient), warm low-angle light at sunrise and sunset, **golden hour** colours, and a blue hour.
  - **Night:** a **moon** with phases (it lights the night with a cool, dim blue directional light), a **star field** that fades in, and occasionally the Milky Way in clear weather far from the city.
- **Lighting:** one directional light that switches between sun and moon, plus ambient/hemisphere light and an environment map that follow the sky colours. **Never regenerate the environment map every frame:** update it every few game minutes, or blend between a few pre-baked keyframes. Shadow intensity fades out at twilight. Exposure and colour grading shift with the time of day (warm day, orange-pink sunset, cool night with deeper contrast).
- **City at night:**
  - **Streetlights** switch on at dusk (emissive heads plus fake light pools on the road; only the nearest 4–8 cast real light).
  - **Windows:** building windows light up in a random, changing pattern (in the facade shader).
  - **Signs and street life:** neon accents on shop fronts and the beachfront, and fewer pedestrians late at night.
- **Vehicles at night:**
  - **Player car:** headlights switch on automatically (low/high beam toggle). Use one spotlight pair for the player car only; all other vehicles get emissive lamps plus a fake cone/glow sprite. Taillights, brake lights and the underglow from part 1 glow.
  - **Planes:** navigation lights (red left, green right, white tail) and anti-collision strobes.
  - **Airport:** runway and taxiway lights.
- **Mountains at night** are genuinely dark outside the headlights and tunnels, with a moonlit silhouette of the peaks.

## 6. Weather cycle

- **States:** clear, few clouds, cloudy, overcast, light rain, heavy rain, **thunderstorm**, fog, and **snow** (automatic instead of rain above the snow line, ~600 m). The weather changes on its own with smooth 1–3 minute transitions and random durations (weights: mostly clear and cloudy, storms rare). Settings and the pause menu offer **lock weather** or **set weather**.
- **Sky and light:** cloud cover and density grow from clear to overcast (in the sky/cloud shader), the sun dims and the light turns flat and grey under overcast, distant fog thickens, everything desaturates slightly in rain. Storms bring dark clouds and wind.
- **Rain:**
  - **Rain streaks:** a particle volume attached to the camera (cheap instanced streaks, aligned to the camera velocity so driving fast slants them).
  - **Raindrops on screen:** in cockpit and hood views.
  - **Splashes:** small splash particles on the road around the car, spray thrown up by the car's tyres (and by traffic, if any).
  - **Wet surfaces:** a wetness value fades in over a minute: roads get darker and glossier (lower roughness, stronger reflections of lights at night), and **puddles** appear in road dips (noise mask) with mirror-like reflections from the environment map.
  - **Drying:** after the rain, wetness dries out over a few minutes.
- **Thunderstorm:**
  - **Lightning:** procedural forked bolts (branching line meshes, a bright flash lighting the whole scene for 2–3 frames, a screen-wide flash).
  - **Thunder:** **delayed by distance / 343 m/s**.
  - **Wind:** strong gusts.
- **Fog:** low-lying fog in valleys and over the sea at dawn; dense fog cuts visibility to ~80 m. Headlights and lamps glow through it (light scattering sprites).
- **Snow:** soft flakes drifting in the wind, snow building up on the roadsides and the terrain's snow colour reaching lower, the road turning white at the edges. Very low grip.
- **Wind:** a single global wind vector (direction plus gust noise) drives rain angle, smoke and fire particles, palm and tree sway (vertex shader), flags, waves (choppier sea in storms), and **crosswind on planes and on cars at high speed** (a mild side push on bridges).
- **Effect on driving and flying:**

  | Weather | Tyre grip | Visibility | Other |
  |---|---|---|---|
  | Clear | 100% | Full | — |
  | Rain | ~75% | Reduced | Puddles cause brief aquaplaning (steering goes light for 0.3 s) |
  | Heavy rain / storm | ~65% | Low | Gusts push the car on bridges; turbulence shakes planes |
  | Fog | 100% | Very low | Pedestrians and props fade in nearer |
  | Snow | ~45% | Reduced | Long braking distances, easy slides |

  Planes: crosswind makes landings harder, storm turbulence adds random pitch/roll jolts, rain streaks appear on the windshield.
- **Audio:** rain on the roof (intensity follows the rain), wipers in hood view, thunder rolls, wind howling at altitude, muffled tyre sounds on snow.
- **Performance:** on Low there are no puddle reflections and fewer drops, lightning without the scene re-light (screen flash only), snow as a texture-scrolling overlay.

## 7. Turbo

The base car speed gets dull on long highways. Turbo adds that **"woah, this is fast"** moment: much faster, a little unruly, but never unplayable.

- **Input:**
  - **Mobile:** a big **TURBO** button just above the gas pedal (flame icon) with a charge ring around it.
  - **Desktop:** Shift (or E).
  - **Gamepad:** A/X.
  - Hold to boost.
- **Charge:** a turbo meter (HUD bar plus the button ring) **drains in ~6 s** of continuous use and **recharges in ~10 s** when not used. It recharges 2× faster while driving above 120 km/h on a highway, and fills instantly at rest stops.
- **Performance while boosting:**
  - **Push:** extra forward force (~2.5× acceleration) and a raised top speed (**about +60%**: 200 → ~320 km/h for the stock car; turbo upgrades in the garage raise both).
  - **Attitude:** a slight nose lift on activation (a pitch impulse), then the car settles.
  - **Over time:** the boost builds in over 0.3 s, and on release the car keeps its speed and slows down naturally.
- **The "semi-uncontrollable" part (subtle, tunable in `config.ts`):**
  - **Steering:** it gets **more sensitive at the wheel but less effective at the tyres**. Steering response goes up ~25% while tyre side-grip ratio goes down ~15%, so the car feels light and darty.
  - **Wobble:** a low-frequency **yaw wobble** (smooth noise, a few degrees) and a high-frequency body shake that grow with speed.
  - **Releasing turbo mid-corner** gives a small lift-off oversteer kick.
  - **Assists:** the stability assist is halved while boosting.
  - **Weather and surface:** on wet or snowy roads all of this is stronger (turbo in snow = a genuine challenge).
  - **Limit:** never strong enough to spin the car on a straight dry road by itself.
- **Feel and effects:**
  - **Exhaust:** blue-white exhaust flames with a pop on activation.
  - **Speed effects:** heat shimmer behind the car, speed lines or streaks at the screen edges, a **field-of-view kick of +12–18°**, a slight radial blur and chromatic aberration on Medium/High, and the chase camera pulling back and lowering.
  - **Sound and haptics:** a rising whoosh and turbine whine, a short vibration on mobile.
  - **Trail:** at night the taillight trails stretch.

## 8. Ramps

- **Where they are:**
  - **Highway kickers:** occasional jump ramps placed on highway shoulders or a marked stunt lane every ~1.5–3 km (seeded), announced by chevron signs and flashing arrows 200 m before.
  - **Mountain and coast jumps:** rarer ramps where the terrain gives a natural gap: over a valley, off a cliff into a lake, across a hairpin.
  - **Mega jump:** about one every ~10 km, a big ramp with a landing ramp on the other side of a canyon.
  - **City:** a few hand-placed stunt spots (from part 1's jump ramp).
- **Shapes:** low-poly wedge or curved kicker ramps (concrete, steel, dirt and plank variants), 12–25° lip angles, with an **automatic safety check** in generation: a clear landing zone ahead (straight, flat or downhill road or ground, no tunnel portals, bridge ends or barriers within the expected landing range at turbo speed). If the check fails, the ramp isn't placed.
- **Air time:** when all four wheels leave the ground after a ramp at more than ~60 km/h, the game enters **airborne mode**:
  - **HUD:** an air-time counter and a distance readout appear.
  - **Air control:** steering yaws the car slightly, gas pitches the nose down and brake/reverse pitches it up (moderate authority, so players can level the car for landing).
  - **Landing:** good landings (wheels first, near level) give a satisfying suspension slam, sparks and dust, a camera bump and a "CLEAN LANDING" pop-up. Bad ones (roof or nose first, or the car past ~45° of roll or pitch) mean a crash bounce, damage and a possible explosion if hard enough.

### 8a. Barrel roll button
- While airborne with enough predicted air time (≥ ~0.8 s), a big **BARREL ROLL** button appears (mobile: centre right, pulsing). It offers two directions: a swipe left or right on it, or two small arrows. Keyboard: Q/E; gamepad: bumpers.
- **Pressing it rolls the car a full 360° around its forward axis:**
  - **Spin:** compute the angular velocity needed to finish one roll in ~70% of the remaining predicted air time (from the current height and vertical speed, ray-cast to the predicted landing point), apply it as an angular impulse, then **auto-stabilise** the last 60° so the car comes out level.
  - **Landing:** if there isn't enough air time left, the roll doesn't finish and the car can land on its side or roof. That risk is part of the fun.
  - **Combos:** double rolls are possible on big jumps (press again after the first completes).
  - **Effects:** a "BARREL ROLL!" pop-up, a whoosh, the camera briefly orbiting to show the roll, a slow-motion dip (~0.6× for 0.4 s) on mega jumps.

### 8b. Turbo in the air = glide
- **Holding turbo while airborne** makes the car **stay in the air much longer**, almost as if it had wings:
  - **Lift:** apply a lift force ∝ speed² perpendicular to the car's forward direction (in its vertical plane), reaching ~**85% of the car's weight at 250 km/h**, so the fall becomes a long floaty arc.
  - **Thrust:** keep the turbo thrust pushing forward, so speed holds instead of bleeding off.
  - **Balance:** a little drag so it doesn't fly forever. The turbo meter drains **1.5× faster in the air**, which naturally limits the glide to a few seconds.
  - **Control:** pitch (gas/brake) changes the glide like a wing: nose up trades speed for height, nose down for speed.
  - **Effects:** two **vapour trails** streaming from the car's rear corners, exhaust flames, rising wind noise, "AIR GLIDE" pop-up with the air-time counter climbing.
  - **Combining:** you can barrel roll during a glide (the roll timing uses the longer predicted air time).

## 9. Optional stretch: light highway traffic

Off by default, toggle in Settings:
- **Movement:** a few AI cars per highway kilometre following lanes on simple splines (kinematic, constant speed, gentle lane changes), despawning out of view, none in tunnels on Low.
- **Collisions:** hit by the player, a car becomes a dynamic body and reacts with physics (and can explode with the part 1 effect).
- **Turbo moments:** weaving between them is the turbo's best moment.

## 10. Performance rules for all of the above

- **Budgets:** terrain triangles in view under ~200k on Medium mobile. Instanced trees and props with 2–3 LODs, billboards past ~400 m. Chunk generation never on the main thread; uploading a chunk must not take more than ~3 ms per frame (spread the uploads over frames).
- **Lighting and atmosphere:** at most one shadow map (following the player); real lights capped (the player's headlights plus 4–8 nearest streetlights; everything else emissive or fake). Weather and sky updates throttled (environment map, ambient, fog colour every few seconds or on change, interpolated in between).
- **Particles:** rain and snow particles live only in a box around the camera, counts scaled by quality. Puddle reflections and lightning re-lighting are Medium/High only.
- **Quality presets:** they gain new controls: terrain view distance, tree density, weather effects level, real-time light count, post effects (turbo blur, aberration). Dynamic resolution stays on.
- **No memory leaks:** test 30 minutes of driving inland with constant chunk loading and unloading; memory must plateau.

## 11. Milestones (each one playable)

1. **Terrain generator:** worker-based chunk streaming, biomes, low-poly terrain, props, floating origin, the new map regions.
2. **Highways:** spline generation, the terrain corridor (cuttings, embankments), bridges, tunnels, interchanges with the city, guardrails, rest stops, directions on the highway network.
3. **Day/night cycle:** sky, sun/moon, stars, night lighting for the city, cars, planes and the airport, time controls.
4. **Weather cycle:** all states, rain/puddles/wetness, storm and lightning, fog, snow, wind, grip and plane effects, weather controls.
5. **Turbo:** meter, physics, the controlled wobble, camera and FX, audio.
6. **Ramps:** placement with safety checks, airborne mode and landings, barrel roll, turbo glide.
7. **Optional traffic + polish:** performance pass on a mid-range phone in the worst case (night + storm + mountains + turbo), tuning.

## 12. Acceptance checklist

- [ ] Driving inland from the city leads through farmland and hills into mountains that keep generating with no visible pop-in, no hitches over ~3 ms, and no jitter after 20+ km (floating origin works).
- [ ] The same seed regenerates exactly the same terrain, highways, ramps and props.
- [ ] The ocean side keeps part 2's out-of-map sequence for planes; inland has no limit.
- [ ] Highways: no curve tighter than ~400 m radius, no grade over ~6%. Bridges and tunnels appear automatically over valleys and through mountains, and the car can drive the whole network at turbo speed without bumps at chunk seams.
- [ ] A full day/night cycle plays smoothly; streetlights, windows, headlights and plane lights switch on at dusk; the mountains are dark at night; time can be set, sped up and locked.
- [ ] All weather states appear and transition smoothly. Rain makes roads wet and reflective with puddles and lowers grip; storms flash and rumble with the right delay; fog cuts visibility; snow appears above the snow line with very low grip; weather can be locked.
- [ ] Turbo: much faster with a big FOV and effects kick, a little twitchy and wobbly but never spins the car on its own on a dry straight; the meter drains and refills as described; it's harder on wet and snow.
- [ ] Ramps appear only where the landing zone is safe. The barrel-roll button appears only with enough air time and lands level when used in time; turbo in the air clearly extends the jump into a glide with vapour trails.
- [ ] 30 fps on a mid-range phone in the worst case (night + thunderstorm + mountains + turbo) on Low/Medium.
- [ ] All new content is original and low-poly, with no real brands, places or copied game content.
