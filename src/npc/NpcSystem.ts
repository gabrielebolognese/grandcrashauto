import type { GameContext, INpcSystem } from '../game/contracts';

/** STUB — replaced by the npc module (pedestrian crowd). */
export class NpcSystem implements INpcSystem {
  readonly name = 'npcs';
  activeCount = 0;
  constructor(private ctx: GameContext) {}
  init(): void {}
}
