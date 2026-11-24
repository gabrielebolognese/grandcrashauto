// Trees vs planes + wrecks that stay after a respawn: counts from the live game (agent mode).
export default async function (page, h) {
  await h.wait(2500);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + JSON.stringify(await h.game(js)));
  const counts = `
    const sc = g.ctx.terrain.scatter, ps = g.ctx.planes;
    return { brokenTrees: sc.broken.size, fallen: sc.fallen[0].length + sc.fallen[1].length, wrecks: ps.wrecks.length,
      pieces: g.ctx.breakup.pieces.length, retiredRts: g.ctx.breakup.planes.filter((r) => r.retired).length,
      wreckGroups: g.ctx.engine.scene.children.filter((c) => c.name.startsWith('wreck-')).length };`;
  await say('fly low', 'return gca.do("fly jumbo agl 5 speed 130")');
  await h.wait(5000);
  await say('after 5 s skimming', counts);
  await say('split', 'return gca.do("split")');
  await h.wait(12000);
  await say('after the crash', counts);
  await h.shot('01-wreck');
  await say('respawn', 'return gca.do("fly airliner agl 300")');
  await h.wait(3000);
  await say('after respawn', counts);
  await say('engine after respawn ok', 'return gca.do("engine 1")');
  await h.wait(2000);
  await say('crash 2', 'return gca.do("split")');
  await h.wait(14000);
  await say('respawn 2', 'return gca.do("fly jumbo")');
  await h.wait(2500);
  await say('after respawn 2', counts);
  await say('respawn 3 (budget)', 'return gca.do("split")');
  await h.wait(12000);
  await h.game('return gca.do("fly prop")');
  await h.wait(2500);
  await say('after respawn 3', counts);
}
