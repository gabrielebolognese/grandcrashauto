import { HW, JUMP, RAMPS, RAMP_HALFW, VIADUCT_PILLARS_X, type RampDef } from './layout';
import type { Highway, HwSample, Strip } from './model';

/** Highway loop, ramps and jump spur geometry (pure math). */

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Piece {
  len: number;
  at(u: number): { x: number; z: number; fx: number; fz: number };
  arc: boolean;
}

function line(x0: number, z0: number, x1: number, z1: number): Piece {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const fx = (x1 - x0) / len, fz = (z1 - z0) / len;
  return { len, arc: false, at: (u) => ({ x: x0 + (x1 - x0) * u, z: z0 + (z1 - z0) * u, fx, fz }) };
}

/** Quarter arc: point = c + R * (px(φ), pz(φ)), tangent (tx(φ), tz(φ)), φ ∈ [0, π/2]. */
function arc(cx: number, cz: number, pos: (p: number) => [number, number], tan: (p: number) => [number, number]): Piece {
  const R = HW.radius;
  return {
    len: (Math.PI / 2) * R,
    arc: true,
    at: (u) => {
      const p = u * (Math.PI / 2);
      const [px, pz] = pos(p);
      const [tx, tz] = tan(p);
      return { x: cx + R * px, z: cz + R * pz, fx: tx, fz: tz };
    },
  };
}

function loopPieces(): Piece[] {
  const X = HW.xEdge, ZN = HW.zNorth, ZS = HW.zSouth, R = HW.radius;
  const cxE = X - R, cxW = -X + R, czN = ZN + R, czS = ZS - R;
  return [
    line(cxW, ZN, cxE, ZN),
    arc(cxE, czN, (p) => [Math.sin(p), -Math.cos(p)], (p) => [Math.cos(p), Math.sin(p)]),
    line(X, czN, X, czS),
    arc(cxE, czS, (p) => [Math.cos(p), Math.sin(p)], (p) => [-Math.sin(p), Math.cos(p)]),
    line(cxE, ZS, cxW, ZS),
    arc(cxW, czS, (p) => [-Math.sin(p), Math.cos(p)], (p) => [-Math.cos(p), -Math.sin(p)]),
    line(-X, czS, -X, czN),
    arc(cxW, czN, (p) => [-Math.cos(p), -Math.sin(p)], (p) => [Math.sin(p), -Math.cos(p)]),
  ];
}

/** Inner-edge deck height above y=0 for a highway point (before the at-grade offset). */
export function hwElevation(z: number): number {
  return HW.elevation * smooth(HW.riseZ0, HW.riseZ1, z);
}

export function buildHighway(): Highway {
  const pieces = loopPieces();
  const total = pieces.reduce((a, p) => a + p.len, 0);
  const n = Math.round(total / HW.sampleStep);
  const ds = total / n;
  // arc intervals in s
  const arcs: [number, number][] = [];
  let acc = 0;
  for (const p of pieces) {
    if (p.arc) arcs.push([acc, acc + p.len]);
    acc += p.len;
  }
  const bankMax = (HW.bankDeg * Math.PI) / 180;
  const samples: HwSample[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * ds;
    let rem = s;
    let k = 0;
    while (k < pieces.length - 1 && rem > pieces[k].len) {
      rem -= pieces[k].len;
      k++;
    }
    const pt = pieces[k].at(Math.min(1, rem / pieces[k].len));
    // bank: full inside arcs, linear ramp over HW.bankRamp outside (loop-aware distance)
    let dArc = Infinity;
    for (const [a, b] of arcs) {
      if (s >= a && s <= b) dArc = 0;
      else {
        const d1 = Math.min(Math.abs(s - a), Math.abs(s - a + total), Math.abs(s - a - total));
        const d2 = Math.min(Math.abs(s - b), Math.abs(s - b + total), Math.abs(s - b - total));
        dArc = Math.min(dArc, d1, d2);
      }
    }
    const bank = bankMax * (1 - smooth(0, HW.bankRamp, dArc));
    samples.push({ s, x: pt.x, z: pt.z, fx: pt.fx, fz: pt.fz, e: HW.gradeY + hwElevation(pt.z), bank });
  }
  const hw: Highway = { samples, length: total, halfW: HW.halfW, innerGaps: [], pillars: [] };
  // viaduct pillars under the south leg (median of the street below)
  for (const x of VIADUCT_PILLARS_X) hw.pillars.push({ x, z: HW.zSouth, s: nearestS(hw, x, HW.zSouth) });
  return hw;
}

/** Outward unit vector (left of travel = away from the loop interior). */
export const outward = (smp: HwSample): [number, number] => [smp.fz, -smp.fx];

/** Deck surface height at lateral offset t (positive = outward), t ∈ [-halfW, halfW]. */
export function deckY(smp: HwSample, t: number, halfW = HW.halfW): number {
  return smp.e + (t + halfW) * Math.tan(smp.bank);
}

export function nearestS(hw: Highway, x: number, z: number): number {
  let best = Infinity, bs = 0;
  for (const smp of hw.samples) {
    const d = (smp.x - x) ** 2 + (smp.z - z) ** 2;
    if (d < best) {
      best = d;
      bs = smp.s;
    }
  }
  return bs;
}

export function sampleIndexAt(hw: Highway, s: number): number {
  const n = hw.samples.length;
  const ds = hw.length / n;
  return ((Math.round(s / ds) % n) + n) % n;
}

// ── Bézier helpers ──
function bezier(p0: number[], p1: number[], p2: number[], p3: number[], step: number): number[][] {
  // estimate length
  let len = 0;
  let prev = p0;
  for (let i = 1; i <= 32; i++) {
    const p = bez(p0, p1, p2, p3, i / 32);
    len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
  }
  const n = Math.max(2, Math.ceil(len / step));
  const out: number[][] = [];
  for (let i = 0; i <= n; i++) out.push(bez(p0, p1, p2, p3, i / n));
  return out;
}

function bez(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number[] {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

export function rampPath(r: RampDef): number[][] {
  return bezier([r.sx, r.sz], [r.sx + r.dx * 22, r.sz + r.dz * 22], [r.mx - r.mdx * 34, r.mz - r.mdz * 34], [r.mx, r.mz], 2);
}

/** Ramp strips at grade (y slightly above the terrain, below the at-grade highway deck). */
export function buildRampStrips(): { strip: Strip; def: RampDef; path: number[][] }[] {
  return RAMPS.map((def) => {
    const path = rampPath(def);
    const pts: number[] = [];
    for (const [x, z] of path) pts.push(x, 0.012, z);
    return { def, path, strip: { pts, halfW: RAMP_HALFW, solid: false, paint: 0, capStart: false, capEnd: false } };
  });
}

/** Kicker height profile over x ∈ [kickerX0, lipX]: launch angle grows linearly to lipAngle. */
export function kickerHeight(x: number): number {
  const L = JUMP.lipX - JUMP.kickerX0;
  const u = Math.min(1, Math.max(0, (x - JUMP.kickerX0) / L));
  // ∫ tan(θ(u)) dx, θ = θmax·u — integrate numerically (cheap, fixed 24 steps), then scale to lipHeight
  const th = (JUMP.lipAngleDeg * Math.PI) / 180;
  const integ = (uu: number) => {
    let s = 0;
    const n = 24;
    for (let i = 0; i < n; i++) s += Math.tan(th * ((i + 0.5) / n) * uu) * (uu / n);
    return s * L;
  };
  return (integ(u) / integ(1)) * JUMP.lipHeight;
}

export function landingHeight(x: number): number {
  const v = Math.min(1, Math.max(0, (x - JUMP.landX0) / (JUMP.landX1 - JUMP.landX0)));
  return JUMP.landHeight * Math.pow(1 - v, 2.2);
}

/** Jump spur: two solid strips (approach+kicker, landing+exit) + path for the road graph. */
export function buildSpur(): { strips: Strip[]; path: number[][] } {
  const J = JUMP;
  const s1 = bezier([J.divergeX, J.laneZ], [J.divergeX + 25, J.laneZ], [J.straightX0 - 25, J.z], [J.straightX0, J.z], 2);
  const s2 = bezier([J.straightX1, J.z], [J.straightX1 + 25, J.z], [J.mergeX - 25, J.laneZ], [J.mergeX, J.laneZ], 2);
  const a: number[] = [];
  const b: number[] = [];
  const path: number[][] = [];
  const g = 0.012;
  for (const [x, z] of s1) {
    a.push(x, g, z);
    path.push([x, g, z]);
  }
  for (let x = J.straightX0 + 2; x < J.kickerX0; x += 2) {
    a.push(x, g, J.z);
    path.push([x, g, J.z]);
  }
  for (let x = J.kickerX0; x <= J.lipX + 1e-6; x += 1) {
    const y = Math.max(g, kickerHeight(x));
    a.push(x, y, J.z);
    path.push([x, y, J.z]);
  }
  for (let x = J.landX0; x <= J.landX1 + 1e-6; x += 1.25) {
    const y = Math.max(g, landingHeight(x));
    b.push(x, y, J.z);
    path.push([x, y, J.z]);
  }
  for (let x = J.landX1 + 2; x < J.straightX1; x += 2) {
    b.push(x, g, J.z);
    path.push([x, g, J.z]);
  }
  for (const [x, z] of s2) {
    b.push(x, g, z);
    path.push([x, g, z]);
  }
  return {
    path,
    strips: [
      { pts: a, halfW: J.halfW, solid: true, paint: 1, capStart: false, capEnd: true },
      { pts: b, halfW: J.halfW, solid: true, paint: 2, capStart: true, capEnd: false },
    ],
  };
}
