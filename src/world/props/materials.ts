import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';

/**
 * Shared materials for props and parked cars (owner: props). Patches are INSERTED after the standard chunks (never
 * replacing them) so an external patch (env.patchMaterial: wetness / snow) can still hook the same chunks; our uniforms
 * use a `p` prefix to avoid clashing with names an external patch may declare.
 */

export const PROP_UNIFORMS = {
  pTraffic: { value: new THREE.Vector4(7, 2, 1, 20) }, // green, amber, all-red, full cycle (s)
  pSway: { value: 1 },
  pCarLamp: { value: 1 },
};

const G = GLOBAL_UNIFORMS;

type Shader = THREE.WebGLProgramParametersWithUniforms;
const after = (src: string, chunk: string, code: string) => src.replace(`#include <${chunk}>`, `#include <${chunk}>\n${code}`);

/** Install our patch, composing an optional external one (applied to a pristine material first, then captured). */
function install(mat: THREE.Material, key: string, patch: (s: Shader) => void, external?: (m: THREE.Material) => void): void {
  let extFn: ((s: Shader, r: THREE.WebGLRenderer) => void) | null = null;
  let extKey = '';
  if (external) {
    const before = mat.onBeforeCompile;
    try {
      external(mat);
    } catch {
      /* optional hook */
    }
    if (mat.onBeforeCompile !== before) extFn = mat.onBeforeCompile;
    try {
      extKey = mat.customProgramCacheKey();
    } catch {
      extKey = '';
    }
  }
  mat.onBeforeCompile = (shader, renderer) => {
    patch(shader);
    if (extFn) extFn.call(mat, shader, renderer);
  };
  mat.customProgramCacheKey = () => key + '|' + extKey;
}

const PROP_VERT_PARS = /* glsl */ `
attribute vec4 aMat;
attribute vec3 aTint;
attribute vec4 aInst;
uniform float pTime;
uniform float pNight;
uniform vec3 pWind;
uniform vec3 pOrigin;
uniform vec4 pTraffic;
uniform float pSway;
varying vec3 vEmit;
varying float vSurf;
`;

const PROP_SWAY = /* glsl */ `
#ifdef USE_INSTANCING
{
  float sw = aMat.z;
  if (sw > 0.001) {
    vec3 ip = instanceMatrix[3].xyz + pOrigin;
    float wspd = length(pWind.xz);
    vec2 wdir = wspd > 0.01 ? pWind.xz / wspd : vec2(0.8, 0.6);
    float amp = clamp(0.3 + wspd * 0.11, 0.25, 2.6) * pSway;
    float ph = pTime * (1.05 + wspd * 0.05) + ip.x * 0.11 + ip.z * 0.07;
    float osc = sin(ph) * 0.6 + sin(ph * 2.3 + 1.7) * 0.25;
    float lean = 0.3 + 0.7 * clamp(wspd / 14.0, 0.0, 1.0);
    float w = min(sw, 1.0);
    vec3 offW = vec3(wdir.x, 0.0, wdir.y) * (lean + osc * 0.5) * w * 0.2 * amp;
    offW += vec3(-wdir.y, 0.0, wdir.x) * sin(ph * 0.7 + 2.0) * w * 0.06 * amp;
    float fl = max(sw - 1.0, 0.0);
    offW.y += sin(pTime * (3.0 + wspd * 0.2) + position.x * 2.1 + position.z * 1.7 + ip.x) * 0.07 * fl * amp;
    mat3 im = mat3(instanceMatrix);
    float s2 = max(dot(im[0], im[0]), 1e-4);
    transformed += (transpose(im) * offW) / s2;
  }
}
#endif
`;

const PROP_COLOR = /* glsl */ `
vSurf = aMat.w;
vEmit = vec3(0.0);
{
  vec3 pBase = color.rgb * mix(vec3(1.0), aTint, aMat.x);
  #ifdef USE_COLOR
  vColor.rgb = pBase;
  #endif
  float code = aMat.y;
  if (code > 0.5) {
    float lit = aInst.z;
    if (code < 1.5) {
      vEmit = pBase * pNight * 2.6 * lit;
    } else if (code < 4.5) {
      float t = mod(pTime + aInst.x, pTraffic.w);
      float g = pTraffic.x, a = pTraffic.y;
      float on = code < 2.5 ? step(g + a, t) : (code < 3.5 ? step(g, t) * (1.0 - step(g + a, t)) : 1.0 - step(g, t));
      vEmit = pBase * on * (2.4 + pNight * 1.6) * lit;
      #ifdef USE_COLOR
      vColor.rgb = pBase * 0.32;
      #endif
    } else if (code < 5.5) {
      float on = step(0.5, fract(pTime * 0.9 + aInst.x));
      vEmit = pBase * on * (1.0 + pNight * 2.2) * lit;
    } else {
      vEmit = pBase * (0.08 + pNight * 1.1) * lit;
    }
  }
}
`;

const PROP_FRAG_PARS = /* glsl */ `
varying vec3 vEmit;
varying float vSurf;
`;

export function makePropMaterial(doubleSided: boolean, external?: (m: THREE.Material) => void): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.name = doubleSided ? 'propFoliage' : 'prop';
  install(
    mat,
    doubleSided ? 'coastline-prop-ds' : 'coastline-prop',
    (shader) => {
      shader.uniforms.pTime = G.uTime;
      shader.uniforms.pNight = G.uNight;
      shader.uniforms.pWind = G.uWind;
      shader.uniforms.pOrigin = G.uOrigin;
      shader.uniforms.pTraffic = PROP_UNIFORMS.pTraffic;
      shader.uniforms.pSway = PROP_UNIFORMS.pSway;
      let vs = after(shader.vertexShader, 'common', PROP_VERT_PARS);
      vs = after(vs, 'begin_vertex', PROP_SWAY);
      vs = after(vs, 'color_vertex', PROP_COLOR);
      shader.vertexShader = vs;
      let fs = after(shader.fragmentShader, 'common', PROP_FRAG_PARS);
      fs = after(fs, 'roughnessmap_fragment', 'roughnessFactor = vSurf < 0.5 ? 0.8 : vSurf < 1.5 ? 0.34 : vSurf < 2.5 ? 0.36 : vSurf < 3.5 ? 0.07 : vSurf < 4.5 ? 0.86 : 0.18;');
      fs = after(fs, 'metalnessmap_fragment', 'metalnessFactor = (vSurf > 1.5 && vSurf < 2.5) ? 0.55 : (vSurf > 4.5 ? 0.9 : 0.0);');
      fs = after(fs, 'emissivemap_fragment', 'totalEmissiveRadiance += vEmit;');
      shader.fragmentShader = fs;
    },
    external,
  );
  return mat;
}

const CAR_VERT_PARS = /* glsl */ `
attribute float paintMask;
attribute vec3 aPaint;
attribute vec4 aCar;
uniform float pNight;
uniform float pCarLamp;
varying float vPM;
varying vec3 vLP;
varying vec3 vLN;
varying vec4 vCar;
varying vec3 vCEmit;
`;

const CAR_COLOR = /* glsl */ `
vPM = paintMask;
vLP = position;
vLN = normal;
vCar = aCar;
vCEmit = vec3(0.0);
{
  // paintMask: 1 paint, 0.5 glass, 0.25 lamp lens (warm-white front / red rear), 0 other
  vec3 c = color.rgb;
  float isPaint = step(0.75, paintMask);
  float isGlass = step(0.375, paintMask) * (1.0 - isPaint);
  float isLamp = step(0.125, paintMask) * (1.0 - step(0.375, paintMask));
  c = mix(c, aPaint, isPaint);
  c = mix(c, vec3(0.03, 0.04, 0.05), isGlass);
  float on = aCar.w * pCarLamp;
  float rear = step(color.g * 1.8 + 0.05, color.r);
  vCEmit = isLamp * color.rgb * pNight * (0.12 + mix(2.4, 1.7, rear) * on);
  c *= 1.0 - 0.82 * aCar.y;
  #ifdef USE_COLOR
  vColor.rgb = c;
  #endif
}
`;

const CAR_FRAG_PARS = /* glsl */ `
varying float vPM;
varying vec3 vLP;
varying vec3 vLN;
varying vec4 vCar;
varying vec3 vCEmit;
`;

const CAR_GLASS = /* glsl */ `
if (vPM > 0.375 && vPM < 0.75 && vCar.x > 0.5) {
  vec3 an = abs(vLN);
  vec2 q = an.x > an.y && an.x > an.z ? vLP.yz : (an.y > an.z ? vLP.xz : vLP.xy);
  q *= 13.0;
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float h = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
  float e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  diffuseColor.rgb = mix(vec3(0.42, 0.48, 0.52), vec3(0.78, 0.84, 0.88), h) * (e < 0.08 ? 0.45 : 1.0);
}
`;

export function makeCarMaterial(external?: (m: THREE.Material) => void): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.2 });
  mat.name = 'parkedCar';
  install(
    mat,
    'coastline-parked',
    (shader) => {
      shader.uniforms.pNight = G.uNight;
      shader.uniforms.pCarLamp = PROP_UNIFORMS.pCarLamp;
      let vs = after(shader.vertexShader, 'common', CAR_VERT_PARS);
      vs = after(vs, 'color_vertex', CAR_COLOR);
      shader.vertexShader = vs;
      let fs = after(shader.fragmentShader, 'common', CAR_FRAG_PARS);
      fs = after(fs, 'color_fragment', CAR_GLASS);
      fs = after(fs, 'roughnessmap_fragment', 'roughnessFactor = vPM > 0.75 ? mix(0.22, 0.85, vCar.y) : (vPM > 0.375 ? (vCar.x > 0.5 ? 0.55 : 0.03) : (vPM > 0.125 ? 0.12 : 0.6));');
      fs = after(fs, 'metalnessmap_fragment', 'metalnessFactor = vPM > 0.75 ? 0.35 * (1.0 - vCar.y) : (vPM > 0.125 ? 0.0 : 0.1);');
      fs = after(fs, 'emissivemap_fragment', 'totalEmissiveRadiance += vCEmit;');
      shader.fragmentShader = fs;
    },
    external,
  );
  return mat;
}

/** Camera-facing additive glow sprites (lamp heads, car lamps). Per instance: matrix (translation + size), aGlow rgb·a. */
export function makeGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      pNight: G.uNight,
      pFogNear: G.uFogNear,
      pFogFar: G.uFogFar,
      pFogDensity: G.uFogDensity,
    },
    vertexShader: /* glsl */ `
      attribute vec4 aGlow;
      uniform float pNight;
      uniform float pFogNear;
      uniform float pFogFar;
      uniform float pFogDensity;
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        vUv = uv;
        vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float size = length(instanceMatrix[0].xyz) * (1.0 + pFogDensity * 1.2);
        float d = length(c.xyz);
        c.xy += position.xy * size;
        c.z += min(size * 0.5, d * 0.5);
        float fog = 1.0 - smoothstep(pFogNear, pFogFar * 1.2, d);
        vCol = aGlow.rgb * aGlow.a * pNight * fog;
        gl_Position = projectionMatrix * c;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vCol;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float a = (exp(-r2 * 5.0) * 0.8 + exp(-r2 * 36.0) * 0.7) * (1.0 - r2);
        gl_FragColor = vec4(vCol * a, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });
}

/** Fake light pools on the ground under lamps (instanced horizontal discs, additive). */
export function makePoolMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      pNight: G.uNight,
      pFogNear: G.uFogNear,
      pFogFar: G.uFogFar,
      pWet: G.uWetness,
    },
    vertexShader: /* glsl */ `
      attribute vec4 aGlow;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vD;
      uniform float pNight;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vD = length(mv.xyz);
        vCol = aGlow.rgb * aGlow.a * pNight;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float pFogNear;
      uniform float pFogFar;
      uniform float pWet;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vD;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        if (r > 1.0) discard;
        float a = 1.0 - smoothstep(0.0, 1.0, r);
        a = a * a * (0.75 + 0.25 * (1.0 - r));
        float fog = 1.0 - smoothstep(pFogNear, pFogFar, vD);
        gl_FragColor = vec4(vCol * a * fog * (1.0 + pWet * 0.8), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
  });
}
