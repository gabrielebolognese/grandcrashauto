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
  turret: THREE.Group; // yaw
  rack: THREE.Group; // pitch (tubes + loaded missiles)
  loaded: THREE.Object3D[]; // missile models in the tubes (hidden when fired)
  ready: boolean[];
  reloadT: number[];
  aimYaw: number; // world yaw of the rack
  aimPitch: number;
  body: RAPIER_T.RigidBody | null;
  ax: number; // ABSOLUTE position
  az: number;
  y: number;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const mats = new Map<number, THREE.MeshStandardMaterial>();
const mat = (c: number, metal = 0.25) => {
  let m = mats.get(c);
  if (!m) mats.set(c, (m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: metal })));
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

/** A missile model (nose +Z), shared geometry per kind (loaded in the launchers and flying). */
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
    // hazard stripes
    for (let k = 0; k < 3; k++) {
      const s = new THREE.Mesh(G[4], mat(0x1c1c1c, 0.1));
      s.position.z = L * (0.05 - k * 0.08);
      g.add(s);
    }
  }
  for (const c of g.children) {
    (c as THREE.Mesh).castShadow = true;
  }
  return g;
}

/**
 * AIR-DEFENCE SITES (user request): 5 kinds (Twin Titan, Quad Lancer, Hornet Swarm, Hexa Pike, Doomsday Silo), by the
 * city's places and up in the mountains, each a teleport place. Every site is a truck / pad with a turret and a rack
 * of tubes holding its missiles (visible until fired, reloaded tube by tube).
 */
export class Launchers {
  readonly list: Launcher[] = [];
  private built = false;

  constructor(private ctx: GameContext) {}

  /** Build once the city data (POIs) exists. */
  update(dt: number): void {
    if (!this.built) this.tryBuild();
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
      l.rack.rotation.x = l.type.kind === 'doom' ? 0 : -l.aimPitch;
    }
  }

  private tries = 0;
  private tryBuild(): void {
    const { ctx } = this;
    const pois = ctx.world.data?.pois;
    if (!pois || !ctx.world.data) return;
    // city sites need their place to exist (some appear a little later): retry for a while
    this.tries++;
    const o = ctx.origin.offset;
    const anchor = (id: string) =>
      id === 'airport' ? ctx.world.data!.airport?.carPark : pois.find((q) => q.id === id)?.pose ?? ctx.nav.pois.find((q) => q.id === id)?.pose;
    const missing = LAUNCHER_SITES.some((s) => s.near && !anchor(s.near.poi));
    if (missing && this.tries < 600) return;
    this.built = true;
    for (const site of LAUNCHER_SITES) {
      let ax: number, az: number;
      if (site.near) {
        const p = anchor(site.near.poi);
        if (!p) continue;
        ax = p.position.x + o.x + site.near.dx;
        az = p.position.z + o.z + site.near.dz;
      } else if (site.at) {
        ax = site.at.x;
        az = site.at.z;
      } else continue;
      this.build(site, ax, az);
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

  private build(site: LauncherSite, ax: number, az: number): void {
    const { ctx } = this;
    const t = LAUNCHER_TYPES[site.kind];
    const o = ctx.origin.offset;
    // the lowest corner of the footprint, so it never floats on a slope
    let y = Infinity;
    for (const [dx, dz] of [[0, 0], [4, 4], [-4, 4], [4, -4], [-4, -4]]) y = Math.min(y, this.groundAbs(ax + dx, az + dz));
    const root = new THREE.Group();
    root.name = `launcher-${site.id}`;
    root.position.set(ax - o.x, y, az - o.z);
    root.rotation.y = site.yaw;
    const box = (w: number, h: number, d: number, x: number, yy: number, z: number, c: number, parent: THREE.Object3D = root) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(c));
      m.position.set(x, yy, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const wheel = (x: number, z: number, r: number) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.5, 14).rotateZ(Math.PI / 2), mat(0x1d1f22, 0));
      m.position.set(x, r, z);
      root.add(m);
    };
    const turret = new THREE.Group();
    const rack = new THREE.Group();
    let pivotY = 3;
    if (t.kind === 'doom') {
      // silo: concrete pad, blast doors, the nuke standing in its open shaft
      box(14, 0.6, 14, 0, 0.3, 0, 0x9a978e);
      box(5.4, 1.4, 5.4, 0, 1.0, 0, t.body);
      box(2.5, 0.25, 5.2, -2.9, 1.8, 0, 0xc9a227);
      box(2.5, 0.25, 5.2, 2.9, 1.8, 0, 0xc9a227);
      for (const [x, z] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) box(0.5, 4, 0.5, x, 2, z, 0xd8d4c8);
      box(3, 2.4, 2, 5, 1.8, -4.5, 0x6a6a64); // control bunker
      pivotY = 1.6;
    } else {
      const L = Math.max(7, t.missileLen + 3), W = t.kind === 'hornet' ? 2.6 : 3.1;
      box(W, 1.0, L, 0, 1.2, 0, t.body); // chassis
      box(W, 1.6, 2.2, 0, 2.2, L / 2 - 1.1, t.body); // cab
      box(W * 0.9, 0.5, 0.05, 0, 2.5, L / 2 + 0.02, 0x2b3542); // windscreen
      const n = Math.max(2, Math.round(L / 2.6));
      for (let k = 0; k < n; k++) {
        const z = -L / 2 + 1 + (k * (L - 2)) / Math.max(1, n - 1);
        wheel(W / 2 + 0.1, z, 0.55);
        wheel(-W / 2 - 0.1, z, 0.55);
      }
      // stabiliser legs
      for (const sx of [1, -1]) box(0.3, 1.2, 0.3, sx * (W / 2 + 0.6), 0.6, -L / 2 + 1.2, 0x3c3f36);
      pivotY = 2.6;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.6, 18), mat(t.rack));
      ring.position.y = 0.3;
      turret.add(ring);
    }
    turret.position.set(0, pivotY, t.kind === 'doom' ? 0 : -1);
    root.add(turret);
    rack.position.y = t.kind === 'doom' ? 0 : 0.9;
    turret.add(rack);
    const loaded: THREE.Object3D[] = [];
    if (t.kind === 'doom') {
      const m = missileModel(t);
      m.rotation.x = -Math.PI / 2; // nose up
      m.position.set(0, t.missileLen / 2 - 1.2, 0);
      rack.add(m);
      loaded.push(m);
    } else {
      // the launch box around the tubes
      const xs = t.tubes.map((p) => p[0]), ys = t.tubes.map((p) => p[1]);
      const bw = Math.max(...xs) - Math.min(...xs) + t.missileR * 3.2;
      const bh = Math.max(...ys) - Math.min(...ys) + t.missileR * 3.2;
      const bl = t.missileLen * 1.02;
      box(bw, bh, bl, 0, 0, 0, t.rack, rack);
      for (const tube of t.tubes) {
        const mouth = new THREE.Mesh(new THREE.CylinderGeometry(t.missileR * 1.25, t.missileR * 1.25, 0.08, 14).rotateX(Math.PI / 2), mat(0x15171a, 0));
        mouth.position.set(tube[0], tube[1], bl / 2 + 0.03);
        rack.add(mouth);
        const m = missileModel(t);
        m.position.set(tube[0], tube[1], bl / 2 - t.missileLen / 2 + 0.05);
        rack.add(m);
        loaded.push(m);
      }
    }
    ctx.engine.scene.add(root);
    // a solid block for cars to bump into
    const body = ctx.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(root.position.x, y, root.position.z).setRotation(_q.setFromAxisAngle(_v.set(0, 1, 0), site.yaw)));
    const half = t.kind === 'doom' ? new THREE.Vector3(7, 1.2, 7) : new THREE.Vector3(1.6, 1.6, Math.max(7, t.missileLen + 3) / 2);
    const col = ctx.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setTranslation(0, half.y, 0).setCollisionGroups(groups(G.WORLD, G.ALL)), body);
    ctx.physics.tag(col, { kind: 'staticProp', material: 'metal' });
    this.list.push({
      id: site.id, name: site.name, type: t, site, root, turret, rack, loaded,
      ready: loaded.map(() => true), reloadT: loaded.map(() => 0),
      aimYaw: site.yaw, aimPitch: 0.5, body, ax, az, y,
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

  /** The turret pivot in world space. */
  pivot(l: Launcher, out: THREE.Vector3): THREE.Vector3 {
    l.root.updateMatrixWorld(true);
    return l.rack.getWorldPosition(out);
  }

  get pois(): { id: string; name: string; icon: string; pose: { position: { x: number; y: number; z: number }; yaw: number } }[] {
    const o = this.ctx.origin.offset;
    return this.list.map((l) => {
      // park the car a little behind the launcher, facing it
      const yaw = l.site.yaw;
      const x = l.ax - o.x - Math.sin(yaw) * 14, z = l.az - o.z - Math.cos(yaw) * 14;
      return { id: l.id, name: `${l.name} (${l.type.name})`, icon: l.type.kind === 'doom' ? '☢️' : '🚀', pose: { position: { x, y: l.y + 0.5, z }, yaw } };
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
