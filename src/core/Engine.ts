import * as THREE from 'three';
import { CONFIG } from '../config';

/**
 * Renderer + main loop (spec §14). Owner: core.
 *  - Fixed-step simulation at CONFIG.physics.hz with render interpolation (alpha).
 *  - timeScale slows game time (explosion slow-mo) without changing the physics step size.
 *  - Pauses automatically while the tab is hidden.
 *  - `view` is what gets rendered: the main world scene by default; the garage swaps in its own scene/camera.
 *  - `post` (set by the environment module) renders the main scene with post-processing (bloom) when present.
 */

export interface RenderView {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export interface PostProcessor {
  render(dt: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

export interface FrameStats {
  fps: number;
  frameMs: number; // smoothed real frame time
  calls: number;
  triangles: number;
  renderScale: number;
  pixelRatio: number;
}

export class Engine {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  /** The main world scene and camera. */
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  view: RenderView;
  post: PostProcessor | null = null;

  timeScale = 1;
  /** Seconds of game time elapsed (scaled). */
  time = 0;
  /** Last real frame delta (unscaled, clamped). */
  realDt = 1 / 60;
  frame = 0;
  readonly stats: FrameStats = { fps: 60, frameMs: 16.7, calls: 0, triangles: 0, renderScale: 1, pixelRatio: 1 };

  /** Called every fixed tick (game logic + physics). */
  onFixed: (dt: number) => void = () => {};
  /** Called every rendered frame. dt = scaled game dt, alpha = interpolation factor. */
  onUpdate: (dt: number, alpha: number, realDt: number) => void = () => {};

  private running = false;
  private rafId = 0;
  private last = 0;
  private acc = 0;
  private renderScale = 1;
  private pixelRatioCap = 1.5;
  private width = 1;
  private height = 1;
  private hidden = false;

  constructor(container: HTMLElement, antialias: boolean) {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'game-canvas';
    container.appendChild(this.canvas);
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.env.exposure;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, CONFIG.camera.near, CONFIG.camera.far);
    this.scene.add(this.camera);
    this.view = { scene: this.scene, camera: this.camera };

    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      this.last = performance.now();
      this.acc = 0;
    });
    this.resize();
  }

  static supportsWebGL2(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!c.getContext('webgl2');
    } catch {
      return false;
    }
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  setPixelRatioCap(cap: number): void {
    this.pixelRatioCap = cap;
    this.applyPixelRatio();
  }

  /** 0.5..1 multiplier on top of the capped device pixel ratio (dynamic resolution). */
  setRenderScale(scale: number): void {
    const s = Math.min(1, Math.max(0.4, scale));
    if (Math.abs(s - this.renderScale) < 0.001) return;
    this.renderScale = s;
    this.applyPixelRatio();
  }

  getRenderScale(): number {
    return this.renderScale;
  }

  private applyPixelRatio(): void {
    const pr = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap) * this.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.post?.setSize(this.width, this.height, pr);
    this.stats.pixelRatio = pr;
    this.stats.renderScale = this.renderScale;
  }

  resize(): void {
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';
    for (const cam of new Set([this.camera, this.view.camera])) {
      cam.aspect = this.width / this.height;
      cam.updateProjectionMatrix();
    }
    this.applyPixelRatio();
  }

  setView(view: RenderView | null): void {
    this.view = view ?? { scene: this.scene, camera: this.camera };
    this.view.camera.aspect = this.width / this.height;
    this.view.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick(now: number): void {
    if (this.hidden) {
      this.last = now;
      return;
    }
    const realDt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.realDt = realDt;
    this.frame++;

    // Smoothed frame stats.
    const ms = realDt * 1000;
    this.stats.frameMs += (ms - this.stats.frameMs) * 0.05;
    this.stats.fps = 1000 / Math.max(1, this.stats.frameMs);

    const fixed = 1 / CONFIG.physics.hz;
    const scaled = realDt * this.timeScale;
    this.acc += scaled;
    let steps = 0;
    while (this.acc >= fixed && steps < CONFIG.physics.maxSubSteps) {
      this.onFixed(fixed);
      this.acc -= fixed;
      steps++;
    }
    if (steps >= CONFIG.physics.maxSubSteps) this.acc = Math.min(this.acc, fixed);
    const alpha = this.acc / fixed;
    this.time += scaled;

    this.onUpdate(scaled, alpha, realDt);
    this.render(scaled);
  }

  render(dt = 0): void {
    this.renderer.info.reset();
    if (this.post && this.view.scene === this.scene) this.post.render(dt);
    else this.renderer.render(this.view.scene, this.view.camera);
    this.stats.calls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }
}

/** Recursively dispose geometries, materials and textures of an object tree. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as any).material as THREE.Material | THREE.Material[] | undefined;
    if (mat) for (const mm of Array.isArray(mat) ? mat : [mat]) disposeMaterial(mm);
  });
}

export function disposeMaterial(mat: THREE.Material): void {
  for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
  mat.dispose();
}
