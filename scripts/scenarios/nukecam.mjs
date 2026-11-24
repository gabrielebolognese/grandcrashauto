// NUKE CAM: nuke the sky plane nearest to the nuke turret, ride the nuke, then watch the plane go down.
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("day; weather clear; fly prop agl 300 speed 60")');
  await h.wait(2500);
  const id = await h.game(`const M = g.ctx.missiles, o = g.ctx.origin.offset; const silo = M.launchers.list.find((l) => l.type.kind === 'nuke');
    const sp = M.launchers.pivot(silo, new (g.ctx.engine.camera.position.constructor)()); let best = null, bd = 1e9;
    for (const p of M.traffic.planes) { const d = p.pos.distanceTo(sp); if (!p.hit && d < bd) { bd = d; best = p.id; } } return best;`);
  console.log(await h.game(`return gca.do("nuke ${id}")`));
  await h.wait(300);
  console.log(await h.game('return gca.do("watch nuke")'));
  let k = 0, last = '';
  for (let i = 0; i < 24 && k < 8; i++) {
    await h.wait(2000);
    const st = await h.game('const s = g.ctx.missiles.spec; return s ? (s.m ? "nuke" : s.p ? "plane" : "blast") : "off"');
    if (st === 'off') break;
    if (i % 3 === 0 || st !== last) {
      await h.shot(`${10 + k}-${st}`);
      k++;
    }
    last = st;
  }
  console.log('end', await h.game('return gca.do("back")'));
}
