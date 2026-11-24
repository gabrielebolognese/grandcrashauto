// Agent mode: text view + forecast, night tree-skim in the jumbo, nose up 2 s, split; recording mode.
export default async function (page, h) {
  await h.wait(2500);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + (await h.game(js)));
  await say('fly', `return gca.do("night; fly jumbo agl 22 speed 140")`);
  await h.wait(4000);
  await say('state skim', 'return gca.state()');
  await h.shot('01-skim');
  // turn-based: freeze, plan, check the forecast, then run
  await say('plan', `return gca.do("freeze; pitch up 2; wait 2; split")`);
  await h.shot('02-frozen-plan');
  await say('run', `return gca.do("go")`);
  await h.wait(1500);
  await h.shot('03-pitch');
  await h.wait(2500);
  await say('state split', 'return gca.state()');
  await h.shot('04-split');
  await h.wait(3000);
  await say('state wreck', 'return gca.state()');
  await h.shot('05-wreck');
  // recording mode with the crash panel up
  await say('rec', `return gca.do("rec on")`);
  await h.wait(1200);
  await h.shot('06-rec');
  // car + latched keys
  await say('car', `return gca.do("rec off; day; car")`);
  await h.wait(1500);
  await page.keyboard.press('KeyW');
  await page.keyboard.press('KeyW');
  await h.wait(400);
  await say('state car', 'return gca.state()');
  await h.shot('07-car');
}
