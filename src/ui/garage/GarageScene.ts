import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CONFIG } from '../../config';
import { disposeObject } from '../../core/Engine';
import type { CarVisual } from '../../game/contracts';
import type { CarBuild } from '../../vehicle/CarBuild';

/**
 * The garage studio (owner: garage): a pastel art-deco cyclorama with a slowly turning mirror platform.
 * Everything here is created once at init and kept for the session (opening the garage again costs nothing).
 * Lights are created once (key / fill / rim); reflections come from a PMREM of a custom studio environment.
 */

export const PLATFORM_R = 3.35;
export const PLATFORM_TOP = 0.11;
const ROOM_FLOOR_R = 16;
const ROOM_COVE = 5;
const ROOM_WALL_TOP = 11;
const COLUMN_R = 14.6;
/** Max camera distance from the orbit target (stays inside the column ring). */
export const ROOM_MAX_CAM_DIST = 13;

const DEG = Math.PI / 180;
const col = (hex: string) => new THREE.Color(hex);

// ───────────────────────────── shaders ─────────────────────────────
const LINE_AA = /* glsl */ `
float lineAA(float d, float w) { float f = max(fwidth(d), 1e-4); return 1.0 - smoothstep(w - f, w + f, abs(d)); }
`;

const ROOM_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const ROOM_FRAG = /* glsl */ `
uniform vec3 uFloorIn, uFloorOut, uRay, uGold, uWallLow, uWallMid, uWallTop, uNeonA, uNeonB, uRing;
uniform float uRingBoost, uPlatR, uTime;
varying vec3 vW;
${LINE_AA}
void main() {
  float r = length(vW.xz);
  float h = vW.y;
  float ang = atan(vW.z, vW.x);

  // ── floor: warm radial gradient, sunburst rays, gold rings, contact AO, neon spill ──
  vec3 fl = mix(uFloorIn, uFloorOut, smoothstep(3.0, 15.0, r));
  float s = fract(ang * (28.0 / 6.2831853));
  float aw = min(fwidth(s), 0.25);
  float band = smoothstep(0.5 - aw, 0.5 + aw, s) * (1.0 - smoothstep(1.0 - aw, 1.0, s));
  float rayZone = smoothstep(5.45, 5.6, r) * (1.0 - smoothstep(9.0, 9.15, r));
  fl = mix(fl, uRay, band * rayZone * 0.42);
  float rings = lineAA(r - 5.05, 0.04) + lineAA(r - 5.32, 0.018) + lineAA(r - 9.25, 0.035) + lineAA(r - 9.5, 0.016)
              + lineAA(r - 13.2, 0.03) * 0.7;
  fl = mix(fl, uGold, clamp(rings, 0.0, 1.0) * 0.9);
  fl *= mix(0.62, 1.0, smoothstep(uPlatR, uPlatR + 1.5, r));
  float spill = exp(-max(r - uPlatR - 0.08, 0.0) * 2.1) * step(uPlatR, r);
  fl += uRing * spill * (0.22 + 0.8 * uRingBoost);

  // ── wall: peach → rose → sky gradient, deco fluting, double neon band ──
  float wt = smoothstep(0.01, 1.4, h);
  vec3 wl = mix(uWallLow, uWallMid, smoothstep(0.0, 5.5, h));
  wl = mix(wl, uWallTop, smoothstep(5.0, 15.0, h));
  float flute = 0.5 + 0.5 * cos(ang * 120.0);
  wl *= 1.0 - 0.05 * flute * smoothstep(2.6, 5.0, h);
  float n1 = lineAA(h - 2.35, 0.03);
  float n2 = lineAA(h - 2.62, 0.02);
  float glow = exp(-abs(h - 2.48) * 2.2);
  wl += (uNeonA * 0.6 + uNeonB * 0.4) * glow * 0.22;
  wl = mix(wl, uNeonA, n1);
  wl = mix(wl, uNeonB, n2);

  vec3 c = mix(fl, wl, wt);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const DISC_SHADER = {
  name: 'GarageDiscShader',
  uniforms: {
    color: { value: null as THREE.Color | null },
    tDiffuse: { value: null as THREE.Texture | null },
    textureMatrix: { value: null as THREE.Matrix4 | null },
    uBase: { value: new THREE.Color() },
    uGold: { value: new THREE.Color() },
    uStrength: { value: 0.6 },
    uR: { value: PLATFORM_R },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec2 vP;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vP = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    uniform vec3 uBase, uGold;
    uniform float uStrength, uR;
    varying vec4 vUv;
    varying vec2 vP;
    ${LINE_AA}
    void main() {
      vec3 refl = texture2DProj(tDiffuse, vUv).rgb;
      float r = length(vP);
      float rn = r / uR;
      vec3 base = uBase * (1.0 + 0.35 * (1.0 - rn * rn));
      float g = r * 22.0;
      float grooveFade = 1.0 - smoothstep(0.15, 0.6, fwidth(g));
      base *= 1.0 - 0.06 * grooveFade * (0.5 + 0.5 * cos(g * 6.2831853));
      float a = atan(vP.y, vP.x);
      float tick = lineAA(fract(a * 16.0 / 6.2831853) - 0.5, 0.06) * step(0.86, rn) * step(rn, 0.9);
      float inlay = lineAA(r - uR * 0.925, 0.016) + lineAA(r - uR * 0.955, 0.007) + lineAA(r - uR * 0.36, 0.008) * 0.6 + tick;
      float k = uStrength * (1.0 - 0.35 * smoothstep(0.5, 1.0, rn));
      vec3 c = base * (1.0 - 0.45 * k) + refl * k;
      c = mix(c, uGold, clamp(inlay, 0.0, 1.0));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const SHADOW_VERT = /* glsl */ `
attribute float strength;
attribute float soft;
varying vec2 vUv;
varying float vS;
varying float vSoft;
void main() {
  vUv = uv;
  vS = strength;
  vSoft = soft;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SHADOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying float vS;
varying float vSoft;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  float a = 1.0 - smoothstep(1.0 - vSoft, 1.0, d);
  a *= a;
  gl_FragColor = vec4(uColor, a * vS * uOpacity);
  #include <colorspace_fragment>
}`;

// ───────────────────────────── scene ─────────────────────────────
export class GarageScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Rotates slowly; holds the car mount, the mirror disc and the contact shadow. */
  readonly turntable = new THREE.Group();
  /** Car parent (y offset used by the drop-in animation). */
  readonly carMount = new THREE.Group();
  visual: CarVisual | null = null;
  /** Car bounding box size at rest (local, unrotated) and the orbit target height. */
  readonly carSize = new THREE.Vector3(1.9, 1.4, 4.4);
  carCenterY = 0.75;

  private roomMat: THREE.ShaderMaterial;
  private ringMat!: THREE.MeshBasicMaterial;
  private ringBaseColor = col('#ff8a7a');
  private reflector: Reflector | null = null;
  private glossDisc: THREE.Mesh;
  private shadowMesh: THREE.Mesh;
  private shadowMat: THREE.ShaderMaterial;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private lights: { key: THREE.DirectionalLight; fill: THREE.HemisphereLight; rim: THREE.DirectionalLight };
  private owned: THREE.Object3D[] = [];
  private ringBoost = 0;
  private dropY = 0;
  private dropV = 0;
  private time = 0;
  private reflectionsWanted = true;
  private tmpSize = new THREE.Vector2();

  constructor(private renderer: THREE.WebGLRenderer) {
    this.camera = new THREE.PerspectiveCamera(CONFIG.garage.fov, 1, 0.1, 120);
    this.scene.background = col('#f6d9c8');

    // Room (floor + cove + wall + ceiling in one lathe), shaded procedurally.
    this.roomMat = new THREE.ShaderMaterial({
      vertexShader: ROOM_VERT,
      fragmentShader: ROOM_FRAG,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        uFloorIn: { value: col('#fbe7d6') },
        uFloorOut: { value: col('#f4cdbd') },
        uRay: { value: col('#ffffff') },
        uGold: { value: col('#d8ae62') },
        uWallLow: { value: col('#f7c9b9') },
        uWallMid: { value: col('#f2bfd2') },
        uWallTop: { value: col('#b9d6f2') },
        uNeonA: { value: col('#ff7d8e') },
        uNeonB: { value: col('#6fe3e0') },
        uRing: { value: this.ringBaseColor.clone() },
        uRingBoost: { value: 0 },
        uPlatR: { value: PLATFORM_R + 0.12 },
        uTime: { value: 0 },
      },
    });
    const room = new THREE.Mesh(new THREE.LatheGeometry(roomProfile(), 120), this.roomMat);
    room.renderOrder = -1;
    this.add(room);

    this.addColumns();
    this.addPlatform();

    // Mirror disc fallback (low quality): glossy dark acrylic lit by the environment.
    this.glossDisc = new THREE.Mesh(
      new THREE.CircleGeometry(PLATFORM_R - 0.02, 96),
      new THREE.MeshStandardMaterial({ color: col('#4d4868'), roughness: 0.16, metalness: 0.1 }),
    );
    this.glossDisc.rotation.x = -Math.PI / 2;
    this.glossDisc.position.y = PLATFORM_TOP;
    this.turntable.add(this.glossDisc);

    // Contact shadow (main body blob + one per wheel), merged into one mesh, rebuilt per model.
    this.shadowMat = new THREE.ShaderMaterial({
      vertexShader: SHADOW_VERT,
      fragmentShader: SHADOW_FRAG,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uColor: { value: col('#2a2440') }, uOpacity: { value: 1 } },
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.shadowMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.shadowMat);
    this.shadowMesh.position.y = PLATFORM_TOP + 0.004;
    this.shadowMesh.renderOrder = 2;
    this.turntable.add(this.shadowMesh);

    this.carMount.position.y = PLATFORM_TOP;
    this.turntable.add(this.carMount);
    this.scene.add(this.turntable);

    // Lights — created once, never added/removed later.
    const key = new THREE.DirectionalLight(col('#fff1dc'), CONFIG.garage.keyLight);
    key.position.set(5, 9, 6);
    const fill = new THREE.HemisphereLight(col('#e2e6ff'), col('#ffd2bf'), CONFIG.garage.fillLight);
    const rim = new THREE.DirectionalLight(col('#c5ecff'), CONFIG.garage.rimLight);
    rim.position.set(-6, 5, -8);
    this.scene.add(key, fill, rim);
    this.lights = { key, fill, rim };

    this.buildEnvironment();
  }

  private add(o: THREE.Object3D): void {
    this.scene.add(o);
    this.owned.push(o);
  }

  private addColumns(): void {
    const parts = [
      new THREE.BoxGeometry(1.3, 0.35, 1.3).translate(0, 0.175, 0),
      new THREE.BoxGeometry(0.95, 0.12, 0.95).translate(0, 0.41, 0),
      new THREE.BoxGeometry(0.8, 6.6, 0.8).translate(0, 3.77, 0),
      new THREE.BoxGeometry(1.05, 0.18, 1.05).translate(0, 7.12, 0),
      new THREE.BoxGeometry(1.25, 0.22, 1.25).translate(0, 7.32, 0),
      new THREE.BoxGeometry(0.9, 0.3, 0.9).translate(0, 7.58, 0),
      new THREE.BoxGeometry(0.5, 0.5, 0.5).translate(0, 7.98, 0),
    ];
    const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()));
    parts.forEach((g) => g.dispose());
    const n = 10;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05 });
    const columns = new THREE.InstancedMesh(geo, mat, n);
    const stripGeo = new THREE.BoxGeometry(0.08, 6.0, 0.04);
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const strips = new THREE.InstancedMesh(stripGeo, stripMat, n);
    const tints = ['#bfeee0', '#f9e3a6', '#d7cdf6', '#ffd0bd', '#bfe4f6'];
    const neon = ['#ff8fa3', '#7ee8e0', '#ffd27a', '#c2a6ff', '#7ee8e0'];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.31;
      p.set(Math.cos(a) * COLUMN_R, 0, Math.sin(a) * COLUMN_R);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a + Math.PI / 2);
      m.compose(p, q, s);
      columns.setMatrixAt(i, m);
      columns.setColorAt(i, col(tints[i % tints.length]));
      // Neon strip on the face looking at the platform.
      const inward = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
      p.addScaledVector(inward, 0.42).setY(3.85);
      m.compose(p, q, s);
      strips.setMatrixAt(i, m);
      strips.setColorAt(i, col(neon[i % neon.length]));
    }
    columns.frustumCulled = strips.frustumCulled = false;
    this.add(columns);
    this.add(strips);
  }

  private addPlatform(): void {
    const R = PLATFORM_R;
    const profile = [
      new THREE.Vector2(R + 0.16, 0),
      new THREE.Vector2(R + 0.16, 0.03),
      new THREE.Vector2(R + 0.1, 0.036),
      new THREE.Vector2(R + 0.1, 0.07),
      new THREE.Vector2(R + 0.08, 0.09),
      new THREE.Vector2(R + 0.03, PLATFORM_TOP - 0.004),
      new THREE.Vector2(R - 0.04, PLATFORM_TOP),
    ];
    const base = new THREE.Mesh(
      new THREE.LatheGeometry(profile, 128),
      new THREE.MeshStandardMaterial({ color: col('#e6c483'), metalness: 1, roughness: 0.26 }),
    );
    this.add(base);
    this.ringMat = new THREE.MeshBasicMaterial({ color: this.ringBaseColor.clone(), toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R + 0.105, 0.016, 8, 200), this.ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.053;
    this.add(ring);
  }

  /** Custom studio environment: pastel gradient dome + soft boxes and coloured strip lights → PMREM. */
  private buildEnvironment(): void {
    const env = new THREE.Scene();
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(30, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        toneMapped: false,
        uniforms: { uLow: { value: col('#b88d80') }, uMid: { value: col('#fff0e2') }, uTop: { value: col('#c9c6f0') } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 uLow,uMid,uTop; varying vec3 vD; void main(){ float y = vD.y; vec3 c = y < 0.0 ? mix(uMid, uLow, smoothstep(0.0, 0.5, -y)) : mix(uMid, uTop, smoothstep(0.0, 0.7, y)); gl_FragColor = vec4(c * 0.85, 1.0); }',
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
    panel(16, 5, '#ffffff', 5.0, 0, 15, 0); // overhead soft box
    panel(1.4, 12, '#fff3e6', 3.2, 15, 5, 3); // side strips
    panel(1.4, 12, '#fff3e6', 3.2, -15, 5, -3);
    panel(18, 0.9, '#ff9a8c', 2.4, 0, 2.6, 15); // coral front strip
    panel(18, 0.9, '#7fe6e2', 2.4, 0, 2.6, -15); // aqua back strip
    panel(6, 3, '#ffe6b8', 2.0, 10, 7, -10); // warm kicker
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pmrem.fromScene(env, 0.025, 0.1, 100);
    pmrem.dispose();
    disposeObject(env);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = CONFIG.garage.envIntensity;
  }

  /** Mirror reflections on the platform (medium/high) or the cheap glossy disc (low). */
  setReflections(on: boolean, highQuality: boolean): void {
    this.reflectionsWanted = on;
    if (on && !this.reflector) {
      const shader = { ...DISC_SHADER, uniforms: DISC_SHADER.uniforms };
      this.reflector = new Reflector(new THREE.CircleGeometry(PLATFORM_R - 0.02, 96), {
        textureWidth: 512,
        textureHeight: 512,
        clipBias: 0.002,
        multisample: highQuality ? 4 : 0,
        shader,
      });
      const u = (this.reflector.material as THREE.ShaderMaterial).uniforms;
      u.uBase.value = col('#3f3a5c');
      u.uGold.value = col('#e2bb72');
      u.uStrength.value = CONFIG.garage.reflectionStrength;
      u.uR.value = PLATFORM_R - 0.02;
      this.reflector.rotation.x = -Math.PI / 2;
      this.reflector.position.y = PLATFORM_TOP;
      this.turntable.add(this.reflector);
      this.resizeReflection();
    }
    if (this.reflector) this.reflector.visible = on;
    this.glossDisc.visible = !on;
  }

  resizeReflection(): void {
    if (!this.reflector) return;
    this.renderer.getDrawingBufferSize(this.tmpSize);
    const k = CONFIG.garage.reflectionScale;
    const w = Math.max(64, Math.min(1280, Math.round(this.tmpSize.x * k)));
    const h = Math.max(64, Math.min(1280, Math.round(this.tmpSize.y * k)));
    const rt = this.reflector.getRenderTarget();
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
  }

  /** Put a (new) car visual on the platform. The caller owns disposal of the previous one. */
  setCar(visual: CarVisual | null, animate: boolean): void {
    if (this.visual) this.carMount.remove(this.visual.root);
    this.visual = visual;
    if (!visual) return;
    this.carMount.add(visual.root);
    visual.root.position.set(0, 0, 0);
    visual.root.rotation.set(0, 0, 0);
    this.measureCar();
    this.rebuildShadow();
    if (animate) {
      this.dropY = 0.55;
      this.dropV = 0;
      this.ringBoost = 1;
    }
  }

  /** Re-measure framing + contact shadow after a build change that alters the car's shape (wheels, kit). */
  refreshCar(): void {
    this.measureCar();
    this.rebuildShadow();
  }

  private measureCar(): void {
    const v = this.visual;
    if (!v) return;
    const prevRot = this.turntable.rotation.y;
    this.turntable.rotation.y = 0;
    const prevY = this.carMount.position.y;
    this.carMount.position.y = PLATFORM_TOP;
    v.root.position.y = 0;
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(v.root);
    this.turntable.rotation.y = prevRot;
    this.carMount.position.y = prevY;
    if (box.isEmpty()) {
      this.carSize.set(1.9, 1.4, 4.4);
      this.carCenterY = PLATFORM_TOP + 0.7;
      return;
    }
    box.getSize(this.carSize);
    const ground = this.groundOffset();
    // Height above the platform, measured from the wheel contact plane.
    const top = box.max.y - PLATFORM_TOP - ground;
    this.carSize.y = Math.max(0.8, top);
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

  private rebuildShadow(): void {
    const v = this.visual;
    const old = this.shadowMesh.geometry;
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
      const hx = Math.max(v.dims.halfExtents.x, 0.7);
      const hz = Math.max(v.dims.halfExtents.z, 1.6);
      quad(hx * 2 * 1.45, hz * 2 * 1.28, 0, 0, 0.5, 0.75);
      quad(hx * 2 * 1.05, hz * 2 * 1.02, 0, 0, 0.32, 0.55);
      const r = v.dims.wheelRadius;
      const w = v.dims.wheelWidth;
      for (const p of v.dims.wheelPositions) quad(w * 1.9, r * 1.5, p.x, p.z, 0.75, 0.9);
    }
    this.shadowMesh.geometry = quads.length ? mergeGeometries(quads) : new THREE.BufferGeometry();
    quads.forEach((g) => g.dispose());
    old.dispose();
  }

  /** Ride height / camber / showroom steer preview on the visual's wheel pivots. */
  applyStance(build: CarBuild): void {
    const v = this.visual;
    if (!v) return;
    const cfg = CONFIG.garage;
    const rh = build.stance.rideHeight;
    const dy = rh >= 0 ? rh * cfg.rideHeightLift : rh * cfg.rideHeightDrop;
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
    this.shadowMat.uniforms.uOpacity.value = 1 - Math.max(0, rh) * 0.25;
  }

  /** Paint-ish accent for the neon ring (follows the car's underglow or body colour). */
  setAccent(hex: string): void {
    this.ringBaseColor.set(hex);
  }

  update(dt: number, spinSpeed: number): void {
    this.time += dt;
    this.turntable.rotation.y += spinSpeed * dt;
    if (this.turntable.rotation.y > Math.PI * 2) this.turntable.rotation.y -= Math.PI * 2;

    // Drop-in spring for new cars.
    if (this.dropY !== 0 || this.dropV !== 0) {
      const k = 190, c = 15;
      this.dropV += (-k * this.dropY - c * this.dropV) * dt;
      this.dropY += this.dropV * dt;
      if (this.dropY < 0 && this.dropV < 0) {
        this.dropY = 0;
        this.dropV = -this.dropV * 0.25; // tiny bounce off the platform
        if (this.dropV < 0.15) this.dropV = 0;
      }
      this.carMount.position.y = PLATFORM_TOP + this.dropY;
      this.shadowMat.uniforms.uOpacity.value = Math.max(0.2, 1 - this.dropY * 1.4);
    }

    // Neon ring: gentle breathing + boost on changes, eased toward the accent colour.
    this.ringBoost = Math.max(0, this.ringBoost - dt * 1.6);
    const breathe = 0.9 + 0.1 * Math.sin(this.time * 2.2);
    const target = this.ringBaseColor;
    const cur = this.roomMat.uniforms.uRing.value as THREE.Color;
    cur.lerp(target, 1 - Math.exp(-dt * 4));
    this.ringMat.color.copy(cur).multiplyScalar(breathe + this.ringBoost * 0.6);
    this.roomMat.uniforms.uRingBoost.value = this.ringBoost;
    this.roomMat.uniforms.uTime.value = this.time;

    this.visual?.update(dt);
    if (this.reflector && this.reflectionsWanted) this.resizeReflection();
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
    this.glossDisc.geometry.dispose();
    (this.glossDisc.material as THREE.Material).dispose();
    this.shadowMesh.geometry.dispose();
    this.shadowMat.dispose();
    this.envTarget?.dispose();
    this.scene.environment = null;
    void this.lights;
  }
}

/** Floor → cove → wall → cove → ceiling profile for the lathe (radius, height). */
function roomProfile(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const F = ROOM_FLOOR_R, C = ROOM_COVE, W = ROOM_WALL_TOP;
  pts.push(new THREE.Vector2(0.001, 0));
  for (let r = 1; r < F; r += 1) pts.push(new THREE.Vector2(r, 0));
  for (let i = 0; i <= 12; i++) {
    const a = -Math.PI / 2 + (i / 12) * (Math.PI / 2);
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
