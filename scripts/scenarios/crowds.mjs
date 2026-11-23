// Mini crowds: list sites, teleport next to the nearest big one, screenshot.
export default async function (page, h) {
  await h.wait(3000);
  const info = await h.game(`const n = g.ctx.npcs; const c = n.crowd; const car = g.ctx.vehicle.state.position;
    return { dbg: { ...n.debug, tris: undefined }, q: g.ctx.quality.level, sites: c.sites.length,
      list: c.sites.map(s => ({ k: s.kind, n: s.count, x: Math.round(s.x), z: Math.round(s.z), d: Math.round(Math.hypot(s.x - car.x, s.z - car.z)), on: s.on })).sort((a, b) => a.d - b.d).slice(0, 12) };`);
  console.error('[crowds] ' + JSON.stringify(info));
  await h.shot('spawn');
  // teleport next to the biggest site within 400 m
  const tp = await h.game(`const c = g.ctx.npcs.crowd; const car = g.ctx.vehicle.state.position;
    const s = c.sites.filter(s => Math.hypot(s.x - car.x, s.z - car.z) < 600).sort((a, b) => b.count - a.count)[0];
    if (!s) return null; const yaw = Math.atan2(s.x - (s.x - 18), 0);
    g.ctx.game.teleportCar({ position: { x: s.x - 18, y: s.y + 0.5, z: s.z }, yaw: Math.PI / 2 }); return { k: s.kind, n: s.count, x: s.x, z: s.z };`);
  await h.wait(3500);
  const after = await h.game(`const n = g.ctx.npcs; return { tp: ${'null'}, members: n.debug.crowdMembers, sites: n.debug.crowdSites, alive: n.crowd.aliveCount(), vis: n.crowd.meshes.map(m => m.count) };`);
  console.error('[crowds-tp] ' + JSON.stringify({ tp, after }));
  await h.shot('crowd');
}
