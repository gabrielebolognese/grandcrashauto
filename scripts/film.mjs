#!/usr/bin/env node
/**
 * Film an agent-mode scene to a smooth MP4 and open it (frame-exact offline render: every frame = exactly 1/fps s of
 * game time, so it is smooth whatever the machine; headless Chrome on the GPU; ffmpeg must be on PATH).
 *
 *   node scripts/film.mjs [--scene "rec on; night; fly jumbo agl 9; wait 3.5; pitch up 1.6; wait 1.6; split"]
 *                         [--seconds 15] [--fps 30] [--size 1920x1080] [--out film/name.mp4] [--no-open]
 *                         [--quality medium]   (high: its bloom pass came out half-drawn in headless Chrome)
 *
 * Frames come straight from the 3D view: pure footage, no buttons at all.
 * Videos go to film/ (git-ignored) unless --out says otherwise.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);
const env = { ...process.env };
if (opt('scene')) env.FILM_SCENE = opt('scene');
if (opt('seconds')) env.FILM_SECONDS = opt('seconds');
if (opt('fps')) env.FILM_FPS = opt('fps');
if (opt('size')) env.FILM_SIZE = opt('size');
if (opt('out')) env.FILM_OUT = resolve(opt('out'));
if (flag('no-open')) env.FILM_OPEN = '0';
const r = spawnSync(process.execPath, [join(root, 'scripts', 'smoke.mjs'), '--tag', 'film', '--gpu', '--params', 'agent', '--quality', opt('quality', 'medium'), '--script', join(root, 'scripts', 'scenarios', 'film.mjs')], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
