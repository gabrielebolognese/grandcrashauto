// Teleport the car around the city using CityData and screenshot each spot from the chase camera.
// node scripts/smoke.mjs --tag tour --script scripts/scenarios/tour.mjs
export default async function (page, h) {
  const spots = await h.game(`
    const d = g.ctx.world.data, out = [];
    out.push({ name: 'spawn', p: d.spawn.position, yaw: d.spawn.yaw });
    if (d.jumpRamp) out.push({ name: 'jump', p: d.jumpRamp.position, yaw: d.jumpRamp.yaw });
    const pick = (district) => d.buildings.filter(b => b.district === district)[0];
    for (const dist of ['downtown', 'residential', 'beach', 'park']) {
      const r = g.ctx.world.findRespawn(new g.ctx.engine.camera.position.constructor(
        ...(pick(dist) ? [pick(dist).x, 0, pick(dist).z] : [0, 0, 0])), 0);
      out.push({ name: dist, p: r.position, yaw: r.yaw });
    }
    const hw = d.roads.edges.find(e => e.kind === 'highway');
    if (hw) { const p = hw.points[Math.floor(hw.points.length / 2)]; out.push({ name: 'highway', p, yaw: 0 }); }
    return out;
  `);
  for (const s of spots) {
    await h.game(`g.ctx.vehicle.reset({ position: ${JSON.stringify(s.p)}, yaw: ${s.yaw} }); g.ctx.cameraRig.snap();`);
    await h.wait(700);
    await h.hold('KeyW', 900);
    await h.wait(300);
    const st = await h.game(`const s = g.ctx.engine.stats; return { calls: s.calls, tris: s.triangles, npcs: g.ctx.npcs.activeCount };`);
    console.error(`[tour] ${s.name}`, JSON.stringify(st));
    await h.shot('tour-' + s.name);
  }
}
