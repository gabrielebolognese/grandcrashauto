import type { NavGraph, RawPath } from './NavGraph';

export type TurnDir = 'left' | 'right' | 'straight' | 'uturn' | 'arrive';

export interface Maneuver {
  /** Distance along the route. */
  s: number;
  dir: TurnDir;
}

/** Spacing of the dense, smoothed track the ribbon is built from (m). */
export const TRACK_STEP = 1.5;

/**
 * An active route in ABSOLUTE coordinates: polyline + cumulative distances, manoeuvres, progress of the car along it,
 * and a dense smoothed track (lazy ground-corrected heights) for the road ribbon.
 */
export class Route {
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly cum: Float64Array;
  /** 1 = the segment starting at this point is off-road (straight connector). */
  readonly offroad: Uint8Array;
  /** Lateral offset (m, right of travel) of the segment starting at each point (ribbon on the travel lanes). */
  readonly lat: Float32Array;
  readonly length: number;
  readonly maneuvers: Maneuver[] = [];
  readonly partial: boolean;
  /** Absolute destination (the POI pose) — for partial routes the map draws a dashed line to it. */
  readonly destX: number;
  readonly destZ: number;
  readonly createdAt = performance.now();

  // progress
  seg = 0;
  t = 0;
  /** Distance along the route of the car's projection. */
  s = 0;
  /** Distance from the car to the route (m). */
  off = 0;

  // ribbon track: samples every TRACK_STEP m, smoothed on the fly; ground heights cached lazily
  readonly trackN: number;
  readonly tGround: Float32Array; // NaN = not sampled yet

  constructor(raw: RawPath, destX: number, destZ: number, graph: NavGraph | null, turnAngleDeg: number) {
    const n = raw.pts.length / 3;
    this.n = n;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.cum = new Float64Array(n);
    this.offroad = new Uint8Array(n);
    this.lat = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.lat[i] = raw.lat?.[i] ?? 0;
      this.x[i] = raw.pts[i * 3];
      this.y[i] = raw.pts[i * 3 + 1];
      this.z[i] = raw.pts[i * 3 + 2];
      this.offroad[i] = raw.offroad[i] ? 1 : 0;
      if (i > 0) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    }
    this.length = n > 0 ? this.cum[n - 1] : 0;
    this.partial = raw.partial;
    this.destX = destX;
    this.destZ = destZ;

    // ── manoeuvres ──
    if (raw.uturnStart) this.maneuvers.push({ s: 0, dir: 'uturn' });
    if (graph) {
      const tA = (turnAngleDeg * Math.PI) / 180;
      for (let i = 1; i < n - 1; i++) {
        const nodeId = raw.node[i];
        if (nodeId < 0) continue;
        const si = this.cum[i];
        const din = this.dirBetween(si - 15, si);
        const dout = this.dirBetween(si, si + 15);
        if (!din || !dout) continue;
        const a = signedAngle(din, dout);
        const alts = graph.outDirections(nodeId, 15);
        // real choices: branches that aren't the way we came in and aren't the chosen one
        let straightest = Infinity;
        let straightestA = 0;
        let choices = 0;
        for (const d of alts) {
          const ad = signedAngle(din, d);
          if (Math.abs(ad) > (160 * Math.PI) / 180) continue; // back where we came from
          if (Math.abs(ad - a) < (6 * Math.PI) / 180) continue; // the chosen branch
          choices++;
          if (Math.abs(ad) < straightest) {
            straightest = Math.abs(ad);
            straightestA = ad;
          }
        }
        if (choices === 0) continue; // no decision here (just a bend)
        let dir: TurnDir | null = null;
        if (Math.abs(a) > (150 * Math.PI) / 180) dir = 'uturn';
        else if (Math.abs(a) > tA) dir = a > 0 ? 'right' : 'left';
        else if (straightest < Math.abs(a) && Math.abs(a - straightestA) > (8 * Math.PI) / 180) dir = a - straightestA > 0 ? 'right' : 'left'; // fork: keep left/right
        if (dir) {
          const last = this.maneuvers[this.maneuvers.length - 1];
          if (last && si - last.s < 8 && last.dir === dir) continue; // double node of one junction
          this.maneuvers.push({ s: si, dir });
        }
      }
    }
    if (!this.partial) this.maneuvers.push({ s: this.length, dir: 'arrive' });

    this.trackN = Math.max(2, Math.ceil(this.length / TRACK_STEP) + 1);
    this.tGround = new Float32Array(this.trackN).fill(NaN);
  }

  private tmpP = { x: 0, y: 0, z: 0 };

  /**
   * Ribbon track sample i (s = i · TRACK_STEP): x/z rounded through corners (box filter ±4.5 m, ends anchored),
   * y = route height, off = 1 on off-road legs.
   */
  trackSample(i: number, out: { x: number; y: number; z: number; off: number; lat: number }): void {
    const n = this.trackN;
    i = Math.max(0, Math.min(n - 1, i));
    const s = Math.min(this.length, i * TRACK_STEP);
    const seg = this.pointAtSeg(s, this.tmpP);
    out.y = this.tmpP.y;
    out.off = this.n > 1 ? this.offroad[seg] : 0;
    const r = Math.min(3, i, n - 1 - i);
    let ax = this.tmpP.x;
    let az = this.tmpP.z;
    let la = this.n > 1 ? this.lat[seg] : 0;
    for (let k = 1; k <= r; k++) {
      let sg = this.pointAtSeg(s - k * TRACK_STEP, this.tmpP);
      ax += this.tmpP.x;
      az += this.tmpP.z;
      la += this.lat[sg] ?? 0;
      sg = this.pointAtSeg(s + k * TRACK_STEP, this.tmpP);
      ax += this.tmpP.x;
      az += this.tmpP.z;
      la += this.lat[sg] ?? 0;
    }
    out.x = ax / (2 * r + 1);
    out.z = az / (2 * r + 1);
    out.lat = la / (2 * r + 1);
  }

  get remaining(): number {
    return Math.max(0, this.length - this.s);
  }

  private lerpSeg(seg: number, s: number, out: { x: number; y: number; z: number }): void {
    if (this.n < 2) {
      out.x = this.x[0] ?? 0;
      out.y = this.y[0] ?? 0;
      out.z = this.z[0] ?? 0;
      return;
    }
    const l = this.cum[seg + 1] - this.cum[seg];
    const t = l > 1e-9 ? Math.min(1, Math.max(0, (s - this.cum[seg]) / l)) : 0;
    out.x = this.x[seg] + (this.x[seg + 1] - this.x[seg]) * t;
    out.y = this.y[seg] + (this.y[seg + 1] - this.y[seg]) * t;
    out.z = this.z[seg] + (this.z[seg + 1] - this.z[seg]) * t;
  }

  /** Point at distance s along the route. */
  pointAt(s: number, out: { x: number; y: number; z: number }): void {
    this.pointAtSeg(s, out);
  }

  /** Point at distance s; returns the segment index. */
  pointAtSeg(s: number, out: { x: number; y: number; z: number }): number {
    if (this.n < 2) {
      this.lerpSeg(0, 0, out);
      return 0;
    }
    s = Math.min(this.length, Math.max(0, s));
    let lo = 0;
    let hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    this.lerpSeg(lo, s, out);
    return lo;
  }

  private dirBetween(s0: number, s1: number): { x: number; z: number } | null {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    this.pointAt(Math.max(0, s0), a);
    this.pointAt(Math.min(this.length, s1), b);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    return l > 0.5 ? { x: dx / l, z: dz / l } : null;
  }

  /** Unit direction of the route at distance s (xz). */
  dirAt(s: number): { x: number; z: number } {
    return this.dirBetween(s - 2, s + 4) ?? { x: 0, z: 1 };
  }

  /**
   * Update the car's projection onto the route (searching a window around the previous one) and the off-route
   * distance. Returns the off-route distance.
   */
  track(ax: number, az: number): number {
    if (this.n < 2) {
      this.off = Math.hypot(ax - (this.x[0] ?? ax), az - (this.z[0] ?? az));
      return this.off;
    }
    const lo = Math.max(0, this.seg - 4);
    const hi = Math.min(this.n - 2, this.seg + 60);
    let best = Infinity;
    let bs = this.seg;
    let bt = this.t;
    for (let i = lo; i <= hi; i++) {
      const x0 = this.x[i], z0 = this.z[i];
      const dx = this.x[i + 1] - x0;
      const dz = this.z[i + 1] - z0;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((ax - x0) * dx + (az - z0) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x0 + dx * t - ax;
      const pz = z0 + dz * t - az;
      const d = px * px + pz * pz;
      // tiny bias toward progress so overlapping out-and-back legs don't snap backwards
      const bias = i < this.seg ? 1.5 : 0;
      if (d + bias < best) {
        best = d + bias;
        bs = i;
        bt = t;
      }
    }
    this.seg = bs;
    this.t = bt;
    this.s = this.cum[bs] + (this.cum[bs + 1] - this.cum[bs]) * bt;
    const p = { x: 0, y: 0, z: 0 };
    this.lerpSeg(bs, this.s, p);
    this.off = Math.hypot(p.x - ax, p.z - az);
    return this.off;
  }

  /** Next manoeuvre ahead of the car (passed ones are skipped). */
  nextManeuver(): Maneuver | null {
    for (const m of this.maneuvers) if (m.s > this.s - 3) return m;
    return null;
  }
}

/** Signed angle from a to b in the XZ plane; positive = turn RIGHT (game yaw convention, see CLAUDE.md). */
export function signedAngle(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
}
