// Missile flicker in REAL time (not film mode): every final frame's mean brightness / blown-out share, frame time,
// render scale and camera, while a full salvo flies from the control room.
export default async function (page, h) {
  await h.wait(3000);
  await h.game(`return gca.do("panel off; ${process.env.FLK_NIGHT ? 'night' : 'day'}; weather clear; fly jumbo agl 1700 speed 170")`);
  await h.wait(2500);
  console.log('enter', await h.game(`
    const M = g.ctx.missiles; const me = g.ctx.planes.state.position;
    let best = null, bd = 1e9; for (const p of M.traffic.planes) { const d = p.pos.distanceTo(me); if (!p.hit && d < bd) { bd = d; best = p; } }
    const o = g.ctx.origin.offset;
    const sites = [...M.sites].filter((s) => s.ready > 0 && s.kind.toLowerCase().includes(${JSON.stringify(process.env.FLK_KIND || "quad")}));
    sites.sort((a, b) => Math.hypot(a.ax - best.pos.x - o.x, a.az - best.pos.z - o.z) - Math.hypot(b.ax - best.pos.x - o.x, b.az - best.pos.z - o.z));
    return M.enterControl(sites[0].id, best.id) || sites[0].id;`));
  await h.wait(1500);
  // hook the final render (to the canvas) and measure it
  await h.game(`
    const e = g.ctx.engine, r = e.renderer, gl = r.getContext();
    window.__rt = []; window.__rtOn = true;
    if (!r.__orig) { r.__orig = r.render.bind(r); }
    let px = null, last = performance.now(), lastCam = e.camera.position.clone();
    r.render = (s, c) => {
      r.__orig(s, c);
      if (!window.__rtOn || r.getRenderTarget() !== null) return;
      const w = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      if (!px || px.length !== w * H * 4) px = new Uint8Array(w * H * 4);
      gl.readPixels(0, 0, w, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, hi = 0, n = 0; for (let k = 0; k < px.length; k += 4 * 17) { const l = px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11; sum += l; if (l > 240) hi++; n++; }
      const now = performance.now(); const cp = e.camera.position;
      const M = g.ctx.missiles, ctl = M.control, m = ctl?.first;
      // the impact phase: an 8×6 luminance grid per frame + a few JPEGs (where does the flicker sit?)
      if (ctl?.phase === 'impact' && (window.__imp = (window.__imp ?? 0) + 1) <= 24) {
        const grid = []; for (let gy = 0; gy < 6; gy++) for (let gx = 0; gx < 8; gx++) { let s2 = 0, n2 = 0; for (let y = Math.floor(gy * H / 6); y < Math.floor((gy + 1) * H / 6); y += 4) for (let x = Math.floor(gx * w / 8); x < Math.floor((gx + 1) * w / 8); x += 4) { const k = (y * w + x) * 4; s2 += px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11; n2++; } grid.push(Math.round(s2 / n2)); }
        (window.__grids = window.__grids ?? []).push(grid);
        if (window.__imp >= 9 && window.__imp <= 16) { const cv = document.createElement('canvas'); cv.width = w; cv.height = H; const x2 = cv.getContext('2d'); const img = x2.createImageData(w, H); const row = w * 4; for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row); x2.putImageData(img, 0, 0); (window.__jpgs = window.__jpgs ?? []).push(cv.toDataURL('image/jpeg', 0.75)); }
      }
      window.__rt.push({ t: Math.round(now), dt: +(now - last).toFixed(1), mean: +(sum / n).toFixed(1), hi: +(hi / n * 100).toFixed(2), w, rs: e.stats.renderScale,
        cam: +cp.distanceTo(lastCam).toFixed(1), ph: ctl?.phase?.[0] ?? '-', dm: m && !m.done ? Math.round(cp.distanceTo(m.obj.position)) : -1,
        lights: g.ctx.fx.lights ? 0 : 0 });
      last = now; lastCam.copy(cp);
    };
    return 1;`);
  console.log('fire', await h.game(`return g.ctx.missiles.fire(0, { all: true })`));
  await h.wait(Number(process.env.FLK_MS || 9000));
  const rows = await h.game(`window.__rtOn = false; return window.__rt`);
  const fmt = rows.map((r, i) => `${i}:${r.mean}/${r.hi}${r.ph}${r.dm >= 0 ? '@' + r.dm : ''}${i && r.w !== rows[i - 1].w ? ' [RES ' + r.w + ']' : ''}${r.dt > 60 ? ' [dt' + r.dt + ']' : ''}`).join(' ');
  console.log('RT', rows.length, 'frames', fmt);
  const jumps = rows.slice(1).map((r, i) => ({ i: i + 1, d: +Math.abs(r.mean - rows[i].mean).toFixed(1), hi: r.hi, ph: r.ph, dm: r.dm, dt: r.dt, res: r.w !== rows[i].w })).sort((a, b) => b.d - a.d).slice(0, 15);
  console.log('RTJUMPS', JSON.stringify(jumps));
  const fl = rows.slice(1).reduce((a, r, i) => a + Math.abs(r.mean - rows[i].mean), 0) / Math.max(1, rows.length - 1);
  const extra = await h.game('return { grids: window.__grids ?? [], jpgs: window.__jpgs ?? [] }');
  const fs = await import('node:fs');
  extra.jpgs.forEach((d, i) => fs.writeFileSync('.smoke/lead/flk/rt-imp-' + (i + 9) + '.jpg', Buffer.from(d.split(',')[1], 'base64')));
  extra.grids.forEach((gr, i) => { if (i) console.log('GRIDΔ', i, gr.map((v, k) => v - extra.grids[i - 1][k]).join(' ')); });
  console.log('RTFLICKER mean |Δ| =', fl.toFixed(2), 'max hi% =', Math.max(...rows.map((r) => r.hi)), 'res changes =', rows.filter((r, i) => i && r.w !== rows[i - 1].w).length);
}
