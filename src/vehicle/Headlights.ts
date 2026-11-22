import * as THREE from 'three';
import { CONFIG } from '../config';

export type BeamMode = 'off' | 'low' | 'high';

/**
 * The player's headlight SpotLight pair (SPEC-PART3 light budget). Created ONCE at init and never removed —
 * switched off with intensity 0 (adding/removing lights recompiles every shader). Owner: src/vehicle.
 * Positioned every frame from the car's interpolated transform; flagged noOriginShift (we place them ourselves).
 */
export class Headlights {
  readonly lights: THREE.SpotLight[] = [];
  /** Player override cycled with the 'lights' trigger: null = automatic. */
  override: BeamMode | null = null;
  mode: BeamMode = 'off';
  private color = new THREE.Color('#fff6e0');
  private v = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < 2; i++) {
      const l = new THREE.SpotLight(0xfff6e0, 0, 50, 0.5, 0.5, 1.4);
      l.castShadow = false;
      l.visible = true; // keep the light count constant: visibility toggles would recompile shaders too
      l.userData.noOriginShift = true;
      l.target.userData.noOriginShift = true;
      scene.add(l, l.target);
      this.lights.push(l);
    }
  }

  /** 'lights' trigger: off → low → high → back to automatic. */
  cycle(autoOn: boolean): void {
    const cur = this.override ?? (autoOn ? 'low' : 'off');
    this.override = cur === 'off' ? 'low' : cur === 'low' ? 'high' : null;
  }

  setColor(hex: string): void {
    this.color.set(hex);
    for (const l of this.lights) l.color.copy(this.color);
  }

  /**
   * Place and drive the lights. `root` = car root (interpolated), halfLength = chassis half length (front of the car).
   * Returns the effective mode.
   */
  update(root: THREE.Object3D | null, halfLength: number, autoOn: boolean, enabled: boolean): BeamMode {
    const H = CONFIG.vehicle.headlights;
    const mode: BeamMode = !enabled || !root ? 'off' : (this.override ?? (autoOn ? 'low' : 'off'));
    this.mode = mode;
    const high = mode === 'high';
    for (let i = 0; i < 2; i++) {
      const l = this.lights[i];
      if (mode === 'off' || !root) {
        l.intensity = 0;
        continue;
      }
      const side = i === 0 ? 1 : -1;
      const z = halfLength - H.inset;
      this.v.set(side * H.spread, H.height, z).applyQuaternion(root.quaternion).add(root.position);
      l.position.copy(this.v);
      const dist = high ? H.highDistance : H.lowDistance;
      const pitch = high ? H.highPitch : H.lowPitch;
      this.v.set(side * H.spread * 0.6, H.height + Math.tan(pitch) * dist, z + dist).applyQuaternion(root.quaternion).add(root.position);
      l.target.position.copy(this.v);
      l.intensity = high ? H.highIntensity : H.lowIntensity;
      l.distance = dist * 1.6;
      l.angle = high ? H.highAngle : H.lowAngle;
      l.penumbra = H.penumbra;
      l.decay = H.decay;
    }
    return mode;
  }
}
