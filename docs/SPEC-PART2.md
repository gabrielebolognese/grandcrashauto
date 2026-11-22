# Build brief, part 2: airport, flyable planes, engine failures, breakups and crashes

> The user's part-2 brief, verbatim. Source of truth for part-2 scope. Architecture notes: `docs/PART2-ARCH.md` and `CLAUDE.md`.

This extends the existing **"Coastline"** web driving sandbox (built from the part 1 brief: TypeScript + Vite + Three.js + Rapier, mobile-first, original content, no gore). **Read the existing codebase first** and reuse its systems: input layer, chunk streaming, road graph, garage/save system, particle and explosion FX, audio engine, HUD, settings, quality presets. All part 1 rules still apply, especially the **performance targets (30 fps on a mid-range phone)** and the **originality rules (no real brands, airlines, logos or copied game content)**.

## 1. Scope

**Add in this version**
- The city becomes an **island** surrounded by open sea, with an **airport**.
- A **map menu** with points of interest: get **directions** (GPS route) to the airport by car, or **teleport** there.
- **4 flyable plane types**, each parked on the apron. Drive up to one, press **BOARD**, and fly it.
- A **simple but believable flight model**: up/down, left/right, throttle; different take-off speeds and handling per plane.
- **Per-engine explode buttons** (1, 2 or 4, bottom centre).
- **Out-of-map sequence**: a warning, then engines exploding one every 10 seconds until the plane crashes into the sea.
- Plane destruction commands: **Explode** (whole plane), **Explode middle** (splits in half, camera stays in the cockpit), **Explode tail** (tail blown off, on fire).
- A **momentum-correct crash and breakup system** for ground, runway and water impacts.

**Not in this version:** passengers or crew (cabins are empty, with seats only), air traffic control, AI aircraft, weapons, real navigation instruments, destructible buildings (planes crash *against* buildings and break up, but buildings stay standing).

## 2. The island and the airport

- **Island:** about **4 × 3 km**. The existing city sits on part of it. Beaches and a sea wall run around the coast, with a low hill or two inland for visual interest. Open **ocean all around to the horizon** (visibility ~10 km, with haze), plus the same cloud and sky look as the city. The ocean needs a cheap far LOD and must look good from 1,000 m up.
- **Airport** on flat land at the island's edge, oriented so take-offs head out over the sea:
  - **Main runway 2,200 × 45 m** with real-style markings (threshold stripes, designator numbers, centreline, touchdown zone, edge lines), edge lights, approach lights and a PAPI light bar. One shorter crosswind runway (1,200 m) for the small plane.
  - **Taxiways** with yellow centrelines and hold-short markings, an **apron** with the 4 plane parking spots (painted stands), a **terminal** with static jet bridges, a **control tower**, 2 **hangars**, fuel trucks, baggage carts, a windsock, perimeter fences, airport roads and a car park.
  - The airport road connects to the city road graph. Car park spaces sit about 40 m from the apron.
  - Reuse the crowd system for pedestrians around the terminal entrance.
- **Map boundary:** a circle centred on the island. **Warning radius 5.5 km**, **failure-sequence radius 6.5 km** (see section 9). Draw the boundary on the minimap and the big map.

## 3. Map menu: directions and teleport

- Add a **Map** screen (pause menu and a HUD button): a top-down island map drawn from the road graph and district shapes, with points of interest: **Airport**, Garage, Beach, Downtown, Park, Highway.
- Selecting a point of interest offers two buttons:
  - **Directions:**
    - **Route:** A* on the road graph from the car's position.
    - **On screen:** shown as a glowing route line on the minimap and the big map, and as a soft chevron ribbon painted on the road surface ahead of the car (first ~150 m, fading). A top-centre arrow card shows the next turn and the distance ("↱ 120 m").
    - **Recalculation:** the route recalculates when the player goes off it.
    - **Arrival:** within 30 m of the destination shows "Arrived" and clears the route. For the airport, the destination is the car park next to the apron.
  - **Teleport:** fade to black (0.4 s), place the car at the destination on the road (airport: the car park, facing the planes), fade in. Disabled while the car is exploding.

## 4. Boarding and leaving a plane

- When the car is **within 8 m of a parked plane's boarding point** (a marker by the door, or by the cockpit for the small plane) and moving under 5 km/h, a big **BOARD** button appears (keyboard: F).
- **Board:**
  - **Transition:** a short fade, or a 1.5 s camera move from the car to the plane.
  - **State:** the car stays parked where it was and keeps existing in the world. The player now controls the plane, which starts on its stand with engines idling, parking brake on, flaps set for take-off, gear down.
  - **Controls:** the HUD and controls switch to flight mode (section 6).
- **Exit (EXIT button):** only when the plane is stopped on the ground. It returns control to the car, teleported next to the plane if the plane has moved more than 50 m away.
- **After a crash:** buttons **Back to car**, **Respawn plane** (parked on its stand, repaired) and **Retry in air** (respawn the same plane flying at 500 m over the island).

## 5. The four planes (original designs, names and liveries)

Build all four in code (procedural meshes, like the cars), each split into **named parts** that can break off (section 10). Give each an original name and livery in the game's fictional world. The silhouettes can follow real classes, but nothing is branded.

| | **1. Light prop plane** | **2. Private jet** | **3. Airliner** | **4. Jumbo jet** |
|---|---|---|---|---|
| Look | High-wing single-prop trainer, fixed gear | Sleek business jet, T-tail, rear fuselage engines | Narrow-body twin, low wing, under-wing engines | Four-engine wide-body with the upper-deck hump (747-class silhouette) |
| Engines (buttons) | 1 (propeller) | 2 | 2 | 4 |
| Length / span | 8 / 11 m | 18 / 16 m | 38 / 35 m | 70 / 64 m |
| Mass (game) | 1,100 kg | 16 t | 70 t | 330 t |
| Rotation speed (lift-off) | **105 km/h** | **200 km/h** | **260 km/h** | **295 km/h** |
| Stall speed (clean) | 85 km/h | 170 km/h | 215 km/h | 245 km/h |
| Top speed (game) | 280 km/h | 850 km/h | 880 km/h | 920 km/h |
| Take-off roll (full power, game-tuned) | ~250 m, 8 s | ~900 m, 16 s | ~1,500 m, 22 s | ~1,900 m, 30 s |
| Handling | Twitchy, floats, easy to land | Fast, responsive, short roll | Stable and predictable | Heavy, slow to roll and pitch, wide turns |
| Fuel / explosion size | Small | Medium | Large | Huge |

Each plane definition (in `config.ts`) holds: mass and inertia, wing area, lift-curve slope, max lift coefficient and stall angle, zero-lift drag, induced-drag factor, gear/flap drag, thrust per engine and engine positions, control authorities, gear layout (for the ground vehicle), camera offsets, part break table, fuel load (for the explosion size). Tune them so the numbers above come out in play.

## 6. Flight controls and the flight model

### Controls (keep them simple)
- **Mobile (landscape):**
  - **Left thumb, flight stick:** up/down = pitch, left/right = bank (with automatic coordinated yaw, so "left" just turns left). Optional tilt control in Settings.
  - **Right thumb:** a vertical **throttle slider** (0–100%, with an idle detent), plus **BRAKE** (on the ground) and **GEAR** buttons.
  - **Top bar:** camera switch, **💥 Explode**, **Explode middle**, **Explode tail**, Reset, pause/map.
  - **Bottom centre:** the **engine buttons** (section 7).
  - On the ground the stick's left/right also steers the nose wheel.
- **Desktop:** W/S pitch, A/D bank, Q/E rudder, Shift/Ctrl throttle up/down, B brakes, G gear, 1–4 engine buttons, X explode, M explode middle, T explode tail, C camera, R reset, F board/exit. **Gamepad:** left stick = pitch/bank, triggers = throttle, bumpers = rudder.

### Flight model (slightly realistic, not complex)
The plane is **one Rapier dynamic rigid body** (compound collider shaped like the fuselage, wings and tail). Each fixed step at 60 Hz, compute forces from the velocity relative to the air (air at rest, optional light wind) and apply them at the right points so torques come out naturally:

1. **Thrust:** each **alive** engine pushes along the body's forward axis **at its own position**. Losing an engine on one side creates a yaw (and slight roll) toward the dead side, which the player has to counter. Engines spool up and down over 1–4 s depending on the type (jets slow, the prop fast). Thrust drops a little with airspeed.
2. **Lift:** `L = ½·ρ·v²·S·CL(α)`, perpendicular to the airflow in the plane's symmetry plane. `CL` rises linearly with angle of attack up to the stall angle, then drops sharply (stall: the nose drops and the plane mushes). Flaps raise `CL` for take-off and landing (auto-deploy below a speed, retract above it).
3. **Drag:** `D = ½·ρ·v²·S·(CD0 + k·CL²)`, plus gear and flap drag, plus **damage drag** (torn sections, missing panels).
4. **Stability:**
   - **Sideslip:** a side force and a weathervane yaw moment (the fin turns the nose into the airflow).
   - **Pitch:** a restoring moment from the tailplane. **Remove these when the tail is destroyed** (section 8c).
   - **Damping:** pitch, roll and yaw damping proportional to airspeed.
5. **Controls:** torque = input × authority × dynamic pressure (clamped), so the controls are soft and mushy near stall speed and crisp at speed. Heavy planes have high inertia: inputs take time to bite.
6. **Assists (on by default, "Assisted / Realistic" toggle in Settings):**
   - auto-coordinated turns (bank → yaw), auto-trim (hands off = hold the current pitch);
   - soft limits of ~60° bank and ±30° pitch;
   - stall warning (horn plus a red speed tape) with a gentle nose-down nudge;
   - auto-rotation help at take-off speed (a light pull lifts it off);
   - landing assist (holds a gentle flare below 10 m when descending slowly).
   - Damaged planes switch the assists off progressively. A crippled plane should feel crippled.
7. **Ground handling:** use a raycast-wheel vehicle for the landing gear (as for the car): nose-wheel steering below 60 km/h, brakes, rolling friction, a short gear-strut suspension.
   - **Lift-off** happens naturally when lift exceeds weight around the rotation speed and the player pulls up.
   - **Gear** retracts with G (auto above 60 m off the ground in Assisted mode).
   - **Touchdown** is checked in section 11.
8. **Altitude:** soft ceiling at 3,000 m (thrust and lift fade). Air density is constant.

### Cameras
- **Chase** (smooth spring behind and above; distance grows with plane size), **cockpit** (a simple interior: dashboard with airspeed, altitude, vertical speed, heading, throttle and per-engine status lights, plus the windshield frame), a **wing camera** looking at the engines, and a **free orbit** camera.
- In every camera, **dragging pans around freely**, and the view returns to forward after 2 s without touch (except in the explode-middle sequence, where free look stays on).

### Flight HUD
Airspeed with the current plane's **rotation speed marked** on the tape, altitude, vertical speed, throttle %, gear and flaps state, stall warning, heading, minimap with the boundary ring, and **engine status icons** (OK / on fire / destroyed).

## 7. Engine buttons and engine explosions

- **Bottom centre**, one round button per engine, labelled **1, 2, 3, 4**. Numbering follows the aviation convention, **left to right as seen from the cockpit**:
  - prop plane: **1**;
  - private jet and airliner: **1** (left), **2** (right);
  - jumbo: **1** left outer, **2** left inner, **3** right inner, **4** right outer.
- **Pressing one makes that engine explode:**
  1. **Blast at the nacelle:** a sharp flash, a compact fireball (scaled to the engine), fan blades and cowling fragments flying out as small debris (6–12 pieces) with the plane's velocity plus an outward kick. A burst of sparks.
  2. **Damaged engine:**
     - **Mesh:** the nacelle swaps to a torn version (open cowling, blackened, missing chunks).
     - **Thrust:** goes to zero at once.
     - **Prop plane:** the propeller jerks to a stop or windmills.
     - **Torn mounting (jumbo, rear-engine jet):** a 15% chance the engine tears off completely and falls (its own burning debris body).
  3. **Persistent fire:**
     - **Flames:** they stream backward from the nacelle, stretched by the airflow (longer at higher speed).
     - **Smoke:** a thick black trail emitted in world space, so it stays behind as a long ribbon in the sky.
     - **Spreading:** after 6–12 s there's a 30% chance the fire spreads along the wing (bigger fire, more drag on that side).
  4. **Handling:** asymmetric thrust yaws the plane toward the dead side. Losing all engines turns the plane into a glider (prop plane glide ratio ~9:1, jets ~15:1, jumbo ~15:1 but heavy). A skilled player can still glide back and land.
  5. **UI:** the button turns red with a crack icon and is disabled. A master-caution tone and a flashing "ENGINE 2 FIRE" banner.
  6. **Sound:** a hard bang (delayed by distance in outside cameras), metal rattle, then a continuous fire roar mixed into the wind.

## 8. Plane destruction commands

All of these reuse the breakup system (section 10) and the explosion FX (section 12). After each one, the top-bar commands turn into **Reset** once the wreck has come to rest, or immediately via long-press.

### 8a. 💥 Explode (whole plane)
- A full fuel explosion: a large fireball engulfing the airframe (size from the fuel table: prop ~10 m, private jet ~25 m, airliner ~45 m, jumbo ~70 m), a bright flash and dynamic light, and a **shockwave** (a visible pressure ring in the air; a ring of water spray or ground dust if within ~100 m of the surface).
- **Breakup:** the airframe splits into **all of its break groups** (nose, forward fuselage, centre box, rear fuselage, tail cone, fin, both tailplanes, wings in 2–3 segments each, engines, gear). Each piece gets the plane's momentum plus a modest radial kick (section 10), so **the burning cloud of wreckage keeps travelling along the flight path** as a fan-shaped shower, tumbling, trailing fire and smoke, then splashing into the sea or hitting the ground (each piece runs its own crash handling, section 11).
- **Camera:** a quick cinematic (short slow-motion, an orbit around the fireball), then it follows the biggest burning piece down to impact.

### 8b. Explode middle (the plane splits in half; you stay in the cockpit)
- **Blast:** a ring explosion around the fuselage just **behind the wings** (just ahead of the engines on the rear-engine jet), with a sharp flash, a ring of fire and a burst of panels, insulation and paper-like debris. Cabin pressure loss: a white mist puff, and loose items (empty seat cushions, overhead bins) sucked out of the opening.
- **Separation:** the airframe splits into **two rigid bodies** at the blast plane:
  - **front section:** cockpit and forward cabin, **no wings**;
  - **rear section:** wings, engines, rear cabin and tail.
  - Both inherit the plane's velocity and angular velocity, plus a small separating kick along the fuselage axis (front forward, rear back) and a slight random rotation.
- **Torn ends:** both sections show a **ragged break** (a procedural jagged ring of skin with bent edges, exposed frames and stringers, dangling cables as simple swinging lines, a dark interior with empty seat rows visible). Sparks and small fires spray from the torn edges for a few seconds, then smoke.
- **Physics after the split:**
  - **Front section:** no wings means no lift. It pitches down and slowly tumbles nose-first, with drag from the open back slowing it and making it wobble.
  - **Rear section:** still has wings but no nose ballast, so its centre of mass jumps backward. It pitches up violently, stalls, then spirals or flat-spins down. Its engines may keep running for a few seconds, driving it in a corkscrew.
- **Camera:** it **stays in the cockpit section** (cockpit view) with **free 360° look**: drag to turn around and watch through the open back as the rear half drops away, spinning, burning, shedding pieces. Add strong wind roar, alarm tones, cockpit shake and flickering instrument lights. Controls do nothing meaningful (the stick has no effect); the player is a passenger in the falling cockpit until impact (section 11). A **"Skip"** button is allowed.

### 8c. Explode tail (tail blown off, on fire)
- **Blast:** an explosion at the tail cone. The fin (vertical stabilizer) and one or both tailplanes **break off** as debris, and the rear fuselage catches fire: big flames and a dense black smoke trail streaming behind.
- **Physics:** remove the stabilizing tail moments from the flight model (no weathervane yaw, no pitch restoring moment, tail controls gone).
  - **Pitch:** the plane becomes unstable and starts pitching **up**, with the centre of pressure moving forward. Depending on speed and the player's input, it either pitches up into a stall and drops, or tucks under.
  - **Yaw:** it goes into a growing yaw oscillation, and may enter a **flat spin**.
  - **Controls:** the player keeps reduced roll and pitch control (wings and throttle only) and can fight it for a while. Differential engine thrust (throttle split, engine buttons) changes the spin.
  - **Fire spreading:** the fire spreads forward along the fuselage over ~20 s. If the plane is still airborne after 25–40 s, the fire reaches the centre tank and triggers 8a.
- **Camera:** the chase camera widens to keep the burning tail and the smoke ribbon in frame.

## 9. Out of map: warning, then engines failing one by one

- Crossing the **warning radius (5.5 km)**:
  - **Warning:** a red edge vignette, a top banner **"OUT OF MAP — TURN BACK"** with a **10 s countdown**, a beeping tone, and a minimap arrow pointing to the island.
  - **Turning back** inside the radius cancels it.
- Still outside when the countdown ends (or crossing the 6.5 km radius at any time), the **failure sequence** starts and **cannot be cancelled**:
  1. **Engines:** one **alive engine explodes every 10 seconds**, exactly as if its button had been pressed (section 7), in order 1 → 4, skipping engines already destroyed. Banner: "ENGINE FAILURE — 2/4".
  2. **Gliding:** after the last engine, the plane glides.
  3. **Guaranteeing a sea crash:** the failure state adds damage drag that keeps increasing and slowly pushes the nose down, so the plane **always comes down within ~40 s after the last engine**, out over the sea. The player keeps the controls and can choose how to hit the water.
  4. **Single-engine prop plane:** one explosion, then the same glide-and-drag rule.
- The impact uses the **water crash** handling (section 11).

## 10. Breakup system (how planes come apart)

- **Parts and break groups:** each plane model is built from named parts: nose, cockpit, forward fuselage, centre fuselage + wing box, rear fuselage, tail cone, fin, left/right tailplane, left/right wing (2–3 segments each), engines, gear legs. A **break table** per plane lists which parts form the bodies for each break mode (engine, middle split, tail, total explode, and crash breaks along the weakest joints near the impact point). **Torn-edge caps** (jagged skin rings, dark interior, exposed frames) are pre-generated for each break line and shown only when that line breaks.
- **Spawning pieces:** at the moment of a break, replace the single plane body with one dynamic body per piece, at the exact current world transform:
  - **Mass:** each piece's mass and inertia come from the part table, and the masses sum to the plane's mass.
  - **Velocity:** **linear velocity = plane velocity + ω × r** (r = from the plane's centre of mass to the piece's centre of mass), angular velocity = the plane's ω. This conserves momentum and keeps the motion continuous: nothing jolts on the break frame.
  - **Kick:** add the explosion impulse: radial from the blast centre, `Δv = K · energy / (piece mass · (1 + d²))`, **clamped to 10–25% of the current airspeed** for in-flight blasts, so forward momentum dominates. A blast at 700 km/h throws the wreckage *forward along the flight path*, not out in a sphere.
  - **Tumble:** a small random angular kick so the pieces tumble.
- **Aerodynamics of the pieces** (cheap):
  - **Drag:** every piece gets drag `½·ρ·v²·CdA` applied at its **centre of pressure, offset from its centre of mass**. Asymmetric pieces tumble and flutter on their own, compact pieces (engines) fall fast and straight, light panels flutter and drift.
  - **Wing pieces** keep a reduced lift model, so a severed wing autorotates (spins like a sycamore seed) as it falls.
  - **Fuselage sections** with an open end get extra drag on the open side.
- **Burning:** pieces that carry fuel (centre box, wings, engines) burn with fire and smoke emitters attached at their surface points, emitted in world space so they leave trails. Other pieces get a short smoke trail. Burning pieces cool down over 20–60 s.
- **Budget:** at most ~24 bodies per plane (prop ~8) plus pooled small debris (non-colliding particle meshes for tiny fragments). Merge or freeze pieces that come to rest. Sink pieces in water after 20–60 s with bubbles, then remove them.

## 11. Crash mechanics (impacts with ground, runway, buildings and water)

### Detection
Every plane body (and every piece) reports contacts. From each contact compute:
- the **impact speed** split into its **normal** and **tangential** components;
- the **impact angle**;
- **which part touched first** (nose, wing tip, gear, belly, tail);
- the **kinetic energy**.

These pick the outcome and where the airframe breaks.

### Outcomes
1. **Landing:** gear down, vertical speed under 3 m/s, bank under 10°, nose not pointing down, on a runway or flat ground. Normal touchdown with tyre smoke puffs and a squeal; rollout with brakes.
2. **Hard landing:** vertical speed 3–6 m/s, or gear up on a runway/flat ground.
   - **Gear:** it collapses, with a strut-snap sound.
   - **Slide:** a **belly slide** with sparks streaming backward, scrape marks painted on the ground, dust (or spray on wet ground), engines scraping and possibly tearing off. The fuselage may crack into 2 pieces.
   - **Fire:** a moderate fire.
   - **End:** the plane slides to a stop following real friction (asphalt μ ≈ 0.5 for metal, grass ≈ 0.7 with ploughing drag).
3. **Ground crash:** vertical speed over 6 m/s, steep angle, or high speed into rough terrain or an obstacle.
   - **Breakup:** the airframe breaks at the joints nearest the impact and along the weakest lines.
     - **Nose-first:** the nose crushes (crumple deformation, then detaches) and the fuselage splits into 3–5 sections.
     - **Wing-tip-first:** the wing tears off and the plane **cartwheels** (the angular momentum comes from the offset contact point, not scripted).
     - **Belly-first at speed:** a long slide that breaks up progressively.
   - **Momentum:** every section keeps its momentum and slides, tumbles or bounces along the impact direction with ground friction. Sections **plough** soft ground (a dust plume and a gouge decal following the piece).
   - **Fuel ignition:** a **main fireball at first impact that moves with the wreckage** (section 12, momentum inheritance), then **secondary explosions** every 0.3–1.5 s as tanks rupture (when a fuel-carrying piece takes a hard hit or 2–4 random timed bursts), plus a **trail of burning fuel patches** along the whole slide path that burn for 20–40 s.
4. **Water crash:** the most common one (out-of-map), so make it spectacular.
   - **Water drag model:** when a piece's points go below the water surface, apply a strong drag ∝ v² × submerged area at those points (much higher than air) plus buoyancy. A plane hitting water fast decelerates violently, and **the point that hits first gets dragged hardest**:
     - nose-down impacts **pitch over and flip**;
     - a wing tip catching the water **cartwheels** the plane across the surface;
     - a flat, slow ditching (under ~1.3× stall speed, wings level, nose slightly up) can **skim and stay mostly intact**, settling and floating for a while before sinking.
   - **Breakup thresholds are lower on water at speed** (above ~250 km/h water behaves like concrete).
   - **Effects:**
     - a huge **spray plume** whose height and particle count scale with speed²;
     - a ring of splash, plus a long spray sheet along the skid path if the plane skims;
     - foam on the water surface;
     - **steam** where fire meets water.
   - **Fire on water:** a **burning fuel slick** spreading on the surface (fire patches floating, merging and slowly dying), black smoke columns. The impact fireball **skims forward over the water** with the wreck's momentum.
   - **Aftermath:** pieces float briefly and sink over 20–60 s with bubbles; the tail fin is often the last thing above water.
5. **Buildings and other static obstacles:**
   - **Plane:** hitting a building is a ground-crash breakup at that contact. The plane crushes, explodes and breaks up against the facade; the wreckage falls to the street and burns there.
   - **Building:** it is **not damaged structurally** (no collapse): scorch decals and fire on the facade near the impact only.
   - **Car and props:** the parked car and street props react to the blast as in the part 1 explosion.

### The momentum rule (important: this is what makes it feel real)
- Explosions caused by impacts **move with the wreck**:
  - **Emitters:** they spawn at the impact point with the wreck's velocity, then slow down by air drag, so the fireball rolls forward along the crash direction instead of blooming in place.
  - **Kick:** the radial blast kick stays small compared with the sliding or flying momentum.
  - **Fire trail:** fire is left behind along the path, because fuel keeps spilling as the wreck travels.
- At 300 km/h the result is a **long, forward-streaking fire storm with tumbling pieces**, not a static ball of fire.

### Crash camera and flow
- **Impact:** a brief slow-motion dip (0.3× for ~1.5 s), a camera switch to the best crash shot (wide chase, low ground angle or water level, depending on the impact type), shake scaled by distance.
- **Afterwards:** the camera settles on the burning wreck, and the **Back to car / Respawn plane / Retry in air** buttons appear after 3 s.
- **Middle split:** the cockpit section impact is shown from inside the cockpit (violent shake, a white-out flash, then a cut to an outside shot of the wreckage).

## 12. Explosion and fire FX (shared with the car, scaled up)

- **Phases of a big explosion:**
  1. **Flash (0–0.1 s):** a white-hot core sprite, a light intensity spike, a bloom pop.
  2. **Fireball (0.1–1.5 s):** hundreds of soft, self-shadowed puff particles with a **blackbody heat colour ramp** (white-yellow → orange → deep red → black smoke) and turbulent expansion, then rising on buoyancy into a mushrooming smoke column. **Keep flames optically thick** so stacked particles don't sum to pure white.
  3. **Shockwave:** a fast expanding transparent ring or dome with a bright rim; a ground dust ring or water spray ring near the surface; a camera shake when the front reaches the camera.
  4. **Debris:** burning chunks with fire and smoke trails, sparks with velocity-stretched streaks.
  5. **Aftermath:** lingering fires and smoke columns drifting with the wind.
- **Momentum inheritance (core rule):** every particle and debris piece spawned by an explosion **starts with the exploding object's velocity** (fireball ~80–100%, smoke ~60%, sparks ~100% + their own spread), then **decelerates by drag toward the wind velocity**. Moving explosions become streaking comets of fire and smoke.
- **Wind-blown fire:** flames on a moving aircraft are emitted in world space and stretched backward by the relative airflow, so burning engines and tails leave long continuous trails.
- **Scale by fuel:** car < prop plane < private jet < airliner < jumbo. Particle counts, sizes, light intensity and shockwave radius all come from the fuel table.
- **Lights:** up to 2–4 flickering dynamic point lights for the biggest active fires; the rest of the fire glow is emissive-only.
- **Sound** (procedural, Web Audio):
  - **Delay:** distant explosions are **delayed by distance / 343 m/s**.
  - **Blasts:** layered booms (sub thump + crack + debris rattle), fire roar loops whose volume follows the fire size.
  - **Breakups:** metal tearing for breakups, big water roars for sea impacts.
  - **Flight:** wind noise rising with airspeed, alarm tones in the cockpit (generic tones, no voice samples from real aircraft).
- **Performance:** GPU-instanced sprite particles with per-quality caps (Low ~3k, Medium ~8k, High ~20k), pooling, soft particles, nothing that allocates per frame. In flight, keep the explosion system working at 30 fps on a mid-range phone by scaling counts down rather than dropping effects.

## 13. Performance in the air

- **Altitude LOD:**
  - **City chunks:** above ~150 m, swap to merged low-detail meshes; above ~600 m, to a single island impostor mesh.
  - **Pedestrians and parked-car physics:** disabled above ~80 m.
  - **Airport:** keeps its detailed meshes within 1.5 km.
- **Planes:** each has 3 LODs; the jumbo's high-detail mesh only within ~200 m.
- **Rendering and physics:** the ocean far LOD and fog hide the horizon cleanly. Shadows only around the player plane (and the car when nearby). Physics runs only on bodies near the player; the breakup budgets above are hard caps.

## 14. Milestones (each one playable)

1. **Island + airport + map menu:** directions (route on the minimap and the road) and teleport.
2. **Boarding + flight model:** all four planes, take-off, flying, landing; cameras and the flight HUD; assisted and realistic modes.
3. **Engine buttons + engine explosions + out-of-map sequence.**
4. **Breakup system:** Explode, Explode middle (cockpit free look), Explode tail.
5. **Crash mechanics:** landing / hard landing / ground crash / water crash / buildings, plus momentum-correct explosions, burning slicks and trails, sinking.
6. **Polish:** audio, performance pass on mid-range phones, tuning each plane to its table.

## 15. Acceptance checklist

- [ ] Directions draw a correct, recalculating route from anywhere in the city to the airport car park; teleport lands the car there safely.
- [ ] BOARD appears only near a parked plane at low speed; EXIT works only when stopped on the ground; the car is still where it was left.
- [ ] Each plane lifts off around its listed rotation speed with a light pull, feels clearly different (prop twitchy, jumbo heavy), stalls believably below its stall speed, and can be landed back on the runway by a casual player with assists on.
- [ ] Engine buttons show 1 / 2 / 2 / 4 for the four planes, numbered left to right; each explosion kills that engine's thrust, yaws the plane toward the dead side and leaves a fire and smoke trail in world space.
- [ ] Out of map: a 10 s warning, then one engine explodes every 10 s, and the flight always ends in a sea crash.
- [ ] Explode / Explode middle / Explode tail behave as described. In explode middle the camera stays in the cockpit, free look works, and the rear half visibly separates and falls away.
- [ ] Breakups conserve momentum: no jolt on the break frame, and wreckage continues along the flight or slide path.
- [ ] Ground crashes (nose-first, wing-first, belly) and water crashes (dive, cartwheel, ditching) each look distinct and come from the physics, not canned animations; impact fireballs travel with the wreck.
- [ ] Buildings never collapse; planes break up against them.
- [ ] 30 fps on a mid-range phone while flying over the city, including during an airliner explosion (with reduced particle counts on Low).
- [ ] 30 explode/crash → respawn cycles in a row with no memory growth or leftover bodies.
- [ ] No passengers, no gore, no real aircraft brands, airlines or logos anywhere.
