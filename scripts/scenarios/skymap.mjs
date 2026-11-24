// The map: sky planes drawn and selectable, the plane card (SHOOT / RAM / NUKE), the site list, into the control room.
export default async function (page, h) {
  await h.wait(5000);
  await page.keyboard.press('KeyN');
  await h.wait(1500);
  await h.game('const m = g.ctx.nav.map; m.renderer.view.ppm = 0.035; m.markDirty(); return 1');
  await h.wait(800);
  await h.shot('01-map-sky');
  const id = await h.game('return g.ctx.missiles.sky.find((p) => !p.hit)?.id');
  await h.game(`g.ctx.nav.map.selectSky(${id}); return 1`);
  await h.wait(800);
  await h.shot('02-plane-card');
  await h.game(`document.querySelector('.nm-sky-b button').click(); return 1`);
  await h.wait(800);
  await h.shot('03-sites');
  await h.game(`document.querySelector('.nm-sky-b .nm-site:not([disabled])').click(); return 1`);
  await h.wait(1500);
  console.log('controlling', await h.game('return g.ctx.missiles.controlling'), 'places', await h.game("return g.ctx.nav.pois.filter((p) => p.id.startsWith('sam') || p.id.startsWith('silo')).map((p) => p.name).join(' | ')"));
  await h.shot('04-control');
}
