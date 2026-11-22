import type { GameContext, IGarage } from '../../game/contracts';

/** STUB — replaced by the garage module (garage scene + customization UI). */
export class Garage implements IGarage {
  readonly name = 'garage';
  isOpen = false;
  constructor(private ctx: GameContext) {}
  init(): void {}
  open(): void {
    this.isOpen = true;
    // Stub: immediately drive the current car.
    setTimeout(() => this.ctx.game.driveFromGarage(this.ctx.save.data.garage.current), 0);
  }
  close(): void { this.isOpen = false; }
}
