import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, lerp } from '../core/math';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { GameContext } from '../game/contracts';
import type { BuildingLot, CityData, RoadEdge, RoadKind } from '../world/types';
import { CamPose, easeInOutSine, smooth01 } from './camMath';

/**
 * Title / main-menu background: a slow cinematic tour of the city. Shots are generated from `ctx.world.data`
 * (aerial establishing shot, downtown towers from the street, the beach at a golden angle, the skyline from the
 * water, the park crane, the jump ramp / highway, a low glide down a boulevard, the garage hub), validated against
 * the building footprints so no move clips through a tower, and joined by soft dips to dark through a DOM overlay.
 * Rebuilt every cycle with different subjects, so it stays fresh and works whatever the world generator produces.
 */

type V = THREE.Vector3;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

interface ShotBase {
  name: string;
  dur: number;
  fov0: number;
  fov1: number;
  roll: number;
  t0: V;
  t1: V;
}
interface DollyShot extends ShotBase {
  kind: 'dolly';
  p0: V;
  p1: V;
}
interface OrbitShot extends ShotBase {
  kind: 'orbit';
  c: V;
  r0: number;
  r1: number;
  a0: number;
  a1: number;
  h0: number;
  h1: number;
}
interface TrackShot extends ShotBase {
  kind: 'track';
  pts: V[];
  cum: number[];
  s0: number;
  s1: number;
  ahead: number;
  height: number;
  lateral: number;
  lookUp: number;
}
type Shot = DollyShot | OrbitShot | TrackShot;

// ───────────────────────────── building footprint index ─────────────────────────────
class BuildingIndex {
  private grid = new Map<number, BuildingLot[]>();
  readonly maxH: number;
  private readonly cell = 40;

  constructor(readonly list: BuildingLot[]) {
    let maxH = 0;
    for (const b of list) {
      if (!b || !(b.w > 0) || !(b.d > 0)) continue;
      maxH = Math.max(maxH, b.y + b.h);
      const r = 0.5 * Math.hypot(b.w, b.d);
      const x0 = Math.floor((b.x - r) / this.cell);
      const x1 = Math.floor((b.x + r) / this.cell);
      const z0 = Math.floor((b.z - r) / this.cell);
      const z1 = Math.floor((b.z + r) / this.cell);
      for (let ix = x0; ix <= x1; ix++)
        for (let iz = z0; iz <= z1; iz++) {
          const k = this.key(ix, iz);
          let arr = this.grid.get(k);
          if (!arr) this.grid.set(k, (arr = []));
          arr.push(b);
        }
    }
    this.maxH = maxH;
  }

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  blocked(x: number, y: number, z: number, margin: number, ignore: BuildingLot | null = null): boolean {
    const arr = this.grid.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    if (!arr) return false;
    for (const b of arr) {
      if (b === ignore) continue;
      if (y > b.y + b.h + margin || y < b.y - 4) continue;
      const dx = x - b.x;
      const dz = z - b.z;
      const cs = Math.cos(b.yaw || 0);
      const sn = Math.sin(b.yaw || 0);
      const lx = dx * cs - dz * sn;
      const lz = dx * sn + dz * cs;
      if (Math.abs(lx) < b.w / 2 + margin && Math.abs(lz) < b.d / 2 + margin) return true;
    }
    return false;
  }

  /** Line of sight a→b (the last `endSkip` fraction is not tested: the target may sit on a facade). */
  segmentClear(a: V, b: V, margin: number, ignore: BuildingLot | null, endSkip = 0.06): boolean {
    const len = a.distanceTo(b);
    const n = Math.max(2, Math.ceil(len / 2.5));
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (t > 1 - endSkip) break;
      if (this.blocked(lerp(a.x, b.x, t), lerp(a.y, b.y, t), lerp(a.z, b.z, t), margin, ignore)) return false;
    }
    return true;
  }
}

// ───────────────────────────── showcase ─────────────────────────────
export class Showcase {
  readonly pose = new CamPose();
  private shots: Shot[] = [];
  private idx = 0;
  private t = 0;
  private cycle = 0;
  private hold = 0;
  private fadeIn = 0;
  private overlay: HTMLDivElement | null = null;
  private shown = -1;
  private index: BuildingIndex | null = null;
  private readonly target = v3();
  private readonly tmp = v3();
  private everStarted = false;
  active = false;

  constructor(private readonly ctx: GameContext) {}

  init(): void {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'camera-fade';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;background:#0b1220;opacity:0;display:none;will-change:opacity';
    document.body.appendChild(el);
    this.overlay = el;
  }

  start(): void {
    const fade = this.everStarted;
    this.everStarted = true;
    this.active = true;
    this.shots = this.buildShots();
    this.idx = 0;
    this.t = 0;
    this.hold = fade ? 0.12 : 0;
    this.fadeIn = fade ? 1.1 : 0;
    this.setOpacity(fade ? 1 : 0);
    if (this.shots.length) this.evalShot(this.shots[0], 0);
  }

  stop(): void {
    this.active = false;
    this.setOpacity(0);
  }

  private waitReady = 0;

  private streamReady(): boolean {
    const p = this.pose.pos;
    try {
      return this.ctx.terrain?.isReady?.(p.x, p.z, 120) ?? true;
    } catch {
      return true;
    }
  }

  update(dt: number): void {
    const c = CONFIG.camera;
    if (!this.shots.length) {
      this.shots = this.buildShots();
      this.idx = 0;
      this.t = 0;
      if (!this.shots.length) return;
    }
    let shot = this.shots[this.idx];
    if (this.hold > 0) {
      // Held dark at a cut; far-away shots (airport…) also wait for streaming around the new spot (max ~2.5 s).
      this.hold -= dt;
      this.waitReady -= dt;
      this.setOpacity(1);
      this.evalShot(shot, 0);
      if (this.hold <= 0 && this.waitReady > 0 && !this.streamReady()) this.hold = 0.05;
      return;
    }
    this.t += dt;
    if (this.t >= shot.dur) {
      this.idx++;
      if (this.idx >= this.shots.length) {
        this.cycle++;
        this.shots = this.buildShots();
        this.idx = 0;
        if (!this.shots.length) return;
      }
      shot = this.shots[this.idx];
      this.t = 0;
      this.hold = c.showcaseHold;
      this.waitReady = 2.5;
      this.fadeIn = c.showcaseFadeIn;
      this.setOpacity(1);
      this.evalShot(shot, 0);
      return;
    }
    const fin = this.fadeIn > 0 ? smooth01(this.t / this.fadeIn) : 1;
    const fout = smooth01((shot.dur - this.t) / Math.max(0.05, c.showcaseFadeOut));
    this.setOpacity(1 - Math.min(fin, fout));
    this.evalShot(shot, this.t / shot.dur);
  }

  /** Floating origin: the world (and CityData, in place) moved by -(dx, 0, dz). */
  shift(dx: number, dz: number): void {
    const sh = (v: V) => {
      v.x -= dx;
      v.z -= dz;
    };
    for (const s of this.shots) {
      sh(s.t0);
      sh(s.t1);
      if (s.kind === 'dolly') {
        sh(s.p0);
        sh(s.p1);
      } else if (s.kind === 'orbit') sh(s.c);
      else s.pts.forEach(sh);
    }
    sh(this.pose.pos);
    sh(this.target);
    this.index = null; // building positions changed in place → re-bucket on next build
  }

  /** Names of the current shot list (debug / smoke tests). */
  get shotNames(): string[] {
    return this.shots.map((s) => s.name);
  }
  get currentShot(): string {
    return this.shots[this.idx]?.name ?? '';
  }

  /** Jump to a shot by name or index (debug / smoke tests). */
  jump(which: string | number, u = 0.5): void {
    if (!this.shots.length) this.shots = this.buildShots();
    const i = typeof which === 'number' ? which : this.shots.findIndex((s) => s.name === which);
    if (i < 0 || i >= this.shots.length) return;
    this.idx = i;
    this.t = this.shots[i].dur * clamp(u, 0, 0.99);
    this.hold = 0;
    this.fadeIn = 0;
    this.setOpacity(0);
    this.evalShot(this.shots[i], u);
  }

  private setOpacity(o: number): void {
    const el = this.overlay;
    if (!el) return;
    const q = Math.round(clamp(o, 0, 1) * 100) / 100;
    if (q === this.shown) return;
    this.shown = q;
    el.style.opacity = String(q);
    el.style.display = q <= 0 ? 'none' : 'block';
  }

  // ───────────────────────────── evaluation ─────────────────────────────
  private evalShot(s: Shot, u: number): void {
    const m = 0.4 * u + 0.6 * easeInOutSine(u);
    const p = this.pose.pos;
    const tg = this.target;
    if (s.kind === 'dolly') {
      p.lerpVectors(s.p0, s.p1, m);
      tg.lerpVectors(s.t0, s.t1, m);
    } else if (s.kind === 'orbit') {
      const a = lerp(s.a0, s.a1, m);
      const r = lerp(s.r0, s.r1, m);
      p.set(s.c.x + Math.sin(a) * r, s.c.y + lerp(s.h0, s.h1, m), s.c.z + Math.cos(a) * r);
      tg.lerpVectors(s.t0, s.t1, m);
    } else {
      const sAt = lerp(s.s0, s.s1, m);
      this.pointAt(s, sAt, p, this.tmp);
      // lateral offset (right of travel) + height
      p.x += -this.tmp.z * s.lateral;
      p.z += this.tmp.x * s.lateral;
      p.y += s.height;
      this.pointAt(s, sAt + s.ahead, tg, this.tmp);
      tg.x += -this.tmp.z * s.lateral * 0.5;
      tg.z += this.tmp.x * s.lateral * 0.5;
      tg.y += s.lookUp;
    }
    this.clampUp(p, 1.0);
    this.pose.lookAt(tg, s.roll);
    this.pose.fov = lerp(s.fov0, s.fov1, m);
  }

  /** Point at arc length `sAt` along a track (and the unit tangent in `tan`, horizontal). */
  private pointAt(s: TrackShot, sAt: number, out: V, tan: V): void {
    const { pts, cum } = s;
    const total = cum[cum.length - 1];
    const d = clamp(sAt, 0, total);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.max(1e-6, cum[i] - cum[i - 1]);
    const t = clamp((d - cum[i - 1]) / segLen, 0, 1);
    out.lerpVectors(a, b, t);
    tan.set(b.x - a.x, 0, b.z - a.z);
    const l = tan.length();
    if (l > 1e-6) tan.divideScalar(l);
    else tan.set(0, 0, 1);
  }

  // ───────────────────────────── shot generation ─────────────────────────────
  private ground(x: number, z: number): number {
    try {
      const g = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(g) ? g : 0;
    } catch {
      return 0;
    }
  }

  private clampUp(p: V, clr: number): void {
    const floor = Math.max(this.ground(p.x, p.z), CONFIG.world.waterLevel) + clr;
    if (p.y < floor) p.y = floor;
  }

  private free(p: V, margin = 2, ignore: BuildingLot | null = null): boolean {
    return !this.index || !this.index.blocked(p.x, p.y, p.z, margin, ignore);
  }

  private los(a: V, b: V, ignore: BuildingLot | null = null): boolean {
    return !this.index || this.index.segmentClear(a, b, 0.5, ignore);
  }

  private buildShots(): Shot[] {
    const data = this.ctx.world?.data;
    if (!data) return [this.genericOrbit(null, 0)];
    if (!this.index || this.index.list !== data.buildings) this.index = new BuildingIndex(data.buildings ?? []);
    const cyc = this.cycle;
    const out: Shot[] = [];
    const tryAdd = (fn: () => Shot | null) => {
      try {
        const s = fn();
        if (s) out.push(s);
      } catch {
        /* skip a shot the data can't support */
      }
    };
    tryAdd(() => this.shotAerial(data, cyc));
    tryAdd(() => this.shotBeach(data, cyc));
    tryAdd(() => this.shotDowntown(data, cyc));
    tryAdd(() => this.shotPark(data, cyc));
    if (cyc % 2 === 0) tryAdd(() => this.shotRamp(data, cyc) ?? this.shotHighway(data, cyc));
    else tryAdd(() => this.shotHighway(data, cyc) ?? this.shotRamp(data, cyc));
    tryAdd(() => this.shotStreet(data, cyc));
    tryAdd(() => this.shotAirport(data, cyc));
    tryAdd(() => this.shotSkyline(data, cyc));
    tryAdd(() => this.shotHub(data, cyc));
    let k = 0;
    while (out.length < 4 && k < 3) out.push(this.genericOrbit(data, cyc + k++));
    return out;
  }

  private dur(extra = 0): number {
    return Math.max(3, CONFIG.camera.showcaseShot + extra);
  }

  private shotAerial(d: CityData, cyc: number): Shot {
    let cx = 0;
    let cz = 0;
    let w = 0;
    for (const b of d.buildings ?? []) {
      if (b.district !== 'downtown') continue;
      cx += b.x * b.h;
      cz += b.z * b.h;
      w += b.h;
    }
    if (w > 0) {
      cx /= w;
      cz /= w;
    }
    const size = d.size || 800;
    const center = v3(cx * 0.6, 0, cz * 0.6 + size * 0.04);
    center.y = this.ground(center.x, center.z);
    const H = Math.max(105, (this.index?.maxH ?? 40) + 45);
    const R = size * 0.42;
    const a0 = Math.PI + [-0.42, 0.28, -0.08][cyc % 3];
    const sweep = 0.36 * (cyc % 2 ? -1 : 1);
    const look = v3(center.x, center.y, center.z + size * 0.12);
    return {
      kind: 'orbit', name: 'aerial', dur: this.dur(1.5), fov0: 48, fov1: 44, roll: 0,
      c: center, r0: R, r1: R * 0.88, a0, a1: a0 + sweep, h0: H, h1: H * 0.86,
      t0: look, t1: v3(look.x, look.y, look.z - size * 0.02),
    };
  }

  private sunSide(cyc: number): number {
    const sun = GLOBAL_UNIFORMS.uSunDir.value;
    let dir = sun.x >= 0 ? 1 : -1;
    if (cyc % 2) dir = -dir;
    return dir;
  }

  private shotBeach(d: CityData, cyc: number): Shot | null {
    const coast = d.coast;
    if (!coast || !(coast.shoreZ > coast.seaWallZ)) return null;
    const size = d.size || 800;
    const dirX = this.sunSide(cyc);
    const zc = lerp(coast.seaWallZ, coast.shoreZ, 0.97);
    for (let k = 0; k < 4; k++) {
      const x0 = [-0.3, 0.12, -0.05, 0.33][(cyc + k) % 4] * size;
      const p0 = v3(x0, 0, zc);
      p0.y = this.ground(p0.x, p0.z) + 1.6;
      const p1 = v3(x0 + dirX * 34, 0, zc + 2);
      p1.y = this.ground(p1.x, p1.z) + 2.8;
      if (!this.free(p0) || !this.free(p1)) continue;
      // Look along the shoreline, slightly out to sea and toward the sun's side: glitter on the water.
      const look = v3(dirX, 0, 0.75).normalize().multiplyScalar(45);
      const wl = CONFIG.world.waterLevel;
      return {
        kind: 'dolly', name: 'beach', dur: this.dur(), fov0: 54, fov1: 50, roll: 0,
        p0, p1, t0: v3(p0.x + look.x, wl + 1.2, p0.z + look.z), t1: v3(p1.x + look.x, wl + 1.4, p1.z + look.z),
      };
    }
    return null;
  }

  private shotSkyline(d: CityData, cyc: number): Shot | null {
    const coast = d.coast;
    if (!coast || !(coast.shoreZ > coast.seaWallZ)) return null;
    const size = d.size || 800;
    const dirX = -this.sunSide(cyc);
    const wl = CONFIG.world.waterLevel;
    const x0 = [0.05, -0.22, 0.25][cyc % 3] * size;
    const z = coast.shoreZ + 48;
    const tallest = (this.index?.maxH ?? 30) * 0.35;
    return {
      kind: 'dolly', name: 'skyline', dur: this.dur(), fov0: 50, fov1: 45, roll: 0,
      p0: v3(x0, wl + 4.5, z), p1: v3(x0 + dirX * 30, wl + 8, z - 6),
      t0: v3(x0 + dirX * 8, 12 + tallest, coast.seaWallZ - 130), t1: v3(x0 + dirX * 36, 16 + tallest, coast.seaWallZ - 130),
    };
  }

  private shotDowntown(d: CityData, cyc: number): Shot | null {
    const all = d.buildings ?? [];
    let towers = all.filter((b) => b.district === 'downtown');
    if (!towers.length) towers = all.slice();
    towers = towers.sort((a, b) => b.h - a.h).slice(0, 6).filter((b) => b.h > 22);
    if (!towers.length) return null;
    const nodes = d.roads?.nodes ?? [];
    for (let k = 0; k < towers.length; k++) {
      const b = towers[(cyc + k) % towers.length];
      const halfDiag = 0.5 * Math.hypot(b.w, b.d);
      const cands: V[] = [];
      for (const n of nodes) {
        const dist = Math.hypot(n.p.x - b.x, n.p.z - b.z);
        if (dist > halfDiag + 6 && dist < halfDiag + 55) cands.push(v3(n.p.x, n.p.y, n.p.z));
      }
      cands.sort((p, q) => Math.hypot(p.x - b.x, p.z - b.z) - Math.hypot(q.x - b.x, q.z - b.z));
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + cyc * 0.7;
        const r = halfDiag + 14;
        cands.push(v3(b.x + Math.sin(a) * r, 0, b.z + Math.cos(a) * r));
      }
      const top = v3(b.x, b.y + b.h * 0.92, b.z);
      for (const p of cands) {
        p.y = this.ground(p.x, p.z) + 1.6;
        if (!this.free(p, 1.5) || !this.los(p, top, b)) continue;
        const to = v3(b.x - p.x, 0, b.z - p.z).normalize();
        const side = cyc % 2 ? 1 : -1;
        const p1 = p.clone().addScaledVector(v3(to.z, 0, -to.x), 6 * side).addScaledVector(to, -2);
        p1.y = p.y + 9;
        if (!this.free(p1, 1.5) || !this.los(p1, top, b)) continue;
        return {
          kind: 'dolly', name: 'downtown', dur: this.dur(), fov0: 66, fov1: 60, roll: 0.02 * side,
          p0: p, p1, t0: v3(b.x, b.y + b.h * 0.5, b.z), t1: v3(b.x, b.y + b.h * 1.0, b.z),
        };
      }
    }
    return null;
  }

  private parkArea(d: CityData): { cx: number; cz: number; hw: number; hd: number } | null {
    let best: { cx: number; cz: number; hw: number; hd: number } | null = null;
    let bestA = 0;
    for (const a of d.wanderAreas ?? []) {
      if (a.kind !== 'park') continue;
      const area = (a.maxX - a.minX) * (a.maxZ - a.minZ);
      if (area > bestA) {
        bestA = area;
        best = { cx: (a.minX + a.maxX) / 2, cz: (a.minZ + a.maxZ) / 2, hw: (a.maxX - a.minX) / 2, hd: (a.maxZ - a.minZ) / 2 };
      }
    }
    if (best) return best;
    const n = d.districtGridSize;
    const grid = d.districtGrid;
    if (!n || !grid || grid.length < n * n) return null;
    const cell = (d.size || 800) / n;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let iz = 0; iz < n; iz++)
      for (let ix = 0; ix < n; ix++) {
        if (grid[iz * n + ix] !== 'park') continue;
        const x = -d.size / 2 + (ix + 0.5) * cell;
        const z = -d.size / 2 + (iz + 0.5) * cell;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    if (!Number.isFinite(x0)) return null;
    return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hw: (x1 - x0) / 2 + cell / 2, hd: (z1 - z0) / 2 + cell / 2 };
  }

  private shotPark(d: CityData, cyc: number): Shot | null {
    const area = this.parkArea(d);
    if (!area) return null;
    const y = this.ground(area.cx, area.cz);
    const R = Math.min(140, Math.max(area.hw, area.hd) * 0.85 + 12);
    const c = v3(area.cx, y, area.cz);
    const sweep = 0.5 * (cyc % 2 ? 1 : -1);
    for (let k = 0; k < 6; k++) {
      const a0 = cyc * 1.7 + k * 1.05;
      let ok = true;
      for (let j = 0; j <= 4 && ok; j++) {
        const t = j / 4;
        const a = a0 + sweep * t;
        const r = lerp(R * 1.1, R * 0.9, t);
        const p = v3(c.x + Math.sin(a) * r, y + lerp(7, 26, t), c.z + Math.cos(a) * r);
        if (!this.free(p, 3)) ok = false;
      }
      if (!ok) continue;
      return {
        kind: 'orbit', name: 'park', dur: this.dur(), fov0: 56, fov1: 52, roll: 0,
        c, r0: R * 1.1, r1: R * 0.9, a0, a1: a0 + sweep, h0: 7, h1: 26,
        t0: v3(c.x, y + 2, c.z), t1: v3(c.x, y + 1, c.z),
      };
    }
    return null;
  }

  private shotRamp(d: CityData, cyc: number): Shot | null {
    const rp = d.jumpRamp;
    if (!rp) return null;
    const P0 = v3(rp.position.x, rp.position.y, rp.position.z);
    const f = v3(Math.sin(rp.yaw), 0, Math.cos(rp.yaw));
    const r = v3(-Math.cos(rp.yaw), 0, Math.sin(rp.yaw));
    // The pose is the run-up start; find the lip (highest ground ahead along the ramp direction).
    let lipD = 0;
    let lipH = 0;
    for (let dd = 0; dd <= 180; dd += 2) {
      const h = this.ground(P0.x + f.x * dd, P0.z + f.z * dd) - P0.y;
      if (h > lipH) {
        lipH = h;
        lipD = dd;
      }
    }
    if (lipH < 1.5) lipD = 0;
    const P = P0.clone().addScaledVector(f, lipD);
    const base = P0.y;
    const s0 = cyc % 2 ? 1 : -1;
    for (const side of [s0, -s0]) {
      const p0 = P.clone().addScaledVector(r, 22 * side).addScaledVector(f, -20);
      p0.y = Math.max(this.ground(p0.x, p0.z), base) + 1.2;
      const p1 = P.clone().addScaledVector(r, 15 * side).addScaledVector(f, -6);
      p1.y = Math.max(this.ground(p1.x, p1.z), base) + 2.0;
      const t0 = P.clone().addScaledVector(f, -2);
      t0.y = base + Math.max(2.5, lipH * 0.7);
      const t1 = P.clone().addScaledVector(f, 12);
      t1.y = base + Math.max(5, lipH * 1.1);
      if (!this.free(p0) || !this.free(p1) || !this.los(p0, t0)) continue;
      return { kind: 'dolly', name: 'ramp', dur: this.dur(), fov0: 60, fov1: 50, roll: -0.03 * side, p0, p1, t0, t1 };
    }
    return null;
  }

  /** Follow connected road edges of the given kinds (straightest continuation) into one long polyline. */
  private chain(d: CityData, start: RoadEdge, kinds: Set<RoadKind>, maxLen: number): V[] {
    const nodes = new Map(d.roads.nodes.map((n) => [n.id, n] as const));
    const edges = new Map(d.roads.edges.map((e) => [e.id, e] as const));
    const pts = start.points.map((p) => v3(p.x, p.y, p.z));
    const visited = new Set<number>([start.id]);
    let cur = start.b;
    let len = polyLen(pts);
    for (let guard = 0; guard < 40 && len < maxLen; guard++) {
      const node = nodes.get(cur);
      if (!node || pts.length < 2) break;
      const a = pts[pts.length - 2];
      const b = pts[pts.length - 1];
      const din = v3(b.x - a.x, 0, b.z - a.z).normalize();
      let best: RoadEdge | null = null;
      let bestDot = 0.6;
      let bestFwd = true;
      for (const id of node.edges) {
        const e = edges.get(id);
        if (!e || visited.has(e.id) || !kinds.has(e.kind) || e.points.length < 2) continue;
        const fwd = e.a === cur;
        const q0 = fwd ? e.points[0] : e.points[e.points.length - 1];
        const q1 = fwd ? e.points[1] : e.points[e.points.length - 2];
        const dout = v3(q1.x - q0.x, 0, q1.z - q0.z).normalize();
        const dot = din.dot(dout);
        if (dot > bestDot) {
          bestDot = dot;
          best = e;
          bestFwd = fwd;
        }
      }
      if (!best) break;
      visited.add(best.id);
      const seq = bestFwd ? best.points : best.points.slice().reverse();
      for (let i = 1; i < seq.length; i++) pts.push(v3(seq[i].x, seq[i].y, seq[i].z));
      cur = bestFwd ? best.b : best.a;
      len = polyLen(pts);
    }
    return pts;
  }

  private trackShot(name: string, pts: V[], speed: number, height: number, lateral: number, ahead: number, lookUp: number, fov0: number, fov1: number): TrackShot | null {
    if (pts.length < 2) return null;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    const total = cum[cum.length - 1];
    const dur = this.dur();
    const usable = total - ahead - 4;
    if (usable < 40) return null;
    const travel = Math.min(usable, speed * dur);
    const s0 = (usable - travel) * 0.5;
    const shot: TrackShot = { kind: 'track', name, dur, fov0, fov1, roll: 0, t0: v3(), t1: v3(), pts, cum, s0, s1: s0 + travel, ahead, height, lateral, lookUp };
    // Validate a few samples against buildings (a glide must never pass through a tower).
    const p = v3();
    const tan = v3();
    for (let i = 0; i <= 6; i++) {
      this.pointAt(shot, lerp(shot.s0, shot.s1, i / 6), p, tan);
      p.x += -tan.z * lateral;
      p.z += tan.x * lateral;
      p.y += height;
      if (!this.free(p, 1)) return null;
    }
    return shot;
  }

  private shotHighway(d: CityData, cyc: number): Shot | null {
    const kinds = new Set<RoadKind>(['highway']);
    const cands = (d.roads?.edges ?? []).filter((e) => kinds.has(e.kind) && e.points.length >= 2);
    if (!cands.length) return null;
    for (let k = 0; k < Math.min(6, cands.length); k++) {
      const e = cands[(cyc * 7 + k * 3) % cands.length];
      const pts = this.chain(d, e, kinds, 320);
      const s = this.trackShot('highway', pts, 15, 9, 9 * (cyc % 2 ? 1 : -1), 40, 0, 55, 52);
      if (s) return s;
    }
    return null;
  }

  private shotStreet(d: CityData, cyc: number): Shot | null {
    const kinds = new Set<RoadKind>(['boulevard', 'street4']);
    const edges = (d.roads?.edges ?? []).filter((e) => {
      if (!kinds.has(e.kind) || e.points.length < 2) return false;
      const m = e.points[Math.floor(e.points.length / 2)];
      try {
        return this.ctx.world.districtAt(m.x, m.z) === 'downtown';
      } catch {
        return false;
      }
    });
    const pool = edges.length ? edges : (d.roads?.edges ?? []).filter((e) => kinds.has(e.kind) && e.points.length >= 2);
    if (!pool.length) return null;
    for (let k = 0; k < Math.min(6, pool.length); k++) {
      const e = pool[(cyc * 5 + k * 2) % pool.length];
      const pts = this.chain(d, e, kinds, 220);
      const s = this.trackShot('street', pts, 9, 3.2, e.width * 0.22, 22, 5, 62, 58);
      if (s) return s;
    }
    return null;
  }

  private shotHub(d: CityData, cyc: number): Shot | null {
    const gp = d.garage?.position ?? d.spawn?.position;
    if (!gp) return null;
    const yaw = d.garage?.yaw ?? d.spawn?.yaw ?? 0;
    const g = v3(gp.x, gp.y, gp.z);
    const sp = d.spawn ? v3(d.spawn.position.x, d.spawn.position.y, d.spawn.position.z) : g.clone();
    const f = v3(Math.sin(yaw), 0, Math.cos(yaw));
    const r = v3(-Math.cos(yaw), 0, Math.sin(yaw));
    const s0 = cyc % 2 ? 1 : -1;
    for (const side of [s0, -s0]) {
      // Wide establishing crane over the lot: the garage and the parking hub both in frame.
      const p0 = g.clone().addScaledVector(f, 40).addScaledVector(r, 24 * side);
      p0.y = this.ground(p0.x, p0.z) + 5;
      const p1 = g.clone().addScaledVector(f, 34).addScaledVector(r, 6 * side);
      p1.y = this.ground(p1.x, p1.z) + 11;
      if (!this.free(p0, 1.5) || !this.free(p1, 1.5)) continue;
      const t0 = g.clone().addScaledVector(f, 4);
      t0.y = g.y + 4;
      const t1 = g.clone().lerp(sp, 0.4);
      t1.y = Math.max(g.y, sp.y) + 3;
      return { kind: 'dolly', name: 'hub', dur: this.dur(), fov0: 52, fov1: 48, roll: 0, p0, p1, t0, t1 };
    }
    return null;
  }

  /**
   * Part 2 airport: alternate between a low glide along the main runway (planes on the apron in the background)
   * and a slow crane over the stands looking at the parked planes.
   */
  private shotAirport(d: CityData, cyc: number): Shot | null {
    const ap = d.airport;
    if (!ap) return null;
    const elev = Number.isFinite(ap.elevation) ? ap.elevation : 0;
    const rw = ap.runways?.[0];
    if (rw && cyc % 2 === 0) {
      const a = v3(rw.a.x, rw.a.y, rw.a.z);
      const b = v3(rw.b.x, rw.b.y, rw.b.z);
      const len = a.distanceTo(b);
      if (len > 200) {
        const dir = b.clone().sub(a).setY(0).normalize();
        const side = v3(dir.z, 0, -dir.x);
        // Edge of the runway on the apron side (side closest to the stands).
        const st = ap.stands?.[0]?.p;
        const s = st && side.dot(v3(st.x - a.x, 0, st.z - a.z)) < 0 ? -1 : 1;
        const off = (rw.width || 45) * 0.5 + 6;
        const p0 = a.clone().addScaledVector(dir, len * 0.3).addScaledVector(side, off * s);
        p0.y = elev + 2.2;
        const p1 = p0.clone().addScaledVector(dir, 120);
        p1.y = elev + 4.5;
        const t0 = p0.clone().addScaledVector(dir, 160).addScaledVector(side, off * s * 2.5);
        t0.y = elev + 4;
        const t1 = p1.clone().addScaledVector(dir, 160).addScaledVector(side, off * s * 2.5);
        t1.y = elev + 5;
        return { kind: 'dolly', name: 'airport-runway', dur: this.dur(), fov0: 52, fov1: 48, roll: 0, p0, p1, t0, t1 };
      }
    }
    const stands = ap.stands ?? [];
    if (!stands.length) return null;
    let cx = 0;
    let cz = 0;
    for (const s of stands) {
      cx += s.p.x;
      cz += s.p.z;
    }
    cx /= stands.length;
    cz /= stands.length;
    let r = 40;
    for (const s of stands) r = Math.max(r, Math.hypot(s.p.x - cx, s.p.z - cz) + 45);
    // Swing in from the airside (away from the terminal) so the planes face the lens.
    const t = ap.terminal;
    const away = t ? Math.atan2(cx - t.x, cz - t.z) : cyc * 1.3;
    const a0 = away - 0.35;
    return {
      kind: 'orbit', name: 'airport-apron', dur: this.dur(1), fov0: 54, fov1: 50, roll: 0,
      c: v3(cx, elev, cz), r0: r, r1: r * 0.85, a0, a1: a0 + 0.7, h0: 9, h1: 26,
      t0: v3(cx, elev + 6, cz), t1: v3(cx, elev + 3, cz),
    };
  }

  private genericOrbit(d: CityData | null, cyc: number): Shot {
    const spawn = d?.spawn?.position;
    if (cyc % 2 === 1 && spawn) {
      const c = v3(spawn.x, spawn.y, spawn.z);
      const a0 = cyc * 2.1;
      return {
        kind: 'orbit', name: 'spawn-orbit', dur: this.dur(), fov0: 55, fov1: 52, roll: 0,
        c, r0: 26, r1: 20, a0, a1: a0 + 0.7, h0: 6, h1: 10, t0: v3(c.x, c.y + 1.5, c.z), t1: v3(c.x, c.y + 1.5, c.z),
      };
    }
    const H = Math.max(60, (this.index?.maxH ?? 40) + 20);
    const a0 = cyc * 2.1 + 0.5;
    return {
      kind: 'orbit', name: 'city-orbit', dur: this.dur(), fov0: 52, fov1: 50, roll: 0,
      c: v3(), r0: 150, r1: 135, a0, a1: a0 + 0.5, h0: H + 10, h1: H, t0: v3(0, 5, 0), t1: v3(0, 5, 0),
    };
  }
}

function polyLen(pts: V[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += pts[i].distanceTo(pts[i - 1]);
  return l;
}
