import type { CarBuild } from './CarBuild';

/**
 * Build → physics parameters and garage stat bars (spec §7 Performance). Owner: src/vehicle (vehicle physics agent).
 * STUB signature — the vehicle module replaces the implementation; keep the exported names/signatures stable
 * (the garage UI imports computeStats).
 */
export interface CarStats {
  topSpeedKmh: number; // predicted top speed
  topSpeed: number; // 0..1 bar
  accel: number; // 0..1 bar
  grip: number; // 0..1 bar
  braking: number; // 0..1 bar
}

export function computeStats(build: CarBuild): CarStats {
  const p = build.perf;
  const base = { coupe: 0.62, muscle: 0.6, hatch: 0.45, suv: 0.42 }[build.model];
  return {
    topSpeedKmh: 170 + p.engine * 15 + base * 20,
    topSpeed: Math.min(1, base + p.engine * 0.15),
    accel: Math.min(1, base + p.engine * 0.17),
    grip: Math.min(1, 0.45 + p.tyres * 0.2 + p.suspension * 0.05),
    braking: Math.min(1, 0.45 + p.brakes * 0.22),
  };
}
