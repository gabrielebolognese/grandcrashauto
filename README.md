# Grand Crash Auto

**Play: [grandcrashauto.lol](https://grandcrashauto.lol)**

A sunny 3D driving, flying and crashing sandbox that runs in the browser — on phones (touch, landscape) and desktop
(keyboard / gamepad). Drive a customizable car through a coastal city and an endless procedurally generated world of
farmland, hills and mountains, take a plane from the airport, and press the big 💥 button.

Built with TypeScript, Vite, Three.js (WebGL2) and Rapier physics. Every model, texture, animation and sound is
generated in code — no external assets (see [CREDITS.md](CREDITS.md)).

> Work in progress: the game is being built in parallel by a team of AI agents; this README is finalized at the end.

## Run locally

```bash
npm install
npm run dev        # http://localhost:5999
npm run build      # static site in dist/ (works from any static host or sub-path)
npm run preview    # serve the build
```

## Deploy (Netlify)

The repo contains `netlify.toml`: connect `gabrielebolognese/grandcrashauto` in Netlify (build `npm ci && npm run build`,
publish `dist`), then add the custom domain `grandcrashauto.lol` under *Domain management*.

## Controls (desktop)

| Car | | Plane | |
|---|---|---|---|
| W/S or ↑/↓ | gas / brake-reverse | W/S | pitch |
| A/D or ←/→ | steer | A/D | bank |
| Space | handbrake | Q/E | rudder |
| Shift | turbo | Shift/Ctrl (or =/-) | throttle |
| Q/E (airborne) | barrel roll | G | gear |
| H | horn | 1–4 | explode engine |
| C | camera | X / M / T | explode / middle / tail |
| X | explode | B | brakes |
| R | reset | F | board / exit plane |
| N | map | Esc | pause |

## URL parameters

`?debug` (debug panel + error overlay), `?autostart`, `?quality=low|medium|high`, `?seed=N`, `?car=<share code>`,
`?plane=prop|bizjet|airliner|jumbo` (+ `&air`).
