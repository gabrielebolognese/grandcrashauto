import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config';
import type { Bench, BusStop, PedEdge, PedEdgeKind, PedNode, Vec3, WanderArea } from '../world/types';
import type { NavSource } from './nav';

/**
 * Temporary pedestrian test environment (used while the world module has no ped data, or with ?npctest):
 * a street with two sidewalks + crosswalks, a plaza with paths, benches, a bus stop and group spots, laid out
 * around (cx, cz) on flat ground, plus simple visuals so screenshots read well. Removed when real data appears.
 */
export interface TestWorld {
  source: NavSource;
  object: THREE.Object3D;
  dispose(): void;
}

export function buildTestWorld(cx: number, cy: number, cz: number): TestWorld {
  const nodes: PedNode[] = [];
  const edges: PedEdge[] = [];
  const node = (x: number, z: number): number => {
    const id = nodes.length;
    nodes.push({ id, p: { x: cx + x, y: cy, z: cz + z }, edges: [] });
    return id;
  };
  const edge = (a: number, b: number, kind: PedEdgeKind, width: number) => {
    const id = edges.length;
    edges.push({ id, a, b, kind, width });
    nodes[a].edges.push(id);
    nodes[b].edges.push(id);
  };
  // two sidewalks along X (north z=12, south z=24), road between z 13.5..22.5
  const xs = [-44, -22, 0, 22, 44];
  const north = xs.map((x) => node(x, 12));
  const south = xs.map((x) => node(x, 24));
  for (let i = 0; i < xs.length - 1; i++) {
    edge(north[i], north[i + 1], 'sidewalk', 3);
    edge(south[i], south[i + 1], 'sidewalk', 3);
  }
  // crosswalks at both ends and two in the middle
  for (const i of [0, 1, 3, 4]) edge(north[i], south[i], 'crosswalk', 3);
  // plaza paths (south of the south sidewalk)
  const p0 = node(-22, 31);
  const p1 = node(-34, 38);
  const p2 = node(-12, 40);
  const p3 = node(-22, 46);
  edge(south[1], p0, 'path', 2.6);
  edge(p0, p1, 'plaza', 3);
  edge(p0, p2, 'plaza', 3);
  edge(p1, p3, 'plaza', 3);
  edge(p2, p3, 'plaza', 3);
  // a promenade spur east
  const e0 = node(44, 32);
  const e1 = node(30, 40);
  edge(south[4], e0, 'promenade', 4);
  edge(e0, e1, 'promenade', 4);

  const seatH = CONFIG.props.benchSeatHeight;
  const spacing = CONFIG.props.benchSeatSpacing;
  const benches: Bench[] = [];
  const bench = (x: number, z: number, yaw: number, seats: number, pedNode: number) => {
    benches.push({ id: benches.length, p: { x: cx + x, y: cy + seatH, z: cz + z }, yaw, seats, seatSpacing: spacing, seatHeight: seatH, propIndex: -1, pedNode });
    return benches.length - 1;
  };
  bench(8, 25.9, Math.PI, 3, south[2]);
  bench(14, 25.9, Math.PI, 2, south[3]);
  bench(-8, 10.1, 0, 3, north[2]);
  bench(-28, 40.5, Math.PI * 0.5, 3, p1);
  bench(-16, 44.5, -Math.PI * 0.75, 2, p3);
  const shelterBench = bench(30, 26.2, Math.PI, 3, south[3]);
  const busStops: BusStop[] = [{ id: 0, p: { x: cx + 30, y: cy, z: cz + 25.2 }, yaw: Math.PI, propIndex: -1, pedNode: south[3], benchId: benches[shelterBench].id }];
  const wanderAreas: WanderArea[] = [{ id: 0, kind: 'plaza', minX: cx - 38, maxX: cx - 8, minZ: cz + 28, maxZ: cz + 50, y: cy }];
  const groupSpots: Vec3[] = [
    { x: cx - 18, y: cy, z: cz + 34 },
    { x: cx - 30, y: cy, z: cz + 46 },
    { x: cx + 34, y: cy, z: cz + 11.6 },
    { x: cx - 6, y: cy, z: cz + 25 },
  ];

  // ───────── visuals (one merged mesh, vertex colours) ─────────
  const parts: THREE.BufferGeometry[] = [];
  const col = new THREE.Color();
  const boxAt = (x: number, y: number, z: number, w: number, h: number, d: number, color: number, yaw = 0) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(yaw);
    g.translate(cx + x, cy + y, cz + z);
    col.set(color);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.toArray(c, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  };
  boxAt(0, 0.005, 18, 96, 0.01, 9, 0x4a4d57); // road
  boxAt(0, 0.012, 12, 96, 0.024, 3, 0xd9d2c5); // sidewalks
  boxAt(0, 0.012, 24, 96, 0.024, 3, 0xd9d2c5);
  for (const x of [-44, -22, 22, 44]) for (let k = 0; k < 6; k++) boxAt(x - 1.2 + k * 0.48, 0.013, 18, 0.32, 0.016, 8.6, 0xf4f2ee);
  boxAt(-23, 0.01, 39, 30, 0.02, 22, 0xf3dcb2); // plaza
  boxAt(-22, 0.012, 27.5, 2.6, 0.022, 6, 0xe8dcc6);
  boxAt(37, 0.01, 36, 18, 0.02, 10, 0xf6e7c6); // promenade
  for (const b of benches) {
    const fx = Math.sin(b.yaw), fz = Math.cos(b.yaw);
    const lx = b.p.x - cx, lz = b.p.z - cz;
    const len = b.seats * b.seatSpacing + 0.25;
    boxAt(lx - fx * 0.0, seatH - 0.03, lz - fz * 0.0, len, 0.06, 0.44, 0x9b6a43, b.yaw);
    boxAt(lx - fx * 0.24, seatH + 0.24, lz - fz * 0.24, len, 0.32, 0.05, 0x9b6a43, b.yaw);
    for (const s of [-1, 1]) {
      const ox = Math.cos(b.yaw) * s * (len / 2 - 0.12), oz = -Math.sin(b.yaw) * s * (len / 2 - 0.12);
      boxAt(lx + ox, (seatH - 0.06) / 2, lz + oz, 0.06, seatH - 0.06, 0.4, 0x3d3f45, b.yaw);
    }
  }
  // bus shelter
  boxAt(30, 2.4, 26.7, 4.2, 0.08, 1.6, 0x5cc8d6);
  boxAt(30, 1.25, 27.45, 4.2, 2.3, 0.05, 0xbfe0ff);
  for (const s of [-1, 1]) boxAt(30 + s * 2, 1.2, 26.7, 0.08, 2.4, 0.08, 0x3d3f45);
  const geo = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'npc-test-world';
  return {
    source: { ped: { nodes, edges }, benches, busStops, wanderAreas, groupSpots, buildings: [], props: [] },
    object: mesh,
    dispose() {
      geo.dispose();
      mat.dispose();
      mesh.removeFromParent();
    },
  };
}
