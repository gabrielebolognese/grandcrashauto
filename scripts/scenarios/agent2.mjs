// Agent mode: tap-to-hold keys while frozen, "." steps 1 s, heading/alt hold, recording mode while flying + walking.
export default async function (page, h) {
  await h.wait(2500);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + (await h.game(js)));
  await say('fly', 'return gca.do("fly airliner")');
  await h.wait(3000);
  await page.keyboard.press('KeyK');
  await h.wait(300);
  await page.keyboard.press('KeyD');
  await h.wait(600);
  await say('frozen after one D tap', 'return gca.state()');
  await page.keyboard.press('Period');
  await h.wait(2500);
  await say('after "." (+1 s)', 'return gca.state()');
  await h.shot('01-step');
  await page.keyboard.press('KeyK');
  await say('heading', 'return gca.do("heading 180; alt 200")');
  await h.wait(5000);
  await say('turning', 'return gca.state()');
  await h.shot('02-turn');
  await say('rec', 'return gca.do("rec on")');
  await h.wait(800);
  await h.shot('03-rec-flying');
  await say('walk', 'return gca.do("walk")');
  await h.wait(1500);
  await h.shot('04-rec-walk');
}
