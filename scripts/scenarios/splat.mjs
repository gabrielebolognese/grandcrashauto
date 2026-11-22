// Split an airliner at 1.2 km over land: each half should explode + shatter on impact, scaled by its speed.
export default async function (page, h) {
  await h.wait(3000);
  await h.game(`const p = g.ctx.planes; const b = p.body; const X = 1400, Z = -1600; let gy = 0; try { gy = g.ctx.world.groundHeightAt(X, Z); } catch {}
    b.setTranslation({ x: X, y: gy + 1200, z: Z }, true); b.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true); b.setLinvel({ x: 130, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const bk = g.ctx.breakup; window.__dbg = { hi: [], smash: 0, splat: 0, pc: 0 };
    const wrap = (name, fn) => { const o = bk[name].bind(bk); bk[name] = (...a) => { fn(a); return o(...a); }; };
    wrap('handleImpact', (a) => { if (window.__dbg.hi.length < 12) window.__dbg.hi.push({ vn: Math.round(a[6]), surf: a[8], tracked: a[1].tracked }); });
    wrap('smash', () => window.__dbg.smash++); wrap('splat', () => window.__dbg.splat++); wrap('processContact', () => window.__dbg.pc++);
    window.__ex = []; g.ctx.events.on('planeExplosion', (e) => window.__ex.push({ kind: e.kind, r: Math.round(e.radius), t: +(performance.now() / 1000).toFixed(1) }));`);
  await h.wait(400);
  await h.game('g.ctx.planes.explodeMiddle(); window.__ex = [];');
  let shots = 0, seen = 0;
  const log = [];
  for (let i = 0; i < 120 && shots < 3; i++) {
    await h.wait(300);
    const s = await h.game(`return { n: window.__ex.length, pieces: g.ctx.breakup.pieces.length };`);
    if (s.n > seen) { seen = s.n; await h.wait(250); await h.shot('splat-' + (++shots)); log.push(s); }
  }
  await h.wait(3000);
  const fin = await h.game(`return { ex: window.__ex, pieces: g.ctx.breakup.pieces.length, dbg: window.__dbg, ign: g.ctx.breakup.planes?.[0]?.ignited }`);
  console.error('[splat] ' + JSON.stringify({ atShots: log, final: fin }));
}
