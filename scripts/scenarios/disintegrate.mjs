// One-piece-at-a-time fire disintegration. ?mode=engines (blow all engines) or mode=tail. Logs each break moment.
export default async function (page, h) {
  await h.wait(3000);
  const mode = new URL(page.url()).searchParams.get('mode') || 'engines';
  await h.game(`
    const p = g.ctx.planes; const b = p.body; const t = b.translation(); b.setTranslation({ x: t.x, y: t.y + 2500, z: t.z }, true);
    window.__ex = []; g.ctx.events.on('planeExplosion', (e) => window.__ex.push(e.kind));
    window.__brk = []; const t0 = performance.now(); let last = -1;
    setTimeout(() => {
      if (${JSON.stringify(mode)} === 'tail') p.explodeTail(); else { p.explodeEngine(1); for (let k = 0; k < 12; k++) p.explodeEngine(1); /* re-presses = fire points */ }
      window.__ex = [];
      setInterval(() => { const n = p.breakCount ?? 0; if (n !== last) { last = n; window.__brk.push({ s: +((performance.now() - t0) / 1000).toFixed(1), breaks: n, pieces: g.ctx.breakup.pieces.length, stage: p.engulfStage }); } }, 100);
    }, 300);
  `);
  for (let i = 0; i < 20; i++) {
    await h.wait(3000);
    const done = await h.game('return g.ctx.planes.engulfStage >= 3 || g.ctx.planes.wreckImpact');
    if (i === 8) await h.shot('disint-mid');
    if (done) break;
  }
  await h.shot('disint-end');
  console.error('[disint] ' + JSON.stringify(await h.game('return { breaks: window.__brk, explosions: window.__ex.join(",") || "none", impact: g.ctx.planes.wreckImpact }')));
}
