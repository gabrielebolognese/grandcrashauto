import * as THREE from 'three';
import type { SurfaceMaterial } from '../../core/Physics';
import type { CarModelId } from '../../vehicle/CarBuild';
import { hashf } from './GeoBuilder';
import * as Mdl from './models';
import { buildFallbackCar, buildFarCar, carSpecDims } from './carModels';

/**
 * Kind registry (owner: props). A "render kind" = one model family with its LODs, physics class, colliders,
 * variation and lamps. PropPlacement kinds map onto render kinds through RESOLVERS (bench → bench2/bench3 by seat
 * count, tree → round/cypress by variant…). Unknown placement kinds resolve to null and are skipped gracefully —
 * add a new kind with `defineKind()` + a resolver entry.
 */

export type PhysClass = 'none' | 'light' | 'heavy';

export interface ColliderDef {
  shape: 'box' | 'cyl' | 'cone';
  /** box: half extents; cyl/cone: hx = radius, hy = half height. */
  hx: number;
  hy: number;
  hz: number;
  cx: number;
  cy: number;
  cz: number;
  rz?: number; // tilt about Z
}

export interface LodDef {
  geo: THREE.BufferGeometry;
  /** Max distance (m) at lodScale 1; the last dedicated LOD runs to `cull` unless an impostor takes over. */
  dist: number;
  shadow: boolean;
}

export interface ImpostorDef {
  shape: 'box' | 'cyl';
  sx: number;
  sy: number;
  sz: number;
  oy: number;
  oz: number;
  /** Fixed colour (else the instance tint). */
  color?: string;
}

export interface GlowDef {
  x: number;
  y: number;
  z: number;
  size: number; // sprite size (m)
  pool: number; // ground light-pool radius (m), 0 = none
  light: boolean; // candidate for a real pooled PointLight
}

export interface VariantOut {
  scale: number;
  tint: THREE.Color;
  phase: number;
}

export interface KindDef {
  id: number;
  name: string;
  /** propHit event kind (audio picks the sound from it). */
  event: string;
  material: 'prop' | 'foliage' | 'car';
  lods: LodDef[];
  impostor?: ImpostorDef;
  /** Render distance (m) at lodScale 1 (also clamped by quality viewDistance and fog visibility). */
  cull: number;
  phys: PhysClass;
  colliders: ColliderDef[];
  mass: number;
  friction: number;
  surface: SurfaceMaterial;
  /** Closing speed (m/s) above which a heavy prop snaps and topples (0 = never). */
  topple: number;
  /** Can be thinned by quality.propDensity (decorative). */
  thin: boolean;
  radius: number;
  height: number;
  glows: GlowDef[];
  variant(v: number, out: VariantOut): void;
  car?: CarModelId;
  /** Car lamp anchors (local) for night glow sprites: [x, y, z] front-left; mirrored on X, rear uses tail. */
  carLamps?: { front: number[]; rear: number[]; halfLength: number };
}

const KINDS: KindDef[] = [];
const BY_NAME = new Map<string, KindDef>();

export function kinds(): readonly KindDef[] {
  return KINDS;
}

export function kindByName(name: string): KindDef | undefined {
  return BY_NAME.get(name);
}

type KindInit = Omit<KindDef, 'id' | 'glows' | 'colliders' | 'friction' | 'topple' | 'thin' | 'mass' | 'variant'> &
  Partial<Pick<KindDef, 'glows' | 'colliders' | 'friction' | 'topple' | 'thin' | 'mass' | 'variant'>>;

export function defineKind(init: KindInit): KindDef {
  const k: KindDef = {
    glows: [],
    colliders: [],
    friction: 0.6,
    topple: 0,
    thin: false,
    mass: 10,
    variant: (_v, out) => {
      out.scale = 1;
      out.tint.setRGB(1, 1, 1);
      out.phase = 0;
    },
    ...init,
    id: KINDS.length,
  };
  KINDS.push(k);
  BY_NAME.set(k.name, k);
  return k;
}

// ───────────────────────────── variation helpers ─────────────────────────────
const rnd = (v: number, salt: number) => hashf(v * 0.6180339 + salt * 17.13);
const cols = (hexes: string[]) => hexes.map((h) => new THREE.Color(h));
const pick = (list: THREE.Color[], v: number, salt: number) => list[Math.floor(rnd(v, salt) * list.length) % list.length];

const POLE = cols(['#2f6f73', '#f1e6cf', '#3e5f73', '#f1e6cf', '#5b8f86']);
const PALM_T = cols(['#ffffff', '#f2ffe2', '#fff2d2', '#e4fff1', '#f7f7e8']);
const GREENS = cols(['#5aa05a', '#6db35c', '#4f9a5a', '#7fc06a', '#46905a', '#8cc45e']);
const BLOSSOM = cols(['#d4a6ec', '#ffb3c9', '#f6c8e4']);
const CYPRESS = cols(['#3f7f4f', '#477f45', '#356f4a']);
const WOOD = cols(['#b9824f', '#a8703f', '#c79a6a']);
const PASTEL = cols(['#9ee0c8', '#ff8f7f', '#5cc8d6', '#ffe39a', '#b8a6e8']);
const BINS = cols(['#9ee0c8', '#5cc8d6', '#ff8f7f', '#ffe39a', '#1f6f78', '#2f4a6b']);
const HYDRANT = cols(['#e0473c', '#e0473c', '#e0473c', '#f2c94c', '#f2c94c', '#6fcfb3']);
const CONE = cols(['#ff6a26', '#ff7a2e', '#ff5f22']);
const ROOF = cols(['#ff8f7f', '#5cc8d6', '#9ee0c8', '#ffd27a', '#b8a6e8']);
const HOUSING = cols(['#2c3335', '#1f4f55', '#2d3b2f']);
const SIGN = cols(['#2a8fbd', '#146c94', '#e8574a', '#2f8f74', '#3b4f8f']);
const TRUCK = cols(['#ffd34d', '#f7f7f2', '#5cc8d6']);
const CART = cols(['#ffb38a', '#5cc8d6', '#9ee0c8', '#ffe39a']);

const vary = (list: THREE.Color[], sMin: number, sMax: number) => (v: number, out: VariantOut) => {
  out.scale = sMin + (sMax - sMin) * rnd(v, 1);
  out.tint.copy(pick(list, v, 2));
  out.phase = rnd(v, 3) * 10;
};

// ───────────────────────────── kind definitions ─────────────────────────────
let built = false;

/** Build every model + kind once (call at init; geometry building is synchronous and fast). */
export function buildRegistry(): void {
  if (built) return;
  built = true;
  defineKind({
    name: 'streetlight', event: 'streetlight', material: 'prop',
    lods: [{ geo: Mdl.streetlight(0), dist: 55, shadow: true }, { geo: Mdl.streetlight(1), dist: 400, shadow: false }],
    cull: 420, phys: 'heavy', mass: 160, surface: 'metal', topple: 15, radius: 0.3, height: 5.9,
    colliders: [{ shape: 'cyl', hx: 0.13, hy: 2.7, hz: 0, cx: 0, cy: 2.7, cz: 0 }],
    glows: [{ x: 0, y: Mdl.STREETLIGHT_LAMP_Y, z: 0, size: 2.1, pool: 7.5, light: true }],
    variant: vary(POLE, 0.97, 1.03),
  });
  defineKind({
    name: 'palm', event: 'palm', material: 'foliage',
    lods: [{ geo: Mdl.palm(0), dist: 60, shadow: true }, { geo: Mdl.palm(1), dist: 460, shadow: false }],
    cull: 460, phys: 'heavy', mass: 320, surface: 'foliage', topple: 19, thin: true, radius: 0.4, height: 8,
    colliders: [
      { shape: 'cyl', hx: 0.25, hy: 1.9, hz: 0, cx: 0.06, cy: 1.9, cz: 0 },
      { shape: 'cyl', hx: 0.2, hy: 1.8, hz: 0, cx: 0.75, cy: 5.5, cz: 0, rz: -0.24 },
    ],
    variant: (v, out) => {
      out.scale = 0.85 + 0.38 * rnd(v, 1);
      out.tint.copy(pick(PALM_T, v, 2));
      out.phase = rnd(v, 3) * 10;
    },
  });
  defineKind({
    name: 'treeRound', event: 'tree', material: 'foliage',
    lods: [{ geo: Mdl.treeRound(0), dist: 55, shadow: true }, { geo: Mdl.treeRound(1), dist: 380, shadow: false }],
    cull: 380, phys: 'heavy', mass: 600, surface: 'foliage', thin: true, radius: 0.35, height: 5.6,
    colliders: [{ shape: 'cyl', hx: 0.24, hy: 1.6, hz: 0, cx: 0, cy: 1.6, cz: 0 }],
    variant: (v, out) => {
      out.scale = 0.85 + 0.4 * rnd(v, 1);
      out.tint.copy(rnd(v, 4) < 0.13 ? pick(BLOSSOM, v, 5) : pick(GREENS, v, 2));
      out.phase = rnd(v, 3) * 10;
    },
  });
  defineKind({
    name: 'treeCypress', event: 'tree', material: 'foliage',
    lods: [{ geo: Mdl.treeCypress(0), dist: 60, shadow: true }, { geo: Mdl.treeCypress(1), dist: 320, shadow: false }],
    cull: 320, phys: 'heavy', mass: 400, surface: 'foliage', thin: true, radius: 0.3, height: 5.8,
    colliders: [{ shape: 'cyl', hx: 0.3, hy: 1.2, hz: 0, cx: 0, cy: 1.2, cz: 0 }],
    variant: vary(CYPRESS, 0.85, 1.2),
  });
  const benchVariant = (v: number, out: VariantOut) => {
    out.scale = 1;
    out.tint.copy(rnd(v, 4) < 0.6 ? pick(WOOD, v, 2) : pick(PASTEL, v, 5));
    out.phase = 0;
  };
  for (const seats of [2, 3]) {
    const L = seats * 0.62 + 0.12;
    defineKind({
      name: `bench${seats}`, event: 'bench', material: 'prop',
      lods: [{ geo: Mdl.bench(seats), dist: 50, shadow: false }],
      impostor: { shape: 'box', sx: L, sy: 0.8, sz: 0.55, oy: 0, oz: -0.05 },
      cull: 120, phys: 'light', mass: seats === 2 ? 32 : 42, surface: 'wood', radius: L / 2, height: 0.93,
      colliders: [
        { shape: 'box', hx: L / 2, hy: 0.235, hz: 0.25, cx: 0, cy: 0.235, cz: 0 },
        { shape: 'box', hx: L / 2, hy: 0.2, hz: 0.04, cx: 0, cy: 0.71, cz: -0.29 },
      ],
      variant: benchVariant,
    });
  }
  defineKind({
    name: 'bin', event: 'bin', material: 'prop',
    lods: [{ geo: Mdl.bin(), dist: 40, shadow: false }],
    impostor: { shape: 'cyl', sx: 0.56, sy: 1.1, sz: 0.56, oy: 0, oz: 0 },
    cull: 100, phys: 'light', mass: 16, surface: 'plastic', thin: true, radius: 0.3, height: 1.1,
    colliders: [{ shape: 'cyl', hx: 0.28, hy: 0.55, hz: 0, cx: 0, cy: 0.55, cz: 0 }],
    variant: vary(BINS, 0.96, 1.04),
  });
  defineKind({
    name: 'hydrant', event: 'hydrant', material: 'prop',
    lods: [{ geo: Mdl.hydrant(), dist: 35, shadow: false }],
    impostor: { shape: 'cyl', sx: 0.3, sy: 0.75, sz: 0.3, oy: 0, oz: 0 },
    cull: 90, phys: 'heavy', mass: 90, surface: 'metal', topple: 11, thin: true, radius: 0.2, height: 0.78,
    colliders: [{ shape: 'cyl', hx: 0.17, hy: 0.38, hz: 0, cx: 0, cy: 0.38, cz: 0 }],
    variant: vary(HYDRANT, 0.97, 1.03),
  });
  defineKind({
    name: 'cone', event: 'cone', material: 'prop',
    lods: [{ geo: Mdl.cone(), dist: 40, shadow: false }],
    impostor: { shape: 'cyl', sx: 0.34, sy: 0.72, sz: 0.34, oy: 0, oz: 0 },
    cull: 100, phys: 'light', mass: 3, surface: 'plastic', thin: true, radius: 0.2, height: 0.72,
    colliders: [{ shape: 'cone', hx: 0.19, hy: 0.36, hz: 0, cx: 0, cy: 0.36, cz: 0 }],
    variant: vary(CONE, 0.95, 1.05),
  });
  defineKind({
    name: 'barrier', event: 'barrier', material: 'prop',
    lods: [{ geo: Mdl.barrier(), dist: 45, shadow: false }],
    impostor: { shape: 'box', sx: 1.62, sy: 1.0, sz: 0.3, oy: 0, oz: 0, color: '#f2a196' },
    cull: 110, phys: 'light', mass: 14, surface: 'plastic', thin: true, radius: 0.82, height: 1.1,
    colliders: [{ shape: 'box', hx: 0.8, hy: 0.52, hz: 0.17, cx: 0, cy: 0.52, cz: 0 }],
    variant: (v, out) => {
      out.scale = 1;
      out.tint.setRGB(1, 1, 1);
      out.phase = rnd(v, 3);
    },
  });
  defineKind({
    name: 'busStop', event: 'busStop', material: 'prop',
    lods: [{ geo: Mdl.busStop(), dist: 190, shadow: true }],
    cull: 190, phys: 'heavy', mass: 800, surface: 'metal', radius: 2.2, height: 2.8,
    colliders: [
      { shape: 'box', hx: 1.7, hy: 1.25, hz: 0.06, cx: 0, cy: 1.28, cz: -0.72 },
      { shape: 'box', hx: 0.08, hy: 0.95, hz: 0.65, cx: 1.68, cy: 1.25, cz: 0 },
      { shape: 'box', hx: 0.05, hy: 1.28, hz: 0.05, cx: -1.68, cy: 1.28, cz: 0.74 },
    ],
    glows: [{ x: Mdl.BUS_LAMP.x, y: Mdl.BUS_LAMP.y, z: Mdl.BUS_LAMP.z, size: 1.5, pool: 3.8, light: true }],
    variant: vary(ROOF, 1, 1),
  });
  defineKind({
    name: 'trafficLight', event: 'trafficLight', material: 'prop',
    lods: [{ geo: Mdl.trafficLight(), dist: 170, shadow: false }],
    cull: 170, phys: 'heavy', mass: 150, surface: 'metal', topple: 16, radius: 0.25, height: 3.8,
    colliders: [{ shape: 'cyl', hx: 0.11, hy: 1.85, hz: 0, cx: 0, cy: 1.85, cz: 0 }],
    variant: (v, out) => {
      out.scale = 1;
      out.tint.copy(pick(HOUSING, v, 2));
      out.phase = 0; // set per intersection by Props
    },
  });
  defineKind({
    name: 'sign', event: 'sign', material: 'prop',
    lods: [{ geo: Mdl.sign(), dist: 45, shadow: false }],
    impostor: { shape: 'box', sx: 0.72, sy: 0.48, sz: 0.05, oy: 1.71, oz: 0.075 },
    cull: 110, phys: 'heavy', mass: 25, surface: 'metal', topple: 7, thin: true, radius: 0.36, height: 2.5,
    colliders: [{ shape: 'cyl', hx: 0.06, hy: 1.25, hz: 0, cx: 0, cy: 1.25, cz: 0 }],
    variant: vary(SIGN, 1, 1),
  });
  // Real sign faces (world placement variants: 0 stop, 2 jump warning, 3 parking, 4 roadworks) — see Props RESOLVERS.
  const FACE_COLOR = { stop: '#d8332b', jump: '#efe6dc', parking: '#2a6fd0', works: '#ff9a2e' } as const;
  for (const [name, face] of [['signStop', 'stop'], ['signJump', 'jump'], ['signParking', 'parking'], ['signWorks', 'works']] as const) {
    defineKind({
      name, event: 'sign', material: 'prop',
      lods: [{ geo: Mdl.signFace(face), dist: 45, shadow: false }],
      impostor: { shape: 'box', sx: 0.7, sy: 0.7, sz: 0.05, oy: 1.6, oz: 0.075, color: FACE_COLOR[face] },
      cull: 110, phys: 'heavy', mass: 25, surface: 'metal', topple: 7, thin: true, radius: 0.36, height: 2.5,
      colliders: [{ shape: 'cyl', hx: 0.06, hy: 1.25, hz: 0, cx: 0, cy: 1.25, cz: 0 }],
      variant: vary(SIGN, 1, 1),
    });
  }
  defineKind({
    name: 'fuelTruck', event: 'fuelTruck', material: 'prop',
    lods: [{ geo: Mdl.fuelTruck(), dist: 260, shadow: true }],
    cull: 260, phys: 'light', mass: 9000, friction: 0.9, surface: 'metal', radius: 4.1, height: 3.0,
    colliders: [{ shape: 'box', hx: 1.25, hy: 1.4, hz: 4.0, cx: 0, cy: 1.45, cz: 0.2 }],
    variant: vary(TRUCK, 1, 1),
  });
  defineKind({
    name: 'baggageCart', event: 'baggageCart', material: 'prop',
    lods: [{ geo: Mdl.baggageCart(), dist: 200, shadow: true }],
    cull: 200, phys: 'light', mass: 380, surface: 'metal', radius: 1.5, height: 1.9,
    colliders: [{ shape: 'box', hx: 0.78, hy: 0.62, hz: 1.4, cx: 0, cy: 0.9, cz: 0 }],
    variant: vary(CART, 1, 1),
  });
  defineKind({
    name: 'windsock', event: 'windsock', material: 'foliage',
    lods: [{ geo: Mdl.windsock(), dist: 260, shadow: true }],
    cull: 260, phys: 'heavy', mass: 60, surface: 'metal', topple: 12, radius: 0.2, height: 5.8,
    colliders: [{ shape: 'cyl', hx: 0.09, hy: 2.8, hz: 0, cx: 0, cy: 2.8, cz: 0 }],
  });
  // parked cars (geometry may be swapped for the car-models instancing geometry at runtime)
  const MASS: Record<CarModelId, number> = { coupe: 1250, muscle: 1550, hatch: 1100, suv: 1850 };
  for (const model of ['coupe', 'muscle', 'hatch', 'suv'] as CarModelId[]) {
    const d = carSpecDims(model);
    defineKind({
      name: `car:${model}`, event: 'parkedCar', material: 'car', car: model,
      lods: [{ geo: buildFallbackCar(model), dist: 30, shadow: true }],
      cull: 230, phys: 'light', mass: MASS[model], friction: 0.22, surface: 'metal', radius: d.L / 2, height: d.H,
      colliders: [carCollider(d.L, d.W, d.H)],
      carLamps: carLampsFor(d.L, d.W, d.H),
      variant: (_v, out) => {
        out.scale = 1;
        out.tint.setRGB(1, 1, 1);
        out.phase = 0;
      },
    });
  }
}

export function carCollider(L: number, W: number, H: number): ColliderDef {
  return { shape: 'box', hx: W / 2 - 0.03, hy: H / 2 - 0.02, hz: L / 2 - 0.04, cx: 0, cy: H / 2 + 0.01, cz: 0 };
}

export function carLampsFor(L: number, W: number, H: number): { front: number[]; rear: number[]; halfLength: number } {
  return { front: [W / 2 - 0.3, Math.max(0.55, H * 0.46), L / 2], rear: [W / 2 - 0.3, Math.max(0.65, H * 0.55), -L / 2], halfLength: L / 2 };
}

let farCarGeo: THREE.BufferGeometry | null = null;
export function farCarGeometry(): THREE.BufferGeometry {
  return (farCarGeo ??= buildFarCar());
}

/** Shared far impostor geometries. */
let impBox: THREE.BufferGeometry | null = null;
let impCyl: THREE.BufferGeometry | null = null;
export function impostorGeometry(shape: 'box' | 'cyl'): THREE.BufferGeometry {
  if (shape === 'box') return (impBox ??= Mdl.farBox());
  return (impCyl ??= Mdl.farCyl());
}

export function disposeRegistry(): void {
  for (const k of KINDS) for (const l of k.lods) l.geo.dispose();
  KINDS.length = 0;
  BY_NAME.clear();
  farCarGeo?.dispose();
  impBox?.dispose();
  impCyl?.dispose();
  farCarGeo = impBox = impCyl = null;
  built = false;
}
