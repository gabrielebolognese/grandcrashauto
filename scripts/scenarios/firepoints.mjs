// Fire points: engine fires alone never escalate; re-pressing a burning engine adds points; a burning engine
// falling off resets; enough points → airframe on fire → one-at-a-time disintegration.
export default async function (page, h) {
  await h.wait(3000);
  const st = (l) => h.game(`const p = g.ctx.planes; return { l: ${JSON.stringify(l)}, pts: p.firePoints, meter: document.querySelector('.fire-meter.visible')?.textContent ?? null, stage: p.engulfStage, breaks: p.breakCount, pieces: g.ctx.breakup.pieces.length, eng: p.state.engines.map(e => e.status).join(',') };`);
  const out = [];
  await h.game(`const p = g.ctx.planes; const b = p.body; const t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 2500, z: t.z }, true); p.explodeEngine(1); p.explodeEngine(2);`);
  await h.wait(12000);
  out.push(await st('2 fires, 12 s, no presses'));
  // press a burning engine 3× through the real input path
  const burning = await h.game(`return g.ctx.planes.state.engines.findIndex(e => e.status === 'fire') + 1`);
  for (let i = 0; i < 3; i++) { await h.game(`g.ctx.input.press('engine${burning}')`); await h.wait(250); }
  out.push(await st('3 presses on engine ' + burning));
  await h.shot('fire-points');
  // tear that burning engine off → reset
  await h.game(`const p = g.ctx.planes; g.ctx.breakup.breakJoints(p.tracked, [p.visual.breakModes.engineMount[${burning}]]);`);
  await h.wait(500);
  out.push(await st('burning engine ' + burning + ' fell off'));
  // fan the other burning engine until engulfed
  let other = await h.game(`return g.ctx.planes.state.engines.findIndex(e => e.status === 'fire') + 1`);
  if (!other) { other = await h.game(`const p = g.ctx.planes; const i = p.state.engines.findIndex(e => e.status === 'ok') + 1; p.explodeEngine(i); return i;`); await h.wait(1500); out.push(await st('lit engine ' + other + ' (counts as the first)')); }
  for (let i = 0; i < 10; i++) { await h.game(`g.ctx.input.press('engine${other}')`); await h.wait(250); }
  out.push(await st('10 presses on engine ' + other));
  for (let i = 0; i < 6; i++) { await h.wait(3000); out.push(await st('+' + (i + 1) * 3 + ' s')); }
  console.error('[fire] ' + JSON.stringify(out));
}
