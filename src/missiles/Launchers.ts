import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { G, RAPIER, groups } from '../core/Physics';
import type { GameContext } from '../game/contracts';
import { LAUNCHER_SITES, LAUNCHER_TYPES, type LauncherSite, type LauncherType } from './types';

export interface Launcher {
  id: string;
  name: string;
  type: LauncherType;
  site: LauncherSite;
  root: THREE.Group; // world (LOCAL coords, shifted by core with the floating origin)
  turret: THREE.Group; // yaw (the head)
  rack: THREE.Group; // pitch (launcher box + loaded missiles)
  loaded: THREE.Object3D[]; // missile models in the tubes (hidden when fired)
  ready: boolean[];
  reloadT: number[];
  aimYaw: number; // world yaw of the launcher box
  aimPitch: number;
  body: RAPIER_T.RigidBody | null;
  ax: number; // ABSOLUTE position
  az: number;
  y: number;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const mats = new Map<number, THREE.MeshStandardMaterial>();
const mat = (c: number, metal = 0.3) => {
  let m = mats.get(c);
  if (!m) mats.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, metalness: metal })));
  return m;
};

const geoCache = new Map<string, THREE.BufferGeometry[]>();
function missileGeos(t: LauncherType): THREE.BufferGeometry[] {
  let g = geoCache.get(t.kind);
  if (g) return g;
  const L = t.missileLen, R = t.missileR;
  g = [
    new THREE.CylinderGeometry(R, R, L * 0.78, 12).rotateX(Math.PI / 2),
    new THREE.ConeGeometry(R, L * 0.22, 12).rotateX(Math.PI / 2),
    new THREE.CylinderGeometry(R * 1.02, R * 1.02, L * 0.06, 12).rotateX(Math.PI / 2),
    new THREE.BoxGeometry(R * 0.12, R * 1.8, L * 0.14),
    new THREE.CylinderGeometry(R * 1.01, R * 1.01, L * 0.03, 12).rotateX(Math.PI / 2),
  ];
  geoCache.set(t.kind, g);
  return g;
}

/** A missile model (nose +Z), shared geometry per kind (loaded in the turrets and flying). */
export function missileModel(t: LauncherType): THREE.Group {
  const g = new THREE.Group();
  const L = t.missileLen, R = t.missileR;
  const G = missileGeos(t);
  const body = new THREE.Mesh(G[0], mat(t.missile, 0.1));
  body.position.z = -L * 0.05;
  const nose = new THREE.Mesh(G[1], mat(t.tip, 0.1));
  nose.position.z = L * 0.45;
  const band = new THREE.Mesh(G[2], mat(t.tip, 0.1));
  band.position.z = L * 0.2;
  g.add(body, nose, band);
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.Mesh(G[3], mat(t.tip, 0.1));
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * R * 1.3, Math.sin(a) * R * 1.3, -L * 0.36);
    fin.rotation.z = a - Math.PI / 2;
    g.add(fin);
  }
  if (t.warhead === 'nuke') {
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Mesh(G[4], mat(0x1c1c1c, 0.1));
      s.position.z = L * (0.05 - k * 0.08);
      g.add(s);
    }
  }
  for (const c of g.children) (c as THREE.Mesh).castShadow = true;
  return g;
}

/**
 * AIR-DEFENCE TURRETS (user request), up in the mountains only: a concrete pad, a steel pedestal, a rotating head with
 * a small radar, and a launcher box between two arms holding its missiles side by side (2), in a square (4) or in a
 * 4×2 block (8). The missiles stay visible in their tubes until fired and reload one by one. Each turret is a teleport
 * place and a pick on the map.
 */
export class Launchers {
  readonly list: Launcher[] = [];
  private built = false;

  constructor(private ctx: GameContext) {}

  update(dt: number): void {
    if (!this.built && this.ctx.world.data) {
      this.built = true;
      for (const site of LAUNCHER_SITES) this.build(site);
    }
    for (const l of this.list) {
      for (let i = 0; i < l.ready.length; i++) {
        if (l.ready[i]) continue;
        l.reloadT[i] -= dt;
        if (l.reloadT[i] <= 0) {
          l.ready[i] = true;
          l.loaded[i].visible = true;
        }
      }
      l.turret.rotation.y = l.aimYaw - l.site.yaw;
      l.rack.rotation.x = -l.aimPitch;
    }
  }

  private groundAbs(ax: number, az: number): number {
    const o = this.ctx.origin.offset;
    try {
      const g = this.ctx.world.groundHeightAt(ax - o.x, az - o.z);
      return Number.isFinite(g) ? g : 0;
    } catch {
      return 0;
    }
  }

  private build(site: LauncherSite): void {
    const { ctx } = this;
    const t = LAUNCHER_TYPES[site.kind];
    const o = ctx.origin.offset;
    const ax = site.at.x, az = site.at.z;
    let y = Infinity;
    for (const [dx, dz] of [[0, 0], [3, 3], [-3, 3], [3, -3], [-3, -3]]) y = Math.min(y, this.groundAbs(ax + dx, az + dz));
    const root = new THREE.Group();
    root.name = `turret-${site.id}`;
    root.position.set(ax - o.x, y, az - o.z);
    root.rotation.y = site.yaw;
    const add = (geo: THREE.BufferGeometry, c: number, x: number, yy: number, z: number, parent: THREE.Object3D, metal = 0.3) => {
      const m = new THREE.Mesh(geo, mat(c, metal));
      m.position.set(x, yy, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const [bw, bh] = t.box;
    const L = t.missileLen * 1.04;
    // pad + pedestal
    add(new THREE.CylinderGeometry(4.2, 4.6, 0.8, 8), 0x9a978e, 0, 0.1, 0, root, 0);
    add(new THREE.CylinderGeometry(4.25, 4.25, 0.06, 8), 0xd9c46a, 0, 0.52, 0, root, 0); // yellow rim
    add(new THREE.CylinderGeometry(0.9, 1.2, 2.6, 16), t.body, 0, 1.8, 0, root);
    // head (yaw): turntable, two arms, a radar on the back
    const turret = new THREE.Group();
    turret.position.set(0, 3.1, 0);
    root.add(turret);
    add(new THREE.CylinderGeometry(1.5, 1.5, 0.5, 18), t.body, 0, 0.25, 0, turret);
    for (const sx of [1, -1]) add(new THREE.BoxGeometry(0.3, bh * 2 + 0.6, 1.4), t.body, sx * (bw + 0.25), bh + 0.2, 0, turret);
    add(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), 0x2a2c30, 0, 1.1, -1.2, turret);
    const dish = add(new THREE.CylinderGeometry(0.7, 0.5, 0.12, 14), 0xd8dade, 0, 1.95, -1.2, turret, 0.2);
    dish.rotation.x = 1.1;
    // launcher box (pitch) with the tubes, axle through the arms
    const rack = new THREE.Group();
    rack.position.set(0, bh + 0.2, 0);
    turret.add(rack);
    add(new THREE.BoxGeometry(bw * 2, bh * 2, L), t.rack, 0, 0, 0, rack);
    add(new THREE.CylinderGeometry(0.18, 0.18, bw * 2 + 0.9, 10).rotateZ(Math.PI / 2), 0x2a2c30, 0, 0, 0, rack);
    const loaded: THREE.Object3D[] = [];
    for (const [x, yy] of t.tubes) {
      const mouth = new THREE.Mesh(new THREE.CylinderGeometry(t.missileR * 1.3, t.missileR * 1.3, 0.06, 14).rotateX(Math.PI / 2), mat(0x141518, 0));
      mouth.position.set(x, yy, L / 2 + 0.02);
      rack.add(mouth);
      const m = missileModel(t);
      // the nose peeks out of the tube
      m.position.set(x, yy, L / 2 - t.missileLen * 0.5 + t.missileLen * 0.12);
      rack.add(m);
      loaded.push(m);
    }
    if (t.warhead === 'nuke') {
      // hazard stripes on the box
      for (const sx of [1, -1]) add(new THREE.BoxGeometry(0.04, bh * 1.6, L * 0.6), 0xffd23f, sx * (bw + 0.01), 0, 0, rack, 0.1);
    }
    ctx.engine.scene.add(root);
    // a solid block for cars to bump into
    const body = ctx.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(root.position.x, y, root.position.z).setRotation(_q.setFromAxisAngle(_v.set(0, 1, 0), site.yaw)));
    const col = ctx.physics.world.createCollider(RAPIER.ColliderDesc.cylinder(2.2, 1.6).setTranslation(0, 2.2, 0).setCollisionGroups(groups(G.WORLD, G.ALL)), body);
    ctx.physics.tag(col, { kind: 'staticProp', material: 'metal' });
    this.list.push({
      id: site.id, name: `${site.name} ${t.name}`, type: t, site, root, turret, rack, loaded,
      ready: loaded.map(() => true), reloadT: loaded.map(() => 0),
      aimYaw: site.yaw, aimPitch: 0.35, body, ax, az, y,
    });
  }

  /** World position + direction of tube i (after the current aim), for a launch. */
  tubeWorld(l: Launcher, i: number, pos: THREE.Vector3, dir: THREE.Vector3): void {
    const m = l.loaded[i];
    l.root.updateMatrixWorld(true);
    m.getWorldPosition(pos);
    m.getWorldQuaternion(_q);
    dir.set(0, 0, 1).applyQuaternion(_q).normalize();
  }

  /** The launcher box pivot in world space. */
  pivot(l: Launcher, out: THREE.Vector3): THREE.Vector3 {
    l.root.updateMatrixWorld(true);
    return l.rack.getWorldPosition(out);
  }

  get pois(): { id: string; name: string; icon: string; pose: { position: { x: number; y: number; z: number }; yaw: number } }[] {
    const o = this.ctx.origin.offset;
    return this.list.map((l) => {
      // park the car a little behind the turret, facing the same way
      const yaw = l.site.yaw;
      const x = l.ax - o.x - Math.sin(yaw) * 12, z = l.az - o.z - Math.cos(yaw) * 12;
      return { id: l.id, name: l.name, icon: l.type.warhead === 'nuke' ? '☢️' : '🚀', pose: { position: { x, y: l.y + 0.5, z }, yaw } };
    });
  }

  dispose(): void {
    for (const l of this.list) {
      l.root.removeFromParent();
      this.ctx.physics.removeBody(l.body);
    }
    this.list.length = 0;
  }
}
