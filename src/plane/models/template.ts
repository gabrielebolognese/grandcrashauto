import * as THREE from 'three';
import type { PlanePartKind, PlaneTypeId, PlaneBreakModes } from '../types';
import { CONFIG } from '../../config';
import { GeoBuilder, PAINT, METAL, MATTE, DARK, VAR, type RGB, rgb, v3, mix } from './builder';
import { getDesign, type Design, type WingDef, type FanDef, type PropDef } from './designs';
import { loftFuselage, fuselageLines, closeTail, profileAt, type FusProfile } from './fuselage';
import { buildSurface, stationAt, type WingStation, type TEPiece, type HingeInfo } from './surfaces';
import { buildNacelle, buildPylon, buildPropeller } from './engines';
import { buildGear } from './gear';
import { buildCockpit, fan, widthAt } from './cockpit';
import { fuselageCap, airfoilCap, stubCap } from './caps';
import { buildInterior } from './interior';
import { buildGlowGeometry, type GlowSpec, type WindowLayout } from './material';
import { atlasRegion } from './atlas';

/**
 * Builds (once per plane type) everything instances share: per-part geometry for 3 LODs (part-local), the merged
 * LOD-2 mesh (root space), torn caps, cabin interiors, light glows, control-surface hinges, the mass/inertia table,
 * joints and break modes. Root space = design space − centre of mass.
 */

export type SurfRole = 'aileron' | 'elevator' | 'rudder' | 'flap' | 'gear' | 'fan' | 'prop';

export interface SurfRec {
  id: number;
  role: SurfRole;
  side: number; // +1 left, -1 right, 0 centre
  pivot: THREE.Vector3; // root
  axis: THREE.Vector3; // root, unit (positive angle = TE down / gear retract / TE right for the rudder)
  max: number; // rad
  slide: number; // m (flaps)
  engine: number; // fans/props
}

export interface PartTpl {
  name: string;
  kind: PlanePartKind;
  index: number;
  geo: [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry];
  offset: THREE.Vector3; // part object position (root) = part centre of mass
  mass: number;
  com: THREE.Vector3;
  boxCenter: THREE.Vector3;
  halfExtents: THREE.Vector3;
  fuelKg: number;
  cdA: number;
  cpOffset: THREE.Vector3;
  liftArea?: number;
  interior?: THREE.BufferGeometry;
  interiorAlways?: boolean; // shown even when intact (prop cabin)
  glow?: THREE.BufferGeometry; // part-local light glows
}

export interface JointTpl {
  id: string;
  a: string;
  b: string;
  position: THREE.Vector3;
  normal: THREE.Vector3;
  strength: number;
  capA: THREE.BufferGeometry;
  capB: THREE.BufferGeometry;
}

export interface PlaneTemplate {
  type: PlaneTypeId;
  design: Design;
  parts: PartTpl[];
  joints: JointTpl[];
  merged: THREE.BufferGeometry;
  glowAll: THREE.BufferGeometry;
  surfaces: SurfRec[];
  engines: { index: number; part: string; thrustPoint: THREE.Vector3; exhaustPoint: THREE.Vector3; radius: number; propeller: boolean }[];
  gear: { name: string; wheel: THREE.Vector3; radius: number; steerable: boolean }[];
  breakModes: PlaneBreakModes;
  /** Joints whose break opens the cockpit bulkhead (look back into the torn cabin). */
  bulkheadJoints: string[];
  mass: number;
  inertia: THREE.Vector3;
  dims: { length: number; span: number; height: number };
  boardPoint: THREE.Vector3;
  cockpitEye: THREE.Vector3;
  wingCam: { position: THREE.Vector3; target: THREE.Vector3 };
  win: WindowLayout | null;
  instrument: { part: string; position: THREE.Vector3; quaternion: THREE.Quaternion; width: number; height: number; geo: THREE.PlaneGeometry };
  propDisc: { part: string; position: THREE.Vector3; radius: number; geo: THREE.BufferGeometry } | null;
  tris: [number, number, number];
  buildMs: number;
}

interface PB {
  name: string;
  kind: PlanePartKind;
  lod: [GeoBuilder, GeoBuilder, GeoBuilder];
  planform?: { area: number; meanChord: number; center: THREE.Vector3; side: number; vertical?: boolean };
  interior?: GeoBuilder;
}

const FUS = ['nose', 'cockpit', 'fuselageFwd', 'fuselageCenter', 'fuselageRear', 'tailCone'];
const CHORD_N: [number, number, number] = [12, 6, 3];

export function buildTemplate(type: PlaneTypeId): PlaneTemplate {
  const t0 = performance.now();
  const D = getDesign(type);
  const P = D.profile;
  const L = D.liv;
  const parts = new Map<string, PB>();
  const part = (name: string, kind: PlanePartKind): PB => {
    let p = parts.get(name);
    if (!p) {
      p = { name, kind, lod: [new GeoBuilder(), new GeoBuilder(), new GeoBuilder()] };
      parts.set(name, p);
    }
    return p;
  };
  const surfaces: SurfRec[] = [];
  let nextSurf = 1;
  const allocSurf = (role: SurfRole, side: number, pivot: THREE.Vector3, axis: THREE.Vector3, max: number, slide = 0, engine = 0): number => {
    const id = nextSurf++;
    surfaces.push({ id, role, side, pivot: pivot.clone(), axis: axis.clone().normalize(), max, slide, engine });
    return id;
  };
  const R = P.w((P.zNose + P.zTail) / 2);
  const glows: GlowSpec[] = [];

  // ------------------------------------------------------------------------------------------- fuselage
  const zr: Record<string, [number, number]> = {
    nose: [D.cuts[0], P.zNose],
    cockpit: [D.cuts[1], D.cuts[0]],
    fuselageFwd: [D.cuts[2], D.cuts[1]],
    fuselageCenter: [D.cuts[3], D.cuts[2]],
    fuselageRear: [D.cuts[4], D.cuts[3]],
    tailCone: [P.zTail, D.cuts[4]],
  };
  const propPlane = D.engines[0].kind === 'prop';
  for (let l = 0; l < 3; l++) {
    const lines = fuselageLines(P, L, D.ring[l], l < 2, true);
    for (const name of FUS) {
      const pb = part(name, name === 'cockpit' ? 'cockpit' : 'fuselage');
      const [za, zb] = zr[name];
      const opts = { ringSeg: D.ring[l], step: D.step[l], exact: l < 2, win: true };
      if (propPlane && name === 'nose') {
        loftFuselage(pb.lod[l], P, L, za, zb, { ...opts, variant: VAR.intact(1) }, lines);
        loftFuselage(pb.lod[l], P, L, za, zb, { ...opts, variant: VAR.damaged(1), damaged: 17 }, lines);
      } else loftFuselage(pb.lod[l], P, L, za, zb, opts, lines);
    }
    const tc = part('tailCone', 'fuselage').lod[l];
    closeTail(tc, P, l === 0 ? 20 : l === 1 ? 10 : 6, D.colors.tailEnd, METAL);
    if (propPlane) {
      const nb = part('nose', 'fuselage').lod[l];
      nb.set({ color: rgb(0x2b2e33), mat: MATTE });
      fan(nb, P, P.zNose, 1, 0);
      if (l < 2) {
        // cooling intakes beside the spinner
        nb.set({ color: [0.03, 0.03, 0.035], mat: DARK });
        for (const sx of [1, -1]) nb.box(sx * 0.17, -0.12, P.zNose + 0.004, 0.07, 0.05, 0.004);
      }
    }
    if (D.fairing) {
      const F = D.fairing;
      const z0 = Math.min(F.z0, D.cuts[2] - 0.05);
      const z1 = Math.max(F.z1, D.cuts[3] + 0.05);
      const len = z0 - z1;
      const fp: FusProfile = {
        zTail: z1,
        zNose: z0,
        w: (z) => F.w * Math.pow(Math.max(0, 1 - Math.pow((2 * (z - z1)) / len - 1, 2)), 0.32) + 0.02,
        yTop: () => F.yTop,
        yBot: (z) => F.yTop - (F.yTop - F.yBot) * Math.pow(Math.max(0, 1 - Math.pow((2 * (z - z1)) / len - 1, 4)), 0.5) - 0.02,
        yMid: () => F.yTop - 0.01,
        n: () => 2.4,
      };
      loftFuselage(part('fuselageCenter', 'fuselage').lod[l], fp, { bounds: [], colors: [D.colors.belly], rects: [] }, z1, z0, { ringSeg: D.ring[l], step: D.step[l] * 1.5, exact: false, win: false });
    }
  }

  // ------------------------------------------------------------------------------------------- wings
  const wingStations = (W: WingDef, sx: number, xs: number[]): WingStation[] =>
    xs.map((x) => {
      const e = 0.01;
      const dy = (W.y(x + e) - W.y(x - e)) / (2 * e);
      return {
        s: x,
        le: v3(sx * x, W.y(x), W.le(x)),
        chordDir: v3(0, 0, -1),
        up: v3(-sx * dy, 1, 0).normalize(),
        chord: W.chord(x),
        thick: W.thick(x),
        camber: W.camber,
      };
    });
  const lastSeg: Record<string, string> = {};
  const buildWingLike = (W: WingDef, prefix: 'wing' | 'tailplane', kind: PlanePartKind) => {
    const bounds = [W.x0, ...W.breaks, W.x1];
    for (const sx of [1, -1]) {
      const side = sx > 0 ? 'L' : 'R';
      for (let k = 0; k < bounds.length - 1; k++) {
        const xa = bounds[k];
        const xb = bounds[k + 1];
        const name = prefix === 'wing' ? `wing${side}${k + 1}` : `tailplane${side}`;
        const pb = part(name, kind);
        const last = k === bounds.length - 2;
        if (last) lastSeg[`${prefix}${side}`] = name;
        const xs = new Set<number>([xa, xb]);
        for (const x of W.extraX ?? []) if (x > xa && x < xb) xs.add(x);
        const pieces: TEPiece[] = [];
        const hingeRole: SurfRole[] = [];
        for (const f of W.flaps) {
          if (f.x0 >= xa - 1e-6 && f.x1 <= xb + 1e-6) {
            pieces.push({ s0: f.x0, s1: f.x1, uh: f.uh, surf: -1, color: D.colors.flap });
            hingeRole.push('flap');
          }
        }
        if (W.aileron && W.aileron.x0 >= xa - 1e-6 && W.aileron.x1 <= xb + 1e-6) {
          pieces.push({ s0: W.aileron.x0, s1: W.aileron.x1, uh: W.aileron.uh, surf: -1, color: prefix === 'wing' ? D.colors.flap : undefined });
          hingeRole.push(prefix === 'wing' ? 'aileron' : 'elevator');
        }
        let st = wingStations(W, sx, [...xs].sort((a, c) => a - c));
        // winglet continues the last segment
        if (last && W.winglet && prefix === 'wing') {
          const T = st[st.length - 1];
          const wl = W.winglet;
          const rb = wl.h * 0.32;
          const steps = 4;
          const phiMax = Math.PI / 2 - wl.cant;
          for (let i = 1; i <= steps + 1; i++) {
            const tt = Math.min(1, i / steps);
            const phi = phiMax * tt;
            let x = W.x1 + rb * Math.sin(phi);
            let y = W.y(W.x1) + rb * (1 - Math.cos(phi));
            let zf = tt * 0.35;
            if (i === steps + 1) {
              x += (wl.h - rb) * Math.sin(wl.cant);
              y += (wl.h - rb) * Math.cos(wl.cant);
              zf = 1;
            }
            const chord = T.chord + (wl.tipChord - T.chord) * (i === steps + 1 ? 1 : tt * 0.45);
            st.push({
              s: W.x1 + i * 0.05,
              le: v3(sx * x, y, T.le.z - wl.sweep * zf + (T.chord - chord) * 0.15),
              chordDir: v3(0, 0, -1),
              up: v3(-sx * Math.sin(phi + (i === steps + 1 ? 0 : 0)), Math.cos(phi), 0).normalize(),
              chord,
              thick: T.thick * (1 - 0.15 * tt),
              camber: 0.01,
            });
          }
        }
        if (prefix === 'tailplane' && sx < 0) st = st.map((s) => ({ ...s }));
        const style = {
          top: prefix === 'wing' ? D.colors.wingTop : D.colors.tail,
          bottom: prefix === 'wing' ? D.colors.wingBottom : D.colors.tail,
          le: prefix === 'wing' ? D.colors.wingLE : undefined,
          leU: 0.06,
          tip: (last ? 'round' : 'none') as 'round' | 'none',
          spanColor: W.tipColor ? (s: number) => (s > W.x1 + 0.001 || (prefix === 'tailplane' || D.type === 'prop' ? s > W.x1 - 0.32 : false) ? W.tipColor! : null) : undefined,
        };
        for (let l = 0; l < 3; l++) {
          const pcs = l < 2 ? pieces : [];
          const hinges: HingeInfo[] = buildSurface(pb.lod[l], st, pcs.map((p, i) => ({ ...p, surf: 1000 + i })), style, CHORD_N[l]);
          if (l === 0) {
            // allocate real surface ids, then retag vertices 1000+i → id
            const ids = hinges.map((h) => {
              const i = h.surf - 1000;
              const role = hingeRole[i];
              const axis = h.p0.clone().sub(h.p1).normalize(); // inboard: TE-down positive
              const max = role === 'flap' ? (D.type === 'prop' ? 0.55 : 0.5) : role === 'aileron' ? 0.36 : 0.4;
              const slide = role === 'flap' ? h.chord * (D.type === 'prop' ? 0.03 : 0.08) : 0;
              const pivot = role === 'flap' ? h.p0.clone().add(v3(0, -W.thick(Math.abs(h.p0.x)) * h.chord * 0.45, 0)) : h.p0;
              const sid = allocSurf(role, sx, pivot, axis, max, slide);
              // the pivot of the flap hinge line passes through both ends (shifted down)
              return { tmp: h.surf, id: sid };
            });
            for (const q of ids) pb.lod[0].remapSurf(q.tmp, q.id);
            (pb as PB & { _ids?: { tmp: number; id: number }[] })._ids = ids;
          } else if (l === 1) {
            const ids = (pb as PB & { _ids?: { tmp: number; id: number }[] })._ids ?? [];
            for (const q of ids) pb.lod[1].remapSurf(q.tmp, q.id);
          }
        }
        // flap-track fairings ("canoes") under the jet wings
        if (prefix === 'wing' && (D.type === 'airliner' || D.type === 'jumbo')) {
          for (const f of W.flaps) {
            if (f.x0 < xa - 1e-6 || f.x1 > xb + 1e-6) continue;
            for (const t of [0.18, 0.82]) {
              const x = f.x0 + (f.x1 - f.x0) * t;
              const c = W.chord(x);
              const za = W.le(x) - 0.48 * c;
              const len = 0.72 * c;
              const r = 0.045 * c;
              const ylow = W.y(x) - W.thick(x) * c * 0.33;
              for (let l = 0; l < 2; l++) {
                const g = pb.lod[l];
                g.set({ color: D.colors.wingBottom, mat: PAINT });
                g.push(new THREE.Matrix4().makeTranslation(sx * x, ylow - r * 0.35, za).multiply(new THREE.Matrix4().makeRotationY(Math.PI)));
                g.lathe([[0.005, 0], [r * 0.55, len * 0.08], [r, len * 0.32], [r * 0.9, len * 0.66], [r * 0.45, len * 0.92], [0.005, len]], l === 0 ? 10 : 5);
                g.pop();
              }
            }
          }
        }
        // planform for the collision box / lift area
        let area = 0;
        const n = 12;
        for (let i = 0; i < n; i++) {
          const x = xa + ((xb - xa) * (i + 0.5)) / n;
          area += W.chord(x) * ((xb - xa) / n);
        }
        const xm = (xa + xb) / 2;
        pb.planform = { area, meanChord: area / (xb - xa), center: v3(sx * xm, W.y(xm), W.le(xm) - W.chord(xm) / 2), side: sx };
      }
    }
  };
  buildWingLike(D.wing, 'wing', 'wing');
  buildWingLike(D.tailplane, 'tailplane', 'tail');

  // ------------------------------------------------------------------------------------------- fin
  {
    const F = D.fin;
    const pb = part('fin', 'tail');
    const ys = [F.y0, F.y1];
    const fs = (y: number): WingStation => ({ s: y, le: v3(0, y, F.le(y)), chordDir: v3(0, 0, -1), up: v3(1, 0, 0), chord: F.chord(y), thick: F.thick, camber: 0 });
    const st = ys.map(fs);
    const zMax = F.le(F.y0);
    const zMin = Math.min(F.le(F.y0) - F.chord(F.y0), F.le(F.y1) - F.chord(F.y1));
    const art = atlasRegion(type, 'fin');
    const style = {
      top: [1, 1, 1] as RGB,
      bottom: [1, 1, 1] as RGB,
      tip: (D.tTail ? 'flat' : 'round') as 'flat' | 'round',
      uv: (p: THREE.Vector3) => {
        const u = (p.z - zMin) / (zMax - zMin);
        const vv = (p.y - F.y0) / (F.y1 - F.y0);
        return [art.u0 + (art.u1 - art.u0) * Math.min(1, Math.max(0, u)), art.v0 + (art.v1 - art.v0) * Math.min(1, Math.max(0, vv))] as const;
      },
    };
    let rid = 0;
    for (let l = 0; l < 3; l++) {
      const pcs: TEPiece[] = l < 2 ? [{ s0: F.rudder.y0, s1: F.rudder.y1, uh: F.rudder.uh, surf: 900 }] : [];
      const hinges = buildSurface(pb.lod[l], st, pcs, style, CHORD_N[l]);
      if (l === 0 && hinges[0]) {
        const h = hinges[0];
        rid = allocSurf('rudder', 0, h.p0, h.p1.clone().sub(h.p0).normalize(), 0.45);
      }
      if (rid) pb.lod[l].remapSurf(900, rid);
    }
    if (D.tTail) {
      // bullet fairing at the T junction
      const ty = D.tailplane.y(0);
      const z0 = D.tailplane.le(0) + 0.35;
      for (let l = 0; l < 3; l++) {
        const b = pb.lod[l];
        b.set({ color: D.colors.tail, mat: PAINT });
        b.push(new THREE.Matrix4().makeTranslation(0, ty, z0 - 2.0));
        b.lathe([[0.02, -0.25], [0.14, 0.1], [0.17, 0.8], [0.16, 1.6], [0.1, 2.05], [0.01, 2.3]], l === 0 ? 12 : 6);
        b.pop();
      }
    }
    const ym = (F.y0 + F.y1) / 2;
    let area = 0;
    for (let i = 0; i < 10; i++) {
      const y = F.y0 + ((F.y1 - F.y0) * (i + 0.5)) / 10;
      area += F.chord(y) * ((F.y1 - F.y0) / 10);
    }
    pb.planform = { area, meanChord: area / (F.y1 - F.y0), center: v3(0, ym, F.le(ym) - F.chord(ym) / 2), side: 0, vertical: true };
  }

  // ------------------------------------------------------------------------------------------- engines
  const engines: PlaneTemplate['engines'] = [];
  D.engines.forEach((E, i) => {
    const k = i + 1;
    const name = `engine${k}`;
    const pb = part(name, 'engine');
    if (E.kind === 'fan') {
      const F = E as FanDef;
      const sid = allocSurf('fan', Math.sign(F.front.x), F.front, v3(0, 0, 1), 0, 0, k);
      for (let l = 0; l < 3; l++) {
        const b = pb.lod[l];
        const spec = { length: F.length, rMax: F.rMax, rLip: F.rLip, rFan: F.rFan, cowl: D.colors.nacelle, lipColor: D.colors.nacelleLip, blades: F.blades, seg: l === 0 ? 32 : l === 1 ? 14 : 7, detail: l as 0 | 1 | 2 };
        b.push(new THREE.Matrix4().makeTranslation(F.front.x, F.front.y, F.front.z));
        buildNacelle(b, spec, k, sid, false, k * 13);
        buildNacelle(b, spec, k, sid, true, k * 13);
        b.pop();
        if (F.pylon === 'wing') {
          b.push(new THREE.Matrix4().makeTranslation(F.front.x, 0, 0));
          buildPylon(b, {
            zFront: F.front.z - 0.3 * F.length, zBack: F.front.z - 0.98 * F.length, yLow: F.front.y + F.rMax * 0.8, yHigh: (F.pylonTop ?? 0) + 0.25,
            zTopFront: D.wing.le(Math.abs(F.front.x)) + 0.25, zTopBack: F.pylonBack ?? F.front.z - F.length, halfW: F.rMax * 0.17,
          }, D.colors.pylon);
          b.pop();
        } else {
          const sx = Math.sign(F.front.x);
          const basis = new THREE.Matrix4().makeBasis(v3(0, sx, 0), v3(-sx, 0, 0), v3(0, 0, 1)).setPosition(F.front.x, F.front.y, 0);
          b.push(basis);
          buildPylon(b, {
            zFront: F.front.z - 0.32 * F.length, zBack: F.front.z - 0.78 * F.length, yLow: F.rMax * 0.8, yHigh: Math.abs(F.front.x) - widthAt(P, F.front.z - 0.5 * F.length, F.front.y) + 0.12,
            zTopFront: F.front.z - 0.22 * F.length, zTopBack: F.front.z - 0.9 * F.length, halfW: F.rMax * 0.16,
          }, D.colors.pylon);
          b.pop();
        }
      }
      engines.push({ index: k, part: name, thrustPoint: F.front.clone().add(v3(0, 0, -0.5 * F.length)), exhaustPoint: F.front.clone().add(v3(0, 0, -1.08 * F.length)), radius: F.rMax, propeller: false });
    } else {
      const Pp = E as PropDef;
      const sid = allocSurf('prop', 0, Pp.front, v3(0, 0, 1), 0, 0, k);
      for (let l = 0; l < 3; l++) {
        const b = pb.lod[l];
        const spec = { spinnerR: Pp.spinnerR, spinnerLen: Pp.spinnerLen, bladeLen: Pp.bladeLen, bladeChord: Pp.bladeChord, blades: Pp.blades, spinnerColor: D.colors.nacelle, bladeColor: rgb(0x2a2c30), tipColor: rgb(0xffe39a), seg: l === 0 ? 20 : l === 1 ? 10 : 6, detail: l as 0 | 1 | 2 };
        b.push(new THREE.Matrix4().makeTranslation(Pp.front.x, Pp.front.y, Pp.front.z));
        buildPropeller(b, spec, sid, false);
        buildPropeller(b, spec, sid, true);
        b.pop();
        if (l < 2) {
          // engine block (seen through the torn cowl) + exhaust stacks
          b.set({ color: rgb(0x55585e), mat: METAL });
          b.box(0, -0.02, Pp.front.z - 0.62, 0.2, 0.17, 0.3);
          b.set({ color: rgb(0x6a6560), mat: METAL });
          for (const sx of [1, -1]) b.cylinder(v3(sx * 0.16, -0.32, Pp.front.z - 0.75), v3(sx * 0.18, -0.46, Pp.front.z - 0.95), 0.03, 0.03, 6);
        }
      }
      engines.push({ index: k, part: name, thrustPoint: Pp.front.clone(), exhaustPoint: v3(0, -0.46, Pp.front.z - 0.95), radius: 0.38, propeller: true });
    }
  });

  // ------------------------------------------------------------------------------------------- gear
  for (const g of D.gear) {
    const pb = part(g.name, 'gear');
    let sid = 0;
    if (g.retractAxis) sid = allocSurf('gear', Math.sign(g.top.x), g.top, g.retractAxis, g.retractAngle ?? 1.57);
    for (let l = 0; l < 3; l++) {
      const b = pb.lod[l];
      b.surf = sid;
      buildGear(b, g, l as 0 | 1 | 2);
      b.surf = 0;
    }
  }

  // ------------------------------------------------------------------------------------------- struts (prop)
  if (D.struts) {
    for (const sx of [1, -1]) {
      const pb = part(sx > 0 ? 'strutL' : 'strutR', 'misc');
      const a = D.struts.from.clone().setX(sx * D.struts.from.x);
      const c = D.struts.to.clone().setX(sx * D.struts.to.x);
      for (let l = 0; l < 3; l++) {
        const b = pb.lod[l];
        b.set({ color: D.colors.wingTop, mat: PAINT });
        b.push(new THREE.Matrix4());
        b.tube([a, c], D.struts.r, l === 0 ? 8 : 4);
        b.pop();
      }
    }
  }

  // ------------------------------------------------------------------------------------------- antennas (LOD 0)
  if (!propPlane) {
    const k = R / 2;
    const blade = (partName: string, z: number, top: boolean, size: number) => {
      const pa = profileAt(P, z);
      const y = top ? pa.mid + pa.top - 0.01 : pa.mid - pa.bot + 0.01;
      const s = top ? 1 : -1;
      const h = 0.28 * k * size;
      const L0 = 0.36 * k * size;
      const pts = [v3(0, y, z + L0 / 2), v3(0, y, z - L0 / 2), v3(0, y + s * h, z - L0 * 0.75), v3(0, y + s * h, z - L0 * 0.35)];
      const b = part(partName, 'fuselage').lod[0];
      b.set({ color: rgb(0xe8e9eb), mat: PAINT });
      b.fquadF(pts[0], pts[1], pts[2], pts[3], v3(1, 0, 0));
      b.fquadF(pts[0], pts[1], pts[2], pts[3], v3(-1, 0, 0));
    };
    blade('fuselageFwd', D.cuts[1] - (D.cuts[1] - D.cuts[2]) * 0.3, true, 1);
    blade('fuselageCenter', (D.cuts[2] + D.cuts[3]) / 2 - (D.cuts[2] - D.cuts[3]) * 0.25, true, 0.8);
    blade('fuselageFwd', D.cuts[1] - (D.cuts[1] - D.cuts[2]) * 0.55, false, 0.9);
    blade('fuselageRear', (D.cuts[3] + D.cuts[4]) / 2, true, 0.7);
  }

  // ------------------------------------------------------------------------------------------- cockpit interior
  const instr = buildCockpit(part('cockpit', 'cockpit').lod[0], D, { bulkhead: !D.openCabin });
  if (D.openCabin) {
    // bulkhead behind the rear seats (baggage wall), facing the cockpit
    const b = part('fuselageCenter', 'fuselage').lod[0];
    b.variant = VAR.bulkhead;
    b.sway = -1;
    b.set({ color: D.colors.interior.wall, mat: MATTE });
    fan(b, P, D.cuts[3] + 0.01, 1, Math.max(0.02, R * 0.04));
    b.variant = 0;
    b.sway = 0;
  }

  // ------------------------------------------------------------------------------------------- lights
  const ls = D.lightSize;
  for (const sx of [1, -1]) {
    const W = D.wing;
    const x = W.x1;
    const tipPart = lastSeg[`wing${sx > 0 ? 'L' : 'R'}`];
    const navCol: RGB = sx > 0 ? [1, 0.06, 0.04] : [0.08, 1, 0.25];
    const leZ = W.le(x);
    const pos = v3(sx * (x + 0.04), W.y(x) + 0.02, leZ - W.chord(x) * 0.12);
    glows.push({ pos, color: navCol, kind: 0, size: ls, phase: 0, dir: v3(sx, 0, 0.6).normalize(), part: tipPart });
    glows.push({ pos: v3(sx * (x + 0.05), W.y(x) + 0.03, leZ - W.chord(x) * 0.55), color: [1, 1, 1], kind: 1, size: ls * 1.4, phase: 0, dir: v3(sx, 0, 0), part: tipPart });
    // lens geometry
    for (let l = 0; l < 2; l++) {
      const b = part(tipPart, 'wing').lod[l];
      b.set({ color: sx > 0 ? rgb(0xff2a1a) : rgb(0x22ff55), mat: { r: 0.15, m: 0 } });
      b.box(pos.x, pos.y, pos.z, ls * 0.12, ls * 0.12, ls * 0.25);
    }
    // landing lights at the wing roots (left only on the prop)
    if (D.type !== 'prop' || sx > 0) {
      const xl = D.type === 'prop' ? 1.8 : Math.max(W.x0 + 0.3, widthAt(P, W.le(W.x0), W.y(W.x0)) + R * 0.35);
      const lp = part(D.type === 'prop' ? 'wingL1' : `wing${sx > 0 ? 'L' : 'R'}1`, 'wing');
      void lp;
      glows.push({ pos: v3(sx * xl, W.y(xl) - 0.02, W.le(xl) + 0.06), color: [1, 0.96, 0.88], kind: 3, size: ls * 1.6, phase: 0, dir: v3(0, -0.1, 1).normalize(), part: D.type === 'prop' ? 'wingL1' : `wing${sx > 0 ? 'L' : 'R'}1` });
    }
  }
  {
    const pz = profileAt(P, P.zTail + 0.05);
    glows.push({ pos: v3(0, pz.mid, P.zTail - 0.06), color: [1, 1, 0.95], kind: 0, size: ls, phase: 0, dir: v3(0, 0, -1), part: 'tailCone' });
    glows.push({ pos: v3(0, pz.mid + 0.05, P.zTail - 0.08), color: [1, 1, 1], kind: 1, size: ls * 1.2, phase: 0.62, dir: v3(0, 0, -1), part: 'tailCone' });
    const zc = (D.cuts[2] + D.cuts[3]) / 2;
    const pc = profileAt(P, zc);
    glows.push({ pos: v3(0, pc.mid + pc.top + 0.06, zc), color: [1, 0.12, 0.05], kind: 2, size: ls * 1.1, phase: 0, dir: v3(0, 1, 0), part: 'fuselageCenter' });
    const zb = (D.cuts[2] * 0.3 + D.cuts[3] * 0.7);
    const pbm = profileAt(P, zb);
    glows.push({ pos: v3(0, pbm.mid - pbm.bot - (D.fairing ? 0.4 : 0.06), zb), color: [1, 0.12, 0.05], kind: 2, size: ls * 1.1, phase: 0.5, dir: v3(0, -1, 0), part: 'fuselageCenter' });
    for (let l = 0; l < 2; l++) {
      const b = part('fuselageCenter', 'fuselage').lod[l];
      b.set({ color: rgb(0xff2a1a), mat: { r: 0.15, m: 0 } });
      b.box(0, pc.mid + pc.top + 0.02, zc, ls * 0.12, ls * 0.07, ls * 0.12);
    }
  }

  // ------------------------------------------------------------------------------------------- masses, centres
  const fuelTotal = CONFIG.planes[type].fuelKg;
  const totalMass = CONFIG.planes[type].mass;
  const structMass = totalMass - fuelTotal;
  const names = [...parts.keys()];
  const wsum = names.reduce((a, n) => a + (D.weights[n] ?? 0.5), 0);
  const fsum = names.reduce((a, n) => a + (D.fuelFrac[n] ?? 0), 0) || 1;
  const massOf = (n: string) => (structMass * (D.weights[n] ?? 0.5)) / wsum + (fuelTotal * (D.fuelFrac[n] ?? 0)) / fsum;
  const centroid = (b: GeoBuilder): THREE.Vector3 => b.areaCentroid();
  const designCom = new Map<string, THREE.Vector3>();
  const com = new THREE.Vector3();
  for (const n of names) {
    const pb = parts.get(n)!;
    const c = centroid(pb.lod[1]);
    designCom.set(n, c);
    com.addScaledVector(c, massOf(n) / totalMass);
  }

  // ------------------------------------------------------------------------------------------- interiors
  for (const n of ['fuselageFwd', 'fuselageCenter', 'fuselageRear']) {
    const pb = parts.get(n)!;
    pb.interior = new GeoBuilder();
    buildInterior(pb.interior, D, zr[n][0], zr[n][1], true);
  }

  // ------------------------------------------------------------------------------------------- part templates
  const partList: PartTpl[] = [];
  const tris: [number, number, number] = [0, 0, 0];
  const merged = new GeoBuilder();
  names.forEach((n, index) => {
    const pb = parts.get(n)!;
    const dc = designCom.get(n)!;
    const offset = dc.clone().sub(com);
    const geo = pb.lod.map((b, l) => {
      tris[l] += b.triangles;
      if (l === 2) {
        const m = cloneBuilder(b);
        m.setPartAll(index);
        m.translateAll(-com.x, -com.y, -com.z);
        merged.append(m);
      }
      b.setPartAll(index);
      b.translateAll(-dc.x, -dc.y, -dc.z);
      return b.build();
    }) as [THREE.BufferGeometry, THREE.BufferGeometry, THREE.BufferGeometry];
    // box
    const bb = new THREE.Box3().setFromBufferAttribute(geo[1].getAttribute('position') as THREE.BufferAttribute);
    const center = bb.getCenter(new THREE.Vector3()).add(offset);
    const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    if (pb.planform) {
      const pc = pb.planform.center.clone().sub(com);
      center.z = pc.z;
      half.z = Math.min(half.z, pb.planform.meanChord / 2 + 0.05);
    }
    half.max(v3(0.05, 0.05, 0.05));
    const mass = massOf(n);
    const kind = pb.kind;
    const side = Math.sign(center.x) || 0;
    let cp: THREE.Vector3;
    if (kind === 'wing') cp = v3(side * 0.22 * half.x, 0.02 * half.y, -0.28 * half.z);
    else if (kind === 'tail') cp = n === 'fin' ? v3(0, 0.25 * half.y, -0.3 * half.z) : v3(side * 0.2 * half.x, 0, -0.3 * half.z);
    else if (kind === 'engine') cp = v3(0, 0.05 * half.y, -0.22 * half.z);
    else if (kind === 'gear') cp = v3(0, -0.3 * half.y, -0.05 * half.z);
    else if (n === 'nose' || n === 'cockpit') cp = v3(0, 0.06 * half.y, -0.38 * half.z);
    else cp = v3(0, 0.08 * half.y, -0.3 * half.z);
    const fuel = (fuelTotal * (D.fuelFrac[n] ?? 0)) / fsum;
    let interior: THREE.BufferGeometry | undefined;
    if (pb.interior) {
      pb.interior.setPartAll(index);
      pb.interior.translateAll(-dc.x, -dc.y, -dc.z);
      interior = pb.interior.build();
    }
    partList.push({
      name: n, kind, index, geo, offset, mass, com: offset.clone(), boxCenter: center, halfExtents: half, fuelKg: fuel,
      cdA: 2 * (half.x * half.y + half.y * half.z + half.z * half.x), cpOffset: cp, liftArea: pb.planform?.area, interior,
      interiorAlways: !!D.openCabin && (n === 'fuselageFwd' || n === 'fuselageCenter'),
    });
  });
  const partIdx = new Map(partList.map((p) => [p.name, p]));

  // ------------------------------------------------------------------------------------------- inertia
  const inertia = new THREE.Vector3();
  for (const p of partList) {
    const h = p.halfExtents;
    const c = p.boxCenter;
    const m = p.mass;
    inertia.x += (m * (h.y * h.y + h.z * h.z)) / 3 + m * (c.y * c.y + c.z * c.z);
    inertia.y += (m * (h.x * h.x + h.z * h.z)) / 3 + m * (c.x * c.x + c.z * c.z);
    inertia.z += (m * (h.x * h.x + h.y * h.y)) / 3 + m * (c.x * c.x + c.y * c.y);
  }

  // ------------------------------------------------------------------------------------------- joints + caps
  const joints: JointTpl[] = [];
  let seed = 101;
  const capFor = (partName: string, fn: (b: GeoBuilder) => void): THREE.BufferGeometry => {
    const b = new GeoBuilder();
    fn(b);
    const p = partIdx.get(partName)!;
    const dc = p.offset.clone().add(com);
    b.setPartAll(p.index);
    b.translateAll(-dc.x, -dc.y, -dc.z);
    return b.build();
  };
  const addJoint = (a: string, b: string, posD: THREE.Vector3, nrm: THREE.Vector3, strength: number, capA: (g: GeoBuilder) => void, capB: (g: GeoBuilder) => void) => {
    if (!partIdx.has(a) || !partIdx.has(b)) return;
    joints.push({ id: `${a}|${b}`, a, b, position: posD.clone().sub(com), normal: nrm.clone().normalize(), strength, capA: capFor(a, capA), capB: capFor(b, capB) });
  };
  // fuselage chain
  const fusStrength = [1.0, 1.1, 0.7, 0.75, 0.9];
  for (let i = 0; i < FUS.length - 1; i++) {
    const a = FUS[i];
    const b = FUS[i + 1];
    const z = D.cuts[i];
    const pz = profileAt(P, z);
    const cabinA = a !== 'nose';
    const cabinB = b !== 'tailCone';
    const sA = seed++;
    const sB = seed++;
    addJoint(a, b, v3(0, pz.mid, z), v3(0, 0, -1), fusStrength[i],
      (g) => fuselageCap(g, P, L, z, -1, { cabin: cabinA, floorY: a === 'cockpit' ? D.cockpit.floorY : D.floorY, seed: sA }),
      (g) => fuselageCap(g, P, L, z, 1, { cabin: cabinB, floorY: D.floorY, seed: sB }));
  }
  // wings
  const wingCut = (W: WingDef, sx: number, x: number): WingStation => {
    const st = wingStations(W, sx, [x - 0.01, x, x + 0.01]);
    return stationAt(st, x);
  };
  for (const sx of [1, -1]) {
    const side = sx > 0 ? 'L' : 'R';
    const W = D.wing;
    const zRoot = W.le(W.x0) - W.chord(W.x0) * 0.4;
    const xr = D.type === 'prop' ? 0.0 : Math.max(W.x0 + 0.05, widthAt(P, zRoot, W.y(W.x0)) * 0.98);
    const rootSt = wingCut(W, sx, Math.max(W.x0, xr));
    const sdOut = v3(sx, 0, 0);
    const sa = seed++;
    addJoint('fuselageCenter', `wing${side}1`, rootSt.le.clone().addScaledVector(rootSt.chordDir, rootSt.chord * 0.4), sdOut, 1.6,
      (g) => airfoilCap(g, rootSt, sdOut, D.colors.wingTop, sa, R * 0.8),
      (g) => airfoilCap(g, rootSt, sdOut.clone().negate(), D.colors.wingTop, sa + 7, R * 0.8));
    W.breaks.forEach((x, k) => {
      const st = wingCut(W, sx, x);
      const s1 = seed++;
      addJoint(`wing${side}${k + 1}`, `wing${side}${k + 2}`, st.le.clone().addScaledVector(st.chordDir, st.chord * 0.4), sdOut, k === 0 ? 0.85 : 0.7,
        (g) => airfoilCap(g, st, sdOut, D.colors.wingTop, s1, R * 0.6),
        (g) => airfoilCap(g, st, sdOut.clone().negate(), D.colors.wingTop, s1 + 3, R * 0.6));
    });
    // tailplanes
    const T = D.tailplane;
    const mount = D.tTail ? 'fin' : 'tailCone';
    const xt = D.tTail ? Math.max(T.x0, 0.12) : Math.max(T.x0 + 0.05, widthAt(P, T.le(T.x0) - T.chord(T.x0) * 0.4, T.y(T.x0)) * 0.97);
    const tst = wingCut(T, sx, xt);
    const s2 = seed++;
    addJoint(mount, `tailplane${side}`, tst.le.clone().addScaledVector(tst.chordDir, tst.chord * 0.4), sdOut, 0.6,
      (g) => airfoilCap(g, tst, sdOut, D.colors.tail, s2, R * 0.4),
      (g) => airfoilCap(g, tst, sdOut.clone().negate(), D.colors.tail, s2 + 5, R * 0.4));
  }
  // fin
  {
    const F = D.fin;
    const zMid = F.le(F.y0) - F.chord(F.y0) * 0.45;
    const pz = profileAt(P, zMid);
    const yc = Math.min(F.y1 - 0.2, Math.max(F.y0, pz.mid + pz.top - 0.02));
    const st: WingStation = { s: yc, le: v3(0, yc, F.le(yc)), chordDir: v3(0, 0, -1), up: v3(1, 0, 0), chord: F.chord(yc), thick: F.thick, camber: 0 };
    const s3 = seed++;
    addJoint('tailCone', 'fin', st.le.clone().addScaledVector(st.chordDir, st.chord * 0.4), v3(0, 1, 0), 0.75,
      (g) => airfoilCap(g, st, v3(0, 1, 0), [1, 1, 1], s3, R * 0.45),
      (g) => airfoilCap(g, st, v3(0, -1, 0), [1, 1, 1], s3 + 9, R * 0.45));
  }
  // engines
  const engineMount: Record<number, string> = {};
  D.engines.forEach((E, i) => {
    const k = i + 1;
    const s4 = seed++;
    if (E.kind === 'fan') {
      const F = E as FanDef;
      let pos: THREE.Vector3;
      let nrm: THREE.Vector3;
      let size: THREE.Vector2;
      if (F.pylon === 'wing') {
        pos = v3(F.front.x, (F.pylonTop ?? 0) - 0.05, (D.wing.le(Math.abs(F.front.x)) + (F.pylonBack ?? F.front.z - F.length)) / 2);
        nrm = v3(0, -1, 0);
        size = new THREE.Vector2(F.rMax * 0.15, Math.abs(D.wing.le(Math.abs(F.front.x)) - (F.pylonBack ?? 0)) * 0.42);
      } else {
        const sx = Math.sign(F.front.x);
        pos = v3(sx * (widthAt(P, F.front.z - 0.5 * F.length, F.front.y) + 0.05), F.front.y, F.front.z - 0.55 * F.length);
        nrm = v3(sx, 0, 0);
        size = new THREE.Vector2(F.rMax * 0.15, F.length * 0.22);
      }
      addJoint(F.mount, `engine${k}`, pos, nrm, 0.55,
        (g) => stubCap(g, pos, nrm, size, D.colors.pylon, s4, false),
        (g) => stubCap(g, pos, nrm.clone().negate(), size, D.colors.pylon, s4 + 1, false));
      engineMount[k] = `${F.mount}|engine${k}`;
    } else {
      const Pp = E as PropDef;
      const pos = v3(0, Pp.front.y, Pp.front.z - 0.32);
      const nrm = v3(0, 0, 1);
      addJoint(Pp.mount, `engine${k}`, pos, nrm, 0.6,
        (g) => stubCap(g, pos.clone().add(v3(0, 0, -0.1)), nrm, new THREE.Vector2(0.16, 0.14), [0.35, 0.36, 0.38], s4, true),
        (g) => stubCap(g, pos.clone().add(v3(0, 0, -0.1)), nrm.clone().negate(), new THREE.Vector2(0.16, 0.14), [0.35, 0.36, 0.38], s4 + 1, true));
      engineMount[k] = `${Pp.mount}|engine${k}`;
    }
  });
  // gear
  for (const g of D.gear) {
    const s5 = seed++;
    const nrm = v3(0, -1, 0);
    const pos = g.top.clone();
    const sz = new THREE.Vector2(g.strutR * 1.3, g.strutR * 1.3);
    addJoint(g.mount, g.name, pos, nrm, 0.45,
      (b) => stubCap(b, pos, nrm, sz, [0.5, 0.5, 0.52], s5, true),
      (b) => stubCap(b, pos, nrm.clone().negate(), sz, [0.5, 0.5, 0.52], s5 + 1, true));
  }
  // struts
  if (D.struts) {
    for (const sx of [1, -1]) {
      const to = D.struts.to.clone().setX(sx * D.struts.to.x);
      const from = D.struts.from.clone().setX(sx * D.struts.from.x);
      const nrm = from.clone().sub(to).normalize();
      const pos = to.clone().addScaledVector(nrm, 0.12);
      const s6 = seed++;
      const sz = new THREE.Vector2(D.struts.r * 1.2, D.struts.r * 1.2);
      addJoint(`wing${sx > 0 ? 'L' : 'R'}1`, sx > 0 ? 'strutL' : 'strutR', pos, nrm, 0.6,
        (b) => stubCap(b, pos, nrm, sz, D.colors.wingTop, s6, true),
        (b) => stubCap(b, pos, nrm.clone().negate(), sz, D.colors.wingTop, s6 + 1, true));
    }
  }

  // ------------------------------------------------------------------------------------------- glows
  const glowRoot = glows.map((g) => ({ ...g, pos: g.pos.clone().sub(com) }));
  const glowAll = buildGlowGeometry(glowRoot, new THREE.Vector3());
  for (const p of partList) {
    const mine = glowRoot.filter((g) => g.part === p.name);
    if (mine.length) p.glow = buildGlowGeometry(mine, p.offset);
  }

  // ------------------------------------------------------------------------------------------- surfaces → root
  for (const s of surfaces) s.pivot.sub(com);

  // ------------------------------------------------------------------------------------------- misc info
  const gearInfo = D.gear.map((g) => ({ name: g.name, wheel: g.wheel.clone().sub(com), radius: g.wheelR, steerable: g.steerable }));
  for (const e of engines) {
    e.thrustPoint.sub(com);
    e.exhaustPoint.sub(com);
  }
  const doorZ = D.doorL1;
  const board = v3(widthAt(P, doorZ, D.floorY + 0.8) + (D.type === 'prop' ? 1.1 : D.type === 'bizjet' ? 1.6 : 2.2), D.ground, doorZ).sub(com);
  const eye = D.cockpit.eye.clone().sub(com);
  let wingCam: { position: THREE.Vector3; target: THREE.Vector3 };
  const e1 = engines[0];
  if (D.type === 'prop') {
    wingCam = { position: v3(1.9, 0.62, 0.35).sub(com), target: v3(0.0, 0.1, 3.4).sub(com) };
  } else if (D.type === 'bizjet') {
    const zc = -2.6;
    wingCam = { position: v3(widthAt(P, zc, 0.3) + 0.35, 0.55, zc).sub(com), target: e1.thrustPoint.clone().add(v3(0.15, 0.05, 0.6)) };
  } else {
    const fanFront = (D.engines[0] as FanDef).front;
    const zc = fanFront.z - (D.type === 'jumbo' ? 16 : 10);
    const yc = D.type === 'jumbo' ? 3.4 : 1.4;
    wingCam = { position: v3(widthAt(P, zc, yc) + 0.4, yc, zc).sub(com), target: e1.thrustPoint.clone().add(v3(0, 0, 0.3 * (D.engines[0] as FanDef).length)) };
  }
  const cp = partIdx.get('cockpit')!;
  const instrument = {
    part: 'cockpit',
    position: instr.position.clone().sub(com).sub(cp.offset),
    quaternion: instr.quaternion,
    width: instr.width,
    height: instr.height,
    geo: new THREE.PlaneGeometry(instr.width, instr.height),
  };
  let propDisc: PlaneTemplate['propDisc'] = null;
  if (propPlane) {
    const Pp = D.engines[0] as PropDef;
    const ep = partIdx.get('engine1')!;
    const r = Pp.spinnerR * 0.6 + Pp.bladeLen;
    const g = new THREE.CircleGeometry(r, 40);
    propDisc = { part: 'engine1', position: Pp.front.clone().sub(com).sub(ep.offset).add(v3(0, 0, -0.02)), radius: r, geo: g };
  }
  const breakModes: PlaneBreakModes = {
    middle: ['fuselageFwd|fuselageCenter'],
    tailRequired: ['tailCone|fin'],
    tailOptional: D.tTail ? [] : ['tailCone|tailplaneL', 'tailCone|tailplaneR'],
    engineMount,
  };
  const mergedGeo = merged.build();
  return {
    type, design: D, parts: partList, joints, merged: mergedGeo, glowAll, surfaces, engines, gear: gearInfo, breakModes,
    bulkheadJoints: D.openCabin ? ['fuselageCenter|fuselageRear'] : ['fuselageFwd|fuselageCenter', 'cockpit|fuselageFwd'],
    mass: totalMass, inertia, dims: { length: D.length, span: D.span, height: D.height }, boardPoint: board, cockpitEye: eye, wingCam,
    win: D.win, instrument, propDisc, tris, buildMs: performance.now() - t0,
  };
}

function cloneBuilder(b: GeoBuilder): GeoBuilder {
  const c = new GeoBuilder();
  c.append(b);
  return c;
}

export { mix };
