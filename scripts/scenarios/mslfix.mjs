// Missile fixes check: aim without AUTO LOCK (red box + guide, dashed circle) → AUTO LOCK (green), a salvo measured in
// REAL time (zoom pumping / flicker), the control room's missile replay (the plane you shot), then your own crash →
// the replay is YOUR plane (user report: it showed the plane you shot down).
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("panel off; day; weather clear; fly jumbo agl 1700 speed 170")');
  await h.wait(2500);
  console.log('enter', await h.game(`
    const M = g.ctx.missiles; const me = g.ctx.planes.state.position;
    let best = null, bd = 1e9; for (const p of M.traffic.planes) { const d = p.pos.distanceTo(me); if (!p.hit && d < bd) { bd = d; best = p; } }
    const o = g.ctx.origin.offset;
    const sites = [...M.sites].filter((s) => s.ready > 0 && s.kind.toLowerCase().includes('quad'));
    sites.sort((a, b) => Math.hypot(a.ax - best.pos.x - o.x, a.az - best.pos.z - o.z) - Math.hypot(b.ax - best.pos.x - o.x, b.az - best.pos.z - o.z));
    return M.enterControl(sites[0].id, best.id) || sites[0].id;`));
  const hud = (label) =>
    h.game(`const q = (s) => document.querySelector(s); const r = q('.msl-ring').getBoundingClientRect(), c = q('.msl-reticle').getBoundingClientRect();
      return ${JSON.stringify(label)} + ': box ' + getComputedStyle(q('.msl-mark')).display + ' ' + Math.round(r.width) + 'px lock=' + q('.msl-mark').classList.contains('lock') + ' · circle ' + Math.round(c.width) + 'px lock=' + q('.msl-reticle').classList.contains('lock') + ' · guide ' + getComputedStyle(q('.msl-guide')).display + ' · "' + q('.msl-state').textContent + '" · fov ' + g.ctx.engine.camera.fov.toFixed(2);`);
  await h.wait(1500);
  console.log(await hud('aim'));
  await h.shot('mf-01-aim');
  // drag by hand toward it (mouse drag on the canvas, like the player)
  await page.mouse.move(640, 360);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(640 + i * 6, 360, { steps: 2 });
  await page.mouse.up();
  await h.wait(600);
  console.log(await hud('after drag'));
  await h.game('g.ctx.missiles.autoLock(); return 1');
  await h.wait(800);
  console.log(await hud('auto lock'));
  await h.shot('mf-02-locked');
  // real-time measurement of every final frame while the salvo flies and hits
  await h.game(`
    const e = g.ctx.engine, r = e.renderer, gl = r.getContext();
    window.__rt = []; window.__rtOn = true; if (!r.__orig) r.__orig = r.render.bind(r); let px = null;
    r.render = (s, c) => { r.__orig(s, c); if (!window.__rtOn || r.getRenderTarget() !== null) return;
      const w = gl.drawingBufferWidth, H = gl.drawingBufferHeight; if (!px || px.length !== w * H * 4) px = new Uint8Array(w * H * 4);
      gl.readPixels(0, 0, w, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let sum = 0, n = 0; for (let k = 0; k < px.length; k += 4 * 17) { sum += px[k] * 0.3 + px[k + 1] * 0.59 + px[k + 2] * 0.11; n++; }
      const M = g.ctx.missiles, ctl = M.control, m = ctl?.first, cp = e.camera.position;
      window.__rt.push({ mean: +(sum / n).toFixed(1), fov: +e.camera.fov.toFixed(2), ph: ctl?.phase?.[0] ?? '-', dm: m && !m.done ? +cp.distanceTo(m.obj.position).toFixed(1) : -1 }); };
    return 1;`);
  console.log('fire', await h.game('return g.ctx.missiles.fire(0, { all: true })'));
  for (let k = 0; k < 40 && (await h.game('return g.ctx.missiles.control?.phase ?? "-"')) !== 'impact'; k++) await h.wait(500);
  await h.wait(3500);
  const rows = await h.game('window.__rtOn = false; return window.__rt');
  const ph = (p) => rows.filter((r) => r.ph === p);
  const dmv = ph('m').map((r) => r.dm).filter((v) => v > 0);
  const dd = dmv.slice(1).map((v, i) => Math.abs(v - dmv[i]));
  const fovs = rows.map((r) => r.fov);
  const fj = fovs.slice(1).map((v, i) => Math.abs(v - fovs[i]));
  const imp = ph('i');
  const ij = imp.slice(1).map((r, i) => Math.abs(r.mean - imp[i].mean));
  console.log('RT frames', rows.length, '| missile cam distance', dmv.length ? `${Math.min(...dmv)}–${Math.max(...dmv)} m, mean frame jump ${(dd.reduce((a, b) => a + b, 0) / Math.max(1, dd.length)).toFixed(2)} m` : '-',
    '| fov frame jumps max', Math.max(0, ...fj).toFixed(2), '| impact brightness mean |Δ|', (ij.reduce((a, b) => a + b, 0) / Math.max(1, ij.length)).toFixed(2), 'max', Math.max(0, ...ij).toFixed(1));
  console.log('fov trail', fovs.filter((_, i) => i % 6 === 0).join(' '));
  await h.shot('mf-03-impact');
  // the control room's REPLAY: the missile story (the plane you shot)
  console.log('replay(missile story)', await h.game('g.ctx.replay.start(); return JSON.stringify({ active: g.ctx.replay.active, shots: g.ctx.replay.shots, camCo: g.ctx.replay.camCo })'));
  const aimchk = () => h.game(`const R = g.ctx.replay, cam = g.ctx.engine.camera; const fwd = new cam.position.constructor(0, 0, -1).applyQuaternion(cam.quaternion);
    const to = R.subj.clone().sub(cam.position); const co = R.camCo ? R.co : R.visual; let cw = null;
    if (co) { const p = co.parts.find((q) => q.name === 'fuselageCenter') ?? co.parts[0]; p.object.updateWorldMatrix(true, false); cw = new cam.position.constructor().setFromMatrixPosition(p.object.matrixWorld); }
    return R.camName + ' t=' + R.t.toFixed(1) + ' subj→cam ' + Math.round(to.length()) + ' m, off-axis ' + (Math.acos(Math.min(1, fwd.dot(to.normalize()))) * 57.3).toFixed(1) + '°, subj vs co ' + (cw ? Math.round(cw.distanceTo(R.subj)) + ' m' : '-') + ', fov ' + cam.fov.toFixed(1);`);
  for (let i = 0; i < 4; i++) { await h.wait(1000); console.log('missile replay', await aimchk()); }
  await h.shot('mf-04-replay-missile');
  await h.game('g.ctx.replay.nextCam(); return 1');
  await h.wait(1500);
  console.log('missile replay', await aimchk());
  await h.shot('mf-04b-replay-missile-chase');
  await h.game('g.ctx.replay.stop(); return 1');
  await h.game('g.ctx.missiles.exitControl(); return 1');
  await h.wait(1500);
  // now crash YOUR plane: the replay must be yours
  await h.game('return gca.do("explode")');
  await h.wait(4500);
  console.log('replay(own crash)', await h.game(`g.ctx.replay.start(); const R = g.ctx.replay;
    return JSON.stringify({ active: R.active, shots: R.shots, camCo: R.camCo, subjectIsMine: R.visual === g.ctx.planes.visual, co: !!R.co })`));
  for (let i = 0; i < 6; i++) { await h.wait(1500); console.log('own replay', await aimchk(), 'origin', await h.game('return Math.round(g.ctx.origin.offset.x) + "," + Math.round(g.ctx.origin.offset.z)')); }
  await h.shot('mf-05-replay-own');
  console.log('replay cam', await h.game('return g.ctx.replay.camName'));
  // the 'Hit plane' pass shows the one you shot
  for (let i = 0; i < 4 && (await h.game('return g.ctx.replay.camName')) !== 'Hit plane'; i++) await h.game('g.ctx.replay.nextCam(); return 1');
  await h.wait(2000);
  console.log('replay cam', await h.game('return g.ctx.replay.camName'));
  await h.shot('mf-06-replay-hitplane');
  await h.game('g.ctx.replay.stop(); return 1');
}
