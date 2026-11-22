// Determinism: the same chunk / tile / scatter generated on the main thread and in two workers must hash
// identically, and again after a page reload.
//   node scripts/smoke.mjs --tag terrain-det --script src/terrain/smoke/determinism.mjs
export default async function (page, h) {
  await h.wait(1000);
  const a = await h.game(`return window.__terrain.debugDeterminism();`);
  console.error('[det] load1', JSON.stringify(a));
  await page.reload();
  await page.waitForFunction(() => { const s = window.__game?.game?.state; return s && s !== 'boot'; }, null, { timeout: 120000 });
  await h.wait(1000);
  const b = await h.game(`return window.__terrain.debugDeterminism();`);
  console.error('[det] load2', JSON.stringify(b));
  const all = [...a.chunk, ...b.chunk].every((x) => x === a.chunk[0]) && [...a.tile, ...b.tile].every((x) => x === a.tile[0]) && [...a.scatter, ...b.scatter].every((x) => x === a.scatter[0]);
  console.error('[det] identical:', all);
}
