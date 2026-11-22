// Fire escalation: blow both bizjet engines in flight, watch engulf → dismantle → structural failure.
export default async function (page, h) {
  await h.wait(3000);
  await h.game('g.ctx.planes.explodeEngine(1); g.ctx.planes.explodeEngine(2);');
  const log = [];
  let shot1 = false;
  for (let i = 0; i < 16; i++) {
    await h.wait(3000);
    const s = await h.game(`const p = g.ctx.planes; return { t: ${i * 3 + 3}, engulf: +(p.engulf ?? 0).toFixed(2), stage: p.engulfStage, pieces: g.ctx.breakup.pieces.length, split: p.state.damage.split, crashed: p.crashed, agl: Math.round(p.state.altitudeAgl) };`);
    log.push(s);
    if (!shot1 && s.stage >= 1) { await h.shot('engulf-stage1'); shot1 = true; }
    if (s.stage >= 3) { await h.wait(1500); await h.shot('engulf-failure'); break; }
  }
  console.error('[engulf] ' + JSON.stringify(log));
}
