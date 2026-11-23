import * as THREE from 'three';
import { GeoBuilder, MATTE, PAINT, type RGB, rgb, mix, v3 } from './builder';
import { loftFuselage, profileAt } from './fuselage';
import { widthAt } from './cockpit';
import type { Design } from './designs';

/**
 * Cabin interior of one fuselage part, revealed only when one of its joints breaks: inward shell (ceiling, walls with
 * bright window panes, dark cargo hold), cabin floor, rows of empty seats, overhead bins, ceiling light strip; the
 * jumbo also gets its upper deck. Darkens with depth from the open ends so the cavity reads as a cavity.
 */
export function buildInterior(
  b: GeoBuilder, D: Design, za: number, zb: number, cabin: boolean,
  opts: { seatsOut?: { x: number; y: number; z: number }[]; front?: boolean; rear?: boolean } = {},
): void {
  const P = D.profile;
  const R = Math.max(0.5, P.w((P.zNose + P.zTail) / 2));
  const I = D.colors.interior;
  const floorY = D.floorY;
  const ceilH = 0.62;
  b.sway = -1;
  const glass = D.liv.rects.filter((r) => r.kind === 'glass' && r.z1 > za && r.z0 < zb);
  loftFuselage(b, P, { bounds: [], colors: [[1, 1, 1]], rects: glass }, za, zb, {
    ringSeg: cabin ? 28 : 16, step: R * (glass.length ? 0.15 : 0.6), exact: glass.length > 0, win: cabin && !!D.win,
    inner: {
      offset: Math.max(0.03, R * 0.04),
      zFront: zb + 1,
      color: (h) => {
        if (!cabin) return [0.05, 0.05, 0.055];
        const y = h; // normalized
        if (y > ceilH) return I.ceiling;
        if (y > -0.05) return I.wall;
        return [0.07, 0.07, 0.08];
      },
    },
  });
  if (!cabin) {
    b.sway = 0;
    return;
  }
  // floor
  const segs = Math.max(1, Math.ceil((zb - za) / (R * 1.5)));
  for (let s = 0; s < segs; s++) {
    const z0 = za + ((zb - za) * s) / segs;
    const z1 = za + ((zb - za) * (s + 1)) / segs;
    const w0 = Math.max(0.2, widthAt(P, z0, floorY) - 0.03);
    const w1 = Math.max(0.2, widthAt(P, z1, floorY) - 0.03);
    b.set({ color: I.floor, mat: MATTE });
    b.fquadF(v3(w0, floorY, z0), v3(-w0, floorY, z0), v3(-w1, floorY, z1), v3(w1, floorY, z1), v3(0, 1, 0));
    // aisle carpet stripe
    b.set({ color: mix(I.floor, [1, 1, 1], 0.12), mat: MATTE });
    const aw = R * 0.12;
    b.fquadF(v3(aw, floorY + 0.004, z0), v3(-aw, floorY + 0.004, z0), v3(-aw, floorY + 0.004, z1), v3(aw, floorY + 0.004, z1), v3(0, 1, 0));
  }
  // windows: the shell itself is cut open by the material (vWin), so you can look outside from the cabin
  const W = D.win;
  // end walls: rear pressure bulkhead / front wall with the cockpit door (walkable cabin ends)
  if (opts.rear) bulkhead(b, D, za + 0.02, 1, I.wall, null);
  if (opts.front) bulkhead(b, D, zb - 0.02, -1, I.wall, mix(I.wall, [0.25, 0.27, 0.32], 0.6));
  // seats
  const seatCols = seatColumns(D, R);
  const pitch = D.seatPitch;
  const nRows = Math.floor((zb - za - 0.6) / pitch);
  const doorZ = W ? W.doors.filter((d) => d.y < 1.5).map((d) => d.s) : [];
  for (let r = 0; r < nRows; r++) {
    const z = za + 0.45 + r * pitch;
    if (doorZ.some((dz) => Math.abs(dz - z) < 0.75)) continue;
    for (const x of seatCols) {
      if (Math.abs(x) > widthAt(P, z, floorY + 0.5) - 0.28) continue;
      seat(b, x, floorY, z, I.seat, I.seatAccent, (r + Math.round(x * 3)) % 7 === 0);
      opts.seatsOut?.push({ x, y: floorY, z });
    }
  }
  // jumbo upper deck
  if (D.upperFloorY !== undefined) {
    const uz0 = Math.max(za, 12.5);
    const uz1 = Math.min(zb, 26);
    if (uz1 > uz0 + 1) {
      const fy = D.upperFloorY;
      const w = Math.max(0.3, widthAt(P, (uz0 + uz1) / 2, fy) - 0.03);
      b.set({ color: I.floor, mat: MATTE });
      b.fquadF(v3(w, fy, uz0), v3(-w, fy, uz0), v3(-w, fy, uz1), v3(w, fy, uz1), v3(0, 1, 0));
      b.set({ color: [0.2, 0.2, 0.22], mat: MATTE });
      b.fquadF(v3(w, fy - 0.03, uz0), v3(-w, fy - 0.03, uz0), v3(-w, fy - 0.03, uz1), v3(w, fy - 0.03, uz1), v3(0, -1, 0));
      const rows = Math.floor((uz1 - uz0 - 0.6) / pitch);
      for (let r = 0; r < rows; r++) {
        const z = uz0 + 0.45 + r * pitch;
        for (const x of [-1.25, -0.75, 0.75, 1.25]) if (Math.abs(x) < widthAt(P, z, fy + 0.5) - 0.28) seat(b, x, fy, z, I.seat, I.seatAccent, false);
      }
    }
  }
  // overhead bins along both sides + ceiling light strip
  const pa = profileAt(P, (za + zb) / 2);
  const binY = pa.mid + pa.top * 0.5;
  const binX = widthAt(P, (za + zb) / 2, binY) - R * 0.2;
  if (binX > 0.4 && D.type !== 'prop') {
    for (const sx of [1, -1]) {
      b.set({ color: mix(I.ceiling, [0.6, 0.6, 0.62], 0.25), mat: PAINT });
      b.box(sx * binX, binY, (za + zb) / 2, R * 0.16, R * 0.11, (zb - za) / 2 - 0.05);
    }
    b.set({ color: rgb(0xfff4dc), mat: PAINT });
    const cy = pa.mid + pa.top * 0.86;
    b.fquadF(v3(R * 0.05, cy, za + 0.05), v3(-R * 0.05, cy, za + 0.05), v3(-R * 0.05, cy, zb - 0.05), v3(R * 0.05, cy, zb - 0.05), v3(0, -1, 0));
  }
  b.sway = 0;
}

/** Flat end wall of the cabin at z (facing +1 = toward +Z), following the inner profile; optional door panel. */
function bulkhead(b: GeoBuilder, D: Design, z: number, facing: number, col: RGB, door: RGB | null): void {
  const P = D.profile;
  const pa = profileAt(P, z);
  const R = Math.max(0.5, P.w((P.zNose + P.zTail) / 2));
  const off = Math.max(0.05, R * 0.06);
  const y0 = pa.mid - pa.bot * 0.97, y1 = pa.mid + pa.top * 0.97;
  const n = 14;
  const nrm = v3(0, 0, facing);
  b.set({ color: col, mat: MATTE });
  for (let k = 0; k < n; k++) {
    const ya = y0 + ((y1 - y0) * k) / n, yb = y0 + ((y1 - y0) * (k + 1)) / n;
    const xa = Math.max(0.02, widthAt(P, z, ya) - off), xb = Math.max(0.02, widthAt(P, z, yb) - off);
    b.fquadF(v3(xa, ya, z), v3(-xa, ya, z), v3(-xb, yb, z), v3(xb, yb, z), nrm);
  }
  if (door) {
    const fy = D.floorY, dz = z + facing * 0.012;
    b.set({ color: door, mat: PAINT });
    b.fquadF(v3(0.42, fy, dz), v3(-0.42, fy, dz), v3(-0.42, fy + 1.9, dz), v3(0.42, fy + 1.9, dz), nrm);
    b.set({ color: [0.85, 0.8, 0.6], mat: PAINT });
    b.fquadF(v3(-0.28, fy + 0.98, dz + facing * 0.004), v3(-0.34, fy + 0.98, dz + facing * 0.004), v3(-0.34, fy + 1.04, dz + facing * 0.004), v3(-0.28, fy + 1.04, dz + facing * 0.004), nrm);
  }
}

function seatColumns(D: Design, R: number): number[] {
  const blocks = D.seatsAbreast;
  const seatW = D.type === 'prop' ? 0.5 : D.type === 'bizjet' ? 0.62 : 0.5;
  const aisle = D.type === 'prop' ? 0.08 : R * 0.27;
  const total = blocks.reduce((a, n) => a + n * seatW, 0) + aisle * (blocks.length - 1);
  const cols: number[] = [];
  let x = total / 2;
  blocks.forEach((n, bi) => {
    for (let i = 0; i < n; i++) {
      cols.push(x - seatW / 2);
      x -= seatW;
    }
    if (bi < blocks.length - 1) x -= aisle;
  });
  return cols;
}

function seat(b: GeoBuilder, x: number, floorY: number, z: number, col: RGB, accent: RGB, alt: boolean): void {
  const c = alt ? accent : col;
  b.set({ color: c, mat: MATTE });
  b.box(x, floorY + 0.42, z + 0.05, 0.22, 0.06, 0.22);
  b.push(new THREE.Matrix4().makeTranslation(x, floorY + 0.42, z - 0.17).multiply(new THREE.Matrix4().makeRotationX(0.18)));
  b.box(0, 0.36, 0, 0.21, 0.34, 0.045);
  b.set({ color: mix(c, [1, 1, 1], 0.55), mat: MATTE });
  b.box(0, 0.62, -0.05, 0.14, 0.06, 0.01);
  b.pop();
  b.set({ color: [0.18, 0.18, 0.2], mat: MATTE });
  b.box(x, floorY + 0.19, z, 0.05, 0.19, 0.12);
}
