// Explode → Reset N times and compare memory/physics counters (SPEC §4 / §16).
// node scripts/smoke.mjs --tag leak --script scripts/scenarios/leak.mjs
export default async function (page, h) {
  const N = Number(process.env.LEAK_N || 50);
  const snap = () =>
    h.game(`
      const c = g.ctx, m = c.engine.renderer.info.memory;
      return { geo: m.geometries, tex: m.textures, bodies: c.physics.world.bodies.len(), colliders: c.physics.world.colliders.len(),
               sceneChildren: c.engine.scene.children.length, heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1e6) : null };
    `);
  await h.hold('KeyW', 1500);
  // warm-up cycle so lazily created pools exist before the baseline
  await h.game('g.game.explodeOrReset()');
  await h.wait(900);
  await h.game('g.game.requestReset()');
  await h.wait(900);
  const before = await snap();
  for (let i = 0; i < N; i++) {
    await h.game('g.game.explodeOrReset()');
    await h.wait(450);
    await h.game('g.game.requestReset()');
    await h.wait(650);
    if ((i + 1) % 25 === 0) console.error('[leak] after ' + (i + 1) + ' ' + JSON.stringify(await snap()));
  }
  await h.wait(500);
  const after = await snap();
  await h.shot('after-leak');
  console.error('[leak] before', JSON.stringify(before));
  console.error('[leak] after ', JSON.stringify(after));
  await h.game(`window.__leak = ${JSON.stringify({ before, after })}`);
}
