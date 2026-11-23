import * as THREE from 'three';
import type { AvatarHandle } from '../game/contracts';
import type { Appearance } from './appearance';
import { CLIP, type ClipInfo } from './clips';
import { makeNpcDepthMaterial, makeNpcMaterial, type NpcUniforms } from './material';
import { buildHero } from './model';

/**
 * The player's on-foot character (walking in plane cabins, falling, on the ground): one hero-LOD instance of the
 * pedestrian GPU-skinned mesh, driven directly (clip crossfades, world matrix written each frame by the owner).
 */
export class Avatar implements AvatarHandle {
  readonly object: THREE.InstancedMesh;
  private animA: THREE.InstancedBufferAttribute;
  private animB: THREE.InstancedBufferAttribute;
  private clipA: number = CLIP.idle;
  private clipB: number = CLIP.idle;
  private tA = 0;
  private tB = 0;
  private rateA = 1;
  private rateB = 1;
  private wB = 0;
  private fadeRate = 4;
  private m = new THREE.Matrix4();
  private scl = new THREE.Matrix4();

  constructor(private clips: ClipInfo[], uniforms: NpcUniforms, private app: Appearance) {
    const g = buildHero();
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(4), 4).setUsage(THREE.DynamicDrawUsage);
    this.animA = mk();
    this.animB = mk();
    const col0 = mk(), col1 = mk(), extra = mk();
    g.setAttribute('iAnimA', this.animA);
    g.setAttribute('iAnimB', this.animB);
    g.setAttribute('iCol0', col0);
    g.setAttribute('iCol1', col1);
    g.setAttribute('iExtra', extra);
    (col0.array as Float32Array).set([app.skin, app.top, app.bottom, app.shoes]);
    (col1.array as Float32Array).set([app.hair, app.acc, app.inner, app.flags]);
    (extra.array as Float32Array).set([0, 0, app.shape, 0]);
    const mesh = new THREE.InstancedMesh(g, makeNpcMaterial(uniforms, false), 1);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.customDepthMaterial = makeNpcDepthMaterial(uniforms, false);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = 'player-avatar';
    mesh.userData.noOriginShift = true; // the owner writes absolute matrices every frame
    mesh.visible = false;
    this.object = mesh;
    this.scl.makeScale(app.scale, app.scale, app.scale);
  }

  get visible(): boolean {
    return this.object.visible;
  }
  set visible(v: boolean) {
    this.object.visible = v;
  }

  get clipDone(): boolean {
    const c = this.clips[this.clipA];
    return !c.loop && this.tA >= c.duration;
  }

  play(name: string, fade = 0.2, rate = 1, restart = false): void {
    const id = (CLIP as Record<string, number>)[name];
    if (id === undefined) return;
    if (this.clipA === id && !restart) {
      this.rateA = rate;
      return;
    }
    if (fade <= 0) {
      this.wB = 0;
    } else if (this.wB < 0.5) {
      this.clipB = this.clipA;
      this.tB = this.tA;
      this.rateB = this.rateA;
      this.wB = 1;
    }
    this.fadeRate = fade > 0 ? 1 / fade : 1e6;
    this.clipA = id;
    this.tA = 0;
    this.rateA = rate;
  }

  setMatrix(m: THREE.Matrix4): void {
    this.m.multiplyMatrices(m, this.scl);
    this.object.setMatrixAt(0, this.m);
    this.object.instanceMatrix.needsUpdate = true;
  }

  update(dt: number): void {
    this.tA += dt * this.rateA;
    this.tB += dt * this.rateB;
    this.wB = Math.max(0, this.wB - dt * this.fadeRate);
    const a = this.animA.array as Float32Array;
    const b = this.animB.array as Float32Array;
    this.rows(this.clipA, this.tA, a);
    a[3] = this.wB;
    this.rows(this.wB > 0.002 ? this.clipB : this.clipA, this.wB > 0.002 ? this.tB : this.tA, b);
    b[3] = 1; // fully faded in
    this.animA.needsUpdate = true;
    this.animB.needsUpdate = true;
  }

  private rows(clip: number, t: number, out: Float32Array): void {
    const c = this.clips[clip];
    let f = t * c.fps;
    let i0: number, i1: number, fr: number;
    if (c.loop) {
      f %= c.frames;
      if (f < 0) f += c.frames;
      i0 = Math.floor(f);
      fr = f - i0;
      i1 = (i0 + 1) % c.frames;
    } else {
      const max = c.frames - 1;
      if (f >= max) {
        i0 = i1 = max;
        fr = 0;
      } else {
        if (f < 0) f = 0;
        i0 = Math.floor(f);
        i1 = i0 + 1;
        fr = f - i0;
      }
    }
    out[0] = c.start + i0;
    out[1] = c.start + i1;
    out[2] = fr;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
    this.object.customDepthMaterial?.dispose();
    this.object.removeFromParent();
    this.object.dispose();
  }
}
