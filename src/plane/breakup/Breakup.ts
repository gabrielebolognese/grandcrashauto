import type { GameContext, IBreakup } from '../../game/contracts';
import type { WreckPiece } from '../types';

/** STUB — replaced by the breakup module (crash detection, water forces, momentum-correct breakup, wreck fires). */
export class Breakup implements IBreakup {
  readonly name = 'breakup';
  pieces: WreckPiece[] = [];
  focusPiece: WreckPiece | null = null;
  constructor(private ctx: GameContext) {}
  init(): void {}
  track(): void {}
  untrack(): void {}
  breakJoints(): WreckPiece[] { return []; }
  explodeTotal(): void {}
  hardLanding(): void {}
  crash(): void {}
  clear(): void {}
}
