// Missiles: sky traffic, a shot from the nearest air-defence site, the impact, the replay.
export default async function (page, h) {
  await h.wait(3000);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + (await h.game(js)));
  await say('traffic', 'return gca.do("rec on; traffic")');
  await say('sites', 'return gca.do("sites")');
  // the plane nearest to any site
  const id = await h.game(`const M = g.ctx.missiles; let best = null, bd = 1e9;
    for (const p of M.sky) for (const s of M.sites) { const d = Math.hypot(p.ax - s.ax, p.az - s.az); if (!p.hit && d < bd) { bd = d; best = p.id; } }
    return best;`);
  await say('shoot', `return gca.do("shoot ${id} aim left")`);
  await h.wait(1200);
  await h.shot('01-launch');
  await say('flying', 'return JSON.stringify({ controlling: g.ctx.missiles.controlling, missiles: g.ctx.missiles.missiles.map((m) => [Math.round(m.t * 10) / 10, Math.round(m.speed), m.done]) })');
  await h.wait(3500);
  await h.shot('02-missile');
  await h.wait(5000);
  await say('after', `return JSON.stringify({ hit: g.ctx.missiles.sky.find((p) => p.id === ${id})?.hit, phase: g.ctx.missiles.control?.phase, missiles: g.ctx.missiles.missiles.map((m) => m.done) })`);
  await h.shot('03-impact');
  await h.wait(3000);
  await h.shot('04-falling');
  await say('replay', 'return gca.do("replay")');
  await h.wait(2500);
  await h.shot('05-replay');
  await h.wait(3000);
  await h.shot('06-replay2');
  await say('stop', 'return gca.do("replay stop; back")');
}
