# Grand Crash Auto

**Play free in your browser: [grandcrashauto.lol](https://grandcrashauto.lol)** (phone in landscape, or desktop)

A sunny, fast, crash-first 3D sandbox. Grab a car or a plane and wreck it: into crowds, buildings, the sea, off a
mega jump, or just press the big 💥. Built for short sessions — every crash is a few taps away.

- **Cars:** a coastal city with streets, parked cars, knockable props and crowds that dodge (or don't). Turbo to
  ~320 km/h, jump ramps, barrel rolls, turbo-glide, damage, and a full-car explosion with debris and fire.
- **Garage:** 4 original cars (Riptide R supercar, Saltrunner 77, Sandpiper Zip, Headland Cairn), paint finishes,
  6 rims, body kits, stance, underglow, plates, performance + turbo upgrades, 3 save slots and share codes.
- **Planes:** an airport with 4 original planes (Saltwing S2, Swiftlet 7, Tidewing 38, Pelagic 700). Board from the
  car, press AIRBORNE, nudge the plane anywhere in 100 m steps, explode single engines, the middle, the tail or the
  whole plane — momentum-correct breakups, crashes on land, buildings and water.
- **World:** the city and airport sit on a coast; inland the land generates forever (farmland, hills, mountains,
  lakes) with endless highways, bridges, tunnels, rest stops and mega jumps. Day/night cycle and weather (rain,
  storms with lightning, fog, snow) that change grip and visibility.

Everything — models, textures, animations, sounds — is generated in code. No external assets (see [CREDITS.md](CREDITS.md)).
Built with TypeScript, Vite, Three.js (WebGL2) and Rapier physics.

## Controls

**Phone (landscape):** steering slider/arrows on the left, GAS / BRAKE / HANDBRAKE + TURBO on the right,
💥 / ↺ at the bottom centre (long-press = reset), menu pill at the top (map, camera, day/night, lights, horn,
fullscreen, pause). In a plane: stick on the left, throttle on the right, engine buttons, ▲◀▶▼ nudge pad.

| Car (keyboard) | | Plane (keyboard) | |
|---|---|---|---|
| W/S or ↑/↓ | gas / brake → reverse | W/S | pitch (S = nose up) |
| A/D or ←/→ | steer | A/D | bank |
| Shift | turbo | Q/E | rudder |
| Space | handbrake | Shift/Ctrl or =/- | throttle |
| Q/E (in the air) | barrel roll | 1–4 | explode an engine |
| B | look back | X / M / T | explode / middle / tail |
| H | horn | G / B | gear / brakes (automatic by default) |
| L | headlights | F | board plane / exit |
| C | camera | C | camera |
| X | explode | R | respawn |
| R | reset | N | map |
| N | map | Esc | pause |
| F | board a plane (when BOARD shows) | | |

Gamepad: triggers gas/brake (planes: throttle), left stick steer (planes: pitch/bank), A turbo, X handbrake,
Y explode, B reset, bumpers barrel roll (planes: rudder).

## Run locally

```bash
npm install
npm run dev        # http://localhost:5999
npm run build      # static site in dist/ — works from any static host or sub-path
npm run preview    # serve the production build
```

Useful URL parameters: `?quality=low|medium|high`, `?seed=N`, `?car=<share code>`,
`?plane=prop|bizjet|airliner|jumbo` (start in a plane) + `&air` (start flying), `?debug` (debug panel),
`?rec` (recording mode: every button tiny in one corner, the screen clear — also the ● button or U),
`?agent` (agent mode for AI players such as Claude in Chrome: a live text view with a physics forecast of the next
seconds, keys where a tap = a 1 s hold, a timed command language — `gca.do("night; fly jumbo agl 22; wait 6; pitch up 2; wait 2; split")`,
freeze / step with K and `.`; see `gca.help()`).

## Deploy

`netlify.toml` is included: connect the GitHub repo in Netlify (build `npm ci && npm run build`, publish `dist`) and
add the custom domain. Any static host works (the build uses relative paths).

## Development notes

- Architecture, module ownership and conventions: [`CLAUDE.md`](CLAUDE.md). Briefs: [`docs/SPEC.md`](docs/SPEC.md),
  [`docs/SPEC-PART2.md`](docs/SPEC-PART2.md), [`docs/SPEC-PART3.md`](docs/SPEC-PART3.md).
- Headless smoke test with screenshots: `node scripts/smoke.mjs --tag me [--mobile]`; scenarios in `scripts/scenarios/`
  (leak test, tour, boarding, airborne).
- `node scripts/live.mjs --port 5999` serves the last good build and reloads open pages when a new one compiles.
