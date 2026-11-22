import * as THREE from 'three';
import { LIGHT_TYPES } from './regions';
import { getCrackTexture, getTreadNormalMap } from './textures';

/**
 * Car materials. Every material is per car instance (so damage/char/paint never leak between cars) but the shader
 * code per kind is identical → three.js shares the compiled programs. All runtime changes go through uniforms or
 * plain scalar params; no defines change after creation (no shader recompiles while customizing):
 *  - paint 'std' variant covers gloss / metallic / matte / colour-shift (clearcoat never reaches 0);
 *  - paint 'pearl' variant adds iridescence (compiled once on first use).
 */

type U<T> = { value: T };

export interface PaintUniforms {
  uColor: U<THREE.Color>;
  uRoofColor: U<THREE.Color>;
  uTwoTone: U<number>;
  uStripeColor: U<THREE.Color>;
  uStripeMode: U<number>;
  uStripeA: U<THREE.Vector4>;
  uSideBand: U<THREE.Vector4>;
  uShift: U<number>;
  uShiftColor: U<THREE.Color>;
  uPearl: U<number>;
  uFlake: U<number>;
  uChar: U<number>;
}

export interface DetailUniforms {
  uTint: U<THREE.Color>;
  uEmis: U<THREE.Vector3[]>;
  uGlass: U<THREE.Vector4>;
  uChar: U<number>;
}

export function makePaintUniforms(uChar: U<number>): PaintUniforms {
  return {
    uColor: { value: new THREE.Color(1, 0.3, 0.25) },
    uRoofColor: { value: new THREE.Color(0.1, 0.1, 0.12) },
    uTwoTone: { value: 0 },
    uStripeColor: { value: new THREE.Color(1, 1, 1) },
    uStripeMode: { value: 0 },
    uStripeA: { value: new THREE.Vector4(0.16, 0.07, 0.2, 0) },
    uSideBand: { value: new THREE.Vector4(0.4, 0.46, -2, 2) },
    uShift: { value: 0 },
    uShiftColor: { value: new THREE.Color(0.4, 0.3, 1) },
    uPearl: { value: 0 },
    uFlake: { value: 0 },
    uChar,
  };
}

export function makeDetailUniforms(uChar: U<number>): DetailUniforms {
  const emis: THREE.Vector3[] = [];
  for (let i = 0; i < LIGHT_TYPES; i++) emis.push(new THREE.Vector3());
  return { uTint: { value: new THREE.Color(1, 1, 1) }, uEmis: { value: emis }, uGlass: { value: new THREE.Vector4(0.05, 0.06, 0.07, 0) }, uChar };
}

const COMMON_FRAG = /* glsl */ `
float cHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.23)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(cHash(i), cHash(i + vec3(1,0,0)), f.x), mix(cHash(i + vec3(0,1,0)), cHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(cHash(i + vec3(0,0,1)), cHash(i + vec3(1,0,1)), f.x), mix(cHash(i + vec3(0,1,1)), cHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
uniform float uChar;
`;

/** Insert `code` after `#include <chunk>` keeping the include (so other patches can still find it). */
const after = (src: string, chunk: string, code: string) => src.replace(`#include <${chunk}>`, `#include <${chunk}>\n${code}`);

/**
 * Install our patch and keep room for an external one (env.patchMaterial for wet look): the external patch is applied
 * first on a pristine material, captured, and then composed after ours.
 */
function install(mat: THREE.Material, key: string, patch: (s: THREE.WebGLProgramParametersWithUniforms) => void, external?: (m: THREE.Material) => void): void {
  let extFn: ((s: THREE.WebGLProgramParametersWithUniforms, r: THREE.WebGLRenderer) => void) | null = null;
  let extKey = '';
  if (external) {
    const before = mat.onBeforeCompile;
    try {
      external(mat);
    } catch {
      /* optional */
    }
    if (mat.onBeforeCompile !== before) extFn = mat.onBeforeCompile;
    extKey = mat.customProgramCacheKey();
  }
  mat.onBeforeCompile = (shader, renderer) => {
    patch(shader);
    if (extFn) extFn.call(mat, shader, renderer);
  };
  mat.customProgramCacheKey = () => key + '|' + extKey;
}

export function createPaintMaterial(variant: 'std' | 'pearl', physical: boolean, U: PaintUniforms, external?: (m: THREE.Material) => void): THREE.MeshStandardMaterial {
  const mat = physical
    ? new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        vertexColors: true,
        metalness: 0.5,
        roughness: 0.35,
        clearcoat: 1,
        clearcoatRoughness: 0.04,
        envMapIntensity: 1.0,
        ...(variant === 'pearl' ? { iridescence: 1, iridescenceIOR: 1.45, iridescenceThicknessMinimum: 260, iridescenceThicknessMaximum: 640 } : {}),
      })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 0.5, roughness: 0.35, envMapIntensity: 1.0 });
  mat.name = 'carPaint';
  install(
    mat,
    `carPaint-${variant}-${physical ? 'p' : 's'}`,
    (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aCar;\nattribute float aRoof;\nvarying vec3 vCar;\nvarying vec3 vCarN;\nvarying float vRoof;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCar = aCar; vCarN = objectNormal; vRoof = aRoof;');
      let fs = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
${COMMON_FRAG}
uniform vec3 uColor; uniform vec3 uRoofColor; uniform vec3 uStripeColor; uniform vec3 uShiftColor;
uniform float uTwoTone; uniform float uStripeMode; uniform float uShift; uniform float uPearl; uniform float uFlake;
uniform vec4 uStripeA; uniform vec4 uSideBand;
varying vec3 vCar; varying vec3 vCarN; varying float vRoof;
float aaStep(float e, float x) { float w = max(fwidth(x), 1e-4) * 0.8; return smoothstep(e - w, e + w, x); }
float stripeMask() {
  float ax = abs(vCar.x);
  if (uStripeMode < 0.5) return 0.0;
  if (uStripeMode < 1.5) return 1.0 - aaStep(uStripeA.x, ax);
  if (uStripeMode < 2.5) return aaStep(uStripeA.y, ax) * (1.0 - aaStep(uStripeA.z, ax));
  float y = vCar.y - vCar.z * uStripeA.w;
  float side = smoothstep(0.45, 0.7, abs(vCarN.x));
  return aaStep(uSideBand.x, y) * (1.0 - aaStep(uSideBand.y, y)) * side * aaStep(uSideBand.z, vCar.z) * (1.0 - aaStep(uSideBand.w, vCar.z));
}`,
      );
      fs = after(
        fs,
        'normal_fragment_maps',
        `{
  vec3 paint = mix(uColor, uRoofColor, vRoof * uTwoTone);
  float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float graze = 1.0 - ndv;
  if (uShift > 0.5) paint = mix(paint, uShiftColor, smoothstep(0.08, 0.85, pow(graze, 1.15)));
  if (uPearl > 0.5) paint = mix(paint, paint * 0.55 + vec3(0.45, 0.42, 0.52), pow(graze, 2.2) * 0.55);
  paint = mix(paint, uStripeColor, stripeMask());
  diffuseColor.rgb *= paint;
  if (uFlake > 0.0) {
    vec3 cell = floor(vCar * 900.0);
    float fade = 1.0 - smoothstep(0.0006, 0.0018, length(fwidth(vCar)));
    vec3 fn = vec3(cHash(cell + 1.7), cHash(cell + 3.1), cHash(cell + 5.3)) - 0.5;
    normal = normalize(normal + fn * uFlake * 0.12 * fade);
    roughnessFactor = max(0.0, roughnessFactor - uFlake * 0.05);
  }
  if (uChar > 0.0) {
    float n = cNoise(vCar * 9.0) * 0.6 + cNoise(vCar * 37.0) * 0.4;
    vec3 charCol = vec3(0.022, 0.02, 0.019) + vec3(0.06, 0.05, 0.045) * n * n;
    float c = clamp(uChar * (0.75 + n * 0.5), 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, charCol, c);
    roughnessFactor = mix(roughnessFactor, 0.8 + 0.2 * n, c);
    metalnessFactor = mix(metalnessFactor, 0.15, c);
  }
}`,
      );
      fs = after(fs, 'lights_physical_fragment', '#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= (1.0 - uChar);\n#endif');
      shader.fragmentShader = fs;
    },
    external,
  );
  return mat;
}

/**
 * Detail material: vertex colour × (optional tint by aMat.z) with per-vertex metalness/roughness (aMat.xy) and an
 * emissive per light type (aMat.w → uEmis[type]); type 7 = opaque glass (low LOD) driven by uGlass.
 */
export function createDetailMaterial(U: DetailUniforms, map: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, metalness: 1, roughness: 1, map, envMapIntensity: 1.0 });
  mat.name = 'carDetail';
  install(mat, `carDetail-${map ? 'm' : 'n'}`, (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nvarying vec4 vMat;\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat; vObj = position;');
    let fs = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
${COMMON_FRAG}
uniform vec3 uTint; uniform vec3 uEmis[${LIGHT_TYPES}]; uniform vec4 uGlass;
varying vec4 vMat; varying vec3 vObj;`,
    );
    fs = after(
      fs,
      'normal_fragment_maps',
      `int lt = int(vMat.w + 0.5);
metalnessFactor = vMat.x; roughnessFactor = vMat.y;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uTint, vMat.z);
if (lt == 7) { diffuseColor.rgb = mix(uGlass.rgb, vec3(0.7), uGlass.a); metalnessFactor = 0.0; roughnessFactor = mix(0.04, 0.55, uGlass.a); }
if (uChar > 0.0) {
  float n = cNoise(vObj * 11.0);
  float c = clamp(uChar * (0.8 + n * 0.4), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.022, 0.02) + 0.05 * n, c);
  roughnessFactor = mix(roughnessFactor, 0.85, c);
  metalnessFactor = mix(metalnessFactor, 0.2, c);
}`,
    );
    fs = after(fs, 'emissivemap_fragment', 'totalEmissiveRadiance += uEmis[lt] * (1.0 - uChar);');
    shader.fragmentShader = fs;
  });
  return mat;
}

export interface GlassUniforms {
  uCrack: U<number>;
  uCrackMap: U<THREE.Texture>;
  uChar: U<number>;
}

/** Tinted window glass with un-attenuated reflections (premultiplied output) and a crack overlay. */
export function createGlassMaterial(uChar: U<number>): { mat: THREE.MeshStandardMaterial; U: GlassUniforms } {
  const U: GlassUniforms = { uCrack: { value: 0 }, uCrackMap: { value: getCrackTexture() }, uChar };
  const mat = new THREE.MeshStandardMaterial({
    color: 0x0c1012,
    metalness: 0,
    roughness: 0.03,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    envMapIntensity: 1.15,
  });
  mat.name = 'carGlass';
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendEquation = THREE.AddEquation;
  install(mat, 'carGlass', (shader) => {
    Object.assign(shader.uniforms, U);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGUv = uv;');
    let fs = shader.fragmentShader.replace('#include <common>', `#include <common>\n${COMMON_FRAG}\nuniform float uCrack; uniform sampler2D uCrackMap; varying vec2 vGUv;`);
    fs = after(
      fs,
      'normal_fragment_maps',
      `{
  float crack = uCrack > 0.0 ? texture2D(uCrackMap, vGUv).r * uCrack : 0.0;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75), crack);
  diffuseColor.a = mix(diffuseColor.a, 0.92, crack);
  roughnessFactor = mix(roughnessFactor, 0.45, crack);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02), uChar);
  diffuseColor.a = mix(diffuseColor.a, 0.95, uChar);
}`,
    );
    fs = fs.replace('#include <opaque_fragment>', 'gl_FragColor = vec4(totalDiffuse * diffuseColor.a + totalSpecular * (1.0 - uChar * 0.8) + totalEmissiveRadiance, diffuseColor.a);');
    shader.fragmentShader = fs;
  });
  return { mat, U };
}

export function createTyreMaterial(uChar: U<number>): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.86, metalness: 0, normalMap: getTreadNormalMap(), normalScale: new THREE.Vector2(0.9, 0.9) });
  mat.name = 'carTyre';
  install(mat, 'carTyre', (shader) => {
    shader.uniforms.uChar = uChar;
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uChar;');
    shader.fragmentShader = after(shader.fragmentShader, 'normal_fragment_maps', 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.012), uChar); roughnessFactor = mix(roughnessFactor, 1.0, uChar);');
  });
  return mat;
}

let shadowMat: THREE.Material | null = null;
/** Invisible material for the shadow proxy (only rendered into the shadow map). */
export function getShadowProxyMaterial(): THREE.Material {
  if (!shadowMat) {
    shadowMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    shadowMat.name = 'carShadowProxy';
  }
  return shadowMat;
}
