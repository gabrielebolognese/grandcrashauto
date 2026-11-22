import * as THREE from 'three';

/**
 * Procedural forked lightning bolts: midpoint-displaced main channel + a few branches, built once per strike as
 * camera-facing ribbons into a preallocated buffer (no allocations per strike). Additive HDR colour (blooms on High).
 */

const MAX_SEGMENTS = 180;

const VERT = /* glsl */ `
attribute float aGlow;
varying float vGlow;
varying float vEdge;
void main() {
  vGlow = aGlow;
  vEdge = uv.x;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uAlpha;
uniform vec3 uColor;
varying float vGlow;
varying float vEdge;
void main() {
  float core = 1.0 - abs(vEdge * 2.0 - 1.0);
  core = core * core;
  gl_FragColor = vec4(uColor * vGlow * (0.4 + 1.6 * core) * uAlpha, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Lightning {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private uvs: Float32Array;
  private glow: Float32Array;
  private segs = 0;
  private life = 0;
  private pts: THREE.Vector3[] = [];
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private side = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor() {
    this.pos = new Float32Array(MAX_SEGMENTS * 6 * 3);
    this.uvs = new Float32Array(MAX_SEGMENTS * 6 * 2);
    this.glow = new Float32Array(MAX_SEGMENTS * 6);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aGlow', new THREE.BufferAttribute(this.glow, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      name: 'env.lightning',
      uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color(5, 5.5, 8) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env.lightning';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 6;
    this.mesh.userData.warmup = true; // hidden until needed: pre-compiled behind the loading bar
    this.mesh.userData.noOriginShift = true; // shifted by shift() on originShift
    for (let i = 0; i < 80; i++) this.pts.push(new THREE.Vector3());
  }

  private channel(from: THREE.Vector3, to: THREE.Vector3, levels: number, rough: number, width: number, glow: number, cam: THREE.Vector3): void {
    // Midpoint displacement into this.pts (2^levels + 1 points).
    const n = 1 << levels;
    const P = this.pts;
    P[0].copy(from);
    P[n].copy(to);
    for (let step = n; step > 1; step >>= 1) {
      for (let i = 0; i < n; i += step) {
        const m = i + step / 2;
        const len = P[i].distanceTo(P[i + step]);
        P[m].copy(P[i]).lerp(P[i + step], 0.5);
        P[m].x += (Math.random() - 0.5) * len * rough;
        P[m].z += (Math.random() - 0.5) * len * rough;
        P[m].y += (Math.random() - 0.5) * len * rough * 0.3;
      }
    }
    for (let i = 0; i < n && this.segs < MAX_SEGMENTS; i++) {
      const w = width * (1 - (i / n) * 0.5);
      this.ribbon(P[i], P[i + 1], w, glow, cam);
    }
  }

  private ribbon(p0: THREE.Vector3, p1: THREE.Vector3, w: number, glow: number, cam: THREE.Vector3): void {
    const d = this.a.subVectors(p1, p0);
    const v = this.b.subVectors(cam, p0);
    this.side.crossVectors(d, v);
    if (this.side.lengthSq() < 1e-6) this.side.set(1, 0, 0);
    this.side.normalize().multiplyScalar(w * 0.5);
    const s = this.side;
    const i = this.segs * 6;
    const quad = [
      [p0, -1, 0], [p0, 1, 1], [p1, 1, 1],
      [p0, -1, 0], [p1, 1, 1], [p1, -1, 0],
    ] as const;
    for (let k = 0; k < 6; k++) {
      const [p, sign, u] = quad[k];
      this.tmp.copy(p).addScaledVector(s, sign);
      this.pos[(i + k) * 3] = this.tmp.x;
      this.pos[(i + k) * 3 + 1] = this.tmp.y;
      this.pos[(i + k) * 3 + 2] = this.tmp.z;
      this.uvs[(i + k) * 2] = u;
      this.uvs[(i + k) * 2 + 1] = 0;
      this.glow[i + k] = glow;
    }
    this.segs++;
  }

  /** Build a bolt from the cloud base `top` down to the ground point `bottom`. */
  strike(top: THREE.Vector3, bottom: THREE.Vector3, cam: THREE.Vector3): void {
    this.segs = 0;
    const height = top.y - bottom.y;
    const width = THREE.MathUtils.clamp(cam.distanceTo(bottom) * 0.0025, 1.2, 6);
    this.channel(top, bottom, 6, 0.42, width, 1, cam);
    const main = this.pts.slice(0, 65).map((p) => p.clone());
    const branches = 3 + Math.floor(Math.random() * 3);
    for (let b = 0; b < branches; b++) {
      const start = main[4 + Math.floor(Math.random() * 40)];
      const end = this.tmp.set(
        start.x + (Math.random() - 0.5) * height * 0.5,
        start.y - height * (0.15 + Math.random() * 0.3),
        start.z + (Math.random() - 0.5) * height * 0.5,
      ).clone();
      this.channel(start, end, 4, 0.5, width * 0.45, 0.55, cam);
    }
    this.geo.setDrawRange(0, this.segs * 6);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.uv as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aGlow as THREE.BufferAttribute).needsUpdate = true;
    this.life = 1;
    this.mesh.visible = true;
  }

  /** Returns the current flash level 0..1 (double flicker). */
  update(realDt: number): number {
    if (this.life <= 0) {
      this.mesh.visible = false;
      return 0;
    }
    this.life = Math.max(0, this.life - realDt / 0.45);
    const t = 1 - this.life; // 0..1 over 0.45 s
    const flick = t < 0.12 ? 1 : t < 0.22 ? 0.25 : t < 0.36 ? 0.85 : Math.max(0, 1 - (t - 0.36) / 0.64) * 0.6;
    this.mat.uniforms.uAlpha.value = flick;
    return flick;
  }

  shift(dx: number, dz: number): void {
    for (let i = 0; i < this.segs * 6; i++) {
      this.pos[i * 3] -= dx;
      this.pos[i * 3 + 2] -= dz;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
