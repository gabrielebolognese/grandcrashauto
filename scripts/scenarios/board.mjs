// Park the car in front of each parked plane's nose and check the BOARD candidate.
export default async function (page, h) {
  await h.wait(1500);
  const stands = await h.game(`return (g.ctx.world.data.airport?.stands ?? []).map(s => ({ type: s.type, p: s.p, yaw: s.yaw }));`);
  const len = { prop: 8, bizjet: 18, airliner: 38, jumbo: 70 };
  const out = [];
  for (const s of stands) {
    const L = len[s.type] ?? 30;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    const p = { x: s.p.x + fx * (L / 2 + 4), y: s.p.y + 0.5, z: s.p.z + fz * (L / 2 + 4) };
    await h.game(`g.ctx.vehicle.reset({ position: ${JSON.stringify(p)}, yaw: ${s.yaw + Math.PI} }); g.ctx.cameraRig.snap();`);
    await h.wait(2500);
    const c = await h.game(`return g.ctx.planes.boardCandidate;`);
    out.push({ stand: s.type, candidate: c?.type ?? null });
    await h.shot('board-' + s.type);
  }
  console.error('[board] ' + JSON.stringify(out));
}
