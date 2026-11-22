import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups } from '../core/Physics';
import type { GameContext } from '../game/contracts';
import { K_TUNNEL, laneStart, lanesAt, type EdgeRoute } from './net/route';

/**
 * Optional light highway traffic (SPEC-PART3 §9; settings.traffic, off by default).
 * A small pool of low-poly cars (2 instanced meshes: bodies + lamps) following lanes on the routed edges near the
 * focus at constant-ish speed with gentle lane changes. Each car is a kinematic body; when the player hits one it
 * becomes a dynamic body and reacts physically (big hits explode it with the part-1 effect), then despawns later.
 */

interface TCar {
  active: boolean;
  route: EdgeRoute | null;
  side: number;
  lane: number;
  laneTarget: number;
  lat: number;
  s: number;
  speed: number;
  body: RAPIER.RigidBody | null;
  collider: RAPIER.Collider | null;
  wrecked: boolean;
  wreckT: number;
  exploded: boolean;
  color: THREE.Color;
  prev: THREE.Matrix4;
  curr: THREE.Matrix4;
}

const CAR_COLORS = [0xff7a6b, 0xffb38a, 0x9ee0c8, 0x5cc8d6, 0xb8a6e8, 0xffe39a, 0xfff4e0, 0x8fd0ec, 0x4a4d57, 0xf3dcb2];

function carGeometry(): { body: THREE.BufferGeometry; lamps: THREE.BufferGeometry } {
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, shade: number) => {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x, y, z);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3).fill(shade);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g);
  };
  box(1.86, 0.62, 4.3, 0, 0.62, 0, 1); // lower body (tinted by instance colour)
  box(1.6, 0.52, 2.2, 0, 1.18, -0.2, 0.85); // cabin
  box(1.62, 0.36, 2.0, 0, 1.2, -0.2, 0.25); // windows band (dark)
  for (const [x, z] of [[0.8, 1.35], [-0.8, 1.35], [0.8, -1.35], [-0.8, -1.35]]) box(0.26, 0.6, 0.6, x, 0.32, z, 0.12);
  const body = mergeNonIndexed(parts);
  const lp: THREE.BufferGeometry[] = [];
  const lbox = (x: number, z: number, r: number, gc: number, b: number) => {
    const g = new THREE.BoxGeometry(0.42, 0.16, 0.06).toNonIndexed();
    g.translate(x, 0.78, z);
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) c.set([r, gc, b], k * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    lp.push(g);
  };
  for (const x of [0.62, -0.62]) {
    lbox(x, 2.16, 1.6, 1.5, 1.3); // headlights
    lbox(x, -2.16, 1.4, 0.08, 0.05); // taillights
  }
  return { body, lamps: mergeNonIndexed(lp) };
}

function mergeNonIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    const c = p.getAttribute('position').count;
    pos.set(p.getAttribute('position').array as Float32Array, o * 3);
    nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
    col.set(p.getAttribute('color').array as Float32Array, o * 3);
    o += c;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

export class Traffic {
  private cars: TCar[] = [];
  private bodyMesh: THREE.InstancedMesh;
  private lampMesh: THREE.InstancedMesh;
  private bodyMat: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshBasicMaterial;
  private handleToCar = new Map<number, TCar>();
  private enabled = false;
  private spawnT = 0;
  private tmpM = new THREE.Matrix4();
  private tmpQ = new THREE.Quaternion();
  private tmpP = new THREE.Vector3();
  private tmpS = new THREE.Vector3(1, 1, 1);
  private euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(private ctx: GameContext, private routes: () => Iterable<EdgeRoute>) {
    const geo = carGeometry();
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.15 });
    this.bodyMat.name = 'highway-traffic';
    this.lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.lampMat.name = 'highway-traffic-lamps';
    const max = CONFIG.highway.traffic.maxCars;
    this.bodyMesh = new THREE.InstancedMesh(geo.body, this.bodyMat, max);
    this.lampMesh = new THREE.InstancedMesh(geo.lamps, this.lampMat, max);
    for (const m of [this.bodyMesh, this.lampMesh]) {
      m.userData.noOriginShift = true; // instance matrices are rebuilt in LOCAL coordinates every frame
      m.frustumCulled = false;
      m.name = 'highway-traffic';
      m.count = max;
      for (let i = 0; i < max; i++) m.setMatrixAt(i, this.hidden);
    }
    this.bodyMesh.castShadow = true;
    for (let i = 0; i < max; i++) {
      const color = new THREE.Color(CAR_COLORS[i % CAR_COLORS.length]);
      this.bodyMesh.setColorAt(i, color);
      this.cars.push({
        active: false, route: null, side: 1, lane: 0, laneTarget: 0, lat: 0, s: 0, speed: 30, body: null, collider: null,
        wrecked: false, wreckT: 0, exploded: false, color, prev: new THREE.Matrix4(), curr: new THREE.Matrix4(),
      });
    }
    this.bodyMesh.visible = false;
    this.lampMesh.visible = false;
    ctx.engine.scene.add(this.bodyMesh, this.lampMesh);
    ctx.events.on('contact', (e) => this.onContact(e.h1, e.h2, e.force));
  }

  /** Materials for the warm-up pass (the meshes stay in the scene, hidden while traffic is off). */
  get meshes(): THREE.Object3D[] {
    return [this.bodyMesh, this.lampMesh];
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.bodyMesh.visible = on;
    this.lampMesh.visible = on;
    if (!on) for (const c of this.cars) this.despawn(c);
  }

  private poseAt(c: TCar, out: THREE.Matrix4): void {
    const r = c.route!;
    const f = Math.max(0, Math.min(r.n - 1e-6, c.s / r.ds));
    const i = Math.floor(f), u = f - i;
    let tx = r.tx[i] + (r.tx[i + 1] - r.tx[i]) * u, tz = r.tz[i] + (r.tz[i + 1] - r.tz[i]) * u;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    const l = c.side * c.lat;
    const x = r.x[i] + (r.x[i + 1] - r.x[i]) * u - tz * l;
    const z = r.z[i] + (r.z[i + 1] - r.z[i]) * u + tx * l;
    const bank = r.bank[i] + (r.bank[i + 1] - r.bank[i]) * u;
    const y = r.y[i] + (r.y[i + 1] - r.y[i]) * u - bank * l;
    const grade = (r.y[i + 1] - r.y[i]) / r.ds;
    const o = this.ctx.origin.offset;
    this.tmpP.set(x - o.x, y, z - o.z);
    this.euler.set(-Math.atan(grade) * c.side, Math.atan2(tx, tz) + (c.side > 0 ? 0 : Math.PI), bank * c.side * 0.8, 'YXZ');
    this.tmpQ.setFromEuler(this.euler);
    out.compose(this.tmpP, this.tmpQ, this.tmpS);
  }

  private laneLat(c: TCar, lane: number): number {
    return laneStart() + (lane + 0.5) * CONFIG.highway.laneW;
  }

  private spawn(c: TCar, focusAbs: THREE.Vector3): boolean {
    const T = CONFIG.highway.traffic;
    const cand: EdgeRoute[] = [];
    for (const r of this.routes()) {
      const dx = Math.max(r.minX - focusAbs.x, 0, focusAbs.x - r.maxX), dz = Math.max(r.minZ - focusAbs.z, 0, focusAbs.z - r.maxZ);
      if (Math.hypot(dx, dz) < T.radius) cand.push(r);
    }
    if (!cand.length) return false;
    for (let tries = 0; tries < 8; tries++) {
      const r = cand[Math.floor(Math.random() * cand.length)];
      const s = r.forkA + 40 + Math.random() * Math.max(1, r.L - r.forkA - r.forkB - 80);
      const i = Math.min(r.n, Math.round(s / r.ds));
      const d = Math.hypot(r.x[i] - focusAbs.x, r.z[i] - focusAbs.z);
      if (d < 220 || d > T.radius) continue;
      if (r.kind[i] === K_TUNNEL && (this.ctx.quality.current.weatherLevel ?? 1) === 0) continue;
      const side = Math.random() < 0.5 ? 1 : -1;
      const lanes = Math.floor(lanesAt(r, s));
      const lane = Math.floor(Math.random() * Math.max(1, lanes - 1));
      let clash = false;
      for (const o of this.cars) if (o.active && o.route === r && o.side === side && Math.abs(o.s - s) < 70) clash = true;
      if (clash) continue;
      c.route = r;
      c.side = side;
      c.lane = c.laneTarget = lane;
      c.lat = this.laneLat(c, lane);
      c.s = s;
      const [lo, hi] = T.speedKmh as number[];
      c.speed = (lo + Math.random() * (hi - lo)) / 3.6;
      c.wrecked = false;
      c.exploded = false;
      c.active = true;
      this.poseAt(c, c.curr);
      c.prev.copy(c.curr);
      const { physics } = this.ctx;
      this.tmpP.setFromMatrixPosition(c.curr);
      this.tmpQ.setFromRotationMatrix(c.curr);
      c.body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.tmpP.x, this.tmpP.y + 0.75, this.tmpP.z).setRotation({ x: this.tmpQ.x, y: this.tmpQ.y, z: this.tmpQ.z, w: this.tmpQ.w }),
      );
      c.collider = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.93, 0.7, 2.15).setDensity(180).setCollisionGroups(groups(G.PARKED)).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1500),
        c.body,
      );
      physics.tag(c.collider, { kind: 'parkedCar', material: 'metal' });
      this.handleToCar.set(c.collider.handle, c);
      return true;
    }
    return false;
  }

  private despawn(c: TCar): void {
    if (c.collider) this.handleToCar.delete(c.collider.handle);
    if (c.body) this.ctx.physics.removeBody(c.body);
    c.body = null;
    c.collider = null;
    c.active = false;
    c.route = null;
  }

  private onContact(h1: number, h2: number, force: number): void {
    if (!this.enabled) return;
    const c = this.handleToCar.get(h1) ?? this.handleToCar.get(h2);
    if (!c || !c.body) return;
    const other = this.handleToCar.get(h1) ? h2 : h1;
    const tag = this.ctx.physics.tagOf(other);
    if (!c.wrecked && tag?.kind === 'player') {
      // become a physical wreck with the lane velocity it had
      const r = c.route!;
      const i = Math.min(r.n, Math.round(c.s / r.ds));
      c.wrecked = true;
      c.wreckT = 0;
      c.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      c.body.setLinvel({ x: r.tx[i] * c.side * c.speed, y: 0, z: r.tz[i] * c.side * c.speed }, true);
      c.body.setLinearDamping(0.1);
      c.body.setAngularDamping(0.4);
    }
    if (c.wrecked && !c.exploded && force > 2.6e5) {
      c.exploded = true;
      const t = c.body.translation();
      this.tmpP.set(t.x, t.y, t.z);
      this.ctx.fx.explosion(this.tmpP, 0.8);
      this.ctx.events.emit('explosion', { position: this.tmpP.clone(), radius: 6, force: 0.5 });
    }
  }

  fixedUpdate(dt: number, focusAbs: THREE.Vector3): void {
    if (!this.enabled) return;
    const T = CONFIG.highway.traffic;
    this.spawnT -= dt;
    let active = 0;
    for (const c of this.cars) if (c.active) active++;
    if (this.spawnT <= 0 && active < T.maxCars) {
      this.spawnT = 0.25;
      const free = this.cars.find((c) => !c.active);
      if (free) this.spawn(free, focusAbs);
    }
    const o = this.ctx.origin.offset;
    for (const c of this.cars) {
      if (!c.active || !c.route || !c.body) continue;
      const r = c.route;
      c.prev.copy(c.curr);
      if (c.wrecked) {
        c.wreckT += dt;
        const t = c.body.translation(), q = c.body.rotation();
        this.tmpP.set(t.x, t.y - 0.75, t.z);
        this.tmpQ.set(q.x, q.y, q.z, q.w);
        c.curr.compose(this.tmpP, this.tmpQ, this.tmpS);
        const d = Math.hypot(t.x + o.x - focusAbs.x, t.z + o.z - focusAbs.z);
        if ((c.wreckT > 12 && d > 150) || c.wreckT > 40 || t.y < CONFIG.world.killY) this.despawn(c);
        continue;
      }
      // car ahead in the same lane → slow down or change lanes; avoid kicker lanes
      let ahead = Infinity, aheadSpeed = c.speed;
      for (const b of this.cars) {
        if (b === c || !b.active || b.route !== r || b.side !== c.side || b.lane !== c.lane) continue;
        const gap = (b.s - c.s) * c.side;
        if (gap > 0 && gap < ahead) {
          ahead = gap;
          aheadSpeed = b.wrecked ? 0 : b.speed;
        }
      }
      const lanes = Math.max(1, Math.floor(lanesAt(r, c.s)));
      for (const k of r.features.kickers) {
        const d = (k.s - c.s) * c.side;
        if (k.side === c.side && d > -40 && d < 350 && c.laneTarget >= lanes - 1) c.laneTarget = Math.max(0, lanes - 2);
      }
      if (ahead < 60 && aheadSpeed < c.speed) {
        if (c.laneTarget === c.lane && lanes > 1) c.laneTarget = c.lane > 0 ? c.lane - 1 : c.lane + 1;
        else c.speed = Math.max(aheadSpeed, c.speed - 6 * dt);
      } else if (Math.random() < dt * 0.02 && lanes > 1) c.laneTarget = Math.min(lanes - 2, Math.max(0, c.lane + (Math.random() < 0.5 ? -1 : 1)));
      const targetLat = this.laneLat(c, c.laneTarget);
      const dl = targetLat - c.lat;
      c.lat += Math.sign(dl) * Math.min(Math.abs(dl), 0.9 * dt);
      if (Math.abs(dl) < 0.05) c.lane = c.laneTarget;
      c.s += c.speed * dt * c.side;
      if (c.s < 5 || c.s > r.L - 5) {
        this.despawn(c);
        continue;
      }
      this.poseAt(c, c.curr);
      this.tmpP.setFromMatrixPosition(c.curr);
      this.tmpQ.setFromRotationMatrix(c.curr);
      c.body.setNextKinematicTranslation({ x: this.tmpP.x, y: this.tmpP.y + 0.75, z: this.tmpP.z });
      c.body.setNextKinematicRotation({ x: this.tmpQ.x, y: this.tmpQ.y, z: this.tmpQ.z, w: this.tmpQ.w });
      const d = Math.hypot(this.tmpP.x + o.x - focusAbs.x, this.tmpP.z + o.z - focusAbs.z);
      if (d > T.radius + 250) this.despawn(c);
    }
  }

  update(alpha: number): void {
    if (!this.enabled) return;
    const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), sc = new THREE.Vector3();
    this.cars.forEach((c, i) => {
      if (!c.active) {
        this.bodyMesh.setMatrixAt(i, this.hidden);
        this.lampMesh.setMatrixAt(i, this.hidden);
        return;
      }
      c.prev.decompose(pa, qa, sc);
      c.curr.decompose(pb, qb, sc);
      pa.lerp(pb, alpha);
      qa.slerp(qb, alpha);
      this.tmpM.compose(pa, qa, this.tmpS);
      this.bodyMesh.setMatrixAt(i, this.tmpM);
      this.lampMesh.setMatrixAt(i, c.exploded ? this.hidden : this.tmpM);
    });
    this.bodyMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.instanceMatrix.needsUpdate = true;
  }

  /** After an origin shift the stored matrices (LOCAL) must move with the world. */
  shift(dx: number, dz: number): void {
    const v = new THREE.Vector3();
    for (const c of this.cars) {
      for (const m of [c.prev, c.curr]) {
        v.setFromMatrixPosition(m);
        m.setPosition(v.x - dx, v.y, v.z - dz);
      }
    }
  }

  get activeCount(): number {
    let n = 0;
    for (const c of this.cars) if (c.active) n++;
    return n;
  }
}
