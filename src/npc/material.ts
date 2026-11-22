import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import { NUM_BONES, PIVOTS } from './rig';

/**
 * Instanced GPU skinning: MeshStandardMaterial (and a depth material for optional shadow casting) patched via
 * onBeforeCompile. Per-vertex: aSkin (bone0, bone1, weight0, region), aPart. Per-instance:
 *   iAnimA = (rowA0, rowA1, fracA, weightB)   current clip: two baked frames + lerp
 *   iAnimB = (rowB0, rowB1, fracB, fade)      previous clip (crossfade) + dither fade-in/out
 *   iCol0  = packed sRGB (skin, top, bottom, shoes)
 *   iCol1  = packed sRGB (hair, acc, inner) + flags
 *   iExtra = (headYaw, headPitch, packed shape, unused)
 */

const PARS = /* glsl */ `
uniform highp sampler2D uNpcAnim;
uniform vec3 uNpcPivots[${NUM_BONES}];
uniform float uNight;
attribute vec4 aSkin;
attribute float aPart;
attribute vec4 iAnimA;
attribute vec4 iAnimB;
attribute vec4 iCol0;
attribute vec4 iCol1;
attribute vec4 iExtra;
varying vec3 vNpcColor;
varying float vNpcFade;
varying float vNpcRough;
varying float vNpcEmit;

vec3 npcUnpack(float v) {
  float f = floor(v + 0.5);
  float r = floor(f / 65536.0);
  float g = floor((f - r * 65536.0) / 256.0);
  float b = f - r * 65536.0 - g * 256.0;
  return vec3(r, g, b) / 255.0;
}
vec3 npcLin(vec3 c) {
  return mix(c * 0.0773993808, pow(c * 0.9478672986 + 0.0521327014, vec3(2.4)), step(0.04045, c));
}
mat4 npcFetch(float row, int bone) {
  ivec2 uv = ivec2(bone * 3, int(row + 0.5));
  vec4 a = texelFetch(uNpcAnim, uv, 0);
  vec4 b = texelFetch(uNpcAnim, uv + ivec2(1, 0), 0);
  vec4 c = texelFetch(uNpcAnim, uv + ivec2(2, 0), 0);
  return mat4(a.x, b.x, c.x, 0.0, a.y, b.y, c.y, 0.0, a.z, b.z, c.z, 0.0, a.w, b.w, c.w, 1.0);
}
mat4 npcBone(int bone) {
  mat4 m = npcFetch(iAnimA.x, bone);
  if (iAnimA.z > 0.002) m += (npcFetch(iAnimA.y, bone) - m) * iAnimA.z;
  if (iAnimA.w > 0.002) {
    mat4 mb = npcFetch(iAnimB.x, bone);
    if (iAnimB.z > 0.002) mb += (npcFetch(iAnimB.y, bone) - mb) * iAnimB.z;
    m += (mb - m) * iAnimA.w;
  }
  return m;
}
void npcLook(inout vec3 p, inout vec3 n) {
  vec3 pv = uNpcPivots[3];
  float cy = cos(iExtra.x), sy = sin(iExtra.x), cp = cos(iExtra.y), sp = sin(iExtra.y);
  vec3 q = p - pv;
  q = vec3(q.x, q.y * cp - q.z * sp, q.y * sp + q.z * cp);
  q = vec3(q.x * cy + q.z * sy, q.y, -q.x * sy + q.z * cy);
  p = pv + q;
  n = vec3(n.x, n.y * cp - n.z * sp, n.y * sp + n.z * cp);
  n = vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
}
bool npcBit(uint flags, uint b) { return ((flags >> b) & 1u) != 0u; }

void npcSkin(out vec3 outP, out vec3 outN) {
  uint flags = uint(iCol1.w + 0.5);
  vec3 p = position;
  vec3 n = normal;
  int b0 = int(aSkin.x + 0.5);
  int reg = int(aSkin.w + 0.5);
  // ── body shape (bind space) ──
  float shp = floor(iExtra.z + 0.5);
  float qs = floor(shp / 65536.0);
  float qh = floor((shp - qs * 65536.0) / 256.0);
  float qg = shp - qs * 65536.0 - qh * 256.0;
  vec3 shape = vec3(qs, qh, qg) / 255.0 * 0.5 + 0.8; // shoulder, hip, girth
  float sx = p.x < 0.0 ? -1.0 : 1.0;
  if (b0 <= 2) {
    float wx = mix(shape.y, shape.x, smoothstep(1.0, 1.36, p.y));
    p.x *= wx * mix(1.0, shape.z, 0.55);
    p.z *= p.z > 0.0 ? shape.z : mix(1.0, shape.z, 0.5);
  } else if (b0 >= 4 && b0 <= 7) {
    float ax = sx * ${PIVOTS[4][0].toFixed(3)};
    float g = mix(1.0, shape.z, 0.5);
    float sc = (reg == 8 && npcBit(flags, 17u)) ? 1.13 : 1.0;
    p.x = ax * shape.x + (p.x - ax) * g * sc;
    p.z *= g * sc;
  } else if (b0 >= 8) {
    float lx = sx * ${PIVOTS[8][0].toFixed(3)};
    bool foot = (b0 == 10 || b0 == 13);
    float g = foot ? 1.0 : mix(1.0, shape.z, 0.6);
    float sc = (reg == 10 && npcBit(flags, 18u)) ? 1.14 : 1.0;
    p.x = lx * shape.y + (p.x - lx) * g * sc;
    if (!foot) p.z *= g * sc;
  }
  // ── skinning (linear blend of two bones, each from a 2-clip crossfade) ──
  vec3 p0 = p; vec3 n0 = n;
  if (b0 == 3) npcLook(p0, n0);
  mat4 M0 = npcBone(b0);
  vec3 sp = (M0 * vec4(p0, 1.0)).xyz;
  vec3 sn = mat3(M0) * n0;
#ifndef NPC_RIGID
  float w0 = aSkin.z;
  if (w0 < 0.999) {
    int b1 = int(aSkin.y + 0.5);
    vec3 p1 = p; vec3 n1 = n;
    if (b1 == 3) npcLook(p1, n1);
    mat4 M1 = npcBone(b1);
    sp = sp * w0 + (M1 * vec4(p1, 1.0)).xyz * (1.0 - w0);
    sn = sn * w0 + (mat3(M1) * n1) * (1.0 - w0);
  }
#endif
  // ── optional parts ──
  if (aPart > 0.5 && !npcBit(flags, uint(aPart + 0.5) - 1u)) sp = vec3(0.0, -50.0, 0.0);
  outP = sp;
  outN = normalize(sn);
}

void npcColor() {
  uint flags = uint(iCol1.w + 0.5);
  int reg = int(aSkin.w + 0.5);
  vec3 skin = npcUnpack(iCol0.x);
  vec3 top = npcUnpack(iCol0.y);
  vec3 bottom = npcUnpack(iCol0.z);
  vec3 c = skin;
  float rough = 0.85;
  vNpcEmit = 0.0;
  switch (reg) {
    case 0: c = skin; rough = 0.62; break;
    case 1: c = top; break;
    case 2: c = npcBit(flags, 20u) ? top : bottom; break;
    case 3: c = npcUnpack(iCol0.w); rough = 0.5; break;
    case 4: c = npcUnpack(iCol1.x); rough = 0.55; break;
    case 5: c = npcUnpack(iCol1.y); rough = 0.7; break;
    case 6: c = vec3(0.13, 0.11, 0.15); rough = 0.3; break;
    case 7: c = npcBit(flags, 16u) ? top : skin; rough = npcBit(flags, 16u) ? 0.85 : 0.62; break;
    case 8: c = npcBit(flags, 17u) ? top : skin; rough = npcBit(flags, 17u) ? 0.85 : 0.62; break;
    case 9: c = npcBit(flags, 19u) ? skin : bottom; rough = npcBit(flags, 19u) ? 0.62 : 0.85; break;
    case 10: c = npcBit(flags, 18u) ? bottom : skin; rough = npcBit(flags, 18u) ? 0.85 : 0.62; break;
    case 11: c = npcBit(flags, 20u) ? top : bottom; break;
    case 12: c = vec3(0.07, 0.075, 0.09); rough = 0.25; break;
    case 13: c = npcUnpack(iCol1.z); break;
    case 14: c = vec3(0.94, 0.93, 0.9); rough = 0.6; break;
    case 15: c = npcUnpack(iCol1.x) * 0.7; rough = 0.6; break;
    case 16: c = mix(skin, vec3(0.62, 0.3, 0.32), 0.45) * 0.82; rough = 0.5; break;
    case 17: c = vec3(0.45, 0.78, 0.95); rough = 0.2; vNpcEmit = 1.0; break;
  }
  vNpcColor = npcLin(c);
  vNpcRough = rough;
  vNpcFade = iAnimB.w;
}
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vNpcColor;
varying float vNpcFade;
varying float vNpcRough;
varying float vNpcEmit;
uniform float uNight;
`;

const DITHER = /* glsl */ `
  if (vNpcFade < 0.999) {
    float npcN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (vNpcFade <= npcN) discard;
  }
`;

export interface NpcUniforms {
  uNpcAnim: { value: THREE.Texture | null };
  uNpcPivots: { value: THREE.Vector3[] };
  uNight: { value: number };
}

export function makeNpcUniforms(anim: THREE.Texture): NpcUniforms {
  return {
    uNpcAnim: { value: anim },
    uNpcPivots: { value: PIVOTS.map((p) => new THREE.Vector3(p[0], p[1], p[2])) },
    uNight: GLOBAL_UNIFORMS.uNight,
  };
}

export function makeNpcMaterial(uniforms: NpcUniforms, rigid: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, envMapIntensity: 0.5 });
  if (rigid) mat.defines = { NPC_RIGID: '' };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal; vec3 npcP; npcSkin(npcP, objectNormal); npcColor();')
      .replace('#include <begin_vertex>', 'vec3 transformed = npcP;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('void main() {', 'void main() {\n' + DITHER)
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vNpcColor;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vNpcRough;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vNpcColor * vNpcEmit * (0.25 + 1.4 * uNight);');
  };
  mat.customProgramCacheKey = () => (rigid ? 'npc-skin-rigid-v1' : 'npc-skin-v1');
  return mat;
}

export function makeNpcDepthMaterial(uniforms: NpcUniforms, rigid: boolean): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  if (rigid) mat.defines = { NPC_RIGID: '' };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + PARS)
      .replace('#include <begin_vertex>', 'vec3 npcP; vec3 npcN; npcSkin(npcP, npcN); vec3 transformed = npcP;');
  };
  mat.customProgramCacheKey = () => (rigid ? 'npc-depth-rigid-v1' : 'npc-depth-v1');
  return mat;
}

/** Instanced soft blob shadows (one draw call). Instance attribute iShadow = opacity. */
export function makeBlobMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      { uColor: { value: new THREE.Color(0x2a2850) }, uOpacity: { value: 0.42 } },
    ]),
    vertexShader: /* glsl */ `
      attribute float iShadow;
      varying vec2 vUv;
      varying float vA;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vA = iShadow;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vA;
      #include <common>
      #include <fog_pars_fragment>
      void main() {
        vec2 d = vUv * 2.0 - 1.0;
        float r = dot(d, d);
        float a = (1.0 - smoothstep(0.08, 1.0, r)) * uOpacity * vA;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}
