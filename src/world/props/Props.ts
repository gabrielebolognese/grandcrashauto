import * as THREE from 'three';
import { CONFIG } from '../../config';
import { reportError } from '../../core/debugOverlay';
import type { GameContext, IProps } from '../../game/contracts';
import { CAR_MODEL_IDS, type CarModelId } from '../../vehicle/CarBuild';
import type { ParkedCarPlacement, PropPlacement } from '../types';
import { hashf } from './GeoBuilder';
import { NightLights } from './NightLights';
import { PropPhysics } from './PropPhysics';
import { PropRender } from './PropRender';
import { PROP_UNIFORMS, makeCarMaterial, makePropMaterial } from './materials';
import { buildRegistry, carCollider, carLampsFor, disposeRegistry, kindByName, kinds, type KindDef, type VariantOut } from './registry';
import { F, ItemStore } from './store';
import { buildTestLayout } from './testLayout';

/** Placement kind → render kind. Unknown kinds resolve to null (skipped). Extend here for new PropKinds. */
const RESOLVERS: Record<string, (p: PropPlacement, seats: number | undefined) => string> = {
  bench: (p, seats) => ((seats ?? (p.variant % 2 ? 2 : 3)) <= 2 ? 'bench2' : 'bench3'),
  tree: (p) => (p.variant % 4 === 3 ? 'treeCypress' : 'treeRound'),
};

const _v = new THREE.Vector3();
const _n = new THREE.Vector3(0, 1, 0);

interface Geyser {
  x: number;
  y: number;
  z: number;
  t: number;
  acc: number;
}

/**
 * Street furniture, knockable props and parked cars (spec §5, §10; part 2/3 notes). Owner: src/world/props.
 *  - Rendering: PropRender (instanced batches per kind LOD + shared impostors, cell culling, LODs, density thinning).
 *  - Physics: PropPhysics (pooled bodies near the focus, sleeping-dynamic light props & parked cars, toppling heavy
 *    props, blasts, glass, events). Parked while flying above CONFIG.props.planeParkAltitude.
 *  - Night: NightLights (lamp emissive via uNight in the shader, glow sprites, fake light pools, pooled PointLights).
 *  - Disturbed items respawn at their spot once far away and out of view; floating-origin aware.
 */
export class Props implements IProps {
  readonly name = 'props';
  private store = new ItemStore();
  private render: PropRender | null = null;
  private lights: NightLights | null = null;
  private phys: PropPhysics | null = null;
  private mats: { prop: THREE.MeshStandardMaterial; foliage: THREE.MeshStandardMaterial; car: THREE.MeshStandardMaterial } | null = null;
  private focus = new THREE.Vector3();
  private lockedHidden: Uint8Array = new Uint8Array(0);
  private carGeoAttempts = 0;
  private carGeoNext = 0;
  private carGeoDone = false;
  private respawnT = 0;
  private geysers: Geyser[] = [];
  private offs: (() => void)[] = [];
  private time = 0;
  /** True when the dev test layout is shown (stub world or ?propstest). */
  testLayout = false;

  constructor(private ctx: GameContext) {}

  init(): void {
    const { ctx } = this;
    buildRegistry();
    const env = ctx.env;
    this.mats = {
      prop: makePropMaterial(false),
      foliage: makePropMaterial(true, env.patchMaterial ? (m) => env.patchMaterial?.(m, 'foliage') : undefined),
      car: makeCarMaterial(env.patchMaterial ? (m) => env.patchMaterial?.(m, 'vehicle') : undefined),
    };
    this.populate();
    this.lights = new NightLights(ctx);
    this.lights.init();
    this.render = new PropRender(ctx, this.store, this.lights, this.mats);
    this.render.build();
    this.phys = new PropPhysics(ctx, this.store, {
      dirty: () => {
        if (this.render) this.render.dirty = true;
      },
      onToppled: (i, def, speed) => this.onToppled(i, def, speed),
    });
    const ev = ctx.events;
    this.offs.push(
      ev.on('explosion', (e) => this.phys?.explode(e.position, e.radius, e.force ?? 1, this.focus)),
      ev.on('planeExplosion', (e) => this.phys?.explode(e.position, e.radius, Math.min(3, Math.max(1, e.radius / 18)), this.focus)),
      ev.on('originShift', (e) => this.onOriginShift(e.delta.x, e.delta.z)),
      ev.on('qualityChanged', () => this.applyDensity()),
    );
    if (ctx.debug) (window as unknown as { __props?: Props }).__props = this;
  }

  warmup(): void {
    this.render?.warmup();
    this.lights?.warmup();
  }

  // ───────────────────────────── data ─────────────────────────────
  private populate(): void {
    const { ctx, store } = this;
    const data = ctx.world.data;
    const params = new URLSearchParams(location.search);
    let props: PropPlacement[] = data.props ?? [];
    let cars: ParkedCarPlacement[] = data.parkedCars ?? [];
    const seats = new Map<number, number>();
    this.testLayout = params.has('propstest') || props.length === 0;
    if (this.testLayout) {
      const ground = (x: number, z: number) => {
        try {
          return ctx.world.groundHeightAt(x, z);
        } catch {
          return 0;
        }
      };
      // ?propstest=x,z anchors the layout on open ground (yaw 0) instead of the spawn
      const at = (params.get('propstest') ?? '').split(',').map(Number);
      const anchor = at.length >= 2 && at.every(Number.isFinite) ? { position: { x: at[0], y: ground(at[0], at[1]), z: at[1] }, yaw: 0 } : undefined;
      const t = buildTestLayout(data, ground, anchor);
      props = t.props;
      cars = t.cars;
      t.seats.forEach((s, k) => seats.set(k, s));
    } else {
      for (const b of data.benches ?? []) seats.set(b.propIndex, b.seats);
    }
    const nP = props.length, nC = cars.length;
    store.alloc(nP + nC);
    store.nProps = nP;
    this.lockedHidden = new Uint8Array(nP + nC);
    const out: VariantOut = { scale: 1, tint: new THREE.Color(), phase: 0 };
    const seed = CONFIG.game.seed;
    // shelter benches: a separate bench placement sitting on a shelter's built-in bench is redundant
    const shelterSeats: number[] = [];
    const off = CONFIG.props.busStopBenchOffset;
    for (const p of props) if (p.kind === 'busStop') shelterSeats.push(p.p.x + Math.sin(p.yaw) * off, p.p.z + Math.cos(p.yaw) * off);
    for (let i = 0; i < nP; i++) {
      const pl = props[i];
      const res = RESOLVERS[pl.kind];
      const def = kindByName(res ? res(pl, seats.get(i)) : pl.kind) ?? null;
      store.hash[i] = hashf(i * 1.618 + seed * 0.0137 + pl.variant * 0.371);
      if (!def || def.car) {
        store.setBase(i, pl.p.x, pl.p.y, pl.p.z, pl.yaw, 1);
        store.flags[i] = F.HIDDEN;
        this.lockedHidden[i] = 1;
        continue;
      }
      def.variant(pl.variant, out);
      store.kind[i] = def.id;
      store.setBase(i, pl.p.x, pl.p.y, pl.p.z, pl.yaw, out.scale);
      out.tint.toArray(store.tint, i * 3);
      store.inst[i * 4] = out.phase;
      store.inst[i * 4 + 2] = 1;
      if (pl.kind === 'bench') {
        for (let k = 0; k < shelterSeats.length; k += 2) {
          if (Math.hypot(pl.p.x - shelterSeats[k], pl.p.z - shelterSeats[k + 1]) < 1.0) {
            store.flags[i] = F.HIDDEN;
            this.lockedHidden[i] = 1;
          }
        }
      }
    }
    for (let j = 0; j < nC; j++) {
      const c = cars[j];
      const i = nP + j;
      const model: CarModelId = CAR_MODEL_IDS[Math.abs(Math.floor(c.variant)) % CAR_MODEL_IDS.length];
      const def = kindByName(`car:${model}`)!;
      store.kind[i] = def.id;
      store.setBase(i, c.p.x, c.p.y, c.p.z, c.yaw, 1);
      const col = new THREE.Color();
      try {
        col.set(c.color || '#ffffff');
      } catch {
        col.set('#ffffff');
      }
      col.toArray(store.tint, i * 3);
      store.hash[i] = hashf(j * 2.399 + seed * 0.0191 + 0.5);
      store.inst[i * 4 + 2] = def.carLamps?.halfLength ?? 2.2;
      store.inst[i * 4 + 3] = hashf(j * 3.7 + seed * 0.11) < CONFIG.props.carLightsChance ? 1 : 0;
    }
    this.assignTrafficPhases(props);
    store.buildGrid(32);
    this.applyDensity();
  }

  /** Traffic lights at the same intersection share a base phase; perpendicular approaches are half a cycle apart. */
  private assignTrafficPhases(props: PropPlacement[]): void {
    const { store } = this;
    const T = CONFIG.props.traffic;
    const cycle = 2 * (T.green + T.amber + T.allRed);
    const nodes = (this.ctx.world.data.roads?.nodes ?? []).filter((n) => n.trafficLight || n.kind === 'intersection');
    for (let i = 0; i < props.length; i++) {
      const pl = props[i];
      if (pl.kind !== 'trafficLight') continue;
      let key = -1;
      let best = 40 * 40;
      for (const n of nodes) {
        const d = (n.p.x - pl.p.x) ** 2 + (n.p.z - pl.p.z) ** 2;
        if (d < best) {
          best = d;
          key = n.id + 1;
        }
      }
      if (key < 0) key = 100000 + Math.round(pl.p.x / 30) * 977 + Math.round(pl.p.z / 30) * 131;
      const base = hashf(key * 0.731 + CONFIG.game.seed * 0.01) * cycle;
      const crossAxis = Math.abs(Math.sin(pl.yaw)) > Math.abs(Math.cos(pl.yaw));
      store.inst[i * 4] = base + (crossAxis ? cycle / 2 : 0);
    }
  }

  private applyDensity(): void {
    const { store } = this;
    const q = this.ctx.quality.current;
    const dens = q.propDensity ?? 1;
    const cd = q.parkedCarDensity ?? 1;
    const K = kinds();
    for (let i = 0; i < store.n; i++) {
      const k = store.kind[i];
      let hide = this.lockedHidden[i] === 1 || k < 0;
      if (!hide) {
        const def = K[k];
        if (def.car) hide = store.hash[i] > cd;
        else if (def.thin) hide = store.hash[i] > dens;
      }
      const was = (store.flags[i] & F.HIDDEN) !== 0;
      if (hide && !was) {
        if (store.rec[i] >= 0) this.phys?.release(i, false);
        store.flags[i] |= F.HIDDEN;
      } else if (!hide && was) {
        store.flags[i] &= ~F.HIDDEN;
      }
    }
    if (this.render) this.render.dirty = true;
  }

  // ───────────────────────────── car geometry from the car-models module ─────────────────────────────
  private ensureCarGeometry(): void {
    if (this.carGeoDone || this.time < this.carGeoNext) return;
    const f = this.ctx.cars?.instancingGeometry;
    if (!f) {
      this.carGeoDone = true;
      return;
    }
    let got = 0;
    for (const model of CAR_MODEL_IDS) {
      const def = kindByName(`car:${model}`);
      if (!def) continue;
      let geo: THREE.BufferGeometry | null = null;
      try {
        geo = f.call(this.ctx.cars, model);
      } catch (err) {
        reportError('[props] instancingGeometry threw', err);
      }
      if (!geo || !geo.getAttribute('position') || !geo.getAttribute('paintMask')) continue;
      got++;
      this.useCarGeometry(def, this.sanitize(geo));
    }
    this.carGeoAttempts++;
    if (got > 0 || this.carGeoAttempts >= 3) this.carGeoDone = true;
    else this.carGeoNext = this.time + 3;
  }

  /** Make an external car geometry match our shader's expectations (vec3 colour, normals). */
  private sanitize(src: THREE.BufferGeometry): THREE.BufferGeometry {
    const g = src.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const c = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    const n = g.getAttribute('position').count;
    if (!c) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    } else if (c.itemSize !== 3) {
      const a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        a[i * 3] = c.getX(i);
        a[i * 3 + 1] = c.getY(i);
        a[i * 3 + 2] = c.getZ(i);
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(a, 3));
    }
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'color', 'paintMask'].includes(name)) g.deleteAttribute(name);
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  private useCarGeometry(def: KindDef, geo: THREE.BufferGeometry): void {
    const bb = geo.boundingBox!;
    const L = bb.max.z - bb.min.z, W = bb.max.x - bb.min.x, H = bb.max.y - Math.max(0, bb.min.y);
    if (!(L > 1 && W > 0.8 && H > 0.5)) return;
    this.render?.setKindGeometry(def, geo);
    def.colliders[0] = carCollider(L, W, H);
    def.carLamps = carLampsFor(L, W, H);
    // glow anchors from the lamp lenses (paintMask 0.25: warm-white front, red rear)
    const pm = geo.getAttribute('paintMask') as THREE.BufferAttribute;
    const pa = geo.getAttribute('position') as THREE.BufferAttribute;
    const fr = [0, 0, -1e9, 0], rr = [0, 0, 1e9, 0];
    for (let v = 0; v < pa.count; v++) {
      if (Math.abs(pm.getX(v) - 0.25) > 0.1) continue;
      const x = Math.abs(pa.getX(v)), y = pa.getY(v), z = pa.getZ(v);
      const a = z > 0 ? fr : rr;
      a[0] += x;
      a[1] += y;
      a[2] = z > 0 ? Math.max(a[2], z) : Math.min(a[2], z);
      a[3]++;
    }
    if (fr[3] > 0) def.carLamps.front = [fr[0] / fr[3], fr[1] / fr[3], fr[2] + 0.03];
    if (rr[3] > 0) def.carLamps.rear = [rr[0] / rr[3], rr[1] / rr[3], rr[2] - 0.03];
    def.radius = L / 2;
    def.height = H;
    const { store } = this;
    for (let i = 0; i < store.n; i++) {
      if (store.kind[i] !== def.id) continue;
      store.inst[i * 4 + 2] = L / 2;
      if (store.rec[i] >= 0) this.phys?.release(i, true);
    }
    this.phys?.dropPool(def);
    geo.dispose(); // the batch keeps its own clone
  }

  // ───────────────────────────── loop ─────────────────────────────
  private computeFocus(): void {
    const { ctx } = this;
    const target = ctx.game.mode === 'plane' ? ctx.planes?.cameraTarget?.object : null;
    if (target) target.getWorldPosition(this.focus);
    else if (ctx.vehicle.active && ctx.vehicle.object) this.focus.copy(ctx.vehicle.state.position);
    else this.focus.copy(ctx.engine.camera.position);
  }

  fixedUpdate(dt: number): void {
    if (!this.phys) return;
    this.ensureCarGeometry();
    this.computeFocus();
    this.phys.fixedUpdate(dt, this.focus);
  }

  postStep(dt: number): void {
    this.phys?.postStep(dt);
  }

  update(_dt: number, alpha: number): void {
    const { render, phys, lights } = this;
    if (!render || !phys || !lights) return;
    const realDt = this.ctx.engine.realDt;
    this.time += realDt;
    const P = CONFIG.props;
    PROP_UNIFORMS.pTraffic.value.set(P.traffic.green, P.traffic.amber, P.traffic.allRed, 2 * (P.traffic.green + P.traffic.amber + P.traffic.allRed));
    PROP_UNIFORMS.pSway.value = P.sway;
    if (!phys.parked) phys.interpolate(alpha, (i) => render.writeItem(i));
    if (!render.update(this.ctx.engine.camera)) render.flushAll();
    lights.update(realDt);
    this.respawnT -= realDt;
    if (this.respawnT <= 0) {
      this.respawnT = 0.5;
      this.respawnPass(0.5);
    }
    this.updateGeysers(realDt);
  }

  private respawnPass(step: number): void {
    const { store, render, phys } = this;
    if (!render || !phys) return;
    const P = CONFIG.props;
    const fx = this.focus.x, fz = this.focus.z;
    const R2 = P.respawnDistance * P.respawnDistance;
    const K = kinds();
    const killY = CONFIG.world.killY;
    for (let m = store.movedList.length - 1; m >= 0; m--) {
      const i = store.movedList[m];
      if (store.pos[i * 3 + 1] < killY) {
        this.restoreItem(i); // fell out of the world
        continue;
      }
      if (store.rec[i] >= 0 && phys.isAwake(i)) {
        store.awayT[i] = 0;
        continue;
      }
      const x = store.pos[i * 3], y = store.pos[i * 3 + 1], z = store.pos[i * 3 + 2];
      const bx = store.basePos[i * 3], bz = store.basePos[i * 3 + 2];
      const def = K[store.kind[i]];
      const far = (x - fx) ** 2 + (z - fz) ** 2 > R2 && (bx - fx) ** 2 + (bz - fz) ** 2 > R2;
      const seen = render.inView(x, y + 1, z, (def?.height ?? 2) + 2) || render.inView(bx, store.basePos[i * 3 + 1] + 1, bz, (def?.height ?? 2) + 2);
      if (far && !seen) store.awayT[i] += step;
      else store.awayT[i] = 0;
      if (store.awayT[i] >= P.respawnDelay) this.restoreItem(i);
    }
  }

  private restoreItem(i: number): void {
    const { store } = this;
    if (store.rec[i] >= 0) this.phys?.release(i, false);
    store.restore(i);
    store.unmarkMoved(i);
    store.flags[i] &= ~(F.DISTURBED | F.TOPPLED | F.GLASS);
    const def = kinds()[store.kind[i]];
    if (def?.car) {
      store.inst[i * 4] = 0;
      store.inst[i * 4 + 1] = 0;
    } else {
      store.inst[i * 4 + 2] = 1;
    }
    store.awayT[i] = 0;
    if (this.render) this.render.dirty = true;
  }

  private onToppled(i: number, def: KindDef, speed: number): void {
    const { store, ctx } = this;
    const p = _v.set(store.pos[i * 3], store.pos[i * 3 + 1] + 0.4, store.pos[i * 3 + 2]);
    ctx.events.emit('propHit', { position: p, kind: def.event, speed });
    if (def.surface === 'metal') ctx.fx.sparks(p, _n, Math.min(1, speed / 20));
    ctx.fx.dust(p, 0.6 + Math.min(0.8, speed / 25));
    if (def.name === 'hydrant' && this.geysers.length < 4) this.geysers.push({ x: p.x, y: store.basePos[i * 3 + 1] + 0.6, z: p.z, t: 7, acc: 0 });
  }

  /** Knocked hydrants spray for a few seconds. */
  private updateGeysers(dt: number): void {
    for (let k = this.geysers.length - 1; k >= 0; k--) {
      const g = this.geysers[k];
      g.t -= dt;
      g.acc += dt;
      if (g.acc > 0.09) {
        g.acc = 0;
        this.ctx.fx.dust(_v.set(g.x, g.y, g.z), 0.9 * Math.min(1, g.t / 2), '#e6f6ff');
      }
      if (g.t <= 0) this.geysers.splice(k, 1);
    }
  }

  private onOriginShift(dx: number, dz: number): void {
    this.store.shift(dx, dz);
    this.phys?.shift(dx, dz);
    this.lights?.shift(dx, dz);
    for (const g of this.geysers) {
      g.x -= dx;
      g.z -= dz;
    }
    this.focus.x -= dx;
    this.focus.z -= dz;
    if (this.render) this.render.dirty = true;
  }

  // ───────────────────────────── IProps ─────────────────────────────
  isDisturbed(propIndex: number): boolean {
    if (propIndex < 0 || propIndex >= this.store.nProps) return false;
    return (this.store.flags[propIndex] & F.DISTURBED) !== 0;
  }

  resetAll(): void {
    const { store } = this;
    this.phys?.releaseAll(false);
    for (let m = store.movedList.length - 1; m >= 0; m--) this.restoreItem(store.movedList[m]);
    for (let i = 0; i < store.n; i++) {
      if (store.flags[i] & (F.GLASS | F.DISTURBED | F.TOPPLED)) this.restoreItem(i);
    }
    this.geysers.length = 0;
  }

  /** Debug / test helpers. */
  stats(): Record<string, number> {
    return {
      items: this.store.n,
      moved: this.store.movedList.length,
      bodies: this.phys?.bodyCount ?? 0,
      active: this.phys?.activeCount ?? 0,
      batches: this.render?.drawBatches ?? 0,
      triangles: this.render?.triangles ?? 0,
      lights: this.lights?.lightCount ?? 0,
      parked: this.phys?.parked ? 1 : 0,
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.phys?.dispose();
    this.render?.dispose();
    this.lights?.dispose();
    this.mats?.prop.dispose();
    this.mats?.foliage.dispose();
    this.mats?.car.dispose();
    this.phys = null;
    this.render = null;
    this.lights = null;
    disposeRegistry();
  }
}
