import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';

/**
 * The plane material: ONE MeshStandardMaterial program shared by every plane (all types, all instances, all LODs),
 * so each part costs a single draw call. Per-instance uniforms drive, in the vertex shader:
 *   - control surfaces / gear / propellers / fans: rotation about a root-space hinge (aFx.x = surface id),
 *   - geometry variants (intact vs torn engine, cockpit bulkhead, prop blades): collapsed when inactive (aFx.y),
 *   - crumple of one part near a point, cable sway (aFx.z),
 * and in the fragment shader: vertex-attribute roughness/metalness (aRM), procedural cabin windows + door outlines
 * (aWin = fuselage z / y), per-part charring with noise, warm window glow at night (GLOBAL_UNIFORMS.uNight).
 */

export const NSURF = 24;
export const NPART = 32;

export interface PlaneUniforms {
  uSurfA: { value: THREE.Vector4[] };
  uSurfP: { value: THREE.Vector4[] };
  uPartOff: { value: THREE.Vector4[] };
  uCharV: { value: THREE.Vector4[] };
  uDmg: { value: THREE.Vector4 };
  uFlags: { value: THREE.Vector4 }; // x merged (per material), y cabin open aft, z time, w prop blur
  uCrush: { value: THREE.Vector4 }; // xyz root point, w amount (m)
  uCrushDir: { value: THREE.Vector4 }; // xyz direction, w part id (-1 = none)
  uCrushR: { value: number };
  uWin: { value: THREE.Vector4 }; // pitch, halfW, halfH, corner
  uRowA: { value: THREE.Vector4 }; // y, sMin, sMax, -
  uRowB: { value: THREE.Vector4 };
  uDoors: { value: THREE.Vector4[] }; // s, y, halfW, halfH
  uWinCol: { value: THREE.Color };
}

export interface WindowLayout {
  pitch: number;
  halfW: number;
  halfH: number;
  corner: number;
  rows: { y: number; sMin: number; sMax: number }[];
  doors: { s: number; y: number; halfW: number; halfH: number }[];
}

export function makeUniforms(win: WindowLayout | null): PlaneUniforms {
  const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4(0, 0, 0, 0));
  const U: PlaneUniforms = {
    uSurfA: { value: vec4s(NSURF).map((v) => v.set(1, 0, 0, 0)) },
    uSurfP: { value: vec4s(NSURF) },
    uPartOff: { value: vec4s(NPART) },
    uCharV: { value: vec4s(NPART / 4) },
    uDmg: { value: new THREE.Vector4(0, 0, 0, 0) },
    uFlags: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCrush: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCrushDir: { value: new THREE.Vector4(0, 0, -1, -1) },
    uCrushR: { value: 1 },
    uWin: { value: new THREE.Vector4(0.5, 0.12, 0.17, 0.08) },
    uRowA: { value: new THREE.Vector4(0, 1, 0, 0) },
    uRowB: { value: new THREE.Vector4(0, 1, 0, 0) },
    uDoors: { value: vec4s(8) },
    uWinCol: { value: new THREE.Color(0x1d2a3a) },
  };
  if (win) {
    U.uWin.value.set(win.pitch, win.halfW, win.halfH, win.corner);
    const r = win.rows;
    if (r[0]) U.uRowA.value.set(r[0].y, r[0].sMin, r[0].sMax, 0);
    if (r[1]) U.uRowB.value.set(r[1].y, r[1].sMin, r[1].sMax, 0);
    win.doors.slice(0, 8).forEach((d, i) => U.uDoors.value[i].set(d.s, d.y, d.halfW, d.halfH));
  }
  return U;
}

const VERT_PARS = /* glsl */ `
attribute vec2 aWin;
attribute vec2 aRM;
attribute vec4 aFx;
varying vec2 vWin;
varying vec2 vRM;
varying float vChar;
varying vec3 vPPos;
varying float vInt;
uniform vec4 uSurfA[${NSURF}];
uniform vec4 uSurfP[${NSURF}];
uniform vec4 uPartOff[${NPART}];
uniform vec4 uCharV[${NPART / 4}];
uniform vec4 uDmg;
uniform vec4 uFlags;
uniform vec4 uCrush;
uniform vec4 uCrushDir;
uniform float uCrushR;
vec3 plRot(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}
vec3 plHash3(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
vec3 planeDeform(vec3 p, inout vec3 n) {
  int pid = int(aFx.w + 0.5);
  vec3 off = uPartOff[pid].xyz;
  bool merged = uFlags.x > 0.5;
  vec3 rp = merged ? p : p + off;
  int sid = int(aFx.x + 0.5);
  if (sid > 0) {
    vec4 A = uSurfA[sid];
    vec4 P = uSurfP[sid];
    rp = P.xyz + plRot(rp - P.xyz, A.xyz, A.w) + vec3(0.0, -0.22, -1.0) * P.w;
    n = plRot(n, A.xyz, A.w);
  }
  if (uCrush.w > 0.0 && abs(aFx.w - uCrushDir.w) < 0.5) {
    float d = distance(rp, uCrush.xyz);
    float k = uCrush.w * (1.0 - smoothstep(0.0, uCrushR, d));
    vec3 h = plHash3(floor(rp * 2.5) + 0.5) - 0.5;
    rp += uCrushDir.xyz * k * (0.75 + h.x * 0.5);
    rp += h * k * 0.35;
    n = normalize(n + h * min(k * 1.5, 1.2));
  }
  if (aFx.z > 0.01) {
    float t = uFlags.z;
    rp.x += sin(t * 1.9 + rp.z * 1.3 + aFx.w) * 0.06 * aFx.z;
    rp.z += cos(t * 1.4 + rp.x * 1.1) * 0.05 * aFx.z;
  }
  int vi = int(aFx.y + 0.5);
  if (vi > 0) {
    float hide = 0.0;
    if (vi <= 4) hide = step(0.5, uDmg[vi - 1]);
    else if (vi <= 8) hide = 1.0 - step(0.5, uDmg[vi - 5]);
    else if (vi == 9) hide = step(0.5, uFlags.y);
    else if (vi == 10) hide = step(0.5, uFlags.w);
    if (hide > 0.5) rp = merged ? vec3(0.0) : off;
  }
  vPPos = rp;
  return merged ? rp : rp - off;
}
`;

const FRAG_PARS = /* glsl */ `
varying vec2 vWin;
varying vec2 vRM;
varying float vChar;
varying vec3 vPPos;
varying float vInt;
uniform vec4 uWin;
uniform vec4 uRowA;
uniform vec4 uRowB;
uniform vec4 uDoors[8];
uniform vec3 uWinCol;
uniform float uNight;
float plHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float plNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(plHash(i), plHash(i + vec3(1, 0, 0)), f.x), mix(plHash(i + vec3(0, 1, 0)), plHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(plHash(i + vec3(0, 0, 1)), plHash(i + vec3(1, 0, 1)), f.x), mix(plHash(i + vec3(0, 1, 1)), plHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float plRRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float plRow(vec4 R, vec2 w, vec2 fw, float aa) {
  if (R.z <= R.y) return 0.0;
  float t = w.y - R.x;
  if (abs(t) > uWin.z + aa * 3.0 + 0.05) return 0.0;
  float s = w.x;
  if (s < R.y - uWin.x || s > R.z + uWin.x) return 0.0;
  float k = floor((s - R.y) / uWin.x + 0.5);
  float sc = R.y + k * uWin.x;
  if (sc < R.y - 0.01 || sc > R.z + 0.01) return 0.0;
  for (int d = 0; d < 8; d++) {
    vec4 D = uDoors[d];
    if (D.z > 0.0 && abs(sc - D.x) < D.z + uWin.x * 0.55 && abs(R.x - D.y) < D.w) return 0.0;
  }
  float m = 1.0 - smoothstep(-aa, aa, plRRect(vec2(s - sc, t), uWin.yz, uWin.w));
  float avg = (2.0 * uWin.y / uWin.x) * (1.0 - smoothstep(uWin.z - aa, uWin.z + aa, abs(t)));
  float far = smoothstep(uWin.y * 0.5, uWin.y * 1.5, fw.x);
  return mix(m, avg * 0.85, far);
}
`;

const FRAG_COLOR = /* glsl */ `
float plWinM = 0.0;
float plCharM = 0.0;
if (vWin.y < 50.0) {
  vec2 fw = fwidth(vWin);
  float aa = max(max(fw.x, fw.y), 1e-4);
  plWinM = max(plRow(uRowA, vWin, fw, aa), plRow(uRowB, vWin, fw, aa));
  float lineM = 0.0;
  for (int d = 0; d < 8; d++) {
    vec4 D = uDoors[d];
    if (D.z <= 0.0) continue;
    vec2 q = vWin - D.xy;
    if (abs(q.x) > D.z + 0.3 || abs(q.y) > D.w + 0.3) continue;
    float sd = plRRect(q, D.zw, min(D.z, D.w) * 0.3);
    float lw = max(0.011, aa * 0.5);
    lineM = max(lineM, 1.0 - smoothstep(lw - aa, lw + aa, abs(sd)));
    float sdw = plRRect(q - vec2(0.0, D.w * 0.42), vec2(uWin.y * 0.85, uWin.z * 0.75), uWin.w * 0.8);
    plWinM = max(plWinM, (1.0 - smoothstep(-aa, aa, sdw)) * (1.0 - smoothstep(uWin.y * 0.5, uWin.y * 1.5, fw.x)));
  }
  lineM *= 1.0 - smoothstep(0.03, 0.09, aa);
  diffuseColor.rgb *= 1.0 - 0.45 * lineM;
  diffuseColor.rgb = mix(diffuseColor.rgb, uWinCol, plWinM);
}
if (vChar > 0.002) {
  float nz = plNoise(vPPos * 0.9) * 0.6 + plNoise(vPPos * 3.7) * 0.4;
  // smoky darkening everywhere, then patchy soot that spreads with the amount
  diffuseColor.rgb *= mix(1.0, 0.5 + 0.25 * nz, clamp(vChar * 1.8, 0.0, 1.0));
  plCharM = smoothstep(0.05, 0.55, vChar * 1.35 + 0.2 - nz * 0.85);
  vec3 soot = mix(vec3(0.018, 0.016, 0.014), vec3(0.085, 0.065, 0.05), plNoise(vPPos * 7.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, soot, plCharM);
}
`;

const FRAG_RM = /* glsl */ `
float roughnessFactor = roughness * mix(mix(vRM.x, 0.12, plWinM), 0.95, plCharM);
float metalnessFactor = metalness * mix(vRM.y, 0.35, plWinM) * (1.0 - plCharM);
`;

const FRAG_EMISSIVE = /* glsl */ `
totalEmissiveRadiance += plWinM * vec3(1.0, 0.76, 0.42) * uNight * 0.85;
`;

/** Interior surfaces (cockpit shell, cabins): lit by ambient/sky only — no sun through the hull, no shadow acne. */
const FRAG_INTERIOR = /* glsl */ `
if (vInt > 0.5) {
  reflectedLight.directDiffuse *= 0.1;
  reflectedLight.directSpecular *= 0.0;
}
`;

function patchVertexMain(src: string): string {
  return src
    .replace('#include <common>', '#include <common>\n' + VERT_PARS)
    .replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\nvec3 plDef = planeDeform(position, objectNormal);\nvWin = aWin;\nvRM = aRM;\nvInt = aFx.z < -0.5 ? 1.0 : 0.0;\n{ int pc = int(aFx.w + 0.5); vChar = uCharV[pc >> 2][pc & 3]; }',
    )
    .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = plDef;');
}

export interface PlaneMaterials {
  main: THREE.MeshStandardMaterial;
  merged: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
  depthMerged: THREE.MeshDepthMaterial;
  uniforms: PlaneUniforms;
  mergedFlags: { value: THREE.Vector4 };
  dispose(): void;
}

function makeStandard(atlas: THREE.Texture, U: PlaneUniforms, flags: { value: THREE.Vector4 }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: atlas, roughness: 1, metalness: 1, envMapIntensity: 1 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, { uFlags: flags, uNight: GLOBAL_UNIFORMS.uNight });
    shader.vertexShader = patchVertexMain(shader.vertexShader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_RM)
      .replace('#include <metalnessmap_fragment>', '')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + FRAG_EMISSIVE)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + FRAG_INTERIOR);
  };
  m.customProgramCacheKey = () => 'coastline-plane-v1';
  return m;
}

function makeDepth(U: PlaneUniforms, flags: { value: THREE.Vector4 }): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, { uFlags: flags });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ vec3 dn = vec3(0.0, 1.0, 0.0); transformed = planeDeform(position, dn); }');
  };
  m.customProgramCacheKey = () => 'coastline-plane-depth-v1';
  return m;
}

/** Per-instance materials sharing one set of uniforms (merged = LOD-2 single mesh in root space). */
export function createPlaneMaterials(atlas: THREE.Texture, win: WindowLayout | null): PlaneMaterials {
  const U = makeUniforms(win);
  const mergedFlags = { value: new THREE.Vector4(1, 0, 0, 0) };
  const main = makeStandard(atlas, U, U.uFlags);
  const merged = makeStandard(atlas, U, mergedFlags);
  const depth = makeDepth(U, U.uFlags);
  const depthMerged = makeDepth(U, mergedFlags);
  return {
    main, merged, depth, depthMerged, uniforms: U, mergedFlags,
    dispose() {
      main.dispose();
      merged.dispose();
      depth.dispose();
      depthMerged.dispose();
    },
  };
}

// ------------------------------------------------------------------ light glows ------------------------------------

const GLOW_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aKind; // kind, size, phase, -
attribute vec3 aDir;
attribute vec3 color;
uniform vec4 uOn;
uniform float uTime;
uniform float uNight;
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float kind = aKind.x;
  float on = kind < 0.5 ? uOn.x : (kind < 1.5 ? uOn.y : (kind < 2.5 ? uOn.z : uOn.w));
  float t = uTime + aKind.z;
  float inten = 1.0;
  float dayK = 0.45;
  if (kind > 0.5 && kind < 1.5) {
    float ph = mod(t, 1.25);
    inten = step(ph, 0.05) + step(0.16, ph) * step(ph, 0.21);
    dayK = 1.0;
  } else if (kind > 1.5 && kind < 2.5) {
    float ph = mod(t, 1.05);
    inten = exp(-ph * 6.0);
    dayK = 0.8;
  }
  vec3 vdir = normalize(-mv.xyz);
  vec3 d = normalize(normalMatrix * aDir);
  float facing = max(dot(d, vdir), 0.0);
  if (kind > 2.5) { inten *= 0.08 + 0.92 * pow(facing, 2.5); dayK = 0.6; }
  else if (kind < 0.5) inten *= 0.35 + 0.65 * smoothstep(-0.2, 0.4, dot(d, vdir));
  float dist = max(-mv.z, 0.01);
  float night = clamp(uNight, 0.0, 1.0);
  float size = max(aKind.y * mix(0.7, 1.25, night), dist * mix(0.0035, 0.0055, night)) * (0.55 + 0.45 * inten);
  vA = on * inten * mix(dayK, 1.6, night);
  mv.xy += aCorner * size;
  gl_Position = vA < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
  vUv = aCorner;
  vCol = color;
}
`;

const GLOW_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vA;
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 28.0);
  float halo = exp(-r2 * 5.0) * 0.55;
  vec3 c = vCol * (halo + core * 1.6) + vec3(core * 0.9);
  gl_FragColor = vec4(c * vA, 1.0);
}
`;

export interface GlowUniforms {
  uOn: { value: THREE.Vector4 };
  uTime: { value: number };
}

export function createGlowMaterial(): { mat: THREE.ShaderMaterial; uniforms: GlowUniforms } {
  const uniforms: GlowUniforms = { uOn: { value: new THREE.Vector4(0, 0, 0, 0) }, uTime: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uNight: GLOBAL_UNIFORMS.uNight },
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  return { mat, uniforms };
}

export interface GlowSpec {
  pos: THREE.Vector3; // design / root space
  color: readonly [number, number, number];
  kind: 0 | 1 | 2 | 3; // nav, strobe, beacon, landing
  size: number;
  phase: number;
  dir: THREE.Vector3;
  part: string;
}

/** Billboard quads for a list of lights (positions relative to `origin`). */
export function buildGlowGeometry(lights: GlowSpec[], origin: THREE.Vector3): THREE.BufferGeometry {
  const pos: number[] = [];
  const corner: number[] = [];
  const kind: number[] = [];
  const dir: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  lights.forEach((l, i) => {
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const c of corners) {
      pos.push(l.pos.x - origin.x, l.pos.y - origin.y, l.pos.z - origin.z);
      corner.push(c[0], c[1]);
      kind.push(l.kind, l.size, l.phase, 0);
      dir.push(l.dir.x, l.dir.y, l.dir.z);
      col.push(l.color[0], l.color[1], l.color[2]);
    }
    const b = i * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 4));
  g.setAttribute('aDir', new THREE.Float32BufferAttribute(dir, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  if (g.boundingSphere) g.boundingSphere.radius += 3;
  return g;
}
