// Final visual + coverage check: views from fixed cameras, then a fast inland teleport run (holes, profiling).
//   node scripts/smoke.mjs --tag terrain --script src/terrain/smoke/final.mjs
const VIEWS = [
  { name: 'farmland', pos: [2300, 45, -1300], look: [3100, 5, -2300] },
  { name: 'mountains', pos: [5600, 950, -6400], look: [3800, 600, -9900] },
  { name: 'summit-air', pos: [2600, 1700, -7600], look: [3800, 800, -9900] },
  { name: 'lighthouse', pos: [3300, 60, 520], look: [3510, 30, 560] },
];
export default async function (page, h) {
  await h.wait(1500);
  await h.game(`
    const rig = g.ctx.cameraRig;
    window.__camHold = null;
    if (!rig.__origUpdate) rig.__origUpdate = rig.update.bind(rig);
    rig.update = (dt, a) => {
      const v = window.__camHold;
      if (!v) return rig.__origUpdate(dt, a);
      const o = g.ctx.origin.offset, cam = g.ctx.engine.camera;
      cam.position.set(v.pos[0] - o.x, v.pos[1], v.pos[2] - o.z);
      cam.lookAt(v.look[0] - o.x, v.look[1], v.look[2] - o.z);
      cam.updateMatrixWorld();
    };
    if (g.ctx.env.setTime) g.ctx.env.setTime(10.5);
  `);
  for (const v of VIEWS) {
    await h.game(`window.__camHold = ${JSON.stringify(v)};`);
    for (let i = 0; i < 45; i++) {
      await h.wait(1000);
      const s = await h.game(`const t = window.__terrain; return t ? t.debugStats() : null;`);
      if (s && s.pool.pending === 0 && s.tiles.holes === 0 && i > 3) break;
    }
    await h.wait(1200);
    const st = await h.game(`const s = g.ctx.engine.stats, t = window.__terrain.debugStats(); return { calls: s.calls, tris: s.triangles, tiles: t.tiles, scatter: t.scatter, prof: t.profMax };`);
    console.error(`[views] ${v.name}`, JSON.stringify(st));
    await h.shot('final-' + v.name);
  }
  await h.game(`window.__camHold = null;`);
  // fast run: 40 steps of 150 m every second (~540 km/h) — coverage must hold (coarser LOD, no holes)
  let maxHoles = 0;
  for (let k = 0; k <= 40; k++) {
    const r = await h.game(`
      const c = g.ctx, o = c.origin.offset;
      const ax = 900 + ${k} * 150 * 0.62, az = -900 - ${k} * 150 * 0.78;
      const lx = ax - o.x, lz = az - o.z;
      c.vehicle.reset({ position: { x: lx, y: c.terrain.heightAt(lx, lz) + 1.5, z: lz }, yaw: Math.PI * 0.8 });
      c.cameraRig.snap();
      const t = window.__terrain.debugStats();
      return { k: ${k}, holes: t.tiles.holes, pend: t.pool.pending, msAvg: t.updateMsAvg, msMax: t.updateMsMax, inst: t.scatter.instances };
    `);
    maxHoles = Math.max(maxHoles, r.holes);
    if (k % 10 === 0) console.error('[fast]', JSON.stringify(r));
    if (k === 40) await h.shot('final-fast');
    await h.wait(1000);
  }
  const fin = await h.game(`return window.__terrain.debugStats();`);
  console.error('[final]', JSON.stringify({ maxHoles, stats: fin }));
}
