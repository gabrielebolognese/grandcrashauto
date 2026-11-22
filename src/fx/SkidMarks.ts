import * as THREE from 'three';
import { CONFIG } from '../config';
import type { FxSharedUniforms } from './ParticlePool';

/**
 * Ground ribbons: tyre skid marks (per-wheel strips) and plough/scrape gouges (SPEC-PART2 §11), in ONE dynamic ring
 * buffer of quads, ONE draw call. Strips share edge vertices so ribbons are continuous; segments fade with age in
 * the shader (no CPU work after writing); the ring overwrites the oldest.
 * Vertex record: position (3, stored in the fx root's space) + aSkid (across + 2*type, distance along, birth, opacity).
 */

const VERT = /* glsl */ `
uniform float uFxTime;
uniform float uClear;
uniform float uFade;
uniform float uGougeFade;
attribute vec4 aSkid;
varying vec4 vS;
#include <fog_pars_vertex>
void main() {
  float type = floor(aSkid.x * 0.5 + 0.0001);
  float fade = type > 0.5 ? uGougeFade : uFade;
  float age = uFxTime - aSkid.z;
  float a = aSkid.w * (1.0 - smoothstep(fade * 0.5, fade, age));
  if (aSkid.z < uClear || a <= 0.002) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vS = vec4(0.0);
    #ifdef USE_FOG
      vFogDepth = 0.0;
    #endif
    return;
  }
  vS = vec4(aSkid.x - type * 2.0, aSkid.y, a, type);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uGougeColor;
uniform float uOpacity;
uniform float uGougeOpacity;
uniform float uDim;
uniform float uWet;
varying vec4 vS;
#include <fog_pars_fragment>
float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
void main() {
  float x = vS.x;
  float gouge = vS.w;
  float a;
  vec3 rgb;
  if (gouge > 0.5) {
    // ragged edges + longitudinal furrows, lighter churned rim
    float rag = 0.13 + 0.06 * sin(vS.y * 2.3) + 0.04 * sin(vS.y * 7.1 + 1.3);
    float edge = smoothstep(0.0, rag, x) * smoothstep(1.0, 1.0 - rag, x);
    float furrow = 0.72 + 0.28 * sin(x * 31.4 + sin(vS.y * 0.45) * 2.0);
    a = vS.z * uGougeOpacity * edge * furrow;
    float rim = 1.0 - smoothstep(0.0, 0.25, min(x, 1.0 - x));
    rgb = mix(uGougeColor, uGougeColor * 1.9 + 0.06, rim * 0.6);
  } else {
    float edge = smoothstep(0.0, 0.16, x) * smoothstep(1.0, 0.84, x);
    float grooves = 0.8 + 0.2 * step(0.5, fract(x * 3.0 + 0.25));
    float blot = 0.82 + 0.18 * h1(floor(vS.y * 5.0));
    a = vS.z * uOpacity * edge * grooves * blot * (1.0 - 0.6 * uWet);
    rgb = uColor;
  }
  if (a < 0.004) discard;
  rgb *= uDim;
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
  used: number;
}

const WHEEL_STRIPS = 8;
const GOUGE_STRIPS = 12;
const UP = new THREE.Vector3(0, 1, 0);

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
  private dirty = false;
  private readonly rp0 = { start: 0, count: 0 };
  private readonly rp1 = { start: 0, count: 0 };
  private readonly rs0 = { start: 0, count: 0 };
  private readonly rs1 = { start: 0, count: 0 };
  private warm = 0;
  private colorKey = '';
  private gougeKey = '';
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(
    capacity: number,
    shared: FxSharedUniforms,
    private readonly root: THREE.Object3D,
  ) {
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
      uGougeFade: { value: 60 },
      uOpacity: { value: 0.6 },
      uGougeOpacity: { value: 0.85 },
      uWet: { value: 0 },
      uColor: { value: new THREE.Color(0x141418) },
      uGougeColor: { value: new THREE.Color(0x2a2118) },
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
    for (let i = 0; i < WHEEL_STRIPS + GOUGE_STRIPS; i++)
      this.strips.push({ active: false, hasEdge: false, cx: 0, cy: 0, cz: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, alpha: 0, dist: 0, used: 0 });
  }

  warmup(frames: number): void {
    this.warm = frames;
  }

  get segmentCount(): number {
    return this.high;
  }

  /** Feed a wheel contact point. intensity 0..1 (skid strength). */
  add(wheel: number, p: THREE.Vector3, n: THREE.Vector3, intensity: number, now: number): void {
    if (wheel < 0 || wheel >= WHEEL_STRIPS) return;
    const cfg = CONFIG.fx.skid;
    this.feed(this.strips[wheel], p.x, p.y, p.z, n, intensity, cfg.width, cfg.lift, 0, cfg.minSegment, cfg.maxSegment, now);
  }

  /** Gouge decal segment a→b (continues an open gouge strip whose end is near `a`). */
  gouge(a: THREE.Vector3, b: THREE.Vector3, width: number, now: number): void {
    let st: Strip | null = null;
    let best = 1.5 * 1.5;
    let lru = this.strips[WHEEL_STRIPS];
    for (let i = WHEEL_STRIPS; i < this.strips.length; i++) {
      const s = this.strips[i];
      if (s.used < lru.used) lru = s;
      if (!s.active) continue;
      const d = (s.cx - a.x) ** 2 + (s.cy - a.y) ** 2 + (s.cz - a.z) ** 2;
      if (d < best) {
        best = d;
        st = s;
      }
    }
    const w = Math.max(0.1, width);
    if (!st) {
      st = lru;
      st.active = true;
      st.hasEdge = false;
      st.cx = a.x;
      st.cy = a.y + 0.03;
      st.cz = a.z;
      st.alpha = 1;
      st.dist = 0;
    }
    st.used = now;
    this.feed(st, b.x, b.y, b.z, UP, 1, w, 0.03, 1, 0.05, 60, now);
  }

  private feed(
    st: Strip, x: number, y: number, z: number, n: THREE.Vector3, intensity: number,
    width: number, lift: number, type: number, minSeg: number, maxSeg: number, now: number,
  ): void {
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
    const px = x + nx * lift;
    const py = y + ny * lift;
    const pz = z + nz * lift;
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
    if (d > maxSeg) {
      // teleport / huge frame gap: restart the strip here
      st.cx = px;
      st.cy = py;
      st.cz = pz;
      st.hasEdge = false;
      st.alpha = 0;
      return;
    }
    if (d < minSeg) return;
    const ix = dx / d;
    const iy = dy / d;
    const iz = dz / d;
    let sx = ny * iz - nz * iy;
    let sy = nz * ix - nx * iz;
    let sz = nx * iy - ny * ix;
    const sl = Math.hypot(sx, sy, sz) || 1;
    const hw = width * 0.5;
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
    this.writeSegment(st.lx, st.ly, st.lz, st.rx, st.ry, st.rz, nlx, nly, nlz, nrx, nry, nrz, st.dist, dist1, st.alpha, alpha, type, now);
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
    if (st && wheel < WHEEL_STRIPS) st.active = false;
  }

  endAll(): void {
    for (let i = 0; i < WHEEL_STRIPS; i++) this.strips[i].active = false;
  }

  /** Floating origin: cached strip ends are in scene space. */
  shift(dx: number, dz: number): void {
    for (const s of this.strips) {
      s.cx -= dx;
      s.cz -= dz;
      s.lx -= dx;
      s.lz -= dz;
      s.rx -= dx;
      s.rz -= dz;
    }
  }

  private writeSegment(
    lx0: number, ly0: number, lz0: number, rx0: number, ry0: number, rz0: number,
    lx1: number, ly1: number, lz1: number, rx1: number, ry1: number, rz1: number,
    d0: number, d1: number, a0: number, a1: number, type: number, now: number,
  ): void {
    const s = this.head;
    this.head = s + 1 >= this.capacity ? 0 : s + 1;
    if (s + 1 > this.high) this.high = s + 1;
    const P = this.pos.array as Float32Array;
    const S = this.skid.array as Float32Array;
    // stored in the fx root's space (the root is shifted by the floating origin)
    const ox = this.root.position.x;
    const oy = this.root.position.y;
    const oz = this.root.position.z;
    let o = s * 12;
    P[o] = lx0 - ox; P[o + 1] = ly0 - oy; P[o + 2] = lz0 - oz;
    P[o + 3] = rx0 - ox; P[o + 4] = ry0 - oy; P[o + 5] = rz0 - oz;
    P[o + 6] = lx1 - ox; P[o + 7] = ly1 - oy; P[o + 8] = lz1 - oz;
    P[o + 9] = rx1 - ox; P[o + 10] = ry1 - oy; P[o + 11] = rz1 - oz;
    const t2 = type * 2;
    o = s * 16;
    S[o] = t2; S[o + 1] = d0; S[o + 2] = now; S[o + 3] = a0;
    S[o + 4] = 1 + t2; S[o + 5] = d0; S[o + 6] = now; S[o + 7] = a0;
    S[o + 8] = t2; S[o + 9] = d1; S[o + 10] = now; S[o + 11] = a1;
    S[o + 12] = 1 + t2; S[o + 13] = d1; S[o + 14] = now; S[o + 15] = a1;
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

  update(now: number, wetness: number): void {
    const cfg = CONFIG.fx.skid;
    const u = this.uniforms;
    u.uFade.value = cfg.fadeTime;
    u.uGougeFade.value = cfg.gougeFade;
    u.uOpacity.value = cfg.opacity;
    u.uGougeOpacity.value = cfg.gougeOpacity;
    u.uWet.value = wetness;
    if (this.colorKey !== cfg.color) {
      this.colorKey = cfg.color;
      (u.uColor.value as THREE.Color).set(cfg.color);
    }
    if (this.gougeKey !== cfg.gougeColor) {
      this.gougeKey = cfg.gougeColor;
      (u.uGougeColor.value as THREE.Color).set(cfg.gougeColor);
    }
    const life = Math.max(cfg.fadeTime, cfg.gougeFade);
    const alive = this.high > 0 && now - this.lastWrite < life;
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
    for (const s of this.strips) s.active = false;
    this.mesh.visible = this.warm > 0;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
