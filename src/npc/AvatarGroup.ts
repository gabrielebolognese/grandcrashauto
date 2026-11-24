import * as THREE from 'three';
import type { AvatarGroupHandle } from '../game/contracts';
import type { Appearance } from './appearance';
import { CLIP, type ClipInfo } from './clips';
import { makeNpcMaterial, type NpcUniforms } from './material';
import { buildMid } from './model';

interface InstState {
  clipA: number;
  clipB: number;
  tA: number;
  tB: number;
  rateA: number;
  rateB: number;
  wB: number;
  fadeRate: number;
  scale: number;
  hidden: boolean;
}

const _m = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * A small group of independently animated people in ONE draw call (plane passengers, flight attendants): mid-LOD
 * pedestrian mesh, GPU skinning from the shared clip texture, per-instance clip crossfades and world matrices written
 * by the owner every frame (absolute, noOriginShift). Same look and clips as the pedestrians / the player avatar.
 */
export class AvatarGroup implements AvatarGroupHandle {
  readonly object: THREE.InstancedMesh;
  readonly count: number;
  private animA: THREE.InstancedBufferAttribute;
  private animB: THREE.InstancedBufferAttribute;
  private st: InstState[] = [];
  private fill = { value: 0 };

  constructor(private clips: ClipInfo[], uniforms: NpcUniforms, apps: Appearance[]) {
    const n = Math.max(1, apps.length);
    this.count = apps.length;
    const g = buildMid();
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.animA = mk();
    this.animB = mk();
    const col0 = mk(), col1 = mk(), extra = mk();
    g.setAttribute('iAnimA', this.animA);
    g.setAttribute('iAnimB', this.animB);
    g.setAttribute('iCol0', col0);
    g.setAttribute('iCol1', col1);
    g.setAttribute('iExtra', extra);
    apps.forEach((a, i) => {
      (col0.array as Float32Array).set([a.skin, a.top, a.bottom, a.shoes], i * 4);
      (col1.array as Float32Array).set([a.hair, a.acc, a.inner, a.flags], i * 4);
      (extra.array as Float32Array).set([0, 0, a.shape, 0], i * 4);
      this.st.push({ clipA: CLIP.sit, clipB: CLIP.sit, tA: (i * 0.37) % 4, tB: 0, rateA: 1, rateB: 1, wB: 0, fadeRate: 4, scale: a.scale, hidden: true });
    });
    const mat = makeNpcMaterial(uniforms, false);
    // cabin lights: the same emissive fill as the player avatar
    const base = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      base.call(mat, sh, r);
      sh.uniforms.uAvatarFill = this.fill;
      sh.fragmentShader = sh.fragmentShader
        .replace('void main() {', 'uniform float uAvatarFill;\nvoid main() {')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uAvatarFill;');
    };
    mat.customProgramCacheKey = () => 'npc-skin-v2-avatar';
    const mesh = new THREE.InstancedMesh(g, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'cabin-people';
    mesh.userData.noOriginShift = true;
    for (let i = 0; i < n; i++) mesh.setMatrixAt(i, ZERO);
    mesh.count = apps.length;
    this.object = mesh;
  }

  play(i: number, name: string, fade = 0.2, rate = 1, restart = false): void {
    const s = this.st[i];
    const id = (CLIP as Record<string, number>)[name];
    if (!s || id === undefined) return;
    if (s.clipA === id && !restart) {
      s.rateA = rate;
      return;
    }
    if (fade <= 0) s.wB = 0;
    else if (s.wB < 0.5) {
      s.clipB = s.clipA;
      s.tB = s.tA;
      s.rateB = s.rateA;
      s.wB = 1;
    }
    s.fadeRate = fade > 0 ? 1 / fade : 1e6;
    s.clipA = id;
    s.tA = 0;
    s.rateA = rate;
  }

  clipDone(i: number): boolean {
    const s = this.st[i];
    if (!s) return true;
    const c = this.clips[s.clipA];
    return !c.loop && s.tA >= c.duration;
  }

  setMatrix(i: number, m: THREE.Matrix4): void {
    const s = this.st[i];
    if (!s) return;
    s.hidden = false;
    _s.makeScale(s.scale, s.scale, s.scale);
    _m.multiplyMatrices(m, _s);
    this.object.setMatrixAt(i, _m);
    this.object.instanceMatrix.needsUpdate = true;
  }

  hide(i: number): void {
    const s = this.st[i];
    if (!s || s.hidden) return;
    s.hidden = true;
    this.object.setMatrixAt(i, ZERO);
    this.object.instanceMatrix.needsUpdate = true;
  }

  setFill(level: number): void {
    this.fill.value = level;
  }

  update(dt: number): void {
    const a = this.animA.array as Float32Array;
    const b = this.animB.array as Float32Array;
    for (let i = 0; i < this.st.length; i++) {
      const s = this.st[i];
      s.tA += dt * s.rateA;
      s.tB += dt * s.rateB;
      s.wB = Math.max(0, s.wB - dt * s.fadeRate);
      const o = i * 4;
      this.rows(s.clipA, s.tA, a, o);
      a[o + 3] = s.wB;
      if (s.wB > 0.002) this.rows(s.clipB, s.tB, b, o);
      else this.rows(s.clipA, s.tA, b, o);
      b[o + 3] = 1;
    }
    this.animA.needsUpdate = true;
    this.animB.needsUpdate = true;
  }

  private rows(clip: number, t: number, out: Float32Array, o: number): void {
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
    out[o] = c.start + i0;
    out[o + 1] = c.start + i1;
    out[o + 2] = fr;
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
    this.object.removeFromParent();
    this.object.dispose();
  }
}
