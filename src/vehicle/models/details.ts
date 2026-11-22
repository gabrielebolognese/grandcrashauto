import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { SpoilerStyle } from '../CarBuild';
import { S, archCenterY, archRadius, evalRing, newRing, type BodyGrid, type RingOut, variantNormal } from './BodyGen';
import { R, LT, REGION_INFO } from './regions';
import type { CarSpec, QuadInfo } from './specs';
import { PLATE_UV } from './textures';
import { GeoAcc, MAT, gray, lerp, mtx, mtxLook, sweep, clamp, type MatCode, type RGB } from './util';
import { latheX } from './wheels';

/** Detail geometry generators. All output is in car space (root-local). */

const V3 = THREE.Vector3;
const MIRROR_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const CHROME: MatCode = MAT.chrome;
const SATIN_BLACK: RGB = gray(0.04);

export class Surface {
  readonly front: RingOut;
  readonly rear: RingOut;
  private ring = newRing();
  constructor(readonly s: CarSpec) {
    this.front = newRing();
    this.rear = newRing();
    evalRing(s, s.zFront, 0, this.front);
    evalRing(s, s.zRear, 0, this.rear);
  }

  /** Left-side point at z and fractional slot. */
  at(z: number, slot: number, out = new V3()): THREE.Vector3 {
    evalRing(this.s, z, 2, this.ring);
    const j = clamp(Math.floor(slot), 0, S - 2);
    const t = clamp(slot - j, 0, 1);
    const r = this.ring;
    return out.set(lerp(r.x[j], r.x[j + 1], t), lerp(r.y[j], r.y[j + 1], t), lerp(r.z[j], r.z[j + 1], t));
  }

  /** Outward normal at (z, slot) on the left side. */
  normal(z: number, slot: number): THREE.Vector3 {
    const p = this.at(z, slot);
    const ps = this.at(z, slot + 0.05).sub(p);
    const pz = this.at(z + 0.01, slot).sub(p);
    return ps.cross(pz).normalize();
  }

  /** Point on an end cap at height y and lateral fraction xf (-1..1, + = left). */
  cap(front: boolean, y: number, xf: number, out = new V3()): THREE.Vector3 {
    const r = front ? this.front : this.rear;
    const e = front ? this.s.front : this.s.rear;
    let xmax = 1e-6;
    for (let j = 0; j < S; j++) xmax = Math.max(xmax, r.x[j]);
    let xe = r.x[12];
    let z = r.z[12];
    for (let j = 3; j < 12; j++) {
      if (y <= r.y[j + 1] || j === 11) {
        const t = clamp((y - r.y[j]) / Math.max(1e-6, r.y[j + 1] - r.y[j]), 0, 1);
        xe = lerp(r.x[j], r.x[j + 1], t);
        z = lerp(r.z[j], r.z[j + 1], t);
        break;
      }
    }
    const sign = front ? 1 : -1;
    const cf = Math.abs(xf);
    return out.set(xf * xe, y, z + sign * e.bulge * (1 - cf * cf) * (xe / xmax));
  }

  capNormal(front: boolean, y: number, xf: number): THREE.Vector3 {
    const a = this.cap(front, y, xf);
    const b = this.cap(front, y + 0.01, xf).sub(a);
    const c = this.cap(front, y, xf - 0.02).sub(a);
    const n = c.cross(b).normalize();
    if ((front && n.z < 0) || (!front && n.z > 0)) n.negate();
    return n;
  }

  /** Cap half-width at height y. */
  capHalfW(front: boolean, y: number): number {
    return this.cap(front, y, 1).x;
  }
}

function ccw(p: [number, number][]): [number, number][] {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a < 0 ? p.slice().reverse() : p;
}

// ───────────────────────────── exterior details ─────────────────────────────

export function addMirror(sf: Surface, accL: GeoAcc, accR: GeoAcc): void {
  const s = sf.s;
  const z = s.details.mirrorZ;
  const base = sf.at(z, 15);
  const tmp = new GeoAcc();
  const c = new V3(base.x + 0.13, base.y + 0.085, z - 0.03);
  const shell = new RoundedBoxGeometry(0.18, 0.105, 0.085, 2, 0.038);
  // taper the housing toward the front (aero teardrop)
  const sp = shell.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const zz = sp.getZ(i);
    const k = zz > 0 ? 1 - (zz / 0.0425) * 0.18 : 1;
    sp.setXYZ(i, sp.getX(i) * k, sp.getY(i) * k, zz);
  }
  shell.computeVertexNormals();
  tmp.add(shell, { matrix: mtx(c.x, c.y, c.z, 0, -0.06, 0), color: gray(1) });
  shell.dispose();
  const glass = new RoundedBoxGeometry(0.16, 0.085, 0.01, 1, 0.004);
  tmp.add(glass, { matrix: mtx(c.x, c.y, c.z - 0.041, 0, -0.06, 0), color: gray(0.02) });
  glass.dispose();
  const stalk = new RoundedBoxGeometry(0.1, 0.03, 0.05, 1, 0.01);
  tmp.add(stalk, { matrix: mtx(base.x + 0.045, base.y + 0.045, z - 0.02, 0, 0, -0.45), color: gray(1) });
  stalk.dispose();
  accL.append(tmp);
  const g = tmp.toGeometry('detail');
  accR.add(g, { matrix: MIRROR_X });
  g.dispose();
}

export function addHandles(sf: Surface, accL: GeoAcc, accR: GeoAcc): void {
  const s = sf.s;
  const z = s.details.handleZ;
  const p = sf.at(z, s.details.handleSlot);
  const n = sf.normal(z, s.details.handleSlot);
  const h = new RoundedBoxGeometry(0.02, 0.026, 0.15, 2, 0.009);
  const pos = p.clone().addScaledVector(n, 0.006);
  const m = mtxLook(pos, new V3(0, 0, 1), n);
  accL.add(h, { matrix: m, color: gray(0.035) });
  accR.add(h, { matrix: MIRROR_X.clone().multiply(m), color: gray(0.035) });
  h.dispose();
}

/** Horizontal bar across the front cap at height y (|xf| ≤ cf), profile (outward, up) in metres. */
function capBar(sf: Surface, front: boolean, y: number, cf: number, prof: [number, number][], n = 12): THREE.BufferGeometry {
  const path: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const xf = cf - (2 * cf * i) / n;
    path.push(sf.cap(front, y, front ? xf : -xf));
  }
  // path runs from +X to -X on the front (tangent -X → side = up × t = +Z outward)
  return sweep(path, ccw(prof), { closed: true, capStart: true, capEnd: true });
}

function capPost(sf: Surface, front: boolean, xf: number, y0: number, y1: number, prof: [number, number][]): THREE.BufferGeometry {
  const path: THREE.Vector3[] = [];
  for (let i = 0; i <= 4; i++) path.push(sf.cap(front, lerp(y0, y1, i / 4), xf));
  return sweep(path, ccw(prof), { closed: true, capStart: true, capEnd: true, up: new V3(0, 0, front ? 1 : -1) });
}

export function addGrille(sf: Surface, trim: GeoAcc): void {
  const s = sf.s;
  const d = s.details;
  const ring = sf.front;
  const y0 = ring.y[d.grilleBands[0]];
  const y1 = ring.y[d.grilleBands[1]];
  const h = y1 - y0;
  const cf = d.grilleCf * 0.96;
  const add = (g: THREE.BufferGeometry, color: RGB, mat: MatCode) => {
    trim.add(g, { color, mat });
    g.dispose();
  };
  switch (d.grille) {
    case 'blades':
      for (const f of [0.3, 0.7]) add(capBar(sf, true, y0 + h * f, cf, [[-0.01, -0.006], [0.012, -0.006], [0.012, 0.006], [-0.01, 0.006]]), gray(0.25), [1, 0.25, 0, 0]);
      break;
    case 'eggcrate': {
      for (const f of [0.22, 0.5, 0.78]) add(capBar(sf, true, y0 + h * f, cf, [[-0.01, -0.005], [0.008, -0.005], [0.008, 0.005], [-0.01, 0.005]]), gray(0.85), CHROME);
      for (let i = 0; i <= 12; i++) {
        const xf = -cf + (2 * cf * i) / 12;
        if (Math.abs(Math.abs(xf) - 0.58) < 0.09 || Math.abs(Math.abs(xf) - 0.8) < 0.09) continue; // lamp pods
        add(capPost(sf, true, xf, y0 + 0.01, y1 - 0.01, [[-0.004, -0.012], [0.004, -0.012], [0.004, 0.006], [-0.004, 0.006]]), gray(0.08), MAT.satin);
      }
      // chrome surround
      add(capBar(sf, true, y1 - 0.004, d.grilleCf, [[-0.012, -0.007], [0.012, -0.007], [0.012, 0.007], [-0.012, 0.007]], 16), gray(0.9), CHROME);
      add(capBar(sf, true, y0 + 0.004, d.grilleCf, [[-0.012, -0.007], [0.012, -0.007], [0.012, 0.007], [-0.012, 0.007]], 16), gray(0.9), CHROME);
      break;
    }
    case 'bars':
      add(capBar(sf, true, y0 + h * 0.5, cf, [[-0.01, -0.012], [0.014, -0.01], [0.014, 0.01], [-0.01, 0.012]]), gray(0.06), MAT.satin);
      break;
    case 'slats':
      for (let i = 0; i <= 8; i++) {
        const xf = -cf + (2 * cf * i) / 8;
        add(capPost(sf, true, xf, y0 + 0.015, y1 - 0.015, [[-0.012, -0.03], [0.012, -0.03], [0.012, 0.012], [-0.012, 0.012]]), gray(0.22), [0.9, 0.3, 0, 0]);
      }
      add(capBar(sf, true, y0 + h * 0.5, cf, [[-0.006, -0.008], [0.016, -0.008], [0.016, 0.008], [-0.006, 0.008]]), gray(0.85), CHROME);
      break;
  }
}

/** Round lamp pods (muscle): lens in the lights mesh, chrome bezel in trim. Returns lamp centres. */
export function addRoundLamps(sf: Surface, trim: GeoAcc, lights: GeoAcc): THREE.Vector3[] {
  const d = sf.s.details;
  const out: THREE.Vector3[] = [];
  if (!d.roundLamps) return out;
  const ring = sf.front;
  const y = (ring.y[d.grilleBands[0]] + ring.y[d.grilleBands[1]]) / 2 + d.roundLamps.y;
  const r = d.roundLamps.r;
  const lens = latheX([
    [0.001, 0.018],
    [r * 0.5, 0.015],
    [r * 0.9, 0.006],
    [r, 0.0],
  ], 20);
  const bezel = latheX([
    [r * 0.98, 0.002],
    [r * 1.08, 0.014],
    [r * 1.2, 0.006],
    [r * 1.22, -0.012],
  ], 20);
  const cup = latheX([
    [0.001, -0.03],
    [r * 0.7, -0.026],
    [r * 0.98, -0.002],
  ], 16);
  for (const cf of d.roundLamps.cfs) {
    for (const side of [1, -1]) {
      const p = sf.cap(true, y, side * cf);
      const n = sf.capNormal(true, y, side * cf);
      const m = mtxLook(p, n).multiply(new THREE.Matrix4().makeRotationY(-Math.PI / 2));
      lights.add(lens, { matrix: m, color: [0.92, 0.94, 0.96], mat: [0.6, 0.08, 0, LT.HEAD] });
      trim.add(bezel, { matrix: m, color: gray(0.9), mat: CHROME });
      trim.add(cup, { matrix: m, color: gray(0.8), mat: CHROME });
      out.push(p.clone().addScaledVector(n, 0.02));
    }
  }
  lens.dispose();
  bezel.dispose();
  cup.dispose();
  return out;
}

export interface PlateInfo {
  start: number;
  count: number;
  geo: THREE.BufferGeometry;
}

/** Licence plate (atlas-mapped face + dark backing) into `acc`; returns its vertex range for collapse-on-detach. */
export function addPlate(sf: Surface, acc: GeoAcc, front: boolean, y: number): PlateInfo {
  const start = acc.count;
  const p = sf.cap(front, y, 0);
  const n = sf.capNormal(front, y, 0);
  const tmp = new GeoAcc();
  const back = new RoundedBoxGeometry(0.42, 0.135, 0.012, 1, 0.006);
  const m = mtxLook(p.clone().addScaledVector(n, 0.008), n);
  tmp.add(back, { matrix: m, color: gray(0.05), mat: MAT.satin });
  back.dispose();
  const face = new THREE.PlaneGeometry(0.4, 0.125);
  // plane faces +Z → our matrix maps +Z to n; uv: plane uv (0..1) → atlas rect (flipY false: v=0 is the top row)
  const uv = face.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  tmp.add(face, { matrix: mtxLook(p.clone().addScaledVector(n, 0.0145), n), color: gray(1), mat: [0.1, 0.35, 0, 0], uvRect: PLATE_UV });
  face.dispose();
  acc.append(tmp);
  return { start, count: tmp.count, geo: tmp.toGeometry('detail') };
}

/** Exhaust tips; returns outlet centres (pointing -Z). */
export function addExhausts(sf: Surface, trim: GeoAcc): THREE.Vector3[] {
  const d = sf.s.details;
  const pts: THREE.Vector3[] = [];
  const xs = d.exhaust === 'single' ? [d.exhaustX] : [d.exhaustX, -d.exhaustX];
  const square = d.exhaust === 'twinSquare';
  const r = square ? 0.048 : d.exhaust === 'dualSides' ? 0.042 : 0.038;
  const segs = square ? 4 : 12;
  const tube = latheX([
    [r * 0.82, 0.1],
    [r * 0.82, -0.06],
    [r, -0.065],
    [r * 1.02, -0.05],
    [r, 0.12],
  ], segs, { phase: square ? Math.PI / 4 : 0 });
  const inner = new THREE.CircleGeometry(r * 0.8, segs, square ? Math.PI / 4 : 0);
  for (const x of xs) {
    const xf = x / Math.max(0.2, sf.capHalfW(false, d.exhaustY));
    const p = sf.cap(false, d.exhaustY, clamp(xf, -0.95, 0.95));
    const tip = new V3(x, d.exhaustY, p.z - 0.035);
    // tube axis X → -Z
    const m = mtx(tip.x, tip.y, tip.z + 0.065, 0, Math.PI / 2, 0);
    trim.add(tube, { matrix: m, color: gray(0.9), mat: CHROME });
    trim.add(inner, { matrix: mtx(tip.x, tip.y, tip.z + 0.05, 0, Math.PI, 0), color: gray(0.02), mat: MAT.rubber });
    pts.push(tip);
  }
  tube.dispose();
  inner.dispose();
  return pts;
}

export function addWipers(sf: Surface, trim: GeoAcc): void {
  const c = sf.s.cabin;
  const z = c.zCowl - 0.06;
  const p = sf.at(z, 21);
  const arm = new RoundedBoxGeometry(0.5, 0.012, 0.016, 1, 0.004);
  for (const x0 of [0.3, -0.22]) {
    trim.add(arm, { matrix: mtx(x0, p.y + 0.012, z - 0.01, 0.35, 0, x0 > 0 ? 0.05 : -0.05), color: gray(0.03), mat: MAT.satin });
  }
  arm.dispose();
}

export function addRoofRails(sf: Surface, trim: GeoAcc): void {
  const c = sf.s.cabin;
  const z0 = c.zRoofRear + 0.12;
  const z1 = c.zWsTop - 0.05;
  for (const side of [1, -1]) {
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const z = lerp(z1, z0, i / 10);
      const p = sf.at(z, 19.6);
      path.push(new V3(side * (p.x - 0.01), p.y + 0.06, z));
    }
    const rail = sweep(path, ccw([[-0.014, -0.012], [0.014, -0.012], [0.016, 0.006], [0, 0.014], [-0.016, 0.006]]), { closed: true, capStart: true, capEnd: true });
    trim.add(rail, { color: gray(0.06), mat: [0.6, 0.3, 0, 0] });
    rail.dispose();
    const foot = new RoundedBoxGeometry(0.03, 0.07, 0.09, 1, 0.01);
    for (const t of [0.02, 0.5, 0.98]) {
      const z = lerp(z1, z0, t);
      const p = sf.at(z, 19.6);
      trim.add(foot, { matrix: mtx(side * (p.x - 0.01), p.y + 0.03, z), color: gray(0.05), mat: MAT.satin });
    }
    foot.dispose();
  }
}

export function addAntenna(sf: Surface, trim: GeoAcc): void {
  const s = sf.s;
  const z = s.cabin.zRoofRear + 0.06;
  const p = sf.at(z, 22);
  const fin = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  trim.add(fin, { matrix: mtx(0, p.y - 0.004, z, 0, 0, 0, 0.022, 0.038, 0.075), color: gray(0.03), mat: MAT.gloss });
  fin.dispose();
}

/** Satin black wheel-arch flares (SUV). */
export function addArchFlares(sf: Surface, trim: GeoAcc): void {
  const s = sf.s;
  const Ra = archRadius(s) + 0.02;
  const yA = archCenterY(s);
  const left = new GeoAcc();
  for (const az of [s.axleF, s.axleR]) {
    const path: THREE.Vector3[] = [];
    const sill = s.sill(az);
    const xAt = (z: number, y: number) => {
      // nominal side x at height y (outside the arch)
      const r = newRing();
      evalRing(s, z, 2, r);
      for (let k = 4; k < 12; k++) if (y <= r.y[k + 1]) return lerp(r.x[k], r.x[k + 1], clamp((y - r.y[k]) / Math.max(1e-6, r.y[k + 1] - r.y[k]), 0, 1));
      return r.x[12];
    };
    const pushP = (z: number, y: number) => path.push(new V3(xAt(z, y) + 0.004, y, z));
    pushP(az + Ra, sill + 0.01);
    for (let i = 0; i <= 16; i++) {
      const a = (i / 16) * Math.PI;
      pushP(az + Ra * Math.cos(a), yA + Ra * Math.sin(a));
    }
    pushP(az - Ra, sill + 0.01);
    const g = sweep(path, ccw([[-0.045, -0.002], [0.045, -0.002], [0.04, 0.02], [-0.04, 0.02]]), { closed: true, capStart: true, capEnd: true, up: new V3(1, 0, 0) });
    left.add(g);
    g.dispose();
  }
  const lg = left.toGeometry('plain');
  trim.add(lg, { color: gray(0.045), mat: [0, 0.7, 0, 0] });
  trim.add(lg, { matrix: MIRROR_X, color: gray(0.045), mat: [0, 0.7, 0, 0] });
  lg.dispose();
}

// ───────────────────────────── interior & bays ─────────────────────────────

const INTERIOR: Record<string, { shell: RGB; seat: RGB; accent: RGB }> = {
  coupe: { shell: [0.05, 0.048, 0.05], seat: [0.2, 0.035, 0.035], accent: [0.06, 0.06, 0.065] },
  muscle: { shell: [0.08, 0.065, 0.055], seat: [0.42, 0.25, 0.14], accent: [0.1, 0.08, 0.07] },
  hatch: { shell: [0.075, 0.08, 0.09], seat: [0.18, 0.22, 0.28], accent: [0.1, 0.11, 0.13] },
  suv: { shell: [0.09, 0.085, 0.08], seat: [0.38, 0.33, 0.27], accent: [0.11, 0.1, 0.09] },
};

export function addInterior(sf: Surface, grid: BodyGrid, trim: GeoAcc): void {
  const s = sf.s;
  const pal = INTERIOR[s.id];
  const c = s.cabin;
  const hatchback = s.trunk.hatch;
  const zA = hatchback ? s.zRear + 0.12 : Math.max(s.zRear + 0.2, c.zBl + 0.05);
  const zB = c.zCowl - 0.02;
  // Coarse inner shell: stations from the grid (keeping region breaks), subset of slots.
  const keys = new Set<number>([...s.breaks, c.zCowl, c.zWsTop, c.zRoofRear, c.zBl].map((z) => Math.round(z * 1000)));
  const zs: number[] = [];
  for (const st of grid.stations) {
    if (st.z < zA - 1e-6 || st.z > zB + 1e-6) continue;
    const last = zs[zs.length - 1];
    const isKey = keys.has(Math.round(st.z * 1000));
    if (last === undefined || st.z - last > 0.14 || (isKey && st.z - last > 0.02)) zs.push(st.z);
  }
  if (zs[zs.length - 1] < zB - 0.02) zs.push(zB);
  const slots = [5, 9, 12, 15, 17, 19, 22];
  const rings = zs.map((z) => {
    const r = newRing();
    evalRing(s, z, 0, r);
    return r;
  });
  const inset = 0.035;
  const pt = (r: RingOut, j: number, side: number): THREE.Vector3 => {
    const a = Math.max(0, j - 1);
    const b = Math.min(S - 1, j + 1);
    let tx = r.x[b] - r.x[a];
    let ty = r.y[b] - r.y[a];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    // outward in-plane normal on the left side = (ty, -tx)
    return new V3(side * (r.x[j] - ty * inset), r.y[j] + tx * inset, r.z[j]);
  };
  const info: QuadInfo = { kind: 0, band: 0, side: 1, z: 0, y: 0, x: 0, cf: 1, H: 0 };
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < slots.length - 1; k++) {
      for (const side of [1, -1] as const) {
        info.band = slots[k];
        info.side = side;
        info.z = (zs[i] + zs[i + 1]) / 2;
        info.H = (rings[i].H + rings[i + 1].H) / 2;
        info.y = (rings[i].y[slots[k]] + rings[i].y[slots[k + 1]]) / 2;
        const reg = s.classify(info);
        if (reg === R.GLASS) continue;
        const a = pt(rings[i], slots[k], side);
        const b = pt(rings[i], slots[k + 1], side);
        const cc = pt(rings[i + 1], slots[k + 1], side);
        const d = pt(rings[i + 1], slots[k], side);
        quad(trim, side > 0 ? [a, d, cc, b] : [a, b, cc, d], pal.shell);
      }
    }
  }
  const rMid = rings[Math.floor(rings.length / 2)];
  const floorY = s.sill(0) + 0.06;
  const wIn = rMid.x[9] - 0.06;
  // floor
  quad(trim, [new V3(wIn, floorY, zA), new V3(-wIn, floorY, zA), new V3(-wIn, floorY, zB), new V3(wIn, floorY, zB)], pal.accent);
  const belt = s.belt(c.zCowl - 0.3);
  // rear bulkhead + parcel shelf (notch/fastback) or cargo floor (hatch)
  if (!hatchback) {
    const zr = s.details.cabinRear;
    const rr = newRing();
    evalRing(s, zr, 0, rr);
    const wr = rr.x[12] - 0.05;
    const yb = s.belt(zr) - 0.02;
    quad(trim, [new V3(wr, floorY, zr), new V3(wr, yb, zr), new V3(-wr, yb, zr), new V3(-wr, floorY, zr)], pal.shell);
    quad(trim, [new V3(wr, yb, zr), new V3(wr, yb, zA), new V3(-wr, yb, zA), new V3(-wr, yb, zr)], pal.accent);
  } else {
    const yc = s.sill(s.zRear + 0.3) + 0.25;
    quad(trim, [new V3(wIn, yc, zA), new V3(-wIn, yc, zA), new V3(-wIn, yc, s.details.cabinRear + 0.6), new V3(wIn, yc, s.details.cabinRear + 0.6)], pal.accent);
  }
  // dashboard
  const cw = c.cabinW(c.zCowl) - 0.06;
  const dash = new RoundedBoxGeometry(cw * 2, 0.24, 0.42, 1, 0.06);
  trim.add(dash, { matrix: mtx(0, belt - 0.1, c.zCowl - 0.22), color: pal.shell, mat: MAT.plastic });
  dash.dispose();
  const hood = new RoundedBoxGeometry(0.34, 0.07, 0.16, 1, 0.03);
  trim.add(hood, { matrix: mtx(0.37, belt + 0.02, c.zCowl - 0.42), color: gray(0.03), mat: MAT.plastic });
  hood.dispose();
  // steering wheel + column
  const sw = new THREE.TorusGeometry(0.175, 0.017, 5, 14);
  const swZ = c.zCowl - 0.62;
  const swY = belt - 0.02;
  trim.add(sw, { matrix: mtx(0.37, swY, swZ, -0.42, 0, 0), color: gray(0.03), mat: MAT.plastic });
  sw.dispose();
  const hub = new THREE.CylinderGeometry(0.05, 0.06, 0.05, 10);
  trim.add(hub, { matrix: mtx(0.37, swY, swZ, -0.42 + Math.PI / 2, 0, 0), color: pal.accent, mat: MAT.satin });
  hub.dispose();
  const col = new THREE.CylinderGeometry(0.03, 0.035, 0.32, 8);
  trim.add(col, { matrix: mtx(0.37, swY + 0.04, swZ + 0.17, -0.42 + Math.PI / 2, 0, 0), color: gray(0.03), mat: MAT.plastic });
  col.dispose();
  // seats
  const seatZ = c.zCowl - (s.id === 'coupe' ? 0.98 : 1.08) + (s.id === 'suv' ? 0.06 : 0);
  const seatY = floorY + (s.id === 'suv' ? 0.22 : s.id === 'coupe' ? 0.05 : 0.16);
  const cushion = new RoundedBoxGeometry(0.48, 0.12, 0.5, 1, 0.045);
  const back = new RoundedBoxGeometry(0.48, 0.62, 0.13, 1, 0.05);
  const head = new RoundedBoxGeometry(0.26, 0.16, 0.09, 1, 0.035);
  const seat = (x: number, z: number, w = 1, hs = 1) => {
    trim.add(cushion, { matrix: mtx(x, seatY, z, 0, 0, 0, w, 1, 1), color: pal.seat, mat: MAT.fabric });
    trim.add(back, { matrix: mtx(x, seatY + 0.3 * hs, z - 0.27, -0.24, 0, 0, w, hs, 1), color: pal.seat, mat: MAT.fabric });
    if (w === 1) trim.add(head, { matrix: mtx(x, seatY + 0.68, z - 0.36, -0.24, 0, 0), color: pal.seat, mat: MAT.fabric });
  };
  seat(0.37, seatZ);
  seat(-0.37, seatZ);
  if (s.details.seats4) {
    const rz = seatZ - 0.82;
    // keep the bench back under the roof / backlight line
    const roofY = s.belt(rz - 0.3) + s.cabin.H(rz - 0.3) - 0.12;
    const hs = clamp((roofY - seatY - 0.06) / 0.62, 0.45, 1);
    if (rz > zA + 0.25) seat(0, rz, 2.6, hs);
  }
  cushion.dispose();
  back.dispose();
  head.dispose();
}

function quad(acc: GeoAcc, p: THREE.Vector3[], color: RGB, mat: MatCode = MAT.plastic): void {
  const n = new V3().subVectors(p[1], p[0]).cross(new V3().subVectors(p[2], p[0])).normalize();
  const i = p.map((v) => acc.vertex(v.x, v.y, v.z, n.x, n.y, n.z, color, undefined, undefined, mat));
  acc.tri(i[0], i[1], i[2]);
  acc.tri(i[0], i[2], i[3]);
}

/**
 * Dark backing under detachable panels (visible through panel gaps and when the panel is gone): the panel's quads
 * plus a 1-quad ring around them, pushed inward. Doors only get the frame ring (so the cabin shows when detached).
 */
export function addBays(grid: BodyGrid, trim: GeoAcc): void {
  const spec = grid.spec;
  const panels: [number[], number][] = [
    [[R.HOOD, R.HOOD_BLACK], 0.04],
    [[R.TRUNK], 0.04],
    [[R.BUMPER_F, R.BUMPER_F_BLACK], 0.035],
    [[R.BUMPER_R, R.BUMPER_R_BLACK], 0.035],
    [[R.DOOR_L], 0.03],
    [[R.DOOR_R], 0.03],
  ];
  const vq = new Map<number, number[]>();
  for (let t = 0; t < grid.quadCount; t++) {
    for (let c = 0; c < 4; c++) {
      const v = grid.qv[t * 4 + c];
      let l = vq.get(v);
      if (!l) vq.set(v, (l = []));
      l.push(t);
    }
  }
  const n = [0, 0, 0];
  const col = gray(0.03);
  const P = grid.P;
  for (const [regs, depth] of panels) {
    const inPanel = (t: number) => regs.includes(grid.qreg[t]);
    const quads: number[] = [];
    const boundaryV = new Set<number>();
    for (let t = 0; t < grid.quadCount; t++) {
      if (!inPanel(t)) continue;
      let boundary = false;
      for (let c = 0; c < 4; c++) {
        const v = grid.qv[t * 4 + c];
        for (const o of vq.get(v)!) if (!inPanel(o) && grid.qreg[o] !== R.SKIP) {
          boundary = true;
          boundaryV.add(v);
        }
      }
      if (boundary) quads.push(t);
    }
    if (!quads.length) continue;
    const map = new Map<number, number>();
    for (const t of quads) {
      const ids: number[] = [];
      for (let c = 0; c < 4; c++) {
        const v = grid.qv[t * 4 + c];
        let id = map.get(v);
        if (id === undefined) {
          variantNormal(grid, v, 0, n);
          let x = P[v * 3] - n[0] * depth;
          let y = P[v * 3 + 1] - n[1] * depth;
          let z = P[v * 3 + 2] - n[2] * depth;
          if (boundaryV.has(v)) {
            // push boundary vertices away from the panel (tangentially) so the backing spans the whole gap
            let cx = 0, cy = 0, cz = 0, k = 0;
            for (const o of vq.get(v)!) {
              if (!inPanel(o)) continue;
              for (let cc = 0; cc < 4; cc++) {
                const w = grid.qv[o * 4 + cc];
                cx += P[w * 3];
                cy += P[w * 3 + 1];
                cz += P[w * 3 + 2];
                k++;
              }
            }
            let dx = P[v * 3] - cx / k, dy = P[v * 3 + 1] - cy / k, dz = P[v * 3 + 2] - cz / k;
            const dn = dx * n[0] + dy * n[1] + dz * n[2];
            dx -= dn * n[0];
            dy -= dn * n[1];
            dz -= dn * n[2];
            const l = Math.hypot(dx, dy, dz);
            if (l > 1e-5) {
              x += (dx / l) * 0.03;
              y += (dy / l) * 0.03;
              z += (dz / l) * 0.03;
            }
          }
          id = trim.vertex(x, y, z, n[0], n[1], n[2], col, undefined, undefined, MAT.rubber);
          map.set(v, id);
        }
        ids.push(id);
      }
      trim.tri(ids[0], ids[1], ids[2]);
      trim.tri(ids[0], ids[2], ids[3]);
    }
  }
  // engine bay floor + block under the hood (only seen when the hood is gone)
  const hz = (spec.hood.z0 + spec.hood.z1) / 2;
  const sf = new Surface(spec);
  let hoodLow = Infinity;
  for (let k = 0; k <= 6; k++) hoodLow = Math.min(hoodLow, sf.at(lerp(spec.hood.z0 + 0.05, spec.hood.z1 - 0.1, k / 6), 22).y);
  {
    const y = hoodLow - 0.3;
    const w = spec.halfW(hz) - 0.14;
    quad(trim, [new V3(w, y, spec.hood.z0), new V3(-w, y, spec.hood.z0), new V3(-w, y, spec.hood.z1), new V3(w, y, spec.hood.z1)], gray(0.03), MAT.rubber);
  }
  if (spec.id !== 'coupe') {
    const blk = new RoundedBoxGeometry(0.66, 0.2, Math.max(0.4, (spec.hood.z1 - spec.hood.z0) * 0.5), 1, 0.04);
    trim.add(blk, { matrix: mtx(0, hoodLow - 0.18, hz - 0.05), color: gray(0.18), mat: MAT.metal });
    blk.dispose();
  }
}

// ───────────────────────────── body kit ─────────────────────────────

/** Front splitter: slab following the front plan outline at the sill. */
export function buildSplitter(sf: Surface, hi: boolean): THREE.BufferGeometry {
  const s = sf.s;
  const Ra = archRadius(s);
  const z0 = s.axleF + Ra + 0.02;
  const path: THREE.Vector3[] = [];
  const n = hi ? 8 : 3;
  const y = s.sill(s.zFront - 0.1) + 0.005;
  const r = newRing();
  for (let i = 0; i <= n; i++) {
    const z = lerp(z0, s.zFront - 0.002, i / n);
    evalRing(s, z, 2, r);
    path.push(new V3(r.x[4] - 0.01, y, r.z[4]));
  }
  const capN = hi ? 10 : 4;
  for (let i = 1; i < capN; i++) {
    const xf = 1 - (2 * i) / capN;
    const p = sf.cap(true, sf.front.y[4], xf);
    path.push(new V3(p.x, y, p.z + 0.0));
  }
  const left = path.slice(0, n + 1).reverse().map((p) => new V3(-p.x, p.y, p.z));
  path.push(...left);
  const d = s.kit.splitterDepth;
  return sweep(path, ccw([[-0.08, -0.016], [d, -0.016], [d + 0.008, -0.004], [d, 0.006], [-0.08, 0.006]]), { closed: true, capStart: true, capEnd: true });
}

/** Side skirts between the arches (left; mirror for right). */
export function buildSkirts(sf: Surface, hi: boolean): THREE.BufferGeometry {
  const s = sf.s;
  const Ra = archRadius(s);
  const z0 = s.axleR + Ra + 0.025;
  const z1 = s.axleF - Ra - 0.025;
  const r = newRing();
  const path: THREE.Vector3[] = [];
  const n = hi ? 10 : 3;
  for (let i = 0; i <= n; i++) {
    const z = lerp(z0, z1, i / n);
    evalRing(s, z, 2, r);
    path.push(new V3(r.x[4] - 0.012, r.y[4] - 0.004, z));
  }
  const prof = ccw([[-0.03, -0.045], [0.026, -0.04], [0.038, -0.01], [0.03, 0.04], [-0.02, 0.07]]);
  const left = sweep(path, prof, { closed: true, capStart: true, capEnd: true });
  const acc = new GeoAcc();
  const lowerBlack = (p: THREE.Vector3, out: number[]) => {
    const v = p.y < s.sill(p.z) - 0.025 ? 0.03 : 1;
    out[0] = out[1] = out[2] = v;
  };
  acc.add(left, { colorFn: lowerBlack });
  acc.add(left, { matrix: MIRROR_X, colorFn: lowerBlack });
  left.dispose();
  return acc.toGeometry('paint');
}

/** Hood scoop (paint with a black intake mouth). */
export function buildScoop(sf: Surface, hi: boolean): THREE.BufferGeometry {
  const s = sf.s;
  const { z0, z1, w, h } = s.kit.scoop;
  const acc = new GeoAcc();
  const prof: [number, number][] = [
    [1, 0],
    [0.92, 0.6],
    [0.7, 0.95],
    [0.35, 1],
    [-0.35, 1],
    [-0.7, 0.95],
    [-0.92, 0.6],
    [-1, 0],
  ];
  const n = hi ? 10 : 4;
  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const z = lerp(z0, z1, t);
    const base = sf.at(z, 22).y - 0.006;
    const hh = h * Math.pow(Math.min(1, t / 0.85), 0.8);
    const ww = w * (0.75 + 0.25 * t);
    rings.push(prof.map(([px, py]) => new V3(px * ww, base + py * hh, z)));
  }
  const P = prof.length;
  const ids: number[][] = [];
  for (const ring of rings) ids.push(ring.map((p) => acc.vertex(p.x, p.y, p.z, 0, 1, 0, gray(1))));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < P - 1; j++) {
      const a = ids[i][j], b = ids[i][j + 1], c = ids[i + 1][j + 1], d = ids[i + 1][j];
      acc.tri(a, c, b);
      acc.tri(a, d, c);
    }
  }
  // black mouth at the front, recessed
  const last = rings[n];
  const zf = last[0].z;
  const mouth = last.map((p) => new V3(p.x * 0.86, lerp(last[0].y, p.y, 0.86), zf - 0.03));
  const m = mouth.map((p) => acc.vertex(p.x, p.y, p.z, 0, 0, 1, gray(0.02)));
  const outer = last.map((p) => acc.vertex(p.x, p.y, p.z, 0, 0, 1, gray(0.02)));
  for (let j = 0; j < P - 1; j++) {
    acc.tri(outer[j], outer[j + 1], m[j + 1]);
    acc.tri(outer[j], m[j + 1], m[j]);
  }
  for (let j = 1; j < P - 1; j++) acc.tri(m[0], m[j], m[j + 1]);
  const g = acc.toGeometry('paint');
  g.computeVertexNormals();
  return g;
}

/** Rear spoiler for a style; mounted on the deck (coupe/muscle) or the roof edge (hatch/SUV). */
export function buildSpoiler(sf: Surface, style: SpoilerStyle, hi: boolean): THREE.BufferGeometry | null {
  if (style === 'none') return null;
  const s = sf.s;
  const z = s.kit.spoilerZ;
  const roof = s.kit.spoilerRoof;
  const r = newRing();
  evalRing(s, z, 0, r);
  // line across the mounting surface (left→right)
  const j0 = roof ? 17.6 : 12.2;
  const line: THREE.Vector3[] = [];
  const n = hi ? 12 : 4;
  const at = (slot: number) => {
    const j = Math.min(S - 2, Math.floor(slot));
    const t = slot - j;
    return new V3(lerp(r.x[j], r.x[j + 1], t), lerp(r.y[j], r.y[j + 1], t), lerp(r.z[j], r.z[j + 1], t));
  };
  for (let i = 0; i <= n; i++) {
    const slot = lerp(j0, 22, i / n);
    line.push(at(slot));
  }
  const full = line
    .slice()
    .reverse()
    .concat(line.slice(1).map((p) => new V3(-p.x, p.y, p.z)));
  // full runs +X → -X : tangent -X → side = up × t = +Z (forward); profile (forward, up)
  const acc = new GeoAcc();
  const black = gray(0.03);
  if (style === 'lip') {
    const prof = roof ? [[0.02, -0.004], [-0.08, -0.012], [-0.1, 0.004], [0.0, 0.01]] : [[0.03, -0.002], [-0.04, -0.002], [-0.055, 0.03], [-0.01, 0.016]];
    const g = sweep(full, ccw(prof as [number, number][]), { closed: true, capStart: true, capEnd: true });
    acc.add(g, { color: gray(1) });
    g.dispose();
  } else if (style === 'ducktail') {
    const prof = roof ? [[0.03, -0.004], [-0.16, -0.03], [-0.19, 0.0], [-0.02, 0.022]] : [[0.08, -0.002], [-0.09, -0.002], [-0.12, 0.075], [-0.05, 0.06], [0.04, 0.02]];
    const g = sweep(full, ccw(prof as [number, number][]), { closed: true, capStart: true, capEnd: true, scale: (i) => 0.75 + 0.25 * Math.sin((i / (full.length - 1)) * Math.PI) });
    acc.add(g, { color: gray(1) });
    g.dispose();
  } else {
    // GT wing: airfoil on two uprights, with end plates.
    const W = r.x[12] * (roof ? 0.9 : 0.94);
    const baseY = roof ? at(20).y : at(17).y;
    const wy = baseY + (roof ? 0.12 : 0.3);
    const wz = z - (roof ? 0.12 : 0.1);
    const chord = roof ? 0.22 : 0.28;
    const foil: [number, number][] = [];
    const nf = hi ? 10 : 5;
    for (let i = 0; i <= nf; i++) {
      const t = i / nf;
      const xx = chord * (0.5 - t);
      const th = 0.12 * chord * (1.4 * Math.sqrt(t) - t - 0.4 * t * t) * 2.2;
      foil.push([xx, th]);
    }
    for (let i = nf - 1; i > 0; i--) {
      const t = i / nf;
      const xx = chord * (0.5 - t);
      const th = -0.03 * chord * Math.sin(Math.PI * t);
      foil.push([xx, th]);
    }
    const path = [new V3(W, wy, wz), new V3(0, wy + 0.005, wz), new V3(-W, wy, wz)];
    const tilt = -0.12;
    const prof = ccw(foil.map(([a, b]) => [a * Math.cos(tilt) - b * Math.sin(tilt), a * Math.sin(tilt) + b * Math.cos(tilt)] as [number, number]));
    const wing = sweep(path, prof, { closed: true, capStart: true, capEnd: true });
    acc.add(wing, { color: black });
    wing.dispose();
    const plate = new RoundedBoxGeometry(0.012, 0.13, chord * 1.15, 1, 0.004);
    for (const sx of [1, -1]) acc.add(plate, { matrix: mtx(sx * (W + 0.006), wy - 0.02, wz - 0.01), color: black });
    plate.dispose();
    const post = new RoundedBoxGeometry(0.018, wy - baseY + 0.02, 0.07, 1, 0.006);
    for (const sx of [1, -1]) acc.add(post, { matrix: mtx(sx * W * 0.55, (wy + baseY) / 2, wz + 0.02, 0.15, 0, 0), color: black });
    post.dispose();
  }
  const g = acc.toGeometry('paint');
  return g;
}

/** Collapse a vertex range of a geometry to a point (hide part of a merged mesh) or restore from a copy. */
export function setRangeCollapsed(geo: THREE.BufferGeometry, start: number, count: number, collapsed: boolean, orig: Float32Array): void {
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const arr = p.array as Float32Array;
  for (let i = start; i < start + count; i++) {
    if (collapsed) {
      arr[i * 3] = arr[start * 3];
      arr[i * 3 + 1] = arr[start * 3 + 1];
      arr[i * 3 + 2] = arr[start * 3 + 2];
    } else {
      arr[i * 3] = orig[i * 3];
      arr[i * 3 + 1] = orig[i * 3 + 1];
      arr[i * 3 + 2] = orig[i * 3 + 2];
    }
  }
  p.needsUpdate = true;
}

export { REGION_INFO };

/** Engine-cover louvres: slats across the top surface (between the roof corners). */
export function addLouvers(sf: Surface, trim: GeoAcc): void {
  const L = sf.s.details.louvers;
  if (!L) return;
  for (let i = 0; i < L.n; i++) {
    const z = lerp(L.z0, L.z1, (i + 0.5) / L.n);
    const path: THREE.Vector3[] = [];
    for (let k = 0; k <= 4; k++) {
      const p = sf.at(z, lerp(19.6, 22, k / 4));
      path.push(new V3(p.x * 0.92, p.y + 0.004, p.z));
    }
    const full = path.concat(path.slice(0, -1).reverse().map((p) => new V3(-p.x, p.y, p.z)));
    const g = sweep(full, ccw([[-0.03, 0], [0.03, 0], [0.026, 0.012], [-0.03, 0.004]]), { closed: true, capStart: true, capEnd: true });
    trim.add(g, { color: gray(0.035), mat: [0.3, 0.4, 0, 0] });
    g.dispose();
  }
}

/** Vertical diffuser fins on the rear cap. */
export function addDiffuserFins(sf: Surface, trim: GeoAcc): void {
  const n = sf.s.details.diffuserFins ?? 0;
  if (!n) return;
  const r = sf.rear;
  const y0 = r.y[4] + 0.01;
  const y1 = r.y[6] - 0.01;
  for (let i = 0; i < n; i++) {
    const xf = -0.66 + (1.32 * i) / Math.max(1, n - 1);
    const g = capPost(sf, false, xf, y0, y1, [[-0.006, -0.004], [0.006, -0.004], [0.006, 0.045], [-0.006, 0.045]]);
    trim.add(g, { color: gray(0.04), mat: MAT.satin });
    g.dispose();
  }
}
