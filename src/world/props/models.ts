import * as THREE from 'three';
import { CONFIG } from '../../config';
import { EM, GeoBuilder, M, SF, alongSegment, box, cyl, cylX, cylZ, extrude, extrudeShape, hash3, lathe, soup, tubeAlong, type PartOpts } from './GeoBuilder';

/**
 * Original procedural prop models (owner: props). Pastel coastal art-deco: stepped plinths, fluted poles, gold bands,
 * rounded canopies. Every builder returns a merged geometry in prop layout (see GeoBuilder). Local frame: origin on
 * the ground at the prop base, +Z = the prop's facing direction (placement yaw), +Y up.
 * LOD 0 = near (medium-poly), LOD 1 = far (cheap silhouette).
 */

export const P = {
  coral: '#ff7a6b', peach: '#ffb38a', sand: '#f3dcb2', mint: '#9ee0c8', aqua: '#5cc8d6', lilac: '#b8a6e8',
  butter: '#ffe39a', cream: '#fff4e0', sky: '#8fd0ec', sea: '#2aa3c4', deep: '#146c94', palm: '#4f9a5a',
  asphalt: '#4a4d57', sidewalk: '#d9d2c5', gold: '#e0b860', iron: '#2c3837', dark: '#202528', white: '#ffffff',
  steel: '#9aa3a6', lampWarm: '#ffe9bf', glass: '#bfe3ee', black: '#16191b',
};

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const W = '#ffffff';
const tinted: PartOpts = { tint: 1, surf: SF.gloss };
const metal: PartOpts = { surf: SF.metal };

/** Chamfered rectangle outline (x, y), centred. */
function chamferRect(w: number, h: number, c: number): number[][] {
  const x = w / 2, y = h / 2;
  return [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]];
}

/** Flat rectangular frame (outer w×h, inner iw×ih, chamfer c) of thickness d in the XY plane. */
function frameRing(w: number, h: number, iw: number, ih: number, c: number, d: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(chamferRect(w, h, c).map((q) => new THREE.Vector2(q[0], q[1])));
  shape.holes.push(new THREE.Path(chamferRect(iw, ih, c * 0.8).reverse().map((q) => new THREE.Vector2(q[0], q[1]))));
  return extrudeShape(shape, d);
}

/** A slat running along X with a chamfered (z, y) cross-section. */
function slatX(len: number, h: number, d: number, c = 0.008): THREE.BufferGeometry {
  return extrude(chamferRect(d, h, c), len).rotateY(-Math.PI / 2);
}

/** Clip a convex polygon by the half-plane a*x + b*y <= c. */
function clipHalf(poly: number[][], a: number, b: number, c: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Diagonally striped flat panel (w × h × depth) in the XY plane centred at m's origin. */
function stripedPanel(b: GeoBuilder, w: number, h: number, depth: number, stripe: number, slope: number, cols: string[], m: THREE.Matrix4, opts: PartOpts = {}): void {
  const rect = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  const n = Math.ceil((w + Math.abs(slope) * h) / stripe) + 2;
  const start = -w / 2 - Math.abs(slope) * h - stripe;
  for (let i = 0; i < n; i++) {
    const c0 = start + i * stripe, c1 = c0 + stripe;
    // band: c0 <= x - slope*y <= c1
    let poly = clipHalf(rect, -1, slope, -c0);
    poly = clipHalf(poly, 1, -slope, c1);
    if (poly.length < 3) continue;
    b.add(extrude(poly, depth), cols[i % cols.length], opts, m);
  }
}

// ───────────────────────────── streetlight ─────────────────────────────
export const STREETLIGHT_LAMP_Y = 5.1;

export function streetlight(lod: number): THREE.BufferGeometry {
  const b = new GeoBuilder('prop');
  if (lod === 0) {
    const seg = 12;
    // stepped art-deco plinth
    b.add(lathe([[0, 0], [0.31, 0], [0.31, 0.09], [0.27, 0.11], [0.27, 0.32], [0.22, 0.35], [0.22, 0.52], [0.17, 0.55], [0.15, 0.64], [0.105, 0.7], [0.09, 0.82], [0.078, 1.1]], seg, 30), W, { tint: 1, surf: SF.metal });
    // fluted (faceted) shaft
    b.add(lathe([[0.078, 1.1], [0.064, 4.45]], seg, 30, Math.PI / seg), W, { tint: 1, surf: SF.metal, flat: true });
    // gold bands
    b.add(lathe([[0.228, 0.47], [0.232, 0.48], [0.232, 0.53], [0.228, 0.54]], seg), P.gold, metal);
    b.add(lathe([[0.075, 1.95], [0.1, 1.97], [0.1, 2.04], [0.075, 2.06]], seg), P.gold, metal);
    // neck, gold cup, globe, crown
    b.add(lathe([[0.064, 4.44], [0.1, 4.5], [0.1, 4.57], [0.075, 4.61], [0.075, 4.72]], seg), W, { tint: 1, surf: SF.metal });
    b.add(lathe([[0.07, 4.72], [0.13, 4.76], [0.2, 4.84], [0.205, 4.88], [0.165, 4.9]], seg, 35), P.gold, metal);
    b.add(lathe([[0.165, 4.9], [0.2, 4.98], [0.215, 5.1], [0.205, 5.22], [0.17, 5.31], [0.12, 5.38]], seg, 50), P.lampWarm, { emit: EM.lamp, surf: SF.glass });
    b.add(lathe([[0.12, 5.37], [0.25, 5.4], [0.26, 5.44], [0.2, 5.47], [0.17, 5.55], [0.12, 5.6], [0.06, 5.64], [0.045, 5.71], [0.07, 5.75], [0.045, 5.8], [0, 5.85]], seg, 35), W, { tint: 1, surf: SF.metal });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      b.add(box(0.018, 0.44, 0.05), P.gold, metal, M(Math.sin(a) * 0.207, 5.13, Math.cos(a) * 0.207, 0, a, 0));
    }
    // decorative scroll brackets under the cup
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      b.add(box(0.025, 0.2, 0.09), W, { tint: 1, surf: SF.metal }, M(Math.sin(a) * 0.1, 4.62, Math.cos(a) * 0.1, 0, a, 0));
    }
  } else {
    b.add(lathe([[0, 0], [0.29, 0], [0.27, 0.35], [0.2, 0.55], [0.09, 0.8], [0.068, 4.5], [0.1, 4.62], [0.2, 4.86]], 6, 30), W, { tint: 1, surf: SF.metal });
    b.add(lathe([[0.18, 4.86], [0.215, 5.1], [0.12, 5.38]], 6, 60), P.lampWarm, { emit: EM.lamp, surf: SF.glass });
    b.add(lathe([[0.12, 5.37], [0.26, 5.42], [0.1, 5.62], [0, 5.85]], 6, 30), W, { tint: 1, surf: SF.metal });
  }
  return b.build();
}

// ───────────────────────────── palm ─────────────────────────────
export function palm(lod: number): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.5, 0.3);
  const H = 7.4;
  const curve = new THREE.CatmullRomCurve3([V(0, 0, 0), V(0.08, 1.8, 0), V(0.4, 3.9, 0), V(0.95, 5.9, 0), V(1.35, H, 0)]);
  const near = lod === 0;
  const N = near ? 12 : 4;
  const rings: number[] = [];
  const kind: number[] = []; // 0 bulge, 1 notch
  if (near) {
    rings.push(0, 0.012);
    kind.push(2, 2);
    for (let k = 1; k < N; k++) {
      rings.push(k / N, k / N + 0.3 / N);
      kind.push(0, 1);
    }
  } else {
    for (let k = 0; k <= N; k++) {
      rings.push(k / N);
      kind.push(k === 0 ? 2 : 0);
    }
  }
  rings.push(1);
  kind.push(0);
  const rBase = (t: number) => 0.26 - 0.1 * t;
  const swayTrunk = (_x: number, y: number) => Math.min(1, Math.pow(Math.max(0, y) / H, 2));
  b.add(
    tubeAlong(curve, rings, (t, i) => (kind[i] === 2 ? (i === 0 ? 0.42 : 0.31) : rBase(t) * (kind[i] === 1 ? 0.88 : 1.06)), near ? 8 : 5, true, (i) => (kind[i] === 1 ? 0.7 : 1)),
    '#a8865f',
    { sway: swayTrunk, surf: SF.matte },
  );
  const T = curve.getPoint(1);
  const tD = curve.getTangent(1).normalize();
  const up = V(0, 1, 0);
  // crown shaft + dead frond boots
  b.add(cyl(0.17, 0.25, 1, near ? 8 : 5), '#7c6d3f', { sway: 1, surf: SF.matte }, alongSegment(T.clone().addScaledVector(tD, -0.55), T.clone().addScaledVector(tD, 0.12)));
  if (near) {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.4;
      const d = V(Math.cos(a), 0, Math.sin(a));
      const s0 = T.clone().addScaledVector(tD, -0.42);
      b.add(cyl(0.0, 0.08, 1, 4), '#8d6c45', { sway: 1, flat: true }, alongSegment(s0, s0.clone().addScaledVector(d, 0.5).addScaledVector(up, -0.32), 1));
    }
    const nut = new THREE.IcosahedronGeometry(0.12, 0);
    const nuts = [[0.18, -0.25, 0.1], [-0.12, -0.28, 0.16], [0.02, -0.3, -0.19], [-0.17, -0.22, -0.08]];
    nuts.forEach((n, i) => b.add(nut, i === 2 ? '#8a8a3a' : '#71522c', { sway: 1, flat: true }, M(T.x + n[0], T.y + n[1], T.z + n[2])));
  }
  // fronds: two tiers (drooping lower, perkier upper)
  const tiers = near
    ? [{ n: 7, elev: 0.3, droop: 1.75, L: 3.2, w: 0.5, off: 0.2 }, { n: 6, elev: 0.8, droop: 1.35, L: 2.6, w: 0.42, off: 0.72 }]
    : [{ n: 7, elev: 0.5, droop: 1.6, L: 3.0, w: 0.5, off: 0.2 }];
  const S = near ? 11 : 4;
  const green0 = new THREE.Color('#3d8442'), green1 = new THREE.Color('#9acb63');
  let fi = 0;
  for (const tier of tiers) {
    for (let i = 0; i < tier.n; i++, fi++) {
      const az = ((i + tier.off) / tier.n) * Math.PI * 2 + Math.sin(fi * 7.1) * 0.12;
      const dir = V(Math.cos(az), 0, Math.sin(az));
      const side = new THREE.Vector3().crossVectors(dir, up).normalize();
      const L = tier.L * (0.9 + 0.2 * Math.abs(Math.sin(fi * 3.3)));
      const pts: THREE.Vector3[] = [];
      const p = T.clone().addScaledVector(tD, 0.05);
      for (let k = 0; k < S; k++) {
        const s = k / (S - 1);
        pts.push(p.clone());
        const th = tier.elev - tier.droop * Math.pow(s, 1.3);
        p.addScaledVector(dir, Math.cos(th) * (L / (S - 1))).addScaledVector(up, Math.sin(th) * (L / (S - 1)));
      }
      const pos: number[] = [];
      for (let k = 0; k < S - 1; k++) {
        const quad = (ka: number) => {
          const s = ka / (S - 1);
          let w = tier.w * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.08)), 0.75) * (s < 0.1 ? s / 0.1 : 1);
          if (near && ka % 2 === 1) w *= 0.5; // leaflet serration
          const c = pts[ka];
          const fold = w * 0.4;
          return {
            l: c.clone().addScaledVector(side, -w).addScaledVector(up, -fold),
            m: c.clone(),
            r: c.clone().addScaledVector(side, w).addScaledVector(up, -fold),
            s,
          };
        };
        const A = quad(k), B = quad(k + 1);
        const push = (...vs: THREE.Vector3[]) => vs.forEach((v) => pos.push(v.x, v.y, v.z));
        push(A.l, A.m, B.l, A.m, B.m, B.l, A.m, A.r, B.m, A.r, B.r, B.m);
      }
      const Tc = T.clone();
      b.add(soup(pos), W, {
        tint: 1,
        surf: SF.foliage,
        flat: true,
        jitter: 0.05,
        sway: (x, y, z) => 1 + Math.min(1, Math.hypot(x - Tc.x, y - Tc.y, z - Tc.z) / 3),
        colorFn: (x, y, z, out) => {
          const t = Math.min(1, Math.hypot(x - Tc.x, y - Tc.y, z - Tc.z) / 3.2);
          out.copy(green0).lerp(green1, t * t);
        },
      });
    }
  }
  return b.build();
}

// ───────────────────────────── trees ─────────────────────────────
function blob(b: GeoBuilder, cx: number, cy: number, cz: number, r: number, detail: number, sway: number): void {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = hash3(x + cx, y + cy, z + cz);
    const k = 1 + (h - 0.5) * 0.28;
    p.setXYZ(i, x * k, y * k * 0.86, z * k);
  }
  b.add(g, W, {
    tint: 1,
    surf: SF.foliage,
    flat: true,
    jitter: 0.07,
    sway,
    colorFn: (_x, y, _z, out) => {
      const t = Math.min(1, Math.max(0, (y - (cy - r)) / (2 * r)));
      out.multiplyScalar(0.62 + 0.5 * t);
    },
  }, M(cx, cy, cz));
}

export function treeRound(lod: number): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.4, 0.25);
  const bark = '#7f6249';
  if (lod === 0) {
    const trunk = new THREE.CatmullRomCurve3([V(0, 0, 0), V(0.08, 1.2, 0.04), V(0.02, 2.4, -0.05), V(0, 3.0, 0)]);
    b.add(tubeAlong(trunk, [0, 0.03, 0.3, 0.6, 1], (t, i) => (i === 0 ? 0.3 : 0.2 - 0.08 * t), 7, false), bark, { sway: (_x, y) => Math.max(0, y - 1.5) * 0.08 });
    const br = [[0.9, 3.2, 0.3], [-0.8, 3.3, -0.4], [-0.2, 3.1, 0.9]];
    for (const q of br) b.add(cyl(0.05, 0.09, 1, 5), bark, { sway: 0.15 }, alongSegment(V(0.03, 2.0, 0), V(q[0] * 0.8, q[1] * 0.9, q[2] * 0.8)));
    blob(b, 0, 3.65, 0, 1.55, 1, 0.3);
    blob(b, 0.95, 3.2, 0.35, 1.1, 1, 0.3);
    blob(b, -0.85, 3.3, -0.4, 1.15, 1, 0.3);
    blob(b, 0.15, 4.5, -0.15, 1.0, 1, 0.35);
    blob(b, -0.25, 3.15, 0.95, 0.95, 1, 0.3);
  } else {
    b.add(cyl(0.12, 0.2, 2.6, 5, true), bark, {}, M(0, 1.3, 0));
    blob(b, 0, 3.6, 0, 1.85, 0, 0.3);
    blob(b, 0.3, 4.45, -0.1, 1.15, 0, 0.35);
  }
  return b.build();
}

export function treeCypress(lod: number): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.4, 0.25);
  const seg = lod === 0 ? 9 : 5;
  b.add(lathe([[0.16, 0], [0.11, 0.9]], seg, 30), '#7a5d45', {});
  const prof = lod === 0
    ? [[0, 0.55], [0.42, 0.7], [0.78, 1.3], [0.88, 2.2], [0.8, 3.2], [0.6, 4.2], [0.34, 5.0], [0.12, 5.55], [0, 5.75]]
    : [[0, 0.6], [0.8, 1.4], [0.85, 2.6], [0.5, 4.4], [0, 5.75]];
  b.add(lathe(prof, seg, 25), W, {
    tint: 1,
    surf: SF.foliage,
    flat: true,
    jitter: 0.08,
    sway: (_x, y) => Math.max(0, y - 0.6) * 0.07,
    colorFn: (x, y, z, out) => out.multiplyScalar(0.7 + 0.35 * Math.min(1, y / 5.5) + (hash3(x, y, z) - 0.5) * 0.08),
  });
  return b.build();
}

// ───────────────────────────── bench ─────────────────────────────
/** Bench with `seats` seats: seat-surface centre at (0, benchSeatHeight, 0), sitter faces +Z, backrest behind (−Z). */
export function bench(seats: number): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.3, 0.25);
  const hs = CONFIG.props.benchSeatHeight;
  const L = seats * CONFIG.props.benchSeatSpacing + 0.12;
  const wood: PartOpts = { tint: 1, surf: SF.matte };
  for (const z of [-0.165, -0.055, 0.055, 0.165]) b.add(slatX(L, 0.04, 0.095), W, wood, M(0, hs - 0.02, z));
  for (const y of [0.6, 0.71, 0.82]) b.add(slatX(L, 0.075, 0.03), W, wood, M(0, y, -0.25 - (y - 0.5) * 0.25, -0.24));
  // cast-iron side frames (extruded silhouette)
  const frame = [
    [0.27, 0.0], [0.27, 0.035], [0.2, 0.06], [0.19, hs - 0.075], [0.22, hs - 0.04], [-0.215, hs - 0.04], [-0.335, 0.93], [-0.385, 0.93],
    [-0.27, hs - 0.06], [-0.24, 0.06], [-0.31, 0.035], [-0.31, 0.0], [-0.17, 0.0], [-0.18, 0.05], [-0.16, hs - 0.13], [0.11, hs - 0.13],
    [0.12, 0.05], [0.14, 0.0],
  ];
  const fg = extrude(frame, 0.045).rotateY(-Math.PI / 2);
  const iron: PartOpts = { surf: SF.metal };
  const xs = seats >= 3 ? [-L / 2 + 0.08, 0, L / 2 - 0.08] : [-L / 2 + 0.08, L / 2 - 0.08];
  for (const x of xs) b.add(fg, P.iron, iron, M(x, 0, 0));
  for (const x of [-L / 2 + 0.08, L / 2 - 0.08]) {
    b.add(box(0.06, 0.035, 0.5), P.iron, iron, M(x, 0.665, -0.03));
    b.add(cylX(0.038, 0.065, 8), P.iron, iron, M(x, 0.645, 0.215));
    b.add(box(0.04, 0.22, 0.04), P.iron, iron, M(x, 0.54, 0.17));
  }
  return b.build();
}

// ───────────────────────────── bin ─────────────────────────────
export function bin(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop');
  const seg = 12;
  b.add(lathe([[0, 0], [0.25, 0], [0.25, 0.05], [0.215, 0.075]], seg), P.iron, metal);
  b.add(lathe([[0.2, 0.075], [0.255, 0.12], [0.27, 0.2], [0.27, 0.82], [0.25, 0.86]], seg, 30), W, tinted);
  b.add(lathe([[0.274, 0.17], [0.282, 0.18], [0.282, 0.23], [0.274, 0.24]], seg), P.gold, metal);
  b.add(lathe([[0.274, 0.72], [0.282, 0.73], [0.282, 0.78], [0.274, 0.79]], seg), P.gold, metal);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    b.add(box(0.032, 0.46, 0.022), '#e8e8e8', { tint: 1, surf: SF.gloss }, M(Math.sin(a) * 0.272, 0.475, Math.cos(a) * 0.272, 0, a, 0));
  }
  b.add(lathe([[0.2, 0.86], [0.295, 0.875], [0.295, 0.93], [0.23, 0.955], [0.16, 1.0], [0.07, 1.035], [0.045, 1.06], [0.06, 1.09], [0, 1.12]], seg, 35), P.iron, metal);
  b.add(lathe([[0.262, 0.86], [0.262, 0.875]], seg), P.black, {});
  b.add(cylZ(0.055, 0.012, 10), P.gold, metal, M(0, 0.5, 0.272));
  return b.build();
}

// ───────────────────────────── hydrant ─────────────────────────────
export function hydrant(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.2, 0.2);
  const seg = 12;
  b.add(lathe([[0, 0], [0.17, 0], [0.17, 0.05], [0.14, 0.07], [0.135, 0.1], [0.12, 0.12], [0.12, 0.43]], seg, 30), W, tinted);
  b.add(lathe([[0.123, 0.43], [0.123, 0.47]], seg), '#f7f4ec', { surf: SF.gloss });
  b.add(lathe([[0.12, 0.47], [0.12, 0.5], [0.15, 0.52], [0.15, 0.57], [0.12, 0.59], [0.115, 0.62], [0.09, 0.68], [0.05, 0.72], [0, 0.725]], seg, 40), W, tinted);
  b.add(cyl(0.035, 0.042, 0.07, 5), '#d9d6cc', metal, M(0, 0.755, 0));
  for (const s of [-1, 1]) {
    b.add(cylX(0.058, 0.09, 10), W, tinted, M(s * 0.15, 0.4, 0));
    b.add(cylX(0.064, 0.035, 10), '#d9d6cc', metal, M(s * 0.208, 0.4, 0));
    b.add(cylX(0.022, 0.03, 5), '#d9d6cc', metal, M(s * 0.235, 0.4, 0));
  }
  b.add(cylZ(0.075, 0.1, 10), W, tinted, M(0, 0.33, 0.15));
  b.add(cylZ(0.082, 0.04, 10), '#d9d6cc', metal, M(0, 0.33, 0.215));
  b.add(cylZ(0.028, 0.03, 5), '#d9d6cc', metal, M(0, 0.33, 0.245));
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    b.add(box(0.025, 0.02, 0.025), '#d9d6cc', metal, M(Math.sin(a) * 0.155, 0.06, Math.cos(a) * 0.155));
  }
  return b.build();
}

// ───────────────────────────── cone ─────────────────────────────
export function cone(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.12, 0.25);
  b.add(lathe([[0.3, 0], [0.3, 0.03], [0.275, 0.045], [0.18, 0.048]], 4, 20, Math.PI / 4), '#2c2f33', {});
  const r = (y: number) => 0.175 - (y - 0.045) * 0.194;
  const bands: [number, number, boolean][] = [[0.045, 0.2, false], [0.2, 0.31, true], [0.31, 0.42, false], [0.42, 0.52, true], [0.52, 0.68, false]];
  for (const [y0, y1, white] of bands) {
    b.add(lathe([[r(y0), y0], [r(y1), y1]], 14), white ? '#f6f6f2' : W, white ? { surf: SF.gloss } : { tint: 1, surf: SF.gloss });
  }
  b.add(lathe([[r(0.68), 0.68], [0.04, 0.705], [0, 0.712]], 14, 50), W, { tint: 1, surf: SF.gloss });
  return b.build();
}

// ───────────────────────────── barrier (sawhorse) ─────────────────────────────
export function barrier(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.2, 0.2);
  const legC = '#ece8de';
  for (const x of [-0.64, 0.64]) {
    for (const s of [-1, 1]) b.add(box(0.045, 1.0, 0.055), legC, {}, M(x, 0.48, s * 0.085, -s * 0.17, 0, 0));
    b.add(box(0.09, 0.035, 0.36), '#2b2e31', {}, M(x, 0.0175, 0));
    b.add(box(0.05, 0.05, 0.2), legC, {}, M(x, 0.2, 0));
  }
  stripedPanel(b, 1.62, 0.24, 0.035, 0.2, 0.9, ['#e8483f', '#fbf7f0'], M(0, 0.84, 0.035), { surf: SF.gloss });
  stripedPanel(b, 1.62, 0.16, 0.035, 0.2, 0.9, ['#e8483f', '#fbf7f0'], M(0, 0.46, 0.035), { surf: SF.gloss });
  b.add(box(0.11, 0.14, 0.07), '#2a2d30', {}, M(-0.62, 1.04, 0.035));
  b.add(cylZ(0.05, 0.03, 10), '#ffb21e', { emit: EM.blink, surf: SF.glass }, M(-0.62, 1.04, 0.08));
  b.add(cylZ(0.05, 0.03, 10), '#ffb21e', { emit: EM.blink, surf: SF.glass }, M(-0.62, 1.04, -0.01));
  return b.build();
}

// ───────────────────────────── bus stop shelter ─────────────────────────────
export const BUS_LAMP = { x: 0, y: 2.46, z: 0.15 };

/** Shelter: base centre at origin, faces the road (+Z). Bench seat centre at (0, seatHeight, busStopBenchOffset). */
export function busStop(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.25, 0.2);
  const cream = P.cream;
  b.add(box(3.9, 0.06, 1.9), P.sidewalk, {}, M(0, 0.03, 0));
  for (const x of [-1.68, 1.68]) for (const z of [0.74, -0.72]) b.add(box(0.07, 2.5, 0.07), cream, metal, M(x, 1.28, z));
  // curved art-deco canopy
  const roof = [[-0.85, 2.5], [0.2, 2.56], [0.78, 2.6], [1.02, 2.64], [1.03, 2.71], [0.96, 2.76], [0.6, 2.73], [0.2, 2.69], [-0.85, 2.62]];
  b.add(extrude(roof, 3.9, 0.012).rotateY(-Math.PI / 2), W, tinted);
  b.add(box(3.93, 0.035, 0.06), cream, { surf: SF.gloss }, M(0, 2.69, 1.0));
  b.add(box(3.93, 0.03, 0.05), cream, { surf: SF.gloss }, M(0, 2.6, -0.86));
  // back wall
  b.add(box(3.25, 1.72, 0.025), P.glass, { surf: SF.glass }, M(0, 1.27, -0.72));
  b.add(box(3.36, 0.06, 0.06), cream, metal, M(0, 2.15, -0.72));
  b.add(box(3.36, 0.06, 0.06), cream, metal, M(0, 0.39, -0.72));
  b.add(box(3.3, 0.3, 0.03), W, tinted, M(0, 0.2, -0.72));
  // deco fins on the glass
  for (const x of [-0.55, 0.55]) b.add(box(0.03, 1.72, 0.035), cream, metal, M(x, 1.27, -0.72));
  // side lightbox with a sunny poster
  b.add(box(0.14, 1.85, 1.3), cream, metal, M(1.68, 1.25, 0.0));
  const pe: PartOpts = { emit: EM.panel };
  b.add(box(0.146, 1.58, 1.12), P.sky, pe, M(1.68, 1.28, 0));
  b.add(cylX(0.2, 0.152, 14), P.butter, pe, M(1.68, 1.5, 0.15));
  b.add(box(0.152, 0.38, 1.12), P.sea, pe, M(1.68, 0.95, 0));
  b.add(box(0.152, 0.17, 1.12), P.sand, pe, M(1.68, 0.67, 0));
  b.add(box(0.152, 0.09, 0.74), P.coral, pe, M(1.68, 1.92, 0));
  b.add(box(0.154, 0.16, 0.06), '#ffffff', pe, M(1.68, 1.03, -0.2));
  // bench (3 seats) on cantilever brackets
  const hs = CONFIG.props.benchSeatHeight;
  const bz = CONFIG.props.busStopBenchOffset;
  const L = 3 * CONFIG.props.benchSeatSpacing + 0.1;
  for (const dz of [-0.12, 0, 0.12]) b.add(slatX(L, 0.04, 0.105), '#c48a58', { surf: SF.matte }, M(0, hs - 0.02, bz + dz));
  b.add(slatX(L, 0.08, 0.03), '#c48a58', { surf: SF.matte }, M(0, 0.74, -0.68));
  for (const x of [-L / 2 + 0.15, L / 2 - 0.15]) {
    b.add(box(0.05, 0.05, 0.42), P.iron, metal, M(x, hs - 0.065, bz - 0.02));
    b.add(box(0.05, hs - 0.09, 0.05), P.iron, metal, M(x, (hs - 0.09) / 2, bz + 0.13));
  }
  // light strip
  b.add(box(2.8, 0.03, 0.14), P.lampWarm, { emit: EM.lamp, surf: SF.glass }, M(BUS_LAMP.x, BUS_LAMP.y + 0.02, BUS_LAMP.z));
  // bus sign pole
  b.add(lathe([[0.07, 0], [0.07, 0.05], [0.045, 0.08], [0.045, 2.75], [0, 2.78]], 8), P.steel, metal, M(-2.05, 0, 0.75));
  b.add(cylZ(0.3, 0.035, 18), '#ffffff', pe, M(-2.05, 2.5, 0.75));
  b.add(cylZ(0.255, 0.045, 18), '#2a8fbd', pe, M(-2.05, 2.5, 0.75));
  b.add(box(0.26, 0.13, 0.05), '#ffffff', pe, M(-2.05, 2.51, 0.756));
  for (const x of [-0.07, 0.0, 0.07]) b.add(box(0.05, 0.045, 0.054), '#2a8fbd', pe, M(-2.05 + x, 2.535, 0.757));
  return b.build();
}

// ───────────────────────────── traffic light ─────────────────────────────
export function trafficLight(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.2, 0.2);
  const pole = '#3a4345';
  b.add(lathe([[0, 0], [0.17, 0], [0.17, 0.06], [0.13, 0.1], [0.12, 0.25], [0.085, 0.3], [0.078, 3.6], [0.09, 3.64], [0.06, 3.7], [0, 3.74]], 10, 30), pole, metal);
  b.add(box(0.06, 0.06, 0.24), pole, metal, M(0, 3.28, 0.12));
  b.add(box(0.06, 0.06, 0.24), pole, metal, M(0, 2.62, 0.12));
  // housing + backplate with a butter border
  b.add(extrude(chamferRect(0.34, 1.0, 0.05), 0.24, 0.012), W, { tint: 1, surf: SF.gloss }, M(0, 2.95, 0.3));
  b.add(extrude(chamferRect(0.54, 1.24, 0.1), 0.03), P.black, {}, M(0, 2.95, 0.165));
  b.add(frameRing(0.56, 1.26, 0.48, 1.18, 0.1, 0.006), '#ffd84a', { surf: SF.gloss }, M(0, 2.95, 0.183));
  const lens = lathe([[0.105, 0], [0.105, 0.012], [0.08, 0.035], [0, 0.046]], 12, 50).rotateX(Math.PI / 2);
  const visor = new THREE.CylinderGeometry(0.128, 0.128, 0.22, 10, 1, true, Math.PI / 2, Math.PI).rotateX(Math.PI / 2);
  const lamps: [number, string, number][] = [[3.27, '#ff4a3d', EM.red], [2.95, '#ffb21e', EM.amber], [2.63, '#2fe08a', EM.green]];
  for (const [y, c, e] of lamps) {
    b.add(cylZ(0.115, 0.02, 12), P.black, {}, M(0, y, 0.425));
    b.add(lens, c, { emit: e, surf: SF.glass }, M(0, y, 0.43));
    b.add(visor, W, { tint: 1, surf: SF.gloss, doubleSided: true }, M(0, y, 0.53));
  }
  b.add(box(0.09, 0.15, 0.07), '#ffd23f', { surf: SF.gloss }, M(0, 1.1, 0.1));
  b.add(cylZ(0.025, 0.02, 8), P.black, {}, M(0, 1.12, 0.14));
  // art-deco street blade on top
  b.add(extrude(chamferRect(0.8, 0.17, 0.03), 0.028), '#1d5a4a', { surf: SF.gloss }, M(0.3, 3.55, 0, 0, 0, 0));
  b.add(extrude(chamferRect(0.72, 0.1, 0.02), 0.032), '#f4f1e6', {}, M(0.3, 3.55, 0));
  b.add(extrude(chamferRect(0.66, 0.06, 0.01), 0.036), '#1d5a4a', {}, M(0.3, 3.55, 0));
  return b.build();
}

// ───────────────────────────── sign ─────────────────────────────
export function sign(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.15, 0.2);
  b.add(lathe([[0, 0], [0.07, 0], [0.07, 0.05], [0.045, 0.08], [0.04, 2.3], [0.052, 2.32], [0.052, 2.36], [0.03, 2.4], [0.042, 2.45], [0, 2.5]], 8, 40), P.steel, metal);
  b.add(box(0.08, 0.05, 0.06), P.iron, metal, M(0, 2.12, 0.03));
  b.add(box(0.08, 0.05, 0.06), P.iron, metal, M(0, 1.78, 0.03));
  b.add(extrude(chamferRect(0.72, 0.48, 0.07), 0.035, 0.008), W, tinted, M(0, 1.95, 0.075));
  const wb = '#f7f5ee';
  b.add(extrude(chamferRect(0.64, 0.4, 0.05), 0.037), wb, {}, M(0, 1.95, 0.077));
  b.add(extrude(chamferRect(0.6, 0.36, 0.045), 0.039), W, tinted, M(0, 1.95, 0.078));
  b.add(box(0.3, 0.07, 0.04), wb, {}, M(-0.04, 1.95, 0.08));
  b.add(extrude([[0, 0.13], [0.17, 0], [0, -0.13]], 0.04), wb, {}, M(0.1, 1.95, 0.08));
  return b.build();
}

/** Road signs with real faces (world placement variants: 0 stop, 2 jump warning, 3 parking, 4 roadworks). */
export type SignFace = 'stop' | 'jump' | 'parking' | 'works';
export function signFace(face: SignFace): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.15, 0.2);
  b.add(lathe([[0, 0], [0.07, 0], [0.07, 0.05], [0.045, 0.08], [0.04, 2.3], [0.052, 2.32], [0.052, 2.36], [0.03, 2.4], [0.042, 2.45], [0, 2.5]], 8, 40), P.steel, metal);
  b.add(box(0.08, 0.05, 0.06), P.iron, metal, M(0, 2.12, 0.03));
  b.add(box(0.08, 0.05, 0.06), P.iron, metal, M(0, 1.78, 0.03));
  const white = '#f7f5ee';
  const ngon = (n: number, r: number, rot: number) =>
    Array.from({ length: n }, (_, i) => [Math.cos(rot + (i / n) * Math.PI * 2) * r, Math.sin(rot + (i / n) * Math.PI * 2) * r]);
  const tri = (s: number) => [[0, s], [s * 0.94, -s * 0.66], [-s * 0.94, -s * 0.66]];
  const at = (z: number) => M(0, 1.95, z);
  if (face === 'stop') {
    b.add(extrude(ngon(8, 0.38, Math.PI / 8), 0.035, 0.006), white, {}, at(0.075));
    b.add(extrude(ngon(8, 0.34, Math.PI / 8), 0.037), '#d8332b', {}, at(0.077));
    b.add(box(0.42, 0.1, 0.04), white, {}, at(0.081));
  } else if (face === 'jump') {
    b.add(extrude(tri(0.46), 0.035, 0.006), '#d8332b', {}, at(0.075));
    b.add(extrude(tri(0.36), 0.037), white, {}, M(0, 1.93, 0.077));
    b.add(extrude([[-0.2, -0.13], [0.16, -0.13], [0.16, 0.03]], 0.039), '#1d2a44', {}, M(0, 1.93, 0.079)); // ramp
    b.add(box(0.12, 0.05, 0.04), '#1d2a44', {}, M(0.02, 1.99, 0.081, 0, 0, 0.42)); // car leaving it
  } else if (face === 'parking') {
    b.add(extrude(chamferRect(0.56, 0.56, 0.06), 0.035, 0.006), white, {}, at(0.075));
    b.add(extrude(chamferRect(0.5, 0.5, 0.05), 0.037), '#2a6fd0', {}, at(0.077));
    b.add(box(0.07, 0.36, 0.04), white, {}, M(-0.08, 1.95, 0.081));
    b.add(box(0.18, 0.06, 0.04), white, {}, M(0.0, 2.1, 0.081));
    b.add(box(0.18, 0.06, 0.04), white, {}, M(0.0, 1.97, 0.081));
    b.add(box(0.06, 0.19, 0.04), white, {}, M(0.08, 2.035, 0.081));
  } else {
    b.add(extrude(ngon(4, 0.42, Math.PI / 4).map(([x, y]) => [x, y]), 0.035, 0.006), '#1d2a44', {}, M(0, 1.95, 0.075, 0, 0, Math.PI / 4));
    b.add(extrude(ngon(4, 0.37, Math.PI / 4), 0.037), '#ff9a2e', {}, M(0, 1.95, 0.077, 0, 0, Math.PI / 4));
    b.add(box(0.06, 0.4, 0.04), '#1d2a44', {}, M(-0.07, 1.95, 0.081, 0, 0, 0.6));
    b.add(box(0.06, 0.4, 0.04), '#1d2a44', {}, M(0.09, 1.95, 0.081, 0, 0, 0.6));
  }
  return b.build();
}

// ───────────────────────────── airport: fuel truck ─────────────────────────────
function wheelSet(b: GeoBuilder, r: number, w: number, at: number[][]): void {
  const tyre = lathe([[r * 0.6, -w / 2], [r * 0.93, -w / 2], [r, -w * 0.35], [r, w * 0.35], [r * 0.93, w / 2], [r * 0.6, w / 2]], 14, 40).rotateZ(Math.PI / 2);
  for (const p of at) {
    b.add(tyre, '#1e2124', {}, M(p[0], p[1], p[2]));
    b.add(cylX(r * 0.6, w * 0.92, 10), '#c9ced2', metal, M(p[0], p[1], p[2]));
    b.add(cylX(r * 0.18, w * 1.0, 6), '#8d949b', metal, M(p[0], p[1], p[2]));
  }
}

export function fuelTruck(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.3, 0.2);
  b.add(box(1.9, 0.3, 7.6), '#2a2d31', {}, M(0, 0.68, 0));
  // cab
  const cab = [[2.3, 0.75], [3.95, 0.75], [4.0, 1.45], [3.76, 2.72], [3.55, 2.86], [2.3, 2.86]];
  b.add(extrude(cab, 2.45, 0.04).rotateY(-Math.PI / 2), W, tinted);
  b.add(box(2.2, 0.95, 0.03), '#2e4352', { surf: SF.glass }, M(0, 2.12, 3.9, -0.175));
  for (const s of [-1, 1]) b.add(box(0.03, 0.72, 0.95), '#2e4352', { surf: SF.glass }, M(s * 1.235, 2.18, 3.0));
  b.add(box(2.42, 0.32, 0.16), '#30353a', {}, M(0, 0.82, 4.02));
  b.add(box(1.0, 0.28, 0.04), '#1b1f22', {}, M(0, 1.2, 4.01));
  for (const s of [-1, 1]) b.add(box(0.32, 0.16, 0.05), '#fffbea', { surf: SF.glass }, M(s * 0.85, 1.12, 4.0));
  b.add(lathe([[0.12, 0], [0.12, 0.05], [0.09, 0.14], [0, 0.17]], 10, 50), '#ffb21e', { emit: EM.blink, surf: SF.glass }, M(0, 2.86, 3.0));
  for (const s of [-1, 1]) b.add(box(0.06, 0.2, 0.14), P.dark, {}, M(s * 1.3, 2.3, 3.75));
  // tank
  const tank = lathe([[0, 0], [0.72, 0.02], [1.0, 0.18], [1.05, 0.4], [1.05, 4.3], [1.0, 4.52], [0.72, 4.68], [0, 4.7]], 16, 40).rotateX(Math.PI / 2);
  b.add(tank, '#e9edf0', { surf: SF.metal }, M(0, 1.92, -3.55));
  for (const z of [-3.15, -1.2, 0.75]) b.add(lathe([[1.06, 0], [1.065, 0.01], [1.065, 0.3], [1.06, 0.31]], 16).rotateX(Math.PI / 2), W, tinted, M(0, 1.92, z));
  for (const z of [-3.0, -1.2, 0.6]) b.add(box(1.7, 0.35, 0.18), '#2a2d31', {}, M(0, 0.98, z));
  b.add(box(0.5, 0.12, 2.0), '#c9ced2', metal, M(0, 3.0, -1.2));
  // rear ladder + hose reel
  for (const s of [-1, 1]) b.add(box(0.04, 1.9, 0.04), '#c9ced2', metal, M(s * 0.25, 1.9, -3.75));
  for (let k = 0; k < 6; k++) b.add(box(0.5, 0.03, 0.03), '#c9ced2', metal, M(0, 1.1 + k * 0.32, -3.75));
  b.add(cylX(0.32, 0.5, 12), '#3a3f44', {}, M(0.8, 1.2, -3.55));
  b.add(stripeHelper(), W, tinted);
  wheelSet(b, 0.5, 0.36, [[1.03, 0.5, 3.0], [-1.03, 0.5, 3.0], [1.03, 0.5, -1.6], [-1.03, 0.5, -1.6], [1.03, 0.5, -2.7], [-1.03, 0.5, -2.7]]);
  for (const s of [-1, 1]) {
    b.add(box(0.42, 0.06, 1.2), '#2a2d31', {}, M(s * 1.03, 1.06, 3.0));
    b.add(box(0.42, 0.06, 2.4), '#2a2d31', {}, M(s * 1.03, 1.06, -2.15));
  }
  return b.build();

  function stripeHelper(): THREE.BufferGeometry {
    // long side stripe on the tank flanks
    return new THREE.BoxGeometry(2.14, 0.16, 4.0).translate(0, 1.6, -1.2);
  }
}

// ───────────────────────────── airport: baggage cart ─────────────────────────────
export function baggageCart(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.25, 0.2);
  b.add(extrude(chamferRect(2.7, 0.12, 0.03), 1.5).rotateY(-Math.PI / 2), W, tinted, M(0, 0.48, 0));
  for (const s of [-1, 1]) {
    b.add(box(0.04, 0.04, 2.6), '#d8dcdf', metal, M(s * 0.73, 0.78, 0));
    for (const z of [-1.3, 1.3]) b.add(box(0.05, 1.32, 0.05), '#d8dcdf', metal, M(s * 0.73, 1.16, z));
  }
  b.add(extrude([[-1.45, 0], [1.45, 0], [1.45, 0.05], [0, 0.14], [-1.45, 0.05]], 1.62).rotateY(-Math.PI / 2), W, tinted, M(0, 1.82, 0));
  b.add(box(0.08, 0.06, 0.9), P.dark, {}, M(0, 0.36, 1.75));
  b.add(cylX(0.06, 0.03, 8), P.dark, {}, M(0, 0.36, 2.22));
  wheelSet(b, 0.2, 0.15, [[0.62, 0.2, 1.0], [-0.62, 0.2, 1.0], [0.62, 0.2, -1.0], [-0.62, 0.2, -1.0]]);
  const bags: [number, number, number, number, number, number, string][] = [
    [0.3, 0.75, 0.7, 0.55, 0.4, 0.25, P.coral], [-0.3, 0.75, 0.75, 0.5, 0.42, 0.28, P.aqua], [0.25, 0.71, -0.2, 0.62, 0.34, 0.45, P.lilac],
    [-0.32, 0.79, -0.3, 0.42, 0.5, 0.3, P.butter], [0.0, 0.73, -0.95, 0.9, 0.38, 0.5, '#2f4a6b'], [0.05, 1.08, 0.72, 0.46, 0.3, 0.24, P.mint],
  ];
  for (const [x, y, z, w, h, d, c] of bags) {
    b.add(extrude(chamferRect(w, h, 0.04), d, 0.01), c, { surf: SF.gloss }, M(x, y + h / 2 - 0.2, z));
    b.add(box(0.14, 0.03, 0.03), P.dark, {}, M(x, y + h - 0.18, z));
  }
  return b.build();
}

// ───────────────────────────── airport: windsock ─────────────────────────────
export function windsock(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.25, 0.2);
  b.add(lathe([[0, 0], [0.2, 0], [0.2, 0.08], [0.15, 0.15], [0.065, 0.28], [0.055, 5.5]], 8, 30), '#f2efe8', metal);
  for (const y of [1.2, 2.6, 4.0]) b.add(lathe([[0.058, y], [0.058, y + 0.5]], 8), '#e8483f', metal);
  b.add(lathe([[0.055, 5.5], [0.09, 5.55], [0.09, 5.62], [0.0, 5.7]], 8), P.iron, metal);
  b.add(box(0.5, 0.04, 0.04), P.iron, metal, M(0.22, 5.52, 0));
  b.add(new THREE.TorusGeometry(0.4, 0.022, 4, 14).rotateY(Math.PI / 2), P.iron, { surf: SF.metal, sway: 0.3 }, M(0.48, 5.52, 0));
  const segs = 5;
  for (let k = 0; k < segs; k++) {
    const x0 = 0.48 + k * 0.5, x1 = x0 + 0.5;
    const r0 = 0.4 - k * 0.048, r1 = r0 - 0.048;
    const g = new THREE.CylinderGeometry(r1, r0, 0.5, 12, 1, true).rotateZ(-Math.PI / 2);
    const droop = (x: number) => -0.04 * (x - 0.48) * (x - 0.48);
    const gp = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < gp.count; i++) {
      const xx = gp.getX(i) + (x0 + x1) / 2;
      gp.setY(i, gp.getY(i) + droop(xx));
    }
    b.add(g, k % 2 ? '#fbf7f0' : '#ff6a2a', { surf: SF.matte, doubleSided: true, sway: (x) => 1 + Math.min(1, Math.max(0, (x - 0.48) / 2.5)) }, M((x0 + x1) / 2, 5.52, 0));
  }
  return b.build();
}

// ───────────────────────────── far impostors ─────────────────────────────
/** Unit box with its base at y = 0 (instance scale gives the size). */
export function farBox(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.25, 0.2);
  b.add(box(1, 1, 1), W, { tint: 1 }, M(0, 0.5, 0));
  return b.build();
}

/** Unit frustum (radius 0.5 → 0.36, height 1) with its base at y = 0. */
export function farCyl(): THREE.BufferGeometry {
  const b = new GeoBuilder('prop', 0.25, 0.2);
  b.add(lathe([[0.5, 0], [0.36, 1], [0, 1.02]], 7, 30), W, { tint: 1 });
  return b.build();
}
