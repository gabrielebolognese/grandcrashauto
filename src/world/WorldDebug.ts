import * as THREE from 'three';
import type { CityData, PedEdgeKind } from './types';
import type { CityLayout } from './gen/model';

/**
 * `?worlddebug` overlay: road graph (yellow, highway orange, ramps red), pedestrian graph (by kind), benches,
 * bus stops, group spots, wander areas, exits. Built once in ABSOLUTE coordinates under the world root.
 */
const PED_COL: Record<PedEdgeKind, number> = { sidewalk: 0x00e0ff, crosswalk: 0xffffff, path: 0x40ff60, promenade: 0xff60d0, plaza: 0xb070ff };

export class WorldDebug {
  readonly group = new THREE.Group();
  private geos: THREE.BufferGeometry[] = [];
  private mats: THREE.Material[] = [];

  constructor(data: CityData, layout: CityLayout) {
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, hex: number) => {
      pos.push(ax, ay, az, bx, by, bz);
      c.setHex(hex);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const lift = 0.35;
    for (const e of data.roads.edges) {
      const hex = layout.noRespawnEdges.has(e.id) ? 0xff2020 : e.kind === 'highway' ? 0xff9900 : e.kind === 'ramp' ? 0xff4040 : e.kind === 'lot' ? 0x99ff99 : 0xffee00;
      for (let i = 0; i + 1 < e.points.length; i++) {
        const a = e.points[i], b = e.points[i + 1];
        seg(a.x, a.y + lift + 0.2, a.z, b.x, b.y + lift + 0.2, b.z, hex);
      }
    }
    for (const n of data.roads.nodes) {
      const h = n.trafficLight ? 0xff0000 : 0xffffff;
      seg(n.p.x, n.p.y, n.p.z, n.p.x, n.p.y + 3, n.p.z, h);
    }
    for (const e of data.ped.edges) {
      const a = data.ped.nodes[e.a].p, b = data.ped.nodes[e.b].p;
      seg(a.x, a.y + lift, a.z, b.x, b.y + lift, b.z, PED_COL[e.kind]);
    }
    const cross = (x: number, y: number, z: number, r: number, hex: number) => {
      seg(x - r, y, z, x + r, y, z, hex);
      seg(x, y, z - r, x, y, z + r, hex);
      seg(x, y, z, x, y + 1.2, z, hex);
    };
    for (const b of data.benches) {
      cross(b.p.x, b.p.y, b.p.z, 0.6, 0xff00ff);
      seg(b.p.x, b.p.y + 0.3, b.p.z, b.p.x + Math.sin(b.yaw) * 1.2, b.p.y + 0.3, b.p.z + Math.cos(b.yaw) * 1.2, 0xff00ff);
      const pn = data.ped.nodes[b.pedNode];
      if (pn) seg(b.p.x, b.p.y, b.p.z, pn.p.x, pn.p.y + lift, pn.p.z, 0xffaaff);
    }
    for (const s of data.busStops) cross(s.p.x, s.p.y + 0.2, s.p.z, 1, 0x3060ff);
    for (const g of data.groupSpots) cross(g.x, g.y + 0.2, g.z, 0.8, 0xffffff);
    for (const w of data.wanderAreas) {
      const y = w.y + 0.3;
      seg(w.minX, y, w.minZ, w.maxX, y, w.minZ, 0x80ff80);
      seg(w.maxX, y, w.minZ, w.maxX, y, w.maxZ, 0x80ff80);
      seg(w.maxX, y, w.maxZ, w.minX, y, w.maxZ, 0x80ff80);
      seg(w.minX, y, w.maxZ, w.minX, y, w.minZ, 0x80ff80);
    }
    for (const ex of data.exits ?? []) {
      const p = data.roads.nodes[ex.node].p;
      seg(p.x, p.y + 1, p.z, p.x + ex.dir.x * 20, p.y + 1, p.z + ex.dir.z * 20, 0xff0000);
      seg(p.x, p.y, p.z, p.x, p.y + 8, p.z, 0xff0000);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const m = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: true, fog: false });
    const lines = new THREE.LineSegments(g, m);
    lines.frustumCulled = false;
    lines.renderOrder = 10;
    this.group.add(lines);
    this.geos.push(g);
    this.mats.push(m);
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
  }
}
