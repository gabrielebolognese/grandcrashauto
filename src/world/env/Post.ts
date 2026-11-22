import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { PostProcessor } from '../../core/Engine';

/**
 * Bloom post chain for High quality, installed as `engine.post`:
 *   RenderPass (linear HDR, half-float, MSAA when the preset antialiases)
 *   → UnrealBloomPass (starts at half resolution; high threshold so only really bright things bloom:
 *     the sun, glitter on the sea, headlights, lit windows at night, explosions)
 *   → OutputPass (ACES tone mapping + sRGB exactly once — matches the non-post look).
 */
export class BloomPost implements PostProcessor {
  private composer: EffectComposer;
  private target: THREE.WebGLRenderTarget;
  private bloom: UnrealBloomPass;
  private output: OutputPass;
  private renderPass: RenderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, pixelRatio: number, samples: number) {
    this.target = new THREE.WebGLRenderTarget(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio), {
      type: THREE.HalfFloatType,
      samples,
    });
    this.target.texture.name = 'env.post.rt';
    this.composer = new EffectComposer(renderer, this.target);
    this.renderPass = new RenderPass(scene, camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(width * pixelRatio, height * pixelRatio), 0.3, 0.45, 1.6);
    this.output = new OutputPass();
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.setSize(width, height, pixelRatio);
  }

  setParams(strength: number, radius: number, threshold: number): void {
    this.bloom.strength = strength;
    this.bloom.radius = radius;
    this.bloom.threshold = threshold;
  }

  render(dt: number): void {
    this.composer.render(dt);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  dispose(): void {
    this.bloom.dispose();
    this.output.dispose();
    this.renderPass.dispose();
    this.composer.dispose();
    this.target.dispose();
  }
}
