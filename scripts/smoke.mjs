#!/usr/bin/env node
/**
 * Headless smoke test + screenshots. Safe to run concurrently (unique build dir + random port per run).
 *
 *   node scripts/smoke.mjs [--tag name] [--no-build] [--params "a=1&b=2"] [--mobile] [--desktop-only]
 *                          [--scenario default|idle|garage|menu|none] [--script path/to/scenario.mjs] [--seconds 4]
 *                          [--quality low|medium|high] [--gpu]
 *
 * Output: screenshots + summary.json in .smoke/<tag>/ ; prints a JSON summary; exit code 1 on page errors.
 * Custom scenario: --script file exporting `default async function (page, h)` where h = { shot(name), wait(ms),
 * hold(key, ms), state(), game(js) } — game(js) evaluates `js` with `g` = window.__game ({game, ctx, CONFIG}).
 */
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync, openSync, writeSync, closeSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};

const tag = opt('tag', 'default');
const outDir = join(root, '.smoke', tag);
const buildDir = join(tmpdir(), `crashgame-smoke-${tag}`);
const scenario = opt('scenario', 'default');
const seconds = Number(opt('seconds', '3'));
const quality = opt('quality', 'medium');
const extraParams = opt('params', '');

await mkdir(outDir, { recursive: true });

// 0) Machine-wide concurrency limit: many agents share one laptop. At most SMOKE_SLOTS (default 2) build+browser
//    runs at once; others wait. Lock files carry the owner PID so locks of killed processes are reclaimed.
const SLOTS = Number(process.env.SMOKE_SLOTS || 1); // user: keep headless Chrome to ONE instance machine-wide
let lockPath = null;
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
async function acquireSlot() {
  const t0 = Date.now();
  let warned = false;
  for (;;) {
    for (let i = 0; i < SLOTS; i++) {
      const p = join(tmpdir(), `crashgame-smoke-slot-${i}.lock`);
      try {
        const fd = openSync(p, 'wx');
        writeSync(fd, `${process.pid} ${tag}`);
        closeSync(fd);
        lockPath = p;
        return;
      } catch {
        try {
          const [pid] = readFileSync(p, 'utf8').split(' ');
          const old = Date.now() - statSync(p).mtimeMs > 20 * 60 * 1000;
          if (!pidAlive(Number(pid)) || old) unlinkSync(p);
        } catch {
          /* raced with another process */
        }
      }
    }
    if (!warned) {
      console.error(`[smoke] waiting for a free smoke slot (max ${SLOTS} concurrent runs on this machine)…`);
      warned = true;
    }
    if (Date.now() - t0 > 40 * 60 * 1000) throw new Error('timed out waiting for a smoke slot');
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
  }
}
function releaseSlot() {
  if (!lockPath) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
  lockPath = null;
}
process.on('exit', releaseSlot);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(130));
await acquireSlot();
console.error(`[smoke] slot acquired (${tag})`);

// 1) Build into a private temp dir (does not touch dist/, safe in parallel).
if (!flag('no-build') || !existsSync(join(buildDir, 'index.html'))) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], {
    cwd: root,
    env: { ...process.env, OUT_DIR: buildDir },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.log(JSON.stringify({ ok: false, stage: 'build', output: (r.stdout + r.stderr).slice(-4000) }, null, 2));
    process.exit(1);
  }
  console.error(`[smoke] build ok in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${buildDir}`);
}

// 2) Static server on a random port.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ktx2': 'application/octet-stream', '.glb': 'model/gltf-binary' };
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(buildDir, p);
    if (!file.startsWith(buildDir)) throw new Error('bad path');
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not file');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// 3) Browser.
const { chromium } = await import('playwright');
const launchArgs = flag('gpu')
  ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11']
  : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'];
// Fewer Chrome processes per browser (lighter on the shared PC).
launchArgs.push('--renderer-process-limit=1', '--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--no-first-run', '--disable-sync');
const browser = await chromium.launch({ headless: true, args: launchArgs });

const summary = { ok: true, tag, url: '', runs: [] };

async function run(name, contextOpts) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`.slice(0, 600));
  });
  page.on('pageerror', (e) => errors.push(String(e.stack || e).slice(0, 1200)));
  const shots = [];
  const h = {
    async shot(n) {
      const f = join(outDir, `${name}-${n}.png`);
      await page.screenshot({ path: f });
      shots.push(f);
    },
    wait: (ms) => page.waitForTimeout(ms),
    async hold(key, ms) {
      await page.keyboard.down(key);
      await page.waitForTimeout(ms);
      await page.keyboard.up(key);
    },
    state: () => page.evaluate(() => window.__game?.game?.state ?? null),
    game: (js) => page.evaluate((code) => new Function('g', code)(window.__game), js),
  };
  const params = new URLSearchParams(extraParams);
  params.set('debug', '');
  if (!params.has('quality')) params.set('quality', quality);
  if (scenario !== 'menu' && scenario !== 'none' && !params.has('noautostart')) params.set('autostart', '');
  const url = `http://127.0.0.1:${port}/?${params.toString().replace(/=(&|$)/g, '$1')}`;
  summary.url = url;
  const t0 = Date.now();
  await page.goto(url);
  let loaded = true;
  try {
    await page.waitForFunction(() => {
      const s = window.__game?.game?.state;
      return s && s !== 'boot';
    }, null, { timeout: 180000 });
  } catch {
    loaded = false;
    errors.push('timeout: game never left boot state');
  }
  const loadMs = Date.now() - t0;
  try {
    if (loaded) {
      if (opt('script')) {
        const mod = await import(pathToFileURL(resolve(opt('script'))).href);
        await mod.default(page, h);
      } else if (scenario === 'default') {
        await h.wait(800);
        await h.shot('01-start');
        await page.keyboard.down('KeyW');
        await h.wait(seconds * 1000);
        await h.shot('02-driving');
        await page.keyboard.down('KeyD');
        await h.wait(900);
        await page.keyboard.down('Space');
        await h.wait(500);
        await page.keyboard.up('Space');
        await page.keyboard.up('KeyD');
        await page.keyboard.up('KeyW');
        await h.shot('03-turn');
        await page.keyboard.press('KeyX');
        await h.wait(400);
        await h.shot('04-explode');
        await h.wait(1500);
        await h.shot('05-wreck');
        await page.keyboard.press('KeyR');
        await h.wait(1200);
        await h.shot('06-reset');
      } else if (scenario === 'idle') {
        await h.wait(seconds * 1000);
        await h.shot('idle');
      } else if (scenario === 'menu') {
        await h.wait(1500);
        await h.shot('title');
        await page.mouse.click(contextOpts.viewport.width / 2, contextOpts.viewport.height / 2);
        await h.wait(1500);
        await h.shot('menu');
      } else if (scenario === 'garage') {
        await h.game('g.game.openGarage()');
        await h.wait(2500);
        await h.shot('garage');
      }
    }
  } catch (err) {
    errors.push('scenario failed: ' + String(err?.stack || err).slice(0, 800));
  }
  const info = await page
    .evaluate(() => {
      const g = window.__game;
      if (!g) return null;
      const c = g.ctx;
      const st = c.engine.stats;
      const v = c.vehicle.state;
      const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null;
      return {
        state: g.game.state,
        fps: +st.fps.toFixed(1),
        calls: st.calls,
        triangles: st.triangles,
        renderScale: st.renderScale,
        geometries: c.engine.renderer.info.memory.geometries,
        textures: c.engine.renderer.info.memory.textures,
        programs: c.engine.renderer.info.programs?.length ?? null,
        bodies: c.physics.world?.bodies.len?.() ?? null,
        colliders: c.physics.world?.colliders.len?.() ?? null,
        npcs: c.npcs.activeCount,
        car: { pos: [v.position.x, v.position.y, v.position.z].map((n) => +n.toFixed(1)), kmh: Math.round(v.speedKmh), gear: v.gear, exploded: v.exploded },
        heapMB: mem,
        gpu: c.quality.gpuName,
        quality: c.quality.level,
      };
    })
    .catch(() => null);
  const errorOverlay = await page.evaluate(() => document.getElementById('debug-errors')?.innerText ?? null).catch(() => null);
  summary.runs.push({ name, loadMs, info, pageErrors: errors, consoleErrors: logs.slice(0, 30), errorOverlay, shots });
  if (errors.length) summary.ok = false;
  await context.close();
}

try {
  if (!flag('mobile-only')) await run('desktop', { viewport: { width: 1280, height: 720 } });
  if (flag('mobile') || flag('mobile-only'))
    await run('mobile', { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' });
} finally {
  await browser.close();
  server.close();
}
await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
