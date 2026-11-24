import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { G, RAPIER, groups } from '../core/Physics';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { GameContext, GameSystem } from '../game/contracts';

type Kind = 'keep' | 'watch' | 'redroof' | 'wizard' | 'crystal' | 'moon' | 'sky';

interface TowerDef {
  id: string;
  name: string;
  kind: Kind;
  at: { x: number; z: number }; // ABSOLUTE
  fantasy: boolean;
}

/** User request (an Instagram comment asked for "towers"…): medieval towers and fantasy towers, all crashable. */
const DEFS: TowerDef[] = [
  { id: 'tower-keep', name: 'Old Keep', kind: 'keep', at: { x: 1050, z: -800 }, fantasy: false },
  { id: 'tower-watch', name: 'Watchtower', kind: 'watch', at: { x: 1500, z: 120 }, fantasy: false },
  { id: 'tower-redroof', name: 'Red Roof Tower', kind: 'redroof', at: { x: 2300, z: -1700 }, fantasy: false },
  { id: 'tower-wizard', name: "Wizard's Spire", kind: 'wizard', at: { x: -350, z: -1500 }, fantasy: true },
  { id: 'tower-crystal', name: 'Crystal Spire', kind: 'crystal', at: { x: 1800, z: -3000 }, fantasy: true },
  { id: 'tower-moon', name: 'Moon Tower', kind: 'moon', at: { x: 3400, z: -900 }, fantasy: true },
  { id: 'tower-sky', name: 'Sky Citadel Spire', kind: 'sky', at: { x: 700, z: -2400 }, fantasy: true },
];

interface Segment {
  mesh: THREE.Mesh;
  body: RAPIER_T.RigidBody;
  y0: number; // bottom, above the tower base
  y1: number;
}

interface Tower {
  def: TowerDef;
  base: THREE.Vector3; // LOCAL position of the foot
  height: number;
  radius: number;
  segs: Segment[];
  spin: THREE.Object3D[]; // floating rings / crystals (children of the top segment)
  glows: THREE.Sprite[];
  broken: boolean;
  settleT: number;
  ax: number;
  az: number;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

// ── geometry helpers: non-indexed, vertex-coloured, merged per segment (1 draw call each) ──
function paint(g: THREE.BufferGeometry, hex: number, vary: number, seed: number): THREE.BufferGeometry {
  const p = g.index ? g.toNonIndexed() : g;
  p.deleteAttribute('uv');
  const n = p.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const base = new THREE.Color(hex);
  for (let f = 0; f < n; f += 3) {
    // per-face variation: stone blocks / crystal facets
    const r = Math.sin((f + seed * 131) * 12.9898) * 43758.5453;
    const k = 1 + (r - Math.floor(r) - 0.5) * vary;
    _c.copy(base).multiplyScalar(k);
    for (let j = 0; j < 3; j++) _c.toArray(arr, (f + j) * 3);
  }
  p.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return p;
}
const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0) => g.applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z));

function merlons(r: number, y: number, n: number, w: number, h: number, hex: number, seed: number, square = false): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  if (square) {
    const per = Math.max(2, Math.round(n / 4));
    for (let s = 0; s < 4; s++)
      for (let k = 0; k < per; k++) {
        const t = (k + 0.5) / per - 0.5;
        const a = (s * Math.PI) / 2;
        const x = Math.cos(a) * r - Math.sin(a) * t * 2 * r, z = Math.sin(a) * r + Math.cos(a) * t * 2 * r;
        out.push(paint(at(new THREE.BoxGeometry(w, h, w), x, y + h / 2, z, a), hex, 0.12, seed + s * 10 + k));
      }
    return out;
  }
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push(paint(at(new THREE.BoxGeometry(w, h, w * 0.7), Math.cos(a) * r, y + h / 2, Math.sin(a) * r, -a), hex, 0.12, seed + k));
  }
  return out;
}

/**
 * TOWERS (user request, from an Instagram comment: "add towers" — taken literally): three medieval stone towers and
 * four fantasy spires in the countryside around the city, each a teleport place.
 *  - Built from stacked sections, each one solid (a plane hitting it crashes) and one draw call.
 *  - A crash, a missile, a nuke or a car blast close by brings it down: everything above the hit topples the way the
 *    hit was going, a hit low down drops the whole tower; the stump stays.
 *  - Fantasy spires have floating rings and crystals that turn slowly and glow (much brighter at night).
 */
export class Towers implements GameSystem {
  readonly name = 'towers';
  readonly list: Tower[] = [];
  private built = false;
  private stone = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  private shiny = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.7 });
  private crystal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.1, emissive: 0xffffff, emissiveIntensity: 0.25, transparent: true, opacity: 0.88 });
  private glowMat: THREE.SpriteMaterial | null = null;
  private visT = 0;
  private t = 0;

  constructor(private ctx: GameContext) {}

  init(): void {
    const ev = this.ctx.events;
    ev.on('planeImpact', (e) => {
      if (!e.replay && e.outcome !== 'landing') this.hit(e.position, e.velocity, 25);
    });
    ev.on('planeExplosion', (e) => {
      if (!e.replay) this.hit(e.position, e.velocity, e.radius + 8);
    });
    ev.on('explosion', (e) => this.hit(e.position, null, e.radius + 4));
    ev.on('originShift', ({ delta }) => {
      for (const t of this.list) t.base.sub(delta);
    });
  }

  /** Teleport places (the car parks a little away from the foot). */
  get pois(): { id: string; name: string; icon: string; pose: { position: { x: number; y: number; z: number }; yaw: number } }[] {
    return this.list.map((t) => ({
      id: t.def.id, name: t.def.name, icon: t.def.fantasy ? '🔮' : '🏰',
      pose: { position: { x: t.base.x + t.radius + 18, y: t.base.y + 0.5, z: t.base.z + t.radius + 18 }, yaw: Math.PI * 1.25 },
    }));
  }

  /** Where to aim a crash at a tower near (ax, az) ABSOLUTE: 60 % of its height (absolute y), else null. */
  aimAt(ax: number, az: number): number | null {
    for (const t of this.list) if (Math.hypot(t.ax - ax, t.az - az) < 40 && !t.broken) return t.base.y + t.height * 0.6;
    return null;
  }

  private ground(x: number, z: number): number {
    try {
      const g = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(g) ? g : 0;
    } catch {
      return 0;
    }
  }

  private build(): void {
    const o = this.ctx.origin.offset;
    for (const d of DEFS) {
      const lx = d.at.x - o.x, lz = d.at.z - o.z;
      let y = Infinity;
      for (const [dx, dz] of [[0, 0], [5, 5], [-5, 5], [5, -5], [-5, -5]]) y = Math.min(y, this.ground(lx + dx, lz + dz));
      const t: Tower = { def: d, base: new THREE.Vector3(lx, y - 0.3, lz), height: 0, radius: 0, segs: [], spin: [], glows: [], broken: false, settleT: 0, ax: d.at.x, az: d.at.z };
      this.shape(t);
      this.list.push(t);
    }
  }

  /** One solid section: merged geometry + a fixed body with its collider (cylinder or box). */
  private seg(t: Tower, parts: THREE.BufferGeometry[], y0: number, y1: number, collider: { r?: number; hx?: number; hz?: number }, mat = this.stone): Segment {
    const geo = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    const cy = (y0 + y1) / 2;
    geo.translate(0, -cy, 0); // origin at the section centre (it rotates about it when it falls)
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(t.base.x, t.base.y + cy, t.base.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `${t.def.id}-seg`;
    this.ctx.engine.scene.add(mesh);
    const P = this.ctx.physics;
    const body = P.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(mesh.position.x, mesh.position.y, mesh.position.z));
    const hh = (y1 - y0) / 2;
    const desc = collider.r !== undefined ? RAPIER.ColliderDesc.cylinder(hh, collider.r) : RAPIER.ColliderDesc.cuboid(collider.hx!, hh, collider.hz!);
    const col = P.world.createCollider(desc.setDensity(450).setFriction(0.8).setCollisionGroups(groups(G.WORLD, G.ALL)), body);
    P.tag(col, { kind: 'building', material: 'concrete' });
    const s: Segment = { mesh, body, y0, y1 };
    t.segs.push(s);
    return s;
  }

  private glow(parent: THREE.Object3D, y: number, size: number, hex: number, t: Tower): void {
    if (!this.glowMat) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d')!;
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.3, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(cv);
      this.glowMat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
    }
    const m = this.glowMat.clone();
    m.color.set(hex);
    const s = new THREE.Sprite(m);
    s.position.y = y;
    s.userData.size = size;
    s.renderOrder = 5;
    parent.add(s);
    t.glows.push(s);
  }

  private shape(t: Tower): void {
    const k = t.def.kind;
    const STONE = 0x9c968a, DARK = 0x6e6a62, SLIT = 0x24211e;
    if (k === 'keep' || k === 'redroof') {
      // round stone tower: tapering drums with arrow slits; battlements (keep) or a red cone roof
      const R0 = k === 'keep' ? 6.2 : 5, n = k === 'keep' ? 5 : 6, h = 6.2;
      t.radius = R0;
      for (let i = 0; i < n; i++) {
        const r0 = R0 * (1 - 0.018 * i), r1 = R0 * (1 - 0.018 * (i + 1));
        const parts = [paint(at(new THREE.CylinderGeometry(r1, r0, h, 16), 0, i * h + h / 2, 0), i === 0 ? DARK : STONE, 0.22, i)];
        if (i % 2 === 1) for (let w = 0; w < 4; w++) {
          const a = (w / 4) * Math.PI * 2 + i;
          parts.push(paint(at(new THREE.BoxGeometry(0.5, 1.8, 0.4), Math.cos(a) * (r0 - 0.05), i * h + h / 2, Math.sin(a) * (r0 - 0.05), -a), SLIT, 0, 0));
        }
        this.seg(t, parts, i * h, (i + 1) * h, { r: (r0 + r1) / 2 });
      }
      const y = n * h;
      if (k === 'keep') {
        const r = R0 * (1 - 0.018 * n);
        const parts = [paint(at(new THREE.CylinderGeometry(r + 0.6, r, 1.2, 16), 0, y + 0.6, 0), STONE, 0.18, 99), ...merlons(r + 0.3, y + 1.2, 14, 1.3, 1.4, STONE, 7)];
        // flag
        parts.push(paint(at(new THREE.CylinderGeometry(0.08, 0.08, 7, 6), 0, y + 4.7, 0), 0x3a2e22, 0, 0));
        parts.push(paint(at(new THREE.BoxGeometry(3, 1.8, 0.05), 1.55, y + 7.2, 0), 0xc8302a, 0, 0));
        this.seg(t, parts, y, y + 2.6, { r: r + 0.6 });
        t.height = y + 8;
      } else {
        const r = R0 * (1 - 0.018 * n);
        const parts = [paint(at(new THREE.CylinderGeometry(r + 0.4, r, 0.8, 16), 0, y + 0.4, 0), STONE, 0.15, 3), paint(at(new THREE.ConeGeometry(r + 1.4, 11, 16), 0, y + 0.8 + 5.5, 0), 0xb4412f, 0.18, 8)];
        parts.push(paint(at(new THREE.CylinderGeometry(0.05, 0.05, 3, 6), 0, y + 13, 0), 0x3a2e22, 0, 0));
        parts.push(paint(at(new THREE.BoxGeometry(1.6, 0.9, 0.04), 0.82, y + 14, 0), 0xffd23f, 0, 0));
        this.seg(t, parts, y, y + 11.8, { r: r + 0.4 });
        t.height = y + 14.5;
      }
    } else if (k === 'watch') {
      // square watchtower: stone storeys, a timber lookout with a pyramid roof
      const W = 3, h = 5.5, n = 4;
      t.radius = W * 1.4;
      for (let i = 0; i < n; i++) {
        const parts = [paint(at(new THREE.BoxGeometry(W * 2, h, W * 2), 0, i * h + h / 2, 0), i === 0 ? DARK : STONE, 0.22, 20 + i)];
        parts.push(paint(at(new THREE.BoxGeometry(0.6, 1.6, 0.1), 0, i * h + h / 2, W + 0.02), SLIT, 0, 0));
        this.seg(t, parts, i * h, (i + 1) * h, { hx: W, hz: W });
      }
      const y = n * h;
      const parts = [
        paint(at(new THREE.BoxGeometry(W * 2 + 1, 0.6, W * 2 + 1), 0, y + 0.3, 0), 0x6b4f32, 0.15, 5),
        ...merlons(W + 0.2, y + 0.6, 12, 1, 1.2, STONE, 30, true),
        paint(at(new THREE.ConeGeometry(W * 1.75, 5, 4), 0, y + 4.6, 0, Math.PI / 4), 0x5c4a3a, 0.15, 9),
      ];
      for (const [x, z] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) parts.push(paint(at(new THREE.BoxGeometry(0.3, 2.4, 0.3), x * W, y + 1.8, z * W), 0x4a3828, 0, 0));
      this.seg(t, parts, y, y + 7, { hx: W + 0.5, hz: W + 0.5 });
      t.height = y + 7;
    } else if (k === 'wizard') {
      // wizard's spire: a slim twisting tower, a balcony, a purple hat roof with a curled tip, a floating crystal
      const n = 9, h = 7;
      t.radius = 4.4;
      for (let i = 0; i < n; i++) {
        const r0 = 4.4 - i * 0.16, r1 = 4.4 - (i + 1) * 0.16;
        const parts = [paint(at(new THREE.CylinderGeometry(r1, r0, h, 10), 0, i * h + h / 2, 0, i * 0.18), i % 3 === 2 ? 0x7d7a8c : 0x8e8a9a, 0.2, 40 + i)];
        if (i % 2 === 0) for (let w = 0; w < 3; w++) {
          const a = (w / 3) * Math.PI * 2 + i * 0.7;
          parts.push(paint(at(new THREE.BoxGeometry(0.7, 1.4, 0.3), Math.cos(a) * r0, i * h + h * 0.5, Math.sin(a) * r0, -a), 0x2a2140, 0, 0));
        }
        if (i === 6) parts.push(paint(at(new THREE.TorusGeometry(r0 + 0.5, 0.35, 6, 18).rotateX(Math.PI / 2), 0, i * h + 0.4, 0), 0x6a5a8c, 0.1, 3));
        this.seg(t, parts, i * h, (i + 1) * h, { r: (r0 + r1) / 2 });
      }
      const y = n * h, r = 4.4 - n * 0.16;
      const roof = [paint(at(new THREE.ConeGeometry(r + 2.2, 14, 12), 0, y + 7, 0), 0x5b3d9e, 0.16, 50)];
      roof.push(paint(at(new THREE.ConeGeometry(0.9, 4, 8).rotateZ(-0.9), 1.6, y + 14.5, 0), 0x5b3d9e, 0.1, 51));
      roof.push(paint(at(new THREE.SphereGeometry(0.45, 8, 6), 3.1, y + 15.6, 0), 0xffd23f, 0, 0));
      const top = this.seg(t, roof, y, y + 14, { r: r + 1.2 });
      const crystal = new THREE.Mesh(paint(new THREE.OctahedronGeometry(1.6, 0).scale(1, 1.7, 1), 0x5ff2ff, 0.2, 9), this.crystal);
      crystal.position.y = 14 + 6 - (14 / 2);
      top.mesh.add(crystal);
      t.spin.push(crystal);
      this.glow(top.mesh, crystal.position.y, 14, 0x6ff6ff, t);
      t.height = y + 22;
    } else if (k === 'crystal') {
      // crystal spire: a rock base and stacked leaning crystal prisms, glowing
      t.radius = 6;
      this.seg(t, [paint(at(new THREE.CylinderGeometry(4.5, 6.5, 6, 7), 0, 3, 0), 0x6e675e, 0.3, 60)], 0, 6, { r: 5.4 });
      this.seg(t, [paint(at(new THREE.CylinderGeometry(3.4, 4.6, 5, 7), 0, 8.5, 0), 0x7a7268, 0.3, 61)], 6, 11, { r: 4 });
      const cols = [0xd16bff, 0x5ff2ff, 0xff6bd5, 0x7f8bff, 0x5ff2ff, 0xd16bff];
      let y = 11;
      for (let i = 0; i < 6; i++) {
        const h = 9 - i * 0.8, r = 3.4 - i * 0.42;
        const parts = [paint(at(new THREE.CylinderGeometry(r * 0.82, r, h, 6), 0, y + h / 2, 0, i * 0.5), cols[i], 0.3, 70 + i)];
        for (let s = 0; s < 3; s++) {
          const a = (s / 3) * Math.PI * 2 + i;
          parts.push(paint(at(new THREE.OctahedronGeometry(r * 0.5, 0).scale(0.6, 1.8, 0.6), Math.cos(a) * r * 0.95, y + h * 0.4, Math.sin(a) * r * 0.95), cols[(i + s + 1) % 6], 0.3, 80 + i * 3 + s));
        }
        const s = this.seg(t, parts, y, y + h, { r: r * 0.9 }, this.crystal);
        if (i % 2 === 1) this.glow(s.mesh, 0, 10 + r * 3, cols[i], t);
        y += h;
      }
      const tip = new THREE.Mesh(paint(new THREE.OctahedronGeometry(1.2, 0).scale(1, 2.2, 1), 0xffffff, 0.1, 9), this.crystal);
      const last = t.segs[t.segs.length - 1];
      tip.position.y = (last.y1 - last.y0) / 2 + 3.5;
      last.mesh.add(tip);
      t.spin.push(tip);
      this.glow(last.mesh, tip.position.y, 16, 0xff9bff, t);
      t.height = y + 6;
    } else if (k === 'moon' || k === 'sky') {
      // moon tower / sky citadel spire: slender white towers with gold bands, floating gold rings, a beacon crystal
      const sky = k === 'sky';
      const n = sky ? 14 : 10, h = sky ? 12 : 9, R0 = sky ? 6.5 : 3.8, R1 = sky ? 2.6 : 2;
      t.radius = R0;
      for (let i = 0; i < n; i++) {
        const r0 = R0 + (R1 - R0) * (i / n), r1 = R0 + (R1 - R0) * ((i + 1) / n);
        const parts = [paint(at(new THREE.CylinderGeometry(r1, r0, h, 14), 0, i * h + h / 2, 0), sky ? 0xe8eef8 : 0xf2efe6, 0.06, 90 + i)];
        if (i % 3 === 2) parts.push(paint(at(new THREE.CylinderGeometry(r1 + 0.25, r1 + 0.25, 0.7, 14), 0, (i + 1) * h - 0.35, 0), 0xd4a937, 0.05, 0));
        if (i % 2 === 0) for (let w = 0; w < 4; w++) {
          const a = (w / 4) * Math.PI * 2 + i * 0.4;
          parts.push(paint(at(new THREE.BoxGeometry(0.6, 2.2, 0.2), Math.cos(a) * r0, i * h + h / 2, Math.sin(a) * r0, -a), 0x3a5a8c, 0, 0));
        }
        this.seg(t, parts, i * h, (i + 1) * h, { r: (r0 + r1) / 2 });
      }
      const y = n * h;
      const spireH = sky ? 30 : 18;
      const top = this.seg(t, [paint(at(new THREE.ConeGeometry(R1 + 0.6, spireH, 14), 0, y + spireH / 2, 0), 0xd4a937, 0.08, 99)], y, y + spireH, { r: R1 * 0.7 }, this.shiny);
      // floating rings around the upper tower, turning
      const rings = sky ? 3 : 2;
      for (let i = 0; i < rings; i++) {
        const ring = new THREE.Mesh(paint(new THREE.TorusGeometry(R1 + 3 + i * 1.6, 0.35, 6, 32).rotateX(Math.PI / 2 + 0.25 * (i % 2 ? 1 : -1)), 0xd4a937, 0.05, i), this.shiny);
        ring.position.y = -spireH / 2 - 6 - i * (sky ? 14 : 8);
        top.mesh.add(ring);
        t.spin.push(ring);
      }
      const beacon = new THREE.Mesh(paint(new THREE.OctahedronGeometry(sky ? 2.4 : 1.4, 0).scale(1, 1.6, 1), sky ? 0x8fd0ff : 0xfff2b0, 0.15, 5), this.crystal);
      beacon.position.y = spireH / 2 + (sky ? 7 : 4);
      top.mesh.add(beacon);
      t.spin.push(beacon);
      this.glow(top.mesh, beacon.position.y, sky ? 40 : 16, sky ? 0x9fdcff : 0xfff0b0, t);
      t.height = y + spireH + (sky ? 12 : 7);
    }
  }

  // ───────────────────────────── collapse ─────────────────────────────
  /** A crash / blast at `pos` (LOCAL): a tower within `reach` comes down from the height it was hit at. */
  private hit(pos: THREE.Vector3, vel: THREE.Vector3 | null, reach: number): void {
    for (const t of this.list) {
      const dh = Math.hypot(pos.x - t.base.x, pos.z - t.base.z);
      const hy = pos.y - t.base.y;
      if (dh > t.radius + reach || hy < -reach || hy > t.height + reach) continue;
      this.collapse(t, pos, vel, clamp01(hy / t.height));
    }
  }

  private collapse(t: Tower, pos: THREE.Vector3, vel: THREE.Vector3 | null, at01: number): void {
    const { ctx } = this;
    const hitY = at01 * t.height;
    const low = at01 < 0.2;
    // the push: the way the hit was going (or out from the blast), mostly horizontal
    const push = new THREE.Vector3();
    if (vel && vel.lengthSq() > 4) push.copy(vel).setY(0);
    if (push.lengthSq() < 1e-3) push.set(t.base.x - pos.x, 0, t.base.z - pos.z);
    if (push.lengthSq() < 1e-3) push.set(1, 0, 0);
    push.normalize();
    const speed = vel ? Math.min(60, vel.length()) : 25;
    let n = 0;
    for (const s of t.segs) {
      if (s.body.isDynamic()) continue;
      const above = s.y1 > hitY - 3;
      if (!above && !low) continue;
      s.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      const near = Math.max(0, 1 - Math.abs((s.y0 + s.y1) / 2 - hitY) / 25);
      const up = (s.y0 + s.y1) / 2 - hitY;
      // above the hit: tips over with the push (higher = faster); at the hit: blasted out
      const v = push.clone().multiplyScalar(speed * (0.12 + 0.35 * near) + Math.max(0, up) * 0.08);
      v.y = near * 4;
      s.body.setLinvel(v, true);
      const axis = _v.set(push.z, 0, -push.x); // tip over toward the push
      const w = 0.25 + Math.max(0, up) * 0.012 + near * 0.8;
      s.body.setAngvel({ x: axis.x * w + (Math.random() - 0.5) * 0.3, y: (Math.random() - 0.5) * 0.4, z: axis.z * w + (Math.random() - 0.5) * 0.3 }, true);
      n++;
    }
    if (!n) return;
    t.broken = true;
    t.settleT = 0;
    const p = new THREE.Vector3(t.base.x, t.base.y + hitY, t.base.z);
    ctx.fx.dust(p, 3, t.def.fantasy ? 0xcfc8ff : 0xb8b0a0);
    ctx.fx.debrisBurst?.({ position: p, velocity: push.clone().multiplyScalar(speed * 0.3), count: 26, size: 1.1, kind: 'panel' });
    ctx.fx.sparks(p, _v.set(0, 1, 0), t.def.fantasy ? 1.6 : 0.8);
    ctx.events.emit('toast', { text: `🏰 ${t.def.name} is coming down!`, ms: 1800 });
  }

  // ───────────────────────────── per frame ─────────────────────────────
  update(dt: number): void {
    const { ctx } = this;
    if (!this.built) {
      if (!ctx.world.data || ctx.game.state === 'boot') return;
      this.built = true;
      this.build();
    }
    this.t += dt;
    const night = GLOBAL_UNIFORMS.uNight.value;
    this.crystal.emissiveIntensity = 0.25 + 1.4 * night;
    const cam = ctx.engine.camera.position;
    this.visT -= dt;
    const vis = this.visT <= 0;
    if (vis) this.visT = 0.5;
    for (const t of this.list) {
      if (vis) {
        const d = Math.hypot(cam.x - t.base.x, cam.z - t.base.z);
        const far = t.def.kind === 'sky' ? 12000 : 5000;
        for (const s of t.segs) s.mesh.visible = d < far;
      }
      for (let i = 0; i < t.spin.length; i++) {
        const o = t.spin[i];
        o.rotation.y += dt * (i % 2 ? -0.25 : 0.35);
      }
      for (const g of t.glows) {
        const d = cam.distanceTo(g.getWorldPosition(_v));
        const k = (g.userData.size as number) * (0.45 + 0.9 * night) * (1 + Math.max(0, d - 400) / 1500) * (0.92 + 0.08 * Math.sin(this.t * 2.3));
        g.scale.set(k, k, 1);
      }
      if (!t.broken) continue;
      // fallen sections: meshes follow their bodies whenever they move (a later crash can knock them again)
      t.settleT += dt;
      for (const s of t.segs) {
        if (!s.body.isDynamic() || s.body.isSleeping()) continue;
        const p = s.body.translation(), q = s.body.rotation();
        s.mesh.position.set(p.x, p.y, p.z);
        s.mesh.quaternion.set(q.x, q.y, q.z, q.w);
        // far from you there are no ground colliders: rest on the analytic ground, then freeze
        const gy = this.ground(p.x, p.z);
        if (p.y < gy - 1 || (t.settleT > 25 && !s.body.isSleeping())) {
          if (p.y < gy - 1) s.body.setTranslation({ x: p.x, y: gy + 1, z: p.z }, true);
          s.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
        }
      }
    }
    void _q;
  }

  dispose(): void {
    for (const t of this.list) for (const s of t.segs) {
      s.mesh.removeFromParent();
      s.mesh.geometry.dispose();
      this.ctx.physics.removeBody(s.body);
    }
    this.list.length = 0;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
