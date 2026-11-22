import { CONFIG } from '../config';
import { RAPIER, G, groups, type Physics, type ColliderKind, type SurfaceMaterial } from '../core/Physics';
import * as L from './gen/layout';
import type { CityLayout } from './gen/model';
import type { HighwayBuild } from './render/HighwayMesh';

/**
 * Static colliders for the city (resident: static colliders are cheap in Rapier and props/NPCs need them anywhere).
 * Everything hangs off ONE fixed body so the floating-origin shift moves it in one go.
 *  - ground: one cuboid (top y = 0) for the city land + a trimesh beach/seabed
 *  - islands (blocks/sidewalks/medians): rounded rectangles = 2 round-cuboids + 4 corner cylinders, top at 0.15,
 *    small border radius = drivable bevelled curb
 *  - buildings: one cuboid per lot; solids/cylinders flagged `collide`
 *  - highway: trimesh built from the visual vertices + cuboid barriers/pillars
 */
export class WorldPhysics {
  body!: RAPIER.RigidBody;
  count = 0;

  constructor(private physics: Physics) {}

  build(layout: CityLayout, hw: HighwayBuild): void {
    const { physics } = this;
    const world = physics.world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const grp = groups(G.WORLD, G.ALL);
    const add = (desc: RAPIER.ColliderDesc, kind: ColliderKind, material: SurfaceMaterial, id?: number) => {
      desc.setCollisionGroups(grp).setFriction(0.9);
      const c = world.createCollider(desc, this.body);
      physics.tag(c, { kind, material, id });
      this.count++;
      return c;
    };
    const cb = CONFIG.world.cityBounds;
    // land slab
    {
      const x0 = cb.minX, x1 = cb.maxX, z0 = cb.minZ, z1 = L.BEACH_START_Z;
      add(RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, 1, (z1 - z0) / 2).setTranslation((x0 + x1) / 2, -1, (z0 + z1) / 2), 'ground', 'asphalt');
    }
    // airport slab (flat, top y = elevation)
    if (layout.airport) {
      const AB = CONFIG.world.airportBounds;
      const e = layout.airport.data.elevation;
      add(RAPIER.ColliderDesc.cuboid((AB.maxX - AB.minX) / 2, 1, (AB.maxZ - AB.minZ) / 2).setTranslation((AB.minX + AB.maxX) / 2, e - 1, (AB.minZ + AB.maxZ) / 2), 'ground', 'asphalt');
    }
    // beach + seabed trimesh
    {
      const x0 = cb.minX, x1 = cb.maxX, z0 = L.BEACH_START_Z - 0.6, z1 = cb.maxZ;
      const dx = 5;
      const zs: number[] = [];
      for (let z = z0; z < z1; z += z < 380 ? 2.5 : 6) zs.push(z);
      zs.push(z1);
      const nx = Math.round((x1 - x0) / dx);
      const v: number[] = [];
      for (const z of zs) for (let i = 0; i <= nx; i++) {
        const x = x0 + ((x1 - x0) * i) / nx;
        v.push(x, L.beachHeight(x, Math.max(z, L.BEACH_START_Z)), z);
      }
      const idx: number[] = [];
      const row = nx + 1;
      for (let j = 0; j + 1 < zs.length; j++)
        for (let i = 0; i < nx; i++) {
          const a = j * row + i, b = a + 1, c = a + row + 1, d = a + row;
          idx.push(a, d, c, a, c, b);
        }
      add(RAPIER.ColliderDesc.trimesh(new Float32Array(v), new Uint32Array(idx)), 'ground', 'sand');
    }
    // islands
    const bevel = 0.06;
    for (const isl of layout.islands) {
      const w = isl.maxX - isl.minX, d = isl.maxZ - isl.minZ;
      const cx = (isl.minX + isl.maxX) / 2, cz = (isl.minZ + isl.maxZ) / 2;
      const yb = -0.4, yt = isl.top;
      const hy = (yt - yb) / 2, cy = (yt + yb) / 2;
      const mat: SurfaceMaterial = isl.interior === 'park' || isl.kind === 'verge' ? 'grass' : 'concrete';
      const R = isl.r;
      const rc = (hx: number, hz: number) =>
        add(RAPIER.ColliderDesc.roundCuboid(Math.max(0.01, hx - bevel), hy - bevel, Math.max(0.01, hz - bevel), bevel).setTranslation(cx, cy, cz), 'ground', mat);
      if (R < 0.6) {
        rc(w / 2, d / 2);
        continue;
      }
      rc(w / 2, d / 2 - R);
      rc(w / 2 - R, d / 2);
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
        add(RAPIER.ColliderDesc.roundCylinder(hy - bevel, R - bevel, bevel).setTranslation(cx + sx * (w / 2 - R), cy, cz + sz * (d / 2 - R)), 'ground', mat);
    }
    // buildings
    for (const b of layout.data.buildings) {
      const q = { x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) };
      add(RAPIER.ColliderDesc.cuboid(b.w / 2, b.h / 2, b.d / 2).setTranslation(b.x, b.y + b.h / 2, b.z).setRotation(q), 'building', b.style === 1 ? 'glass' : 'concrete', b.id);
    }
    // solids
    const solids = layout.airport ? layout.solids.concat(layout.airport.solids) : layout.solids;
    const cylinders = layout.airport ? layout.cylinders.concat(layout.airport.cylinders) : layout.cylinders;
    for (const s of solids) {
      if (!s.collide) continue;
      const q = { x: 0, y: Math.sin(s.yaw / 2), z: 0, w: Math.cos(s.yaw / 2) };
      if (s.h0 !== undefined && Math.abs(s.h0 - s.h) > 0.01) {
        // wedge: convex hull in local space
        const hw = s.w / 2, hd = s.d / 2;
        const pts = new Float32Array([-hw, 0, -hd, hw, 0, -hd, -hw, 0, hd, hw, 0, hd, -hw, s.h0 + 0.001, -hd, hw, s.h0 + 0.001, -hd, -hw, s.h, hd, hw, s.h, hd]);
        const desc = RAPIER.ColliderDesc.convexHull(pts);
        if (desc) add(desc.setTranslation(s.cx, s.cy, s.cz).setRotation(q), 'ground', 'concrete');
      } else {
        add(RAPIER.ColliderDesc.cuboid(s.w / 2, s.h / 2, s.d / 2).setTranslation(s.cx, s.cy + s.h / 2, s.cz).setRotation(q), s.mat === 8 ? 'misc' : 'building', s.mat === 8 ? 'metal' : 'concrete');
      }
    }
    for (const c of cylinders) {
      if (!c.collide) continue;
      add(RAPIER.ColliderDesc.cylinder(c.h / 2, c.r).setTranslation(c.cx, c.cy + c.h / 2, c.cz), 'misc', 'concrete');
    }
    // highway
    for (const g of hw.phys) {
      const desc = RAPIER.ColliderDesc.trimesh(g.positions(), g.indices(), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES);
      add(desc, 'road', 'asphalt');
    }
    for (const c of hw.cuboids) {
      add(RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(c.cx, c.cy, c.cz).setRotation({ x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] }), 'misc', c.material);
    }
  }

  dispose(): void {
    this.physics.removeBody(this.body);
  }
}
