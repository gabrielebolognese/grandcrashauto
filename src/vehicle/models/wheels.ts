import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TyreProfile } from '../CarBuild';
import { GeoAcc, MAT, gray, mtx, type MatCode, type RGB } from './util';

/**
 * Procedural wheels. Wheel local frame: axle = X, outer face toward +X (right-side wheels are rotated π about Y).
 * Tyres are lathed profiles (with tread normal map uv); rims = barrel lathe + extruded spoke face (shape with holes,
 * bevelled) + hub, lug nuts, centre cap and brake disc. Geometries are cached per design/size and shared by all cars.
 */

export const RIM_NAMES = ['Velo 5', 'Lattice', 'Deep Dish', 'Turbine', 'Split Ten', 'Steelie'];

export function wheelRadius(baseR: number, size: number, tyre: TyreProfile): number {
  const s = [0.93, 1.0, 1.07][Math.max(0, Math.min(2, size))];
  const p = tyre === 'low' ? 0.985 : tyre === 'high' ? 1.02 : 1.0;
  return baseR * s * p;
}

export function sidewallFrac(tyre: TyreProfile): number {
  return tyre === 'low' ? 0.17 : tyre === 'high' ? 0.34 : 0.25;
}

/** Lathe a profile [r, x] around the X axis. Normal = dx·(-radial) + dr·(+X) (see notes): order profiles accordingly. */
export function latheX(profile: ReadonlyArray<readonly [number, number]>, segs: number, opts: { uv?: boolean; phase?: number } = {}): THREE.BufferGeometry {
  const P = profile.length;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let total = 0;
  const acc: number[] = [0];
  for (let i = 1; i < P; i++) {
    total += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
    acc.push(total);
  }
  const ph = opts.phase ?? 0;
  for (let j = 0; j <= segs; j++) {
    const a = (j / segs) * Math.PI * 2 + ph;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let i = 0; i < P; i++) {
      const [r, x] = profile[i];
      pos.push(x, r * c, r * s);
      uv.push(j / segs, acc[i] / Math.max(1e-6, total));
    }
  }
  for (let j = 0; j < segs; j++) {
    for (let i = 0; i < P - 1; i++) {
      const a = j * P + i;
      const b = j * P + i + 1;
      const c = (j + 1) * P + i + 1;
      const d = (j + 1) * P + i;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Lathe seam: average normals of the duplicated first/last ring.
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < P; i++) {
    const a = i;
    const b = segs * P + i;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Tyre profile (outer bead → outer sidewall → tread → inner sidewall → inner bead). */
export function tyreGeometry(R: number, sidewall: number, width: number, segs: number, detail: boolean): THREE.BufferGeometry {
  const hw = width / 2;
  const rim = R - sidewall;
  const sw = sidewall;
  const prof: [number, number][] = [];
  prof.push([rim - 0.004, hw * 0.84]);
  if (detail) {
    prof.push([rim + sw * 0.18, hw * 0.97]);
    prof.push([rim + sw * 0.52, hw * 1.0]);
    prof.push([rim + sw * 0.84, hw * 0.97]);
  } else prof.push([rim + sw * 0.5, hw]);
  prof.push([R - 0.014, hw * 0.9]);
  prof.push([R - 0.002, hw * 0.78]);
  if (detail) prof.push([R + 0.002, 0]);
  prof.push([R - 0.002, -hw * 0.78]);
  prof.push([R - 0.014, -hw * 0.9]);
  if (detail) {
    prof.push([rim + sw * 0.84, -hw * 0.97]);
    prof.push([rim + sw * 0.52, -hw * 1.0]);
    prof.push([rim + sw * 0.18, -hw * 0.97]);
  } else prof.push([rim + sw * 0.5, -hw]);
  prof.push([rim - 0.004, -hw * 0.84]);
  const g = latheX(prof, segs, { uv: true });
  // remap uv.y so the tread band sits at v∈[0.3,0.7] like the normal map expects
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const x = pos.getX(i);
    const r = Math.hypot(pos.getY(i), pos.getZ(i));
    const onTread = r > R - 0.016;
    const v = onTread ? 0.5 - (x / hw) * 0.25 : x > 0 ? 0.15 * ((r - rim) / sw) : 1 - 0.15 * ((r - rim) / sw);
    uv.setXY(i, uv.getX(i) * 4, v);
  }
  return g;
}

interface SpokeDef {
  n: number;
  r0: number;
  r1: number;
  wHub: number;
  wRim: number;
  twist?: number;
  /** split spokes: angular half-offset of the pair (radians) at the hub and rim */
  split?: [number, number];
}

/** Window (hole) polygon between spoke edges. Angles in radians. */
function windowsFor(d: SpokeDef, ro: number, samples: number): THREE.Path[] {
  const holes: THREE.Path[] = [];
  const spokes: { c: (r: number) => number }[] = [];
  const tw = d.twist ?? 0;
  for (let k = 0; k < d.n; k++) {
    const base = (k / d.n) * Math.PI * 2;
    if (d.split) {
      const [s0, s1] = d.split;
      const off = (r: number) => s0 + (s1 - s0) * ((r - d.r0 * ro) / ((d.r1 - d.r0) * ro));
      spokes.push({ c: (r) => base - off(r) + tw * ((r - d.r0 * ro) / ro) });
      spokes.push({ c: (r) => base + off(r) + tw * ((r - d.r0 * ro) / ro) });
    } else spokes.push({ c: (r) => base + tw * ((r - d.r0 * ro) / ro) });
  }
  const width = (r: number) => (d.wHub + (d.wRim - d.wHub) * ((r - d.r0 * ro) / ((d.r1 - d.r0) * ro))) * ro;
  const m = spokes.length;
  for (let k = 0; k < m; k++) {
    const A = spokes[k];
    const B = spokes[(k + 1) % m];
    const wrap = k === m - 1 ? Math.PI * 2 : 0;
    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let i = 0; i <= samples; i++) {
      const r = (d.r0 + (d.r1 - d.r0) * (i / samples)) * ro;
      const a = A.c(r) + width(r) / 2 / r;
      const b = B.c(r) + wrap - width(r) / 2 / r;
      if (b - a > 0.02) {
        left.push([r, a]);
        right.push([r, b]);
      }
    }
    if (left.length < 2) continue;
    const pts: THREE.Vector2[] = [];
    const P = (r: number, a: number) => new THREE.Vector2(r * Math.cos(a), r * Math.sin(a));
    for (const [r, a] of left) pts.push(P(r, a));
    // outer arc
    const [rl, al] = left[left.length - 1];
    const [, bl] = right[right.length - 1];
    const arcN = Math.max(2, Math.ceil((bl - al) * 6));
    for (let i = 1; i < arcN; i++) pts.push(P(rl, al + ((bl - al) * i) / arcN));
    for (let i = right.length - 1; i >= 0; i--) pts.push(P(right[i][0], right[i][1]));
    const [r0, a0] = left[0];
    const [, b0] = right[0];
    const arcN0 = Math.max(1, Math.ceil((b0 - a0) * 3));
    for (let i = arcN0 - 1; i > 0; i--) pts.push(P(r0, a0 + ((b0 - a0) * i) / arcN0));
    holes.push(new THREE.Path(pts));
  }
  return holes;
}

const RIM_BODY: MatCode = [0.85, 0.3, 1, 0];
const CHROME: MatCode = [1, 0.08, 0, 0];

/** Build a rim (outer face toward +X). */
export function rimGeometry(design: number, rimR: number, width: number, hi: boolean): THREE.BufferGeometry {
  const acc = new GeoAcc();
  const segs = hi ? 24 : 14;
  const w = width * 0.92;
  const lipX = w / 2;
  const rB = rimR - 0.014;
  // Barrel + outer lip (inner surface faces the axle).
  const deep = design === 2;
  const barrel: [number, number][] = [
    [rimR + 0.008, -w / 2],
    [rB, -w / 2 + 0.012],
    [rB, lipX - (deep ? 0.08 : 0.02)],
    [rimR + 0.004, lipX - 0.006],
    [rimR + 0.013, lipX - 0.012],
    [rimR + 0.013, lipX - 0.03],
  ];
  acc.add(latheX(barrel, segs), { color: deep ? gray(0.95) : gray(1), mat: deep ? CHROME : RIM_BODY });
  const ro = rB - 0.002;
  const faceX = lipX - (deep ? 0.09 : 0.038);
  const thick = hi ? 0.022 : 0.03;
  // Face.
  const shape = new THREE.Shape();
  let faceR = ro;
  let dish = 0.035;
  let defs: SpokeDef | null = null;
  const circleHoles: THREE.Path[] = [];
  switch (design) {
    case 0:
      defs = { n: 5, r0: 0.3, r1: 0.88, wHub: 0.3, wRim: 0.17 };
      dish = 0.04;
      break;
    case 1:
      defs = { n: 12, r0: 0.34, r1: 0.9, wHub: 0.085, wRim: 0.065 };
      dish = 0.022;
      break;
    case 2:
      defs = { n: 8, r0: 0.3, r1: 0.6, wHub: 0.13, wRim: 0.11 };
      faceR = ro * 0.64;
      dish = 0.012;
      break;
    case 3:
      defs = { n: 10, r0: 0.34, r1: 0.85, wHub: 0.2, wRim: 0.26, twist: 0.65 };
      dish = 0.008;
      break;
    case 4:
      defs = { n: 5, r0: 0.3, r1: 0.88, wHub: 0.075, wRim: 0.06, split: [0.05, 0.13] };
      dish = 0.045;
      break;
    default: {
      dish = 0.015;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
        const pts: THREE.Vector2[] = [];
        const hn = hi ? 12 : 6;
        for (let i = 0; i < hn; i++) {
          const b = -(i / hn) * Math.PI * 2;
          pts.push(new THREE.Vector2(Math.cos(a) * ro * 0.6 + Math.cos(b) * ro * 0.11, Math.sin(a) * ro * 0.6 + Math.sin(b) * ro * 0.11));
        }
        circleHoles.push(new THREE.Path(pts));
      }
    }
  }
  shape.absarc(0, 0, faceR, 0, Math.PI * 2, false);
  shape.holes.push(...(defs ? windowsFor(defs, ro, hi ? 3 : 2) : circleHoles));
  const face = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.005,
    bevelSegments: 1,
    curveSegments: hi ? 22 : 12,
  });
  // map extrusion z → wheel x (outward), dish toward the hub
  const p = face.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const sx = p.getX(i);
    const sy = p.getY(i);
    const sz = p.getZ(i);
    const r = Math.hypot(sx, sy) / ro;
    const x = faceX - thick + sz - dish * (1 - Math.min(1, r) ** 1.6);
    p.setXYZ(i, x, sy, sx);
  }
  face.deleteAttribute('normal');
  face.deleteAttribute('uv');
  // the x/z swap is a reflection → flip winding, then weld for smooth bevels
  flipWinding(face);
  const welded = mergeVertices(face, 1e-5);
  cullHidden(welded, ro, faceX - thick - 0.002);
  welded.computeVertexNormals();
  acc.add(welded, { color: gray(1), mat: RIM_BODY });
  welded.dispose();
  if (design === 2) {
    // polished conical dish from the spoke ring out to the lip
    const dishRing: [number, number][] = [
      [faceR - 0.004, faceX - dish * 0.2],
      [faceR + 0.01, faceX + 0.004],
      [ro + 0.004, lipX - 0.012],
    ];
    acc.add(latheX(dishRing, segs), { color: gray(0.95), mat: CHROME });
  }
  if (design === 5) {
    // steel wheel: raised centre ring + chrome dome cap + trim ring
    acc.add(latheX([
      [ro * 0.36, faceX + 0.004],
      [ro * 0.42, faceX + 0.014],
      [ro * 0.46, faceX + 0.004],
    ], segs), { color: gray(1), mat: RIM_BODY });
    acc.add(latheX([
      [ro * 0.001, faceX + 0.055],
      [ro * 0.22, faceX + 0.048],
      [ro * 0.33, faceX + 0.03],
      [ro * 0.36, faceX + 0.006],
    ], segs), { color: gray(0.92), mat: CHROME });
    acc.add(latheX([
      [ro * 0.86, faceX + 0.006],
      [ro * 0.93, faceX + 0.016],
      [ro + 0.006, lipX - 0.006],
    ], segs), { color: gray(0.92), mat: CHROME });
  } else {
    // hub, lug nuts, centre cap
    const hubX = faceX - dish + 0.002;
    const hs = hi ? 16 : 8;
    acc.add(latheX([
      [ro * 0.13, hubX + 0.012],
      [ro * 0.24, hubX + 0.008],
      [ro * 0.25, hubX - 0.002],
    ], hs), { color: gray(0.85), mat: RIM_BODY });
    acc.add(latheX([
      [ro * 0.001, hubX + 0.024],
      [ro * 0.11, hubX + 0.022],
      [ro * 0.13, hubX + 0.012],
    ], hs), { color: gray(0.75), mat: [0.9, 0.18, 0, 0] });
    const nut = new THREE.CylinderGeometry(0.0095, 0.011, 0.018, 6).rotateZ(-Math.PI / 2);
    const nuts = design === 1 || design === 3 ? 6 : 5;
    for (let k = 0; k < nuts; k++) {
      const a = (k / nuts) * Math.PI * 2 + 0.3;
      acc.add(nut, { matrix: mtx(hubX + 0.012, Math.cos(a) * ro * 0.19, Math.sin(a) * ro * 0.19), color: gray(0.9), mat: CHROME });
    }
    nut.dispose();
  }
  // brake disc + hat
  acc.add(latheX([
    [ro * 0.3, -w / 2 + 0.1],
    [ro * 0.36, -w / 2 + 0.07],
    [ro * 0.82, -w / 2 + 0.07],
    [ro * 0.82, -w / 2 + 0.05],
  ], hi ? 16 : 10), { color: gray(0.42), mat: [0.85, 0.42, 0, 0] });
  face.dispose();
  return acc.toGeometry('detail');
}

/** Drop extrude triangles nobody sees: the back cap and the outer rim wall hidden by the barrel. */
function cullHidden(g: THREE.BufferGeometry, ro: number, backX: number): void {
  const idx = g.getIndex();
  if (!idx) return;
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const keep: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    a.fromBufferAttribute(p, idx.getX(i));
    b.fromBufferAttribute(p, idx.getX(i + 1));
    c.fromBufferAttribute(p, idx.getX(i + 2));
    n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
    const mx = (a.x + b.x + c.x) / 3;
    const mr = (Math.hypot(a.y, a.z) + Math.hypot(b.y, b.z) + Math.hypot(c.y, c.z)) / 3;
    if (n.x < -0.85 && mx < backX + 0.012) continue; // back cap
    if (mr > ro * 0.985 && Math.abs(n.x) < 0.4) continue; // outer wall under the barrel
    keep.push(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
  }
  g.setIndex(keep);
}

function flipWinding(g: THREE.BufferGeometry): void {
  const idx = g.getIndex();
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      const b = idx.getX(i + 1);
      idx.setX(i + 1, idx.getX(i + 2));
      idx.setX(i + 2, b);
    }
    return;
  }
  for (const name of Object.keys(g.attributes)) {
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    const n = a.itemSize;
    const arr = a.array as Float32Array;
    for (let i = 0; i < a.count; i += 3) {
      for (let k = 0; k < n; k++) {
        const t = arr[(i + 1) * n + k];
        arr[(i + 1) * n + k] = arr[(i + 2) * n + k];
        arr[(i + 2) * n + k] = t;
      }
    }
  }
}

/** Low-LOD merged wheel (rim + tyre in one detail geometry; rim tinted via aMat.z). */
export function lowWheelGeometry(R: number, sidewall: number, width: number): THREE.BufferGeometry {
  const acc = new GeoAcc();
  const tyre = tyreGeometry(R, sidewall, width, 10, false);
  acc.add(tyre, { color: gray(0.014), mat: MAT.rubber });
  tyre.dispose();
  const rim = R - sidewall;
  const hw = width / 2;
  const face = latheX([
    [0.001, hw * 0.45],
    [rim * 0.3, hw * 0.4],
    [rim * 0.8, hw * 0.55],
    [rim, hw * 0.75],
  ], 10);
  acc.add(face, { color: gray(1), mat: RIM_BODY });
  face.dispose();
  return acc.toGeometry('detail');
}

// ───────────────────────────── caches ─────────────────────────────
const tyreCache = new Map<string, THREE.BufferGeometry>();
const rimCache = new Map<string, THREE.BufferGeometry>();
const lowCache = new Map<string, THREE.BufferGeometry>();

const k3 = (a: number) => a.toFixed(4);

export function getTyre(R: number, sidewall: number, width: number): THREE.BufferGeometry {
  const key = `${k3(R)}|${k3(sidewall)}|${k3(width)}`;
  let g = tyreCache.get(key);
  if (!g) tyreCache.set(key, (g = tyreGeometry(R, sidewall, width, 26, true)));
  return g;
}

export function getRim(design: number, rimR: number, width: number): THREE.BufferGeometry {
  const key = `${design}|${k3(rimR)}|${k3(width)}`;
  let g = rimCache.get(key);
  if (!g) rimCache.set(key, (g = rimGeometry(design, rimR, width, true)));
  return g;
}

export function getLowWheel(R: number, sidewall: number, width: number): THREE.BufferGeometry {
  const key = `${k3(R)}|${k3(sidewall)}|${k3(width)}`;
  let g = lowCache.get(key);
  if (!g) lowCache.set(key, (g = lowWheelGeometry(R, sidewall, width)));
  return g;
}

export type { RGB };
