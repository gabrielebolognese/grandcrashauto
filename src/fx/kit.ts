import * as THREE from 'three';
import type { ParticlePool, Spawn } from './ParticlePool';

/** What effect builders (explosion, emitters, wheel fx) need from the Fx system. */
export interface FxKit {
  /** fx clock (game time, slowed by slow-mo, frozen while paused). */
  readonly time: number;
  /** Last update's game dt (for per-frame callers like spraySheet). */
  readonly dt: number;
  /** Alpha-ish pool drawn first: smoke, dust, debris, glass. */
  readonly main: ParticlePool;
  /** Pool drawn after `main`: fireballs, flames, sparks, embers, glows, shock domes. */
  readonly glow: ParticlePool;
  /** Long-lived ground decals (scorch marks). */
  readonly decals: ParticlePool;
  /** Scratch spawn record (always reset() before use). */
  readonly s: Spawn;
  /** Current quality particle scale (counts multiplier). */
  readonly q: number;
  /** Wind velocity (m/s) smoke drifts toward. */
  readonly wind: THREE.Vector3;
  /** Gravity (negative, m/s²). */
  readonly gravity: number;
  ground(x: number, z: number): number;
  /** Light flash (pooled point lights). delay in s; color defaults to warm fire white. */
  flash(x: number, y: number, z: number, peak: number, decay: number, distance: number, delay?: number, r?: number, g?: number, b?: number): void;
}

export const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
export const rndS = (): number => Math.random() * 2 - 1;
export const pick = <T>(a: T, b: T): T => (Math.random() < 0.5 ? a : b);

/** Uniform random unit vector. */
export function randDir(out: THREE.Vector3): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(t), z, r * Math.sin(t));
}

/** Random point inside the unit ball (scaled). */
export function randInBall(out: THREE.Vector3, radius: number): THREE.Vector3 {
  randDir(out);
  return out.multiplyScalar(radius * Math.cbrt(Math.random()));
}

/** Count helper: base × scale, rounded with a random remainder (so small scales still sometimes emit). */
export function count(base: number, scale: number, max = 1e9): number {
  const v = base * scale;
  const n = Math.floor(v) + (Math.random() < v - Math.floor(v) ? 1 : 0);
  return Math.min(max, n);
}
