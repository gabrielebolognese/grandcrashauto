import type { CityData, ParkedCarPlacement, Pose, PropKind, PropPlacement } from '../types';

/**
 * Temporary development layout (owner: props): a short street ahead of the spawn with every prop kind, a crash
 * course in the driving lane, parked cars on both kerbs, a traffic-light junction and the airport kinds behind the
 * car. Used only when CityData has no props (stub world) or with `?propstest`.
 */
export function buildTestLayout(
  data: CityData,
  groundAt: (x: number, z: number) => number,
  anchor?: Pose,
): { props: PropPlacement[]; cars: ParkedCarPlacement[]; seats: Map<number, number> } {
  const sp = anchor?.position ?? data.spawn.position;
  const yaw = anchor?.yaw ?? data.spawn.yaw;
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // forward
  const rx = -Math.cos(yaw), rz = Math.sin(yaw); // right
  const props: PropPlacement[] = [];
  const cars: ParkedCarPlacement[] = [];
  const seats = new Map<number, number>();
  let v = 1;
  const at = (lat: number, fwd: number) => {
    const x = sp.x + rx * lat + fx * fwd;
    const z = sp.z + rz * lat + fz * fwd;
    return { x, y: groundAt(x, z), z };
  };
  /** face: local yaw offset relative to the street direction (0 = along the street, ±π/2 = toward the road). */
  const add = (kind: PropKind, lat: number, fwd: number, face: number, s?: number) => {
    const p = at(lat, fwd);
    if (kind === 'bench' && s) seats.set(props.length, s);
    props.push({ kind, p, yaw: yaw + face, variant: (v++ * 7919) % 10007, chunk: 0 });
  };
  const toRoad = (lat: number) => (lat > 0 ? Math.PI / 2 : -Math.PI / 2); // +Z local faces the street centre
  // kerbside furniture
  for (const side of [-1, 1]) {
    for (const f of [10, 30, 50]) add('streetlight', side * 7.6, f, toRoad(side));
    for (const f of [15, 25, 35, 45, 55]) add('palm', side * 9.6, f, (f * 1.7) % 6.28);
    add('bin', side * 8.2, 22, toRoad(side));
    add('bin', side * 8.2, 42, toRoad(side));
  }
  add('bench', -9.0, 19, toRoad(-9), 3);
  add('bench', 9.0, 39, toRoad(9), 2);
  add('bench', 9.0, 21, toRoad(9), 3);
  add('hydrant', 7.6, 17, toRoad(7.6));
  add('hydrant', -7.6, 37, toRoad(-7.6));
  add('sign', 8.6, 28, Math.PI);
  add('sign', -8.6, 47, Math.PI);
  add('busStop', -11.2, 31, toRoad(-11));
  for (const [lat, f] of [[-15, 12], [15, 18], [-15, 45], [16, 33]]) add('tree', lat, f, f, undefined);
  for (const [lat, f] of [[15, 50], [-16, 24]]) {
    const p = at(lat, f);
    props.push({ kind: 'tree', p, yaw, variant: 3, chunk: 0 }); // variant 3 → cypress
  }
  // crash course in the lane
  for (let k = -2; k <= 2; k++) add('cone', k * 0.8, 20, 0);
  add('barrier', -1.0, 27, 0);
  add('barrier', 1.0, 27, 0);
  add('bin', -0.6, 33, 0);
  add('bin', 0.7, 33.5, 0);
  add('bench', 0, 39.5, Math.PI, 2);
  for (let k = -3; k <= 3; k++) add('cone', k * 0.7, 46 + Math.abs(k) * 0.6, 0);
  // traffic-light junction
  add('trafficLight', 6.6, 58, Math.PI);
  add('trafficLight', -6.6, 66, 0);
  add('trafficLight', -6.6, 58, -Math.PI / 2);
  add('trafficLight', 6.6, 66, Math.PI / 2);
  // airport kinds behind the car
  add('fuelTruck', 9, -20, Math.PI / 2);
  add('baggageCart', -6, -14, 0.1);
  add('baggageCart', -6, -18.5, 0.05);
  add('windsock', -13, -27, 0.8);
  // parked cars on both kerbs
  const colors = ['#ff7a6b', '#5cc8d6', '#ffe39a', '#b8a6e8', '#9ee0c8', '#f4f1ea', '#2f4a6b', '#ffb38a', '#e84a5f', '#3a3f47', '#7fb0d8', '#c94f7c'];
  let ci = 0;
  for (const side of [-1, 1]) {
    for (const f of [12, 18.5, 25, 31.5, 44, 50.5]) {
      const p = at(side * 5.3, f);
      cars.push({ p, yaw: side > 0 ? yaw : yaw + Math.PI, variant: ci, color: colors[ci % colors.length], chunk: 0 });
      ci++;
    }
  }
  return { props, cars, seats };
}
