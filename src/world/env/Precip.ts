import * as THREE from 'three';

/**
 * Rain & snow (SPEC-PART3 §6): one instanced draw of camera-facing streaks living in a box around the camera.
 * Particles are world-anchored (absolute coords incl. the floating origin) and wrap inside the box, so driving
 * through rain looks right; streaks stretch along the velocity relative to the camera (fast driving slants them).
 * Each particle is rain or snow by a per-particle threshold → mixed precipitation around the snow line.
 */

const VERT = /* glsl */ `
attribute vec4 aOff;
uniform vec3 uBox;
uniform vec3 uCamMod;   // absolute camera position mod box (CPU, double precision)
uniform vec3 uWind;
uniform vec3 uCamVel;
uniform float uTime;    // wrapped
uniform float uSnowFrac;
uniform float uStreak;
uniform float uGroundY;  // ground height under the camera (splashes)
uniform float uSplash;   // 0/1
varying float vAlpha;
varying vec2 vUv;
varying float vSnow;
varying float vSplash;
void main() {
  float isSnow = step(fract(aOff.w * 7.31), uSnowFrac);
  float speed = mix(10.0 + aOff.w * 3.5, 1.2 + aOff.w * 0.7, isSnow);
  vec3 vel = vec3(0.0, -speed, 0.0) + uWind * mix(0.85, 0.75, isSnow);
  vec3 p = aOff.xyz * uBox + vel * uTime;
  p.xz += isSnow * vec2(sin(uTime * 1.3 + aOff.w * 40.0), cos(uTime * 1.07 + aOff.w * 31.0)) * 0.7;
  vec3 rel = mod(p - uCamMod, uBox) - 0.5 * uBox;
  vec3 centre = cameraPosition + rel;
  vec3 rv = vel - uCamVel;
  float rl = length(rv);
  vec3 dir = rv / max(rl, 0.001);
  vec3 toCam = normalize(cameraPosition - centre);
  vec3 side = cross(dir, toCam);
  side = length(side) > 1e-3 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float len = clamp(rl * uStreak, 0.35, 4.0);
  float w = 0.028 + 0.016 * aOff.w;
  vec3 wp;
  if (isSnow > 0.5) {
    float s = 0.1 + 0.08 * aOff.w;
    wp = centre + camRight * position.x * s + camUp * position.y * s;
  } else {
    wp = centre + side * position.x * w + dir * position.y * len;
  }
  vec3 e = abs(rel) / (0.5 * uBox);
  float edge = 1.0 - smoothstep(0.7, 1.0, max(max(e.x, e.y), e.z));
  vAlpha = edge * smoothstep(0.4, 1.6, length(rel));
  vUv = position.xy * 2.0;
  vSnow = isSnow;
  vSplash = 0.0;
  // ~20 % of the rain drops are splash rings on the ground around the camera.
  float isSplash = step(0.8, aOff.w) * (1.0 - isSnow) * uSplash;
  if (isSplash > 0.5) {
    float ph = fract(uTime * 1.9 + aOff.w * 37.0);
    float r = 0.05 + ph * 0.3;
    wp = vec3(centre.x, uGroundY + 0.04, centre.z) + vec3(position.x * r * 2.0, 0.0, position.y * r * 2.0);
    float hor = length(rel.xz) / (0.5 * uBox.x);
    vAlpha = (1.0 - smoothstep(0.55, 0.9, hor)) * (1.0 - ph) * (1.0 - smoothstep(6.0, 12.0, abs(cameraPosition.y - uGroundY)));
    vSplash = 1.0;
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform vec3 uRainColor;
uniform vec3 uSnowColor;
uniform float uOpacity;
varying float vAlpha;
varying vec2 vUv;
varying float vSnow;
varying float vSplash;
void main() {
  float a;
  vec3 c;
  if (vSplash > 0.5) {
    float l = length(vUv);
    a = smoothstep(0.55, 0.8, l) * (1.0 - smoothstep(0.85, 1.0, l)) * 1.6;
    c = uRainColor;
  } else if (vSnow > 0.5) {
    a = 1.0 - smoothstep(0.35, 1.0, length(vUv));
    c = uSnowColor;
  } else {
    a = (1.0 - abs(vUv.x)) * (1.0 - smoothstep(0.4, 1.0, abs(vUv.y)));
    c = uRainColor;
  }
  a *= vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Precip {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private max = 0;
  private box = new THREE.Vector3(34, 22, 34);
  private lastCam = new THREE.Vector3();
  private camVel = new THREE.Vector3();
  private hasLast = false;

  constructor(maxCount: number) {
    this.geo = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.max = 0;
    this.setMax(maxCount);
    this.mat = new THREE.ShaderMaterial({
      name: 'env.precip',
      uniforms: {
        uBox: { value: this.box },
        uCamMod: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3() },
        uCamVel: { value: this.camVel },
        uTime: { value: 0 },
        uSnowFrac: { value: 0 },
        uStreak: { value: 0.045 },
        uRainColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
        uSnowColor: { value: new THREE.Color(1, 1, 1) },
        uOpacity: { value: 0.35 },
        uGroundY: { value: -1e4 },
        uSplash: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env.precip';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 5;
    this.mesh.userData.noOriginShift = true;
    this.mesh.visible = false;
    this.mesh.userData.warmup = true; // hidden until needed: pre-compiled behind the loading bar
  }

  setMax(n: number): void {
    n = Math.max(16, Math.round(n));
    if (n === this.max) return;
    this.max = n;
    const off = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      off[i * 4] = Math.random();
      off[i * 4 + 1] = Math.random();
      off[i * 4 + 2] = Math.random();
      off[i * 4 + 3] = Math.random();
    }
    this.geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 4));
    this.geo.instanceCount = 0;
  }

  get triangleCount(): number {
    return this.mesh.visible ? this.geo.instanceCount * 2 : 0;
  }

  /**
   * @param amount 0..1 precipitation, snowFrac 0..1 share of snow, camAbs absolute camera position.
   */
  /** Splash rings on the ground (Medium/High), at this ground height under the camera. */
  setGround(y: number, enabled: boolean): void {
    this.mat.uniforms.uGroundY.value = y;
    this.mat.uniforms.uSplash.value = enabled ? 1 : 0;
  }

  update(realDt: number, time: number, camera: THREE.Camera, camAbs: THREE.Vector3, amount: number, snowFrac: number, wind: THREE.Vector3, rainColor: THREE.Color, snowColor: THREE.Color): void {
    const n = Math.round(this.max * THREE.MathUtils.clamp(amount, 0, 1));
    this.mesh.visible = n > 8;
    // Camera velocity (absolute, so origin shifts don't spike it).
    if (this.hasLast && realDt > 1e-4) {
      const k = 1 - Math.exp(-realDt * 8);
      const vx = (camAbs.x - this.lastCam.x) / realDt, vy = (camAbs.y - this.lastCam.y) / realDt, vz = (camAbs.z - this.lastCam.z) / realDt;
      if (Math.abs(vx) + Math.abs(vy) + Math.abs(vz) < 600) {
        this.camVel.x += (vx - this.camVel.x) * k;
        this.camVel.y += (vy - this.camVel.y) * k;
        this.camVel.z += (vz - this.camVel.z) * k;
      }
    }
    this.lastCam.copy(camAbs);
    this.hasLast = true;
    if (!this.mesh.visible) return;
    this.geo.instanceCount = n;
    const u = this.mat.uniforms;
    const b = this.box;
    const m = (v: number, s: number) => ((v % s) + s) % s;
    u.uCamMod.value.set(m(camAbs.x, b.x), m(camAbs.y, b.y), m(camAbs.z, b.z));
    u.uTime.value = time % 600;
    u.uWind.value.copy(wind);
    u.uSnowFrac.value = snowFrac;
    u.uRainColor.value.copy(rainColor);
    u.uSnowColor.value.copy(snowColor);
    u.uOpacity.value = 0.22 + 0.2 * amount;
    void camera;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
