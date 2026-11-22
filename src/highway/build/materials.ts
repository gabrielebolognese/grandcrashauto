import * as THREE from 'three';

/**
 * Shared highway materials (created once at init — never new variants mid-game) + the sign text atlas.
 *  - road:     everything static (pavement, markings, barriers, rails, bridges, tunnels, buildings…) via vertex colours
 *  - lamp:     streetlight heads (emissive, brighter at night — colour driven by uNight in update)
 *  - tunnel:   tunnel light strips (always on)
 *  - sign:     gantry / roadside text panels (atlas map + emissive at night)
 *  - flash:    ramp warning arrows (blink)
 *  - far:      low-detail far ribbons (no polygon offset games, cheaper)
 */
export interface HighwayMaterials {
  road: THREE.MeshStandardMaterial;
  far: THREE.MeshStandardMaterial;
  lamp: THREE.MeshBasicMaterial;
  tunnel: THREE.MeshBasicMaterial;
  sign: THREE.MeshStandardMaterial;
  flash: THREE.MeshBasicMaterial;
  atlas: SignAtlas;
}

export class SignAtlas {
  readonly texture: THREE.CanvasTexture;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx2d: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private slots = new Map<string, number>();
  private order: string[] = [];
  static readonly COLS = 4;
  static readonly ROWS = 32;
  static readonly W = 1024;
  static readonly H = 1024;

  constructor() {
    const W = SignAtlas.W, H = SignAtlas.H;
    let cv: HTMLCanvasElement | OffscreenCanvas;
    if (typeof document !== 'undefined') {
      cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
    } else cv = new OffscreenCanvas(W, H);
    this.canvas = cv;
    this.ctx2d = cv.getContext('2d') as CanvasRenderingContext2D;
    this.ctx2d.fillStyle = '#2f7a59';
    this.ctx2d.fillRect(0, 0, W, H);
    this.texture = new THREE.CanvasTexture(cv as HTMLCanvasElement);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  /** UV rect [u0, v0, u1, v1] of a text slot (drawn on first use). Style: 0 green guide sign, 1 blue service, 2 amber warning. */
  slot(text: string, style = 0): [number, number, number, number] {
    const key = style + '|' + text;
    let idx = this.slots.get(key);
    if (idx === undefined) {
      const cap = SignAtlas.COLS * SignAtlas.ROWS;
      if (this.order.length >= cap) {
        const old = this.order.shift()!;
        idx = this.slots.get(old)!;
        this.slots.delete(old);
      } else idx = this.order.length;
      this.slots.set(key, idx);
      this.order.push(key);
      this.draw(idx, text, style);
    }
    const cw = 1 / SignAtlas.COLS, ch = 1 / SignAtlas.ROWS;
    const cx = idx % SignAtlas.COLS, cy = Math.floor(idx / SignAtlas.COLS);
    const pad = 0.002;
    // canvas y down → texture v up (flipY)
    return [cx * cw + pad, 1 - (cy + 1) * ch + pad, (cx + 1) * cw - pad, 1 - cy * ch - pad];
  }

  private draw(idx: number, text: string, style: number): void {
    const g = this.ctx2d;
    const sw = SignAtlas.W / SignAtlas.COLS, sh = SignAtlas.H / SignAtlas.ROWS;
    const x = (idx % SignAtlas.COLS) * sw, y = Math.floor(idx / SignAtlas.COLS) * sh;
    const bg = style === 1 ? '#2b5fa8' : style === 2 ? '#f4b63c' : '#2f7a59';
    const fg = style === 2 ? '#1d1d22' : '#f7f5ee';
    g.fillStyle = bg;
    g.fillRect(x, y, sw, sh);
    g.strokeStyle = fg;
    g.lineWidth = 2;
    g.strokeRect(x + 2, y + 2, sw - 4, sh - 4);
    g.fillStyle = fg;
    let size = 21;
    g.font = `bold ${size}px "Trebuchet MS", "Segoe UI", Arial, sans-serif`;
    while (g.measureText(text).width > sw - 14 && size > 10) {
      size--;
      g.font = `bold ${size}px "Trebuchet MS", "Segoe UI", Arial, sans-serif`;
    }
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x + sw / 2, y + sh / 2 + 1);
    this.texture.needsUpdate = true;
  }
}

export function createHighwayMaterials(): HighwayMaterials {
  const road = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  road.name = 'highway-road';
  const far = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  far.name = 'highway-far';
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.93, 0.8) });
  lamp.name = 'highway-lamp';
  const tunnel = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.25, 0.75) });
  tunnel.name = 'highway-tunnel-light';
  const atlas = new SignAtlas();
  const sign = new THREE.MeshStandardMaterial({
    map: atlas.texture,
    emissiveMap: atlas.texture,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 0.12,
    roughness: 0.6,
    metalness: 0,
  });
  sign.name = 'highway-sign';
  const flash = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 1.0, 0.15) });
  flash.name = 'highway-flash';
  return { road, far, lamp, tunnel, sign, flash, atlas };
}
