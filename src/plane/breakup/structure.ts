import * as THREE from 'three';
import type { BreakJoint, PlanePartInfo, PlanePartKind, PlaneVisual } from '../types';

/**
 * Static, per-visual structural data for the breakup system (computed once per PlaneVisual and cached):
 * part boxes, collider boxes separated so pieces never spawn interpenetrating, per-face adjacency to joints (interior
 * faces are shielded from air/water flow until their joint breaks → open ends), lift axes and buoyancy fractions.
 * Everything is in ROOT space (= body-local space of every assembly; root origin = intact centre of mass).
 */

/** Face index f = axis * 2 + (negative ? 1 : 0); axis 0 = x, 1 = y, 2 = z. */
export const faceAxis = (f: number) => f >> 1;
export const faceSign = (f: number) => (f & 1 ? -1 : 1);

export interface PartDef {
  i: number;
  name: string;
  kind: PlanePartKind;
  info: PlanePartInfo;
  mass: number;
  com: THREE.Vector3;
  /** Inertia / aero box. */
  bc: THREE.Vector3;
  bh: THREE.Vector3;
  /** Collider box (shrunk where it overlapped a neighbour). */
  cc: THREE.Vector3;
  ch: THREE.Vector3;
  faceArea: number[];
  /** Joint indices whose break line lies on each face. */
  faceJoints: number[][];
  volume: number;
  /** Fraction of the box volume that is buoyant air when intact (hollow fuselage ≫ engine). */
  airFrac: number;
  /** Scales Newtonian face drag so the orientation-averaged drag area matches PlanePartInfo.cdA. */
  cdScale: number;
  cp: THREE.Vector3;
  liftArea: number;
  /** Lift model axes: thin axis (normal) and span axis; chord is root Z. -1 when not a lifting part. */
  liftN: number;
  liftS: number;
  fuel0: number;
  radius: number;
  isCockpit: boolean;
  /** 1-based engine button index, 0 if not an engine. */
  engineIndex: number;
}

export interface JointDef {
  i: number;
  id: string;
  a: number;
  b: number;
  pos: THREE.Vector3;
  normal: THREE.Vector3;
  strength: number;
  faceA: number;
  faceB: number;
  src: BreakJoint;
}

export interface Structure {
  visual: PlaneVisual;
  parts: PartDef[];
  joints: JointDef[];
  partIndex: Map<string, number>;
  jointIndex: Map<string, number>;
  /** part index → joint indices touching it. */
  adj: number[][];
  length: number;
  span: number;
  mass: number;
  fuel: number;
}

const cache = new WeakMap<PlaneVisual, Structure>();

export function getStructure(visual: PlaneVisual): Structure {
  let s = cache.get(visual);
  if (!s) {
    s = buildStructure(visual);
    cache.set(visual, s);
  }
  return s;
}

const comp = (v: THREE.Vector3, a: number) => (a === 0 ? v.x : a === 1 ? v.y : v.z);
const setComp = (v: THREE.Vector3, a: number, x: number) => {
  if (a === 0) v.x = x;
  else if (a === 1) v.y = x;
  else v.z = x;
};

/** Face of box (c, h) nearest to point q (by normalized offset). */
function nearestFace(c: THREE.Vector3, h: THREE.Vector3, q: THREE.Vector3): number {
  let best = 0;
  let bestV = -1;
  let sign = 1;
  for (let a = 0; a < 3; a++) {
    const r = (comp(q, a) - comp(c, a)) / Math.max(0.05, comp(h, a));
    if (Math.abs(r) > bestV) {
      bestV = Math.abs(r);
      best = a;
      sign = r >= 0 ? 1 : -1;
    }
  }
  return best * 2 + (sign > 0 ? 0 : 1);
}

function airFraction(kind: PlanePartKind): number {
  switch (kind) {
    case 'fuselage':
    case 'cockpit':
      return 0.55;
    case 'wing':
      return 0.32;
    case 'tail':
      return 0.3;
    case 'engine':
      return 0.18;
    case 'gear':
      return 0.05;
    default:
      return 0.2;
  }
}

function buildStructure(visual: PlaneVisual): Structure {
  const parts: PartDef[] = [];
  const partIndex = new Map<string, number>();
  const engineByPart = new Map<string, number>();
  for (const e of visual.engines) engineByPart.set(e.part, e.index);
  let fuel = 0;
  for (const info of visual.parts) {
    const i = parts.length;
    const bh = info.halfExtents.clone();
    bh.x = Math.max(0.04, bh.x);
    bh.y = Math.max(0.04, bh.y);
    bh.z = Math.max(0.04, bh.z);
    const ax = 4 * bh.y * bh.z;
    const ay = 4 * bh.x * bh.z;
    const az = 4 * bh.x * bh.y;
    const meanFace = (ax + ay + az) / 3;
    let liftN = -1;
    let liftS = -1;
    const liftArea = info.liftArea ?? 0;
    if (liftArea > 0 && (info.kind === 'wing' || info.kind === 'tail')) {
      // Chord runs along root Z; the thinner of X/Y is the surface normal, the other one is the span.
      liftN = bh.x < bh.y ? 0 : 1;
      liftS = liftN === 0 ? 1 : 0;
    }
    const p: PartDef = {
      i,
      name: info.name,
      kind: info.kind,
      info,
      mass: Math.max(1, info.mass),
      com: info.com.clone(),
      bc: info.boxCenter.clone(),
      bh,
      cc: info.boxCenter.clone(),
      ch: bh.clone(),
      faceArea: [ax, ax, ay, ay, az, az],
      faceJoints: [[], [], [], [], [], []],
      volume: 8 * bh.x * bh.y * bh.z,
      airFrac: airFraction(info.kind),
      cdScale: THREE.MathUtils.clamp(info.cdA > 0 ? info.cdA / Math.max(0.01, meanFace) : 1, 0.25, 3),
      cp: info.cpOffset.clone(),
      liftArea,
      liftN,
      liftS,
      fuel0: Math.max(0, info.fuelKg),
      radius: bh.length(),
      isCockpit: info.kind === 'cockpit' || info.name === 'cockpit',
      engineIndex: engineByPart.get(info.name) ?? 0,
    };
    fuel += p.fuel0;
    parts.push(p);
    partIndex.set(info.name, i);
  }

  const joints: JointDef[] = [];
  const jointIndex = new Map<string, number>();
  const adj: number[][] = parts.map(() => []);
  for (const j of visual.joints) {
    const a = partIndex.get(j.a);
    const b = partIndex.get(j.b);
    if (a === undefined || b === undefined || a === b) continue;
    const pa = parts[a];
    const pb = parts[b];
    const jd: JointDef = {
      i: joints.length,
      id: j.id,
      a,
      b,
      pos: j.position.clone(),
      normal: j.normal.clone().normalize(),
      strength: Math.max(0.05, j.strength),
      faceA: nearestFace(pa.bc, pa.bh, j.position),
      faceB: nearestFace(pb.bc, pb.bh, j.position),
      src: j,
    };
    pa.faceJoints[jd.faceA].push(jd.i);
    pb.faceJoints[jd.faceB].push(jd.i);
    adj[a].push(jd.i);
    adj[b].push(jd.i);
    joints.push(jd);
    jointIndex.set(j.id, jd.i);
  }

  separateColliders(parts);

  return {
    visual,
    parts,
    joints,
    partIndex,
    jointIndex,
    adj,
    length: Math.max(2, visual.dims.length),
    span: Math.max(2, visual.dims.span),
    mass: parts.reduce((s, p) => s + p.mass, 0),
    fuel,
  };
}

/**
 * Shrink collider boxes so no two parts' boxes overlap (they may end up in different bodies, and interpenetrating
 * spawns would jolt on the break frame). Overlap is removed along the axis with the smallest RELATIVE overlap (so a
 * wing root buried in the fuselage is trimmed along the span, an engine hung under a wing along the vertical), split
 * in proportion to each box's extent, never below 35 % of the original extent.
 */
function separateColliders(parts: PartDef[], gap = 0.03): void {
  const n = parts.length;
  const mn = parts.map((p) => [p.bc.x - p.bh.x, p.bc.y - p.bh.y, p.bc.z - p.bh.z]);
  const mx = parts.map((p) => [p.bc.x + p.bh.x, p.bc.y + p.bh.y, p.bc.z + p.bh.z]);
  const minExt = parts.map((p) => [p.bh.x * 0.7, p.bh.y * 0.7, p.bh.z * 0.7]);
  const o = [0, 0, 0];
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let separated = false;
        for (let a = 0; a < 3; a++) {
          o[a] = Math.min(mx[i][a], mx[j][a]) - Math.max(mn[i][a], mn[j][a]);
          if (o[a] <= -gap) separated = true;
        }
        if (separated) continue;
        let axis = 0;
        let best = Infinity;
        for (let a = 0; a < 3; a++) {
          const ei = mx[i][a] - mn[i][a];
          const ej = mx[j][a] - mn[j][a];
          const rel = (o[a] + gap) / Math.max(0.02, Math.min(ei, ej));
          if (rel < best) {
            best = rel;
            axis = a;
          }
        }
        const need = o[axis] + gap;
        const ci = (mn[i][axis] + mx[i][axis]) / 2;
        const cj = (mn[j][axis] + mx[j][axis]) / 2;
        const ei = mx[i][axis] - mn[i][axis];
        const ej = mx[j][axis] - mn[j][axis];
        let si = (need * ei) / Math.max(1e-6, ei + ej);
        let sj = need - si;
        si = Math.min(si, Math.max(0, ei - minExt[i][axis]));
        sj = Math.min(sj, Math.max(0, ej - minExt[j][axis]));
        if (ci <= cj) {
          mx[i][axis] -= si;
          mn[j][axis] += sj;
        } else {
          mn[i][axis] += si;
          mx[j][axis] -= sj;
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const p = parts[i];
    for (let a = 0; a < 3; a++) {
      setComp(p.cc, a, (mn[i][a] + mx[i][a]) / 2);
      setComp(p.ch, a, Math.max(0.03, (mx[i][a] - mn[i][a]) / 2));
    }
  }
}

// ───────────────────────────── mass properties ─────────────────────────────

export interface MassProps {
  mass: number;
  com: THREE.Vector3;
  /** Inertia tensor about com in body-local axes, row-major 3×3. */
  I: Float64Array;
  principal: THREE.Vector3;
  frame: THREE.Quaternion;
  /** Smallest principal moment (conservative scalar for force limiters). */
  Imin: number;
}

export function newMassProps(): MassProps {
  return { mass: 0, com: new THREE.Vector3(), I: new Float64Array(9), principal: new THREE.Vector3(), frame: new THREE.Quaternion(), Imin: 1 };
}

const _A = new Float64Array(9);
const _V = new Float64Array(9);
const _m4 = new THREE.Matrix4();

/** Mass, centre of mass and full box-derived inertia tensor (diagonalized) of a set of parts. */
export function computeMassProps(s: Structure, idxs: readonly number[], out: MassProps): MassProps {
  let m = 0;
  out.com.set(0, 0, 0);
  for (const i of idxs) {
    const p = s.parts[i];
    m += p.mass;
    out.com.addScaledVector(p.com, p.mass);
  }
  m = Math.max(1, m);
  out.com.multiplyScalar(1 / m);
  out.mass = m;
  const I = out.I;
  I.fill(0);
  for (const i of idxs) {
    const p = s.parts[i];
    const pm = p.mass;
    const hx = p.bh.x, hy = p.bh.y, hz = p.bh.z;
    const dx = p.com.x - out.com.x, dy = p.com.y - out.com.y, dz = p.com.z - out.com.z;
    // box about its own centre (half extents): m(b²+c²)/3, plus parallel axis m(|d|²E − d dᵀ)
    I[0] += (pm * (hy * hy + hz * hz)) / 3 + pm * (dy * dy + dz * dz);
    I[4] += (pm * (hx * hx + hz * hz)) / 3 + pm * (dx * dx + dz * dz);
    I[8] += (pm * (hx * hx + hy * hy)) / 3 + pm * (dx * dx + dy * dy);
    I[1] -= pm * dx * dy;
    I[2] -= pm * dx * dz;
    I[5] -= pm * dy * dz;
  }
  I[3] = I[1];
  I[6] = I[2];
  I[7] = I[5];
  _A.set(I);
  jacobiEigen(_A, _V);
  // Floor the moments (thin plates / single slender parts) for solver stability.
  const maxI = Math.max(_A[0], _A[4], _A[8], 1e-6);
  const floor = Math.max(maxI * 0.02, m * 0.01);
  out.principal.set(Math.max(floor, _A[0]), Math.max(floor, _A[4]), Math.max(floor, _A[8]));
  out.Imin = Math.min(out.principal.x, out.principal.y, out.principal.z);
  // Eigenvectors are V's columns; make it a proper rotation.
  const det =
    _V[0] * (_V[4] * _V[8] - _V[5] * _V[7]) - _V[1] * (_V[3] * _V[8] - _V[5] * _V[6]) + _V[2] * (_V[3] * _V[7] - _V[4] * _V[6]);
  if (det < 0) {
    _V[2] = -_V[2];
    _V[5] = -_V[5];
    _V[8] = -_V[8];
  }
  _m4.set(_V[0], _V[1], _V[2], 0, _V[3], _V[4], _V[5], 0, _V[6], _V[7], _V[8], 0, 0, 0, 0, 1);
  out.frame.setFromRotationMatrix(_m4).normalize();
  return out;
}

/** Cyclic Jacobi eigen-decomposition of a symmetric 3×3 (row-major). A → diagonal (eigenvalues), V → eigenvectors (columns). */
export function jacobiEigen(A: Float64Array, V: Float64Array): void {
  V.fill(0);
  V[0] = V[4] = V[8] = 1;
  const scale = Math.abs(A[0]) + Math.abs(A[4]) + Math.abs(A[8]) + 1e-30;
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = A[1] * A[1] + A[2] * A[2] + A[5] * A[5];
    if (off < 1e-22 * scale * scale) break;
    for (let k = 0; k < 3; k++) {
      const p = k === 2 ? 1 : 0;
      const q = k === 0 ? 1 : 2;
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let r = 0; r < 3; r++) {
        const arp = A[r * 3 + p];
        const arq = A[r * 3 + q];
        A[r * 3 + p] = c * arp - s * arq;
        A[r * 3 + q] = s * arp + c * arq;
      }
      for (let r = 0; r < 3; r++) {
        const apr = A[p * 3 + r];
        const aqr = A[q * 3 + r];
        A[p * 3 + r] = c * apr - s * aqr;
        A[q * 3 + r] = s * apr + c * aqr;
      }
      for (let r = 0; r < 3; r++) {
        const vrp = V[r * 3 + p];
        const vrq = V[r * 3 + q];
        V[r * 3 + p] = c * vrp - s * vrq;
        V[r * 3 + q] = s * vrp + c * vrq;
      }
    }
  }
}

// ───────────────────────────── union-find ─────────────────────────────

/** Connected components of `parts` over joints that are unbroken and have both ends in the set. */
export function components(s: Structure, parts: readonly number[], broken: Uint8Array): number[][] {
  const parent = new Map<number, number>();
  for (const p of parts) parent.set(p, p);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    let y = x;
    while (parent.get(y)! !== r) {
      const nx = parent.get(y)!;
      parent.set(y, r);
      y = nx;
    }
    return r;
  };
  for (const j of s.joints) {
    if (broken[j.i]) continue;
    if (!parent.has(j.a) || !parent.has(j.b)) continue;
    const ra = find(j.a);
    const rb = find(j.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map<number, number[]>();
  for (const p of parts) {
    const r = find(p);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(p);
  }
  return [...groups.values()];
}
