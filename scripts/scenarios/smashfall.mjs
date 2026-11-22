// Split an airliner high up: the halves must keep accelerating down and smash (no bounce, no long glide).
export default async function (page, h) {
  await h.wait(3000);
  await h.game(`const p = g.ctx.planes; const b = p.body; const t = b.translation();
    let gy = 0; try { gy = g.ctx.world.groundHeightAt(t.x, t.z); } catch {}
    const X = 1400, Z = -1600; try { gy = g.ctx.world.groundHeightAt(X, Z); } catch {}
    b.setTranslation({ x: X, y: gy + 1200, z: Z }, true); b.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 }, true); b.setLinvel({ x: 130, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    window.__wet = () => { try { return g.ctx.terrain?.waterAt?.(X + 130 * 30, Z) ?? null; } catch { return "err"; } };`);
  await h.wait(400);
  await h.game('g.ctx.planes.explodeMiddle()');
  const log = [];
  for (let i = 0; i < 34; i++) {
    await h.wait(1000);
    const s = await h.game(`const ps = [...g.ctx.breakup.pieces].sort((a, b) => b.mass - a.mass).slice(0, 2);
      return ps.map(pc => { const t = pc.body.translation(), v = pc.body.linvel(); let gy = 0; try { gy = g.ctx.world.groundHeightAt(t.x, t.z); } catch {}
        let w = null; try { w = g.ctx.terrain?.waterAt?.(t.x, t.z) ?? null; } catch {} return [Math.round(t.y - gy), Math.round(v.y), Math.round(Math.hypot(v.x, v.z)) + (w !== null ? "W" : "")]; });`);
    log.push(s.map(x => x.join('/')).join(' | '));
    if (i === 3) await h.shot('fall');
    if (s.every(x => x[0] < 30) && !log.shotDone) { log.shotDone = true; await h.shot('smash'); }
  }
  console.error('[smash] agl/vy/vh per second: ' + JSON.stringify(log));
}
