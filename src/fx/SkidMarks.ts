import * as THREE from 'three';
import { CONFIG } from '../config';
import type { FxSharedUniforms } from './ParticlePool';

/**
 * Tyre skid marks: one dynamic ring buffer of quads (segments) shared by every wheel, ONE draw call.
 * Each wheel keeps an open strip; consecutive segments share edge vertices so ribbons are continuous.
 * Segments fade with age in the shader (no CPU work after writing); the ring overwrites the oldest.
 * Vertex record: position (3) + aSkid (across 0/1, distance along, birth time, opacity).
 */

const VERT = /* glsl */ `
uniform float uFxTime;
uniform float uClear;
uniform float uFade;
attribute vec4 aSkid;
varying vec3 vS;
#include <fog_pars_vertex>
void main() {
  float age = uFxTime - aSkid.z;
  float a = aSkid.w * (1.0 - smoothstep(uFade * 0.5, uFade, age));
  if (aSkid.z < uClear || a <= 0.002) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vS = vec3(0.0);
    #ifdef USE_FOG
      vFogDepth = 0.0;
    #endif
    return;
  }
  vS = vec3(aSkid.xy, a);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uDim;
varying vec3 vS;
#include <fog_pars_fragment>
void main() {
  float x = vS.x;
  float edge = smoothstep(0.0, 0.16, x) * smoothstep(1.0, 0.84, x);
  float grooves = 0.8 + 0.2 * step(0.5, fract(x * 3.0 + 0.25));
  float blot = 0.82 + 0.18 * fract(sin(floor(vS.y * 5.0) * 12.9898) * 43758.5453);
  float a = vS.z * uOpacity * edge * grooves * blot;
  if (a < 0.004) discard;
  vec3 rgb = uColor * uDim;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    a *= 1.0 - fogFactor;
  #endif
  gl_FragColor = vec4(rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

interface Strip {
  active: boolean;
  hasEdge: boolean;
  cx: number;
  cy: number;
  cz: number;
  lx: number;
  ly: number;
  lz: number;
  rx: number;
  ry: number;
  rz: number;
  alpha: number;
  dist: number;
}

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private pos: THREE.BufferAttribute;
  private skid: THREE.BufferAttribute;
  private capacity: number;
  private head = 0;
  private high = 0;
  private lastWrite = -1e9;
  private strips: Strip[] = [];
  private dLo = 1;
  private dHi = 0;
  private eLo = 1;
  private eHi = 0;
  private pendingPos = false;
  private pendingSkid = false;
  private readonly rp0 = { start: 0, count: 0 };
  private readonly rp1 = { start: 0, count: 0 };
  private readonly rs0 = { start: 0, count: 0 };
  private readonly rs1 = { start: 0, count: 0 };
  private warm = 0;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(capacity: number, shared: FxSharedUniforms) {
    this.capacity = Math.max(64, Math.floor(capacity));
    const n = this.capacity;
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3);
    this.skid = new THREE.BufferAttribute(new Float32Array(n * 4 * 4), 4);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.skid.setUsage(THREE.DynamicDrawUsage);
    this.pos.onUpload(() => (this.pendingPos = false));
    this.skid.onUpload(() => (this.pendingSkid = false));
    const idx = new (n * 4 > 65535 ? Uint32Array : Uint16Array)(n * 6);
    for (let s = 0; s < n; s++) {
      const b = s * 4;
      idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], s * 6);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('aSkid', this.skid);
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    this.uniforms = {
      uFxTime: shared.uFxTime,
      uClear: shared.uClear,
      uDim: shared.uDim,
      uFade: { value: 20 },
      uOpacity: { value: 0.6 },
      uColor: { value: new THREE.Color(0x141418) },
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    };
    const mat = new THREE.ShaderMaterial({
      name: 'fx-skid',
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.name = 'fx-skidmarks';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    for (let i = 0; i < 8; i++)
      this.strips.push({ active: false, hasEdge: false, cx: 0, cy: 0, cz: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, alpha: 0, dist: 0 });
  }

  warmup(frames: number): void {
    this.warm = frames;
  }

  get segmentCount(): number {
    return this.high;
  }

  /** Feed a wheel contact point. intensity 0..1 (skid strength). */
  add(wheel: number, p: THREE.Vector3, n: THREE.Vector3, intensity: number, now: number): void {
    const st = this.strips[wheel];
    if (!st) return;
    const cfg = CONFIG.fx.skid;
    let nx = n.x;
    let ny = n.y;
    let nz = n.z;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 0.5) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nx /= nl;
      ny /= nl;
      nz /= nl;
    }
    const lift = cfg.lift;
    const px = p.x + nx * lift;
    const py = p.y + ny * lift;
    const pz = p.z + nz * lift;
    const alpha = Math.min(1, Math.max(0, intensity));
    if (!st.active) {
      st.active = true;
      st.hasEdge = false;
      st.cx = px;
      st.cy = py;
      st.cz = pz;
      st.alpha = 0;
      return;
    }
    const dx = px - st.cx;
    const dy = py - st.cy;
    const dz = pz - st.cz;
    const d = Math.hypot(dx, dy, dz);
    if (d > cfg.maxSegment) {
      // teleport / huge frame gap: restart the strip here
      st.cx = px;
      st.cy = py;
      st.cz = pz;
      st.hasEdge = false;
      st.alpha = 0;
      return;
    }
    if (d < cfg.minSegment) return;
    // side = normalize(cross(normal, dir)) * halfWidth
    const ix = dx / d;
    const iy = dy / d;
    const iz = dz / d;
    let sx = ny * iz - nz * iy;
    let sy = nz * ix - nx * iz;
    let sz = nx * iy - ny * ix;
    const sl = Math.hypot(sx, sy, sz) || 1;
    const hw = cfg.width * 0.5;
    sx = (sx / sl) * hw;
    sy = (sy / sl) * hw;
    sz = (sz / sl) * hw;
    if (!st.hasEdge) {
      st.lx = st.cx + sx;
      st.ly = st.cy + sy;
      st.lz = st.cz + sz;
      st.rx = st.cx - sx;
      st.ry = st.cy - sy;
      st.rz = st.cz - sz;
      st.hasEdge = true;
    }
    const nlx = px + sx;
    const nly = py + sy;
    const nlz = pz + sz;
    const nrx = px - sx;
    const nry = py - sy;
    const nrz = pz - sz;
    const dist1 = st.dist + d;
    this.writeSegment(st.lx, st.ly, st.lz, st.rx, st.ry, st.rz, nlx, nly, nlz, nrx, nry, nrz, st.dist, dist1, st.alpha, alpha, now);
    st.lx = nlx;
    st.ly = nly;
    st.lz = nlz;
    st.rx = nrx;
    st.ry = nry;
    st.rz = nrz;
    st.cx = px;
    st.cy = py;
    st.cz = pz;
    st.alpha = alpha;
    st.dist = dist1 % 1000;
  }

  end(wheel: number): void {
    const st = this.strips[wheel];
    if (st) st.active = false;
  }

  endAll(): void {
    for (const s of this.strips) s.active = false;
  }

  private writeSegment(
    lx0: number, ly0: number, lz0: number, rx0: number, ry0: number, rz0: number,
    lx1: number, ly1: number, lz1: number, rx1: number, ry1: number, rz1: number,
    d0: number, d1: number, a0: number, a1: number, now: number,
  ): void {
    const s = this.head;
    this.head = s + 1 >= this.capacity ? 0 : s + 1;
    if (s + 1 > this.high) this.high = s + 1;
    const P = this.pos.array as Float32Array;
    const S = this.skid.array as Float32Array;
    let o = s * 12;
    P[o] = lx0; P[o + 1] = ly0; P[o + 2] = lz0;
    P[o + 3] = rx0; P[o + 4] = ry0; P[o + 5] = rz0;
    P[o + 6] = lx1; P[o + 7] = ly1; P[o + 8] = lz1;
    P[o + 9] = rx1; P[o + 10] = ry1; P[o + 11] = rz1;
    o = s * 16;
    S[o] = 0; S[o + 1] = d0; S[o + 2] = now; S[o + 3] = a0;
    S[o + 4] = 1; S[o + 5] = d0; S[o + 6] = now; S[o + 7] = a0;
    S[o + 8] = 0; S[o + 9] = d1; S[o + 10] = now; S[o + 11] = a1;
    S[o + 12] = 1; S[o + 13] = d1; S[o + 14] = now; S[o + 15] = a1;
    this.lastWrite = now;
    this.markDirty(s);
  }

  private markDirty(i: number): void {
    if (!this.pendingPos && !this.pendingSkid) {
      this.dLo = this.eLo = 1;
      this.dHi = this.eHi = 0;
    }
    this.pendingPos = this.pendingSkid = true;
    if (this.dLo > this.dHi) {
      this.dLo = this.dHi = i;
    } else if (i === this.dHi + 1) this.dHi = i;
    else if (i < this.dLo || i > this.dHi) {
      if (this.eLo > this.eHi) this.eLo = this.eHi = i;
      else if (i === this.eHi + 1) this.eHi = i;
      else if (i < this.eLo || i > this.eHi) {
        this.dLo = Math.min(this.dLo, this.eLo, i);
        this.dHi = Math.max(this.dHi, this.eHi, i);
        this.eLo = 1;
        this.eHi = 0;
      }
    }
    this.dirty = true;
  }
  private dirty = false;

  update(now: number): void {
    const cfg = CONFIG.fx.skid;
    this.uniforms.uFade.value = cfg.fadeTime;
    this.uniforms.uOpacity.value = cfg.opacity;
    (this.uniforms.uColor.value as THREE.Color).set(cfg.color);
    const alive = this.high > 0 && now - this.lastWrite < cfg.fadeTime;
    if (!alive && this.high > 0 && !this.pendingPos && !this.pendingSkid) {
      this.head = 0;
      this.high = 0;
      for (const s of this.strips) s.hasEdge = false;
    }
    if (this.warm > 0) {
      this.warm--;
      this.mesh.visible = true;
      this.geo.setDrawRange(0, Math.max(1, this.high) * 6);
    } else {
      this.mesh.visible = alive;
      this.geo.setDrawRange(0, this.high * 6);
    }
    if (this.dirty) {
      this.dirty = false;
      this.applyRanges(this.pos, 12, this.rp0, this.rp1);
      this.applyRanges(this.skid, 16, this.rs0, this.rs1);
    }
  }

  private applyRanges(attr: THREE.BufferAttribute, per: number, r0: { start: number; count: number }, r1: { start: number; count: number }): void {
    const ranges = attr.updateRanges;
    ranges.length = 0;
    if (this.dLo <= this.dHi) {
      r0.start = this.dLo * per;
      r0.count = (this.dHi - this.dLo + 1) * per;
      ranges.push(r0);
    }
    if (this.eLo <= this.eHi) {
      r1.start = this.eLo * per;
      r1.count = (this.eHi - this.eLo + 1) * per;
      ranges.push(r1);
    }
    attr.needsUpdate = true;
  }

  clear(): void {
    this.lastWrite = -1e9;
    this.endAll();
    this.mesh.visible = this.warm > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
