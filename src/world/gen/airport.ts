import { CONFIG } from '../../config';
import { Rng } from '../../core/rng';
import type { AirportData, CityData, PropKind, Vec3 } from '../types';
import { Facade, Mat, type BoxPart, type Cylinder, type Decal, type Island, type Solid } from './model';
import { ISLAND_TOP } from './layout';
import type { PedBuilder } from './ped';

/**
 * Airport (SPEC-PART2 §2, PART3 §2) inside CONFIG.world.airportBounds, west of the city near the west coast.
 * Main runway 2200 × 45 m E–W (take-offs west over the sea), crosswind 1200 m, taxiways with hold-short bars, apron
 * with 4 stands sized per plane type, terminal + jet bridges, control tower, 2 hangars, fence, access road + car park.
 * Pure data, ABSOLUTE coordinates.
 */

export interface PavedRect {
  cx: number;
  cz: number;
  dx: number; // unit direction of the long axis
  dz: number;
  hl: number;
  hw: number;
  col: number;
  mat: number;
  y: number;
  surf: 'asphalt' | 'concrete';
}

export interface AirportLight {
  x: number;
  y: number;
  z: number;
  col: number;
  size: number;
}

export interface AirportModel {
  data: AirportData;
  paved: PavedRect[];
  decals: Decal[];
  solids: Solid[];
  cylinders: Cylinder[];
  parts: BoxPart[];
  lights: AirportLight[];
  islands: Island[];
  /** Fence: polyline segments [x0,z0,x1,z1]. */
  fence: number[][];
  arches: { cx: number; cz: number; w: number; d: number; y: number; h: number; col: number }[];
}

const RWY = 0x3b3d43, SHOULDER = 0x55575d, TAXI = 0x45474d, APRON = 0xa9aaa6, WHITE = 0xf4f2ec, YELLOW = 0xf2c84b;

/** 7-segment digits: a b c d e f g */
const SEG: Record<string, string> = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg' };

export function generateAirport(seed: number, city: CityData, ped: PedBuilder, addNode: (x: number, y: number, z: number) => number,
  addEdge: (a: number, b: number, kind: 'lot' | 'street4' | 'street2', lanes: number, width: number, sw: number, pts: Vec3[], speed: number, laneOff: number) => number,
  chunkOf: (x: number, z: number) => number): AirportModel {
  const rng = Rng.from(seed, 0xa1);
  const AB = CONFIG.world.airportBounds;
  const E = CONFIG.world.airportElevation ?? 1.2; // airport ground level (terrain blends to it at the bounds)
  const m: AirportModel = {
    data: null as unknown as AirportData, paved: [], decals: [], solids: [], cylinders: [], parts: [], lights: [], islands: [], fence: [], arches: [],
  };
  const rect = (cx: number, cz: number, dx: number, dz: number, hl: number, hw: number, col: number, mat: number, y: number, surf: 'asphalt' | 'concrete') =>
    m.paved.push({ cx, cz, dx, dz, hl, hw, col, mat, y, surf });
  const dec = (cx: number, cz: number, dx: number, dz: number, hl: number, hw: number, col: number, y = E + 0.05, mat: number = Mat.Paint) =>
    m.decals.push({ cx, cz, dx, dz, hl, hw, y, col, mat });
  const light = (x: number, z: number, col: number, size = 1, y = E + 0.35) => m.lights.push({ x, y, z, col, size });
  const fixture = (x: number, z: number) => m.solids.push({ cx: x, cy: E, cz: z, w: 0.3, h: 0.32, d: 0.3, yaw: 0, col: 0xdedad2, mat: Mat.Metal, collide: false });

  /** Paint a string of digits: origin = centre of the text, v = "up" direction of the glyphs, u = right. */
  const paintText = (text: string, ox: number, oz: number, vx: number, vz: number, H: number, W: number, stroke: number, y = E + 0.055) => {
    const ux = -vz, uz = vx; // right-hand perpendicular (in x/z plane, looking down with v up)
    const gap = W * 0.45;
    const total = text.length * W + (text.length - 1) * gap;
    text.split('').forEach((ch, k) => {
      const segs = SEG[ch];
      if (!segs) return;
      const cu = -total / 2 + W / 2 + k * (W + gap);
      const P = (u: number, v: number): [number, number] => [ox + ux * (cu + u) + vx * v, oz + uz * (cu + u) + vz * v];
      const bar = (u0: number, v0: number, u1: number, v1: number) => {
        const [ax, az] = P(u0, v0), [bx, bz] = P(u1, v1);
        const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
        dec((ax + bx) / 2, (az + bz) / 2, dx / l, dz / l, l / 2 + stroke / 2, stroke / 2, WHITE, y);
      };
      const hw = W / 2 - stroke / 2, hh = H / 2 - stroke / 2;
      if (segs.includes('a')) bar(-hw, hh, hw, hh);
      if (segs.includes('g')) bar(-hw, 0, hw, 0);
      if (segs.includes('d')) bar(-hw, -hh, hw, -hh);
      if (segs.includes('b')) bar(hw, hh, hw, 0);
      if (segs.includes('c')) bar(hw, 0, hw, -hh);
      if (segs.includes('f')) bar(-hw, hh, -hw, 0);
      if (segs.includes('e')) bar(-hw, 0, -hw, -hh);
    });
  };

  // ── base: grass handled by the renderer; paved surfaces ──
  // main runway
  const rz = -300, rx0 = -3350, rx1 = -1150, rw = 45;
  const rcx = (rx0 + rx1) / 2, rhl = (rx1 - rx0) / 2;
  rect(rcx, rz, 1, 0, rhl + 60, rw / 2 + 7.5, SHOULDER, Mat.Asphalt, E + 0.02, 'asphalt');
  rect(rcx, rz, 1, 0, rhl, rw / 2, RWY, Mat.Asphalt, E + 0.03, 'asphalt');
  // runway markings
  for (let x = rx0; x < rx1; x += 50) for (const s of [-1, 1]) dec(x + 25, rz + s * (rw / 2 - 1), 1, 0, 25, 0.45, WHITE);
  for (let x = rx0 + 140; x < rx1 - 140 - 30; x += 50) dec(x + 15, rz, 1, 0, 15, 0.45, WHITE);
  const runwayEnd = (tx: number, inward: number, desig: string) => {
    // threshold piano keys
    for (let k = 0; k < 6; k++) for (const s of [-1, 1]) dec(tx + inward * (6 + 15), rz + s * (3.2 + k * 3.4), 1, 0, 15, 0.9, WHITE);
    // designator (glyph up = landing direction, read by an approaching pilot)
    paintText(desig, tx + inward * 60, rz, inward, 0, 18, 6, 1.2);
    // aiming point + touchdown zone
    for (const s of [-1, 1]) dec(tx + inward * 322, rz + s * 9.5, 1, 0, 22.5, 4.5, WHITE);
    for (const [d, n] of [[150, 3], [450, 2], [600, 2], [750, 1]] as [number, number][])
      for (let k = 0; k < n; k++) for (const s of [-1, 1]) dec(tx + inward * (d + 11), rz + s * (5 + k * 3.2), 1, 0, 11, 0.9, WHITE);
    // end lights: green threshold bar, red stop bar behind
    for (let z = rz - rw / 2; z <= rz + rw / 2 + 0.1; z += 3) {
      light(tx, z, 0x40ff70, 1.2);
      light(tx - inward * 2, z, 0xff3030, 1.0);
    }
    // approach lights (crossbars every 30 m, out to 300 m or the bounds)
    for (let d = 30; d <= 300; d += 30) {
      const x = tx - inward * d;
      if (x < AB.minX + 5 || x > AB.maxX - 5) break;
      for (const o of [-8, -4, 0, 4, 8]) {
        light(x, rz + o, 0xfff2c8, 1.1, E + 1.2);
        fixture(x, rz + o);
      }
    }
    // PAPI on the left side, 300 m in (2 white + 2 red = on the glide path)
    const leftSign = inward < 0 ? 1 : -1; // landing heading west (inward -x): left = +z
    for (let k = 0; k < 4; k++) {
      const z = rz + leftSign * (rw / 2 + 12 + k * 9);
      light(tx + inward * 300, z, k < 2 ? 0xff3a2a : 0xffffff, 1.6, E + 0.9);
      m.solids.push({ cx: tx + inward * 300, cy: E, cz: z, w: 1.4, h: 0.8, d: 1.2, yaw: 0, col: 0xe8e0d0, mat: Mat.Metal, collide: false });
    }
  };
  runwayEnd(rx1, -1, '27');
  runwayEnd(rx0, 1, '09');
  for (let x = rx0; x <= rx1 + 0.1; x += 60) for (const s of [-1, 1]) light(x, rz + s * (rw / 2 + 1.5), 0xfff4dc, 1);

  // crosswind runway
  const cA: [number, number] = [-3060, -385], cB: [number, number] = [-1960, -880];
  const cdx = cB[0] - cA[0], cdz = cB[1] - cA[1], cl = Math.hypot(cdx, cdz);
  const cux = cdx / cl, cuz = cdz / cl, cw = 30;
  const ccx = (cA[0] + cB[0]) / 2, ccz = (cA[1] + cB[1]) / 2;
  rect(ccx, ccz, cux, cuz, cl / 2 + 30, cw / 2 + 5, SHOULDER, Mat.Asphalt, E + 0.018, 'asphalt');
  rect(ccx, ccz, cux, cuz, cl / 2, cw / 2, RWY, Mat.Asphalt, E + 0.028, 'asphalt');
  const pxz = (t: number, o: number): [number, number] => [cA[0] + cux * t - cuz * o, cA[1] + cuz * t + cux * o];
  for (let t = 0; t < cl; t += 50) for (const s of [-1, 1]) {
    const [x, z] = pxz(t + 25, s * (cw / 2 - 0.8));
    dec(x, z, cux, cuz, 25, 0.4, WHITE, E + 0.048);
  }
  for (let t = 110; t < cl - 140; t += 50) {
    const [x, z] = pxz(t + 15, 0);
    dec(x, z, cux, cuz, 15, 0.4, WHITE, E + 0.048);
  }
  for (const [t0, inward, des] of [[0, 1, '07'], [cl, -1, '25']] as [number, number, string][]) {
    for (let k = 0; k < 4; k++) for (const s of [-1, 1]) {
      const [x, z] = pxz(t0 + inward * 20, s * (2.6 + k * 3.2));
      dec(x, z, cux, cuz, 14, 0.85, WHITE, E + 0.05);
    }
    const [x, z] = pxz(t0 + inward * 55, 0);
    paintText(des, x, z, cux * inward, cuz * inward, 14, 4.8, 1.0);
    for (let o = -cw / 2; o <= cw / 2 + 0.1; o += 3) {
      const [lx, lz] = pxz(t0, o);
      light(lx, lz, 0x40ff70, 1.1);
    }
  }
  for (let t = 0; t <= cl + 0.1; t += 60) for (const s of [-1, 1]) {
    const [x, z] = pxz(t, s * (cw / 2 + 1.5));
    light(x, z, 0xfff4dc, 0.9);
  }

  // ── taxiways ──
  const TW = 23;
  const tz = -180;
  const taxi = (x0: number, z0: number, x1: number, z1: number, lights = true) => {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz);
    const ux = dx / l, uz = dz / l;
    rect((x0 + x1) / 2, (z0 + z1) / 2, ux, uz, l / 2, TW / 2, TAXI, Mat.Asphalt, E + 0.025, 'asphalt');
    for (let t = 0; t < l; t += 20) {
      const a = t, b = Math.min(l, t + 20);
      dec(x0 + ux * (a + b) / 2, z0 + uz * (a + b) / 2, ux, uz, (b - a) / 2, 0.09, YELLOW, E + 0.045);
      for (const s of [-1, 1]) dec(x0 + ux * (a + b) / 2 - uz * s * (TW / 2 - 0.6), z0 + uz * (a + b) / 2 + ux * s * (TW / 2 - 0.6), ux, uz, (b - a) / 2, 0.1, YELLOW, E + 0.045);
    }
    if (lights) for (let t = 15; t < l; t += 30) for (const s of [-1, 1]) light(x0 + ux * t - uz * s * (TW / 2 + 1), z0 + uz * t + ux * s * (TW / 2 + 1), 0x3a6bff, 0.8, E + 0.3);
  };
  const holdShort = (x: number, z: number, ux: number, uz: number) => {
    // 2 solid + 2 dashed yellow lines across the taxiway (solid side toward the taxiway)
    for (let k = 0; k < 4; k++) {
      const off = (k - 1.5) * 0.9;
      const cx = x + ux * off, cz = z + uz * off;
      if (k < 2) dec(cx, cz, -uz, ux, TW / 2 - 0.5, 0.15, YELLOW, E + 0.05);
      else for (let o = -TW / 2 + 1; o < TW / 2 - 1; o += 3) dec(cx - uz * (o + 0.9), cz + ux * (o + 0.9), -uz, ux, 0.9, 0.15, YELLOW, E + 0.05);
    }
    for (const s of [-1, 1]) light(x - uz * s * (TW / 2 + 1.5), z + ux * s * (TW / 2 + 1.5), 0xffd040, 1.2, E + 0.5);
  };
  taxi(-3330, tz, -1170, tz);
  for (const x of [-3300, -2700, -2100, -1500, -1200]) {
    taxi(x, tz - TW / 2, x, rz + rw / 2 + 2, false);
    holdShort(x, rz + 75, 0, 1);
  }
  taxi(-3060, rz - rw / 2 - 2, cA[0], cA[1] + 10, false);
  holdShort(-3060, -345, 0, -1);
  for (const x of [-2400, -1960]) taxi(x, tz + TW / 2, x, -130, false);
  taxi(-2600, tz + TW / 2, -2600, -100, false); // hangar apron link

  // ── apron + stands ──
  const ax0 = -2500, ax1 = -1700, az0 = -130, az1 = 60;
  rect((ax0 + ax1) / 2, (az0 + az1) / 2, 1, 0, (ax1 - ax0) / 2, (az1 - az0) / 2, APRON, Mat.Concrete, E + 0.03, 'concrete');
  rect(-2655, -55, 1, 0, 165, 55, APRON, Mat.Concrete, E + 0.029, 'concrete'); // hangar apron
  for (let x = ax0; x < ax1; x += 25) {
    dec(x + 12.5, az0 + 0.4, 1, 0, 12.5, 0.12, YELLOW, E + 0.05);
    dec(x + 12.5, 42, 1, 0, 5, 0.12, WHITE, E + 0.05); // service road dashes
  }
  const standsDef: { type: 'prop' | 'bizjet' | 'airliner' | 'jumbo'; x: number; bw: number; bd: number; label: string }[] = [
    { type: 'prop', x: -1745, bw: 16, bd: 18, label: '1' },
    { type: 'bizjet', x: -1786, bw: 26, bd: 26, label: '2' },
    { type: 'airliner', x: -1852, bw: 44, bd: 44, label: '3' },
    { type: 'jumbo', x: -1952, bw: 78, bd: 76, label: '4' },
  ];
  const stands = standsDef.map((s, i) => {
    const cz = -6;
    // box outline (white), lead-in line (yellow) from the apron edge, stop bar at the nose
    const box = (x0: number, x1: number, z0: number, z1: number) => {
      dec((x0 + x1) / 2, z0, 1, 0, (x1 - x0) / 2, 0.15, WHITE);
      dec((x0 + x1) / 2, z1, 1, 0, (x1 - x0) / 2, 0.15, WHITE);
      dec(x0, (z0 + z1) / 2, 0, 1, (z1 - z0) / 2, 0.15, WHITE);
      dec(x1, (z0 + z1) / 2, 0, 1, (z1 - z0) / 2, 0.15, WHITE);
    };
    box(s.x - s.bw / 2, s.x + s.bw / 2, cz - s.bd / 2, cz + s.bd / 2);
    dec(s.x, (az0 + cz) / 2, 0, 1, (cz - az0) / 2, 0.12, YELLOW);
    dec(s.x, cz - s.bd * 0.42, 1, 0, Math.min(6, s.bw / 4), 0.3, YELLOW);
    paintText(s.label, s.x, cz + s.bd / 2 - 5, 0, -1, 6, 2.4, 0.5);
    return { id: i, type: s.type, p: { x: s.x, y: E + 0.03, z: cz }, yaw: Math.PI };
  });

  // ── terminal, jet bridges, tower, hangars ──
  const T = { x0: -2300, x1: -1800, z0: 75, z1: 125 };
  const glass = 0x5b86b5;
  const tseed = rng.next();
  const tcx = (T.x0 + T.x1) / 2, tcz = (T.z0 + T.z1) / 2;
  const P = (cx: number, cz: number, y: number, w: number, h: number, d: number, style: number, color: number, accent: number, floorH = 4, baseOff = 0, groundH = 0, lit = 0.5, tower = true) =>
    m.parts.push({ cx, cz, y, w, h, d, yaw: 0, style, color, accent, seed: tseed + m.parts.length * 0.01, floorH, baseOff, groundH, lit, tower });
  P(tcx, tcz, E, T.x1 - T.x0, 14, T.z1 - T.z0, Facade.Glass, glass, 0xff7a6b, 4.5, 0, 0, 0.6);
  P(tcx, tcz, E + 14, T.x1 - T.x0 + 2, 1.2, T.z1 - T.z0 + 2, Facade.Solid, 0xf4efe6, 0xffffff);
  P(tcx, tcz + 2, E, 80, 22, 40, Facade.Deco, 0xf6efe6, 0x5cc8d6, 4.5, 0, 5, 0.6); // central hall
  P(tcx, tcz + 2, E + 22, 60, 2.5, 30, Facade.Solid, 0x5cc8d6, 0x5cc8d6);
  P(tcx, T.z1 + 3.5, E + 4.2, T.x1 - T.x0 - 20, 0.5, 7, Facade.Solid, 0xffffff, 0xffffff); // entrance canopy
  for (let x = T.x0 + 15; x < T.x1 - 10; x += 30) P(x, T.z1 + 6.6, E, 0.6, 4.2, 0.6, Facade.Solid, 0xe8e2d8, 0xffffff);
  P(tcx, T.z1 + 0.8, E + 15.5, 46, 4, 1.2, Facade.Neon, 0xff7a6b, 0xff7a6b, 3); // sign
  // jet bridges for the big stands (rotunda + corridor at door height)
  const bridges: [typeof stands[number], number][] = [[stands[2], -4], [stands[3], -12], [stands[3], 16]];
  for (const [st, dx] of bridges) {
    const sx = st.p.x + dx;
    const len = T.z0 - 4 - (st.p.z + (st.type === 'jumbo' ? 26 : 12));
    P(sx, T.z0 - 4 - len / 2, E + 3.6, 3.2, 3.0, len, Facade.Solid, 0xd9dcdf, 0x5cc8d6, 3, 0, 0, 0, false);
    P(sx, T.z0 - 4 - len / 2, E + 6.6, 3.4, 0.25, len + 0.2, Facade.Solid, 0xbfc4c8, 0xbfc4c8, 3, 0, 0, 0, false);
    m.cylinders.push({ cx: sx, cy: E, cz: T.z0 - 4, r: 2.6, h: 7.2, col: 0xd9dcdf, mat: Mat.Concrete, segs: 14, collide: true });
    m.solids.push({ cx: sx, cy: E, cz: T.z0 - 4 - len * 0.8, w: 0.8, h: 3.6, d: 0.8, yaw: 0, col: 0x8a8f94, mat: Mat.Metal, collide: true });
    m.solids.push({ cx: sx, cy: E + 3.6, cz: T.z0 - 4 - len / 2, w: 3.2, h: 3.0, d: len, yaw: 0, col: -1, mat: Mat.Metal, collide: true });
  }
  // control tower
  const twx = -1760, twz = 100;
  m.cylinders.push({ cx: twx, cy: E, cz: twz, r: 3.6, h: 36, col: 0xf2ece2, mat: Mat.Concrete, segs: 16, collide: true });
  m.cylinders.push({ cx: twx, cy: E + 30, cz: twz, r: 5.2, h: 2, col: 0x5cc8d6, mat: Mat.Concrete, segs: 16, collide: false });
  P(twx, twz, E + 36, 12, 5.5, 12, Facade.Glass, 0x3f7a99, 0xff7a6b, 5.5, 0, 0, 0.9);
  P(twx, twz, E + 41.5, 13.5, 1.0, 13.5, Facade.Solid, 0xf4efe6, 0xffffff);
  P(twx, twz, E + 42.5, 0.5, 9, 0.5, Facade.Solid, 0xdddddd, 0xff3030);
  light(twx, twz, 0xff3030, 2.2, E + 51.5);
  // hangars (walls + barrel roof)
  for (const hx of [-2590, -2720]) {
    P(hx, -55, E, 100, 14, 90, Facade.Apartment, 0xe9e4da, 0x5cc8d6, 7, 0, 0, 0.3);
    m.arches.push({ cx: hx, cz: -55, w: 100.4, d: 90.4, y: E + 14, h: 9, col: 0xb8c4c9 });
    // big door on the north face
    m.solids.push({ cx: hx, cy: E, cz: -100.1, w: 80, h: 12.5, d: 0.3, yaw: 0, col: 0x8d969c, mat: Mat.Metal, collide: false });
  }
  // fuel farm
  for (let k = 0; k < 3; k++) m.cylinders.push({ cx: -2900 + k * 18, cy: E, cz: 40, r: 7, h: 9, col: 0xf1f1ec, mat: Mat.Concrete, segs: 18, collide: true });

  // ── landside: frontage road, access road, car park ──
  const fz = 145;
  rect(-1500, fz, 1, 0, 820, 7.5, 0x4a4d57, Mat.Asphalt, E + 0.02, 'asphalt');
  for (let x = -2320; x < -700; x += 10) dec(x + 5, fz, 1, 0, 5, 0.07, YELLOW, E + 0.045);
  for (let x = -2320; x < -700; x += 9) for (const s of [-1, 1]) dec(x + 1.5, fz + s * 3.6, 1, 0, 1.5, 0.07, WHITE, E + 0.045);
  // car park (facing the planes)
  const cp = { x0: -1660, x1: -1560, z0: -80, z1: 40 };
  rect((cp.x0 + cp.x1) / 2, (cp.z0 + cp.z1) / 2, 1, 0, (cp.x1 - cp.x0) / 2, (cp.z1 - cp.z0) / 2, 0x55585f, Mat.Asphalt, E + 0.02, 'asphalt');
  rect(-1610, (cp.z1 + fz) / 2, 0, 1, (fz - cp.z1) / 2, 4, 0x4a4d57, Mat.Asphalt, E + 0.021, 'asphalt');
  rect((ax1 + cp.x0) / 2, -20, 1, 0, (cp.x0 - ax1) / 2 + 2, 5, 0x6a6c70, Mat.Asphalt, E + 0.021, 'asphalt'); // service road to the apron
  for (const xr of [-1645, -1615, -1585]) for (let z = cp.z0 + 4; z < cp.z1 - 4; z += 2.7) dec(xr, z, 1, 0, 2.6, 0.06, WHITE, E + 0.045);
  // terminal curb (raised sidewalk) — the NPC crowd area
  const curb: Island = { id: 9000, kind: 'block', minX: T.x0 - 10, maxX: T.x1 + 10, minZ: T.z1, maxZ: T.z1 + 12.5, r: 1.5, top: E + ISLAND_TOP, sw: [0, 0, 6, 0], interior: 'plaza', block: 'none', district: 'hub' };
  m.islands.push(curb);
  // fence around the airside (bounds), gap for the access road
  const fx0 = AB.minX + 20, fx1 = AB.maxX - 20, fz0 = AB.minZ + 20, fz1 = 115;
  m.fence.push([fx0, fz0, fx1, fz0], [fx0, fz0, fx0, fz1], [fx1, fz0, fx1, -100]);
  m.fence.push([fx0, fz1, T.x0 - 30, fz1]);

  // ── road graph ──
  const nExit = addNode(AB.maxX, E, fz);
  const nCpRoad = addNode(-1610, E, fz);
  const nTermE = addNode(T.x1 + 10, E, fz);
  const nTermW = addNode(T.x0 - 20, E, fz);
  const nCp = addNode(-1610, E, 0);
  const nApron = addNode(ax1 - 30, E + 0.03, -20);
  const v = (x: number, z: number, y = E) => ({ x, y, z });
  addEdge(nExit, nCpRoad, 'street4', 4, 15, 0, [v(AB.maxX, fz), v(-1610, fz)], 70, 1.8);
  addEdge(nCpRoad, nTermE, 'street4', 4, 15, 0, [v(-1610, fz), v(T.x1 + 10, fz)], 50, 1.8);
  addEdge(nTermE, nTermW, 'street4', 4, 15, 4, [v(T.x1 + 10, fz), v(T.x0 - 20, fz)], 30, 1.8);
  addEdge(nCpRoad, nCp, 'lot', 2, 8, 0, [v(-1610, fz), v(-1610, cp.z1), v(-1610, 0)], 20, 1.8);
  addEdge(nCp, nApron, 'lot', 2, 10, 0, [v(-1610, 0), v(-1610, -20), v(cp.x0, -20), v(ax1 - 30, -20, E + 0.03)], 20, 2);

  // ── props: windsocks, fuel trucks, baggage carts, apron masts, landside lights ──
  const props = city.props;
  const prop = (kind: PropKind, x: number, z: number, yaw: number, y = E) => props.push({ kind, p: { x, y, z }, yaw, variant: rng.int(0, 999), chunk: chunkOf(x, z) });
  prop('windsock', rx1 - 280, rz - 70, 0);
  prop('windsock', rx0 + 280, rz + 70, 0);
  prop('windsock', cA[0] + 150, cA[1] - 60, 0);
  for (const [x, z] of [[-1800, 30], [-1930, 34], [-2080, 20]]) prop('fuelTruck', x, z, Math.PI / 2 + rng.range(-0.3, 0.3), E + 0.03);
  for (let k = 0; k < 9; k++) prop('baggageCart', -1880 - k * 14 + rng.range(-3, 3), 46 + rng.range(-3, 3), rng.range(0, Math.PI * 2), E + 0.03);
  for (let x = ax0 + 40; x < ax1; x += 100) prop('streetlight', x, az1 + 6, 0, E + 0.03);
  for (let x = -2300; x < -700; x += 32) prop('streetlight', x, fz + 9, Math.PI, E);
  for (let z = cp.z0 + 10; z < cp.z1; z += 30) prop('streetlight', cp.x1 + 3, z, -Math.PI / 2, E);
  for (let k = 0; k < 6; k++) prop('cone', -1700 + rng.range(-20, 20), -60 + rng.range(-20, 20), rng.range(0, 6), E + 0.03);

  // ── pedestrians: terminal curb sidewalk, benches, wander area ──
  const py = E + ISLAND_TOP;
  const walkZ = curb.maxZ - 3;
  let prev = -1;
  const curbNodes: number[] = [];
  for (let x = curb.minX + 3; x <= curb.maxX - 3 + 0.01; x += 24) {
    const id = ped.node(x, py, walkZ);
    if (prev >= 0) ped.edge(prev, id, 'sidewalk', 5);
    curbNodes.push(id);
    prev = id;
  }
  // entrance plaza nodes near the doors
  for (let k = 0; k < curbNodes.length; k += 3) {
    const n = ped.nodes[curbNodes[k]].p;
    const d = ped.node(n.x, py, curb.minZ + 2.5);
    ped.edge(curbNodes[k], d, 'plaza', 4);
  }
  const benches: number[] = [];
  for (let x = curb.minX + 20; x < curb.maxX - 20; x += 45) {
    const z = curb.maxZ - 1.0;
    props.push({ kind: 'bench', p: { x, y: py, z }, yaw: 0, variant: rng.int(0, 999), chunk: chunkOf(x, z) });
    const pi = props.length - 1;
    const pn = ped.attach(x, py, walkZ, 'sidewalk', 2, (e) => e.kind === 'sidewalk' && ped.nodes[e.a].p.z === walkZ, false);
    city.benches.push({ id: city.benches.length, p: { x, y: py + CONFIG.props.benchSeatHeight, z }, yaw: 0, seats: 3, seatSpacing: CONFIG.props.benchSeatSpacing, seatHeight: CONFIG.props.benchSeatHeight, propIndex: pi, pedNode: pn });
    benches.push(pi);
  }
  city.wanderAreas.push({ id: city.wanderAreas.length, kind: 'plaza', minX: curb.minX + 4, maxX: curb.maxX - 4, minZ: curb.minZ + 1.5, maxZ: curb.minZ + 6, y: py });
  for (let k = 0; k < 6; k++) city.groupSpots.push({ x: curb.minX + 30 + k * 85, y: py, z: curb.minZ + 4 });

  // building lots (colliders, minimap, plane crashes)
  const lot = (x: number, z: number, w: number, d: number, h: number, style: number) =>
    city.buildings.push({ id: city.buildings.length, x, z, w, d, h, yaw: 0, y: E, district: 'hub', style, chunk: chunkOf(x, z) });
  lot(tcx, tcz, T.x1 - T.x0, T.z1 - T.z0, 15.2, 1);
  lot(tcx, tcz + 2, 80, 40, 24.5, 0);
  lot(twx, twz, 12, 12, 42.5, 1);
  for (const hx of [-2590, -2720]) lot(hx, -55, 100, 90, 18, 5);

  m.data = {
    runways: [
      { id: 'main', a: { x: rx1, y: E + 0.03, z: rz }, b: { x: rx0, y: E + 0.03, z: rz }, width: rw, designatorA: '27', designatorB: '09' },
      { id: 'crosswind', a: { x: cA[0], y: E + 0.03, z: cA[1] }, b: { x: cB[0], y: E + 0.03, z: cB[1] }, width: cw, designatorA: '07', designatorB: '25' },
    ],
    stands,
    carPark: { position: { x: -1650, y: E + 0.02, z: -20 }, yaw: -Math.PI / 2 },
    terminal: { x: tcx, y: E, z: tcz },
    tower: { x: twx, y: E, z: twz },
    bounds: { minX: AB.minX, maxX: AB.maxX, minZ: AB.minZ, maxZ: AB.maxZ },
    elevation: E,
  };
  city.exits = city.exits ?? [];
  city.exits.push({ node: nExit, dir: { x: 1, y: 0, z: 0 }, tag: 'airport' });
  return m;
}
