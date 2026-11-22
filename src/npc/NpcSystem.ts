import * as THREE from 'three';
import type RAPIER_T from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { RAPIER, G, groups } from '../core/Physics';
import { Rng } from '../core/rng';
import type { GameContext, INpcSystem } from '../game/contracts';
import { chunkIndex, type Bench, type Vec3, type WanderArea } from '../world/types';
import { ACT, Npc, S, type AmbientSpot, type Group } from './agent';
import { PHONE_BIT, randomAppearance, type Appearance } from './appearance';
import { bakeClips, CLIP, FLEE_STRIDE, RUN_STRIDE, SEAT_H, SIT_BACK, SIT_STAND_Z, WALK_STRIDE, type ClipInfo } from './clips';
import { makeBlobMaterial, makeNpcDepthMaterial, makeNpcMaterial, makeNpcUniforms, type NpcUniforms } from './material';
import { buildFar, buildHero, buildMid } from './model';
import { PedNav, type AvoidOut, type NearestHit, type NavSource } from './nav';
import { HIP_H, LIE_H } from './rig';
import { buildTestWorld, type TestWorld } from './testWorld';
import { CrowdManager, type CrowdMemberRef, type CrowdSite } from './crowds';

/**
 * Pedestrian crowd (spec §8): pooled NPCs with a per-NPC state machine on the ped graph, groups, benches, bus stops,
 * wander areas, ambient spots; reactions to horn / fast cars / hits / explosions; physics-capsule knockdowns;
 * instanced GPU-skinned rendering (3 LOD meshes + 1 blob-shadow mesh = 4 draw calls).
 */

const TAU = Math.PI * 2;
const SIT_HIP_LOCAL = SEAT_H + 0.114; // pelvis pivot above the seated origin (scale 1)
const LOOK_AHEAD = 1.6;
const RADIUS = 0.27;

const wrap = (a: number) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const rand = Math.random;
const rr = (a: number, b: number) => a + (b - a) * rand();

interface LodMesh {
  mesh: THREE.InstancedMesh;
  animA: THREE.InstancedBufferAttribute;
  animB: THREE.InstancedBufferAttribute;
  col0: THREE.InstancedBufferAttribute;
  col1: THREE.InstancedBufferAttribute;
  extra: THREE.InstancedBufferAttribute;
  count: number;
  tris: number;
}

/** A staggered reaction (explosion shockwave, crowd take-over). kind: 0 knock, 1 panic flee, 2 calm step-aside, 3 dive, 4 hop. */
interface Pending {
  active: boolean;
  t: number;
  kind: number;
  npc: number;
  site: number;
  member: number;
  gen: number;
  vx: number;
  vy: number;
  vz: number;
  wx: number;
  wy: number;
  wz: number;
}

interface Rag {
  body: RAPIER_T.RigidBody;
  npc: number;
  t: number;
  prev: THREE.Vector3;
  curr: THREE.Vector3;
  prevQ: THREE.Quaternion;
  currQ: THREE.Quaternion;
}

export class NpcSystem implements INpcSystem {
  readonly name = 'npcs';
  activeCount = 0;
  /** Debug / perf info (exposed via window.__game.ctx.npcs.debug). */
  readonly debug = {
    crowdSites: 0,
    crowdMembers: 0,
    crowdRebuilds: 0,
    pending: 0,
    updateMs: 0,
    fixedMs: 0,
    active: 0,
    desired: 0,
    visible: 0,
    lod: [0, 0, 0],
    tris: [0, 0, 0],
    ragdolls: 0,
    testMode: false,
    hidden: false,
    drawCalls: 4,
    knocked: 0,
    hits: 0,
  };

  private npcs: Npc[] = [];
  private clips: ClipInfo[] = [];
  private uniforms!: NpcUniforms;
  private lods: LodMesh[] = [];
  private blob!: THREE.InstancedMesh;
  private blobA!: THREE.InstancedBufferAttribute;
  private root = new THREE.Group();
  private nav!: PedNav;
  private testWorld: TestWorld | null = null;
  private benchList: Bench[] = [];
  private benchOcc: number[][] = [];
  private benchOff: boolean[] = [];
  private stopWaiters: number[] = [];
  private groupsArr: Group[] = [];
  private spotGroup: number[] = [];
  private spots: AmbientSpot[] = [];
  private spotSeq = 0;
  private rags: Rag[] = [];
  private poolSize = 0;
  private spawnSeq = 0;
  private started = false;
  private fillT = 0; // s of "initial fill" (in-view spawns allowed)
  private hidden = false;
  private worldCheckT = 0;
  private startleT = 0;
  private hornT = 0;
  private emaUpdate = 0;
  private emaFixed = 0;

  // per-frame shared state
  private focus = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private car = {
    active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, speed: 0, fx: 0, fz: 1, rx: 1, rz: 0, yawRate: 0,
    hx: 0.95, hy: 0.7, hz: 2.2, ox: 0, oy: 0.55, oz: 0,
  };
  private densityNow = 1;
  private hurry = 1;
  private farSpawnNow = 125;
  // spatial hash
  private hHead = new Int32Array(1024);
  private hNext = new Int32Array(1);
  // sort buffers
  private visIdx = new Int32Array(1);
  private visKey = new Float32Array(1);
  // temps
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private axisX = new THREE.Vector3(1, 0, 0);
  private axisY = new THREE.Vector3(0, 1, 0);
  private hit: NearestHit = { edge: -1, t: 0, dist: 0, x: 0, z: 0 };
  private avoidOut: AvoidOut = { x: 0, z: 0, inside: false };
  private seatOut = { x: 0, y: 0, z: 0 };
  private disturbed = (i: number) => this.ctx.props.isDisturbed(i);
  private offs: (() => void)[] = [];
  private crowd!: CrowdManager;
  private memberRef: CrowdMemberRef = { x: 0, y: 0, z: 0, yaw: 0, app: null as unknown as CrowdMemberRef['app'], clip: 0, time: 0 };
  private pending: Pending[] = Array.from({ length: 256 }, () => ({ active: false, t: 0, kind: 0, npc: -1, site: -1, member: -1, gen: 0, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }));
  private pendingCount = 0;
  private animTime = 0;
  private prevCarT = new THREE.Vector3();
  private prevCarQ = new THREE.Quaternion();
  private hasPrevCar = false;
  private carOnSidewalk = false;
  private hitEvents = 0;
  private hitEventT = 0;

  constructor(private ctx: GameContext) {}

  // ═══════════════════════════════════════ init ═══════════════════════════════════════
  init(): void {
    const C = CONFIG.npc;
    const baked = bakeClips();
    this.clips = baked.clips;
    this.uniforms = makeNpcUniforms(baked.texture);
    this.poolSize = C.poolSize;
    for (let i = 0; i < this.poolSize; i++) this.npcs.push(new Npc(i));
    this.hNext = new Int32Array(this.poolSize);
    this.visIdx = new Int32Array(this.poolSize);
    this.visKey = new Float32Array(this.poolSize);

    const geos = [buildHero(), buildMid(), buildFar()];
    geos.forEach((g, li) => {
      const mat = makeNpcMaterial(this.uniforms, li === 2);
      const mesh = new THREE.InstancedMesh(g, mat, this.poolSize);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = `npc-lod${li}`;
      const mk = () => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(this.poolSize * 4), 4);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
      };
      const L: LodMesh = { mesh, animA: mk(), animB: mk(), col0: mk(), col1: mk(), extra: mk(), count: 0, tris: (g.index?.count ?? 0) / 3 };
      g.setAttribute('iAnimA', L.animA);
      g.setAttribute('iAnimB', L.animB);
      g.setAttribute('iCol0', L.col0);
      g.setAttribute('iCol1', L.col1);
      g.setAttribute('iExtra', L.extra);
      mesh.receiveShadow = true;
      if (li === 0) mesh.customDepthMaterial = makeNpcDepthMaterial(this.uniforms, false);
      this.lods.push(L);
      this.root.add(mesh);
      this.debug.tris[li] = L.tris;
    });
    // blob shadows
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.blobA = new THREE.InstancedBufferAttribute(new Float32Array(this.poolSize), 1);
    this.blobA.setUsage(THREE.DynamicDrawUsage);
    plane.setAttribute('iShadow', this.blobA);
    this.blob = new THREE.InstancedMesh(plane, makeBlobMaterial(), this.poolSize);
    this.blob.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blob.frustumCulled = false;
    this.blob.count = 0;
    this.blob.renderOrder = -1;
    this.blob.name = 'npc-blobs';
    this.root.add(this.blob);
    this.root.name = 'npc-crowd';
    this.root.userData.noOriginShift = true; // we shift our own data and write absolute instance matrices
    this.ctx.engine.scene.add(this.root);
    // static mini crowds: dedicated mid + far geometries (their own instanced attributes)
    this.crowd = new CrowdManager(this.clips, this.uniforms, buildMid(), buildFar(), (x, z) => this.ground(x, z));
    this.ctx.engine.scene.add(this.crowd.root);

    // pooled physics capsules for knockdowns (G.NPC, collide with the world only)
    const { physics } = this.ctx;
    for (let i = 0; i < C.maxRagdolls; i++) {
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(0, -500 - i * 3, 0)
          .setLinearDamping(0.15)
          .setAngularDamping(1.1)
          .setCcdEnabled(true)
          .setEnabled(false),
      );
      const col = physics.world.createCollider(
        RAPIER.ColliderDesc.capsule(0.56, 0.21)
          .setTranslation(0, -0.05, 0)
          .setMass(68)
          .setFriction(0.75)
          .setRestitution(0.12)
          .setCollisionGroups(groups(G.NPC, G.WORLD)),
        body,
      );
      physics.tag(col, { kind: 'npc', material: 'flesh', id: -1 });
      this.rags.push({ body, npc: -1, t: 0, prev: new THREE.Vector3(), curr: new THREE.Vector3(), prevQ: new THREE.Quaternion(), currQ: new THREE.Quaternion() });
    }

    this.setupNav();
    this.applyQuality();

    const ev = this.ctx.events;
    this.offs.push(
      ev.on('qualityChanged', () => this.applyQuality()),
      ev.on('horn', (e) => e.on && this.onHorn(e.position)),
      ev.on('explosion', (e) => this.onExplosion(e.position, e.radius, e.force)),
      ev.on('carReset', () => {
        this.fillT = 0.5;
      }),
      ev.on('originShift', (e) => this.onOriginShift(e.delta.x, e.delta.z)),
    );
  }

  private applyQuality(): void {
    const q = this.ctx.quality;
    const high = q.level === 'high';
    const cast = high && q.current.shadows && CONFIG.npc.castShadows;
    this.lods[0].mesh.castShadow = cast;
  }

  /** Build navigation from the world's ped data, or the temporary test environment. */
  private setupNav(): void {
    const d = this.ctx.world.data;
    const params = new URLSearchParams(location.search);
    const forceTest = params.has('npctest');
    const useTest = forceTest || (CONFIG.npc.testWorld === 'auto' && (!d || d.ped.nodes.length === 0));
    this.testWorld?.dispose();
    this.testWorld = null;
    let src: NavSource;
    if (useTest) {
      const sp = d?.spawn.position ?? { x: 0, y: 0, z: 0 };
      const gy = this.ground(sp.x, sp.z + 18);
      this.testWorld = buildTestWorld(sp.x, gy, sp.z);
      this.ctx.engine.scene.add(this.testWorld.object);
      src = this.testWorld.source;
    } else {
      src = { ped: d.ped, benches: d.benches, busStops: d.busStops, wanderAreas: d.wanderAreas, groupSpots: d.groupSpots, buildings: d.buildings, props: d.props };
    }
    this.debug.testMode = useTest;
    this.nav = new PedNav(src);
    // crowd sites (data-driven; ambient-spot crowds survive a nav rebuild)
    for (const s of [...this.crowd.sites]) if (s.ambientId < 0) this.crowd.removeSite(s);
    this.crowd.generate(src, d ?? null, this.nav, useTest);
    // bench & stop bookkeeping (ambient spot benches are appended after these)
    const keepAmbient = this.benchList.slice(this.navBenchCount);
    this.benchList = [...this.nav.benches];
    this.navBenchCount = this.benchList.length;
    this.benchList.push(...keepAmbient);
    this.benchOcc = this.benchList.map((b) => new Array<number>(b.seats).fill(-1));
    this.benchOff = this.benchList.map(() => false);
    this.stopWaiters = this.nav.busStops.map(() => 0);
    this.spotGroup = this.nav.groupSpots.map(() => -1);
    // re-link ambient spot bench indices
    let k = this.navBenchCount;
    for (const s of this.spots) for (let i = 0; i < s.benches.length; i++) s.benches[i] = k++;
  }
  private navBenchCount = 0;

  // ═══════════════════════════════════════ ambient spots (part 3) ═══════════════════════════════════════
  addAmbientSpot(spot: { position: THREE.Vector3; radius: number; count: number; benches?: { p: THREE.Vector3; yaw: number }[] }): number {
    const id = ++this.spotSeq;
    const gy = this.ground(spot.position.x, spot.position.z);
    const s: AmbientSpot = {
      id,
      x: spot.position.x,
      y: Number.isFinite(gy) ? gy : spot.position.y,
      z: spot.position.z,
      radius: Math.max(2, spot.radius),
      count: Math.max(0, Math.min(12, Math.round(spot.count))),
      members: 0,
      benches: [],
      active: true,
    };
    for (const b of spot.benches ?? []) {
      const bg = this.ground(b.p.x, b.p.z);
      const seatH = CONFIG.props.benchSeatHeight;
      // accept either the bench base on the ground or the seat centre at seat height
      const seatY = b.p.y > bg + seatH * 0.6 ? b.p.y : bg + seatH;
      this.benchList.push({ id: -1000 * id - s.benches.length, p: { x: b.p.x, y: seatY, z: b.p.z }, yaw: b.yaw, seats: 2, seatSpacing: CONFIG.props.benchSeatSpacing, seatHeight: seatH, propIndex: -1, pedNode: -1 });
      this.benchOcc.push([-1, -1]);
      this.benchOff.push(false);
      s.benches.push(this.benchList.length - 1);
    }
    this.spots.push(s);
    return id;
  }

  removeAmbientSpot(id: number): void {
    const i = this.spots.findIndex((s) => s.id === id);
    if (i < 0) return;
    const s = this.spots[i];
    s.active = false;
    for (const b of s.benches) this.benchOff[b] = true;
    for (const n of this.npcs) {
      if (!n.active || n.spot !== id) continue;
      if (n.vis) n.fadeTo = 0;
      else this.despawn(n);
      n.spot = -1;
    }
    this.spots.splice(i, 1);
  }

  // ═══════════════════════════════════════ floating origin ═══════════════════════════════════════
  private onOriginShift(dx: number, dz: number): void {
    this.nav.shift(dx, dz);
    if (this.testWorld) {
      const s = this.testWorld.source;
      for (const b of s.benches) {
        b.p.x -= dx;
        b.p.z -= dz;
      }
      for (const b of s.busStops) {
        b.p.x -= dx;
        b.p.z -= dz;
      }
      for (const a of s.wanderAreas) {
        a.minX -= dx;
        a.maxX -= dx;
        a.minZ -= dz;
        a.maxZ -= dz;
      }
      for (const g of s.groupSpots) {
        g.x -= dx;
        g.z -= dz;
      }
    }
    for (let i = this.navBenchCount; i < this.benchList.length; i++) {
      this.benchList[i].p.x -= dx;
      this.benchList[i].p.z -= dz;
    }
    for (const s of this.spots) {
      s.x -= dx;
      s.z -= dz;
    }
    for (const g of this.groupsArr) {
      g.x -= dx;
      g.z -= dz;
    }
    for (const n of this.npcs) {
      if (!n.active) continue;
      n.x -= dx;
      n.z -= dz;
      n.px -= dx;
      n.pz -= dz;
      n.tx -= dx;
      n.tz -= dz;
      n.evX -= dx;
      n.evZ -= dz;
      n.gx -= dx;
      n.gz -= dz;
      n.lookX -= dx;
      n.lookZ -= dz;
      n.threatX -= dx;
      n.threatZ -= dz;
      n.s0.x -= dx;
      n.s0.z -= dz;
      n.s1.x -= dx;
      n.s1.z -= dz;
      n.homeX -= dx;
      n.homeZ -= dz;
    }
    this.crowd.shift(dx, dz);
    this.prevCarT.x -= dx;
    this.prevCarT.z -= dz;
    for (const p of this.pending) {
      if (!p.active || (p.kind !== 1 && p.kind !== 2 && p.kind !== 3 && p.kind !== 4)) continue;
      p.wy -= dx;
      p.wz -= dz;
    }
    for (const r of this.rags) {
      r.prev.x -= dx;
      r.prev.z -= dz;
      r.curr.x -= dx;
      r.curr.z -= dz;
    }
    this.focus.x -= dx;
    this.focus.z -= dz;
  }

  // ═══════════════════════════════════════ helpers ═══════════════════════════════════════
  private ground(x: number, z: number): number {
    try {
      const h = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(h) ? h : 0;
    } catch {
      return 0;
    }
  }

  private refreshGround(n: Npc, dt: number, force = false): void {
    n.gT -= dt;
    const moved = (n.x - n.gx) ** 2 + (n.z - n.gz) ** 2;
    if (force || moved > 0.36 || n.gT <= 0) {
      n.gy = this.ground(n.x, n.z);
      n.gx = n.x;
      n.gz = n.z;
      n.gT = 0.6 + rand() * 0.3;
    }
  }

  /** Switch the current clip (crossfade from the previous one). fade = 0 → instant. */
  private play(n: Npc, clip: number, fade = 0.25, rate = 1, t0 = 0, restart = false): void {
    if (n.clipA === clip && !restart) {
      n.rateA = rate;
      return;
    }
    if (fade <= 0) {
      n.wB = 0;
      n.clipB = clip;
    } else if (n.wB < 0.5) {
      n.clipB = n.clipA;
      n.tB = n.tA;
      n.rateB = n.rateA;
      n.wB = 1;
    }
    n.fadeRate = fade > 0 ? 1 / fade : 1e6;
    n.clipA = clip;
    n.tA = t0;
    n.rateA = rate;
  }

  private clipDone(n: Npc): boolean {
    const c = this.clips[n.clipA];
    return !c.loop && n.tA >= c.duration;
  }

  private seatOrigin(b: Bench, k: number, s: number, out: { x: number; y: number; z: number }): void {
    const off = b.seatSpacing * (k - (b.seats - 1) / 2);
    const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    out.x = b.p.x + off * c - sn * SIT_BACK;
    out.z = b.p.z - off * sn - c * SIT_BACK;
    out.y = b.p.y - s * SEAT_H;
  }

  private inView(x: number, y: number, z: number, r: number, margin: number): boolean {
    const d = Math.hypot(x - this.camPos.x, y - this.camPos.y, z - this.camPos.z);
    this.sphere.center.set(x, y, z);
    this.sphere.radius = r + d * margin;
    return this.frustum.intersectsSphere(this.sphere);
  }

  // ═══════════════════════════════════════ spawning ═══════════════════════════════════════
  private freeNpc(): Npc | null {
    for (const n of this.npcs) if (!n.active) return n;
    return null;
  }

  /** Returns the start fade (1 = solid) if (x,z) is a valid spawn spot, or -1. */
  private spawnCheck(x: number, y: number, z: number, minR: number): number {
    const C = CONFIG.npc;
    const d2 = (x - this.focus.x) ** 2 + (z - this.focus.z) ** 2;
    if (d2 > C.spawnMax * C.spawnMax) return -1;
    const pop = this.fillT > 0;
    if (!pop && d2 < minR * minR) return -1;
    if (this.crowd.insideAny(x, z, 0.8)) return -1;
    const camD = Math.hypot(x - this.camPos.x, z - this.camPos.z);
    if (pop) return this.inView(x, y + 0.9, z, 1.2, 0.05) ? 0 : 1;
    if (!this.inView(x, y + 0.9, z, 1.5, 0.45)) return 1;
    if (camD > this.farSpawnNow) return 0; // far in view: dither fade-in
    return -1;
  }

  private initNpc(n: Npc, x: number, y: number, z: number, fade: number, app?: Appearance): void {
    if (app) n.app = app;
    else {
      const off = this.ctx.origin?.offset;
      const ax = x + (off?.x ?? 0), az = z + (off?.z ?? 0);
      const chunk = chunkIndex(ax, az, CONFIG.world.size, CONFIG.world.chunkSize);
      n.app = randomAppearance(Rng.from(CONFIG.game.seed, chunk, this.spawnSeq++, 0x4e5043));
    }
    n.scale = n.app.scale;
    n.active = true;
    n.x = x;
    n.y = y;
    n.z = z;
    n.gx = 1e9;
    n.gT = 0;
    n.vx = n.vz = n.speed = 0;
    n.body = false;
    n.rag = -1;
    n.hy = n.hp = 0;
    n.lookT = 0;
    n.curious = rand();
    n.calm = false;
    n.crowdSite = -1;
    n.crowdMember = -1;
    n.stuckT = 0;
    n.bench = n.seat = n.stop = n.group = n.area = n.spot = -1;
    n.edge = n.nextEdge = -1;
    n.reactT = -1;
    n.hitCd = 0;
    n.fade = fade;
    n.fadeTo = 1;
    n.wB = 0;
    n.avoidT = rand() * 0.1;
    n.ax = n.az = 0;
    n.want = CONFIG.npc.walkSpeed * n.app.pace * this.hurry;
    n.tA = rand() * 4;
    n.clipA = n.clipB = CLIP.idle;
    this.refreshGround(n, 0, true);
    this.activeCount++;
  }

  private despawn(n: Npc): void {
    if (!n.active) return;
    this.releaseSlots(n);
    if (n.rag >= 0) this.releaseRag(n.rag);
    if (n.spot >= 0) {
      const s = this.spots.find((sp) => sp.id === n.spot);
      if (s) s.members = Math.max(0, s.members - 1);
    }
    n.active = false;
    n.spot = -1;
    this.activeCount--;
  }

  /** Leave bench / bus stop / group bookkeeping. */
  private releaseSlots(n: Npc): void {
    if (n.bench >= 0 && n.seat >= 0 && this.benchOcc[n.bench]?.[n.seat] === n.i) this.benchOcc[n.bench][n.seat] = -1;
    n.bench = n.seat = -1;
    if (n.stop >= 0) this.stopWaiters[n.stop] = Math.max(0, (this.stopWaiters[n.stop] ?? 1) - 1);
    n.stop = -1;
    if (n.group >= 0) {
      const g = this.groupsArr[n.group];
      if (g && g.active) {
        const k = g.members.indexOf(n.i);
        if (k >= 0) g.members.splice(k, 1);
        if (g.members.length <= 1) this.dissolveGroup(g);
      }
    }
    n.group = -1;
  }

  private dissolveGroup(g: Group): void {
    g.active = false;
    if (g.spot >= 0) this.spotGroup[g.spot] = -1;
    for (const m of g.members) {
      const o = this.npcs[m];
      o.group = -1;
      if (o.active && o.st === S.Group) {
        o.act = ACT.Walker;
        this.enterStand(o, CLIP.lookAround, rr(1, 3));
      }
    }
    g.members.length = 0;
  }

  private spawnTick(desired: number): void {
    const attempts = this.fillT > 0 ? 8 : 3; // progressive initial fill (a few per frame)
    for (let a = 0; a < attempts && this.activeCount < desired; a++) {
      const mix = CONFIG.npc.mix;
      const rain = this.hurry > 1.01 ? 0.25 : 1;
      // ambient spots first (they are few and want their count)
      if (this.spots.length && rand() < 0.5 && this.spawnAmbient()) continue;
      const w = [mix.walker, mix.group * rain, mix.bench * rain, mix.bus, mix.wander * rain];
      let total = 0;
      for (const v of w) total += v;
      let r = rand() * total;
      let kind = 0;
      for (; kind < w.length - 1; kind++) {
        r -= w[kind];
        if (r <= 0) break;
      }
      let ok = false;
      if (kind === 1) ok = this.spawnGroup(desired);
      else if (kind === 2) ok = this.spawnSitter() !== null;
      else if (kind === 3) ok = this.spawnWaiter();
      else if (kind === 4) ok = this.spawnWanderer();
      if (!ok) this.spawnWalker();
    }
  }

  private ringPoint(out: { x: number; z: number }): void {
    const C = CONFIG.npc;
    const minR = this.fillT > 0 || this.debug.testMode ? 4 : C.spawnMin;
    const a = rand() * TAU;
    const r = minR + (C.spawnMax - minR) * Math.pow(rand(), 1.7);
    out.x = this.focus.x + Math.cos(a) * r;
    out.z = this.focus.z + Math.sin(a) * r;
  }
  private rp = { x: 0, z: 0 };

  private minSpawnR(): number {
    return this.debug.testMode ? 10 : CONFIG.npc.spawnMin;
  }

  private spawnWalker(): boolean {
    if (this.nav.empty) return false;
    this.ringPoint(this.rp);
    if (!this.nav.nearest(this.rp.x, this.rp.z, 14, this.hit, true)) return false;
    const e = this.nav.edges[this.hit.edge];
    const a = this.nav.nodes[e.a];
    const x = this.hit.x, z = this.hit.z;
    const y = a.y;
    const fade = this.spawnCheck(x, y, z, this.minSpawnR());
    if (fade < 0 || this.crowded(x, z, 1.2)) return false;
    const n = this.freeNpc();
    if (!n) return false;
    this.initNpc(n, x, y, z, fade);
    n.act = ACT.Walker;
    this.startWalkOn(n, this.hit.edge, rand() < 0.5 ? 1 : -1);
    const fx = e.dx * n.dir, fz = e.dz * n.dir;
    n.x += -fz * n.lat;
    n.z += fx * n.lat;
    n.yaw = Math.atan2(fx, fz);
    this.play(n, CLIP.walk, 0, 1, rand());
    return true;
  }

  private spawnGroup(desired: number): boolean {
    const spots = this.nav.groupSpots;
    if (!spots.length || desired - this.activeCount < 2) return false;
    const si = Math.floor(rand() * spots.length);
    if (this.spotGroup[si] >= 0) return false;
    const sp = spots[si];
    const fade = this.spawnCheck(sp.x, sp.y, sp.z, this.minSpawnR());
    if (fade < 0) return false;
    const count = Math.min(desired - this.activeCount, 2 + Math.floor(rand() * 3));
    let gi = this.groupsArr.findIndex((g) => !g.active);
    if (gi < 0) {
      gi = this.groupsArr.length;
      this.groupsArr.push({ active: false, spot: -1, members: [], speaker: 0, t: 0, x: 0, z: 0 });
    }
    const g = this.groupsArr[gi];
    g.active = true;
    g.spot = si;
    g.members.length = 0;
    g.x = sp.x;
    g.z = sp.z;
    g.t = rr(2, 5);
    this.spotGroup[si] = gi;
    const radius = 0.52 + count * 0.1;
    const a0 = rand() * TAU;
    for (let k = 0; k < count; k++) {
      const n = this.freeNpc();
      if (!n) break;
      const a = a0 + (k / count) * TAU + rr(-0.25, 0.25);
      const x = sp.x + Math.sin(a) * radius, z = sp.z + Math.cos(a) * radius;
      this.initNpc(n, x, sp.y, z, fade);
      n.act = ACT.Group;
      n.group = gi;
      n.yaw = Math.atan2(sp.x - x, sp.z - z) + rr(-0.2, 0.2);
      n.st = S.Group;
      n.stT = 0;
      n.stDur = rr(4, 9);
      n.actT = rr(40, 140);
      g.members.push(n.i);
      this.play(n, rand() < 0.3 ? CLIP.armsCrossed : CLIP.idle, 0, 1, rand() * 4);
    }
    g.speaker = g.members[0] ?? -1;
    if (g.members.length < 2) {
      this.dissolveGroup(g);
      return g.members.length > 0;
    }
    return true;
  }

  private freeSeat(bi: number): number {
    if (this.benchOff[bi]) return -1;
    const b = this.benchList[bi];
    if (b.propIndex >= 0 && this.ctx.props.isDisturbed(b.propIndex)) return -1;
    const occ = this.benchOcc[bi];
    const start = Math.floor(rand() * occ.length);
    for (let k = 0; k < occ.length; k++) {
      const s = (start + k) % occ.length;
      if (occ[s] < 0) return s;
    }
    return -1;
  }

  private spawnSitter(benchIdx = -1): Npc | null {
    const nb = this.navBenchCount;
    if (!nb && benchIdx < 0) return null;
    const bi = benchIdx >= 0 ? benchIdx : Math.floor(rand() * nb);
    const seat = this.freeSeat(bi);
    if (seat < 0) return null;
    const b = this.benchList[bi];
    const fade = this.spawnCheck(b.p.x, b.p.y, b.p.z, this.minSpawnR());
    if (fade < 0) return null;
    const n = this.freeNpc();
    if (!n) return null;
    this.initNpc(n, b.p.x, b.p.y - b.seatHeight, b.p.z, fade);
    n.act = benchIdx >= 0 ? ACT.Ambient : ACT.Bench;
    this.sitImmediately(n, bi, seat);
    return n;
  }

  private sitImmediately(n: Npc, bi: number, seat: number): void {
    const b = this.benchList[bi];
    this.benchOcc[bi][seat] = n.i;
    n.bench = bi;
    n.seat = seat;
    this.seatOrigin(b, seat, n.scale, this.seatOut);
    n.x = this.seatOut.x;
    n.y = this.seatOut.y;
    n.z = this.seatOut.z;
    n.gy = b.p.y - b.seatHeight;
    n.gx = n.x;
    n.gz = n.z;
    n.gT = 1e9;
    n.yaw = b.yaw;
    n.st = S.Sit;
    n.stT = 0;
    n.stDur = rr(15, 60);
    this.play(n, rand() < 0.35 ? CLIP.sitPhone : CLIP.sit, 0, 1, rand() * 4);
  }

  private spawnWaiter(): boolean {
    const stops = this.nav.busStops;
    if (!stops.length) return false;
    const si = Math.floor(rand() * stops.length);
    if (this.stopWaiters[si] >= 4) return false;
    const st = stops[si];
    // sit on the shelter bench if there is a free seat
    if (st.benchId !== null && rand() < 0.5) {
      const bi = this.nav.benchIndexById.get(st.benchId);
      if (bi !== undefined && this.freeSeat(bi) >= 0) {
        const n = this.spawnSitter(bi);
        if (n) {
          n.act = ACT.Bus;
          n.stop = si;
          n.actT = rr(20, 70);
          this.stopWaiters[si]++;
        }
        return n !== null;
      }
    }
    const rx = -Math.cos(st.yaw), rz = Math.sin(st.yaw);
    const lat = rr(-1.8, 1.8), back = rr(0.1, 0.9);
    const x = st.p.x + rx * lat - Math.sin(st.yaw) * back, z = st.p.z + rz * lat - Math.cos(st.yaw) * back;
    const fade = this.spawnCheck(x, st.p.y, z, this.minSpawnR());
    if (fade < 0 || this.crowded(x, z, 0.8)) return false;
    const n = this.freeNpc();
    if (!n) return false;
    this.initNpc(n, x, st.p.y, z, fade);
    n.act = ACT.Bus;
    n.stop = si;
    this.stopWaiters[si]++;
    n.actT = rr(20, 70);
    n.yaw = st.yaw + rr(-0.5, 0.5);
    this.enterStand(n, this.waitClip(), rr(4, 10), 0);
    return true;
  }

  private waitClip(): number {
    const r = rand();
    return r < 0.3 ? CLIP.idle : r < 0.55 ? CLIP.phone : r < 0.78 ? CLIP.lookAround : CLIP.armsCrossed;
  }

  private spawnWanderer(): boolean {
    const areas = this.nav.wanderAreas;
    if (!areas.length) return false;
    const ai = Math.floor(rand() * areas.length);
    const a = areas[ai];
    const x = rr(a.minX + 1.5, a.maxX - 1.5), z = rr(a.minZ + 1.5, a.maxZ - 1.5);
    if (this.nav.insideBuilding(x, z, 0.4)) return false;
    const y = a.y;
    const fade = this.spawnCheck(x, y, z, this.minSpawnR());
    if (fade < 0 || this.crowded(x, z, 1)) return false;
    const n = this.freeNpc();
    if (!n) return false;
    this.initNpc(n, x, y, z, fade);
    n.act = ACT.Wander;
    n.area = ai;
    n.actT = rr(60, 200);
    n.yaw = rand() * TAU;
    if (rand() < 0.5) this.enterStand(n, this.waitClip(), rr(2, 7), 0);
    else this.pickWanderTarget(n);
    return true;
  }

  private spawnAmbient(): boolean {
    for (const s of this.spots) {
      if (!s.active || s.members >= s.count) continue;
      const d2 = (s.x - this.focus.x) ** 2 + (s.z - this.focus.z) ** 2;
      if (d2 > CONFIG.npc.spawnMax ** 2) continue;
      // sit on one of the spot's benches?
      if (s.benches.length && rand() < 0.45) {
        const bi = s.benches[Math.floor(rand() * s.benches.length)];
        const n = this.spawnSitter(bi);
        if (n) {
          n.spot = s.id;
          s.members++;
          return true;
        }
      }
      const a = rand() * TAU, r = Math.sqrt(rand()) * s.radius * 0.8;
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      const y = this.ground(x, z);
      const fade = this.spawnCheck(x, y, z, 30);
      if (fade < 0 || this.crowded(x, z, 1)) continue;
      const n = this.freeNpc();
      if (!n) return false;
      this.initNpc(n, x, y, z, fade);
      n.act = ACT.Ambient;
      n.spot = s.id;
      s.members++;
      n.yaw = rand() * TAU;
      n.actT = 1e9;
      this.enterStand(n, this.waitClip(), rr(2, 8), 0);
      return true;
    }
    return false;
  }

  /** Take over a static crowd member as a dynamic NPC (same look, pose, clip phase, place). */
  private convertMember(site: CrowdSite, i: number): Npc | null {
    if (!site.on || !site.alive[i]) return null;
    const n = this.freeNpc() ?? this.stealNpc();
    if (!n) return null;
    if (!this.crowd.take(site, i, this.animTime, this.memberRef)) return null;
    const m = this.memberRef;
    this.initNpc(n, m.x, m.y, m.z, 1, m.app);
    n.act = ACT.Crowd;
    n.crowdSite = site.id;
    n.crowdGen = site.gen;
    n.crowdMember = i;
    n.homeX = m.x;
    n.homeZ = m.z;
    n.homeYaw = m.yaw;
    n.yaw = m.yaw;
    n.actT = CONFIG.npc.crowds.rejoinAfter * rr(0.8, 1.4);
    n.st = S.Stand;
    n.stT = 0;
    n.stDur = rr(3, 6);
    this.play(n, m.clip, 0, 1, m.time);
    return n;
  }

  /** Free a pool slot by recycling the farthest unseen calm regular NPC. */
  private stealNpc(): Npc | null {
    let best: Npc | null = null;
    let bd = -1;
    for (const o of this.npcs) {
      if (!o.active || o.vis || o.act === ACT.Crowd || o.body || o.st === S.Lying || o.st === S.GetUp) continue;
      const d = (o.x - this.focus.x) ** 2 + (o.z - this.focus.z) ** 2;
      if (d > bd) {
        bd = d;
        best = o;
      }
    }
    if (best) this.despawn(best);
    return best;
  }

  // ───────────── staggered reactions ─────────────
  private queue(kind: number, delay: number, npc: number, site: CrowdSite | null, member: number, vx = 0, vy = 0, vz = 0, wx = 0, wy = 0, wz = 0): void {
    for (const p of this.pending) {
      if (p.active) continue;
      p.active = true;
      p.t = delay;
      p.kind = kind;
      p.npc = npc;
      p.site = site ? site.id : -1;
      p.gen = site ? site.gen : 0;
      p.member = member;
      p.vx = vx;
      p.vy = vy;
      p.vz = vz;
      p.wx = wx;
      p.wy = wy;
      p.wz = wz;
      if (site) site.pend[member] = 1;
      this.pendingCount++;
      return;
    }
  }

  private processPending(dt: number): void {
    if (this.pendingCount <= 0) return;
    let done = 0;
    const max = CONFIG.npc.maxReactPerFrame;
    for (const p of this.pending) {
      if (!p.active) continue;
      p.t -= dt;
      if (p.t > 0 || done >= max) continue;
      p.active = false;
      this.pendingCount--;
      done++;
      let n: Npc | null = null;
      if (p.site >= 0) {
        const site = this.crowd.sites.find((s) => s.id === p.site);
        if (!site || site.gen !== p.gen) continue;
        site.pend[p.member] = 0;
        n = this.convertMember(site, p.member);
      } else {
        n = this.npcs[p.npc];
        if (!n.active) n = null;
      }
      if (!n || n.st === S.Knocked || n.st === S.Settle) continue;
      if (p.kind === 0) this.knock(n, p.vx, p.vy, p.vz, p.wx, p.wy, p.wz, false);
      else if (p.kind === 1 || p.kind === 2) {
        if (n.st === S.Lying || n.st === S.GetUp) continue;
        n.calm = p.kind === 2;
        this.startFlee(n, p.vx, p.vz, p.wx, p.wy, p.wz);
      } else {
        n.escX = p.vx;
        n.escZ = p.vz;
        n.threatX = p.wy;
        n.threatZ = p.wz;
        n.reactKind = p.kind === 3 ? 1 : 2;
        this.react(n);
      }
    }
  }

  private blockedFn = (x: number, z: number): boolean => this.nav.insideBuilding(x, z, 0.35);

  private inWanderArea(x: number, z: number): boolean {
    for (const a of this.nav.wanderAreas) if (x > a.minX && x < a.maxX && z > a.minZ && z < a.maxZ) return true;
    return false;
  }

  private crowded(x: number, z: number, r: number): boolean {
    const r2 = r * r;
    for (const o of this.npcs) if (o.active && (o.x - x) ** 2 + (o.z - z) ** 2 < r2) return true;
    return false;
  }

  // ═══════════════════════════════════════ graph walking ═══════════════════════════════════════
  private startWalkOn(n: Npc, edge: number, dir: number): void {
    const e = this.nav.edges[edge];
    n.edge = edge;
    n.dir = dir;
    const hw = Math.max(0.1, e.width / 2 - 0.4);
    const side = rand() < 0.82 ? 1 : -1;
    n.lat = side * hw * rr(0.15, 0.85);
    n.st = S.Walk;
    n.stT = 0;
    this.chooseNext(n);
  }

  private chooseNext(n: Npc): void {
    const e = this.nav.edges[n.edge];
    const endNode = n.dir > 0 ? e.b : e.a;
    const node = this.nav.nodes[endNode];
    const fx = e.dx * n.dir, fz = e.dz * n.dir;
    let total = 0;
    let best = -1;
    // weighted random pick (prefer going straight, avoid U-turns)
    const cands = node.edges;
    let r = 0;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) r = rand() * total;
      for (const ei of cands) {
        if (ei === n.edge && cands.length > 1) continue;
        const c = this.nav.edges[ei];
        const d = c.a === endNode ? 1 : -1;
        const dot = c.dx * d * fx + c.dz * d * fz;
        let w = 0.35 + 1.4 * Math.max(0, dot);
        if (c.cross) w *= 0.55;
        if (pass === 0) total += w;
        else {
          r -= w;
          if (r <= 0 && best < 0) {
            best = ei;
            n.nextDir = d;
          }
        }
      }
    }
    if (best < 0) {
      best = n.edge;
      n.nextDir = -n.dir;
    }
    n.nextEdge = best;
  }

  /** Called when the walker reaches the end node of its edge. Returns false if the walker left Walk state. */
  private atNode(n: Npc): boolean {
    const e = this.nav.edges[n.edge];
    const node = n.dir > 0 ? e.b : e.a;
    // benches / bus stops at this node
    if (n.act === ACT.Walker) {
      const bs = this.nav.nodeBenches.get(node);
      if (bs && rand() < 0.28) {
        for (const bi of bs) {
          const seat = this.freeSeat(bi);
          if (seat >= 0) {
            this.approachSeat(n, bi, seat);
            return false;
          }
        }
      }
      const ss = this.nav.nodeStops.get(node);
      if (ss && rand() < 0.22) {
        const si = ss[0];
        if (this.stopWaiters[si] < 4) {
          const st = this.nav.busStops[si];
          n.act = ACT.Bus;
          n.stop = si;
          this.stopWaiters[si]++;
          n.actT = rr(20, 60);
          const lat = rr(-1.6, 1.6);
          n.tx = st.p.x - Math.cos(st.yaw) * lat - Math.sin(st.yaw) * 0.5;
          n.tz = st.p.z + Math.sin(st.yaw) * lat - Math.cos(st.yaw) * 0.5;
          n.tyaw = st.yaw + rr(-0.4, 0.4);
          n.st = S.Approach;
          n.stT = 0;
          return false;
        }
      }
      if (rand() < 0.035 && !this.nav.edges[n.nextEdge].cross) {
        this.enterStand(n, rand() < 0.5 ? CLIP.phone : CLIP.lookAround, rr(3, 8));
        n.edge = n.nextEdge;
        n.dir = n.nextDir;
        this.chooseNext(n);
        return false;
      }
    }
    n.edge = n.nextEdge;
    n.dir = n.nextDir;
    this.chooseNext(n);
    return true;
  }

  private approachSeat(n: Npc, bi: number, seat: number): void {
    const b = this.benchList[bi];
    this.benchOcc[bi][seat] = n.i;
    n.bench = bi;
    n.seat = seat;
    this.seatOrigin(b, seat, n.scale, this.seatOut);
    const d = SIT_STAND_Z * n.scale;
    n.tx = this.seatOut.x + Math.sin(b.yaw) * d;
    n.tz = this.seatOut.z + Math.cos(b.yaw) * d;
    n.tyaw = b.yaw;
    n.st = S.Approach;
    n.stT = 0;
  }

  private pickWanderTarget(n: Npc): void {
    let a: WanderArea | null = null;
    if (n.act === ACT.Wander && n.area >= 0) a = this.nav.wanderAreas[n.area];
    const s = n.spot >= 0 ? this.spots.find((sp) => sp.id === n.spot) : undefined;
    for (let k = 0; k < 6; k++) {
      let x: number, z: number;
      if (a) {
        x = rr(a.minX + 1.5, a.maxX - 1.5);
        z = rr(a.minZ + 1.5, a.maxZ - 1.5);
      } else if (s) {
        const ang = rand() * TAU, r = Math.sqrt(rand()) * s.radius;
        x = s.x + Math.cos(ang) * r;
        z = s.z + Math.sin(ang) * r;
      } else {
        x = n.x + rr(-6, 6);
        z = n.z + rr(-6, 6);
      }
      if (this.nav.insideBuilding(x, z, 0.5)) continue;
      n.tx = x;
      n.tz = z;
      break;
    }
    n.st = S.Wander;
    n.stT = 0;
    n.stDur = 25;
  }

  private enterStand(n: Npc, clip: number, dur: number, fade = 0.3): void {
    n.st = S.Stand;
    n.stT = 0;
    n.stDur = dur;
    n.vx = n.vz = 0;
    this.play(n, clip, fade, 1, clip === CLIP.idle ? rand() * 4 : 0);
  }

  /** Back to the graph (or the activity area) after being displaced. */
  private enterReturn(n: Npc): void {
    if (n.act === ACT.Crowd) {
      this.goHome(n);
      return;
    }
    n.st = S.Return;
    n.stT = 0;
    if (n.act === ACT.Ambient || n.act === ACT.Wander) {
      this.pickWanderTarget(n);
      return;
    }
    if (n.act !== ACT.Walker) {
      this.releaseSlots(n);
      n.act = ACT.Walker;
    }
    if (this.nav.nearest(n.x, n.z, 60, this.hit, true)) {
      n.tx = this.hit.x;
      n.tz = this.hit.z;
      n.edge = this.hit.edge;
    } else {
      n.edge = -1;
      n.tx = n.x + rr(-5, 5);
      n.tz = n.z + rr(-5, 5);
    }
  }

  /** Resume the NPC's activity after a stand / stumble / get-up. */
  /** Crowd member taken over by the dynamic system: walk back to its place in the crowd, then idle there. */
  private goHome(n: Npc): void {
    const d = Math.hypot(n.homeX - n.x, n.homeZ - n.z);
    if (d > 0.9) {
      n.tx = n.homeX;
      n.tz = n.homeZ;
      n.tyaw = n.homeYaw;
      n.bench = -1;
      n.st = S.Approach;
      n.stT = 0;
    } else this.enterStand(n, this.waitClip(), rr(4, 9));
  }

  private resume(n: Npc): void {
    switch (n.act) {
      case ACT.Crowd:
        this.goHome(n);
        return;
      case ACT.Wander:
      case ACT.Ambient:
        n.actT -= n.stT;
        this.pickWanderTarget(n);
        return;
      case ACT.Bus:
        if (n.actT > 0 && n.stop >= 0) {
          this.enterStand(n, this.waitClip(), rr(5, 12));
          return;
        }
        this.releaseSlots(n);
        n.act = ACT.Walker;
        this.enterReturn(n);
        return;
      default:
        if (n.edge >= 0 && this.nav.edges[n.edge]) {
          const e = this.nav.edges[n.edge];
          const a = this.nav.nodes[e.a];
          const t = (n.x - a.x) * e.dx + (n.z - a.z) * e.dz;
          const off = Math.abs((n.x - a.x) * -e.dz + (n.z - a.z) * e.dx);
          if (t > -1 && t < e.len + 1 && off < e.width / 2 + 0.6) {
            n.st = S.Walk;
            n.stT = 0;
            if (n.nextEdge < 0) this.chooseNext(n);
            return;
          }
        }
        this.enterReturn(n);
    }
  }

  // ═══════════════════════════════════════ reactions ═══════════════════════════════════════
  private onHorn(pos: THREE.Vector3): void {
    if (this.hidden) return;
    const R = CONFIG.npc.hornRadius;
    const c = this.car;
    let count = 0;
    for (const n of this.npcs) {
      if (!n.active) continue;
      const d = Math.hypot(n.x - pos.x, n.z - pos.z);
      if (d > R || n.st === S.Knocked || n.st === S.Settle || n.st === S.Evade || n.st === S.Lying || n.st === S.GetUp) continue;
      count++;
      n.lookX = pos.x;
      n.lookY = pos.y + 0.8;
      n.lookZ = pos.z;
      n.lookT = rr(2.2, 4);
      // in front of the car (its path): get out of the way
      if (c.active && d < 16) {
        const dx = n.x - c.x, dz = n.z - c.z;
        const ahead = dx * c.fx + dz * c.fz;
        const lat = dx * c.fz - dz * c.fx;
        if (ahead > -1 && Math.abs(lat) < c.hx + 2.4 && n.st !== S.Sit && n.reactT < 0) {
          const side = lat >= 0 ? 1 : -1;
          n.escX = c.fz * side;
          n.escZ = -c.fx * side;
          n.threatX = c.x;
          n.threatZ = c.z;
          n.reactKind = 5;
          n.reactT = 0.08 + (1 - n.app.reflex) * 0.25;
          continue;
        }
      }
      if ((n.st === S.Walk || n.st === S.Wander) && rand() < 0.45) {
        // stop, turn toward the car, then carry on
        n.tyaw = Math.atan2(pos.x - n.x, pos.z - n.z);
        if (d < 9 && n.app.reflex > 0.5) this.enterStand(n, CLIP.flinch, 0.9, 0.12);
        else this.enterStand(n, CLIP.lookAround, rr(1.2, 2.4), 0.25);
      }
    }
    // static crowd members right in front of the car step aside too (taken over, staggered)
    if (c.active) {
      for (const site of this.crowd.sites) {
        if (!site.on || (site.x - c.x) ** 2 + (site.z - c.z) ** 2 > (site.radius + 16) ** 2) continue;
        for (let i = 0; i < site.n; i++) {
          if (!site.alive[i] || site.pend[i]) continue;
          const dx = site.mx[i] - c.x, dz = site.mz[i] - c.z;
          const ahead = dx * c.fx + dz * c.fz;
          const lat = dx * c.fz - dz * c.fx;
          if (ahead < -1 || ahead > 16 || Math.abs(lat) > c.hx + 2.4) continue;
          const side = lat >= 0 ? 1 : -1;
          this.queue(2, rr(0.08, 0.4), -1, site, i, c.fz * side, 0, -c.fx * side, rr(0.9, 1.5), c.x, c.z);
          count++;
        }
      }
    }
    if (count > 0 && this.hornT <= 0) {
      this.hornT = 1;
      this.ctx.events.emit('npcStartled', { position: pos, count, scream: false });
    }
  }

  private onExplosion(pos: THREE.Vector3, radius: number, force: number): void {
    if (this.hidden) return;
    const flee = radius * CONFIG.npc.explosionFlee;
    const fmul = Math.min(2, Math.max(0.4, force));
    let count = 0;
    const blast = (x: number, z: number, npc: number, site: CrowdSite | null, member: number) => {
      const dx = x - pos.x, dz = z - pos.z;
      const d = Math.hypot(dx, dz) || 0.01;
      const ux = dx / d, uz = dz / d;
      if (d < radius) {
        const f = (1 - d / radius) * fmul;
        const sp = 4 + 10 * f;
        // shockwave travels outward: staggered starts (and spread over frames)
        this.queue(0, d / 90 + rand() * 0.03, npc, site, member, ux * sp, 3.5 + 5 * f, uz * sp, -uz * rr(3, 7), rr(-3, 3), ux * rr(3, 7));
        count++;
      } else if (d < flee) {
        this.queue(1, 0.12 + d / 60 + rand() * 0.25, npc, site, member, ux, 0, uz, rr(3, 6), pos.x, pos.z);
        count++;
      }
    };
    for (const n of this.npcs) {
      if (!n.active || n.st === S.Knocked || n.st === S.Settle) continue;
      const cx = n.body ? n.px : n.x, cz = n.body ? n.pz : n.z;
      const d = Math.hypot(cx - pos.x, cz - pos.z);
      if (d < flee) blast(cx, cz, n.i, null, -1);
      else if (d < flee * 1.4) {
        n.lookX = pos.x;
        n.lookY = pos.y;
        n.lookZ = pos.z;
        n.lookT = rr(2, 4);
      }
    }
    for (const site of this.crowd.sites) {
      if (!site.on) continue;
      if (Math.hypot(site.x - pos.x, site.z - pos.z) > flee + site.radius) continue;
      for (let i = 0; i < site.n; i++) if (site.alive[i] && !site.pend[i]) blast(site.mx[i], site.mz[i], -1, site, i);
    }
    if (count > 0) this.ctx.events.emit('npcStartled', { position: pos, count, scream: true });
  }

  private startFlee(n: Npc, ux: number, uz: number, dur: number, tx: number, tz: number): void {
    if (n.st === S.Sit || n.st === S.SitDown) {
      // jump up first
      n.st = S.StandUp;
      n.stT = 0;
      n.reactKind = 2;
      n.escX = ux;
      n.escZ = uz;
      this.play(n, CLIP.standUp, 0.15, 1.8);
      return;
    }
    if (n.st === S.Group || n.group >= 0) this.releaseSlots(n);
    if (n.stop >= 0 || n.bench >= 0) this.releaseSlots(n);
    if (n.act !== ACT.Ambient && n.act !== ACT.Wander && n.act !== ACT.Crowd) n.act = ACT.Walker;
    n.st = S.Flee;
    n.stT = 0;
    n.stDur = dur;
    n.escX = ux;
    n.escZ = uz;
    n.threatX = tx;
    n.threatZ = tz;
  }

  private pathSide = 0;
  private pathLat = 0;
  /** Is (x,z) inside the car's predicted swept box (straight + yaw-rate arc)? Returns time to impact or -1. */
  private pathHit(x: number, y: number, z: number, margin: number): number {
    const c = this.car;
    if (Math.abs(y - c.y) > 3) return -1;
    const T = CONFIG.npc.predictTime;
    const K = 6;
    for (let k = 0; k <= K; k++) {
      const t = (k / K) * T;
      const h = c.yawRate * t;
      const mh = h * 0.5;
      const cm = Math.cos(mh), sm = Math.sin(mh);
      const px = c.x + (c.vx * cm + c.vz * sm) * t;
      const pz = c.z + (-c.vx * sm + c.vz * cm) * t;
      const ch = Math.cos(h), sh = Math.sin(h);
      const fx = c.fx * ch + c.fz * sh, fz = -c.fx * sh + c.fz * ch;
      const dx = x - px, dz = z - pz;
      const lz = dx * fx + dz * fz;
      const lx = dx * fz - dz * fx; // + = to the car's left (car left = +X local)
      if (Math.abs(lz) < c.hz + 0.9 && Math.abs(lx) < c.hx + margin) {
        this.pathSide = lx >= 0 ? 1 : -1;
        if (Math.abs(lx) < 0.25) this.pathSide = rand() < 0.5 ? 1 : -1;
        this.pathLat = Math.abs(lx);
        return t;
      }
    }
    return -1;
  }

  /** 1 dive, 2 hop, 3 panic run, 5 calm jog out of the way. */
  private chooseReaction(tHit: number, kmh: number): number {
    if (kmh < CONFIG.npc.calmDodgeKmh) return tHit < 0.45 ? 2 : 5;
    if (tHit < 0.6) return rand() < 0.55 ? 1 : 2;
    return rand() < 0.6 ? 3 : 2;
  }

  /** Predicted car path → step aside / dive / hop / run for pedestrians in the way (incl. static crowd members). */
  private dangerScan(): void {
    const c = this.car;
    const C = CONFIG.npc;
    if (!c.active) return;
    const kmh = c.speed * 3.6;
    // driving on the sidewalk: people ahead get out of the way even at a crawl
    const presence = this.carOnSidewalk && kmh > 7;
    if (kmh < C.dangerKmh && !presence) return;
    const margin = C.dangerMargin + (this.carOnSidewalk ? 0.8 : 0);
    const reach = c.speed * C.predictTime + 10;
    let startled = 0;
    for (const n of this.npcs) {
      if (!n.active || n.reactT >= 0) continue;
      const st = n.st;
      if (st === S.Knocked || st === S.Settle || st === S.Evade || st === S.Lying || st === S.GetUp || st === S.Fall || st === S.Flee) continue;
      const dx0 = n.x - c.x, dz0 = n.z - c.z;
      if (dx0 * dx0 + dz0 * dz0 > reach * reach) continue;
      let tHit = this.pathHit(n.x, n.y, n.z, margin);
      if (tHit < 0 && presence) {
        const ahead = dx0 * c.fx + dz0 * c.fz;
        const lat = dx0 * c.fz - dz0 * c.fx;
        if (ahead > 0 && ahead < 12 && Math.abs(lat) < c.hx + 2) {
          tHit = ahead / Math.max(1, c.speed);
          this.pathSide = lat >= 0 ? 1 : -1;
          this.pathLat = Math.abs(lat);
        }
      }
      if (tHit < 0) continue;
      const side = this.pathSide;
      n.reactT = 0.03 + (1 - n.app.reflex) * 0.18 + rand() * 0.06;
      n.escX = c.fz * side; // car-left vector × side: perpendicular, away from the path
      n.escZ = -c.fx * side;
      n.threatX = c.x;
      n.threatZ = c.z;
      n.reactKind = this.chooseReaction(tHit, kmh);
      if (n.st === S.Sit) n.reactKind = kmh < C.calmDodgeKmh ? 5 : 3;
      n.evDist = (c.hx + margin + 0.4 - this.pathLat) * 1; // lateral distance to clear
      startled++;
    }
    for (const site of this.crowd.sites) {
      if (!site.on) continue;
      const sr = site.radius + reach;
      if ((site.x - c.x) ** 2 + (site.z - c.z) ** 2 > sr * sr) continue;
      for (let i = 0; i < site.n; i++) {
        if (!site.alive[i] || site.pend[i]) continue;
        const tHit = this.pathHit(site.mx[i], site.my[i], site.mz[i], margin);
        if (tHit < 0) continue;
        const side = this.pathSide;
        const ex = c.fz * side, ez = -c.fx * side;
        const kind = this.chooseReaction(tHit, kmh);
        const delay = 0.04 + rand() * 0.22;
        if (kind === 5) this.queue(2, delay, -1, site, i, ex, 0, ez, (c.hx + margin + 0.6 - this.pathLat) / 2.9 + 0.4, c.x, c.z);
        else if (kind === 3) this.queue(1, delay, -1, site, i, ex, 0, ez, rr(1.5, 3), c.x, c.z);
        else this.queue(kind === 1 ? 3 : 4, delay, -1, site, i, ex, 0, ez, 0, c.x, c.z);
        startled++;
      }
    }
    if (startled > 0 && this.startleT <= 0) {
      this.startleT = 0.8;
      this.tmpV.set(c.x, c.y, c.z);
      this.ctx.events.emit('npcStartled', { position: this.tmpV, count: startled, scream: kmh > C.calmDodgeKmh });
    }
  }

  private react(n: Npc): void {
    const kind = n.reactKind;
    n.reactT = -1;
    if (n.st === S.Knocked || n.st === S.Settle || n.st === S.Lying || n.st === S.GetUp) return;
    if (n.st === S.Sit || n.st === S.SitDown || n.st === S.StandUp) {
      n.calm = kind === 5;
      this.startFlee(n, n.escX, n.escZ, rr(1.5, 3), n.threatX, n.threatZ);
      return;
    }
    this.releaseSlots(n);
    if (n.act !== ACT.Ambient && n.act !== ACT.Wander && n.act !== ACT.Crowd) n.act = ACT.Walker;
    if (kind === 5) {
      // jog sideways out of the predicted path, then look back at the car
      n.calm = true;
      const clear = Math.max(1.2, n.evDist || 2);
      this.startFlee(n, n.escX, n.escZ, Math.min(2.2, clear / 2.9 + 0.45), n.threatX, n.threatZ);
      return;
    }
    if (kind === 3) {
      n.calm = false;
      this.startFlee(n, n.escX, n.escZ, rr(1.5, 3), n.threatX, n.threatZ);
      return;
    }
    n.st = S.Evade;
    n.stT = 0;
    n.evX = n.x;
    n.evZ = n.z;
    n.vx = n.vz = 0;
    if (kind === 1) {
      n.reactKind = 1;
      n.evDist = 2.6 * n.scale;
      this.play(n, CLIP.dive, 0.1);
    } else {
      n.reactKind = 2;
      n.evDist = 1.8 * n.scale;
      const left = n.escX * Math.cos(n.yaw) - n.escZ * Math.sin(n.yaw); // dot(esc, local +X)
      this.play(n, left >= 0 ? CLIP.hopL : CLIP.hopR, 0.1);
    }
  }

  // ═══════════════════════════════════════ knockdown physics ═══════════════════════════════════════
  private acquireRag(n: Npc): number {
    if (n.rag >= 0) return n.rag;
    let best = -1;
    for (let i = 0; i < this.rags.length; i++) if (this.rags[i].npc < 0) {
      best = i;
      break;
    }
    if (best < 0) return -1; // pool busy: caller falls back to the analytic tumble
    const r = this.rags[best];
    r.npc = n.i;
    r.t = 0;
    n.rag = best;
    return best;
  }

  private releaseRag(ri: number): void {
    const r = this.rags[ri];
    if (!r) return;
    const n = this.npcs[r.npc];
    if (n && n.rag === ri) n.rag = -1;
    r.npc = -1;
    try {
      r.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      r.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      r.body.setTranslation({ x: 0, y: -500 - ri * 3, z: 0 }, false);
      r.body.setEnabled(false);
    } catch {
      /* body removed */
    }
  }

  /** Knock an NPC over with a launch velocity (m/s) and spin (rad/s). */
  private knock(n: Npc, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number, capsule = false): void {
    const C = CONFIG.npc;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > C.launchMax) {
      const k = C.launchMax / sp;
      vx *= k;
      vy *= k;
      vz *= k;
    }
    // current pelvis pose → body frame
    if (!n.body) {
      const s = n.scale;
      if (n.st === S.Lying) {
        this.tmpQ.setFromAxisAngle(this.axisY, n.yaw);
        this.tmpQ2.setFromAxisAngle(this.axisX, n.front ? Math.PI / 2 : -Math.PI / 2);
        n.q.copy(this.tmpQ).multiply(this.tmpQ2);
        n.px = n.x;
        n.py = n.y + LIE_H * s + 0.1;
        n.pz = n.z;
      } else {
        const sitting = n.st === S.Sit || n.st === S.SitDown || n.st === S.StandUp;
        n.q.setFromAxisAngle(this.axisY, n.yaw);
        n.px = n.x;
        n.py = n.y + (sitting ? SIT_HIP_LOCAL : HIP_H) * s;
        n.pz = n.z;
      }
    }
    this.releaseSlots(n);
    if (n.act !== ACT.Ambient && n.act !== ACT.Wander && n.act !== ACT.Crowd) n.act = ACT.Walker;
    n.reactT = -1;
    n.hitCd = 0.35;
    n.slowT = 0;
    n.stT = 0;
    n.st = S.Knocked;
    n.body = true;
    this.debug.knocked++;
    this.play(n, CLIP.tumble, 0.12, rr(0.8, 1.3));
    // a few real Rapier capsules for the closest car hits (they bounce off walls); everyone else tumbles analytically
    const ri = capsule ? this.acquireRag(n) : -1;
    if (ri < 0) {
      n.rag = -1;
      n.bvx = vx;
      n.bvy = vy;
      n.bvz = vz;
      n.bwx = wx;
      n.bwy = wy;
      n.bwz = wz;
      n.gT = 0;
      return;
    }
    const r = this.rags[ri];
    const b = r.body;
    b.setEnabled(true);
    b.setTranslation({ x: n.px, y: n.py, z: n.pz }, true);
    b.setRotation({ x: n.q.x, y: n.q.y, z: n.q.z, w: n.q.w }, true);
    b.setLinvel({ x: vx, y: vy, z: vz }, true);
    b.setAngvel({ x: wx, y: wy, z: wz }, true);
    b.wakeUp();
    r.prev.set(n.px, n.py, n.pz);
    r.curr.copy(r.prev);
    r.prevQ.copy(n.q);
    r.currQ.copy(n.q);
  }

  private beginSettle(n: Npc): void {
    if (n.rag >= 0) this.releaseRag(n.rag);
    n.body = true;
    n.s0.set(n.px, n.py, n.pz);
    n.q0.copy(n.q);
    const h = this.tmpV.set(0, 1, 0).applyQuaternion(n.q);
    const f = this.tmpV2.set(0, 0, 1).applyQuaternion(n.q);
    const gy = this.ground(n.px, n.pz);
    n.gy = gy;
    const hl = Math.hypot(h.x, h.z);
    n.upright = hl < 0.4 && h.y > 0;
    if (n.upright) {
      n.settleYaw = Math.atan2(f.x, f.z);
      n.q1.setFromAxisAngle(this.axisY, n.settleYaw);
      n.s1.set(n.px, gy + HIP_H * n.scale, n.pz);
      this.play(n, CLIP.idle, 0.3);
    } else {
      n.front = f.y < 0;
      n.settleYaw = n.front ? Math.atan2(h.x, h.z) : Math.atan2(-h.x, -h.z);
      this.tmpQ.setFromAxisAngle(this.axisY, n.settleYaw);
      this.tmpQ2.setFromAxisAngle(this.axisX, n.front ? Math.PI / 2 : -Math.PI / 2);
      n.q1.copy(this.tmpQ).multiply(this.tmpQ2);
      n.s1.set(n.px, gy + LIE_H * n.scale, n.pz);
      this.play(n, n.front ? CLIP.relaxF : CLIP.relaxB, 0.3);
    }
    n.st = S.Settle;
    n.stT = 0;
  }

  // ═══════════════════════════════════════ fixed step: hits ═══════════════════════════════════════
  // swept car poses for the current fixed step (prev → current), inverse rotations precomputed
  private sweepP = Array.from({ length: 6 }, () => new THREE.Vector3());
  private sweepQi = Array.from({ length: 6 }, () => new THREE.Quaternion());
  private curCarQ = new THREE.Quaternion();
  private carBox = { hx: 1, hy: 0.7, hz: 2.3, ox: 0, oy: 0.55, oz: 0 };
  private bumpedThisStep = 0;

  /** Forgiving cylinder-vs-inflated-OBB test of a point against every swept car pose. Returns the sample index or -1. */
  private sweptHit(x: number, y: number, z: number, lying: boolean, scale: number, samples: number): number {
    const B = this.carBox;
    const rad = (lying ? 0.5 : CONFIG.npc.hitRadius) * scale;
    const cy = y + (lying ? 0.15 : 0.6) * scale;
    const yTol = B.hy + (lying ? 0.35 : 0.85);
    for (let s = 0; s < samples; s++) {
      const P = this.sweepP[s];
      const l = this.tmpV.set(x - P.x, cy - P.y, z - P.z).applyQuaternion(this.sweepQi[s]);
      l.x -= B.ox;
      l.y -= B.oy;
      l.z -= B.oz;
      if (Math.abs(l.y) > yTol) continue;
      const ex = Math.max(Math.abs(l.x) - B.hx, 0), ez = Math.max(Math.abs(l.z) - B.hz, 0);
      if (ex * ex + ez * ez <= rad * rad) return s;
    }
    return -1;
  }

  fixedUpdate(): void {
    if (!this.started || this.hidden) return;
    const t0 = performance.now();
    const v = this.ctx.vehicle;
    const body = v.active ? v.chassis : null;
    if (!body) {
      this.hasPrevCar = false;
      return;
    }
    const C = CONFIG.npc;
    const t = body.translation();
    const r = body.rotation();
    const lv = body.linvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    const dims = v.visual?.dims;
    const B = this.carBox;
    const inf = C.hitInflate;
    B.hx = (dims ? dims.halfExtents.x : 0.95) + inf;
    B.hy = dims ? dims.halfExtents.y : 0.7;
    B.hz = (dims ? dims.halfExtents.z : 2.2) + inf;
    B.ox = dims ? dims.colliderOffset.x : 0;
    B.oy = dims ? dims.colliderOffset.y : 0.55;
    B.oz = dims ? dims.colliderOffset.z : 0;
    this.curCarQ.set(r.x, r.y, r.z, r.w);
    if (!this.hasPrevCar) {
      this.prevCarT.set(t.x, t.y, t.z);
      this.prevCarQ.copy(this.curCarQ);
      this.hasPrevCar = true;
    }
    const move = Math.hypot(t.x - this.prevCarT.x, t.y - this.prevCarT.y, t.z - this.prevCarT.z);
    // teleports (reset) are not swept
    const samples = move > 8 ? 1 : Math.min(6, Math.max(1, Math.ceil(move / 0.3)));
    for (let s = 0; s < samples; s++) {
      const f = samples === 1 ? 1 : (s + 1) / samples;
      this.sweepP[s].set(t.x, t.y, t.z);
      if (f < 1) this.sweepP[s].lerpVectors(this.prevCarT, this.sweepP[s], f);
      this.sweepQi[s].slerpQuaternions(this.prevCarQ, this.curCarQ, f).invert();
    }
    this.prevCarT.set(t.x, t.y, t.z);
    this.prevCarQ.copy(this.curCarQ);
    const reach = B.hz + 2.5 + move;
    const reach2 = reach * reach;
    this.bumpedThisStep = 0;
    for (const n of this.npcs) {
      if (!n.active) continue;
      if (n.hitCd > 0) n.hitCd -= 1 / 60;
      if (n.st === S.Knocked || n.st === S.Settle || n.hitCd > 0) continue;
      const dx = n.x - t.x, dz = n.z - t.z;
      if (dx * dx + dz * dz > reach2) continue;
      const lying = n.st === S.Lying || n.st === S.GetUp || n.st === S.Fall;
      if (this.sweptHit(n.x, n.y, n.z, lying, n.scale, samples) < 0) continue;
      this.carContact(n, lying, speed, lv.x, lv.z, t.x, t.y, t.z);
    }
    // static crowd members in the swept box → taken over by the dynamic system and knocked / shoved
    for (const site of this.crowd.sites) {
      if (!site.on) continue;
      const sr = site.radius + reach;
      if ((site.x - t.x) ** 2 + (site.z - t.z) ** 2 > sr * sr) continue;
      for (let i = 0; i < site.n; i++) {
        if (!site.alive[i]) continue;
        if (this.sweptHit(site.mx[i], site.my[i], site.mz[i], false, site.app[i].scale, samples) < 0) continue;
        const n = this.convertMember(site, i);
        if (n) this.carContact(n, false, speed, lv.x, lv.z, t.x, t.y, t.z);
      }
    }
    if (this.bumpedThisStep > 0) {
      // the car feels a bump (momentum share), never a wall
      const hs = Math.hypot(lv.x, lv.z);
      if (hs > 0.5) {
        const dv = Math.min(C.carBumpMax, C.carBump * hs * Math.min(2.5, this.bumpedThisStep));
        const m = body.mass();
        body.applyImpulse({ x: (-lv.x / hs) * dv * m, y: 0, z: (-lv.z / hs) * dv * m }, true);
      }
      this.ctx.events.emit('vibrate', { pattern: 35 });
      if (this.startleT <= 0) {
        this.startleT = 0.6;
        this.tmpV.set(t.x, t.y, t.z);
        let witnesses = this.bumpedThisStep;
        for (const o of this.npcs) if (o.active && (o.x - t.x) ** 2 + (o.z - t.z) ** 2 < 400) witnesses++;
        this.ctx.events.emit('npcStartled', { position: this.tmpV, count: witnesses, scream: true });
      }
    }
    this.emaFixed += (performance.now() - t0 - this.emaFixed) * 0.05;
    this.debug.fixedMs = +this.emaFixed.toFixed(3);
  }

  /** The car touched pedestrian n: knock it over (fast) or shove it out of the way (slow). */
  private carContact(n: Npc, lying: boolean, speed: number, vx: number, vz: number, cx: number, cy: number, cz: number): void {
    const C = CONFIG.npc;
    if (speed * 3.6 > (lying ? C.hitKmh * 1.6 : C.hitKmh)) {
      const hs = Math.hypot(vx, vz) || 1;
      // push away from the car's centre line (to its left or right) + forward with the car + upward kick + spin
      const fx = vx / hs, fz = vz / hs;
      const side = (n.x - cx) * -fz + (n.z - cz) * fx >= 0 ? 1 : -1; // + = car's left
      const k = rr(0.8, 1.05);
      const lat = hs * rr(0.15, 0.32) * side;
      const slowBoost = Math.max(0, 1 - hs / 6); // slow taps still visibly topple people
      const up = (Math.min(7.5, 2.2 + hs * 0.17) + slowBoost * 1.2) * (lying ? 0.6 : 1);
      const spin = (3.5 + hs * 0.22) * (lying ? 0.5 : 1);
      const wx = -fz * spin + rr(-1, 1), wz = fx * spin + rr(-1, 1);
      const pv = Math.max(hs * k, 2.6);
      this.knock(n, fx * pv - fz * lat, up, fz * pv + fx * lat, wx, rr(-3, 3), wz, true);
      this.bumpedThisStep++;
      if (this.hitEvents < 4) {
        this.hitEvents++;
        this.tmpV.set(n.px, n.py, n.pz);
        this.ctx.events.emit('npcHit', { position: this.tmpV, speed });
      }
      this.debug.hits++;
      return;
    }
    if (lying) return;
    // slow contact: nudge out of the car's box + a stumble if it was a real shove
    const ax = n.x - cx, az = n.z - cz;
    const al = Math.hypot(ax, az) || 1;
    n.x += (ax / al) * 0.08;
    n.z += (az / al) * 0.08;
    if (speed > 0.7 && n.st !== S.Stumble && n.st !== S.Evade) {
      this.releaseSlots(n);
      if (n.act !== ACT.Ambient && n.act !== ACT.Wander && n.act !== ACT.Crowd) n.act = ACT.Walker;
      n.escX = ax / al;
      n.escZ = az / al;
      n.yaw = Math.atan2(-n.escX, -n.escZ); // face the car, stumble backwards
      n.st = S.Stumble;
      n.stT = 0;
      n.evX = n.x;
      n.evZ = n.z;
      n.evDist = 0.7 * n.scale;
      n.hitCd = 0.6;
      this.play(n, CLIP.stumble, 0.12);
      n.lookX = cx;
      n.lookY = cy;
      n.lookZ = cz;
      n.lookT = 3;
    }
  }

  postStep(): void {
    for (const r of this.rags) {
      if (r.npc < 0) continue;
      const t = r.body.translation();
      const q = r.body.rotation();
      r.prev.copy(r.curr);
      r.prevQ.copy(r.currQ);
      r.curr.set(t.x, t.y, t.z);
      r.currQ.set(q.x, q.y, q.z, q.w);
      r.t += 1 / 60;
    }
  }

  // ═══════════════════════════════════════ per-frame update ═══════════════════════════════════════
  update(dt: number, alpha: number): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const C = CONFIG.npc;
    if (!this.started) {
      this.started = true;
      this.fillT = 2;
    }
    dt = Math.min(dt, 0.1);
    this.fillT -= dt;
    this.startleT -= dt;
    this.hornT -= dt;

    // late world data → switch from the test environment to the real graph
    this.worldCheckT -= dt;
    if (this.worldCheckT <= 0) {
      this.worldCheckT = 2;
      if (this.debug.testMode && !new URLSearchParams(location.search).has('npctest') && ctx.world.data?.ped.nodes.length) {
        for (const n of this.npcs) if (n.active) this.despawn(n);
        this.setupNav();
        this.fillT = 1;
      }
    }

    // focus: plane / car / camera
    const plane = ctx.game.mode === 'plane' ? ctx.planes?.cameraTarget?.object : null;
    if (plane) plane.getWorldPosition(this.focus);
    else if (ctx.vehicle.active && ctx.vehicle.object) this.focus.copy(ctx.vehicle.state.position);
    else this.focus.copy(ctx.engine.camera.position);

    // part 2: crowd disabled while flying high
    const agl = ctx.game.mode === 'plane' ? (ctx.planes?.state?.altitudeAgl ?? 0) : 0;
    const hide = ctx.game.mode === 'plane' && ctx.planes?.active && agl > C.altitudeHide;
    if (hide !== this.hidden) {
      this.hidden = !!hide;
      this.root.visible = !this.hidden;
      this.crowd.root.visible = !this.hidden;
      if (this.hidden) for (const n of this.npcs) if (n.active) this.despawn(n);
      else this.fillT = 0.8;
    }
    this.debug.hidden = this.hidden;
    if (this.hidden) {
      this.debug.active = this.activeCount;
      return;
    }

    // camera frustum (from last frame's camera; inflated margins cover the 1-frame lag)
    const cam = ctx.engine.camera;
    cam.updateMatrixWorld();
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    this.updateCar();
    this.updateEnvironment();
    const desired = Math.min(this.poolSize - 40, Math.round(ctx.quality.current.npcCount * this.densityNow));
    this.debug.desired = desired;
    this.animTime += dt;
    this.uniforms.uNpcTime.value = this.animTime;
    this.hitEventT -= dt;
    if (this.hitEventT <= 0) {
      this.hitEventT = 0.3;
      this.hitEvents = 0;
    }
    // is the car on a pedestrian area (sidewalk, plaza, crowd)?
    const c = this.car;
    this.carOnSidewalk = false;
    if (c.active) {
      if (this.nav.nearest(c.x, c.z, 4, this.hit, true)) this.carOnSidewalk = this.hit.dist < this.nav.edges[this.hit.edge].width / 2 + 0.9;
      if (!this.carOnSidewalk) this.carOnSidewalk = this.crowd.insideAny(c.x, c.z, 5) !== null || this.inWanderArea(c.x, c.z);
    }
    this.processPending(dt);
    // static mini crowds: site-level bookkeeping only (instance data rewritten only on change)
    const lvl = ctx.quality.level;
    const budget = (CONFIG.npc.crowds.budget as Record<string, number>)[lvl] ?? 100;
    this.crowd.update(this.focus, this.camPos, this.frustum, this.animTime, budget, this.densityNow, this.farSpawnNow, this.fillT > 0, this.blockedFn);

    this.rebuildHash();
    this.dangerScan();

    // groups: speaker rotation
    for (const g of this.groupsArr) {
      if (!g.active) continue;
      g.t -= dt;
      if (g.t <= 0 && g.members.length) {
        g.t = rr(2.5, 6.5);
        let next = g.members[Math.floor(rand() * g.members.length)];
        if (next === g.speaker && g.members.length > 1) next = g.members[(g.members.indexOf(next) + 1) % g.members.length];
        g.speaker = next;
      }
    }

    // per-NPC behaviour
    const despR2 = C.despawn * C.despawn;
    let crowdDyn = 0;
    for (const n of this.npcs) {
      if (!n.active) continue;
      this.updateNpc(n, dt, alpha);
      if (!n.active) continue;
      if (n.act === ACT.Crowd) {
        // taken-over crowd member: once calm and unseen (or far), it slips back into its static crowd
        crowdDyn++;
        n.actT -= dt;
        const calm = n.st === S.Stand || n.st === S.Approach || n.st === S.Wander;
        if (n.actT <= 0 && calm && (!n.vis || n.dist > 45) && Math.hypot(n.x - n.homeX, n.z - n.homeZ) < 25) {
          if (this.crowd.restore(n.crowdSite, n.crowdGen, n.crowdMember)) {
            this.despawn(n);
            continue;
          }
          n.act = ACT.Walker;
          this.enterReturn(n);
        }
      }
      // fades
      if (n.fade !== n.fadeTo) {
        const step = dt / C.fadeTime;
        n.fade = n.fade < n.fadeTo ? Math.min(n.fadeTo, n.fade + step) : Math.max(n.fadeTo, n.fade - step);
        if (n.fade <= 0 && n.fadeTo <= 0) {
          this.despawn(n);
          continue;
        }
      }
      // recycle far NPCs
      const fx = n.body ? n.px : n.x, fz = n.body ? n.pz : n.z;
      const d2 = (fx - this.focus.x) ** 2 + (fz - this.focus.z) ** 2;
      if (d2 > despR2 && n.st !== S.Knocked) {
        if (n.vis && n.fade > 0.5) n.fadeTo = 0;
        else this.despawn(n);
      }
    }
    // too many (density / quality drop): drop off-screen ones first
    const regular = this.activeCount - crowdDyn;
    if (regular > desired) {
      let excess = Math.min(3, regular - desired);
      for (let pass = 0; pass < 2 && excess > 0; pass++) {
        for (const n of this.npcs) {
          if (!n.active || excess <= 0 || n.st === S.Knocked || n.fadeTo === 0 || n.act === ACT.Crowd) continue;
          if (pass === 0 && n.vis) continue;
          if (pass === 1 && n.dist < 50) continue;
          if (pass === 0) this.despawn(n);
          else n.fadeTo = 0;
          excess--;
        }
      }
    } else if (regular < desired) this.spawnTick(desired + crowdDyn);

    this.render();
    this.activeCount = 0;
    for (const n of this.npcs) if (n.active) this.activeCount++;
    this.debug.active = this.activeCount;
    let rg = 0;
    for (const r of this.rags) if (r.npc >= 0) rg++;
    this.debug.ragdolls = rg;
    let on = 0;
    for (const s of this.crowd.sites) if (s.on) on++;
    this.debug.crowdSites = on;
    this.debug.crowdMembers = this.crowd.materialized;
    this.debug.crowdRebuilds = this.crowd.rebuilds;
    this.debug.pending = this.pendingCount;
    const ms = performance.now() - t0;
    this.emaUpdate += (ms - this.emaUpdate) * 0.05;
    this.debug.updateMs = +this.emaUpdate.toFixed(3);
  }

  private updateCar(): void {
    const c = this.car;
    const v = this.ctx.vehicle;
    c.active = !!(v.active && v.object && !(this.ctx.game.mode === 'plane'));
    if (!c.active) return;
    const s = v.state;
    c.x = s.position.x;
    c.y = s.position.y;
    c.z = s.position.z;
    c.vx = s.velocity.x;
    c.vy = s.velocity.y;
    c.vz = s.velocity.z;
    c.speed = Math.hypot(c.vx, c.vz);
    const fl = Math.hypot(s.forward.x, s.forward.z) || 1;
    c.fx = s.forward.x / fl;
    c.fz = s.forward.z / fl;
    const av = v.chassis?.angvel();
    c.yawRate = av ? av.y : 0;
    const dims = v.visual?.dims;
    if (dims) {
      c.hx = dims.halfExtents.x;
      c.hy = dims.halfExtents.y;
      c.hz = dims.halfExtents.z;
    }
  }

  /** Part 3: time of day / weather density and pace; fog brings fade-ins nearer. */
  private updateEnvironment(): void {
    const C = CONFIG.npc;
    const env = this.ctx.env;
    let dens = 1;
    const h = env.clockHours;
    if (typeof h === 'number' && Number.isFinite(h)) {
      // full 8h-21h, thinning through the evening, minimum ~1h-4h30, waking up 5h-8h
      const hh = ((h % 24) + 24) % 24;
      let f: number;
      if (hh >= 8 && hh <= 21) f = 1;
      else if (hh > 21) f = 1 - (1 - C.nightDensity) * sstep(21, 24.5, hh);
      else if (hh < 4.5) f = C.nightDensity + 0.06 * Math.max(0, 1 - hh / 1.5);
      else f = C.nightDensity + (1 - C.nightDensity) * sstep(4.5, 8, hh);
      dens *= f;
    }
    const w = env.weather;
    let hurry = 1;
    let far = C.farSpawn;
    if (w) {
      const heavy = w.kind === 'heavyRain' || w.kind === 'storm' ? 1 : w.kind === 'lightRain' ? 0.4 : 0;
      const rain = Math.max(w.rain * (0.5 + 0.5 * heavy), w.storm);
      dens *= 1 - (1 - C.rainDensity) * Math.min(1, rain);
      hurry = 1 + (C.rainHurry - 1) * Math.min(1, rain * 1.2);
      if (w.snow > 0.3) dens *= 0.7;
      if (w.fog > 0.05 && Number.isFinite(w.visibility)) far = Math.max(28, Math.min(C.farSpawn, w.visibility * 0.75));
    }
    this.densityNow = dens;
    this.hurry = hurry;
    this.farSpawnNow = far;
  }

  // ───────────── spatial hash (2.5 m cells) ─────────────
  private hkey(x: number, z: number): number {
    return ((Math.floor(x / 2.5) * 73856093) ^ (Math.floor(z / 2.5) * 19349663)) & 1023;
  }
  private rebuildHash(): void {
    this.hHead.fill(-1);
    for (const n of this.npcs) {
      if (!n.active || n.body) continue;
      const k = this.hkey(n.x, n.z);
      this.hNext[n.i] = this.hHead[k];
      this.hHead[k] = n.i;
    }
  }

  /** Separation + head-on sidestep from nearby NPCs; writes into sepOut. */
  private sepOut = { x: 0, z: 0 };
  private separation(n: Npc): void {
    let sx = 0, sz = 0;
    const cx0 = Math.floor(n.x / 2.5), cz0 = Math.floor(n.z / 2.5);
    const fx = Math.sin(n.yaw), fz = Math.cos(n.yaw);
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const k = (((cx0 + ox) * 73856093) ^ ((cz0 + oz) * 19349663)) & 1023;
        for (let j = this.hHead[k]; j >= 0; j = this.hNext[j]) {
          if (j === n.i) continue;
          const o = this.npcs[j];
          const dx = n.x - o.x, dz = n.z - o.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 6.25 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const personal = 0.62 * (n.scale + o.scale) * 0.5;
          if (d < personal) {
            const s = (personal - d) / personal;
            sx += (dx / d) * s * 2.2;
            sz += (dz / d) * s * 2.2;
          }
          // head-on: someone ahead, coming toward us → step to the right
          const ahead = -(dx * fx + dz * fz);
          if (ahead > 0 && ahead < 2.4 && n.speed > 0.3) {
            const lateral = Math.abs(-dx * fz + dz * fx);
            const ofx = Math.sin(o.yaw), ofz = Math.cos(o.yaw);
            const facing = ofx * fx + ofz * fz;
            if (lateral < 0.75 && (facing < -0.3 || o.speed < 0.2)) {
              const w = (1 - ahead / 2.4) * 0.9;
              sx += -fz * w;
              sz += fx * w;
            }
          }
        }
      }
    }
    this.sepOut.x = sx;
    this.sepOut.z = sz;
  }

  /** Static (props, buildings) + parked/slow player car avoidance, time-sliced. */
  private updateAvoid(n: Npc, dt: number, force: boolean): void {
    n.avoidT -= dt;
    if (n.avoidT > 0 && !force) return;
    n.avoidT = 0.1;
    let ax = 0, az = 0;
    if (this.nav.avoid(n.x, n.z, RADIUS, 1.1, this.avoidOut, this.disturbed)) {
      ax += this.avoidOut.x;
      az += this.avoidOut.z;
      if (this.avoidOut.inside) {
        n.x += this.avoidOut.x * 0.05;
        n.z += this.avoidOut.z * 0.05;
      }
    }
    // static crowds are solid: walk around them (taken-over members may walk back in)
    if (n.act !== ACT.Crowd) {
      const site = this.crowd.insideAny(n.x, n.z, 1.2);
      if (site) {
        const dx = n.x - site.x, dz = n.z - site.z;
        const d = Math.hypot(dx, dz) || 0.01;
        const s = Math.min(3, (site.radius + 1.2 - d) * 1.5 + 0.5);
        ax += (dx / d) * s;
        az += (dz / d) * s;
      }
    }
    const c = this.car;
    if (c.active && c.speed < 3.5) {
      const dx = n.x - c.x, dz = n.z - c.z;
      if (dx * dx + dz * dz < 64 && Math.abs(n.y - c.y) < 2.5) {
        const lz = dx * c.fx + dz * c.fz;
        const lx = dx * c.fz - dz * c.fx;
        const hx = c.hx + RADIUS, hz = c.hz + RADIUS;
        const qx = Math.abs(lx) - hx, qz = Math.abs(lz) - hz;
        const look = 1.3;
        if (qx < look && qz < look) {
          let px = 0, pz = 0, s: number;
          if (qx < 0 && qz < 0) {
            if (qx > qz) px = Math.sign(lx) || 1;
            else pz = Math.sign(lz) || 1;
            s = 3;
          } else {
            const ex = Math.max(qx, 0), ez = Math.max(qz, 0);
            const d = Math.hypot(ex, ez) || 0.001;
            px = (ex / d) * (Math.sign(lx) || 1);
            pz = (ez / d) * (Math.sign(lz) || 1);
            s = Math.max(0, (look - d) / look) * 1.6;
          }
          // local (lateral = car-left, longitudinal = forward) back to world
          ax += (px * c.fz + pz * c.fx) * s;
          az += (-px * c.fx + pz * c.fz) * s;
        }
      }
    }
    n.ax = ax;
    n.az = az;
  }

  /** Steer toward (tx,tz) at `speed`, with separation and avoidance. */
  private steer(n: Npc, tx: number, tz: number, speed: number, dt: number, arrive = 0): number {
    let dx = tx - n.x, dz = tz - n.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      dx /= d;
      dz /= d;
    }
    let sp = speed;
    if (arrive > 0) sp *= Math.min(1, d / arrive);
    this.separation(n);
    this.updateAvoid(n, dt, false);
    let wx = dx * sp + (this.sepOut.x + n.ax) * Math.max(0.6, sp * 0.7);
    let wz = dz * sp + (this.sepOut.z + n.az) * Math.max(0.6, sp * 0.7);
    const wl = Math.hypot(wx, wz);
    const maxS = speed * 1.15;
    if (wl > maxS) {
      wx = (wx / wl) * maxS;
      wz = (wz / wl) * maxS;
    }
    const k = Math.min(1, dt * 6);
    n.vx += (wx - n.vx) * k;
    n.vz += (wz - n.vz) * k;
    n.x += n.vx * dt;
    n.z += n.vz * dt;
    n.speed = Math.hypot(n.vx, n.vz);
    if (n.speed > 0.12) {
      const target = Math.atan2(n.vx, n.vz);
      n.yaw += wrap(target - n.yaw) * Math.min(1, dt * (speed > 3 ? 10 : 7));
    }
    return d;
  }

  /** Walk / run / idle clip from the actual speed (feet don't slide). */
  private locomotion(n: Npc, running: boolean): void {
    const s = n.scale;
    if (running && n.speed > 1.8) {
      const panic = n.st === S.Flee && !n.calm;
      if (panic) this.play(n, CLIP.flee, 0.2, (0.6 * n.speed) / (FLEE_STRIDE * s));
      else this.play(n, CLIP.run, 0.2, (0.66 * n.speed) / (RUN_STRIDE * s));
    } else if (n.speed > 0.28) {
      this.play(n, CLIP.walk, 0.25, n.speed / (WALK_STRIDE * s));
    } else if (n.clipA === CLIP.walk || n.clipA === CLIP.run || n.clipA === CLIP.flee) {
      this.play(n, CLIP.idle, 0.3, 1, rand() * 4);
    }
  }

  // ═══════════════════════════════════════ behaviour per NPC ═══════════════════════════════════════
  private updateNpc(n: Npc, dt: number, alpha: number): void {
    n.stT += dt;
    // animation clocks
    n.tA += dt * n.rateA;
    n.tB += dt * n.rateB;
    if (n.wB > 0) n.wB = Math.max(0, n.wB - dt * n.fadeRate);
    if (n.reactT >= 0) {
      n.reactT -= dt;
      if (n.reactT < 0) {
        n.reactT = 0;
        this.react(n);
      }
    }
    switch (n.st) {
      case S.Walk:
        this.doWalk(n, dt);
        break;
      case S.Return: {
        const d = this.steer(n, n.tx, n.tz, n.want, dt);
        this.locomotion(n, false);
        this.refreshGround(n, dt);
        n.y += (n.gy - n.y) * Math.min(1, dt * 10);
        if (d < 0.6 || n.stT > 40) {
          if (n.edge >= 0 && this.nav.edges[n.edge]) {
            const e = this.nav.edges[n.edge];
            const fx = Math.sin(n.yaw), fz = Math.cos(n.yaw);
            this.startWalkOn(n, n.edge, e.dx * fx + e.dz * fz >= 0 ? 1 : -1);
          } else if (!n.vis) this.despawn(n);
          else this.enterReturn(n);
        }
        break;
      }
      case S.Wander: {
        const d = this.steer(n, n.tx, n.tz, n.want * 0.85, dt, 0.8);
        this.locomotion(n, false);
        this.refreshGround(n, dt);
        n.y += (n.gy - n.y) * Math.min(1, dt * 10);
        if (d < 0.5 || n.stT > n.stDur) {
          n.actT -= n.stT;
          if (n.actT <= 0 && n.act === ACT.Wander && !this.nav.empty) {
            n.act = ACT.Walker;
            this.enterReturn(n);
          } else this.enterStand(n, this.waitClip(), rr(2, 8));
        }
        break;
      }
      case S.Stand: {
        this.brake(n, dt);
        if (n.tyaw !== 0 && n.lookT > 0) n.yaw += wrap(n.tyaw - n.yaw) * Math.min(1, dt * 3);
        const c = this.clips[n.clipA];
        if (n.stT > n.stDur && (c.loop || n.tA >= c.duration)) {
          n.tyaw = 0;
          this.resume(n);
        }
        break;
      }
      case S.Group:
        this.doGroup(n, dt);
        break;
      case S.Approach: {
        const d = this.steer(n, n.tx, n.tz, n.want, dt, 0.7);
        this.locomotion(n, false);
        this.refreshGround(n, dt);
        n.y += (n.gy - n.y) * Math.min(1, dt * 10);
        if (d < 0.22 || (d < 0.6 && n.stT > 12)) {
          n.vx = n.vz = 0;
          n.speed = 0;
          this.play(n, CLIP.idle, 0.25);
          const err = wrap(n.tyaw - n.yaw);
          n.yaw += err * Math.min(1, dt * 5);
          if (Math.abs(err) < 0.12) {
            if (n.bench >= 0) this.beginSitDown(n);
            else {
              n.yaw = n.tyaw;
              this.enterStand(n, this.waitClip(), rr(4, 10));
            }
          }
        } else if (n.stT > 25) this.enterReturn(n);
        break;
      }
      case S.SitDown: {
        const b = this.benchList[n.bench];
        if (!b) {
          this.enterReturn(n);
          break;
        }
        const k = sstep(0.1, 0.85, n.tA / this.clips[CLIP.sitDown].duration);
        n.y = n.gy + (b.p.y - n.scale * SEAT_H - n.gy) * k;
        if (this.clipDone(n)) {
          n.y = b.p.y - n.scale * SEAT_H;
          n.st = S.Sit;
          n.stT = 0;
          n.stDur = rr(12, 50);
          this.play(n, rand() < 0.3 ? CLIP.sitPhone : CLIP.sit, 0.35, 1, rand() * 4);
        }
        break;
      }
      case S.Sit: {
        if ((n.stT % 0.5) < dt) {
          const b = this.benchList[n.bench];
          if (!b || this.benchOff[n.bench] || (b.propIndex >= 0 && this.ctx.props.isDisturbed(b.propIndex))) {
            // the bench got knocked away: jump up startled
            if (n.bench >= 0) this.benchOff[n.bench] = !b || this.benchOff[n.bench] || b.propIndex >= 0;
            n.st = S.StandUp;
            n.stT = 0;
            n.reactKind = 2;
            n.escX = -Math.sin(n.yaw);
            n.escZ = -Math.cos(n.yaw);
            this.play(n, CLIP.standUp, 0.12, 1.7);
            break;
          }
        }
        if (n.stT > n.stDur) {
          n.st = S.StandUp;
          n.stT = 0;
          n.reactKind = 0;
          this.play(n, CLIP.standUp, 0.3);
        }
        break;
      }
      case S.StandUp: {
        const b = this.benchList[n.bench];
        const gy = b ? b.p.y - b.seatHeight : n.gy;
        const k = sstep(0.15, 0.9, n.tA / this.clips[CLIP.standUp].duration);
        const sy = b ? b.p.y - n.scale * SEAT_H : n.y;
        n.y = sy + (gy - sy) * k;
        if (this.clipDone(n)) {
          const d = SIT_STAND_Z * n.scale;
          n.x += Math.sin(n.yaw) * d;
          n.z += Math.cos(n.yaw) * d;
          n.y = gy;
          n.gy = gy;
          n.gx = 1e9;
          this.play(n, CLIP.idle, 0, 1, 0);
          const wasBus = n.act === ACT.Bus;
          if (n.bench >= 0 && n.seat >= 0 && this.benchOcc[n.bench]?.[n.seat] === n.i) this.benchOcc[n.bench][n.seat] = -1;
          n.bench = n.seat = -1;
          if (n.reactKind === 2) {
            n.reactKind = 0;
            this.startFlee(n, n.escX, n.escZ, rr(1.2, 2.5), n.x - n.escX, n.z - n.escZ);
          } else if (n.act === ACT.Ambient) this.pickWanderTarget(n);
          else {
            if (!wasBus) {
              this.releaseSlots(n);
              n.act = ACT.Walker;
            } else n.actT = 0;
            this.enterReturn(n);
          }
        }
        break;
      }
      case S.Evade:
        this.doEvade(n, dt);
        break;
      case S.Flee: {
        // keep running away from the threat; bend around obstacles
        const tx = n.x + n.escX * 4, tz = n.z + n.escZ * 4;
        this.steer(n, tx, tz, (n.calm ? 2.9 : CONFIG.npc.runSpeed) * n.app.pace, dt);
        this.locomotion(n, true);
        this.refreshGround(n, dt);
        n.y += (n.gy - n.y) * Math.min(1, dt * 10);
        if (n.stT > n.stDur) {
          n.lookX = n.threatX;
          n.lookZ = n.threatZ;
          n.lookY = n.y + 1;
          n.lookT = 2.5;
          const wasCalm = n.calm;
          n.calm = false;
          this.enterStand(n, wasCalm ? CLIP.idle : CLIP.lookAround, wasCalm ? rr(0.8, 1.6) : rr(1.5, 3));
        }
        break;
      }
      case S.Knocked:
        this.doKnocked(n, dt, alpha);
        break;
      case S.Settle: {
        const e = sstep(0, 1, n.stT / 0.45);
        n.px = n.s0.x + (n.s1.x - n.s0.x) * e;
        n.py = n.s0.y + (n.s1.y - n.s0.y) * e;
        n.pz = n.s0.z + (n.s1.z - n.s0.z) * e;
        n.q.slerpQuaternions(n.q0, n.q1, e);
        if (n.stT >= 0.45) {
          n.body = false;
          n.x = n.s1.x;
          n.z = n.s1.z;
          n.y = n.gy;
          n.yaw = n.settleYaw;
          n.gx = n.x;
          n.gz = n.z;
          if (n.upright) {
            this.play(n, CLIP.idle, 0, 1, 0);
            this.enterStand(n, CLIP.lookAround, rr(1, 2), 0.3);
          } else {
            this.play(n, n.front ? CLIP.lieFront : CLIP.lieBack, 0, 1, n.tA);
            n.st = S.Lying;
            n.stT = 0;
            n.stDur = rr(CONFIG.npc.lieMin, CONFIG.npc.lieMax);
          }
        }
        break;
      }
      case S.Lying:
        if (n.stT > n.stDur) {
          n.st = S.GetUp;
          n.stT = 0;
          this.play(n, n.front ? CLIP.getUpFront : CLIP.getUpBack, 0.3);
        }
        break;
      case S.GetUp:
        if (this.clipDone(n)) {
          const d = this.clips[n.clipA].rootEndZ * n.scale;
          n.x += Math.sin(n.yaw) * d;
          n.z += Math.cos(n.yaw) * d;
          this.refreshGround(n, 0, true);
          n.y = n.gy;
          this.play(n, CLIP.idle, 0, 1, 0);
          const c = this.car;
          if (c.active) {
            n.lookX = c.x;
            n.lookY = c.y + 0.6;
            n.lookZ = c.z;
            n.lookT = 2.5;
          }
          if (c.active && Math.hypot(c.x - n.x, c.z - n.z) < 18 && rand() < 0.7) {
            const dx = n.x - c.x, dz = n.z - c.z;
            const l = Math.hypot(dx, dz) || 1;
            this.startFlee(n, dx / l, dz / l, rr(1.5, 3), c.x, c.z);
          } else this.enterStand(n, rand() < 0.5 ? CLIP.lookAround : CLIP.idle, rr(1, 2.5), 0.3);
        }
        break;
      case S.Stumble: {
        const t = Math.min(1, n.tA / 1.0);
        const k = 1 - (1 - t) * (1 - t);
        n.x = n.evX + n.escX * n.evDist * k;
        n.z = n.evZ + n.escZ * n.evDist * k;
        this.refreshGround(n, dt);
        n.y += (n.gy - n.y) * Math.min(1, dt * 10);
        if (this.clipDone(n)) this.resume(n);
        break;
      }
      case S.Fall:
        if (this.clipDone(n)) {
          n.front = false;
          this.play(n, CLIP.lieBack, 0.15);
          n.st = S.Lying;
          n.stT = 0;
          n.stDur = rr(CONFIG.npc.lieMin, CONFIG.npc.lieMax);
        }
        break;
      case S.WaitCross: {
        this.brake(n, dt);
        if ((n.stT % 0.25) < dt && !this.carNearCrossing(n)) {
          n.st = S.Walk;
          n.stT = 0;
        } else if (n.stT > 12) {
          n.st = S.Walk;
          n.stT = 0;
        }
        if (n.st === S.Walk) this.play(n, CLIP.walk, 0.25);
        break;
      }
    }
    this.updateHead(n, dt);
  }

  private brake(n: Npc, dt: number): void {
    if (n.speed > 0.01) {
      const k = Math.max(0, 1 - dt * 8);
      n.vx *= k;
      n.vz *= k;
      n.x += n.vx * dt;
      n.z += n.vz * dt;
      n.speed = Math.hypot(n.vx, n.vz);
    }
    // standing NPCs still get nudged apart / out of obstacles
    this.updateAvoid(n, dt, false);
    if (n.ax !== 0 || n.az !== 0) {
      const l = Math.hypot(n.ax, n.az);
      if (l > 1.2) {
        n.x += (n.ax / l) * dt * 0.8;
        n.z += (n.az / l) * dt * 0.8;
      }
    }
  }

  private doWalk(n: Npc, dt: number): void {
    const nav = this.nav;
    const e = nav.edges[n.edge];
    if (!e) {
      this.enterReturn(n);
      return;
    }
    const from = nav.nodes[n.dir > 0 ? e.a : e.b];
    const fx = e.dx * n.dir, fz = e.dz * n.dir;
    const rx = -fz, rz = fx;
    const s = (n.x - from.x) * fx + (n.z - from.z) * fz;
    const rem = e.len - s;
    const hw = Math.max(0.1, e.width / 2 - 0.35);
    const lat = Math.max(-hw, Math.min(hw, n.lat));
    let tx: number, tz: number;
    if (rem > LOOK_AHEAD || n.nextEdge < 0) {
      const ss = Math.min(e.len, s + LOOK_AHEAD);
      tx = from.x + fx * ss + rx * lat;
      tz = from.z + fz * ss + rz * lat;
    } else {
      const ne = nav.edges[n.nextEdge];
      const nfrom = nav.nodes[n.nextDir > 0 ? ne.a : ne.b];
      const nfx = ne.dx * n.nextDir, nfz = ne.dz * n.nextDir;
      const nhw = Math.max(0.1, ne.width / 2 - 0.35);
      const nl = Math.max(-nhw, Math.min(nhw, n.lat));
      const ss = Math.min(ne.len, LOOK_AHEAD - Math.max(0, rem));
      tx = nfrom.x + nfx * ss - nfz * nl;
      tz = nfrom.z + nfz * ss + nfx * nl;
      // wait at the curb if the car is coming
      if (ne.cross && !e.cross && rem < 1.2 && this.carNearCrossing(n)) {
        n.st = S.WaitCross;
        n.stT = 0;
        n.lookX = this.car.x;
        n.lookZ = this.car.z;
        n.lookY = this.car.y + 0.6;
        n.lookT = 2;
        this.play(n, rand() < 0.5 ? CLIP.lookAround : CLIP.idle, 0.3);
        return;
      }
    }
    this.steer(n, tx, tz, n.want, dt);
    // blocked (parked car across the sidewalk, crowd jam): turn around
    if (n.speed < 0.22) n.stuckT += dt;
    else n.stuckT = 0;
    if (n.stuckT > 2.5) {
      n.stuckT = 0;
      n.dir = -n.dir;
      this.chooseNext(n);
    }
    this.locomotion(n, false);
    // stay inside the walkable corridor (current or next edge)
    this.clampCorridor(n, e, from, fx, fz, hw);
    this.refreshGround(n, dt);
    n.y += (n.gy - n.y) * Math.min(1, dt * 10);
    if (rem < 0.35) this.atNode(n);
  }

  private clampCorridor(n: Npc, e: { len: number; width: number }, from: { x: number; z: number }, fx: number, fz: number, hw: number): void {
    const s = (n.x - from.x) * fx + (n.z - from.z) * fz;
    const sc = Math.max(0, Math.min(e.len, s));
    const lx = n.x - (from.x + fx * sc), lz = n.z - (from.z + fz * sc);
    const d = Math.hypot(lx, lz);
    const lim = hw + 0.3;
    if (d > lim) {
      // allowed if inside the next edge's corridor (turning a corner)
      if (n.nextEdge >= 0) {
        const ne = this.nav.edges[n.nextEdge];
        const na = this.nav.nodes[ne.a];
        let t = (n.x - na.x) * ne.dx + (n.z - na.z) * ne.dz;
        t = Math.max(0, Math.min(ne.len, t));
        const d2 = Math.hypot(n.x - (na.x + ne.dx * t), n.z - (na.z + ne.dz * t));
        if (d2 < ne.width / 2) return;
      }
      n.x -= (lx / d) * (d - lim);
      n.z -= (lz / d) * (d - lim);
    }
  }

  private carNearCrossing(n: Npc): boolean {
    const c = this.car;
    if (!c.active || c.speed < 3) return false;
    const dx = n.x - c.x, dz = n.z - c.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 38 * 38) return false;
    return dx * c.vx + dz * c.vz > 0 || d2 < 64;
  }

  private doGroup(n: Npc, dt: number): void {
    const g = this.groupsArr[n.group];
    if (!g || !g.active) {
      n.act = ACT.Walker;
      this.enterReturn(n);
      return;
    }
    this.brake(n, dt);
    const speaking = g.speaker === n.i;
    if (speaking) {
      if (n.clipA !== CLIP.talk) this.play(n, CLIP.talk, 0.4, rr(0.9, 1.1), rand() * 4);
    } else if (n.clipA === CLIP.talk || n.stT > n.stDur) {
      n.stT = 0;
      n.stDur = rr(4, 10);
      const r = rand();
      this.play(n, r < 0.55 ? CLIP.idle : r < 0.8 ? CLIP.armsCrossed : CLIP.phone, 0.45, 1, rand() * 4);
    }
    // look at the speaker (speaker looks around the circle)
    if (n.lookT <= 0) {
      const target = speaking ? this.npcs[g.members[Math.floor((n.stT * 0.3) % g.members.length)]] : this.npcs[g.speaker];
      if (target && target !== n) {
        n.lookX = target.x;
        n.lookZ = target.z;
        n.lookY = target.y + 1.6 * target.scale;
      } else {
        n.lookX = g.x;
        n.lookZ = g.z;
        n.lookY = n.y + 1.5;
      }
    }
    // members drift off eventually
    n.actT -= dt;
    if (n.actT <= 0 && !this.nav.empty) {
      this.releaseSlots(n);
      n.act = ACT.Walker;
      this.enterReturn(n);
    }
  }

  private beginSitDown(n: Npc): void {
    const b = this.benchList[n.bench];
    if (!b || this.freeSeatFor(n) === false) {
      this.enterReturn(n);
      return;
    }
    this.seatOrigin(b, n.seat, n.scale, this.seatOut);
    n.x = this.seatOut.x;
    n.z = this.seatOut.z;
    n.yaw = b.yaw;
    n.gy = b.p.y - b.seatHeight;
    n.gx = n.x;
    n.gz = n.z;
    n.gT = 1e9;
    n.y = n.gy;
    n.st = S.SitDown;
    n.stT = 0;
    this.play(n, CLIP.sitDown, 0);
  }

  private freeSeatFor(n: Npc): boolean {
    if (n.bench < 0 || this.benchOff[n.bench]) return false;
    const b = this.benchList[n.bench];
    if (b.propIndex >= 0 && this.ctx.props.isDisturbed(b.propIndex)) return false;
    return this.benchOcc[n.bench][n.seat] === n.i;
  }

  private doEvade(n: Npc, dt: number): void {
    const t = n.tA;
    let k: number;
    if (n.reactKind === 1) {
      k = t < 0.12 ? 0 : t < 0.76 ? 0.88 * sstep(0.12, 0.76, t) : 0.88 + 0.12 * sstep(0.76, 1.0, t);
      n.yaw += wrap(Math.atan2(n.escX, n.escZ) - n.yaw) * Math.min(1, dt * 22);
    } else {
      k = sstep(0.08, 0.55, t);
    }
    n.x = n.evX + n.escX * n.evDist * k;
    n.z = n.evZ + n.escZ * n.evDist * k;
    this.updateAvoid(n, dt, true);
    if (this.avoidOut.inside) {
      n.evX += this.avoidOut.x * 0.05;
      n.evZ += this.avoidOut.z * 0.05;
    }
    this.refreshGround(n, dt);
    n.y += (n.gy - n.y) * Math.min(1, dt * 12);
    if (this.clipDone(n)) {
      if (n.reactKind === 1) {
        n.front = true;
        this.play(n, CLIP.lieFront, 0.2);
        n.st = S.Lying;
        n.stT = 0;
        n.stDur = rr(0.5, 1.3);
      } else if (rand() < 0.5) this.startFlee(n, n.escX, n.escZ, rr(1, 2), n.threatX, n.threatZ);
      else {
        n.lookX = n.threatX;
        n.lookZ = n.threatZ;
        n.lookT = 2;
        this.enterStand(n, CLIP.lookAround, rr(1, 2), 0.2);
      }
    }
  }

  /**
   * Cheap analytic tumble (no physics body): integrate velocity + spin, ground clamp via groundHeightAt with a small
   * bounce and sliding friction, a tip-over bias so people end up lying down, building footprints as walls.
   */
  private doBallistic(n: Npc, dt: number): void {
    const g = CONFIG.physics.gravity;
    n.bvy += g * dt;
    const ox = n.px, oz = n.pz;
    n.px += n.bvx * dt;
    n.py += n.bvy * dt;
    n.pz += n.bvz * dt;
    if (this.nav.insideBuilding(n.px, n.pz, 0.22)) {
      n.px = ox;
      n.pz = oz;
      n.bvx *= -0.3;
      n.bvz *= -0.3;
    }
    n.gT -= dt;
    if (n.gT <= 0) {
      n.gy = this.ground(n.px, n.pz);
      n.gT = 0.08;
      if (n.py < CONFIG.world.killY || (n.py < n.gy + 0.6 && this.ctx.world.isDeepWater?.(n.px, n.pz))) {
        this.despawn(n);
        return;
      }
    }
    // spin (world-space angular velocity)
    const wl = Math.hypot(n.bwx, n.bwy, n.bwz);
    if (wl > 1e-4) {
      this.tmpV.set(n.bwx / wl, n.bwy / wl, n.bwz / wl);
      this.tmpQ.setFromAxisAngle(this.tmpV, wl * dt);
      n.q.premultiply(this.tmpQ).normalize();
    }
    const h = this.tmpV2.set(0, 1, 0).applyQuaternion(n.q);
    const ext = Math.abs(h.y) * 0.56 * n.scale + 0.2;
    let grounded = false;
    if (n.py - ext < n.gy) {
      grounded = true;
      n.py = n.gy + ext;
      if (n.bvy < 0) n.bvy = n.bvy < -2.5 ? -n.bvy * 0.25 : 0;
      const f = Math.max(0, 1 - 5 * dt);
      n.bvx *= f;
      n.bvz *= f;
      const fa = Math.max(0, 1 - 4 * dt);
      n.bwx *= fa;
      n.bwy *= fa;
      n.bwz *= fa;
      // tip over toward lying flat
      if (Math.abs(h.y) > 0.12) {
        let ax = h.z, az = -h.x;
        const al = Math.hypot(ax, az);
        if (al < 0.05) {
          ax = 1;
          az = 0;
        } else {
          ax /= al;
          az /= al;
        }
        const sgn = h.y > 0 ? 1 : -1;
        n.bwx += ax * sgn * 9 * dt;
        n.bwz += az * sgn * 9 * dt;
      }
    } else {
      const fa = Math.max(0, 1 - 0.4 * dt);
      n.bwx *= fa;
      n.bwy *= fa;
      n.bwz *= fa;
    }
    const v2 = n.bvx * n.bvx + n.bvy * n.bvy + n.bvz * n.bvz;
    const w2 = n.bwx * n.bwx + n.bwy * n.bwy + n.bwz * n.bwz;
    if (grounded && v2 < 0.5 && w2 < 3 && Math.abs(h.y) < 0.35) n.slowT += dt;
    else n.slowT = 0;
    if (n.slowT > 0.2 || n.stT > 4.5) this.beginSettle(n);
  }

  private doKnocked(n: Npc, dt: number, alpha: number): void {
    if (n.rag < 0) {
      this.doBallistic(n, dt);
      return;
    }
    const r = this.rags[n.rag];
    if (!r || r.npc !== n.i) {
      this.beginSettle(n);
      return;
    }
    n.px = r.prev.x + (r.curr.x - r.prev.x) * alpha;
    n.py = r.prev.y + (r.curr.y - r.prev.y) * alpha;
    n.pz = r.prev.z + (r.curr.z - r.prev.z) * alpha;
    n.q.slerpQuaternions(r.prevQ, r.currQ, alpha);
    n.gT -= dt;
    if (n.gT <= 0) {
      n.gy = this.ground(n.px, n.pz);
      n.gT = 0.15;
    }
    const lv = r.body.linvel();
    const av = r.body.angvel();
    const v2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
    const w2 = av.x * av.x + av.y * av.y + av.z * av.z;
    if (v2 < 0.5 && w2 < 4 && n.py - n.gy < 0.7) n.slowT += dt;
    else n.slowT = 0;
    if (n.py < CONFIG.world.killY || (this.ctx.world.isDeepWater?.(n.px, n.pz) && n.py < n.gy + 0.5)) {
      this.despawn(n);
      return;
    }
    if (n.slowT > 0.25 || n.stT > 5) this.beginSettle(n);
  }

  // ───────────── head look ─────────────
  private updateHead(n: Npc, dt: number): void {
    let ty = 0, tp = 0;
    const st = n.st;
    const can = st !== S.Knocked && st !== S.Settle && st !== S.Lying && st !== S.GetUp && st !== S.Evade && st !== S.Fall && st !== S.Stumble && st !== S.SitDown && st !== S.StandUp && st !== S.Flee;
    if (can) {
      let lx = 0, lz = 0, ly = 0, has = false;
      if (n.lookT > 0) {
        n.lookT -= dt;
        lx = n.lookX;
        lz = n.lookZ;
        ly = n.lookY;
        has = true;
      } else if (st === S.Group) {
        lx = n.lookX;
        lz = n.lookZ;
        ly = n.lookY;
        has = true;
      } else {
        const c = this.car;
        if (c.active && c.speed > 1.2 && n.curious > 0.25) {
          const d2 = (c.x - n.x) ** 2 + (c.z - n.z) ** 2;
          const R = CONFIG.npc.lookRadius;
          if (d2 < R * R) {
            lx = c.x;
            lz = c.z;
            ly = c.y + 0.7;
            has = true;
          }
        }
      }
      if (has) {
        const dx = lx - n.x, dz = lz - n.z;
        const rel = wrap(Math.atan2(dx, dz) - n.yaw);
        if (Math.abs(rel) < 2.0) {
          ty = Math.max(-1.2, Math.min(1.2, rel));
          const headY = n.y + 1.6 * n.scale;
          tp = Math.max(-0.35, Math.min(0.4, Math.atan2(headY - ly, Math.hypot(dx, dz) + 0.1)));
          if (n.clipA === CLIP.phone || n.clipA === CLIP.sitPhone) tp = Math.min(tp, 0) - 0.15;
        }
      }
    }
    const k = Math.min(1, dt * 5);
    n.hy += (ty - n.hy) * k;
    n.hp += (tp - n.hp) * k;
  }

  // ═══════════════════════════════════════ rendering ═══════════════════════════════════════
  private render(): void {
    const C = CONFIG.npc;
    const q = this.ctx.quality;
    const lodScale = q.level === 'low' ? 0.7 : q.level === 'medium' ? 0.85 : 1;
    const maxLod0 = (C.maxLod0 as Record<string, number>)[q.level] ?? 12;
    const lod0D = C.lod0Dist * lodScale;
    const lod1D = C.lod1Dist * lodScale;
    for (const L of this.lods) L.count = 0;
    let nv = 0;
    // visibility + sort by distance
    for (const n of this.npcs) {
      if (!n.active) {
        n.vis = false;
        continue;
      }
      const cx = n.body ? n.px : n.x;
      const cy = n.body ? n.py : n.y + 0.9 * n.scale;
      const cz = n.body ? n.pz : n.z;
      const d = Math.hypot(cx - this.camPos.x, cy - this.camPos.y, cz - this.camPos.z);
      n.dist = d;
      this.sphere.center.set(cx, cy, cz);
      this.sphere.radius = 1.15 * n.scale + d * 0.1;
      n.vis = this.frustum.intersectsSphere(this.sphere);
      if (!n.vis) continue;
      // insertion sort by distance (nearly sorted frame to frame)
      let j = nv++;
      while (j > 0 && this.visKey[j - 1] > d) {
        this.visKey[j] = this.visKey[j - 1];
        this.visIdx[j] = this.visIdx[j - 1];
        j--;
      }
      this.visKey[j] = d;
      this.visIdx[j] = n.i;
    }
    let nb = 0;
    const blobArr = this.blob.instanceMatrix.array as Float32Array;
    const shadowD = C.shadowDist;
    for (let k = 0; k < nv; k++) {
      const n = this.npcs[this.visIdx[k]];
      const lod = n.dist < lod0D && this.lods[0].count < maxLod0 ? 0 : n.dist < lod1D ? 1 : 2;
      this.writeInstance(n, this.lods[lod]);
      if (n.dist < shadowD && nb < this.poolSize) this.writeBlob(n, blobArr, nb++);
    }
    for (const L of this.lods) {
      L.mesh.count = L.count;
      if (L.count > 0) {
        for (const a of [L.animA, L.animB, L.col0, L.col1, L.extra]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, L.count * 4);
          a.needsUpdate = true;
        }
        L.mesh.instanceMatrix.clearUpdateRanges();
        L.mesh.instanceMatrix.addUpdateRange(0, L.count * 16);
        L.mesh.instanceMatrix.needsUpdate = true;
      }
      L.mesh.visible = L.count > 0;
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
    this.debug.visible = nv;
    this.debug.lod[0] = this.lods[0].count;
    this.debug.lod[1] = this.lods[1].count;
    this.debug.lod[2] = this.lods[2].count;
  }

  private frameRows(clip: number, t: number, out: Float32Array, o: number): void {
    const c = this.clips[clip];
    let f = t * c.fps;
    let i0: number, i1: number, fr: number;
    if (c.loop) {
      f %= c.frames;
      if (f < 0) f += c.frames;
      i0 = Math.floor(f);
      fr = f - i0;
      i1 = (i0 + 1) % c.frames;
    } else {
      const max = c.frames - 1;
      if (f >= max) {
        i0 = i1 = max;
        fr = 0;
      } else {
        if (f < 0) f = 0;
        i0 = Math.floor(f);
        i1 = i0 + 1;
        fr = f - i0;
      }
    }
    out[o] = c.start + i0;
    out[o + 1] = c.start + i1;
    out[o + 2] = fr;
  }

  private writeInstance(n: Npc, L: LodMesh): void {
    const k = L.count++;
    const m = L.mesh.instanceMatrix.array as Float32Array;
    const o = k * 16;
    const s = n.scale;
    if (!n.body) {
      const c = Math.cos(n.yaw) * s, sn = Math.sin(n.yaw) * s;
      m[o] = c;
      m[o + 1] = 0;
      m[o + 2] = -sn;
      m[o + 3] = 0;
      m[o + 4] = 0;
      m[o + 5] = s;
      m[o + 6] = 0;
      m[o + 7] = 0;
      m[o + 8] = sn;
      m[o + 9] = 0;
      m[o + 10] = c;
      m[o + 11] = 0;
      m[o + 12] = n.x;
      m[o + 13] = n.y;
      m[o + 14] = n.z;
      m[o + 15] = 1;
    } else {
      // T(pelvis) · R(q) · S(s) · T(0, -HIP_H, 0)
      this.tmpM.makeRotationFromQuaternion(n.q);
      const e = this.tmpM.elements;
      for (let i = 0; i < 3; i++) {
        m[o + i] = e[i] * s;
        m[o + 4 + i] = e[4 + i] * s;
        m[o + 8 + i] = e[8 + i] * s;
      }
      m[o + 3] = m[o + 7] = m[o + 11] = 0;
      m[o + 12] = n.px - e[4] * s * HIP_H;
      m[o + 13] = n.py - e[5] * s * HIP_H;
      m[o + 14] = n.pz - e[6] * s * HIP_H;
      m[o + 15] = 1;
    }
    const a = L.animA.array as Float32Array;
    const b = L.animB.array as Float32Array;
    const q4 = k * 4;
    this.frameRows(n.clipA, n.tA, a, q4);
    a[q4 + 3] = n.wB;
    this.frameRows(n.wB > 0.002 ? n.clipB : n.clipA, n.wB > 0.002 ? n.tB : n.tA, b, q4);
    b[q4 + 3] = n.fade;
    const app = n.app;
    const c0 = L.col0.array as Float32Array;
    c0[q4] = app.skin;
    c0[q4 + 1] = app.top;
    c0[q4 + 2] = app.bottom;
    c0[q4 + 3] = app.shoes;
    const c1 = L.col1.array as Float32Array;
    c1[q4] = app.hair;
    c1[q4 + 1] = app.acc;
    c1[q4 + 2] = app.inner;
    const dom = n.wB > 0.5 ? n.clipB : n.clipA;
    const phone = dom === CLIP.phone || dom === CLIP.sitPhone;
    c1[q4 + 3] = phone ? app.flags | PHONE_BIT : app.flags;
    const ex = L.extra.array as Float32Array;
    ex[q4] = n.hy;
    ex[q4 + 1] = n.hp;
    ex[q4 + 2] = app.shape;
    ex[q4 + 3] = 0;
  }

  private writeBlob(n: Npc, arr: Float32Array, k: number): void {
    const o = k * 16;
    const s = n.scale;
    let x: number, z: number, gy: number, yaw: number, w: number, l: number, a: number;
    if (n.body) {
      x = n.px;
      z = n.pz;
      gy = n.gy;
      // elongate along the body axis projected on the ground
      const h = this.tmpV.set(0, 1, 0).applyQuaternion(n.q);
      const hl = Math.hypot(h.x, h.z);
      yaw = Math.atan2(h.x, h.z);
      w = 0.62 * s;
      l = (0.62 + 1.2 * Math.min(1, hl)) * s;
      a = Math.max(0.15, Math.min(1, 1 - (n.py - gy - 0.9) / 4));
    } else if (n.st === S.Lying || (n.st === S.GetUp && n.tA < 0.9)) {
      yaw = n.yaw;
      const off = (n.front ? -0.05 : 0.05) * s; // body extends toward the feet
      x = n.x + Math.sin(yaw) * off;
      z = n.z + Math.cos(yaw) * off;
      gy = n.y;
      w = 0.7 * s;
      l = 1.85 * s;
      a = 1;
    } else {
      x = n.x;
      z = n.z;
      yaw = n.yaw;
      gy = n.st === S.Sit || n.st === S.SitDown || n.st === S.StandUp ? n.gy : n.y;
      const sitting = n.st === S.Sit;
      if (sitting) {
        x += Math.sin(yaw) * 0.18 * s;
        z += Math.cos(yaw) * 0.18 * s;
      }
      w = 0.72 * s;
      l = (sitting ? 0.95 : 0.78) * s;
      a = 1;
    }
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    arr[o] = c * w;
    arr[o + 1] = 0;
    arr[o + 2] = -sn * w;
    arr[o + 3] = 0;
    arr[o + 4] = 0;
    arr[o + 5] = 1;
    arr[o + 6] = 0;
    arr[o + 7] = 0;
    arr[o + 8] = sn * l;
    arr[o + 9] = 0;
    arr[o + 10] = c * l;
    arr[o + 11] = 0;
    arr[o + 12] = x;
    arr[o + 13] = gy + 0.03;
    arr[o + 14] = z;
    arr[o + 15] = 1;
    (this.blobA.array as Float32Array)[k] = a * n.fade;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    for (const L of this.lods) {
      L.mesh.geometry.dispose();
      (L.mesh.material as THREE.Material).dispose();
      L.mesh.customDepthMaterial?.dispose();
      L.mesh.dispose();
    }
    this.blob.geometry.dispose();
    (this.blob.material as THREE.Material).dispose();
    this.blob.dispose();
    this.uniforms.uNpcAnim.value?.dispose();
    this.root.removeFromParent();
    this.testWorld?.dispose();
    this.crowd.dispose();
    for (const r of this.rags) this.ctx.physics.removeBody(r.body);
    this.rags.length = 0;
  }
}

// keep type-only imports referenced for isolatedModules
export type { Vec3 };
