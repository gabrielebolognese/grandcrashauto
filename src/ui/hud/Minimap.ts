import { CONFIG } from '../../config';
import { clamp, damp } from '../../core/math';
import type { GameContext } from '../../game/contracts';
import type { CityData, DistrictId, RoadKind } from '../../world/types';
import { h } from '../dom';

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

/**
 * Rotating canvas minimap (spec §13). The city (districts, water, parks, buildings, roads) is pre-rendered once
 * into an offscreen canvas at ~1–2 px/m and re-rendered whenever the world's data changes; every frame we only
 * blit it rotated around the car heading and draw the markers.
 */
export class Minimap {
  readonly el: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private north: HTMLDivElement;
  private map: HTMLCanvasElement | null = null;
  private mapPpm = 1;
  private sig = '';
  private checkT = 0;
  private radius = CONFIG.ui.minimap.radiusMin;
  private cssSize = 0;
  private dpr = 1;
  private big = false;

  constructor(private ctx: GameContext) {
    this.canvas = h('canvas', { class: 'mm-canvas', 'aria-hidden': 'true' });
    this.g = this.canvas.getContext('2d', { alpha: true })!;
    this.north = h('div', { class: 'mm-north' }, h('span', { text: 'N' }));
    this.el = h('div', { class: 'minimap', role: 'img', 'aria-label': 'Minimap' }, this.canvas, h('div', { class: 'mm-ring' }), this.north);
    this.el.addEventListener('click', () => {
      this.big = !this.big;
      this.el.classList.toggle('big', this.big);
      this.cssSize = 0;
    });
  }

  /** Signature of the world data; when it changes the offscreen map is rebuilt. */
  private signature(d: CityData): string {
    return `${d.seed}|${d.size}|${d.roads?.edges?.length ?? 0}|${d.roads?.nodes?.length ?? 0}|${d.buildings?.length ?? 0}|${d.wanderAreas?.length ?? 0}|${d.districtGrid?.length ?? 0}|${d.coast?.shoreZ}`;
  }

  private rebuild(d: CityData): void {
    const ppm = this.ctx.quality.level === 'low' ? Math.min(1, CONFIG.ui.minimap.pxPerMeter) : CONFIG.ui.minimap.pxPerMeter;
    const size = d.size || CONFIG.world.size;
    const px = Math.max(64, Math.min(2048, Math.round(size * ppm)));
    const c = this.map ?? document.createElement('canvas');
    c.width = px;
    c.height = px;
    this.map = c;
    this.mapPpm = px / size;
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, px, px);
    // World meters → map pixels (x right = +X, y down = +Z; the ocean is at the bottom).
    const k = this.mapPpm;
    g.setTransform(k, 0, 0, k, (size / 2) * k, (size / 2) * k);
    const half = size / 2;

    // Land + district tints.
    g.fillStyle = '#efe7d6';
    g.fillRect(-half, -half, size, size);
    const n = d.districtGridSize || 0;
    if (n > 0 && d.districtGrid?.length === n * n) {
      const cell = size / n;
      for (let iz = 0; iz < n; iz++)
        for (let ix = 0; ix < n; ix++) {
          const id = d.districtGrid[iz * n + ix];
          g.fillStyle = DISTRICT_TINT[id] ?? '#efe7d6';
          g.fillRect(-half + ix * cell - 0.5, -half + iz * cell - 0.5, cell + 1, cell + 1);
        }
    }
    // Beach sand and sea (south / +Z).
    if (d.coast) {
      g.fillStyle = '#f7e1ad';
      g.fillRect(-half, d.coast.seaWallZ, size, half - d.coast.seaWallZ + 1);
      const sea = g.createLinearGradient(0, d.coast.shoreZ, 0, half);
      sea.addColorStop(0, '#8fd6ec');
      sea.addColorStop(1, '#4fb3d3');
      g.fillStyle = sea;
      g.fillRect(-half, d.coast.shoreZ, size, half - d.coast.shoreZ + 1);
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(-half, d.coast.shoreZ);
      g.lineTo(half, d.coast.shoreZ);
      g.stroke();
    }
    // Wander areas (parks, beach promenade, plazas).
    for (const a of d.wanderAreas ?? []) {
      g.fillStyle = a.kind === 'park' ? '#b5dfa2' : a.kind === 'beach' ? '#f6dca4' : '#e9e1d2';
      g.fillRect(a.minX, a.minZ, a.maxX - a.minX, a.maxZ - a.minZ);
    }
    // Building footprints.
    for (const b of d.buildings ?? []) {
      g.save();
      g.translate(b.x, b.z);
      g.rotate(-b.yaw);
      g.fillStyle = BUILDING_TINT[b.district] ?? '#d6cbbd';
      g.fillRect(-b.w / 2, -b.d / 2, b.w, b.d);
      g.restore();
    }
    // Roads: sidewalks first, then asphalt by kind (highway on top), round caps so junctions merge.
    const edges = d.roads?.edges ?? [];
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const path = (pts: { x: number; z: number }[]) => {
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].z);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].z);
    };
    for (const e of edges) {
      if (!e.points || e.points.length < 2 || e.kind === 'highway' || e.kind === 'ramp') continue;
      g.strokeStyle = '#fbf7ee';
      g.lineWidth = e.width + 2 * (e.sidewalk || 0) + 1;
      path(e.points);
      g.stroke();
    }
    for (const kind of ROAD_ORDER) {
      const hw = kind === 'highway' || kind === 'ramp';
      if (hw) {
        // dark outline under the highway so it reads above streets
        g.strokeStyle = '#c66f4f';
        for (const e of edges) {
          if (e.kind !== kind || !e.points || e.points.length < 2) continue;
          g.lineWidth = e.width + 3;
          path(e.points);
          g.stroke();
        }
      }
      g.strokeStyle = ROAD_FILL[kind];
      for (const e of edges) {
        if (e.kind !== kind || !e.points || e.points.length < 2) continue;
        g.lineWidth = Math.max(3, e.width);
        path(e.points);
        g.stroke();
      }
    }
    // Highway centre line.
    g.strokeStyle = 'rgba(255,240,210,0.9)';
    g.lineWidth = 1.2;
    g.setLineDash([6, 6]);
    for (const e of edges) {
      if (e.kind !== 'highway' || !e.points || e.points.length < 2) continue;
      path(e.points);
      g.stroke();
    }
    g.setLineDash([]);
    g.setTransform(1, 0, 0, 1, 0, 0);
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

  update(dt: number): void {
    const d = this.ctx.world?.data;
    if (!d) return;
    this.checkT -= dt;
    if (this.checkT <= 0 || !this.map) {
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
    this.resize();
    if (!this.map || !this.cssSize) return;

    const v = this.ctx.vehicle;
    const s = v.state;
    const px = s.position.x;
    const pz = s.position.z;
    const yaw = Math.atan2(s.forward.x, s.forward.z);
    const mm = CONFIG.ui.minimap;
    const speedT = clamp(Math.abs(s.speed) / Math.max(1, mm.speedForMaxZoom), 0, 1);
    const targetR = (mm.radiusMin + (mm.radiusMax - mm.radiusMin) * speedT) * (this.big ? 1.6 : 1);
    this.radius = damp(this.radius, targetR, 2.5, dt);

    const g = this.g;
    const W = this.canvas.width;
    const scale = W / 2 / this.radius; // canvas px per meter
    // Rotate so the car's forward points up: canvas angle of forward is atan2(fz, fx); target is −90°.
    const rot = -Math.PI / 2 - Math.atan2(s.forward.z, s.forward.x);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.setTransform(1, 0, 0, 1, W / 2, W / 2);
    g.rotate(rot);
    g.scale(scale, scale);
    g.translate(-px, -pz);
    const size = d.size || CONFIG.world.size;
    const half = size / 2;
    // Outside the city: land to the north, sea to the south (big quads so the edges never show).
    g.fillStyle = '#e6dcc8';
    g.fillRect(px - 2000, pz - 2000, 4000, 4000);
    if (d.coast) {
      g.fillStyle = '#5bb9d6';
      g.fillRect(px - 2000, d.coast.shoreZ, 4000, 4000);
    }
    g.imageSmoothingEnabled = true;
    g.drawImage(this.map, -half, -half, size, size);

    // Garage marker (clamped to the rim when off-map).
    const gp = d.garage?.position;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (gp) this.marker(gp.x - px, gp.z - pz, rot, scale, W, '#ff7a6b', 'G');
    if (d.jumpRamp) this.marker(d.jumpRamp.position.x - px, d.jumpRamp.position.z - pz, rot, scale, W, '#ffcf5a', '▲', false);

    // Player arrow (always centre, pointing up).
    g.setTransform(this.dpr, 0, 0, this.dpr, W / 2, W / 2);
    const a = 7;
    g.fillStyle = 'rgba(255,255,255,0.28)';
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, a * 5, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(0, -a * 1.25);
    g.lineTo(a, a);
    g.lineTo(0, a * 0.45);
    g.lineTo(-a, a);
    g.closePath();
    g.fillStyle = s.exploded ? '#3b3f4f' : '#ff6a59';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.stroke();
    g.fill();
    g.setTransform(1, 0, 0, 1, 0, 0);

    // North indicator rides the ring.
    const na = rot - Math.PI / 2; // world −Z (north) direction on screen
    this.north.style.transform = `rotate(${(na + Math.PI / 2).toFixed(3)}rad)`;
    (this.north.firstElementChild as HTMLElement).style.transform = `rotate(${(-(na + Math.PI / 2)).toFixed(3)}rad)`;
  }

  private marker(dx: number, dz: number, rot: number, scale: number, W: number, color: string, label: string, clampToRim = true): void {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    let x = (dx * c - dz * sn) * scale;
    let y = (dx * sn + dz * c) * scale;
    const rim = W / 2 - 11 * this.dpr;
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
