import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';

/**
 * Weather surface patch (SPEC-PART3 §6): `patchMaterial(mat, kind)` injects wetness (darker, glossier), puddles
 * (noise mask in road dips → near-mirror env-map reflections, Medium/High) and snow (up-facing surfaces above the
 * snow line, and everywhere while snow settles) into MeshStandard/Physical/Lambert/Phong materials via
 * onBeforeCompile (chained with any existing hook). Pure uniforms → no recompiles when the weather changes.
 * Noise uses ABSOLUTE coords (worldPos + uOrigin) so puddles don't jump on floating-origin shifts.
 * `puddleMask()` is the identical CPU noise (aquaplaning).
 */

export type PatchKind = 'road' | 'ground' | 'foliage' | 'building' | 'vehicle';

/** Shared quality switch: 0 = no puddles (Low), 1 = puddles with reflections. */
export const WET_UNIFORMS = {
  uPuddles: { value: 1 },
};

// [darken when wet, wet roughness, puddles 0..1, altitude snow, settled snow, snow up-facing threshold]
const KIND: Record<PatchKind, [number, number, number, number, number, number]> = {
  road: [0.5, 0.16, 1, 0.35, 0.55, 0.55],
  ground: [0.68, 0.45, 0.45, 1, 1, 0.45],
  foliage: [0.82, 0.5, 0, 1, 0.9, 0.35],
  building: [0.8, 0.35, 0, 1, 0.9, 0.82],
  vehicle: [0.95, 0.6, 0, 0, 0.6, 0.85],
};

const GLSL_NOISE = /* glsl */ `
float envVH(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float envVN(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(envVH(i), envVH(i + vec2(1.0, 0.0)), u.x), mix(envVH(i + vec2(0.0, 1.0)), envVH(i + vec2(1.0, 1.0)), u.x), u.y);
}
float envPuddleNoise(vec2 pa) {
  return envVN(pa * 0.085) * 0.65 + envVN(pa * 0.29 + 17.0) * 0.35;
}
`;

function fract(x: number): number {
  return x - Math.floor(x);
}
function vh(x: number, y: number): number {
  // Mirror of envVH (Dave Hoskins hash12).
  let a = fract(x * 0.1031), b = fract(y * 0.1031), c = fract(x * 0.1031);
  const dt = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33); // dot(p3, p3.yzx + 33.33)
  a += dt;
  b += dt;
  c += dt;
  return fract((a + b) * c);
}
function vn(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = vh(ix, iy), b = vh(ix + 1, iy), c = vh(ix, iy + 1), d = vh(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

/** CPU twin of the GLSL puddle noise (absolute coordinates). */
export function puddleNoise(ax: number, az: number): number {
  return vn(ax * 0.085, az * 0.085) * 0.65 + vn(ax * 0.29 + 17, az * 0.29 + 17) * 0.35;
}

/** Puddle depth 0..1 at absolute (ax, az) for a road surface with the given wetness. */
export function puddleMask(ax: number, az: number, wetness: number): number {
  if (wetness < 0.05) return 0;
  const th = 1 - 0.36 * wetness;
  const n = puddleNoise(ax, az);
  return THREE.MathUtils.smoothstep(n, th, th + 0.06) * Math.min(1, wetness * 1.5);
}

export function patchMaterial(material: THREE.Material, kind: PatchKind): void {
  const m = material as THREE.MeshStandardMaterial & { __envPatched?: string };
  if (!m || m.__envPatched) return;
  m.__envPatched = kind;
  const k = KIND[kind] ?? KIND.ground;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey?.bind(m);
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    const G = GLOBAL_UNIFORMS;
    shader.uniforms.uWetness = G.uWetness;
    shader.uniforms.uSnow = G.uSnow;
    shader.uniforms.uSnowLine = G.uSnowLine;
    shader.uniforms.uOrigin = G.uOrigin;
    shader.uniforms.uRain = G.uRain;
    shader.uniforms.uTime = G.uTime;
    shader.uniforms.uPuddles = WET_UNIFORMS.uPuddles;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEnvWorld;\nvarying vec3 vEnvNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
  {
    vec4 envWP = vec4(transformed, 1.0);
    vec3 envN = objectNormal;
    #ifdef USE_BATCHING
      envWP = batchingMatrix * envWP;
      envN = mat3(batchingMatrix) * envN;
    #endif
    #ifdef USE_INSTANCING
      envWP = instanceMatrix * envWP;
      envN = mat3(instanceMatrix) * envN;
    #endif
    envWP = modelMatrix * envWP;
    vEnvWorld = envWP.xyz;
    vEnvNormal = normalize(mat3(modelMatrix) * envN);
  }`,
      );
    const f = (n: number) => n.toFixed(3);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying vec3 vEnvWorld;
varying vec3 vEnvNormal;
uniform float uWetness;
uniform float uSnow;
uniform float uSnowLine;
uniform vec3 uOrigin;
uniform float uRain;
uniform float uTime;
uniform float uPuddles;
${GLSL_NOISE}`,
    );
    // Applied right before the lighting chunk, i.e. AFTER every other patch (owners' own onBeforeCompile code
    // that sets diffuse/roughness on the standard chunks) — so wetness/snow always win.
    const anchors = ['#include <lights_physical_fragment>', '#include <lights_lambert_fragment>', '#include <lights_phong_fragment>', '#include <lights_toon_fragment>'];
    const anchor = anchors.find((a) => shader.fragmentShader.includes(a));
    if (!anchor) return;
    const pbr = anchor === anchors[0];
    const block = `
  {
    vec2 envPA = vEnvWorld.xz + uOrigin.xz;
    float envUp = clamp(normalize(vEnvNormal).y, 0.0, 1.0);
    float envBright = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    float envWet = uWetness * mix(0.35, 1.0, envUp);
    float envTh = 1.0 - 0.36 * uWetness;
    // Puddles only on darker flat surfaces (asphalt, not sand or paint).
    float envPuddle = smoothstep(envTh, envTh + 0.06, envPuddleNoise(envPA)) * min(1.0, uWetness * 1.5) * ${f(k[2])}
      * uPuddles * step(0.9, envUp) * (1.0 - smoothstep(0.22, 0.45, envBright));
    diffuseColor.rgb *= mix(1.0, ${f(k[0])}, envWet);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.7, envPuddle);
    // Snow: above the snow line on up-facing faces (ragged edge), plus settled snow while it snows.
    float envSnowEdge = (envVN(envPA * 0.045) - 0.5) * 70.0;
    float envAlt = smoothstep(uSnowLine - 45.0, uSnowLine + 25.0, vEnvWorld.y + envSnowEdge) * ${f(k[3])};
    float envSet = uSnow * ${f(k[4])} * smoothstep(0.25, 0.65, envVN(envPA * 0.37 + 3.0) + uSnow * 0.5);
    float envSnow = max(envAlt, envSet) * smoothstep(${f(k[5])}, ${f(Math.min(0.99, k[5] + 0.2))}, envUp) * (1.0 - envPuddle);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 1.0), envSnow);
    ${pbr ? `roughnessFactor = mix(roughnessFactor, min(roughnessFactor, ${f(k[1])}), envWet);
    roughnessFactor = mix(roughnessFactor, 0.035, envPuddle);
    roughnessFactor = mix(roughnessFactor, 0.85, envSnow);
    {
      vec3 envUpV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      // Rain rings on the puddles (expanding ripples in drifting cells).
      vec2 rp = envPA * 1.7;
      vec2 rc = floor(rp);
      float rr = fract(uTime * 0.9 + envVH(rc) * 7.0);
      float rd = length(fract(rp) - 0.5 - (vec2(envVH(rc + 1.3), envVH(rc + 2.1)) - 0.5) * 0.5);
      float ring = sin((rd - rr * 0.5) * 40.0) * (1.0 - rr) * smoothstep(0.5 * rr + 0.06, 0.5 * rr, rd) * uRain;
      vec3 envFlat = normalize(envUpV + vec3(ring * 0.08, 0.0, ring * 0.08));
      normal = normalize(mix(normal, envFlat, envPuddle * 0.92));
    }` : ''}
  }
  `;
    shader.fragmentShader = shader.fragmentShader.replace(anchor, block + anchor);
  };
  m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|envwx:' + kind;
  m.needsUpdate = true;
}
