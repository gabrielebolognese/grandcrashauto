import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLSL_ENV_PARS, GLSL_OUTPUT, envUniforms } from './shaders';
import { makeWaterTexture } from './textures';

/**
 * Ocean: camera-following polar grid (dense under the camera, geometric ring growth → huge radius for few vertices),
 * Gerstner waves in the vertex shader, per-pixel analytic wave normals + scrolling ripple texture, fresnel sky
 * reflection, sun/moon glitter, depth-tinted body colour (turquoise shallows → deep blue), transparent shallows over
 * the sand, animated shoreline foam, aerial haze to the horizon. One draw call.
 *
 * Seabed depth comes from a low-res depth field baked progressively from `world.groundHeightAt` (works for any
 * coastline shape: city beach now, whole island later). Until it's ready (or if the world gives no seabed) an
 * analytic fallback is used: shore line at `coast.shoreZ`, land = the city square.
 */

const MAX_WAVES = 8;
const DEPTH_MIN = -4;
const DEPTH_MAX = 16;

// [travel direction (deg, 180 = toward -Z / the shore), wavelength m, amplitude m, choppiness]
const WAVES: [number, number, number, number][] = [
  [172, 46, 0.26, 1.1],
  [203, 31, 0.17, 1.2],
  [143, 19.5, 0.1, 1.2],
  [228, 11.5, 0.055, 1.1],
  [158, 6.8, 0.032, 1.0],
  [196, 4.1, 0.018, 0.9],
  [125, 2.6, 0.011, 0.8],
];

const GLSL_SEABED = /* glsl */ `
uniform sampler2D uSeabed;
uniform vec4 uSeabedBounds; // minX, minZ, 1/sizeX, 1/sizeZ
uniform vec4 uShore;        // shoreZ, slope, cityHalf, seabedValid
float seabedDepth(vec2 xz) {
  float o = max(abs(xz.x) - uShore.z, -xz.y - uShore.z);
  float d = max(xz.y - uShore.x, o) * uShore.y;
  if (uShore.w > 0.5) {
    vec2 uv = (xz - uSeabedBounds.xy) * uSeabedBounds.zw;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      d = textureLod(uSeabed, uv, 0.0).r * ${(DEPTH_MAX - DEPTH_MIN).toFixed(1)} + ${DEPTH_MIN.toFixed(1)};
    }
  }
  return d;
}
`;

const VERT = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES]; // dir.x, dir.z, k, amplitude
uniform vec4 uWaveB[MAX_WAVES]; // choppiness, -, phase, -
uniform int uVertWaves;
uniform vec2 uGrid;   // inner spacing, growth per metre
uniform float uAmpNorm;
${GLSL_SEABED}
varying vec3 vWorld;
varying float vHeight;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 xz = wp.xz;
  float depth = seabedDepth(xz);
  float shoreAtt = clamp(depth / 4.0, 0.18, 1.0);
  float spacing = uGrid.x + uGrid.y * length(position.xz);
  vec3 disp = vec3(0.0);
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uVertWaves) break;
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float lambda = 6.2831853 / a.z;
    float fade = 1.0 - smoothstep(lambda * 0.16, lambda * 0.38, spacing);
    float f = a.z * dot(a.xy, xz) + b.z;
    float amp = a.w * fade;
    disp.y += amp * sin(f);
    disp.xz += a.xy * (b.x * amp * cos(f));
  }
  disp *= shoreAtt;
  wp.xyz += disp;
  vHeight = disp.y * uAmpNorm;
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
${GLSL_ENV_PARS}
${GLSL_SEABED}
uniform vec4 uWaveA[MAX_WAVES];
uniform vec4 uWaveB[MAX_WAVES];
uniform int uFragWaves;
uniform sampler2D uDetail;
uniform vec4 uScroll;     // detail map offsets (xy, zw)
uniform vec4 uScroll2;    // foam offset xy, foam phase, detail sample count
uniform vec3 uWaterDeep;
uniform vec3 uWaterMid;
uniform vec3 uWaterShallow;
uniform vec4 uDepthParams; // shallowDepth, deepDepth, clearDepth, foamWidth
uniform vec4 uOcean;       // hazeDist, fadeStart, fadeEnd, glitter
varying vec3 vWorld;
varying float vHeight;

void main() {
  vec2 xz = vWorld.xz;
  // Derivatives first (uniform control flow), explicit-gradient texture fetches after the discard.
  vec2 dX = dFdx(xz);
  vec2 dY = dFdy(xz);
  float fp = length(abs(dX) + abs(dY)); // pixel footprint in metres
  float depth = seabedDepth(xz);
  if (depth < -0.3) discard; // under land
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // Analytic wave slopes, faded once a wave gets smaller than a few pixels (no shimmer).
  vec2 g = vec2(0.0);
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uFragWaves) break;
    vec4 a = uWaveA[i];
    float lambda = 6.2831853 / a.z;
    float fade = 1.0 - smoothstep(lambda * 0.2, lambda * 0.55, fp);
    float f = a.z * dot(a.xy, xz) + uWaveB[i].z;
    g += a.xy * (a.z * a.w * cos(f) * fade);
  }
  // Groups of waves: slow amplitude modulation kills the regular "corduroy" look at grazing angles.
  float grp = textureGrad(uDetail, xz * 0.0063 + uScroll.zw * 0.05, dX * 0.0063, dY * 0.0063).a;
  g *= clamp(depth / 4.0, 0.25, 1.0) * (0.45 + 1.1 * grp);

  // Ripple detail (tileable texture, two scales scrolling in different directions).
  vec4 t1 = textureGrad(uDetail, xz * 0.085 + uScroll.xy, dX * 0.085, dY * 0.085);
  vec2 rip = t1.xy * 2.0 - 1.0;
  if (uScroll2.w > 1.5) {
    vec2 r2 = textureGrad(uDetail, vec2(xz.y, -xz.x) * 0.031 + uScroll.zw, vec2(dX.y, -dX.x) * 0.031, vec2(dY.y, -dY.x) * 0.031).xy * 2.0 - 1.0;
    rip = rip * 0.55 + r2 * 0.75;
  }
  float far = smoothstep(30.0, 900.0, dist);
  g += rip * mix(0.2, 0.09, far);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  // Large-scale blotches break up tiling when seen from far / high.
  float blotch = textureGrad(uDetail, xz * 0.0021 + uScroll2.xy * 0.1, dX * 0.0021, dY * 0.0021).a;

  vec3 L = uSunDir;
  vec3 R = reflect(-V, N);
  vec3 refl = skyColor(normalize(vec3(R.x, abs(R.y) + 0.1, R.z)));
  float NdV = clamp(dot(N, V), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // Body colour by depth.
  float sh = 1.0 - smoothstep(0.0, uDepthParams.x, depth);
  float dp = smoothstep(uDepthParams.x, uDepthParams.y, depth);
  vec3 body = mix(uWaterMid, uWaterDeep, dp);
  body = mix(body, uWaterShallow, sh);
  body *= 0.9 + 0.2 * blotch;
  vec3 irr = uAmbient + uSunLight * (0.2 + 0.8 * max(L.y, 0.0)) * 0.55;
  vec3 col = body * irr * 0.42;
  // Light scattering through wave crests (looking toward the sun).
  float sss = clamp(vHeight * 1.4 + 0.15, 0.0, 1.0) * pow(clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  col += uWaterShallow * uSunLight * sss * 0.05;

  col = mix(col, refl, fres * 0.82);

  // Sun (or moon) glitter: sharp up close, a broad sheen far away / from altitude.
  vec3 Hh = normalize(L + V);
  float NdH = max(dot(N, Hh), 0.0);
  float rough = clamp(fp * 0.06, 0.0, 1.0);
  float shin = mix(1600.0, 140.0, sqrt(rough));
  float spec = pow(NdH, shin) * (shin + 8.0) * 0.0398;
  float sunUp = smoothstep(-0.02, 0.06, L.y);
  col += uSunLight * spec * (0.06 + 0.94 * fres) * uOcean.w * sunUp * 1.6;

  // Shoreline foam: band at the waterline that laps with the waves + swash lines rolling in.
  vec4 fz = textureGrad(uDetail, xz * 0.04 + uScroll2.xy, dX * 0.04, dY * 0.04);
  float fn = fz.b;
  float dEff = depth - vHeight * 0.35;
  float band = 1.0 - smoothstep(0.0, uDepthParams.w, dEff);
  // Swash lines roll toward the beach (phase grows → constant-phase depth shrinks).
  float swash = sin(dEff * 13.0 + uScroll2.z + fn * 2.2) * 0.5 + 0.5;
  float lines = smoothstep(0.86, 0.985, swash) * smoothstep(0.02, 0.15, depth) * (1.0 - smoothstep(0.35, 0.8, depth));
  float foam = band * smoothstep(0.12, 0.45, fn + band * 0.45) + lines * smoothstep(0.3, 0.6, fn) * 0.9;
  foam = max(foam, smoothstep(0.62, 0.95, vHeight) * smoothstep(0.62, 0.82, fn) * 0.5 * (1.0 - far));
  foam = clamp(foam, 0.0, 1.0) * step(0.0, depth + 0.3);
  vec3 foamCol = (uAmbient * 0.9 + uSunLight * max(L.y, 0.15)) * 0.3183 * 0.92;
  col = mix(col, foamCol, foam * 0.92);

  // Transparent shallows (see the sand), opaque further out and at grazing angles.
  float alpha = smoothstep(0.0, uDepthParams.z, depth);
  alpha = max(alpha, min(1.0, fres * 1.4));
  alpha = max(alpha, foam);

  // Haze to the horizon colour (seamless with the sky at the horizon).
  float haze = 1.0 - exp(-dist / uOcean.x);
  haze = max(haze, smoothstep(uOcean.y, uOcean.z, dist));
  col = envHaze(col, -V, haze);
  alpha = mix(alpha, 1.0, haze);

  gl_FragColor = vec4(col, alpha);
  ${GLSL_OUTPUT}
}
`;

interface CoastInfo {
  shoreZ: number;
  cityHalf: number;
}

/** Progressive bake of water depth (waterLevel - ground height) into a small R8 texture. */
class SeabedField {
  readonly texture: THREE.DataTexture;
  readonly bounds = new THREE.Vector4(0, 0, 1, 1);
  valid = false;
  private data: Uint8Array;
  private w: number;
  private h: number;
  private minX = 0;
  private minZ = 0;
  private sx = 1;
  private sz = 1;
  private next = 0;
  private flat = 0;
  private hasDeep = false;
  private hasLand = false;
  private sampler: ((x: number, z: number) => number) | null = null;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h);
    this.texture = new THREE.DataTexture(this.data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.name = 'env.seabed';
  }

  get busy(): boolean {
    return this.sampler !== null;
  }

  begin(sampler: (x: number, z: number) => number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.sampler = sampler;
    this.minX = minX;
    this.minZ = minZ;
    this.sx = (maxX - minX) / this.w;
    this.sz = (maxZ - minZ) / this.h;
    this.next = 0;
    this.flat = 0;
    this.hasDeep = false;
    this.hasLand = false;
  }

  /** Bake for up to `budgetMs`; returns true when finished this call. */
  step(budgetMs: number): boolean {
    const fn = this.sampler;
    if (!fn) return false;
    const t0 = performance.now();
    const wl = CONFIG.world.waterLevel;
    const total = this.w * this.h;
    const range = DEPTH_MAX - DEPTH_MIN;
    while (this.next < total) {
      const end = Math.min(total, this.next + 256);
      for (let i = this.next; i < end; i++) {
        const ix = i % this.w;
        const iz = (i / this.w) | 0;
        const x = this.minX + (ix + 0.5) * this.sx;
        const z = this.minZ + (iz + 0.5) * this.sz;
        let gh = fn(x, z);
        if (!Number.isFinite(gh)) gh = wl - DEPTH_MAX;
        const d = wl - gh;
        if (Math.abs(d) < 1e-4) this.flat++;
        if (d > 2) this.hasDeep = true;
        if (d < -0.5) this.hasLand = true;
        this.data[i] = Math.round(Math.min(1, Math.max(0, (d - DEPTH_MIN) / range)) * 255);
      }
      this.next = end;
      if (performance.now() - t0 > budgetMs) return false;
    }
    this.sampler = null;
    // A world that returns exactly the water level over big areas has no seabed model → keep the analytic fallback.
    this.valid = this.hasDeep && this.hasLand && this.flat < total * 0.25;
    if (this.valid) {
      this.bounds.set(this.minX, this.minZ, 1 / (this.sx * this.w), 1 / (this.sz * this.h));
      this.texture.needsUpdate = true;
    }
    return true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

export class Ocean {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;
  private detailTex: THREE.DataTexture;
  private seabed: SeabedField;
  private detail = -1;
  private radius = 0;
  private gridS0 = 1;
  private vertWaves = 4;
  private fragWaves = 6;
  private omegas: number[] = [];
  private coast: CoastInfo = { shoreZ: 360, cityHalf: CONFIG.world.size / 2 };

  constructor(anisotropy: number) {
    this.detailTex = makeWaterTexture(256);
    this.detailTex.anisotropy = anisotropy;
    this.seabed = new SeabedField(1, 1);
    const waveA: THREE.Vector4[] = [];
    const waveB: THREE.Vector4[] = [];
    for (let i = 0; i < MAX_WAVES; i++) {
      waveA.push(new THREE.Vector4());
      waveB.push(new THREE.Vector4());
    }
    this.material = new THREE.ShaderMaterial({
      name: 'env.ocean',
      uniforms: {
        ...envUniforms(),
        uWaveA: { value: waveA },
        uWaveB: { value: waveB },
        uVertWaves: { value: 4 },
        uFragWaves: { value: 6 },
        uGrid: { value: new THREE.Vector2(1, 0.05) },
        uAmpNorm: { value: 1 },
        uSeabed: { value: this.seabed.texture },
        uSeabedBounds: { value: this.seabed.bounds },
        uShore: { value: new THREE.Vector4(360, 0.045, 400, 0) },
        uDetail: { value: this.detailTex },
        uScroll: { value: new THREE.Vector4() },
        uScroll2: { value: new THREE.Vector4(0, 0, 0, 2) },
        uWaterDeep: { value: new THREE.Color() },
        uWaterMid: { value: new THREE.Color() },
        uWaterShallow: { value: new THREE.Color() },
        uDepthParams: { value: new THREE.Vector4(2.5, 14, 1.4, 0.55) },
        uOcean: { value: new THREE.Vector4(650, 1000, 1400, 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: true,
      fog: false,
    });
    this.geometry = new THREE.BufferGeometry();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'env.ocean';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10; // first among transparents (particles over the sea draw after it)
    this.mesh.matrixAutoUpdate = false;
  }

  /** 0 = low, 1 = medium, 2 = high. Rebuilds the grid; no shader recompiles. */
  setDetail(level: number, radius: number): void {
    level = Math.max(0, Math.min(2, Math.round(level)));
    radius = Math.max(600, radius);
    if (level === this.detail && Math.abs(radius - this.radius) < this.radius * 0.05) return;
    this.detail = level;
    this.radius = radius;
    const segs = [56, 96, 144][level];
    const s0 = [2.6, 1.5, 0.95][level];
    const growth = [1.13, 1.075, 1.055][level];
    this.gridS0 = s0;
    this.vertWaves = [3, 4, 5][level];
    this.fragWaves = [4, 6, 7][level];
    const u = this.material.uniforms;
    u.uGrid.value.set(s0, growth - 1);
    u.uVertWaves.value = this.vertWaves;
    u.uFragWaves.value = this.fragWaves;
    u.uScroll2.value.w = level === 0 ? 1 : 2;

    const radii = [0];
    let r = 0;
    let s = s0;
    while (r < radius) {
      r = Math.min(radius, r + s);
      radii.push(r);
      s = Math.min(s * growth, 400);
    }
    const rings = radii.length - 1;
    const pos = new Float32Array((1 + rings * segs) * 3);
    let p = 3; // vertex 0 = centre
    for (let i = 1; i <= rings; i++) {
      const rr = radii[i];
      const off = (i % 2) * 0.5; // stagger rings → nicer triangles
      for (let j = 0; j < segs; j++) {
        const a = ((j + off) / segs) * Math.PI * 2;
        pos[p++] = Math.cos(a) * rr;
        pos[p++] = 0;
        pos[p++] = Math.sin(a) * rr;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
    for (let i = 1; i < rings; i++) {
      const a0 = 1 + (i - 1) * segs;
      const b0 = 1 + i * segs;
      for (let j = 0; j < segs; j++) {
        const j1 = (j + 1) % segs;
        const a = a0 + j, b = a0 + j1, c = b0 + j, d = b0 + j1;
        if (i % 2 === 1) idx.push(a, b, d, a, d, c);
        else idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    this.geometry.dispose();
    this.geometry = geo;
    this.mesh.geometry = geo;
    this.applyWaves();
  }

  get triangleCount(): number {
    return (this.geometry.index?.count ?? 0) / 3;
  }

  private applyWaves(): void {
    const u = this.material.uniforms;
    const A = u.uWaveA.value as THREE.Vector4[];
    const B = u.uWaveB.value as THREE.Vector4[];
    const scale = CONFIG.env.ocean.waveScale;
    let ampSum = 0;
    this.omegas.length = 0;
    for (let i = 0; i < MAX_WAVES; i++) {
      const w = WAVES[i];
      if (!w) {
        A[i].set(0, 0, 1, 0);
        B[i].set(0, 0, 0, 0);
        this.omegas.push(0);
        continue;
      }
      const [deg, lambda, amp, chop] = w;
      const a = (deg * Math.PI) / 180;
      const k = (Math.PI * 2) / lambda;
      A[i].set(Math.sin(a), Math.cos(a), k, amp * scale);
      // Choppiness bounded so crests never loop over.
      const q = Math.min(chop, 0.9 / (k * amp * scale * WAVES.length + 1e-6));
      B[i].set(q, 0, 0, 0);
      this.omegas.push(Math.sqrt(9.81 * k));
      if (i < this.vertWaves) ampSum += amp * scale;
    }
    u.uAmpNorm.value = 1 / Math.max(0.05, ampSum * 0.75);
  }

  setCoast(shoreZ: number, cityHalf: number): void {
    this.coast.shoreZ = shoreZ;
    this.coast.cityHalf = cityHalf;
  }

  /** Start baking the seabed depth field from a ground-height sampler over the given bounds (keeps the old one meanwhile). */
  bakeSeabed(sampler: (x: number, z: number) => number, minX: number, minZ: number, maxX: number, maxZ: number, texel: number): void {
    const w = Math.max(16, Math.min(1024, Math.round((maxX - minX) / texel)));
    const h = Math.max(16, Math.min(1024, Math.round((maxZ - minZ) / texel)));
    this.baking?.dispose();
    this.baking = new SeabedField(w, h);
    this.baking.begin(sampler, minX, minZ, maxX, maxZ);
  }

  private baking: SeabedField | null = null;

  /** null while baking, then whether the world provided a usable seabed. */
  get seabedState(): 'baking' | 'baked' | 'analytic' {
    return this.baking ? 'baking' : this.seabed.valid ? 'baked' : 'analytic';
  }

  update(camera: THREE.PerspectiveCamera, time: number, bakeBudgetMs: number): void {
    const cfg = CONFIG.env.ocean;
    const u = this.material.uniforms;
    // Seabed bake (progressive, time-budgeted).
    if (this.baking && this.baking.step(bakeBudgetMs)) {
      const done = this.baking;
      this.baking = null;
      if (done.valid) {
        this.seabed.dispose();
        this.seabed = done;
        u.uSeabed.value = done.texture;
        u.uSeabedBounds.value = done.bounds;
      } else {
        done.dispose(); // the world has no seabed model: keep the analytic shore
      }
    }
    u.uShore.value.set(this.coast.shoreZ, cfg.shoreSlope, this.coast.cityHalf, this.seabed.valid ? 1 : 0);

    // Follow the camera, snapped to the inner grid spacing (less vertex swimming).
    const snap = this.gridS0 * 2;
    this.mesh.position.set(Math.round(camera.position.x / snap) * snap, CONFIG.world.waterLevel, Math.round(camera.position.z / snap) * snap);
    this.mesh.updateMatrix();

    // Wave phases computed in double precision on the CPU (no float precision loss after hours of play).
    const B = u.uWaveB.value as THREE.Vector4[];
    const t = time * cfg.waveSpeed;
    const TAU = Math.PI * 2;
    for (let i = 0; i < this.omegas.length; i++) B[i].z = -((this.omegas[i] * t) % TAU);
    const sc = u.uScroll.value as THREE.Vector4;
    sc.set((t * 0.011) % 1, (-t * 0.019) % 1, (-t * 0.007) % 1, (-t * 0.0105) % 1);
    const s2 = u.uScroll2.value as THREE.Vector4;
    s2.x = (t * 0.004) % 1;
    s2.y = (-t * 0.009) % 1;
    s2.z = (t * 1.5) % TAU;

    u.uDepthParams.value.set(cfg.shallowDepth, cfg.deepDepth, cfg.clearDepth, cfg.foamWidth);
    const camH = Math.max(0, camera.position.y - CONFIG.world.waterLevel);
    const R = this.radius;
    const fadeEnd = Math.min(R * 0.97, camera.far * 0.97);
    u.uOcean.value.set(cfg.hazeDist * (1 + camH / 250), fadeEnd * 0.6, fadeEnd, cfg.glitter);
  }

  setColors(deep: THREE.Color, mid: THREE.Color, shallow: THREE.Color): void {
    const u = this.material.uniforms;
    u.uWaterDeep.value.copy(deep);
    u.uWaterMid.value.copy(mid);
    u.uWaterShallow.value.copy(shallow);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.detailTex.dispose();
    this.seabed.dispose();
    this.baking?.dispose();
  }
}
