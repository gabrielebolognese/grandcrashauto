import * as THREE from 'three';
import { CONFIG } from '../../config';
import { G, RAPIER, groups } from '../../core/Physics';
import type { GameContext } from '../../game/contracts';
import { F, type ItemStore } from './store';
import { kinds, type KindDef } from './registry';

const FILTER = G.WORLD | G.PLAYER | G.DEBRIS | G.PLANE | G.PROP | G.PARKED;

interface Rec {
  body: RAPIER.RigidBody;
  cols: RAPIER.Collider[];
  kind: number;
  item: number; // -1 = pooled
  dynamic: boolean;
  asleep: boolean;
  prev: Float32Array; // x y z qx qy qz qw
  curr: Float32Array;
  lv: Float32Array; // last linear velocity
  cool: number;
  awakeT: number;
  ai: number; // index in `active`
  carBodyKey: string;
}

export interface PhysHooks {
  /** An item started moving / changed render state (render must re-cull soon). */
  dirty(): void;
  onToppled(i: number, def: KindDef, speed: number): void;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _ev = new THREE.Vector3();

/**
 * Prop & parked-car physics (owner: props). Bodies exist only for items within CONFIG.props.activeRadius of the focus
 * and are pooled per kind (disabled, reused). Light props and parked cars are DYNAMIC bodies created asleep — any
 * contact (player car, debris, planes, other props) wakes them and Rapier resolves the hit; we add a satisfying kick,
 * events and render interpolation. Heavy props are FIXED bodies that snap to dynamic (topple) when the player car is
 * about to hit them faster than the kind's topple speed, or when a blast is close.
 */
export class PropPhysics {
  private recs: Rec[] = [];
  private free = new Map<string, number[]>();
  private active: number[] = [];
  private nLight = 0;
  private nHeavy = 0;
  private nCar = 0;
  private step = 0;
  parked = false;
  private hitsThisStep = 0;

  constructor(private ctx: GameContext, private store: ItemStore, private hooks: PhysHooks) {}

  get activeCount(): number {
    return this.active.length;
  }

  get bodyCount(): number {
    return this.recs.length;
  }

  /** Item has a dynamic body that is currently moving. */
  isAwake(i: number): boolean {
    const ri = this.store.rec[i];
    if (ri < 0) return false;
    const rec = this.recs[ri];
    return rec.dynamic && !rec.asleep;
  }

  // ───────────────────────────── pooling ─────────────────────────────
  private poolKey(def: KindDef): string {
    if (!def.car) return def.name;
    const c = def.colliders[0];
    return `${def.name}:${c.hx.toFixed(2)}:${c.hy.toFixed(2)}:${c.hz.toFixed(2)}`;
  }

  private create(def: KindDef): Rec {
    const { physics } = this.ctx;
    const P = CONFIG.props;
    const heavy = def.phys === 'heavy';
    const desc = heavy
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.dynamic()
          .setLinearDamping(def.car ? P.carLinearDamping : P.lightLinearDamping)
          .setAngularDamping(def.car ? P.carAngularDamping : P.lightAngularDamping)
          .setCcdEnabled(def.mass < 60);
    desc.setCanSleep(true);
    const body = physics.world.createRigidBody(desc);
    const cols: RAPIER.Collider[] = [];
    const member = def.car ? G.PARKED : G.PROP;
    const n = def.colliders.length;
    for (const c of def.colliders) {
      let cd: RAPIER.ColliderDesc;
      if (c.shape === 'box') cd = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz);
      else if (c.shape === 'cone') cd = RAPIER.ColliderDesc.cone(c.hy, c.hx);
      else cd = RAPIER.ColliderDesc.cylinder(c.hy, c.hx);
      cd.setTranslation(c.cx, c.cy, c.cz);
      if (c.rz) {
        _q.setFromAxisAngle(_v.set(0, 0, 1), c.rz);
        cd.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      }
      if (def.car) {
        // lowered centre of mass so shoved cars slide and spin rather than flip (blasts still roll them)
        const m = def.mass;
        const w = c.hx * 2, h = c.hy * 2, l = c.hz * 2;
        cd.setMassProperties(m, { x: 0, y: -c.hy * 0.35, z: 0 }, { x: (m * (h * h + l * l)) / 12, y: (m * (w * w + l * l)) / 12, z: (m * (w * w + h * h)) / 12 }, { x: 0, y: 0, z: 0, w: 1 });
        cd.setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min);
      } else {
        cd.setMass(def.mass / n);
      }
      cd.setFriction(def.friction).setRestitution(def.car ? 0.05 : 0.18).setCollisionGroups(groups(member, FILTER));
      cols.push(physics.world.createCollider(cd, body));
    }
    body.setEnabled(false);
    const rec: Rec = {
      body, cols, kind: def.id, item: -1, dynamic: !heavy, asleep: true,
      prev: new Float32Array(7), curr: new Float32Array(7), lv: new Float32Array(3), cool: 0, awakeT: 0, ai: -1,
      carBodyKey: this.poolKey(def),
    };
    this.recs.push(rec);
    return rec;
  }

  private cap(def: KindDef): boolean {
    const P = CONFIG.props;
    if (def.car) return this.nCar < P.maxCarBodies;
    if (def.phys === 'heavy') return this.nHeavy < P.maxHeavyBodies;
    return this.nLight < P.maxLightBodies;
  }

  private count(def: KindDef, d: number): void {
    if (def.car) this.nCar += d;
    else if (def.phys === 'heavy') this.nHeavy += d;
    else this.nLight += d;
  }

  /** Give item i a body (asleep / fixed) at its current pose. */
  activate(i: number, force = false): Rec | null {
    const s = this.store;
    if (s.rec[i] >= 0) return this.recs[s.rec[i]];
    const k = s.kind[i];
    if (k < 0) return null;
    const def = kinds()[k];
    if (def.phys === 'none') return null;
    if (!force && !this.cap(def)) return null;
    const key = this.poolKey(def);
    const list = this.free.get(key);
    const ri = list && list.length ? list.pop()! : -1;
    const rec = ri >= 0 ? this.recs[ri] : this.create(def);
    const idx = ri >= 0 ? ri : this.recs.length - 1;
    const { physics } = this.ctx;
    const toppled = (s.flags[i] & F.TOPPLED) !== 0;
    const wantDynamic = def.phys !== 'heavy' || toppled;
    const b = rec.body;
    if (def.phys === 'heavy') {
      b.setBodyType(wantDynamic ? RAPIER.RigidBodyType.Dynamic : RAPIER.RigidBodyType.Fixed, false);
      if (wantDynamic) {
        b.setLinearDamping(CONFIG.props.lightLinearDamping);
        b.setAngularDamping(0.6);
      }
    }
    rec.dynamic = wantDynamic;
    b.setTranslation({ x: s.pos[i * 3], y: s.pos[i * 3 + 1], z: s.pos[i * 3 + 2] }, false);
    b.setRotation({ x: s.quat[i * 4], y: s.quat[i * 4 + 1], z: s.quat[i * 4 + 2], w: s.quat[i * 4 + 3] }, false);
    b.setEnabled(true);
    if (wantDynamic) {
      b.setLinvel({ x: 0, y: 0, z: 0 }, false);
      b.setAngvel({ x: 0, y: 0, z: 0 }, false);
      b.sleep();
    }
    const tagKind = def.car ? 'parkedCar' : def.phys === 'heavy' ? 'staticProp' : 'prop';
    for (const c of rec.cols) physics.tag(c, { kind: tagKind, material: def.surface, id: i, data: { prop: def.event } });
    rec.item = i;
    rec.asleep = true;
    rec.cool = 0;
    rec.awakeT = 0;
    this.capture(rec, true);
    rec.lv.fill(0);
    rec.ai = this.active.length;
    this.active.push(idx);
    s.rec[i] = idx;
    s.flags[i] |= F.ACTIVE;
    this.count(def, 1);
    return rec;
  }

  /** Return item i's body to the pool; writeBack stores the final pose into the item. */
  release(i: number, writeBack = true): void {
    const s = this.store;
    const ri = s.rec[i];
    if (ri < 0) return;
    const rec = this.recs[ri];
    const def = kinds()[rec.kind];
    if (writeBack && rec.dynamic) {
      this.readBody(rec);
      this.settleItem(i);
    }
    rec.body.setEnabled(false);
    if (def.phys === 'heavy' && rec.dynamic) {
      rec.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
      rec.dynamic = false;
    }
    rec.item = -1;
    // swap-remove from active
    const last = this.active[this.active.length - 1];
    this.active[rec.ai] = last;
    this.recs[last].ai = rec.ai;
    this.active.pop();
    rec.ai = -1;
    let list = this.free.get(rec.carBodyKey);
    if (!list) this.free.set(rec.carBodyKey, (list = []));
    list.push(ri);
    s.rec[i] = -1;
    s.flags[i] &= ~F.ACTIVE;
    this.count(def, -1);
  }

  releaseAll(writeBack = true): void {
    while (this.active.length) this.release(this.recs[this.active[this.active.length - 1]].item, writeBack);
  }

  /** Remove pooled bodies of a kind (e.g. collider dims changed with a new car geometry). */
  dropPool(def: KindDef): void {
    for (const [key, list] of this.free) {
      if (!key.startsWith(def.name)) continue;
      for (const ri of list) {
        const rec = this.recs[ri];
        this.ctx.physics.removeBody(rec.body);
        rec.kind = -1;
      }
      list.length = 0;
    }
  }

  private readBody(rec: Rec): void {
    const s = this.store;
    const i = rec.item;
    const t = rec.body.translation();
    const r = rec.body.rotation();
    s.pos[i * 3] = t.x;
    s.pos[i * 3 + 1] = t.y;
    s.pos[i * 3 + 2] = t.z;
    s.quat[i * 4] = r.x;
    s.quat[i * 4 + 1] = r.y;
    s.quat[i * 4 + 2] = r.z;
    s.quat[i * 4 + 3] = r.w;
  }

  /** Classify an item's displacement after it came to rest. */
  private settleItem(i: number): void {
    const s = this.store;
    const [d, a] = s.displacement(i);
    if (d < 0.03 && a < 0.04 && !(s.flags[i] & F.TOPPLED)) {
      s.restore(i);
      s.unmarkMoved(i);
      s.flags[i] &= ~F.DISTURBED;
      this.hooks.dirty();
      return;
    }
    s.markMoved(i);
    if (d > 0.15 || a > 0.17 || s.flags[i] & F.TOPPLED) s.flags[i] |= F.DISTURBED;
  }

  private capture(rec: Rec, prime: boolean): void {
    const t = rec.body.translation();
    const r = rec.body.rotation();
    if (!prime) rec.prev.set(rec.curr);
    rec.curr[0] = t.x;
    rec.curr[1] = t.y;
    rec.curr[2] = t.z;
    rec.curr[3] = r.x;
    rec.curr[4] = r.y;
    rec.curr[5] = r.z;
    rec.curr[6] = r.w;
    if (prime) rec.prev.set(rec.curr);
  }

  // ───────────────────────────── per tick ─────────────────────────────
  fixedUpdate(dt: number, focus: THREE.Vector3): void {
    const P = CONFIG.props;
    this.step++;
    this.hitsThisStep = 0;
    // part 2: flying high → park every body
    const { game, planes } = this.ctx;
    const agl = game.mode === 'plane' ? planes?.state?.altitudeAgl ?? 0 : 0;
    const park = game.mode === 'plane' && agl > (this.parked ? P.planeParkAltitude - 10 : P.planeParkAltitude);
    if (park !== this.parked) {
      this.parked = park;
      if (park) this.releaseAll(true);
    }
    if (this.parked) return;
    if (this.step % 6 === 0) this.stream(focus);
    this.predictTopple(dt);
    for (const ri of this.active) {
      const rec = this.recs[ri];
      if (rec.cool > 0) rec.cool -= dt;
    }
  }

  private stream(focus: THREE.Vector3): void {
    const P = CONFIG.props;
    const s = this.store;
    const R = P.activeRadius;
    const R2 = R * R;
    const fx = focus.x, fz = focus.z;
    const K = kinds();
    // progressive: at most a few dozen activations per pass (10 Hz), nearest ring first
    let budget = 36;
    for (const ring of [R * 0.5, R]) {
      const ring2 = ring * ring;
      s.forEachNear(fx, fz, ring, (i) => {
        if (budget <= 0 || s.flags[i] & (F.HIDDEN | F.ACTIVE | F.MOVED)) return;
        const k = s.kind[i];
        if (k < 0 || K[k].phys === 'none') return;
        const dx = s.pos[i * 3] - fx, dz = s.pos[i * 3 + 2] - fz;
        if (dx * dx + dz * dz < ring2 && this.activate(i)) budget--;
      });
    }
    for (let m = 0; m < s.movedList.length && budget > 0; m++) {
      const i = s.movedList[m];
      if (s.flags[i] & (F.HIDDEN | F.ACTIVE)) continue;
      const dx = s.pos[i * 3] - fx, dz = s.pos[i * 3 + 2] - fz;
      if (dx * dx + dz * dz < R2 && this.activate(i)) budget--;
    }
    const RR2 = P.releaseRadius * P.releaseRadius;
    const far2 = (R * 2.5) * (R * 2.5);
    for (let a = this.active.length - 1; a >= 0; a--) {
      const rec = this.recs[this.active[a]];
      const i = rec.item;
      const px = rec.dynamic ? rec.curr[0] : s.pos[i * 3];
      const pz = rec.dynamic ? rec.curr[2] : s.pos[i * 3 + 2];
      const d2 = (px - fx) * (px - fx) + (pz - fz) * (pz - fz);
      if (d2 < RR2) continue;
      if (rec.dynamic && !rec.asleep && d2 < far2 && rec.awakeT < 20) continue;
      this.release(i, true);
    }
  }

  /** Heavy props snap when the player car is about to hit them fast enough. */
  private predictTopple(dt: number): void {
    const v = this.ctx.vehicle;
    const ch = v.chassis;
    if (!ch || !v.active || v.state.exploded) return;
    const lv = ch.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    if (speed < 6) return;
    const t = ch.translation();
    const r = ch.rotation();
    _qa.set(r.x, r.y, r.z, r.w).invert();
    const he = v.visual?.dims.halfExtents;
    const off = v.visual?.dims.colliderOffset;
    const hx = he ? he.x : 0.95, hz = he ? he.z : 2.2;
    const ox = off ? off.x : 0, oz = off ? off.z : 0;
    const s = this.store;
    const K = kinds();
    const look = speed * dt * 2.5;
    const lvL = _v2.set(lv.x, 0, lv.z).applyQuaternion(_qa);
    const lvx = lvL.x, lvz = lvL.z;
    for (let a = 0; a < this.active.length; a++) {
      const rec = this.recs[this.active[a]];
      if (rec.dynamic) continue;
      const def = K[rec.kind];
      if (!def.topple) continue;
      const i = rec.item;
      const px = s.pos[i * 3], pz = s.pos[i * 3 + 2];
      const dx = px - t.x, dz = pz - t.z;
      const reach = hz + def.radius + look + 1;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (s.pos[i * 3 + 1] + def.height < t.y - 1 || s.pos[i * 3 + 1] > t.y + 2) continue;
      // prop point in the car frame, swept along the car's velocity
      const p = _v.set(dx, 0, dz).applyQuaternion(_qa);
      const rad = def.radius * s.scale[i] + 0.12;
      let hit = false;
      for (let k = 0; k <= 2 && !hit; k++) {
        const f = (k / 2) * dt * 2.5;
        const qx = p.x - lvx * f - ox, qz = p.z - lvz * f - oz;
        const cx = Math.max(-hx, Math.min(hx, qx)), cz = Math.max(-hz, Math.min(hz, qz));
        if ((qx - cx) * (qx - cx) + (qz - cz) * (qz - cz) < rad * rad) hit = true;
      }
      if (!hit) continue;
      const dl = Math.hypot(dx, dz) || 1;
      const closing = (lv.x * dx + lv.z * dz) / dl;
      if (closing < def.topple * (0.85 + 0.3 * s.hash[i])) continue;
      this.topple(rec, _ev.set(lv.x, 0, lv.z).normalize(), closing);
    }
  }

  /** Snap a heavy prop: it becomes dynamic, base kicked with the hit, top lagging (falls over). */
  topple(rec: Rec, dir: THREE.Vector3, speed: number): void {
    const s = this.store;
    const i = rec.item;
    const def = kinds()[rec.kind];
    const b = rec.body;
    b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.setLinearDamping(CONFIG.props.lightLinearDamping);
    b.setAngularDamping(0.6);
    rec.dynamic = true;
    rec.asleep = false;
    rec.awakeT = 0;
    const h = Math.max(0.5, def.height * s.scale[i]);
    const vBase = speed * 0.85, vTop = speed * 0.35;
    const vc = (vBase + vTop) / 2;
    b.setLinvel({ x: dir.x * vc, y: 1.2, z: dir.z * vc }, true);
    // ω about (up × dir): top moves slower than the base → it tips back over the hitter
    const w = (vTop - vBase) / h;
    _v.set(0, 1, 0).cross(dir).normalize().multiplyScalar(w);
    b.setAngvel({ x: _v.x + (Math.random() - 0.5) * 0.6, y: (Math.random() - 0.5) * 1.5, z: _v.z + (Math.random() - 0.5) * 0.6 }, true);
    this.capture(rec, true);
    rec.lv.set([dir.x * vc, 1.2, dir.z * vc]);
    s.flags[i] |= F.TOPPLED | F.DISTURBED;
    s.markMoved(i);
    s.inst[i * 4 + 2] = 0; // lamp broken
    this.hooks.dirty();
    this.hooks.onToppled(i, def, speed);
  }

  /** After physics.step(): wake/settle detection, hit events, interpolation capture. */
  postStep(dt: number): void {
    if (this.parked) return;
    const s = this.store;
    const K = kinds();
    const P = CONFIG.props;
    const veh = this.ctx.vehicle;
    const vp = veh.active ? veh.state.position : null;
    for (let a = 0; a < this.active.length; a++) {
      const rec = this.recs[this.active[a]];
      if (!rec.dynamic) continue;
      const b = rec.body;
      const i = rec.item;
      if (b.isSleeping()) {
        if (!rec.asleep) {
          rec.asleep = true;
          this.capture(rec, false);
          this.readBody(rec);
          this.settleItem(i);
        }
        continue;
      }
      const def = K[rec.kind];
      this.capture(rec, rec.asleep);
      rec.awakeT += dt;
      const v = b.linvel();
      const dvx = v.x - rec.lv[0], dvy = v.y - rec.lv[1], dvz = v.z - rec.lv[2];
      const dv = Math.hypot(dvx, dvy, dvz);
      const speed = Math.hypot(v.x, v.y, v.z);
      if (rec.asleep) {
        rec.asleep = false;
        rec.awakeT = 0;
        if (speed > P.hitWakeSpeed) this.onWake(rec, def, speed, vp);
      } else if (def.car && dv > P.carHitDv && rec.cool <= 0) {
        this.carHit(rec, dv, vp);
      } else if (!def.car && dv > 4 && rec.cool <= 0 && this.hitsThisStep < 3) {
        rec.cool = 0.3;
        this.hitsThisStep++;
        this.ctx.events.emit('propHit', { position: _ev.fromArray(rec.curr, 0), kind: def.event, speed: dv });
      }
      rec.lv[0] = v.x;
      rec.lv[1] = v.y;
      rec.lv[2] = v.z;
      if (!(s.flags[i] & F.MOVED)) {
        s.markMoved(i);
        this.hooks.dirty();
      }
    }
  }

  private onWake(rec: Rec, def: KindDef, speed: number, vp: THREE.Vector3 | null): void {
    const s = this.store;
    const i = rec.item;
    const P = CONFIG.props;
    s.flags[i] |= F.DISTURBED;
    s.markMoved(i);
    this.hooks.dirty();
    if (def.car) {
      this.carHit(rec, speed, vp);
      return;
    }
    const nearPlayer = !!vp && vp.distanceToSquared(_ev.fromArray(rec.curr, 0)) < (def.radius + 6) * (def.radius + 6);
    let evSpeed = speed;
    if (nearPlayer) {
      const pv = this.ctx.vehicle.state.velocity;
      evSpeed = Math.max(speed, pv.length());
      // satisfying launch: up-kick + tumble, scaled down for heavy props
      const mScale = Math.min(1, Math.sqrt(20 / Math.max(1, def.mass)));
      const up = Math.min(P.kickUpMax, speed * P.kickUp) * (0.4 + 0.6 * mScale);
      const m = rec.body.mass();
      rec.body.applyImpulse({ x: 0, y: up * m, z: 0 }, true);
      const sp = speed * P.kickSpin * mScale;
      const av = rec.body.angvel();
      rec.body.setAngvel({ x: av.x + (Math.random() - 0.5) * sp, y: av.y + (Math.random() - 0.5) * sp, z: av.z + (Math.random() - 0.5) * sp }, true);
    }
    if (this.hitsThisStep < 4) {
      this.hitsThisStep++;
      rec.cool = 0.3;
      _ev.fromArray(rec.curr, 0);
      this.ctx.events.emit('propHit', { position: _ev, kind: def.event, speed: evSpeed });
      if (evSpeed > 7) this.ctx.fx.dust(_ev, Math.min(0.8, evSpeed / 30));
    }
  }

  private carHit(rec: Rec, dv: number, vp: THREE.Vector3 | null): void {
    const s = this.store;
    const i = rec.item;
    rec.cool = 0.25;
    s.flags[i] |= F.DISTURBED;
    const pos = _ev.fromArray(rec.curr, 0);
    let speed = dv;
    if (vp && vp.distanceToSquared(pos) < 49) speed = Math.max(dv, this.ctx.vehicle.state.velocity.length());
    this.ctx.events.emit('parkedCarHit', { position: pos, speed });
    if (dv > CONFIG.props.carGlassDv) this.shatter(i, true);
  }

  /** Shatter a parked car's windows (once). */
  shatter(i: number, fx: boolean): boolean {
    const s = this.store;
    if (s.flags[i] & F.GLASS) return false;
    s.flags[i] |= F.GLASS | F.DISTURBED;
    s.inst[i * 4] = 1;
    s.markMoved(i);
    this.hooks.dirty();
    if (fx) {
      const p = _v2.set(s.pos[i * 3], s.pos[i * 3 + 1] + 1.1, s.pos[i * 3 + 2]);
      this.ctx.fx.glassShards(p, 26);
      this.ctx.events.emit('glassBreak', { position: p, shattered: true });
    }
    return true;
  }

  /** Render interpolation for awake bodies → item poses. Returns the number of items written via `write`. */
  interpolate(alpha: number, write: (i: number) => void): void {
    const s = this.store;
    for (let a = 0; a < this.active.length; a++) {
      const rec = this.recs[this.active[a]];
      if (!rec.dynamic) continue;
      const i = rec.item;
      const p = rec.prev, c = rec.curr;
      if (rec.asleep) {
        if (p[0] === c[0] && p[1] === c[1] && p[2] === c[2] && p[6] === c[6]) continue;
        p.set(c);
        if (!(s.flags[i] & F.MOVED)) continue;
        s.pos[i * 3] = c[0];
        s.pos[i * 3 + 1] = c[1];
        s.pos[i * 3 + 2] = c[2];
        for (let k = 0; k < 4; k++) s.quat[i * 4 + k] = c[3 + k];
        write(i);
        continue;
      }
      s.pos[i * 3] = p[0] + (c[0] - p[0]) * alpha;
      s.pos[i * 3 + 1] = p[1] + (c[1] - p[1]) * alpha;
      s.pos[i * 3 + 2] = p[2] + (c[2] - p[2]) * alpha;
      _qa.set(p[3], p[4], p[5], p[6]);
      _qb.set(c[3], c[4], c[5], c[6]);
      _qa.slerp(_qb, alpha).toArray(s.quat, i * 4);
      write(i);
    }
  }

  // ───────────────────────────── blasts ─────────────────────────────
  explode(center: THREE.Vector3, radius: number, force: number, focus: THREE.Vector3): void {
    const P = CONFIG.props;
    const s = this.store;
    const K = kinds();
    const R = radius * P.blastRadiusMul;
    const found: number[] = [];
    const dist: number[] = [];
    const consider = (i: number) => {
      if (s.flags[i] & F.HIDDEN || s.kind[i] < 0) return;
      const dx = s.pos[i * 3] - center.x, dy = s.pos[i * 3 + 1] - center.y, dz = s.pos[i * 3 + 2] - center.z;
      const d = Math.hypot(dx, dy * 0.5, dz);
      if (d < R) {
        found.push(i);
        dist.push(d);
      }
    };
    s.forEachNear(center.x, center.z, R, (i) => {
      if (!(s.flags[i] & F.MOVED)) consider(i);
    });
    for (const i of s.movedList) consider(i);
    const order = found.map((_, k) => k).sort((a, b) => dist[a] - dist[b]);
    let events = 0, shards = 0;
    for (let n = 0; n < order.length && n < 180; n++) {
      const i = found[order[n]];
      const d = dist[order[n]];
      const def = K[s.kind[i]];
      const f = Math.max(0, 1 - d / R);
      if (def.car && d < radius) {
        const fx = shards < 4;
        if (this.shatter(i, fx)) shards += fx ? 1 : 0;
        if (f > 0.55) s.inst[i * 4 + 1] = Math.max(s.inst[i * 4 + 1], Math.min(1, (f - 0.45) * 1.6));
      }
      if (def.phys === 'none' || this.parked) continue;
      // bodies only where the physics bubble lives (else they would freeze mid-air when released)
      const fdx = s.pos[i * 3] - focus.x, fdz = s.pos[i * 3 + 2] - focus.z;
      if (fdx * fdx + fdz * fdz > (P.releaseRadius * 1.8) ** 2) continue;
      const rec = this.activate(i, n < 120);
      if (!rec) continue;
      _v.set(s.pos[i * 3] - center.x, 0, s.pos[i * 3 + 2] - center.z);
      const hd = _v.length() || 1;
      _v.multiplyScalar(1 / hd);
      _v.y = 0.55 + 0.3 * f;
      _v.normalize();
      if (def.phys === 'heavy' && !rec.dynamic) {
        if (def.topple && f > P.blastTopple * (0.8 + 0.4 * s.hash[i])) this.topple(rec, _v2.set(_v.x, 0, _v.z).normalize(), 8 + 14 * f * force);
        continue;
      }
      const dv = (def.car ? P.blastCarDv : P.blastLightDv * (def.mass > 60 ? 0.5 : 1)) * f * f * force;
      const b = rec.body;
      const m = b.mass();
      b.wakeUp();
      b.applyImpulse({ x: _v.x * dv * m, y: _v.y * dv * m, z: _v.z * dv * m }, true);
      const spin = (def.car ? 0.8 : 4) * f * force;
      b.setAngvel({ x: (Math.random() - 0.5) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin }, true);
      s.flags[i] |= F.DISTURBED;
      s.markMoved(i);
      if (events < 5 && f > 0.25) {
        events++;
        _ev.set(s.pos[i * 3], s.pos[i * 3 + 1] + 0.5, s.pos[i * 3 + 2]);
        if (def.car) this.ctx.events.emit('parkedCarHit', { position: _ev, speed: dv * 2 });
        else this.ctx.events.emit('propHit', { position: _ev, kind: def.event, speed: dv });
      }
    }
    // pre-mark blasted cars as awake so their first motion doesn't re-trigger onWake hit logic
    for (const ri of this.active) {
      const rec = this.recs[ri];
      if (rec.dynamic && rec.asleep && !rec.body.isSleeping()) {
        rec.asleep = false;
        rec.awakeT = 0;
        const v = rec.body.linvel();
        rec.lv[0] = v.x;
        rec.lv[1] = v.y;
        rec.lv[2] = v.z;
      }
    }
    this.hooks.dirty();
  }

  /** Floating origin: shift interpolation samples (bodies are moved by core). */
  shift(dx: number, dz: number): void {
    for (const rec of this.recs) {
      rec.prev[0] -= dx;
      rec.prev[2] -= dz;
      rec.curr[0] -= dx;
      rec.curr[2] -= dz;
    }
  }

  dispose(): void {
    for (const rec of this.recs) this.ctx.physics.removeBody(rec.body);
    this.recs.length = 0;
    this.active.length = 0;
    this.free.clear();
  }
}

