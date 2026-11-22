// Memory plateau over a long inland drive: teleports the car in steps along a 25+ km line (north-east), logging
// renderer memory, physics colliders, JS heap and terrain stats.
//   node scripts/smoke.mjs --tag terrain-mem --script src/terrain/smoke/plateau.mjs
// env PLATEAU_STEPS (default 140), PLATEAU_STEP_M (default 190), PLATEAU_WAIT_MS (default 1400)
export default async function (page, h) {
  const steps = Number(process.env.PLATEAU_STEPS || 140);
  const stepM = Number(process.env.PLATEAU_STEP_M || 190);
  const waitMs = Number(process.env.PLATEAU_WAIT_MS || 1400);
  await h.wait(1500);
  if (!process.env.PLATEAU_NO_DET) {
    // determinism across a page reload (main thread vs 2 workers, then again after reload)
    const a = await h.game(`return window.__terrain.debugDeterminism();`);
    await page.reload();
    await page.waitForFunction(() => { const s = window.__game?.game?.state; return s && s !== 'boot'; }, null, { timeout: 120000 });
    await h.wait(1500);
    const b = await h.game(`return window.__terrain.debugDeterminism();`);
    const same = JSON.stringify(a) === JSON.stringify(b) && [a.chunk, a.tile, a.scatter].every((l) => l.every((x) => x === l[0]));
    console.error('[det]', JSON.stringify(a), 'reload:', JSON.stringify(b), 'identical:', same);
  }
  const log = [];
  const t0 = Date.now();
  for (let k = 0; k <= steps; k++) {
    const r = await h.game(`
      const c = g.ctx, o = c.origin.offset;
      const ax = 600 + ${k} * ${stepM} * 0.62, az = -600 - ${k} * ${stepM} * 0.78;
      const lx = ax - o.x, lz = az - o.z;
      const y = c.terrain.heightAt(lx, lz) + 1.5;
      c.vehicle.reset({ position: { x: lx, y, z: lz }, yaw: Math.PI * 0.8 });
      c.cameraRig.snap();
      const m = c.engine.renderer.info.memory;
      const t = window.__terrain ? window.__terrain.debugStats() : null;
      return {
        k: ${k}, ax: Math.round(ax), az: Math.round(az), off: [o.x, o.z], shifts: c.origin.shifts,
        geo: m.geometries, tex: m.textures, colliders: c.physics.world.colliders.len(), bodies: c.physics.world.bodies.len(),
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
        calls: c.engine.stats.calls, tris: c.engine.stats.triangles, fps: +c.engine.stats.fps.toFixed(1),
        tiles: t && t.tiles.slotsUsed, tileRecs: t && t.tiles.tiles, holes: t && t.tiles.holes, tcol: t && t.colliders.colliders,
        chunks: t && t.colliders.chunks, sch: t && t.scatter.chunks, inst: t && t.scatter.instances, str: t && t.scatter.structures,
        pend: t && t.pool.pending, done: t && t.pool.done, msAvg: t && t.updateMsAvg, msMax: t && t.updateMsMax,
      };
    `);
    log.push(r);
    if (k % 10 === 0) console.error('[plateau]', JSON.stringify(r));
    if (k === 0 || k === Math.round(steps / 2) || k === steps) await h.shot('plateau-' + k);
    await h.wait(waitMs);
  }
  const first = log[Math.min(15, log.length - 1)], last = log[log.length - 1];
  console.error('[plateau] summary', JSON.stringify({ seconds: Math.round((Date.now() - t0) / 1000), km: +((steps * stepM) / 1000).toFixed(1), first, last }));
}
