/**
 * Air-defence TURRETS (user request): a pedestal turret with a launcher box of 2 missiles side by side, 4 in a square
 * or 8 in a 4×2 block — up in the mountains only. Tube positions are in the RACK frame (rack faces +Z, origin at the
 * pitch pivot).
 */
export type LauncherKind = 'duo' | 'quad' | 'octo' | 'nuke';
export type Warhead = 'big' | 'medium' | 'small' | 'nuke';

export interface LauncherType {
  kind: LauncherKind;
  name: string;
  /** S fires one; ALL fires every ready tube (octo: the salvo, SPREAD = different spots). */
  salvo: 'single' | 'batch';
  warhead: Warhead;
  /** Fireball radius (m) of one missile. */
  blast: number;
  /** Top speed (m/s) and boost time to reach it (s). */
  speed: number;
  boost: number;
  missileLen: number;
  missileR: number;
  /** Seconds to reload one tube. */
  reload: number;
  tubes: [number, number][]; // rack-frame (x, y) of each tube
  box: [number, number]; // launcher box half width / half height
  body: number; // pedestal / head colour
  rack: number; // launcher box colour
  missile: number; // missile body colour
  tip: number; // nose / band colour
  blurb: string;
}

const grid = (cols: number, rows: number, dx: number, dy: number): [number, number][] => {
  const out: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([(c - (cols - 1) / 2) * dx, ((rows - 1) / 2 - r) * dy]);
  return out;
};

export const LAUNCHER_TYPES: Record<LauncherKind, LauncherType> = {
  duo: {
    kind: 'duo', name: 'Twin turret', salvo: 'single', warhead: 'big', blast: 26, speed: 450, boost: 2.2,
    missileLen: 6.4, missileR: 0.42, reload: 35, tubes: grid(2, 1, 1.25, 0), box: [1.35, 0.7],
    body: 0x6b7058, rack: 0x7d8466, missile: 0xeceee6, tip: 0xc8423a,
    blurb: '2 big missiles side by side — S fires one, ALL fires both',
  },
  quad: {
    kind: 'quad', name: 'Quad turret', salvo: 'single', warhead: 'medium', blast: 16, speed: 520, boost: 1.9,
    missileLen: 4.6, missileR: 0.3, reload: 22, tubes: grid(2, 2, 0.85, 0.85), box: [0.95, 0.95],
    body: 0x707262, rack: 0x8b8d78, missile: 0xf1f2ee, tip: 0x2f3e66,
    blurb: '4 missiles in a square — S fires one, ALL fires all four',
  },
  octo: {
    kind: 'octo', name: 'Octo turret', salvo: 'batch', warhead: 'small', blast: 9, speed: 600, boost: 1.4,
    missileLen: 2.8, missileR: 0.16, reload: 12, tubes: grid(4, 2, 0.5, 0.5), box: [1.15, 0.6],
    body: 0x5a6266, rack: 0x707c82, missile: 0xf4f1e8, tip: 0xffb000,
    blurb: '8 small missiles (4×2) — S fires one, ALL the salvo, SPREAD = different spots',
  },
  nuke: {
    kind: 'nuke', name: 'Nuke turret', salvo: 'single', warhead: 'nuke', blast: 240, speed: 380, boost: 3,
    missileLen: 7, missileR: 0.5, reload: 120, tubes: grid(2, 1, 1.4, 0), box: [1.5, 0.78],
    body: 0x55524c, rack: 0x3f3d39, missile: 0xf3f0e6, tip: 0xffd23f,
    blurb: '2 NUKES side by side — everything flying around the target goes',
  },
};

/** Where the turrets stand: ABSOLUTE spots in the mountains north and east of the city. */
export interface LauncherSite {
  id: string;
  name: string;
  kind: LauncherKind;
  at: { x: number; z: number };
  yaw: number;
}

export const LAUNCHER_SITES: LauncherSite[] = [
  { id: 'aa-ridge', name: 'Ridge', kind: 'duo', at: { x: 2400, z: -6300 }, yaw: Math.PI },
  { id: 'aa-pass', name: 'Pass', kind: 'quad', at: { x: 900, z: -4200 }, yaw: Math.PI },
  { id: 'aa-peak', name: 'Peak', kind: 'octo', at: { x: 4300, z: -5200 }, yaw: Math.PI },
  { id: 'aa-east', name: 'East Hills', kind: 'quad', at: { x: 5600, z: -2600 }, yaw: -Math.PI / 2 },
  { id: 'aa-west', name: 'West Crag', kind: 'octo', at: { x: -900, z: -5200 }, yaw: Math.PI },
  { id: 'aa-doom', name: 'Doom Summit', kind: 'nuke', at: { x: -1300, z: -7400 }, yaw: Math.PI },
];
