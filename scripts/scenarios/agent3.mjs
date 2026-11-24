// Agent mode: the night tree-skim split recipe end to end (rec mode on), then the replay.
export default async function (page, h) {
  await h.wait(2500);
  const say = async (label, js) => console.log(`\n===== ${label}\n` + (await h.game(js)));
  await say('recipe', `return gca.do("rec on; night; fly jumbo agl 22 speed 150; wait 6; pitch up 2; wait 2; split; wait 7; replay")`);
  await h.wait(5000);
  await h.shot('01-skim-rec');
  await say('before split', 'return gca.state()');
  await h.wait(2500);
  await h.shot('02-pitch-up');
  await h.wait(2500);
  await h.shot('03-split');
  await h.wait(9000);
  await say('replay', 'return gca.state()');
  await h.shot('04-replay');
}
