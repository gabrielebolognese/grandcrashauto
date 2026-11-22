# Build brief: mobile-first 3D city driving sandbox for the web (prototype v0.1)

> This is the user's original brief, verbatim. It is the source of truth for scope. See `CLAUDE.md` for architecture/ownership.

You are building a playable, **original** 3D open-city driving sandbox that runs in the browser and is fully playable on **phones (touch, landscape)** as well as desktop. This first version is only about **driving**: a living city to cruise around, a garage to customize the car, ambient pedestrians walking and sitting, and a big **Explode / Reset** button. Build it end to end, milestone by milestone, with a playable build at every step.

## 1. Scope

**In v0.1**
- A compact open city you can drive anywhere in (roads, sidewalks, buildings, beachfront, park, highway loop).
- One player car at a time, chosen and customized in a garage.
- Ambient pedestrians: walking, standing, chatting, sitting on benches, reacting to the car.
- Parked cars and knockable street props.
- Explode / Reset button.
- Touch controls for mobile, keyboard and gamepad for desktop.
- Procedural audio, HUD, minimap, settings, save/load.

**Not in v0.1** (keep the code ready for them, but don't build them): getting out of the car / on-foot player, missions, weapons, police, AI traffic driving on the roads (optional stretch goal, off by default), interiors, multiplayer.

## 2. Originality and content rules

- Everything is original: the city, its name, the cars, the brands, the characters. **No real car brands or logos, no real-world maps, and nothing copied from an existing game** (no recreated assets, characters, map layouts, UI or names).
- Use only assets generated in code or from CC0 / MIT sources, and list every third-party asset with its licence in `CREDITS.md`.
- Pedestrians react to collisions with stumbles, falls and ragdolls. **No blood, gore or dismemberment.**
- Working title: **"Coastline"** (placeholder, easy to rename in one config value).

## 3. Tech stack

- **TypeScript + Vite**, static build deployable to any static host (GitHub Pages, Netlify, Vercel). No backend.
- **Three.js (WebGL2)** for rendering.
- **Rapier (`@dimforge/rapier3d-compat`)** for physics: the raycast vehicle controller (`DynamicRayCastVehicleController`) for the car, plus static/dynamic bodies for the world and props.
- **Web Audio API** for all sound (procedural, no audio files required).
- No game engine and no UI framework required. Plain DOM/CSS for menus and HUD (or a tiny framework if it clearly helps), canvas for the minimap.
- Code layout (suggested): `src/core` (loop, input, settings, save), `src/world` (city generation, streaming, props), `src/vehicle` (physics, models, customization, damage), `src/npc` (crowd, animation, behaviour), `src/fx` (particles, explosion, skid marks), `src/audio`, `src/ui` (HUD, garage, menus), `src/config.ts` (every tunable number in one place).

## 4. Performance targets (non-negotiable)

- **Mid-range phone (e.g. iPhone 12, Pixel 6, recent mid Android): stable 30 fps or better** on Low/Medium. Desktop with a modest GPU: 60 fps on High.
- First playable load under ~10 s on a decent 4G connection. Initial download under ~15 MB, with the rest streamed after the menu appears.
- Mobile budgets: under ~150 draw calls, under ~300k visible triangles, at most one shadow-casting light, device pixel ratio capped at 1.5 (Low: 1.0). Use instancing for buildings, props, palms and parked cars; frustum and distance culling; LOD.
- **Auto-detect a quality preset** on first launch (Low / Medium / High from GPU tier and a 3-second frame-time probe), let the player override it in Settings, and add **dynamic resolution** that lowers the render scale when frame time stays above budget.
- No memory leaks: exploding and resetting 50 times in a row must not grow memory (dispose geometries, materials and textures, pool particles and NPCs).

## 5. The city

- Size about **800 × 800 m**, generated procedurally from a seed (the same seed always gives the same city) and split into **100 m chunks** that load and unload around the player.
- **Districts:**
  - **Downtown:** taller glass and pastel towers, a dense grid, wide boulevards.
  - **Beachfront:** a palm-lined boulevard along the sand, a sea wall, the ocean to the horizon.
  - **Residential:** low pastel houses and small apartment blocks.
  - **A park:** grass, trees, paths, benches.
  - **A highway loop** around the city with on-ramps, a few banked curves and one big jump ramp.
  - **A parking-lot hub** next to the garage, which is the spawn point.
- **Roads:** two- and four-lane streets with lane markings, intersections with crosswalks and (visual-only) traffic lights, curbs, sidewalks. Keep a road graph in data, because the pedestrians, the minimap and the reset logic all use it.
- **Buildings:** instanced boxes with a procedural facade shader (windows in a grid, storefronts on the ground floor, lit windows at night). Add rooftops, parapets and awnings. Every building gets a static box collider.
- **Street props:** streetlights, palms, benches, bins, hydrants, cones, barriers, bus stops. Light props (bins, cones, barriers, benches) are dynamic and get knocked flying when hit. Heavy ones (lamp posts, palms) are static, or optionally snap and topple when hit hard.
- **Parked cars** along the streets: simple dynamic bodies the player can shove and push around.
- **Look:** a sun-drenched coastal city. Warm sun, cool lavender-blue shade (shadows are never black), soft haze in the distance, big cumulus clouds, pastel art-deco colours, glossy cars and water. Use ACES tone mapping, an environment map from the sky for reflections, and a light bloom on High. **Day is required; a sunset and a night preset (headlights, emissive windows, streetlight glow) are a stretch goal** behind a time-of-day setting.
- **Water:** an animated ocean plane with waves, fresnel and sun glitter. The car can drive into the shallows; deep water triggers a reset.

## 6. The car

- **Physics:** a Rapier raycast vehicle with 4 wheels.
  - **Suspension:** rest length, stiffness, damping, travel.
  - **Tyres:** friction slip, side-friction stiffness.
  - **Engine:** a force curve with automatic gears (5 forward plus reverse) and a top speed around 200 km/h.
  - **Brakes and handbrake:** brakes, plus a handbrake that drops rear grip so the car can drift.
  - **Steering:** angle that shrinks with speed.
  - **Stability:** an anti-roll assist, mild downforce, a little air control for landing jumps.
- **Feel:** arcade-leaning but weighty. Easy to drive with thumbs, drifts with the handbrake, satisfying on jumps. Every number lives in `config.ts`, and a hidden debug panel (`?debug`) exposes sliders for live tuning.
- **Recovery:** if the car is upside down or stuck for 2 s, show a "Flip car" prompt. Falling out of the world or into deep water auto-resets.
- **Car models:** **4 original car bodies built in code** (a sports coupe, a muscle car, a compact hatchback, an SUV). Each is about 10–25k triangles, with separate parts for body, glass, wheels (rim + tyre), lights, bumpers and mount points for the kit parts. They must look good up close in the garage and cheap from the chase camera.
- **Effects:** skid marks (decals fading over time), tyre smoke when drifting, sparks when metal scrapes, dust on dirt and sand, brake lights, working headlights at night.
- **Light damage:** vertex dents near impact points, cracked then shattered windows, a bumper that hangs and then falls off after big hits. A Reset repairs everything.

## 7. Garage and customization

A garage scene where the car sits on a slowly turning platform. Swipe or drag to orbit, pinch or scroll to zoom. A bottom tab bar holds the categories; every change previews live.

- **Paint:** colour picker plus curated swatches. Finish: gloss, metallic, matte, pearl, colour-shift. Optional two-tone roof and racing stripes (procedural decals).
- **Wheels:** at least 6 rim designs (procedural), rim colour, tyre profile, wheel size.
- **Body kit:** front splitter, side skirts, rear spoiler (none / lip / ducktail / GT wing), hood scoop.
- **Stance:** ride height (changes the physics suspension rest length too) and visual camber.
- **Extras:** window tint, headlight colour, underglow neon colour (glows on the ground at night), custom licence-plate text.
- **Performance:** engine, tyres, brakes and suspension, 3 levels each. They change the physics parameters, shown as stat bars (top speed, acceleration, grip, braking).
- **Save:** 3 save slots in `localStorage`, auto-save of the last car, and a **share code** (the build encoded in a short URL parameter) that loads someone else's car.
- Buttons: **Drive** (spawns the car at the garage exit), Randomize, Reset to stock.

## 8. Pedestrians (ambient crowd)

- **Density** scales with the quality preset: about 30 active on Low, 60 on Medium, 120+ on High. They spawn and despawn in a ring around the player (about 40–150 m), pooled, never popping in inside the camera view.
- **Characters:** rigged low-poly humans in varied, casual everyday clothes, adults only.
  - Use a CC0 or MIT source (for example Quaternius' animated character packs, CC0) or build simple original ones, and list them in `CREDITS.md`.
  - Variation: per-instance clothing and skin tint, height scale, and a few hairstyles or accessories.
  - Rendering many characters cheaply: use GPU skinning via **baked animation textures with instancing** (or a similarly cheap path), so dozens of NPCs cost a few draw calls. Far NPCs drop to a lower LOD.
- **Animations:** walk, idle, talk (gesturing), look at phone, sit on bench, look around, run or flee, jump aside, stumble or fall, get up.
- **Behaviour** (a small state machine per NPC):
  - walk along sidewalks following the road graph, crossing at crosswalks;
  - stand in small groups chatting;
  - sit on the benches (snap exactly to the seat) and in the park;
  - use the bus stops;
  - wander in the park and on the beach promenade.
- **Reacting to the car:**
  - **Horn:** nearby NPCs turn and look.
  - **Car coming fast onto the sidewalk:** NPCs in the path dive aside or run.
  - **Hit by the car:** the NPC gets knocked over with the car's momentum (a simple ragdoll, or a physics capsule plus a fall animation and an impulse), lies down briefly, gets up and walks away or despawns. **No gore, no blood.**
  - **Explosion nearby:** NPCs are knocked back or flee and scream.
- NPCs never walk through buildings and never stand in the middle of the road except at crosswalks.

## 9. Controls

**Mobile (landscape; show a "rotate your phone" overlay in portrait):**
- Left thumb: steering, either a horizontal drag slider or left/right arrow buttons (selectable in Settings). Optional tilt steering through the device orientation API (iOS needs a permission tap).
- Right thumb: big **GAS** pedal, **BRAKE/REVERSE** pedal, **HANDBRAKE** button.
- Top bar: camera switch, horn, **💥 Explode / ↺ Reset**, pause (opens the menu and the garage), fullscreen.
- Full multi-touch: gas, steer and handbrake together. Hit targets at least 64 px, semi-transparent, layout adjustable (left-handed mirror and size slider in Settings). Light vibration on impacts where supported.
- No page scrolling, zooming or long-press menus: the right viewport meta, `touch-action: none`, prevent default gestures. Handle safe areas (the notch) with `env(safe-area-inset-*)`.

**Desktop:** WASD/arrows to drive, Space = handbrake, H = horn, C = camera, X = explode, R = reset, Esc = pause. **Gamepad** through the Gamepad API (triggers for gas/brake, stick for steering, buttons for handbrake, explode, reset, camera).

## 10. Explode / Reset button

One button with two states:

1. **💥 Explode** (while driving):
   - **Blast:** the car explodes immediately. A fireball (particle sprites with heat colour), a bright flash light, an expanding shockwave ring and ground dust, and camera shake with a brief slow-motion dip.
   - **Car:** it is thrown up and tumbles. Wheels, hood, doors and bumpers detach as physics debris, the body turns charred black, then fire and smoke keep burning on the wreck.
   - **Surroundings:** nearby props and parked cars are pushed away by a radial impulse that falls off with distance; nearby pedestrians are knocked back or flee; parked-car windows within the blast radius shatter.
   - **Sound:** a big procedural boom, debris rattling, then the fire crackling.
   - The button changes to **↺ Reset**.
2. **↺ Reset** (on the wreck, or any time with a long-press, or the R key):
   - The car respawns repaired, upright and still, at the nearest safe road position in the driving direction (from the road graph). It keeps its customization.
   - A quick fade or flash hides the swap, and the debris, fire and decals are cleaned up.
   - Optional auto-reset 6 s after an explosion (a Settings toggle).

## 11. Camera

- **Chase camera:** spring-follows the car. Distance and height grow with speed, the field of view widens at high speed, and it looks into turns and drifts. A raycast pulls it in when a building would block the view.
- **Other modes:** hood/bumper camera, a free orbit camera (drag to orbit, auto-returns), a **look-back** button.
- **Explosion:** a short cinematic orbit around the blast, skippable by tapping Reset.

## 12. Audio (all procedural, Web Audio)

- **Engine:** layered oscillators plus filtered noise driven by rpm and throttle, gear-shift dips, a turbo whoosh on the upgraded engine.
- **Tyres, impacts and horn:** tyre squeal from slip, impacts scaled by force (metal, plastic, glass), and a horn.
- **Explosion:** boom, debris and fire layers.
- **City ambience:** distant traffic hum, the ocean near the beach, crowd murmur near pedestrians, short reactions when startled.
- Unlock the audio on the first touch. Master, effects and engine volume sliders, plus a mute button.

## 13. HUD and menus

- **HUD:** speed (km/h or mph), gear, a rev bar, and a **minimap** (canvas, roads from the road graph, rotating with the car) — all in a corner that doesn't fight the touch controls.
- **Main menu:** Play, Garage, Settings, Credits.
- **Settings:** quality preset and individual toggles (shadows, bloom, NPC density, render scale, time of day), control layout and sensitivity, units, audio, show FPS.
- **Pause menu:** Resume, Garage, Reset car, Settings, Main menu.
- **Loading screen:** a progress bar, and a short "tap to start" (needed for audio and fullscreen on mobile).

## 14. Architecture notes

- **Game loop:** fixed-step physics at 60 Hz with rendering interpolation, `requestAnimationFrame`, pausing when the tab is hidden.
- **Input:** one input layer that maps touch, keyboard and gamepad into the same actions (throttle, brake, steer, handbrake, horn, explode, reset, camera).
- **Determinism:** the city seed controls generation; NPC and prop randomness is seeded per chunk.
- **Saving:** all persisted data in one versioned `localStorage` key, with migrations.
- **Error handling:** an on-screen overlay in `?debug` mode; if WebGL2 or the physics fail to start, fall back to a friendly message.

## 15. Milestones (each one is a playable build)

1. **City and car on desktop:** generated city chunks, colliders, raycast-vehicle driving, chase camera, reset.
2. **Mobile:** touch controls, orientation and fullscreen handling, quality presets, dynamic resolution. Hits the frame-rate target on a mid phone.
3. **Garage:** car models, all the customization options, stats affecting the physics, save slots, share code.
4. **Pedestrians:** walking, sitting, groups, reactions, knock-downs.
5. **Explode / Reset:** the full explosion effect, debris, shockwave on props, NPCs and parked cars, respawn logic.
6. **Polish:** audio, HUD and minimap, settings, menus, a performance pass, `CREDITS.md`, a README with run/build/deploy instructions.

## 16. Acceptance checklist

- [ ] Runs from `npm install && npm run dev`; `npm run build` produces a static site that works when served from any static host.
- [ ] 30+ fps sustained on a mid-range phone on Low/Medium while driving through downtown with NPCs; 60 fps on desktop High.
- [ ] Gas, steering and handbrake can be held at the same time on a touchscreen; no accidental page zoom or scroll.
- [ ] You can drive the whole city and the highway loop without falling through the world; flip recovery and the safe-road reset always work.
- [ ] Every customization option changes the car visibly (and the performance ones measurably); the setup survives a page reload; a share code reproduces a car exactly.
- [ ] Pedestrians walk only on sidewalks and crosswalks, sit cleanly on benches, react to the horn and to fast cars, and fall and get up when hit, with no gore.
- [ ] Explode then Reset works 50 times in a row with no memory growth and no leftover debris.
- [ ] Every third-party asset is listed with its licence in `CREDITS.md`; no real brands, logos or copied game content anywhere.
