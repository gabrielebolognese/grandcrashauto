import type { CityData, Pose, Vec3 } from '../world/types';

/**
 * Floating-origin helper (owner: core): shift every coordinate in CityData IN PLACE by -(dx, dz) so the data stays in
 * LOCAL coordinates. Called by Game right before the 'originShift' event. If you add coordinate fields to CityData,
 * handle them here.
 */
export function shiftCityData(d: CityData, dx: number, dz: number): void {
  const v = (p: Vec3 | undefined | null) => {
    if (!p) return;
    p.x -= dx;
    p.z -= dz;
  };
  const pose = (p: Pose | undefined | null) => v(p?.position);
  const rect = (r: { minX: number; maxX: number; minZ: number; maxZ: number } | undefined | null) => {
    if (!r) return;
    r.minX -= dx;
    r.maxX -= dx;
    r.minZ -= dz;
    r.maxZ -= dz;
  };
  const seen = new Set<Vec3>(); // polylines may share point objects with nodes
  const vOnce = (p: Vec3) => {
    if (seen.has(p)) return;
    seen.add(p);
    v(p);
  };
  for (const n of d.roads.nodes) vOnce(n.p);
  for (const e of d.roads.edges) for (const p of e.points) vOnce(p);
  for (const n of d.ped.nodes) vOnce(n.p);
  for (const b of d.benches) vOnce(b.p);
  for (const b of d.busStops) vOnce(b.p);
  for (const a of d.wanderAreas) {
    a.minX -= dx;
    a.maxX -= dx;
    a.minZ -= dz;
    a.maxZ -= dz;
  }
  for (const g of d.groupSpots) vOnce(g);
  for (const b of d.buildings) {
    b.x -= dx;
    b.z -= dz;
  }
  for (const p of d.props) vOnce(p.p);
  for (const c of d.parkedCars) vOnce(c.p);
  pose(d.spawn);
  pose(d.garage);
  pose(d.jumpRamp);
  d.coast.seaWallZ -= dz;
  d.coast.shoreZ -= dz;
  if (d.airport) {
    for (const r of d.airport.runways) {
      vOnce(r.a);
      vOnce(r.b);
    }
    for (const s of d.airport.stands) vOnce(s.p);
    pose(d.airport.carPark);
    vOnce(d.airport.terminal);
    vOnce(d.airport.tower);
    rect(d.airport.bounds);
  }
  if (d.pois) for (const p of d.pois) pose(p.pose);
  rect(d.island);
  // districtGrid is indexed in ABSOLUTE space: world.districtAt() must add ctx.origin.offset before indexing.
}
