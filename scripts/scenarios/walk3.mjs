// Walker: faster walk, head bob + first-person hand, anti-noclip against the walls / bins, thrown around in a spin.
export default async function (page, h) {
  await h.wait(2500);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + JSON.stringify(await h.game(js)));
  const pos = `const w = g.ctx.walker; return { mode: w.mode, p: [w.p.x.toFixed(2), w.p.y.toFixed(2), w.p.z.toFixed(2)], v: Math.hypot(w.v.x, w.v.z).toFixed(2), bobK: w.bobK.toFixed(2), hand: w.hand.root.visible, floating: w.floating };`;
  await h.game('return gca.do("rec on; fly airliner agl 900 speed 150; level")');
  await h.wait(2500);
  await say('walk', 'return gca.do("walk")');
  await h.wait(800);
  await h.game('return gca.do("hold moveY -1 2.5")'); // toward the rear (start faces the rear)
  await h.wait(1200);
  await say('walking', pos);
  await h.shot('01-walking-hand');
  await h.wait(1500);
  await h.game('return gca.do("hold moveX 1 3")');
  await h.wait(2500);
  await say('pushed into the wall', pos);
  await h.shot('02-wall');
  await h.game('return gca.do("hold moveX -1 4")');
  await h.wait(3500);
  await say('other wall', pos);
  await h.shot('03-other-wall');
  await say('spin', 'return gca.do("wing left half; timescale 2")');
  await h.wait(17000);
  await say('in the spin', pos);
  await h.shot('04-spin');
  await h.wait(4000);
  await say('later', pos);
  await h.shot('05-spin2');
}
