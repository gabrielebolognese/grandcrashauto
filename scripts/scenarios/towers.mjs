// Towers: a look at the medieval and fantasy towers, then a jumbo into the Wizard's Spire.
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("rec on; day; weather clear")');
  const look = async (name, x, z, agl, dist) => {
    await h.game(`return gca.do("fly prop agl ${agl} speed 45 at ${x} ${z + dist} heading n; alt ${agl}")`);
    await h.wait(3500);
    await h.shot(name);
  };
  await look('01-keep', 1050, -800, 30, 200);
  await look('02-watch', 1500, 120, 25, 160);
  await look('03-redroof', 2300, -1700, 35, 210);
  await look('04-wizard', -350, -1500, 60, 300);
  await look('05-crystal', 1800, -3000, 45, 260);
  await look('06-moon', 3400, -900, 70, 380);
  await look('07-sky', 700, -2400, 120, 700);
  console.log(await h.game('return gca.do("places")'));
  console.log(await h.game('return gca.do("fly jumbo target wizard in 10")'));
  await h.wait(10500);
  await h.shot('08-impact');
  await h.wait(3000);
  await h.shot('09-collapse');
  console.log('broken', await h.game('return JSON.stringify(g.ctx.towers.list.map((t) => [t.def.id, t.broken, t.segs.filter((s) => s.body.isDynamic()).length]))'));
}
