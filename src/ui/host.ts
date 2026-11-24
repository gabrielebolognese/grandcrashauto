import type { GameContext } from '../game/contracts';
import type { Tilt } from './touch/Tilt';

/** What screens/components need from the UI orchestrator (keeps imports one-directional). */
export interface UIHost {
  readonly ctx: GameContext;
  readonly tilt: Tilt;
  readonly isMobile: boolean;
  /** True when touch controls/hints should be shown (touch device and last input was touch). */
  touchMode(): boolean;
  /** Open settings, optionally on a tab ('graphics' | 'controls' | 'world' | 'gameplay' | 'audio'). */
  openSettings(tab?: string): void;
  openCredits(): void;
  closeSub(): void;
  confirm(opts: ConfirmOpts): Promise<boolean>;
  toast(text: string, ms?: number): void;
  vibrate(pattern: number | number[]): void;
  /** Recording mode (every button tiny in one corner). */
  readonly recMode: boolean;
  setRecMode(on: boolean): void;
}

export interface ConfirmOpts {
  title: string;
  message: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

/** A full-screen UI layer that the menu navigator can drive with keyboard / gamepad. */
export interface Screen {
  readonly el: HTMLElement;
  setVisible(on: boolean): void;
  /** Escape / gamepad B. Return false if not handled. */
  back?(): boolean;
}
