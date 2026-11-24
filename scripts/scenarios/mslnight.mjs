// Night: missiles glow (exhaust flare), seen from the turret and from the missile cam; AUTO LOCK.
export default async function (page, h) {
  await h.wait(3000);
  const id = await h.game('return g.ctx.missiles.sky.find((p) => !p.hit)?.id');
  await h.game(`gca.do("night"); return g.ctx.missiles.enterControl('aa-peak', ${id})`);
  await h.wait(1200);
  console.log('lock', await h.game('return g.ctx.missiles.autoLock()'));
  await page.keyboard.press('Space'); // ALL
  await h.wait(900);
  await h.game('const c = g.ctx.missiles.control; c.phase = "aim"; c.first = null; return 1'); // look from the turret
  await h.wait(600);
  await h.shot('01-night-turret');
  await h.wait(1500);
  await h.shot('02-night-turret2');
}
