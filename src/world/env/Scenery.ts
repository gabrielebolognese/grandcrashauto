import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLSL_ENV_PARS, GLSL_OUTPUT, envUniforms } from './shaders';

/**
 * Distant scenery out at sea: a few low-poly islands (flat-shaded sand / green / rock, vertex colours), a lighthouse
 * whose lamp blinks at night, and little sailboats bobbing on the swell. All merged into ONE mesh / ONE draw call.
 * Own lighting + aerial haze (not the city fog, which would erase them).
 */

const VERT = /* glsl */ `
attribute vec3 color;
attribute vec4 aBob;   // boat pivot x, z, phase, weight (0 = static)
attribute float aGlow; // 1 = lighthouse lamp
uniform float uTime;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vGlow;
void main() {
  vec3 p = position;
  vec3 n = normal;
  if (aBob.w > 0.0) {
    float t = uTime * 0.9 + aBob.z;
    float roll = sin(t) * 0.07;
    float pitch = sin(t * 0.77 + 1.3) * 0.04;
    vec3 r = p - vec3(aBob.x, 0.0, aBob.y);
    float cr = cos(roll), sr = sin(roll);
    r.xy = vec2(r.x * cr - r.y * sr, r.x * sr + r.y * cr);
    n.xy = vec2(n.x * cr - n.y * sr, n.x * sr + n.y * cr);
    float cp = cos(pitch), sp = sin(pitch);
    r.zy = vec2(r.z * cp - r.y * sp, r.z * sp + r.y * cp);
    p = r + vec3(aBob.x, sin(t * 1.3) * 0.25, aBob.y);
  }
  vColor = color;
  vNormal = n;
  vGlow = aGlow;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${GLSL_ENV_PARS}
uniform float uSceneryHaze;
varying vec3 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vGlow;
void main() {
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 amb = mix(uAmbientGround, uAmbient, n.y * 0.5 + 0.5);
  vec3 col = vColor * (uSunLight * ndl + amb) * 0.3183;
  if (vGlow > 0.5) {
    float blink = smoothstep(0.55, 1.0, sin(uTime * 2.2) * 0.5 + 0.5);
    col += vec3(1.0, 0.85, 0.55) * uNight * (1.5 + 14.0 * blink);
  }
  float haze = 1.0 - exp(-dist / uSceneryHaze);
  col = envHaze(col, -V, haze * mix(0.88, 0.7, vGlow * uNight));
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_OUTPUT}
}
`;

const C = (hex: string) => new THREE.Color(hex);
const SAND = C('#f1d9ad');
const WET_SAND = C('#cdb48c');
const GRASS = C('#6fb05f');
const PALM = C('#4f9a5a');
const ROCK = C('#a8998a');
const CLIFF = C('#8d7f74');

class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  bob: number[] = [];
  glow: number[] = [];
  private bobCur = [0, 0, 0, 0];
  private glowCur = 0;

  setBob(x: number, z: number, phase: number, w: number): void {
    this.bobCur = [x, z, phase, w];
  }
  setGlow(g: number): void {
    this.glowCur = g;
  }
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, ca: THREE.Color, cb = ca, cc = ca): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.col.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
    for (let i = 0; i < 3; i++) {
      this.bob.push(...this.bobCur);
      this.glow.push(this.glowCur);
    }
  }
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, col: THREE.Color): void {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBob', new THREE.Float32BufferAttribute(this.bob, 4));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.computeVertexNormals(); // non-indexed → flat facets (low-poly look)
    g.computeBoundingSphere();
    return g;
  }
}

function rngFrom(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

function addIsland(b: GeoBuilder, cx: number, cz: number, radius: number, height: number, elong: number, seed: number): THREE.Vector3 {
  const rnd = rngFrom(seed);
  const segs = Math.max(12, Math.min(30, Math.round(radius / 7)));
  // Ring profile: [radius factor, height factor (or absolute for the shore rings), colour]
  const rings: [number, number, THREE.Color, boolean][] = [
    [1.18, -2.5, WET_SAND, true],
    [1.0, 0.5, SAND, true],
    [0.9, 1.6, SAND, true],
    [0.76, 0.3, GRASS, false],
    [0.52, 0.66, PALM, false],
    [0.26, 0.92, ROCK, false],
  ];
  // Smooth angular noise for an organic outline.
  const harm = [0, 1, 2, 3].map(() => ({ a: rnd() * 0.18, p: rnd() * Math.PI * 2 }));
  const outline = (t: number) => 1 + harm.reduce((s, h, i) => s + h.a * Math.sin(t * (i + 2) + h.p), 0);
  const peakOff = new THREE.Vector2((rnd() - 0.5) * radius * 0.35, (rnd() - 0.5) * radius * 0.35);
  const ring: THREE.Vector3[][] = rings.map(([rf, hf, , abs], ri) => {
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j < segs; j++) {
      const t = (j / segs) * Math.PI * 2;
      const rr = radius * rf * outline(t) * (0.92 + rnd() * 0.16);
      const inner = ri >= 3 ? (ri - 2) / 4 : 0;
      const ox = peakOff.x * inner, oz = peakOff.y * inner;
      const y = abs ? hf : height * hf * (0.8 + rnd() * 0.4);
      pts.push(new THREE.Vector3(cx + ox + Math.cos(t) * rr * elong, y, cz + oz + Math.sin(t) * rr));
    }
    return pts;
  });
  const top = new THREE.Vector3(cx + peakOff.x, height, cz + peakOff.y);
  for (let ri = 0; ri < ring.length - 1; ri++) {
    const A = ring[ri], B = ring[ri + 1];
    const col = rings[ri + 1][2];
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      // Steep faces read as cliffs.
      const steep = ri >= 2 && Math.abs(B[j].y - A[j].y) / Math.max(1, A[j].distanceTo(B[j])) > 0.75;
      b.quad(A[j], A[j1], B[j1], B[j], steep ? CLIFF : col);
    }
  }
  const last = ring[ring.length - 1];
  for (let j = 0; j < segs; j++) b.tri(last[j], last[(j + 1) % segs], top, ROCK);
  // A few low-poly trees on the green belt.
  const trees = Math.round(radius / 14);
  for (let i = 0; i < trees; i++) {
    const t = rnd() * Math.PI * 2;
    const rr = radius * (0.55 + rnd() * 0.25) * outline(t);
    const x = cx + Math.cos(t) * rr * elong, z = cz + Math.sin(t) * rr;
    const y = height * 0.25 + rnd() * 2;
    const h = 7 + rnd() * 6, w = 2.6 + rnd() * 1.5;
    const tip = new THREE.Vector3(x, y + h, z);
    const p0 = new THREE.Vector3(x + w, y, z), p1 = new THREE.Vector3(x - w * 0.5, y, z + w * 0.87), p2 = new THREE.Vector3(x - w * 0.5, y, z - w * 0.87);
    b.tri(p0, p1, tip, PALM);
    b.tri(p1, p2, tip, PALM);
    b.tri(p2, p0, tip, PALM);
  }
  return top;
}

function addLighthouse(b: GeoBuilder, x: number, y: number, z: number): void {
  const segs = 10, h = 16, r0 = 2.2, r1 = 1.4;
  const white = C('#fff6ea'), red = C('#e2544a');
  const bands = 5;
  for (let k = 0; k < bands; k++) {
    const y0 = y + (k / bands) * h, y1 = y + ((k + 1) / bands) * h;
    const ra = r0 + (r1 - r0) * (k / bands), rb = r0 + (r1 - r0) * ((k + 1) / bands);
    const col = k % 2 ? red : white;
    for (let j = 0; j < segs; j++) {
      const a0 = (j / segs) * Math.PI * 2, a1 = ((j + 1) / segs) * Math.PI * 2;
      b.quad(
        new THREE.Vector3(x + Math.cos(a0) * ra, y0, z + Math.sin(a0) * ra),
        new THREE.Vector3(x + Math.cos(a1) * ra, y0, z + Math.sin(a1) * ra),
        new THREE.Vector3(x + Math.cos(a1) * rb, y1, z + Math.sin(a1) * rb),
        new THREE.Vector3(x + Math.cos(a0) * rb, y1, z + Math.sin(a0) * rb),
        col,
      );
    }
  }
  // Lamp room (glows at night) + red cap.
  b.setGlow(1);
  const ly = y + h, lr = 1.25, lh = 2.2;
  const lamp = C('#fff1c8');
  for (let j = 0; j < segs; j++) {
    const a0 = (j / segs) * Math.PI * 2, a1 = ((j + 1) / segs) * Math.PI * 2;
    b.quad(
      new THREE.Vector3(x + Math.cos(a0) * lr, ly, z + Math.sin(a0) * lr),
      new THREE.Vector3(x + Math.cos(a1) * lr, ly, z + Math.sin(a1) * lr),
      new THREE.Vector3(x + Math.cos(a1) * lr, ly + lh, z + Math.sin(a1) * lr),
      new THREE.Vector3(x + Math.cos(a0) * lr, ly + lh, z + Math.sin(a0) * lr),
      lamp,
    );
  }
  b.setGlow(0);
  const capTip = new THREE.Vector3(x, ly + lh + 2.0, z);
  for (let j = 0; j < segs; j++) {
    const a0 = (j / segs) * Math.PI * 2, a1 = ((j + 1) / segs) * Math.PI * 2;
    b.tri(new THREE.Vector3(x + Math.cos(a0) * 1.7, ly + lh, z + Math.sin(a0) * 1.7), new THREE.Vector3(x + Math.cos(a1) * 1.7, ly + lh, z + Math.sin(a1) * 1.7), capTip, red);
  }
}

function addSailboat(b: GeoBuilder, x: number, z: number, yaw: number, scale: number, phase: number, sailCol: THREE.Color, hullCol: THREE.Color): void {
  b.setBob(x, z, phase, 1);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const P = (lx: number, ly: number, lz: number) => new THREE.Vector3(x + (lx * cy + lz * sy) * scale, ly * scale, z + (-lx * sy + lz * cy) * scale);
  const L = 4.2, W = 1.25, D = 0.9, F = 0.5;
  const bow = P(0, F, L), sternL = P(W, F, -L * 0.85), sternR = P(-W, F, -L * 0.85);
  const midL = P(W * 1.1, F, 0), midR = P(-W * 1.1, F, 0);
  const keelF = P(0, -D, L * 0.6), keelB = P(0, -D, -L * 0.7);
  // Deck
  b.tri(bow, midR, midL, C('#e9dcc6'));
  b.quad(midL, midR, sternR, sternL, C('#e9dcc6'));
  // Hull sides
  b.quad(bow, midL, keelB, keelF, hullCol);
  b.tri(midL, sternL, keelB, hullCol);
  b.quad(bow, keelF, keelB, midR, hullCol);
  b.tri(midR, keelB, sternR, hullCol);
  b.tri(sternL, sternR, keelB, hullCol);
  // Mast + sails
  const mastB = P(0, F, L * 0.25), mastT = P(0, 9.5, L * 0.25);
  b.tri(mastB, mastT, P(0.08, F, L * 0.2), C('#d8d2c8'));
  b.tri(P(0, F + 0.6, L * 0.2), mastT, P(0.25, F + 0.8, -L * 0.8), sailCol); // main sail
  b.tri(P(0, F + 0.5, L * 0.32), mastT, P(0.15, F + 0.4, L * 0.98), sailCol); // jib
  b.setBob(0, 0, 0, 0);
}

export class Scenery {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;

  constructor(shoreZ: number) {
    const b = new GeoBuilder();
    const cfg = CONFIG.env.scenery;
    for (const isl of cfg.islands) {
      const top = addIsland(b, isl.x, isl.z, isl.radius, isl.height, isl.elong, isl.seed);
      if (isl.lighthouse) addLighthouse(b, top.x, top.y - 0.5, top.z);
    }
    const rnd = rngFrom(4711);
    const sails = [C('#fff8ee'), C('#fff8ee'), C('#ffd9c9'), C('#fff1c2'), C('#e8f6ff')];
    const hulls = [C('#ffffff'), C('#2f5d8a'), C('#e2544a'), C('#f3f0ea'), C('#1f3550')];
    for (let i = 0; i < cfg.boats; i++) {
      const x = (rnd() - 0.5) * 1400;
      const z = shoreZ + 160 + rnd() * 700;
      addSailboat(b, x, z, rnd() * Math.PI * 2, 1 + rnd() * 0.5, rnd() * 10, sails[i % sails.length], hulls[(i * 3) % hulls.length]);
    }
    this.geo = b.build();
    this.mat = new THREE.ShaderMaterial({
      name: 'env.scenery',
      uniforms: { ...envUniforms(), uSceneryHaze: { value: 1500 } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'env.scenery';
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
  }

  get triangleCount(): number {
    return this.geo.attributes.position.count / 3;
  }

  update(camera: THREE.PerspectiveCamera, hazeScale = 1): void {
    const camH = Math.max(0, camera.position.y);
    this.mat.uniforms.uSceneryHaze.value = CONFIG.env.scenery.hazeDist * (1 + camH / 400) * Math.max(0.05, hazeScale);
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
