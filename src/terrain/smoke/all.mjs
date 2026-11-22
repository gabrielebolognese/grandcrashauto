// Combined terrain check (one browser run): determinism, views from fixed cameras, a short drive on terrain, profiling.
//   node scripts/smoke.mjs --tag terrain --script src/terrain/smoke/all.mjs
// env TERRAIN_VIEWS="a,b" (subset), TERRAIN_SKIP="det,drive"
const VIEWS = [
  { name: 'city-north', pos: [300, 70, 250], look: [1500, 40, -2500] },
  { name: 'farmland', pos: [2300, 45, -1300], look: [3100, 5, -2300] },
  { name: 'coast-east', pos: [2100, 40, 560], look: [3600, 15, 260] },
  { name: 'mountains', pos: [5600, 950, -6400], look: [3800, 600, -9900] },
  { name: 'summit-air', pos: [2600, 1700, -7600], look: [3800, 800, -9900] },
];
export default async function (page, h) {
  const skip = (process.env.TERRAIN_SKIP || '').split(',');
  const pick = (process.env.TERRAIN_VIEWS || '').split(',').filter(Boolean);
  await h.wait(1500);
  if (!skip.includes('det')) {
    const d = await h.game(`return window.__terrain.debugDeterminism();`).catch((e) => String(e));
    console.error('[det]', JSON.stringify(d));
  }
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
    for (let i = 0; i < 45; i++) {
      await h.wait(1000);
      const s = await h.game(`const t = window.__terrain; return t ? t.debugStats() : null;`);
      if (s && s.pool.pending === 0 && s.tiles.holes === 0 && i > 3) break;
    }
    await h.wait(1500);
    const st = await h.game(`const s = g.ctx.engine.stats, t = window.__terrain; return { calls: s.calls, tris: s.triangles, fps: +s.fps.toFixed(1), terrain: t ? t.debugStats() : null };`);
    console.error(`[views] ${v.name}`, JSON.stringify(st));
    await h.shot('view-' + v.name);
  }
  await h.game(`window.__camHold = null;`);
  if (!skip.includes('drive')) {
    for (const s of [{ name: 'farmland', p: [2450, -1450], yaw: 2.6 }, { name: 'pier', poi: 'pier' }]) {
      await h.game(`
        const c = g.ctx, o = c.origin.offset;
        let x, z, yaw;
        if (${JSON.stringify(s.poi || '')}) { const p = c.terrain.pois.find(q => q.id === ${JSON.stringify(s.poi || '')}); x = p.pose.position.x; z = p.pose.position.z; yaw = p.pose.yaw; }
        else { x = ${s.p ? s.p[0] : 0} - o.x; z = ${s.p ? s.p[1] : 0} - o.z; yaw = ${s.yaw ?? 0}; }
        window.__spot = { x, z, yaw };
      `);
      for (let i = 0; i < 40; i++) {
        const ok = await h.game(`const s = window.__spot; return g.ctx.terrain.isReady(s.x, s.z, 80);`);
        if (ok) break;
        await h.wait(1000);
      }
      await h.game(`
        const c = g.ctx, s = window.__spot;
        const y = c.terrain.heightAt(s.x, s.z) + (${JSON.stringify(s.poi || '')} ? 0.6 : 1.2);
        c.vehicle.reset({ position: { x: s.x, y, z: s.z }, yaw: s.yaw });
        c.cameraRig.snap();
      `);
      await h.wait(3000);
      await h.shot('drive-' + s.name + '-a');
      await h.hold('KeyW', 2500);
      const st = await h.game(`
        const c = g.ctx, v = c.vehicle.state, p = v.position;
        const gh = c.terrain.heightAt(p.x, p.z);
        return { pos: [p.x, p.y, p.z].map(n => +n.toFixed(2)), ground: +gh.toFixed(2), dy: +(p.y - gh).toFixed(2), kmh: Math.round(v.speedKmh),
          surface: c.terrain.surfaceAt(p.x, p.z), biome: c.terrain.biomeAt(p.x, p.z), wheels: v.wheels.map(w => w.contact), water: c.terrain.waterAt(p.x, p.z),
          ocean: Math.round(c.terrain.oceanDistance(p.x, p.z)), calls: c.engine.stats.calls, tris: c.engine.stats.triangles };
      `);
      console.error(`[drive] ${s.name}`, JSON.stringify(st));
      await h.shot('drive-' + s.name + '-b');
    }
  }
  const fin = await h.game(`return { pois: g.ctx.terrain.pois.map(p => [p.id, Math.round(p.pose.position.x), Math.round(p.pose.position.y), Math.round(p.pose.position.z)]), stats: window.__terrain.debugStats() };`);
  console.error('[final]', JSON.stringify(fin));
}
