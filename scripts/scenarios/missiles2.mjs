// Missiles 2: the control-room view, a Hornet salvo (spread), the nuke from the silo, ramming a sky plane.
export default async function (page, h) {
  await h.wait(3000);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + (await h.game(js)));
  const nearest = (site) => h.game(`const M = g.ctx.missiles; const s = M.sites.find((x) => x.id === '${site}'); let best = null, bd = 1e9;
    for (const p of M.sky) { const d = Math.hypot(p.ax - s.ax, p.az - s.az); if (!p.hit && d < bd) { bd = d; best = p.id; } } return best;`);
  await say('sites', 'return gca.do("rec on; sites")');
  let id = await nearest('sam-beach');
  await say('enter control (hornet)', `return g.ctx.missiles.enterControl('sam-beach', ${id}) || 'ok'`);
  await h.wait(1500);
  await h.shot('01-control-view');
  await say('salvo', `return gca.do("shoot all spread")`);
  await h.wait(5000);
  await h.shot('02-salvo');
  await h.wait(5000);
  await say('hit?', `return JSON.stringify(g.ctx.missiles.sky.find((p) => p.id === ${id}))`);
  await h.shot('03-salvo-hit');
  await say('back', 'return gca.do("back")');
  id = await nearest('silo-north');
  await say('nuke shot', `return gca.do("shoot ${id} from silo")`);
  await h.wait(9000);
  await h.shot('04-nuke-flight');
  await h.wait(7000);
  await h.shot('05-nuke');
  await say('after nuke', 'return JSON.stringify(g.ctx.missiles.sky.map((p) => [p.id, p.hit]))');
  await say('back', 'return gca.do("back")');
  await say('fly + ram', 'return gca.do("fly jumbo agl 1700 speed 170")');
  await h.wait(2000);
  const me = await h.game('const p = g.ctx.planes.state.position; const o = g.ctx.origin.offset; return JSON.stringify([p.x + o.x, p.z + o.z])');
  const [mx, mz] = JSON.parse(me);
  const rid = await h.game(`const M = g.ctx.missiles; let best = null, bd = 1e9; for (const p of M.sky) { const d = Math.hypot(p.ax - ${mx}, p.az - ${mz}); if (!p.hit && d < bd) { bd = d; best = p.id; } } return best;`);
  await say('ram', `return gca.do("ram ${rid}")`);
  for (let k = 0; k < 6; k++) {
    await h.wait(5000);
    const r = await h.game(`return JSON.stringify({ hit: g.ctx.missiles.sky.find((p) => p.id === ${rid})?.hit ?? 'gone', me: g.ctx.planes.crashed, d: Math.round(g.ctx.planes.state.position.distanceTo(g.ctx.missiles.traffic.planes.find((p) => p.id === ${rid})?.pos ?? g.ctx.planes.state.position)) })`);
    console.log('ram', r);
    if (r.includes('"hit":true')) break;
  }
  await h.shot('06-ram');
}
