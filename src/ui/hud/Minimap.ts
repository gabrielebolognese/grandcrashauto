import { CONFIG } from '../../config';
import { clamp, damp } from '../../core/math';
import type { GameContext } from '../../game/contracts';
import type { CityData, DistrictId, RoadEdge, RoadKind } from '../../world/types';
import { h } from '../dom';
import { icon } from '../icons';
import { uiSound } from '../widgets';

const DISTRICT_TINT: Record<DistrictId, string> = {
  downtown: '#ece3ee',
  residential: '#f6ead6',
  beach: '#f7e4b8',
  park: '#c4e6b3',
  hub: '#ebe5da',
  highway: '#f1eadc',
  water: '#8fd0ec',
};
const BUILDING_TINT: Record<DistrictId, string> = {
  downtown: '#c9bcd8',
  residential: '#e8c9b4',
  beach: '#f0c9a6',
  park: '#a9cf9a',
  hub: '#d3c8bb',
  highway: '#d8cbbb',
  water: '#7cc0dc',
};
const ROAD_FILL: Record<RoadKind, string> = {
  street2: '#6a7088',
  street4: '#5f6680',
  boulevard: '#5a6280',
  highway: '#f4a26b',
  ramp: '#f4a26b',
  lot: '#8a8fa3',
};
const ROAD_ORDER: RoadKind[] = ['lot', 'street2', 'street4', 'boulevard', 'ramp', 'highway'];
const LAND = '#e9e0cc';
const SEA = '#5bb9d6';

interface Layer {
  canvas: HTMLCanvasElement;
  minX: number; // absolute metres covered
  minZ: number;
  w: number;
  h: number;
}
interface PolyCache {
  pts: Float32Array; // absolute x,z pairs
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Rotating canvas minimap (spec §13, part 2 §3/§9, part 3 floating origin). Everything is drawn in ABSOLUTE
 * coordinates (absolute = local + ctx.origin.offset): the city (districts, water, parks, buildings, roads) is
 * pre-rendered into a hi-res offscreen layer, the wider region (airport, outlying roads) into a low-res one; both are
 * rebuilt only when the data changes. Each frame blits them rotated around the heading and adds the coast/sea,
 * the ocean out-of-map boundary, the highway network, the nav route, markers and the player icon.
 */
export class Minimap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private north: HTMLDivElement;
  private city: Layer | null = null;
  private region: Layer | null = null;
  private sig = '';
  private checkT = 0;
  private radius = CONFIG.ui.minimap.radiusMin;
  private cssSize = 0;
  private dpr = 1;
  private big = false;
  private hwVersion = -1;
  private hw: PolyCache[] = [];
  private routeRef: unknown = null;
  private routeLen = -1;
  private route: Float32Array | null = null;
  private blink = 0;

  constructor(private ctx: GameContext) {
    this.canvas = h('canvas', { class: 'mm-canvas', 'aria-hidden': 'true' });
    this.g = this.canvas.getContext('2d', { alpha: true })!;
    this.north = h('div', { class: 'mm-north' }, h('span', { text: 'N' }));
    const mapBtn = h('button', { class: 'mm-mapbtn touch-ctl', type: 'button', 'aria-label': 'Open map', title: 'Map (N)' }, icon('map'), h('span', { text: 'MAP' }));
    mapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      uiSound('click');
      this.ctx.nav?.openMap?.();
    });
    this.el = h('div', { class: 'minimap', role: 'img', 'aria-label': 'Minimap' }, this.canvas, h('div', { class: 'mm-ring' }), this.north, mapBtn);
    this.el.addEventListener('click', () => {
      this.big = !this.big;
      this.el.classList.toggle('big', this.big);
      this.cssSize = 0;
    });
  }

  private get ox(): number {
    return this.ctx.origin?.offset.x ?? 0;
  }
  private get oz(): number {
    return this.ctx.origin?.offset.z ?? 0;
  }

  /** Signature of the world data; when it changes the offscreen layers are rebuilt. */
  private signature(d: CityData): string {
    return `${d.seed}|${d.size}|${d.roads?.edges?.length ?? 0}|${d.roads?.nodes?.length ?? 0}|${d.buildings?.length ?? 0}|${d.wanderAreas?.length ?? 0}|${d.districtGrid?.length ?? 0}|${d.airport?.runways?.length ?? 0}|${this.ctx.quality.level === 'low'}`;
  }

  private rebuild(d: CityData): void {
    const ox = this.ox;
    const oz = this.oz;
    const size = d.size || CONFIG.world.size;
    const half = size / 2;
    // City layer: the city square in absolute coordinates (its local centre is −offset after origin shifts).
    const ppm = this.ctx.quality.level === 'low' ? Math.min(1, CONFIG.ui.minimap.pxPerMeter) : CONFIG.ui.minimap.pxPerMeter;
    const cMinX = -half;
    const cMinZ = -half;
    this.city = this.drawLayer(this.city, cMinX, cMinZ, size, size, ppm, (g) => {
      g.fillStyle = '#efe7d6';
      g.fillRect(cMinX, cMinZ, size, size);
      const n = d.districtGridSize || 0;
      if (n > 0 && d.districtGrid?.length === n * n) {
        const cell = size / n;
        for (let iz = 0; iz < n; iz++)
          for (let ix = 0; ix < n; ix++) {
            g.fillStyle = DISTRICT_TINT[d.districtGrid[iz * n + ix]] ?? '#efe7d6';
            g.fillRect(cMinX + ix * cell - 0.5, cMinZ + iz * cell - 0.5, cell + 1, cell + 1);
          }
      }
      if (d.coast) {
        const wall = d.coast.seaWallZ + oz;
        const shore = d.coast.shoreZ + oz;
        g.fillStyle = '#f7e1ad';
        g.fillRect(cMinX, wall, size, half - wall + 1);
        const sea = g.createLinearGradient(0, shore, 0, half);
        sea.addColorStop(0, '#8fd6ec');
        sea.addColorStop(1, '#5bb9d6');
        g.fillStyle = sea;
        g.fillRect(cMinX, shore, size, half - shore + 1);
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.lineWidth = 2.5;
        g.beginPath();
        g.moveTo(cMinX, shore);
        g.lineTo(half, shore);
        g.stroke();
      }
      this.drawContent(g, d, ox, oz, true);
    });
    // Region layer: everything with data outside the city (airport, link roads), low resolution.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    const grow = (x: number, z: number, pad = 0) => {
      minX = Math.min(minX, x - pad);
      maxX = Math.max(maxX, x + pad);
      minZ = Math.min(minZ, z - pad);
      maxZ = Math.max(maxZ, z + pad);
    };
    for (const e of d.roads?.edges ?? []) for (const p of e.points ?? []) if (Math.abs(p.x + ox) > half || Math.abs(p.z + oz) > half) grow(p.x + ox, p.z + oz, 30);
    const ap = d.airport;
    if (ap) {
      grow(ap.bounds.minX + ox, ap.bounds.minZ + oz, 40);
      grow(ap.bounds.maxX + ox, ap.bounds.maxZ + oz, 40);
    }
    if (minX < maxX) {
      const w = maxX - minX;
      const hh = maxZ - minZ;
      const rp = Math.min(0.6, 2048 / Math.max(w, hh));
      this.region = this.drawLayer(this.region, minX, minZ, w, hh, rp, (g) => {
        if (ap) {
          g.fillStyle = 'rgba(214, 208, 196, 0.95)';
          g.fillRect(ap.bounds.minX + ox, ap.bounds.minZ + oz, ap.bounds.maxX - ap.bounds.minX, ap.bounds.maxZ - ap.bounds.minZ);
          g.lineCap = 'butt';
          for (const r of ap.runways) {
            g.strokeStyle = '#5a6078';
            g.lineWidth = Math.max(r.width, 18);
            g.beginPath();
            g.moveTo(r.a.x + ox, r.a.z + oz);
            g.lineTo(r.b.x + ox, r.b.z + oz);
            g.stroke();
            g.strokeStyle = 'rgba(255,255,255,0.9)';
            g.lineWidth = 3;
            g.setLineDash([24, 18]);
            g.stroke();
            g.setLineDash([]);
          }
        }
        this.drawContent(g, d, ox, oz, false);
      });
    } else {
      this.region = null;
    }
  }

  private drawLayer(prev: Layer | null, minX: number, minZ: number, w: number, hh: number, ppm: number, paint: (g: CanvasRenderingContext2D) => void): Layer {
    const pw = Math.max(32, Math.min(2048, Math.round(w * ppm)));
    const ph = Math.max(32, Math.min(2048, Math.round(hh * ppm)));
    const c = prev?.canvas ?? document.createElement('canvas');
    c.width = pw;
    c.height = ph;
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, pw, ph);
    g.setTransform(pw / w, 0, 0, ph / hh, -minX * (pw / w), -minZ * (ph / hh));
    paint(g);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return { canvas: c, minX, minZ, w, h: hh };
  }

  /** Parks, buildings and roads (absolute coordinates). insideCity: draw only what lies in the city square. */
  private drawContent(g: CanvasRenderingContext2D, d: CityData, ox: number, oz: number, insideCity: boolean): void {
    const half = (d.size || CONFIG.world.size) / 2;
    const inCity = (x: number, z: number) => Math.abs(x) <= half + 40 && Math.abs(z) <= half + 40;
    const want = (x: number, z: number) => (insideCity ? inCity(x, z) : !inCity(x, z));
    if (insideCity) {
      for (const a of d.wanderAreas ?? []) {
        g.fillStyle = a.kind === 'park' ? '#b5dfa2' : a.kind === 'beach' ? '#f6dca4' : '#e9e1d2';
        g.fillRect(a.minX + ox, a.minZ + oz, a.maxX - a.minX, a.maxZ - a.minZ);
      }
    }
    for (const b of d.buildings ?? []) {
      if (!want(b.x + ox, b.z + oz)) continue;
      g.save();
      g.translate(b.x + ox, b.z + oz);
      g.rotate(-b.yaw);
      g.fillStyle = BUILDING_TINT[b.district] ?? '#d6cbbd';
      g.fillRect(-b.w / 2, -b.d / 2, b.w, b.d);
      g.restore();
    }
    const edges = (d.roads?.edges ?? []).filter((e) => e.points && e.points.length >= 2 && e.points.some((p) => want(p.x + ox, p.z + oz)));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const path = (e: RoadEdge) => {
      g.beginPath();
      g.moveTo(e.points[0].x + ox, e.points[0].z + oz);
      for (let i = 1; i < e.points.length; i++) g.lineTo(e.points[i].x + ox, e.points[i].z + oz);
    };
    for (const e of edges) {
      if (e.kind === 'highway' || e.kind === 'ramp') continue;
      g.strokeStyle = '#fbf7ee';
      g.lineWidth = e.width + 2 * (e.sidewalk || 0) + 1;
      path(e);
      g.stroke();
    }
    for (const kind of ROAD_ORDER) {
      const hw = kind === 'highway' || kind === 'ramp';
      if (hw) {
        g.strokeStyle = '#c66f4f';
        for (const e of edges) {
          if (e.kind !== kind) continue;
          g.lineWidth = e.width + 3;
          path(e);
          g.stroke();
        }
      }
      g.strokeStyle = ROAD_FILL[kind];
      for (const e of edges) {
        if (e.kind !== kind) continue;
        g.lineWidth = Math.max(insideCity ? 3 : 8, e.width);
        path(e);
        g.stroke();
      }
    }
  }

  private resize(): void {
    const s = Math.round(this.el.clientWidth) || 120;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (s === this.cssSize && dpr === this.dpr) return;
    this.cssSize = s;
    this.dpr = dpr;
    this.canvas.width = Math.round(s * dpr);
    this.canvas.height = Math.round(s * dpr);
  }

  /** Highway network polylines cached in absolute coordinates (re-read when graphVersion bumps). */
  private refreshHighways(): void {
    const hwys = this.ctx.highways;
    if (!hwys?.graph) return;
    const v = hwys.graphVersion ?? 0;
    if (v === this.hwVersion) return;
    this.hwVersion = v;
    const ox = this.ox;
    const oz = this.oz;
    this.hw = [];
    for (const e of hwys.graph.edges ?? []) {
      const pts = e.points;
      if (!pts || pts.length < 2) continue;
      const arr = new Float32Array(pts.length * 2);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const x = pts[i].x + ox;
        const z = pts[i].z + oz;
        arr[i * 2] = x;
        arr[i * 2 + 1] = z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      this.hw.push({ pts: arr, minX, maxX, minZ, maxZ });
    }
  }

  private refreshRoute(): void {
    const r = this.ctx.nav?.route ?? null;
    if (r === this.routeRef && (r?.length ?? -1) === this.routeLen) return;
    this.routeRef = r;
    this.routeLen = r?.length ?? -1;
    if (!r || r.length < 2) {
      this.route = null;
      return;
    }
    const ox = this.ox;
    const oz = this.oz;
    const a = new Float32Array(r.length * 2);
    for (let i = 0; i < r.length; i++) {
      a[i * 2] = r[i].x + ox;
      a[i * 2 + 1] = r[i].z + oz;
    }
    this.route = a;
  }

  update(dt: number): void {
    const { ctx } = this;
    const d = ctx.world?.data;
    if (!d) return;
    this.checkT -= dt;
    if (this.checkT <= 0 || !this.city) {
      this.checkT = 1;
      const sig = this.signature(d);
      if (sig !== this.sig) {
        this.sig = sig;
        try {
          this.rebuild(d);
        } catch (err) {
          console.warn('[ui] minimap rebuild failed', err);
        }
      }
    }
    // Origin shifts move cached local data; the route cache is keyed by identity, so force a refresh on shift.
    this.refreshHighways();
    this.refreshRoute();
    this.resize();
    if (!this.city || !this.cssSize) return;

    const plane = ctx.game.mode === 'plane' && ctx.planes?.active;
    const ps = ctx.planes?.state;
    const vs = ctx.vehicle.state;
    const pos = plane && ps ? ps.position : vs.position;
    const fwd = plane && ps ? ps.forward : vs.forward;
    const ax = pos.x + this.ox;
    const az = pos.z + this.oz;
    const mm = CONFIG.ui.minimap;
    let targetR: number;
    if (plane && ps) {
      targetR = clamp(500 + ps.altitudeAgl * 2.2 + ps.airspeed * 9, 600, 5200);
    } else {
      const speedT = clamp(Math.abs(vs.speed) / Math.max(1, mm.speedForMaxZoom), 0, 1);
      targetR = mm.radiusMin + (mm.radiusMax - mm.radiusMin) * speedT * (vs.turboActive ? 1.4 : 1);
    }
    targetR *= this.big ? 1.6 : 1;
    this.radius = damp(this.radius, targetR, 2.5, dt);
    this.blink += dt;

    const g = this.g;
    const W = this.canvas.width;
    const scale = W / 2 / this.radius; // canvas px per metre
    const fx = Math.abs(fwd.x) + Math.abs(fwd.z) > 1e-4 ? fwd.x : 0;
    const fz = Math.abs(fwd.x) + Math.abs(fwd.z) > 1e-4 ? fwd.z : 1;
    const rot = -Math.PI / 2 - Math.atan2(fz, fx); // heading up
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.setTransform(1, 0, 0, 1, W / 2, W / 2);
    g.rotate(rot);
    g.scale(scale, scale);
    g.translate(-ax, -az);
    const R = this.radius * 1.5;
    // Land, then the ocean (west of coast.westX, south of coast.southZ — part 3 geography).
    g.fillStyle = LAND;
    g.fillRect(ax - R, az - R, 2 * R, 2 * R);
    const coast = CONFIG.world.coast;
    g.fillStyle = SEA;
    if (az + R > coast.southZ) g.fillRect(ax - R, coast.southZ, 2 * R, az + R - coast.southZ);
    if (ax - R < coast.westX) g.fillRect(ax - R, az - R, coast.westX - (ax - R), 2 * R);
    g.imageSmoothingEnabled = true;
    if (this.region) {
      const L = this.region;
      if (L.minX < ax + R && L.minX + L.w > ax - R && L.minZ < az + R && L.minZ + L.h > az - R) g.drawImage(L.canvas, L.minX, L.minZ, L.w, L.h);
    }
    {
      const L = this.city;
      if (L.minX < ax + R && L.minX + L.w > ax - R && L.minZ < az + R && L.minZ + L.h > az - R) g.drawImage(L.canvas, L.minX, L.minZ, L.w, L.h);
    }
    // Highways (endless network).
    if (this.hw.length) {
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const lw = Math.max(14, 3.2 / scale);
      for (const pass of [0, 1]) {
        g.strokeStyle = pass === 0 ? '#c66f4f' : '#f4a26b';
        g.lineWidth = pass === 0 ? lw + 2.5 / scale : lw;
        g.beginPath();
        for (const e of this.hw) {
          if (e.maxX < ax - R || e.minX > ax + R || e.maxZ < az - R || e.minZ > az + R) continue;
          const p = e.pts;
          g.moveTo(p[0], p[1]);
          for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
        }
        g.stroke();
      }
    }
    // Ocean out-of-map boundary (planes): dashed red line offshore.
    if (plane || this.radius > 1200) {
      const warn = CONFIG.world.planeWarnOffshore;
      g.strokeStyle = 'rgba(232, 60, 50, 0.85)';
      g.lineWidth = 3 / scale;
      g.setLineDash([14 / scale, 10 / scale]);
      g.beginPath();
      g.moveTo(coast.westX - warn, az - R * 3);
      g.lineTo(coast.westX - warn, coast.southZ + warn);
      g.lineTo(ax + R * 3, coast.southZ + warn);
      g.stroke();
      g.setLineDash([]);
    }
    // Nav route: glowing line.
    if (this.route) {
      const p = this.route;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      for (const [col, w] of [
        ['rgba(92, 200, 214, 0.35)', 11],
        ['#2aa3c4', 5],
        ['#e9fbff', 1.8],
      ] as [string, number][]) {
        g.strokeStyle = col;
        g.lineWidth = w / scale;
        g.beginPath();
        g.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
        g.stroke();
      }
    }

    // Markers (screen space, clamped to the rim when off-map).
    g.setTransform(1, 0, 0, 1, 0, 0);
    const gp = d.garage?.position;
    if (gp) this.marker(gp.x + this.ox - ax, gp.z + this.oz - az, rot, scale, W, '#ff7a6b', 'G', !plane);
    if (d.jumpRamp && !plane) this.marker(d.jumpRamp.position.x + this.ox - ax, d.jumpRamp.position.z + this.oz - az, rot, scale, W, '#ffcf5a', '▲', false);
    if (d.airport) this.marker(d.airport.terminal.x + this.ox - ax, d.airport.terminal.z + this.oz - az, rot, scale, W, '#5a6fd8', '✈', true);
    const dest = ctx.nav?.destination?.pose?.position;
    if (dest) this.marker(dest.x + this.ox - ax, dest.z + this.oz - az, rot, scale, W, '#2aa3c4', '★', true);

    // Player icon (centre, pointing up).
    g.setTransform(this.dpr, 0, 0, this.dpr, W / 2, W / 2);
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, 34, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
    g.closePath();
    g.fill();
    g.lineJoin = 'round';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    if (plane) {
      g.fillStyle = ctx.planes.crashed ? '#3b3f4f' : '#4e6bff';
      g.beginPath();
      g.moveTo(0, -10);
      g.lineTo(1.6, -4);
      g.lineTo(9, 1);
      g.lineTo(9, 3);
      g.lineTo(1.6, 1);
      g.lineTo(1.2, 6);
      g.lineTo(4, 8.5);
      g.lineTo(4, 10);
      g.lineTo(0, 9);
      g.lineTo(-4, 10);
      g.lineTo(-4, 8.5);
      g.lineTo(-1.2, 6);
      g.lineTo(-1.6, 1);
      g.lineTo(-9, 3);
      g.lineTo(-9, 1);
      g.lineTo(-1.6, -4);
      g.closePath();
    } else {
      const a = 7;
      g.fillStyle = vs.exploded ? '#3b3f4f' : '#ff6a59';
      g.beginPath();
      g.moveTo(0, -a * 1.25);
      g.lineTo(a, a);
      g.lineTo(0, a * 0.45);
      g.lineTo(-a, a);
      g.closePath();
    }
    g.stroke();
    g.fill();

    // Out of map: pulsing arrow on the rim toward land.
    if (plane && ps && ps.outOfMap.state !== 'ok') {
      let dx = ax < coast.westX ? coast.westX - ax : 0;
      let dz = az > coast.southZ ? coast.southZ - az : 0;
      if (!dx && !dz) {
        dx = -ax;
        dz = -az;
      }
      const c = Math.cos(rot);
      const sn = Math.sin(rot);
      const sx = dx * c - dz * sn;
      const sy = dx * sn + dz * c;
      const ang = Math.atan2(sy, sx);
      const rr = this.cssSize / 2 - 16;
      const pulse = 0.65 + 0.35 * Math.sin(this.blink * 8);
      g.setTransform(this.dpr, 0, 0, this.dpr, W / 2, W / 2);
      g.rotate(ang);
      g.translate(rr, 0);
      g.globalAlpha = pulse;
      g.fillStyle = '#ff3b30';
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(10, 0);
      g.lineTo(-6, -8);
      g.lineTo(-2, 0);
      g.lineTo(-6, 8);
      g.closePath();
      g.stroke();
      g.fill();
      g.globalAlpha = 1;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);

    // North indicator rides the ring.
    this.north.style.transform = `rotate(${rot.toFixed(3)}rad)`;
    (this.north.firstElementChild as HTMLElement).style.transform = `rotate(${(-rot).toFixed(3)}rad)`;
  }

  /** Call on 'originShift' — the route polyline cache is rebuilt from the shifted local points. */
  onOriginShift(): void {
    this.routeRef = null;
  }

  private marker(dx: number, dz: number, rot: number, scale: number, W: number, color: string, label: string, clampToRim = true): void {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    let x = (dx * c - dz * sn) * scale;
    let y = (dx * sn + dz * c) * scale;
    const rim = W / 2 - 12 * this.dpr;
    const dist = Math.hypot(x, y);
    if (dist > rim) {
      if (!clampToRim) return;
      x *= rim / dist;
      y *= rim / dist;
    }
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, W / 2 + x, W / 2 + y);
    g.beginPath();
    g.arc(0, 0, 7.5, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = '#fff';
    g.stroke();
    g.fillStyle = '#fff';
    g.font = '800 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 0, 0.5);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
