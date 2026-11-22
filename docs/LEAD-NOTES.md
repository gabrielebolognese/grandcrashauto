# Lead notes (orchestration state)

Session 2 (after a PowerShell crash): all agents resumed with their FULL remaining scope (part 1 finish + part 2 +
part 3 additions) in one message each, so no further wave messages are needed — just integrate as they report.
Live preview: `LIVE_PREVIEW=1 npx vite --host --port 5999 --strictPort` (debounced full reloads). Port 5173 is taken.
Smoke runs: machine-wide limit of 2 concurrent (lock files in %TEMP%, PID-checked).

## Agents (resume with SendMessage to the id — they keep their module context)
| module | agent id | scope |
|---|---|---|
| world | aac23918e3639b472 | city + airport (west, by coast) + exits + delegation to terrain/highways + night windows/neon + altitude LOD |
| env | aeb3edd2fe5c024a1 | sky/ocean/post + ocean all around/altitude + day/night clock + weather + patchMaterial + turbo post |
| props (v2) | a02c54282847a6454 | props + parked cars + airport kinds + streetlight light pool + wind sway |
| vehicle | ae899d50292c891b0 | physics/damage/explosion + turbo + airborne/barrel roll/glide + weather grip + headlights |
| camera | a2227f757b547b4db | car cams + plane cams/cockpit sequence/crash shots + turbo FOV + roll orbit + origin shift |
| carmodels | ad19f0bc7229bae48 | 4 cars + night lamps + exhaustPoints/rearCorners/headlightPoints |
| garage | abbc23387d67c6dc2 | garage + perf.turbo + share code v2 |
| npc | a128f3900a29e0e80 | crowd + altitude hide + night/rain density + addAmbientSpot |
| fx | a26be4a8a435361a2 | part-1 fx + all part-2 IFx members + turbo flames/vapour/rain splashes/wind |
| audio | a4875191712a494ce | part-1 + plane audio + weather/thunder/tunnel/turbo |
| ui | a088dfa80739b7dee | part-1 UI + flight HUD/controls/crash buttons/out-of-map + clock/turbo/barrel roll/stunts/settings |
| planemodels | ad8d50f6de1ac5b67 | 4 planes (restarted from scratch) |
| flight | a6868d902c49a7927 | plane system (restarted; ocean-only out-of-map, airport west, wind) |
| breakup | a29cdb882db06fac6 | breakup/crash (restarted; terrain.waterAt) |
| terrain | a41096cc2bf99adb9 | NEW part 3: worker terrain, biomes, coast, lakes, scatter, mountain ring, POIs |
| highway | a8feda9d9492f3b78 | NEW part 3: highway network, structures, interchanges, rest stops, ramps, (traffic) |
| nav | a43454e51eace0829 | NEW: POIs/discovery, A*, ribbon, turn card, map screen, teleport |

## Integration checklist (lead)
- After each report: typecheck, smoke, review screenshots, fix cross-module issues, commit.
- Final: smoke default/menu/garage/mobile, tour, leak (50× explode/reset), plane leak (30× crash/respawn),
  inland memory plateau, origin-shift test (drive > 2 km, no jumps), perf numbers (calls/tris), README, CREDITS.

## Completed modules
- camera, fx, audio, garage (all pushed via commits / live auto-push).
## Integration follow-ups
- audio: cockpit detection uses `cameraRig.mode === 'hood'` → switch to optional `ICameraRig.view` ('cockpit'|'wing'…).
- audio: re-run `node scripts/smoke.mjs --tag audio --script src/audio/smoke-audio.mjs` on a quiet machine.
- UI must forward touch drags to cameraRig.orbitDrag (camera note). Camber while driving → vehicle (sent).
- Repo: github.com/gabrielebolognese/grandcrashauto (main). Netlify via netlify.toml, domain grandcrashauto.lol.
  live.mjs runs with --autopush 15 (commits+pushes passing builds) and archives builds to %USERPROFILE%\crashgame-timelapse\builds.
