// Control-room camera (behind the rack) + "shoot nearest" + nuke at a place.
export default async function (page, h) {
  await h.wait(3000);
  const id = await h.game('return g.ctx.missiles.sky.find((p) => !p.hit)?.id');
  console.log(await h.game(`return g.ctx.missiles.enterControl('sam-pass', ${id}) || 'in control'`));
  await h.wait(1500);
  await h.shot('01-rack-view');
  console.log(await h.game('return gca.do("back; shoot nearest from titan aim nose")'));
  await h.wait(1500);
  await h.shot('02-titan');
  await h.wait(9000);
  console.log(await h.game('return JSON.stringify(g.ctx.missiles.sky.filter((p) => p.hit).map((p) => p.id))'));
  console.log(await h.game('return gca.do("back; nuke beach")'));
}
