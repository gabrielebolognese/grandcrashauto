#!/usr/bin/env node
/**
 * Builder-side shortcut for the endpoint recorder (public/endpoint/film.mjs — the same file the video-maker project
 * downloads from https://grandcrashauto.netlify.app/endpoint/film.mjs). Films the CURRENT source through the live
 * dev server on :5999, videos into film/ (git-ignored). Every option of the recorder works here:
 *
 *   node scripts/film.mjs --scene "night; fly jumbo agl 9 speed 140; wait 3.5; pitch up 1.6; wait 1.6; split" --seconds 15
 *   node scripts/film.mjs --dry --scene "…"        (rehearsal: state timeline + contact sheet, no video)
 *   node scripts/film.mjs --url https://grandcrashauto.netlify.app/ --scene "…"   (film the deployed build)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (!args.includes('--url') && !args.includes('--local')) args.push('--local');
if (!args.includes('--out')) {
  const i = args.indexOf('--name');
  const name = i >= 0 ? args[i + 1] : args.includes('--dry') ? 'rehearsal' : 'scene';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  args.push('--out', join(root, 'film', `${name}-${stamp}.mp4`));
}
const r = spawnSync(process.execPath, [join(root, 'public', 'endpoint', 'film.mjs'), ...args], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
