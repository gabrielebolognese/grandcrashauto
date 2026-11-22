import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../../config';
import { GLSL_ENV_PARS, GLSL_OUTPUT, envUniforms } from './shaders';

/**
 * Big puffy cumulus: ONE InstancedMesh of low-poly smooth puffs (42 verts each), clustered into clouds with flat
 * bottoms. Clouds drift with the wind and wrap around the camera (whole clouds wrap, never single puffs).
 * Clouds farther than the camera's far plane are pulled in radially (same direction & angular size) so the cloud
 * field can extend for kilometres regardless of `camera.far`. Shading: sun wrap lighting, darker lavender bases,
 * silver lining toward the sun, aerial haze. Fly-through: dithered fade near the camera + whiteout fog (Environment).
 */

const VERT = /* glsl */ `
uniform vec2 uDrift;     // wind drift minus floating origin, wrapped (m)
uniform float uGrow;     // puff growth with cloud cover
uniform float uSpread;   // half size of the wrapping field
uniform float uRMax;     // pull-in radius (inside camera.far)
attribute vec4 aCloud;   // cloud centre x, z, base y, cloud height
varying vec3 vN;
varying vec3 vWorld;
varying float vH;
varying float vTrueDist;
void main() {
  vec2 c = aCloud.xy + uDrift;
  vec2 rel = mod(c - cameraPosition.xz + uSpread, 2.0 * uSpread) - uSpread;
  vec2 centre = cameraPosition.xz + rel;
  vec4 lp = instanceMatrix * vec4(position * uGrow, 1.0);
  vec3 wp = vec3(centre.x + lp.x, lp.y, centre.y + lp.z);
  vec3 n = normalize(position);
  float base = aCloud.z;
  if (wp.y < base) {
    wp.y = base + (wp.y - base) * 0.06; // flat cumulus bottoms
    n = normalize(mix(n, vec3(0.0, -1.0, 0.0), 0.75));
  }
  vH = clamp((wp.y - base) / aCloud.w, 0.0, 1.0);
  vec3 cc = vec3(centre.x, base + aCloud.w * 0.35, centre.y);
  float dc = length(cc - cameraPosition);
  vTrueDist = length(wp - cameraPosition);
  float s = dc > uRMax ? uRMax / dc : 1.0;
  wp = cameraPosition + (wp - cameraPosition) * s;
  vN = n;
  vWorld = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
${GLSL_ENV_PARS}
uniform float uCloudHaze;
varying vec3 vN;
varying vec3 vWorld;
varying float vH;
varying float vTrueDist;
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dRender = length(toCam);
  // Dithered fade when the camera flies into a puff.
  if (vTrueDist < 70.0 && envHash12(gl_FragCoord.xy) * 60.0 > vTrueDist - 10.0) discard;
  vec3 V = toCam / dRender;
  vec3 n = normalize(vN);
  vec3 L = uSunDir;
  float wrap = dot(n, L) * 0.5 + 0.5;
  float lit = wrap * mix(0.35, 1.0, smoothstep(0.0, 0.8, vH));
  vec3 col = mix(uCloudShade, uCloudLit, smoothstep(0.15, 0.85, lit));
  // Soft rim light + silver lining when the sun is behind the cloud.
  float rim = pow(1.0 - clamp(abs(dot(n, V)), 0.0, 1.0), 3.0);
  float back = pow(max(dot(-V, L), 0.0), 5.0);
  col += uCloudLit * rim * (0.12 + 1.3 * back);
  col *= 1.4;
  col += vec3(0.7, 0.75, 1.0) * uLightning * 1.8 * (0.4 + vH);
  float haze = 1.0 - exp(-vTrueDist / uCloudHaze);
  col = envHaze(col, -V, haze * 0.92);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

interface CloudInfo {
  x: number;
  z: number;
  base: number;
  height: number;
  radius: number;
  puffs: { x: number; y: number; z: number; r: number }[];
}

export class Clouds {
  readonly mesh: THREE.InstancedMesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private clouds: CloudInfo[] = [];
  private puffEnd: number[] = []; // cumulative instance count after cloud i
  private wind = new THREE.Vector2(); // accumulated drift (absolute)
  private driftU = new THREE.Vector2(); // drift - origin, wrapped (shader + CPU tests)
  private spread: number;

  constructor() {
    const cfg = CONFIG.env.clouds;
    this.spread = cfg.spread;
    const ico = new THREE.IcosahedronGeometry(1, 1);
    ico.deleteAttribute('normal');
    ico.deleteAttribute('uv');
    this.geo = mergeVertices(ico);
    ico.dispose();

    // Deterministic layout (not gameplay-relevant, but keeps screenshots stable).
    let seed = 1234567;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed - 1) / 2147483646;
    };
    const total = cfg.count;
    const mats: THREE.Matrix4[] = [];
    const info: number[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    // Jittered grid so clouds are evenly scattered, never clumped.
    const side = Math.ceil(Math.sqrt(total));
    const cell = (this.spread * 2) / side;
    for (let i = 0; i < total; i++) {
      const gx = i % side;
      const gz = Math.floor(i / side);
      const cx = -this.spread + (gx + 0.15 + rnd() * 0.7) * cell;
      const cz = -this.spread + (gz + 0.15 + rnd() * 0.7) * cell;
      const big = rnd();
      const width = 220 + big * big * 380;
      const base = cfg.altitudeMin + rnd() * (cfg.altitudeMax - cfg.altitudeMin);
      const n = Math.round(cfg.puffsMin + rnd() * (cfg.puffsMax - cfg.puffsMin));
      const ang = rnd() * Math.PI;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const cloud: CloudInfo = { x: cx, z: cz, base, height: width * 0.55, radius: width * 0.65, puffs: [] };
      for (let p = 0; p < n; p++) {
        const t = n === 1 ? 0 : p / (n - 1);
        // Central puffs bigger and higher (towering middle), edges small and low.
        const along = (t - 0.5) * width * 0.85 + (rnd() - 0.5) * width * 0.12;
        const across = (rnd() - 0.5) * width * 0.38;
        const centrality = 1 - Math.abs(t - 0.5) * 2;
        const r = width * (0.13 + 0.15 * centrality + rnd() * 0.07);
        const y = base + r * (0.25 + 0.5 * centrality) + rnd() * width * 0.05;
        const lx = along * ca - across * sa;
        const lz = along * sa + across * ca;
        cloud.puffs.push({ x: lx, y, z: lz, r });
        q.setFromAxisAngle(yAxis, rnd() * Math.PI * 2);
        m.compose(new THREE.Vector3(lx, y, lz), q, new THREE.Vector3(r * (1 + rnd() * 0.25), r * 0.82, r));
        mats.push(m.clone());
        info.push(cx, cz, base, cloud.height);
      }
      this.clouds.push(cloud);
      this.puffEnd.push(mats.length);
    }
    this.mat = new THREE.ShaderMaterial({
      name: 'env.clouds',
      uniforms: {
        ...envUniforms(),
        uDrift: { value: this.driftU },
        uGrow: { value: 1 },
        uSpread: { value: this.spread },
        uRMax: { value: 1300 },
        uCloudHaze: { value: 2600 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, mats.length);
    for (let i = 0; i < mats.length; i++) this.mesh.setMatrixAt(i, mats[i]);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.geo.setAttribute('aCloud', new THREE.InstancedBufferAttribute(new Float32Array(info), 4));
    this.mesh.name = 'env.clouds';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.noOriginShift = true; // follows the camera; origin handled via uDrift
  }

  /** Fraction of the clouds to draw (quality). */
  setAmount(fraction: number): void {
    const k = Math.max(1, Math.round(this.clouds.length * Math.min(1, Math.max(0, fraction))));
    this.mesh.count = this.puffEnd[k - 1];
  }

  get triangleCount(): number {
    return ((this.geo.index?.count ?? 0) / 3) * this.mesh.count;
  }

  /**
   * @param wind world wind (m/s), origin floating-origin offset, cover 0..1 (puffs swell as the sky fills in)
   */
  update(camera: THREE.PerspectiveCamera, dt: number, wind: THREE.Vector3, origin: THREE.Vector3, cover: number): void {
    const cfg = CONFIG.env.clouds;
    const period = this.spread * 2;
    this.wind.x = (this.wind.x + wind.x * cfg.windDrift * dt) % period;
    this.wind.y = (this.wind.y + wind.z * cfg.windDrift * dt) % period;
    const m = (v: number) => ((v % period) + period) % period;
    this.driftU.set(m(this.wind.x - origin.x), m(this.wind.y - origin.z));
    const u = this.mat.uniforms;
    u.uRMax.value = camera.far * 0.9;
    u.uGrow.value = 1 + 0.3 * cover;
    const camH = Math.max(0, camera.position.y);
    u.uCloudHaze.value = 2600 * (1 + camH / 1200);
  }

  /** 0..1 how deep the camera is inside a cloud (for the whiteout fog). */
  insideAmount(cam: THREE.Vector3): number {
    if (!this.mesh.visible) return 0;
    const period = this.spread * 2;
    let best = 0;
    const n = this.puffEnd.findIndex((e) => e >= this.mesh.count) + 1 || this.clouds.length;
    for (let i = 0; i < n; i++) {
      const c = this.clouds[i];
      if (cam.y < c.base - 20 || cam.y > c.base + c.height * 1.3) continue;
      let rx = c.x + this.driftU.x - cam.x;
      let rz = c.z + this.driftU.y - cam.z;
      rx = ((((rx + this.spread) % period) + period) % period) - this.spread;
      rz = ((((rz + this.spread) % period) + period) % period) - this.spread;
      if (rx * rx + rz * rz > c.radius * c.radius) continue;
      // Camera position relative to the wrapped cloud centre.
      const px = -rx, pz = -rz;
      for (const p of c.puffs) {
        const dx = px - p.x, dy = Math.max(cam.y, c.base) - p.y, dz = pz - p.z;
        const d = Math.sqrt(dx * dx + dy * dy * 1.4 + dz * dz) / (p.r * this.mat.uniforms.uGrow.value);
        if (d < 1) best = Math.max(best, 1 - d);
      }
    }
    return Math.min(1, best * 2.5);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
