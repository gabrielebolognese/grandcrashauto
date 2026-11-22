import * as THREE from 'three';
import { CONFIG } from '../config';
import { Rng } from '../core/rng';
import type { CityData } from '../world/types';
import { randomAppearance, type Appearance } from './appearance';
import { CLIP, type ClipInfo } from './clips';
import { makeBlobMaterial, makeNpcMaterial, type NpcUniforms } from './material';
import type { NavSource, PedNav } from './nav';

/**
 * MINI CROWDS: stationary groups of 8–30 people (audiences, chatting clusters, spectators, queues) rendered as pure
 * static instances. The animation clock runs in the vertex shader (uNpcTime + per-instance offset), so a materialized
 * crowd costs ZERO per-frame CPU and zero uploads: instance buffers are rewritten only when something changes
 * (crowd appears/disappears, LOD switch, visibility set change, a member is taken over by the dynamic system after a
 * hit / scare, or rejoins). 3 draw calls total (mid mesh, far mesh, blob shadows).
 */

export type CrowdKind = 'circle' | 'cluster' | 'arc' | 'queue';

export interface CrowdSite {
  id: number;
  x: number;
  y: number;
  z: number;
  facing: number; // yaw toward the attraction (arc / queue)
  kind: CrowdKind;
  count: number;
  seed: number;
  radius: number;
  ambientId: number; // addAmbientSpot id or -1
  // runtime
  on: boolean;
  gen: number;
  lod: number; // 0 = mid mesh, 1 = far mesh
  vis: boolean;
  d: number; // camera distance (last update)
  spawnT: number;
  n: number; // materialized member count
  mx: Float32Array;
  my: Float32Array;
  mz: Float32Array;
  myaw: Float32Array;
  mclip: Uint8Array;
  moff: Float32Array;
  mrate: Float32Array;
  alive: Uint8Array;
  pend: Uint8Array; // a reaction is queued for this member
  app: Appearance[];
}

const MAXM = 32;
const FLOATS = 16;

export interface CrowdMemberRef {
  x: number;
  y: number;
  z: number;
  yaw: number;
  app: Appearance;
  clip: number;
  time: number;
}

export class CrowdManager {
  readonly sites: CrowdSite[] = [];
  readonly meshes: THREE.InstancedMesh[] = [];
  private attrs: THREE.InstancedBufferAttribute[][] = []; // per mesh: animA, animB, col0, col1, extra
  private blob: THREE.InstancedMesh;
  private blobA: THREE.InstancedBufferAttribute;
  private dirty = true;
  private seq = 0;
  private cap: number;
  private sphere = new THREE.Sphere();
  readonly root = new THREE.Group();
  materialized = 0;
  rebuilds = 0;
  get blobVisible(): boolean {
    return this.blob.visible;
  }

  constructor(
    private clips: ClipInfo[],
    uniforms: NpcUniforms,
    midGeo: THREE.BufferGeometry,
    farGeo: THREE.BufferGeometry,
    private ground: (x: number, z: number) => number,
  ) {
    this.cap = 240;
    [midGeo, farGeo].forEach((g, i) => {
      const geo = g; // caller passes dedicated geometries (own instanced attributes)
      const mk = () => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 4), 4);
        return a;
      };
      const set = [mk(), mk(), mk(), mk(), mk()];
      geo.setAttribute('iAnimA', set[0]);
      geo.setAttribute('iAnimB', set[1]);
      geo.setAttribute('iCol0', set[2]);
      geo.setAttribute('iCol1', set[3]);
      geo.setAttribute('iExtra', set[4]);
      const mesh = new THREE.InstancedMesh(geo, makeNpcMaterial(uniforms, i === 1, true), this.cap);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      mesh.receiveShadow = true;
      mesh.name = `npc-crowd-${i === 0 ? 'mid' : 'far'}`;
      this.meshes.push(mesh);
      this.attrs.push(set);
      this.root.add(mesh);
    });
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.blobA = new THREE.InstancedBufferAttribute(new Float32Array(this.cap), 1);
    plane.setAttribute('iShadow', this.blobA);
    this.blob = new THREE.InstancedMesh(plane, makeBlobMaterial(), this.cap);
    this.blob.frustumCulled = false;
    this.blob.count = 0;
    this.blob.visible = false;
    this.blob.renderOrder = -1;
    this.blob.name = 'npc-crowd-blobs';
    this.root.add(this.blob);
    this.root.name = 'npc-crowds';
    this.root.userData.noOriginShift = true;
  }

  // ───────────── site generation ─────────────
  addSite(x: number, y: number, z: number, kind: CrowdKind, count: number, facing: number, seed: number, ambientId = -1): CrowdSite {
    const c = Math.max(4, Math.min(MAXM - 2, Math.round(count)));
    const radius = kind === 'circle' ? 2.3 + c * 0.075 : kind === 'arc' ? 1.4 + c * 0.16 : 0.9 + Math.sqrt(c) * 0.62;
    const s: CrowdSite = {
      id: ++this.seq, x, y, z, facing, kind, count: c, seed, radius: radius + 0.6, ambientId,
      on: false, gen: 0, lod: 1, vis: false, d: 1e9, spawnT: -100, n: 0,
      mx: new Float32Array(MAXM), my: new Float32Array(MAXM), mz: new Float32Array(MAXM), myaw: new Float32Array(MAXM),
      mclip: new Uint8Array(MAXM), moff: new Float32Array(MAXM), mrate: new Float32Array(MAXM),
      alive: new Uint8Array(MAXM), pend: new Uint8Array(MAXM), app: [],
    };
    this.sites.push(s);
    return s;
  }

  removeSite(s: CrowdSite): void {
    const i = this.sites.indexOf(s);
    if (i >= 0) this.sites.splice(i, 1);
    if (s.on) this.materialized -= s.n;
    s.on = false;
    this.dirty = true;
  }

  /** Deterministic crowd sites from the city data (plazas, beach, park, bus stops, jump ramp, airport, group spots). */
  generate(src: NavSource, data: CityData | null, nav: PedNav, test: boolean): void {
    const seed = CONFIG.game.seed;
    const rng = Rng.from(seed, 0x43524f57);
    const C = CONFIG.npc.crowds;
    const size = () => Math.round(C.sizeMin + (C.sizeMax - C.sizeMin) * Math.pow(rng.next(), 1.6));
    if (test) {
      const a = src.wanderAreas[0];
      if (a) this.addSite((a.minX + a.maxX) / 2 + 2, a.y, (a.minZ + a.maxZ) / 2 + 2, 'circle', 18, 0, rng.int(1, 1e6));
      const sp = data?.spawn.position ?? { x: 0, y: 0, z: 0 };
      this.addSite(sp.x + 37, sp.y, sp.z + 38, 'arc', 16, -Math.PI / 2, rng.int(1, 1e6));
      this.addSite(sp.x - 34, sp.y, sp.z + 2, 'cluster', 12, 0, rng.int(1, 1e6));
      return;
    }
    for (const a of src.wanderAreas) {
      const w = a.maxX - a.minX, d = a.maxZ - a.minZ;
      if (w * d < 160 || w < 10 || d < 10) continue;
      const k = Math.min(3, Math.max(1, Math.floor((w * d) / 2500)));
      for (let i = 0; i < k; i++) {
        const x = a.minX + 5 + rng.next() * (w - 10), z = a.minZ + 5 + rng.next() * (d - 10);
        if (nav.insideBuilding(x, z, 4)) continue;
        const kind: CrowdKind = a.kind === 'plaza' ? (rng.chance(0.5) ? 'circle' : 'cluster') : a.kind === 'beach' ? (rng.chance(0.4) ? 'arc' : 'cluster') : 'cluster';
        this.addSite(x, a.y, z, kind, size(), rng.next() * Math.PI * 2, rng.int(1, 1e6));
      }
    }
    src.groupSpots.forEach((g, i) => {
      if (rng.next() > 0.18 || nav.insideBuilding(g.x, g.z, 2.5)) return;
      this.addSite(g.x, g.y, g.z, 'cluster', 8 + rng.int(0, 5), 0, rng.int(1, 1e6) + i);
    });
    src.busStops.forEach((b) => {
      if (rng.next() > 0.25) return;
      const back = 1.6;
      this.addSite(b.p.x - Math.sin(b.yaw) * back, b.p.y, b.p.z - Math.cos(b.yaw) * back, 'queue', 8 + rng.int(0, 3), b.yaw, rng.int(1, 1e6));
    });
    if (data?.jumpRamp) {
      const r = data.jumpRamp;
      const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw);
      for (const side of [1, -1]) {
        const x = r.position.x + fx * 10 - fz * 15 * side, z = r.position.z + fz * 10 + fx * 15 * side;
        if (nav.insideBuilding(x, z, 3)) continue;
        this.addSite(x, r.position.y, z, 'arc', 16 + rng.int(0, 8), r.yaw + (side * Math.PI) / 2, rng.int(1, 1e6));
      }
    }
    const ap = data?.airport;
    if (ap) {
      const dx = ap.carPark.position.x - ap.terminal.x, dz = ap.carPark.position.z - ap.terminal.z;
      const l = Math.hypot(dx, dz) || 1;
      this.addSite(ap.terminal.x + (dx / l) * 14, ap.terminal.y, ap.terminal.z + (dz / l) * 14, 'cluster', 22, 0, rng.int(1, 1e6));
    }
  }

  insideAny(x: number, z: number, pad: number): CrowdSite | null {
    for (const s of this.sites) {
      const r = s.radius + pad;
      if ((x - s.x) ** 2 + (z - s.z) ** 2 < r * r) return s;
    }
    return null;
  }

  shift(dx: number, dz: number): void {
    for (const s of this.sites) {
      s.x -= dx;
      s.z -= dz;
      for (let i = 0; i < s.n; i++) {
        s.mx[i] -= dx;
        s.mz[i] -= dz;
      }
    }
    this.dirty = true;
  }

  // ───────────── materialization ─────────────
  private materialize(s: CrowdSite, time: number, inView: boolean, density: number, isBlocked: (x: number, z: number) => boolean): void {
    const rng = Rng.from(s.seed, s.id, 0x4d454d);
    const count = Math.max(4, Math.round(s.count * density));
    let n = 0;
    const tryAdd = (x: number, z: number, yaw: number, clip: number) => {
      if (n >= count || isBlocked(x, z)) return;
      for (let j = 0; j < n; j++) if ((s.mx[j] - x) ** 2 + (s.mz[j] - z) ** 2 < 0.4) return;
      s.mx[n] = x;
      s.mz[n] = z;
      s.my[n] = this.ground(x, z);
      if (!Number.isFinite(s.my[n])) s.my[n] = s.y;
      s.myaw[n] = yaw;
      s.mclip[n] = clip;
      s.moff[n] = rng.next() * 8;
      s.mrate[n] = 0.88 + rng.next() * 0.24;
      s.alive[n] = 1;
      s.pend[n] = 0;
      s.app[n] = randomAppearance(Rng.from(s.seed, n, 0x415050));
      n++;
    };
    const pick = (opts: number[], w: number[]) => rng.weighted(opts, w);
    if (s.kind === 'circle') {
      // audience around a street performer
      tryAdd(s.x, s.z, rng.next() * Math.PI * 2, CLIP.cheer);
      const R = s.radius - 0.6;
      const per = Math.max(6, Math.round((Math.PI * 2 * R) / 0.72));
      for (let i = 0; n < count && i < per * 2; i++) {
        const ring = i < per ? 0 : 1;
        const a = ((i % per) + (ring ? 0.5 : 0)) / per * Math.PI * 2 + rng.range(-0.06, 0.06);
        const rr = R + ring * 0.75 + rng.range(-0.12, 0.12);
        const x = s.x + Math.sin(a) * rr, z = s.z + Math.cos(a) * rr;
        tryAdd(x, z, Math.atan2(s.x - x, s.z - z) + rng.range(-0.25, 0.25), pick([CLIP.clap, CLIP.cheer, CLIP.idle, CLIP.armsCrossed, CLIP.phone], [40, 18, 24, 12, 6]));
      }
    } else if (s.kind === 'arc') {
      // spectators in 2-3 rows facing `facing`
      const rows = count > 16 ? 3 : 2;
      const perRow = Math.ceil(count / rows);
      const fx = Math.sin(s.facing), fz = Math.cos(s.facing);
      const rx = -fz, rz = fx;
      for (let r = 0; r < rows; r++) {
        for (let i = 0; i < perRow; i++) {
          const lat = (i - (perRow - 1) / 2) * 0.66 + (r % 2 ? 0.33 : 0) + rng.range(-0.1, 0.1);
          const back = -r * 0.8 + rng.range(-0.1, 0.1);
          tryAdd(s.x + rx * lat + fx * back, s.z + rz * lat + fz * back, s.facing + rng.range(-0.3, 0.3), pick([CLIP.cheer, CLIP.clap, CLIP.idle, CLIP.lookAround, CLIP.phone], [32, 32, 16, 14, 6]));
        }
      }
    } else {
      // chatting cluster / bus queue: sub-groups facing each other
      const subs = Math.max(1, Math.round(count / 4));
      const cx: number[] = [], cz: number[] = [];
      for (let k = 0; k < subs; k++) {
        const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * (s.radius - 1.4);
        cx.push(s.x + Math.sin(a) * r);
        cz.push(s.z + Math.cos(a) * r);
      }
      for (let i = 0; i < count * 3 && n < count; i++) {
        const k = i % subs;
        const a = rng.next() * Math.PI * 2, r = 0.55 + rng.next() * 0.45;
        const x = cx[k] + Math.sin(a) * r, z = cz[k] + Math.cos(a) * r;
        const yaw = s.kind === 'queue' ? s.facing + rng.range(-0.6, 0.6) : Math.atan2(cx[k] - x, cz[k] - z) + rng.range(-0.3, 0.3);
        tryAdd(x, z, yaw, s.kind === 'queue'
          ? pick([CLIP.idle, CLIP.phone, CLIP.lookAround, CLIP.armsCrossed], [30, 30, 20, 20])
          : pick([CLIP.talk, CLIP.idle, CLIP.phone, CLIP.armsCrossed, CLIP.lookAround, CLIP.clap], [32, 26, 14, 14, 8, 6]));
      }
    }
    s.n = n;
    s.on = true;
    s.gen++;
    s.spawnT = inView ? time : time - 10;
    this.materialized += n;
    this.dirty = true;
  }

  private dematerialize(s: CrowdSite): void {
    if (!s.on) return;
    s.on = false;
    this.materialized -= s.n;
    s.n = 0;
    s.app.length = 0;
    this.dirty = true;
  }

  /**
   * Per frame: cheap site-level work only (≈ a dozen sphere tests). Instance buffers are rebuilt only when the
   * visible set / LOD / membership changes.
   */
  update(focus: THREE.Vector3, camPos: THREE.Vector3, frustum: THREE.Frustum, time: number, budget: number, density: number, farSpawn: number, allowPop: boolean, isBlocked: (x: number, z: number) => boolean): void {
    const C = CONFIG.npc.crowds;
    const R = C.materializeR;
    // dematerialize far sites, materialize near ones (nearest first, within the member budget)
    for (const s of this.sites) {
      const d2 = (s.x - focus.x) ** 2 + (s.z - focus.z) ** 2;
      if (s.on && d2 > (R + 25) ** 2) {
        this.sphere.set(this.tmp.set(s.x, s.y + 1, s.z), s.radius + 1);
        const camD = Math.hypot(s.x - camPos.x, s.z - camPos.z);
        if (!frustum.intersectsSphere(this.sphere) || camD > farSpawn + 40) this.dematerialize(s);
      }
    }
    let best: CrowdSite | null = null;
    let bestD = Infinity;
    for (const s of this.sites) {
      if (s.on) continue;
      const d2 = (s.x - focus.x) ** 2 + (s.z - focus.z) ** 2;
      if (d2 > R * R || d2 >= bestD) continue;
      if (this.materialized + s.count > budget) continue;
      best = s;
      bestD = d2;
    }
    if (best) {
      this.sphere.set(this.tmp.set(best.x, best.y + 1, best.z), best.radius + 2 + Math.sqrt(bestD) * 0.4);
      const inView = frustum.intersectsSphere(this.sphere);
      const camD = Math.hypot(best.x - camPos.x, best.z - camPos.z);
      if (!inView || allowPop || camD > farSpawn) this.materialize(best, time, inView, density, isBlocked);
    }
    // visibility + LOD per site
    for (const s of this.sites) {
      if (!s.on) continue;
      const d = Math.hypot(s.x - camPos.x, s.y - camPos.y, s.z - camPos.z);
      s.d = d;
      this.sphere.set(this.tmp.set(s.x, s.y + 1, s.z), s.radius + 1.2 + d * 0.12);
      const vis = frustum.intersectsSphere(this.sphere);
      const lod = d - s.radius < C.midDist ? 0 : 1;
      if (vis !== s.vis || (vis && lod !== s.lod)) {
        s.vis = vis;
        s.lod = lod;
        this.dirty = true;
      }
    }
    if (this.dirty) this.rebuild();
  }
  private tmp = new THREE.Vector3();

  markDirty(): void {
    this.dirty = true;
  }

  private rebuild(): void {
    this.dirty = false;
    this.rebuilds++;
    const counts = [0, 0];
    let nb = 0;
    const blobM = this.blob.instanceMatrix.array as Float32Array;
    const blobA = this.blobA.array as Float32Array;
    const shadowD = CONFIG.npc.shadowDist;
    for (const s of this.sites) {
      if (!s.on || !s.vis) continue;
      const L = s.lod;
      const mesh = this.meshes[L];
      const [aA, aB, c0, c1, ex] = this.attrs[L].map((a) => a.array as Float32Array);
      const m = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < s.n; i++) {
        if (!s.alive[i]) continue;
        const k = counts[L];
        if (k >= this.cap) break;
        counts[L]++;
        const app = s.app[i];
        const sc = app.scale;
        const cs = Math.cos(s.myaw[i]) * sc, sn = Math.sin(s.myaw[i]) * sc;
        const o = k * FLOATS;
        m[o] = cs; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = sc; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = cs; m[o + 11] = 0;
        m[o + 12] = s.mx[i]; m[o + 13] = s.my[i]; m[o + 14] = s.mz[i]; m[o + 15] = 1;
        const q = k * 4;
        const clip = this.clips[s.mclip[i]];
        aA[q] = clip.start;
        aA[q + 1] = clip.frames;
        aA[q + 2] = clip.fps * s.mrate[i];
        aA[q + 3] = s.moff[i];
        aB[q] = s.spawnT;
        aB[q + 1] = 1e9;
        aB[q + 2] = 0;
        aB[q + 3] = 0;
        c0[q] = app.skin; c0[q + 1] = app.top; c0[q + 2] = app.bottom; c0[q + 3] = app.shoes;
        c1[q] = app.hair; c1[q + 1] = app.acc; c1[q + 2] = app.inner; c1[q + 3] = app.flags;
        ex[q] = 0; ex[q + 1] = 0; ex[q + 2] = app.shape; ex[q + 3] = 0;
        if (s.d - s.radius < shadowD) {
          if (nb < this.cap) {
            const bo = nb * 16;
            const w = 0.72 * sc, l = 0.78 * sc;
            blobM[bo] = cs / sc * w; blobM[bo + 1] = 0; blobM[bo + 2] = -sn / sc * w; blobM[bo + 3] = 0;
            blobM[bo + 4] = 0; blobM[bo + 5] = 1; blobM[bo + 6] = 0; blobM[bo + 7] = 0;
            blobM[bo + 8] = sn / sc * l; blobM[bo + 9] = 0; blobM[bo + 10] = cs / sc * l; blobM[bo + 11] = 0;
            blobM[bo + 12] = s.mx[i]; blobM[bo + 13] = s.my[i] + 0.03; blobM[bo + 14] = s.mz[i]; blobM[bo + 15] = 1;
            blobA[nb] = 1;
            nb++;
          }
        }
      }
    }
    for (let L = 0; L < 2; L++) {
      const mesh = this.meshes[L];
      mesh.count = counts[L];
      mesh.visible = counts[L] > 0;
      if (counts[L] > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, counts[L] * 16);
        mesh.instanceMatrix.needsUpdate = true;
        for (const a of this.attrs[L]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, counts[L] * 4);
          a.needsUpdate = true;
        }
      }
    }
    this.blob.count = nb;
    this.blob.visible = nb > 0;
    if (nb > 0) {
      this.blob.instanceMatrix.clearUpdateRanges();
      this.blob.instanceMatrix.addUpdateRange(0, nb * 16);
      this.blob.instanceMatrix.needsUpdate = true;
      this.blobA.clearUpdateRanges();
      this.blobA.addUpdateRange(0, nb);
      this.blobA.needsUpdate = true;
    }
  }

  /** Hand a member over to the dynamic system (it disappears from the static batch). */
  take(s: CrowdSite, i: number, time: number, out: CrowdMemberRef): boolean {
    if (!s.on || !s.alive[i]) return false;
    s.alive[i] = 0;
    s.pend[i] = 0;
    out.x = s.mx[i];
    out.y = s.my[i];
    out.z = s.mz[i];
    out.yaw = s.myaw[i];
    out.app = s.app[i];
    out.clip = s.mclip[i];
    const clip = this.clips[s.mclip[i]];
    out.time = ((time + s.moff[i]) * s.mrate[i]) % clip.duration;
    this.dirty = true;
    return true;
  }

  /** A converted member walks back in: restore it (only if the same materialization is still live). */
  restore(siteId: number, gen: number, i: number): boolean {
    const s = this.sites.find((q) => q.id === siteId);
    if (!s || !s.on || s.gen !== gen || i >= s.n || s.alive[i]) return false;
    s.alive[i] = 1;
    this.dirty = true;
    return true;
  }

  aliveCount(): number {
    let c = 0;
    for (const s of this.sites) if (s.on) for (let i = 0; i < s.n; i++) c += s.alive[i];
    return c;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
    this.blob.dispose();
    this.root.removeFromParent();
  }
}
