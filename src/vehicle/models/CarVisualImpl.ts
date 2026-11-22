import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import { cloneBuild, normalizeBuild, type CarBuild, type CarModelId } from '../CarBuild';
import type { CarDimensions, CarVisual, WheelVisual } from '../../game/contracts';
import { setRangeCollapsed } from './details';
import {
  createDetailMaterial,
  createGlassMaterial,
  createPaintMaterial,
  createTyreMaterial,
  getShadowProxyMaterial,
  makeDetailUniforms,
  makePaintUniforms,
  type DetailUniforms,
  type GlassUniforms,
  type PaintUniforms,
} from './materials';
import { LT } from './regions';
import { SPECS, type CarSpec } from './specs';
import { PANELS, getHighTemplate, getLowTemplate, type HighTemplate, type KitKey, type LowTemplate, type PanelKey } from './templates';
import { createTrimAtlas, drawPlate, getBeamTexture, getGlowTexture } from './textures';
import { getLowWheel, getRim, getTyre, sidewallFrac, wheelRadius } from './wheels';

/** Host hooks provided by the factory. */
export interface VisualHost {
  physical(): boolean;
  shadows(): boolean;
  patchPaint?: (m: THREE.Material) => void;
  release(v: CarVisualImpl): void;
}

const STRIPE_MODE = { none: 0, center: 1, twin: 2, side: 3 } as const;
const FINISH: Record<string, { metal: number; rough: number; cc: number; ccr: number; flake: number }> = {
  gloss: { metal: 0.0, rough: 0.38, cc: 1, ccr: 0.03, flake: 0 },
  metallic: { metal: 0.62, rough: 0.33, cc: 1, ccr: 0.05, flake: 1 },
  matte: { metal: 0.04, rough: 0.66, cc: 0.0001, ccr: 0.6, flake: 0 },
  pearl: { metal: 0.25, rough: 0.3, cc: 1, ccr: 0.04, flake: 0.5 },
  shift: { metal: 0.55, rough: 0.3, cc: 1, ccr: 0.04, flake: 0.6 },
};
const WHEEL_NAMES = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'];
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _c = new THREE.Color();
const RED = new THREE.Color(1, 0.012, 0.006);
const AMBER = new THREE.Color(1, 0.45, 0.05);
const WHITE = new THREE.Color(1, 1, 1);

interface DeformData {
  pos: Float32Array;
  nrm: Float32Array;
  adjStart?: Uint32Array;
  adjTris?: Uint32Array;
  dirty: boolean;
}

let unitPlane: THREE.PlaneGeometry | null = null;

export class CarVisualImpl implements CarVisual {
  readonly root = new THREE.Group();
  readonly dims: CarDimensions;
  readonly wheels: WheelVisual[] = [];
  parts: Record<string, THREE.Object3D> = {};
  exhaustPoints: THREE.Vector3[] = [];
  rearCorners: THREE.Vector3[] = [];
  headlightPoints: THREE.Vector3[] = [];

  private model!: CarModelId;
  private spec!: CarSpec;
  private hi!: HighTemplate;
  private lo!: LowTemplate;
  private build!: CarBuild;
  private uChar = { value: 0 };
  private PU: PaintUniforms;
  private TU: DetailUniforms; // trim / low detail
  private LU: DetailUniforms; // lamps
  private RU: DetailUniforms; // rims
  private paintStd: THREE.MeshStandardMaterial | null = null;
  private paintPearl: THREE.MeshStandardMaterial | null = null;
  private paintPhysical = true;
  private glass: { mat: THREE.MeshStandardMaterial; U: GlassUniforms };
  private trimMat: THREE.MeshStandardMaterial;
  private lampMat: THREE.MeshStandardMaterial;
  private rimMat: THREE.MeshStandardMaterial;
  private tyreMat: THREE.MeshStandardMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private beamMat: THREE.MeshBasicMaterial;
  private atlas: THREE.CanvasTexture;
  private plateText = '';
  private meshes = new Map<string, THREE.Mesh>();
  private deform = new Map<THREE.BufferGeometry, DeformData>();
  private home = new Map<string, { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }>();
  private detached = new Set<string>();
  private plateChildren = new Map<string, THREE.Mesh>();
  private underglowMesh: THREE.Mesh;
  private beamMesh: THREE.Mesh;
  private shadowMesh: THREE.Mesh | null = null;
  private lightState = { brake: false, reverse: false, headlights: false, underglow: true };
  private glassLevel: 0 | 1 | 2 = 0;
  private wheelKey = '';
  private kitKey = '';
  private disposed = false;

  constructor(
    private host: VisualHost,
    build: CarBuild,
    readonly lod: 'high' | 'low',
  ) {
    this.root.name = 'car';
    this.dims = {
      wheelPositions: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
      wheelRadius: 0.33,
      wheelWidth: 0.24,
      halfExtents: new THREE.Vector3(),
      colliderOffset: new THREE.Vector3(),
      mass: 1200,
    };
    this.PU = makePaintUniforms(this.uChar);
    this.TU = makeDetailUniforms(this.uChar);
    this.LU = makeDetailUniforms(this.uChar);
    this.RU = makeDetailUniforms(this.uChar);
    this.atlas = createTrimAtlas('');
    this.glass = createGlassMaterial(this.uChar);
    this.trimMat = createDetailMaterial(this.TU, lod === 'high' ? this.atlas : null);
    this.lampMat = createDetailMaterial(this.LU, null);
    this.rimMat = createDetailMaterial(this.RU, null);
    this.tyreMat = createTyreMaterial(this.uChar);
    if (!unitPlane) unitPlane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.glowMat = new THREE.MeshBasicMaterial({ map: getGlowTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, color: 0x000000 });
    this.glowMat.name = 'carUnderglow';
    this.beamMat = new THREE.MeshBasicMaterial({ map: getBeamTexture(), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, color: 0x000000 });
    this.beamMat.name = 'carBeam';
    this.underglowMesh = new THREE.Mesh(unitPlane, this.glowMat);
    this.underglowMesh.renderOrder = 2;
    this.underglowMesh.visible = false;
    this.beamMesh = new THREE.Mesh(unitPlane, this.beamMat);
    this.beamMesh.renderOrder = 2;
    this.beamMesh.visible = false;
    this.beamMesh.frustumCulled = false;
    this.setupModel(normalizeBuild(build));
  }

  // ───────────────────────────── construction ─────────────────────────────

  private setupModel(b: CarBuild): void {
    this.clearModel();
    this.model = b.model;
    this.spec = SPECS[b.model];
    const s = this.spec;
    if (this.lod === 'high') this.hi = getHighTemplate(b.model);
    else this.lo = getLowTemplate(b.model);
    this.dims.mass = s.mass;
    this.dims.wheelWidth = s.wheelW;
    // Chassis box: covers the body from just above the sills to the beltline.
    const halfW = s.halfW(0) - 0.04;
    const yBot = s.sill(0) + 0.08;
    const yTop = s.belt(0) + 0.05 + s.cabin.H(0) * 0.35;
    this.dims.halfExtents.set(halfW, (yTop - yBot) / 2, (s.zFront - s.zRear) / 2 - 0.05);
    this.dims.colliderOffset.set(0, (yTop + yBot) / 2, (s.zFront + s.zRear) / 2);
    if (this.lod === 'high') {
      const t = this.hi;
      for (const k of PANELS) {
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), t.panelKind[k] === 'paint' ? this.paintMaterial() : this.trimMat);
        mesh.name = k;
        mesh.receiveShadow = true;
        this.meshes.set(k, mesh);
        this.root.add(mesh);
        if (k !== 'body') this.parts[k] = mesh;
      }
      this.addMesh('glass', t.glass.clone(), this.glass.mat, false);
      this.addMesh('lights', t.lights.clone(), this.lampMat, false);
      this.addMesh('trim', t.trim.clone(), this.trimMat, true);
      this.meshes.get('glass')!.renderOrder = 1;
      this.shadowMesh = new THREE.Mesh(t.shadow, getShadowProxyMaterial());
      this.shadowMesh.castShadow = true;
      this.shadowMesh.name = 'shadowProxy';
      this.root.add(this.shadowMesh);
      this.exhaustPoints = t.exhaustPoints.map((p) => p.clone());
      this.rearCorners = t.rearCorners.map((p) => p.clone());
      this.headlightPoints = t.headlightPoints.map((p) => p.clone());
    } else {
      const body = new THREE.Mesh(new THREE.BufferGeometry(), this.paintMaterial());
      body.name = 'body';
      body.castShadow = true;
      body.receiveShadow = true;
      this.meshes.set('body', body);
      this.root.add(body);
      this.addMesh('detail', this.lo.detail.clone(), this.trimMat, true);
      this.exhaustPoints = this.lo.exhaustPoints.map((p) => p.clone());
      this.rearCorners = this.lo.rearCorners.map((p) => p.clone());
      this.headlightPoints = this.lo.headlightPoints.map((p) => p.clone());
    }
    this.root.add(this.underglowMesh, this.beamMesh);
    // wheels
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Object3D();
      pivot.name = WHEEL_NAMES[i];
      const spin = new THREE.Object3D();
      pivot.add(spin);
      this.root.add(pivot);
      this.wheels.push({ pivot, spin });
      this.parts[WHEEL_NAMES[i]] = pivot;
    }
    this.wheelKey = '';
    this.kitKey = '';
    this.build = cloneBuild(b);
    this.applyBuildInternal(b, true);
    this.updateShadowVisibility();
  }

  private addMesh(name: string, geo: THREE.BufferGeometry, mat: THREE.Material, receive: boolean): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.receiveShadow = receive;
    this.meshes.set(name, m);
    this.root.add(m);
    this.trackDeform(geo);
    return m;
  }

  private trackDeform(geo: THREE.BufferGeometry): void {
    const p = geo.getAttribute('position') as THREE.BufferAttribute;
    const n = geo.getAttribute('normal') as THREE.BufferAttribute;
    this.deform.set(geo, { pos: (p.array as Float32Array).slice(), nrm: (n.array as Float32Array).slice(), dirty: false });
  }

  private clearModel(): void {
    for (const m of this.meshes.values()) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const c of this.plateChildren.values()) {
      c.removeFromParent();
      c.geometry.dispose();
    }
    this.plateChildren.clear();
    this.meshes.clear();
    this.deform.clear();
    for (const w of this.wheels) w.pivot.removeFromParent();
    this.wheels.length = 0;
    this.shadowMesh?.removeFromParent();
    this.shadowMesh = null;
    this.parts = {};
    this.home.clear();
    this.detached.clear();
    this.glassLevel = 0;
    this.uChar.value = 0;
  }

  private kitOf(b: CarBuild): KitKey {
    return { splitter: b.kit.splitter, skirts: b.kit.skirts, spoiler: b.kit.spoiler, scoop: b.kit.scoop };
  }

  /** Assign a per-instance clone of a template geometry to a mesh, recentred on its bbox for detachable parts. */
  private setGeometry(mesh: THREE.Mesh, tpl: THREE.BufferGeometry, recentre: boolean): void {
    const old = mesh.geometry;
    this.deform.delete(old);
    old.dispose();
    const g = tpl.clone();
    mesh.position.set(0, 0, 0);
    if (recentre) {
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      g.translate(-c.x, -c.y, -c.z);
      mesh.position.copy(c);
    }
    g.computeBoundingSphere();
    mesh.geometry = g;
    mesh.rotation.set(0, 0, 0);
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrix();
    this.trackDeform(g);
    this.home.set(mesh.name, { p: mesh.position.clone(), q: mesh.quaternion.clone(), s: mesh.scale.clone() });
  }

  private applyKit(b: CarBuild): void {
    const kit = this.kitOf(b);
    const key = `${+kit.splitter}${+kit.skirts}${+kit.scoop}${kit.spoiler}`;
    if (key === this.kitKey) return;
    const prev = this.kitKey;
    this.kitKey = key;
    if (this.lod === 'low') {
      this.setGeometry(this.meshes.get('body')!, this.lo.paint(kit), false);
      return;
    }
    const t = this.hi;
    const first = prev === '';
    for (const k of PANELS) {
      const affected = first || (k === 'body' && prev[1] !== key[1]) || (k === 'hood' && prev[2] !== key[2]) || (k === 'bumperF' && prev[0] !== key[0]);
      if (affected) this.setGeometry(this.meshes.get(k)!, t.panel(k, kit), k !== 'body');
    }
    // spoiler
    const spGeo = t.spoiler(kit.spoiler);
    let sp = this.meshes.get('spoiler');
    if (!spGeo) {
      if (sp) {
        sp.removeFromParent();
        this.deform.delete(sp.geometry);
        sp.geometry.dispose();
        this.meshes.delete('spoiler');
        delete this.parts.spoiler;
      }
    } else {
      if (!sp) {
        sp = new THREE.Mesh(new THREE.BufferGeometry(), this.paintMaterial());
        sp.name = 'spoiler';
        sp.receiveShadow = true;
        this.meshes.set('spoiler', sp);
        this.root.add(sp);
        this.parts.spoiler = sp;
      }
      this.setGeometry(sp, spGeo, true);
    }
  }

  private applyWheels(b: CarBuild): void {
    const key = `${b.wheels.rim}|${b.wheels.size}|${b.wheels.tyre}`;
    if (key === this.wheelKey) return;
    this.wheelKey = key;
    const s = this.spec;
    const R = wheelRadius(s.wheelR, b.wheels.size, b.wheels.tyre);
    const sw = R * sidewallFrac(b.wheels.tyre);
    this.dims.wheelRadius = R;
    const pos = [
      [s.halfTrack, s.axleF],
      [-s.halfTrack, s.axleF],
      [s.halfTrack, s.axleR],
      [-s.halfTrack, s.axleR],
    ];
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      this.dims.wheelPositions[i].set(pos[i][0], R, pos[i][1]);
      w.pivot.position.copy(this.dims.wheelPositions[i]);
      this.home.set(WHEEL_NAMES[i], { p: w.pivot.position.clone(), q: w.pivot.quaternion.clone(), s: w.pivot.scale.clone() });
      for (const c of [...w.spin.children]) w.spin.remove(c);
      const right = pos[i][0] < 0;
      if (this.lod === 'high') {
        const tyre = new THREE.Mesh(getTyre(R, sw, s.wheelW), this.tyreMat);
        const rim = new THREE.Mesh(getRim(b.wheels.rim, R - sw, s.wheelW), this.rimMat);
        tyre.name = 'tyre';
        rim.name = 'rim';
        if (right) tyre.rotation.y = rim.rotation.y = Math.PI;
        tyre.receiveShadow = rim.receiveShadow = true;
        w.spin.add(tyre, rim);
      } else {
        const m = new THREE.Mesh(getLowWheel(R, sw, s.wheelW), this.rimMat);
        if (right) m.rotation.y = Math.PI;
        w.spin.add(m);
      }
    }
  }

  // ───────────────────────────── materials ─────────────────────────────

  private paintMaterial(): THREE.MeshStandardMaterial {
    const physical = this.host.physical();
    if (this.paintStd && this.paintPhysical !== physical) {
      this.paintStd.dispose();
      this.paintPearl?.dispose();
      this.paintStd = this.paintPearl = null;
    }
    this.paintPhysical = physical;
    const pearl = this.build?.paint.finish === 'pearl' && physical;
    if (pearl) {
      if (!this.paintPearl) this.paintPearl = createPaintMaterial('pearl', true, this.PU, this.host.patchPaint);
      return this.paintPearl;
    }
    if (!this.paintStd) this.paintStd = createPaintMaterial('std', physical, this.PU, this.host.patchPaint);
    return this.paintStd;
  }

  private assignPaint(): void {
    const mat = this.paintMaterial();
    const f = FINISH[this.build.paint.finish] ?? FINISH.gloss;
    mat.metalness = f.metal;
    mat.roughness = f.rough;
    if (mat instanceof THREE.MeshPhysicalMaterial) {
      mat.clearcoat = f.cc;
      mat.clearcoatRoughness = f.ccr;
    }
    for (const [name, m] of this.meshes) {
      if (m.material === this.trimMat || m.material === this.glass.mat || m.material === this.lampMat) continue;
      if (name === 'body' || PANELS.includes(name as PanelKey) || name === 'spoiler') m.material = mat;
    }
    for (const c of this.plateChildren.values()) c.material = this.trimMat;
  }

  /** Called by the factory when the quality level changes (Physical ↔ Standard paint, shadow proxy). */
  refreshQuality(): void {
    if (this.disposed) return;
    this.assignPaint();
    this.updateShadowVisibility();
  }

  private updateShadowVisibility(): void {
    if (this.shadowMesh) this.shadowMesh.visible = this.host.shadows();
  }

  // ───────────────────────────── CarVisual API ─────────────────────────────

  applyBuild(build: CarBuild): void {
    if (this.disposed) return;
    const b = normalizeBuild(build);
    if (b.model !== this.model) {
      this.setupModel(b);
      return;
    }
    this.applyBuildInternal(b, false);
  }

  private applyBuildInternal(b: CarBuild, first: boolean): void {
    this.build = cloneBuild(b);
    this.applyWheels(b);
    this.applyKit(b);
    const p = b.paint;
    const PU = this.PU;
    PU.uColor.value.set(p.color);
    PU.uRoofColor.value.set(p.roofColor);
    PU.uTwoTone.value = p.twoTone ? 1 : 0;
    PU.uStripeColor.value.set(p.stripeColor);
    PU.uStripeMode.value = STRIPE_MODE[p.stripes] ?? 0;
    const st = this.spec.stripe;
    PU.uStripeA.value.set(st.center, st.twinIn, st.twinOut, st.sideSlope);
    PU.uSideBand.value.set(st.sideY0, st.sideY1, st.sideZ0, st.sideZ1);
    PU.uShift.value = p.finish === 'shift' ? 1 : 0;
    PU.uShiftColor.value.set(p.shiftColor);
    PU.uPearl.value = p.finish === 'pearl' ? 1 : 0;
    PU.uFlake.value = (FINISH[p.finish] ?? FINISH.gloss).flake;
    this.assignPaint();
    // rims
    this.RU.uTint.value.set(b.wheels.rimColor);
    // glass tint
    const t = b.extras.tint;
    _c.setRGB(0.07, 0.09, 0.1).lerp(new THREE.Color(0.006, 0.007, 0.009), t);
    this.glass.mat.color.copy(_c);
    this.glass.mat.opacity = 0.4 + 0.55 * t;
    this.applyGlassUniforms();
    // plate
    if (b.extras.plate !== this.plateText || first) {
      this.plateText = b.extras.plate;
      drawPlate(this.atlas.image as HTMLCanvasElement, b.extras.plate);
      this.atlas.needsUpdate = true;
    }
    // underglow footprint
    const s = this.spec;
    this.underglowMesh.scale.set((s.halfW(0) + 0.45) * 2, 1, s.zFront - s.zRear + 0.9);
    this.underglowMesh.position.set(0, 0.03, (s.zFront + s.zRear) / 2);
    this.beamMesh.scale.set(3.2, 1, 11);
    this.beamMesh.position.set(0, 0.04, s.zFront + 5.4);
    this.updateEmissive();
  }

  private applyGlassUniforms(): void {
    this.glass.U.uCrack.value = this.glassLevel === 1 ? 1 : 0;
    const g = this.meshes.get('glass');
    if (g) g.visible = this.glassLevel < 2;
    // low LOD opaque glass
    const t = this.build.extras.tint;
    const c = new THREE.Color(0.1, 0.13, 0.15).lerp(new THREE.Color(0.012, 0.014, 0.018), t);
    if (this.glassLevel === 2) c.setRGB(0.01, 0.01, 0.01);
    this.TU.uGlass.value.set(c.r, c.g, c.b, this.glassLevel === 1 ? 1 : 0);
  }

  setLights(state: { brake: boolean; reverse: boolean; headlights: boolean; underglow: boolean }): void {
    const ls = this.lightState;
    if (ls.brake === state.brake && ls.reverse === state.reverse && ls.headlights === state.headlights && ls.underglow === state.underglow) return;
    ls.brake = state.brake;
    ls.reverse = state.reverse;
    ls.headlights = state.headlights;
    ls.underglow = state.underglow;
    this.updateEmissive();
  }

  private updateEmissive(): void {
    const cfg = CONFIG.carModels;
    const ls = this.lightState;
    const on = 1 - Math.min(1, this.uChar.value * 1.5);
    const night = GLOBAL_UNIFORMS.uNight.value;
    const k = cfg.lampIntensity * on;
    const hc = _c.set(this.build.extras.headlightColor);
    const E = (this.lod === 'high' ? this.LU : this.TU).uEmis.value;
    const tailBase = ls.headlights ? cfg.tailOn * (1 + night * 0.4) : cfg.tailDay;
    E[LT.HEAD].set(hc.r, hc.g, hc.b).multiplyScalar((ls.headlights ? cfg.headOn : 0) * k);
    E[LT.DRL].set(hc.r, hc.g, hc.b).multiplyScalar((ls.headlights ? cfg.drlOn : cfg.drlDay) * k);
    E[LT.TAIL].set(RED.r, RED.g, RED.b).multiplyScalar(tailBase * k);
    E[LT.BRAKE].set(RED.r, RED.g, RED.b).multiplyScalar((ls.brake ? cfg.brakeOn : tailBase) * k);
    E[LT.REVERSE].set(WHITE.r, WHITE.g, WHITE.b).multiplyScalar((ls.reverse ? cfg.reverseOn : 0) * k);
    E[LT.INDICATOR].set(AMBER.r, AMBER.g, AMBER.b).multiplyScalar(0.12 * k);
    const ug = this.build.extras.underglow;
    const ugOn = !!ug && ls.underglow && on > 0.5;
    if (ug) {
      const c = new THREE.Color(ug);
      E[LT.UNDERGLOW].set(c.r, c.g, c.b).multiplyScalar(ugOn ? 4 * k : 0);
      this.glowMat.color.copy(c);
    } else E[LT.UNDERGLOW].set(0, 0, 0);
    this.underglowMesh.visible = ugOn;
    this.beamMesh.visible = this.lod === 'low' && cfg.fakeBeam && ls.headlights && on > 0.5 && night > 0.05;
    this.updateGlow(night);
  }

  private updateGlow(night: number): void {
    const cfg = CONFIG.carModels;
    if (this.underglowMesh.visible) {
      const ug = this.build.extras.underglow;
      if (ug) this.glowMat.color.set(ug).multiplyScalar(cfg.underglowDay + (cfg.underglowNight - cfg.underglowDay) * night);
    }
    if (this.beamMesh.visible) this.beamMat.color.set(this.build.extras.headlightColor).multiplyScalar(cfg.beamNight * night);
  }

  private lastNight = -1;
  update(_dt: number): void {
    if (this.disposed) return;
    const night = GLOBAL_UNIFORMS.uNight.value;
    if (Math.abs(night - this.lastNight) > 0.01) {
      this.lastNight = night;
      this.updateEmissive();
    }
  }

  dent(localPoint: THREE.Vector3, localDir: THREE.Vector3, strength: number): void {
    if (this.disposed) return;
    const cfg = CONFIG.carModels;
    const st = Math.min(2, Math.max(0, strength)) * cfg.dentScale;
    if (st < 0.01) return;
    const radius = 0.22 + 0.33 * Math.min(1, st);
    const depth = Math.min(cfg.maxDent, 0.085 * st);
    // Always push into the body, whichever way the caller's normal points.
    const cy = this.spec.belt(0) * 0.6;
    _dir.copy(localDir);
    if (_dir.lengthSq() < 1e-8) _dir.set(-localPoint.x, cy - localPoint.y, -localPoint.z);
    _dir.normalize();
    if (_dir.x * localPoint.x + _dir.y * (localPoint.y - cy) + _dir.z * localPoint.z > 0) _dir.negate();
    for (const [name, mesh] of this.meshes) {
      if (mesh.parent !== this.root || name === 'shadowProxy') continue;
      const dd = this.deform.get(mesh.geometry);
      if (!dd) continue;
      mesh.updateMatrix();
      _m.copy(mesh.matrix).invert();
      const lp = _v.copy(localPoint).applyMatrix4(_m);
      _d.copy(_dir).transformDirection(_m);
      const bs = mesh.geometry.boundingSphere;
      if (bs && bs.center.distanceTo(lp) > bs.radius + radius) continue;
      this.dentGeometry(mesh.geometry, dd, lp, _d, radius, depth, cfg.maxDeform);
    }
  }

  private dentGeometry(g: THREE.BufferGeometry, dd: DeformData, p: THREE.Vector3, dir: THREE.Vector3, radius: number, depth: number, maxDef: number): void {
    const pa = g.getAttribute('position') as THREE.BufferAttribute;
    const arr = pa.array as Float32Array;
    const o = dd.pos;
    const r2 = radius * radius;
    const touched: number[] = [];
    for (let i = 0; i < pa.count; i++) {
      const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
      const dx = x - p.x, dy = y - p.y, dz = z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const f = 1 - d2 / r2;
      const h = Math.sin(o[i * 3] * 91.7 + o[i * 3 + 1] * 47.3 + o[i * 3 + 2] * 13.1) * 43758.5;
      const noise = 0.75 + 0.5 * (h - Math.floor(h));
      const s = depth * f * f * noise;
      let nx = x + dir.x * s, ny = y + dir.y * s, nz = z + dir.z * s;
      const ox = nx - o[i * 3], oy = ny - o[i * 3 + 1], oz = nz - o[i * 3 + 2];
      const ol = Math.hypot(ox, oy, oz);
      if (ol > maxDef) {
        const k = maxDef / ol;
        nx = o[i * 3] + ox * k;
        ny = o[i * 3 + 1] + oy * k;
        nz = o[i * 3 + 2] + oz * k;
      }
      arr[i * 3] = nx;
      arr[i * 3 + 1] = ny;
      arr[i * 3 + 2] = nz;
      touched.push(i);
    }
    if (!touched.length) return;
    dd.dirty = true;
    pa.needsUpdate = true;
    this.recomputeNormals(g, dd, touched);
  }

  /** Local normal update around touched vertices (2-ring), keeping crease splits. */
  private recomputeNormals(g: THREE.BufferGeometry, dd: DeformData, touched: number[]): void {
    const index = g.getIndex();
    if (!index) return;
    const idx = index.array as ArrayLike<number>;
    const vc = g.getAttribute('position').count;
    if (!dd.adjStart) {
      const cnt = new Uint32Array(vc + 1);
      for (let i = 0; i < idx.length; i++) cnt[idx[i] + 1]++;
      for (let i = 0; i < vc; i++) cnt[i + 1] += cnt[i];
      const tris = new Uint32Array(idx.length);
      const fill = cnt.slice(0, vc);
      for (let i = 0; i < idx.length; i++) tris[fill[idx[i]]++] = (i / 3) | 0;
      dd.adjStart = cnt;
      dd.adjTris = tris;
    }
    const start = dd.adjStart!;
    const tris = dd.adjTris!;
    const pos = g.getAttribute('position').array as Float32Array;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const na = nrm.array as Float32Array;
    const verts = new Set<number>();
    for (const v of touched) {
      verts.add(v);
      for (let k = start[v]; k < start[v + 1]; k++) {
        const t = tris[k];
        verts.add(idx[t * 3]);
        verts.add(idx[t * 3 + 1]);
        verts.add(idx[t * 3 + 2]);
      }
    }
    for (const v of verts) {
      let sx = 0, sy = 0, sz = 0;
      for (let k = start[v]; k < start[v + 1]; k++) {
        const t = tris[k];
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
        const wx = pos[c * 3] - pos[a * 3], wy = pos[c * 3 + 1] - pos[a * 3 + 1], wz = pos[c * 3 + 2] - pos[a * 3 + 2];
        sx += uy * wz - uz * wy;
        sy += uz * wx - ux * wz;
        sz += ux * wy - uy * wx;
      }
      const l = Math.hypot(sx, sy, sz);
      if (l > 1e-12) {
        na[v * 3] = sx / l;
        na[v * 3 + 1] = sy / l;
        na[v * 3 + 2] = sz / l;
      }
    }
    nrm.needsUpdate = true;
  }

  setGlassDamage(level: 0 | 1 | 2): void {
    this.glassLevel = level;
    this.applyGlassUniforms();
  }

  setCharred(amount: number): void {
    this.uChar.value = Math.min(1, Math.max(0, amount));
    this.updateEmissive();
  }

  detachPart(name: string): THREE.Object3D | null {
    const obj = this.parts[name];
    if (!obj || obj.parent !== this.root) return null;
    if (!this.home.has(name)) this.home.set(name, { p: obj.position.clone(), q: obj.quaternion.clone(), s: obj.scale.clone() });
    // plates living in merged meshes ride along as a child copy
    if (this.lod === 'high') {
      for (const pl of this.hi.plates) {
        if (pl.host !== name || pl.mesh !== 'trim') continue;
        const trim = this.meshes.get('trim')!;
        const dd = this.deform.get(trim.geometry);
        if (dd) setRangeCollapsed(trim.geometry, pl.info.start, pl.info.count, true, dd.pos);
        const child = new THREE.Mesh(pl.info.geo.clone().translate(-obj.position.x, -obj.position.y, -obj.position.z), this.trimMat);
        child.name = 'plate';
        obj.add(child);
        this.plateChildren.set(name, child);
      }
    }
    this.root.remove(obj);
    this.detached.add(name);
    return obj;
  }

  repair(): void {
    if (this.disposed) return;
    for (const name of this.detached) {
      const obj = this.parts[name];
      if (!obj) continue;
      obj.removeFromParent();
      const h = this.home.get(name);
      if (h) {
        obj.position.copy(h.p);
        obj.quaternion.copy(h.q);
        obj.scale.copy(h.s);
      }
      const child = this.plateChildren.get(name);
      if (child) {
        child.removeFromParent();
        child.geometry.dispose();
        this.plateChildren.delete(name);
      }
      this.root.add(obj);
    }
    this.detached.clear();
    if (this.lod === 'high') {
      const trim = this.meshes.get('trim');
      const dd = trim && this.deform.get(trim.geometry);
      if (trim && dd) for (const pl of this.hi.plates) if (pl.mesh === 'trim') setRangeCollapsed(trim.geometry, pl.info.start, pl.info.count, false, dd.pos);
    }
    for (const [g, dd] of this.deform) {
      if (!dd.dirty) continue;
      (g.getAttribute('position').array as Float32Array).set(dd.pos);
      (g.getAttribute('normal').array as Float32Array).set(dd.nrm);
      g.getAttribute('position').needsUpdate = true;
      g.getAttribute('normal').needsUpdate = true;
      dd.dirty = false;
    }
    for (const w of this.wheels) w.spin.rotation.set(0, 0, 0);
    this.glassLevel = 0;
    this.applyGlassUniforms();
    this.setCharred(0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    this.clearModel();
    this.paintStd?.dispose();
    this.paintPearl?.dispose();
    this.glass.mat.dispose();
    this.trimMat.dispose();
    this.lampMat.dispose();
    this.rimMat.dispose();
    this.tyreMat.dispose();
    this.glowMat.dispose();
    this.beamMat.dispose();
    this.atlas.dispose();
    this.host.release(this);
  }

  /** Debug: triangle and draw-call counts of what is currently attached. */
  stats(): { tris: number; calls: number } {
    let tris = 0;
    let calls = 0;
    this.root.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry;
      tris += g.index ? g.index.count / 3 : g.getAttribute('position').count / 3;
      calls++;
    });
    return { tris: Math.round(tris), calls };
  }
}
