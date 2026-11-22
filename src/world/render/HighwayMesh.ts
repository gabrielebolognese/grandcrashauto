import * as L from '../gen/layout';
import { deckY, outward } from '../gen/highway';
import { Mat, type CityLayout, type HwSample, type Strip } from '../gen/model';
import { GeoBuilder } from './GeoBuilder';

/**
 * Highway loop (banked deck, jersey barriers, viaduct underside + pillars), ramps, exit stubs and the jump spur.
 * Produces one visual GeoBuilder and the matching physics data (trimesh of the drivable/solid surfaces + cuboids for
 * barriers and pillars) from the SAME vertices, so visuals and colliders never disagree.
 */

export interface Cuboid {
  cx: number;
  cy: number;
  cz: number;
  hx: number;
  hy: number;
  hz: number;
  /** rotation quaternion */
  q: [number, number, number, number];
  material: 'concrete' | 'metal';
}

export interface HighwayBuild {
  vis: GeoBuilder;
  /** Elevated spans + pillars (cast shadows). */
  visHigh: GeoBuilder;
  phys: GeoBuilder[]; // trimesh pieces (deck loop, each solid strip)
  cuboids: Cuboid[];
}

const ASPH = 0x45484f;
const CONC = 0xdcd6cc;
const CONC_D = 0xc4beb3;
const WHITE = 0xf4f2ec;
const YELLOW = 0xf2c84b;

export function buildHighwayMeshes(layout: CityLayout, pillarOk: (x: number, z: number) => boolean): HighwayBuild {
  const hw = layout.highway;
  const S = hw.samples;
  const n = S.length;
  const H = hw.halfW;
  const visLow = new GeoBuilder();
  const visHigh = new GeoBuilder();
  let vis = visLow;
  const deckPhys = new GeoBuilder();
  const cuboids: Cuboid[] = [];
  const P = (smp: HwSample, t: number, dy = 0): [number, number, number] => {
    const [ox, oz] = outward(smp);
    return [smp.x + ox * t, deckY(smp, t) + dy, smp.z + oz * t];
  };
  const deckN = (smp: HwSample): [number, number, number] => {
    const [ox, oz] = outward(smp);
    const c = Math.cos(smp.bank), s = Math.sin(smp.bank);
    return [-ox * s, c, -oz * s];
  };
  const open = (smp: HwSample) => smp.e > L.HW.openAbove;
  const inGap = (gaps: [number, number][], s: number) =>
    gaps.some(([a, b]) => {
      const L2 = hw.length;
      const ss = ((s % L2) + L2) % L2;
      return (ss >= a && ss <= b) || (ss + L2 >= a && ss + L2 <= b) || (ss - L2 >= a && ss - L2 <= b);
    });

  for (let i = 0; i < n; i++) {
    const a = S[i], b = S[(i + 1) % n];
    const na = deckN(a);
    vis = a.e > 2.5 || b.e > 2.5 ? visHigh : visLow;
    // top
    for (const g of [vis, deckPhys]) g.quad(...P(a, -H), ...P(b, -H), ...P(b, H), ...P(a, H), ...na, ASPH, Mat.Asphalt);
    // paint
    const paint = (t: number, hwid: number, col: number) => {
      vis.quad(...P(a, t - hwid, 0.025), ...P(b, t - hwid, 0.025), ...P(b, t + hwid, 0.025), ...P(a, t + hwid, 0.025), ...na, col, Mat.Paint);
    };
    paint(-0.17, 0.07, YELLOW);
    paint(0.17, 0.07, YELLOW);
    paint(-7.15, 0.1, WHITE);
    paint(7.15, 0.1, WHITE);
    if (Math.floor(a.s / 4) % 3 === 0) {
      paint(-3.6, 0.07, WHITE);
      paint(3.6, 0.07, WHITE);
    }
    // sides
    const oa = open(a), ob = open(b);
    for (const sgn of [-1, 1]) {
      const t = sgn * H;
      const topA = P(a, t), topB = P(b, t);
      const botA: [number, number, number] = oa ? [topA[0], topA[1] - L.HW.deckThickness, topA[2]] : [topA[0], -0.3, topA[2]];
      const botB: [number, number, number] = ob ? [topB[0], topB[1] - L.HW.deckThickness, topB[2]] : [topB[0], -0.3, topB[2]];
      const [ox, oz] = outward(a);
      for (const g of [vis, deckPhys]) g.quad(...topA, ...topB, ...botB, ...botA, ox * sgn, 0, oz * sgn, sgn > 0 ? CONC : CONC_D, Mat.Concrete);
      // fascia stripe (deco aqua band) on the outer face of open spans
      if (oa && ob && sgn > 0) vis.quad(topA[0] + ox * 0.02, topA[1] - 0.35, topA[2] + oz * 0.02, topB[0] + ox * 0.02, topB[1] - 0.35, topB[2] + oz * 0.02, topB[0] + ox * 0.02, topB[1] - 0.55, topB[2] + oz * 0.02, topA[0] + ox * 0.02, topA[1] - 0.55, topA[2] + oz * 0.02, ox, 0, oz, 0x5cc8d6, Mat.Concrete);
    }
    // underside of open spans
    if (oa && ob) {
      const d = L.HW.deckThickness;
      for (const g of [vis, deckPhys]) {
        const ia = P(a, -H, -d), ib = P(b, -H, -d), ob2 = P(b, H, -d), oa2 = P(a, H, -d);
        g.quad(...ia, ...oa2, ...ob2, ...ib, -na[0], -na[1], -na[2], CONC_D, Mat.Concrete);
      }
    }
    // abutment caps at solid ↔ open transitions
    if (oa !== ob) {
      const smp = oa ? b : a; // solid side sample
      const [fx, fz] = [smp.fx * (oa ? -1 : 1), smp.fz * (oa ? -1 : 1)];
      const l = P(smp, -H, -L.HW.deckThickness), r = P(smp, H, -L.HW.deckThickness);
      for (const g of [vis, deckPhys]) g.quad(l[0], l[1], l[2], r[0], r[1], r[2], r[0], -0.3, r[2], l[0], -0.3, l[2], fx, 0, fz, CONC_D, Mat.Concrete);
    }
  }

  // jersey barriers (visual profile) + cuboid colliders every 3 samples
  const prof: [number, number][] = [[0, 0], [0.08, 0.3], [0.2, 0.9], [0.38, 0.9], [0.5, 0.3], [0.58, 0]];
  for (const sgn of [-1, 1]) {
    const gaps = sgn > 0 ? hw.outerGaps : hw.innerGaps;
    for (let i = 0; i < n; i += 2) {
      const a = S[i], b = S[(i + 2) % n];
      if (inGap(gaps, (a.s + b.s) / 2)) continue;
      vis = a.e > 2.5 || b.e > 2.5 ? visHigh : visLow;
      const na = deckN(a), nb = deckN(b);
      for (let k = 0; k + 1 < prof.length; k++) {
        const [t0, h0] = prof[k], [t1, h1] = prof[k + 1];
        const tA0 = sgn * (H - t0), tA1 = sgn * (H - t1);
        const pa0 = P(a, tA0), pa1 = P(a, tA1), pb0 = P(b, tA0), pb1 = P(b, tA1);
        const A0: [number, number, number] = [pa0[0] + na[0] * h0, pa0[1] + na[1] * h0, pa0[2] + na[2] * h0];
        const A1: [number, number, number] = [pa1[0] + na[0] * h1, pa1[1] + na[1] * h1, pa1[2] + na[2] * h1];
        const B0: [number, number, number] = [pb0[0] + nb[0] * h0, pb0[1] + nb[1] * h0, pb0[2] + nb[2] * h0];
        const B1: [number, number, number] = [pb1[0] + nb[0] * h1, pb1[1] + nb[1] * h1, pb1[2] + nb[2] * h1];
        // face normal: perpendicular to the profile segment, pointing out of the barrier
        const [ox, oz] = outward(a);
        const dt = (t1 - t0), dh = h1 - h0;
        const len = Math.hypot(dt, dh) || 1;
        // profile-plane normal (pointing away from the barrier core): (−dh, dt) in (inward-t, height) → map to world
        const inx = -ox * sgn, inz = -oz * sgn; // inward direction (toward road centre)
        const nIn = -dh / len, nUp = dt / len;
        const nx = inx * nIn + na[0] * nUp, ny = na[1] * nUp, nz = inz * nIn + na[2] * nUp;
        vis.quad(...A0, ...B0, ...B1, ...A1, nx, ny, nz, k === 2 ? 0xf2efe8 : CONC, Mat.Concrete);
      }
    }
    // colliders
    for (let i = 0; i < n; i += 3) {
      const a = S[i], b = S[(i + 3) % n];
      if (inGap(gaps, a.s) && inGap(gaps, b.s)) continue;
      if (inGap(gaps, (a.s + b.s) / 2)) continue;
      const t = sgn * (H - 0.29);
      const pa = P(a, t), pb = P(b, t);
      const na = deckN(a);
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      const len = Math.hypot(dx, dy, dz);
      cuboids.push({
        cx: (pa[0] + pb[0]) / 2 + na[0] * 0.5, cy: (pa[1] + pb[1]) / 2 + na[1] * 0.5, cz: (pa[2] + pb[2]) / 2 + na[2] * 0.5,
        hx: 0.29, hy: 0.55, hz: len / 2 + 0.05, q: basisQuat(dx / len, dy / len, dz / len, na[0], na[1], na[2]), material: 'concrete',
      });
    }
  }

  // pillars: explicit viaduct ones + automatic along other open spans
  const pillarAt = (smp: HwSample) => {
    vis = visHigh;
    const top = deckY(smp, 0) - L.HW.deckThickness + Math.tan(smp.bank) * 0; // centre underside (approx, bank lifts outer side)
    const yawT = Math.atan2(smp.fx, smp.fz);
    const capH = 1.3;
    const colTop = Math.min(deckY(smp, -H), deckY(smp, H)) - L.HW.deckThickness - capH + 0.05;
    vis.box(smp.x, 0, smp.z, 1.8, colTop, 1.8, yawT, 0xe6e0d6, Mat.Concrete);
    vis.box(smp.x, colTop, smp.z, 2 * H - 2.5, capH, 2.2, yawT + Math.PI / 2, 0xd8d2c8, Mat.Concrete);
    cuboids.push({ cx: smp.x, cy: colTop / 2, cz: smp.z, hx: 0.9, hy: colTop / 2, hz: 0.9, q: yawQuat(yawT), material: 'concrete' });
    void top;
  };
  for (const p of hw.pillars) {
    const idx = S.reduce((bi, s, i) => ((s.x - p.x) ** 2 + (s.z - p.z) ** 2 < (S[bi].x - p.x) ** 2 + (S[bi].z - p.z) ** 2 ? i : bi), 0);
    pillarAt({ ...S[idx], x: p.x, z: p.z });
  }
  const explicitZ = L.HW.zSouth;
  let lastS = -1e9;
  for (let i = 0; i < n; i++) {
    const smp = S[i];
    if (!open(smp)) continue;
    if (Math.abs(smp.z - explicitZ) < 0.5 && Math.abs(smp.x) <= L.HW.xEdge - L.HW.radius) continue; // south straight: explicit
    if (smp.s - lastS < 28) continue;
    // must stand on free ground (not on a road or sidewalk)
    if (!pillarOk(smp.x, smp.z)) continue;
    pillarAt(smp);
    lastS = smp.s;
  }

  // strips (ramps, stubs, spur pieces)
  const phys: GeoBuilder[] = [deckPhys];
  for (const st of layout.strips) {
    const sp = st.solid ? new GeoBuilder() : null;
    stripGeo(st.solid ? visHigh : visLow, sp, st);
    if (sp) phys.push(sp);
  }
  return { vis: visLow, visHigh, phys, cuboids };
}

function stripGeo(vis: GeoBuilder, phys: GeoBuilder | null, st: Strip): void {
  const P = st.pts;
  const m = P.length / 3;
  const H = st.halfW;
  const dirAt = (i: number): [number, number] => {
    const i0 = Math.max(0, i - 1), i1 = Math.min(m - 1, i + 1);
    const dx = P[i1 * 3] - P[i0 * 3], dz = P[i1 * 3 + 2] - P[i0 * 3 + 2];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  const edge = (i: number, t: number, dy = 0): [number, number, number] => {
    const [fx, fz] = dirAt(i);
    return [P[i * 3] - fz * t, P[i * 3 + 1] + dy, P[i * 3 + 2] + fx * t];
  };
  let dist = 0;
  for (let i = 0; i + 1 < m; i++) {
    const segLen = Math.hypot(P[(i + 1) * 3] - P[i * 3], P[(i + 1) * 3 + 1] - P[i * 3 + 1], P[(i + 1) * 3 + 2] - P[i * 3 + 2]);
    const dyy = P[(i + 1) * 3 + 1] - P[i * 3 + 1];
    const slope = Math.atan2(dyy, Math.hypot(P[(i + 1) * 3] - P[i * 3], P[(i + 1) * 3 + 2] - P[i * 3 + 2]));
    const [fx, fz] = dirAt(i);
    const nx = -fx * Math.sin(slope), ny = Math.cos(slope), nz = -fz * Math.sin(slope);
    let col = ASPH;
    let mat: number = Mat.Asphalt;
    if (st.paint === 1 && P[i * 3 + 1] > 0.05) {
      const band = Math.floor(dist / 1.6) % 2 === 0;
      col = band ? 0xf2c84b : 0x33363d;
      mat = Mat.Paint;
    } else if (st.paint === 2 && P[i * 3 + 1] > 0.05) {
      col = Math.floor(dist / 2.5) % 2 === 0 ? 0xf4f2ec : 0xff7a6b;
      mat = Mat.Paint;
    }
    const quad = (g: GeoBuilder, c: number, mm: number) => g.quad(...edge(i, -H), ...edge(i + 1, -H), ...edge(i + 1, H), ...edge(i, H), nx, ny, nz, c, mm);
    quad(vis, col, mat);
    if (phys) quad(phys, col, mat);
    // edge paint on flat parts
    if (st.paint === 0 || st.paint === 3 || P[i * 3 + 1] < 0.05) {
      for (const sg of [-1, 1]) {
        const tt = sg * (H - 0.35);
        vis.quad(...edge(i, tt - 0.09, 0.02), ...edge(i + 1, tt - 0.09, 0.02), ...edge(i + 1, tt + 0.09, 0.02), ...edge(i, tt + 0.09, 0.02), 0, 1, 0, WHITE, Mat.Paint);
      }
      if (st.paint === 0 && Math.floor(dist / 3.5) % 2 === 0) vis.quad(...edge(i, -0.07, 0.02), ...edge(i + 1, -0.07, 0.02), ...edge(i + 1, 0.07, 0.02), ...edge(i, 0.07, 0.02), 0, 1, 0, YELLOW, Mat.Paint);
    }
    // solid strips: side walls down to the ground
    if (st.solid) {
      for (const sg of [-1, 1]) {
        const a = edge(i, sg * H), b = edge(i + 1, sg * H);
        if (a[1] < 0.06 && b[1] < 0.06) continue;
        const sx = -fz * sg, sz = fx * sg;
        const q = (g: GeoBuilder) => g.quad(a[0], a[1], a[2], b[0], b[1], b[2], b[0], -0.05, b[2], a[0], -0.05, a[2], sx, 0, sz, sg > 0 ? CONC : CONC_D, Mat.Concrete);
        q(vis);
        if (phys) q(phys);
      }
    }
    dist += segLen;
  }
  if (st.solid) {
    const cap = (i: number, sgn: number) => {
      const [fx, fz] = dirAt(i);
      const l = edge(i, -H), r = edge(i, H);
      if (l[1] < 0.06) return;
      const q = (g: GeoBuilder) => g.quad(l[0], l[1], l[2], r[0], r[1], r[2], r[0], -0.05, r[2], l[0], -0.05, l[2], fx * sgn, 0, fz * sgn, 0xffd166, Mat.Concrete);
      q(vis);
      if (phys) q(phys);
    };
    if (st.capEnd) cap(m - 1, 1);
    if (st.capStart) cap(0, -1);
  }
}

function yawQuat(yaw: number): [number, number, number, number] {
  return [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
}

/** Quaternion whose local +Z = forward f and local +Y ≈ up u (orthonormalised). */
function basisQuat(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): [number, number, number, number] {
  // x = u × f
  let xx = uy * fz - uz * fy, xy = uz * fx - ux * fz, xz = ux * fy - uy * fx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  // y = f × x
  const yx = fy * xz - fz * xy, yy = fz * xx - fx * xz, yz = fx * xy - fy * xx;
  const m00 = xx, m01 = yx, m02 = fx, m10 = xy, m11 = yy, m12 = fy, m20 = xz, m21 = yz, m22 = fz;
  const tr = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  return [qx, qy, qz, qw];
}
