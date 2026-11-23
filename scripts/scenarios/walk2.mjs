// Cockpit view survives split + crash → replay with cams → jumbo: 3rd-person cabin cam, grab a seat during a split.
export default async function (page, h) {
  await h.wait(2500);
  await h.game(`g.game.quickFly('airliner')`);
  await h.wait(1500);
  await page.keyboard.press('KeyC'); // chase → cockpit
  await h.wait(800);
  const cam = `const r = g.ctx.cameraRig; const pr = r.plane ?? r.planeRig; return { view: pr?.view, phase: pr?.phase, crashed: g.ctx.planes.crashed, split: !g.ctx.planes.currentTracked?.body, canReplay: g.ctx.replay.canReplay, rp: g.ctx.replay.active, cam: g.ctx.replay.camName, sp: g.ctx.replay.speed };`;
  console.error('[cockpit] ' + JSON.stringify(await h.game(cam)));
  await h.shot('01-cockpit');
  await page.keyboard.press('KeyM');
  await h.wait(1200);
  console.error('[split] ' + JSON.stringify(await h.game(cam)));
  await h.shot('02-cockpit-split');
  // dive it in: wait for the crash
  for (let i = 0; i < 20; i++) {
    await h.wait(1000);
    const s = await h.game(cam);
    if (s.crashed) { console.error('[crashed@' + i + '] ' + JSON.stringify(s)); break; }
  }
  await h.wait(1500);
  await h.shot('03-cockpit-crash');
  await h.game(`g.ctx.replay.start()`);
  await h.wait(1500);
  console.error('[replay] ' + JSON.stringify(await h.game(cam)));
  await h.shot('04-replay-a');
  await h.wait(2500);
  await h.shot('05-replay-b');
  await page.keyboard.press('KeyV');
  await h.wait(1200);
  console.error('[replay-next] ' + JSON.stringify(await h.game(cam)));
  await h.shot('06-replay-c');
  await page.keyboard.press('KeyV');
  await h.wait(1200);
  await h.shot('07-replay-d');
  await h.game(`g.ctx.replay.stop()`);
  await h.wait(500);
  // jumbo: walk, 3rd person, grab during a split
  await h.game(`g.game.quickFly('jumbo')`);
  await h.wait(1500);
  await h.game(`g.ctx.walker.start()`);
  await page.keyboard.press('KeyC');
  await page.keyboard.down('KeyW');
  await h.wait(2500);
  await page.keyboard.up('KeyW');
  await h.shot('08-jumbo-3rd');
  await page.keyboard.down('KeyE');
  await h.wait(600);
  await page.keyboard.press('KeyM');
  const st = `const w = g.ctx.walker; return { mode: w.mode, seat: w.seat, z: +w.p.z.toFixed(2), g: [w.gApp.x, w.gApp.y, w.gApp.z].map(v => +v.toFixed(1)), acc: [w.acc.x, w.acc.y, w.acc.z].map(v => +v.toFixed(1)) };`;
  for (let i = 0; i < 6; i++) {
    await h.wait(800);
    console.error('[grab ' + i + '] ' + JSON.stringify(await h.game(st)));
  }
  await h.shot('09-grabbing');
  await page.keyboard.up('KeyE');
  for (let i = 0; i < 6; i++) {
    await h.wait(800);
    console.error('[let-go ' + i + '] ' + JSON.stringify(await h.game(st)));
  }
  await h.shot('10-let-go');
}
