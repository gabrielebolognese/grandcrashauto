import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import type { PostProcessor } from '../../core/Engine';

/**
 * Post processing, installed as `engine.post` by the Environment:
 *  - BloomPost (High): RenderPass (linear HDR half-float, MSAA when the preset antialiases) → UnrealBloomPass (from
 *    half resolution, high threshold: sun, sea glitter, headlights, lit windows, explosions, lightning) → turbo
 *    radial blur + chromatic aberration (only enabled while boosting) → OutputPass (ACES + sRGB exactly once).
 *  - TurboDirect (Medium / bloom off, only while boosting): renders the scene to the screen exactly like the normal
 *    path (same shader programs → no recompiles/hitches), copies the framebuffer, and draws the blur on top.
 */

const TURBO_GLSL = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uBlur;
uniform float uAberr;
uniform vec2 uCenter;
varying vec2 vUv;
void main() {
  vec2 dir = vUv - uCenter;
  float d = length(dir);
  float k = smoothstep(0.12, 0.75, d);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float s = 1.0 - uBlur * k * float(i) / 5.0;
    vec2 uv = uCenter + dir * s;
    vec2 ca = dir * uAberr * k * 40.0 * uBlur;
    acc.r += texture2D(tDiffuse, uv + ca).r;
    acc.g += texture2D(tDiffuse, uv).g;
    acc.b += texture2D(tDiffuse, uv - ca).b;
  }
  gl_FragColor = vec4(acc / 6.0, 1.0);
}
`;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function turboUniforms() {
  return {
    tDiffuse: { value: null as THREE.Texture | null },
    uBlur: { value: 0 },
    uAberr: { value: 0.0045 },
    uCenter: { value: new THREE.Vector2(0.5, 0.52) },
  };
}

export class BloomPost implements PostProcessor {
  private composer: EffectComposer;
  private target: THREE.WebGLRenderTarget;
  private bloom: UnrealBloomPass;
  private turbo: ShaderPass;
  private output: OutputPass;
  private renderPass: RenderPass;

  private renderer: THREE.WebGLRenderer;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, pixelRatio: number, samples: number) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio), {
      type: THREE.HalfFloatType,
      samples,
    });
    this.target.texture.name = 'env.post.rt';
    this.composer = new EffectComposer(renderer, this.target);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width * pixelRatio, height * pixelRatio), 0.3, 0.45, 1.6);
    this.turbo = new ShaderPass({ uniforms: turboUniforms(), vertexShader: VERT, fragmentShader: TURBO_GLSL });
    this.turbo.enabled = false;
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.turbo);
    this.composer.addPass(this.output);
    this.setSize(width, height, pixelRatio);
  }

  setParams(strength: number, radius: number, threshold: number): void {
    this.bloom.strength = strength;
    this.bloom.radius = radius;
    this.bloom.threshold = threshold;
  }

  setTurbo(blur: number, aberr: number): void {
    this.turbo.enabled = blur > 0.002;
    this.turbo.uniforms.uBlur.value = blur;
    this.turbo.uniforms.uAberr.value = aberr;
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  /**
   * Compile the normally-disabled turbo pass for the composer's render target (no full render: the scene/bloom
   * programs get compiled by the regular warm-up frames that render through this composer).
   */
  warm(): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const scene = new THREE.Scene();
    const geo = new THREE.PlaneGeometry(2, 2);
    scene.add(new THREE.Mesh(geo, this.turbo.material));
    r.setRenderTarget(this.target);
    r.compile(scene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
    r.setRenderTarget(prev);
    geo.dispose();
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  dispose(): void {
    this.bloom.dispose();
    this.turbo.dispose();
    this.output.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}

export class TurboDirect implements PostProcessor {
  private fbTex: THREE.FramebufferTexture | null = null;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private geo = new THREE.PlaneGeometry(2, 2);
  private size = new THREE.Vector2();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
  ) {
    this.mat = new THREE.ShaderMaterial({
      name: 'env.turboDirect',
      uniforms: turboUniforms(),
      vertexShader: VERT,
      fragmentShader: TURBO_GLSL, // input is already tone-mapped sRGB: no output conversion
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(this.geo, this.mat);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  setTurbo(blur: number, aberr: number): void {
    this.mat.uniforms.uBlur.value = blur;
    this.mat.uniforms.uAberr.value = aberr;
  }

  render(): void {
    const r = this.renderer;
    r.render(this.scene, this.camera);
    r.getDrawingBufferSize(this.size);
    if (!this.fbTex || this.fbTex.image.width !== this.size.x || this.fbTex.image.height !== this.size.y) {
      this.fbTex?.dispose();
      this.fbTex = new THREE.FramebufferTexture(this.size.x, this.size.y);
      this.fbTex.minFilter = THREE.LinearFilter;
      this.fbTex.magFilter = THREE.LinearFilter;
    }
    r.copyFramebufferToTexture(this.fbTex);
    this.mat.uniforms.tDiffuse.value = this.fbTex;
    r.render(this.quadScene, this.quadCam);
  }

  setSize(): void {
    // The framebuffer texture follows the drawing buffer size lazily in render().
  }

  /** Compile the quad program (screen target) behind the loading screen — no render. */
  warm(): void {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(null);
    r.compile(this.quadScene, this.quadCam);
    r.setRenderTarget(prev);
  }

  dispose(): void {
    this.fbTex?.dispose();
    this.mat.dispose();
    this.geo.dispose();
  }
}
