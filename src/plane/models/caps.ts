import * as THREE from 'three';
import { GeoBuilder, MATTE, METAL, DARK, type RGB, rgb, mix, prng, v3 } from './builder';
import { fusPoint, fusNormal, profileAt, bandColor, type FusLivery, type FusProfile } from './fuselage';
import { airfoilPoint, type WingStation } from './surfaces';

/**
 * Torn-edge caps, hidden until a joint breaks: jagged skin petals bent outward (livery outside, primer inside), broken
 * frames and stringers, floor beams, dangling cables (vertex-shader sway), a dark backstop where there is no cabin.
 */

const PRIMER: RGB = rgb(0x7f8f62);
const PRIMER_DARK: RGB = rgb(0x4d5640);
const BARE: RGB = rgb(0x9a9ea4);
const SOOT: RGB = [0.03, 0.028, 0.026];
const CABLE_COLORS: RGB[] = [rgb(0xd8342c), rgb(0xf0c030), rgb(0x1c1c1c), rgb(0xe8e8e8), rgb(0x2a6fd0)];

/** Double-sided quad with separate colours per face. */
function quad2(b: GeoBuilder, p: THREE.Vector3[], outward: THREE.Vector3, cOut: RGB, cIn: RGB): void {
  b.color = cOut;
  b.fquadF(p[0], p[1], p[2], p[3], outward);
  b.color = cIn;
  b.fquadF(p[0], p[1], p[2], p[3], outward.clone().negate());
}
function tri2(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, outward: THREE.Vector3, cOut: RGB, cIn: RGB): void {
  for (const [col, sgn] of [[cOut, 1], [cIn, -1]] as const) {
    b.color = col;
    const n = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, a));
    if (n.dot(outward) * sgn >= 0) b.ftri(a, c, d);
    else b.ftri(a, d, c);
  }
}

export interface FusCapOpts {
  floorY?: number;
  cabin: boolean; // has an interior (else a dark backstop)
  seed: number;
}

/**
 * Fuselage cap at z = zc. dir = direction from the part toward the gap (+1 = the part lies behind, petals point +Z).
 */
export function fuselageCap(b: GeoBuilder, P: FusProfile, L: FusLivery, zc: number, dir: 1 | -1, o: FusCapOpts): void {
  const rnd = prng(o.seed);
  const pa = profileAt(P, zc);
  const R = Math.max(0.15, Math.max(pa.w, (pa.top + pa.bot) / 2));
  const n = 30;
  const overlap = 0.12 * R;
  const offOut = 0.006 * R;
  const p0 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  b.mat = MATTE;
  // petals
  for (let k = 0; k < n; k++) {
    const t0 = (k / n) * Math.PI * 2;
    const t1 = ((k + 1) / n) * Math.PI * 2;
    const tm = (t0 + t1) / 2;
    const len = rnd() < 0.18 ? R * 0.02 : R * (0.05 + 0.32 * rnd() * rnd() + 0.08 * rnd());
    const bend = (rnd() < 0.8 ? 1 : -0.4) * (0.2 + rnd() * 0.9) * len;
    const twist = (rnd() - 0.5) * 0.4;
    const nAt = (P.n ? P.n(zc) : 2);
    const cOut = mix(bandColor(L, zc, tm, nAt).color, SOOT, 0.15 + 0.35 * rnd());
    const cIn = rnd() < 0.5 ? PRIMER : PRIMER_DARK;
    const pt = (t: number, s: number) => {
      // s: 0 = base (inside the part), 1 = cut line, >1 past the cut
      const zz = s < 1 ? zc - dir * overlap * (1 - s) : zc + dir * len * (s - 1);
      fusPoint(P, zc, t, p0, pa);
      fusNormal(P, zc, t, nrm);
      const past = Math.max(0, s - 1);
      const out = offOut + bend * past * past;
      return p0.clone().addScaledVector(nrm, out).setZ(zz + dir * twist * past * len * 0.3);
    };
    const a0 = pt(t0, 0), a1 = pt(t1, 0);
    const m0 = pt(t0, 1), m1 = pt(t1, 1);
    const outward = fusNormal(P, zc, tm, new THREE.Vector3());
    quad2(b, [a0, a1, m1, m0], outward, cOut, cIn);
    // jagged tip: 2 uneven points
    const tipA = pt(t0 + (t1 - t0) * (0.2 + 0.3 * rnd()), 2);
    const e0 = pt(t0, 1 + 0.5 * rnd() + 0.3);
    const e1 = pt(t1, 1 + 0.5 * rnd() + 0.3);
    quad2(b, [m0, m1, e1, e0], outward, cOut, cIn);
    tri2(b, e0, e1, tipA, outward, cOut, cIn);
  }
  // frames: one broken at the cut, two intact inside
  b.mat = MATTE;
  const frameD = 0.07 * R;
  for (let f = 0; f < 3; f++) {
    const zf = zc - dir * (0.05 * R + f * 0.42 * R);
    const ring: THREE.Vector3[] = [];
    const inner: THREE.Vector3[] = [];
    const segs = 32;
    for (let k = 0; k <= segs; k++) {
      const t = (k / segs) * Math.PI * 2;
      fusPoint(P, zf, t, p0);
      fusNormal(P, zf, t, nrm);
      ring.push(p0.clone().addScaledVector(nrm, -0.01 * R));
      inner.push(p0.clone().addScaledVector(nrm, -frameD));
    }
    for (let k = 0; k < segs; k++) {
      if (f === 0 && rnd() < 0.3) continue;
      const fz = v3(0, 0, -dir);
      b.color = f === 0 ? mix(PRIMER, SOOT, 0.3) : PRIMER;
      b.fquadF(ring[k], ring[k + 1], inner[k + 1], inner[k], v3(0, 0, dir));
      b.color = PRIMER_DARK;
      b.fquadF(ring[k], ring[k + 1], inner[k + 1], inner[k], fz);
    }
  }
  // stringers poking out of the torn edge
  b.color = BARE;
  b.mat = METAL;
  for (let s = 0; s < 16; s++) {
    const t = rnd() * Math.PI * 2;
    fusPoint(P, zc, t, p0);
    fusNormal(P, zc, t, nrm);
    const base = p0.clone().addScaledVector(nrm, -0.03 * R).setZ(zc - dir * 0.3 * R);
    const len = R * (0.08 + rnd() * 0.45);
    const tip = p0.clone().addScaledVector(nrm, -0.03 * R + (rnd() - 0.3) * len * 0.5).setZ(zc + dir * len);
    b.cylinder(base, tip, 0.012 * R, 0.01 * R, 4, false);
  }
  // floor beam / cabin floor edge
  if (o.floorY !== undefined && o.cabin) {
    const fy = o.floorY;
    const pw = Math.max(0.2, pa.w * 0.92);
    b.mat = MATTE;
    const pts: THREE.Vector3[] = [];
    const segs = 10;
    for (let k = 0; k <= segs; k++) {
      const x = -pw + (2 * pw * k) / segs;
      pts.push(v3(x, fy, zc + dir * R * (0.02 + rnd() * 0.18)));
    }
    for (let k = 0; k < segs; k++) {
      const A = v3(pts[k].x, fy, zc - dir * 0.2 * R), B = v3(pts[k + 1].x, fy, zc - dir * 0.2 * R);
      quad2(b, [A, B, pts[k + 1], pts[k]], v3(0, 1, 0), rgb(0x5f646c), rgb(0x3a3d42));
      // beam under the floor
      b.color = PRIMER_DARK;
      b.fquadF(pts[k].clone().setY(fy - 0.12 * R), pts[k + 1].clone().setY(fy - 0.12 * R), pts[k + 1], pts[k], v3(0, 0, dir));
    }
  }
  // dark backstop when there is no cabin interior
  if (!o.cabin) {
    b.color = [0.035, 0.035, 0.04];
    b.mat = DARK;
    const zb = zc - dir * 0.35 * R;
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < 24; k++) {
      fusPoint(P, zb, (k / 24) * Math.PI * 2, p0);
      fusNormal(P, zb, (k / 24) * Math.PI * 2, nrm);
      ring.push(p0.clone().addScaledVector(nrm, -0.02 * R));
    }
    const pz = profileAt(P, zb);
    const c = v3(0, pz.mid, zb);
    for (let k = 0; k < 24; k++) {
      const a = ring[k], d = ring[(k + 1) % 24];
      const nn = new THREE.Vector3().subVectors(a, c).cross(new THREE.Vector3().subVectors(d, c));
      if (nn.z * dir > 0) b.ftri(c, a, d);
      else b.ftri(c, d, a);
    }
  }
  // dangling cables from the ceiling
  for (let c = 0; c < 7; c++) {
    const x = (rnd() - 0.5) * pa.w * 1.1;
    const top = pa.mid + pa.top * 0.78;
    const start = v3(x, top - rnd() * 0.1 * R, zc - dir * 0.15 * R);
    const reach = R * (0.15 + rnd() * 0.4);
    const drop = R * (0.25 + rnd() * 0.55);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      pts.push(v3(x + (rnd() - 0.5) * 0.04 * R, start.y - drop * t * t, start.z + dir * reach * Math.sin(t * Math.PI * 0.6)));
    }
    b.color = CABLE_COLORS[c % CABLE_COLORS.length];
    b.mat = MATTE;
    b.ribbon(pts, 0.022 * R, v3(1, 0, 0), 1);
  }
  b.color = [1, 1, 1];
}

/** Airfoil cap at a wing/tail station. spanDir points from the part toward the gap. */
export function airfoilCap(b: GeoBuilder, S: WingStation, spanDir: THREE.Vector3, paint: RGB, seed: number, scale: number): void {
  const rnd = prng(seed);
  const us: number[] = [];
  const nU = 9;
  for (let i = 0; i <= nU; i++) us.push(0.5 * (1 - Math.cos((Math.PI * i) / nU)));
  const outline: { p: THREE.Vector3; n: THREE.Vector3 }[] = [];
  for (let i = us.length - 1; i >= 0; i--) outline.push({ p: airfoilPoint(S, us[i], -1), n: S.up.clone().negate() });
  for (let i = 1; i < us.length - 1; i++) outline.push({ p: airfoilPoint(S, us[i], 1), n: S.up.clone() });
  const thick = S.thick * S.chord;
  const sd = spanDir.clone().normalize();
  b.mat = MATTE;
  // petals along the outline
  for (let k = 0; k < outline.length; k++) {
    const A = outline[k];
    const B = outline[(k + 1) % outline.length];
    if (A.p.distanceTo(B.p) < 1e-4) continue;
    const len = rnd() < 0.15 ? 0.01 * scale : scale * (0.04 + 0.25 * rnd() * rnd()) + thick * 0.2;
    const bend = (0.2 + rnd() * 0.8) * len * (rnd() < 0.8 ? 1 : -0.5);
    const out = A.n.clone().add(B.n).normalize();
    const base0 = A.p.clone().addScaledVector(sd, -0.06 * scale);
    const base1 = B.p.clone().addScaledVector(sd, -0.06 * scale);
    const e0 = A.p.clone().addScaledVector(sd, len * (0.5 + rnd() * 0.5)).addScaledVector(out, bend * 0.4 + 0.002 * scale);
    const e1 = B.p.clone().addScaledVector(sd, len * (0.5 + rnd() * 0.5)).addScaledVector(out, bend * 0.4 + 0.002 * scale);
    const tip = A.p.clone().lerp(B.p, 0.3 + 0.4 * rnd()).addScaledVector(sd, len * 1.2).addScaledVector(out, bend);
    const cOut = mix(paint, SOOT, 0.2 + 0.3 * rnd());
    quad2(b, [base0.addScaledVector(out, 0.002 * scale), base1.addScaledVector(out, 0.002 * scale), e1, e0], out, cOut, PRIMER_DARK);
    tri2(b, e0, e1, tip, out, cOut, PRIMER_DARK);
  }
  // dark rib just inside the cut (no see-through)
  const rib = outline.map((o) => o.p.clone().addScaledVector(sd, -0.04 * scale).addScaledVector(o.n, -0.002 * scale));
  const c = airfoilPoint(S, 0.35, 1).add(airfoilPoint(S, 0.35, -1)).multiplyScalar(0.5).addScaledVector(sd, -0.04 * scale);
  b.color = [0.05, 0.05, 0.055];
  b.mat = DARK;
  for (let k = 0; k < rib.length; k++) {
    const a = rib[k], d = rib[(k + 1) % rib.length];
    const nn = new THREE.Vector3().subVectors(a, c).cross(new THREE.Vector3().subVectors(d, c));
    if (nn.dot(sd) > 0) b.ftri(c, a, d);
    else b.ftri(c, d, a);
  }
  // spars (front / rear) sticking out
  b.mat = METAL;
  for (const u of [0.15, 0.62]) {
    const top = airfoilPoint(S, u, 1);
    const bot = airfoilPoint(S, u, -1);
    const len = scale * (0.05 + rnd() * 0.18);
    const t2 = top.clone().addScaledVector(sd, len);
    const b2 = bot.clone().addScaledVector(sd, len * (0.4 + rnd() * 0.6));
    quad2(b, [top.clone().addScaledVector(sd, -0.05 * scale), bot.clone().addScaledVector(sd, -0.05 * scale), b2, t2], S.chordDir.clone(), BARE, mix(BARE, SOOT, 0.4));
  }
  // hydraulic lines
  b.color = rgb(0x30343a);
  for (let i = 0; i < 2; i++) {
    const p = airfoilPoint(S, 0.3 + 0.25 * i, 1).lerp(airfoilPoint(S, 0.3 + 0.25 * i, -1), 0.5);
    const tip = p.clone().addScaledVector(sd, scale * (0.1 + rnd() * 0.2)).addScaledVector(S.up, -scale * 0.05 * rnd());
    b.cylinder(p.clone().addScaledVector(sd, -0.05 * scale), tip, 0.01 * scale + thick * 0.04, 0.01 * scale + thick * 0.04, 4, false);
  }
  b.color = [1, 1, 1];
}

/** Small torn stub (pylon / strut / gear leg): jagged rectangular or round section around `center`. */
export function stubCap(b: GeoBuilder, center: THREE.Vector3, normal: THREE.Vector3, size: THREE.Vector2, paint: RGB, seed: number, round: boolean): void {
  const rnd = prng(seed);
  const n = normal.clone().normalize();
  const t1 = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0).cross(n).normalize() : new THREE.Vector3(1, 0, 0).cross(n).normalize();
  const t2 = new THREE.Vector3().crossVectors(n, t1).normalize();
  const k = round ? 10 : 12;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < k; i++) {
    const a = (i / k) * Math.PI * 2;
    let x = Math.cos(a);
    let y = Math.sin(a);
    if (!round) {
      const m = Math.max(Math.abs(x), Math.abs(y));
      x /= m;
      y /= m;
    }
    pts.push(center.clone().addScaledVector(t1, x * size.x).addScaledVector(t2, y * size.y));
  }
  const L = Math.max(size.x, size.y);
  b.mat = MATTE;
  for (let i = 0; i < k; i++) {
    const A = pts[i], B = pts[(i + 1) % k];
    const out = A.clone().add(B).multiplyScalar(0.5).sub(center).normalize();
    const len = L * (0.2 + rnd() * 1.1);
    const e0 = A.clone().addScaledVector(n, len * (0.4 + 0.6 * rnd())).addScaledVector(out, len * 0.2 * rnd());
    const e1 = B.clone().addScaledVector(n, len * (0.4 + 0.6 * rnd())).addScaledVector(out, len * 0.2 * rnd());
    quad2(b, [A.clone().addScaledVector(n, -0.2 * L), B.clone().addScaledVector(n, -0.2 * L), e1, e0], out, mix(paint, SOOT, 0.35), PRIMER_DARK);
  }
  b.color = [0.04, 0.04, 0.045];
  b.mat = DARK;
  const c = center.clone().addScaledVector(n, 0.05 * L);
  for (let i = 0; i < k; i++) {
    const a = pts[i].clone().addScaledVector(n, 0.05 * L), d = pts[(i + 1) % k].clone().addScaledVector(n, 0.05 * L);
    const nn = new THREE.Vector3().subVectors(a, c).cross(new THREE.Vector3().subVectors(d, c));
    if (nn.dot(n) > 0) b.ftri(c, a, d);
    else b.ftri(c, d, a);
  }
  b.color = [1, 1, 1];
}
