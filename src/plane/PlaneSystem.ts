import * as THREE from 'three';
import type { GameContext, IPlaneSystem, PlaneCameraTarget } from '../game/contracts';
import type { PlaneState, PlaneVisual } from './types';

/** STUB — replaced by the flight module (flight model, gear, engines, boarding, out-of-map, assists). */
export function emptyPlaneState(): PlaneState {
  return {
    type: null, phase: 'none',
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1),
    airspeed: 0, airspeedKmh: 0, groundSpeedKmh: 0, altitude: 0, altitudeAgl: 0, verticalSpeed: 0, heading: 0, pitch: 0, bank: 0, aoa: 0,
    throttle: 0, flaps: 0, gear: 1, onGround: true, brake: false, stall: false, stallWarning: false,
    rotationSpeedKmh: 0, stallSpeedKmh: 0, engines: [], assisted: true,
    outOfMap: { state: 'ok', countdown: 0, distance: 0, failed: 0, total: 0 },
    damage: { tailLost: false, split: false, drag: 0 },
    canExit: false,
  };
}

export class PlaneSystem implements IPlaneSystem {
  readonly name = 'planes';
  active = false;
  readonly state: PlaneState = emptyPlaneState();
  visual: PlaneVisual | null = null;
  cameraTarget: PlaneCameraTarget | null = null;
  boardCandidate = null;
  crashed = false;
  crashTime = 0;
  inCockpitSequence = false;
  constructor(private ctx: GameContext) {}
  init(): void {}
  board(): boolean { return false; }
  exit(): boolean { return false; }
  explodeEngine(): void {}
  explode(): void {}
  explodeMiddle(): void {}
  explodeTail(): void {}
  respawnPlane(): void {}
  retryInAir(): void {}
  backToCar(): void {
    this.ctx.game.setMode('car');
  }
  skipSequence(): void {}
}
