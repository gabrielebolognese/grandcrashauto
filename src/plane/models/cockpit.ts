import * as THREE from 'three';
import { GeoBuilder, MATTE, METAL, PAINT, DARK, VAR, type RGB, rgb, v3, mix } from './builder';
import { loftFuselage, fusRing, profileAt, fuselageLines } from './fuselage';
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

export function buildCockpit(b: GeoBuilder, D: Design): InstrumentPlacement {
  const P = D.profile;
  const L = D.liv;
  const K = D.cockpit;
  const zRear = D.cuts[1];
  const zNoseCut = D.cuts[0];
  const R = Math.max(0.5, P.w((P.zNose + P.zTail) / 2));
  const hSill = 0.2;
  // inward shell: openings exactly at the glass rects
  const lines = fuselageLines(P, L, 48, true);
  loftFuselage(b, P, L, zRear, Math.max(zNoseCut, K.zFront + 0.01), {
    ringSeg: 48, step: R * 0.12, exact: true, win: false, extraZ: [K.zFront],
    inner: {
      offset: Math.max(0.02, R * 0.025),
      zFront: K.zFront,
      color: (h) => (h > 0.62 ? SHELL_UP : h > hSill ? SHELL_MID : SHELL_LOW),
    },
  }, lines);
  // front closure (behind the dashboard)
  b.set({ color: PANEL, mat: MATTE });
  fan(b, P, K.zFront, -1, Math.max(0.02, R * 0.025));
  // aft bulkhead with a door (hidden when the cabin is opened)
  b.variant = VAR.bulkhead;
  b.set({ color: SHELL_MID, mat: MATTE });
  fan(b, P, zRear + 0.002, 1, Math.max(0.02, R * 0.025));
  const pr = profileAt(P, zRear);
  const doorH = Math.min(1.9, (pr.mid + pr.top - K.floorY) * 0.88);
  const doorW = Math.min(0.42, pr.w * 0.3);
  b.set({ color: rgb(0x5d6067), mat: PAINT });
  b.fquadF(v3(doorW, K.floorY, zRear + 0.012), v3(-doorW, K.floorY, zRear + 0.012), v3(-doorW, K.floorY + doorH, zRear + 0.012), v3(doorW, K.floorY + doorH, zRear + 0.012), v3(0, 0, 1));
  b.variant = 0;
  // floor
  const wf = Math.max(0.3, widthAt(P, zRear + 0.3, K.floorY) - 0.04);
  b.set({ color: rgb(0x2c2e33), mat: MATTE });
  b.fquadF(v3(wf, K.floorY, zRear), v3(-wf, K.floorY, zRear), v3(-wf * 0.8, K.floorY, K.dashZ + 0.2), v3(wf * 0.8, K.floorY, K.dashZ + 0.2), v3(0, 1, 0));

  // dashboard: slanted face toward the eye, glareshield on top
  const eye = K.eye;
  const halfW = Math.min(K.panelW / 2 + 0.08, widthAt(P, K.dashZ, K.dashTop) - 0.03);
  const panelH = (K.panelW / 3) * 1.0;
  const tilt = 0.22; // face tilted back
  const yTop = K.dashTop - 0.035;
  const yBot = yTop - panelH - 0.16;
  const zTop = K.dashZ;
  const zBot = K.dashZ + Math.tan(tilt) * (yTop - yBot);
  b.set({ color: PANEL, mat: MATTE });
  b.fquadF(v3(halfW, yTop, zTop), v3(-halfW, yTop, zTop), v3(-halfW, yBot, zBot), v3(halfW, yBot, zBot), v3(0, 0.2, -1));
  // lower panel down to the floor (knee area)
  b.set({ color: SHELL_LOW, mat: MATTE });
  b.fquadF(v3(halfW, yBot, zBot), v3(-halfW, yBot, zBot), v3(-halfW * 0.9, K.floorY, zBot + 0.25), v3(halfW * 0.9, K.floorY, zBot + 0.25), v3(0, 0, -1));
  // side cheeks
  for (const sx of [1, -1]) {
    b.fquadF(v3(sx * halfW, yTop, zTop), v3(sx * halfW, yBot, zBot), v3(sx * halfW, yBot, K.zFront), v3(sx * halfW, yTop, K.zFront), v3(-sx, 0, 0));
  }
  // glareshield: slab with an overhanging lip
  b.set({ color: GLARE, mat: MATTE });
  const gl = K.dashTop;
  const lip = 0.12;
  b.fquadF(v3(halfW + 0.03, gl, zTop - lip), v3(-halfW - 0.03, gl, zTop - lip), v3(-halfW - 0.03, gl, K.zFront), v3(halfW + 0.03, gl, K.zFront), v3(0, 1, 0));
  b.fquadF(v3(halfW + 0.03, gl, zTop - lip), v3(-halfW - 0.03, gl, zTop - lip), v3(-halfW - 0.03, gl - 0.05, zTop - lip + 0.02), v3(halfW + 0.03, gl - 0.05, zTop - lip + 0.02), v3(0, 0, -1));
  b.fquadF(v3(halfW + 0.03, gl - 0.05, zTop - lip + 0.02), v3(-halfW - 0.03, gl - 0.05, zTop - lip + 0.02), v3(-halfW - 0.03, gl - 0.05, zTop), v3(halfW + 0.03, gl - 0.05, zTop), v3(0, -1, 0));
  // instrument face placement (slightly in front of the panel face)
  const faceTop = yTop - 0.03;
  const faceCy = faceTop - panelH / 2;
  const faceCz = zTop + Math.tan(tilt) * (yTop - faceCy) - 0.012;
  const q = new THREE.Quaternion().setFromAxisAngle(v3(1, 0, 0), -tilt).multiply(new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), Math.PI));

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
  return { position: v3(0, faceCy, faceCz), quaternion: q, width: K.panelW, height: panelH };
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
