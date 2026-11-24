// Terrain look: smooth farmland colours (greens / yellows / browns) and smooth mountains.
export default async function (page, h) {
  await h.wait(2500);
  await h.game('return gca.do("rec on; day; weather clear; fly airliner agl 260 speed 120")');
  await h.wait(6000);
  await h.shot('01-farmland');
  await h.game('return gca.do("fly airliner agl 900 speed 120 at 2600 -7000 heading n")');
  await h.wait(7000);
  await h.shot('02-mountains');
  await h.game('return gca.do("fly prop agl 60 speed 50 at 2200 -900 heading e")');
  await h.wait(5000);
  await h.shot('03-low-fields');
}
