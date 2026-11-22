import * as THREE from 'three';
import type { PlaneInstruments } from '../types';

/**
 * Cockpit instrument face drawn into a CanvasTexture (per instance, created on first use): airspeed, altitude,
 * heading and vertical-speed dials with big readable numbers, a throttle bar, per-engine status lamps (OK / FIRE /
 * OFF) and a STALL lamp. Glass-cockpit style for jets, analogue gauges for the prop. Redrawn at ~10 Hz by the owner.
 */

const W = 768;
const H = 256;

let blank: THREE.CanvasTexture | null = null;
/** Shared dark placeholder (before the first setInstruments). */
export function blankPanelTexture(): THREE.CanvasTexture {
  if (blank) return blank;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0b0e13';
  g.fillRect(0, 0, 64, 32);
  g.fillStyle = '#18202a';
  for (let i = 0; i < 4; i++) g.fillRect(3 + i * 15.5, 3, 13, 18);
  blank = new THREE.CanvasTexture(c);
  blank.colorSpace = THREE.SRGBColorSpace;
  return blank;
}

export class InstrumentPanel {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private g: CanvasRenderingContext2D;
  constructor(private glass: boolean, private speedMax: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
  }

  draw(i: PlaneInstruments, time: number): void {
    const g = this.g;
    const glass = this.glass;
    g.fillStyle = glass ? '#06090d' : '#1d1f22';
    g.fillRect(0, 0, W, H);
    const D = 186;
    const top = 6;
    const cy = top + D / 2;
    const blink = Math.floor(time * 3) % 2 === 0;
    // 1 airspeed
    this.dial(96, cy, D / 2 - 6, i.airspeedKmh / this.speedMax, Math.round(i.airspeedKmh).toString(), 'KM/H', i.stall && blink ? '#ff4040' : glass ? '#7fe8ff' : '#ffffff', i.stall);
    // 2 altitude (one turn = 1000 m)
    this.dial(288, cy, D / 2 - 6, (i.altitude % 1000) / 1000, Math.round(i.altitude).toString(), 'ALT M', glass ? '#9cff9c' : '#ffffff', false);
    // 3 heading rose
    this.heading(480, cy, D / 2 - 6, i.heading);
    // 4 vertical speed
    const vs = Math.max(-30, Math.min(30, i.verticalSpeed));
    this.vsi(672, cy, D / 2 - 6, vs / 30, (i.verticalSpeed >= 0 ? '+' : '') + i.verticalSpeed.toFixed(1), 'V/S M/S');
    // bottom strip: throttle bar, engine lamps, stall
    const by = top + D + 8;
    const bh = H - by - 6;
    g.fillStyle = glass ? '#0d1218' : '#2a2c30';
    g.fillRect(6, by, W - 12, bh);
    g.fillStyle = '#c8d0d8';
    g.font = '700 26px "Segoe UI", Arial, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.fillText('THR', 16, by + bh / 2);
    const tx = 74;
    const tw = 230;
    g.fillStyle = '#1b232c';
    g.fillRect(tx, by + 12, tw, bh - 24);
    g.fillStyle = i.throttle > 0.95 ? '#ffb347' : '#5ce0a0';
    g.fillRect(tx, by + 12, tw * Math.max(0, Math.min(1, i.throttle)), bh - 24);
    g.fillStyle = '#ffffff';
    g.textAlign = 'right';
    g.fillText(`${Math.round(i.throttle * 100)}%`, tx + tw + 70, by + bh / 2);
    // engine lamps
    const n = i.engines.length;
    const ex0 = 400;
    const ew = Math.min(64, 200 / Math.max(1, n));
    for (let k = 0; k < n; k++) {
      const st = i.engines[k];
      const x = ex0 + k * (ew + 6);
      let col = '#2fd06a';
      let label = 'OK';
      if (st === 'fire') {
        col = blink ? '#ff3030' : '#7a1010';
        label = 'FIRE';
      } else if (st === 'destroyed' || st === 'detached') {
        col = '#4a4d52';
        label = 'OFF';
      }
      g.fillStyle = col;
      roundRect(g, x, by + 6, ew, bh - 12, 6);
      g.fill();
      g.fillStyle = st === 'ok' ? '#062010' : '#ffffff';
      g.textAlign = 'center';
      g.font = `800 ${n > 2 ? 15 : 18}px "Segoe UI", Arial, sans-serif`;
      g.fillText(`${k + 1}`, x + ew / 2, by + bh * 0.33);
      g.fillText(label, x + ew / 2, by + bh * 0.72);
    }
    // stall lamp
    g.fillStyle = i.stall ? (blink ? '#ff2a2a' : '#701010') : '#2a1414';
    roundRect(g, W - 150, by + 6, 138, bh - 12, 6);
    g.fill();
    g.fillStyle = i.stall ? '#ffffff' : '#5a3a3a';
    g.textAlign = 'center';
    g.font = '800 26px "Segoe UI", Arial, sans-serif';
    g.fillText('STALL', W - 81, by + bh / 2 + 1);
    this.texture.needsUpdate = true;
  }

  private bezel(x: number, y: number, r: number): void {
    const g = this.g;
    g.fillStyle = this.glass ? '#0a1016' : '#0c0c0d';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = this.glass ? 3 : 7;
    g.strokeStyle = this.glass ? '#24323f' : '#bdb6a2';
    g.stroke();
  }

  private dial(x: number, y: number, r: number, f: number, value: string, label: string, color: string, warn: boolean): void {
    const g = this.g;
    this.bezel(x, y, r);
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    // ticks
    g.strokeStyle = '#d8dde2';
    for (let t = 0; t <= 20; t++) {
      const a = a0 + ((a1 - a0) * t) / 20;
      const l = t % 5 === 0 ? 14 : 7;
      g.lineWidth = t % 5 === 0 ? 3 : 1.5;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * (r - 6), y + Math.sin(a) * (r - 6));
      g.lineTo(x + Math.cos(a) * (r - 6 - l), y + Math.sin(a) * (r - 6 - l));
      g.stroke();
    }
    // value arc (glass)
    const ff = Math.max(0, Math.min(1, f));
    if (this.glass) {
      g.strokeStyle = warn ? '#ff4040' : color;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(x, y, r - 3, a0, a0 + (a1 - a0) * ff);
      g.stroke();
    }
    // needle
    const a = a0 + (a1 - a0) * ff;
    g.strokeStyle = this.glass ? '#ffffff' : '#ffffff';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x - Math.cos(a) * 10, y - Math.sin(a) * 10);
    g.lineTo(x + Math.cos(a) * (r - 18), y + Math.sin(a) * (r - 18));
    g.stroke();
    g.fillStyle = '#9aa0a8';
    g.beginPath();
    g.arc(x, y, 6, 0, Math.PI * 2);
    g.fill();
    // numbers
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `800 ${value.length > 4 ? 34 : 40}px "Segoe UI", Arial, sans-serif`;
    g.fillText(value, x, y + r * 0.42);
    g.fillStyle = '#9fb0bf';
    g.font = '700 16px "Segoe UI", Arial, sans-serif';
    g.fillText(label, x, y - r * 0.38);
  }

  private vsi(x: number, y: number, r: number, f: number, value: string, label: string): void {
    const g = this.g;
    this.bezel(x, y, r);
    // 9 o'clock = 0, clockwise (up) = climb
    const ang = (v: number) => Math.PI + v * Math.PI * 0.75;
    g.strokeStyle = '#d8dde2';
    for (let t = -6; t <= 6; t++) {
      const a = ang(t / 6);
      g.lineWidth = t % 3 === 0 ? 3 : 1.5;
      const l = t % 3 === 0 ? 14 : 7;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * (r - 6), y + Math.sin(a) * (r - 6));
      g.lineTo(x + Math.cos(a) * (r - 6 - l), y + Math.sin(a) * (r - 6 - l));
      g.stroke();
    }
    if (this.glass && Math.abs(f) > 0.005) {
      g.strokeStyle = f >= 0 ? '#5ce0a0' : '#ffb347';
      g.lineWidth = 6;
      g.beginPath();
      if (f >= 0) g.arc(x, y, r - 3, ang(0), ang(f));
      else g.arc(x, y, r - 3, ang(f), ang(0));
      g.stroke();
    }
    const a = ang(f);
    g.strokeStyle = '#ffffff';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x - Math.cos(a) * 10, y - Math.sin(a) * 10);
    g.lineTo(x + Math.cos(a) * (r - 18), y + Math.sin(a) * (r - 18));
    g.stroke();
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '800 34px "Segoe UI", Arial, sans-serif';
    g.fillText(value, x + r * 0.15, y + r * 0.42);
    g.fillStyle = '#9fb0bf';
    g.font = '700 16px "Segoe UI", Arial, sans-serif';
    g.fillText(label, x + r * 0.12, y - r * 0.38);
  }

  private heading(x: number, y: number, r: number, hdg: number): void {
    const g = this.g;
    this.bezel(x, y, r);
    const rot = (-hdg * Math.PI) / 180;
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.strokeStyle = '#d8dde2';
    g.fillStyle = '#d8dde2';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = 0; d < 360; d += 10) {
      const a = (d * Math.PI) / 180 - Math.PI / 2;
      const major = d % 30 === 0;
      g.lineWidth = major ? 3 : 1.5;
      g.beginPath();
      g.moveTo(Math.cos(a) * (r - 6), Math.sin(a) * (r - 6));
      g.lineTo(Math.cos(a) * (r - (major ? 18 : 12)), Math.sin(a) * (r - (major ? 18 : 12)));
      g.stroke();
      if (d % 90 === 0) {
        g.save();
        g.translate(Math.cos(a) * (r - 34), Math.sin(a) * (r - 34));
        g.rotate(a + Math.PI / 2);
        g.font = '800 22px "Segoe UI", Arial, sans-serif';
        g.fillStyle = d === 0 ? '#ff8a78' : '#ffffff';
        g.fillText(['N', 'E', 'S', 'W'][d / 90], 0, 0);
        g.restore();
      }
    }
    g.restore();
    // lubber + aircraft symbol
    g.fillStyle = '#ffb347';
    g.beginPath();
    g.moveTo(x, y - r + 4);
    g.lineTo(x - 8, y - r + 18);
    g.lineTo(x + 8, y - r + 18);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '800 34px "Segoe UI", Arial, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(Math.round(((hdg % 360) + 360) % 360)).padStart(3, '0'), x, y + 4);
    g.fillStyle = '#9fb0bf';
    g.font = '700 16px "Segoe UI", Arial, sans-serif';
    g.fillText('HDG', x, y + r * 0.42);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
