// Passengers + flight attendants: seated people, engine-blast panic on that side, a split (panic → brace, crew thrown).
export default async function (page, h) {
  await h.wait(2500);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + JSON.stringify(await h.game(js)));
  const info = `const c = g.ctx.walker.people; return { n: c.people.length, shown: c.group?.object.visible,
    modes: c.people.reduce((m, p) => ((m[p.kind + ':' + p.mode] = (m[p.kind + ':' + p.mode] || 0) + 1), m), {}),
    reacting: c.people.filter((p) => p.react).map((p) => p.react).slice(0, 12) };`;
  await h.game('return gca.do("rec on; fly jumbo agl 1500 speed 160; level")');
  await h.wait(2500);
  await h.game('return gca.do("walk")');
  await h.wait(600);
  await say('walking in', info);
  await h.game('return gca.do("hold moveY 1 2.2")'); // walk toward the rear
  await h.wait(2600);
  await h.shot('01-cabin');
  await h.game('return gca.do("view")'); // third person
  await h.wait(600);
  await h.shot('02-cabin-tp');
  await h.game('return gca.do("view")');
  await say('engine 1', 'return gca.do("engine 1")');
  await h.wait(1200);
  await say('after engine', info);
  await h.shot('03-engine-panic');
  await h.wait(3500);
  await h.shot('04-engine-look');
  await say('split', 'return gca.do("split")');
  await h.wait(1500);
  await say('after split', info);
  await h.shot('05-split');
  await h.wait(3000);
  await say('falling', info);
  await h.shot('06-falling');
}
