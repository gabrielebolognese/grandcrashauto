import * as THREE from 'three';
import type { PlaneTypeId } from '../types';
import { curve, plin, rgb, type Curve, type RGB, v3 } from './builder';
import type { FusLivery, FusProfile, FusRect } from './fuselage';
import type { GearDef } from './gear';
import type { WindowLayout } from './material';
import { atlasRegion } from './atlas';

/**
 * The four original planes, as data. Design frame: nose +Z, LEFT wing +X, y up; the assembler moves the origin to
 * the centre of mass afterwards. Lengths in metres.
 */

export interface WingDef {
  x0: number; // root station (inside the fuselage)
  x1: number; // tip
  le: Curve; // x → z of the leading edge
  chord: Curve;
  y: Curve; // x → height of the chord line (dihedral)
  thick: Curve;
  camber: number;
  breaks: number[]; // segment boundaries (x)
  extraX?: number[];
  flaps: { x0: number; x1: number; uh: number }[];
  aileron: { x0: number; x1: number; uh: number } | null;
  winglet?: { h: number; cant: number; sweep: number; tipChord: number };
  tipColor?: RGB;
}

export interface FinDef {
  y0: number;
  y1: number;
  le: Curve; // y → z
  chord: Curve;
  thick: number;
  rudder: { y0: number; y1: number; uh: number };
}

export interface FanDef {
  kind: 'fan';
  front: THREE.Vector3; // intake lip centre (left engines; right ones mirrored by the list)
  length: number;
  rMax: number;
  rLip: number;
  rFan: number;
  blades: number;
  mount: string;
  pylon: 'wing' | 'side';
  pylonTop?: number; // wing underside y at the pylon (wing pylons)
  pylonBack?: number; // z where the pylon meets the wing trailing area
}

export interface PropDef {
  kind: 'prop';
  front: THREE.Vector3; // prop disc centre
  spinnerR: number;
  spinnerLen: number;
  bladeLen: number;
  bladeChord: number;
  blades: number;
  mount: string;
}

export interface CockpitDef {
  eye: THREE.Vector3;
  dashZ: number; // face of the instrument panel
  dashTop: number; // glareshield top
  floorY: number;
  zFront: number; // forward closure of the cockpit shell
  seatX: number;
  glass: boolean; // glass cockpit (jets) vs analogue gauges (prop)
  panelW: number; // instrument face width
}

export interface Design {
  type: PlaneTypeId;
  name: string;
  livery: string;
  description: string;
  length: number;
  span: number;
  height: number;
  profile: FusProfile;
  liv: FusLivery;
  cuts: [number, number, number, number, number];
  ring: [number, number, number];
  step: [number, number, number];
  win: WindowLayout | null;
  wing: WingDef;
  tailplane: WingDef;
  fin: FinDef;
  tTail: boolean;
  fairing?: { z0: number; z1: number; w: number; yTop: number; yBot: number };
  engines: (FanDef | PropDef)[];
  gear: GearDef[];
  struts?: { from: THREE.Vector3; to: THREE.Vector3; r: number };
  colors: {
    wingTop: RGB;
    wingBottom: RGB;
    wingLE: RGB;
    flap: RGB;
    tail: RGB;
    nacelle: RGB;
    nacelleLip?: RGB;
    pylon: RGB;
    gearDoor: RGB;
    belly: RGB;
    tailEnd: RGB;
    interior: { wall: RGB; ceiling: RGB; floor: RGB; seat: RGB; seatAccent: RGB };
  };
  weights: Record<string, number>;
  fuelFrac: Record<string, number>;
  cockpit: CockpitDef;
  /** Small cabin seen from the cockpit (prop): cabin interiors always shown, bulkhead behind the rear seats. */
  openCabin?: boolean;
  floorY: number;
  upperFloorY?: number;
  seatPitch: number;
  seatsAbreast: number[]; // seat block sizes (e.g. [3, 3])
  lightSize: number;
  doorL1: number; // z of the boarding door (left side)
  ground: number; // y of the ground with the gear down
}

const C = {
  white: rgb(0xfbfbfa),
  pearl: rgb(0xf7f5f2),
  cream: rgb(0xfff4e0),
  coral: rgb(0xff7a6b),
  coralDeep: rgb(0xf0645a),
  aqua: rgb(0x5cc8d6),
  aquaDeep: rgb(0x2fa9bb),
  mint: rgb(0x9ee0c8),
  butter: rgb(0xffe39a),
  lilac: rgb(0xb8a6e8),
  gold: rgb(0xe8c870),
  lgrey: rgb(0xd6dade),
  mgrey: rgb(0xb5bbc2),
  wingGrey: rgb(0xc9cfd6),
  belly: rgb(0xc9c3e0),
  dark: rgb(0x3a3f47),
};

const uv = (t: PlaneTypeId, w: 'title' | 'reg') => {
  const r = atlasRegion(t, w);
  return { u0: r.u0, v0: r.v0, u1: r.u1, v1: r.v1 };
};

// ------------------------------------------------------------------------------------------------ light prop plane
function propDesign(): Design {
  const profile: FusProfile = {
    zTail: -3.9,
    zNose: 3.56,
    w: curve([[-3.9, 0.07], [-3.0, 0.19], [-1.8, 0.35], [-0.6, 0.51], [0.2, 0.56], [2.3, 0.56], [2.75, 0.52], [3.2, 0.42], [3.56, 0.27]]),
    yTop: curve([[-3.9, 0.29], [-2.5, 0.37], [-1.0, 0.58], [-0.15, 0.8], [0.2, 0.84], [1.6, 0.84], [1.85, 0.79], [2.2, 0.6], [2.48, 0.45], [3.0, 0.33], [3.56, 0.19]]),
    yBot: curve([[-3.9, 0.14], [-2.8, -0.04], [-1.4, -0.34], [-0.3, -0.6], [0.4, -0.66], [2.4, -0.66], [3.05, -0.57], [3.56, -0.37]]),
    n: curve([[-3.9, 2.4], [-1.5, 2.8], [0, 3.0], [2.5, 3.0], [3.56, 2.3]]),
  };
  const b0 = curve([[-3.9, 0.32], [-2.2, -0.04], [-0.5, -0.12], [3.6, -0.12]]);
  const rects: FusRect[] = [
    { z0: 1.68, z1: 2.5, t0: 0, t1: 1.02, kind: 'glass' },
    { z0: 1.05, z1: 1.6, t0: 0.66, t1: 1.38, kind: 'glass' },
    { z0: 0.08, z1: 0.92, t0: 0.66, t1: 1.3, kind: 'glass' },
    { z0: -2.35, z1: -1.0, t0: 0.78, t1: 1.36, kind: 'uv', uv: uv('prop', 'reg') },
    { z0: 2.52, z1: 3.42, t0: 1.06, t1: 1.34, kind: 'uv', uv: uv('prop', 'title') },
  ];
  const liv: FusLivery = { bounds: [b0, (z) => b0(z) - 0.08], colors: [C.cream, C.coral, C.mint], rects };
  return {
    type: 'prop', name: 'Saltwing S2', livery: 'Coastline Flying Club', description: 'Two-seat high-wing trainer',
    length: 8, span: 11, height: 2.7,
    profile, liv,
    cuts: [2.56, 1.55, 1.15, -0.45, -2.0],
    ring: [40, 18, 8], step: [0.16, 0.42, 1.4],
    win: null,
    wing: {
      x0: 0, x1: 5.45,
      le: plin([[0, 1.45], [2.7, 1.45], [5.45, 1.33]]),
      chord: plin([[0, 1.5], [2.7, 1.5], [5.45, 1.15]]),
      y: plin([[0, 0.9], [5.45, 1.02]]),
      thick: plin([[0, 0.15], [5.45, 0.12]]),
      camber: 0.035,
      breaks: [2.7],
      flaps: [{ x0: 0.62, x1: 2.6, uh: 0.72 }],
      aileron: { x0: 2.85, x1: 5.0, uh: 0.72 },
      tipColor: C.coral,
    },
    tailplane: {
      x0: 0.08, x1: 1.75,
      le: plin([[0, -3.0], [1.75, -3.12]]),
      chord: plin([[0, 0.85], [1.75, 0.58]]),
      y: plin([[0, 0.14], [1.75, 0.14]]),
      thick: plin([[0, 0.1], [1.75, 0.09]]),
      camber: 0,
      breaks: [],
      flaps: [],
      aileron: { x0: 0.18, x1: 1.68, uh: 0.62 },
      tipColor: C.coral,
    },
    fin: { y0: 0.12, y1: 1.27, le: plin([[0.12, -2.72], [1.27, -3.25]]), chord: plin([[0.12, 1.18], [1.27, 0.64]]), thick: 0.1, rudder: { y0: 0.2, y1: 1.2, uh: 0.6 } },
    tTail: false,
    engines: [{ kind: 'prop', front: v3(0, -0.02, 3.62), spinnerR: 0.21, spinnerLen: 0.42, bladeLen: 0.72, bladeChord: 0.15, blades: 2, mount: 'nose' }],
    gear: [
      { name: 'gearNose', mount: 'nose', top: v3(0, -0.4, 3.05), wheel: v3(0, -1.2, 3.12), wheelR: 0.2, wheelW: 0.12, layout: 'single', strutR: 0.035, steerable: true, pant: C.coral },
      { name: 'gearL', mount: 'fuselageCenter', top: v3(0.32, -0.6, 0.42), wheel: v3(1.18, -1.17, 0.42), wheelR: 0.25, wheelW: 0.14, layout: 'single', strutR: 0.03, steerable: false, pant: C.coral, spring: true },
      { name: 'gearR', mount: 'fuselageCenter', top: v3(-0.32, -0.6, 0.42), wheel: v3(-1.18, -1.17, 0.42), wheelR: 0.25, wheelW: 0.14, layout: 'single', strutR: 0.03, steerable: false, pant: C.coral, spring: true },
    ],
    struts: { from: v3(0.5, -0.42, 0.95), to: v3(2.55, 0.86, 1.08), r: 0.04 },
    colors: {
      wingTop: C.cream, wingBottom: rgb(0xf2e8d6), wingLE: C.cream, flap: C.cream, tail: C.cream, nacelle: C.mint,
      pylon: C.cream, gearDoor: C.cream, belly: C.mint, tailEnd: C.cream,
      interior: { wall: rgb(0x8c8a86), ceiling: rgb(0xd8d2c8), floor: rgb(0x3b3d44), seat: rgb(0x355c7a), seatAccent: rgb(0x9ee0c8) },
    },
    weights: {
      nose: 4, cockpit: 14, fuselageFwd: 5, fuselageCenter: 11, fuselageRear: 6, tailCone: 3, fin: 1.5, tailplaneL: 1.4, tailplaneR: 1.4,
      wingL1: 7, wingR1: 7, wingL2: 4, wingR2: 4, strutL: 0.8, strutR: 0.8, engine1: 18, gearNose: 2, gearL: 2.5, gearR: 2.5,
    },
    fuelFrac: { wingL1: 0.4, wingR1: 0.4, wingL2: 0.1, wingR2: 0.1 },
    cockpit: { eye: v3(0, 0.56, 1.72), dashZ: 2.2, dashTop: 0.42, floorY: -0.45, zFront: 2.43, seatX: 0.27, glass: false, panelW: 0.9 },
    openCabin: true,
    floorY: -0.45,
    seatPitch: 0.9,
    seatsAbreast: [1, 1],
    lightSize: 0.22,
    doorL1: 1.4,
    ground: -1.45,
  };
}

// ------------------------------------------------------------------------------------------------ business jet
function bizjetDesign(): Design {
  const profile: FusProfile = {
    zTail: -8.2,
    zNose: 8.8,
    w: curve([[-8.2, 0.15], [-7.3, 0.35], [-6, 0.61], [-4.5, 0.86], [-3, 0.97], [-2, 0.98], [5.4, 0.98], [6.4, 0.92], [7.3, 0.74], [8.0, 0.48], [8.5, 0.25], [8.8, 0]]),
    yTop: curve([[-8.2, 0.52], [-7, 0.69], [-5.5, 0.9], [-4, 1.03], [-3, 1.08], [5.2, 1.08], [5.85, 1.03], [6.45, 0.88], [7.05, 0.64], [7.7, 0.4], [8.3, 0.17], [8.65, 0.03], [8.8, -0.08]]),
    yBot: curve([[-8.2, 0.2], [-7.4, -0.04], [-6, -0.44], [-4.5, -0.8], [-3, -0.92], [5.5, -0.92], [6.6, -0.86], [7.5, -0.67], [8.2, -0.41], [8.6, -0.21], [8.8, -0.08]]),
    n: curve([[-8.2, 2.0], [-4, 2.15], [6, 2.15], [8.8, 2.0]]),
  };
  const b0 = curve([[-8.2, 0.6], [-6.5, 0.35], [-4, -0.12], [-1, -0.44], [4, -0.55], [8.8, -0.55]]);
  const rects: FusRect[] = [
    { z0: 6.3, z1: 7.6, t0: 0.02, t1: 0.56, kind: 'glass' },
    { z0: 5.78, z1: 6.75, t0: 0.64, t1: 1.03, kind: 'glass' },
    { z0: 5.28, z1: 5.72, t0: 0.68, t1: 0.99, kind: 'glass' },
    { z0: 0.9, z1: 3.55, t0: 0.69, t1: 1.03, kind: 'uv', uv: uv('bizjet', 'title') },
    { z0: -7.75, z1: -6.55, t0: 1.28, t1: 1.72, kind: 'uv', uv: uv('bizjet', 'reg') },
  ];
  const liv: FusLivery = { bounds: [b0, (z) => b0(z) - 0.055], colors: [C.pearl, C.gold, C.lilac], rects };
  return {
    type: 'bizjet', name: 'Swiftlet 7', livery: 'Palmhaven Jet Charter', description: 'Twin rear-engine business jet',
    length: 18, span: 16, height: 5.5,
    profile, liv,
    cuts: [7.75, 5.0, 1.95, -1.7, -5.3],
    ring: [44, 20, 10], step: [0.3, 0.8, 2.4],
    win: { pitch: 0.95, halfW: 0.17, halfH: 0.22, corner: 0.16, rows: [{ y: 0.17, sMin: -3.85, sMax: 3.3 }], doors: [{ s: 4.45, y: -0.1, halfW: 0.38, halfH: 0.72 }] },
    wing: {
      x0: 0.4, x1: 7.85,
      le: plin([[0, 2.05], [7.85, 2.05 - 7.85 * 0.47]]),
      chord: plin([[0, 3.45], [7.85, 1.0]]),
      y: plin([[0, -0.62], [7.85, -0.2]]),
      thick: plin([[0, 0.13], [7.85, 0.1]]),
      camber: 0.02,
      breaks: [4.4],
      flaps: [{ x0: 1.1, x1: 4.3, uh: 0.72 }],
      aileron: { x0: 4.7, x1: 7.2, uh: 0.74 },
      winglet: { h: 1.15, cant: 0.22, sweep: 0.75, tipChord: 0.42 },
      tipColor: C.lilac,
    },
    tailplane: {
      x0: 0, x1: 2.95,
      le: plin([[0, -7.12], [2.95, -7.12 - 2.95 * 0.5]]),
      chord: plin([[0, 1.4], [2.95, 0.72]]),
      y: plin([[0, 3.6], [2.95, 3.52]]),
      thick: plin([[0, 0.1], [2.95, 0.09]]),
      camber: 0,
      breaks: [],
      flaps: [],
      aileron: { x0: 0.3, x1: 2.85, uh: 0.66 },
      tipColor: C.lilac,
    },
    fin: { y0: 0.65, y1: 3.62, le: plin([[0.65, -4.72], [3.62, -4.72 - 2.97 * 0.86]]), chord: plin([[0.65, 2.85], [3.62, 1.5]]), thick: 0.12, rudder: { y0: 1.0, y1: 3.4, uh: 0.68 } },
    tTail: true,
    fairing: { z0: 2.4, z1: -2.2, w: 1.06, yTop: -0.35, yBot: -1.02 },
    engines: [
      { kind: 'fan', front: v3(1.62, 0.44, -3.72), length: 2.7, rMax: 0.5, rLip: 0.44, rFan: 0.4, blades: 18, mount: 'fuselageRear', pylon: 'side' },
      { kind: 'fan', front: v3(-1.62, 0.44, -3.72), length: 2.7, rMax: 0.5, rLip: 0.44, rFan: 0.4, blades: 18, mount: 'fuselageRear', pylon: 'side' },
    ],
    gear: [
      { name: 'gearNose', mount: 'cockpit', top: v3(0, -0.72, 6.95), wheel: v3(0, -1.47, 6.95), wheelR: 0.24, wheelW: 0.13, layout: 'twin', track: 0.3, strutR: 0.05, steerable: true, retractAxis: v3(-1, 0, 0), retractAngle: 1.75, door: C.pearl },
      { name: 'gearL', mount: 'fuselageCenter', top: v3(1.45, -0.62, -0.55), wheel: v3(1.45, -1.38, -0.55), wheelR: 0.33, wheelW: 0.18, layout: 'single', strutR: 0.065, steerable: false, retractAxis: v3(0, 0, -1), retractAngle: 1.6, door: C.lilac },
      { name: 'gearR', mount: 'fuselageCenter', top: v3(-1.45, -0.62, -0.55), wheel: v3(-1.45, -1.38, -0.55), wheelR: 0.33, wheelW: 0.18, layout: 'single', strutR: 0.065, steerable: false, retractAxis: v3(0, 0, 1), retractAngle: 1.6, door: C.lilac },
    ],
    colors: {
      wingTop: C.pearl, wingBottom: rgb(0xe9e7ee), wingLE: rgb(0xc8ccd2), flap: C.pearl, tail: C.pearl, nacelle: C.pearl, nacelleLip: rgb(0xc9cdd3),
      pylon: C.pearl, gearDoor: C.lilac, belly: C.lilac, tailEnd: rgb(0x8d8f96),
      interior: { wall: rgb(0xe8e0d2), ceiling: rgb(0xf3eee6), floor: rgb(0x6b5a4a), seat: rgb(0xd9c8a8), seatAccent: rgb(0xb8a6e8) },
    },
    weights: {
      nose: 2, cockpit: 8, fuselageFwd: 10, fuselageCenter: 14, fuselageRear: 11, tailCone: 3, fin: 2.6, tailplaneL: 1, tailplaneR: 1,
      wingL1: 8, wingR1: 8, wingL2: 3.5, wingR2: 3.5, engine1: 7, engine2: 7, gearNose: 0.8, gearL: 2, gearR: 2,
    },
    fuelFrac: { fuselageCenter: 0.3, wingL1: 0.28, wingR1: 0.28, wingL2: 0.07, wingR2: 0.07 },
    cockpit: { eye: v3(0, 0.66, 5.6), dashZ: 6.25, dashTop: 0.36, floorY: -0.5, zFront: 6.75, seatX: 0.42, glass: true, panelW: 1.2 },
    floorY: -0.55,
    seatPitch: 1.25,
    seatsAbreast: [1, 1],
    lightSize: 0.32,
    doorL1: 4.45,
    ground: -1.85,
  };
}

// ------------------------------------------------------------------------------------------------ narrow-body airliner
function airlinerDesign(): Design {
  const profile: FusProfile = {
    zTail: -19,
    zNose: 19,
    w: curve([[-19, 0.22], [-18.2, 0.48], [-16.5, 0.95], [-14, 1.5], [-11.5, 1.86], [-8.5, 1.98], [12.5, 1.98], [14.5, 1.9], [16.2, 1.62], [17.4, 1.22], [18.3, 0.78], [18.8, 0.42], [19, 0]]),
    yTop: curve([[-19, 0.95], [-17.5, 1.25], [-15, 1.62], [-12, 1.92], [-8.5, 2.05], [12.9, 2.05], [14.3, 1.98], [15.0, 1.83], [15.65, 1.57], [16.3, 1.27], [16.95, 1.0], [17.6, 0.74], [18.3, 0.46], [18.8, 0.18], [19, -0.05]]),
    yBot: curve([[-19, 0.62], [-17.5, 0.2], [-15, -0.65], [-12, -1.55], [-9, -1.92], [-7, -1.95], [13, -1.95], [15, -1.85], [16.5, -1.58], [17.6, -1.2], [18.4, -0.78], [18.85, -0.38], [19, -0.05]]),
    n: curve([[-19, 2.0], [0, 2.05], [19, 2.0]]),
  };
  const b0 = curve([[-19, 0.86], [-15, 0.55], [-11, 0.12], [-6, -0.3], [2, -0.42], [19, -0.44]]);
  const rects: FusRect[] = [
    { z0: 14.98, z1: 16.3, t0: 0, t1: 0.5, kind: 'glass' },
    { z0: 14.5, z1: 15.75, t0: 0.57, t1: 0.99, kind: 'glass' },
    { z0: 13.8, z1: 14.42, t0: 0.6, t1: 0.95, kind: 'glass' },
    { z0: 0.6, z1: 7.6, t0: 0.72, t1: 1.08, kind: 'uv', uv: uv('airliner', 'title') },
    { z0: -11.3, z1: -8.9, t0: 0.8, t1: 1.0, kind: 'uv', uv: uv('airliner', 'reg') },
  ];
  const liv: FusLivery = { bounds: [b0, (z) => b0(z) - 0.075], colors: [C.white, C.coral, C.aqua], rects };
  const le = (x: number) => 4.4 - 0.51 * x;
  return {
    type: 'airliner', name: 'Tidewing 38', livery: 'Seaglass Air', description: 'Narrow-body twinjet airliner',
    length: 38, span: 35, height: 12,
    profile, liv,
    cuts: [16.7, 13.0, 4.4, -3.9, -12.0],
    ring: [52, 22, 10], step: [0.55, 1.6, 5],
    win: {
      pitch: 0.53, halfW: 0.125, halfH: 0.17, corner: 0.09, rows: [{ y: 0.55, sMin: -11.6, sMax: 11.6 }],
      doors: [
        { s: 12.1, y: 0.12, halfW: 0.42, halfH: 0.95 },
        { s: 0.85, y: 0.45, halfW: 0.24, halfH: 0.48 },
        { s: 0.05, y: 0.45, halfW: 0.24, halfH: 0.48 },
        { s: -12.55, y: 0.12, halfW: 0.38, halfH: 0.92 },
      ],
    },
    wing: {
      x0: 1.0, x1: 17.25,
      le: (x) => le(x),
      chord: plin([[0, 7.2], [6.5, 4.6], [17.25, 1.45]]),
      y: (x) => -1.15 + 0.0875 * x,
      thick: plin([[0, 0.145], [6.5, 0.115], [17.25, 0.095]]),
      camber: 0.02,
      breaks: [7.4, 12.6],
      extraX: [6.5],
      flaps: [{ x0: 2.15, x1: 7.25, uh: 0.72 }, { x0: 7.55, x1: 12.45, uh: 0.74 }],
      aileron: { x0: 12.75, x1: 16.3, uh: 0.75 },
      winglet: { h: 1.75, cant: 0.12, sweep: 1.1, tipChord: 0.45 },
      tipColor: C.aqua,
    },
    tailplane: {
      x0: 0.4, x1: 6.25,
      le: plin([[0, -12.8], [6.25, -12.8 - 6.25 * 0.55]]),
      chord: plin([[0, 4.0], [6.25, 1.35]]),
      y: plin([[0, 0.55], [6.25, 1.2]]),
      thick: plin([[0, 0.11], [6.25, 0.09]]),
      camber: 0,
      breaks: [],
      flaps: [],
      aileron: { x0: 1.3, x1: 6.0, uh: 0.7 },
    },
    fin: { y0: 1.2, y1: 8.0, le: plin([[1.2, -10.9], [8.0, -10.9 - 6.8 * 0.68]]), chord: plin([[1.2, 5.9], [8.0, 1.9]]), thick: 0.11, rudder: { y0: 2.3, y1: 7.7, uh: 0.68 } },
    tTail: false,
    fairing: { z0: 5.4, z1: -5.6, w: 2.22, yTop: -0.7, yBot: -2.2 },
    engines: [
      { kind: 'fan', front: v3(5.8, -2.32, le(5.8) + 2.6), length: 4.2, rMax: 1.05, rLip: 0.95, rFan: 0.87, blades: 22, mount: 'wingL1', pylon: 'wing', pylonTop: -0.85, pylonBack: le(5.8) - 2.6 },
      { kind: 'fan', front: v3(-5.8, -2.32, le(5.8) + 2.6), length: 4.2, rMax: 1.05, rLip: 0.95, rFan: 0.87, blades: 22, mount: 'wingR1', pylon: 'wing', pylonTop: -0.85, pylonBack: le(5.8) - 2.6 },
    ],
    gear: [
      { name: 'gearNose', mount: 'cockpit', top: v3(0, -1.55, 14.4), wheel: v3(0, -3.6, 14.4), wheelR: 0.38, wheelW: 0.24, layout: 'twin', track: 0.5, strutR: 0.1, steerable: true, retractAxis: v3(-1, 0, 0), retractAngle: 1.62, door: C.aqua },
      { name: 'gearL', mount: 'fuselageCenter', top: v3(3.8, -1.0, -1.3), wheel: v3(3.8, -3.42, -1.3), wheelR: 0.58, wheelW: 0.36, layout: 'twin', track: 0.88, strutR: 0.15, steerable: false, retractAxis: v3(0, 0, -1), retractAngle: 1.72, door: C.aqua },
      { name: 'gearR', mount: 'fuselageCenter', top: v3(-3.8, -1.0, -1.3), wheel: v3(-3.8, -3.42, -1.3), wheelR: 0.58, wheelW: 0.36, layout: 'twin', track: 0.88, strutR: 0.15, steerable: false, retractAxis: v3(0, 0, 1), retractAngle: 1.72, door: C.aqua },
    ],
    colors: {
      wingTop: C.wingGrey, wingBottom: rgb(0xb9c0c8), wingLE: rgb(0xe2e5e8), flap: rgb(0xbfc6ce), tail: C.white, nacelle: C.aqua, nacelleLip: rgb(0xd5d9de),
      pylon: C.white, gearDoor: C.aqua, belly: C.aqua, tailEnd: rgb(0x8d8f96),
      interior: { wall: rgb(0xe9e6df), ceiling: rgb(0xf4f2ee), floor: rgb(0x46607a), seat: rgb(0x2f6f8a), seatAccent: rgb(0x9ee0c8) },
    },
    weights: {
      nose: 1.5, cockpit: 5, fuselageFwd: 12, fuselageCenter: 16, fuselageRear: 10, tailCone: 3, fin: 1.6, tailplaneL: 1.2, tailplaneR: 1.2,
      wingL1: 9, wingR1: 9, wingL2: 4, wingR2: 4, wingL3: 1.6, wingR3: 1.6, engine1: 6, engine2: 6, gearNose: 0.7, gearL: 2.2, gearR: 2.2,
    },
    fuelFrac: { fuselageCenter: 0.4, wingL1: 0.22, wingR1: 0.22, wingL2: 0.08, wingR2: 0.08 },
    cockpit: { eye: v3(0, 1.55, 14.55), dashZ: 15.25, dashTop: 1.28, floorY: -0.15, zFront: 15.95, seatX: 0.55, glass: true, panelW: 1.9 },
    floorY: -0.55,
    seatPitch: 0.81,
    seatsAbreast: [3, 3],
    lightSize: 0.45,
    doorL1: 12.1,
    ground: -4.0,
  };
}

// ------------------------------------------------------------------------------------------------ four-engine jumbo
function jumboDesign(): Design {
  const profile: FusProfile = {
    zTail: -35,
    zNose: 35,
    w: curve([[-35, 0.32], [-33.5, 0.85], [-30, 1.85], [-26, 2.65], [-21, 3.1], [-17, 3.25], [27, 3.25], [29.5, 3.1], [31.5, 2.7], [33.0, 2.05], [34.2, 1.25], [34.8, 0.6], [35, 0]]),
    yTop: curve([[-35, 1.45], [-32, 2.05], [-27, 2.85], [-22, 3.3], [-17, 3.45], [3, 3.45], [6, 3.62], [9, 4.15], [12, 4.68], [15, 4.92], [26.4, 4.92], [28.4, 4.76], [29.9, 4.38], [30.9, 3.9], [32.1, 3.08], [33.3, 2.17], [34.2, 1.27], [34.75, 0.45], [35, -0.25]]),
    yBot: curve([[-35, 1.0], [-32, 0.15], [-28, -1.2], [-23, -2.5], [-19, -3.0], [-15, -3.15], [27, -3.15], [30, -2.95], [32.2, -2.5], [33.6, -1.75], [34.5, -1.0], [34.9, -0.5], [35, -0.25]]),
    yMid: curve([[-35, 1.2], [-30, 0.55], [-22, 0.0], [-17, -0.05], [27, -0.05], [31, 0.0], [33.5, -0.1], [35, -0.25]]),
    n: curve([[-35, 2.0], [3, 2.0], [10, 2.3], [27, 2.3], [31, 2.15], [35, 2.0]]),
    pinch: curve([[3, 0], [6, 0.05], [10, 0.13], [14, 0.16], [27, 0.16], [30, 0.12], [32.5, 0.05], [34, 0]]),
  };
  const b0 = curve([[-35, 0.85], [-28, 0.62], [-21, 0.22], [-15, 0.11], [3, 0.11], [11, 0.08], [28, 0.08], [33, 0.02], [35, -0.1]]);
  const rects: FusRect[] = [
    { z0: 30.25, z1: 31.25, t0: 0, t1: 0.42, kind: 'glass' },
    { z0: 29.55, z1: 30.75, t0: 0.49, t1: 0.82, kind: 'glass' },
    { z0: 28.9, z1: 29.5, t0: 0.52, t1: 0.78, kind: 'glass' },
    { z0: 14.2, z1: 24.4, t0: 0.97, t1: 1.27, kind: 'uv', uv: uv('jumbo', 'title') },
    { z0: -24.2, z1: -20.6, t0: 0.88, t1: 1.11, kind: 'uv', uv: uv('jumbo', 'reg') },
  ];
  const liv: FusLivery = {
    bounds: [b0, (z) => b0(z) - 0.2, (z) => b0(z) - 0.26, () => -0.62],
    colors: [C.white, C.coral, C.butter, C.white, C.belly],
    rects,
  };
  const le = (x: number) => 10.5 - 0.767 * x;
  return {
    type: 'jumbo', name: 'Pelagic 700', livery: 'Coral Crown International', description: 'Four-engine wide-body jumbo jet',
    length: 70, span: 64, height: 19,
    profile, liv,
    cuts: [32.0, 26.0, 8.6, -6.8, -22.5],
    ring: [60, 24, 12], step: [0.9, 2.6, 8],
    win: {
      pitch: 0.52, halfW: 0.13, halfH: 0.19, corner: 0.1,
      rows: [{ y: 0.9, sMin: -21.6, sMax: 28.6 }, { y: 3.78, sMin: 13.2, sMax: 25.4 }],
      doors: [
        { s: 27.4, y: 0.35, halfW: 0.55, halfH: 1.0 },
        { s: 17.0, y: 0.35, halfW: 0.55, halfH: 1.0 },
        { s: 4.4, y: 0.35, halfW: 0.55, halfH: 1.0 },
        { s: -8.2, y: 0.35, halfW: 0.55, halfH: 1.0 },
        { s: -17.6, y: 0.35, halfW: 0.5, halfH: 1.0 },
        { s: 19.6, y: 3.62, halfW: 0.4, halfH: 0.72 },
      ],
    },
    wing: {
      x0: 1.5, x1: 31.4,
      le: (x) => le(x),
      chord: plin([[0, 15.5], [12, 9.0], [31.4, 3.4]]),
      y: (x) => -2.0 + 0.123 * x,
      thick: plin([[0, 0.135], [12, 0.105], [31.4, 0.08]]),
      camber: 0.02,
      breaks: [13.6, 23.8],
      extraX: [12],
      flaps: [{ x0: 3.4, x1: 13.4, uh: 0.74 }, { x0: 13.8, x1: 23.6, uh: 0.76 }],
      aileron: { x0: 24.2, x1: 30.4, uh: 0.76 },
      winglet: { h: 1.9, cant: 0.5, sweep: 1.5, tipChord: 0.9 },
      tipColor: C.coral,
    },
    tailplane: {
      x0: 0.8, x1: 11.0,
      le: plin([[0, -25.3], [11, -25.3 - 11 * 0.75]]),
      chord: plin([[0, 8.3], [11, 2.6]]),
      y: plin([[0, 1.2], [11, 2.55]]),
      thick: plin([[0, 0.11], [11, 0.09]]),
      camber: 0,
      breaks: [],
      flaps: [],
      aileron: { x0: 1.8, x1: 10.6, uh: 0.7 },
    },
    fin: { y0: 2.4, y1: 13.2, le: plin([[2.4, -22.3], [13.2, -22.3 - 10.8 * 0.98]]), chord: plin([[2.4, 12.6], [13.2, 4.2]]), thick: 0.11, rudder: { y0: 3.5, y1: 12.8, uh: 0.7 } },
    tTail: false,
    fairing: { z0: 11.5, z1: -9.5, w: 3.62, yTop: -1.2, yBot: -3.5 },
    engines: [
      { kind: 'fan', front: v3(21.2, -1.55, le(21.2) + 3.4), length: 6.0, rMax: 1.45, rLip: 1.32, rFan: 1.2, blades: 24, mount: 'wingL2', pylon: 'wing', pylonTop: 0.25, pylonBack: le(21.2) - 3.0 },
      { kind: 'fan', front: v3(11.6, -2.7, le(11.6) + 3.7), length: 6.2, rMax: 1.5, rLip: 1.36, rFan: 1.24, blades: 24, mount: 'wingL1', pylon: 'wing', pylonTop: -0.95, pylonBack: le(11.6) - 3.5 },
      { kind: 'fan', front: v3(-11.6, -2.7, le(11.6) + 3.7), length: 6.2, rMax: 1.5, rLip: 1.36, rFan: 1.24, blades: 24, mount: 'wingR1', pylon: 'wing', pylonTop: -0.95, pylonBack: le(11.6) - 3.5 },
      { kind: 'fan', front: v3(-21.2, -1.55, le(21.2) + 3.4), length: 6.0, rMax: 1.45, rLip: 1.32, rFan: 1.2, blades: 24, mount: 'wingR2', pylon: 'wing', pylonTop: 0.25, pylonBack: le(21.2) - 3.0 },
    ],
    gear: [
      { name: 'gearNose', mount: 'cockpit', top: v3(0, -2.4, 29.4), wheel: v3(0, -5.22, 29.4), wheelR: 0.6, wheelW: 0.36, layout: 'twin', track: 0.72, strutR: 0.16, steerable: true, retractAxis: v3(-1, 0, 0), retractAngle: 1.62, door: C.white },
      { name: 'gearL', mount: 'fuselageCenter', top: v3(5.6, -1.6, -2.4), wheel: v3(5.6, -5.22, -2.4), wheelR: 0.62, wheelW: 0.38, layout: 'bogie', track: 1.12, axleSpacing: 1.48, strutR: 0.22, steerable: false, retractAxis: v3(0, 0, -1), retractAngle: 1.57, door: C.belly },
      { name: 'gearR', mount: 'fuselageCenter', top: v3(-5.6, -1.6, -2.4), wheel: v3(-5.6, -5.22, -2.4), wheelR: 0.62, wheelW: 0.38, layout: 'bogie', track: 1.12, axleSpacing: 1.48, strutR: 0.22, steerable: false, retractAxis: v3(0, 0, 1), retractAngle: 1.57, door: C.belly },
      { name: 'gearL2', mount: 'fuselageCenter', top: v3(1.9, -2.2, -5.6), wheel: v3(1.9, -5.22, -5.6), wheelR: 0.62, wheelW: 0.38, layout: 'bogie', track: 1.12, axleSpacing: 1.48, strutR: 0.22, steerable: false, retractAxis: v3(-1, 0, 0), retractAngle: 1.62 },
      { name: 'gearR2', mount: 'fuselageCenter', top: v3(-1.9, -2.2, -5.6), wheel: v3(-1.9, -5.22, -5.6), wheelR: 0.62, wheelW: 0.38, layout: 'bogie', track: 1.12, axleSpacing: 1.48, strutR: 0.22, steerable: false, retractAxis: v3(-1, 0, 0), retractAngle: 1.62 },
    ],
    colors: {
      wingTop: C.wingGrey, wingBottom: rgb(0xb9c0c8), wingLE: rgb(0xe2e5e8), flap: rgb(0xbfc6ce), tail: C.white, nacelle: C.white, nacelleLip: C.coral,
      pylon: C.white, gearDoor: C.belly, belly: C.belly, tailEnd: rgb(0x8d8f96),
      interior: { wall: rgb(0xebe5dc), ceiling: rgb(0xf5f1ea), floor: rgb(0x7a4e5a), seat: rgb(0xc9503f), seatAccent: rgb(0xffe39a) },
    },
    weights: {
      nose: 1, cockpit: 4, fuselageFwd: 11, fuselageCenter: 14, fuselageRear: 9, tailCone: 2.5, fin: 1.5, tailplaneL: 1.2, tailplaneR: 1.2,
      wingL1: 8.5, wingR1: 8.5, wingL2: 4, wingR2: 4, wingL3: 1.5, wingR3: 1.5,
      engine1: 3, engine2: 3, engine3: 3, engine4: 3, gearNose: 0.6, gearL: 1.6, gearR: 1.6, gearL2: 1.6, gearR2: 1.6,
    },
    fuelFrac: { fuselageCenter: 0.4, wingL1: 0.22, wingR1: 0.22, wingL2: 0.08, wingR2: 0.08 },
    cockpit: { eye: v3(0, 4.02, 29.7), dashZ: 30.42, dashTop: 3.82, floorY: 2.95, zFront: 31.15, seatX: 0.6, glass: true, panelW: 2.0 },
    floorY: -0.6,
    upperFloorY: 2.95,
    seatPitch: 0.84,
    seatsAbreast: [3, 4, 3],
    lightSize: 0.62,
    doorL1: 27.4,
    ground: -5.82,
  };
}

let cache: Record<PlaneTypeId, Design> | null = null;
export function getDesign(t: PlaneTypeId): Design {
  if (!cache) cache = { prop: propDesign(), bizjet: bizjetDesign(), airliner: airlinerDesign(), jumbo: jumboDesign() };
  return cache[t];
}
