// Concert music: unlock audio with a key press, teleport to the concert, read the music debug (volume / distance).
export default async function (page, h) {
  await h.wait(2500);
  await page.mouse.click(400, 300);
  await page.keyboard.press('KeyH');
  await h.wait(800);
  const read = `const a = g.ctx.audio; return { ac: a.ac?.state, c: a.concert ? { ...a.concert.dbg, live: a.concert.live, step: a.concert.step } : null };`;
  console.error('[far] ' + JSON.stringify(await h.game(read)));
  await h.game(`g.ctx.nav.teleport('concert')`);
  await h.wait(4000);
  console.error('[near] ' + JSON.stringify(await h.game(read)));
}
