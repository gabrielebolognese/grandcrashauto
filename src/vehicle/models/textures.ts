import * as THREE from 'three';
import { CONFIG } from '../../config';

/**
 * Canvas textures for the cars. Shared ones (crack, tread, glow, beam) are created once and never disposed;
 * the trim atlas (licence plate + white) is per car because it carries the build's plate text.
 *
 * Trim atlas layout (flipY = false, uv (u,v) ↔ canvas (u·W, v·H)):
 *   v ∈ [0, 0.625]  licence plate artwork (512×160)
 *   v ∈ [0.66, 1]   plain white (untextured trim samples WHITE_UV = (0.75, 0.82))
 */

export const PLATE_UV: readonly [number, number, number, number] = [0.0, 0.0, 1.0, 0.625];

const canvas = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
};

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draw the original "Coastline" plate design + text into the atlas canvas. */
export function drawPlate(c: HTMLCanvasElement, text: string): void {
  const g = c.getContext('2d')!;
  const W = c.width;
  const H = c.height;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  const ph = Math.round(H * 0.625);
  // plate body
  g.fillStyle = '#2b3550';
  roundRect(g, 2, 2, W - 4, ph - 4, 18);
  g.fill();
  const grad = g.createLinearGradient(0, 8, 0, ph - 8);
  grad.addColorStop(0, '#fff7ea');
  grad.addColorStop(1, '#f6e7cf');
  g.fillStyle = grad;
  roundRect(g, 8, 8, W - 16, ph - 16, 13);
  g.fill();
  // sunset band
  const band = g.createLinearGradient(8, 0, W - 8, 0);
  band.addColorStop(0, '#ff7a6b');
  band.addColorStop(0.5, '#ffb38a');
  band.addColorStop(1, '#5cc8d6');
  g.save();
  roundRect(g, 8, 8, W - 16, ph - 16, 13);
  g.clip();
  g.fillStyle = band;
  g.fillRect(8, 8, W - 16, 30);
  // little wave along the bottom
  g.strokeStyle = 'rgba(42,163,196,0.55)';
  g.lineWidth = 4;
  g.beginPath();
  for (let x = 8; x <= W - 8; x += 4) {
    const y = ph - 18 + Math.sin(x * 0.06) * 4;
    if (x === 8) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.stroke();
  g.restore();
  // sun badge
  g.fillStyle = '#ffb347';
  g.beginPath();
  g.arc(44, ph * 0.6, 17, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2aa3c4';
  g.fillRect(24, ph * 0.6 + 4, 40, 4);
  g.fillRect(28, ph * 0.6 + 11, 32, 4);
  // header
  g.fillStyle = '#ffffff';
  g.font = 'bold 22px Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(CONFIG.game.title || 'Coastline').toUpperCase().split('').join(' '), W / 2, 23);
  // main text
  g.fillStyle = '#1d2a4a';
  const t = (text || '').toUpperCase().slice(0, 8);
  let size = 88;
  g.font = `bold ${size}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
  while (g.measureText(t).width > W - 130 && size > 40) {
    size -= 4;
    g.font = `bold ${size}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
  }
  g.fillText(t, W / 2 + 22, ph * 0.6 + 4);
  // bolts
  g.fillStyle = '#9aa1ad';
  for (const x of [60, W - 60]) {
    g.beginPath();
    g.arc(x, 24, 4, 0, Math.PI * 2);
    g.fill();
  }
}

export function createTrimAtlas(plate: string): THREE.CanvasTexture {
  const [c] = canvas(512, 256);
  drawPlate(c, plate);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  return tex;
}

let crackTex: THREE.Texture | null = null;
/** Tiling crack pattern (white lines on black) for cracked windows. */
export function getCrackTexture(): THREE.Texture {
  if (crackTex) return crackTex;
  const [c, g] = canvas(256, 256);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  const star = (cx: number, cy: number, n: number, len: number) => {
    for (let i = 0; i < n; i++) {
      let a = (i / n) * Math.PI * 2 + rnd() * 0.5;
      let x = cx;
      let y = cy;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x, y);
      const steps = 6 + Math.floor(rnd() * 5);
      for (let k = 0; k < steps; k++) {
        a += (rnd() - 0.5) * 0.6;
        const l = (len / steps) * (0.6 + rnd() * 0.8);
        x += Math.cos(a) * l;
        y += Math.sin(a) * l;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    for (let r = 10; r < len * 0.8; r += 14 + rnd() * 10) {
      g.lineWidth = 1;
      g.beginPath();
      const a0 = rnd() * Math.PI * 2;
      g.arc(cx, cy, r, a0, a0 + 1.5 + rnd() * 3);
      g.stroke();
    }
  };
  // wrap stars so the pattern tiles
  for (const [x, y] of [
    [70, 80],
    [190, 170],
    [200, 40],
  ])
    for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) star(x + ox, y + oy, 9, 90);
  crackTex = new THREE.CanvasTexture(c);
  crackTex.wrapS = crackTex.wrapT = THREE.RepeatWrapping;
  crackTex.colorSpace = THREE.NoColorSpace;
  return crackTex;
}

let treadTex: THREE.Texture | null = null;
/** Tyre normal map: u around the circumference, v across the profile (tread blocks in the middle, ribs on sides). */
export function getTreadNormalMap(): THREE.Texture {
  if (treadTex) return treadTex;
  const W = 512;
  const H = 64;
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / (H - 1);
    for (let x = 0; x < W; x++) {
      let val = 0;
      if (v > 0.3 && v < 0.7) {
        const lane = Math.floor((v - 0.3) / 0.1);
        const off = lane % 2 ? 8 : 0;
        const bx = (x + off) % 16;
        val = bx < 3 ? -1 : 0; // lateral grooves
        const lv = ((v - 0.3) / 0.1) % 1;
        if (lv < 0.12) val = -1; // circumferential grooves
        if (bx >= 3 && bx < 4 && lv > 0.4 && lv < 0.6) val = -0.5; // sipes
      } else {
        const ring = Math.abs(v - 0.5);
        val = Math.sin(ring * 260) > 0.92 ? 0.4 : 0;
      }
      h[y * W + x] = val;
    }
  }
  const [c, g] = canvas(W, H);
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = h[y * W + ((x - 1 + W) % W)];
      const r = h[y * W + ((x + 1) % W)];
      const d = h[Math.max(0, y - 1) * W + x];
      const u = h[Math.min(H - 1, y + 1) * W + x];
      let nx = (l - r) * 1.2;
      let ny = (d - u) * 1.2;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * W + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz / len) * 0.5 * 255 + 127;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  treadTex = new THREE.CanvasTexture(c);
  treadTex.wrapS = THREE.RepeatWrapping;
  treadTex.colorSpace = THREE.NoColorSpace;
  return treadTex;
}

let glowTex: THREE.Texture | null = null;
/** Soft rounded-rectangle glow (underglow pool on the ground). */
export function getGlowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const [c, g] = canvas(128, 256);
  const img = g.createImageData(128, 256);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 128; x++) {
      const u = Math.abs((x + 0.5) / 128 - 0.5) * 2;
      const v = Math.abs((y + 0.5) / 256 - 0.5) * 2;
      // distance outside an inner rounded rect (car footprint)
      const dx = Math.max(0, u - 0.55) / 0.45;
      const dy = Math.max(0, v - 0.72) / 0.28;
      const d = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - d, 2.2);
      const i = (y * 128 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(a * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.NoColorSpace;
  return glowTex;
}

let beamTex: THREE.Texture | null = null;
/** Two headlight beams on the ground (v = 0 at the bumper, 1 far ahead). */
export function getBeamTexture(): THREE.Texture {
  if (beamTex) return beamTex;
  const [c, g] = canvas(128, 256);
  const img = g.createImageData(128, 256);
  for (let y = 0; y < 256; y++) {
    const v = y / 255;
    for (let x = 0; x < 128; x++) {
      const u = (x + 0.5) / 128 - 0.5;
      let a = 0;
      for (const cx of [-0.24, 0.24]) {
        const spread = 0.06 + v * 0.3;
        const du = (u - cx * (1 - v * 0.5)) / spread;
        a += Math.exp(-du * du * 2.2);
      }
      a = Math.min(1, a * 0.75) * Math.pow(1 - v, 1.4) * smooth01(v * 8);
      const i = (y * 128 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(a * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  beamTex = new THREE.CanvasTexture(c);
  beamTex.colorSpace = THREE.NoColorSpace;
  return beamTex;
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
