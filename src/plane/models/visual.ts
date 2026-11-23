import * as THREE from 'three';
import type {
  BreakJoint, PlaneBreakModes, PlaneCabin, PlaneEngineInfo, PlaneGearInfo, PlaneInstruments, PlanePartInfo, PlaneTypeId, PlaneVisual,
} from '../types';
import { CONFIG } from '../../config';
import type { PlaneTemplate, SurfRec } from './template';
import { createPlaneMaterials, createGlowMaterial, type PlaneMaterials, type GlowUniforms } from './material';
import { getAtlas } from './atlas';
import { InstrumentPanel, blankPanelTexture } from './instruments';

/**
 * One plane instance. Geometry is shared (template); per instance: the plane materials (one program for all planes,
 * per-instance uniforms), light glow material, instrument canvas, prop blur disc. Parts are Groups (position = part
 * centre of mass, identity rotation) holding one Mesh each (LOD geometry swapped in place); caps and the cabin
 * interior are hidden children. LOD 2 on an intact plane draws ONE merged mesh instead of the parts.
 */

interface PartRT {
  info: PlanePartInfo;
  tpl: PlaneTemplate['parts'][number];
  mesh: THREE.Mesh;
  interior: THREE.Mesh | null;
  glow: THREE.Mesh | null;
  capsShown: number;
}

const _v = new THREE.Vector3();

export class PlaneVisualImpl implements PlaneVisual {
  readonly type: PlaneTypeId;
  readonly root = new THREE.Group();
  readonly parts: PlanePartInfo[] = [];
  readonly partByName: Record<string, PlanePartInfo> = {};
  readonly joints: BreakJoint[] = [];
  readonly breakModes: PlaneBreakModes;
  readonly engines: PlaneEngineInfo[];
  readonly gear: PlaneGearInfo[];
  readonly mass: number;
  readonly inertia: THREE.Vector3;
  readonly dims: { length: number; span: number; height: number };
  readonly boardPoint: THREE.Vector3;
  readonly cockpitEye: THREE.Vector3;
  readonly wingCam: { position: THREE.Vector3; target: THREE.Vector3 };
  readonly name: string;
  readonly cabin: PlaneCabin | null;
  readonly livery: string;

  private mats: PlaneMaterials;
  private glowMat: THREE.ShaderMaterial;
  private glowU: GlowUniforms;
  private rt: PartRT[] = [];
  private rtByName = new Map<string, PartRT>();
  private merged: THREE.Mesh;
  private glowRoot: THREE.Mesh;
  private instrMesh: THREE.Mesh;
  private instrMat: THREE.MeshBasicMaterial;
  private panel: InstrumentPanel | null = null;
  private instr: PlaneInstruments | null = null;
  private instrDirty = false;
  private instrTimer = 0;
  private propDisc: THREE.Mesh | null = null;
  private propDiscMat: THREE.MeshBasicMaterial | null = null;
  private lod: 0 | 1 | 2 = 0;
  private broken = false;
  private time = 0;
  private surf: SurfRec[];
  private lastProp: number[] = [];
  private propDelta: number[] = [];
  private propGiven: boolean[] = [];
  private fanAuto: number[] = [];
  private damaged: boolean[] = [false, false, false, false];
  private blur = 0;
  private lightsOn = { nav: false, strobe: false, beacon: false, landing: false };
  private appliedMode = '';
  private original = new Map<THREE.Object3D, { pos: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }>();
  private disposed = false;

  constructor(private tpl: PlaneTemplate) {
    const D = tpl.design;
    this.type = tpl.type;
    this.name = D.name;
    this.livery = D.livery;
    this.cabin = tpl.cabin;
    this.root.name = `plane-${tpl.type}`;
    this.mass = tpl.mass;
    this.inertia = tpl.inertia.clone();
    this.dims = { ...tpl.dims };
    this.boardPoint = tpl.boardPoint.clone();
    this.cockpitEye = tpl.cockpitEye.clone();
    this.wingCam = { position: tpl.wingCam.position.clone(), target: tpl.wingCam.target.clone() };
    this.breakModes = { middle: [...tpl.breakModes.middle], tailRequired: [...tpl.breakModes.tailRequired], tailOptional: [...tpl.breakModes.tailOptional], engineMount: { ...tpl.breakModes.engineMount } };
    this.engines = tpl.engines.map((e) => ({ ...e, thrustPoint: e.thrustPoint.clone(), exhaustPoint: e.exhaustPoint.clone() }));
    this.gear = tpl.gear.map((g) => ({ ...g, wheel: g.wheel.clone() }));
    this.surf = tpl.surfaces;
    this.mats = createPlaneMaterials(getAtlas(), tpl.win);
    const U = this.mats.uniforms;
    for (const s of this.surf) {
      U.uSurfA.value[s.id].set(s.axis.x, s.axis.y, s.axis.z, 0);
      U.uSurfP.value[s.id].set(s.pivot.x, s.pivot.y, s.pivot.z, 0);
    }
    const glow = createGlowMaterial();
    this.glowMat = glow.mat;
    this.glowU = glow.uniforms;

    for (const p of tpl.parts) {
      U.uPartOff.value[p.index].set(p.offset.x, p.offset.y, p.offset.z, 0);
      const obj = new THREE.Group();
      obj.name = p.name;
      obj.position.copy(p.offset);
      const mesh = new THREE.Mesh(p.geo[0], this.mats.main);
      mesh.name = `${p.name}-mesh`;
      mesh.customDepthMaterial = this.mats.depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      obj.add(mesh);
      let interior: THREE.Mesh | null = null;
      if (p.interior) {
        interior = new THREE.Mesh(p.interior, this.mats.main);
        interior.name = `${p.name}-interior`;
        interior.visible = !!p.interiorAlways;
        obj.add(interior);
      }
      this.root.add(obj);
      const info: PlanePartInfo = {
        name: p.name, kind: p.kind, object: obj, mass: p.mass, com: p.com.clone(), boxCenter: p.boxCenter.clone(), halfExtents: p.halfExtents.clone(),
        fuelKg: p.fuelKg, cdA: p.cdA, cpOffset: p.cpOffset.clone(), liftArea: p.liftArea,
      };
      this.parts.push(info);
      this.partByName[p.name] = info;
      const r: PartRT = { info, tpl: p, mesh, interior, glow: null, capsShown: 0 };
      this.rt.push(r);
      this.rtByName.set(p.name, r);
      this.original.set(obj, { pos: obj.position.clone(), quat: obj.quaternion.clone(), scale: obj.scale.clone() });
    }
    for (const j of tpl.joints) {
      const mk = (partName: string, geo: THREE.BufferGeometry, tag: string) => {
        const m = new THREE.Mesh(geo, this.mats.main);
        m.name = `cap-${j.id}-${tag}`;
        m.visible = false;
        this.rtByName.get(partName)!.info.object.add(m);
        return m;
      };
      this.joints.push({ id: j.id, a: j.a, b: j.b, position: j.position.clone(), normal: j.normal.clone(), strength: j.strength, capA: mk(j.a, j.capA, 'a'), capB: mk(j.b, j.capB, 'b') });
    }
    // merged LOD 2
    this.merged = new THREE.Mesh(tpl.merged, this.mats.merged);
    this.merged.name = 'plane-lod2';
    this.merged.customDepthMaterial = this.mats.depthMerged;
    this.merged.castShadow = true;
    this.merged.visible = false;
    this.root.add(this.merged);
    // light glows (intact: one mesh on the root)
    this.glowRoot = new THREE.Mesh(tpl.glowAll, this.glowMat);
    this.glowRoot.name = 'plane-lights';
    this.glowRoot.renderOrder = 5;
    this.glowRoot.visible = false;
    this.root.add(this.glowRoot);
    // instrument face
    this.instrMat = new THREE.MeshBasicMaterial({ map: blankPanelTexture(), toneMapped: false });
    this.instrMesh = new THREE.Mesh(tpl.instrument.geo, this.instrMat);
    this.instrMesh.name = 'instruments';
    this.instrMesh.position.copy(tpl.instrument.position);
    this.instrMesh.quaternion.copy(tpl.instrument.quaternion);
    this.rtByName.get(tpl.instrument.part)!.info.object.add(this.instrMesh);
    // prop blur disc
    if (tpl.propDisc) {
      this.propDiscMat = new THREE.MeshBasicMaterial({ color: 0x1c1d20, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
      this.propDisc = new THREE.Mesh(tpl.propDisc.geo, this.propDiscMat);
      this.propDisc.name = 'prop-disc';
      this.propDisc.position.copy(tpl.propDisc.position);
      this.propDisc.visible = false;
      this.propDisc.renderOrder = 4;
      this.rtByName.get(tpl.propDisc.part)!.info.object.add(this.propDisc);
    }
    for (let i = 0; i < this.engines.length; i++) {
      this.lastProp.push(0);
      this.propDelta.push(0);
      this.propGiven.push(false);
      this.fanAuto.push(Math.random() * 6);
    }
    this.applyLod(true);
  }

  // ------------------------------------------------------------------------------------------------ controls
  setControls(c: { aileron: number; elevator: number; rudder: number; flaps: number; gear: number; propAngle?: number[] }): void {
    const A = this.mats.uniforms.uSurfA.value;
    const Pv = this.mats.uniforms.uSurfP.value;
    const cl = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
    const ail = cl(c.aileron || 0, -1, 1);
    const ele = cl(c.elevator || 0, -1, 1);
    const rud = cl(c.rudder || 0, -1, 1);
    const flp = cl(c.flaps || 0, 0, 1);
    const gr = cl(c.gear ?? 1, 0, 1);
    for (const s of this.surf) {
      switch (s.role) {
        case 'aileron':
          A[s.id].w = s.side * ail * s.max;
          break;
        case 'elevator':
          A[s.id].w = -ele * s.max;
          break;
        case 'rudder':
          A[s.id].w = rud * s.max;
          break;
        case 'flap':
          A[s.id].w = flp * s.max;
          Pv[s.id].w = flp * s.slide;
          break;
        case 'gear':
          A[s.id].w = (1 - gr) * s.max;
          break;
        case 'fan':
        case 'prop': {
          const k = s.engine - 1;
          const given = c.propAngle && c.propAngle[k] !== undefined && Number.isFinite(c.propAngle[k]);
          if (given) {
            const a = c.propAngle![k];
            let d = a - this.lastProp[k];
            if (d > Math.PI) d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
            if (d < -Math.PI) d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
            this.propDelta[k] += Math.abs(d);
            this.lastProp[k] = a;
            A[s.id].w = a;
          }
          this.propGiven[k] = !!given;
          break;
        }
      }
    }
  }

  setEngineDamaged(index: number, damaged: boolean): void {
    if (index < 1 || index > 4) return;
    this.damaged[index - 1] = damaged;
    const d = this.mats.uniforms.uDmg.value;
    d.setComponent(index - 1, damaged ? 1 : 0);
  }

  setLights(l: { nav: boolean; strobe: boolean; beacon: boolean; landing: boolean }): void {
    this.lightsOn = { ...l };
    this.glowU.uOn.value.set(l.nav ? 1 : 0, l.strobe ? 1 : 0, l.beacon ? 1 : 0, l.landing ? 1 : 0);
    this.applyLod();
  }

  setInstruments(i: PlaneInstruments): void {
    this.instr = i;
    this.instrDirty = true;
  }

  /** Walking inside: every cabin interior visible (else only torn-open ones / the prop's open cabin). */
  private interiorsOn = false;
  setInteriorVisible(on: boolean): void {
    this.interiorsOn = on;
    for (const r of this.rt) if (r.interior) r.interior.visible = on || r.capsShown > 0 || !!r.tpl.interiorAlways;
  }

  showBreak(jointId: string): void {
    const j = this.joints.find((x) => x.id === jointId);
    if (!j) return;
    for (const [cap, pn] of [[j.capA, j.a], [j.capB, j.b]] as const) {
      if (cap && !cap.visible) {
        cap.visible = true;
        const r = this.rtByName.get(pn);
        if (r) {
          r.capsShown++;
          if (r.interior) r.interior.visible = true;
        }
      }
    }
    if (this.tpl.bulkheadJoints.includes(jointId)) this.mats.uniforms.uFlags.value.y = 1;
    this.mats.uniforms.uCabin.value = 0.6; // emergency lighting once the airframe is torn
    this.broken = true;
    this.applyLod();
  }

  setCharred(partName: string, amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    const C = this.mats.uniforms.uCharV.value;
    const set = (i: number) => C[i >> 2].setComponent(i & 3, a);
    if (partName === '*') for (const r of this.rt) set(r.tpl.index);
    else {
      const r = this.rtByName.get(partName);
      if (r) set(r.tpl.index);
    }
  }

  crumple(partName: string, point: THREE.Vector3, amount: number): void {
    const r = this.rtByName.get(partName);
    if (!r) return;
    const U = this.mats.uniforms;
    const L = this.tpl.design.length;
    const amt = Math.max(0, Math.min(amount, L * 0.06));
    U.uCrush.value.set(point.x, point.y, point.z, amt);
    _v.copy(point).multiplyScalar(-1);
    _v.y *= 0.3;
    if (_v.lengthSq() < 1e-6) _v.set(0, 0, -1);
    _v.normalize();
    U.uCrushDir.value.set(_v.x, _v.y, _v.z, r.tpl.index);
    U.uCrushR.value = Math.max(1.2, L * 0.09);
  }

  setLod(level: 0 | 1 | 2): void {
    if (level === this.lod) return;
    this.lod = level;
    this.applyLod(true);
  }

  repair(): void {
    for (const r of this.rt) {
      const o = r.info.object;
      const orig = this.original.get(o)!;
      if (o.parent !== this.root) this.root.add(o);
      o.position.copy(orig.pos);
      o.quaternion.copy(orig.quat);
      o.scale.copy(orig.scale);
      o.visible = true;
      r.capsShown = 0;
      if (r.interior) r.interior.visible = this.interiorsOn || !!r.tpl.interiorAlways;
    }
    for (const j of this.joints) {
      if (j.capA) j.capA.visible = false;
      if (j.capB) j.capB.visible = false;
    }
    const U = this.mats.uniforms;
    U.uDmg.value.set(0, 0, 0, 0);
    for (const v of U.uCharV.value) v.set(0, 0, 0, 0);
    U.uCrush.value.set(0, 0, 0, 0);
    U.uCrushDir.value.w = -1;
    U.uFlags.value.y = 0;
    U.uCabin.value = 1;
    this.damaged = [false, false, false, false];
    this.broken = false;
    this.applyLod(true);
  }

  update(dt: number): void {
    if (this.disposed) return;
    const d = Math.max(1e-4, dt);
    this.time += dt;
    const U = this.mats.uniforms;
    U.uFlags.value.z = this.time;
    this.glowU.uTime.value = this.time;
    // parts re-parented by the breakup system while the merged LOD shows → switch back to parts
    if (this.merged.visible || this.glowRoot.visible) {
      for (const r of this.rt) if (r.info.object.parent !== this.root) {
        this.broken = true;
        this.applyLod();
        break;
      }
    }
    // fans windmill gently when nobody drives them
    const A = U.uSurfA.value;
    for (const s of this.surf) {
      if (s.role !== 'fan') continue;
      const k = s.engine - 1;
      if (!this.propGiven[k] && !this.damaged[k]) {
        this.fanAuto[k] += dt * 0.6;
        A[s.id].w = this.fanAuto[k];
      }
    }
    // prop blur
    if (this.tpl.propDisc) {
      const w = this.propDelta[0] / d;
      this.propDelta[0] = 0;
      const target = this.damaged[0] ? 0 : smooth(28, 70, w);
      this.blur += (target - this.blur) * Math.min(1, dt * 10);
      U.uFlags.value.w = this.damaged[0] || this.blur > 0.55 ? 1 : 0;
      if (this.propDisc && this.propDiscMat) {
        this.propDiscMat.opacity = this.blur * 0.32;
        this.propDisc.visible = this.blur > 0.02 && this.lod < 2 && !this.merged.visible;
      }
      if (this.damaged[0]) U.uFlags.value.w = 1;
    }
    const mf = this.mats.mergedFlags.value;
    mf.y = U.uFlags.value.y;
    mf.z = U.uFlags.value.z;
    mf.w = U.uFlags.value.w;
    // instruments (only when the face is drawn)
    if (this.instrMesh.visible && this.instr) {
      this.instrTimer -= dt;
      if (this.instrDirty && this.instrTimer <= 0) {
        this.instrTimer = 1 / CONFIG.planeModels.instrumentHz;
        this.instrDirty = false;
        if (!this.panel) {
          this.panel = new InstrumentPanel(this.tpl.design.cockpit.glass, this.tpl.type === 'prop' ? 300 : this.tpl.type === 'bizjet' ? 950 : 1000);
          this.instrMat.map = this.panel.texture;
          this.instrMat.needsUpdate = true;
        }
        this.panel.draw(this.instr, this.time);
      }
      const fl = this.instr.flicker || 0;
      const k = fl > 0 ? 1 - fl * (Math.random() < 0.35 ? 0.4 + Math.random() * 0.6 : Math.random() * 0.15) : 1;
      this.instrMat.color.setScalar(k);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mats.dispose();
    this.glowMat.dispose();
    this.instrMat.dispose();
    this.panel?.dispose();
    this.propDiscMat?.dispose();
    for (const r of this.rt) if (r.glow) r.glow.removeFromParent();
    this.root.removeFromParent();
  }

  /** Recommended LOD for a camera distance (m). */
  lodForDistance(d: number): 0 | 1 | 2 {
    const L = CONFIG.planeModels.lodDistance[this.type];
    return d < L[0] ? 0 : d < L[1] ? 1 : 2;
  }

  // ------------------------------------------------------------------------------------------------ internals
  private applyLod(force = false): void {
    const intact = !this.broken && this.rt.every((r) => r.info.object.parent === this.root);
    const useMerged = this.lod === 2 && intact;
    const anyLight = this.lightsOn.nav || this.lightsOn.strobe || this.lightsOn.beacon || this.lightsOn.landing;
    const mode = `${this.lod}|${useMerged}|${intact}|${anyLight}`;
    if (!force && mode === this.appliedMode) return;
    this.appliedMode = mode;
    this.merged.visible = useMerged;
    for (const r of this.rt) {
      r.mesh.visible = !useMerged;
      const g = r.tpl.geo[this.lod];
      if (r.mesh.geometry !== g) r.mesh.geometry = g;
      r.mesh.castShadow = this.lod < 2;
    }
    this.merged.castShadow = true;
    this.instrMesh.visible = this.lod === 0 && !useMerged;
    // lights: one root mesh while intact, per-part meshes once broken
    this.glowRoot.visible = anyLight && intact;
    for (const r of this.rt) {
      if (!r.tpl.glow) continue;
      if (!intact && anyLight && !r.glow) {
        r.glow = new THREE.Mesh(r.tpl.glow, this.glowMat);
        r.glow.name = `${r.info.name}-lights`;
        r.glow.renderOrder = 5;
        r.info.object.add(r.glow);
      }
      if (r.glow) r.glow.visible = anyLight && !intact;
    }
  }
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
