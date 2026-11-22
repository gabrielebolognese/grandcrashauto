import { Rng } from '../../core/rng';
import type { BuildingLot, DistrictId } from '../types';
import { Facade, type BoxPart, type Island, type RoofPart, type TankPart, type Decal, Mat } from './model';
import { HUB, ISLAND_TOP } from './layout';

/** Building lots + instanced render parts per block (pure data). */

export const WALL_PASTEL = [0xff9e8f, 0xffc4a0, 0xf5dfb5, 0xb5ead6, 0x9fdbe3, 0xcdbff0, 0xffe7a6, 0xfff4e0, 0xf7c6d4, 0xf2efe8, 0xbfe3f2, 0xffd3b0];
export const WALL_DECO = [0xf3e6d3, 0xe9d8c4, 0xf6efe6, 0xd9e6e8, 0xf1d7c8, 0xe2dcef, 0xf4e1c1, 0xe6efe0, 0xf7d9cf, 0xdfe9f2];
export const GLASS = [0x4a8fa8, 0x5b86b5, 0x4c9a8e, 0x6f8fa6, 0x3f7a99, 0x587f9e];
export const ACCENT = [0xff7a6b, 0x5cc8d6, 0xffd166, 0x9ee0c8, 0xb8a6e8, 0xf28cb1, 0x4f9a5a, 0x2aa3c4, 0xff9a5c];
export const ROOFS = [0xd9774f, 0xc8644a, 0x4fa3a5, 0x7d8495, 0xb5564a, 0x6a9a8a, 0xe08e5e];
const TRIM = [0xffffff, 0xf6f1ea, 0xfff4e0, 0xe8e2d8];

export interface BuildingOut {
  lots: BuildingLot[];
  parts: BoxPart[];
  roofs: RoofPart[];
  tanks: TankPart[];
  decals: Decal[];
  /** Back-yard / courtyard free spots for trees (x,z). */
  yardSpots: number[];
}

interface Ctx {
  out: BuildingOut;
  rng: Rng;
  district: DistrictId;
  chunkOf: (x: number, z: number) => number;
  blocked: (x0: number, x1: number, z0: number, z1: number) => boolean;
  y: number;
}

/** Local building frame → world. */
function toWorld(bx: number, bz: number, yaw: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [bx + lx * c + lz * s, bz - lx * s + lz * c];
}

function part(ctx: Ctx, bx: number, bz: number, yaw: number, lx: number, lz: number, y: number, w: number, h: number, d: number, style: number, color: number, accent: number, seed: number, floorH: number, baseOff: number, groundH: number, lit: number, tower = false): void {
  const [cx, cz] = toWorld(bx, bz, yaw, lx, lz);
  ctx.out.parts.push({ cx, cz, y, w, h, d, yaw, style, color, accent, seed, floorH, baseOff, groundH, lit, tower });
}

function lot(ctx: Ctx, x: number, z: number, w: number, d: number, h: number, yaw: number, style: number): void {
  ctx.out.lots.push({ id: ctx.out.lots.length, x, z, w, d, h, yaw, y: ctx.y, district: ctx.district, style, chunk: ctx.chunkOf(x, z) });
}

function rooftop(ctx: Ctx, bx: number, bz: number, yaw: number, w: number, d: number, top: number, tanks: boolean): void {
  const { rng } = ctx;
  const n = Math.min(4, Math.floor((w * d) / 140));
  for (let i = 0; i < n; i++) {
    const lx = rng.range(-w / 2 + 2, w / 2 - 2), lz = rng.range(-d / 2 + 2, d / 2 - 2);
    part(ctx, bx, bz, yaw, lx, lz, top, rng.range(1.4, 2.6), rng.range(0.9, 1.5), rng.range(1.2, 2.2), Facade.Solid, 0xc9c6c0, 0x9a9790, rng.next(), 3, 0, 0, 0);
  }
  if (tanks && w > 8 && d > 8 && rng.chance(0.45)) {
    const lx = rng.range(-w / 2 + 2.5, w / 2 - 2.5), lz = rng.range(-d / 2 + 2.5, d / 2 - 2.5);
    const [cx, cz] = toWorld(bx, bz, yaw, lx, lz);
    ctx.out.tanks.push({ cx, cz, y: top, r: rng.range(1.3, 1.9), h: rng.range(2.4, 3.4), color: rng.pick([0x9b7b5e, 0x8a6f58, 0xb0a596, 0x7f8c8d]) });
  }
}

// ───────────────────────── building types ─────────────────────────

function decoTower(ctx: Ctx, x0: number, x1: number, z0: number, z1: number, h: number): void {
  const { rng } = ctx;
  const w = x1 - x0, d = z1 - z0, bx = (x0 + x1) / 2, bz = (z0 + z1) / 2;
  const y = ctx.y;
  const wall = rng.pick(WALL_DECO);
  const acc = rng.pick(ACCENT);
  const trim = rng.pick(TRIM);
  const seed = rng.next();
  const lit = rng.range(0.35, 0.65);
  const groundH = 5;
  const hp = Math.min(h * 0.3, groundH + 3.6 * rng.int(1, 3));
  part(ctx, bx, bz, 0, 0, 0, y, w, hp, d, Facade.Shop, wall, acc, seed, 3.6, 0, groundH, lit);
  const s1 = rng.range(2, 3.5);
  let sw = w - 2 * s1, sd = d - 2 * s1;
  const h1 = hp + (h - hp) * rng.range(0.72, 0.84);
  part(ctx, bx, bz, 0, 0, 0, y + hp, sw, h1 - hp, sd, Facade.Deco, wall, trim, seed, 3.6, hp, 0, lit, true);
  // vertical fins on the two long faces
  const finC = trim;
  const longX = sw >= sd;
  for (const sgn of [-1, 1]) {
    for (const f of [-0.2, 0.2]) {
      if (longX) part(ctx, bx, bz, 0, f * sw, sgn * (sd / 2 + 0.3), y + hp, 0.6, h1 - hp + 1.5, 0.6, Facade.Solid, finC, finC, seed, 3.6, hp, 0, 0, true);
      else part(ctx, bx, bz, 0, sgn * (sw / 2 + 0.3), f * sd, y + hp, 0.6, h1 - hp + 1.5, 0.6, Facade.Solid, finC, finC, seed, 3.6, hp, 0, 0, true);
    }
  }
  let cur = h1;
  if (sw > 12 && sd > 12) {
    const s2 = rng.range(2, 3.2);
    sw -= 2 * s2;
    sd -= 2 * s2;
    const h2 = h1 + (h - h1) * 0.6;
    part(ctx, bx, bz, 0, 0, 0, y + h1, sw, h2 - h1, sd, Facade.Deco, wall, trim, seed + 0.31, 3.6, h1, 0, lit, true);
    cur = h2;
    if (sw > 8 && sd > 8) {
      sw -= 4;
      sd -= 4;
      part(ctx, bx, bz, 0, 0, 0, y + h2, sw, h - h2, sd, Facade.Solid, trim, acc, seed, 3.6, h2, 0, 0, true);
      cur = h;
    }
  }
  if (rng.chance(0.55)) part(ctx, bx, bz, 0, 0, 0, y + cur, 0.9, rng.range(6, 14), 0.9, Facade.Solid, 0xdedad2, acc, seed, 3, 0, 0, 0, true);
  else part(ctx, bx, bz, 0, 0, 0, y + cur, Math.max(2, sw * 0.4), 2.4, Math.max(2, sd * 0.4), Facade.Solid, acc, acc, seed, 3, 0, 0, 0, true);
  rooftop(ctx, bx, bz + (d / 2 - 3), 0, Math.max(4, w - 4), 4, y + hp, false);
  lot(ctx, bx, bz, w, d, h, 0, 0);
}

function glassTower(ctx: Ctx, x0: number, x1: number, z0: number, z1: number, h: number): void {
  const { rng } = ctx;
  const w = x1 - x0, d = z1 - z0, bx = (x0 + x1) / 2, bz = (z0 + z1) / 2;
  const y = ctx.y;
  const wall = rng.pick(WALL_DECO);
  const glass = rng.pick(GLASS);
  const acc = rng.pick(ACCENT);
  const seed = rng.next();
  const lit = rng.range(0.4, 0.7);
  const hp = 5 + 3.6 * rng.int(0, 2);
  part(ctx, bx, bz, 0, 0, 0, y, w, hp, d, Facade.Shop, wall, acc, seed, 3.6, 0, 5, lit);
  const s = rng.range(2.2, 3.5);
  const gw = w - 2 * s, gd = d - 2 * s;
  if (rng.chance(0.4) && gw > 18) {
    // two volumes, staggered heights
    const split = rng.range(0.45, 0.6);
    const wa = gw * split, wb = gw - wa;
    const ha = h, hb = hp + (h - hp) * rng.range(0.6, 0.8);
    part(ctx, bx, bz, 0, -gw / 2 + wa / 2, 0, y + hp, wa, ha - hp, gd, Facade.Glass, glass, acc, seed, 3.6, hp, 0, lit, true);
    part(ctx, bx, bz, 0, gw / 2 - wb / 2, 0, y + hp, wb, hb - hp, gd * 0.85, Facade.Glass, glass, acc, seed + 0.5, 3.6, hp, 0, lit, true);
    part(ctx, bx, bz, 0, -gw / 2 + wa / 2, 0, y + ha, wa * 0.55, 4, gd * 0.55, Facade.Solid, 0xd0d4d6, acc, seed, 3, 0, 0, 0, true);
  } else {
    part(ctx, bx, bz, 0, 0, 0, y + hp, gw, h - hp, gd, Facade.Glass, glass, acc, seed, 3.6, hp, 0, lit, true);
    part(ctx, bx, bz, 0, 0, 0, y + h, gw * 0.5, 4.5, gd * 0.5, Facade.Solid, 0xd0d4d6, acc, seed, 3, 0, 0, 0, true);
    if (rng.chance(0.3)) part(ctx, bx, bz, 0, gw * 0.15, 0, y + h + 4.5, 0.5, rng.range(8, 16), 0.5, Facade.Solid, 0xe8e8e8, acc, seed, 3, 0, 0, 0, true);
  }
  rooftop(ctx, bx, bz - (d / 2 - 2), 0, Math.max(4, w - 4), 3, y + hp, false);
  lot(ctx, bx, bz, w, d, h, 0, 1);
}

interface FrontageOpts {
  setback: number;
  dmin: number;
  dmax: number;
  wmin: number;
  wmax: number;
  gmin: number;
  gmax: number;
  make: (bx: number, bz: number, yaw: number, w: number, d: number, sideIndex: number) => void;
}

/** Lay buildings along the 4 sides of an interior rect, fronts facing outward (local +z = street). */
function frontage(ctx: Ctx, x0: number, x1: number, z0: number, z1: number, o: FrontageOpts, sides = [0, 1, 2, 3]): void {
  const { rng } = ctx;
  const W = x1 - x0, D = z1 - z0;
  let dmax = Math.min(o.dmax, (D - o.setback * 2) / 2 - 1);
  const dmin = Math.min(o.dmin, dmax);
  if (dmax < 6) return;
  const reserveNS = o.setback + dmax + Math.max(1, o.gmin);
  const run = (k: number, a: number, b: number) => {
    let t = a;
    while (b - t >= o.wmin) {
      let w = rng.range(o.wmin, o.wmax);
      if (b - t - w < o.wmin + o.gmin) w = b - t; // fill the remainder
      w = Math.min(w, b - t);
      const d = rng.range(dmin, dmax);
      let bx = 0, bz = 0, yaw = 0;
      const mid = t + w / 2;
      if (k === 0) [bx, bz, yaw] = [mid, z0 + o.setback + d / 2, Math.PI];
      else if (k === 2) [bx, bz, yaw] = [mid, z1 - o.setback - d / 2, 0];
      else if (k === 1) [bx, bz, yaw] = [x1 - o.setback - d / 2, mid, Math.PI / 2];
      else [bx, bz, yaw] = [x0 + o.setback + d / 2, mid, -Math.PI / 2];
      const hx = k === 0 || k === 2 ? w / 2 : d / 2, hz = k === 0 || k === 2 ? d / 2 : w / 2;
      if (!ctx.blocked(bx - hx, bx + hx, bz - hz, bz + hz)) o.make(bx, bz, yaw, w, d, k);
      t += w + rng.range(o.gmin, o.gmax);
    }
  };
  if (sides.includes(0)) run(0, x0, x1);
  if (sides.includes(2)) run(2, x0, x1);
  if (W > 2 * reserveNS + 4) {
    void W;
  }
  if (D > 2 * reserveNS + o.wmin) {
    if (sides.includes(1)) run(1, z0 + reserveNS, z1 - reserveNS);
    if (sides.includes(3)) run(3, z0 + reserveNS, z1 - reserveNS);
  }
}

function house(ctx: Ctx, bx: number, bz: number, yaw: number, w: number, d: number): void {
  const { rng } = ctx;
  const floors = rng.chance(0.55) ? 1 : 2;
  const fh = 3.3;
  const h = 0.5 + floors * fh;
  const wall = rng.pick(WALL_PASTEL);
  const acc = rng.pick(ACCENT);
  const seed = rng.next();
  part(ctx, bx, bz, yaw, 0, 0, ctx.y, w, h, d, Facade.House, wall, acc, seed, fh, 0, 0, rng.range(0.3, 0.7));
  let top = h;
  if (rng.chance(0.58)) {
    const rh = rng.range(2.0, 3.0);
    ctx.out.roofs.push({ cx: bx, cz: bz, y: ctx.y + h, w: w + 0.6, d: d + 0.6, h: rh, yaw, color: rng.pick(ROOFS) });
    top += rh;
  } else {
    // flat deco roof: parapet cap + small stair box
    part(ctx, bx, bz, yaw, 0, 0, ctx.y + h, w + 0.3, 0.45, d + 0.3, Facade.Solid, rng.pick(TRIM), acc, seed, 3, 0, 0, 0);
    if (rng.chance(0.5)) part(ctx, bx, bz, yaw, rng.range(-w / 4, w / 4), -d / 4, ctx.y + h + 0.45, 2.6, 2.2, 2.6, Facade.Solid, wall, acc, seed, 3, 0, 0, 0);
  }
  // porch canopy over the door (front)
  part(ctx, bx, bz, yaw, 0, d / 2 + 0.6, ctx.y + 2.5, Math.min(3.2, w * 0.4), 0.18, 1.2, Facade.Solid, rng.pick(TRIM), acc, seed, 3, 0, 0, 0);
  // pool in the back yard sometimes
  if (rng.chance(0.22)) {
    const [px, pz] = toWorld(bx, bz, yaw, rng.range(-w / 4, w / 4), -d / 2 - 4.5);
    const dirx = Math.cos(yaw), dirz = -Math.sin(yaw);
    ctx.out.decals.push({ cx: px, cz: pz, dx: dirx, dz: dirz, hl: 2.6, hw: 1.6, y: ctx.y + 0.035, col: 0x45c3d9, mat: Mat.Water });
    ctx.out.decals.push({ cx: px, cz: pz, dx: dirx, dz: dirz, hl: 3.2, hw: 2.2, y: ctx.y + 0.03, col: 0xe8e2d6, mat: Mat.Concrete });
  }
  const [yx, yz] = toWorld(bx, bz, yaw, rng.range(-w / 3, w / 3), -d / 2 - 3.5);
  ctx.out.yardSpots.push(yx, yz);
  lot(ctx, bx, bz, yaw === 0 || Math.abs(yaw) === Math.PI ? w : w, d, top, yaw, 4);
}

function apartment(ctx: Ctx, bx: number, bz: number, yaw: number, w: number, d: number, floorsMin: number, floorsMax: number, style: number): void {
  const { rng } = ctx;
  const floors = rng.int(floorsMin, floorsMax);
  const fh = 3.3;
  const groundH = style === Facade.Shop ? 4.4 : 0;
  const h = groundH + floors * fh + (groundH ? 0 : 0.6);
  const wall = rng.pick(style === Facade.Shop ? WALL_PASTEL : WALL_DECO.concat(WALL_PASTEL));
  const acc = rng.pick(ACCENT);
  const seed = rng.next();
  const lit = rng.range(0.35, 0.7);
  part(ctx, bx, bz, yaw, 0, 0, ctx.y, w, h, d, style, wall, acc, seed, fh, 0, groundH, lit);
  // parapet
  part(ctx, bx, bz, yaw, 0, 0, ctx.y + h, w + 0.25, 0.7, d + 0.25, Facade.Solid, rng.pick(TRIM), acc, seed, 3, 0, 0, 0);
  if (style === Facade.Shop) {
    // awning over the storefront (tilted thin box handled as a flat slab with stripes)
    part(ctx, bx, bz, yaw, 0, d / 2 + 0.9, ctx.y + 3.1, w * 0.86, 0.22, 1.8, Facade.Awning, acc, 0xffffff, seed, 3, 0, 0, 0);
  }
  if (rng.chance(0.35) && h > 9) {
    // deco stepped centre bay on the front
    part(ctx, bx, bz, yaw, 0, d / 2 + 0.35, ctx.y + groundH, Math.min(5, w * 0.3), h - groundH + 2.2, 0.7, Facade.Solid, rng.pick(TRIM), acc, seed, 3, 0, 0, 0);
  }
  rooftop(ctx, bx, bz, yaw, w, d, ctx.y + h + 0.0, true);
  lot(ctx, bx, bz, w, d, h + 0.7, yaw, style === Facade.Shop ? 3 : 5);
}

function hotel(ctx: Ctx, bx: number, bz: number, yaw: number, w: number, d: number): void {
  const { rng } = ctx;
  const floors = rng.int(4, 8);
  const fh = 3.3;
  const groundH = 5;
  const h = groundH + floors * fh;
  const wall = rng.pick(WALL_PASTEL);
  const acc = rng.pick(ACCENT);
  const trim = rng.pick(TRIM);
  const seed = rng.next();
  const lit = rng.range(0.45, 0.8);
  part(ctx, bx, bz, yaw, 0, 0, ctx.y, w, h, d, Facade.Hotel, wall, acc, seed, fh, 0, groundH, lit);
  // stepped central bay / tower with crown
  const bw = Math.min(8, w * 0.3);
  const bh = h + rng.range(3, 7);
  part(ctx, bx, bz, yaw, 0, d / 2 - 2.5, ctx.y, bw, bh, 6, Facade.Solid, trim, acc, seed, fh, 0, 0, 0);
  part(ctx, bx, bz, yaw, 0, d / 2 - 2.5, ctx.y + bh, bw * 0.6, 2.2, 4, Facade.Solid, acc, acc, seed, fh, 0, 0, 0);
  // vertical neon sign fin on the bay
  part(ctx, bx, bz, yaw, 0, d / 2 + 1.0, ctx.y + groundH + 1, 0.35, Math.min(h * 0.62, 16), 1.6, Facade.Neon, acc, acc, seed, fh, 0, 0, 0);
  // corner eyebrows / parapet
  part(ctx, bx, bz, yaw, 0, 0, ctx.y + h, w + 0.3, 0.8, d + 0.3, Facade.Solid, trim, acc, seed, 3, 0, 0, 0);
  // entrance canopy
  part(ctx, bx, bz, yaw, 0, d / 2 + 1.4, ctx.y + 3.4, bw + 3, 0.3, 2.8, Facade.Solid, acc, acc, seed, 3, 0, 0, 0);
  rooftop(ctx, bx, bz - d / 4, yaw, w * 0.6, d * 0.4, ctx.y + h, true);
  lot(ctx, bx, bz, w, d, bh + 2.2, yaw, 6);
}

// ───────────────────────── block dispatch ─────────────────────────

export function genBlockBuildings(isl: Island, seed: number, out: BuildingOut, chunkOf: (x: number, z: number) => number, blocked: Ctx['blocked']): void {
  const rng = Rng.from(seed, 0xb17d, isl.id);
  const ctx: Ctx = { out, rng, district: isl.district, chunkOf, blocked, y: isl.top };
  const [sn, se, ss, sw] = isl.sw;
  const x0 = isl.minX + sw, x1 = isl.maxX - se, z0 = isl.minZ + sn, z1 = isl.maxZ - ss;
  const W = x1 - x0, D = z1 - z0;
  switch (isl.block) {
    case 'tower': {
      const cxB = (x0 + x1) / 2, czB = (z0 + z1) / 2;
      const dist = Math.hypot(cxB, czB + 80);
      const hMax = Math.max(26, 100 - dist * 0.42);
      const lots: [number, number, number, number][] = [];
      const alley = 3;
      if (W > 34 && D > 34 && rng.chance(0.65)) {
        if (W >= D) {
          const s = x0 + W * rng.range(0.4, 0.6);
          lots.push([x0, s - alley / 2, z0, z1], [s + alley / 2, x1, z0, z1]);
        } else {
          const s = z0 + D * rng.range(0.4, 0.6);
          lots.push([x0, x1, z0, s - alley / 2], [x0, x1, s + alley / 2, z1]);
        }
        // maybe split one again
        const k = rng.int(0, 1);
        const L = lots[k];
        const lw = L[1] - L[0], ld = L[3] - L[2];
        if (Math.max(lw, ld) > 32 && rng.chance(0.45)) {
          lots.splice(k, 1);
          if (lw >= ld) {
            const s = L[0] + lw * rng.range(0.42, 0.58);
            lots.push([L[0], s - alley / 2, L[2], L[3]], [s + alley / 2, L[1], L[2], L[3]]);
          } else {
            const s = L[2] + ld * rng.range(0.42, 0.58);
            lots.push([L[0], L[1], L[2], s - alley / 2], [L[0], L[1], s + alley / 2, L[3]]);
          }
        }
      } else lots.push([x0, x1, z0, z1]);
      for (const L of lots) {
        let h = Math.max(22, hMax * rng.range(0.55, 1.0));
        if (rng.chance(0.12)) h *= 1.22;
        const lw = L[1] - L[0], ld = L[3] - L[2];
        if (blocked(L[0], L[1], L[2], L[3])) continue;
        if (lw < 14 || ld < 14) apartment(ctx, (L[0] + L[1]) / 2, (L[2] + L[3]) / 2, 0, lw, ld, 4, 7, Facade.Shop);
        else if (rng.chance(0.42)) glassTower(ctx, L[0], L[1], L[2], L[3], h);
        else decoTower(ctx, L[0], L[1], L[2], L[3], h);
      }
      break;
    }
    case 'midrise':
      frontage(ctx, x0, x1, z0, z1, {
        setback: 0, dmin: 14, dmax: 20, wmin: 16, wmax: 28, gmin: 0, gmax: 3,
        make: (bx, bz, yaw, w, d) => apartment(ctx, bx, bz, yaw, w, d, 3, 8, rng.chance(0.45) ? Facade.Shop : Facade.Apartment),
      });
      break;
    case 'mixed':
      frontage(ctx, x0, x1, z0, z1, {
        setback: 0, dmin: 11, dmax: 16, wmin: 9, wmax: 18, gmin: 0, gmax: 1.5,
        make: (bx, bz, yaw, w, d) => apartment(ctx, bx, bz, yaw, w, d, 1, 4, Facade.Shop),
      });
      break;
    case 'house':
      frontage(ctx, x0, x1, z0, z1, {
        setback: 4, dmin: 9, dmax: 12, wmin: 8.5, wmax: 12.5, gmin: 3, gmax: 5.5,
        make: (bx, bz, yaw, w, d) => {
          if (rng.chance(0.1) && w > 11) apartment(ctx, bx, bz, yaw, w + 4, d + 2, 2, 4, Facade.Apartment);
          else house(ctx, bx, bz, yaw, w, d);
        },
      });
      break;
    case 'hotel':
      // beach-facing hotels on the south side, lower annexes elsewhere
      frontage(ctx, x0, x1, z0, z1, {
        setback: 0, dmin: 16, dmax: 21, wmin: 20, wmax: 32, gmin: 3, gmax: 6,
        make: (bx, bz, yaw, w, d) => hotel(ctx, bx, bz, yaw, w, d),
      }, [2]);
      frontage(ctx, x0, x1, z0, z1, {
        setback: 0, dmin: 10, dmax: 14, wmin: 12, wmax: 22, gmin: 2, gmax: 5,
        make: (bx, bz, yaw, w, d) => apartment(ctx, bx, bz, yaw, w, d, 1, 3, rng.chance(0.5) ? Facade.Shop : Facade.Apartment),
      }, [0]);
      break;
    case 'hub': {
      const G = HUB.garage;
      const gx = (G.x0 + G.x1) / 2, gz = (G.z0 + G.z1) / 2;
      const gw = G.z1 - G.z0, gd = G.x1 - G.x0; // local w along world z (yaw π/2)
      const seed2 = rng.next();
      part(ctx, gx, gz, Math.PI / 2, 0, 0, ISLAND_TOP, gw, G.h, gd, Facade.Garage, 0xfff4e0, 0xff7a6b, seed2, 5.5, 0, 0, 0.6);
      // deco crown + sign tower
      part(ctx, gx, gz, Math.PI / 2, 0, 0, ISLAND_TOP + G.h, gw + 0.4, 0.9, gd + 0.4, Facade.Solid, 0x5cc8d6, 0x5cc8d6, seed2, 3, 0, 0, 0);
      part(ctx, gx, gz, Math.PI / 2, 0, gd / 2 - 3, ISLAND_TOP, 6, G.h + 7, 4, Facade.Solid, 0xff7a6b, 0xffd166, seed2, 3, 0, 0, 0);
      part(ctx, gx, gz, Math.PI / 2, 0, gd / 2 - 0.7, ISLAND_TOP + 6, 0.5, G.h - 3, 1.6, Facade.Neon, 0xffd166, 0xffd166, seed2, 3, 0, 0, 0);
      lot(ctx, gx, gz, gw, gd, G.h + 7, Math.PI / 2, 7);
      break;
    }
    default:
      break;
  }
}
