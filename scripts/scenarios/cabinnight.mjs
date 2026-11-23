// Cabin at night: lights on (first + third person), emergency lighting after a split.
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`g.ctx.env.setTime?.(23); g.game.quickFly('jumbo')`);
  await h.wait(2500);
  await h.game(`g.ctx.walker.start()`);
  await h.wait(1500);
  await h.shot('01-night-fp');
  await page.keyboard.press('KeyQ');
  await h.wait(1000);
  await h.shot('02-night-window');
  await page.keyboard.press('KeyQ');
  await page.keyboard.press('KeyC');
  await page.keyboard.down('KeyW');
  await h.wait(1500);
  await page.keyboard.up('KeyW');
  await h.shot('03-night-tp');
  await page.keyboard.press('KeyM');
  await h.wait(1800);
  await h.shot('04-night-split');
}
