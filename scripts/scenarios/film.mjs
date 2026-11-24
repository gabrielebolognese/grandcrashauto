// Film scenario (driven by scripts/film.mjs): frame-exact offline render of an agent scene → MP4 → open it.
// Every frame advances the game exactly 1/FPS s (engine film mode), so the video is perfectly smooth whatever the
// headless frame rate. Frames come straight from the game canvas (pure footage, no buttons).
// Env: FILM_SCENE, FILM_SECONDS, FILM_PREROLL, FILM_FPS, FILM_OUT, FILM_SIZE, FILM_OPEN, FILM_KEEP.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

// step one frame, read the pixels, flip rows, encode JPEG (runs in the page; g = window.__game)
const GRAB = `
  const e = g.ctx.engine;
  e.filmStep($DT);
  const gl = e.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, row = w * 4;
  if (!window.__film || window.__film.w !== w || window.__film.h !== h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    window.__film = { w, h, c, x, px: new Uint8Array(w * h * 4), img: x.createImageData(w, h) };
  }
  const f = window.__film;
  e.renderer.setRenderTarget(null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, f.px);
  for (let y = 0; y < h; y++) f.img.data.set(f.px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  f.x.putImageData(f.img, 0, 0);
  return f.c.toDataURL('image/jpeg', 0.94);
`;

const DEFAULT_SCENE ='rec on; night; fly jumbo agl 9 speed 140; wait 3.5; pitch up 1.6; wait 1.6; split';

export default async function (page, h) {
  const scene = process.env.FILM_SCENE || DEFAULT_SCENE;
  const fps = Number(process.env.FILM_FPS || 30);
  const seconds = Number(process.env.FILM_SECONDS || 15);
  const preroll = Number(process.env.FILM_PREROLL || 0.6);
  const [w, hh] = (process.env.FILM_SIZE || '1920x1080').split('x').map(Number);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = resolve(process.env.FILM_OUT || join('film', `scene-${stamp}.mp4`));
  const frames = join(tmpdir(), `crashgame-film-${process.pid}`);
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });

  await page.setViewportSize({ width: w, height: hh });
  await h.wait(2500);
  await h.game('g.ctx.engine.setFilming(true); return 1');
  console.log('\n===== scene\n' + (await h.game(`return gca.do(${JSON.stringify(scene)})`)));
  const step = (n) => h.game(`for (let i = 0; i < ${n}; i++) g.ctx.engine.filmStep(${1 / fps}); return 1`);
  // pre-roll (not filmed): spawn snap, first streaming
  for (let i = 0; i < Math.round(preroll * fps); i++) {
    await step(1);
    await h.wait(30);
  }
  console.log('\n===== at the start of the shot\n' + (await h.game('return gca.state()')));
  const total = Math.round(seconds * fps);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    // read the frame straight from the GL drawing buffer in the same task as the render (readPixels waits for the
    // finished image; page screenshots / canvas.toDataURL raced the GPU and caught blank or half-drawn frames)
    const url = await h.game(GRAB.replace('$DT', String(1 / fps)));
    writeFileSync(join(frames, `f${String(i).padStart(5, '0')}.jpg`), Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
    if (i % 60 === 0) console.error(`[film] frame ${i}/${total} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    if (i === Math.round(5.5 * fps)) console.log('\n===== mid-shot\n' + (await h.game('return gca.state()')));
  }
  console.log('\n===== end of the shot\n' + (await h.game('return gca.state()')));
  await h.game('g.ctx.engine.setFilming(false); return 1');
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, 'f%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(out)) throw new Error('ffmpeg failed: ' + (r.stderr || r.error));
  if (process.env.FILM_KEEP === '1') console.log('[film] frames kept in ' + frames);
  else rmSync(frames, { recursive: true, force: true });
  console.log(`\n[film] ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB, ${seconds} s @ ${fps} fps, ${w}x${hh})`);
  if (process.env.FILM_OPEN !== '0') spawn('explorer.exe', [out], { detached: true, stdio: 'ignore' }).unref();
}
