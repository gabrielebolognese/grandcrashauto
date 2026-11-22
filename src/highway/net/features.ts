import { CONFIG } from '../../config';
import type { Rng } from '../../core/rng';
import { cfg, getNode, nodeFrame, otherEnd, presentIncident } from './lattice';
import { K_BRIDGE, K_GALLERY, K_ROAD, K_TUNNEL, halfPavedMax, laneStart, type EdgeRoute } from './route';

/**
 * Roadside features of one edge (PURE): rest stops, highway kickers (with the landing-zone SAFETY CHECK), mega
 * jumps (big kicker + gap/canyon + landing ramp in a dedicated jump lane), overhead gantries with destination names,
 * streetlight zones. Placed in this order so later features avoid earlier ones.
 *
 * Side convention: side +1 = the carriageway at lateral l > 0 (right of +s), traffic travels +s; side −1 = l < 0,
 * traffic travels −s.
 */

export interface RestStop {
  id: string;
  s0: number;
  s1: number;
  side: 1 | -1;
  /** inner edge of the pad (|l|, m from the centreline) */
  lOff: number;
  /** pad width (m) */
  w: number;
  name: string;
}

export interface Kicker {
  /** toe station (where the ramp starts); the lip is `len` further along the travel direction */
  s: number;
  side: 1 | -1;
  /** signed lateral centre */
  l: number;
  len: number;
  h: number;
  w: number;
  lipDeg: number;
  /** 0 concrete, 1 steel, 2 dirt, 3 plank */
  variant: number;
  /** expected landing range at turbo speed (m past the lip) — kept clear */
  range: number;
}

export interface MegaJump {
  side: 1 | -1;
  /** stations in TRAVEL order: approach start, kicker toe, lip, landing-ramp start (gap end), landing-ramp end, runout end */
  sA: number;
  sKick: number;
  sLip: number;
  sLand0: number;
  sLand1: number;
  sEnd: number;
  laneL: number;
  laneW: number;
  kickH: number;
  landH: number;
  lipDeg: number;
  canyon: boolean;
  pitDepth: number;
}

export interface Gantry {
  s: number;
  side: 1 | -1;
  /** destination panels: [name, arrow] (arrow: 0 up, 1 up-right, −1 up-left) */
  panels: [string, number][];
}

export interface Features {
  rest: RestStop[];
  kickers: Kicker[];
  megas: MegaJump[];
  gantries: Gantry[];
  /** streetlights near node a / b (junctions and city exits) */
  lightsA: boolean;
  lightsB: boolean;
}

const KMAX_SPEED = 95; // m/s ≈ 342 km/h — turbo top speed with upgrades (landing-zone check)

function sampleAt(r: EdgeRoute, s: number): number {
  return Math.max(0, Math.min(r.n, Math.round(s / r.ds)));
}

function yAt(r: EdgeRoute, s: number): number {
  const f = Math.max(0, Math.min(r.n, s / r.ds));
  const i = Math.min(r.n - 1, Math.floor(f));
  return r.y[i] + (r.y[i + 1] - r.y[i]) * (f - i);
}

/** Max lateral deviation of the centreline from the straight line through station s (along the travel tangent). */
function straightness(r: EdgeRoute, s: number, back: number, ahead: number, side: number): number {
  const i = sampleAt(r, s);
  const px = r.x[i], pz = r.z[i];
  const dx = r.tx[i] * side, dz = r.tz[i] * side;
  let worst = 0;
  const i0 = sampleAt(r, s - back * side), i1 = sampleAt(r, s + ahead * side);
  const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
  for (let k = lo; k <= hi; k += 2) {
    const ex = r.x[k] - px, ez = r.z[k] - pz;
    const lat = Math.abs(ex * -dz + ez * dx);
    if (lat > worst) worst = lat;
  }
  return worst;
}

function kindRange(r: EdgeRoute, s0: number, s1: number): { tunnel: boolean; mixed: boolean; first: number } {
  const a = sampleAt(r, Math.min(s0, s1)), b = sampleAt(r, Math.max(s0, s1));
  const first = r.kind[a];
  let tunnel = false, mixed = false;
  for (let k = a; k <= b; k++) {
    const kk = r.kind[k];
    if (kk === K_TUNNEL || kk === K_GALLERY) tunnel = true;
    if (kk !== first) mixed = true;
  }
  return { tunnel, mixed, first };
}

export function placeFeatures(r: EdgeRoute, rng: Rng): Features {
  const C = cfg();
  const f: Features = { rest: [], kickers: [], megas: [], gantries: [], lightsA: false, lightsB: false };
  const d = r.desc;
  const L = r.L;
  const a2 = halfPavedMax(r.lanes);
  const zoneA = Math.max(r.forkA, r.exitA ? 250 : 0) + 150;
  const zoneB = Math.max(r.forkB, r.exitB ? 250 : 0) + 150;
  const busy: [number, number][] = []; // station ranges already used
  const free = (s0: number, s1: number, pad: number) => {
    const lo = Math.min(s0, s1) - pad, hi = Math.max(s0, s1) + pad;
    if (lo < zoneA || hi > L - zoneB) return false;
    for (const [a, b] of busy) if (hi > a && lo < b) return false;
    return true;
  };
  const occupy = (s0: number, s1: number) => busy.push([Math.min(s0, s1), Math.max(s0, s1)]);
  const grade = (s: number) => (yAt(r, s + 6) - yAt(r, s - 6)) / 12;

  // ── rest stops ──
  if (L > 2200 && d.ref.cls !== 'link' && rng.chance(C.restStopChance)) {
    for (let tries = 0; tries < 24; tries++) {
      const sc = rng.range(0.15, 0.85) * L;
      const s0 = sc - 130, s1 = sc + 130;
      if (!free(s0, s1, 60)) continue;
      const kr = kindRange(r, s0 - 40, s1 + 40);
      if (kr.mixed || kr.first !== K_ROAD) continue;
      let ok = true;
      for (let s = s0; s <= s1; s += 30) if (Math.abs(grade(s)) > 0.05) ok = false;
      if (!ok || straightness(r, sc, 150, 150, 1) > 40) continue;
      const side: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      const near = side === 1 ? d.b : d.a;
      f.rest.push({ id: `rest:${r.key}`, s0, s1, side, lOff: a2 + 0.4, w: 40, name: near.name });
      occupy(s0 - 80, s1 + 80);
      break;
    }
  }

  // ── mega jumps ──
  const g = Math.abs(CONFIG.physics.gravity);
  const forcedMega = r.key === '0,1>0,2';
  const megaP = forcedMega ? 1 : Math.min(0.85, L / C.megaEvery);
  if (L > 2000 && d.ref.cls !== 'link' && rng.chance(megaP)) {
    const laneW = 8;
    const laneL0 = a2 + 1.6 + laneW / 2;
    for (let tries = 0; tries < 24; tries++) {
      const side: 1 | -1 = tries % 2 === 0 ? 1 : -1;
      const sLip0 = rng.range(0.25, 0.75) * L;
      const lipDeg = rng.range(19, 24);
      const kickLen = 42;
      const kickH = (kickLen * Math.tan((lipDeg * Math.PI) / 180)) / 2;
      const gap = rng.range(70, 110);
      const landLen = 46;
      const runout = 520;
      const appr = 280;
      const sKick = sLip0 - kickLen * side, sLip = sLip0;
      const sA = sKick - appr * side;
      const sLand0 = sLip + gap * side, sLand1 = sLand0 + landLen * side;
      const sEnd = sLand1 + runout * side;
      if (!free(sA, sEnd, 120)) continue;
      if (straightness(r, sLip, appr + kickLen + 40, gap + landLen + runout, side) > 2.6) continue;
      const kr = kindRange(r, sA - 60 * side, sEnd);
      if (kr.tunnel) continue;
      // landing zone flat or downhill, no climbs beyond 1.5 m above the lip
      let ok = true;
      const yLip = yAt(r, sLip);
      for (let k = 30; k <= gap + landLen + runout; k += 18) if (yAt(r, sLip + k * side) > yLip + 1.5) ok = false;
      if (!ok) continue;
      // canyon (road on a bridge under the gap) or a carved pit
      const gk = kindRange(r, sLip, sLand0);
      const canyon = gk.first === K_BRIDGE && !gk.mixed;
      const landH = Math.max(3, kickH * 0.62);
      f.megas.push({ side, sA, sKick, sLip, sLand0, sLand1, sEnd, laneL: side * laneL0, laneW, kickH, landH, lipDeg, canyon, pitDepth: 5.5 });
      occupy(sA - 150 * side, sEnd + 150 * side);
      break;
    }
  }

  // ── highway kickers: scan for safe straight zones, then pick with seeded spacing ──
  {
    const [gMin, gMax] = C.kickerGap as number[];
    let s = zoneA + rng.range(150, 900);
    for (let slot = 0; slot < 8 && s < L - zoneB; slot++) {
      const variant = rng.int(0, 3);
      const [lenLo, lenHi, degLo, degHi] = variant === 0 ? [18, 24, 12, 16] : variant === 1 ? [14, 20, 13, 18] : variant === 2 ? [12, 16, 15, 21] : [16, 22, 12, 17];
      const len = rng.range(lenLo, lenHi);
      const lipDeg = rng.range(degLo, degHi);
      const th = (lipDeg * Math.PI) / 180;
      const h = (len * Math.tan(th)) / 2;
      const vy = KMAX_SPEED * Math.sin(th);
      const tFly = (vy + Math.sqrt(vy * vy + 2 * g * h)) / g;
      const range = KMAX_SPEED * Math.cos(th) * tFly * 1.1 + 40;
      const side0: 1 | -1 = rng.chance(0.5) ? 1 : -1;
      let found = false;
      const sMax = Math.min(L - zoneB, s + (gMax - gMin) + 700);
      for (let toe = s; toe < sMax && !found; toe += 30) {
        for (const side of [side0, -side0 as 1 | -1]) {
          const lip = toe + len * side;
          if (!free(toe - 220 * side, lip + range * side, 40)) continue;
          // SAFETY: straight landing zone at turbo range, flat or downhill, no tunnel portals / galleries
          if (straightness(r, lip, len + 120, range, side) > 3.0) continue;
          if (kindRange(r, toe - 200 * side, lip + range * side).tunnel) continue;
          let ok = true;
          const yl = yAt(r, lip);
          for (let k = 20; k <= range && ok; k += 15) if (yAt(r, lip + k * side) > yl + 1.0) ok = false;
          if (!ok) continue;
          const l = side * (laneStart() + (r.lanes - 0.5) * C.laneW);
          f.kickers.push({ s: toe, side, l, len, h, w: 4.2, lipDeg, variant, range });
          occupy(toe - 220 * side, lip + range * side);
          s = toe + rng.range(gMin, gMax);
          found = true;
          break;
        }
      }
      if (!found) s = sMax;
    }
  }

  // ── gantries (destination signs) ──
  {
    const destNames = (nodeKey: string, viaEdge: string): [string, number][] => {
      const node = getNode(nodeKey)!;
      const inc = presentIncident(nodeKey).filter((e) => e.key !== viaEdge);
      if (inc.length === 0) return [[node.name, 0]];
      const frame = nodeFrame(nodeKey);
      const arrive = frame.get(viaEdge)!.dir; // departure dir of our edge at the node = −travel direction
      const out: [string, number][] = [];
      for (const e of inc.slice(0, 2)) {
        const end = frame.get(e.key);
        const far = getNode(otherEnd(e, nodeKey));
        if (!end || !far) continue;
        // turn sign: cross of travel dir (−arrive) and the far node direction
        const tdx = -arrive.x, tdz = -arrive.z;
        const fx = far.x - node.x, fz = far.z - node.z;
        const cr = tdx * fz - tdz * fx;
        const dot = (tdx * fx + tdz * fz) / (Math.hypot(fx, fz) || 1);
        const arrow = dot > 0.8 || inc.length === 1 ? 0 : cr > 0 ? 1 : -1;
        out.push([far.name, arrow]);
      }
      if (out.length === 0) out.push([node.name, 0]);
      return out;
    };
    const tryGantry = (s: number, side: 1 | -1, panels: [string, number][]) => {
      for (const dsTry of [0, 60, -60, 140, -140]) {
        const ss = s + dsTry;
        if (ss < 80 || ss > L - 80) continue;
        const kr = kindRange(r, ss - 20, ss + 20);
        if (kr.tunnel) continue;
        let clash = false;
        for (const k of f.kickers) {
          const lo = Math.min(k.s - 60 * k.side, k.s + (k.len + k.range) * k.side), hi = Math.max(k.s - 60 * k.side, k.s + (k.len + k.range) * k.side);
          if (ss > lo && ss < hi) clash = true;
        }
        for (const m of f.megas) {
          const lo = Math.min(m.sA, m.sEnd) - 40, hi = Math.max(m.sA, m.sEnd) + 40;
          if (ss > lo && ss < hi) clash = true;
        }
        if (clash) continue;
        f.gantries.push({ s: ss, side, panels });
        return;
      }
    };
    if (L > 1400) {
      tryGantry(L - 950, 1, destNames(d.b.key, r.key));
      tryGantry(950, -1, destNames(d.a.key, r.key));
    }
    if (L > 4200) {
      tryGantry(L * 0.5 - 300, 1, [[d.b.name, 0]]);
      tryGantry(L * 0.5 + 300, -1, [[d.a.name, 0]]);
    }
  }
  f.lightsA = d.a.kind === 'exit' || r.forkA > 0;
  f.lightsB = d.b.kind === 'exit' || r.forkB > 0;
  void K_ROAD;
  return f;
}
