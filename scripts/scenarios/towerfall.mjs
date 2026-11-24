// A tower coming down, seen from a slow plane: hit at 60 % of its height, the top topples.
export default async function (page, h) {
  await h.wait(3000);
  await h.game('return gca.do("rec on; day; weather clear; fly prop agl 70 speed 40 at 3400 -380 heading n; alt 70")');
  await h.wait(3000);
  await h.game(`const T = g.ctx.towers, t = T.list.find((x) => x.def.id === 'tower-moon'); const V = g.ctx.engine.camera.position.constructor;
    T.collapse(t, new V(t.base.x, t.base.y + t.height * 0.6, t.base.z + 2), new V(0, 0, -45), 0.6); return 1`);
  for (const [k, ms] of [[1, 600], [2, 1200], [3, 1500], [4, 2500]]) {
    await h.wait(ms);
    await h.shot(`0${k}-fall`);
  }
}
