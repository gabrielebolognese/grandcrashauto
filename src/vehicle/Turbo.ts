import { CONFIG } from '../config';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';

/**
 * Turbo meter + push envelope (SPEC-PART3 §7). Owner: src/vehicle.
 * The vehicle applies the forces/handling changes; this class owns the charge, activation edges, build-in envelope,
 * the lift-off kick timer and the smooth wobble noise.
 */
export class Turbo {
  charge = 1;
  active = false;
  /** 0..1 push envelope (builds in over CONFIG.vehicle.turbo.buildIn). */
  level = 0;
  /** >0 while the lift-off oversteer kick is running. */
  liftOffT = 0;
  /** Set for one step when turbo just engaged (nose-lift impulse). */
  justStarted = false;
  /** Set for one step when turbo just released (lift-off kick check). */
  justReleased = false;
  private locked = false;
  private t = 0;
  private seed = Math.random() * 100;

  constructor(private events: EventBus<GameEvents>) {}

  reset(): void {
    if (this.active) this.events.emit('turbo', { on: false });
    this.charge = 1;
    this.active = false;
    this.level = 0;
    this.liftOffT = 0;
    this.locked = false;
    this.justStarted = this.justReleased = false;
  }

  /** Stop boosting immediately (explosion, plane mode…) without touching the charge. */
  cut(): void {
    if (this.active) {
      this.active = false;
      this.events.emit('turbo', { on: false });
    }
    this.level = 0;
  }

  step(dt: number, held: boolean, airborne: boolean, perfTurbo: number, rechargeMul: number, restStop: boolean): void {
    const C = CONFIG.vehicle.turbo;
    this.t += dt;
    this.justStarted = this.justReleased = false;
    if (restStop) this.charge = 1;
    if (this.locked && this.charge >= C.minRestart) this.locked = false;
    const want = held && !this.locked && this.charge > 0;
    if (want && !this.active) {
      this.active = true;
      this.justStarted = true;
      this.events.emit('turbo', { on: true });
    } else if (!want && this.active) {
      this.active = false;
      this.justReleased = this.level > 0.5;
      this.events.emit('turbo', { on: false });
    }
    const drain = C.drainTime * (perfTurbo >= 2 ? C.perfDrain2 : perfTurbo >= 1 ? C.perfDrain1 : 1);
    if (this.active) {
      this.charge -= (dt / Math.max(0.5, drain)) * (airborne ? C.airDrain : 1);
      if (this.charge <= 0) {
        this.charge = 0;
        this.locked = true;
      }
      this.level = Math.min(1, this.level + dt / Math.max(0.01, C.buildIn));
    } else {
      this.charge = Math.min(1, this.charge + (dt / Math.max(0.5, C.rechargeTime)) * rechargeMul);
      this.level = Math.max(0, this.level - dt / Math.max(0.01, C.release));
    }
    if (this.liftOffT > 0) this.liftOffT -= dt;
  }

  /** Smooth noise in [-1, 1] (sum of incommensurate sines) at frequency f Hz. */
  noise(f: number, channel = 0): number {
    const x = (this.t + this.seed + channel * 17.31) * f * Math.PI * 2;
    return (Math.sin(x) * 0.55 + Math.sin(x * 1.618 + 1.3) * 0.3 + Math.sin(x * 2.719 + 4.1) * 0.15);
  }

  accelFor(perfTurbo: number): number {
    const C = CONFIG.vehicle.turbo;
    return C.accel * (perfTurbo >= 2 ? C.perfAccel2 : perfTurbo >= 1 ? C.perfAccel1 : 1);
  }

  topFactorFor(perfTurbo: number): number {
    const C = CONFIG.vehicle.turbo;
    return C.topFactor + (perfTurbo >= 2 ? C.perfTop2 : perfTurbo >= 1 ? C.perfTop1 : 0);
  }
}
