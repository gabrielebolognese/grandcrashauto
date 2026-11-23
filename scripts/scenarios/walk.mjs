// Walk the cabin: quick fly → stand up → walk aft → window seat → 3rd person → switch plane → split while standing.
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`g.game.quickFly('airliner')`);
  await h.wait(2500);
  await h.shot('01-quickfly');
  const st = `const w = g.ctx.walker; const r = (v) => v ? [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)] : null;
    return { mode: w.mode, p: r(w.p), wp: r(w.wp), sec: w.sec, seat: w.seat, fp: w.firstPerson, chain: w.chain, g: r(w.gApp), fv: +w.frameVel.length().toFixed(1), planeType: g.ctx.planes.currentType, split: !g.ctx.planes.currentTracked?.body };`;
  console.error('[start] ' + JSON.stringify(await h.game(`const ok = g.ctx.walker.start(); return ok;`)));
  await h.wait(1200);
  console.error('[cabin] ' + JSON.stringify(await h.game(st)));
  await h.shot('02-cabin-fp');
  await page.keyboard.down('KeyW');
  await h.wait(2500);
  await page.keyboard.up('KeyW');
  console.error('[walked] ' + JSON.stringify(await h.game(st)));
  await page.keyboard.press('KeyQ');
  await h.wait(1200);
  console.error('[window] ' + JSON.stringify(await h.game(st)));
  await h.shot('03-window');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyC');
  await h.wait(800);
  await h.shot('04-third-person');
  // mid-air switch (walker stops), then walk again in the jumbo
  await h.game(`g.ctx.planes.switchType('jumbo')`);
  await h.wait(2000);
  await h.shot('05-switched-jumbo');
  await h.game(`g.ctx.walker.start()`);
  await page.keyboard.down('KeyW');
  await h.wait(3000);
  await page.keyboard.up('KeyW');
  console.error('[jumbo] ' + JSON.stringify(await h.game(st)));
  await h.shot('06-jumbo-cabin');
  // split while standing in the aisle (third person to see)
  await page.keyboard.press('KeyM');
  for (let i = 0; i < 12; i++) {
    await h.wait(700);
    console.error('[split ' + i + '] ' + JSON.stringify(await h.game(st)));
    if (i === 1) await h.shot('07-split');
    if (i === 6) await h.shot('08-after');
  }
  await h.wait(4000);
  console.error('[end] ' + JSON.stringify(await h.game(st)));
  await h.shot('09-end');
}
