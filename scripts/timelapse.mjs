#!/usr/bin/env node
/**
 * Progress timelapse: replays archived builds (scripts/live.mjs archive + optional git commits), records a ~10 s drive
 * of each with a caption, then stitches an MP4 compilation (full + fast cut) with the system ffmpeg.
 *
 *   node scripts/timelapse.mjs [--archive DIR] [--out DIR] [--limit N] [--every K] [--gpu] [--commits sha1,sha2,…]
 *
 * Runs ONE headless browser at a time (light on the PC). Builds that fail to boot within 120 s are skipped.
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);
const home = process.env.USERPROFILE || root;
const archive = opt('archive', join(home, 'crashgame-timelapse', 'builds'));
const outDir = opt('out', join(home, 'crashgame-timelapse', 'video'));
const clipsDir = join(outDir, 'clips');
const SECONDS = Number(opt('seconds', '10'));
await mkdir(clipsDir, { recursive: true });

// ── collect builds: git commits (built on demand) + archived live builds, ordered by time ──
const builds = [];
const commits = (opt('commits', '') || '').split(',').filter(Boolean);
for (const sha of commits) {
  const dir = join(archive, `git-${sha}`);
  if (!existsSync(join(dir, 'index.html'))) {
    const src = join(home, 'crashgame-timelapse', 'src', sha);
    await rm(src, { recursive: true, force: true });
    await mkdir(src, { recursive: true });
    const tar = spawnSync('git', ['archive', '--format=tar', sha], { cwd: root, maxBuffer: 1 << 30 });
    if (tar.status !== 0) {
      console.log('[timelapse] git archive failed', sha);
      continue;
    }
    spawnSync('tar', ['-xf', '-', '-C', src], { input: tar.stdout });
    try {
      await symlink(join(root, 'node_modules'), join(src, 'node_modules'), 'junction');
    } catch {
      /* exists */
    }
    const r = spawnSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], {
      cwd: src,
      env: { ...process.env, OUT_DIR: dir },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      console.log('[timelapse] build failed for', sha);
      continue;
    }
  }
  const t = spawnSync('git', ['show', '-s', '--format=%cI|%s', sha], { cwd: root, encoding: 'utf8' }).stdout.trim().split('|');
  builds.push({ dir, time: t[0], label: `commit ${sha.slice(0, 7)}`, sub: (t[1] || '').slice(0, 60) });
}
const manifest = join(archive, 'manifest.jsonl');
if (existsSync(manifest)) {
  for (const line of readFileSync(manifest, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (existsSync(join(m.dir, 'index.html'))) builds.push({ dir: m.dir, time: m.time, label: m.seed ? 'live build (seed)' : `live build #${m.version}`, sub: '' });
    } catch {
      /* skip */
    }
  }
}
builds.sort((a, b) => a.time.localeCompare(b.time));
const every = Number(opt('every', '1'));
let list = builds.filter((_, i) => i % every === 0 || i === builds.length - 1);
const limit = Number(opt('limit', '0'));
if (limit) list = list.slice(-limit);
console.log(`[timelapse] ${list.length} builds to record`);

// ── record ──
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const { chromium } = await import('playwright');
const launchArgs = flag('gpu')
  ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--renderer-process-limit=1', '--mute-audio']
  : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--renderer-process-limit=1', '--mute-audio'];
const browser = await chromium.launch({ headless: true, args: launchArgs });
const recorded = [];
let n = 0;
for (const b of list) {
  n++;
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = join(b.dir, p);
      if (!file.startsWith(b.dir)) throw new Error('bad');
      if (!(await stat(file)).isFile()) throw new Error('nf');
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const vdir = join(clipsDir, `raw-${String(n).padStart(3, '0')}`);
  await rm(vdir, { recursive: true, force: true });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: vdir, size: { width: 1280, height: 720 } } });
  const page = await ctxB.newPage();
  const t0 = Date.now();
  let bootMs = -1;
  try {
    await page.goto(`http://127.0.0.1:${port}/?autostart&quality=high`);
    await page.waitForFunction(() => {
      const boot = document.getElementById('boot');
      return !boot || boot.style.display === 'none' || getComputedStyle(boot).display === 'none' || getComputedStyle(boot).opacity === '0';
    }, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    bootMs = Date.now() - t0;
    const when = new Date(b.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await page.evaluate(([label, sub, when]) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:14px;bottom:12px;z-index:999999;font:800 18px system-ui;color:#fff;text-shadow:0 2px 6px rgba(0,0,0,.7);pointer-events:none';
      d.innerHTML = `${label} <span style="opacity:.75;font-weight:600">· ${when}</span>${sub ? `<div style="font:600 12px system-ui;opacity:.8">${sub}</div>` : ''}`;
      document.body.appendChild(d);
    }, [b.label, b.sub, when]);
    // ~10 s drive: gas, a few steering moves, handbrake slide, explode near the end.
    const kb = page.keyboard;
    await kb.down('KeyW');
    await page.waitForTimeout(SECONDS * 300);
    await kb.down('KeyD');
    await page.waitForTimeout(800);
    await kb.up('KeyD');
    await kb.down('KeyA');
    await page.waitForTimeout(600);
    await kb.up('KeyA');
    await page.waitForTimeout(SECONDS * 250);
    await kb.down('Space');
    await kb.down('KeyD');
    await page.waitForTimeout(700);
    await kb.up('Space');
    await kb.up('KeyD');
    await kb.up('KeyW');
    await kb.press('KeyX');
    await page.waitForTimeout(Math.max(1500, SECONDS * 1000 - (Date.now() - t0 - bootMs)));
  } catch (err) {
    console.log(`[timelapse] ${b.label}: failed (${String(err).slice(0, 80)})`);
  }
  const video = page.video();
  await ctxB.close();
  server.close();
  if (bootMs < 0 || !video) continue;
  const raw = await video.path();
  const clip = join(clipsDir, `clip-${String(n).padStart(3, '0')}.mp4`);
  // Trim off the boot, normalise to 30 fps H.264.
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(bootMs / 1000), '-i', raw, '-t', String(SECONDS), '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '22', clip], { encoding: 'utf8' });
  if (ff.status === 0) {
    recorded.push(clip);
    console.log(`[timelapse] ${n}/${list.length} ${b.label} → ${clip} (boot ${(bootMs / 1000).toFixed(1)} s)`);
  } else console.log('[timelapse] ffmpeg failed', ff.stderr?.slice(0, 200));
  await rm(vdir, { recursive: true, force: true });
}
await browser.close();

// ── stitch ──
if (recorded.length) {
  const listFile = join(outDir, 'clips.txt');
  await writeFile(listFile, recorded.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n'));
  const full = join(outDir, 'grand-crash-auto-progress-full.mp4');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', full]);
  // Fast cut: the 3 most interesting seconds of each clip (just before + after the explosion).
  const fastParts = [];
  for (const c of recorded) {
    const f = c.replace('.mp4', '-fast.mp4');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, SECONDS - 4)), '-i', c, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '22', f]);
    fastParts.push(f);
  }
  const fastList = join(outDir, 'clips-fast.txt');
  await writeFile(fastList, fastParts.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n'));
  const fast = join(outDir, 'grand-crash-auto-progress-fast.mp4');
  spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', fastList, '-c', 'copy', fast]);
  console.log(`[timelapse] done: ${full}\n[timelapse]       ${fast}`);
}
