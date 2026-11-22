// 747 tail off at altitude: fire builds from the back, airframe slowly comes apart, NO explosion.
export default async function (page, h) {
  await h.wait(3000);
  await h.game(`
    window.__ex = []; g.ctx.events.on('planeExplosion', (e) => window.__ex.push(e.kind));
    const b = g.ctx.planes.body; const t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 1500, z: t.z }, true);
  `);
  await h.wait(500);
  await h.game('g.ctx.planes.explodeTail(); window.__ex = [];');
  const log = [];
  let shot = 0;
  for (let i = 0; i < 18; i++) {
    await h.wait(2500);
    const s = await h.game(`const p = g.ctx.planes; return { t: ${(i + 1) * 2.5}, engulf: +(p.engulf ?? 0).toFixed(2), stage: p.engulfStage, pieces: g.ctx.breakup.pieces.length, crashed: p.crashed, agl: Math.round(p.state.altitudeAgl), ex: window.__ex.join(',') };`);
    log.push(s);
    if (shot === 0 && s.stage >= 1) { await h.shot('tail-stage1'); shot = 1; }
    if (shot === 1 && s.stage >= 2) { await h.wait(1200); await h.shot('tail-stage2'); shot = 2; }
    if (shot === 2 && s.stage >= 3) { await h.wait(1200); await h.shot('tail-stage3'); shot = 3; }
    if (shot === 3 && s.agl < 5) break;
  }
  console.error('[tail] ' + JSON.stringify(log));
}
