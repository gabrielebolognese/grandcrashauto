#!/usr/bin/env node
/**
 * Live preview of the LAST GOOD BUILD (for watching parallel agents build the game).
 *   node scripts/live.mjs [--port 5999] [--interval 90]
 * Every --interval seconds, if src/ changed, runs `vite build` into a temp dir; a successful build is published and
 * open pages reload themselves (a tiny poller is injected into index.html). Broken intermediate states are never served.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const PORT = Number(opt('port', '5999'));
const INTERVAL = Number(opt('interval', '90')) * 1000;
const base = join(tmpdir(), 'crashgame-live');
await mkdir(base, { recursive: true });

let current = null; // dir of the last good build
let version = 0;
let builtAt = '';
let lastSrcStamp = 0;
let building = false;
let lastError = '';

// --seed <dir>: serve an existing good build (e.g. of the last commit) until the first fresh build succeeds.
const seed = opt('seed', '');
if (seed) {
  try {
    await stat(join(seed, 'index.html'));
    current = seed;
    builtAt = 'last commit';
    console.log('[live] serving seed build', seed);
  } catch {
    console.log('[live] seed not found', seed);
  }
}

async function srcStamp(dir = join(root, 'src')) {
  let max = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) max = Math.max(max, await srcStamp(p));
    else max = Math.max(max, (await stat(p)).mtimeMs);
  }
  return max;
}

function build(outDir) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--logLevel', 'error'], {
      cwd: root,
      env: { ...process.env, OUT_DIR: outDir, FORCE_COLOR: '0' },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => res({ ok: code === 0, out }));
  });
}

async function tick(force = false) {
  if (building) return;
  try {
    const stamp = await srcStamp();
    if (!force && stamp <= lastSrcStamp) return;
    building = true;
    const n = version + 1;
    const dir = join(base, `build-${Date.now()}`);
    const t0 = Date.now();
    const r = await build(dir);
    if (r.ok) {
      const old = current;
      current = dir;
      version = n;
      lastSrcStamp = stamp;
      builtAt = new Date().toLocaleTimeString();
      lastError = '';
      console.log(`[live] build #${version} published in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      if (old) setTimeout(() => rm(old, { recursive: true, force: true }).catch(() => {}), 60_000);
    } else {
      lastError = r.out.replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter((l) => /error|Error|\.ts/.test(l)).slice(0, 3).join(' | ');
      console.log(`[live] build failed (keeping #${version}): ${lastError.slice(0, 200)}`);
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.log('[live] tick error', err);
  } finally {
    building = false;
  }
}

const POLLER = `<script>(function(){var v=null;function badge(t){var b=document.getElementById('live-badge');if(!b){b=document.createElement('div');b.id='live-badge';b.style.cssText='position:fixed;left:50%;bottom:2px;transform:translateX(-50%);z-index:100000;font:10px system-ui;color:#fff;background:rgba(0,0,0,.35);padding:1px 6px;border-radius:6px;pointer-events:none';document.body&&document.body.appendChild(b)}b.textContent=t}
function poll(){fetch('/__live',{cache:'no-store'}).then(function(r){return r.json()}).then(function(d){if(v===null)v=d.version;else if(d.version!==v){location.reload();return}badge('live build #'+d.version+' · '+d.builtAt+(d.building?' · building…':''))}).catch(function(){})}
setInterval(poll,8000);setTimeout(poll,1500)})();</script>`;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__live') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ version, builtAt, building, lastError }));
    return;
  }
  if (!current) {
    res.writeHead(503, { 'content-type': 'text/html', refresh: '5' });
    res.end('<body style="font:16px system-ui;padding:2em">First build in progress… this page refreshes automatically.</body>');
    return;
  }
  try {
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(current, p);
    if (!file.startsWith(current)) throw new Error('bad path');
    let body = await readFile(file);
    const type = MIME[extname(file)] || 'application/octet-stream';
    if (p.endsWith('index.html')) body = Buffer.from(String(body).replace('</body>', POLLER + '</body>'));
    res.writeHead(200, { 'content-type': type, 'cache-control': p.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[live] serving last good build on http://localhost:${PORT}/`);
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`[live]   LAN: http://${a.address}:${PORT}/`);
});
await tick(true);
setInterval(() => tick(false), INTERVAL);
