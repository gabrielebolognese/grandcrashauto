import './nav.css';
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { GameContext, INav } from '../game/contracts';
import type { Pose } from '../world/types';
import { MapScreen } from '../ui/map/MapScreen';
import { formatDistance } from './format';
import { type GraphSource, NavGraph, type RawPath } from './NavGraph';
import { decodeDiscovered, encodeDiscovered, iconFor, makePoi, type NavPoi, type PoiSource, type SavedPoi } from './pois';
import { Ribbon } from './Ribbon';
import { Route, type TurnDir } from './Route';
import { TurnCard } from './TurnCard';

type NextTurn = { direction: TurnDir; distance: number };

/**
 * Navigation (SPEC-PART2 §3, SPEC-PART3 §2): points of interest (city + terrain + highways, discovery + save),
 * A* directions over the combined city + highway graph, the chevron road ribbon, the top-centre turn card,
 * the Map screen (src/ui/map) and teleport. Runtime state is LOCAL (contract); the graph, POIs and routes are
 * kept in ABSOLUTE coordinates internally, so a floating-origin shift only moves the exposed `route` polyline.
 */
export class Nav implements INav {
  readonly name = 'nav';
  pois: NavPoi[] = [];
  route: THREE.Vector3[] | null = null;
  destination: NavPoi | null = null;
  nextTurn: NextTurn | null = null;
  mapOpen = false;

  /** Combined graph (absolute coordinates) — null until first needed. */
  graph: NavGraph | null = null;
  /** Active route (absolute coordinates). */
  active: Route | null = null;
  /** Last A* timing (ms) and expansions, for the debug panel / smoke tests. */
  stats = { routeMs: 0, buildMs: 0, expansions: 0, nodes: 0, edges: 0, routes: 0, rebuilds: 0 };

  private graphSig = '';
  private graphBuiltAt = -1e9;
  private ribbon: Ribbon | null = null;
  private card: TurnCard | null = null;
  private map: MapScreen | null = null;
  private poiMap = new Map<string, NavPoi>();
  private saved = new Map<string, SavedPoi>();
  private discovered = new Set<string>();
  private pausedByMap = false;
  private poiT = 0;
  private offT = 0;
  private wrongT = 0;
  private lastRecalc = -1e9;
  private lastExtend = 0;
  private extendSig = '';
  private forceRecalc = false;
  private trimmed = 0;
  private rerouteFlash = 0;
  private prefetchT = 0;
  private inited = false;
  private tmpV = new THREE.Vector3();

  constructor(private ctx: GameContext) {
    // Registered before the UI's menu navigator (built in ui.init) so map keys never reach the pause menu below.
    window.addEventListener('keydown', (e) => this.map?.onKey(e), true);
  }

  init(): void {
    if (this.inited) return;
    this.inited = true;
    const { ctx } = this;
    for (const s of ctx.save.data.discovered ?? []) {
      const d = decodeDiscovered(s);
      if (!d) continue;
      this.discovered.add(d.id);
      if (d.pose) this.saved.set(d.id, d);
    }
    this.ribbon = new Ribbon();
    ctx.engine.scene.add(this.ribbon.mesh);
    this.card = new TurnCard();
    const root = document.getElementById('ui-root') ?? document.body;
    root.append(this.card.el);
    this.map = new MapScreen(this, ctx);

    ctx.events.on('originShift', ({ delta }) => {
      if (this.route) for (const p of this.route) {
        p.x -= delta.x;
        p.z -= delta.z;
      }
      for (const p of this.poiMap.values()) {
        p.pose.position.x = p.ax - ctx.origin.offset.x;
        p.pose.position.z = p.az - ctx.origin.offset.z;
      }
    });
    ctx.events.on('carReset', () => {
      this.forceRecalc = true;
    });
    ctx.events.on('stateChanged', () => this.updateCard());
    ctx.events.on('modeChanged', () => this.updateCard());
    this.refreshPois();
  }

  // ─────────────────────────────── geometry helpers ───────────────────────────────
  get offset(): THREE.Vector3 {
    return this.ctx.origin.offset;
  }

  /** Player focus (car, or the plane in plane mode), absolute. */
  focusAbs(out = this.tmpV): THREE.Vector3 {
    const { ctx } = this;
    const o = ctx.origin.offset;
    if (ctx.game.mode === 'plane' && ctx.planes?.state?.position) out.copy(ctx.planes.state.position);
    else out.copy(ctx.vehicle.state.position);
    out.x += o.x;
    out.z += o.z;
    return out;
  }

  /** Heading of the player in radians (yaw convention: 0 faces +Z). */
  focusYaw(): number {
    const { ctx } = this;
    const f = ctx.game.mode === 'plane' && ctx.planes?.state?.forward ? ctx.planes.state.forward : ctx.vehicle.state.forward;
    return Math.atan2(f.x, f.z);
  }

  entries(): NavPoi[] {
    return this.pois;
  }

  isDiscovered(id: string): boolean {
    return this.poiMap.get(id)?.discovered ?? this.discovered.has(id);
  }

  // ─────────────────────────────── POIs ───────────────────────────────
  refreshPois(): void {
    const { ctx } = this;
    const o = ctx.origin.offset;
    const seen = new Set<string>();
    let changed = false;
    const add = (id: string, name: string, icon: string | undefined, pose: Pose | undefined | null, source: PoiSource) => {
      if (!id || seen.has(id) || !pose?.position || !Number.isFinite(pose.position.x) || !Number.isFinite(pose.position.z)) return;
      seen.add(id);
      const ic = iconFor(id, name, icon);
      let p = this.poiMap.get(id);
      if (!p) {
        p = makePoi(id, name || id, ic, pose, o.x, o.z, source);
        this.poiMap.set(id, p);
        changed = true;
      } else {
        p.pose.position.x = pose.position.x;
        p.pose.position.y = pose.position.y;
        p.pose.position.z = pose.position.z;
        p.pose.yaw = pose.yaw;
        p.ax = pose.position.x + o.x;
        p.ay = pose.position.y;
        p.az = pose.position.z + o.z;
        p.name = name || id;
        p.icon = ic;
        if (p.source !== source) changed = true;
        p.source = source;
        p.live = true;
      }
      p.discovered = source === 'city' || this.discovered.has(id);
    };
    const data = ctx.world?.data;
    if (data) {
      for (const p of data.pois ?? []) add(p.id, p.name, undefined, p.pose, 'city');
      if (data.airport?.carPark) add('airport', 'Airport', '✈️', data.airport.carPark, 'city');
      if (data.spawn) add('garage', 'Garage', '🔧', data.spawn, 'city');
    }
    // air-defence sites (missiles): always known, always teleportable
    try {
      for (const p of ctx.missiles?.pois ?? []) add(p.id, p.name, p.icon, p.pose, 'city');
      for (const p of ctx.towers?.pois ?? []) add(p.id, p.name, p.icon, p.pose, 'city');
    } catch {
      /* missiles not ready */
    }
    try {
      for (const p of ctx.terrain?.pois ?? []) add(p.id, p.name, p.icon, p.pose, 'terrain');
    } catch {
      /* terrain not ready */
    }
    try {
      for (const p of ctx.highways?.pois ?? []) add(p.id, p.name, p.icon, p.pose, 'highway');
    } catch {
      /* highways not ready */
    }
    // discovered POIs only known from the save (network not regenerated there yet)
    for (const s of this.saved.values()) {
      if (seen.has(s.id) || !s.pose) continue;
      seen.add(s.id);
      let p = this.poiMap.get(s.id);
      if (!p) {
        p = makePoi(s.id, s.pose.name, s.pose.icon, { position: { x: s.pose.ax - o.x, y: s.pose.ay, z: s.pose.az - o.z }, yaw: s.pose.yaw }, o.x, o.z, 'saved');
        this.poiMap.set(s.id, p);
        changed = true;
      }
      p.live = false;
      p.discovered = true;
      p.pose.position.x = p.ax - o.x;
      p.pose.position.z = p.az - o.z;
    }
    // a city POI sharing its name with a generated one (the city 'Big Jump' vs the highway one) gets a suffix
    const names = new Set<string>();
    for (const p of this.poiMap.values()) if (p.source !== 'city' && seen.has(p.id)) names.add(p.name);
    for (const p of this.poiMap.values()) if (p.source === 'city' && names.has(p.name)) p.name = `${p.name} (City)`;
    for (const [id, p] of this.poiMap) {
      if (!seen.has(id) && p !== this.destination) {
        this.poiMap.delete(id);
        changed = true;
      }
    }
    if (changed || this.pois.length !== this.poiMap.size) {
      const order: Record<PoiSource, number> = { city: 0, highway: 1, terrain: 1, saved: 2 };
      this.pois = Array.from(this.poiMap.values()).sort((a, b) => order[a.source] - order[b.source]);
      this.map?.markDirty();
    }
  }

  private checkDiscovery(): void {
    const { ctx } = this;
    if (ctx.game.state !== 'driving') return;
    if (!ctx.vehicle.active && ctx.game.mode !== 'plane') return;
    const f = this.focusAbs();
    const r = CONFIG.nav.discoverRadius;
    for (const p of this.poiMap.values()) {
      if (p.discovered) continue;
      const dx = p.ax - f.x;
      const dz = p.az - f.z;
      if (dx * dx + dz * dz < r * r && Math.abs(p.ay - f.y) < 300) this.discover(p);
    }
  }

  private discover(p: NavPoi): void {
    const { ctx } = this;
    p.discovered = true;
    this.discovered.add(p.id);
    const entry = encodeDiscovered(p);
    const d = decodeDiscovered(entry);
    if (d?.pose) this.saved.set(p.id, d);
    ctx.save.update((s) => {
      s.discovered = s.discovered.filter((x) => x.split('|')[0] !== p.id);
      s.discovered.push(entry);
      if (s.discovered.length > 500) s.discovered.splice(0, s.discovered.length - 500);
    });
    ctx.events.emit('poiDiscovered', { id: p.id, name: p.name });
    ctx.events.emit('toast', { text: `${p.icon} Discovered: ${p.name} — teleport unlocked`, ms: 3200 });
    ctx.events.emit('vibrate', { pattern: [20, 40, 30] });
    this.map?.markDirty();
  }

  // ─────────────────────────────── graph ───────────────────────────────
  private graphSignature(): string {
    const { ctx } = this;
    const r = ctx.world?.data?.roads;
    let hw = '';
    try {
      const g = ctx.highways?.graph;
      hw = `${ctx.highways?.graphVersion ?? 0}|${g?.nodes?.length ?? 0}|${g?.edges?.length ?? 0}`;
    } catch {
      hw = 'x';
    }
    return `${r?.nodes?.length ?? 0}|${r?.edges?.length ?? 0}|${hw}`;
  }

  /** (Re)build the combined graph if the sources changed (at most once per `minInterval` s while a graph exists). */
  ensureGraph(minInterval = 0): NavGraph | null {
    const sig = this.graphSignature();
    const now = performance.now();
    if (this.graph && (sig === this.graphSig || now - this.graphBuiltAt < minInterval * 1000)) return this.graph;
    const { ctx } = this;
    const o = ctx.origin.offset;
    const sources: GraphSource[] = [];
    const city = ctx.world?.data?.roads;
    if (city) sources.push({ graph: city, ox: o.x, oz: o.z, hw: false });
    try {
      const hg = ctx.highways?.graph;
      if (hg && hg.nodes?.length) sources.push({ graph: hg, ox: o.x, oz: o.z, hw: true });
    } catch {
      /* highways not ready */
    }
    const t0 = performance.now();
    try {
      this.graph = NavGraph.build(sources, CONFIG.nav.mergeDistance, CONFIG.nav.joinDistance);
    } catch (err) {
      console.error('[nav] graph build failed', err);
      this.graph = null;
    }
    this.stats.buildMs = +(performance.now() - t0).toFixed(2);
    this.stats.rebuilds++;
    this.stats.nodes = this.graph?.nodeCount ?? 0;
    this.stats.edges = this.graph?.base.length ?? 0;
    this.graphSig = sig;
    this.graphBuiltAt = now;
    this.map?.markDirty();
    return this.graph;
  }

  // ─────────────────────────────── routing ───────────────────────────────
  setDestination(poiId: string | null): void {
    if (poiId === null) {
      this.clearRoute();
      return;
    }
    let p = this.poiMap.get(poiId);
    if (!p) {
      this.refreshPois();
      p = this.poiMap.get(poiId);
    }
    if (!p) {
      this.ctx.events.emit('toast', { text: 'Unknown destination' });
      return;
    }
    this.destination = p;
    const ok = this.computeRoute();
    if (ok && this.active) {
      const units = this.ctx.settings.values.units;
      this.ctx.events.emit('toast', { text: `🧭 Directions to ${p.name} · ${formatDistance(this.active.length, units)}` });
    }
    this.updateCard();
    this.map?.markDirty();
  }

  private clearRoute(): void {
    this.destination = null;
    this.active = null;
    this.route = null;
    this.nextTurn = null;
    this.offT = 0;
    this.wrongT = 0;
    this.ribbon?.setActive(false);
    this.updateCard();
    this.map?.markDirty();
  }

  private carState(): { x: number; y: number; z: number; fx: number; fz: number } {
    const { ctx } = this;
    const o = ctx.origin.offset;
    const v = ctx.vehicle.state;
    const fx = v.forward?.x ?? 0;
    const fz = v.forward?.z ?? 1;
    if (ctx.game.mode === 'plane' && ctx.planes?.state?.position) {
      const p = ctx.planes.state.position;
      const f = ctx.planes.state.forward;
      return { x: p.x + o.x, y: p.y, z: p.z + o.z, fx: f?.x ?? 0, fz: f?.z ?? 1 };
    }
    return { x: v.position.x + o.x, y: v.position.y, z: v.position.z + o.z, fx, fz };
  }

  /** Compute (or recompute) the route from the player to the destination. Returns false when there is none. */
  computeRoute(): boolean {
    const dest = this.destination;
    if (!dest) return false;
    const C = CONFIG.nav;
    const t0 = performance.now();
    const car = this.carState();
    const g = this.ensureGraph();
    let raw: RawPath | null = null;
    if (g && g.nodeCount > 0) {
      const start = g.snapStart(car.x, car.z, car.y, car.fx, car.fz, C.snapStart, C.snapFar);
      if (start) {
        const goal = g.nearest(dest.ax, dest.az, C.goalSnap, undefined, dest.ay);
        raw = g.route(start, goal, dest.ax, dest.az, car.fx, car.fz, C.uturnPenalty, C.maxExpansions);
        if (!raw && goal) raw = g.route(start, null, dest.ax, dest.az, car.fx, car.fz, C.uturnPenalty, C.maxExpansions);
        if (raw) {
          this.stats.expansions = raw.expansions;
          // off-road connector from the car onto the network
          if (start.dist > 8) {
            raw.pts.unshift(car.x, start.y, car.z);
            raw.node.unshift(-1);
            raw.offroad.unshift(1);
            raw.lat.unshift(0);
          }
          const n = raw.pts.length / 3;
          const ex = raw.pts[n * 3 - 3];
          const ez = raw.pts[n * 3 - 1];
          const endD = Math.hypot(ex - dest.ax, ez - dest.az);
          if (raw.partial && Math.hypot(car.x - dest.ax, car.z - dest.az) <= endD + 20) {
            raw = null; // already closer than anything the network reaches: head straight for it
          } else if (endD > C.arriveRadius * 0.6) {
            // last bit off the network (POI away from the road, or network not generated toward it yet)
            raw.offroad[raw.offroad.length - 1] = 1;
            raw.lat[raw.lat.length - 1] = 0;
            raw.pts.push(dest.ax, dest.ay, dest.az);
            raw.node.push(-1);
            raw.offroad.push(0);
            raw.lat.push(0);
          }
        }
      }
    }
    if (!raw) {
      raw = { pts: [car.x, car.y, car.z, dest.ax, dest.ay, dest.az], node: [-1, -1], offroad: [1, 0], lat: [0, 0], partial: true, uturnStart: false, cost: 0, expansions: 0 };
    }
    const route = new Route(raw, dest.ax, dest.az, g, C.turnAngleDeg);
    this.active = route;
    this.trimmed = 0;
    route.track(car.x, car.z);
    const o = this.ctx.origin.offset;
    const arr: THREE.Vector3[] = [];
    for (let i = 0; i < route.n; i++) arr.push(new THREE.Vector3(route.x[i] - o.x, route.y[i], route.z[i] - o.z));
    this.route = arr;
    this.offT = 0;
    this.wrongT = 0;
    this.lastRecalc = performance.now();
    this.lastExtend = this.lastRecalc;
    this.extendSig = this.graphSig;
    this.stats.routeMs = +(performance.now() - t0).toFixed(2);
    this.stats.routes++;
    this.ribbon?.setActive(true);
    this.updateNextTurn();
    this.map?.markDirty();
    return true;
  }

  private arrive(): void {
    const name = this.destination?.name ?? '';
    this.ctx.events.emit('toast', { text: `🏁 Arrived${name ? ` at ${name}` : ''}`, ms: 2600 });
    this.ctx.events.emit('vibrate', { pattern: [30, 60, 30] });
    this.clearRoute();
  }

  private updateNextTurn(): void {
    const r = this.active;
    if (!r) {
      this.nextTurn = null;
      return;
    }
    const m = r.nextManeuver();
    if (m) {
      const d = Math.max(0, m.s - r.s);
      this.nextTurn = { direction: m.dir !== 'arrive' && d > 1500 ? 'straight' : m.dir, distance: d };
    } else this.nextTurn = { direction: 'straight', distance: r.remaining };
  }

  // ─────────────────────────────── per frame ───────────────────────────────
  update(dt: number): void {
    const { ctx } = this;
    const C = CONFIG.nav;
    this.poiT -= dt;
    if (this.poiT <= 0) {
      this.poiT = 0.5;
      this.refreshPois();
      this.checkDiscovery();
    }
    const driving = ctx.game.state === 'driving';
    if (driving && this.prefetchT >= 0) {
      this.prefetchT += ctx.engine.realDt;
      if (this.prefetchT > 8) {
        this.prefetchT = -1;
        try {
          this.map?.prefetch();
        } catch (err) {
          console.warn('[nav] map prefetch failed', err);
        }
      }
    }
    const carMode = ctx.game.mode === 'car';
    const r = this.active;
    if (r && this.destination && driving && carMode && ctx.vehicle.active) {
      const car = this.carState();
      const dest = this.destination;
      if (Math.hypot(car.x - dest.ax, car.z - dest.az) < C.arriveRadius) {
        this.arrive();
      } else if (this.forceRecalc) {
        this.forceRecalc = false;
        this.computeRoute();
      } else {
        const off = r.track(car.x, car.z);
        const onTail = r.offroad[Math.min(r.n - 1, r.seg)] === 1 && r.seg > 0;
        this.offT = off > (onTail ? 150 : C.offRouteDistance) ? this.offT + dt : 0;
        const v = ctx.vehicle.state.velocity;
        const sp = Math.hypot(v.x, v.z);
        const dir = r.dirAt(r.s);
        this.wrongT = sp > 6 && (v.x * dir.x + v.z * dir.z) / sp < -0.5 && !onTail ? this.wrongT + dt : 0;
        const now = performance.now();
        const canRecalc = now - this.lastRecalc > C.recalcMinInterval * 1000;
        if (canRecalc && (this.offT > C.offRouteTime || this.wrongT > 3)) {
          this.computeRoute();
          this.rerouteFlash = 1.4;
        } else if (r.partial && now - this.lastExtend > C.partialRefresh * 1000) {
          this.lastExtend = now;
          const sig = this.graphSignature();
          if (sig !== this.extendSig) this.computeRoute(); // the network grew toward the target
        } else {
          // trim the passed part of the exposed polyline (minimap draws what's left)
          const rt = this.route;
          while (rt && rt.length > 2 && this.trimmed < r.seg) {
            rt.shift();
            this.trimmed++;
          }
          this.updateNextTurn();
        }
      }
    }
    this.rerouteFlash = Math.max(0, this.rerouteFlash - dt);
    this.ribbon?.setActive(!!this.active && carMode);
    const o = ctx.origin.offset;
    const world = ctx.world;
    this.ribbon?.update(dt, this.active, o.x, o.z, world?.groundHeightAt ? (x, z) => world.groundHeightAt(x, z) : null);
    this.updateCard();
  }

  private updateCard(): void {
    const card = this.card;
    if (!card) return;
    const { ctx } = this;
    const r = this.active;
    const show = !!r && !!this.destination && !!this.nextTurn && ctx.game.state === 'driving' && ctx.game.mode === 'car' && !this.mapOpen;
    card.setVisible(show);
    if (!show || !r || !this.nextTurn || !this.destination) return;
    const units = ctx.settings.values.units;
    const t = this.nextTurn;
    const onTail = r.partial && r.offroad[Math.min(r.n - 1, r.seg)] === 1;
    const sub = this.rerouteFlash > 0 ? 'Rerouting…' : `${this.destination.name} · ${formatDistance(r.remaining, units)}${onTail ? ' · off-road' : ''}`;
    card.set(t.direction, t.distance < 8 && t.direction !== 'straight' ? 'Now' : formatDistance(t.distance, units), sub, t.distance < 60 && t.direction !== 'straight' && t.direction !== 'arrive', r.partial && t.direction !== 'arrive');
  }

  // ─────────────────────────────── teleport ───────────────────────────────
  canTeleport(p: NavPoi | undefined | null): { ok: boolean; reason: string } {
    const { ctx } = this;
    if (!p) return { ok: false, reason: 'Unknown place' };
    if (!p.discovered) return { ok: false, reason: `Drive within ${Math.round(CONFIG.nav.discoverRadius)} m to unlock teleport` };
    if (ctx.vehicle.state.exploded) return { ok: false, reason: 'Your car is wrecked — reset it first' };
    if (!ctx.vehicle.active) return { ok: false, reason: 'No car to teleport' };
    return { ok: true, reason: '' };
  }

  teleport(poiId: string): void {
    const { ctx } = this;
    const p = this.poiMap.get(poiId);
    const chk = this.canTeleport(p);
    if (!p || !chk.ok) {
      ctx.events.emit('toast', { text: chk.reason });
      return;
    }
    const o = ctx.origin.offset;
    const pose: Pose = { position: { x: p.ax - o.x, y: p.ay, z: p.az - o.z }, yaw: p.pose.yaw };
    if (this.destination?.id === poiId) this.clearRoute();
    this.closeMap();
    if (ctx.game.state === 'paused') ctx.game.resume();
    ctx.game.teleportCar(pose);
    this.forceRecalc = true;
  }

  // ─────────────────────────────── map screen ───────────────────────────────
  openMap(): void {
    const { ctx } = this;
    if (this.mapOpen || !this.map) return;
    const st = ctx.game.state;
    if (st !== 'driving' && st !== 'paused') return;
    this.pausedByMap = st === 'driving';
    if (this.pausedByMap) ctx.game.pause();
    this.mapOpen = true;
    this.refreshPois();
    this.ensureGraph();
    this.updateCard();
    this.map.open();
  }

  /** Contract close (Game calls it on resume / menus): hide only, no state change. */
  closeMap(): void {
    if (!this.mapOpen) return;
    this.mapOpen = false;
    this.pausedByMap = false;
    this.map?.close();
    this.updateCard();
  }

  /** User closed the map (back button / Esc / N): return to where it was opened from. */
  dismissMap(): void {
    if (!this.mapOpen) return;
    const resume = this.pausedByMap;
    this.closeMap();
    if (resume && this.ctx.game.state === 'paused') this.ctx.game.resume();
  }

  /** Directions chosen on the map: set the route and get back to driving. */
  directionsFromMap(poiId: string): void {
    this.setDestination(poiId);
    this.closeMap();
    if (this.ctx.game.state === 'paused') this.ctx.game.resume();
  }

  dispose(): void {
    this.ribbon?.dispose();
    this.card?.el.remove();
    this.map?.dispose();
  }
}
