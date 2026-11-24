# Grand Crash Auto: the endpoint for AI video makers

Endpoint version: 8 · 2026-11-24

You are a Claude Code agent in a separate project. Your job is to turn the user's video requests into finished
videos of the game. This file explains everything: how to open the game, how to play it, and how to film it.
A different project (the builder) makes the game. Every time the game changes, the builder appends to the
**Changelog** at the bottom and raises the version number above.

**At the start of every session:** fetch this file again
(`curl -s https://grandcrashauto.netlify.app/endpoint.md`). If the version is higher than the last one you read,
read the Changelog first. Re-download the recorder too.

---

## 0. Where things are

| What | Where |
|---|---|
| The game | https://grandcrashauto.netlify.app/ |
| This document | https://grandcrashauto.netlify.app/endpoint.md |
| The recorder (one file, no dependencies) | https://grandcrashauto.netlify.app/endpoint/film.mjs |
| Agent mode (text view + command API) | add `?agent` to the game URL. Add `&autostart` to skip the title screen and `&rec` for a clean screen |
| Version check, live | `gca.version` in the page equals the "Endpoint version" above (both ship in the same build) |

## 1. Rules

- **You make videos; you never edit the game.** If a request needs something the game can't do, film the closest
  version you can. Then tell the user exactly what was missing so the builder project can add it. Include the scene
  you tried and what happened.
- **Only one headless browser at a time on this machine.** The recorder queues itself automatically. Never start two
  recorders at once, and never loop renders back to back without reason.
- Put videos in your project's `videos/` folder, which is the recorder's default.
- Never use `?debug` or internal objects (`gca.raw`) in the scenes you deliver. Stick to the commands below: they are
  the stable contract, and internals can change without notice.

## 2. Quick start (first session, about 5 minutes)

```bash
node -v                      # needs 22 or newer (built-in WebSocket)
ffmpeg -version              # needs ffmpeg on PATH (Windows: winget install Gyan.FFmpeg)
curl -sO https://grandcrashauto.netlify.app/endpoint/film.mjs     # Chrome or Edge must be installed

# 1) rehearse (about 1 min, no video): writes a text timeline and a contact sheet
node film.mjs --dry --seconds 12 --scene "night; fly jumbo agl 9 speed 140; wait 3.5; pitch up 1.6; wait 1.6; split"

# 2) film it (15 s of 1080p takes about 3 min); the MP4 opens by itself
node film.mjs --name low-split --seconds 15 --scene "night; fly jumbo agl 9 speed 140; wait 3.5; pitch up 1.6; wait 1.6; split"
```

Look at the files it writes:
- `videos/<name>-<time>.sheet.jpg`: 16 frames from across the shot. Open it with the Read tool.
- `videos/<name>-<time>.txt`: what the game reported, second by second.

The scene above is **user-approved**: "it's perfect". At night a 747 skims the treetops, lifts its nose and splits
in half. The front half hits first, then the camera follows the rear half crashing through the trees.

## 3. From a request to a finished video

1. **Beats.** Write the request as timed beats. For example: 0–5 s skimming the trees, about 5 s split and
   fireball, about 8 s front half slams in, about 11 s rear half crashes, 11–15 s aerial over the burning wreck.
2. **Scene.** Translate the beats into commands (§6 reference, §7 vocabulary, §8 proven scenes).
   `wait N` sets the timing.
3. **Explore** (optional, when you don't yet know how something looks or behaves). Play it live in Chrome (§5),
   using freeze, the forecast and screenshots.
4. **Rehearse.** Run `--dry`. Read the `.txt` timeline: did the events happen when the beats want them? Check the
   EVENTS line, the pieces in the FORECAST, and `CRASHED/DESTROYED`. Read the `.sheet.jpg`: is the framing right, is
   it readable, is it night, is the subject on screen?
5. **Adjust.** Change wait times, height, speed, time of day or weather, then rehearse again (about 1 min each).
   Two or three rounds is normal.
6. **Film.** Landscape 1920×1080 is the default. Use `--vertical` (1080×1920) for Reels, TikTok and Shorts, and
   `--square` for feed posts.
7. **Verify.** Read the final `.sheet.jpg`. If one moment matters, pull a frame from it:
   `ffmpeg -ss 4.8 -i video.mp4 -frames:v 1 check.jpg`
8. **Deliver.** Give the user the path, a second-by-second description, the scene line you used (so it can be
   re-filmed or varied), and any differences from what they asked for.

**If the user gives you a reference video** (a clip to recreate): build a contact sheet to see what happens,
then map each beat to a command.
```bash
ffmpeg -i ref.mp4 -vf "fps=2,scale=480:-2,tile=4x4" -frames:v 1 ref-sheet.jpg
```

## 4. The game in one minute

- **The world:** a sunny pastel coastal city with a beach on the south coast, and an airport west of the city by the
  west coast. Endless land goes north and east: forests, fields, mountains, lakes, and highways with jump ramps.
  The ocean is west and south. There's a day/night cycle and weather (clear, clouds, rain, storm, fog, snow).
- **The player can:** drive a car (turbo, jumps, barrel rolls, explode) and fly four planes. In the two big planes
  the player can also walk around the cabin, even while the plane breaks apart.
- **Destruction:** blow up engines one by one, split the plane in half, blow off the tail, tear a wing, or explode
  everything.
- **Crash physics:** pieces keep their momentum, burn, tumble and slide. Fuel fires and secondary explosions follow.
- **Trees break:** a plane or a piece clipping trees knocks them over the way it was moving. A fast, low, hard hit
  smashes them to bits, and they stay broken.
- **Wrecks stay:** after a respawn the old wreck stays where it crashed, and its fires fade slowly over a few
  minutes. The last 2 wrecks are kept (1 on low quality, 3 on high), so a new scene can fly past an earlier crash.
- **The camera is automatic and cinematic after a crash.** It follows the pieces, swings to the most interesting
  one (often the rear half), then rises into an aerial view of the wreck. Usually the best footage comes from
  leaving it alone.
- **Sky traffic:** jumbos, airliners, private jets and a few prop planes always fly across the area in different directions, at their own heights. They show on the map, and each one is a real plane that breaks apart, falls and crashes when hit.
- **Missiles and nukes:** 6 air-defence **turrets**, all up in the mountains north and east of the city (none in the city), each a teleport place. A turret is a pedestal with a rotating head and a launcher box:
  - **Twin turret:** 2 big missiles side by side; S fires one, ALL fires both.
  - **Quad turret:** 4 missiles in a square.
  - **Octo turret:** 8 small missiles in a 4×2 block. ALL fires the salvo, and SPREAD makes them hit different spots.
  - **Nuke turret:** 2 nukes side by side. Everything flying within about 1.8 km of the hit goes, and the trees below are flattened.

  **How to shoot:** on the map, tap a plane, then SHOOT. The map zooms out and the turrets glow with a line to the target; **tap a turret on the map** and you are in its control room, looking from behind it.
  - Aim with drag, A/D/W or the arrows, and press S to fire. **No lock is needed.**
  - Aimed at the red marker, it locks and **always hits**; the same keys then pick where (nose, tail, a wing, an engine).
  - Without a lock the missile flies straight and the keys steer it. Its seeker locks on if the plane comes in front of it.
  - Each S fires again. BACK returns to your car or plane while the missiles keep going.
  - The replay shows the missile run and the plane going down. Flying, you can also RAM a sky plane on autopilot, or just crash into one.
- **The beach concert** (west end of the beach) has a big crowd and a band. A crash there knocks people flying and sends the rest running and screaming, and the stage collapses: it is no longer an indestructible block.
- **Cockpit and wing views** look freely in 360° (drag), and stay where you looked.
- **Passengers and crew** (airliner, jumbo, private jet):
  - About a third of the seats are taken, by the same people in the same seats every flight.
  - Most wear seatbelts. Their reactions are fixed: after an engine blast, the window seats by that engine panic, stare at it and scream (mildly), and the rest of that side looks worried. A split, tail blast or explosion makes everyone panic, then brace. A spin or dive keeps them braced, with the odd scream.
  - Two flight attendants walk the aisles, and a few passengers are out of their seats. They have your physics: they get thrown around in a spin, float in a dive, get sucked out of a torn end, and fall.
  - Visible when you walk inside, or up close once the airframe is torn open.
- **Cartoon tone:** people get knocked over comically and there is no gore. Keep requests in that spirit.

| Plane | `fly` name | Engines | Stall speed | Cruise | Notes |
|---|---|---|---|---|---|
| Prop plane | `prop` | 1 | 85 km/h | 210 km/h | small, light, agile |
| Private jet | `jet` | 2 | 170 km/h | 520 km/h | fast |
| Airliner | `airliner` | 2 | 215 km/h | 520 km/h | walkable cabin |
| Jumbo (747) | `jumbo` | 4 | 245 km/h | 540 km/h | the biggest crashes, walkable cabin, the default |

Speeds in commands are in m/s unless you add `kmh` (`speed 140` = 504 km/h, `speed 300 kmh`).
Engines are numbered 1 to 4 from left to right as seen from the cockpit.

## 5. Playing live in Chrome (Claude in Chrome)

Live play is for **understanding and tuning**. For the final video use the recorder, which is smooth, frame-exact
and 1080p.

1. Open a new tab on `https://grandcrashauto.netlify.app/?agent&autostart`. Add `&rec` if the user will watch or
   screen-record. The game loads in 5–15 s, then you are in a car in the city.
2. **Read** the game as text, not from screenshots. A text panel sits bottom-left. Better: run `gca.state()` with
   the JavaScript tool, which returns the same text (format in §9). `gca.json()` gives the same as data.
3. **Act** with the JavaScript tool: `gca.do("fly jumbo agl 30; wait 3; split")`. It returns what each command did
   plus the **forecast**.
4. **Turn-based play** (the best way to tune):
   - `gca.do("freeze")` stops the world.
   - Queue commands, for example `gca.do("pitch up 1.5; wait 2; split")`. While frozen, the reply forecasts
     the outcome: "+2.0 s split at 48 m … front section hits the ground ≈ +3.6 s".
   - `gca.do("run 3")` plays exactly 3 s, then freezes again.
   - Read `gca.state()` and take a screenshot.
5. **Keys** also work after a click on the game. A tap counts as holding the key for 1 s, and taps add up.
   - Planes: S nose up · W nose down · A/D bank · Q/E rudder · M split · T tail · 1–4 engines · X explode
   - Always: K freeze/unfreeze · `.` steps 1 s · Backspace releases everything · C camera · U recording mode
6. **Screenshots** show the look: lighting, framing, how big the fire is. The text gives the numbers.
7. **Background tabs:** the game keeps simulating when its tab is in the background (agent mode has a worker clock),
   but it only draws while the tab is visible. Bring the tab to the front before a screenshot.
8. Commands are plain JavaScript calls. Nothing in the game opens alert or confirm dialogs.

**Recording mode** (`&rec`, the ● button, the U key, or the command `rec on`) shrinks every button and stacks them
in one corner so the screen stays clear. It only matters when someone records the live screen. The recorder films
the 3D view directly, so its videos never contain any buttons.

## 6. Command reference

`gca.do("a; b; wait 2; c")`:
- `;` or a newline separates commands.
- `wait N` delays **everything after it** by N seconds of game time. Waits add up.
- Commands before the first `wait` run immediately.
- Numbers are metres, seconds and m/s.
- `gca.help()` prints the in-game version of this list.

**World**

| Command | Effect |
|---|---|
| `night` · `day` · `sunset` · `dawn` | sets the clock to 23:00 · 12:00 · 19:18 · 06:12 |
| `time 21:30` | any time of day |
| `weather clear` | also `cloudy`, `overcast`, `rain`, `drizzle`, `storm`, `fog`, `snow`, `auto`. With `auto` (the default) the weather drifts on its own, so set `clear` when the look must be predictable |

**Start**

| Command | Effect |
|---|---|
| `fly jumbo` | starts in the air. Options can be combined in any order: `agl 25` (metres above the ground) · `speed 140` / `speed 500 kmh` · `heading 90` / `heading n` (also e, s, w) · `over forest` / `over city` / `over sea` · `at X Z` |
| `fly jumbo agl 9` | **any `agl` below 150 starts over a forest along a straight stretch** and keeps terrain-following at that height, with the gear locked up. 9 m is just above the treetops. Without `agl` the plane starts 380 m up, east of the city, heading toward it |
| `switch airliner` | swaps the plane type in mid-air |
| `car` | back in the car |
| `places` · `teleport <id>` | lists the map places · jumps to one. Teleport works **from the car** and only to places already discovered. A fresh session (every recorder run) knows the city places: `garage airport beach downtown park highway jump concert`; highway and terrain places (Mega Jump, rest stops, viewpoints) unlock once you drive within reach |

**Flying (controls)**

| Command | Effect |
|---|---|
| `pitch up 1.5` · `pitch down 2` | nose up or down for N s. An optional third number sets the strength, 0–1 |
| `climb 2` · `dive 2` | the same thing |
| `bank left 1` · `bank right 2` | roll for N s |
| `bank 30` | holds a 30° bank, + = right (`bank off` releases it) |
| `yaw left 1` | rudder |
| `stick <pitch> <roll> <s>` | both axes at once, each −1..1 |
| `throttle 80` | also `max`, `idle`, `+10`, `-10` |
| `release` | centres everything |

With the stick centred, the assists hold the flight path and keep the wings level.

**Missiles, nukes, sky traffic**

| Command | Effect |
|---|---|
| `traffic` | lists the sky planes: #number, type, height, heading, speed, distance |
| `sites` | lists the turrets: id, kind, missiles ready |
| `shoot nearest` · `shoot 3` | into the control room of the best turret (the nearest ready one, or `from twin|quad|octo|nuke` or a turret id), aimed and locked, and fires. Options: `2` (missiles) · `all` (salvo) · `spread` (different spots) · `aim nose|front|middle|rear|tail|left|right|engine` (where the first one hits). The camera rides behind the first missile, then watches the plane go down |
| `shoot` (already in a control room) | fires again with the same rule |
| `steer <u> <v>` | moves the first missile's hit point: u = −1 left wing … +1 right wing, v = −1 tail … +1 nose |
| `back` | leaves the control room (missiles keep homing) |
| `ram nearest` · `ram 3` · `ram off` | flying: your plane's autopilot flies into that sky plane. It turns into you near the end, so a ram really connects |
| `nuke nearest` · `nuke 3` · `nuke beach` · `nuke x z` | a nuke from the Nuke turret at a sky plane, or an airburst over a place. Each of its 2 tubes reloads in 120 s |

Plane numbers change every session, so scripted scenes should use `nearest`. Turrets reload tube by tube (Twin 35 s, Quad 22 s, Octo 12 s, Nuke 120 s).

**Crash on a target** (the easy way to aim a crash)

| Command | Effect |
|---|---|
| `fly jumbo target concert` | spawns the plane on a straight dive that **crashes into the target**. A homing autopilot keeps steering into it, so it really hits. Options: `in 14` (seconds until impact, default 14) · `from s` (approach direction n/e/s/w or degrees; default: from the sea for coastal targets, else from the east) · `speed 110` · `agl 200` (start height, which sets how steep the dive is; default about a 10° dive) |
| targets | `concert` (between the stage and the crowd: takes both) · `stage` · `crowd` · `city` (downtown) · `beach` · `airport` · `park` · `garage` · `highway` · `jump` · any place from `places` · or `x z` absolute coordinates |
| `target concert` | already flying: home on a target from where you are (it dives into it) |
| `target off` | stop homing |

The text view's AUTO line shows `HOMING on <target> (distance, seconds left)`, and the FORECAST predicts the impact.

**Autopilot**

| Command | Effect |
|---|---|
| `alt 30` | terrain-following height above the ground |
| `heading 270` | turns the short way and holds that heading |
| `speed 120` | holds that speed |
| `level` | wings level |
| `ap off` | turns everything off. Each hold also turns off on its own: `alt off`, `heading off`, `speed off` |

**Destruction**

| Command | Effect |
|---|---|
| `split` | the plane breaks in half at the middle |
| `tail` | blows the tail off. A fire then grows and explodes the plane later; the TIMERS line counts it down |
| `engine 1` … `engine 4` | blows up that engine. Only while the plane is still flying: after a crash or a hard landing it does nothing |
| `wing left half` · `wing right far` | tears the wing in half (an unrecoverable spin after about 30 s; TIMERS counts it) · tears off just the tip. The break catches fire, with smoke and light: a lost tip burns about 15 s, a wing torn in half keeps burning, and the falling piece burns about 8 s |
| `explode` | one big explosion |
| `gear up` · `gear down` | landing gear |
| `respawn` · `retry` | reset · retry in the air |

**On foot** (airliner and jumbo, in flight or in the wreck)

| Command | Effect |
|---|---|
| `walk` | leave the seat and walk in the cabin. Walking is about 3.6 m/s inside (5.4 running) and twice that outside the plane. In first person the view bobs with each step and your hand swings in the lower right, Minecraft-style, and shows in the footage. To walk with commands, use `hold moveY 1 3` (forward 3 s; −1 = back) and `hold moveX 1 2` (right; −1 = left) |
| `window` | look out of the window |
| `view` | switch between first and third person |
| `pilot` | interact or sit |
| `flyagain` | back to flying |

**Car**

| Command | Effect |
|---|---|
| `gas 3` | accelerate for 3 s |
| `brake 1` | brake |
| `steer left 0.5` | steer, optional strength 0–1 |
| `handbrake` | handbrake |
| `turbo 2` | turbo for 2 s |
| `barrel left` | barrel roll (in the air off a ramp) |
| `explode` · `reset` | blow up the car · reset |

**Camera**

| Command | Effect |
|---|---|
| `cam` | next view |
| `cam chase` · `cam cockpit` · `cam wing` · `cam orbit` | a specific plane view (`hood` is car only) |

During the automatic crash camera, `cam` **ends that cinematic** and returns to a normal view. Only use it when you
want to cut it short.

**Replay**

| Command | Effect |
|---|---|
| `replay` | after a crash, replays the last ~14 s. **One camera per pass, complete**: the whole clip plays from one camera, and the next pass switches to the next camera. Order: Chase, You (only if you were walking), Side (a spectator beside the big moment), Ground (a spectator on the ground near the crash site), Orbit, Tail, Top. The plane looks intact until the moment it broke, and fires appear only when they started. Slow motion around the main moments (engine blasts, the split / tail / total explosion, the first hard impact) |
| `replay next` · `replay restart` · `replay stop` | next camera, starting the clip again from the beginning · the same camera from the start · stop |

**Time**

| Command | Effect |
|---|---|
| `slowmo 0.3 3` | ×0.3 speed, easing back to normal over 3 s |
| `timescale 0.5` | constant speed, 0.05–2 |
| `freeze` · `go` | stop the world · resume |
| `run 2` | play 2 s, then freeze |
| `cancel` | clears queued commands |

**Interface** (live play only)

| Command | Effect |
|---|---|
| `rec on` · `rec off` | recording mode |
| `panel off` · `panel on` | hide or show the text panel |
| `menu` | main menu |

**JavaScript API (`window.gca`)**

| Call | What it does |
|---|---|
| `gca.do(cmds)` | runs commands (alias `gca.run`) |
| `gca.state()` | the text view (alias `gca.text()`) |
| `gca.json()` | the same as data |
| `gca.help()` | the command list |
| `gca.places()` | the map places |
| `gca.version` | the endpoint version |
| `gca.ready()` | true once the game has booted |
| `gca.freeze()` · `gca.step(s)` · `gca.cancel()` | freeze · play s seconds then freeze · clear the queue |
| `gca.film.start()` | filming: the game now only moves on `frame` or `advance` |
| `gca.film.frame(dt = 1/30, jpegQuality = 0.94)` | advances exactly dt and returns that frame as a JPEG data URL |
| `gca.film.advance(n, dt)` | advances n frames without capturing them |
| `gca.film.stop()` | back to live |

## 7. What requests mean in commands

| The request says | Use |
|---|---|
| "drastically low", "skimming the trees", "hugging the ground" | `fly jumbo agl 9` (forest start). Around 5 clips the trees; 20–30 is low but clear |
| "crash it into the concert / the city / the beach" | `fly jumbo target concert in 14` (or `target city` while flying) |
| "low over the city", "between buildings" | `fly airliner agl 120 over city` |
| "over the ocean", "along the beach" | `over sea` (starts off the south coast, heading west along the beach) |
| "lift it a bit", "pull up" | `pitch up 1.5`; 1–2 s is a gentle lift and 3+ s a steep climb |
| "nose dive" | `pitch down 2`, or `dive 3` from higher up |
| "split in half", "breaks apart" | `split` |
| "tail rips off" | `tail` |
| "engine explodes" / "engines one by one" | `engine 1` / `engine 1; wait 3; engine 2; …` |
| "wing comes off", "death spiral" | `wing left half` (spins in about 30 s) or `wing left far` (just the tip) |
| "at night", "sunset", "golden hour", "at dawn" | `night` · `sunset` · `time 18:45` · `dawn` |
| "in a storm", "foggy", "snowing" | `weather storm` · `weather fog` · `weather snow` |
| "slow motion" | `slowmo 0.3 3` at the moment it should start |
| "from the cockpit" / "wing view" | `cam cockpit` / `cam wing`, sent before the crash |
| "show it again from another angle" | `replay` after the crash; one pass is about 14–20 s (longer with slow motion), so film long enough. For a specific angle, add `replay next` the right number of times right after `replay` (Chase is first) |
| "someone walking inside while it crashes" | `walk` (airliner or jumbo) a few seconds before the destruction |
| "car jump" / "barrel roll" | car scenes are less proven than plane scenes, so rehearse them. `car`, then `gas` / `turbo` / `steer`, and `barrel left` while airborne. The city has one ramp you can always teleport to: `car; teleport jump` (Big Jump). The bigger Mega Jumps are out on the highways and need driving there first |

## 8. Proven scenes (copy, then vary)

| Name | Scene | Length | What you get |
|---|---|---|---|
| **Low split (user-approved)** | `night; fly jumbo agl 9 speed 140; wait 3.5; pitch up 1.6; wait 1.6; split` | 15 s | 0–5 s skimming the treetops along a highway at night. About 5 s split and fireball. About 8 s the front half slams in. About 11 s the rear half crashes through the trees. 11–15 s aerial over the fire |
| Night tree-skim, longer run-up | `night; fly jumbo agl 22 speed 150; wait 6; pitch up 2; wait 2; split; wait 6; replay` | 25 s | more skimming before the split, then the replay angles |
| Wing-off death spiral | `fly airliner agl 700; wing left half; wait 32; cam` | 45 s | a slow loss of control, then a spin into the ground |
| Engines one by one | `fly jumbo; engine 1; wait 3; engine 2; wait 3; engine 3; wait 3; engine 4` | 20 s | four separate explosions, then a powerless glide |
| Walk while it splits | `fly jumbo agl 500; walk; wait 4; split` | 15 s | in the cabin when it tears open |
| Shoot down the nearest plane | `shoot nearest aim left; wait 14; replay` | 30 s | missile cam from launch to impact (left wing), the airliner breaks and falls burning, then the replay |
| Octo salvo | `shoot nearest from octo all spread` | 20 s | 8 small missiles streak up and hit all over the plane |
| Nuke a jumbo | `shoot nearest from nuke` | 30 s | the nuke leaves the turret, then a blinding flash and a fireball; every plane nearby breaks apart |
| Mid-air ram | `fly jumbo agl 1700 speed 170; wait 2; ram nearest` | 30–40 s | your jumbo hunts a sky plane and they collide |
| Jumbo into the concert | `fly jumbo target concert in 12` | 20 s | in from the sea, slams into the beach concert: the stage collapses, the crowd is thrown, the band falls |
| Tail off over the city | `fly airliner agl 250 over city; wait 4; tail; wait 1; cam` | 20 s | the tail goes, and the plane falls into the city |

The forest start is the same spot every time (a fixed search), so a scene looks almost the same on every take.

## 9. Reading the text view (`gca.state()`)

Real output from the low split, one second after the split:

```
GRAND CRASH AUTO · AGENT VIEW · t 12.2 s · FILMING (frame-exact) ×1.00
WORLD   23:09 night · weather fewClouds
YOU     PLANE · Jumbo (747) · DESTROYED (5 pieces)
HELD    nothing — stick centred (assists hold the flight path, wings level)
AUTO    terrain-follow 9 m
FORECAST (same physics, your held keys + autopilot + queue; nothing else changes)
  rear section (tail): 49 m up, 111 m/s → hits the ground in ≈ 1.8 s at ≈ 110 m/s
  piece (fuselageFwd): 6 m up, 9 m/s → hits the ground in ≈ 1.2 s at ≈ 17 m/s
  front section (cockpit): 34 m up, 26 m/s → hits the ground in ≈ 2.4 s at ≈ 45 m/s
EVENTS  [11.5] impact: groundCrash on ground at 37 m/s · [11.5] 💥 explosion (secondary) · [11.5] airframe tore (3 pieces)
KEYS    …
```

| Line | Meaning |
|---|---|
| line 1 | `t` is the game clock in seconds; EVENTS and QUEUE use it. Then LIVE, FROZEN or FILMING |
| `WORLD` | time of day and weather |
| `YOU` | the vehicle and its phase: flying / CRASHED / DESTROYED (n pieces), plus damage (tail lost, wing torn, engines out) and whether you're on foot |
| `NOW` | while flying: height above the ground, speed, climb rate, pitch, bank, heading, throttle, ⚠ STALL |
| `HELD` | controls being held, with the seconds left |
| `AUTO` | the autopilot holds that are on |
| `FORECAST` | the **real physics run ahead as a ghost copy**. It covers the controls you hold, the autopilot and the queued commands (split, tail…). It reports when and where the plane, or each piece, hits the ground and how fast. Trust it to within about 0.2 s |
| `TIMERS` | countdowns: wing-spin onset, the tail fire exploding the plane, out of the map |
| `QUEUE` | commands still waiting, with their times |
| `EVENTS` | the last few things that happened (split, impacts, explosions, touchdown…) |

## 10. The recorder (`film.mjs`)

| Option | Default | Meaning |
|---|---|---|
| `--scene "<cmds>"` / `--scene-file f.txt` | (required) | the commands. The scene starts 0.6 s before the first frame |
| `--seconds N` | 15 | length of the shot |
| `--fps N` | 30 (15 with `--dry`) | frames per second |
| `--size WxH` / `--vertical` / `--square` | 1920x1080 | 1080x1920 · 1080x1080 |
| `--name low-split` | `scene` | file name: `videos/low-split-<time>.mp4` |
| `--out path.mp4` | | exact output path |
| `--dry` | | rehearsal: small and fast. Writes the timeline and contact sheet, no MP4 |
| `--quality low\|medium\|high` | medium | keep medium (see §11) |
| `--preroll S` | 0.6 | game seconds played before frame 0 |
| `--log-every S` | 1 (0.5 with `--dry`) | gap between text snapshots in the `.txt` |
| `--url URL` / `--local` | the live site | `--local` = http://localhost:5999/, the builder's dev server |
| `--no-open` · `--no-sheet` · `--keep-frames` | | don't open the video · no contact sheet · keep the JPEG frames |
| `--chrome path` | auto | the browser executable (or set `CHROME_PATH`) |

**What it writes** (next to the video):
- `.mp4`: H.264, yuv420p, CRF 17, faststart. Upload it as is.
- `.sheet.jpg`: 4×4 frames, left to right then top to bottom, at the times listed in the log.
- `.txt`: the scene, the game's replies, `gca.state()` every `--log-every` s (headed by shot time), and page errors.

**How it works:** headless Chrome loads the game with `?agent&autostart&quality=medium`. The game switches to film
mode, where it only moves when told to, and every frame advances exactly 1/fps s. The video is smooth no matter how
slow the machine is. 1080p takes about 0.4 s per frame, so a 15 s shot is about 3 minutes; vertical 1080×1920 is
about the same. Frames come straight from the 3D view: no buttons, no text panel.

**Troubleshooting**

| Message | Fix |
|---|---|
| "waiting for it to finish…" | another headless run is using the browser slot. It continues by itself |
| "no gca.film (older than the recorder)" | the site hasn't redeployed yet. Wait a few minutes, or ask the user |
| "ffmpeg not found" / "no Chrome / Edge found" | install it, or pass `--chrome` |
| the first frame looks odd (camera still swinging in) | `--preroll 1.5` |
| a take differs from the rehearsal | small details vary (debris, fire); re-run once. Always judge the real take by its own `.sheet.jpg` |

## 11. Known limits

- **No sound** in recorded videos yet. Add music or sound in editing if the request needs it.
- **Use quality `medium`.** `high` adds a bloom glow that headless Chrome sometimes captures half-drawn.
- **Takes are almost repeatable, not exactly.** The big events (when the split happens, which half hits first) repeat
  closely; debris, sparks and fire shapes vary.
- Weather `auto` drifts over time. Set `weather clear` (or whatever you need) when the look matters.
- Keep shots under about 60 s; the frames sit on disk until the MP4 is assembled.
- `wait` counts game time. During `slowmo`, real time slows down but `wait` still counts game seconds.

## 12. The contract

**Stable:**
- every command and option in §6
- `gca.do / state / json / help / places / version / ready / film.*`
- the recorder's flags and outputs

**Can change without notice:** anything under `gca.raw`, `?debug` and the game's internals.

The builder project adds a Changelog entry **with every game change** and raises the version by one. Even a change
that doesn't touch the commands gets an entry, so you know what's new to film.

## Changelog (newest first)

- **v8 · 2026-11-24:** shooting reworked.
  - The launchers are now **turrets** in the mountains only: Twin (2 side by side), Quad (4 in a square), Octo (8 in 4×2) and Nuke (2 nukes). There are no trucks, silos or city launchers any more.
  - The turret is picked **on the map** (tap it after SHOOT).
  - Aiming works: the keys no longer also drive your car or plane.
  - S fires **without a lock** too. Locked missiles always hit; unlocked ones fly straight and lock on if the plane crosses their seeker.
  - Agent: `from twin|quad|octo|nuke`; the old names still work.

- **v7 · 2026-11-24:** missiles, nukes and sky traffic.
  - Perpetual sky traffic (jumbos, airliners, jets, props) shown on the map.
  - 7 air-defence sites of 5 kinds (Twin Titan, Quad Lancer, Hornet Swarm, Hexa Pike, Doomsday Silo), each a teleport place.
  - Map: tap a plane for SHOOT (pick a site, then the control room: aim, S fires, missiles always hit, steer where), RAM and NUKE.
  - Mid-air collisions break both planes, and the replay records missile strikes.
  - Agent: `traffic`, `sites`, `shoot`, `steer`, `back`, `ram`, `nuke`.

- **v6 · 2026-11-24:** targets, concert and terrain.
  - New `fly <type> target <place> [in s] [from dir]` and `target <place>` / `target off`: homing crash set-ups (concert, stage, crowd, city, beach, airport… or x z).
  - The concert stage now breaks apart on a crash, and the crowd reacts to plane crashes (knocked flying near the impact, fleeing and screaming further out, band included). Before, they stayed perfectly fine.
  - Cockpit and wing cameras: free 360° look.
  - Terrain: smooth shading and colours instead of blocky facets. Farmland is only greens, yellows and green-browns (no purple), and mountains are smooth.

- **v5 · 2026-11-24:** passengers and crew.
  - About 30 % of the seats are taken, by the same people every flight. Most are belted, with fixed reactions: engine blast (that side panics, looks out and screams mildly), split or explosion (panic then brace), spin or dive (brace and scream now and then).
  - Two flight attendants walk the aisles. They and a few unbelted passengers get thrown around, sucked out and fall, with the same physics as you.
  - Good shots: `fly jumbo agl 1500; walk; wait 3; engine 1` (first person, then `view` for third person) or `…; walk; wait 4; split`.

- **v4 · 2026-11-24:** on foot.
  - Faster walking: the old sprint is the walk now, and speed doubles outside the plane.
  - First person has a head bob and a visible blocky hand that swings with each step.
  - Anti-noclip in the cabin: the body and the eye stay inside the curved walls, bins and ceiling, with no tunnelling through seats, even when thrown around.
  - Fixed: the commands `hold moveX` / `hold moveY` were rejected before.

- **v3 · 2026-11-24:** trees break and wrecks stay.
  - Trees break: plane parts and wreck pieces clipping trees knock them over in the direction of travel, and fast low hits smash them.
  - Crashed planes stay in the world after a respawn (last 2 wrecks, 1 on low quality, 3 on high). Their fires burn on, then fade slowly over minutes, with flames shrinking first and smoke lingering.
  - Wreck fires in general burn longer and fade progressively.

- **v2 · 2026-11-24:** replay reworked.
  - One camera for a whole pass instead of cutting every 2.8 s. The cockpit shot is gone, and Side and Ground are new fixed spectators. `replay next` restarts the clip from the next camera.
  - The plane looks intact until it actually broke: no torn edges early, no charring before the fire.
  - Fires appear only from the moment they started, and follow the falling pieces. A crash fire is no longer burning from the first frame.
  - Slow motion only around the main moments.
  - Engines can no longer be blown up after a crash or a hard landing (the buttons grey out).
  - Wing breaks now catch fire with smoke and light: a tip burns about 15 s, a half wing keeps burning.

- **v1 · 2026-11-24:** first endpoint.
  - Agent mode (`?agent`): text view, ghost-physics forecast, latched keys, timed commands, freeze and step.
  - Recording mode (`&rec`).
  - Film API `gca.film.*`, `gca.version`, `gca.ready()`, the `places` command.
  - The zero-dependency recorder `/endpoint/film.mjs`: landscape, vertical or square; dry rehearsals with a timeline
    and contact sheet.
  - Recently shipped and filmable: walking inside planes (even while they split), mid-air plane switch, a cockpit
    view that survives crashes, crash replay with rotating angles, wing breaks, night cabin lighting, beach concert
    and crowds.
