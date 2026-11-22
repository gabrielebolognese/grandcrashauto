// Regression: a gentle touchdown (gear down, -1.5 m/s) must not crash; a 20 m/s belly slam must.
export default async function (page, h) {
  const fb = new URL(page.url()).searchParams.get("fb") !== "0";
  await h.wait(500);
  await h.game("g.CONFIG.breakup.fastHitFallback = " + fb);
  await h.wait(3000);
  const drop = (vy) => h.game(`const p = g.ctx.planes; const b = p.body; const X = 1400, Z = -1600; let gy = 0; try { gy = g.ctx.world.groundHeightAt(X, Z); } catch {}
    b.setTranslation({ x: X, y: gy + 4, z: Z }, true); b.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true);
    b.setLinvel({ x: 62, y: ${vy}, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);`);
  await h.game(`window.__imp = []; g.ctx.events.on('planeImpact', (e) => window.__imp.push(e.outcome ?? 'impact')); g.ctx.events.on('touchdown', (e) => window.__imp.push('touchdown:' + (e.grade ?? e.kind ?? '')));`);
  await h.game("g.ctx.input.press('gear')");
  for (let i = 0; i < 12; i++) { await h.wait(500); if (await h.game("return g.ctx.planes.state.gear > 0.98")) break; }
  await drop(-1.5);
  await h.wait(5000);
  const gentle = await h.game(`return { crashed: g.ctx.planes.crashed, pieces: g.ctx.breakup.pieces.length, ev: window.__imp.join(','), gear: +g.ctx.planes.state.gear.toFixed(2) };`);
  console.error('[touchdown] ' + JSON.stringify({ fb, gentle }));
}
