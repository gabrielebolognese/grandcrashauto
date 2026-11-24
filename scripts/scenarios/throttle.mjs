// Throttle check (normal mode): quick-fly each plane, full power, then idle; log throttle + airspeed + altitude.
export default async function (page, h) {
  await h.wait(3000);
  const st = () => h.game('const s = g.ctx.planes.state; return `thr ${Math.round(s.throttle * 100)}% ${Math.round(s.airspeedKmh)} km/h alt ${Math.round(s.altitude)} ${g.ctx.planes.crashed ? "CRASHED" : ""}`');
  for (const type of ['jumbo', 'airliner', 'prop']) {
    await h.game(`g.ctx.planes.quickFly('${type}'); return 1`);
    await h.wait(2000);
    const line = [type, 'start', await st()];
    await h.wait(4000);
    line.push('| cruise +4s', await st());
    await h.hold('ShiftLeft', 2000);
    for (let i = 0; i < 4; i++) {
      await h.wait(5000);
      line.push(`| full +${(i + 1) * 5}s`, await st());
    }
    await h.hold('Minus', 2500);
    for (let i = 0; i < 3; i++) {
      await h.wait(5000);
      line.push(`| idle +${(i + 1) * 5}s`, await st());
    }
    console.log(line.join(' '));
  }
}
