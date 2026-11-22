import * as THREE from 'three';
import { GeoBuilder, MATTE, METAL, PAINT, DARK, VAR, type RGB, rgb, v3, mix } from './builder';
import { loftFuselage, fusRing, fusPoint, profileAt, fuselageLines } from './fuselage';

const RAD = 180 / Math.PI;
import type { Design } from './designs';

/**
 * Cockpit interior seen from cockpitEye: an inward-facing shell that follows the fuselage with openings exactly where
 * the outside glass rects are, front closure, aft bulkhead (hidden once the cabin behind is torn open), dashboard +
 * glareshield, yokes, centre pedestal with throttle levers, seats and an overhead panel. Returns where the instrument
 * face (CanvasTexture mesh) goes.
 */

export interface InstrumentPlacement {
  position: THREE.Vector3; // design space, centre of the face
  quaternion: THREE.Quaternion;
  width: number;
  height: number;
}

const SHELL_UP: RGB = rgb(0xc9c6c0);
const SHELL_MID: RGB = rgb(0x8f9196);
const SHELL_LOW: RGB = rgb(0x3d4047);
const PANEL: RGB = rgb(0x2a2d33);
const GLARE: RGB = rgb(0x17181b);
const SEAT: RGB = rgb(0x34373e);

export function buildCockpit(b: GeoBuilder, D: Design, opts: { bulkhead: boolean } = { bulkhead: true }): InstrumentPlacement {
  const P = D.profile;
  const L = D.liv;
  const K = D.cockpit;
  const zRear = D.cuts[1];
  const zNoseCut = D.cuts[0];
  const R = Math.max(0.5, P.w((P.zNose + P.zTail) / 2));
  const hSill = 0.2;
  const eye = K.eye;
  const inset = Math.max(0.02, R * 0.025);
  // the front pane (first glass rect) drives the layout: its lower edge on the centreline sets how low the
  // windshield reaches; the glareshield lip sits just below it, the instrument face below that.
  const front = L.rects.find((r) => r.kind === 'glass')!;
  const zW = front.z1;
  const pBot = fusPoint(P, zW, Math.max(0.001, front.t0));
  const paneDeg = Math.atan2(eye.y - pBot.y, zW - eye.z) * RAD;
  const lipDeg = Math.max(9, paneDeg + 1.5);
  const zFront = Math.max(zW + 0.03, K.zFront);
  // inward shell: openings exactly at the glass rects
  const lines = fuselageLines(P, L, 48, true);
  loftFuselage(b, P, L, zRear, Math.max(zNoseCut, zFront + 0.01), {
    ringSeg: 48, step: R * 0.12, exact: true, win: false, extraZ: [zFront],
    inner: {
      offset: inset,
      zFront,
      color: (h) => (h > 0.62 ? SHELL_UP : h > hSill ? SHELL_MID : SHELL_LOW),
    },
  }, lines);
  // front closure (ahead of every pane, hidden behind the dashboard)
  b.set({ color: PANEL, mat: MATTE });
  fan(b, P, zFront, -1, inset);
  if (opts.bulkhead) {
    // aft bulkhead with a door (hidden when the cabin behind is torn open)
    b.variant = VAR.bulkhead;
    b.set({ color: SHELL_MID, mat: MATTE });
    fan(b, P, zRear + 0.002, 1, inset);
    const pr = profileAt(P, zRear);
    const doorH = Math.min(1.9, (pr.mid + pr.top - K.floorY) * 0.88);
    const doorW = Math.min(0.42, pr.w * 0.3);
    b.set({ color: rgb(0x5d6067), mat: PAINT });
    b.fquadF(v3(doorW, K.floorY, zRear + 0.012), v3(-doorW, K.floorY, zRear + 0.012), v3(-doorW, K.floorY + doorH, zRear + 0.012), v3(doorW, K.floorY + doorH, zRear + 0.012), v3(0, 0, 1));
    b.variant = 0;
  }
  // floor
  const wf = Math.max(0.3, widthAt(P, zRear + 0.3, K.floorY) - 0.04);
  b.set({ color: rgb(0x2c2e33), mat: MATTE });
  b.fquadF(v3(wf, K.floorY, zRear), v3(-wf, K.floorY, zRear), v3(-wf * 0.8, K.floorY, K.dashZ + 0.2), v3(wf * 0.8, K.floorY, K.dashZ + 0.2), v3(0, 1, 0));

  // ---- instrument face: perpendicular to the view ray, spanning ~14° just under the glareshield lip
  const dashDist = K.dashZ - eye.z;
  const a1 = (lipDeg + 1.4) / RAD;
  const span = 14 / RAD;
  const ac = a1 + span / 2;
  const distC = dashDist / Math.cos(ac);
  const faceC = v3(0, eye.y - Math.sin(ac) * distC, eye.z + Math.cos(ac) * distC);
  const panelH = 2 * distC * Math.tan(span / 2);
  const panelW = panelH * 3;
  const fNrm = v3(0, Math.sin(ac), -Math.cos(ac)); // toward the eye
  const fUp = v3(0, Math.cos(ac), Math.sin(ac)); // face "up" (tilted back)
  const at = (x: number, y: number, back = 0) => faceC.clone().add(v3(x, 0, 0)).addScaledVector(fUp, y).addScaledVector(fNrm, -back);
  // dashboard board (face plane), wider than the face, from the lip down
  const halfW = Math.max(panelW / 2 + 0.05, Math.min(widthAt(P, faceC.z, faceC.y) - 0.04, panelW * 0.5 + R * 0.55));
  const topY = panelH / 2 + 0.03;
  const botY = -panelH / 2 - Math.max(0.06, panelH * 0.45);
  b.set({ color: PANEL, mat: MATTE });
  b.fquadF(at(halfW, topY, 0.004), at(-halfW, topY, 0.004), at(-halfW, botY, 0.004), at(halfW, botY, 0.004), fNrm);
  if (K.glass) {
    // flanking (unlit) displays: subtle glass-cockpit look
    for (const sx of [1, -1]) {
      const cx = sx * (panelW / 2 + panelH * 0.62);
      if (Math.abs(cx) + panelH * 0.55 > halfW) continue;
      b.set({ color: rgb(0x2a323c), mat: MATTE });
      b.fquadF(at(cx + panelH * 0.55, panelH * 0.5, 0.002), at(cx - panelH * 0.55, panelH * 0.5, 0.002), at(cx - panelH * 0.55, -panelH * 0.5, 0.002), at(cx + panelH * 0.55, -panelH * 0.5, 0.002), fNrm);
      b.set({ color: rgb(0x0e1319), mat: { r: 0.15, m: 0.3 } });
      b.fquadF(at(cx + panelH * 0.5, panelH * 0.45, 0.0), at(cx - panelH * 0.5, panelH * 0.45, 0.0), at(cx - panelH * 0.5, -panelH * 0.45, 0.0), at(cx + panelH * 0.5, -panelH * 0.45, 0.0), fNrm);
    }
  }
  // knee panel down to the floor
  const kneeTop = at(0, botY, 0.004);
  b.set({ color: SHELL_LOW, mat: MATTE });
  b.fquadF(v3(halfW, kneeTop.y, kneeTop.z), v3(-halfW, kneeTop.y, kneeTop.z), v3(-halfW * 0.9, K.floorY, kneeTop.z + 0.3), v3(halfW * 0.9, K.floorY, kneeTop.z + 0.3), v3(0, 0, -1));
  // side cheeks of the dashboard box
  const lipP = at(0, topY, 0.004);
  for (const sx of [1, -1]) {
    b.fquadF(v3(sx * halfW, lipP.y, lipP.z), v3(sx * halfW, kneeTop.y, kneeTop.z), v3(sx * halfW, kneeTop.y, zFront), v3(sx * halfW, lipP.y, zFront), v3(-sx, 0, 0));
  }
  // glareshield: an overhanging lip, then a top sloping down to the windshield base
  b.set({ color: GLARE, mat: MATTE });
  const lipZ = lipP.z - 0.07;
  const gl = eye.y - Math.tan(lipDeg / RAD) * (lipZ - eye.z);
  const frontY = Math.min(gl, pBot.y - 0.02);
  const hwF = Math.max(0.2, Math.min(halfW + 0.03, widthAt(P, zW, frontY) - 0.03));
  b.fquadF(v3(halfW + 0.03, gl, lipZ), v3(-halfW - 0.03, gl, lipZ), v3(-hwF, frontY, zW), v3(hwF, frontY, zW), v3(0, 1, 0));
  b.fquadF(v3(halfW + 0.03, gl, lipZ), v3(-halfW - 0.03, gl, lipZ), v3(-halfW - 0.03, lipP.y, lipP.z), v3(halfW + 0.03, lipP.y, lipP.z), v3(0, 0.3, -1));
  b.fquadF(v3(hwF, frontY, zW), v3(-hwF, frontY, zW), v3(-hwF, frontY - 0.3, zW), v3(hwF, frontY - 0.3, zW), v3(0, 0, -1));
  const q = new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), ac).multiply(new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), Math.PI));
  const faceCz = faceC.z;
  const faceCy = faceC.y;
  const zBot = kneeTop.z;
  const yBot = kneeTop.y;
  const zTop = lipP.z;
  const pr = profileAt(P, zRear);

  // centre pedestal + throttle levers
  const pedZ0 = eye.z + 0.05;
  const pedTop = K.floorY + (yBot - K.floorY) * 0.78;
  b.set({ color: PANEL, mat: MATTE });
  b.box(0, (K.floorY + pedTop) / 2, (pedZ0 + zBot) / 2, Math.min(0.15, halfW * 0.22), (pedTop - K.floorY) / 2, (zBot - pedZ0) / 2);
  const nEng = D.engines.length;
  for (let i = 0; i < nEng; i++) {
    const x = (nEng === 1 ? 0 : (i / (nEng - 1) - 0.5) * 0.16) * -1;
    b.set({ color: rgb(0x9aa0a8), mat: METAL });
    b.box(x, pedTop + 0.07, (pedZ0 + zBot) / 2 + 0.05, 0.008, 0.07, 0.008);
    b.set({ color: nEng === 1 ? rgb(0x111111) : rgb(0xe8e8e8), mat: PAINT });
    b.box(x, pedTop + 0.15, (pedZ0 + zBot) / 2 + 0.05, 0.02, 0.018, 0.022);
  }
  // yokes
  for (const sx of [1, -1]) {
    const x = sx * Math.min(K.seatX, halfW * 0.62);
    const colTop = v3(x, eye.y - 0.42, zTop - 0.32);
    b.set({ color: rgb(0x3a3d44), mat: MATTE });
    b.cylinder(v3(x, yBot + 0.02, zBot - 0.02), colTop, 0.025, 0.022, 6, false);
    b.set({ color: rgb(0x22252a), mat: PAINT });
    const wy = colTop.y + 0.02;
    const wz = colTop.z - 0.02;
    b.box(x, wy, wz, 0.13, 0.018, 0.018);
    b.box(x + 0.13, wy + 0.05, wz, 0.018, 0.07, 0.02);
    b.box(x - 0.13, wy + 0.05, wz, 0.018, 0.07, 0.02);
  }
  // seats (behind the eye, beside it)
  for (const sx of [1, -1]) {
    const x = sx * K.seatX * 1.05;
    const zs = eye.z - 0.32;
    const seatY = K.floorY + Math.min(0.45, (eye.y - K.floorY) * 0.42);
    b.set({ color: SEAT, mat: MATTE });
    b.box(x, seatY, zs + 0.12, 0.24, 0.06, 0.24);
    b.push(new THREE.Matrix4().makeTranslation(x, seatY, zs - 0.12).multiply(new THREE.Matrix4().makeRotationX(0.22)));
    b.box(0, 0.38, 0, 0.23, 0.36, 0.05);
    b.set({ color: mix(SEAT, D.colors.interior.seatAccent, 0.35), mat: MATTE });
    b.box(0, 0.86, 0, 0.13, 0.1, 0.06);
    b.pop();
    b.set({ color: SEAT, mat: MATTE });
    b.box(x, (K.floorY + seatY) / 2, zs, 0.06, (seatY - K.floorY) / 2, 0.06);
  }
  // overhead panel (jets)
  if (K.glass) {
    const ceil = pr.mid + pr.top - Math.max(0.05, R * 0.06);
    const oy = Math.min(ceil, eye.y + 0.55);
    const ow = Math.min(0.36, halfW * 0.5);
    const z0 = eye.z - 0.1;
    const z1 = eye.z + 0.55;
    b.set({ color: PANEL, mat: MATTE });
    b.fquadF(v3(ow, oy, z0), v3(-ow, oy, z0), v3(-ow, oy + 0.12, z1), v3(ow, oy + 0.12, z1), v3(0, -1, 0));
    // switch dots
    const cols = [rgb(0xe8e8e8), rgb(0xffb020), rgb(0x40c060), rgb(0x9aa0a8)];
    let n = 0;
    for (let iz = 0; iz < 5; iz++) {
      for (let ix = 0; ix < 7; ix++) {
        const x = -ow * 0.8 + (ix / 6) * ow * 1.6;
        const t = (iz + 0.5) / 5;
        const z = z0 + (z1 - z0) * t;
        const y = oy + 0.12 * t - 0.006;
        b.set({ color: cols[(n++ * 7 + iz) % cols.length], mat: PAINT });
        b.fquadF(v3(x + 0.018, y, z - 0.02), v3(x - 0.018, y, z - 0.02), v3(x - 0.018, y + 0.0036, z + 0.02), v3(x + 0.018, y + 0.0036, z + 0.02), v3(0, -1, 0));
      }
    }
  }
  b.set({ color: [1, 1, 1], mat: DARK });
  return { position: v3(0, faceCy, faceCz).addScaledVector(fNrm, 0.003), quaternion: q, width: panelW, height: panelH };
}

/** Fuselage half-width at a given height (approx) for station z. */
export function widthAt(P: Design['profile'], z: number, y: number): number {
  const pa = profileAt(P, z);
  const h = y >= pa.mid ? (y - pa.mid) / Math.max(1e-3, pa.top) : (pa.mid - y) / Math.max(1e-3, pa.bot);
  const c = Math.min(1, Math.abs(h));
  // superellipse: |x/w|^n + |h|^n = 1
  const xs = Math.pow(Math.max(0, 1 - Math.pow(c, pa.n)), 1 / pa.n);
  const pinch = y >= pa.mid ? pa.pinch * Math.pow(c, pa.n) : 0;
  return pa.w * xs * (1 - pinch);
}

/** Flat fan closing the ring at z, facing dir (+1 = +Z). */
export function fan(b: GeoBuilder, P: Design['profile'], z: number, dir: 1 | -1, inset: number): void {
  const ring = fusRing(P, z, 28, inset);
  const pa = profileAt(P, z);
  const n = v3(0, 0, dir);
  const ci = b.vtxV(v3(0, pa.mid, z), n);
  const base = b.count;
  for (const p of ring.p) b.vtxV(p, n);
  const N = ring.p.length;
  for (let k = 0; k < N; k++) {
    const a = base + k;
    const c = base + ((k + 1) % N);
    // ring goes top → left(+X) → bottom: CCW seen from -Z
    if (dir > 0) b.tri(ci, c, a);
    else b.tri(ci, a, c);
  }
}
