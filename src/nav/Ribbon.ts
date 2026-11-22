import * as THREE from 'three';
import { CONFIG } from '../config';
import { TRACK_STEP, type Route } from './Route';

const MAX_SAMPLES = Math.ceil(420 / TRACK_STEP) + 6;

const VERT = /* glsl */ `
attribute vec2 aUv;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uCarS;
uniform float uEndS;
uniform float uRouteEnd;
uniform float uSpacing;
uniform float uFlow;
uniform float uOpacity;
uniform vec3 uGlow;
uniform vec3 uCore;
varying vec2 vUv;
void main() {
  float a = abs(vUv.x);
  float d = vUv.y;
  float fade = smoothstep(uCarS - 1.0, uCarS + 8.0, d) * (1.0 - smoothstep(uEndS - 50.0, uEndS, d)) * (1.0 - smoothstep(uRouteEnd - 6.0, uRouteEnd, d));
  float edge = 1.0 - smoothstep(0.82, 1.0, a);
  // soft lane glow with brighter rails
  float glow = (0.16 + 0.34 * smoothstep(0.5, 0.92, a)) * edge;
  // flowing chevrons pointing along the route (tip ahead: lines d + k|u| = c)
  float p = (d + a * uSpacing * 0.42 - uTime * uFlow) / uSpacing;
  float f = fract(p);
  float chev = smoothstep(0.0, 0.07, f) * (1.0 - smoothstep(0.24, 0.34, f));
  chev *= 1.0 - smoothstep(0.7, 0.9, a);
  vec3 col = mix(uGlow, uCore, chev);
  float alpha = max(glow, chev) * fade * uOpacity;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(col * (1.0 + 0.5 * chev), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Soft glowing chevron ribbon painted on the road surface along the first ~150 m of the active route. ONE draw call:
 * a dynamic triangle strip rebuilt from the route's dense track every frame (≤ ~110 samples), in LOCAL coordinates
 * (the mesh opts out of the core origin shift; its vertices come from the absolute track minus the origin offset).
 */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private uv: Float32Array;
  private mat: THREE.ShaderMaterial;
  private opacity = 0;
  private target = 0;
  private time = 0;
  private tmp = new Float64Array((MAX_SAMPLES + 2) * 5);
  private smp = { x: 0, y: 0, z: 0, off: 0, lat: 0 };

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX_SAMPLES * 2 * 3);
    this.uv = new Float32Array(MAX_SAMPLES * 2 * 2);
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    const ua = new THREE.BufferAttribute(this.uv, 2);
    ua.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', pa);
    this.geo.setAttribute('aUv', ua);
    const idx = new Uint16Array((MAX_SAMPLES - 1) * 6);
    for (let i = 0; i < MAX_SAMPLES - 1; i++) {
      const a = i * 2;
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uCarS: { value: 0 },
        uEndS: { value: 0 },
        uRouteEnd: { value: 0 },
        uSpacing: { value: 6 },
        uFlow: { value: 8 },
        uOpacity: { value: 0 },
        uGlow: { value: new THREE.Color('#5cd6e6') },
        uCore: { value: new THREE.Color('#f4ffff') },
      },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'nav-ribbon';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.visible = false;
    this.mesh.userData.noOriginShift = true;
  }

  /** Fade the ribbon in/out (it keeps animating while fading out). */
  setActive(on: boolean): void {
    this.target = on ? 1 : 0;
  }

  /**
   * Rebuild the strip ahead of the car. `ground(x, z)` returns the drivable surface height at LOCAL x,z (or NaN);
   * ox/oz = origin offset (absolute = local + offset).
   */
  update(dt: number, route: Route | null, ox: number, oz: number, ground: ((x: number, z: number) => number) | null): void {
    this.time += dt;
    this.opacity += (this.target - this.opacity) * Math.min(1, dt * 4);
    if (this.target === 0 && this.opacity < 0.01) this.opacity = 0;
    const visible = !!route && this.opacity > 0.002 && route.trackN >= 2;
    this.mesh.visible = visible;
    if (!visible || !route) return;
    const C = CONFIG.nav;
    const len = Math.min(400, Math.max(20, C.ribbonLength));
    const hw = C.ribbonWidth / 2;
    const lift = C.ribbonLift;
    const carS = route.s;
    const i0 = Math.max(0, Math.floor((carS - 4) / TRACK_STEP));
    const i1 = Math.min(route.trackN - 1, Math.ceil((carS + len) / TRACK_STEP), i0 + MAX_SAMPLES - 1);
    const count = i1 - i0 + 1;
    if (count < 2) {
      this.geo.setDrawRange(0, 0);
      return;
    }
    const P = this.pos;
    const U = this.uv;
    // smoothed samples i0-1 … i1+1 (neighbours give the tangents)
    const T = this.tmp;
    for (let k = -1; k <= count; k++) {
      route.trackSample(i0 + k, this.smp);
      const o = (k + 1) * 5;
      T[o] = this.smp.x;
      T[o + 1] = this.smp.y;
      T[o + 2] = this.smp.z;
      T[o + 3] = this.smp.off;
      T[o + 4] = this.smp.lat;
    }
    for (let k = 0; k < count; k++) {
      const i = i0 + k;
      const c = (k + 1) * 5;
      const pv = k * 5;
      const nx = (k + 2) * 5;
      let dx = T[nx] - T[pv];
      let dz = T[nx + 2] - T[pv + 2];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      // on the travel lanes: offset to the right of travel (right of (dx, dz) is (-dz, dx))
      const la = T[c + 4];
      const lx = T[c] - ox - dz * la;
      const lz = T[c + 2] - oz + dx * la;
      const ry = T[c + 1];
      let gy = route.tGround[i];
      if (Number.isNaN(gy) && ground) {
        const g = ground(lx, lz);
        gy = Number.isFinite(g) ? g : ry;
        route.tGround[i] = gy;
      }
      let y: number;
      if (T[c + 3]) y = Number.isFinite(gy) ? gy : ry;
      else y = Number.isFinite(gy) && Math.abs(gy - ry) < 2 ? Math.max(gy, ry) : ry;
      y += lift;
      // side vector perpendicular to the tangent in XZ
      const sx = dz * hw;
      const sz = -dx * hw;
      const o = k * 6;
      P[o] = lx + sx;
      P[o + 1] = y;
      P[o + 2] = lz + sz;
      P[o + 3] = lx - sx;
      P[o + 4] = y;
      P[o + 5] = lz - sz;
      const q = k * 4;
      const s = i * TRACK_STEP;
      U[q] = -1;
      U[q + 1] = s;
      U[q + 2] = 1;
      U[q + 3] = s;
    }
    const pa = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const ua = this.geo.getAttribute('aUv') as THREE.BufferAttribute;
    pa.clearUpdateRanges();
    pa.addUpdateRange(0, count * 6);
    pa.needsUpdate = true;
    ua.clearUpdateRanges();
    ua.addUpdateRange(0, count * 4);
    ua.needsUpdate = true;
    this.geo.setDrawRange(0, (count - 1) * 6);
    const u = this.mat.uniforms;
    u.uTime.value = this.time;
    u.uCarS.value = carS;
    u.uEndS.value = carS + len;
    u.uRouteEnd.value = route.partial ? route.length + 60 : route.length;
    u.uSpacing.value = C.ribbonSpacing;
    u.uFlow.value = C.ribbonFlow;
    u.uOpacity.value = this.opacity * C.ribbonOpacity;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
