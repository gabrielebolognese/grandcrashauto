import * as THREE from 'three';
import type { GameContext, IPlaneFactory, PlaneModelInfo } from '../../game/contracts';
import type {
  BreakJoint, PlaneBreakModes, PlaneEngineInfo, PlaneGearInfo, PlaneInstruments, PlanePartInfo, PlanePartKind, PlaneTypeId, PlaneVisual,
} from '../types';
import { CONFIG } from '../../config';

/**
 * STUB — boxy placeholder planes with the FULL part / joint / engine / gear structure, so the flight and breakup
 * modules can be developed against it. Replaced by the planemodels module (keep the same part names & semantics).
 */

interface StubSpec {
  length: number;
  span: number;
  height: number;
  r: number; // fuselage half-width
  wingY: number; // wing vertical offset from fuselage axis
  chord: number;
  segs: 2 | 3;
  tTail: boolean;
  engines: { x: number; y: number; z: number; prop: boolean; mount: string }[];
  gearTrack: number;
  gearLen: number;
  wheelR: number;
}

const SPECS: Record<PlaneTypeId, StubSpec> = {
  prop: { length: 8, span: 11, height: 2.7, r: 0.6, wingY: 0.75, chord: 1.5, segs: 2, tTail: false,
    engines: [{ x: 0, y: 0, z: 3.7, prop: true, mount: 'cockpit' }], gearTrack: 2.4, gearLen: 0.9, wheelR: 0.3 },
  bizjet: { length: 18, span: 16, height: 5.5, r: 1.0, wingY: -0.6, chord: 2.6, segs: 2, tTail: true,
    engines: [{ x: 1.7, y: 0.5, z: -5.2, prop: false, mount: 'fuselageRear' }, { x: -1.7, y: 0.5, z: -5.2, prop: false, mount: 'fuselageRear' }],
    gearTrack: 3, gearLen: 1.2, wheelR: 0.4 },
  airliner: { length: 38, span: 35, height: 12, r: 2.0, wingY: -1.3, chord: 5, segs: 3, tTail: false,
    engines: [{ x: 5.8, y: -2.4, z: 2.2, prop: false, mount: 'wingL1' }, { x: -5.8, y: -2.4, z: 2.2, prop: false, mount: 'wingR1' }],
    gearTrack: 7.4, gearLen: 2.2, wheelR: 0.6 },
  jumbo: { length: 70, span: 64, height: 19, r: 3.2, wingY: -2.0, chord: 9, segs: 3, tTail: false,
    engines: [
      { x: 21, y: -3.6, z: -1.5, prop: false, mount: 'wingL2' }, { x: 11.5, y: -4, z: 3, prop: false, mount: 'wingL1' },
      { x: -11.5, y: -4, z: 3, prop: false, mount: 'wingR1' }, { x: -21, y: -3.6, z: -1.5, prop: false, mount: 'wingR2' },
    ], gearTrack: 11, gearLen: 3.6, wheelR: 0.75 },
};

const NAMES: Record<PlaneTypeId, PlaneModelInfo> = {
  prop: { type: 'prop', name: 'Prop', livery: 'Stub', description: 'Light prop plane' },
  bizjet: { type: 'bizjet', name: 'Bizjet', livery: 'Stub', description: 'Private jet' },
  airliner: { type: 'airliner', name: 'Airliner', livery: 'Stub', description: 'Narrow-body airliner' },
  jumbo: { type: 'jumbo', name: 'Jumbo', livery: 'Stub', description: 'Four-engine jumbo jet' },
};

export class PlaneFactory implements IPlaneFactory {
  readonly name = 'planeModels';
  readonly models: PlaneModelInfo[] = Object.values(NAMES);
  constructor(private ctx: GameContext) {}
  init(): void {}

  create(type: PlaneTypeId): PlaneVisual {
    return buildStub(type);
  }
}

function buildStub(type: PlaneTypeId): PlaneVisual {
  const S = SPECS[type];
  const totalMass = CONFIG.planes[type].mass;
  const root = new THREE.Group();
  root.name = `plane-${type}`;
  const L = S.length;
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.5, metalness: 0.2 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xff7a6b, roughness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x333840, roughness: 0.7 });
  const capMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1, side: THREE.DoubleSide });
  const mats = [bodyMat, accentMat, darkMat, capMat];

  type Raw = { name: string; kind: PlanePartKind; c: THREE.Vector3; h: THREE.Vector3; w: number; fuel: number; mat: THREE.Material };
  const raw: Raw[] = [];
  const add = (name: string, kind: PlanePartKind, c: [number, number, number], h: [number, number, number], w: number, fuel = 0, mat: THREE.Material = bodyMat) =>
    raw.push({ name, kind, c: new THREE.Vector3(...c), h: new THREE.Vector3(...h), w, fuel, mat });

  // Fuselage split along Z (nose at +Z).
  const seg = [0.1, 0.1, 0.2, 0.2, 0.2, 0.2]; // nose, cockpit, fwd, center, rear, tailCone
  const fusNames = ['nose', 'cockpit', 'fuselageFwd', 'fuselageCenter', 'fuselageRear', 'tailCone'];
  let z = L / 2;
  const fusZ: Record<string, number> = {};
  fusNames.forEach((n, i) => {
    const len = seg[i] * L;
    const cz = z - len / 2;
    fusZ[n] = cz;
    const taper = n === 'nose' ? 0.7 : n === 'tailCone' ? 0.6 : 1;
    add(n, n === 'cockpit' ? 'cockpit' : 'fuselage', [0, 0, cz], [S.r * taper, S.r * taper, len / 2], n === 'fuselageCenter' ? 2.2 : 1.2, n === 'fuselageCenter' ? 0.3 : 0, n === 'cockpit' ? accentMat : bodyMat);
    z -= len;
  });
  const centerZ = fusZ.fuselageCenter;
  // Wings: segments from root to tip on each side. LEFT wing = +X.
  const half = S.span / 2;
  const segLen = (half - S.r) / S.segs;
  for (const side of [1, -1]) {
    for (let i = 0; i < S.segs; i++) {
      const name = `wing${side > 0 ? 'L' : 'R'}${i + 1}`;
      const cx = side * (S.r + segLen * (i + 0.5));
      const chord = S.chord * (1 - i * 0.25);
      add(name, 'wing', [cx, S.wingY, centerZ - i * S.chord * 0.15], [segLen / 2, S.chord * 0.06 + 0.05, chord / 2], 1.6 - i * 0.4, 0.35 / (S.segs * 2) * (S.segs - i));
    }
  }
  // Tail.
  const tz = fusZ.tailCone;
  const finH = S.height * 0.42;
  const finY = S.r + finH / 2;
  add('fin', 'tail', [0, finY, tz - L * 0.03], [0.12 + S.r * 0.05, finH / 2, L * 0.07], 0.35, 0, accentMat);
  const tpY = S.tTail ? S.r + finH * 0.95 : 0.2 * S.r;
  const tpSpan = S.span * 0.18;
  for (const side of [1, -1]) {
    add(`tailplane${side > 0 ? 'L' : 'R'}`, 'tail', [side * (S.tTail ? tpSpan / 2 : S.r + tpSpan / 2), tpY, tz - L * 0.04], [tpSpan / 2, 0.08 + S.r * 0.03, L * 0.045], 0.2);
  }
  // Engines.
  S.engines.forEach((e, i) => {
    const er = e.prop ? S.r * 0.75 : S.r * (type === 'jumbo' ? 0.42 : 0.5);
    add(`engine${i + 1}`, 'engine', [e.x, e.y, e.z], [er, er, e.prop ? 0.35 : er * 2], 1.4, 0.02, darkMat);
  });
  // Gear (tricycle).
  const gy = -S.r - S.gearLen / 2;
  add('gearNose', 'gear', [0, gy, fusZ.cockpit], [0.15, S.gearLen / 2, 0.15], 0.15, 0, darkMat);
  add('gearL', 'gear', [S.gearTrack / 2, gy, centerZ - S.chord * 0.2], [0.18, S.gearLen / 2, 0.2], 0.25, 0, darkMat);
  add('gearR', 'gear', [-S.gearTrack / 2, gy, centerZ - S.chord * 0.2], [0.18, S.gearLen / 2, 0.2], 0.25, 0, darkMat);

  // Mass distribution: weights → kg, centre of mass → root origin.
  const wsum = raw.reduce((a, r) => a + r.w * r.h.x * r.h.y * r.h.z, 0);
  const com = new THREE.Vector3();
  const masses = raw.map((r) => (totalMass * r.w * r.h.x * r.h.y * r.h.z) / wsum);
  raw.forEach((r, i) => com.addScaledVector(r.c, masses[i] / totalMass));

  const parts: PlanePartInfo[] = [];
  const partByName: Record<string, PlanePartInfo> = {};
  const inertia = new THREE.Vector3();
  const fuelTotal = CONFIG.planes[type].fuelKg;
  const fuelW = raw.reduce((a, r) => a + r.fuel, 0) || 1;
  raw.forEach((r, i) => {
    const c = r.c.clone().sub(com);
    const obj = new THREE.Group();
    obj.name = r.name;
    obj.position.copy(c);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(r.h.x * 2, r.h.y * 2, r.h.z * 2), r.mat);
    mesh.castShadow = true;
    obj.add(mesh);
    if (r.name === 'engine1' && S.engines[0].prop) {
      const prop = new THREE.Mesh(new THREE.BoxGeometry(S.r * 2.6, 0.12, 0.05), darkMat);
      prop.name = 'propeller';
      prop.position.z = r.h.z + 0.05;
      obj.add(prop);
    }
    root.add(obj);
    const m = masses[i];
    const info: PlanePartInfo = {
      name: r.name, kind: r.kind, object: obj, mass: m, com: c.clone(), boxCenter: c.clone(), halfExtents: r.h.clone(),
      fuelKg: (fuelTotal * r.fuel) / fuelW,
      cdA: 1.1 * Math.max(r.h.x * r.h.y, r.h.y * r.h.z, r.h.x * r.h.z) * 4 * 0.5,
      cpOffset: new THREE.Vector3(0, 0, -0.15 * r.h.z),
      liftArea: r.kind === 'wing' || r.kind === 'tail' ? r.h.x * r.h.z * 4 : undefined,
    };
    parts.push(info);
    partByName[r.name] = info;
    const hx = r.h.x * 2, hy = r.h.y * 2, hz = r.h.z * 2;
    inertia.x += (m * (hy * hy + hz * hz)) / 12 + m * (c.y * c.y + c.z * c.z);
    inertia.y += (m * (hx * hx + hz * hz)) / 12 + m * (c.x * c.x + c.z * c.z);
    inertia.z += (m * (hx * hx + hy * hy)) / 12 + m * (c.x * c.x + c.y * c.y);
  });

  // Joints.
  const joints: BreakJoint[] = [];
  const joint = (a: string, b: string, strength: number) => {
    const pa = partByName[a], pb = partByName[b];
    if (!pa || !pb) return;
    const position = pa.com.clone().add(pb.com).multiplyScalar(0.5);
    const normal = pb.com.clone().sub(pa.com).normalize();
    const mk = (parent: THREE.Object3D) => {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(S.r * 1.6, S.r * 1.6, 0.05), capMat);
      cap.visible = false;
      cap.position.copy(position).sub(parent.position);
      cap.lookAt(cap.position.clone().add(normal));
      parent.add(cap);
      return cap;
    };
    joints.push({ id: `${a}|${b}`, a, b, position, normal, strength, capA: mk(pa.object), capB: mk(pb.object) });
  };
  for (let i = 0; i < fusNames.length - 1; i++) joint(fusNames[i], fusNames[i + 1], fusNames[i] === 'fuselageFwd' ? 0.8 : 1);
  for (const sd of ['L', 'R']) {
    joint('fuselageCenter', `wing${sd}1`, 1.6);
    for (let i = 1; i < S.segs; i++) joint(`wing${sd}${i}`, `wing${sd}${i + 1}`, 1 - i * 0.2);
    joint(S.tTail ? 'fin' : 'tailCone', `tailplane${sd}`, 0.6);
  }
  joint('tailCone', 'fin', 0.7);
  const engineMount: Record<number, string> = {};
  S.engines.forEach((e, i) => {
    joint(e.mount, `engine${i + 1}`, 0.9);
    engineMount[i + 1] = `${e.mount}|engine${i + 1}`;
  });
  joint('cockpit', 'gearNose', 0.5);
  joint('fuselageCenter', 'gearL', 0.6);
  joint('fuselageCenter', 'gearR', 0.6);

  const breakModes: PlaneBreakModes = {
    middle: ['fuselageFwd|fuselageCenter'],
    tailRequired: ['tailCone|fin'],
    tailOptional: S.tTail ? [] : ['tailCone|tailplaneL', 'tailCone|tailplaneR'],
    engineMount,
  };
  const engines: PlaneEngineInfo[] = S.engines.map((e, i) => {
    const p = partByName[`engine${i + 1}`];
    return {
      index: i + 1, part: p.name, thrustPoint: p.com.clone(), exhaustPoint: p.com.clone().add(new THREE.Vector3(0, 0, -p.halfExtents.z)),
      radius: p.halfExtents.x, propeller: e.prop,
    };
  });
  const gear: PlaneGearInfo[] = ['gearNose', 'gearL', 'gearR'].map((n) => {
    const p = partByName[n];
    return { name: n, wheel: p.com.clone().add(new THREE.Vector3(0, -p.halfExtents.y, 0)), radius: S.wheelR, steerable: n === 'gearNose' };
  });

  const original = new Map<THREE.Object3D, { pos: THREE.Vector3; quat: THREE.Quaternion }>();
  for (const p of parts) original.set(p.object, { pos: p.object.position.clone(), quat: p.object.quaternion.clone() });
  const charred = new THREE.Color(0x151515);
  const partMats = new Map<string, THREE.MeshStandardMaterial>();
  const getMat = (part: PlanePartInfo) => {
    let m = partMats.get(part.name);
    if (!m) {
      const mesh = part.object.children[0] as THREE.Mesh;
      m = (mesh.material as THREE.MeshStandardMaterial).clone();
      mats.push(m);
      mesh.material = m;
      partMats.set(part.name, m);
    }
    return m;
  };
  const baseColor = new Map<string, THREE.Color>();
  const prop = root.getObjectByName('propeller');

  const visual: PlaneVisual = {
    type, root, parts, partByName, joints, breakModes, engines, gear, mass: totalMass, inertia,
    dims: { length: S.length, span: S.span, height: S.height },
    boardPoint: new THREE.Vector3(S.r + 2.5, -S.r - S.gearLen, fusZ.cockpit - com.z - S.length * 0.05),
    cockpitEye: new THREE.Vector3(0, S.r * 0.45, fusZ.cockpit - com.z + S.length * 0.03),
    wingCam: {
      position: new THREE.Vector3(S.r * 1.2, S.r * 0.6, centerZ - com.z - S.chord * 0.3),
      target: engines[0].thrustPoint.clone(),
    },
    name: NAMES[type].name,
    livery: NAMES[type].livery,
    setControls(c) {
      if (prop && c.propAngle) prop.rotation.z = c.propAngle[0] ?? 0;
    },
    setEngineDamaged(index, damaged) {
      const p = partByName[`engine${index}`];
      if (!p) return;
      getMat(p).color.set(damaged ? 0x111111 : 0x333840);
    },
    setLights() {},
    setInstruments(_i: PlaneInstruments) {},
    showBreak(id) {
      const j = joints.find((x) => x.id === id);
      if (j?.capA) j.capA.visible = true;
      if (j?.capB) j.capB.visible = true;
    },
    setCharred(name, amount) {
      const targets = name === '*' ? parts : parts.filter((p) => p.name === name);
      for (const p of targets) {
        const m = getMat(p);
        if (!baseColor.has(p.name)) baseColor.set(p.name, m.color.clone());
        m.color.copy(baseColor.get(p.name)!).lerp(charred, amount);
      }
    },
    setLod() {},
    repair() {
      for (const p of parts) {
        const o = original.get(p.object)!;
        root.add(p.object);
        p.object.position.copy(o.pos);
        p.object.quaternion.copy(o.quat);
        p.object.visible = true;
        const m = partMats.get(p.name);
        if (m && baseColor.has(p.name)) m.color.copy(baseColor.get(p.name)!);
      }
      for (const j of joints) {
        if (j.capA) j.capA.visible = false;
        if (j.capB) j.capB.visible = false;
      }
      S.engines.forEach((_, i) => visual.setEngineDamaged(i + 1, false));
    },
    update() {},
    dispose() {
      root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const m of mats) m.dispose();
    },
  };
  return visual;
}
