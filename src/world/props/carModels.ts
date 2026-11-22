import * as THREE from 'three';
import type { CarModelId } from '../../vehicle/CarBuild';
import { GeoBuilder, M, alongSegment, box, cylX, extrude, lathe } from './GeoBuilder';

/**
 * Fallback low/medium-poly parked cars (owner: props), used until/unless ICarFactory.instancingGeometry() returns a
 * geometry. SAME attribute layout as that contract: position, normal, color, paintMask (1 paint, 0.5 glass, 0 other).
 * Car faces +Z, left side +X, origin on the ground under the car centre.
 * Lamp colours follow the convention the parked-car shader uses to light them at night: headlight lenses bright
 * cream-white at the front end, tail lamps saturated red at the rear end.
 */

interface CarSpec {
  L: number;
  W: number;
  r: number; // wheel radius
  wf: number; // front axle z
  wr: number; // rear axle z
  yb: number; // body bottom
  tw: number; // tyre width
  /** Body side outline (z, y) from the front-bottom corner over the top to the rear-bottom corner. */
  top: number[][];
  /** Greenhouse (z, y) polygon. */
  cabin: number[][];
  inset: number; // greenhouse inset per side
  roof: [number, number, number]; // z front, z rear, y
  pillars: number[][][]; // segments [[z0,y0],[z1,y1]]
  hlY: number; // headlight height
  tlY: number;
  chrome?: boolean;
  extras?: (b: GeoBuilder, s: CarSpec) => void;
}

const SPECS: Record<CarModelId, CarSpec> = {
  coupe: {
    L: 4.32, W: 1.84, r: 0.33, wf: 1.38, wr: -1.32, yb: 0.24, tw: 0.24,
    top: [[2.12, 0.27], [2.18, 0.42], [2.16, 0.6], [2.02, 0.68], [1.25, 0.78], [0.72, 0.84], [-1.35, 0.86], [-1.9, 0.88], [-2.12, 0.84], [-2.17, 0.62], [-2.12, 0.3]],
    cabin: [[0.8, 0.8], [0.02, 1.24], [-0.7, 1.25], [-1.52, 0.94], [-1.64, 0.8]],
    inset: 0.13, roof: [0.02, -0.7, 1.245],
    pillars: [[[0.72, 0.83], [0.03, 1.23]], [[-0.68, 1.23], [-1.5, 0.92]], [[-0.28, 0.86], [-0.32, 1.24]]],
    hlY: 0.62, tlY: 0.74,
    extras: (b) => {
      b.add(box(1.5, 0.04, 0.22), '#ffffff', { paint: 1 }, M(0, 0.9, -1.98));
    },
  },
  muscle: {
    L: 4.76, W: 1.92, r: 0.36, wf: 1.52, wr: -1.46, yb: 0.27, tw: 0.27,
    top: [[2.34, 0.3], [2.4, 0.5], [2.38, 0.74], [2.25, 0.8], [1.0, 0.9], [0.55, 0.92], [-1.7, 0.95], [-2.3, 0.96], [-2.38, 0.9], [-2.4, 0.62], [-2.34, 0.32]],
    cabin: [[0.62, 0.88], [-0.12, 1.3], [-0.9, 1.31], [-1.76, 0.97], [-1.82, 0.88]],
    inset: 0.14, roof: [-0.12, -0.9, 1.305],
    pillars: [[[0.56, 0.91], [-0.11, 1.29]], [[-0.88, 1.29], [-1.74, 0.96]]],
    hlY: 0.66, tlY: 0.78, chrome: true,
    extras: (b) => {
      b.add(box(0.62, 0.09, 0.8), '#ffffff', { paint: 1 }, M(0, 0.93, 1.2));
      b.add(box(0.5, 0.05, 0.04), '#15171a', {}, M(0, 0.95, 1.6));
      b.add(box(1.75, 0.05, 0.22), '#ffffff', { paint: 1 }, M(0, 1.01, -2.22));
    },
  },
  hatch: {
    L: 3.86, W: 1.74, r: 0.31, wf: 1.24, wr: -1.2, yb: 0.25, tw: 0.22,
    top: [[1.9, 0.27], [1.95, 0.45], [1.9, 0.68], [1.7, 0.78], [1.1, 0.88], [-1.8, 0.95], [-1.92, 0.9], [-1.94, 0.5], [-1.88, 0.28]],
    cabin: [[1.13, 0.84], [0.32, 1.42], [-1.55, 1.43], [-1.86, 1.0], [-1.88, 0.86]],
    inset: 0.12, roof: [0.32, -1.55, 1.425],
    pillars: [[[1.1, 0.87], [0.33, 1.41]], [[-0.2, 0.9], [-0.22, 1.42]], [[-1.4, 1.42], [-1.84, 0.98]]],
    hlY: 0.66, tlY: 0.82,
    extras: (b) => {
      for (const s of [-1, 1]) b.add(box(0.05, 0.05, 1.7), '#2a2e33', {}, M(s * 0.62, 1.47, -0.6));
    },
  },
  suv: {
    L: 4.62, W: 1.96, r: 0.39, wf: 1.42, wr: -1.42, yb: 0.38, tw: 0.27,
    top: [[2.26, 0.42], [2.31, 0.62], [2.3, 0.95], [2.1, 1.06], [1.15, 1.14], [-2.0, 1.17], [-2.26, 1.13], [-2.3, 0.7], [-2.24, 0.42]],
    cabin: [[1.18, 1.1], [0.45, 1.74], [-1.95, 1.76], [-2.22, 1.25], [-2.24, 1.1]],
    inset: 0.13, roof: [0.45, -1.95, 1.755],
    pillars: [[[1.15, 1.13], [0.46, 1.73]], [[-0.4, 1.15], [-0.42, 1.75]], [[-1.85, 1.75], [-2.2, 1.22]]],
    hlY: 0.92, tlY: 1.0,
    extras: (b, s) => {
      for (const x of [-1, 1]) {
        b.add(box(0.05, 0.06, 2.2), '#2a2e33', {}, M(x * 0.7, s.roof[2] + 0.06, -0.75));
        b.add(box(0.03, 0.18, 2.1), '#2a2e33', {}, M(x * (s.W / 2 + 0.005), s.yb + 0.12, 0));
      }
      b.add(box(1.2, 0.08, 0.1), '#2a2e33', {}, M(0, 0.55, 2.3));
    },
  },
};

export function carSpecDims(model: CarModelId): { L: number; W: number; H: number } {
  const s = SPECS[model];
  return { L: s.L, W: s.W, H: s.roof[2] + 0.04 };
}

/** Body outline: given top contour (front → rear) + a bottom edge with wheel arches (rear → front). */
function outline(s: CarSpec): number[][] {
  const pts = s.top.map((p) => [p[0], p[1]]);
  const ra = s.r + 0.06;
  const arch = (wz: number) => {
    const d = Math.asin(Math.min(0.99, Math.max(-0.99, (s.r - s.yb) / ra)));
    const a0 = Math.PI + d, a1 = -d;
    for (let k = 0; k <= 7; k++) {
      const a = a0 + ((a1 - a0) * k) / 7;
      pts.push([wz + ra * Math.cos(a), s.r + ra * Math.sin(a)]);
    }
  };
  arch(s.wr);
  arch(s.wf);
  return pts;
}

export function buildFallbackCar(model: CarModelId): THREE.BufferGeometry {
  const s = SPECS[model];
  const b = new GeoBuilder('car', 0.2, 0.15);
  const paint = { paint: 1 };
  const glass = { paint: 0.5 };
  // body (paint) — extruded side profile, rounded by a small bevel
  const bevel = 0.05;
  b.add(extrude(outline(s), s.W, bevel, 3).rotateY(-Math.PI / 2), '#ffffff', paint);
  // greenhouse (glass) + roof cap + pillars (paint)
  const wc = s.W - 2 * s.inset;
  b.add(extrude(s.cabin, wc, 0.03, 2).rotateY(-Math.PI / 2), '#223040', glass);
  const [rzf, rzr, ry] = s.roof;
  b.add(box(wc + 0.03, 0.05, rzf - rzr + 0.06), '#ffffff', paint, M(0, ry - 0.005, (rzf + rzr) / 2));
  for (const seg of s.pillars) {
    for (const side of [-1, 1]) {
      const a = new THREE.Vector3(side * (wc / 2 + 0.012), seg[0][1], seg[0][0]);
      const c = new THREE.Vector3(side * (wc / 2 + 0.012), seg[1][1], seg[1][0]);
      b.add(box(0.05, 1, 0.08), '#ffffff', paint, alongSegment(a, c));
    }
  }
  const zf = s.top[0][0] + 0.04;
  const zr = s.top[s.top.length - 1][0] - 0.04;
  const trim = s.chrome ? '#bfc4c9' : '#2c3036';
  // bumpers, grille, lamps, plates
  b.add(extrude([[-0.08, -0.09], [0.06, -0.09], [0.09, 0.0], [0.06, 0.09], [-0.08, 0.09]], s.W * 0.97, 0.01).rotateY(-Math.PI / 2), trim, {}, M(0, s.yb + 0.1, zf - 0.03));
  b.add(extrude([[-0.06, -0.09], [0.08, -0.09], [0.08, 0.09], [-0.09, 0.09], [-0.09, 0.0]], s.W * 0.97, 0.01).rotateY(-Math.PI / 2), trim, {}, M(0, s.yb + 0.1, zr + 0.03));
  b.add(box(s.W * 0.4, 0.13, 0.05), '#16191c', {}, M(0, s.hlY - 0.12, zf - 0.02));
  for (const x of [-1, 1]) {
    b.add(box(0.36, 0.12, 0.08), '#fff3d9', { paint: 0.25 }, M(x * (s.W / 2 - 0.3), s.hlY, zf - 0.05));
    b.add(box(0.4, 0.1, 0.07), '#e2251f', { paint: 0.25 }, M(x * (s.W / 2 - 0.3), s.tlY, zr + 0.03));
    b.add(box(0.14, 0.05, 0.075), '#ff9a2a', {}, M(x * (s.W / 2 - 0.12), s.hlY - 0.08, zf - 0.07));
    // side mirrors
    b.add(box(0.13, 0.09, 0.1), '#ffffff', paint, M(x * (s.W / 2 + 0.05), s.cabin[0][1] + 0.1, s.cabin[0][0] - 0.2));
    // door seams
    const bp = s.pillars.find((q) => Math.abs(q[0][0] - q[1][0]) < 0.1);
    const doorZ = [s.cabin[0][0] - 0.05, bp ? bp[0][0] : -0.5];
    for (const z of doorZ) b.add(box(0.012, s.top[5][1] - s.yb - 0.12, 0.012), '#1a1d20', {}, M(x * (s.W / 2 + 0.004), (s.top[5][1] + s.yb) / 2, z));
  }
  b.add(box(0.46, 0.11, 0.02), '#f2efe4', {}, M(0, s.yb + 0.28, zr - 0.005));
  // underbody + wheel-well blockers + wheels
  b.add(box(s.W - 0.2, 0.08, s.L - 0.6), '#121417', {}, M(0, s.yb + 0.02, 0));
  const wx = s.W / 2 - s.tw / 2 - 0.02;
  const tyre = lathe([[s.r * 0.62, -s.tw / 2], [s.r * 0.92, -s.tw / 2], [s.r, -s.tw * 0.3], [s.r, s.tw * 0.3], [s.r * 0.92, s.tw / 2], [s.r * 0.62, s.tw / 2]], 14, 40).rotateZ(Math.PI / 2);
  for (const z of [s.wf, s.wr]) {
    b.add(box(s.W - 2 * s.tw - 0.12, s.r * 1.6, s.r * 1.9), '#101214', {}, M(0, s.r + 0.02, z));
    for (const x of [-1, 1]) {
      b.add(tyre, '#1b1d20', {}, M(x * wx, s.r, z));
      b.add(cylX(s.r * 0.62, s.tw * 0.9, 10), '#c3c9ce', {}, M(x * wx, s.r, z));
      b.add(cylX(s.r * 0.22, s.tw * 0.96, 6), '#7d848b', {}, M(x * wx, s.r, z));
    }
  }
  s.extras?.(b, s);
  return b.build();
}

/** Generic far-LOD car (L 4.3, W 1.82, H 1.3): instance scale adapts it per model. */
export function buildFarCar(): THREE.BufferGeometry {
  const b = new GeoBuilder('car', 0.2, 0.15);
  b.add(extrude([[2.15, 0.28], [2.15, 0.66], [0.8, 0.84], [-2.15, 0.86], [-2.15, 0.3]], 1.82).rotateY(-Math.PI / 2), '#ffffff', { paint: 1 });
  b.add(extrude([[0.8, 0.8], [0.05, 1.24], [-0.85, 1.25], [-1.6, 0.82]], 1.56).rotateY(-Math.PI / 2), '#223040', { paint: 0.5 });
  b.add(box(1.58, 0.04, 0.92), '#ffffff', { paint: 1 }, M(0, 1.25, -0.4));
  for (const z of [1.35, -1.3]) for (const x of [-0.8, 0.8]) b.add(box(0.24, 0.62, 0.62), '#1b1d20', {}, M(x, 0.31, z));
  return b.build();
}
