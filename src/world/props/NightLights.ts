import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import type { GameContext } from '../../game/contracts';
import { makeGlowMaterial, makePoolMaterial } from './materials';

const GLOW_CAP = 900;
const POOL_CAP = 420;
const CAND_CAP = 256;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

interface LightSlot {
  light: THREE.PointLight;
  x: number;
  y: number;
  z: number;
  cur: number;
  assigned: boolean;
}

/**
 * Night lighting for props (owner: props): additive glow sprites on lamp heads and car lamps, fake light pools on the
 * ground, and a fixed POOL of real PointLights (created once at init — never added/removed at runtime) moved to the
 * nearest lit streetlights every ~0.5 s; `quality.current.realtimeLights` of them are enabled (the rest stay at 0).
 */
export class NightLights {
  private glow: THREE.InstancedMesh;
  private glowA: THREE.InstancedBufferAttribute;
  private pool: THREE.InstancedMesh;
  private poolA: THREE.InstancedBufferAttribute;
  private nGlow = 0;
  private nPool = 0;
  private active = false;
  private slots: LightSlot[] = [];
  private cand = new Float32Array(CAND_CAP * 4);
  private nCand = 0;
  private candReady = new Float32Array(CAND_CAP * 4);
  private nCandReady = 0;
  private timer = 0;
  private lampCol = new THREE.Color('#ffc98a');
  private camPos = new THREE.Vector3();

  constructor(private ctx: GameContext) {
    const glowMat = makeGlowMaterial();
    const quad = new THREE.PlaneGeometry(1, 1);
    this.glowA = new THREE.InstancedBufferAttribute(new Float32Array(GLOW_CAP * 4), 4);
    this.glowA.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aGlow', this.glowA);
    this.glow = new THREE.InstancedMesh(quad, glowMat, GLOW_CAP);
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const disc = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.poolA = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAP * 4), 4);
    this.poolA.setUsage(THREE.DynamicDrawUsage);
    disc.setAttribute('aGlow', this.poolA);
    this.pool = new THREE.InstancedMesh(disc, makePoolMaterial(), POOL_CAP);
    this.pool.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (const m of [this.glow, this.pool]) {
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.castShadow = m.receiveShadow = false;
      m.userData.noOriginShift = true;
    }
    this.glow.renderOrder = 3;
    this.pool.renderOrder = 2;
    this.glow.name = 'props:glow';
    this.pool.name = 'props:pools';
  }

  init(): void {
    const { engine, quality } = this.ctx;
    engine.scene.add(this.glow, this.pool);
    // Fixed pool: max over presets (desktop) — on mobile only what the current preset enables (each point light costs
    // fragment time in every lit material even at intensity 0).
    const presets = CONFIG.quality.presets as Record<string, { realtimeLights?: number }>;
    let n = 0;
    for (const k in presets) n = Math.max(n, presets[k].realtimeLights ?? 0);
    if (quality.isMobile) n = Math.min(n, quality.current.realtimeLights ?? n);
    for (let i = 0; i < n; i++) {
      const light = new THREE.PointLight(this.lampCol, 0, CONFIG.props.lightDistance, 2);
      light.castShadow = false;
      light.position.set(0, -1000, 0);
      light.userData.noOriginShift = true;
      light.name = `props:streetLight${i}`;
      engine.scene.add(light);
      this.slots.push({ light, x: 0, y: -1000, z: 0, cur: 0, assigned: false });
    }
  }

  get lightCount(): number {
    return this.slots.length;
  }

  /** Warm-up: one hidden glow + pool so their programs/buffers exist before play. */
  warmup(): void {
    this.begin(true, this.camPos);
    this.lamp(0, -500, 0, 1, 1, -500.5, false, 1e9);
    this.end();
  }

  /** Start collecting lamps for this cull pass. */
  begin(active: boolean, camPos: THREE.Vector3): void {
    this.active = active;
    this.camPos.copy(camPos);
    this.nGlow = 0;
    this.nPool = 0;
    this.nCand = 0;
  }

  lamp(x: number, y: number, z: number, size: number, poolR: number, groundY: number, candidate: boolean, d2: number): void {
    if (!this.active) return;
    const gi = CONFIG.props.glowIntensity;
    this.addGlow(x, y, z, size, 1.0 * gi, 0.8 * gi, 0.52 * gi, 1.15);
    if (poolR > 0 && this.nPool < POOL_CAP && d2 < 180 * 180) {
      const i = this.nPool++;
      _m.compose(_p.set(x, groundY + 0.06, z), _q.identity(), _s.set(poolR, 1, poolR));
      _m.toArray(this.pool.instanceMatrix.array as Float32Array, i * 16);
      const pi = CONFIG.props.poolIntensity;
      const a = this.poolA.array as Float32Array;
      a[i * 4] = 1.0;
      a[i * 4 + 1] = 0.76;
      a[i * 4 + 2] = 0.48;
      a[i * 4 + 3] = pi;
    }
    if (candidate && this.nCand < CAND_CAP) {
      const c = this.nCand++ * 4;
      this.cand[c] = x;
      this.cand[c + 1] = y;
      this.cand[c + 2] = z;
      this.cand[c + 3] = d2;
    }
  }

  carGlow(x: number, y: number, z: number, rear: boolean): void {
    if (!this.active) return;
    if (rear) this.addGlow(x, y, z, 0.55, 1.0, 0.1, 0.06, 1.0);
    else this.addGlow(x, y, z, 0.8, 1.0, 0.93, 0.8, 1.0);
  }

  private addGlow(x: number, y: number, z: number, size: number, r: number, g: number, b: number, k: number): void {
    if (this.nGlow >= GLOW_CAP) return;
    const i = this.nGlow++;
    _m.compose(_p.set(x, y, z), _q.identity(), _s.set(size, size, size));
    _m.toArray(this.glow.instanceMatrix.array as Float32Array, i * 16);
    const a = this.glowA.array as Float32Array;
    a[i * 4] = r;
    a[i * 4 + 1] = g;
    a[i * 4 + 2] = b;
    a[i * 4 + 3] = k;
  }

  end(): void {
    for (const [m, n, attr] of [[this.glow, this.nGlow, this.glowA], [this.pool, this.nPool, this.poolA]] as const) {
      m.count = n;
      m.visible = n > 0;
      if (n > 0) {
        m.instanceMatrix.clearUpdateRanges();
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * 4);
        attr.needsUpdate = true;
      }
    }
    // keep the latest candidate list for the (slower) light assignment
    for (let k = 0; k < this.nCand * 4; k++) this.candReady[k] = this.cand[k];
    this.nCandReady = this.nCand;
  }

  /** Real-light assignment + fades. */
  update(dt: number): void {
    const night = GLOBAL_UNIFORMS.uNight.value;
    const enabled = Math.min(this.slots.length, night > 0.05 ? this.ctx.quality.current.realtimeLights ?? 0 : 0);
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = CONFIG.props.lightUpdate;
      this.assign(enabled);
    }
    const target = CONFIG.props.lightIntensity * Math.min(1, night * 1.25);
    const k = Math.min(1, dt * 5);
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const t = s.assigned && i < this.slots.length ? target : 0;
      s.cur += (t - s.cur) * k;
      if (s.cur < 0.01 && t === 0) s.cur = 0;
      s.light.intensity = s.cur;
      s.light.distance = CONFIG.props.lightDistance;
    }
  }

  private assign(enabled: number): void {
    // choose the nearest `enabled` candidates (partial selection on d2)
    const n = this.nCandReady;
    const c = this.candReady;
    const chosen: number[] = this.chosenTmp;
    chosen.length = 0;
    for (let k = 0; k < enabled && k < n; k++) {
      let best = -1, bd = Infinity;
      for (let j = 0; j < n; j++) {
        if (chosen.includes(j)) continue;
        const d = c[j * 4 + 3];
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      if (best < 0) break;
      chosen.push(best);
    }
    // keep lights already sitting on a chosen lamp
    const taken = this.takenTmp;
    taken.length = 0;
    for (const s of this.slots) s.assigned = false;
    for (const j of chosen) {
      const x = c[j * 4], y = c[j * 4 + 1], z = c[j * 4 + 2];
      for (const s of this.slots) {
        if (!s.assigned && Math.abs(s.x - x) < 0.3 && Math.abs(s.z - z) < 0.3 && Math.abs(s.y - y) < 0.3) {
          s.assigned = true;
          taken.push(j);
          break;
        }
      }
    }
    for (const j of chosen) {
      if (taken.includes(j)) continue;
      const s = this.slots.find((q) => !q.assigned);
      if (!s) break;
      s.x = c[j * 4];
      s.y = c[j * 4 + 1] - 0.25;
      s.z = c[j * 4 + 2];
      s.light.position.set(s.x, s.y, s.z);
      s.cur = 0;
      s.assigned = true;
    }
  }

  private chosenTmp: number[] = [];
  private takenTmp: number[] = [];

  shift(dx: number, dz: number): void {
    for (const s of this.slots) {
      s.x -= dx;
      s.z -= dz;
      s.light.position.set(s.x, s.y, s.z);
    }
    for (let j = 0; j < this.nCandReady; j++) {
      this.candReady[j * 4] -= dx;
      this.candReady[j * 4 + 2] -= dz;
    }
  }

  dispose(): void {
    const scene = this.ctx.engine.scene;
    scene.remove(this.glow, this.pool);
    this.glow.geometry.dispose();
    (this.glow.material as THREE.Material).dispose();
    this.pool.geometry.dispose();
    (this.pool.material as THREE.Material).dispose();
    this.glow.dispose();
    this.pool.dispose();
    for (const s of this.slots) {
      scene.remove(s.light);
      s.light.dispose();
    }
    this.slots.length = 0;
  }
}
