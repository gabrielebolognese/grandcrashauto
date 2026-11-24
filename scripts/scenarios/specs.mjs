// Spectator cameras + ram replay: ram a sky plane, HIT PLANE CAM, the replay's 'Hit plane' pass; then a nuke + NUKE CAM.
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("rec on; day; weather clear; fly jumbo agl 1700 speed 170")');
  await h.wait(2000);
  const rid = await h.game(`const M = g.ctx.missiles; const me = g.ctx.planes.state.position; let best = null, bd = 1e9; for (const p of M.traffic.planes) { const d = p.pos.distanceTo(me); if (!p.hit && d < bd) { bd = d; best = p.id; } } return best;`);
  console.log(await h.game(`return gca.do("ram ${rid}")`));
  let hit = false;
  for (let k = 0; k < 30 && !hit; k++) {
    await h.wait(1500);
    hit = await h.game(`const q = g.ctx.missiles.traffic.planes.find((x) => x.id === ${rid}); if (k % 3 === 0) console.log("d", q ? Math.round(q.pos.distanceTo(g.ctx.planes.state.position)) : -1, Math.round(g.ctx.planes.state.airspeedKmh)); return !!q?.hit`.replace("k % 3", String(k) + " % 3"));
  }
  console.log('hit', hit, 'bar:', await h.game('return document.querySelector(".msl-spec")?.className + " " + document.querySelector(".msl-spec")?.textContent'));
  await h.wait(1000);
  console.log(await h.game('return gca.do("watch hit")'));
  await h.wait(1500);
  await h.shot('01-hitcam');
  await h.wait(3000);
  await h.shot('02-hitcam');
  console.log('bar:', await h.game('return document.querySelector(".msl-spec")?.textContent'));
  console.log(await h.game('return gca.do("watch off")'));
  await h.wait(500);
  console.log(await h.game('return gca.do("replay")'), await h.game('return g.ctx.replay.shots?.join(",")'));
  for (let i = 0; i < 6; i++) {
    const name = await h.game('return g.ctx.replay.camName');
    if (name === 'Hit plane') break;
    await h.game('g.ctx.replay.nextCam(); return 1');
    await h.wait(300);
  }
  await h.wait(1500);
  await h.shot('03-replay-hitplane');
  console.log('bar in replay:', await h.game('return getComputedStyle(document.querySelector(".msl-spec")).display'));
  await h.wait(2500);
  await h.shot('04-replay-hitplane');
  await h.game('g.ctx.replay.nextCam(); return 1'); // back to a pass on your plane: both planes
  await h.game('g.ctx.replay.restart?.(); return 1');
  await h.wait(200);
  console.log('cam', await h.game('return g.ctx.replay.camName'));
  await h.game('g.ctx.replay.stop(); return 1');
}
