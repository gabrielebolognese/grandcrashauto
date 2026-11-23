// Concert + mini crowds: crowds near spawn materialize, concert POI teleport, day/night shots, drive in, map.
export default async function (page, h) {
  await h.wait(3500);
  const crowdInfo = `const n = g.ctx.npcs; const c = n.crowd; const car = g.ctx.vehicle.state.position;
    const mini = c.sites.filter(s => !s.big).map(s => ({ k: s.kind, n: s.count, d: Math.round(Math.hypot(s.x - car.x, s.z - car.z)), on: s.on })).sort((a, b) => a.d - b.d).slice(0, 6);
    const big = c.sites.filter(s => s.big);
    const tri = (m) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    return { mini, miniOn: c.materialized, bigSites: big.length, bigTotal: big.reduce((a, s) => a + s.count, 0), bigOn: c.materializedBig, bigTilesOn: big.filter(s => s.on).length,
      meshCounts: c.meshes.map(m => m.count), crowdTris: c.meshes.reduce((a, m) => a + m.count * tri(m), 0), frameTris: g.ctx.engine.renderer?.info?.render?.triangles, calls: g.ctx.engine.renderer?.info?.render?.calls, q: g.ctx.quality.level, mob: g.ctx.quality.isMobile };`;
  console.error('[spawn] ' + JSON.stringify(await h.game(crowdInfo)));
  await h.shot('spawn');
  const poi = await h.game(`const nav = g.ctx.nav; nav.refreshPois?.(); const p = nav.entries().find(e => e.id === 'concert'); return p ? { name: p.name, icon: p.icon, disc: p.discovered, can: nav.canTeleport(p) } : null;`);
  console.error('[poi] ' + JSON.stringify(poi));
  await h.game(`g.ctx.nav.teleport('concert')`);
  await h.wait(4500);
  console.error('[concert] ' + JSON.stringify(await h.game(crowdInfo)));
  await h.shot('concert-day');
  // daylight from a high orbit-ish view: camera debug not needed, just night next
  await h.game(`g.ctx.env.setTime?.(22.5)`);
  await h.wait(2500);
  await h.shot('concert-night');
  await h.game(`g.ctx.env.setTime?.(13)`);
  await h.wait(1000);
  // drive into the crowd
  await page.keyboard.down('KeyW');
  await h.wait(3200);
  await page.keyboard.up('KeyW');
  await h.shot('concert-drive');
  await h.wait(1500);
  console.error('[after-drive] ' + JSON.stringify(await h.game(`const n = g.ctx.npcs; return { hits: n.debug.hits, knocked: n.debug.knocked, active: n.debug.active, bigOn: n.crowd.materializedBig };`)));
  await h.shot('concert-after');
  await page.keyboard.press('KeyN');
  await h.wait(1500);
  await h.shot('map');
  await page.keyboard.press('KeyN');
  await h.wait(500);
}
