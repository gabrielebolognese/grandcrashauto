import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CarBuild, CarModelId } from '../CarBuild';
import type { CarModelInfo, CarVisual, GameContext, ICarFactory } from '../../game/contracts';
import { CarVisualImpl, type VisualHost } from './CarVisualImpl';
import { SPECS } from './specs';
import { getBeamGeometry, getHighTemplate, getInstancingGeometry, getLowTemplate, templateStats } from './templates';

/**
 * Car models module: four original procedural car bodies (lofted cross-sections with wheel arches, panel gaps,
 * integrated lamps, glass and interior), six rim designs, body kits, paint finishes and damage.
 * Templates are built lazily per model/LOD and shared; each CarVisual clones only what it deforms.
 */
export class CarFactory implements ICarFactory {
  readonly name = 'cars';
  readonly models: CarModelInfo[] = (Object.keys(SPECS) as CarModelId[]).map((id) => ({ id, name: SPECS[id].name, description: SPECS[id].description }));
  private live = new Set<CarVisualImpl>();
  private host: VisualHost;

  constructor(private ctx: GameContext) {
    const env = () => (this.ctx.env as { patchMaterial?: (m: THREE.Material, k: 'vehicle') => void } | undefined);
    this.host = {
      physical: () => this.ctx.quality?.level !== 'low',
      shadows: () => this.ctx.quality?.current?.shadows !== false,
      patchPaint: (m) => env()?.patchMaterial?.(m, 'vehicle'),
      release: (v) => this.live.delete(v),
    };
  }

  init(): void {
    this.ctx.events.on('qualityChanged', () => {
      for (const v of this.live) v.refreshQuality();
    });
    // Warm the default model so the first spawn does not hitch on geometry generation.
    try {
      getHighTemplate('coupe');
    } catch (err) {
      console.error('[cars] template build failed', err);
    }
    if (this.ctx.debug) {
      (window as unknown as Record<string, unknown>).__cars = {
        factory: this,
        THREE,
        RoomEnvironment,
        instancing: getInstancingGeometry,
        beam: getBeamGeometry,
        stats: templateStats,
        lowTemplate: getLowTemplate,
      };
    }
  }

  create(build: CarBuild, opts?: { lod?: 'high' | 'low' }): CarVisual {
    const v = new CarVisualImpl(this.host, build, opts?.lod ?? 'high');
    this.live.add(v);
    return v;
  }

  instancingGeometry(model: CarModelId): THREE.BufferGeometry | null {
    try {
      return getInstancingGeometry(model);
    } catch (err) {
      console.error('[cars] instancing geometry failed', err);
      return null;
    }
  }

  instancingBeamGeometry(model: CarModelId): THREE.BufferGeometry | null {
    try {
      return getBeamGeometry(model);
    } catch (err) {
      console.error('[cars] beam geometry failed', err);
      return null;
    }
  }
}
