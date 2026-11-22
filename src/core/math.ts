/** Small math helpers shared by all modules. */
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential smoothing. lambda ~ responsiveness (1/s). */
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));
export const approach = (current: number, target: number, maxDelta: number) =>
  current < target ? Math.min(current + maxDelta, target) : Math.max(current - maxDelta, target);
export const wrapAngle = (a: number) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};
export const dampAngle = (current: number, target: number, lambda: number, dt: number) =>
  current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
export const DEG = Math.PI / 180;
export const KMH = 3.6; // m/s -> km/h
export const MPH = 2.23694; // m/s -> mph

/** World convention: yaw 0 faces +Z. forward = (sin yaw, 0, cos yaw). right = (-cos yaw, 0, sin yaw). */
export const yawForward = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
export const yawFromDir = (dx: number, dz: number) => Math.atan2(dx, dz);
