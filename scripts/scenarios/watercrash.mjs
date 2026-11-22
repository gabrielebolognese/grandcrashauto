// Dive an airliner into the sea: expect breakup + fire, NO planeExplosion events, pieces sinking deep.
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`
    window.__ex = 0; window.__exk = []; g.ctx.events.on('planeExplosion', (e) => { window.__ex++; window.__exk.push(e.kind + '@' + Math.round(e.position.y)); });
    const p = g.ctx.planes; const b = p.body;
    b.setTranslation({ x: 0, y: 160, z: 1300 }, true);
    b.setLinvel({ x: 0, y: -70, z: 90 }, true);
  `);
  const log = [];
  for (let i = 0; i < 14; i++) {
    await h.wait(2000);
    const s = await h.game(`const bk = g.ctx.breakup; const ys = bk.pieces.map(pc => pc.body.translation().y); return { t: ${(i + 1) * 2}, explosions: window.__ex, kinds: window.__exk.join(','), crashed: g.ctx.planes.crashed, pieces: bk.pieces.length, minY: ys.length ? Math.round(Math.min(...ys)) : null, maxY: ys.length ? Math.round(Math.max(...ys)) : null };`);
    log.push(s);
    if (i === 1) await h.shot('water-impact');
    if (i === 5) await h.shot('water-sinking');
  }
  console.error('[water] ' + JSON.stringify(log));
}
