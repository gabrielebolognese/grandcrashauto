import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';

/**
 * Shared GLSL + uniform objects for every environment material (sky, ocean, clouds, scenery).
 * The same uniform OBJECTS are referenced by all materials, so the Environment updates them once per frame.
 * Note: GLOBAL uSunDir is the LIGHT direction (sun by day, moon by night); uSkySun is the true sun (sky glow).
 */

export const SKY_UNIFORMS = {
  uZenith: { value: new THREE.Color() },
  uSkyMid: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uSkyGround: { value: new THREE.Color() },
  uGlow: { value: new THREE.Color() },
  uGlowStrength: { value: 0.5 },
  uSkySun: { value: new THREE.Vector3(0, 1, 0) },
  uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunDisk: { value: 20 },
  uSunSize: { value: 1 },
  uMoon: { value: 0 },
  uStars: { value: 0 },
  uMilky: { value: 0 },
  /** 0..1 cloud cover (sky deck). */
  uCover: { value: 0 },
  uCloudOff: { value: new THREE.Vector2() },
  uCloudTex: { value: null as THREE.Texture | null },
  uCloudLit: { value: new THREE.Color(1, 1, 1) },
  uCloudShade: { value: new THREE.Color(0.6, 0.6, 0.75) },
  /** 0..1 — camera inside a cloud: everything turns to fog colour. */
  uWhiteout: { value: 0 },
  /** Sun radiance (colour × intensity, linear) — for env materials doing their own lighting. */
  uSunLight: { value: new THREE.Color(3, 3, 3) },
  /** Ambient irradiance (hemisphere sky colour × intensity). */
  uAmbient: { value: new THREE.Color(1, 1, 1) },
  uAmbientGround: { value: new THREE.Color(0.5, 0.5, 0.6) },
};

/** Uniforms every env material gets (globals + sky). Spread into a material's uniforms (keeps object identity). */
export function envUniforms(): Record<string, THREE.IUniform> {
  return {
    uTime: GLOBAL_UNIFORMS.uTime,
    uNight: GLOBAL_UNIFORMS.uNight,
    uSunDir: GLOBAL_UNIFORMS.uSunDir,
    uSunColor: GLOBAL_UNIFORMS.uSunColor,
    uFogColor: GLOBAL_UNIFORMS.uFogColor,
    uFogNear: GLOBAL_UNIFORMS.uFogNear,
    uFogFar: GLOBAL_UNIFORMS.uFogFar,
    uOrigin: GLOBAL_UNIFORMS.uOrigin,
    uWind: GLOBAL_UNIFORMS.uWind,
    uLightning: GLOBAL_UNIFORMS.uLightning,
    uFogDensity: GLOBAL_UNIFORMS.uFogDensity,
    ...SKY_UNIFORMS,
  };
}

export const GLSL_ENV_PARS = /* glsl */ `
uniform float uTime;
uniform float uNight;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uOrigin;
uniform vec3 uWind;
uniform float uLightning;
uniform float uFogDensity;
uniform vec3 uZenith;
uniform vec3 uSkyMid;
uniform vec3 uHorizon;
uniform vec3 uSkyGround;
uniform vec3 uGlow;
uniform float uGlowStrength;
uniform vec3 uSkySun;
uniform vec3 uMoonDir;
uniform float uSunDisk;
uniform float uSunSize;
uniform float uMoon;
uniform float uStars;
uniform float uMilky;
uniform float uCover;
uniform vec2 uCloudOff;
uniform sampler2D uCloudTex;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uWhiteout;
uniform vec3 uSunLight;
uniform vec3 uAmbient;
uniform vec3 uAmbientGround;

float envHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float envHash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

// Clear-sky radiance (linear HDR) in a direction, without sun disk / moon / stars / cloud deck.
// Below the horizon it stays at the horizon haze colour (seamless with sea haze and fog).
vec3 skyColor(vec3 dir) {
  float h = dir.y;
  float hp = max(h, 0.0);
  vec3 col = mix(uHorizon, uSkyMid, smoothstep(0.0, 0.28, pow(hp, 0.85)));
  col = mix(col, uZenith, smoothstep(0.18, 1.0, hp));
  float sd = max(dot(normalize(vec3(dir.x, hp, dir.z)), uSkySun), 0.0);
  float band = exp(-hp * 4.0);
  col += uGlow * uGlowStrength * (0.6 * pow(sd, 4.0) * band + 0.3 * pow(sd, 20.0) + 0.5 * pow(sd, 180.0));
  return col;
}

// Cloud deck (weather): density 0..1 and its colour. Cheap: two taps of a tileable noise texture.
float cloudDeck(vec3 dir, out vec3 deckCol) {
  float hp = max(dir.y, 0.0);
  vec2 uv = dir.xz / (hp + 0.09) * 0.22 + uCloudOff;
  float n = textureLod(uCloudTex, uv, 0.0).b * 0.62 + textureLod(uCloudTex, uv * 2.9 + 0.37, 0.0).b * 0.38;
  float th = 1.0 - uCover * 1.05;
  float c = smoothstep(th, th + 0.32, n);
  c = mix(c, 1.0, smoothstep(0.72, 0.98, uCover));
  float sd = max(dot(dir, uSkySun), 0.0);
  float dens = smoothstep(0.35, 1.0, n) * uCover;
  deckCol = mix(uCloudLit, uCloudShade, 0.35 + 0.5 * dens);
  deckCol += uGlow * uGlowStrength * pow(sd, 6.0) * (1.0 - dens) * 0.6;
  deckCol += vec3(0.75, 0.8, 1.0) * uLightning * 1.1 * (0.4 + n);
  return c * smoothstep(-0.02, 0.12, dir.y);
}

// Aerial perspective: blend toward the sky colour at the horizon in that direction.
vec3 envHaze(vec3 col, vec3 viewDir, float amount) {
  vec3 hz = skyColor(normalize(vec3(viewDir.x, max(viewDir.y, 0.0) * 0.35, viewDir.z)));
  hz = mix(hz, uFogColor, smoothstep(0.4, 1.0, uCover) * 0.7);
  col = mix(col, hz, clamp(amount, 0.0, 1.0));
  return mix(col, uFogColor, max(uWhiteout, uFogDensity * smoothstep(0.0, 0.5, amount)));
}
`;

/** Tone mapping + colour space for custom ShaderMaterials (no-ops when rendering into the post composer target). */
export const GLSL_OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
