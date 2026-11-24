/**
 * Air-defence systems (user request: different launchers in the city and in the mountains, each one custom).
 * Tube positions are in the RACK frame (rack faces +Z, origin at the pivot); the silo's single tube is vertical.
 */
export type LauncherKind = 'titan' | 'lancer' | 'hornet' | 'pike' | 'doom';
export type Warhead = 'big' | 'medium' | 'small' | 'nuke';

export interface LauncherType {
  kind: LauncherKind;
  name: string;
  /** How S / ALL fire: single = one per S, ALL = every tube; pairs = two per S; batch = one per S, ALL = salvo. */
  salvo: 'single' | 'pairs' | 'batch' | 'one';
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
  tubes: [number, number, number][]; // rack-frame tube mouths
  body: number; // vehicle / pad colour
  rack: number; // rack colour
  missile: number; // missile body colour
  tip: number; // nose / band colour
  blurb: string;
}

const grid = (cols: number, rows: number, dx: number, dy: number, z: number): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([(c - (cols - 1) / 2) * dx, (r - (rows - 1) / 2) * dy, z]);
  return out;
};

export const LAUNCHER_TYPES: Record<LauncherKind, LauncherType> = {
  titan: {
    kind: 'titan', name: 'Twin Titan', salvo: 'single', warhead: 'big', blast: 28, speed: 430, boost: 2.6,
    missileLen: 9, missileR: 0.48, reload: 40, tubes: grid(2, 1, 1.9, 0, 4.6),
    body: 0x56604a, rack: 0x6c7656, missile: 0xe9ebe4, tip: 0xc8423a,
    blurb: '2 huge missiles — fire one (S) or both (ALL)',
  },
  lancer: {
    kind: 'lancer', name: 'Quad Lancer', salvo: 'single', warhead: 'medium', blast: 16, speed: 520, boost: 2.1,
    missileLen: 5.6, missileR: 0.3, reload: 25, tubes: grid(2, 2, 1.1, 1.0, 3),
    body: 0x6f6a58, rack: 0x8a8670, missile: 0xf1f2ee, tip: 0x2f3e66,
    blurb: '4 medium missiles, one per S',
  },
  hornet: {
    kind: 'hornet', name: 'Hornet Swarm', salvo: 'batch', warhead: 'small', blast: 8, speed: 620, boost: 1.5,
    missileLen: 2.6, missileR: 0.15, reload: 12, tubes: grid(4, 2, 0.52, 0.52, 1.5),
    body: 0x4f5a62, rack: 0x6c7880, missile: 0xf4f1e8, tip: 0xffb000,
    blurb: '8 small missiles — S fires one, ALL fires the salvo; SPREAD hits different spots',
  },
  pike: {
    kind: 'pike', name: 'Hexa Pike', salvo: 'pairs', warhead: 'medium', blast: 12, speed: 560, boost: 1.8,
    missileLen: 4.2, missileR: 0.24, reload: 18, tubes: grid(3, 2, 0.8, 0.8, 2.4),
    body: 0x7a6e52, rack: 0x968a6a, missile: 0xeceae2, tip: 0x2a9d8f,
    blurb: '6 missiles fired in pairs (S = 2)',
  },
  doom: {
    kind: 'doom', name: 'Doomsday Silo', salvo: 'one', warhead: 'nuke', blast: 260, speed: 360, boost: 4,
    missileLen: 14, missileR: 0.95, reload: 150, tubes: [[0, 0, 0]],
    body: 0x8d8a82, rack: 0x5c5a55, missile: 0xf3f0e6, tip: 0xffd23f,
    blurb: '1 NUKE — the whole sky around the target goes',
  },
};

/** Where the systems stand: next to city places (offsets from a POI) or at ABSOLUTE spots in the mountains. */
export interface LauncherSite {
  id: string;
  name: string;
  kind: LauncherKind;
  near?: { poi: string; dx: number; dz: number };
  at?: { x: number; z: number };
  yaw: number;
}

export const LAUNCHER_SITES: LauncherSite[] = [
  { id: 'sam-park', name: 'Park Air Defence', kind: 'lancer', near: { poi: 'park', dx: 22, dz: 18 }, yaw: Math.PI },
  { id: 'sam-beach', name: 'Beach Swarm', kind: 'hornet', near: { poi: 'beach', dx: 60, dz: 6 }, yaw: Math.PI },
  { id: 'sam-airport', name: 'Airport Pike', kind: 'pike', near: { poi: 'airport', dx: -30, dz: 26 }, yaw: Math.PI / 2 },
  { id: 'sam-ridge', name: 'Ridge Titans', kind: 'titan', at: { x: 2400, z: -6300 }, yaw: 0 },
  { id: 'sam-peak', name: 'Peak Swarm', kind: 'hornet', at: { x: 4300, z: -5200 }, yaw: -Math.PI / 4 },
  { id: 'sam-pass', name: 'Pass Lancer', kind: 'lancer', at: { x: 900, z: -4200 }, yaw: Math.PI / 6 },
  { id: 'silo-north', name: 'Doomsday Silo', kind: 'doom', at: { x: -1300, z: -7400 }, yaw: 0 },
];
