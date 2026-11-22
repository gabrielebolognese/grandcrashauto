import * as THREE from 'three';
import type { GameContext, IPlaneFactory, PlaneModelInfo } from '../../game/contracts';
import type { PlaneTypeId, PlaneVisual } from '../types';
import { PLANE_TYPES } from '../types';
import { buildTemplate, type PlaneTemplate } from './template';
import { getDesign } from './designs';
import { PlaneVisualImpl } from './visual';
import { getAtlas } from './atlas';
import { GeoBuilder } from './builder';
import { createPlaneMaterials, createGlowMaterial, buildGlowGeometry } from './material';
import { blankPanelTexture } from './instruments';

/**
 * Procedural plane factory (planemodels module). Four original planes built in code — Saltwing S2 trainer,
 * Swiftlet 7 business jet, Tidewing 38 airliner, Pelagic 700 jumbo — each with named breakable parts, torn caps,
 * cabin interiors, cockpit + instruments, animated controls, lights and 3 LODs. Geometry is built once per type and
 * shared by every instance; all planes share one shader program.
 */
export class PlaneFactory implements IPlaneFactory {
  readonly name = 'planeModels';
  readonly models: PlaneModelInfo[] = PLANE_TYPES.map((t) => {
    const d = getDesign(t);
    return { type: t, name: d.name, livery: d.livery, description: d.description };
  });
  private templates = new Map<PlaneTypeId, PlaneTemplate>();
  private warm: THREE.Group | null = null;

  constructor(private ctx: GameContext) {}

  init(): void {}

  /** Shared per-type template (geometry, part table). Built on first use. */
  template(type: PlaneTypeId): PlaneTemplate {
    let t = this.templates.get(type);
    if (!t) {
      t = buildTemplate(type);
      this.templates.set(type, t);
    }
    return t;
  }

  create(type: PlaneTypeId): PlaneVisual {
    return new PlaneVisualImpl(this.template(type));
  }

  /**
   * Build every template behind the loading bar (geometry is shared, so later create() calls are ~1 ms) and leave a
   * tiny hidden opt-in group (userData.warmup) with one mesh per plane material variant — plane surface, merged LOD,
   * light glows, instrument face, prop blur disc — so the lead's pre-compile covers every plane program.
   */
  warmup(): void {
    for (const t of PLANE_TYPES) this.template(t);
    try {
      this.ctx.engine.renderer.initTexture(getAtlas());
    } catch {
      /* optional */
    }
    if (this.warm) return;
    const g = new THREE.Group();
    g.name = 'planes-warmup';
    g.userData.warmup = true;
    g.userData.noOriginShift = true;
    g.visible = false;
    g.position.set(0, -800, 0);
    const mats = createPlaneMaterials(getAtlas(), null);
    const box = new GeoBuilder();
    box.box(0, 0, 0, 0.5, 0.5, 0.5);
    const geo = box.build();
    const m1 = new THREE.Mesh(geo, mats.main);
    m1.customDepthMaterial = mats.depth;
    m1.castShadow = true;
    const m2 = new THREE.Mesh(geo, mats.merged);
    m2.customDepthMaterial = mats.depthMerged;
    m2.castShadow = true;
    const glow = createGlowMaterial();
    glow.uniforms.uOn.value.set(1, 1, 1, 1);
    const gGeo = buildGlowGeometry([{ pos: new THREE.Vector3(), color: [1, 0, 0], kind: 0, size: 0.3, phase: 0, dir: new THREE.Vector3(0, 0, 1), part: '' }], new THREE.Vector3());
    const m3 = new THREE.Mesh(gGeo, glow.mat);
    const instrMat = new THREE.MeshBasicMaterial({ map: blankPanelTexture(), toneMapped: false });
    const discMat = new THREE.MeshBasicMaterial({ color: 0x1c1d20, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
    const plane = new THREE.PlaneGeometry(0.5, 0.5);
    const m4 = new THREE.Mesh(plane, instrMat);
    const m5 = new THREE.Mesh(plane, discMat);
    for (const m of [m1, m2, m3, m4, m5]) {
      m.userData.warmup = true;
      g.add(m);
    }
    this.ctx.engine.scene.add(g);
    this.warm = g;
    setTimeout(() => {
      g.removeFromParent();
      geo.dispose();
      gGeo.dispose();
      plane.dispose();
      mats.dispose();
      glow.mat.dispose();
      instrMat.dispose();
      discMat.dispose();
      this.warm = null;
    }, 20000);
  }
}
