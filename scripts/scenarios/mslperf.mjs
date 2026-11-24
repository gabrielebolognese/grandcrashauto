// Missile load: particles / draw calls / terrain work during an Octo salvo; your plane frozen in the control room.
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("fly airliner agl 1500 speed 150")');
  await h.wait(2500);
  const st = () => h.game(`const f = g.ctx.fx.debugStats(); const r = g.ctx.engine.renderer.info.render; const P = g.ctx.planes.state.position;
    return JSON.stringify({ main: f.main, glow: f.glow, fires: f.fires, calls: r.calls, tris: r.triangles, terrainMs: +(g.ctx.terrain.uploadMs ?? 0).toFixed(2), plane: [Math.round(P.x), Math.round(P.y), Math.round(P.z)], frozen: !!g.ctx.planes.frozenAt, focus: g.ctx.missiles.focus ? 'turret' : 'player' })`);
  console.log('flying       ', await st());
  console.log(await h.game('return gca.do("shoot nearest from octo all spread")'));
  for (let k = 0; k < 4; k++) {
    await h.wait(1500);
    console.log(`salvo +${(k + 1) * 1.5}s  `, await st());
  }
  await h.shot('01-salvo-cam');
  console.log(await h.game('return gca.do("back")'));
  await h.wait(1500);
  console.log('back (moving)', await st());
}
