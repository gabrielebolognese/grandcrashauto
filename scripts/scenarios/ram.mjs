// Ram autopilot: your plane flies into a sky plane (debug readout every 2 s).
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("fly jumbo agl 1700 speed 170")');
  await h.wait(2000);
  const rid = await h.game(`const M = g.ctx.missiles; const me = g.ctx.planes.state.position; let best = null, bd = 1e9; for (const p of M.traffic.planes) { const d = p.pos.distanceTo(me); if (!p.hit && d < bd) { bd = d; best = p.id; } } return best;`);
  console.log(await h.game(`return gca.do("ram ${rid}")`));
  for (let k = 0; k < 14; k++) {
    await h.wait(2000);
    const r = await h.game(`const P = g.ctx.planes; const s = P.state; const p = s.position; const T = g.ctx.missiles.traffic;
      const q = T.planes.find((x) => x.id === ${rid});
      return JSON.stringify({ d: q ? Math.round(q.pos.distanceTo(p)) : -1, hdg: Math.round(s.heading), bank: Math.round(s.bank), hit: q?.hit, crashed: P.crashed,
        tgt: q ? { v: [Math.round(q.vel.x), Math.round(q.vel.z)], yaw: Math.round(q.yaw * 57.3), near: q.ramNear, speed: Math.round(q.speed) } : null,
        me: [Math.round(p.x), Math.round(p.z)], from: [Math.round(T.ramFrom.x), Math.round(T.ramFrom.z)], ramId: T.ramId });`);
    console.log(r);
    if (r.includes('"hit":true')) break;
  }
}
