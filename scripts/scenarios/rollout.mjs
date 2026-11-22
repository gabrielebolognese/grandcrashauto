// Regression: board the parked plane, full-throttle ground roll — must not register any crash/impact.
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`window.__imp = []; g.ctx.events.on('planeImpact', (e) => window.__imp.push(e.outcome ?? e.kind ?? 'impact'));
    g.ctx.planes.takeOff?.();`);
  await h.wait(4000);
  await h.game(`window.__crashedAfterTakeoff = g.ctx.planes.crashed;`);
  const out = [];
  for (let i = 0; i < 5; i++) {
    await h.wait(3000);
    out.push(await h.game(`const p = g.ctx.planes; return { crashed: p.crashed, pieces: g.ctx.breakup.pieces.length, agl: Math.round(p.state.altitudeAgl), kmh: Math.round(p.state.airspeedKmh), imp: window.__imp.join(',') };`));
  }
  console.error('[rollout] ' + JSON.stringify(out));
}
