#!/usr/bin/env node
/**
 * GRAND CRASH AUTO — scene recorder. Read https://grandcrashauto.netlify.app/endpoint.md first.
 *
 * Plays an agent-mode scene in headless Chrome and renders it frame-exact to an MP4 (every frame = exactly 1/fps s
 * of game time, so the video is perfectly smooth however slow the machine is), then opens it.
 * Zero npm dependencies: Node 22+ (built-in WebSocket), Google Chrome or Microsoft Edge, ffmpeg on PATH.
 *
 *   node film.mjs --scene "night; fly jumbo agl 9 speed 140; wait 3.5; pitch up 1.6; wait 1.6; split" --seconds 15
 *
 *   --scene "<cmds>"      agent commands (gca.do syntax: ";" separates, "wait N" = N s of game time later)
 *   --scene-file <path>   the same, read from a text file (newlines also separate commands)
 *   --seconds 15          length of the shot              --fps 30         frames per second
 *   --size 1920x1080      landscape (default) · --vertical = 1080x1920 (Reels/TikTok/Shorts) · --square = 1080x1080
 *   --name low-split      file name → videos/low-split-<time>.mp4        --out <file.mp4>  exact output path
 *   --url <game url>      default https://grandcrashauto.netlify.app/ · --local = http://localhost:5999/ (dev server)
 *   --quality medium      low|medium|high (high's bloom can come out half-drawn in headless Chrome)
 *   --preroll 0.6         game seconds played before the first frame (spawn settles, world streams)
 *   --dry                 rehearsal: no video, small + fast; writes the state timeline + a contact sheet
 *   --no-open             don't open the video          --no-sheet  no contact sheet        --keep-frames
 *   --log-every 1         game seconds between state snapshots in the .txt timeline
 *   --chrome <path>       browser executable (else CHROME_PATH, else Chrome / Edge in the usual places)
 *
 * Outputs (next to the video): <name>.mp4 · <name>.sheet.jpg (4×4 frames across the shot, left→right, top→bottom)
 * · <name>.txt (scene, command replies, the game's text view every --log-every s, page errors).
 * One headless Chrome at a time on this machine: runs queue on the same lock files as the game's own smoke tests.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const RECORDER_VERSION = 1;
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const flag = (n) => args.includes('--' + n);
if (flag('help') || flag('h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}

const dry = flag('dry');
let scene = opt('scene') ?? (opt('scene-file') ? readFileSync(resolve(opt('scene-file')), 'utf8') : null);
if (!scene) fail('missing --scene "<commands>" (or --scene-file). Example: --scene "night; fly jumbo agl 9; wait 3.5; pitch up 1.6; wait 1.6; split"');
scene = scene.trim();
const fps = Number(opt('fps', dry ? 15 : 30));
const seconds = Number(opt('seconds', 15));
const preroll = Number(opt('preroll', 0.6));
const logEvery = Number(opt('log-every', dry ? 0.5 : 1));
const quality = opt('quality', 'medium');
const sizeArg = flag('vertical') ? '1080x1920' : flag('square') ? '1080x1080' : opt('size', '1920x1080');
let [W, H] = sizeArg.split('x').map(Number);
if (dry) {
  const k = Math.min(1, 960 / Math.max(W, H)); // rehearsals render small: same framing, much faster
  W = Math.round((W * k) / 2) * 2;
  H = Math.round((H * k) / 2) * 2;
}
if (!(W > 0 && H > 0 && fps > 0 && seconds > 0)) fail('bad --size / --fps / --seconds');
W -= W % 2;
H -= H % 2;
const base = (() => {
  const u = opt('url') ?? (flag('local') ? 'http://localhost:5999/' : 'https://grandcrashauto.netlify.app/');
  return u.includes('://') ? u : 'https://' + u;
})();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const name = (opt('name', dry ? 'rehearsal' : 'scene') || 'scene').replace(/[^\w.-]+/g, '-');
const out = resolve(opt('out') ?? join('videos', `${name}-${stamp}.mp4`));
const stem = out.replace(/\.mp4$/i, '');
const logFile = stem + '.txt';
const sheetFile = stem + '.sheet.jpg';
const log = [];
const note = (s) => {
  log.push(s);
  console.log(s);
};
function fail(msg) {
  console.error('[film] ' + msg);
  process.exit(1);
}

// ── machine-wide lock: one headless Chrome at a time (same lock files as the game repo's smoke tests) ──
const SLOTS = Number(process.env.SMOKE_SLOTS || 1);
let lockPath = null;
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
async function acquireSlot() {
  const t0 = Date.now();
  let warned = false;
  for (;;) {
    for (let i = 0; i < SLOTS; i++) {
      const p = join(tmpdir(), `crashgame-smoke-slot-${i}.lock`);
      try {
        const fd = openSync(p, 'wx');
        writeSync(fd, `${process.pid} film`);
        closeSync(fd);
        lockPath = p;
        return;
      } catch {
        try {
          const [pid] = readFileSync(p, 'utf8').split(' ');
          const old = Date.now() - statSync(p).mtimeMs > 40 * 60 * 1000;
          if (!pidAlive(Number(pid)) || old) unlinkSync(p);
        } catch {
          /* raced */
        }
      }
    }
    if (!warned) console.error('[film] another headless browser run is going on this machine — waiting for it to finish…');
    warned = true;
    if (Date.now() - t0 > 60 * 60 * 1000) fail('waited an hour for the browser slot — giving up');
    await sleep(1500 + Math.random() * 2000);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── browser ──
function findBrowser() {
  const c = opt('chrome') || process.env.CHROME_PATH;
  if (c) return c;
  const L = process.env.LOCALAPPDATA || '';
  const list =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          join(L, 'Google\\Chrome\\Application\\chrome.exe'),
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return list.find((p) => existsSync(p));
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.listeners = [];
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('could not connect to the browser (DevTools websocket)'));
      this.ws.onclose = () => {
        for (const w of this.waiting.values()) w.rej(new Error('the browser closed the connection'));
        this.waiting.clear();
      };
      this.ws.onmessage = (m) => {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
        if (msg.id) {
          const w = this.waiting.get(msg.id);
          if (!w) return;
          this.waiting.delete(msg.id);
          clearTimeout(w.timer);
          if (msg.error) w.rej(new Error(`${w.method}: ${msg.error.message}`));
          else w.res(msg.result);
        } else for (const l of this.listeners) l(msg);
      };
    });
  }
  send(method, params = {}, sessionId, timeout = 120000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        rej(new Error(`${method} timed out after ${timeout / 1000} s`));
      }, timeout);
      this.waiting.set(id, { res, rej, timer, method });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

let chrome = null;
let profile = null;
let cdp = null;
function cleanup() {
  try {
    chrome?.kill();
  } catch {
    /* gone */
  }
  chrome = null;
  if (profile) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Chrome may still hold a file for a moment: it is in the temp dir */
    }
    profile = null;
  }
  if (lockPath) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* gone */
    }
    lockPath = null;
  }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(130));

async function main() {
  const exe = findBrowser();
  if (!exe) fail('no Chrome / Edge found — pass --chrome <path to chrome.exe> or set CHROME_PATH');
  const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (ff.status !== 0 && !dry) fail('ffmpeg not found on PATH (needed to assemble the MP4). Windows: winget install Gyan.FFmpeg');
  mkdirSync(dirname(out), { recursive: true });

  await acquireSlot();
  profile = mkdtempSync(join(tmpdir(), 'gca-film-profile-'));
  const gpu = ['--enable-gpu', '--ignore-gpu-blocklist'];
  if (process.platform === 'win32') gpu.push('--use-angle=d3d11');
  if (process.platform === 'darwin') gpu.push('--use-angle=metal');
  chrome = spawn(
    exe,
    [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--renderer-process-limit=1', '--disable-features=Translate,MediaRouter,OptimizationHints', ...gpu, 'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('the browser did not start within 30 s')), 30000);
    chrome.stderr.on('data', (d) => {
      if (buf === null) return; // keep draining stderr so the browser never blocks on a full pipe
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        buf = null;
        res(m[1]);
      }
    });
    chrome.on('exit', (code) => buf !== null && rej(new Error(`the browser exited (${code}): ${buf.slice(-1500)}`)));
  });
  cdp = new Cdp(wsUrl);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p, t) => cdp.send(m, p, sessionId, t);
  const pageErrors = [];
  cdp.listeners.push((msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push((d.exception?.description || d.text || 'exception').slice(0, 600));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      pageErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600));
    }
  });
  await S('Runtime.enable');
  await S('Page.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const js = async (expr, timeout) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeout);
    if (r.exceptionDetails) throw new Error('in the page: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  const u = new URL(base);
  u.searchParams.set('agent', '');
  u.searchParams.set('autostart', '');
  if (!u.searchParams.has('quality')) u.searchParams.set('quality', quality);
  const url = u.toString().replace(/=(&|$)/g, '$1');
  note(`GRAND CRASH AUTO recorder v${RECORDER_VERSION} · ${dry ? 'DRY RUN (no video)' : 'filming'} · ${W}x${H} @ ${fps} fps · ${seconds} s`);
  note(`url     ${url}`);
  note(`scene   ${scene.replace(/\s*\n\s*/g, '; ')}`);
  await S('Page.navigate', { url });
  const t0 = Date.now();
  for (;;) {
    const st = await js(`typeof gca === 'object' ? (gca.film && gca.ready() ? 'ok' : gca.film ? 'boot' : 'old') : 'none'`).catch(() => 'none');
    if (st === 'ok') break;
    if (st === 'old') fail('this game build has no gca.film (older than the recorder) — wait for the new deploy or use --local');
    if (Date.now() - t0 > 180000) fail('the game did not load within 180 s' + (pageErrors.length ? ':\n' + pageErrors.join('\n') : ''));
    await sleep(500);
  }
  const version = await js('gca.version');
  note(`game    endpoint version ${version} · loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await sleep(2500); // world settles + first streaming
  await js('gca.film.start()');
  const reply = await js(`gca.do(${JSON.stringify(scene)})`);
  note('\n===== scene → game\n' + reply);
  const dt = 1 / fps;
  for (let i = 0; i < Math.round(preroll * fps); i++) {
    await js(`gca.film.advance(1, ${dt})`);
    await sleep(30); // real time for the terrain workers
  }

  const clock0 = await js('gca.json().t');
  note(`\nshot 0.0 s = game clock t ${clock0.toFixed(1)} s (the text view's t, EVENTS and QUEUE use the game clock)`);
  const total = Math.round(seconds * fps);
  const every = Math.max(1, Math.round(logEvery * fps));
  const sheetAt = new Set(Array.from({ length: 16 }, (_, k) => Math.min(total - 1, Math.round((k * (total - 1)) / 15))));
  const frames = mkdtempSync(join(tmpdir(), 'gca-film-frames-'));
  const stills = [];
  const tStart = Date.now();
  for (let i = 0; i < total; i++) {
    if (i % every === 0) note(`\n===== shot ${(i / fps).toFixed(1)} s\n` + (await js('gca.state()')));
    const grab = !dry || sheetAt.has(i);
    if (grab) {
      const data = await js(`gca.film.frame(${dt}, 0.94)`);
      const file = join(frames, dry ? `s${String(stills.length).padStart(2, '0')}.jpg` : `f${String(i).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
      if (sheetAt.has(i)) stills.push({ file, t: i / fps });
    } else await js(`gca.film.advance(1, ${dt})`);
    if (i % 60 === 59 && !dry) {
      const el = (Date.now() - tStart) / 1000;
      console.error(`[film] frame ${i + 1}/${total} · ${el.toFixed(0)} s · about ${((el / (i + 1)) * (total - i - 1)).toFixed(0)} s left`);
    }
  }
  note(`\n===== end of the shot (shot ${seconds.toFixed(1)} s)\n` + (await js('gca.state()')));
  await js('gca.film.stop()').catch(() => {});
  try {
    await cdp.send('Browser.close', {}, undefined, 5000);
  } catch {
    /* killed below */
  }
  cleanup();

  // contact sheet: 16 frames across the shot
  if (!flag('no-sheet') && ff.status === 0 && stills.length) {
    const sheetDir = mkdtempSync(join(tmpdir(), 'gca-film-sheet-'));
    stills.forEach((s, k) => copyFileSync(s.file, join(sheetDir, `s${String(k).padStart(2, '0')}.jpg`)));
    const tw = Math.round(Math.min(W, 1920) / 4 / 2) * 2;
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(sheetDir, 's%02d.jpg'), '-vf', `scale=${tw}:-2,tile=4x4`, '-frames:v', '1', '-q:v', '3', sheetFile], { encoding: 'utf8' });
    rmSync(sheetDir, { recursive: true, force: true });
    if (r.status === 0) note(`\nsheet   ${sheetFile}\n        tiles left→right, top→bottom at t = ${stills.map((s) => s.t.toFixed(1)).join(', ')} s`);
    else note('\nsheet   failed: ' + r.stderr);
  }
  if (!dry) {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, 'f%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(out)) fail('ffmpeg failed: ' + (r.stderr || r.error));
  }
  if (flag('keep-frames')) note(`frames  kept in ${frames}`);
  else rmSync(frames, { recursive: true, force: true });
  note(`\nerrors  ${pageErrors.length ? '\n' + pageErrors.join('\n') : 'none'}`);
  if (!dry) note(`\nvideo   ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB, ${seconds} s @ ${fps} fps, ${W}x${H}, rendered in ${((Date.now() - tStart) / 1000).toFixed(0)} s)`);
  writeFileSync(logFile, log.join('\n') + '\n');
  console.log(`log     ${logFile}`);
  if (!dry && !flag('no-open')) {
    const opener = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [out], { detached: true, stdio: 'ignore' }).unref();
  }
}

main().catch((e) => {
  cleanup();
  if (log.length) {
    try {
      writeFileSync(logFile, log.join('\n') + '\n\nFAILED: ' + (e?.stack || e) + '\n');
    } catch {
      /* no log */
    }
  }
  fail(String(e?.message || e));
});
