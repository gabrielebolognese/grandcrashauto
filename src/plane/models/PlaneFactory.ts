import * as THREE from 'three';
import type { GameContext, IPlaneFactory, PlaneModelInfo } from '../../game/contracts';
import type { PlaneTypeId, PlaneVisual } from '../types';
import { PLANE_TYPES } from '../types';
import { buildTemplate, type PlaneTemplate } from './template';
import { getDesign } from './designs';
import { PlaneVisualImpl } from './visual';
import { getAtlas } from './atlas';

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
  private warm: PlaneVisual | null = null;

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
   * Build every template behind the loading bar and leave one hidden plane (all sub-meshes: parts, merged LOD,
   * caps, interior, lights, instruments, prop disc) in the scene so the lead's shader pre-compile covers every
   * plane program; removed a little later.
   */
  warmup(): void {
    for (const t of PLANE_TYPES) this.template(t);
    try {
      this.ctx.engine.renderer.initTexture(getAtlas());
    } catch {
      /* optional */
    }
    if (this.warm) return;
    const v = this.create('prop');
    v.root.visible = false;
    v.root.position.set(0, -800, 0);
    v.setLights({ nav: true, strobe: true, beacon: true, landing: true });
    for (const j of v.joints) j.capA && (j.capA.visible = true);
    v.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== v.root) o.visible = true;
    });
    this.ctx.engine.scene.add(v.root);
    this.warm = v;
    setTimeout(() => {
      if (this.warm) {
        this.warm.dispose();
        this.warm = null;
      }
    }, 20000);
  }
}
