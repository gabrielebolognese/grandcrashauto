// Concert seen from a plane: static crowds stay visible while flying high (dynamic peds hidden), no errors.
export default async function (page, h) {
  await h.wait(3000);
  // teleport the plane high above the concert
  await h.game(`const c = g.ctx.world.data.concert; const p = g.ctx.planes; const b = p.body;
    if (b) { b.setTranslation({ x: c.stage.x + 260, y: 160, z: c.stage.z }, true); }`);
  await h.wait(3500);
  const r = await h.game(`const n = g.ctx.npcs; return { hidden: n.debug.hidden, agl: g.ctx.planes.state?.altitudeAgl, bigOn: n.crowd.materializedBig, mesh: n.crowd.meshes.map(m => m.count), rootVis: n.crowd.root.visible };`);
  console.error('[air] ' + JSON.stringify(r));
  await h.shot('air');
}
