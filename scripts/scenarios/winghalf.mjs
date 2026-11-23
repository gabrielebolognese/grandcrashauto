// Wing break HALF: progressively uncontrollable over 30 s, then stall + spin (hands off, from high up).
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`g.game.quickFly('airliner')`);
  await h.wait(1200);
  const att = `const p = g.ctx.planes, s = p.state, b = p.body; const w = b ? b.angvel() : { x: 0, y: 0, z: 0 };
    return { bank: Math.round(s.bank), pitch: Math.round(s.pitch), agl: Math.round(s.altitudeAgl), vs: +s.verticalSpeed.toFixed(1), w: +Math.hypot(w.x, w.y, w.z).toFixed(2), crashed: p.crashed, t: +(p.wingFailure?.t ?? 0).toFixed(1) };`;
  await h.game(`const p = g.ctx.planes; const b = p.body; const t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 2200, z: t.z }, true); p.breakWing('R', 'half')`);
  for (let i = 0; i < 19; i++) {
    await h.wait(2000);
    console.error('[half ' + (i * 2 + 2) + 's] ' + JSON.stringify(await h.game(att)));
    if (i === 6) await h.shot('half-14s');
    if (i === 16) await h.shot('half-spin');
  }
}
