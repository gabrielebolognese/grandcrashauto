// Plane quick placement: AIRBORNE from standstill, then nudges.
export default async function (page, h) {
  await h.wait(2500);
  const s = (label) => h.game(`const p = g.ctx.planes.state; return { label: ${JSON.stringify(label)}, onGround: p.onGround, kmh: Math.round(p.airspeedKmh), agl: Math.round(p.altitudeAgl), thr: +p.throttle.toFixed(2), airborneBtn: !!document.querySelector('.airborne-btn') && getComputedStyle(document.querySelector('.airborne-btn')).display !== 'none', nudgeBtn: !!document.querySelector('.fl-nudge') && getComputedStyle(document.querySelector('.fl-nudge')).display !== 'none' };`);
  const out = [await s('parked')];
  await h.shot('parked');
  await h.game('g.ctx.planes.takeOff()');
  await h.wait(1500);
  out.push(await s('after takeOff'));
  for (let i = 0; i < 3; i++) await h.game('g.ctx.planes.nudge(100, 0)');
  await h.game('g.ctx.planes.nudge(0, 100)');
  await h.wait(1200);
  out.push(await s('after 3x fwd + 1x up'));
  await h.shot('airborne');
  console.error('[airborne] ' + JSON.stringify(out));
}
