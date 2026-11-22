import { CONFIG } from '../config';
import { damp, lerp } from '../core/math';
import type { EventBus } from '../core/EventBus';
import type { GameEvents } from '../core/events';
import { rpmAtSpeed, torqueFactor, type VehicleParams } from './tuning';

/**
 * Engine + automatic 5-speed gearbox + reverse (spec §6). Owner: src/vehicle.
 *  - rpm follows the wheels (with clutch slip when pulling away and free revs when airborne / clutch in),
 *  - shift points depend on throttle (short shifts when cruising, near redline flat out, kickdown),
 *  - a short torque cut on every shift, a bouncing rev limiter, optional turbo spool (upgraded engines).
 */
export class Drivetrain {
  gear = 1; // -1 R, 1..5
  rpm = 900;
  boost = 0;
  /** >0 while a shift is in progress (torque cut). */
  shiftTimer = 0;
  private limiterTimer = 0;

  constructor(private events: EventBus<GameEvents>) {}

  reset(p: VehicleParams): void {
    this.gear = 1;
    this.rpm = p.idleRpm;
    this.boost = 0;
    this.shiftTimer = 0;
    this.limiterTimer = 0;
  }

  ratio(p: VehicleParams, gear = this.gear): number {
    return gear < 0 ? p.reverseRatio : p.gears[Math.min(5, Math.max(1, gear)) - 1];
  }

  /**
   * Advance one fixed step and return the total drive force at the wheels (N, + = forward).
   * @param throttle drive pedal 0..1 for the current direction
   * @param reverse  reverse gear requested
   * @param speed    signed forward speed (m/s)
   * @param grounded any wheel touching the ground
   * @param clutchIn engine disconnected from the wheels (handbrake on a RWD car): free revs, no drive
   */
  step(dt: number, p: VehicleParams, throttle: number, reverse: boolean, speed: number, grounded: boolean, clutchIn: boolean): number {
    const E = CONFIG.vehicle.engine;
    const redline = p.redlineRpm;

    // Direction changes
    if (reverse && this.gear !== -1) {
      this.gear = -1;
      this.shiftTimer = E.downshiftTime;
      this.events.emit('gearShift', { gear: -1, up: false });
    } else if (!reverse && this.gear === -1) {
      this.gear = 1;
      this.shiftTimer = E.downshiftTime;
      this.events.emit('gearShift', { gear: 1, up: true });
    }

    // Automatic shifting (only with the wheels on the ground and the clutch engaged)
    if (this.gear > 0 && grounded && !clutchIn && this.shiftTimer <= 0) {
      const upRpm = lerp(E.shiftUpLight, E.shiftUp, throttle) * redline;
      const downRpm = lerp(E.shiftDownLight, E.shiftDown, throttle) * redline;
      const wr = rpmAtSpeed(p, this.ratio(p), speed);
      if (this.gear < 5 && wr > upRpm && speed > 0) {
        this.gear++;
        this.shiftTimer = E.shiftTime;
        this.events.emit('gearShift', { gear: this.gear, up: true });
      } else if (this.gear > 1 && wr < downRpm && rpmAtSpeed(p, this.ratio(p, this.gear - 1), speed) < upRpm * 0.9) {
        this.gear--;
        this.shiftTimer = E.downshiftTime;
        this.events.emit('gearShift', { gear: this.gear, up: false });
      }
    }
    if (this.shiftTimer > 0) this.shiftTimer -= dt;

    // Engine speed
    const ratio = this.ratio(p);
    const wheelRpm = rpmAtSpeed(p, ratio, speed);
    let target: number;
    let response: number;
    if (clutchIn || !grounded) {
      target = throttle > 0.05 ? lerp(p.idleRpm, redline * 1.02, throttle) : p.idleRpm;
      response = E.freeRevResponse;
    } else {
      target = Math.max(wheelRpm, p.idleRpm);
      if (this.gear === 1 || this.gear === -1) target = Math.max(target, p.idleRpm + (p.launchRpm - p.idleRpm) * throttle);
      response = this.shiftTimer > 0 ? E.rpmResponse * 1.5 : E.rpmResponse;
    }
    this.rpm = damp(this.rpm, Math.min(target, redline * 1.03), response, dt);

    // Rev limiter: fuel cut + rpm dip (audible bounce)
    if (this.limiterTimer > 0) this.limiterTimer -= dt;
    else if (this.rpm >= redline * 0.995 && throttle > 0.1) {
      this.limiterTimer = E.limiterCut;
      this.rpm -= redline * 0.04;
    }

    // Turbo spool (perf engine ≥ 1)
    if (p.turbo > 0) {
      const want = throttle > 0.5 && this.rpm > 0.4 * redline && this.shiftTimer <= 0 ? throttle : 0;
      this.boost = want > this.boost ? Math.min(want, this.boost + E.turboSpool * dt) : Math.max(want, this.boost - E.turboDecay * dt);
    } else this.boost = 0;

    if (clutchIn || this.shiftTimer > 0 || this.limiterTimer > 0 || throttle <= 0) return 0;
    if (grounded && wheelRpm > redline * 1.01) return 0; // past the gear's limit
    const torque = p.peakTorque * torqueFactor(this.rpm / redline) * throttle * (1 + this.boost * p.turbo);
    let force = (torque * ratio * p.finalDrive * p.efficiency) / p.wheelRadius;
    if (this.gear < 0) {
      const over = Math.abs(speed) - p.maxReverseSpeed;
      if (over > 0) force *= Math.max(0, 1 - over / 2);
      force = -force;
    }
    return force;
  }

  /** Engine braking force magnitude (N) with the throttle released. */
  engineBrake(p: VehicleParams): number {
    if (this.gear === 0) return 0;
    const n = (this.rpm - p.idleRpm) / Math.max(1, p.redlineRpm - p.idleRpm);
    return p.engineBraking * Math.max(0, n);
  }

  normRpm(p: VehicleParams): number {
    return Math.min(1, Math.max(0, (this.rpm - p.idleRpm) / Math.max(1, p.redlineRpm - p.idleRpm)));
  }
}
