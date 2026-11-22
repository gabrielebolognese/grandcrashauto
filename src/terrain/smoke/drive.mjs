// Drive on terrain: teleport the car to inland spots (ABSOLUTE coords), wait for colliders, drive, and check the car
// sits on the ground (no floating/sinking). node scripts/smoke.mjs --tag terrain-drive --script src/terrain/smoke/drive.mjs
const SPOTS = [
  { name: 'farmland', p: [2450, -1450], yaw: 2.6 },
  { name: 'hills', p: [3600, -3800], yaw: 3.0 },
  { name: 'lighthouse', poi: 'lighthouse' },
  { name: 'pier', poi: 'pier' },
];
export default async function (page, h) {
  await h.wait(1500);
  for (const s of SPOTS) {
    await h.game(`
      const c = g.ctx, o = c.origin.offset;
      let x, z, yaw;
      if (${JSON.stringify(s.poi || '')}) { const p = c.terrain.pois.find(q => q.id === ${JSON.stringify(s.poi || '')}); x = p.pose.position.x; z = p.pose.position.z; yaw = p.pose.yaw; }
      else { x = ${s.p ? s.p[0] : 0} - o.x; z = ${s.p ? s.p[1] : 0} - o.z; yaw = ${s.yaw ?? 0}; }
      window.__spot = { x, z, yaw };
      c.terrain.isReady(x, z, 80);
    `);
    for (let i = 0; i < 30; i++) {
      const ok = await h.game(`const s = window.__spot; return g.ctx.terrain.isReady(s.x, s.z, 80);`);
      if (ok) break;
      await h.wait(1000);
    }
    await h.game(`
      const c = g.ctx, s = window.__spot;
      const y = c.terrain.heightAt(s.x, s.z) + 1.2;
      c.vehicle.reset({ position: { x: s.x, y, z: s.z }, yaw: s.yaw });
      c.cameraRig.snap();
    `);
    await h.wait(2500);
    await h.shot('drive-' + s.name + '-a');
    await h.hold('KeyW', 2500);
    const st = await h.game(`
      const c = g.ctx, v = c.vehicle.state, p = v.position;
      const gh = c.terrain.heightAt(p.x, p.z);
      return { pos: [p.x, p.y, p.z].map(n => +n.toFixed(2)), ground: +gh.toFixed(2), dy: +(p.y - gh).toFixed(2), kmh: Math.round(v.speedKmh),
        surface: c.terrain.surfaceAt(p.x, p.z), biome: c.terrain.biomeAt(p.x, p.z), wheels: v.wheels.map(w => w.contact),
        calls: c.engine.stats.calls, tris: c.engine.stats.triangles };
    `);
    console.error(`[drive] ${s.name}`, JSON.stringify(st));
    await h.shot('drive-' + s.name + '-b');
  }
}
