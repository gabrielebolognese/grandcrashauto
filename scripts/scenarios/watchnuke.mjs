// New missile exhaust (flame + smoke ribbon), the missile centred in the control room, WATCH IT (distance kept, camera
// on the plane) and a nuke while watching: your camera stays on your plane (no cut to the plane that gets hit).
export default async function (page, h) {
  const night = !!process.env.WN_NIGHT;
  await h.wait(3000);
  await h.game(`return gca.do("panel off; ${night ? 'night' : 'day'}; weather clear; fly jumbo agl 1700 speed 170")`);
  await h.wait(2500);
  // ── control room: fire one, the missile in the centre, flame + ribbon ── (WN_SKIPCR=1 skips it)
  if (!process.env.WN_SKIPCR) {
  console.log(await h.game('return gca.do("shoot nearest from quad")'));
  const centre = () => h.game(`const M = g.ctx.missiles, m = M.control?.first; if (!m || m.done) return 'no missile';
    const p = m.obj.position.clone().project(g.ctx.engine.camera); return 'missile on screen at ' + p.x.toFixed(3) + ',' + p.y.toFixed(3) + ' (0,0 = centre) · cam ' + Math.round(g.ctx.engine.camera.position.distanceTo(m.obj.position)) + ' m';`);
  for (const [ms, name] of [[700, 'ex-01'], [1500, 'ex-02'], [2500, 'ex-03']]) {
    await h.wait(ms === 700 ? 700 : 900);
    console.log(name, await centre());
    await h.shot(name);
  }
  for (let k = 0; k < 40 && (await h.game('return g.ctx.missiles.control?.phase ?? "-"')) !== 'impact'; k++) await h.wait(500);
  await h.wait(1500);
  // the replay: ribbons drawn as they were
  await h.game('g.ctx.replay.start(); return 1');
  await h.wait(2200);
  console.log('replay', await h.game('const R = g.ctx.replay; return R.camName + " · smoke ribbons visible: " + g.ctx.engine.scene.children.filter((o) => o.name === "missile-smoke" && o.visible).length'));
  await h.shot('ex-04-replay');
  await h.game('g.ctx.replay.stop(); g.ctx.missiles.exitControl(); return 1');
  await h.wait(1500);
  }
  // ── WATCH IT ──
  const tgt = await h.game(`const M = g.ctx.missiles; const me = g.ctx.planes.state.position; let best = null, bd = 1e9;
    for (const p of M.traffic.planes) { const d = p.pos.distanceTo(me); if (!p.hit && d < bd && d > 1500) { bd = d; best = p; } } return best ? best.id : -1;`);
  console.log('watch', await h.game(`return gca.do("watch ${tgt}")`));
  const dist = () => h.game(`const M = g.ctx.missiles; const p = M.traffic.planes.find((x) => x.id === ${tgt}); const me = g.ctx.planes.state.position;
    return p ? Math.round(p.pos.distanceTo(me)) + ' m (R ' + Math.round(M.watchR) + ', move out ' + Math.round(M.watchLat) + ' m, forward ' + Math.round(M.watchAlong) + ' m' + ') · ' + Math.round(g.ctx.planes.state.airspeedKmh) + ' km/h · hdg ' + Math.round(g.ctx.planes.state.heading) + ' vs ' + Math.round(((Math.atan2(p.vel.x, -p.vel.z) * 180 / Math.PI) + 360) % 360) + ' · cam ' + g.ctx.cameraRig.view + (p.hit ? ' · HIT' : '') + (g.ctx.planes.crashed ? ' · YOU CRASHED' : '') : 'gone';`);
  const onScreen = () => h.game(`const M = g.ctx.missiles; const p = M.traffic.planes.find((x) => x.id === ${tgt}); if (!p) return '-'; const v = p.pos.clone().project(g.ctx.engine.camera);
    return 'watched plane on screen at ' + v.x.toFixed(2) + ',' + v.y.toFixed(2) + (Math.abs(v.x) < 1 && Math.abs(v.y) < 1 && v.z < 1 ? ' (in frame)' : ' (OUT of frame)');`);
  for (let i = 0; i < 8; i++) {
    await h.wait(2500);
    console.log('t+' + (i + 1) * 2.5, await dist(), '·', await onScreen());
  }
  await h.shot('wn-01-watching');
  // nuke it while watching
  console.log('nuke', await h.game(`return gca.do("nuke ${tgt}")`));
  let hit = false;
  for (let k = 0; k < 70 && !hit; k++) {
    await h.wait(1000);
    hit = await h.game(`return !!g.ctx.missiles.traffic.planes.find((x) => x.id === ${tgt})?.hit`);
    if (k % 5 === 0) console.log('  nuke flying', await dist());
  }
  console.log('hit', hit, await dist(), '·', await onScreen());
  await h.wait(400);
  await h.shot('wn-02-blast');
  await h.wait(2500);
  console.log('after', await dist(), '·', await onScreen());
  await h.shot('wn-03-after');
  await h.wait(4000);
  console.log('after+', await dist());
  await h.shot('wn-04-after');
  console.log('stop', await h.game('return gca.do("watch off")'));
}
