import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { approach, clamp, dampAngle, smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { AvatarGroupHandle, GameContext } from '../game/contracts';
import type { PlaneCabin, PlaneVisual, TrackedPlane } from '../plane/types';

type Kind = 'belted' | 'loose' | 'crew';
type Mode = 'seat' | 'stand' | 'walk' | 'thrown' | 'fall' | 'ground';

interface Person {
  kind: Kind;
  seat: number; // seat index (seated people), -1 = standing
  mode: Mode;
  sec: number; // cabin section (index into cabin.sections)
  p: THREE.Vector3; // root space (cabin modes)
  v: THREE.Vector3; // root space, relative to the cabin
  yaw: number; // root yaw (0 = toward the nose, +Z)
  wp: THREE.Vector3; // world (fall / ground)
  wv: THREE.Vector3;
  // scripted reaction: `react` from `start` to `until`, then `next` until `nextUntil`, then back to the default
  react: string | null;
  start: number;
  started: boolean;
  until: number;
  next: string | null;
  nextUntil: number;
  // crew walking
  target: number;
  pause: number;
  calm: number; // s of normal gravity (getting back up)
  land: number;
  hidden: boolean;
}

interface SectionFrame {
  obj: THREE.Object3D | null;
  com: THREE.Vector3;
  body: RAPIER.RigidBody | null;
  vPrev: THREE.Vector3;
  acc: THREE.Vector3;
  gApp: THREE.Vector3; // apparent gravity in the section frame
  hist: number;
  q: THREE.Quaternion;
}

const G = 9.81;
const R = 0.22;
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/**
 * PASSENGERS AND CREW (user request). Some seats are taken — not a full plane — and the same people sit in the same
 * seats on every flight of a type (seeded). Most wear their seatbelt and ride their seat whatever happens; their
 * reactions are hard-coded per event (no state machine of their own): an engine blast makes the people at the windows
 * near that engine panic, look out and scream (mildly), the rest of that side looks worried; a split / tail blast or
 * an explosion makes everyone panic then brace; a spin or a dive keeps them braced with the odd scream.
 * Two flight attendants walk up and down the aisles, and a few passengers are out of their seats — they all have the
 * player's physics: the apparent gravity of the section they are in throws them around in a spin, they float in a
 * dive, a torn-open end sucks them out, they fall and land (and stay there).
 * Rendered (one draw call) only while their cabin can be seen: walking inside, or a torn-open airframe up close.
 */
export class CabinPeople {
  private group: AvatarGroupHandle | null = null;
  private visual: PlaneVisual | null = null;
  private cabin: PlaneCabin | null = null;
  private tracked: TrackedPlane | null = null;
  private people: Person[] = [];
  private secs: SectionFrame[] = [];
  private t = 0;
  private screamT = 0;
  private hidden = false;

  constructor(private ctx: GameContext) {}

  init(): void {
    const ev = this.ctx.events;
    ev.on('engineExplode', (e) => {
      if (!e.replay) this.onEngine(e.engine);
    });
    ev.on('planeExplosion', (e) => {
      if (!e.replay) this.onBlast(e.kind === 'secondary' ? 0.6 : 1);
    });
    ev.on('planeBreak', () => this.onBlast(0.8));
    ev.on('planeImpact', (e) => {
      if (!e.replay && e.outcome !== 'landing') this.onBlast(0.7);
    });
    ev.on('originShift', ({ delta }) => {
      for (const p of this.people) p.wp.sub(delta);
    });
  }

  /** The replay hides them (the simulation, and so this, is frozen while it plays). */
  setHidden(on: boolean): void {
    this.hidden = on;
    if (on && this.group) this.group.object.visible = false;
  }

  // ───────────────────────────── setup ─────────────────────────────
  private rebuild(visual: PlaneVisual | null): void {
    const { ctx } = this;
    this.visual = visual;
    this.cabin = visual?.cabin ?? null;
    this.people = [];
    this.secs = [];
    this.group?.dispose();
    this.group = null;
    const cab = this.cabin;
    if (!visual || !cab || !cab.seats.length) return;
    const C = CONFIG.walk.cabin;
    const type = visual.type;
    const max = (C.max as Record<string, number>)[type] ?? 0;
    if (max <= 0) return;
    // always the same passengers in the same seats for a plane type
    const rng = Rng.from(CONFIG.game.seed, 0x53454154, type.length * 31 + type.charCodeAt(0));
    const order = cab.seats.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const n = Math.min(max, Math.round(cab.seats.length * C.share));
    const nLoose = type === 'bizjet' ? 0 : Math.max(1, Math.round(n * C.looseShare));
    const nStand = Math.min(nLoose, 2);
    const nCrew = type === 'bizjet' ? 1 : C.crew;
    const looks: ('passenger' | 'hostess')[] = [];
    const mk = (kind: Kind, seat: number): Person => ({
      kind, seat, mode: seat >= 0 ? 'seat' : 'stand', sec: 0, p: new THREE.Vector3(), v: new THREE.Vector3(), yaw: 0,
      wp: new THREE.Vector3(), wv: new THREE.Vector3(), react: null, start: 0, started: false, until: 0, next: null, nextUntil: 0,
      target: 0, pause: 0, calm: 0, land: 0, hidden: true,
    });
    for (let k = 0; k < n; k++) {
      const seat = order[k];
      const loose = k < nLoose;
      const p = mk(loose ? 'loose' : 'belted', loose && k < nStand ? -1 : seat);
      const s = cab.seats[seat];
      if (p.seat >= 0) p.p.set(s.x, s.y + 0.02, s.z + 0.02);
      else {
        // standing in the aisle next to their seat (stretching their legs)
        p.p.set(this.aisleNear(s.x), cab.floorY, s.z + 0.35);
        p.yaw = rng.next() < 0.5 ? 0 : Math.PI;
      }
      this.people.push(p);
      looks.push('passenger');
    }
    for (let k = 0; k < nCrew; k++) {
      const p = mk('crew', -1);
      p.mode = 'walk';
      const z = cab.rearZ + (cab.frontZ - cab.rearZ) * (k === 0 ? 0.7 : 0.3);
      p.p.set(cab.aisles[k % cab.aisles.length] ?? 0, cab.floorY, z);
      p.target = z;
      p.pause = 1 + k * 2;
      this.people.push(p);
      looks.push('hostess');
    }
    for (const p of this.people) p.sec = this.secAt(p.p.z);
    this.secs = cab.sections.map((s) => {
      const info = visual.partByName[s.part];
      return { obj: info?.object ?? null, com: info?.com.clone() ?? new THREE.Vector3(), body: null, vPrev: new THREE.Vector3(), acc: new THREE.Vector3(), gApp: new THREE.Vector3(0, -G, 0), hist: 0, q: new THREE.Quaternion() };
    });
    this.group = ctx.npcs.createAvatarGroup?.(looks, type.length * 7 + type.charCodeAt(1)) ?? null;
    if (this.group) {
      this.group.object.visible = false;
      ctx.engine.scene.add(this.group.object);
      this.people.forEach((p, i) => this.group!.play(i, p.seat >= 0 ? 'sit' : p.kind === 'crew' ? 'walk' : 'lookAround', 0));
    }
  }

  private aisleNear(x: number): number {
    const a = this.cabin!.aisles;
    return a.reduce((b, c) => (Math.abs(c - x) < Math.abs(b - x) ? c : b), a[0] ?? 0);
  }

  private secAt(z: number): number {
    const S = this.cabin?.sections ?? [];
    for (let i = 0; i < S.length; i++) if (z >= S[i].z0 && z <= S[i].z1) return i;
    if (!S.length) return 0;
    return z > S[0].z1 ? 0 : S.length - 1;
  }

  private sample(arr: Float32Array, z: number): number {
    const c = this.cabin!;
    const f = clamp((z - c.rearZ) / c.step, 0, arr.length - 1);
    const i = Math.floor(f);
    const j = Math.min(arr.length - 1, i + 1);
    return arr[i] + (arr[j] - arr[i]) * (f - i);
  }

  // ───────────────────────────── reactions (hard-coded) ─────────────────────────────
  private reactTo(i: number, clip: string, dur: number, next: string | null = null, nextDur = 0, delay = 0): void {
    const p = this.people[i];
    if (!p || p.mode === 'fall' || p.mode === 'ground' || p.mode === 'thrown') return;
    p.react = clip;
    p.start = this.t + delay;
    p.started = false;
    p.until = p.start + dur;
    p.next = next;
    p.nextUntil = p.until + nextDur;
  }

  private onEngine(index: number): void {
    const vis = this.visual, cab = this.cabin;
    if (!vis || !cab || !this.people.length) return;
    const e = vis.engines[index - 1];
    if (!e) return;
    const ex = e.thrustPoint.x, ez = e.thrustPoint.z;
    const side = Math.sign(ex) || 1;
    const look = side > 0 ? 'sitLookPX' : 'sitLookNX';
    const scream: THREE.Vector3[] = [];
    this.people.forEach((p, i) => {
      if (p.seat < 0) {
        if (p.mode === 'stand' || p.mode === 'walk') this.reactTo(i, 'flinch', 0.7);
        return;
      }
      const s = cab.seats[p.seat];
      const dz = Math.abs(s.z - ez);
      if (Math.sign(s.x) === side && dz < 6) {
        // the window seats by that engine: panic, then stare at it
        this.reactTo(i, 'sitPanic', 2.6 + (i % 3) * 0.3, look, 8);
        if (scream.length < 3) scream.push(this.worldOf(p, new THREE.Vector3()));
      } else if (Math.sign(s.x) === side) this.reactTo(i, look, 5, null, 0, 0.3 + dz * 0.04);
      else this.reactTo(i, look, 3, null, 0, 0.5 + (i % 4) * 0.1);
    });
    for (const w of scream) this.ctx.events.emit('npcStartled', { position: w, count: 1, scream: true, level: CONFIG.walk.cabin.screamLevel });
  }

  private onBlast(k: number): void {
    if (!this.people.length || !this.visual) return;
    let first: THREE.Vector3 | null = null;
    this.people.forEach((p, i) => {
      if (p.seat >= 0) this.reactTo(i, 'sitPanic', 1.8 + (i % 4) * 0.25, 'sitBrace', 12);
      else if (p.mode === 'stand' || p.mode === 'walk') this.reactTo(i, 'flinch', 0.7);
      if (!first && p.seat >= 0) first = this.worldOf(p, new THREE.Vector3());
    });
    if (first && this.t - this.screamT > 0.8) {
      this.screamT = this.t;
      this.ctx.events.emit('npcStartled', { position: first, count: k > 0.9 ? 3 : 2, scream: true, level: CONFIG.walk.cabin.screamLevel * (0.8 + 0.4 * k) });
    }
  }

  // ───────────────────────────── physics ─────────────────────────────
  private bodyFor(i: number): RAPIER.RigidBody | null {
    const s = this.secs[i];
    const vis = this.visual;
    if (!s?.obj || !vis) return null;
    let body: RAPIER.RigidBody | null = null;
    if (s.obj.parent === vis.root) body = this.tracked?.body ?? null;
    if (!body) {
      const part = this.cabin!.sections[i].part;
      body = this.ctx.breakup.pieces.find((w) => w.parts.includes(part))?.body ?? null;
    }
    try {
      if (body && !this.ctx.physics.world.bodies.contains(body.handle)) body = null;
    } catch {
      body = null;
    }
    return body;
  }

  fixedUpdate(dt: number): void {
    if (!this.group || !this.people.length || dt <= 0) return;
    for (let i = 0; i < this.secs.length; i++) {
      const s = this.secs[i];
      const body = this.bodyFor(i);
      if (!body || !s.obj) {
        s.hist = 0;
        continue;
      }
      const lv = body.linvel(), av = body.angvel(), t = body.translation();
      s.obj.updateWorldMatrix(true, false);
      const w = _v.set(0, 0, 0).applyMatrix4(s.obj.matrixWorld); // the section part (its centre of mass)
      const rx = w.x - t.x, ry = w.y - t.y, rz = w.z - t.z;
      const vx = lv.x + av.y * rz - av.z * ry, vy = lv.y + av.z * rx - av.x * rz, vz = lv.z + av.x * ry - av.y * rx;
      if (s.hist > 0 && s.body === body) {
        _v2.set((vx - s.vPrev.x) / dt, (vy - s.vPrev.y) / dt, (vz - s.vPrev.z) / dt);
        if (_v2.length() > CONFIG.walk.maxFrameAccel) _v2.setLength(CONFIG.walk.maxFrameAccel);
        s.acc.lerp(_v2, 1 - Math.exp(-dt / 0.05));
      } else s.acc.set(0, 0, 0);
      s.vPrev.set(vx, vy, vz);
      s.body = body;
      s.hist++;
    }
  }

  /** Apparent gravity per section (same cinematic rules as the player: you fall faster than a split / diving plane). */
  private frames(dt: number): void {
    const W = CONFIG.walk;
    const intact = !!this.tracked?.body;
    for (const s of this.secs) {
      if (!s.obj) continue;
      const k = intact ? 1 : W.splitCoupling;
      const a = s.acc;
      const gw = _v.set(-a.x * k, -G - a.y * k, -a.z * k);
      if (!intact || a.y < -0.7 * G) gw.y = Math.min(gw.y, -W.minFallG * G);
      s.obj.matrixWorld.decompose(_v2, s.q, _v2);
      gw.applyQuaternion(_q.copy(s.q).invert());
      s.gApp.lerp(gw, 1 - Math.exp(-dt / 0.06));
    }
  }

  private broken(a: string, b: string): boolean {
    const s = this.tracked?.brokenJoints;
    return !!s && (s.has(`${a}|${b}`) || s.has(`${b}|${a}`));
  }

  /** z limits of the run of connected sections around `sec` and whether its ends are torn open. */
  private chain(sec: number): { zMin: number; zMax: number; openFront: boolean; openRear: boolean; front: number; back: number } {
    const S = this.cabin!.sections;
    let f = sec, b = sec;
    while (f > 0 && !this.broken(S[f - 1].part, S[f].part)) f--;
    while (b < S.length - 1 && !this.broken(S[b].part, S[b + 1].part)) b++;
    return {
      front: f,
      back: b,
      zMax: f === 0 ? this.cabin!.frontZ : S[f].z1,
      zMin: b === S.length - 1 ? this.cabin!.rearZ : S[b].z0,
      openFront: f > 0 || this.broken('cockpit', S[0].part),
      openRear: b < S.length - 1 || this.broken(S[S.length - 1].part, 'tailCone'),
    };
  }

  /** People out of their seats (crew, loose passengers): the player's cabin physics. Returns false once they are out. */
  private stepLoose(p: Person, i: number, dt: number): void {
    const cab = this.cabin!;
    const W = CONFIG.walk;
    const sf = this.secs[p.sec];
    if (!sf?.obj || !sf.obj.parent) {
      // the section is gone: out into the world
      this.eject(p, this.worldOf(p, new THREE.Vector3()), _v2.set(0, 0, 0));
      return;
    }
    const g = sf.gApp;
    const support = -g.y;
    const lat = Math.hypot(g.x, g.z);
    const normal = support > W.minSupport && lat < W.friction * support * 0.9;
    const c = this.chain(p.sec);
    const floorY = cab.floorY;
    const onFloor = p.p.y <= floorY + 0.03 && p.v.y <= 0.05;
    if (p.mode === 'thrown') {
      p.v.addScaledVector(g, dt);
      if (onFloor && normal) {
        p.calm += dt;
        p.v.x = approach(p.v.x, 0, 6 * dt);
        p.v.z = approach(p.v.z, 0, 6 * dt);
        if (p.calm > 1.4) {
          p.mode = p.kind === 'crew' ? 'walk' : 'stand';
          p.calm = 0;
          this.group?.play(i, p.kind === 'crew' ? 'walk' : 'lookAround', 0.4);
        }
      } else p.calm = 0;
    } else {
      if (!normal || !onFloor) {
        p.mode = 'thrown';
        p.calm = 0;
        this.group?.play(i, 'tumble', 0.2);
        p.v.addScaledVector(g, dt);
      } else if (p.mode === 'walk') {
        // crew: up and down the aisle, a pause at each stop
        p.pause -= dt;
        const dz = p.target - p.p.z;
        if (p.pause > 0) {
          p.v.set(0, 0, 0);
          if (!p.react) this.group?.play(i, 'idle', 0.3);
        } else if (Math.abs(dz) < 0.15) {
          p.pause = 2 + ((i * 1.7 + this.t) % 3);
          const span = Math.max(1, c.zMax - c.zMin - 2.4);
          p.target = c.zMin + 1.2 + ((p.target - c.zMin + span * 0.37 + i) % span);
        } else {
          const sp = CONFIG.walk.cabin.crewSpeed;
          p.v.z = approach(p.v.z, Math.sign(dz) * sp, 3 * dt);
          p.v.x = approach(p.v.x, (this.aisleNear(p.p.x) - p.p.x) * 2, 3 * dt);
          p.yaw = dampAngle(p.yaw, dz > 0 ? 0 : Math.PI, 6, dt);
          if (!p.react) this.group?.play(i, 'walk', 0.25, Math.max(0.6, Math.abs(p.v.z) / 1.36));
        }
        p.v.y = 0;
      } else {
        p.v.set(0, 0, 0);
        if (!p.react) this.group?.play(i, 'lookAround', 0.4);
      }
    }
    // decompression: an open end at speed pulls them toward it
    const air = sf.vPrev.length();
    if (air > 25) {
      const pull = W.suction * clamp((air - 25) / 60, 0, 1);
      if (c.openFront && c.zMax - p.p.z < W.suctionRange) p.v.z += pull * (1 - Math.max(0, c.zMax - p.p.z) / W.suctionRange) * dt;
      if (c.openRear && p.p.z - c.zMin < W.suctionRange) p.v.z -= pull * (1 - Math.max(0, p.p.z - c.zMin) / W.suctionRange) * dt;
    }
    if (p.v.length() > W.maxSpeed) p.v.setLength(W.maxSpeed);
    const n = Math.min(10, Math.max(1, Math.ceil((p.v.length() * dt) / 0.1)));
    for (let k = 0; k < n; k++) {
      p.p.addScaledVector(p.v, dt / n);
      if (this.collide(p, c)) return;
    }
    p.sec = clamp(this.secAt(p.p.z), c.front, c.back);
  }

  private collide(p: Person, c: ReturnType<CabinPeople['chain']>): boolean {
    const cab = this.cabin!;
    const P = p.p, v = p.v;
    const floorY = cab.floorY;
    const beyond = (c.openFront && P.z > c.zMax) || (c.openRear && P.z < c.zMin);
    if (!beyond) {
      if (P.y < floorY) {
        P.y = floorY;
        v.y = v.y < -4 ? -v.y * 0.2 : Math.max(0, v.y);
      }
      const ceil = this.sample(cab.ceil, P.z);
      const top = p.mode === 'thrown' ? 0.9 : 1.7;
      if (P.y + top > ceil) {
        P.y = Math.max(floorY, ceil - top);
        if (v.y > 0) v.y *= -0.2;
      }
      const f = cab.halfWidthAt;
      const w = f ? Math.min(f(P.z, P.y + 0.1), f(P.z, P.y + top * 0.5), f(P.z, P.y + top - 0.05)) : this.sample(cab.halfW, P.z);
      const lim = Math.max(0.05, w - R);
      if (Math.abs(P.x) > lim) {
        P.x = Math.sign(P.x) * lim;
        v.x *= -0.25;
      }
      if (P.y < floorY + 1.1) this.pushOutOfSeats(P, P.y < floorY + 0.5);
    }
    if (!c.openFront && P.z > c.zMax - R - 0.05) {
      P.z = c.zMax - R - 0.05;
      if (v.z > 0) v.z *= -0.2;
    }
    if (!c.openRear && P.z < c.zMin + R + 0.05) {
      P.z = c.zMin + R + 0.05;
      if (v.z < 0) v.z *= -0.2;
    }
    if ((c.openFront && P.z > c.zMax + 0.5) || (c.openRear && P.z < c.zMin - 0.5)) {
      const sf = this.secs[p.sec];
      const wv = _v2.copy(v);
      if (sf?.obj) {
        sf.obj.matrixWorld.decompose(_v, _q, _v);
        wv.applyQuaternion(_q).add(sf.vPrev);
      }
      this.eject(p, this.worldOf(p, new THREE.Vector3()), wv);
      return true;
    }
    return false;
  }

  private pushOutOfSeats(P: THREE.Vector3, low: boolean): void {
    const hx = 0.23;
    for (const s of this.cabin!.seats) {
      if (Math.abs(s.z - P.z) > 0.9 || Math.abs(s.x - P.x) > 0.8) continue;
      const x0 = s.x - hx, x1 = s.x + hx, z0 = low ? s.z - 0.24 : s.z - 0.33, z1 = low ? s.z + 0.3 : s.z - 0.1;
      const cx = clamp(P.x, x0, x1), cz = clamp(P.z, z0, z1);
      const dx = P.x - cx, dz = P.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        P.x += (dx / d) * (R - d);
        P.z += (dz / d) * (R - d);
      } else P.x = P.x >= s.x ? x1 + R : x0 - R;
    }
  }

  private eject(p: Person, w: THREE.Vector3, vel: THREE.Vector3): void {
    p.mode = 'fall';
    p.wp.copy(w);
    p.wv.copy(vel);
    p.land = 0;
  }

  private ground(x: number, z: number): number {
    try {
      const g = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(g) ? g : 0;
    } catch {
      return 0;
    }
  }

  private stepWorld(p: Person, i: number, dt: number): void {
    const W = CONFIG.walk;
    if (p.mode === 'fall') {
      p.wv.y -= G * dt;
      p.wv.multiplyScalar(1 / (1 + W.airDrag * p.wv.length() * dt));
      p.wp.addScaledVector(p.wv, dt);
      this.group?.play(i, 'tumble', 0.2);
      const gy = this.ground(p.wp.x, p.wp.z);
      if (p.wp.y <= gy) {
        p.wp.y = gy;
        p.wv.set(0, 0, 0);
        p.mode = 'ground';
        p.land = 0;
        this.group?.play(i, 'fallBack', 0.05, 1, true);
      }
    } else {
      p.land += dt;
      if (p.land > 1.1 && p.land - dt <= 1.1) this.group?.play(i, 'lieBack', 0.2);
    }
  }

  /** World position of a person (feet). */
  private worldOf(p: Person, out: THREE.Vector3): THREE.Vector3 {
    if (p.mode === 'fall' || p.mode === 'ground') return out.copy(p.wp);
    const s = this.secs[p.sec];
    if (!s?.obj) return out.set(0, 0, 0);
    return out.copy(p.p).sub(s.com).applyMatrix4(s.obj.matrixWorld);
  }

  // ───────────────────────────── per frame ─────────────────────────────
  update(dt: number): void {
    const { ctx } = this;
    const planes = ctx.planes;
    const visual = ctx.game.mode === 'plane' && planes.active ? planes.visual : null;
    if (visual !== this.visual) this.rebuild(visual);
    this.tracked = planes.currentTracked ?? this.tracked;
    const group = this.group;
    if (!group || !this.cabin || !visual) return;
    this.t += dt;
    this.frames(dt);
    // only while their cabin can be seen: walking inside, or a torn-open airframe up close
    const cam = ctx.engine.camera.position;
    visual.root.getWorldPosition(_v);
    const torn = (this.tracked?.brokenJoints.size ?? 0) > 0 || planes.crashed;
    const show = !this.hidden && ((ctx.walker.active && ctx.walker.mode === 'cabin') || (torn && cam.distanceTo(_v) < CONFIG.walk.cabin.showDist));
    group.object.visible = show;
    this.hidden = false;
    // sustained terror: a spin / a dive keeps the belted ones braced, with the odd scream
    const s0 = this.secs[1] ?? this.secs[0];
    const g = s0?.gApp;
    const wild = !!g && (-g.y < CONFIG.walk.minSupport + 2 || Math.hypot(g.x, g.z) > 7);
    if (wild && !planes.crashed && this.t - this.screamT > 3.5) {
      this.screamT = this.t;
      const first = this.people.find((p) => p.seat >= 0);
      if (first) {
        this.onBlastQuiet();
        this.ctx.events.emit('npcStartled', { position: this.worldOf(first, new THREE.Vector3()), count: 2, scream: true, level: CONFIG.walk.cabin.screamLevel * 0.8 });
      }
    }
    for (let i = 0; i < this.people.length; i++) {
      const p = this.people[i];
      // reaction timeline
      if (p.react && !p.started && this.t >= p.start) {
        p.started = true;
        group.play(i, p.react, 0.15, 1, true);
      } else if (p.react && p.started && this.t > p.until) {
        if (p.next && this.t < p.nextUntil) {
          p.react = p.next;
          p.until = p.nextUntil;
          p.next = null;
          group.play(i, p.react, 0.4);
        } else {
          p.react = null;
          if (p.seat >= 0 && p.mode === 'seat') group.play(i, 'sit', 0.5);
        }
      }
      if (p.mode === 'seat') {
        const sf = this.secs[p.sec];
        if (!sf?.obj || !sf.obj.parent) {
          group.hide(i);
          continue;
        }
        // an unbelted passenger leaves the seat when the cabin goes wild
        if (p.kind === 'loose' && wild) {
          p.mode = 'thrown';
          p.seat = -1;
          p.p.y += 0.4;
          group.play(i, 'tumble', 0.2);
        }
      } else if (p.mode === 'fall' || p.mode === 'ground') this.stepWorld(p, i, dt);
      else this.stepLoose(p, i, dt);
      if (!show) continue;
      // matrix
      if (p.mode === 'fall' || p.mode === 'ground') {
        _m.makeRotationY(p.yaw).setPosition(p.wp);
        group.setMatrix(i, _m);
      } else {
        const sf = this.secs[p.sec];
        if (!sf?.obj || !sf.obj.parent) {
          group.hide(i);
          continue;
        }
        _m.makeRotationY(p.yaw).setPosition(_v.copy(p.p).sub(sf.com));
        _m2.multiplyMatrices(sf.obj.matrixWorld, _m);
        group.setMatrix(i, _m2);
      }
    }
    if (show) {
      const night = GLOBAL_UNIFORMS.uNight.value;
      group.setFill(0.1 + 0.6 * smoothstep(0.12, 0.6, night));
      group.update(dt);
    }
    void UP;
  }

  /** Spin / dive: the belted ones brace (no new screams beyond the caller's). */
  private onBlastQuiet(): void {
    this.people.forEach((p, i) => {
      if (p.seat >= 0 && p.react !== 'sitBrace' && p.react !== 'sitPanic') this.reactTo(i, 'sitBrace', 4);
    });
  }

  dispose(): void {
    this.group?.dispose();
    this.group = null;
  }
}
