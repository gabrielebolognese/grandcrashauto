// Menu "Fly now" → tap Jumbo → in the air; walk the cabin (phone controls); then the wings panel.
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`g.game.toMainMenu()`);
  await h.wait(1500);
  await h.shot('01-menu');
  await h.game(`const b = [...document.querySelectorAll('.mm-fly-row button')].find(x => /Jumbo/.test(x.textContent)); b?.click(); return !!b;`);
  await h.wait(2500);
  console.error('[fly] ' + JSON.stringify(await h.game(`return { state: g.game.state, mode: g.game.mode, type: g.ctx.planes.currentType };`)));
  await h.shot('02-flying');
  await h.game(`document.querySelector('.fl-wingbtn')?.click()`);
  await h.wait(500);
  await h.shot('03-wings-panel');
  await h.game(`document.querySelector('.fl-wingbtn')?.click(); g.ctx.walker.start()`);
  await h.wait(1500);
  await h.shot('04-walk-phone');
}
