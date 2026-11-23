// Cockpit view through a split (LOD fix) → replay telephoto cams → wing break FAR (flyable) → wing break HALF (spin in 30 s).
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`g.game.quickFly('airliner')`);
  await h.wait(1200);
  await page.keyboard.press('KeyC');
  await h.wait(500);
  await page.keyboard.press('KeyM');
  await h.wait(1500);
  await h.shot('01-cockpit-after-split');
  for (let i = 0; i < 20; i++) { await h.wait(1000); if (await h.game(`return g.ctx.planes.crashed && !g.ctx.planes.cameraTarget?.velocity`)) break; }
  await h.wait(2000);
  await h.game(`g.ctx.replay.start()`);
  const rp = `return { cam: g.ctx.replay.camName, sp: +g.ctx.replay.speed.toFixed(2), fov: +g.ctx.engine.camera.fov.toFixed(1) };`;
  for (let k = 0; k < 4; k++) {
    await page.keyboard.press('KeyV');
    await h.wait(900);
    const r = await h.game(rp);
    console.error('[replay] ' + JSON.stringify(r));
    if (r.cam === 'Ground' || r.cam === 'Flyby') await h.shot('02-replay-' + r.cam);
  }
  await h.game(`g.ctx.replay.stop()`);
  const att = `const p = g.ctx.planes, s = p.state, b = p.body; const w = b ? b.angvel() : { x: 0, y: 0, z: 0 };
    return { bank: Math.round(s.bank), pitch: Math.round(s.pitch), agl: Math.round(s.altitudeAgl), vs: +s.verticalSpeed.toFixed(1), kmh: Math.round(s.airspeedKmh), w: +Math.hypot(w.x, w.y, w.z).toFixed(2), crashed: p.crashed, fail: p.wingFailure };`;
  // FAR: tip off, hands off — should stay flyable
  await h.game(`g.game.quickFly('airliner')`);
  await h.wait(1500);
  await h.game(`g.ctx.planes.breakWing('L', 'far')`);
  for (let i = 0; i < 8; i++) {
    await h.wait(1000);
    console.error('[far ' + i + '] ' + JSON.stringify(await h.game(att)));
    if (i === 3) await h.shot('03-far');
  }
  // HALF: spin within 30 s
  await h.game(`g.game.quickFly('airliner')`);
  await h.wait(1200);
  await h.game(`const p = g.ctx.planes; const b = p.body; const t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 1500, z: t.z }, true); p.breakWing('R', 'half')`);
  for (let i = 0; i < 17; i++) {
    await h.wait(2000);
    console.error('[half ' + (i * 2 + 2) + 's] ' + JSON.stringify(await h.game(att)));
    if (i === 4) await h.shot('04-half-10s');
    if (i === 16) await h.shot('05-half-spin');
  }
}
