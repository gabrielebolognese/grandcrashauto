import * as THREE from 'three';
import { CONFIG } from '../config';
import { smoothstep } from '../core/math';

/** Global audio node / voice counters (exposed through window.__audioDebug in ?debug). */
export const audioStats = {
  persistentNodes: 0, // long-lived graph nodes (mixer, engine, ambience, vehicle loops)
  voiceNodes: 0, // nodes owned by live one-shot voices (must return to ~0 when quiet)
  voicesCreated: 0,
  voicesFreed: 0,
  stolen: 0,
  refused: 0,
};

/** Count a long-lived node. */
export function keep<T extends AudioNode>(n: T): T {
  audioStats.persistentNodes++;
  return n;
}

const lastTarget = new WeakMap<AudioParam, number>();

/**
 * Smoothly drive an AudioParam toward `v` (setTargetAtTime), skipping redundant automation events when the target
 * did not change. Only use on params that are exclusively driven by this helper (or call forgetParam after manual
 * automation).
 */
export function setSmooth(ac: BaseAudioContext, p: AudioParam, v: number, tau: number, eps = 1e-4): void {
  if (!Number.isFinite(v)) return;
  const l = lastTarget.get(p);
  if (l !== undefined && Math.abs(l - v) <= eps * Math.max(1, Math.abs(v))) return;
  lastTarget.set(p, v);
  p.setTargetAtTime(v, ac.currentTime, tau);
}

export function forgetParam(p: AudioParam): void {
  lastTarget.delete(p);
}

/** Envelope: 0 → amp (linear attack) → hold → exponential decay (time constant tau). */
export function envelope(p: AudioParam, t: number, amp: number, attack: number, hold: number, tau: number): number {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(amp, t + attack);
  if (hold > 0) p.setValueAtTime(amp, t + attack + hold);
  p.setTargetAtTime(0, t + attack + hold, Math.max(0.001, tau));
  return t + attack + hold + tau * 7; // ≈ -60 dB
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface SpatialResult {
  gain: number;
  pan: number;
  dist: number;
  cutoff: number;
}

/** Listener = the render camera. Cheap distance attenuation + stereo panning + air absorption (no HRTF). */
export class Listener {
  readonly pos = new THREE.Vector3();
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly fwd = new THREE.Vector3(0, 0, -1);
  private tmp = new THREE.Vector3();

  update(cam: THREE.Object3D): void {
    const m = cam.matrixWorld;
    this.pos.setFromMatrixPosition(m);
    this.right.setFromMatrixColumn(m, 0).normalize();
    this.fwd.setFromMatrixColumn(m, 2).multiplyScalar(-1).normalize();
  }

  /** maxDist: audibility limit (default spatial.maxDistance; big explosions / thunder / planes pass a larger one). */
  calc(p: Vec3Like, out: SpatialResult, ref: number = CONFIG.audio.spatial.refDistance, maxDist: number = CONFIG.audio.spatial.maxDistance): SpatialResult {
    const S = CONFIG.audio.spatial;
    const d = this.tmp.set(p.x - this.pos.x, p.y - this.pos.y, p.z - this.pos.z);
    const dist = d.length();
    let gain = dist <= ref ? 1 : ref / (ref + S.rolloff * (dist - ref));
    gain *= 1 - smoothstep(maxDist * 0.7, maxDist, dist);
    let pan = dist > 1e-3 ? d.dot(this.right) / dist : 0;
    pan *= S.panWidth * smoothstep(0.4, 4, dist);
    // air absorption: log-distance from airNear (full band) to ~3 km (airFarHz)
    const far = dist <= S.airNear ? 0 : Math.min(1, Math.log(dist / S.airNear) / Math.log(3000 / S.airNear));
    out.gain = gain;
    out.pan = Math.max(-1, Math.min(1, pan));
    out.dist = dist;
    out.cutoff = far <= 0 ? 20000 : 20000 * Math.pow(S.airFarHz / 20000, far);
    return out;
  }
}

let voiceIds = 0;

/** A one-shot (or held) sound: owns its nodes and sources, freed automatically when every source has ended. */
export class Voice {
  readonly id = ++voiceIds;
  readonly out: GainNode;
  readonly nodes: AudioNode[] = [];
  readonly srcs: AudioScheduledSourceNode[] = [];
  panner: StereoPannerNode | null = null;
  air: BiquadFilterNode | null = null;
  end: number;
  readonly start: number;
  stolen = false;
  freed = false;
  private ended = 0;

  constructor(
    private pool: VoicePool,
    readonly prio: number,
  ) {
    this.start = pool.ac.currentTime;
    this.end = this.start;
    this.out = this.add(pool.ac.createGain());
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    audioStats.voiceNodes++;
    return n;
  }

  /** Register + schedule a source node. */
  src<T extends AudioScheduledSourceNode>(s: T, t0: number, t1: number, offset = 0): T {
    this.add(s);
    if (s instanceof AudioBufferSourceNode) s.start(t0, offset);
    else s.start(t0);
    s.stop(t1);
    s.onended = this.onEnded;
    this.srcs.push(s);
    if (t1 > this.end) this.end = t1;
    return s;
  }

  /** Fade out and stop everything at `at` (held voices: horn, fire, alarm). */
  release(at: number, fade = 0.05): void {
    if (this.freed) return;
    const ac = this.pool.ac;
    const now = ac.currentTime;
    const g = this.out.gain;
    forgetParam(g);
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, Math.max(now + 0.005, at) + fade);
    const stopAt = Math.max(now + 0.01, at) + fade + 0.02;
    for (const s of this.srcs) {
      try {
        s.stop(stopAt);
      } catch {
        /* already stopped */
      }
    }
    this.end = stopAt;
  }

  private onEnded = (): void => {
    this.ended++;
    if (this.ended >= this.srcs.length) this.pool.free(this);
  };
}

/** Voice cap with priority stealing + leak-proof cleanup. */
export class VoicePool {
  readonly active: Voice[] = [];
  private dying: Voice[] = [];
  cap = 22;

  constructor(readonly ac: AudioContext) {}

  create(prio: number): Voice | null {
    if (this.active.length >= this.cap) {
      let victim: Voice | null = null;
      for (const v of this.active) {
        if (!victim || v.prio < victim.prio || (v.prio === victim.prio && v.start < victim.start)) victim = v;
      }
      if (!victim || victim.prio > prio) {
        audioStats.refused++;
        return null;
      }
      this.steal(victim);
    }
    const v = new Voice(this, prio);
    this.active.push(v);
    audioStats.voicesCreated++;
    return v;
  }

  steal(v: Voice): void {
    if (v.stolen || v.freed) return;
    v.stolen = true;
    audioStats.stolen++;
    v.release(this.ac.currentTime, 0.015);
    const i = this.active.indexOf(v);
    if (i >= 0) this.active.splice(i, 1);
    this.dying.push(v);
  }

  free(v: Voice): void {
    if (v.freed) return;
    v.freed = true;
    for (const s of v.srcs) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        /* never started / already stopped */
      }
    }
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    audioStats.voiceNodes -= v.nodes.length;
    audioStats.voicesFreed++;
    v.nodes.length = 0;
    v.srcs.length = 0;
    let i = this.active.indexOf(v);
    if (i >= 0) this.active.splice(i, 1);
    i = this.dying.indexOf(v);
    if (i >= 0) this.dying.splice(i, 1);
  }

  /** Safety sweep: free voices whose sources should have ended (onended can be lost while suspended). */
  update(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i];
      if (now > v.end + 0.75) this.free(v);
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      if (now > v.end + 0.5) this.free(v);
    }
  }

  get liveCount(): number {
    return this.active.length + this.dying.length;
  }

  stopAll(): void {
    for (const v of [...this.active]) this.steal(v);
  }
}
