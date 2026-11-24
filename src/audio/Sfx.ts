import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp } from '../core/math';
import type { GameEvents } from '../core/events';
import type { SfxBank } from './bakes';
import type { BusName, Mixer } from './Mixer';
import { Listener, Voice, VoicePool, envelope, setSmooth, type SpatialResult, type Vec3Like } from './Voices';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
function pick<T>(a: readonly T[]): T | undefined {
  return a.length ? a[Math.floor(Math.random() * a.length)] : undefined;
}

type NoiseColor = 'white' | 'pink' | 'brown';
type Grain = [dt: number, amp: number, tau: number];
export type VocalKind = 'whoa' | 'hey' | 'ah' | 'eek' | 'scream' | 'oof';

const VOWELS: Record<string, [number, number, number]> = {
  a: [800, 1200, 2500],
  ae: [700, 1700, 2600],
  e: [550, 1850, 2500],
  i: [300, 2300, 3000],
  o: [500, 900, 2400],
  u: [350, 800, 2300],
};
interface VocalSpec {
  dur: number;
  v: [number, string][]; // [time fraction, vowel]
  p: [number, number][]; // [time fraction, pitch multiplier]
  breath: number;
  vib: number; // vibrato depth (fraction of f0)
  vibHz: number;
  level: number;
}
/** Short, cartoonish, non-verbal reactions (formant synthesis). */
const VOCALS: Record<VocalKind, VocalSpec> = {
  whoa: { dur: 0.42, v: [[0, 'u'], [0.3, 'o'], [0.7, 'a']], p: [[0, 1.0], [0.35, 1.35], [1, 0.95]], breath: 0.15, vib: 0.015, vibHz: 5, level: 1 },
  hey: { dur: 0.3, v: [[0, 'e'], [0.6, 'i']], p: [[0, 1.2], [0.4, 1.45], [1, 1.25]], breath: 0.5, vib: 0.01, vibHz: 6, level: 1 },
  ah: { dur: 0.24, v: [[0, 'a']], p: [[0, 1.3], [0.3, 1.5], [1, 1.15]], breath: 0.3, vib: 0.01, vibHz: 6, level: 0.9 },
  eek: { dur: 0.36, v: [[0, 'i']], p: [[0, 2.5], [0.3, 3.0], [1, 2.4]], breath: 0.1, vib: 0.03, vibHz: 7, level: 0.75 },
  scream: { dur: 0.72, v: [[0, 'a'], [0.6, 'ae']], p: [[0, 2.1], [0.25, 2.5], [0.75, 2.3], [1, 1.7]], breath: 0.15, vib: 0.04, vibHz: 6.5, level: 0.85 },
  oof: { dur: 0.2, v: [[0, 'u'], [0.5, 'o']], p: [[0, 1.1], [1, 0.78]], breath: 0.6, vib: 0, vibHz: 5, level: 0.9 },
};

/** A held, moving voice (horn, fire, alarm): spatial params re-evaluated every frame. */
export class Held {
  readonly pos = new THREE.Vector3();
  dead = false;
  constructor(
    readonly v: Voice,
    readonly ref: number,
    public base: number,
    readonly maxDist: number = CONFIG.audio.spatial.maxDistance,
  ) {}
  stop(fade = 0.3): void {
    if (this.dead) return;
    this.dead = true;
    this.v.release(this.v.out.context.currentTime, fade);
  }
}

export interface VoiceOpts {
  ref?: number;
  send?: number;
  gain?: number;
  /** Audibility limit (m). Default CONFIG.audio.spatial.maxDistance. */
  maxDist?: number;
}

/**
 * Procedural one-shot library. Every sound is a Voice from the pool (capped, stolen by priority, auto-freed);
 * recipes are built from a few primitives: enveloped oscillators, filtered noise from shared buffers, modal partials,
 * baked buffers and noise "grain" trains.
 */
export class Sfx {
  private sp: SpatialResult = { gain: 1, pan: 0, dist: 0, cutoff: 20000 };
  private readonly hasPanner: boolean;
  private held: Held[] = [];
  private lastImpactT = -1;
  private lastImpactS = 0;
  private lastPropT = -1;
  private lastParkedT = -1;
  private lastGlassT = -1;
  private lastAlarmT = -100;
  private lastStartleT = -1;
  private vocalEnds: number[] = [];
  private hornCurve: Float32Array<ArrayBuffer>;
  readonly counts: Record<string, number> = {};

  constructor(
    private ac: AudioContext,
    private mixer: Mixer,
    readonly pool: VoicePool,
    private listener: Listener,
    private bank: SfxBank,
  ) {
    this.hasPanner = typeof ac.createStereoPanner === 'function';
    const c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) {
      const x = (i / (c.length - 1)) * 2 - 1;
      c[i] = Math.tanh(3 * x) / Math.tanh(3);
    }
    this.hornCurve = c;
  }

  get now(): number {
    return this.ac.currentTime;
  }

  private count(k: string): void {
    this.counts[k] = (this.counts[k] ?? 0) + 1;
  }

  // ─────────────────────────────── voice plumbing ───────────────────────────────
  /** Voice routed to a bus, spatialized at `pos` (centred if null). Null when inaudible or refused by the cap. */
  voice(bus: BusName, prio: number, pos: Vec3Like | null, o: VoiceOpts = {}, forceSpatialNodes = false): Voice | null {
    let gain = o.gain ?? 1;
    let pan = 0;
    let cutoff = 20000;
    if (pos) {
      this.listener.calc(pos, this.sp, o.ref, o.maxDist);
      gain *= this.sp.gain;
      pan = this.sp.pan;
      cutoff = this.sp.cutoff;
    }
    if (gain < 0.002 && !forceSpatialNodes) return null;
    const v = this.pool.create(prio);
    if (!v) return null;
    const ac = this.ac;
    v.out.gain.value = gain;
    let node: AudioNode = v.out;
    if (pos && (cutoff < 16000 || forceSpatialNodes)) {
      const f = v.add(ac.createBiquadFilter());
      f.type = 'lowpass';
      f.Q.value = 0.5;
      f.frequency.value = cutoff;
      node.connect(f);
      node = f;
      v.air = f;
    }
    if (pos && this.hasPanner) {
      const p = v.add(ac.createStereoPanner());
      p.pan.value = pan;
      node.connect(p);
      node = p;
      v.panner = p;
    }
    const b = this.mixer.buses[bus];
    node.connect(b.input);
    if (o.send && b.send) {
      const s = v.add(ac.createGain());
      s.gain.value = o.send;
      node.connect(s);
      s.connect(b.send);
    }
    return v;
  }

  /** Held voice that follows a position each frame. */
  holdVoice(bus: BusName, prio: number, pos: Vec3Like, o: VoiceOpts = {}): Held | null {
    const v = this.voice(bus, prio, pos, o, true);
    if (!v) return null;
    const h = new Held(v, o.ref ?? CONFIG.audio.spatial.refDistance, o.gain ?? 1, o.maxDist);
    h.pos.set(pos.x, pos.y, pos.z);
    this.held.push(h);
    return h;
  }

  updateHeld(): void {
    const ac = this.ac;
    for (let i = this.held.length - 1; i >= 0; i--) {
      const h = this.held[i];
      if (h.dead || h.v.freed || h.v.stolen) {
        h.dead = true;
        this.held.splice(i, 1);
        continue;
      }
      this.listener.calc(h.pos, this.sp, h.ref, h.maxDist);
      setSmooth(ac, h.v.out.gain, this.sp.gain * h.base, 0.05, 1e-3);
      if (h.v.panner) setSmooth(ac, h.v.panner.pan, this.sp.pan, 0.05, 1e-3);
      if (h.v.air) setSmooth(ac, h.v.air.frequency, this.sp.cutoff, 0.1, 1e-2);
    }
  }

  /** Floating origin: cached held positions move with the world. */
  shiftHeld(dx: number, dz: number): void {
    for (const h of this.held) {
      h.pos.x -= dx;
      h.pos.z -= dz;
    }
  }

  // ─────────────────────────────── primitives ───────────────────────────────
  private osc(v: Voice, d: AudioNode, t: number, type: OscillatorType, f0: number, f1: number, glide: number, amp: number, attack: number, tau: number, hold = 0): OscillatorNode {
    const ac = this.ac;
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + Math.max(0.005, glide));
    const g = v.add(ac.createGain());
    const end = envelope(g.gain, t, amp, attack, hold, tau);
    o.connect(g);
    g.connect(d);
    v.src(o, t, end + 0.01);
    return o;
  }

  private thump(v: Voice, d: AudioNode, t: number, amp: number, f0 = 80, f1 = 40, tau = 0.1): void {
    this.osc(v, d, t, 'sine', f0, f1, tau * 1.3, amp, 0.002, tau);
  }

  private noise(v: Voice, d: AudioNode, t: number, color: NoiseColor, ftype: BiquadFilterType | null, f0: number, f1: number, q: number, amp: number, attack: number, tau: number, hold = 0, rate = 1): void {
    const buf = this.bank[color];
    if (!buf) return;
    const ac = this.ac;
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    let n: AudioNode = s;
    if (ftype) {
      const f = v.add(ac.createBiquadFilter());
      f.type = ftype;
      f.Q.value = q;
      f.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + attack + hold + tau * 3);
      n.connect(f);
      n = f;
    }
    const g = v.add(ac.createGain());
    const end = envelope(g.gain, t, amp, attack, hold, tau);
    n.connect(g);
    g.connect(d);
    v.src(s, t, end + 0.01, Math.random() * Math.max(0, buf.duration - 1));
  }

  /** Train of noise bursts on ONE source (rattles, bounces, flutter). */
  private grains(v: Voice, d: AudioNode, t: number, color: NoiseColor, ftype: BiquadFilterType, f: number, q: number, grains: Grain[]): void {
    const buf = this.bank[color];
    if (!buf || !grains.length) return;
    const ac = this.ac;
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    const fl = v.add(ac.createBiquadFilter());
    fl.type = ftype;
    fl.frequency.value = f;
    fl.Q.value = q;
    const g = v.add(ac.createGain());
    g.gain.setValueAtTime(0, t);
    let end = t;
    for (const [dt, a, tau] of grains) {
      const tt = t + dt;
      g.gain.setTargetAtTime(a, tt, 0.0015);
      g.gain.setTargetAtTime(0, tt + 0.006, tau);
      end = Math.max(end, tt + 0.006 + tau * 7);
    }
    s.connect(fl);
    fl.connect(g);
    g.connect(d);
    v.src(s, t, end + 0.01, Math.random() * Math.max(0, buf.duration - 1));
  }

  /** Modal ring: inharmonic sine partials. */
  private partials(v: Voice, d: AudioNode, t: number, f0: number, ratios: number[], amps: number[], taus: number[], amp: number): void {
    for (let k = 0; k < ratios.length; k++) {
      const f = f0 * ratios[k];
      if (f > 16000) continue;
      this.osc(v, d, t, 'sine', f, f, 0, amp * amps[k], 0.0008, taus[k]);
    }
  }

  private play(v: Voice, d: AudioNode, t: number, buf: AudioBuffer | null | undefined, rate: number, amp: number, lpHz = 0): boolean {
    if (!buf) return false;
    const ac = this.ac;
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    let n: AudioNode = s;
    if (lpHz > 0 && lpHz < 16000) {
      const f = v.add(ac.createBiquadFilter());
      f.type = 'lowpass';
      f.frequency.value = lpHz;
      f.Q.value = 0.5;
      n.connect(f);
      n = f;
    }
    const g = v.add(ac.createGain());
    g.gain.value = amp;
    n.connect(g);
    g.connect(d);
    v.src(s, t, t + buf.duration / rate + 0.02);
    return true;
  }

  // ─────────────────────────────── materials ───────────────────────────────
  private metal(v: Voice, d: AudioNode, t: number, s: number, amp: number, f0 = rnd(240, 540) - s * 90): void {
    this.thump(v, d, t, amp * 0.85, 95, 45, 0.06 + 0.08 * s);
    const k = 0.5 + s;
    this.partials(v, d, t, f0, [1, 2.41, 3.93, 5.62], [1, 0.6, 0.4, 0.25], [0.32 * k, 0.2 * k, 0.13 * k, 0.08 * k], amp * 0.16);
    this.noise(v, d, t, 'white', 'bandpass', 2600, 1800, 0.9, amp * 0.5, 0.001, 0.03 + 0.06 * s);
  }

  private plastic(v: Voice, d: AudioNode, t: number, s: number, amp: number): void {
    this.noise(v, d, t, 'white', 'bandpass', 1300, 1000, 1.6, amp * 0.95, 0.001, 0.035 + 0.03 * s);
    this.osc(v, d, t, 'triangle', 240, 150, 0.06, amp * 0.5, 0.002, 0.045);
    this.noise(v, d, t, 'white', 'highpass', 3500, 3500, 0.7, amp * 0.35, 0.0005, 0.01);
  }

  private wood(v: Voice, d: AudioNode, t: number, s: number, amp: number): void {
    this.noise(v, d, t, 'white', 'bandpass', 430, 430, 9, amp * 2.4, 0.001, 0.09 + 0.05 * s);
    this.noise(v, d, t, 'white', 'bandpass', 1150, 1150, 7, amp * 1.1, 0.001, 0.06);
    this.thump(v, d, t, amp * 0.5, 130, 75, 0.05);
  }

  private concrete(v: Voice, d: AudioNode, t: number, s: number, amp: number): void {
    this.thump(v, d, t, amp, 75, 38, 0.1 + 0.1 * s);
    this.noise(v, d, t, 'brown', 'lowpass', 700, 300, 0.7, amp * 0.9, 0.002, 0.08 + 0.05 * s);
    this.noise(v, d, t, 'white', 'bandpass', 1800, 1400, 0.7, amp * 0.3, 0.001, 0.035);
  }

  private foliage(v: Voice, d: AudioNode, t: number, amp: number): void {
    const g: Grain[] = [];
    let tt = 0;
    for (let k = 0; k < 6; k++) {
      g.push([tt, amp * 0.5 * (1 - k * 0.12), rnd(0.03, 0.07)]);
      tt += rnd(0.03, 0.08);
    }
    this.grains(v, d, t, 'white', 'bandpass', rnd(2600, 3800), 0.7, g);
    this.thump(v, d, t, amp * 0.35, 100, 60, 0.05);
  }

  private flesh(v: Voice, d: AudioNode, t: number, amp: number): void {
    this.thump(v, d, t, amp * 0.9, 120, 65, 0.07);
    this.noise(v, d, t, 'brown', 'lowpass', 800, 400, 0.7, amp * 0.7, 0.002, 0.05);
  }

  private soft(v: Voice, d: AudioNode, t: number, amp: number, hiss: number): void {
    this.thump(v, d, t, amp * 0.6, 85, 50, 0.07);
    this.noise(v, d, t, 'pink', 'lowpass', 900, 500, 0.7, amp * 0.6, 0.003, 0.09);
    this.noise(v, d, t, 'white', 'highpass', hiss, hiss, 0.7, amp * 0.25, 0.01, 0.15);
  }

  private water(v: Voice, d: AudioNode, t: number, s: number, amp: number): void {
    this.noise(v, d, t, 'pink', 'bandpass', 900, 320, 0.9, amp * 1.1, 0.004, 0.22 + 0.15 * s);
    this.noise(v, d, t, 'white', 'highpass', 3000, 2000, 0.7, amp * 0.4, 0.01, 0.2);
  }

  private glassHit(v: Voice, d: AudioNode, t: number, s: number, amp: number): void {
    if (s > 0.35 && this.play(v, d, t, pick(this.bank.glass), rnd(0.9, 1.15), amp * 0.9)) return;
    this.partials(v, d, t, rnd(3000, 5500), [1, 1.48, 2.1], [1, 0.6, 0.35], [0.05, 0.035, 0.02], amp * 0.35);
    this.noise(v, d, t, 'white', 'highpass', 4000, 4000, 0.7, amp * 0.3, 0.0005, 0.015);
  }

  // ─────────────────────────────── game events ───────────────────────────────
  impact(e: GameEvents['impact']): void {
    const C = CONFIG.audio.impacts;
    const s = clamp(Number.isFinite(e.strength) ? e.strength : 0, 0, 1);
    if (s < C.minStrength) return;
    const now = this.now;
    if (now - this.lastImpactT < C.cooldownMs / 1000 && s < this.lastImpactS * 1.5) return;
    this.lastImpactT = now;
    this.lastImpactS = s;
    const amp = C.level * (0.12 + 0.88 * Math.pow(s, 0.85));
    const v = this.voice('sfx', 3 + s * 5, e.position, { send: 0.08 + s * 0.22 });
    if (!v) return;
    this.count('impact');
    const t = now + 0.004;
    const d = v.out;
    const m = e.material;
    switch (m) {
      case 'metal':
        this.metal(v, d, t, s, amp);
        break;
      case 'glass':
        this.glassHit(v, d, t, s, amp);
        this.thump(v, d, t, amp * 0.5, 90, 50, 0.06);
        break;
      case 'plastic':
        this.plastic(v, d, t, s, amp);
        break;
      case 'wood':
        this.wood(v, d, t, s, amp);
        break;
      case 'foliage':
        this.foliage(v, d, t, amp);
        break;
      case 'flesh':
        this.flesh(v, d, t, amp);
        break;
      case 'sand':
        this.soft(v, d, t, amp, 2800);
        break;
      case 'grass':
        this.soft(v, d, t, amp, 1800);
        break;
      case 'water':
        this.water(v, d, t, s, amp);
        break;
      default:
        this.concrete(v, d, t, s, amp);
    }
    // our own body crumpling on hard hits
    if (s > C.crunchFrom && m !== 'foliage' && m !== 'flesh' && m !== 'water' && m !== 'sand' && m !== 'grass') {
      this.play(v, d, t, pick(this.bank.crunch), rnd(0.85, 1.15) - s * 0.12, amp * Math.min(1, (s - C.crunchFrom) * 1.8 + 0.25), 2500 + s * 11000);
    }
  }

  propHit(e: GameEvents['propHit']): void {
    const C = CONFIG.audio.impacts;
    const now = this.now;
    if (now - this.lastPropT < 0.035) return;
    this.lastPropT = now;
    const s = clamp(e.speed / 14, 0.1, 1);
    const amp = C.propLevel * (0.25 + 0.75 * s);
    const v = this.voice('sfx', 4, e.position, { send: 0.12 });
    if (!v) return;
    this.count('prop');
    const t = now + 0.003;
    const d = v.out;
    switch (e.kind) {
      case 'cone':
        this.osc(v, d, t, 'sine', 330, 210, 0.07, amp * 0.8, 0.002, 0.07);
        this.noise(v, d, t, 'white', 'bandpass', 900, 700, 3, amp * 0.9, 0.001, 0.05);
        this.grains(v, d, t + 0.16, 'white', 'bandpass', 850, 2.5, [[0, amp * 0.4, 0.03], [0.14, amp * 0.22, 0.025], [0.24, amp * 0.1, 0.02]]);
        break;
      case 'bin':
        this.thump(v, d, t, amp * 0.7, 110, 60, 0.08);
        this.partials(v, d, t, rnd(170, 210), [1, 1.73, 2.9, 4.2], [1, 0.7, 0.5, 0.3], [0.25, 0.18, 0.12, 0.08], amp * 0.3);
        this.grains(v, d, t + 0.05, 'white', 'bandpass', 2200, 1.5, [[0, amp * 0.3, 0.02], [0.07, amp * 0.25, 0.02], [0.15, amp * 0.2, 0.02], [0.26, amp * 0.12, 0.02], [0.4, amp * 0.06, 0.02]]);
        break;
      case 'barrier':
        this.plastic(v, d, t, s, amp);
        this.wood(v, d, t + 0.01, s, amp * 0.6);
        this.grains(v, d, t + 0.2, 'white', 'bandpass', 1400, 2, [[0, amp * 0.3, 0.03], [0.17, amp * 0.15, 0.03]]);
        break;
      case 'bench':
        this.thump(v, d, t, amp, 65, 38, 0.12);
        this.wood(v, d, t, s, amp * 0.8);
        this.partials(v, d, t, rnd(500, 700), [1, 2.7, 4.4], [1, 0.5, 0.3], [0.2, 0.12, 0.08], amp * 0.15);
        break;
      case 'hydrant':
        this.thump(v, d, t, amp, 80, 45, 0.1);
        this.partials(v, d, t, rnd(140, 170), [1, 2.7, 5.1], [1, 0.5, 0.3], [0.3, 0.2, 0.1], amp * 0.3);
        break;
      case 'sign':
        this.partials(v, d, t, rnd(200, 260), [1, 1.58, 2.24, 3.1], [1, 0.8, 0.5, 0.3], [0.6, 0.45, 0.3, 0.2], amp * 0.25);
        this.noise(v, d, t, 'white', 'bandpass', 2000, 1500, 1, amp * 0.3, 0.001, 0.02);
        break;
      case 'streetlight':
      case 'trafficLight':
        this.partials(v, d, t, rnd(100, 125), [1, 2.76, 5.4, 8.9], [1, 0.6, 0.35, 0.2], [0.9, 0.5, 0.3, 0.15], amp * 0.35);
        this.thump(v, d, t, amp * 0.6, 80, 45, 0.1);
        break;
      case 'palm':
      case 'tree':
        this.foliage(v, d, t, amp);
        this.wood(v, d, t, s, amp * 0.5);
        break;
      case 'busStop':
        this.metal(v, d, t, s, amp * 0.7);
        this.glassHit(v, d, t, s, amp * 0.6);
        break;
      default:
        this.plastic(v, d, t, s, amp);
    }
  }

  parkedCarHit(e: GameEvents['parkedCarHit']): void {
    const C = CONFIG.audio.impacts;
    const now = this.now;
    if (now - this.lastParkedT < 0.08) return;
    this.lastParkedT = now;
    const s = clamp(e.speed / 12, 0.08, 1);
    const amp = C.parkedLevel * (0.2 + 0.8 * s);
    const v = this.voice('sfx', 6, e.position, { send: 0.15 + s * 0.15 });
    if (v) {
      this.count('parked');
      const t = now + 0.003;
      const d = v.out;
      this.thump(v, d, t, amp, 85, 40, 0.1 + 0.08 * s);
      if (s > 0.2) this.play(v, d, t, pick(this.bank.crunch), rnd(0.8, 1.05), amp * (0.4 + 0.6 * s), 2000 + 10000 * s);
      const k = 0.5 + s;
      this.partials(v, d, t, rnd(150, 260), [1, 2.2, 3.4, 4.9], [1, 0.6, 0.35, 0.2], [0.4 * k, 0.25 * k, 0.15 * k, 0.1 * k], amp * 0.12);
      this.noise(v, d, t, 'white', 'bandpass', 2400, 1600, 0.8, amp * 0.4, 0.001, 0.04);
    }
    if (e.speed >= C.alarmMinSpeed && now - this.lastAlarmT > C.alarmCooldown && Math.random() < C.alarmChance) this.alarm(e.position);
  }

  glassBreak(e: GameEvents['glassBreak']): void {
    const C = CONFIG.audio.impacts;
    const now = this.now;
    if (now - this.lastGlassT < 0.06) return;
    this.lastGlassT = now;
    const v = this.voice('sfx', 6, e.position, { send: 0.15 });
    if (!v) return;
    this.count('glass');
    const t = now + 0.003;
    const d = v.out;
    if (e.shattered) {
      if (!this.play(v, d, t, pick(this.bank.glass), rnd(0.9, 1.12), C.glassLevel)) this.glassHit(v, d, t, 0.2, C.glassLevel);
    } else {
      this.noise(v, d, t, 'white', 'highpass', 2500, 2500, 0.7, C.glassLevel * 0.5, 0.0003, 0.012);
      this.partials(v, d, t + 0.01, rnd(3500, 6000), [1, 1.37, 1.93], [1, 0.6, 0.4], [0.04, 0.03, 0.02], C.glassLevel * 0.3);
    }
  }

  partDetached(e: GameEvents['partDetached']): void {
    const amp = CONFIG.audio.impacts.partLevel;
    const v = this.voice('sfx', 5, e.position, { send: 0.15 });
    if (!v) return;
    this.count('part');
    const t = this.now + 0.003;
    const d = v.out;
    const p = (e.part || '').toLowerCase();
    if (p.includes('wheel') || p.includes('tyre') || p.includes('tire')) {
      const times = [0, 0.38, 0.66, 0.86, 1.0];
      const amps = [1, 0.6, 0.38, 0.22, 0.12];
      for (let k = 0; k < times.length; k++) this.thump(v, d, t + times[k], amp * amps[k], 140, 80, 0.06);
      this.partials(v, d, t, rnd(600, 900), [1, 2.4, 3.9], [1, 0.6, 0.3], [0.15, 0.1, 0.06], amp * 0.15);
    } else if (/bumper|spoiler|splitter|skirt|mirror|light|scoop/.test(p)) {
      this.plastic(v, d, t, 0.6, amp);
      this.grains(v, d, t + 0.22, 'white', 'bandpass', 1300, 1.6, [[0, amp * 0.45, 0.03], [0.16, amp * 0.25, 0.025], [0.27, amp * 0.12, 0.02]]);
    } else {
      this.partials(v, d, t, rnd(150, 240), [1, 1.5, 2.3, 3.4], [1, 0.7, 0.5, 0.3], [0.45, 0.35, 0.25, 0.15], amp * 0.22);
      this.noise(v, d, t, 'white', 'bandpass', 1800, 1200, 0.9, amp * 0.5, 0.001, 0.06);
      this.thump(v, d, t, amp * 0.6, 100, 55, 0.08);
      this.grains(v, d, t + 0.3, 'white', 'bandpass', 1500, 1.2, [[0, amp * 0.35, 0.05], [0.2, amp * 0.15, 0.04]]);
    }
  }

  /** Original car-alarm pattern: two-tone → sweeps → pulses. */
  alarm(pos: Vec3Like): void {
    const C = CONFIG.audio.impacts;
    const v = this.voice('sfx', 4, pos, { send: 0.2, ref: 10 });
    if (!v) return;
    this.lastAlarmT = this.now;
    this.count('alarm');
    const ac = this.ac;
    const t = this.now + 0.15;
    const dur = C.alarmSeconds;
    const L = C.alarmLevel;
    const o = ac.createOscillator();
    o.type = 'square';
    const bp = v.add(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    const g = v.add(ac.createGain());
    const f = o.frequency;
    let tt = t;
    for (let i = 0; tt < t + dur * 0.4; i++, tt += 0.25) f.setValueAtTime(i % 2 ? 980 : 680, tt);
    for (; tt < t + dur * 0.7; tt += 0.18) {
      f.setValueAtTime(600, tt);
      f.linearRampToValueAtTime(1400, tt + 0.17);
    }
    f.setValueAtTime(1100, tt);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(L, t + 0.02);
    g.gain.setValueAtTime(L, tt);
    for (; tt < t + dur; tt += 0.125) {
      g.gain.setTargetAtTime(L, tt, 0.004);
      g.gain.setTargetAtTime(0, tt + 0.0625, 0.004);
    }
    g.gain.setTargetAtTime(0, t + dur, 0.01);
    o.connect(bp);
    bp.connect(g);
    g.connect(v.out);
    v.src(o, t, t + dur + 0.08);
  }

  explosion(pos: Vec3Like, force: number): void {
    const E = CONFIG.audio.explosion;
    const t = this.now + 0.008;
    const f = clamp(Number.isFinite(force) ? force : 1, 0.3, 2);
    const v = this.voice('sfx', 10, pos, { send: E.reverbSend, ref: 30 });
    if (v) {
      this.count('explosion');
      if (!this.play(v, v.out, t, pick(this.bank.boom), rnd(0.86, 1.0), E.boomLevel * (0.75 + 0.25 * f))) {
        this.thump(v, v.out, t, E.boomLevel, 110, 30, 0.5);
        this.noise(v, v.out, t, 'brown', 'lowpass', 2500, 150, 0.7, E.boomLevel, 0.003, 0.6);
      }
      this.osc(v, v.out, t, 'sine', 62, 32, 0.5, 0.5 * E.boomLevel, 0.003, 0.35);
    }
    const dv = this.voice('sfx', 7, pos, { send: 0.3, ref: 20 });
    if (dv) this.play(dv, dv.out, t + 0.14, pick(this.bank.debris), rnd(0.94, 1.08), E.debrisLevel);
  }

  startFire(pos: Vec3Like, level = CONFIG.audio.explosion.fireLevel, ref = 9, maxDist?: number): Held | null {
    const E = CONFIG.audio.explosion;
    const fire = this.bank.fire;
    if (!fire) return null;
    const h = this.holdVoice('sfx', 9, pos, { send: 0.1, ref, maxDist });
    if (!h) return null;
    this.count('fire');
    const ac = this.ac;
    const v = h.v;
    const t = this.now;
    const s = ac.createBufferSource();
    s.buffer = fire;
    s.loop = true;
    const g = v.add(ac.createGain());
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + E.fireFadeIn);
    s.connect(g);
    g.connect(v.out);
    v.src(s, t, t + 3600, Math.random() * fire.duration);
    v.end = t + 3600;
    return h;
  }

  /** Two-tone car horn (held). Frequencies per model. */
  horn(pos: Vec3Like, freqs: readonly number[]): Held | null {
    const h = this.holdVoice('sfx', 8, pos, { send: 0.14, gain: 1 });
    if (!h) return null;
    this.count('horn');
    const ac = this.ac;
    const v = h.v;
    const t = this.now + 0.003;
    const L = CONFIG.audio.horn.level;
    const shaper = v.add(ac.createWaveShaper());
    shaper.curve = this.hornCurve;
    const pre = v.add(ac.createGain());
    pre.gain.value = 0.55;
    const bp = v.add(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.6;
    const pk = v.add(ac.createBiquadFilter());
    pk.type = 'peaking';
    pk.frequency.value = 2400;
    pk.gain.value = 5;
    pk.Q.value = 1;
    const lp = v.add(ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    const env = v.add(ac.createGain());
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(L, t + 0.012);
    for (let i = 0; i < 2; i++) {
      const f = freqs[i] ?? 400 * (i ? 1.25 : 1);
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = i ? 4 : -3;
      o.frequency.setValueAtTime(f * 0.94, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
      o.connect(pre);
      v.src(o, t, t + 600);
    }
    pre.connect(shaper);
    shaper.connect(bp);
    bp.connect(pk);
    pk.connect(lp);
    lp.connect(env);
    env.connect(v.out);
    v.end = t + 600;
    return h;
  }

  vocal(pos: Vec3Like, kind: VocalKind, delay = 0, gainMul = 1): void {
    const N = CONFIG.audio.npc;
    const now = this.now;
    let active = 0;
    for (let i = this.vocalEnds.length - 1; i >= 0; i--) {
      if (this.vocalEnds[i] < now) this.vocalEnds.splice(i, 1);
      else active++;
    }
    if (active >= N.maxConcurrent) return;
    const spec = VOCALS[kind];
    const level = (kind === 'scream' || kind === 'eek' ? N.screamLevel : N.level) * spec.level * gainMul;
    const v = this.voice('sfx', 5, pos, { send: 0.16, ref: 6 });
    if (!v) return;
    this.count('vocal');
    const ac = this.ac;
    const female = Math.random() < 0.5;
    const f0 = female ? rnd(195, 255) : rnd(110, 150);
    const fs = female ? 1.16 : 1;
    const t = now + 0.01 + delay;
    const dur = spec.dur * rnd(0.9, 1.15);
    const src = ac.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(f0 * spec.p[0][1], t);
    for (let i = 1; i < spec.p.length; i++) src.frequency.linearRampToValueAtTime(f0 * spec.p[i][1], t + spec.p[i][0] * dur);
    if (spec.vib > 0) {
      const lfo = ac.createOscillator();
      lfo.frequency.value = spec.vibHz * rnd(0.9, 1.1);
      const lg = v.add(ac.createGain());
      lg.gain.value = f0 * spec.p[0][1] * spec.vib;
      lfo.connect(lg);
      lg.connect(src.frequency);
      v.src(lfo, t, t + dur + 0.05);
    }
    const sum = v.add(ac.createGain());
    const Q = [5, 8, 10];
    const G = [3, 1.65, 0.9];
    for (let k = 0; k < 3; k++) {
      const bp = v.add(ac.createBiquadFilter());
      bp.type = 'bandpass';
      bp.Q.value = Q[k];
      const v0 = VOWELS[spec.v[0][1]];
      bp.frequency.setValueAtTime(v0[k] * fs, t);
      for (let i = 1; i < spec.v.length; i++) bp.frequency.linearRampToValueAtTime(VOWELS[spec.v[i][1]][k] * fs, t + spec.v[i][0] * dur);
      const g = v.add(ac.createGain());
      g.gain.value = G[k];
      src.connect(bp);
      bp.connect(g);
      g.connect(sum);
    }
    const env = v.add(ac.createGain());
    const rel = Math.min(0.12, dur * 0.4);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(level, t + 0.03);
    env.gain.linearRampToValueAtTime(level * 0.85, t + dur - rel);
    env.gain.linearRampToValueAtTime(0, t + dur);
    const lp = v.add(ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 3800;
    sum.connect(env);
    env.connect(lp);
    lp.connect(v.out);
    this.noise(v, v.out, t, 'white', 'bandpass', 1600 * fs, 1200 * fs, 1, level * spec.breath, 0.005, kind === 'oof' ? 0.07 : 0.035);
    v.src(src, t, t + dur + 0.05);
    this.vocalEnds.push(t + dur);
  }

  npcStartled(e: GameEvents['npcStartled']): void {
    const now = this.now;
    if (now - this.lastStartleT < CONFIG.audio.npc.cooldownMs / 1000) return;
    this.lastStartleT = now;
    const n = Math.max(1, Math.min(Math.round(e.count) || 1, e.scream ? 3 : 2, CONFIG.audio.npc.maxConcurrent));
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const kind: VocalKind = e.scream ? pick(['scream', 'eek', 'scream', 'whoa'] as const)! : pick(['whoa', 'hey', 'ah', 'whoa'] as const)!;
      p.x = e.position.x + rnd(-2, 2);
      p.y = e.position.y + 1.6;
      p.z = e.position.z + rnd(-2, 2);
      this.vocal(p, kind, i * rnd(0.05, 0.2), (i ? 0.8 : 1) * (e.level ?? 1));
    }
  }

  npcHit(e: GameEvents['npcHit']): void {
    const s = clamp(e.speed / 12, 0.2, 1);
    const v = this.voice('sfx', 5, e.position, { send: 0.1 });
    if (v) {
      this.count('npcHit');
      this.flesh(v, v.out, this.now + 0.003, CONFIG.audio.impacts.level * (0.3 + 0.5 * s));
    }
    this.vocal({ x: e.position.x, y: e.position.y + 1.2, z: e.position.z }, Math.random() < 0.6 ? 'oof' : 'ah', 0.02);
  }

  // ─────────────────────────────── car extras ───────────────────────────────
  starter(pos: Vec3Like): number {
    const v = this.voice('engine', 7, pos);
    if (!v) return 0.5;
    this.count('starter');
    const ac = this.ac;
    const t = this.now + 0.01;
    const dur = rnd(0.45, 0.6);
    const L = CONFIG.audio.engine.starterLevel;
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.linearRampToValueAtTime(190, t + dur);
    const lp = v.add(ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    lp.Q.value = 1.5;
    const am = v.add(ac.createGain());
    am.gain.value = 0.5;
    const lfo = ac.createOscillator();
    lfo.frequency.setValueAtTime(5, t);
    lfo.frequency.linearRampToValueAtTime(7.5, t + dur);
    const lg = v.add(ac.createGain());
    lg.gain.value = 0.45;
    lfo.connect(lg);
    lg.connect(am.gain);
    const env = v.add(ac.createGain());
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(L, t + 0.03);
    env.gain.setValueAtTime(L, t + dur - 0.06);
    env.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(lp);
    lp.connect(am);
    am.connect(env);
    env.connect(v.out);
    v.src(o, t, t + dur + 0.02);
    v.src(lfo, t, t + dur + 0.02);
    this.noise(v, v.out, t, 'white', 'bandpass', 2200, 2600, 4, L * 0.25, 0.02, dur * 0.3, dur * 0.5);
    return dur;
  }

  /** Exhaust pop / backfire (decel burble, upshift). */
  pop(at: number, amp: number, pos: Vec3Like): void {
    const v = this.voice('engine', 4, pos, { send: 0.2 });
    if (!v) return;
    this.count('pop');
    const a = amp * CONFIG.audio.engine.popLevel;
    const t = Math.max(at, this.now + 0.003);
    const d = v.out;
    this.noise(v, d, t, 'white', 'bandpass', rnd(350, 1000), rnd(250, 600), 1.2, a, 0.0008, rnd(0.012, 0.03));
    this.osc(v, d, t, 'sine', 115, 55, 0.04, a * 0.7, 0.001, 0.03);
    if (Math.random() < 0.6) this.noise(v, d, t, 'white', 'highpass', 3000, 3000, 0.7, a * 0.4, 0.0003, 0.004);
  }

  /** Turbo blow-off valve: "pssh" (or flutter "stu-tu-tu"). */
  blowoff(pos: Vec3Like, amount: number, flutter: boolean): void {
    const v = this.voice('engine', 5, pos);
    if (!v) return;
    this.count('blowoff');
    const a = CONFIG.audio.engine.blowoffLevel * clamp(amount, 0.2, 1);
    const t = this.now + 0.01;
    if (flutter) {
      const g: Grain[] = [];
      for (let k = 0; k < 6; k++) g.push([k * 0.045, a * (1 - k * 0.14), 0.016]);
      this.grains(v, v.out, t, 'white', 'bandpass', 2300, 2, g);
    } else {
      this.noise(v, v.out, t, 'white', 'bandpass', 3800, 1300, 1.4, a, 0.008, 0.14, 0.05);
    }
  }

  landing(pos: Vec3Like, s: number): void {
    const v = this.voice('sfx', 5, pos, { send: 0.08 });
    if (!v) return;
    this.count('landing');
    const t = this.now + 0.003;
    const d = v.out;
    const a = CONFIG.audio.impacts.level * s;
    this.thump(v, d, t, a * 0.9, 75, 40, 0.1 + 0.1 * s);
    this.noise(v, d, t, 'brown', 'lowpass', 500, 300, 0.7, a * 0.6, 0.002, 0.07);
    this.noise(v, d, t + 0.01, 'white', 'bandpass', 1400, 1400, 3, a * 0.25, 0.001, 0.02);
  }

  /** Soft shimmer when the car is respawned behind the fade. */
  respawn(): void {
    const v = this.voice('sfx', 6, null);
    if (!v) return;
    const t = this.now + 0.01;
    this.noise(v, v.out, t, 'pink', 'bandpass', 500, 3200, 1.2, 0.1, 0.28, 0.06);
    this.osc(v, v.out, t + 0.28, 'sine', 1568, 1568, 0, 0.05, 0.004, 0.2);
    this.osc(v, v.out, t + 0.33, 'sine', 2349, 2349, 0, 0.03, 0.004, 0.2);
  }

  // ─────────────────────────────── ambience one-shots ───────────────────────────────
  gull(pos: Vec3Like): void {
    const v = this.voice('ambience', 1, pos, { ref: 15, send: 0.15 });
    if (!v) return;
    this.count('gull');
    const ac = this.ac;
    const L = CONFIG.audio.ambience.birdLevel;
    const t = this.now + 0.02;
    const base = rnd(0.9, 1.15);
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    const lfo = ac.createOscillator();
    lfo.frequency.value = rnd(22, 32);
    const lg = v.add(ac.createGain());
    lg.gain.value = 45 * base;
    lfo.connect(lg);
    lg.connect(o.frequency);
    const bp = v.add(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1700 * base;
    bp.Q.value = 1.1;
    const hp = v.add(ac.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const g = v.add(ac.createGain());
    g.gain.value = 0;
    const calls = 2 + Math.floor(Math.random() * 3);
    let tt = t;
    for (let c = 0; c < calls; c++) {
      const dur = rnd(0.26, 0.4) * (c === 0 ? 1.25 : 1);
      o.frequency.setValueAtTime(1150 * base, tt);
      o.frequency.linearRampToValueAtTime(1650 * base, tt + dur * 0.3);
      o.frequency.linearRampToValueAtTime(950 * base, tt + dur);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(L, tt + 0.03);
      g.gain.linearRampToValueAtTime(L * 0.75, tt + dur - 0.08);
      g.gain.linearRampToValueAtTime(0, tt + dur);
      tt += dur + rnd(0.08, 0.22);
    }
    o.connect(bp);
    bp.connect(hp);
    hp.connect(g);
    g.connect(v.out);
    v.src(o, t, tt + 0.05);
    v.src(lfo, t, tt + 0.05);
  }

  songbird(pos: Vec3Like): void {
    const v = this.voice('ambience', 1, pos, { ref: 12, send: 0.1 });
    if (!v) return;
    this.count('songbird');
    const ac = this.ac;
    const L = CONFIG.audio.ambience.birdLevel * 0.6;
    const t = this.now + 0.02;
    const o = ac.createOscillator();
    o.type = 'sine';
    const g = v.add(ac.createGain());
    g.gain.value = 0;
    const notes = 3 + Math.floor(Math.random() * 6);
    const base = rnd(2600, 4200);
    const trill = Math.random() < 0.4;
    let tt = t;
    let f1 = base;
    let f2 = base * 1.2;
    for (let k = 0; k < notes; k++) {
      const dur = trill ? rnd(0.035, 0.05) : rnd(0.05, 0.11);
      if (!trill || k === 0) {
        f1 = base * rnd(0.85, 1.3);
        f2 = f1 * rnd(0.75, 1.4);
      }
      o.frequency.setValueAtTime(f1, tt);
      o.frequency.exponentialRampToValueAtTime(f2, tt + dur);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(L, tt + dur * 0.25);
      g.gain.linearRampToValueAtTime(0, tt + dur);
      tt += dur + (trill ? 0.015 : rnd(0.02, 0.09));
    }
    o.connect(g);
    g.connect(v.out);
    v.src(o, t, tt + 0.05);
  }

  farHorn(pos: Vec3Like): void {
    const v = this.voice('ambience', 1, pos, { ref: 20, send: 0.5 });
    if (!v) return;
    this.count('farHorn');
    const ac = this.ac;
    const L = CONFIG.audio.ambience.farHornLevel;
    const t = this.now + 0.02;
    const f1 = rnd(330, 470);
    const f2 = f1 * pick([1.2, 1.25, 1.26, 1.33])!;
    const lp = v.add(ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 1300;
    const g = v.add(ac.createGain());
    g.gain.value = 0;
    const honks = Math.random() < 0.4 ? 2 : 1;
    let tt = t;
    for (let k = 0; k < honks; k++) {
      const dur = honks === 2 ? rnd(0.12, 0.2) : rnd(0.3, 0.7);
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(L, tt + 0.015);
      g.gain.setValueAtTime(L, tt + dur);
      g.gain.linearRampToValueAtTime(0, tt + dur + 0.04);
      tt += dur + 0.12;
    }
    for (const f of [f1, f2]) {
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(lp);
      v.src(o, t, tt + 0.05);
    }
    lp.connect(g);
    g.connect(v.out);
  }

  /** A distant car passing by somewhere off-screen (doppler-ish sweep + pan). */
  passby(pos: Vec3Like, dir: number): void {
    const v = this.voice('ambience', 1, pos, { ref: 40, send: 0.2 });
    if (!v) return;
    this.count('passby');
    const ac = this.ac;
    const L = CONFIG.audio.ambience.passbyLevel;
    const t = this.now + 0.02;
    const dur = rnd(3.5, 5.5);
    if (v.panner) {
      v.panner.pan.setValueAtTime(-0.8 * dir, t);
      v.panner.pan.linearRampToValueAtTime(0.8 * dir, t + dur);
    }
    const s = this.bank.pink;
    if (s) {
      const src = ac.createBufferSource();
      src.buffer = s;
      src.loop = true;
      const bp = v.add(ac.createBiquadFilter());
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(780, t);
      bp.frequency.exponentialRampToValueAtTime(430, t + dur);
      const g = v.add(ac.createGain());
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(L, t + dur * 0.5);
      g.gain.linearRampToValueAtTime(0, t + dur);
      src.connect(bp);
      bp.connect(g);
      g.connect(v.out);
      v.src(src, t, t + dur + 0.05, Math.random() * (s.duration - 1));
    }
    const o = ac.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(rnd(80, 95), t);
    o.frequency.exponentialRampToValueAtTime(rnd(58, 66), t + dur);
    const lp = v.add(ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const g2 = v.add(ac.createGain());
    g2.gain.setValueAtTime(0, t);
    g2.gain.linearRampToValueAtTime(L * 0.6, t + dur * 0.5);
    g2.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(lp);
    lp.connect(g2);
    g2.connect(v.out);
    v.src(o, t, t + dur + 0.05);
  }

  // ─────────────────────────────── part 2: planes ───────────────────────────────
  /** Engine explosion: hard bang (crack + thump + short boom) and a metal rattle. */
  bang(pos: Vec3Like, radius: number): void {
    const P = CONFIG.audio.plane;
    const big = clamp(radius / 8, 0.4, 2);
    const v = this.voice('sfx', 9, pos, { send: 0.45, ref: 14 + radius * 2, maxDist: CONFIG.audio.farMaxDistance });
    if (!v) return;
    this.count('bang');
    const t = this.now + 0.005;
    const d = v.out;
    const a = P.bangLevel;
    this.noise(v, d, t, 'white', 'highpass', 1600, 1600, 0.7, a * 0.9, 0.0004, 0.016);
    this.thump(v, d, t, a * 0.9, 130, 38, 0.16 * big);
    this.play(v, d, t, pick(this.bank.boom), rnd(1.25, 1.5) / Math.sqrt(big), a * 0.7, 9000);
    this.play(v, d, t + 0.06, pick(this.bank.debris), rnd(1.15, 1.35), a * 0.55);
    this.partials(v, d, t + 0.01, rnd(380, 600), [1, 2.31, 3.9, 5.3], [1, 0.6, 0.4, 0.25], [0.5, 0.3, 0.2, 0.12], a * 0.08);
  }

  /** Big layered boom (plane explosions): sub thump + crack + baked body + debris rattle, scaled by radius. */
  bigBoom(pos: Vec3Like, radius: number, kind: string): void {
    const P = CONFIG.audio.plane;
    const k = clamp(radius / 25, 0.3, 3);
    const sec = kind === 'secondary';
    const lvl = P.boomLevel * (sec ? 0.6 : 1);
    const far = CONFIG.audio.farMaxDistance;
    const v = this.voice('sfx', 10, pos, { send: 0.75, ref: 25 + radius * 1.5, maxDist: far });
    if (v) {
      this.count('bigBoom');
      const t = this.now + 0.005;
      const d = v.out;
      const rate = clamp(1.08 - 0.16 * k, 0.55, 1.05) * rnd(0.95, 1.05);
      if (!this.play(v, d, t, pick(this.bank.boom), rate, lvl)) this.noise(v, d, t, 'brown', 'lowpass', 2500, 120, 0.7, lvl, 0.003, 0.8);
      this.osc(v, d, t, 'sine', 55, 22, 0.9, lvl * 0.6, 0.004, 0.45 + 0.25 * k);
      this.noise(v, d, t, 'white', 'highpass', 1200, 1200, 0.7, lvl * 0.7, 0.0005, 0.02);
      if (k > 1.2) this.play(v, d, t + 0.18, pick(this.bank.boom), rate * 0.8, lvl * 0.45, 900);
    }
    const dv = this.voice('sfx', 8, pos, { send: 0.35, ref: 18 + radius, maxDist: 4000 });
    if (dv) {
      const dl = CONFIG.audio.explosion.debrisLevel * (sec ? 0.6 : 1);
      this.play(dv, dv.out, this.now + 0.16, pick(this.bank.debris), rnd(0.8, 0.95), dl);
      if (k > 1) this.play(dv, dv.out, this.now + 0.7, pick(this.bank.debris), rnd(0.75, 0.9), dl * 0.6);
    }
  }

  /** Metal tearing (airframe breakup). */
  tear(pos: Vec3Like, intensity: number): void {
    const v = this.voice('sfx', 8, pos, { send: 0.35, ref: 25, maxDist: 4000 });
    if (!v) return;
    this.count('tear');
    const s = clamp(intensity, 0.15, 1);
    const t = this.now + 0.005;
    const a = CONFIG.audio.plane.tearLevel * (0.4 + 0.6 * s);
    if (!this.play(v, v.out, t, pick(this.bank.tear), rnd(0.8, 1.1), a)) this.noise(v, v.out, t, 'white', 'bandpass', 2600, 1400, 6, a, 0.01, 0.4);
    this.play(v, v.out, t + 0.02, pick(this.bank.crunch), rnd(0.6, 0.8), a * 0.6, 4000);
    this.thump(v, v.out, t, a * 0.6, 90, 40, 0.15);
  }

  /** Sea impact: deep water roar + splash + falling spray. s = 0..1 */
  waterRoar(pos: Vec3Like, s: number): void {
    const v = this.voice('sfx', 9, pos, { send: 0.45, ref: 20 + 40 * s, maxDist: 5000 });
    if (!v) return;
    this.count('water');
    const t = this.now + 0.005;
    const d = v.out;
    const a = CONFIG.audio.plane.waterLevel * (0.35 + 0.65 * s);
    this.thump(v, d, t, a * 0.9, 70, 28, 0.3 + 0.2 * s);
    this.noise(v, d, t, 'brown', 'lowpass', 900, 220, 0.7, a * 1.2, 0.01, 0.9 + 0.8 * s);
    this.noise(v, d, t, 'pink', 'bandpass', 1100, 300, 0.7, a * 0.9, 0.006, 0.5 + 0.4 * s);
    this.noise(v, d, t + 0.05, 'white', 'highpass', 2600, 1800, 0.6, a * 0.45, 0.05, 0.6 + 0.5 * s);
    const g: Grain[] = [];
    for (let k = 0; k < 14; k++) g.push([0.4 + k * rnd(0.06, 0.14), a * 0.25 * (1 - k / 16), rnd(0.03, 0.08)]);
    this.grains(v, d, t, 'white', 'bandpass', 1800, 0.8, g);
  }

  /** Heavy crash on land (plane / big piece): crunch + thump + debris. */
  heavyCrash(pos: Vec3Like, s: number): void {
    const v = this.voice('sfx', 9, pos, { send: 0.4, ref: 18 + 30 * s, maxDist: 4000 });
    if (!v) return;
    this.count('crash');
    const t = this.now + 0.005;
    const d = v.out;
    const a = CONFIG.audio.plane.boomLevel * (0.35 + 0.6 * s);
    this.thump(v, d, t, a, 80, 30, 0.25 + 0.2 * s);
    this.play(v, d, t, pick(this.bank.crunch), rnd(0.55, 0.75), a * 0.9, 6000);
    this.noise(v, d, t, 'brown', 'lowpass', 1200, 250, 0.7, a * 0.9, 0.004, 0.35 + 0.3 * s);
    this.play(v, d, t + 0.1, pick(this.bank.debris), rnd(0.75, 0.9), a * 0.6);
  }

  /** Wheels meeting the runway: rubber chirp + puff (+ thump when hard). */
  touchdown(pos: Vec3Like, vs: number, hard: boolean): void {
    const v = this.voice('sfx', 6, pos, { send: 0.12, ref: 18, maxDist: 1500 });
    if (!v) return;
    this.count('touchdown');
    const t = this.now + 0.003;
    const d = v.out;
    const a = CONFIG.audio.plane.touchdownLevel;
    const s = clamp(Math.abs(vs) / 4, 0.2, 1.2);
    for (let k = 0; k < 2; k++) {
      const tt = t + k * rnd(0.05, 0.12);
      const m = k ? 0.7 : 1;
      this.osc(v, d, tt, 'sawtooth', rnd(1150, 1350), rnd(800, 950), 0.15, a * 0.3 * m, 0.004, 0.08);
      this.noise(v, d, tt, 'white', 'bandpass', 2200, 1500, 1.5, a * 0.5 * m, 0.003, 0.09);
    }
    this.thump(v, d, t, a * (hard ? 1.2 : 0.5) * s, 85, 40, hard ? 0.18 : 0.1);
    if (hard) this.noise(v, d, t + 0.01, 'white', 'bandpass', 1200, 900, 2, a * 0.5, 0.002, 0.05);
  }

  /** Gear collapse: sharp strut snap + metallic ring + clunk + grinding tail. */
  strutSnap(pos: Vec3Like): void {
    const v = this.voice('sfx', 8, pos, { send: 0.25, ref: 18, maxDist: 2000 });
    if (!v) return;
    this.count('snap');
    const t = this.now + 0.003;
    const d = v.out;
    const a = CONFIG.audio.plane.snapLevel;
    this.noise(v, d, t, 'white', 'highpass', 2000, 2000, 0.7, a, 0.0002, 0.007);
    this.partials(v, d, t, rnd(650, 800), [1, 2.3, 3.7, 5.1], [1, 0.6, 0.4, 0.25], [0.18, 0.12, 0.08, 0.05], a * 0.25);
    this.thump(v, d, t + 0.02, a * 0.8, 95, 45, 0.12);
    this.noise(v, d, t + 0.06, 'white', 'bandpass', 1500, 1100, 3, a * 0.4, 0.02, 0.4, 0.2);
  }

  /** Master caution: two-tone chime ('caution') or two groups of triple beeps ('warning'). Generic tones only. */
  caution(level: 'caution' | 'warning'): void {
    const v = this.voice('sfx', 8, null);
    if (!v) return;
    this.count('caution');
    const t = this.now + 0.005;
    const d = v.out;
    const a = CONFIG.audio.plane.cautionLevel;
    if (level === 'caution') {
      this.partials(v, d, t, 1046, [1, 2, 3.01], [1, 0.35, 0.15], [0.45, 0.22, 0.12], a);
      this.partials(v, d, t + 0.33, 784, [1, 2, 3.01], [1, 0.35, 0.15], [0.55, 0.25, 0.12], a);
    } else {
      for (let gI = 0; gI < 2; gI++) {
        for (let k = 0; k < 3; k++) {
          const tt = t + gI * 0.62 + k * 0.15;
          this.osc(v, d, tt, 'triangle', 1250, 1250, 0, a * 0.9, 0.004, 0.012, 0.075);
          this.osc(v, d, tt, 'sine', 2500, 2500, 0, a * 0.25, 0.004, 0.012, 0.075);
        }
      }
    }
  }

  /** Short beep (out-of-map warning). */
  beep(freq: number, dur: number, gain = 1): void {
    const v = this.voice('sfx', 7, null);
    if (!v) return;
    this.count('beep');
    const t = this.now + 0.005;
    const a = CONFIG.audio.plane.beepLevel * gain;
    this.osc(v, v.out, t, 'triangle', freq, freq, 0, a, 0.005, 0.015, dur);
    this.osc(v, v.out, t, 'sine', freq * 2, freq * 2, 0, a * 0.3, 0.005, 0.015, dur);
  }

  /** Cockpit alarm "whoop" (explode-middle sequence). */
  alarmTone(): void {
    const v = this.voice('sfx', 7, null);
    if (!v) return;
    this.count('alarmTone');
    const t = this.now + 0.005;
    const a = CONFIG.audio.plane.alarmLevel;
    this.osc(v, v.out, t, 'triangle', 620, 980, 0.32, a, 0.01, 0.04, 0.3);
    this.osc(v, v.out, t, 'square', 620, 980, 0.32, a * 0.12, 0.01, 0.04, 0.3);
  }

  /** Stall warning horn (held; caller releases). */
  stallHorn(): Voice | null {
    const v = this.voice('sfx', 8, null);
    if (!v) return null;
    this.count('stall');
    const ac = this.ac;
    const t = this.now + 0.005;
    const a = CONFIG.audio.plane.stallLevel;
    const o = ac.createOscillator();
    o.type = 'square';
    o.frequency.value = 420;
    const bp = v.add(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.9;
    const trem = v.add(ac.createGain());
    trem.gain.value = 0.6;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 13;
    const lg = v.add(ac.createGain());
    lg.gain.value = 0.4;
    lfo.connect(lg);
    lg.connect(trem.gain);
    const env = v.add(ac.createGain());
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(a, t + 0.03);
    o.connect(bp);
    bp.connect(trem);
    trem.connect(env);
    env.connect(v.out);
    v.src(o, t, t + 600);
    v.src(lfo, t, t + 600);
    return v;
  }

  // ─────────────────────────────── part 3: weather, turbo, stunts ───────────────────────────────
  /** Thunder (ambience bus). The caller already delayed it by distance / 343 m/s. */
  thunder(pos: Vec3Like, intensity: number, dist: number): void {
    const W = CONFIG.audio.weather;
    const near = dist < W.nearThunder;
    const v = this.voice('ambience', 7, pos, { send: 0.4, ref: 300, maxDist: CONFIG.audio.farMaxDistance * 1.5 });
    if (!v) return;
    this.count('thunder');
    const t = this.now + 0.01;
    const a = W.thunderLevel * clamp(intensity, 0.2, 1.2);
    const buf = near ? this.bank.thunderNear : (this.bank.thunderFar ?? this.bank.thunderNear);
    if (!this.play(v, v.out, t, buf, rnd(0.85, 1.1), a, near ? 0 : 900)) this.noise(v, v.out, t, 'brown', 'lowpass', 300, 120, 0.7, a, 0.3, 2);
  }

  /** One wiper stroke: motor hum + rubber swish + end-stop thunk. */
  wiper(dur: number): void {
    const v = this.voice('sfx', 3, null);
    if (!v) return;
    this.count('wiper');
    const t = this.now + 0.005;
    const d = v.out;
    const a = CONFIG.audio.weather.wiperLevel;
    this.osc(v, d, t, 'triangle', 95, 108, dur, a * 0.35, 0.04, 0.05, Math.max(0, dur - 0.08));
    this.noise(v, d, t, 'pink', 'bandpass', 1300, 2100, 1.4, a, dur * 0.4, dur * 0.25, dur * 0.2);
    this.thump(v, d, t + dur, a * 0.7, 140, 90, 0.03);
  }

  /** Turbo kick-in: rising whoosh + turbine spin-up chirp. */
  turboWhoosh(pos: Vec3Like): void {
    const v = this.voice('sfx', 6, pos, { send: 0.1 });
    if (!v) return;
    this.count('turboWhoosh');
    const t = this.now + 0.005;
    const a = CONFIG.audio.turbo.whoosh;
    this.noise(v, v.out, t, 'pink', 'bandpass', 350, 3400, 1.3, a, 0.35, 0.25, 0.15);
    this.osc(v, v.out, t, 'sine', 900, 4200, 0.6, a * 0.12, 0.2, 0.2, 0.25);
  }

  /** Barrel-roll whoosh sweeping across the stereo field. */
  rollWhoosh(pos: Vec3Like): void {
    const v = this.voice('sfx', 6, pos, { send: 0.12 }, true);
    if (!v) return;
    this.count('rollWhoosh');
    const t = this.now + 0.005;
    const a = CONFIG.audio.stunt.whoosh;
    const dir = Math.random() < 0.5 ? -1 : 1;
    if (v.panner) {
      v.panner.pan.setValueAtTime(-0.7 * dir, t);
      v.panner.pan.linearRampToValueAtTime(0.7 * dir, t + 0.7);
    }
    this.noise(v, v.out, t, 'pink', 'bandpass', 450, 1900, 1.2, a, 0.3, 0.18, 0.12);
    this.osc(v, v.out, t, 'sine', 130, 70, 0.6, a * 0.4, 0.2, 0.15, 0.15);
  }

  /** Landing slam after a jump (crash = crash landing). */
  slam(pos: Vec3Like, s: number, crash: boolean): void {
    const v = this.voice('sfx', 7, pos, { send: 0.15 });
    if (!v) return;
    this.count('slam');
    const t = this.now + 0.003;
    const d = v.out;
    const a = CONFIG.audio.stunt.slam * clamp(s, 0.3, 1.2);
    this.thump(v, d, t, a, 72, 32, 0.18);
    this.noise(v, d, t, 'brown', 'lowpass', 650, 300, 0.7, a * 0.8, 0.002, 0.1);
    this.noise(v, d, t + 0.01, 'white', 'bandpass', 900, 900, 2, a * 0.4, 0.001, 0.04);
    this.osc(v, d, t + 0.02, 'sawtooth', 1050, 760, 0.1, a * 0.08, 0.003, 0.06);
    if (crash) {
      this.play(v, d, t, pick(this.bank.crunch), rnd(0.8, 1), a * 0.8, 9000);
      this.partials(v, d, t + 0.03, rnd(3500, 5500), [1, 1.47, 2.1], [1, 0.6, 0.35], [0.05, 0.03, 0.02], a * 0.15);
    }
  }

  // ─────────────────────────────── UI ───────────────────────────────
  ui(kind: 'click' | 'confirm' | 'back' | 'toggle'): void {
    const v = this.voice('ui', 9, null);
    if (!v) return;
    this.count('ui');
    const t = this.now + 0.004;
    const L = CONFIG.audio.ui.level;
    const d = v.out;
    switch (kind) {
      case 'click':
        this.osc(v, d, t, 'sine', 1250, 880, 0.035, 0.32 * L, 0.002, 0.022);
        this.osc(v, d, t, 'triangle', 2500, 1800, 0.02, 0.05 * L, 0.001, 0.008);
        break;
      case 'confirm':
        this.osc(v, d, t, 'triangle', 784, 784, 0, 0.26 * L, 0.004, 0.07, 0.03);
        this.osc(v, d, t + 0.075, 'triangle', 1175, 1175, 0, 0.26 * L, 0.004, 0.12, 0.03);
        this.osc(v, d, t + 0.075, 'sine', 587, 587, 0, 0.1 * L, 0.004, 0.12);
        break;
      case 'back':
        this.osc(v, d, t, 'triangle', 880, 880, 0, 0.22 * L, 0.004, 0.05, 0.02);
        this.osc(v, d, t + 0.065, 'triangle', 622, 622, 0, 0.22 * L, 0.004, 0.08, 0.02);
        break;
      case 'toggle':
        this.osc(v, d, t, 'sine', 1046, 1046, 0, 0.22 * L, 0.002, 0.025);
        this.osc(v, d, t + 0.04, 'sine', 1568, 1568, 0, 0.18 * L, 0.002, 0.03);
        break;
    }
  }
}
