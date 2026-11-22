import type { GameContext, IAudio } from '../game/contracts';

/** STUB — replaced by the audio module (procedural Web Audio). */
export class Audio implements IAudio {
  readonly name = 'audio';
  unlocked = false;
  constructor(private ctx: GameContext) {}
  init(): void {}
  unlock(): void { this.unlocked = true; }
  ui(): void {}
}
