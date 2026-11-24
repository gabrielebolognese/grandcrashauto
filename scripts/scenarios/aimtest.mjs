// The player's flow: map → tap a plane → SHOOT → tap a turret ON THE MAP → aim with keys / mouse → S (no lock needed).
export default async function (page, h) {
  await h.wait(5000);
  await page.keyboard.press('KeyN');
  await h.wait(1200);
  const id = await h.game('return g.ctx.missiles.sky.find((p) => !p.hit)?.id');
  await h.game(`g.ctx.nav.map.selectSky(${id}); return 1`);
  await h.wait(500);
  await h.game(`document.querySelector('.nm-sky-b button').click(); return 1`); // SHOOT
  await h.wait(1600);
  await h.shot('01-pick-on-map');
  // tap the first turret where the map draws it
  const xy = await h.game(`const m = g.ctx.nav.map, R = m.renderer, s = g.ctx.missiles.sites[0]; const r = m.canvas.getBoundingClientRect(); return JSON.stringify([r.left + R.sx(s.ax), r.top + R.sy(s.az)]);`);
  const [x, y] = JSON.parse(xy);
  await page.mouse.click(x, y);
  await h.wait(1500);
  const aim = () => h.game('const c = g.ctx.missiles.control; return c ? JSON.stringify({ site: c.launcher.id, yaw: +c.launcher.aimYaw.toFixed(2), pitch: +c.launcher.aimPitch.toFixed(2), phase: c.phase, input: g.ctx.input.enabled, car: Math.round(g.ctx.vehicle.state.speedKmh) }) : "no control"');
  console.log('in control', await aim());
  await h.shot('02-turret-view');
  await page.keyboard.down('KeyA');
  await h.wait(700);
  await page.keyboard.up('KeyA');
  await page.keyboard.down('ArrowUp');
  await h.wait(500);
  await page.keyboard.up('ArrowUp');
  console.log('after A + Up', await aim());
  await page.mouse.move(640, 400);
  await page.mouse.down();
  await page.mouse.move(560, 380, { steps: 8 });
  await page.mouse.up();
  console.log('after drag', await aim());
  await page.keyboard.press('KeyS');
  await h.wait(400);
  console.log('S (no lock)', await h.game('return document.querySelector(".msl-msg")?.textContent'), await aim());
  await h.wait(2500);
  await h.shot('03-unguided');
  await h.wait(6000);
  await h.game('g.ctx.missiles.autoAim(); return 1');
  await h.wait(300);
  await page.keyboard.press('KeyS');
  await h.wait(400);
  console.log('S (locked)', await h.game('return document.querySelector(".msl-msg")?.textContent'));
  await h.wait(3000);
  await h.shot('04-locked');
}
