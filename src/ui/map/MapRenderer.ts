import { CONFIG } from '../../config';
import type { GameContext } from '../../game/contracts';
import type { Nav } from '../../nav/Nav';
import type { NavPoi } from '../../nav/pois';
import type { DistrictId, RoadKind } from '../../world/types';
import type { TileCache } from './TileCache';

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
  street2: '#ffffff',
  street4: '#ffffff',
  boulevard: '#fff6e6',
  highway: '#f4a26b',
  ramp: '#f4a26b',
  lot: '#e9e4da',
};
const ROAD_ORDER: RoadKind[] = ['lot', 'street2', 'street4', 'boulevard', 'ramp', 'highway'];
const FONT = "'Avenir Next', Avenir, 'Segoe UI', system-ui, -apple-system, Roboto, sans-serif";

export interface MapView {
  /** Absolute world point at the screen centre. */
  cx: number;
  cz: number;
  /** CSS pixels per metre. */
  ppm: number;
}

/**
 * Draws the big map onto a canvas in ABSOLUTE coordinates (absolute = local + origin offset), north up (+X right,
 * +Z down — the ocean is at the bottom-left). Layers: seeded terrain tiles (with coarser tiles as placeholders),
 * flight-limit line, city (districts, parks, buildings, roads), airport, generated highways, the route, POIs, car.
 */
export class MapRenderer {
  readonly view: MapView = { cx: 0, cz: 0, ppm: 0.35 };
  W = 1;
  H = 1;
  dpr = 1;
  selected: NavPoi | null = null;
  /** Screen-space POI badge positions from the last render (for hit tests). */
  private hits: { p: NavPoi; x: number; y: number; r: number }[] = [];
  private g: CanvasRenderingContext2D;
  private t = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private nav: Nav,
    private ctx: GameContext,
    private tiles: TileCache,
  ) {
    this.g = canvas.getContext('2d', { alpha: false })!;
  }

  resize(): boolean {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(window.devicePixelRatio || 1, this.ctx.quality?.level === 'low' ? 1.25 : 2);
    if (w === this.W && h === this.H && dpr === this.dpr) return false;
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    return true;
  }

  sx(ax: number): number {
    return (ax - this.view.cx) * this.view.ppm + this.W / 2;
  }
  sy(az: number): number {
    return (az - this.view.cz) * this.view.ppm + this.H / 2;
  }
  wx(x: number): number {
    return (x - this.W / 2) / this.view.ppm + this.view.cx;
  }
  wz(y: number): number {
    return (y - this.H / 2) / this.view.ppm + this.view.cz;
  }

  hitPoi(x: number, y: number): NavPoi | null {
    let best: NavPoi | null = null;
    let bd = Infinity;
    for (const h of this.hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d < h.r + 10 && d < bd) {
        bd = d;
        best = h.p;
      }
    }
    return best;
  }

  render(time: number): void {
    this.t = time;
    const g = this.g;
    const { W, H, dpr } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = true;
    // ocean background (tiles cover it as they arrive)
    g.fillStyle = '#2f9fc0';
    g.fillRect(0, 0, W, H);
    this.drawTiles();
    this.drawFlightLimit();
    this.drawCity();
    this.drawAirport();
    this.drawGraphHighways();
    this.drawRoute();
    this.drawPois();
    this.drawPlayer();
  }

  // ─────────────────────────────── tiles ───────────────────────────────
  private drawTiles(): void {
    const g = this.g;
    const size = CONFIG.nav.mapTilePx;
    const devPpm = this.view.ppm * this.dpr;
    const L = Math.max(0, Math.min(8, Math.floor(Math.log2(1 / devPpm) + 0.35)));
    const minX = this.wx(0);
    const maxX = this.wx(this.W);
    const minZ = this.wz(0);
    const maxZ = this.wz(this.H);
    this.tiles.beginFrame();
    // coarse cover first (few tiles, fills the screen quickly), then the wanted level by distance to the centre
    const coarse = Math.min(8, L + 2);
    if (coarse !== L) this.requestLevel(coarse, minX, maxX, minZ, maxZ, -1e6);
    const tw = size * Math.pow(2, L);
    const tx0 = Math.floor(minX / tw);
    const tx1 = Math.floor(maxX / tw);
    const tz0 = Math.floor(minZ / tw);
    const tz1 = Math.floor(maxZ / tw);
    for (let tz = tz0; tz <= tz1; tz++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const x = this.sx(tx * tw);
        const y = this.sy(tz * tw);
        const s = tw * this.view.ppm;
        const X = Math.floor(x);
        const Y = Math.floor(y);
        const S2 = Math.ceil(x + s) - X;
        const S3 = Math.ceil(y + s) - Y;
        const c = this.tiles.get(L, tx, tz);
        if (c) {
          g.drawImage(c, X, Y, S2, S3);
          continue;
        }
        const cxw = (tx + 0.5) * tw - this.view.cx;
        const czw = (tz + 0.5) * tw - this.view.cz;
        this.tiles.need(L, tx, tz, Math.hypot(cxw, czw) * this.view.ppm);
        // placeholder: the closest cached ancestor
        for (let up = 1; up <= 5 && L + up <= 8; up++) {
          const f = 1 << up;
          const ptx = Math.floor(tx / f);
          const ptz = Math.floor(tz / f);
          const pc = this.tiles.get(L + up, ptx, ptz);
          if (!pc) continue;
          const sub = size / f;
          g.drawImage(pc, (tx - ptx * f) * sub, (tz - ptz * f) * sub, sub, sub, X, Y, S2, S3);
          break;
        }
      }
    this.tiles.flush();
  }

  private requestLevel(L: number, minX: number, maxX: number, minZ: number, maxZ: number, prio: number): void {
    const tw = CONFIG.nav.mapTilePx * Math.pow(2, L);
    for (let tz = Math.floor(minZ / tw); tz <= Math.floor(maxZ / tw); tz++)
      for (let tx = Math.floor(minX / tw); tx <= Math.floor(maxX / tw); tx++) if (!this.tiles.has(L, tx, tz)) this.tiles.need(L, tx, tz, prio);
  }

  // ─────────────────────────────── flight limit ───────────────────────────────
  private drawFlightLimit(): void {
    const g = this.g;
    const c = CONFIG.world.coast;
    const ppm = this.view.ppm;
    const big = 1e5;
    const draw = (r: number, alpha: number, dash: number[]) => {
      g.beginPath();
      const wx = c.westX - r;
      const sz = c.southZ + r;
      const top = Math.max(this.wz(-50), -big);
      g.moveTo(this.sx(wx), this.sy(Math.min(top, c.southZ)));
      g.lineTo(this.sx(wx), this.sy(c.southZ));
      g.arc(this.sx(c.westX), this.sy(c.southZ), r * ppm, Math.PI, Math.PI / 2, true);
      g.lineTo(this.sx(Math.max(this.wx(this.W + 50), c.westX)), this.sy(sz));
      g.strokeStyle = `rgba(255, 122, 107, ${alpha})`;
      g.lineWidth = 2.5;
      g.setLineDash(dash);
      g.stroke();
    };
    const warn = CONFIG.world.planeWarnOffshore ?? 5500;
    const fail = CONFIG.world.planeFailOffshore ?? 6500;
    // only when part of it is near the view
    const minX = this.wx(0);
    const maxZ = this.wz(this.H);
    if (minX > c.westX - warn + 200 && maxZ < c.southZ + warn - 200) return;
    g.save();
    draw(fail, 0.35, [4, 8]);
    draw(warn, 0.9, [12, 8]);
    g.setLineDash([]);
    // label
    if (ppm > 0.01) {
      const lx = Math.min(Math.max(this.sx(c.westX - warn) + 10, 70), this.W - 70);
      const ly = this.sy(c.southZ + warn) - 10;
      g.font = `800 11px ${FONT}`;
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.textAlign = 'left';
      if (ly > 20 && ly < this.H - 10) {
        const x = Math.max(20, Math.min(this.W - 120, this.sx(Math.max(c.westX + 200, this.wx(this.W * 0.5)))));
        label(g, '✈ FLIGHT LIMIT', x, ly, '#e2584c');
      } else if (lx > 0 && lx < this.W) {
        const y = Math.max(40, Math.min(this.H - 40, this.H / 2));
        label(g, '✈ FLIGHT LIMIT', lx, y, '#e2584c');
      }
    }
    g.restore();
  }

  // ─────────────────────────────── city + airport ───────────────────────────────
  private drawCity(): void {
    const d = this.ctx.world?.data;
    const g = this.g;
    const o = this.ctx.origin.offset;
    const b = CONFIG.world.cityBounds;
    const ppm = this.view.ppm;
    if (this.sx(b.maxX) < 0 || this.sx(b.minX) > this.W || this.sy(b.maxZ) < 0 || this.sy(b.minZ) > this.H) return;
    // flat city ground
    g.fillStyle = '#efe7d6';
    roundRect(g, this.sx(b.minX), this.sy(b.minZ), (b.maxX - b.minX) * ppm, (b.maxZ - b.minZ) * ppm, Math.min(18, 40 * ppm));
    g.fill();
    if (!d) return;
    // districts (grid in ABSOLUTE space, cell = size / n, covering [-size/2, size/2])
    const n = d.districtGridSize || 0;
    const size = d.size || CONFIG.world.size;
    if (n > 1 && d.districtGrid?.length === n * n && ppm > 0.06) {
      const cell = size / n;
      const half = size / 2;
      for (let iz = 0; iz < n; iz++)
        for (let ix = 0; ix < n; ix++) {
          const id = d.districtGrid[iz * n + ix];
          if (id === 'water') continue;
          g.fillStyle = DISTRICT_TINT[id] ?? '#efe7d6';
          g.fillRect(this.sx(-half + ix * cell) - 0.5, this.sy(-half + iz * cell) - 0.5, cell * ppm + 1, cell * ppm + 1);
        }
    }
    // beach + wander areas
    for (const a of d.wanderAreas ?? []) {
      g.fillStyle = a.kind === 'park' ? '#b5dfa2' : a.kind === 'beach' ? '#f6dca4' : '#e9e1d2';
      g.fillRect(this.sx(a.minX + o.x), this.sy(a.minZ + o.z), (a.maxX - a.minX) * ppm, (a.maxZ - a.minZ) * ppm);
    }
    // buildings
    if (ppm > 0.22 && d.buildings?.length) {
      const minX = this.wx(-20) - o.x;
      const maxX = this.wx(this.W + 20) - o.x;
      const minZ = this.wz(-20) - o.z;
      const maxZ = this.wz(this.H + 20) - o.z;
      for (const bl of d.buildings) {
        if (bl.x < minX || bl.x > maxX || bl.z < minZ || bl.z > maxZ) continue;
        g.fillStyle = BUILDING_TINT[bl.district] ?? '#d8cbbb';
        const x = this.sx(bl.x + o.x);
        const y = this.sy(bl.z + o.z);
        if (Math.abs(bl.yaw) < 1e-3 || Math.abs(Math.abs(bl.yaw) - Math.PI) < 1e-3) g.fillRect(x - (bl.w * ppm) / 2, y - (bl.d * ppm) / 2, bl.w * ppm, bl.d * ppm);
        else {
          g.save();
          g.translate(x, y);
          g.rotate(-bl.yaw);
          g.fillRect((-bl.w * ppm) / 2, (-bl.d * ppm) / 2, bl.w * ppm, bl.d * ppm);
          g.restore();
        }
      }
    }
    // roads: casing then fill, by kind order
    const edges = d.roads?.edges ?? [];
    if (!edges.length) return;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (const kind of ROAD_ORDER) {
        g.beginPath();
        let any = false;
        let wsum = 0;
        let wn = 0;
        for (const e of edges) {
          if (e.kind !== kind || !e.points?.length) continue;
          const p0 = e.points[0];
          g.moveTo(this.sx(p0.x + o.x), this.sy(p0.z + o.z));
          for (let i = 1; i < e.points.length; i++) g.lineTo(this.sx(e.points[i].x + o.x), this.sy(e.points[i].z + o.z));
          any = true;
          wsum += e.width || 8;
          wn++;
        }
        if (!any) continue;
        const w = Math.max(kind === 'highway' || kind === 'ramp' ? 2 : 1.1, ((wsum / wn) * ppm));
        if (pass === 0) {
          g.strokeStyle = kind === 'highway' || kind === 'ramp' ? 'rgba(160,86,44,0.6)' : 'rgba(90,96,120,0.38)';
          g.lineWidth = w + (ppm > 0.3 ? 2 : 1);
        } else {
          g.strokeStyle = ROAD_FILL[kind] ?? '#ffffff';
          g.lineWidth = w;
        }
        g.stroke();
      }
    }
  }

  private drawAirport(): void {
    const a = this.ctx.world?.data?.airport;
    const g = this.g;
    const o = this.ctx.origin.offset;
    const ppm = this.view.ppm;
    const b = a?.bounds ? { minX: a.bounds.minX + o.x, maxX: a.bounds.maxX + o.x, minZ: a.bounds.minZ + o.z, maxZ: a.bounds.maxZ + o.z } : CONFIG.world.airportBounds;
    if (!b || this.sx(b.maxX) < 0 || this.sx(b.minX) > this.W || this.sy(b.maxZ) < 0 || this.sy(b.minZ) > this.H) return;
    g.fillStyle = 'rgba(226, 232, 214, 0.92)';
    roundRect(g, this.sx(b.minX), this.sy(b.minZ), (b.maxX - b.minX) * ppm, (b.maxZ - b.minZ) * ppm, Math.min(14, 30 * ppm));
    g.fill();
    if (!a) return;
    g.lineCap = 'butt';
    for (const r of a.runways ?? []) {
      const x0 = this.sx(r.a.x + o.x);
      const y0 = this.sy(r.a.z + o.z);
      const x1 = this.sx(r.b.x + o.x);
      const y1 = this.sy(r.b.z + o.z);
      g.strokeStyle = '#5d6272';
      g.lineWidth = Math.max(3, r.width * ppm);
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      if (ppm > 0.08) {
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = Math.max(1, 1.2 * ppm);
        g.setLineDash([Math.max(3, 30 * ppm), Math.max(3, 20 * ppm)]);
        g.beginPath();
        g.moveTo(x0, y0);
        g.lineTo(x1, y1);
        g.stroke();
        g.setLineDash([]);
      }
    }
    const sq = (p: { x: number; z: number }, s: number, c: string) => {
      g.fillStyle = c;
      const w = Math.max(3, s * ppm);
      g.fillRect(this.sx(p.x + o.x) - w / 2, this.sy(p.z + o.z) - w / 2, w, w);
    };
    if (a.terminal) sq(a.terminal, 90, '#d9cfe6');
    if (a.tower) sq(a.tower, 16, '#ff7a6b');
    if (ppm > 0.1) for (const s of a.stands ?? []) sq(s.p, 24, 'rgba(255,255,255,0.75)');
  }

  /** Highways generated so far (crisper than the tiles, which show the seeded corridors at every zoom). */
  private drawGraphHighways(): void {
    const G = this.nav.graph;
    if (!G || this.view.ppm < 0.03) return;
    const g = this.g;
    const minX = this.wx(-40);
    const maxX = this.wx(this.W + 40);
    const minZ = this.wz(-40);
    const maxZ = this.wz(this.H + 40);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.beginPath();
      for (const e of G.base) {
        if (e.dead || !e.hw) continue;
        const p = e.pts;
        const n = p.length / 3;
        // cheap bbox reject on endpoints + midpoint
        const xs = [p[0], p[n * 3 - 3], p[Math.floor(n / 2) * 3]];
        const zs = [p[2], p[n * 3 - 1], p[Math.floor(n / 2) * 3 + 2]];
        if (Math.max(...xs) < minX - 600 || Math.min(...xs) > maxX + 600 || Math.max(...zs) < minZ - 600 || Math.min(...zs) > maxZ + 600) continue;
        g.moveTo(this.sx(p[0]), this.sy(p[2]));
        for (let i = 1; i < n; i++) g.lineTo(this.sx(p[i * 3]), this.sy(p[i * 3 + 2]));
      }
      const w = Math.max(2.2, 20 * this.view.ppm);
      g.strokeStyle = pass === 0 ? 'rgba(150,80,40,0.55)' : '#f4a26b';
      g.lineWidth = pass === 0 ? w + 2 : w;
      g.stroke();
    }
  }

  // ─────────────────────────────── route ───────────────────────────────
  private drawRoute(): void {
    const r = this.nav.active;
    if (!r || r.n < 2) return;
    const g = this.g;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const start = Math.max(0, r.seg);
    const onRoad = (i: number) => r.offroad[i] === 0;
    const path = (road: boolean) => {
      g.beginPath();
      let open = false;
      for (let i = start; i < r.n - 1; i++) {
        if (onRoad(i) !== road) {
          open = false;
          continue;
        }
        const ax = i === start ? r.x[i] + (r.x[i + 1] - r.x[i]) * r.t : r.x[i];
        const az = i === start ? r.z[i] + (r.z[i + 1] - r.z[i]) * r.t : r.z[i];
        if (!open) {
          g.moveTo(this.sx(ax), this.sy(az));
          open = true;
        }
        g.lineTo(this.sx(r.x[i + 1]), this.sy(r.z[i + 1]));
      }
    };
    // glow, body, core
    path(true);
    g.strokeStyle = 'rgba(92, 214, 230, 0.35)';
    g.lineWidth = 12;
    g.stroke();
    g.strokeStyle = '#2aa3c4';
    g.lineWidth = 6;
    g.stroke();
    g.strokeStyle = 'rgba(244,255,255,0.95)';
    g.lineWidth = 2.2;
    g.stroke();
    // off-road legs dashed
    path(false);
    g.setLineDash([8, 7]);
    g.strokeStyle = 'rgba(138, 119, 196, 0.95)';
    g.lineWidth = 4;
    g.stroke();
    g.setLineDash([]);
    // flowing dots along the road route
    const total = r.length;
    const step = Math.max(40, 70 / this.view.ppm);
    const phase = (this.t * 0.06 * step) % step;
    g.fillStyle = '#ffffff';
    const tmp = { x: 0, y: 0, z: 0 };
    let count = 0;
    for (let s = r.s + phase; s < total && count < 200; s += step, count++) {
      r.pointAt(s, tmp);
      const x = this.sx(tmp.x);
      const y = this.sy(tmp.z);
      if (x < -10 || y < -10 || x > this.W + 10 || y > this.H + 10) continue;
      g.beginPath();
      g.arc(x, y, 2.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  // ─────────────────────────────── POIs + player ───────────────────────────────
  private drawPois(): void {
    const g = this.g;
    this.hits.length = 0;
    const dest = this.nav.destination;
    const list = this.nav.entries();
    const ppm = this.view.ppm;
    const showLabels = ppm > 0.05;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    // draw undiscovered first, the selected / destination last (on top)
    const sorted = [...list].sort((a, b) => rank(a, this.selected, dest) - rank(b, this.selected, dest));
    for (const p of sorted) {
      const x = this.sx(p.ax);
      const y = this.sy(p.az);
      if (x < -40 || y < -40 || x > this.W + 40 || y > this.H + 40) continue;
      const sel = p === this.selected;
      const isDest = !!dest && p.id === dest.id;
      const r = sel ? 19 : isDest ? 17 : 14;
      // pin shadow + badge
      g.beginPath();
      g.arc(x, y + 2, r + 1, 0, Math.PI * 2);
      g.fillStyle = 'rgba(34,48,77,0.25)';
      g.fill();
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = p.discovered ? (isDest ? '#2aa3c4' : '#fffaf1') : 'rgba(86, 96, 124, 0.82)';
      g.fill();
      g.lineWidth = sel ? 3.5 : 2.5;
      g.strokeStyle = sel ? '#ff7a6b' : p.discovered ? (isDest ? '#ffffff' : '#ffb38a') : 'rgba(255,255,255,0.7)';
      g.stroke();
      g.globalAlpha = p.discovered ? 1 : 0.55;
      g.font = `${Math.round(r * 1.05)}px ${FONT}`;
      g.fillText(p.icon, x, y + 1);
      g.globalAlpha = 1;
      if (!p.discovered) {
        // tiny lock badge
        g.beginPath();
        g.arc(x + r * 0.72, y - r * 0.72, 6.5, 0, Math.PI * 2);
        g.fillStyle = '#22304d';
        g.fill();
        g.font = `700 8px ${FONT}`;
        g.fillStyle = '#fff';
        g.fillText('?', x + r * 0.72, y - r * 0.72 + 0.5);
      }
      if (showLabels || sel || isDest) {
        g.font = `800 ${sel ? 13 : 11.5}px ${FONT}`;
        label(g, p.name, x, y + r + 12, sel ? '#e2584c' : p.discovered ? '#22304d' : '#56607c', true);
      }
      this.hits.push({ p, x, y, r });
    }
  }

  private drawPlayer(): void {
    const g = this.g;
    const f = this.nav.focusAbs();
    const yaw = this.nav.focusYaw();
    const x = this.sx(f.x);
    const y = this.sy(f.z);
    // screen direction of forward (sin yaw, cos yaw) in (x, z) → (x right, y down)
    const ang = Math.atan2(Math.cos(yaw), Math.sin(yaw));
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 0.004);
    g.beginPath();
    g.arc(x, y, 16 + pulse * 6, 0, Math.PI * 2);
    g.fillStyle = `rgba(255, 122, 107, ${0.18 + 0.12 * (1 - pulse)})`;
    g.fill();
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(14, 0);
    g.lineTo(-9, 9.5);
    g.lineTo(-4.5, 0);
    g.lineTo(-9, -9.5);
    g.closePath();
    g.fillStyle = '#ff7a6b';
    g.strokeStyle = '#ffffff';
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.stroke();
    g.fill();
    g.restore();
    if (this.ctx.game.mode === 'plane') {
      g.font = `16px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('✈️', x, y - 24);
    }
  }
}

function rank(p: NavPoi, sel: NavPoi | null, dest: NavPoi | null): number {
  if (p === sel) return 3;
  if (dest && p.id === dest.id) return 2;
  return p.discovered ? 1 : 0;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** Text with a soft cream halo for legibility over terrain. */
function label(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, center = false): void {
  g.textAlign = center ? 'center' : 'left';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(255, 250, 241, 0.92)';
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}
