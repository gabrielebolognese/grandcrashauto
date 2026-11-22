import * as THREE from 'three';

/**
 * Full-screen overlay drawn last (clip-space quad, one draw, only visible when needed):
 *  - raindrops on the lens/windshield in hood / cockpit views (procedural beads that appear, sit and slide),
 *  - lightning screen flash,
 *  - Low-quality snow (scrolling flake layers instead of particles),
 *  - fog/rain veil darkening is NOT here (fog does it).
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uDrops;
uniform float uFlash;
uniform float uSnow;
uniform float uAspect;
uniform vec3 uLight;
varying vec2 vUv;

float h21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// One layer of beads: returns coverage (x), highlight (y), rim (z).
vec3 beads(vec2 uv, vec2 grid, float t, float seed) {
  vec2 cell = uv * grid;
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.5;
  float r = h21(id + seed);
  float r2 = h21(id + seed + 7.7);
  float life = fract(t * (0.12 + 0.22 * r2) + r);
  float exist = step(0.42, r) * smoothstep(0.0, 0.06, life) * (1.0 - smoothstep(0.75, 1.0, life));
  vec2 c = (vec2(h21(id + seed + 1.3), h21(id + seed + 2.9)) - 0.5) * 0.55;
  float slide = step(0.78, r2);
  c.y += slide * (0.25 - life * 1.4);
  vec2 d = f - c;
  d.x *= grid.y / grid.x * uAspect;
  d.y *= 1.0 + slide * 0.6;
  float rad = 0.16 + 0.14 * r2;
  float dist = length(d);
  float m = (1.0 - smoothstep(rad * 0.75, rad, dist)) * exist;
  float hl = (1.0 - smoothstep(0.0, rad * 0.45, length(d - vec2(-0.3, 0.35) * rad))) * m;
  float rim = smoothstep(rad * 0.45, rad * 0.95, dist) * m;
  return vec3(m, hl, rim);
}

void main() {
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (uDrops > 0.001) {
    vec3 b1 = beads(vUv, vec2(11.0, 6.0), uTime, 0.0);
    vec3 b2 = beads(vUv * 1.7 + 0.31, vec2(15.0, 8.0), uTime * 1.3, 17.0);
    vec3 b = max(b1, b2 * 0.85);
    // Beads: darker rim, bright speck, faint body.
    col = mix(uLight * 0.25, uLight * 1.6, b.y);
    a = (b.x * 0.16 + b.z * 0.28 + b.y * 0.45) * uDrops;
  }
  if (uSnow > 0.001) {
    float s = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 uv = vUv * vec2(uAspect, 1.0) * (5.0 + fi * 3.0) + vec2(sin(uTime * 0.4 + fi) * 0.4, uTime * (0.5 + fi * 0.25));
      vec2 id = floor(uv);
      vec2 f = fract(uv) - 0.5;
      float r = h21(id + fi * 13.0);
      vec2 c = (vec2(h21(id + 3.1 + fi), h21(id + 5.7 + fi)) - 0.5) * 0.7;
      float m = step(0.55, r) * (1.0 - smoothstep(0.03, 0.09 - fi * 0.015, length(f - c)));
      s = max(s, m * (1.0 - fi * 0.25));
    }
    col = mix(col, uLight * 1.3, s);
    a = max(a, s * 0.75 * uSnow);
  }
  if (uFlash > 0.001) {
    col = mix(col, vec3(0.85, 0.9, 1.0), uFlash / max(a + uFlash, 0.001));
    a = max(a, uFlash * 0.42);
  }
  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}
`;

export class ScreenFx {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.PlaneGeometry;
  drops = 0;
  flash = 0;
  snow = 0;

  constructor() {
    this.geo = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      name: 'env.screenFx',
      uniforms: {
        uTime: { value: 0 },
        uDrops: { value: 0 },
        uFlash: { value: 0 },
        uSnow: { value: 0 },
        uAspect: { value: 16 / 9 },
        uLight: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env.screenFx';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 100000;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData.noOriginShift = true;
    this.mesh.visible = false;
  }

  update(time: number, aspect: number, light: THREE.Color): void {
    const u = this.mat.uniforms;
    u.uTime.value = time % 1000;
    u.uDrops.value = this.drops;
    u.uFlash.value = this.flash;
    u.uSnow.value = this.snow;
    u.uAspect.value = aspect;
    u.uLight.value.copy(light);
    this.mesh.visible = this.drops > 0.001 || this.flash > 0.001 || this.snow > 0.001;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
