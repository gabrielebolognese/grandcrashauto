// Terrain screenshots from fixed cameras (ABSOLUTE coords) — node scripts/smoke.mjs --tag terrain --script src/terrain/smoke/views.mjs
// Optional env TERRAIN_VIEWS="name,name" to pick a subset.
const VIEWS = [
  { name: 'city-north', pos: [300, 70, 250], look: [1500, 40, -2500] },
  { name: 'coast-east', pos: [1900, 45, 520], look: [3600, 20, 300] },
  { name: 'farmland', pos: [2400, 60, -1500], look: [3200, 10, -2400] },
  { name: 'hills-air', pos: [2000, 420, -2600], look: [4200, 200, -7500] },
  { name: 'mountains', pos: [5200, 900, -6200], look: [3800, 600, -9900] },
  { name: 'summit-air', pos: [3200, 1500, -8200], look: [3800, 900, -9900] },
  { name: 'west-coast', pos: [-3300, 120, -2600], look: [-4300, 0, -4800] },
];
export default async function (page, h) {
  await h.wait(1500);
  const pick = (process.env.TERRAIN_VIEWS || '').split(',').filter(Boolean);
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
    if (pick.length && !pick.includes(v.name)) continue;
    await h.game(`window.__camHold = ${JSON.stringify(v)};`);
    // wait for streaming to settle (SwiftShader + shared CPU are slow)
    for (let i = 0; i < 40; i++) {
      await h.wait(1000);
      const s = await h.game(`const t = window.__terrain; return t ? t.debugStats() : null;`);
      if (s && s.pool.pending === 0 && s.tiles.holes === 0 && i > 3) break;
    }
    await h.wait(800);
    const st = await h.game(`const s = g.ctx.engine.stats, t = window.__terrain; return { calls: s.calls, tris: s.triangles, fps: +s.fps.toFixed(1), terrain: t ? t.debugStats() : null };`);
    console.error(`[views] ${v.name}`, JSON.stringify(st));
    await h.shot('view-' + v.name);
  }
}
