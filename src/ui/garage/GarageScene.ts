import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../../config';
import { disposeObject } from '../../core/Engine';
import type { CarVisual } from '../../game/contracts';
import type { CarBuild } from '../../vehicle/CarBuild';

/**
 * The garage studio (owner: garage): a pastel art-deco showroom.
 *  - One glossy floor (a Reflector on medium/high quality, same shader without the mirror on low) that also draws the
 *    flush turntable: dark lacquered disc with gold inlays (pattern turns with the car), brass rim, neon groove.
 *    Reflections use fresnel + distance blur so the floor reads as polished stone and the disc as black lacquer.
 *  - Cyclorama room (cove, deco bays with uplight scallops, gold pilasters, neon band), deco columns, overhead soft box.
 *  - Contact shadow rendered from below with a depth material and blurred (re-rendered only when the car changes).
 *  - Lights created once: key + hemisphere fill + two rim lights. Car reflections from a PMREM'd custom studio
 *    environment (dark dome with bright soft boxes and coloured strips = contrasty, premium paint highlights).
 *  - A subtle camera vignette (layer 1: hidden from the mirror and shadow passes).
 * Everything is built once at init and kept for the session.
 */

export const PLATFORM_R = 3.3;
/** Car contact plane (the turntable is flush with the floor). */
export const PLATFORM_TOP = 0.006;
const FLOOR_R = 16;
const COVE = 5;
const WALL_TOP = 11;
const COLUMN_R = 14.2;
/** Max camera distance from the orbit target (stays inside the column ring). */
export const ROOM_MAX_CAM_DIST = 12.5;
const SHADOW_RES = 256;
const SHADOW_CAM_H = 1.5;
/** Layer for main-camera-only helpers (vignette, contact shadow): hidden from the mirror pass. */
const MAIN_ONLY = 1;

const DEG = Math.PI / 180;
const col = (hex: string) => new THREE.Color(hex);

// ───────────────────────────── shader chunks ─────────────────────────────
const LINE_AA = /* glsl */ `
float lineAA(float d, float w) { float f = max(fwidth(d), 1e-4); return 1.0 - smoothstep(w - f, w + f, abs(d)); }
`;

/** Same curve as three's ACESFilmicToneMapping, so mirrored cars match the directly rendered car. */
const ACES = /* glsl */ `
vec3 garRRT(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 garACES(vec3 c, float exposure) {
  const mat3 IM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= exposure / 0.6;
  c = OM * garRRT(IM * c);
  return clamp(c, 0.0, 1.0);
}
`;

const FLOOR_VERT = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vUv;
varying vec3 vW;
void main() {
  vUv = textureMatrix * vec4(position, 1.0);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FLOOR_FRAG = /* glsl */ `
uniform vec3 color;
uniform sampler2D tDiffuse;
uniform float uReflect, uStrength, uSpin, uPlatR, uRingBoost, uExposure;
uniform vec2 uTexel;
uniform vec3 uDisc, uGold, uFloorIn, uFloorOut, uFloorEdge, uRing, uFallback;
varying vec4 vUv;
varying vec3 vW;
${LINE_AA}
${ACES}
vec3 mirror(float blur) {
  vec2 uv = vUv.xy / vUv.w;
  vec2 o = uTexel * blur;
  vec3 c = texture2D(tDiffuse, uv).rgb * 0.36;
  c += texture2D(tDiffuse, uv + vec2(o.x, o.y * 0.5)).rgb * 0.16;
  c += texture2D(tDiffuse, uv - vec2(o.x, o.y * 0.5)).rgb * 0.16;
  c += texture2D(tDiffuse, uv + vec2(-o.x * 0.5, o.y)).rgb * 0.16;
  c += texture2D(tDiffuse, uv - vec2(-o.x * 0.5, o.y)).rgb * 0.16;
  return c;
}
void main() {
  float r = length(vW.xz);
  float ang = atan(vW.z, vW.x);
  vec3 V = normalize(cameraPosition - vW);
  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
  float R = uPlatR;

  // ── polished floor: warm stone, pool of light under the soft box, tone-on-tone deco sunburst, gold rings ──
  vec3 base = mix(uFloorIn, uFloorOut, smoothstep(4.5, 14.0, r));
  base = mix(base, uFloorEdge, smoothstep(12.5, 16.0, r));
  base *= mix(0.88, 1.08, exp(-r * r / 36.0));
  float s = fract(ang * 40.0 / 6.2831853);
  float aw = min(fwidth(s) * 1.5, 0.25);
  float band = smoothstep(0.5 - aw, 0.5 + aw, s) * (1.0 - smoothstep(1.0 - aw, 1.0, s));
  float zone = smoothstep(5.25, 5.32, r) * (1.0 - smoothstep(9.38, 9.45, r));
  base *= 1.0 - band * zone * 0.05;
  float rings = lineAA(r - 5.02, 0.034) + lineAA(r - 5.24, 0.013) + lineAA(r - 9.46, 0.03) + lineAA(r - 9.68, 0.012) + lineAA(r - 13.4, 0.02) * 0.6;
  base = mix(base, uGold, clamp(rings, 0.0, 1.0) * 0.85);
  float gap = r - R - 0.13;
  base += uRing * exp(-max(gap, 0.0) * 2.8) * step(0.0, gap) * (0.12 + 0.5 * uRingBoost);
  float F0 = 0.045;
  float blur = 1.0 + r * 0.5;
  float metal = 0.0;

  // ── flush turntable (pattern turns with the car) ──
  if (r < R + 0.13) {
    float a = ang + uSpin;
    float rn = r / R;
    vec3 d = uDisc * (1.0 + 0.32 * (1.0 - rn * rn));
    float g = r * 24.0;
    float gf = 1.0 - smoothstep(0.12, 0.5, fwidth(g));
    d *= 1.0 - 0.07 * gf * (0.5 + 0.5 * cos(g * 6.2831853));
    float s2 = fract(a * 24.0 / 6.2831853);
    float aw2 = min(fwidth(s2) * 1.5, 0.25);
    float ray = smoothstep(0.5 - aw2, 0.5 + aw2, s2) * (1.0 - smoothstep(1.0 - aw2, 1.0, s2));
    d *= 1.0 + ray * step(0.4, rn) * step(rn, 0.84) * 0.16;
    float tick = lineAA(fract(a * 16.0 / 6.2831853) - 0.5, 0.05) * step(0.885, rn) * step(rn, 0.915);
    float inlay = lineAA(r - R * 0.94, 0.012) + lineAA(r - R * 0.865, 0.006) + lineAA(r - R * 0.4, 0.008) + tick;
    d = mix(d, uGold, clamp(inlay, 0.0, 1.0));
    float rim = smoothstep(R - 0.004, R + 0.004, r) * (1.0 - smoothstep(R + 0.07, R + 0.08, r));
    float groove = smoothstep(R + 0.075, R + 0.085, r);
    d = mix(d, uGold * (0.78 + 0.32 * sin((r - R) * 95.0)), rim);
    d = mix(d, uDisc * 0.35, groove);
    base = d;
    F0 = mix(0.36, 0.75, rim) * (1.0 - groove);
    blur = 0.5;
    metal = rim;
  }

  float F = clamp((F0 + (1.0 - F0) * fres) * uStrength * (metal > 0.0 || r < R ? 1.0 : 0.62), 0.0, 0.92);
  vec3 refl = uReflect > 0.5 ? garACES(mirror(blur), uExposure) : uFallback;
  refl *= mix(vec3(1.0), uGold * 1.35, metal * 0.85);
  vec3 c = base * (1.0 - F) + refl * F;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const ROOM_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const ROOM_FRAG = /* glsl */ `
uniform vec3 uFloorEdge, uWallLow, uWallMid, uWallTop, uCeil, uGold, uNeonA, uNeonB, uUp;
uniform vec2 uKeyDir;
varying vec3 vW;
${LINE_AA}
void main() {
  float r = length(vW.xz);
  float h = vW.y;
  float ang = atan(vW.z, vW.x);
  vec2 dir = vW.xz / max(r, 1e-3);
  vec3 c = mix(uFloorEdge, uWallLow, smoothstep(0.0, 1.8, h));
  c = mix(c, uWallMid, smoothstep(1.6, 7.5, h));
  c = mix(c, uWallTop, smoothstep(7.0, 13.0, h));
  c = mix(c, uCeil, smoothstep(13.5, 16.0, h));
  float wall = smoothstep(0.4, 1.6, h) * (1.0 - smoothstep(11.5, 13.5, h));
  // 14 bays: warm uplight scallops, gold-fluted pilasters
  float bays = 14.0;
  float u = fract(ang * bays / 6.2831853) - 0.5;
  float scallop = pow(max(cos(u * 3.14159), 0.0), 6.0) * exp(-max(h - 0.5, 0.0) / 3.4);
  c += uUp * scallop * wall * 0.26;
  float m = (0.5 - abs(u)) * (6.2831853 * 21.0 / bays);
  float pilWall = (1.0 - smoothstep(0.3, 0.34, m)) * smoothstep(1.2, 1.6, h) * (1.0 - smoothstep(10.4, 10.8, h));
  c = mix(c, c * 1.04 + 0.02, pilWall);
  float flutes = lineAA(m - 0.11, 0.011) + lineAA(m - 0.21, 0.011);
  c = mix(c, uGold, clamp(flutes, 0.0, 1.0) * pilWall * 0.75);
  c = mix(c, uGold, clamp(lineAA(h - 10.6, 0.03) + lineAA(h - 1.6, 0.018), 0.0, 1.0) * wall * 0.7);
  // neon band
  float n1 = lineAA(h - 3.1, 0.026);
  float n2 = lineAA(h - 3.36, 0.017);
  c += (uNeonA * 0.6 + uNeonB * 0.4) * exp(-abs(h - 3.23) * 2.2) * 0.14 * wall;
  c = mix(c, uNeonA, n1 * (1.0 - pilWall * 0.7));
  c = mix(c, uNeonB, n2 * (1.0 - pilWall * 0.7));
  // key-light falloff around the room for depth
  c *= 0.9 + 0.14 * max(dot(-dir, uKeyDir), 0.0);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const VIGNETTE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
uniform vec2 uRes;
void main() {
  vec2 p = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  p.x *= 0.82;
  float v = smoothstep(0.55, 1.45, length(p));
  gl_FragColor = vec4(uColor, v * uAmount);
}`;

const AO_VERT = /* glsl */ `
attribute float strength;
attribute float soft;
varying vec2 vUv;
varying float vS;
varying float vSoft;
void main() {
  vUv = uv; vS = strength; vSoft = soft;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const AO_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vS;
varying float vSoft;
void main() {
  float d = length(vUv * 2.0 - 1.0);
  float a = 1.0 - smoothstep(1.0 - vSoft, 1.0, d);
  gl_FragColor = vec4(uColor, a * a * vS * uOpacity);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── scene ─────────────────────────────
export class GarageScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Rotates slowly; holds the car mount and its shadows (the disc pattern follows via a uniform). */
  readonly turntable = new THREE.Group();
  /** Car parent (y offset used by the drop-in animation). */
  readonly carMount = new THREE.Group();
  visual: CarVisual | null = null;
  /** Car bounding box size at rest (local, unrotated; y measured from the contact plane) and orbit target height. */
  readonly carSize = new THREE.Vector3(1.9, 1.4, 4.4);
  carCenterY = 0.65;

  private floorUniforms: Record<string, THREE.IUniform>;
  private floorMats: THREE.ShaderMaterial[] = [];
  private plainFloor: THREE.Mesh;
  private reflector: Reflector | null = null;
  private roomMat: THREE.ShaderMaterial;
  private ringMat!: THREE.MeshBasicMaterial;
  private ringColor = col('#ff8a7a');
  private ringTarget = col('#ff8a7a');
  private aoMesh: THREE.Mesh;
  private aoMat: THREE.ShaderMaterial;
  private vignette: THREE.Mesh;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private owned: THREE.Object3D[] = [];
  private ringBoost = 0;
  private dropY = 0;
  private dropV = 0;
  private time = 0;
  private reflectionsOn = false;
  private tmpSize = new THREE.Vector2();
  private tmpColor = new THREE.Color();
  private blackTex: THREE.DataTexture;

  // contact shadow (depth from below → blur)
  private shadowRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES);
  private shadowBlurRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES);
  private shadowCam = new THREE.OrthographicCamera(-2, 2, 3, -3, 0, SHADOW_CAM_H);
  private shadowScene = new THREE.Scene();
  private shadowPlane: THREE.Mesh;
  private blurPlane: THREE.Mesh;
  private depthMat: THREE.MeshDepthMaterial;
  private hBlur: THREE.ShaderMaterial;
  private vBlur: THREE.ShaderMaterial;
  private shadowDirty = true;
  private shadowW = 4;
  private shadowH = 6;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.PerspectiveCamera(CONFIG.garage.fov, 1, 0.1, 120);
    this.camera.layers.enable(MAIN_ONLY);
    this.scene.background = col('#f1d3c6');

    this.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.blackTex.needsUpdate = true;

    // ── room ──
    this.roomMat = new THREE.ShaderMaterial({
      vertexShader: ROOM_VERT,
      fragmentShader: ROOM_FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uFloorEdge: { value: col('#d2ada6') },
        uWallLow: { value: col('#efcdbf') },
        uWallMid: { value: col('#eecbd6') },
        uWallTop: { value: col('#c9d2f0') },
        uCeil: { value: col('#aeb0dc') },
        uGold: { value: col('#d2a95c') },
        uNeonA: { value: col('#ff7f90') },
        uNeonB: { value: col('#70e4e0') },
        uUp: { value: col('#fff0d8') },
        uKeyDir: { value: new THREE.Vector2(0.64, 0.77) },
      },
    });
    const room = new THREE.Mesh(new THREE.LatheGeometry(roomProfile(), 140), this.roomMat);
    this.add(room);

    // ── floor (plain version; the Reflector version is created on demand) ──
    this.floorUniforms = {
      color: { value: col('#ffffff') },
      tDiffuse: { value: this.blackTex },
      textureMatrix: { value: new THREE.Matrix4() },
      uReflect: { value: 0 },
      uStrength: { value: CONFIG.garage.reflectionStrength },
      uSpin: { value: 0 },
      uPlatR: { value: PLATFORM_R },
      uRingBoost: { value: 0 },
      uExposure: { value: 1 },
      uTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uDisc: { value: col('#2c2943') },
      uGold: { value: col('#d8b06a') },
      uFloorIn: { value: col('#e4c8bd') },
      uFloorOut: { value: col('#d6b3aa') },
      uFloorEdge: { value: col('#d2ada6') },
      uRing: { value: this.ringColor.clone() },
      uFallback: { value: col('#e9cfd6') },
    };
    const floorMat = new THREE.ShaderMaterial({
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      uniforms: THREE.UniformsUtils.clone(this.floorUniforms),
      toneMapped: false,
    });
    floorMat.uniforms.tDiffuse.value = this.blackTex;
    this.floorMats.push(floorMat);
    this.plainFloor = new THREE.Mesh(new THREE.CircleGeometry(FLOOR_R + 0.05, 128), floorMat);
    this.plainFloor.rotation.x = -Math.PI / 2;
    this.add(this.plainFloor);

    this.addColumns();
    this.addRing();
    this.addSoftbox();

    // ── shadows on the turntable ──
    this.aoMat = new THREE.ShaderMaterial({
      vertexShader: AO_VERT,
      fragmentShader: AO_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uColor: { value: col('#2a2238') }, uOpacity: { value: 1 } },
    });
    this.aoMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.aoMat);
    this.aoMesh.position.y = 0.003;
    this.aoMesh.renderOrder = 1;
    this.aoMesh.layers.set(MAIN_ONLY);
    this.turntable.add(this.aoMesh);

    this.depthMat = new THREE.MeshDepthMaterial();
    const darkness = { value: 1.35 };
    this.depthMat.onBeforeCompile = (shader) => {
      shader.uniforms.darkness = darkness;
      shader.fragmentShader =
        'uniform float darkness;\n' +
        shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 1.0 ), ( 1.0 - fragCoordZ ) * darkness );');
    };
    this.hBlur = new THREE.ShaderMaterial({ ...HorizontalBlurShader, uniforms: THREE.UniformsUtils.clone(HorizontalBlurShader.uniforms), depthTest: false, depthWrite: false });
    this.vBlur = new THREE.ShaderMaterial({ ...VerticalBlurShader, uniforms: THREE.UniformsUtils.clone(VerticalBlurShader.uniforms), depthTest: false, depthWrite: false });
    this.shadowCam.rotation.x = Math.PI / 2; // look up from the ground
    const unit = new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2);
    this.blurPlane = new THREE.Mesh(unit, this.hBlur);
    this.blurPlane.position.y = 0.01;
    this.shadowPlane = new THREE.Mesh(
      unit.clone(),
      new THREE.MeshBasicMaterial({ map: this.shadowRT.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, color: 0x241a36 }),
    );
    this.shadowPlane.position.y = 0.004;
    this.shadowPlane.renderOrder = 2;
    this.shadowPlane.layers.set(MAIN_ONLY);
    this.turntable.add(this.shadowPlane);

    this.carMount.position.y = PLATFORM_TOP;
    this.turntable.add(this.carMount);
    this.scene.add(this.turntable);

    // ── vignette (full-screen, main camera only) ──
    this.vignette = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: VIGNETTE_FRAG,
        uniforms: { uColor: { value: col('#3b2a4a') }, uAmount: { value: 0.32 }, uRes: { value: new THREE.Vector2(1, 1) } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.vignette.frustumCulled = false;
    this.vignette.renderOrder = 999;
    this.vignette.layers.set(MAIN_ONLY);
    this.add(this.vignette);

    // ── lights (created once) ──
    const key = new THREE.DirectionalLight(col('#fff3e2'), CONFIG.garage.keyLight);
    key.position.set(4.5, 9, 5.5);
    const fill = new THREE.HemisphereLight(col('#e4e8ff'), col('#f0c8b8'), CONFIG.garage.fillLight);
    const rimA = new THREE.DirectionalLight(col('#bfeaff'), CONFIG.garage.rimLight);
    rimA.position.set(-7, 4, -6);
    const rimB = new THREE.DirectionalLight(col('#ffcdb8'), CONFIG.garage.rimLight * 0.7);
    rimB.position.set(7, 3, -7);
    this.scene.add(key, fill, rimA, rimB);

    this.buildEnvironment();
  }

  private add(o: THREE.Object3D): void {
    this.scene.add(o);
    this.owned.push(o);
  }

  private addColumns(): void {
    const parts = [
      new THREE.BoxGeometry(1.3, 0.32, 1.3).translate(0, 0.16, 0),
      new THREE.BoxGeometry(1.0, 0.12, 1.0).translate(0, 0.38, 0),
      new THREE.BoxGeometry(0.78, 6.6, 0.78).translate(0, 3.74, 0),
      new THREE.BoxGeometry(1.02, 0.16, 1.02).translate(0, 7.12, 0),
      new THREE.BoxGeometry(1.22, 0.22, 1.22).translate(0, 7.31, 0),
      new THREE.BoxGeometry(0.9, 0.3, 0.9).translate(0, 7.57, 0),
      new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 7.97, 0),
    ];
    const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
    parts.forEach((g) => g.dispose());
    const n = 10;
    const columns = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0.04 }), n);
    const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 5.8, 0.04), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), n);
    const tints = ['#f6e7d6', '#e3f1ea', '#f6e7d6', '#ece5f7', '#f6e7d6'];
    const neon = ['#ff8fa3', '#7ee8e0', '#ffd27a', '#c2a6ff', '#7ee8e0'];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.31;
      p.set(Math.cos(a) * COLUMN_R, 0, Math.sin(a) * COLUMN_R);
      q.setFromAxisAngle(up, -a + Math.PI / 2);
      m.compose(p, q, s);
      columns.setMatrixAt(i, m);
      columns.setColorAt(i, col(tints[i % tints.length]));
      p.set(Math.cos(a) * (COLUMN_R - 0.41), 3.85, Math.sin(a) * (COLUMN_R - 0.41));
      m.compose(p, q, s);
      strips.setMatrixAt(i, m);
      strips.setColorAt(i, col(neon[i % neon.length]));
    }
    columns.frustumCulled = strips.frustumCulled = false;
    this.add(columns);
    this.add(strips);
  }

  private addRing(): void {
    this.ringMat = new THREE.MeshBasicMaterial({ color: this.ringColor.clone(), toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(PLATFORM_R + 0.105, 0.017, 8, 220), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.004;
    this.add(ring);
  }

  /** Overhead soft box: bright panel + bronze frame + hanging wires (mostly seen in the floor's reflection). */
  private addSoftbox(): void {
    const W = 7.4, D = 3.4, Y = 7.0;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshBasicMaterial({ color: col('#fffaf1'), toneMapped: false, side: THREE.DoubleSide }));
    panel.rotation.x = Math.PI / 2;
    panel.position.y = Y;
    this.add(panel);
    const t = 0.09;
    const frameParts: THREE.BufferGeometry[] = [
      new THREE.BoxGeometry(W + t * 2, 0.16, t).translate(0, Y + 0.05, D / 2 + t / 2),
      new THREE.BoxGeometry(W + t * 2, 0.16, t).translate(0, Y + 0.05, -D / 2 - t / 2),
      new THREE.BoxGeometry(t, 0.16, D).translate(W / 2 + t / 2, Y + 0.05, 0),
      new THREE.BoxGeometry(t, 0.16, D).translate(-W / 2 - t / 2, Y + 0.05, 0),
      new THREE.BoxGeometry(W, 0.04, D).translate(0, Y + 0.14, 0),
    ];
    for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      frameParts.push(new THREE.CylinderGeometry(0.012, 0.012, 9, 4).translate((x * W) / 2.3, Y + 4.6, (z * D) / 2.3));
    }
    const frame = new THREE.Mesh(
      mergeGeometries(frameParts),
      new THREE.MeshStandardMaterial({ color: col('#7a5b3a'), metalness: 0.9, roughness: 0.35 }),
    );
    frameParts.forEach((g) => g.dispose());
    this.add(frame);
  }

  /** Studio environment for car reflections: darker dome + bright soft boxes / coloured strips → PMREM. */
  private buildEnvironment(): void {
    const env = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(30, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        toneMapped: false,
        uniforms: { uLow: { value: col('#3a2c34') }, uMid: { value: col('#c9a9a6') }, uTop: { value: col('#6e6c9a') } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 uLow,uMid,uTop; varying vec3 vD; void main(){ float y = vD.y; vec3 c = y < 0.0 ? mix(uMid, uLow, smoothstep(0.0, 0.35, -y)) : mix(uMid, uTop, smoothstep(0.0, 0.6, y)); gl_FragColor = vec4(c * 0.75, 1.0); }',
      }),
    );
    env.add(dome);
    const panel = (w: number, h: number, hex: string, intensity: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ color: col(hex).multiplyScalar(intensity), side: THREE.DoubleSide, toneMapped: false }),
      );
      m.position.set(x, y, z);
      m.lookAt(0, 0.6, 0);
      env.add(m);
    };
    panel(14, 6, '#ffffff', 6.0, 0, 14, 0); // overhead soft box
    panel(1.2, 11, '#fff2e4', 4.2, 14, 5, 4); // tall strip boxes
    panel(1.2, 11, '#fff2e4', 4.2, -14, 5, -4);
    panel(1.2, 11, '#fff2e4', 3.0, 4, 5, -14);
    panel(18, 0.7, '#ff9384', 3.0, 0, 2.2, 15); // coral strip
    panel(18, 0.7, '#76e6e2', 3.0, 0, 2.2, -15); // aqua strip
    panel(6, 2.4, '#ffe2b0', 2.2, -10, 6, 10); // warm kicker
    panel(30, 30, '#d9b4a8', 0.35, 0, -2, 0); // floor bounce
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pmrem.fromScene(env, 0.02, 0.1, 100);
    pmrem.dispose();
    disposeObject(env);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = CONFIG.garage.envIntensity;
  }

  /** Mirror floor (medium/high) or the same shader without the mirror pass (low). */
  setReflections(on: boolean, highQuality: boolean): void {
    if (on && !this.reflector) {
      this.reflector = new Reflector(new THREE.CircleGeometry(FLOOR_R + 0.05, 128), {
        textureWidth: 512,
        textureHeight: 512,
        clipBias: 0.003,
        multisample: highQuality ? 4 : 0,
        shader: { name: 'GarageFloor', uniforms: this.floorUniforms, vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG },
      });
      const mat = this.reflector.material as THREE.ShaderMaterial;
      mat.toneMapped = false;
      mat.uniforms.uReflect.value = 1;
      this.floorMats.push(mat);
      this.reflector.rotation.x = -Math.PI / 2;
      this.scene.add(this.reflector);
      const rc = this.reflector.getReflectionCamera(this.camera);
      rc.layers.disable(MAIN_ONLY);
      this.resizeReflection();
    }
    this.reflectionsOn = on && !!this.reflector;
    if (this.reflector) this.reflector.visible = this.reflectionsOn;
    this.plainFloor.visible = !this.reflectionsOn;
  }

  resizeReflection(): void {
    if (!this.reflector) return;
    this.renderer.getDrawingBufferSize(this.tmpSize);
    const k = CONFIG.garage.reflectionScale;
    const w = Math.max(64, Math.min(1280, Math.round(this.tmpSize.x * k)));
    const h = Math.max(64, Math.min(1280, Math.round(this.tmpSize.y * k)));
    const rt = this.reflector.getRenderTarget();
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
    const u = (this.reflector.material as THREE.ShaderMaterial).uniforms;
    (u.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  /** Put a (new) car visual on the turntable. The caller owns disposal of the previous one. */
  setCar(visual: CarVisual | null, animate: boolean): void {
    if (this.visual) this.carMount.remove(this.visual.root);
    this.visual = visual;
    if (!visual) return;
    this.carMount.add(visual.root);
    visual.root.position.set(0, 0, 0);
    visual.root.rotation.set(0, 0, 0);
    this.refreshCar();
    if (animate) {
      this.dropY = 0.5;
      this.dropV = 0;
      this.ringBoost = 1;
    }
  }

  /** Re-measure framing + shadows after a change that alters the car's shape (model, wheels, kit). */
  refreshCar(): void {
    this.measureCar();
    this.rebuildAO();
    this.shadowDirty = true;
  }

  private measureCar(): void {
    const v = this.visual;
    if (!v) return;
    const prevRot = this.turntable.rotation.y;
    const prevY = this.carMount.position.y;
    const prevRootY = v.root.position.y;
    this.turntable.rotation.y = 0;
    this.carMount.position.y = PLATFORM_TOP;
    v.root.position.y = -this.groundOffset();
    this.scene.updateMatrixWorld(true);
    const box = solidBounds(v.root);
    this.turntable.rotation.y = prevRot;
    this.carMount.position.y = prevY;
    v.root.position.y = prevRootY;
    // Reference size from the contract dims (collider box + wheel track) — robust against odd mesh bounds.
    const d = v.dims;
    let track = 0;
    for (const p of d.wheelPositions) track = Math.max(track, Math.abs(p.x) + d.wheelWidth / 2);
    const refX = Math.max(1.4, 2 * Math.max(d.halfExtents.x, track));
    const refZ = Math.max(3.0, 2 * d.halfExtents.z);
    const refY = Math.max(0.9, d.colliderOffset.y + d.halfExtents.y - this.groundOffset());
    if (box.isEmpty()) this.carSize.set(refX, refY, refZ);
    else {
      box.getSize(this.carSize);
      this.carSize.y = box.max.y - PLATFORM_TOP;
    }
    // Mesh bounds may include beams/glows (too big) or miss merged parts (too small): stay within 1–1.5× the dims.
    const clampTo = (v0: number, ref: number) => Math.min(ref * 1.5, Math.max(ref, v0));
    this.carSize.set(clampTo(this.carSize.x, refX), clampTo(this.carSize.y, refY), clampTo(this.carSize.z, refZ));
    this.carCenterY = PLATFORM_TOP + this.carSize.y * 0.45;
  }

  /** Local y of the wheel contact plane (usually 0 — origin on the ground). */
  private groundOffset(): number {
    const v = this.visual;
    if (!v || !v.dims.wheelPositions.length) return 0;
    let g = Infinity;
    for (const p of v.dims.wheelPositions) g = Math.min(g, p.y - v.dims.wheelRadius);
    return Number.isFinite(g) ? g : 0;
  }

  /** Soft ambient-occlusion underlay (broad body blob + one per tyre). */
  private rebuildAO(): void {
    const v = this.visual;
    const old = this.aoMesh.geometry;
    const quads: THREE.BufferGeometry[] = [];
    const quad = (w: number, l: number, x: number, z: number, strength: number, soft: number) => {
      const g = new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2).translate(x, 0, z);
      const n = g.attributes.position.count;
      g.setAttribute('strength', new THREE.Float32BufferAttribute(new Array(n).fill(strength), 1));
      g.setAttribute('soft', new THREE.Float32BufferAttribute(new Array(n).fill(soft), 1));
      g.deleteAttribute('normal');
      quads.push(g);
    };
    if (v) {
      const hx = Math.max(this.carSize.x / 2, 0.7);
      const hz = Math.max(this.carSize.z / 2, 1.6);
      quad(hx * 2 * 1.6, hz * 2 * 1.35, 0, 0, 0.3, 0.8);
      const r = v.dims.wheelRadius;
      const w = v.dims.wheelWidth;
      for (const p of v.dims.wheelPositions) quad(w * 2.0, r * 1.6, p.x, p.z, 0.5, 0.9);
    }
    this.aoMesh.geometry = quads.length ? mergeGeometries(quads) : new THREE.BufferGeometry();
    quads.forEach((g) => g.dispose());
    old.dispose();
  }

  /** Render the car from below with a depth material, blur it, show it on the shadow plane. */
  private renderContactShadow(): void {
    const v = this.visual;
    this.shadowDirty = false;
    if (!v) {
      this.shadowPlane.visible = false;
      return;
    }
    const W = Math.max(2.5, this.carSize.x + 1.9);
    const H = Math.max(3.5, this.carSize.z + 1.9);
    this.shadowW = W;
    this.shadowH = H;
    const cam = this.shadowCam;
    cam.left = -W / 2;
    cam.right = W / 2;
    cam.top = H / 2;
    cam.bottom = -H / 2;
    cam.updateProjectionMatrix();
    this.blurPlane.scale.set(W, 1, H);
    this.shadowPlane.scale.set(W, 1, H);
    this.shadowPlane.visible = true;

    const r = this.renderer;
    const parent = v.root.parent;
    const prevTarget = r.getRenderTarget();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(this.tmpColor);
    // Additive / no-depth-write meshes (glows, underglow planes) must not cast shadows.
    const hidden: THREE.Object3D[] = [];
    v.root.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (o.visible && mat && !Array.isArray(mat) && (mat.blending === THREE.AdditiveBlending || (mat.transparent && !mat.depthWrite))) {
        o.visible = false;
        hidden.push(o);
      }
    });
    try {
      this.shadowScene.add(v.root);
      this.shadowScene.overrideMaterial = this.depthMat;
      r.setClearColor(0xffffff, 0);
      r.setRenderTarget(this.shadowRT);
      r.clear();
      r.render(this.shadowScene, cam);
      this.shadowScene.overrideMaterial = null;
      for (const amount of [5.0, 2.2]) {
        this.blurPlane.material = this.hBlur;
        this.hBlur.uniforms.tDiffuse.value = this.shadowRT.texture;
        this.hBlur.uniforms.h.value = amount / SHADOW_RES;
        r.setRenderTarget(this.shadowBlurRT);
        r.render(this.blurPlane, cam);
        this.blurPlane.material = this.vBlur;
        this.vBlur.uniforms.tDiffuse.value = this.shadowBlurRT.texture;
        this.vBlur.uniforms.v.value = amount / SHADOW_RES;
        r.setRenderTarget(this.shadowRT);
        r.render(this.blurPlane, cam);
      }
    } finally {
      this.shadowScene.overrideMaterial = null;
      if (parent) parent.add(v.root);
      for (const o of hidden) o.visible = true;
      r.setRenderTarget(prevTarget);
      r.setClearColor(this.tmpColor, prevAlpha);
    }
  }

  /** Ride height / camber / showroom steer preview on the visual's wheel pivots. */
  applyStance(build: CarBuild): void {
    const v = this.visual;
    if (!v) return;
    const cfg = CONFIG.garage;
    const range = physicsRideRange() * cfg.rideHeightVisual;
    const dy = build.stance.rideHeight * range;
    const camber = build.stance.camber * cfg.camberMaxDeg * DEG;
    const steer = -cfg.showroomSteerDeg * DEG;
    v.root.position.y = -this.groundOffset() + dy;
    v.wheels.forEach((w, i) => {
      const base = v.dims.wheelPositions[i];
      if (!base) return;
      w.pivot.position.y = base.y - dy;
      w.pivot.rotation.z = base.x > 0 ? camber : -camber;
      w.pivot.rotation.y = i < 2 ? steer : 0;
    });
    this.aoMat.uniforms.uOpacity.value = 1 - Math.max(0, build.stance.rideHeight) * 0.3;
    this.shadowDirty = true;
  }

  /** Accent colour for the neon ring (follows the underglow, else coral). */
  setAccent(hex: string): void {
    this.ringTarget.set(hex);
  }

  update(dt: number, spinSpeed: number): void {
    this.time += dt;
    this.turntable.rotation.y = (this.turntable.rotation.y + spinSpeed * dt) % (Math.PI * 2);

    // Drop-in spring for new cars.
    if (this.dropY !== 0 || this.dropV !== 0) {
      const k = 190, c = 15;
      this.dropV += (-k * this.dropY - c * this.dropV) * dt;
      this.dropY += this.dropV * dt;
      if (this.dropY < 0 && this.dropV < 0) {
        this.dropY = 0;
        this.dropV = -this.dropV * 0.25;
        if (this.dropV < 0.15) this.dropV = 0;
      }
      this.carMount.position.y = PLATFORM_TOP + this.dropY;
      const fade = Math.max(0.15, 1 - this.dropY * 1.6);
      (this.shadowPlane.material as THREE.MeshBasicMaterial).opacity = fade;
      this.aoMat.uniforms.uOpacity.value = fade;
    }

    // Neon ring: gentle breathing + boost on changes, eased toward the accent colour.
    this.ringBoost = Math.max(0, this.ringBoost - dt * 1.6);
    this.ringColor.lerp(this.ringTarget, 1 - Math.exp(-dt * 4));
    const breathe = 0.9 + 0.1 * Math.sin(this.time * 2.2);
    this.ringMat.color.copy(this.ringColor).multiplyScalar(breathe + this.ringBoost * 0.6);

    const exposure = this.renderer.toneMappingExposure;
    for (const m of this.floorMats) {
      const u = m.uniforms;
      u.uSpin.value = this.turntable.rotation.y;
      u.uRingBoost.value = this.ringBoost;
      u.uExposure.value = exposure;
      u.uStrength.value = CONFIG.garage.reflectionStrength;
      (u.uRing.value as THREE.Color).copy(this.ringColor);
    }
    this.renderer.getDrawingBufferSize(this.tmpSize);
    ((this.vignette.material as THREE.ShaderMaterial).uniforms.uRes.value as THREE.Vector2).copy(this.tmpSize);

    this.visual?.update(dt);
    if (this.reflectionsOn) this.resizeReflection();
    if (this.shadowDirty && this.dropY === 0) this.renderContactShadow();
  }

  /** Pulse the ring (feedback on a change). */
  pulse(amount = 0.6): void {
    this.ringBoost = Math.max(this.ringBoost, amount);
  }

  /** Warm up shader programs so the first open does not hitch. */
  compile(): void {
    try {
      this.renderer.compile(this.scene, this.camera);
    } catch {
      /* optional */
    }
  }

  dispose(): void {
    for (const o of this.owned) disposeObject(o);
    this.reflector?.dispose();
    this.aoMesh.geometry.dispose();
    this.aoMat.dispose();
    this.shadowRT.dispose();
    this.shadowBlurRT.dispose();
    this.depthMat.dispose();
    this.hBlur.dispose();
    this.vBlur.dispose();
    this.blurPlane.geometry.dispose();
    this.shadowPlane.geometry.dispose();
    (this.shadowPlane.material as THREE.Material).dispose();
    this.blackTex.dispose();
    this.envTarget?.dispose();
    this.scene.environment = null;
  }
}

/** World AABB of the visible, solid meshes only (skips hidden parts, glows and beams that would inflate it). */
function solidBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const mesh = o as THREE.Mesh;
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    const m0 = Array.isArray(mat) ? mat[0] : mat;
    const glow = !!m0 && (m0.blending === THREE.AdditiveBlending || (m0.transparent && !m0.depthWrite) || m0.colorWrite === false);
    if (mesh.isMesh && mesh.geometry && !glow) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      box.union(tmp);
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return box;
}

/** Physics ride-height range (vehicle config) so the preview matches the drive; falls back to 6 cm. */
function physicsRideRange(): number {
  const v = (CONFIG as unknown as { vehicle?: { suspension?: { rideHeightRange?: number } } }).vehicle;
  const r = v?.suspension?.rideHeightRange;
  return typeof r === 'number' && Number.isFinite(r) ? r : 0.06;
}

/** Floor edge → cove → wall → cove → ceiling profile for the room lathe (radius, height). */
function roomProfile(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const F = FLOOR_R, C = COVE, W = WALL_TOP;
  pts.push(new THREE.Vector2(F - 0.6, -0.004));
  for (let i = 0; i <= 14; i++) {
    const a = -Math.PI / 2 + (i / 14) * (Math.PI / 2);
    pts.push(new THREE.Vector2(F + C * Math.cos(a), C + C * Math.sin(a)));
  }
  for (let y = C + 1.5; y < W; y += 1.5) pts.push(new THREE.Vector2(F + C, y));
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    pts.push(new THREE.Vector2(F + C * Math.cos(a), W + C * Math.sin(a)));
  }
  pts.push(new THREE.Vector2(0.001, W + C));
  return pts;
}
