import * as THREE from 'three';

/**
 * Global shader uniforms shared by every custom material (facades, water, foliage sway, NPC skinning...).
 * Owner: core. WRITTEN ONLY by the environment module each frame; everyone else just references these objects
 * in their ShaderMaterial / onBeforeCompile uniforms (pass the object itself, not a copy, so updates propagate).
 */
export const GLOBAL_UNIFORMS = {
  uTime: { value: 0 }, // seconds of game time
  uNight: { value: 0 }, // 0 day .. 1 night (window lights, streetlights, emissive)
  uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() }, // world-space direction TO the sun
  uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
  uFogColor: { value: new THREE.Color(0.75, 0.87, 0.93) },
  uFogNear: { value: 120 },
  uFogFar: { value: 700 },
};
