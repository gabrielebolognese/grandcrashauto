// Triangle cost per top-level scene object (hide → render → delta).
export default async function (page, h) {
  await h.wait(4000);
  const res = await h.game(`
    const e = g.ctx.engine, r = e.renderer, sc = e.scene;
    const render = () => { r.info.reset(); r.render(sc, e.camera); return r.info.render.triangles; };
    const total = render();
    const rows = [];
    for (const ch of sc.children) {
      if (!ch.visible) continue;
      ch.visible = false; const t = render(); ch.visible = true;
      const d = total - t;
      if (d > 2000) rows.push([ch.name || ch.type + ':' + (ch.children[0]?.name || ch.children.length), d]);
    }
    rows.sort((a, b) => b[1] - a[1]);
    return { total, rows: rows.slice(0, 14) };
  `);
  console.error('[tris] ' + JSON.stringify(res));
}
