import * as THREE from 'three';
import { RAMP_ROWS } from './textures';

/**
 * GPU-simulated billboard particles. The CPU writes ONE record per particle at spawn time (spawn params + birth
 * time); the vertex shader evaluates the closed-form motion every frame:
 *   v(t) = a/k + (v0 - a/k)·e^(-kt)          (linear drag k toward terminal velocity a/k = wind + gravity/k)
 *   x(t) = x0 + (a/k)·t + (v0 - a/k)·(1 - e^(-kt))/k
 * so there is zero CPU work per live particle and zero allocations per frame. Each pool is ONE draw call.
 *
 * Record layout (24 floats, interleaved, instanced):
 *   a0 = pos.xyz, birthTime        a1 = vel.xyz, life
 *   a2 = accel.xyz, drag k         a3 = size0, size1, rot0, spin
 *   a4 = tint.rgb, alpha           a5 = packed(cell | ramp<<4 | heat*8<<10), floorY, stretch, turbulence
 * stretch > 0: velocity-stretched (seconds of motion blur), -1: ground-aligned quad, -2: static decal oriented by
 * the normal stored in vel.xyz, 0: camera billboard.
 * Positions are stored in the fx root's local space (local = scene - root.position): core's floating origin shifts
 * the root, so live particles move with the world for free and emit() converts new spawns.
 * Blending is premultiplied (ONE, ONE_MINUS_SRC_ALPHA); the ramp's "additive" param blends each particle anywhere
 * between occluding (alpha) and pure additive, so a fireball stays optically thick while its core glows.
 */

export const STRIDE = 24;

/** Reusable spawn parameters (fill, then pool.emit(s)). */
export class Spawn {
  x = 0;
  y = 0;
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  ax = 0;
  ay = 0;
  az = 0;
  drag = 0;
  life = 1;
  /** Seconds after "now" the particle is born (negative = born in the past: sub-frame emission). */
  delay = 0;
  size0 = 1;
  size1 = 1;
  rot = 0;
  spin = 0;
  r = 1;
  g = 1;
  b = 1;
  a = 1;
  heat = 1;
  cell = 0;
  ramp = 0;
  floor = -1e5;
  stretch = 0;
  turb = 0;

  reset(): this {
    this.x = this.y = this.z = 0;
    this.vx = this.vy = this.vz = 0;
    this.ax = this.ay = this.az = 0;
    this.drag = 0;
    this.life = 1;
    this.delay = 0;
    this.size0 = this.size1 = 1;
    this.rot = this.spin = 0;
    this.r = this.g = this.b = this.a = 1;
    this.heat = 1;
    this.cell = 0;
    this.ramp = 0;
    this.floor = -1e5;
    this.stretch = 0;
    this.turb = 0;
    return this;
  }

  pos(p: { x: number; y: number; z: number }): this {
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    return this;
  }

  /** Drag k toward the wind velocity, plus a vertical acceleration (gravity < 0, buoyancy > 0). */
  air(k: number, wind: { x: number; y: number; z: number }, accelY: number): this {
    this.drag = k;
    this.ax = k * wind.x;
    this.ay = k * wind.y + accelY;
    this.az = k * wind.z;
    return this;
  }

  tint(r: number, g: number, b: number, a = 1): this {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this;
  }
}

const VERT = /* glsl */ `
#define RAMP_ROWS ${RAMP_ROWS.toFixed(1)}
uniform float uFxTime;
uniform float uClear;
uniform sampler2D uRamp;
uniform vec2 uNearFade;
uniform float uMinSize;
attribute vec4 a0;
attribute vec4 a1;
attribute vec4 a2;
attribute vec4 a3;
attribute vec4 a4;
attribute vec4 a5;
varying vec2 vUv;
varying vec2 vCorner;
varying vec4 vColor;
varying vec4 vParams;
varying float vFloor;
#include <fog_pars_vertex>

void main() {
  float age = uFxTime - a0.w;
  if (age < 0.0 || age >= a1.w || a0.w < uClear) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    vUv = vec2(0.0);
    vCorner = vec2(0.0);
    vColor = vec4(0.0);
    vParams = vec4(0.0);
    vFloor = 0.0;
    #ifdef USE_FOG
      vFogDepth = 0.0;
    #endif
    return;
  }
  float t = age / a1.w;
  float k = a2.w;
  vec3 p;
  vec3 v;
  if (k > 0.001) {
    vec3 term = a2.xyz / k;
    float e = exp(-k * age);
    v = term + (a1.xyz - term) * e;
    p = a0.xyz + term * age + (a1.xyz - term) * ((1.0 - e) / k);
  } else {
    v = a1.xyz + a2.xyz * age;
    p = a0.xyz + a1.xyz * age + 0.5 * a2.xyz * age * age;
  }
  if (p.y < a5.y) { p.y = a5.y; v.y = 0.0; }

  float seed = fract(a0.w * 7.31 + a0.x * 0.173 + a0.z * 0.291) * 6.2831;
  float tw = a5.w * min(age, 1.5);
  p += tw * vec3(sin(age * 1.9 + seed), 0.5 * sin(age * 1.3 + seed * 1.7), cos(age * 1.6 + seed * 2.3));

  float packed = a5.x;
  float heatQ = floor(packed / 1024.0 + 0.0001);
  float cr = packed - heatQ * 1024.0;
  float ramp = floor(cr / 16.0 + 0.0001);
  float cell = cr - ramp * 16.0;

  float te = 1.0 - (1.0 - t) * (1.0 - t);
  float size = mix(a3.x, a3.y, te);
  float rot = a3.z + a3.w * age;
  // never thinner than ~2 px on screen (tiny sparks/embers would shimmer away under mip filtering)
  float centerDepth = max(0.1, -(modelViewMatrix * vec4(p, 1.0)).z);
  size = max(size, centerDepth * uMinSize * (a5.z > 0.0 ? 1.5 : 1.0));

  vec2 corner = position.xy;
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camBack = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float stretch = a5.z;
  vec3 wp;
  vec2 cdir;
  vFloor = 1.0;
  if (stretch > 0.0) {
    vec3 vp = v - camBack * dot(v, camBack);
    float sp = length(vp);
    vec3 ay = sp > 0.0001 ? -vp / sp : camUp;
    vec3 ax = normalize(cross(ay, camBack));
    float len = size + sp * stretch;
    wp = p + ax * (corner.x * size) + ay * (corner.y * len);
    cdir = corner * 2.0;
  } else if (stretch < -1.5) {
    // static decal oriented by the normal stored in the velocity slot (facade scorch, slicks on slopes)
    p = a0.xyz;
    vec3 nn = normalize(a1.xyz + vec3(0.0, 1e-5, 0.0));
    vec3 tt = abs(nn.y) < 0.98 ? normalize(cross(vec3(0.0, 1.0, 0.0), nn)) : vec3(1.0, 0.0, 0.0);
    vec3 bb = cross(nn, tt);
    float c = cos(rot);
    float s = sin(rot);
    vec2 q = corner * size;
    wp = p + tt * (q.x * c - q.y * s) + bb * (q.x * s + q.y * c);
    cdir = vec2(0.0);
  } else if (stretch < 0.0) {
    float c = cos(rot);
    float s = sin(rot);
    vec2 q = corner * size;
    wp = p + vec3(q.x * c - q.y * s, 0.0, q.x * s + q.y * c);
    cdir = vec2(0.0);
  } else {
    float c = cos(rot);
    float s = sin(rot);
    vec2 q = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    wp = p + (camRight * q.x + camUp * q.y) * size;
    cdir = q * 2.0;
  }
  float nearA = 1.0;
  if (stretch >= 0.0) {
    // only sprites right in front of the lens fade (fill-rate); big fireball puffs near the camera stay visible
    float depth = centerDepth - min(size * 0.25, 1.2);
    nearA = clamp((depth - uNearFade.x) / (uNearFade.y - uNearFade.x), 0.0, 1.0);
    vFloor = (wp.y - a5.y) / max(size * 0.28, 0.04);
  }
  // data lives in the fx root's space (core shifts the root on floating-origin moves; it only translates)
  vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  vec2 uvq = corner + 0.5;
  float col = mod(cell, 4.0);
  float row = floor(cell / 4.0 + 0.0001);
  vUv = vec2((col + uvq.x) * 0.25, (row + 1.0 - uvq.y) * 0.25);
  vCorner = cdir;

  float ru = t * (127.0 / 128.0) + 0.5 / 128.0;
  vec4 rc = texture2D(uRamp, vec2(ru, (ramp * 2.0 + 0.5) / RAMP_ROWS));
  vec4 rp = texture2D(uRamp, vec2(ru, (ramp * 2.0 + 1.5) / RAMP_ROWS));
  vColor = vec4(rc.rgb * rc.rgb * a4.rgb, rc.a * a4.a * nearA);
  vParams = vec4(rp.rgb, heatQ * 0.125);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform float uDim;
varying vec2 vUv;
varying vec2 vCorner;
varying vec4 vColor;
varying vec4 vParams;
varying float vFloor;
#include <fog_pars_fragment>

void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float a = tex.a * vColor.a * clamp(vFloor, 0.0, 1.0);
  if (a < 0.003) discard;
  float r2 = dot(vCorner, vCorner);
  vec3 n = vec3(vCorner, sqrt(max(0.0, 1.0 - r2)));
  float ndl = dot(n, uSunView) * 0.5 + 0.5;
  float shade = mix(tex.r, ndl * (0.55 + 0.6 * tex.r), vParams.z);
  vec3 lit = vColor.rgb * mix(uAmbient, uSunColor, clamp(shade, 0.0, 1.2)) * uDim;
  // emissive: hot where the puff is dense, darker & redder toward its soft rim (optically thick, not a white sum)
  float dense = max(smoothstep(0.1, 0.85, tex.a), vParams.y);
  vec3 emi = vColor.rgb * vParams.w * (0.35 + 0.9 * tex.r) * mix(vec3(0.5, 0.28, 0.2), vec3(1.0), dense);
  vec3 rgb = mix(lit, emi, vParams.x);
  float add = vParams.y;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    rgb = mix(rgb, fogColor * (1.0 - add), fogFactor);
  #endif
  gl_FragColor = vec4(rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - add));
}
`;

export interface FxSharedUniforms {
  uFxTime: { value: number };
  uClear: { value: number };
  uRamp: { value: THREE.Texture };
  uAtlas: { value: THREE.Texture };
  uNearFade: { value: THREE.Vector2 };
  /** View-space size of ~2 px per metre of depth (set per frame from the camera fov / viewport height). */
  uMinSize: { value: number };
  uSunView: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
  uDim: { value: number };
}

export function createParticleMaterial(u: FxSharedUniforms, polygonOffset = false): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    name: 'fx-particles',
    uniforms: { ...(u as unknown as Record<string, THREE.IUniform>), ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    fog: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  if (polygonOffset) {
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -4;
  }
  return mat;
}

let sharedQuad: { pos: THREE.BufferAttribute; index: THREE.BufferAttribute } | null = null;
function quad() {
  if (!sharedQuad) {
    sharedQuad = {
      pos: new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3),
      index: new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1),
    };
  }
  return sharedQuad;
}

export class ParticlePool {
  readonly mesh: THREE.Mesh;
  capacity = 0;
  private geo: THREE.InstancedBufferGeometry;
  private buf!: THREE.InstancedInterleavedBuffer;
  private data!: Float32Array;
  private head = 0;
  private high = 0;
  private lastDeath = -1;
  private spawned = 0;
  // pending (not yet uploaded) dirty slot ranges
  private dLo = 1;
  private dHi = 0;
  private eLo = 1;
  private eHi = 0;
  private readonly r0 = { start: 0, count: 0 };
  private readonly r1 = { start: 0, count: 0 };
  private warm = 0;

  constructor(
    readonly name: string,
    capacity: number,
    material: THREE.Material,
    renderOrder: number,
    private readonly root: THREE.Object3D,
  ) {
    this.geo = this.build(capacity);
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.name = 'fx-' + name;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  private build(capacity: number): THREE.InstancedBufferGeometry {
    this.capacity = Math.max(16, Math.floor(capacity));
    this.data = new Float32Array(this.capacity * STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.buf.onUpload(() => {
      this.dLo = this.eLo = 1;
      this.dHi = this.eHi = 0;
    });
    const g = new THREE.InstancedBufferGeometry();
    const q = quad();
    g.setAttribute('position', q.pos);
    g.setIndex(q.index);
    for (let i = 0; i < 6; i++) g.setAttribute('a' + i, new THREE.InterleavedBufferAttribute(this.buf, 4, i * 4));
    g.instanceCount = 0;
    this.head = 0;
    this.high = 0;
    this.lastDeath = -1;
    this.dLo = this.eLo = 1;
    this.dHi = this.eHi = 0;
    return g;
  }

  /** Reallocate with a new capacity (quality change). Drops live particles. */
  resize(capacity: number): void {
    if (Math.max(16, Math.floor(capacity)) === this.capacity) return;
    const old = this.geo;
    this.geo = this.build(capacity);
    this.mesh.geometry = this.geo;
    old.dispose();
  }

  /** Keep the mesh drawn for a few frames (with no live particles) so its program/buffers get created during boot. */
  warmup(frames: number): void {
    this.warm = frames;
  }

  get liveEstimate(): number {
    return this.high;
  }

  get totalSpawned(): number {
    return this.spawned;
  }

  emit(s: Spawn, now: number): void {
    const i = this.head;
    this.head = i + 1 >= this.capacity ? 0 : i + 1;
    if (i + 1 > this.high) this.high = i + 1;
    const o = i * STRIDE;
    const d = this.data;
    const t0 = now + s.delay;
    const rp = this.root.position;
    d[o] = s.x - rp.x;
    d[o + 1] = s.y - rp.y;
    d[o + 2] = s.z - rp.z;
    d[o + 3] = t0;
    d[o + 4] = s.vx;
    d[o + 5] = s.vy;
    d[o + 6] = s.vz;
    d[o + 7] = s.life;
    d[o + 8] = s.ax;
    d[o + 9] = s.ay;
    d[o + 10] = s.az;
    d[o + 11] = s.drag;
    d[o + 12] = s.size0;
    d[o + 13] = s.size1;
    d[o + 14] = s.rot;
    d[o + 15] = s.spin;
    d[o + 16] = s.r;
    d[o + 17] = s.g;
    d[o + 18] = s.b;
    d[o + 19] = s.a;
    const heatQ = Math.round(Math.min(2000, Math.max(0, s.heat)) * 8);
    d[o + 20] = (s.cell & 15) + 16 * (s.ramp & 63) + 1024 * heatQ;
    d[o + 21] = s.floor - rp.y;
    d[o + 22] = s.stretch;
    d[o + 23] = s.turb;
    const death = t0 + s.life;
    if (death > this.lastDeath) this.lastDeath = death;
    this.spawned++;
    this.markDirty(i);
  }

  private markDirty(i: number): void {
    if (this.dLo > this.dHi) {
      this.dLo = this.dHi = i;
      return;
    }
    if (i >= this.dLo && i <= this.dHi) return;
    if (i === this.dHi + 1) {
      this.dHi = i;
      return;
    }
    if (i === this.dLo - 1) {
      this.dLo = i;
      return;
    }
    if (this.eLo > this.eHi) {
      this.eLo = this.eHi = i;
      return;
    }
    if (i >= this.eLo && i <= this.eHi) return;
    if (i === this.eHi + 1) {
      this.eHi = i;
      return;
    }
    if (i === this.eLo - 1) {
      this.eLo = i;
      return;
    }
    this.dLo = Math.min(this.dLo, this.eLo, i);
    this.dHi = Math.max(this.dHi, this.eHi, i);
    this.eLo = 1;
    this.eHi = 0;
  }

  /** Per frame: visibility (0 draw calls when empty) + upload of the dirty ranges. */
  update(now: number): void {
    const alive = now <= this.lastDeath;
    if (!alive && this.high > 0 && this.dLo > this.dHi) {
      // Everything is dead: restart from slot 0 so the instance count (vertex work) stays small.
      this.head = 0;
      this.high = 0;
    }
    if (this.warm > 0) {
      this.warm--;
      this.mesh.visible = true;
      this.geo.instanceCount = Math.max(1, this.high);
    } else {
      this.mesh.visible = alive;
      this.geo.instanceCount = this.high;
    }
    if (this.dLo <= this.dHi) {
      const ranges = this.buf.updateRanges;
      ranges.length = 0;
      this.r0.start = this.dLo * STRIDE;
      this.r0.count = (this.dHi - this.dLo + 1) * STRIDE;
      ranges.push(this.r0);
      if (this.eLo <= this.eHi) {
        this.r1.start = this.eLo * STRIDE;
        this.r1.count = (this.eHi - this.eLo + 1) * STRIDE;
        ranges.push(this.r1);
      }
      this.buf.needsUpdate = true;
    }
  }

  /** Instantly kill everything (shader side is handled by the shared uClear uniform). */
  clear(): void {
    this.lastDeath = -1;
    this.mesh.visible = this.warm > 0;
  }

  dispose(): void {
    this.geo.dispose();
  }
}
