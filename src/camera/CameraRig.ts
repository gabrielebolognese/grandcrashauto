import * as THREE from 'three';
import type { CameraMode, GameContext, ICameraRig } from '../game/contracts';

/** STUB — replaced by the camera module (chase spring cam, hood, orbit, cinematic, shake). */
export class CameraRig implements ICameraRig {
  readonly name = 'camera';
  mode: CameraMode = 'showcase';
  private t = 0;
  private tmp = new THREE.Vector3();
  private up = new THREE.Vector3(0, 3, 0);
  constructor(private ctx: GameContext) {}
  init(): void {}
  cycleMode(): void {
    this.mode = this.mode === 'chase' ? 'hood' : 'chase';
  }
  setMode(mode: CameraMode): void {
    this.mode = mode;
  }
  shake(): void {}
  startCinematic(): void {}
  skipCinematic(): void {}
  snap(): void {}

  update(dt: number): void {
    const cam = this.ctx.engine.camera;
    const v = this.ctx.vehicle;
    if ((this.mode === 'chase' || this.mode === 'hood') && v.active) {
      const s = v.state;
      if (this.mode === 'hood') {
        cam.position.copy(s.position).addScaledVector(s.forward, 0.5);
        cam.position.y += 1.3;
        this.tmp.copy(s.position).addScaledVector(s.forward, 10);
        this.tmp.y = s.position.y + 1;
        cam.lookAt(this.tmp);
      } else {
        this.tmp.copy(s.position).addScaledVector(s.forward, -7).add(this.up);
        cam.position.lerp(this.tmp, 1 - Math.exp(-6 * dt));
        this.tmp.copy(s.position);
        this.tmp.y += 1;
        cam.lookAt(this.tmp);
      }
    } else {
      this.t += dt * 0.05;
      cam.position.set(Math.cos(this.t) * 160, 70, Math.sin(this.t) * 160);
      cam.lookAt(0, 0, 0);
    }
  }
}
