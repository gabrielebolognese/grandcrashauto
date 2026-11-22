import * as THREE from 'three';
import { CONFIG } from '../../config';

/**
 * Game clock (SPEC-PART3 §5): hours 0..24, a full day in settings.dayLengthMin real minutes, pausable.
 * Sun arc from latitude + declination (seasonal tilt), moon with phases cycling every CONFIG.env.moonCycleDays.
 * Frame: north = -Z, east = +X, south = +Z, up = +Y.
 */

const D2R = Math.PI / 180;
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _w = new THREE.Vector3(-1, 0, 0); // west at the horizon

export class Clock {
  hours = 10;
  /** Whole game days elapsed (moon phases). */
  day = 0;
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  readonly moonDir = new THREE.Vector3(0, 1, 0);
  sunElevation = 45; // degrees
  moonElevation = 30;
  /** 0 = new, 0.5 = full. */
  moonPhase = 0.35;
  /** Lit fraction of the moon disk 0..1. */
  moonIllum = 0.8;

  setHours(h: number): void {
    this.hours = ((h % 24) + 24) % 24;
    this.compute();
  }

  advance(realDt: number, dayLengthMin: number): void {
    const len = Math.max(1, dayLengthMin) * 60;
    this.hours += (realDt * 24) / len;
    while (this.hours >= 24) {
      this.hours -= 24;
      this.day++;
    }
    this.compute();
  }

  /** Celestial direction for an hour angle (deg) and declination (deg). */
  private celestial(hourAngleDeg: number, declDeg: number, out: THREE.Vector3): THREE.Vector3 {
    const lat = CONFIG.env.latitudeDeg * D2R;
    const d = declDeg * D2R;
    const h = hourAngleDeg * D2R;
    // Celestial pole (north, raised by latitude) and the equator's meridian point (south, raised by 90° - latitude).
    _p.set(0, Math.sin(lat), -Math.cos(lat));
    _s.set(0, Math.cos(lat), Math.sin(lat));
    out.copy(_p).multiplyScalar(Math.sin(d));
    out.addScaledVector(_s, Math.cos(d) * Math.cos(h));
    out.addScaledVector(_w, Math.cos(d) * Math.sin(h));
    return out.normalize();
  }

  compute(): void {
    const hourAngle = (this.hours - 12) * 15;
    this.celestial(hourAngle, CONFIG.env.declinationDeg, this.sunDir);
    this.sunElevation = Math.asin(THREE.MathUtils.clamp(this.sunDir.y, -1, 1)) / D2R;
    const cycle = Math.max(1, CONFIG.env.moonCycleDays);
    this.moonPhase = (((this.day + this.hours / 24) / cycle + 0.35) % 1 + 1) % 1;
    this.moonIllum = 0.5 - 0.5 * Math.cos(this.moonPhase * Math.PI * 2);
    // The moon lags the sun by phase × 24 h; slightly different declination.
    this.celestial(hourAngle - this.moonPhase * 360, -CONFIG.env.declinationDeg * 0.6, this.moonDir);
    this.moonElevation = Math.asin(THREE.MathUtils.clamp(this.moonDir.y, -1, 1)) / D2R;
  }
}
