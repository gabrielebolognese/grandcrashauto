// HUD layout check with the REAL HUD (no "rec on"): flying, after a ram (camera bar), HIT PLANE CAM, the crash dock,
// the replay bar. Looks for overlapping buttons (user report: reset vs cam controls, hit cam vs the top panel).
export default async function (page, h) {
  const overlaps = (label) =>
    h.game(`
      const sel = 'button, .msl-spec, .tb-cluster, .speed-card, .fl-top, .replay-bar, .boom-wrap, .fl-nudge, .airborne-btn, .toast, .cam-label, .minimap, .fl-tape, .msl-spec-t';
      const els = [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || +cs.opacity < 0.05) return false;
        for (let p = e; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity < 0.05) return false; }
        return true;
      });
      const name = (e) => (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : e.tagName) + (e.textContent ? ' "' + e.textContent.trim().slice(0, 18) + '"' : '');
      const out = [];
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        const a = els[i], b = els[j]; if (a.contains(b) || b.contains(a)) continue;
        const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
        const ox = Math.min(r.right, s.right) - Math.max(r.left, s.left), oy = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
        if (ox > 2 && oy > 2) out.push(name(a) + '  X  ' + name(b) + '  (' + Math.round(ox) + 'x' + Math.round(oy) + ')');
      }
      return ${JSON.stringify(label)} + ': ' + (out.length ? '\\n  ' + out.join('\\n  ') : 'no overlaps');`);
  await h.wait(3000);
  await h.game('return gca.do("panel off; day; weather clear; fly jumbo agl 1700 speed 170")');
  await h.wait(2500);
  await h.shot('01-flying');
  console.log(await overlaps('flying'));
  const rid = await h.game(`const M = g.ctx.missiles; const me = g.ctx.planes.state.position; let best = null, bd = 1e9; for (const p of M.traffic.planes) { const d = p.pos.distanceTo(me); if (!p.hit && d < bd) { bd = d; best = p.id; } } return best;`);
  console.log(await h.game(`return gca.do("ram ${rid}")`));
  let hit = false;
  for (let k = 0; k < 30 && !hit; k++) {
    await h.wait(1500);
    hit = await h.game(`return !!g.ctx.missiles.traffic.planes.find((x) => x.id === ${rid})?.hit`);
  }
  console.log('hit', hit);
  await h.wait(800);
  await h.shot('02-after-hit');
  console.log(await overlaps('after hit'));
  await h.game('return gca.do("watch hit")');
  await h.wait(1500);
  await h.shot('03-hitcam');
  console.log(await overlaps('hit cam'));
  await h.game('return gca.do("watch off")');
  await h.wait(800);
  console.log(await h.game('return gca.do("shoot nearest")'));
  await h.wait(1500);
  await h.shot('03b-control');
  console.log(await overlaps('control room'));
  await h.game('return gca.do("back")');
  await h.wait(1200);
  await h.shot('03c-dock');
  console.log(await overlaps('dock with cams'));
  await h.game('return gca.do("explode")');
  await h.wait(5000);
  await h.shot('04-crashed');
  console.log(await overlaps('crashed'));
  await h.game('return gca.do("replay")');
  await h.wait(1500);
  await h.shot('05-replay');
  console.log(await overlaps('replay'));
  await h.game('g.ctx.replay.stop(); return 1');
  await h.wait(500);
  await h.game('return gca.do("car")');
  await h.wait(2500);
  console.log(await h.game('return gca.do("nuke beach")'));
  await h.wait(1500);
  await h.shot('06-car-offer');
  console.log(await overlaps('car offer'));
}
