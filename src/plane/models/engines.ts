import * as THREE from 'three';
import { GeoBuilder, PAINT, METAL, DARK, MATTE, VAR, type RGB, mix, prng, v3, frameAlong } from './builder';

/**
 * Engines: turbofan nacelle (lathe: chrome lip, painted cowl, fan duct, fan + spinner, bypass nozzle, core cowl and
 * plug), pylons, the torn variant (missing cowl chunks, an open panel, soot, wrecked fan) and the propeller engine.
 * Nacelle local frame: +Z forward, origin at the intake lip centre.
 */

export interface FanSpec {
  length: number;
  rMax: number;
  rLip: number;
  rFan: number;
  cowl: RGB;
  lipColor?: RGB;
  blades: number;
  seg: number; // around
  detail: 0 | 1 | 2;
}

const CHROME: RGB = [0.75, 0.76, 0.78];
const DUCT: RGB = [0.11, 0.115, 0.13];
const NOZZLE: RGB = [0.22, 0.22, 0.24];
const CORE: RGB = [0.5, 0.5, 0.52];
const SOOT: RGB = [0.025, 0.022, 0.02];

/** Intact or torn nacelle, in the current builder matrix (nacelle frame). */
export function buildNacelle(b: GeoBuilder, S: FanSpec, engine: number, fanSurf: number, damaged: boolean, seed = 1): void {
  const L = S.length;
  const seg = S.seg;
  const rnd = prng(seed * 977 + engine);
  b.variant = damaged ? VAR.damaged(engine) : VAR.intact(engine);
  const soot = (c: RGB, k: number): RGB => (damaged ? mix(c, SOOT, k) : c);
  const cowlProfile: [number, number][] = [
    [S.rMax * 0.9, -0.8 * L],
    [S.rMax * 0.98, -0.6 * L],
    [S.rMax, -0.33 * L],
    [S.rMax * 0.985, -0.18 * L],
    [S.rLip * 1.06, -0.04 * L],
    [S.rLip * 1.02, -0.01 * L],
  ];
  const lipProfile: [number, number][] = [
    [S.rLip * 1.02, -0.01 * L],
    [S.rLip, 0],
    [S.rLip * 0.95, -0.012 * L],
    [S.rFan * 1.04, -0.05 * L],
  ];
  const ductProfile: [number, number][] = [
    [S.rFan * 1.04, -0.05 * L],
    [S.rFan * 1.0, -0.12 * L],
    [S.rFan * 0.98, -0.2 * L],
  ];
  const segs = damaged ? tornRanges(seg, rnd) : [[0, seg]];
  for (const [s0, s1] of segs) {
    const a0 = (s0 / seg) * Math.PI * 2;
    const a1 = (s1 / seg) * Math.PI * 2;
    const ns = Math.max(1, s1 - s0);
    b.set({ color: soot(S.cowl, 0.75), mat: damaged ? MATTE : PAINT });
    b.lathe(cowlProfile, ns, { a0, a1 });
    b.set({ color: soot(S.lipColor ?? CHROME, 0.6), mat: damaged ? MATTE : METAL });
    b.lathe(lipProfile, ns, { a0, a1 });
  }
  // inner duct always complete (seen through the holes)
  b.set({ color: DUCT, mat: DARK });
  b.lathe(ductProfile, seg);
  // fan exit nozzle + core (outer surfaces traversed with z ascending → outward normals)
  b.set({ color: soot(NOZZLE, 0.5), mat: METAL });
  b.lathe([[S.rMax * 0.8, -0.835 * L], [S.rMax * 0.9, -0.8 * L]], seg);
  b.set({ color: DUCT, mat: DARK });
  b.disc(S.rMax * 0.8, -0.835 * L, seg, -1, S.rMax * 0.58);
  b.set({ color: soot(CORE, 0.6), mat: METAL });
  b.lathe([[S.rMax * 0.42, -1.0 * L], [S.rMax * 0.5, -0.97 * L], [S.rMax * 0.6, -0.84 * L], [S.rMax * 0.58, -0.82 * L]], seg);
  b.set({ color: DUCT, mat: DARK });
  b.disc(S.rMax * 0.42, -1.0 * L, seg, -1, S.rMax * 0.37);
  b.set({ color: soot(NOZZLE, 0.7), mat: METAL });
  b.lathe([[0.002, -1.13 * L], [S.rMax * 0.3, -1.04 * L], [S.rMax * 0.37, -1.0 * L]], Math.max(6, seg >> 1));
  // fan face disc behind blades
  b.set({ color: [0.07, 0.07, 0.08], mat: DARK });
  b.disc(S.rFan * 0.99, -0.2 * L, seg, 1);
  if (damaged) {
    // hanging cowl panel (open, hinged at the top) — sooty
    b.set({ color: mix(S.cowl, SOOT, 0.55), mat: MATTE });
    const hinge = v3(0, S.rMax * 0.97, -0.3 * L);
    b.push(new THREE.Matrix4().makeTranslation(hinge.x, hinge.y, hinge.z).multiply(new THREE.Matrix4().makeRotationZ(0.9 + rnd() * 0.5)).multiply(new THREE.Matrix4().makeTranslation(-hinge.x, -hinge.y, -hinge.z)));
    b.lathe([[S.rMax * 1.0, -0.55 * L], [S.rMax * 1.0, -0.3 * L]], 4, { a0: Math.PI * 0.08, a1: Math.PI * 0.42 });
    b.lathe([[S.rMax * 0.97, -0.3 * L], [S.rMax * 0.97, -0.55 * L]], 4, { a0: Math.PI * 0.08, a1: Math.PI * 0.42 });
    b.pop();
  }
  // fan: spinner + blades (rotating)
  b.surf = fanSurf;
  b.set({ color: damaged ? SOOT : [0.2, 0.21, 0.23], mat: METAL });
  const hubR = S.rFan * 0.3;
  b.lathe([[hubR, -0.19 * L], [hubR * 0.9, -0.15 * L], [hubR * 0.55, -0.1 * L], [0.001, -0.06 * L]], Math.max(8, seg >> 1));
  if (!damaged) {
    // white swirl mark on the spinner for visible rotation
    b.set({ color: [0.92, 0.92, 0.9], mat: PAINT });
    b.push(new THREE.Matrix4().makeScale(1.04, 1.04, 1));
    b.lathe([[hubR * 0.75, -0.13 * L], [hubR * 0.45, -0.095 * L], [hubR * 0.12, -0.07 * L]], 4, { a0: 0, a1: 1.2 });
    b.pop();
  }
  const nb = S.detail === 2 ? 0 : S.detail === 1 ? Math.round(S.blades * 0.5) : S.blades;
  b.set({ color: damaged ? mix([0.3, 0.3, 0.32], SOOT, 0.6) : [0.32, 0.33, 0.36], mat: METAL });
  for (let i = 0; i < nb; i++) {
    if (damaged && rnd() < 0.55) continue;
    const a = (i / nb) * Math.PI * 2;
    const len = damaged ? 0.35 + rnd() * 0.6 : 1;
    const bend = damaged ? (rnd() - 0.5) * 0.9 : 0;
    blade(b, a, hubR * 0.95, hubR + (S.rFan * 0.97 - hubR) * len, -0.165 * L, S.rFan * 0.16, bend);
  }
  b.surf = 0;
  b.variant = 0;
}

function tornRanges(seg: number, rnd: () => number): number[][] {
  // remove 2-3 angular chunks
  const keep: boolean[] = new Array(seg).fill(true);
  const chunks = 2 + Math.floor(rnd() * 2);
  for (let c = 0; c < chunks; c++) {
    const at = Math.floor(rnd() * seg);
    const w = 1 + Math.floor(rnd() * Math.max(2, seg / 8));
    for (let k = 0; k < w; k++) keep[(at + k) % seg] = false;
  }
  const out: number[][] = [];
  let s = -1;
  for (let k = 0; k <= seg; k++) {
    const on = k < seg && keep[k];
    if (on && s < 0) s = k;
    if (!on && s >= 0) {
      out.push([s, k]);
      s = -1;
    }
  }
  return out;
}

function blade(b: GeoBuilder, a: number, r0: number, r1: number, z: number, chord: number, bend: number): void {
  // twisted flat blade, double sided
  const pts: THREE.Vector3[][] = [];
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = r0 + (r1 - r0) * t;
    const twist = 0.95 - 0.6 * t; // pitch angle (rad)
    const c = chord * (0.8 + 0.4 * t);
    const aa = a + bend * t * t + 0.12 * t; // slight sweep
    const radial = v3(Math.cos(aa), Math.sin(aa), 0);
    const tang = v3(-Math.sin(aa), Math.cos(aa), 0);
    const chordDir = tang.clone().multiplyScalar(Math.cos(twist)).add(v3(0, 0, -Math.sin(twist)));
    const center = radial.clone().multiplyScalar(r).add(v3(0, 0, z));
    pts.push([center.clone().addScaledVector(chordDir, -c / 2), center.clone().addScaledVector(chordDir, c / 2)]);
  }
  for (let i = 0; i < steps; i++) {
    const A = pts[i][0], B = pts[i][1], C = pts[i + 1][1], D = pts[i + 1][0];
    b.fquad(A, B, C, D);
    b.fquad(A, D, C, B);
  }
}

/** Under-wing pylon from nacelle top (local frame) up to the wing; flat-sided aerodynamic slab. */
export function buildPylon(b: GeoBuilder, p: { zFront: number; zBack: number; yLow: number; yHigh: number; zTopFront: number; zTopBack: number; halfW: number }, color: RGB): void {
  b.set({ color, mat: PAINT });
  const w = p.halfW;
  const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);
  for (const sx of [1, -1]) {
    b.fquadF(v3(sx * w, p.yLow, p.zFront), v3(sx * w * 0.6, p.yLow, p.zBack), v3(sx * w * 0.6, p.yHigh, p.zTopBack), v3(sx * w, p.yHigh, p.zTopFront), X.clone().multiplyScalar(sx));
    const fl = v3(0, p.yLow, p.zFront + w * 1.5), fh = v3(0, p.yHigh, p.zTopFront + w * 1.5);
    b.fquadF(v3(sx * w, p.yLow, p.zFront), fl, fh, v3(sx * w, p.yHigh, p.zTopFront), v3(sx, 0, 1));
  }
  b.fquadF(v3(w * 0.6, p.yLow, p.zBack), v3(w * 0.6, p.yHigh, p.zTopBack), v3(-w * 0.6, p.yHigh, p.zTopBack), v3(-w * 0.6, p.yLow, p.zBack), Z.clone().negate());
  b.fquadF(v3(w, p.yLow, p.zFront), v3(w * 0.6, p.yLow, p.zBack), v3(-w * 0.6, p.yLow, p.zBack), v3(-w, p.yLow, p.zFront), Y.clone().negate());
}

export interface PropSpec {
  spinnerR: number;
  spinnerLen: number;
  bladeLen: number; // hub → tip
  bladeChord: number;
  blades: number;
  spinnerColor: RGB;
  bladeColor: RGB;
  tipColor: RGB;
  seg: number;
  detail: 0 | 1 | 2;
}

/** Spinner + propeller at local origin (prop disc plane z = 0, +Z forward). */
export function buildPropeller(b: GeoBuilder, S: PropSpec, surf: number, damaged: boolean): void {
  b.surf = surf;
  b.variant = damaged ? VAR.damaged(1) : VAR.intact(1);
  b.set({ color: damaged ? mix(S.spinnerColor, SOOT, 0.6) : S.spinnerColor, mat: PAINT });
  const r = S.spinnerR;
  const L = S.spinnerLen;
  b.lathe([[r, -L * 0.25], [r * 0.98, 0], [r * 0.8, L * 0.35], [r * 0.45, L * 0.7], [0.002, L]], S.seg);
  b.variant = damaged ? VAR.damaged(1) : VAR.blades;
  const rnd = prng(31);
  for (let i = 0; i < S.blades; i++) {
    const a = (i / S.blades) * Math.PI * 2 + Math.PI / 2;
    const steps = S.detail === 0 ? 5 : S.detail === 1 ? 3 : 2;
    const rows: THREE.Vector3[][] = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const rr = r * 0.6 + S.bladeLen * t;
      const c = S.bladeChord * (0.65 + 0.55 * Math.sin(Math.min(1, t * 1.25) * Math.PI * 0.85)) * (t > 0.92 ? 0.7 : 1);
      const pitch = 0.75 - 0.45 * t;
      const curl = damaged ? t * t * (1.1 + rnd() * 0.4) : 0;
      const radial = v3(Math.cos(a), Math.sin(a), 0);
      const tang = v3(-Math.sin(a), Math.cos(a), 0);
      const center = radial.clone().multiplyScalar(rr * (damaged ? 1 - 0.25 * t * t : 1)).add(v3(0, 0, -curl * S.bladeLen * 0.45));
      const cd = tang.clone().multiplyScalar(Math.cos(pitch)).add(v3(0, 0, -Math.sin(pitch)));
      const th = v3(0, 0, 1).multiplyScalar(Math.cos(pitch)).add(tang.clone().multiplyScalar(Math.sin(pitch))).multiplyScalar(c * 0.07);
      rows.push([center.clone().addScaledVector(cd, -c * 0.4).add(th), center.clone().addScaledVector(cd, c * 0.6), center.clone().addScaledVector(cd, -c * 0.4).sub(th)]);
    }
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      b.color = damaged ? mix(S.bladeColor, SOOT, 0.7) : t > 0.86 ? S.tipColor : S.bladeColor;
      b.mat = damaged ? MATTE : t > 0.86 ? PAINT : MATTE;
      const A = rows[k], B = rows[k + 1];
      const fwd = new THREE.Vector3().subVectors(A[0], A[2]);
      const le = new THREE.Vector3().subVectors(A[0], A[1]);
      b.fquadF(A[0], A[1], B[1], B[0], fwd);
      b.fquadF(A[1], A[2], B[2], B[1], fwd.clone().negate());
      b.fquadF(A[2], A[0], B[0], B[2], le);
    }
  }
  b.surf = 0;
  b.variant = 0;
}

/** Prop blur disc geometry (separate transparent mesh). */
export function propDiscGeometry(radius: number): THREE.BufferGeometry {
  const g = new THREE.RingGeometry(radius * 0.18, radius, 40, 1);
  return g;
}

export { frameAlong };
