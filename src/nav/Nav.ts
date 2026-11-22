import type * as THREE from 'three';
import type { GameContext, INav, PointOfInterest } from '../game/contracts';

/** STUB — replaced by the nav module (A* directions, route ribbon, turn card, map screen, teleport). */
export class Nav implements INav {
  readonly name = 'nav';
  pois: PointOfInterest[] = [];
  route: THREE.Vector3[] | null = null;
  destination: PointOfInterest | null = null;
  nextTurn = null;
  mapOpen = false;
  constructor(private ctx: GameContext) {}
  init(): void {}
  setDestination(): void {}
  teleport(): void {}
  openMap(): void {}
  closeMap(): void {}
}
