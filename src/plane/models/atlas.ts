import * as THREE from 'three';
import type { PlaneTypeId } from '../types';

/**
 * Shared livery atlas (one 1024² CanvasTexture for every plane): a white block (vertex colours show through), and per
 * type: titles, registration and fin art. Everything is drawn in code at first use. Fin art is drawn with the nose
 * to the RIGHT; titles/registration read left-to-right (the UV mapping un-mirrors them on each side).
 */

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** pixel aspect (w / h) */
  aspect: number;
}

const SIZE = 1024;
const TYPES: PlaneTypeId[] = ['prop', 'bizjet', 'airliner', 'jumbo'];

const rects = {
  title: (k: number) => ({ x: 16, y: 24 + k * 128, w: 992, h: 112 }),
  reg: (k: number) => ({ x: 16, y: 544 + k * 96, w: 480, h: 80 }),
  fin: (k: number) => ({ x: 512 + (k % 2) * 256, y: 544 + Math.floor(k / 2) * 240, w: 240, h: 232 }),
};

let texture: THREE.CanvasTexture | null = null;

function toUV(r: { x: number; y: number; w: number; h: number }, inset = 2): UVRect {
  return {
    u0: (r.x + inset) / SIZE,
    u1: (r.x + r.w - inset) / SIZE,
    v1: 1 - (r.y + inset) / SIZE,
    v0: 1 - (r.y + r.h - inset) / SIZE,
    aspect: r.w / r.h,
  };
}

export function atlasRegion(type: PlaneTypeId, which: 'title' | 'reg' | 'fin'): UVRect {
  const k = TYPES.indexOf(type);
  return toUV(rects[which](k));
}

/** Text extent (fraction of the region width) actually used by a title/registration (for sizing the rect on the body). */
export const TEXT_INFO: Record<PlaneTypeId, { title: string; reg: string; titleFont: string; regFont: string; titleColor: string; regColor: string; titleBg: string; regBg: string }> = {
  prop: {
    title: 'Coastline Flying Club', reg: 'CL-SW2', titleFont: 'italic 700 64px "Trebuchet MS", "Segoe UI", sans-serif', regFont: '800 64px "Arial Black", "Segoe UI", sans-serif',
    titleColor: '#2f7f74', regColor: '#e8615a', titleBg: '#fff6e6', regBg: '#fff6e6',
  },
  bizjet: {
    title: 'PALMHAVEN', reg: 'CL-PHJ', titleFont: '600 70px "Georgia", "Times New Roman", serif', regFont: '700 60px "Segoe UI", Arial, sans-serif',
    titleColor: '#8a78c9', regColor: '#6d6487', titleBg: '#fbfaf8', regBg: '#fbfaf8',
  },
  airliner: {
    title: 'seaglass air', reg: 'CL-SGA', titleFont: '800 86px "Trebuchet MS", "Segoe UI", sans-serif', regFont: '700 56px "Segoe UI", Arial, sans-serif',
    titleColor: '#1f9fb0', regColor: '#4a5a66', titleBg: '#ffffff', regBg: '#ffffff',
  },
  jumbo: {
    title: 'CORAL CROWN', reg: 'CL-CRW', titleFont: '800 84px "Segoe UI", "Trebuchet MS", sans-serif', regFont: '700 56px "Segoe UI", Arial, sans-serif',
    titleColor: '#e8615a', regColor: '#5a5560', titleBg: '#ffffff', regBg: '#ffffff',
  },
};

export function getAtlas(): THREE.CanvasTexture {
  if (texture) return texture;
  const cv = document.createElement('canvas');
  cv.width = SIZE;
  cv.height = SIZE;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, SIZE, SIZE);
  TYPES.forEach((t, k) => {
    const T = TEXT_INFO[t];
    drawText(g, rects.title(k), T.title, T.titleFont, T.titleColor, T.titleBg, t === 'jumbo' ? 10 : t === 'bizjet' ? 14 : 0);
    drawText(g, rects.reg(k), T.reg, T.regFont, T.regColor, T.regBg, 4);
    drawFin(g, rects.fin(k), t);
  });
  texture = new THREE.CanvasTexture(cv);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function drawText(g: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, text: string, font: string, color: string, bg: string, spacing: number): void {
  g.save();
  g.fillStyle = bg;
  g.fillRect(r.x, r.y, r.w, r.h);
  g.beginPath();
  g.rect(r.x, r.y, r.w, r.h);
  g.clip();
  g.font = font;
  g.textBaseline = 'middle';
  g.fillStyle = color;
  // fit width
  const chars = [...text];
  const widthOf = () => chars.reduce((a, ch) => a + g.measureText(ch).width + spacing, -spacing);
  let w = widthOf();
  const max = r.w * 0.96;
  if (w > max) {
    const k = max / w;
    g.font = font.replace(/(\d+)px/, (_, n) => `${Math.floor(Number(n) * k)}px`);
    w = widthOf();
  }
  let x = r.x + (r.w - w) / 2;
  for (const ch of chars) {
    g.fillText(ch, x, r.y + r.h / 2 + 2);
    x += g.measureText(ch).width + spacing;
  }
  g.restore();
}

function drawFin(g: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, t: PlaneTypeId): void {
  g.save();
  g.translate(r.x, r.y);
  g.beginPath();
  g.rect(0, 0, r.w, r.h);
  g.clip();
  const W = r.w;
  const H = r.h;
  if (t === 'prop') {
    // mint fin, coral + butter speed stripes, little sun
    g.fillStyle = '#9ee0c8';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#ff7a6b';
    g.beginPath();
    g.moveTo(0, H * 0.62);
    g.lineTo(W, H * 0.42);
    g.lineTo(W, H * 0.52);
    g.lineTo(0, H * 0.74);
    g.fill();
    g.fillStyle = '#ffe39a';
    g.beginPath();
    g.moveTo(0, H * 0.78);
    g.lineTo(W, H * 0.56);
    g.lineTo(W, H * 0.6);
    g.lineTo(0, H * 0.83);
    g.fill();
    g.fillStyle = '#fff4e0';
    g.beginPath();
    g.arc(W * 0.58, H * 0.25, H * 0.1, 0, Math.PI * 2);
    g.fill();
  } else if (t === 'bizjet') {
    // pearl fin, lilac palm frond emblem, gold pinstripe
    g.fillStyle = '#fbfaf8';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#b8a6e8';
    g.beginPath();
    g.moveTo(0, H * 0.86);
    g.quadraticCurveTo(W * 0.5, H * 0.66, W, H * 0.48);
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.fill();
    g.strokeStyle = '#e8c870';
    g.lineWidth = H * 0.025;
    g.beginPath();
    g.moveTo(0, H * 0.8);
    g.quadraticCurveTo(W * 0.5, H * 0.6, W, H * 0.42);
    g.stroke();
    // palm emblem
    const cx = W * 0.55, cy = H * 0.36;
    g.strokeStyle = '#8a78c9';
    g.lineWidth = H * 0.028;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - W * 0.02, cy + H * 0.2);
    g.quadraticCurveTo(cx + W * 0.02, cy + H * 0.05, cx, cy - H * 0.02);
    g.stroke();
    g.fillStyle = '#8a78c9';
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI * 0.95 + (i / 4) * Math.PI * 0.9;
      g.save();
      g.translate(cx, cy - H * 0.02);
      g.rotate(a);
      g.beginPath();
      g.ellipse(H * 0.09, 0, H * 0.1, H * 0.028, 0.25, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  } else if (t === 'airliner') {
    // aqua fin, cream wave, coral sun, white gull
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#46bccd');
    grd.addColorStop(1, '#5cc8d6');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#ff8a78';
    g.beginPath();
    g.arc(W * 0.6, H * 0.42, H * 0.16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff4e0';
    g.beginPath();
    g.moveTo(0, H * 0.72);
    for (let i = 0; i <= 24; i++) {
      const x = (i / 24) * W;
      g.lineTo(x, H * 0.66 - Math.sin((i / 24) * Math.PI * 2.2) * H * 0.05 - (i / 24) * H * 0.08);
    }
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.fill();
    g.fillStyle = '#5cc8d6';
    g.beginPath();
    g.moveTo(0, H * 0.84);
    for (let i = 0; i <= 24; i++) {
      const x = (i / 24) * W;
      g.lineTo(x, H * 0.8 - Math.sin((i / 24) * Math.PI * 2.2 + 1.3) * H * 0.035 - (i / 24) * H * 0.06);
    }
    g.lineTo(W, H);
    g.lineTo(0, H);
    g.fill();
    // gull
    g.strokeStyle = '#ffffff';
    g.lineWidth = H * 0.03;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    const gx = W * 0.45, gy = H * 0.3;
    g.moveTo(gx - W * 0.16, gy + H * 0.02);
    g.quadraticCurveTo(gx - W * 0.07, gy - H * 0.07, gx, gy + H * 0.03);
    g.quadraticCurveTo(gx + W * 0.07, gy - H * 0.07, gx + W * 0.16, gy + H * 0.02);
    g.stroke();
  } else {
    // coral fin, butter crown-sun emblem
    const grd = g.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#ff6f61');
    grd.addColorStop(1, '#ff8a70');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    const cx = W * 0.56, cy = H * 0.44;
    g.fillStyle = '#ffe39a';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      g.beginPath();
      g.moveTo(H * 0.12, -H * 0.025);
      g.lineTo(H * 0.21, 0);
      g.lineTo(H * 0.12, H * 0.025);
      g.fill();
      g.restore();
    }
    g.beginPath();
    g.arc(cx, cy, H * 0.105, 0, Math.PI * 2);
    g.fill();
    // crown on the sun
    g.fillStyle = '#ff6f61';
    g.beginPath();
    const s = H * 0.07;
    g.moveTo(cx - s, cy + s * 0.55);
    g.lineTo(cx - s, cy - s * 0.25);
    g.lineTo(cx - s * 0.5, cy + s * 0.1);
    g.lineTo(cx, cy - s * 0.55);
    g.lineTo(cx + s * 0.5, cy + s * 0.1);
    g.lineTo(cx + s, cy - s * 0.25);
    g.lineTo(cx + s, cy + s * 0.55);
    g.closePath();
    g.fill();
    g.fillStyle = '#fff4e0';
    g.fillRect(0, H * 0.86, W, H * 0.03);
  }
  g.restore();
}
