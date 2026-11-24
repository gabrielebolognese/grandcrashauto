// Homing crash into the concert: the stage breaks, the crowd (and the band) go flying.
export default async function (page, h) {
  await h.wait(3000);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + (typeof js === 'string' ? await h.game(js) : ''));
  const counts = `const n = g.ctx.npcs; const st = g.ctx.world.concert?.parts;
    return JSON.stringify({ stageBroken: st?.broken.value, hidden: n.hidden, knocked: n.npcs.filter((x) => x.active && x.st === 10).length, hits: n.debug.hits, ragdolls: n.debug.ragdolls, active: n.npcs.filter((x) => x.active).length });`;
  await say('fly', 'return gca.do("rec on; fly jumbo target concert in 12")');
  await h.wait(1500);
  await say('approach', 'return gca.state()');
  await h.shot('01-approach');
  await h.wait(8000);
  await say('just before', 'return gca.state()');
  await h.shot('02-before');
  await h.wait(3500);
  await say('impact', counts);
  await h.shot('03-impact');
  await h.wait(2500);
  await say('after', counts);
  await say('state', 'return gca.state()');
  await h.shot('04-after');
}
