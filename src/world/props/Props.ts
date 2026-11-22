import type { GameContext, IProps } from '../../game/contracts';

/** STUB — replaced by the props module (street furniture, parked cars). */
export class Props implements IProps {
  readonly name = 'props';
  constructor(private ctx: GameContext) {}
  init(): void {}
  isDisturbed(): boolean { return false; }
}
