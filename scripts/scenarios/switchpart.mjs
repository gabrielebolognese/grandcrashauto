// Explode middle, then cycle the camera between the halves.
export default async function (page, h) {
  await h.wait(2500);
  await h.game('g.ctx.planes.explodeMiddle()');
  await h.wait(1500);
  const out = [];
  const snap = (l) => h.game(`const p = g.ctx.planes; return { l: ${JSON.stringify(l)}, can: !!p.canCycleTarget, big: p.bigPieces?.().length ?? -1, target: p.cameraTarget?.object?.uuid?.slice(0, 6) ?? null, btn: document.querySelector('.switch-part-btn')?.classList.contains('visible') ?? false };`);
  out.push(await snap('after split'));
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('KeyV');
    await h.wait(900);
    out.push(await snap('V#' + (i + 1)));
    if (i === 0) await h.shot('switched');
  }
  console.error('[switch] ' + JSON.stringify(out));
}
