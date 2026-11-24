import * as THREE from 'three';
import { CONFIG } from '../config';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { GameContext } from '../game/contracts';

/**
 * Terrain-module materials (all MeshStandardMaterial + onBeforeCompile patches, created ONCE at init):
 *  - shared aerial-perspective haze (distance + altitude + sun glow, follows the environment's fog distance so weather
 *    and cloud whiteout thicken it), applied before tone mapping like the env's own distant scenery;
 *  - terrain: smooth vertex colours + vertex normals (user request: no blocky facets), sRGB→linear, dynamic snow line
 *    (uSnowLine − uSnow), radial depth "squash" so terrain/mountain ring beyond the camera far plane still render;
 *  - foliage: wind sway (uWind, uTime); rotor: spinning turbine blades.
 * Patches chain with whatever env.patchMaterial installed (wetness / snow / puddles).
 */

export const TERRAIN_UNIFORMS = {
  /** x = haze mul, y = terrain view distance incl. altitude boost (m), z = squash enabled (0/1), w = base (ground) view distance */
  uTHaze: { value: new THREE.Vector4(0.62, 2200, 1, 0) },
  /** x = squash start, y = squash limit, z = falloff (m) */
  uTSquash: { value: new THREE.Vector3(1e6, 1e6 + 1, 1000) },
  uTSnowJitter: { value: 45 },
};

function chain(mat: THREE.Material, key: string, fn: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    fn(shader);
  };
  mat.customProgramCacheKey = () => {
    let k = '';
    try {
      k = prevKey.call(mat);
    } catch {
      /* default key */
    }
    return k + '|' + key;
  };
}

const HAZE_PARS = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogFar;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
uniform vec4 uTHaze;
varying vec3 vTWorld;
varying float vTDist;
vec3 terrainHaze(vec3 col) {
  float d = vTDist;
  vec3 V = (vTWorld - cameraPosition) / max(d, 1e-3);
  // aerial perspective follows our view distance; dense weather fog / cloud whiteout (short env fog) takes over
  float hd = uTHaze.y * uTHaze.x;
  hd = mix(hd, max(uFogFar * 0.55, 22.0), 1.0 - smoothstep(0.3, 0.75, uFogFar / max(uTHaze.w, 1.0)));
  float hz = 1.0 - exp(-pow(d / hd, 1.7));
  // thinner air: less haze along rays that stay high (camera and point altitude)
  hz *= exp(-max(0.0, 0.5 * (cameraPosition.y + vTWorld.y)) / 2600.0);
  hz = max(hz, smoothstep(uTHaze.y * 0.82, uTHaze.y, d));
  vec3 hazeCol = uFogColor + uSunColor * pow(max(dot(V, uSunDir), 0.0), 6.0) * (1.0 - uNight) * 0.2;
  float mid = smoothstep(200.0, 1800.0, d) * (1.0 - uNight * 0.7);
  col = mix(col, col * vec3(0.9, 0.95, 1.04) + hazeCol * 0.03, mid * 0.3);
  return mix(col, hazeCol, clamp(hz, 0.0, 1.0));
}
`;

const WORLD_VARYING_VERT = /* glsl */ `
varying vec3 vTWorld;
varying float vTDist;
`;

/** World position + view distance for the haze (after project_vertex). */
const WORLD_POS_VERT = /* glsl */ `
{
  vec4 tw = vec4(transformed, 1.0);
  #ifdef USE_BATCHING
    tw = batchingMatrix * tw;
  #endif
  #ifdef USE_INSTANCING
    tw = instanceMatrix * tw;
  #endif
  tw = modelMatrix * tw;
  vTWorld = tw.xyz;
  vTDist = length(mvPosition.xyz);
}
`;

function hazeUniforms(shader: THREE.WebGLProgramParametersWithUniforms): void {
  const G = GLOBAL_UNIFORMS;
  shader.uniforms.uFogColor = G.uFogColor;
  shader.uniforms.uFogFar = G.uFogFar;
  shader.uniforms.uSunDir = G.uSunDir;
  shader.uniforms.uSunColor = G.uSunColor;
  shader.uniforms.uNight = G.uNight;
  shader.uniforms.uTHaze = TERRAIN_UNIFORMS.uTHaze;
}

function addHaze(shader: THREE.WebGLProgramParametersWithUniforms, extraVert = ''): void {
  hazeUniforms(shader);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\n' + WORLD_VARYING_VERT)
    .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + WORLD_POS_VERT + extraVert);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + HAZE_PARS)
    .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n gl_FragColor.rgb = terrainHaze(gl_FragColor.rgb);');
}

/** Ground material for terrain tiles + the distant ring. */
export function createTerrainMaterial(ctx: GameContext): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: false, roughness: 0.94, metalness: 0, fog: false });
  mat.name = 'terrain.ground';
  try {
    ctx.env.patchMaterial?.(mat, 'ground');
  } catch (err) {
    console.warn('[terrain] env.patchMaterial failed', err);
  }
  chain(mat, 'terrain-ground-v2', (shader) => {
    const G = GLOBAL_UNIFORMS;
    shader.uniforms.uSnowLine = G.uSnowLine;
    shader.uniforms.uSnow = G.uSnow;
    shader.uniforms.uTSquash = TERRAIN_UNIFORMS.uTSquash;
    shader.uniforms.uTSnowJitter = TERRAIN_UNIFORMS.uTSnowJitter;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSnow;
uniform float uSnowLine;
uniform float uSnow;
uniform float uTSnowJitter;
uniform vec3 uTSquash;
uniform vec4 uTHaze;
varying float vSnowAmt;`,
      )
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  vColor.rgb = vColor.rgb * (vColor.rgb * (vColor.rgb * 0.305306011 + 0.682171111) + 0.012522878);
#endif`,
      );
    addHaze(
      shader,
      /* glsl */ `
{
  float line = uSnowLine - uSnow * 420.0 + (aSnow.y - 0.5) * uTSnowJitter;
  vSnowAmt = smoothstep(line - 14.0, line + 14.0, vTWorld.y) * smoothstep(0.3, 0.8, aSnow.x);
  float d = vTDist;
  if (uTHaze.z > 0.5 && d > uTSquash.x) {
    float d2 = uTSquash.x + (uTSquash.y - uTSquash.x) * (1.0 - exp(-(d - uTSquash.x) / uTSquash.z));
    // keep sea-bed vertices where they are (hidden behind the ocean), squash everything above water
    if (vTWorld.y > -0.8) gl_Position = projectionMatrix * vec4(mvPosition.xyz * (d2 / d), 1.0);
  }
}
`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSnowAmt;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.98), vSnowAmt);`,
      );
  });
  return mat;
}

/** Trees / bushes: vertex + instance colours, wind sway, haze. */
export function createFoliageMaterial(ctx: GameContext): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0, fog: false });
  mat.name = 'terrain.foliage';
  try {
    ctx.env.patchMaterial?.(mat, 'foliage');
  } catch {
    /* optional */
  }
  chain(mat, 'terrain-foliage-v1', (shader) => {
    const G = GLOBAL_UNIFORMS;
    shader.uniforms.uTime = G.uTime;
    shader.uniforms.uWind = G.uWind;
    shader.uniforms.uOrigin = G.uOrigin;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind;\nuniform vec3 uOrigin;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
{
  float sw = clamp(transformed.y / 11.0, 0.0, 1.0);
  sw *= sw;
  vec3 ip = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z) + uOrigin;
  float ph = dot(ip.xz, vec2(0.071, 0.053));
  float ws = length(uWind.xz);
  vec2 wd = ws > 0.01 ? uWind.xz / ws : vec2(1.0, 0.0);
  float s = sin(uTime * (1.3 + 0.08 * ws) + ph) + 0.35 * sin(uTime * 3.3 + ph * 1.7);
  float amp = (0.04 + 0.022 * min(ws, 18.0)) * sw;
  vec3 lw = transpose(mat3(instanceMatrix)) * vec3(wd.x, 0.0, wd.y);
  lw.y = 0.0;
  lw = normalize(lw + vec3(1e-5));
  transformed.xz += lw.xz * amp * (0.55 + 0.45 * s) * 1.6;
}
#endif`,
      );
    addHaze(shader);
  });
  return mat;
}

/** Rocks, structures, fences, features. `kind` decides which env patch applies. */
export function createSolidMaterial(ctx: GameContext, name: string, kind: 'ground' | 'building', roughness = 0.82): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0, fog: false });
  mat.name = name;
  try {
    ctx.env.patchMaterial?.(mat, kind);
  } catch {
    /* optional */
  }
  chain(mat, 'terrain-solid-v1', (shader) => addHaze(shader));
  return mat;
}

/** Wind turbine rotor: blades spin about the local Z axis (hub at the origin). */
export function createRotorMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, fog: false });
  mat.name = 'terrain.rotor';
  chain(mat, 'terrain-rotor-v1', (shader) => {
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.uniforms.uWind = GLOBAL_UNIFORMS.uWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
{
  float ph = dot(instanceMatrix[3].xz, vec2(0.37, 0.71));
  float ang = uTime * (0.7 + 0.05 * min(length(uWind), 14.0)) + ph;
  float c = cos(ang), s = sin(ang);
  transformed.xy = vec2(c * transformed.x - s * transformed.y, s * transformed.x + c * transformed.y);
}
#endif`,
      )
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 0.0, 1.0);');
    addHaze(shader);
  });
  mat.flatShading = true;
  return mat;
}

/** Lake water: glossy, env-reflective, hazed. */
export function createWaterMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2f8fae, roughness: 0.07, metalness: 0.05, fog: false, envMapIntensity: 1.2 });
  mat.name = 'terrain.lake';
  chain(mat, 'terrain-water-v1', (shader) => {
    shader.uniforms.uTime = GLOBAL_UNIFORMS.uTime;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
{
  vec2 p = vTWorld.xz;
  float a = sin(p.x * 0.21 + uTime * 1.1) + sin(p.y * 0.17 - uTime * 0.9) + 0.6 * sin((p.x + p.y) * 0.43 + uTime * 1.7);
  float b = cos(p.x * 0.19 - uTime * 0.8) + cos(p.y * 0.23 + uTime * 1.2) + 0.6 * cos((p.x - p.y) * 0.39 - uTime * 1.5);
  vec3 wn = normalize(vec3(a * 0.035, 1.0, b * 0.035));
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`,
      );
    addHaze(shader);
  });
  return mat;
}

/** Keep the haze/squash uniforms in sync with the camera + view distance (call once per frame). */
export function updateTerrainUniforms(camera: THREE.PerspectiveCamera, viewDistance: number, baseViewDistance = viewDistance): void {
  const T = TERRAIN_UNIFORMS;
  T.uTHaze.value.x = CONFIG.terrain.hazeMul;
  T.uTHaze.value.y = viewDistance;
  T.uTHaze.value.w = baseViewDistance;
  const far = camera.far;
  const start = far * 0.6;
  const limit = far * 0.86; // inside the env sky sphere (0.9 × far)
  T.uTSquash.value.set(start, limit, Math.max(200, (Math.max(viewDistance, CONFIG.terrain.ring.outer) - start) / 3.2));
  T.uTHaze.value.z = 1;
  T.uTSnowJitter.value = CONFIG.terrain.snowJitter;
}
