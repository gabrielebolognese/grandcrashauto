import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';

/**
 * World materials: one vertex-coloured ground/road material (procedural detail per surface class `aMat`) shared by
 * every chunk, the highway and LOD layers, and the instanced building facade material (window grids, storefronts,
 * awnings, neon, lit windows at night that change over time). Patterns use absolute coordinates (world + uWOrigin).
 */

const NOISE = /* glsl */ `
float wHash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float wHash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float wNoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(wHash12(i), wHash12(i+vec2(1.0,0.0)), u.x), mix(wHash12(i+vec2(0.0,1.0)), wHash12(i+vec2(1.0,1.0)), u.x), u.y); }
float wLine(float f, float w, float fw){ float d = min(f, 1.0 - f); return 1.0 - smoothstep(w - fw, w + fw, d); }
`;

export function createGroundMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  mat.name = 'world-ground';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWTime = GLOBAL_UNIFORMS.uTime;
    shader.uniforms.uWOrigin = GLOBAL_UNIFORMS.uOrigin;
    shader.uniforms.uWNight = GLOBAL_UNIFORMS.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aMat;\nvarying float vMat;\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying float vMat;\nvarying vec3 vWPos;\nuniform float uWTime;\nuniform vec3 uWOrigin;\nuniform float uWNight;\n${NOISE}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec3 wp = vWPos + uWOrigin;
        vec2 p = wp.xz;
        int m = int(vMat + 0.5);
        float wRough = roughness;
        float wMetal = 0.0;
        float fwp = max(fwidth(p.x), fwidth(p.y));
        if (m == 1) { // asphalt
          float n = wNoise(p * 0.35) * 0.09 + wNoise(p * 2.7) * 0.05 + (wHash12(floor(p * 9.0)) - 0.5) * 0.06 * (1.0 - smoothstep(0.05, 0.3, fwp));
          float wPatch = smoothstep(0.62, 0.7, wNoise(p * 0.045 + 7.3)) * 0.06;
          diffuseColor.rgb *= 0.93 + n - wPatch;
          wRough = 0.88;
        } else if (m == 2) { // sidewalk pavers
          vec2 t = p / 1.25;
          float l = max(wLine(fract(t.x), 0.035, fwidth(t.x)), wLine(fract(t.y), 0.035, fwidth(t.y)));
          l *= 1.0 - smoothstep(0.08, 0.25, fwp);
          float tv = (wHash12(floor(t)) - 0.5) * 0.07;
          diffuseColor.rgb *= (1.0 + tv + (wNoise(p * 1.7) - 0.5) * 0.05) * (1.0 - l * 0.16);
          wRough = 0.85;
        } else if (m == 3) { // grass
          float n1 = wNoise(p * 0.11), n2 = wNoise(p * 0.9), n3 = wHash12(floor(p * 6.0));
          diffuseColor.rgb *= 0.82 + n1 * 0.22 + n2 * 0.1 + (n3 - 0.5) * 0.06 * (1.0 - smoothstep(0.05, 0.3, fwp));
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.05, 0.7), smoothstep(0.55, 0.85, n1) * 0.5);
          wRough = 0.95;
        } else if (m == 4) { // sand
          float rip = sin(p.y * 1.6 + wNoise(p * 0.2) * 6.0) * 0.5 + 0.5;
          diffuseColor.rgb *= 0.95 + rip * 0.04 + (wNoise(p * 4.0) - 0.5) * 0.07;
          wRough = 0.97;
        } else if (m == 5) { // paint
          diffuseColor.rgb *= 0.86 + wNoise(p * 1.9) * 0.16;
          wRough = 0.62;
        } else if (m == 6) { // concrete
          diffuseColor.rgb *= 0.95 + (wNoise(p * 1.3 + wp.y) - 0.5) * 0.08;
          wRough = 0.82;
        } else if (m == 7) { // water
          float w1 = sin(p.x * 0.9 + uWTime * 1.3) * sin(p.y * 0.7 - uWTime * 1.1);
          diffuseColor.rgb *= 0.92 + w1 * 0.06;
          wRough = 0.06;
          wMetal = 0.1;
        } else if (m == 8) { // metal
          wRough = 0.38;
          wMetal = 0.55;
        } else if (m == 9) { // plaza pavers (staggered)
          vec2 t = vec2(p.x / 1.6, p.y / 0.8);
          t.x += step(1.0, mod(floor(t.y), 2.0)) * 0.5;
          float l = max(wLine(fract(t.x), 0.03, fwidth(t.x)), wLine(fract(t.y), 0.05, fwidth(t.y)));
          l *= 1.0 - smoothstep(0.08, 0.25, fwp);
          diffuseColor.rgb *= (1.0 + (wHash12(floor(t)) - 0.5) * 0.1) * (1.0 - l * 0.18);
          wRough = 0.8;
        } else if (m == 10) { // soil
          diffuseColor.rgb *= 0.85 + wNoise(p * 3.0) * 0.25;
          wRough = 1.0;
        } else if (m == 11) { // emissive paint (runway / road studs) — handled by vertex colour, glows at night
          wRough = 0.5;
        }
        `,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = wRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = wMetal;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\nif (m == 11) totalEmissiveRadiance += diffuseColor.rgb * (0.15 + uWNight * 2.2);',
      );
  };
  mat.customProgramCacheKey = () => 'world-ground-v1';
  return mat;
}

/** Facade style ids (must match gen/model.ts Facade). */
const FACADE = /* glsl */ `
// styles: 0 deco, 1 glass, 2 house, 3 hotel, 4 solid, 5 awning, 6 neon, 7 garage, 8 container, 9 shop, 10 apartment
float rectMask(float f, float a, float b, float fw){ return smoothstep(a - fw, a + fw, f) * (1.0 - smoothstep(b - fw, b + fw, f)); }
`;

export function createFacadeMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0, color: 0xffffff });
  mat.name = 'world-facade';
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWTime = GLOBAL_UNIFORMS.uTime;
    shader.uniforms.uWOrigin = GLOBAL_UNIFORMS.uOrigin;
    shader.uniforms.uWNight = GLOBAL_UNIFORMS.uNight;
    shader.uniforms.uWFog = GLOBAL_UNIFORMS.uFogColor;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 aStyle; attribute vec4 aExtra; attribute vec3 aAccent;
varying vec4 vStyle; varying vec4 vExtra; varying vec3 vAccent; varying vec4 vFace; varying vec3 vSize; varying vec3 vLocal; varying vec3 vWPosF;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 scl = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
#else
vec3 scl = vec3(1.0);
#endif
vec3 lp = position * scl;
float ft; float fu; float fwid;
if (abs(normal.y) > 0.5) { ft = normal.y > 0.0 ? 1.0 : 2.0; fu = lp.x; fwid = scl.x; }
else if (abs(normal.x) > 0.5) { ft = normal.x > 0.0 ? 4.0 : 5.0; fu = -lp.z * sign(normal.x); fwid = scl.z; }
else { ft = normal.z > 0.0 ? 3.0 : 6.0; fu = lp.x * sign(normal.z); fwid = scl.x; }
vFace = vec4(fu, lp.y + aStyle.w, fwid, ft);
vSize = scl; vLocal = lp; vStyle = aStyle; vExtra = aExtra; vAccent = aAccent;
#ifdef USE_INSTANCING
vWPosF = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;
#else
vWPosF = (modelMatrix * vec4(position, 1.0)).xyz;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uWTime; uniform vec3 uWOrigin; uniform float uWNight; uniform vec3 uWFog;
varying vec4 vStyle; varying vec4 vExtra; varying vec3 vAccent; varying vec4 vFace; varying vec3 vSize; varying vec3 vLocal; varying vec3 vWPosF;
${NOISE}
${FACADE}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        int st = int(vStyle.x + 0.5);
        float seed = vStyle.y;
        float floorH = max(2.4, vStyle.z);
        float baseOff = vStyle.w;
        float groundH = vExtra.x;
        float litFrac = vExtra.y;
        float ft = vFace.w;
        float u = vFace.x, v = vFace.y, fw = vFace.z;
        float topV = baseOff + vSize.y;
        vec3 wall = diffuseColor.rgb;
        vec3 acc = vAccent;
        float glassMask = 0.0;
        float wBlind = 0.0, wInset = 0.0;
        vec3 wBlindC = vec3(0.9, 0.87, 0.8);
        float fRough = 0.86;
        float fMetal = 0.0;
        vec3 emis = vec3(0.0);
        vec3 absP = vWPosF + uWOrigin;
        float grain = (wNoise(absP.xz * 0.9 + absP.y * 0.7) - 0.5) * 0.05;
        wall *= 1.0 + grain;
        bool side = ft > 2.5;
        if (ft < 1.5 && ft > 0.5) {
          // roof: gravel / tar with a lighter parapet rim
          vec2 rp = vLocal.xz;
          float edge = min(vSize.x * 0.5 - abs(rp.x), vSize.z * 0.5 - abs(rp.y));
          vec3 roofC = mix(wall * 0.55, vec3(0.6, 0.58, 0.55), 0.6) * (0.92 + wNoise(absP.xz * 1.5) * 0.12);
          if (st == 1) roofC = vec3(0.55, 0.57, 0.6);
          if (st == 4 || st == 5 || st == 6 || st == 8) roofC = wall * 0.92;
          wall = mix(roofC, wall * 1.04, step(edge, 0.35));
        } else if (side) {
          if (st == 0 || st == 3 || st == 9 || st == 10 || st == 2 || st == 7) {
            float colW = st == 2 ? 3.4 : (st == 3 ? 3.2 : 3.0);
            float nC = max(1.0, floor((fw - 1.0) / colW));
            float gw = nC * colW;
            float uu = u + gw * 0.5;
            float cu = uu / colW;
            float col = floor(cu); float fu = cu - col;
            float rowBase = groundH > 0.0 ? groundH : (st == 2 ? 0.9 : 0.7);
            float rv = (v - rowBase) / floorH;
            float row = floor(rv); float fv = rv - row;
            float fwU = fwidth(cu) * 1.2, fwV = fwidth(rv) * 1.2;
            float inGrid = step(0.0, uu) * step(uu, gw) * step(rowBase, v) * step(v, topV - 0.9);
            float ww = st == 2 ? 0.26 : 0.2;
            float wx0 = ww, wx1 = 1.0 - ww, wy0 = 0.26, wy1 = 0.84;
            float outer = rectMask(fu, wx0, wx1, fwU) * rectMask(fv, wy0, wy1, fwV) * inGrid;
            float lu = clamp((fu - wx0) / (wx1 - wx0), 0.0, 1.0), lv = clamp((fv - wy0) / (wy1 - wy0), 0.0, 1.0);
            float detail = 1.0 - smoothstep(0.1, 0.28, fwU);
            float fr = 0.085;
            float inner = rectMask(lu, fr, 1.0 - fr, fwU * 3.5) * rectMask(lv, fr, 1.0 - fr, fwV * 3.5);
            float mull = rectMask(lu, 0.47, 0.53, fwU * 3.5) * inner;
            vec3 frameC = mix(wall, vec3(0.97, 0.96, 0.93), 0.7);
            wall = mix(wall, frameC, outer * (1.0 - inner + mull) * detail);
            // sill + its shadow, plus a lintel line above
            float sill = rectMask(fu, wx0 - 0.04, wx1 + 0.04, fwU) * rectMask(fv, wy0 - 0.06, wy0, fwV) * inGrid * detail;
            wall = mix(wall, wall * 1.12 + 0.04, sill);
            wall *= 1.0 - 0.22 * rectMask(fv, wy0 - 0.12, wy0 - 0.06, fwV) * rectMask(fu, wx0 - 0.04, wx1 + 0.04, fwU) * inGrid * detail;
            wall *= 1.0 - 0.1 * rectMask(fv, wy1, wy1 + 0.04, fwV) * rectMask(fu, wx0, wx1, fwU) * inGrid * detail;
            float win = outer * mix(1.0, inner * (1.0 - mull), detail);
            float far = smoothstep(0.25, 0.6, fwU);
            win = mix(win, inGrid * 0.42, far);
            // blinds / curtains and fake inset depth (top + left shadow inside the reveal)
            float hb = wHash13(vec3(col * 1.3, row * 2.1, seed * 57.0 + ft * 3.0));
            float blindAmt = step(0.58, hb) * (0.25 + 0.6 * fract(hb * 7.31));
            wBlind = step(1.0 - blindAmt, lv) * detail;
            wInset = ((1.0 - smoothstep(0.0, 0.22, 1.0 - lv)) * 0.55 + (1.0 - smoothstep(0.0, 0.16, lu)) * 0.35) * detail;
            wBlindC = mix(vec3(0.93, 0.89, 0.8), vec3(0.85, 0.9, 0.92), step(0.8, fract(hb * 13.7)));
            // deco pilasters / hotel eyebrows / apartment balconies
            if (st == 0) wall *= 1.0 + 0.06 * (1.0 - rectMask(fu, 0.1, 0.9, fwU)) * inGrid;
            if (st == 3) {
              float brow = rectMask(fv, 0.86, 0.95, fwV) * inGrid;
              wall = mix(wall, acc, brow * 0.9);
              float band = 1.0 - step(1.1, abs(u));
              wall = mix(wall, vec3(0.98, 0.97, 0.94), band * step(groundH, v));
              win *= 1.0 - band;
            }
            if (st == 10) wall = mix(wall, wall * 0.86, rectMask(fv, 0.0, 0.12, fwV) * inGrid);
            // corner pilasters + darker plinth on buildings without storefronts
            wall *= 1.0 + 0.05 * step(fw * 0.5 - abs(u), 0.45);
            if (groundH <= 0.0 && baseOff < 0.01) wall *= 1.0 - 0.2 * (1.0 - smoothstep(0.5, 0.56, v));
            // storefront ground floor
            if (groundH > 0.0 && baseOff < 0.01 && v < groundH) {
              float sc = max(1.0, floor(fw / 4.2));
              float su = (u / fw + 0.5) * sc;
              float sfu = fract(su);
              float shop = rectMask(sfu, 0.07, 0.93, fwidth(su)) * rectMask(v, 0.35, groundH - 1.15, fwidth(v));
              win = max(win * 0.0, shop);
              float signBand = rectMask(v, groundH - 0.95, groundH - 0.25, fwidth(v));
              vec3 signC = mix(acc, vec3(1.0), 0.15);
              wall = mix(wall, signC, signBand);
              // neon accents on shop fronts at night
              float hs = wHash12(vec2(floor(su), seed * 91.0));
              emis += signC * signBand * uWNight * (0.6 + 1.2 * step(0.45, hs));
              emis += vec3(1.0, 0.86, 0.62) * shop * uWNight * 0.55 * step(0.25, hs);
            }
            // doors
            if (ft > 2.5 && ft < 3.5 && baseOff < 0.01) {
              if (st == 2) {
                float door = (1.0 - step(0.6, abs(u))) * step(v, 2.25);
                wall = mix(wall, acc * 0.55, door);
                win *= 1.0 - (1.0 - step(1.3, abs(u))) * step(v, 2.6);
              }
              if (st == 7) {
                float opening = (1.0 - step(4.2, abs(u))) * step(v, 5.6);
                float slat = step(0.5, fract(v * 2.6));
                vec3 doorC = mix(vec3(0.07, 0.07, 0.09), vec3(0.75, 0.74, 0.7) * (0.85 + 0.15 * slat), step(3.6, v));
                wall = mix(wall, doorC, opening);
                win *= 1.0 - opening;
                float sign = (1.0 - step(5.5, abs(u))) * rectMask(v, 6.3, 8.4, fwidth(v));
                wall = mix(wall, acc, sign);
                emis += acc * sign * (0.25 + uWNight * 1.6);
                emis += vec3(1.0, 0.9, 0.7) * opening * (1.0 - step(3.6, v)) * (0.15 + uWNight * 0.6);
              }
            }
            // night: windows light up in a slowly changing random pattern
            float face = ft * 7.0 + floor(fw * 3.0);
            float h1 = wHash13(vec3(col, row, seed * 113.0 + face));
            float slot = floor(uWTime / (35.0 + 95.0 * h1) + h1 * 17.0);
            float on = step(wHash13(vec3(col + 3.1, row * 1.7, slot + seed * 37.0)), litFrac);
            vec3 litC = mix(vec3(1.0, 0.78, 0.48), vec3(0.78, 0.86, 1.0), step(0.78, h1));
            emis += litC * win * on * uWNight * (1.0 + h1 * 0.8);
            glassMask = win;
          } else if (st == 1) {
            // curtain wall: mullion grid
            float cu = u / 1.55, rv = (v - baseOff) / floorH + baseOff / floorH;
            float fwU = fwidth(cu), fwV = fwidth(rv);
            float mull = max(wLine(fract(cu), 0.05, fwU), wLine(fract(rv), 0.07, fwV)) * (1.0 - smoothstep(0.3, 0.6, fwU));
            glassMask = 1.0 - mull;
            float spandrel = rectMask(fract(rv), 0.0, 0.22, fwV) * (1.0 - smoothstep(0.3, 0.6, fwV));
            wall = mix(wall * 1.25, vec3(0.92, 0.93, 0.94), 0.55);
            glassMask *= 1.0 - spandrel * 0.6;
            float h1 = wHash13(vec3(floor(cu), floor(rv), seed * 71.0 + ft));
            float slot = floor(uWTime / (45.0 + 80.0 * h1) + h1 * 11.0);
            float on = step(wHash13(vec3(floor(cu * 0.5), floor(rv), slot + seed * 19.0)), litFrac * 0.85);
            emis += vec3(0.95, 0.9, 0.8) * glassMask * on * uWNight * 0.9;
          } else if (st == 5) {
            // awning: stripes + neon edge at night
            float s2 = step(0.5, fract(u / 0.7));
            wall = mix(acc, vec3(0.98), s2 * 0.85);
            emis += acc * uWNight * 0.5;
          } else if (st == 6) {
            // neon sign fin: glowing segments
            float seg = rectMask(fract(v / 1.25), 0.12, 0.88, fwidth(v / 1.25));
            wall = mix(wall * 0.35, acc, seg);
            emis += acc * seg * (0.35 + uWNight * 2.6);
          } else if (st == 8) {
            // shipping container: corrugation + end doors
            float cor = 0.86 + 0.14 * sin(u * 6.2832 / 0.32);
            wall *= cor;
            if (ft > 2.5 && ft < 3.5 || ft > 5.5) wall *= 0.9 + 0.1 * step(0.05, abs(u));
            fRough = 0.6;
          } else {
            // solid trim: subtle vertical gradient
            wall *= 0.94 + 0.08 * clamp(v / max(1.0, topV), 0.0, 1.0);
          }
        }
        vec3 glassC = st == 1 ? mix(diffuseColor.rgb, vec3(0.1, 0.16, 0.22), 0.45) : vec3(0.13, 0.17, 0.23);
        glassC *= 1.0 - wInset * 0.55;
        glassC = mix(glassC, wBlindC * (1.0 - wInset * 0.3), wBlind);
        diffuseColor.rgb = mix(wall, glassC, glassMask);
        glassMask *= 1.0 - wBlind * 0.75;
        fRough = mix(fRough, 0.12, glassMask);
        fMetal = mix(fMetal, 0.35, glassMask);
        `,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = fRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = fMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += emis;')
      .replace(
        '#include <opaque_fragment>',
        /* glsl */ `
        // fake sky reflection on glass (works without an env map; adds to it when one exists)
        {
          vec3 vd = normalize(vViewPosition);
          vec3 rv = reflect(-vd, normal);
          vec3 rw = (vec4(rv, 0.0) * viewMatrix).xyz;
          float fres = 0.18 + 0.82 * pow(1.0 - clamp(dot(normal, vd), 0.0, 1.0), 4.0);
          vec3 sky = mix(uWFog * 1.05, vec3(0.42, 0.66, 0.92), clamp(rw.y * 1.6, 0.0, 1.0));
          sky = mix(vec3(0.33, 0.33, 0.38), sky, smoothstep(-0.08, 0.04, rw.y));
          sky *= 1.0 - uWNight * 0.88;
          outgoingLight = mix(outgoingLight, sky, glassMask * fres * (st == 1 ? 0.75 : 0.5));
        }
        #include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'world-facade-v1';
  return mat;
}

/** Gable roofs: instance colour + tile rows. */
export function createRoofMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0, color: 0xffffff });
  mat.name = 'world-roof';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoofL;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRoofL = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRoofL;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float rows = vRoofL.y * 9.0;
        float l = smoothstep(0.0, 0.12, fract(rows)) ;
        diffuseColor.rgb *= 0.86 + 0.14 * l;`,
      );
  };
  mat.customProgramCacheKey = () => 'world-roof-v1';
  return mat;
}
