# Lead notes (orchestration state)

## Agents (resume with SendMessage to the id — they keep their module context)
| module | agent id | status |
|---|---|---|
| world | aac23918e3639b472 | part 1 running (got island heads-up) |
| env | aeb3edd2fe5c024a1 | part 1 running (got ocean/altitude heads-up) |
| props (v2) | a02c54282847a6454 | part 1 running (v1 a42612b8a4a4d81b2 stopped by accident, can't resume) |
| vehicle | ae899d50292c891b0 | part 1 running |
| camera | a2227f757b547b4db | part 1 running |
| carmodels | ad19f0bc7229bae48 | part 1 running |
| garage | abbc23387d67c6dc2 | part 1 running |
| npc | a128f3900a29e0e80 | part 1 running |
| fx | a26be4a8a435361a2 | part 1 running (got momentum/trails heads-up) |
| audio | a4875191712a494ce | part 1 running |
| ui | a088dfa80739b7dee | part 1 running |
| planemodels | ad8d50f6de1ac5b67 | part 2 running |
| flight | a6868d902c49a7927 | part 2 running |
| breakup | a29cdb882db06fac6 | part 2 running |
| nav | — | to launch after world lands (A*, ribbon, turn card, map screen src/ui/map, teleport) |

## Wave 2 (part-2 work for part-1 agents, send when each finishes part 1)
- world: island 4×3 km terrain (CONFIG.world.island), coast beaches + sea wall all around, 1–2 hills, airport per SPEC-PART2 §2
  (main runway 2200×45 with markings/edge/approach lights/PAPI, crosswind 1200 m, taxiways, apron + 4 stands sized per type,
  terminal + jet bridges, tower, 2 hangars, fences, airport roads + car park ~40 m from apron), CityData.airport + pois + island,
  airport road connected to the road graph, terminal ped area/wander for NPCs, altitude LOD (merged low-detail chunks > 150 m,
  island impostor > 600 m, airport detailed within 1.5 km), colliders for runway/terrain everywhere (planes land/crash anywhere).
- env: ocean all around + far LOD good from 1000 m, visibility ~10 km haze, fog/shadows/clouds adapt to altitude, bloom pop.
- fx: implement optional IFx part-2 members (explosionEx momentum inheritance, attachTrail world-space, splash/spraySheet/steam/
  bubbles/fuelFire/gouge/debrisBurst/mist/scorch), blackbody optically-thick fireballs, shockwave in air + surface rings,
  2–4 pooled flickering lights, caps Low 3k/Med 8k/High 20k.
- audio: plane engines (prop/jet per type, spool, per-engine), wind by airspeed, stall horn, master caution tones, out-of-map beep,
  engine bang + fire roar, explosion distance delay (d/343), metal tearing (planeBreak), water roar (planeImpact water),
  touchdown squeal, gear collapse snap; cockpit alarm in middle-split sequence.
- camera: plane chase (distance by size), cockpit (cameraTarget.cockpitEye) + wing cam + orbit; drag-to-pan in every camera
  returning after 2 s (except cockpit sequence: free look stays); explosion cinematic + follow biggest burning piece; crash shot
  selection; middle-split cockpit sequence shake + white-out; tail-explode widened chase.
- ui: flight HUD (speed tape w/ Vr marker, alt, VS, throttle, gear/flaps, stall red, heading, engine icons), flight touch controls
  (stick L, throttle slider w/ idle detent + BRAKE + GEAR R, engine buttons bottom centre, top bar camera/explode/middle/tail/reset/
  pause/map), BOARD/EXIT buttons, crash buttons (Back to car / Respawn / Retry in air after crashTime > 3), out-of-map vignette +
  banner + countdown + minimap arrow, masterCaution banner, minimap boundary ring + island + route line (ctx.nav.route), HUD map
  button (ctx.nav.openMap), settings: Assisted/Realistic, flight tilt, invert pitch. Skip button in cockpit sequence.
- npc: disable/hide crowd when focus > 80 m AGL; terminal-entrance crowd uses airport ped data.
- props: parked-car/prop physics off > 80 m AGL; airport props (fuel trucks, baggage carts, windsock).
- vehicle: car must stay parked & stable while player flies (input handbrake), reset/teleport API used by nav & planes.
- carmodels/garage: nothing major.

## Integration checklist (lead)
- typecheck, smoke default/menu/garage/mobile, tour, leak (50× explode/reset), plane leak (30× crash/respawn), perf numbers.
- README (run/build/deploy, controls, URL params), CREDITS, commit per milestone.
