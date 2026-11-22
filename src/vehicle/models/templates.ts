import * as THREE from 'three';
import type { CarModelId, SpoilerStyle } from '../CarBuild';
import { buildGrid, type BodyGrid } from './BodyGen';
import {
  Surface,
  addAntenna,
  addArchFlares,
  addBays,
  addExhausts,
  addGrille,
  addHandles,
  addInterior,
  addMirror,
  addPlate,
  addRoofRails,
  addRoundLamps,
  addLouvers,
  addDiffuserFins,
  addWipers,
  buildScoop,
  buildSkirts,
  buildSpoiler,
  buildSplitter,
  type PlateInfo,
} from './details';
import { LT, R, REGION_INFO, isPaintRegion, type MeshKey } from './regions';
import { SPECS, type CarSpec } from './specs';
import { GeoAcc, MAT, gray, mtx, type MatCode } from './util';

/**
 * Per-model geometry templates (built lazily, cached forever, shared by every car instance; instances clone the
 * deformable ones). High LOD = separate panels/glass/lamps/trim; low LOD = 1 paint + 1 detail geometry.
 */

export type PanelKey = 'body' | 'hood' | 'trunk' | 'doorL' | 'doorR' | 'bumperF' | 'bumperR';
export const PANELS: PanelKey[] = ['body', 'hood', 'trunk', 'doorL', 'doorR', 'bumperF', 'bumperR'];

export interface KitKey {
  splitter: boolean;
  skirts: boolean;
  spoiler: SpoilerStyle;
  scoop: boolean;
}

export interface HighTemplate {
  spec: CarSpec;
  /** Triangles added to trim by each detail generator (debug). */
  detailTris: Record<string, number>;
  grid: BodyGrid;
  /** 'paint' panels use the paint material; chrome bumpers (muscle) use the trim material. */
  panelKind: Record<PanelKey, 'paint' | 'detail'>;
  panel(key: PanelKey, kit: KitKey): THREE.BufferGeometry;
  spoiler(style: SpoilerStyle): THREE.BufferGeometry | null;
  glass: THREE.BufferGeometry;
  lights: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  /** Plates living in a merged mesh that must be hidden when their host part detaches. */
  plates: { host: PanelKey; mesh: 'trim' | PanelKey; info: PlateInfo }[];
  shadow: THREE.BufferGeometry;
  exhaustPoints: THREE.Vector3[];
  rearCorners: THREE.Vector3[];
  headlightPoints: THREE.Vector3[];
}

export interface LowTemplate {
  spec: CarSpec;
  paint(kit: KitKey): THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
  exhaustPoints: THREE.Vector3[];
  rearCorners: THREE.Vector3[];
  headlightPoints: THREE.Vector3[];
}

const CHROME_MAT: MatCode = MAT.chrome;

function glassUV(x: number, y: number, z: number): [number, number] {
  return [(z + x * 0.4) * 0.8, (y + Math.abs(x) * 0.3) * 0.8];
}

/** Push a region's geometry into an accumulator with the attributes its target mesh needs. */
function pushRegion(acc: GeoAcc, grid: BodyGrid, r: number, opts: { chrome?: boolean; lowDetail?: boolean } = {}): void {
  const rg = grid.regions.get(r);
  if (!rg) return;
  const info = REGION_INFO[r];
  const base = acc.count;
  let color = info.color;
  let mat = info.mat;
  if (opts.chrome) {
    const black = info.color[0] < 0.5;
    color = black ? gray(0.05) : gray(0.92);
    mat = black ? MAT.satin : CHROME_MAT;
  }
  const isGlass = info.mesh === 'glass';
  for (let i = 0; i < rg.pos.length / 3; i++) {
    const x = rg.pos[i * 3], y = rg.pos[i * 3 + 1], z = rg.pos[i * 3 + 2];
    const [u, v] = isGlass && !opts.lowDetail ? glassUV(x, y, z) : [0.75, 0.82];
    acc.vertex(x, y, z, rg.nrm[i * 3], rg.nrm[i * 3 + 1], rg.nrm[i * 3 + 2], color, u, v, mat, info.roof);
  }
  for (let i = 0; i < rg.idx.length; i++) acc.idx.push(rg.idx[i] + base);
}

function countTris(g: THREE.BufferGeometry | null): number {
  if (!g) return 0;
  return g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
}

const highCache = new Map<CarModelId, HighTemplate>();
const lowCache = new Map<CarModelId, LowTemplate>();

export function getHighTemplate(model: CarModelId): HighTemplate {
  let t = highCache.get(model);
  if (!t) highCache.set(model, (t = buildHigh(SPECS[model])));
  return t;
}

export function getLowTemplate(model: CarModelId): LowTemplate {
  let t = lowCache.get(model);
  if (!t) lowCache.set(model, (t = buildLow(SPECS[model])));
  return t;
}

function buildHigh(spec: CarSpec): HighTemplate {
  const grid = buildGrid(spec, 'high');
  const sf = new Surface(spec);
  const chrome = spec.bumperChrome;
  const panelKind: Record<PanelKey, 'paint' | 'detail'> = {
    body: 'paint',
    hood: 'paint',
    trunk: 'paint',
    doorL: 'paint',
    doorR: 'paint',
    bumperF: chrome ? 'detail' : 'paint',
    bumperR: chrome ? 'detail' : 'paint',
  };
  const accs: Record<PanelKey | 'glass' | 'lights' | 'trim', GeoAcc> = {
    body: new GeoAcc(),
    hood: new GeoAcc(),
    trunk: new GeoAcc(),
    doorL: new GeoAcc(),
    doorR: new GeoAcc(),
    bumperF: new GeoAcc(),
    bumperR: new GeoAcc(),
    glass: new GeoAcc(),
    lights: new GeoAcc(),
    trim: new GeoAcc(),
  };
  for (const r of grid.regions.keys()) {
    const mk = REGION_INFO[r].mesh as MeshKey;
    if (mk === 'none') continue;
    const acc = accs[mk as keyof typeof accs];
    pushRegion(acc, grid, r, { chrome: chrome && (mk === 'bumperF' || mk === 'bumperR') });
  }
  // Details.
  const detailTris: Record<string, number> = {};
  let mark = accs.trim.idx.length;
  const tick = (name: string) => {
    detailTris[name] = (accs.trim.idx.length - mark) / 3;
    mark = accs.trim.idx.length;
  };
  tick('regions');
  addUnderPlate(spec, accs.trim);
  addMirror(sf, accs.doorL, accs.doorR);
  addHandles(sf, accs.doorL, accs.doorR);
  addGrille(sf, accs.trim);
  tick('grille');
  const lampPts = addRoundLamps(sf, accs.trim, accs.lights);
  const plates: HighTemplate['plates'] = [];
  {
    const host: PanelKey = 'bumperF';
    const target = chrome ? accs.bumperF : accs.trim;
    plates.push({ host, mesh: chrome ? 'bumperF' : 'trim', info: addPlate(sf, target, true, spec.details.plateFY) });
  }
  {
    const host: PanelKey = spec.details.plateROnTrunk ? 'trunk' : 'bumperR';
    const inPanel = host === 'bumperR' && chrome;
    plates.push({ host, mesh: inPanel ? 'bumperR' : 'trim', info: addPlate(sf, inPanel ? accs.bumperR : accs.trim, false, spec.details.plateRY) });
  }
  tick('lamps+plates');
  const exhaustPoints = addExhausts(sf, accs.trim);
  tick('exhaust');
  addWipers(sf, accs.trim);
  if (spec.details.roofRails) addRoofRails(sf, accs.trim);
  if (spec.id !== 'muscle') addAntenna(sf, accs.trim);
  if (spec.details.archFlares) addArchFlares(sf, accs.trim);
  addLouvers(sf, accs.trim);
  addDiffuserFins(sf, accs.trim);
  tick('misc');
  addInterior(sf, grid, accs.trim);
  tick('interior');
  addBays(grid, accs.trim);
  tick('bays');
  addUnderglowStrips(sf, accs.lights);
  // Plain geometries.
  const geo: Partial<Record<keyof typeof accs, THREE.BufferGeometry>> = {};
  for (const k of ['glass', 'lights', 'trim'] as const) geo[k] = accs[k].toGeometry(k === 'glass' ? 'glass' : 'detail');
  // Panel variants (lazy).
  const cache = new Map<string, THREE.BufferGeometry>();
  const kitPart = new Map<string, THREE.BufferGeometry | null>();
  const getKit = (name: 'splitter' | 'skirts' | 'scoop') => {
    if (!kitPart.has(name)) kitPart.set(name, name === 'splitter' ? buildSplitter(sf, true) : name === 'skirts' ? buildSkirts(sf, true) : buildScoop(sf, true));
    return kitPart.get(name)!;
  };
  const panel = (key: PanelKey, kit: KitKey): THREE.BufferGeometry => {
    const variant = key === 'body' ? (kit.skirts ? 'k' : '') : key === 'hood' ? (kit.scoop ? 'k' : '') : key === 'bumperF' ? (kit.splitter ? 'k' : '') : '';
    const ck = key + variant;
    let g = cache.get(ck);
    if (g) return g;
    const acc = new GeoAcc().append(accs[key]);
    if (variant) {
      const kg = getKit(key === 'body' ? 'skirts' : key === 'hood' ? 'scoop' : 'splitter');
      if (kg) acc.add(kg, { color: key === 'bumperF' ? gray(0.03) : undefined, mat: key === 'bumperF' && chrome ? MAT.satin : MAT.plastic });
    }
    g = acc.toGeometry(panelKind[key]);
    cache.set(ck, g);
    return g;
  };
  const spoilers = new Map<SpoilerStyle, THREE.BufferGeometry | null>();
  const spoiler = (style: SpoilerStyle) => {
    if (!spoilers.has(style)) spoilers.set(style, buildSpoiler(sf, style, true));
    return spoilers.get(style)!;
  };
  const headlightPoints = lampCentres(accs.lights, spec);
  void lampPts;
  const rc = sf.at(spec.zRear + spec.rear.round * 0.6, 11);
  const rearCorners = [new THREE.Vector3(rc.x, rc.y, rc.z), new THREE.Vector3(-rc.x, rc.y, rc.z)];
  const shadow = buildShadowProxy(spec);
  const t: HighTemplate = {
    spec,
    detailTris,
    grid,
    panelKind,
    panel,
    spoiler,
    glass: geo.glass!,
    lights: geo.lights!,
    trim: geo.trim!,
    plates,
    shadow,
    exhaustPoints,
    rearCorners,
    headlightPoints,
  };
  return t;
}

/** Flat underbody plate (the loft's centre floor rows are skipped at high LOD). */
function addUnderPlate(spec: CarSpec, trim: GeoAcc): void {
  const z0 = spec.axleR - 0.25;
  const z1 = spec.axleF + 0.25;
  let y = Infinity;
  for (let k = 0; k <= 8; k++) y = Math.min(y, spec.sill(z0 + ((z1 - z0) * k) / 8) - spec.floorDrop);
  y += 0.002;
  const w = spec.halfTrack - spec.wheelW * 0.5 - 0.045;
  const a = trim.vertex(w, y, z0, 0, -1, 0, gray(0.04));
  const b = trim.vertex(-w, y, z0, 0, -1, 0, gray(0.04));
  const c = trim.vertex(-w, y, z1, 0, -1, 0, gray(0.04));
  const d = trim.vertex(w, y, z1, 0, -1, 0, gray(0.04));
  trim.tri(a, c, b);
  trim.tri(a, d, c);
}

/** Average position of HEAD lamp vertices per side (left, right). */
function lampCentres(L: GeoAcc, spec: CarSpec): THREE.Vector3[] {
  const sum = [new THREE.Vector3(), new THREE.Vector3()];
  const n = [0, 0];
  for (let i = 0; i < L.count; i++) {
    if (Math.round(L.mat[i * 4 + 3]) !== LT.HEAD) continue;
    const side = L.pos[i * 3] >= 0 ? 0 : 1;
    sum[side].x += L.pos[i * 3];
    sum[side].y += L.pos[i * 3 + 1];
    sum[side].z += L.pos[i * 3 + 2];
    n[side]++;
  }
  return [0, 1].map((s) => (n[s] ? sum[s].multiplyScalar(1 / n[s]) : new THREE.Vector3(s ? -0.6 : 0.6, 0.65, spec.zFront)));
}

/** Thin emissive neon strips under the sills (underglow light type). */
function addUnderglowStrips(sf: Surface, lights: GeoAcc): void {
  const s = sf.s;
  const len = (s.axleF - s.axleR) * 0.55;
  const box = new THREE.BoxGeometry(0.02, 0.012, len);
  const p = sf.at((s.axleF + s.axleR) / 2, 3);
  for (const side of [1, -1]) lights.add(box, { matrix: mtx(side * (p.x - 0.03), p.y - 0.008, (s.axleF + s.axleR) / 2), color: gray(0.05), mat: [0, 0.4, 0, LT.UNDERGLOW] });
  box.dispose();
}

function buildLow(spec: CarSpec): LowTemplate {
  const grid = buildGrid(spec, 'low');
  const sf = new Surface(spec);
  const paintAcc = new GeoAcc();
  const detailAcc = new GeoAcc();
  for (const r of grid.regions.keys()) {
    const info = REGION_INFO[r];
    if (info.mesh === 'none') continue;
    const toPaint = info.mesh !== 'glass' && info.mesh !== 'lights' && info.mesh !== 'trim' && !((info.mesh === 'bumperF' || info.mesh === 'bumperR') && spec.bumperChrome);
    pushRegion(toPaint ? paintAcc : detailAcc, grid, r, { chrome: spec.bumperChrome && (info.mesh === 'bumperF' || info.mesh === 'bumperR'), lowDetail: true });
  }
  // A couple of cheap details so the silhouette reads: mirrors (paint), exhaust (detail).
  const mL = new GeoAcc();
  const mR = new GeoAcc();
  addMirror(sf, mL, mR);
  paintAcc.append(mL).append(mR);
  const exhaustPoints = addExhausts(sf, detailAcc);
  const detail = detailAcc.toGeometry('detail');
  const headlightPoints = lampCentres(detailAcc, spec);
  const rc = sf.at(spec.zRear + spec.rear.round * 0.6, 11);
  const rearCorners = [new THREE.Vector3(rc.x, rc.y, rc.z), new THREE.Vector3(-rc.x, rc.y, rc.z)];
  const cache = new Map<string, THREE.BufferGeometry>();
  const parts = new Map<string, THREE.BufferGeometry | null>();
  const part = (k: string, f: () => THREE.BufferGeometry | null) => {
    if (!parts.has(k)) parts.set(k, f());
    return parts.get(k)!;
  };
  return {
    spec,
    detail,
    exhaustPoints,
    rearCorners,
    headlightPoints,
    paint(kit: KitKey) {
      const key = `${+kit.splitter}${+kit.skirts}${+kit.scoop}${kit.spoiler}`;
      let g = cache.get(key);
      if (g) return g;
      const acc = new GeoAcc().append(paintAcc);
      if (kit.splitter) acc.add(part('splitter', () => buildSplitter(sf, false))!, { color: gray(0.03) });
      if (kit.skirts) acc.add(part('skirts', () => buildSkirts(sf, false))!);
      if (kit.scoop) acc.add(part('scoop', () => buildScoop(sf, false))!);
      const sp = part('spoiler' + kit.spoiler, () => buildSpoiler(sf, kit.spoiler, false));
      if (sp) acc.add(sp);
      g = acc.toGeometry('paint');
      cache.set(key, g);
      return g;
    },
  };
}

/** Low-poly hull (inset ~3 %) + wheel blocks, used only to cast the car's shadow cheaply. */
function buildShadowProxy(spec: CarSpec): THREE.BufferGeometry {
  const grid = buildGrid(spec, 'low');
  const acc = new GeoAcc();
  for (const r of grid.regions.keys()) {
    if (r === R.UNDER) continue;
    pushRegion(acc, grid, r, { lowDetail: true });
  }
  const yc = spec.belt(0) * 0.6;
  for (let i = 0; i < acc.count; i++) {
    acc.pos[i * 3] *= 0.965;
    acc.pos[i * 3 + 1] = yc + (acc.pos[i * 3 + 1] - yc) * 0.965;
    acc.pos[i * 3 + 2] *= 0.985;
  }
  const cyl = new THREE.CylinderGeometry(spec.wheelR * 0.95, spec.wheelR * 0.95, spec.wheelW * 0.9, 8).rotateZ(Math.PI / 2);
  for (const [x, z] of [
    [spec.halfTrack, spec.axleF],
    [-spec.halfTrack, spec.axleF],
    [spec.halfTrack, spec.axleR],
    [-spec.halfTrack, spec.axleR],
  ])
    acc.add(cyl, { matrix: mtx(x, spec.wheelR, z) });
  cyl.dispose();
  return acc.toGeometry('plain');
}

/** Template triangle statistics (for debugging/verification). */
export function templateStats(model: CarModelId): Record<string, number> {
  const t = getHighTemplate(model);
  const kit: KitKey = { splitter: false, skirts: false, spoiler: 'none', scoop: false };
  const out: Record<string, number> = {};
  for (const k of PANELS) out[k] = countTris(t.panel(k, kit));
  out.glass = countTris(t.glass);
  out.lights = countTris(t.lights);
  out.trim = countTris(t.trim);
  out.shadow = countTris(t.shadow);
  for (const [k, v] of Object.entries(t.detailTris)) out['d_' + k] = v;
  const lt = getLowTemplate(model);
  out.lowPaint = countTris(lt.paint(kit));
  out.lowDetail = countTris(lt.detail);
  return out;
}

export { isPaintRegion };

// ───────────────────────────── instancing (parked / traffic cars) ─────────────────────────────

const instCache = new Map<CarModelId, THREE.BufferGeometry>();
const beamCache = new Map<CarModelId, THREE.BufferGeometry>();

/**
 * One merged non-indexed geometry for instanced parked cars: body + glass + lamps + trim + 4 static wheels.
 * Attributes: position, normal, color (linear, baked) and paintMask: 1 = body paint (tint per instance),
 * 0.5 = glass, 0.25 = lamp lens (colour baked: warm white front, red rear → make emissive at night), 0 = other.
 */
export function getInstancingGeometry(model: CarModelId): THREE.BufferGeometry {
  let g = instCache.get(model);
  if (g) return g;
  const spec = SPECS[model];
  const grid = buildGrid(spec, 'low');
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const mask: number[] = [];
  for (const [r, rg] of grid.regions) {
    const info = REGION_INFO[r];
    if (info.mesh === 'none') continue;
    const chromeBumper = spec.bumperChrome && (r === R.BUMPER_F || r === R.BUMPER_R);
    let m = 0;
    let color: readonly number[] = info.color;
    if (isPaintRegion(r) && !chromeBumper) {
      m = 1;
      color = [1, 1, 1];
    } else if (info.mesh === 'glass') {
      m = 0.5;
      color = [0.05, 0.06, 0.07];
    } else if (info.mesh === 'lights') {
      const type = info.mat[3];
      const front = type === LT.HEAD || type === LT.DRL;
      m = front || type === LT.TAIL || type === LT.BRAKE ? 0.25 : 0;
      color = front ? [1, 0.95, 0.85] : info.color;
    } else if (chromeBumper) color = info.color[0] < 0.5 ? [0.05, 0.05, 0.05] : [0.75, 0.75, 0.78];
    for (let i = 0; i < rg.idx.length; i++) {
      const v = rg.idx[i];
      pos.push(rg.pos[v * 3], rg.pos[v * 3 + 1], rg.pos[v * 3 + 2]);
      nrm.push(rg.nrm[v * 3], rg.nrm[v * 3 + 1], rg.nrm[v * 3 + 2]);
      col.push(color[0], color[1], color[2]);
      mask.push(m);
    }
  }
  // static wheels
  const R0 = spec.wheelR;
  const wheel = new GeoAcc();
  const tyre = new THREE.CylinderGeometry(R0, R0, spec.wheelW, 12, 1).rotateZ(Math.PI / 2);
  wheel.add(tyre, { color: gray(0.06) });
  tyre.dispose();
  const hub = new THREE.CylinderGeometry(R0 * 0.62, R0 * 0.55, 0.02, 10).rotateZ(Math.PI / 2);
  wheel.add(hub, { matrix: mtx(spec.wheelW / 2 + 0.002, 0, 0), color: gray(0.6) });
  hub.dispose();
  const wg = wheel.toGeometry('detail');
  const wp = wg.getAttribute('position').array as Float32Array;
  const wn = wg.getAttribute('normal').array as Float32Array;
  const wc = wg.getAttribute('color').array as Float32Array;
  const wi = wg.getIndex()!.array;
  for (const [x, z] of [
    [spec.halfTrack, spec.axleF],
    [-spec.halfTrack, spec.axleF],
    [spec.halfTrack, spec.axleR],
    [-spec.halfTrack, spec.axleR],
  ]) {
    const sx = x < 0 ? -1 : 1;
    for (let i = 0; i < wi.length; i += 3) {
      const tri = sx < 0 ? [wi[i], wi[i + 2], wi[i + 1]] : [wi[i], wi[i + 1], wi[i + 2]];
      for (const v of tri) {
        pos.push(wp[v * 3] * sx + x, wp[v * 3 + 1] + R0, wp[v * 3 + 2] + z);
        nrm.push(wn[v * 3] * sx, wn[v * 3 + 1], wn[v * 3 + 2]);
        col.push(wc[v * 3], wc[v * 3 + 1], wc[v * 3 + 2]);
        mask.push(0);
      }
    }
  }
  wg.dispose();
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('paintMask', new THREE.Float32BufferAttribute(mask, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  instCache.set(model, g);
  return g;
}

/**
 * Fake headlight beams for night traffic/parked cars (optional companion of the instancing geometry): a flat
 * ground fan + two crossed soft cone cards per lamp. Non-indexed; attributes position, normal, color (pre-faded
 * intensity, black = transparent) — render additive, depthWrite off, colour × headlight tint × night factor.
 */
export function getBeamGeometry(model: CarModelId): THREE.BufferGeometry {
  let g = beamCache.get(model);
  if (g) return g;
  const spec = SPECS[model];
  const lamps = getLowTemplate(model).headlightPoints;
  const pos: number[] = [];
  const col: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], ia: number, ib: number) => {
    const pts: [number[], number][] = [
      [a, ia],
      [b, ia],
      [c, ib],
      [a, ia],
      [c, ib],
      [d, ib],
    ];
    for (const [p, i] of pts) {
      pos.push(p[0], p[1], p[2]);
      col.push(i, i * 0.95, i * 0.85);
    }
  };
  const L = 7;
  for (const l of lamps) {
    const x = l.x;
    const z0 = spec.zFront + 0.1;
    quad([x - 0.25, 0.03, z0], [x + 0.25, 0.03, z0], [x + 1.6, 0.03, z0 + L], [x - 1.6, 0.03, z0 + L], 0.5, 0);
    quad([x, l.y + 0.04, l.z + 0.05], [x, l.y - 0.04, l.z + 0.05], [x, 0.05, l.z + L * 0.7], [x, l.y + 0.6, l.z + L * 0.7], 0.35, 0);
    quad([x - 0.04, l.y, l.z + 0.05], [x + 0.04, l.y, l.z + 0.05], [x + 1.1, l.y - 0.1, l.z + L * 0.7], [x - 1.1, l.y - 0.1, l.z + L * 0.7], 0.3, 0);
  }
  g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  beamCache.set(model, g);
  return g;
}
