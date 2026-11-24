// Agent shots with the turret names: octo salvo (spread), then the nuke turret.
export default async function (page, h) {
  await h.wait(3000);
  console.log(await h.game('return gca.do("sites")'));
  console.log(await h.game('return gca.do("shoot nearest from octo all spread")'));
  await h.wait(10000);
  console.log('hits', await h.game('return JSON.stringify(g.ctx.missiles.sky.filter((p) => p.hit).map((p) => p.id))'));
  console.log(await h.game('return gca.do("back; shoot nearest from nuke")'));
  await h.wait(16000);
  console.log('hits', await h.game('return JSON.stringify(g.ctx.missiles.sky.filter((p) => p.hit).map((p) => p.id))'));
  await h.shot('01-after-nuke');
}
