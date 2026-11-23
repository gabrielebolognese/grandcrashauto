import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, smoothstep } from '../core/math';
import type { SfxBank } from './bakes';
import type { Mixer } from './Mixer';
import { keep, setSmooth, type Listener } from './Voices';

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
// sunny pop loop: C – G – Am – F (one bar each)
const CHORDS = [
  [48, 52, 55, 60],
  [43, 47, 50, 55],
  [45, 48, 52, 57],
  [41, 45, 48, 53],
];
const BASS_STEPS = new Set([0, 3, 6, 8, 11, 14]);
const STAB_STEPS = new Set([2, 6, 10, 14]);

/**
 * The beach concert's live show: a procedural 120 bpm track (kick, clap, hats, bass, chord stabs, arpeggio) plus crowd
 * cheers, scheduled with a short lookahead on the audio clock. One output chain (distance gain → lowpass muffle →
 * pan toward the stage) into the ambience bus; nothing is scheduled while out of earshot.
 */
export class ConcertSound {
  private out: GainNode | null = null;
  private lp!: BiquadFilterNode;
  private pan: StereoPannerNode | null = null;
  private dry!: GainNode;
  private crowdG!: GainNode;
  private nextT = 0;
  private step = 0;
  private live = false;
  private v = new THREE.Vector3();
  readonly dbg = { vol: 0, dist: 0 };

  constructor(
    private ac: AudioContext,
    private mixer: Mixer,
    private listener: Listener,
    private bank: SfxBank,
  ) {}

  private build(): boolean {
    const { ac, bank } = this;
    if (!bank.white || !bank.pink) return false;
    this.out = keep(ac.createGain());
    this.out.gain.value = 0;
    this.lp = keep(ac.createBiquadFilter());
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 18000;
    this.lp.Q.value = 0.5;
    this.out.connect(this.lp);
    if (typeof ac.createStereoPanner === 'function') {
      this.pan = keep(ac.createStereoPanner());
      this.lp.connect(this.pan).connect(this.mixer.buses.ambience.input);
    } else this.lp.connect(this.mixer.buses.ambience.input);
    this.dry = keep(ac.createGain());
    this.dry.gain.value = 1;
    this.dry.connect(this.out);
    // crowd bed: band-passed pink noise, swells on the drops
    const src = keep(ac.createBufferSource());
    src.buffer = bank.pink;
    src.loop = true;
    src.start(0, Math.random() * Math.max(0.1, bank.pink.duration - 0.5));
    const bp = keep(ac.createBiquadFilter());
    bp.type = 'bandpass';
    bp.frequency.value = 1100;
    bp.Q.value = 0.6;
    this.crowdG = keep(ac.createGain());
    this.crowdG.gain.value = 0.05;
    src.connect(bp).connect(this.crowdG).connect(this.out);
    return true;
  }

  /** stage: LOCAL position of the stage front (null = no concert). active: false when paused / in the garage. */
  update(stage: THREE.Vector3 | null, active: boolean): void {
    const ac = this.ac;
    if (!stage) return;
    if (!this.out && !this.build()) return;
    const C = CONFIG.audio.concert;
    const L = this.listener;
    const d = L.pos.distanceTo(stage);
    this.dbg.dist = d;
    const vol = active && d < C.maxDist ? (C.level / (1 + Math.pow(d / C.refDist, 1.5))) * (1 - smoothstep(C.maxDist * 0.7, C.maxDist, d)) : 0;
    this.dbg.vol = vol;
    setSmooth(ac, this.out!.gain, vol, 0.35, 1e-4);
    setSmooth(ac, this.lp.frequency, 18000 * Math.pow(260 / 18000, smoothstep(25, 520, d)), 0.3, 1);
    if (this.pan) {
      this.v.copy(stage).sub(L.pos).setY(0).normalize();
      setSmooth(ac, this.pan.pan, clamp(this.v.dot(L.right) * 0.7 * smoothstep(5, 40, d), -0.8, 0.8), 0.2, 1e-2);
    }
    const audible = vol > 0.002;
    if (!audible) {
      this.live = false;
      return;
    }
    const now = ac.currentTime;
    if (!this.live || this.nextT < now - 0.1) {
      this.live = true;
      this.nextT = now + 0.06;
    }
    const sixteenth = 60 / 120 / 4;
    while (this.nextT < now + 0.25) {
      this.schedule(this.step, this.nextT);
      this.nextT += sixteenth;
      this.step++;
    }
  }

  private schedule(n: number, t: number): void {
    const s = n % 16;
    const bar = Math.floor(n / 16) % 16;
    const build = bar === 14 || bar === 15; // 2-bar break before the drop: no kick, riser
    const chord = CHORDS[Math.floor(n / 16) % 4];
    if (!build && s % 4 === 0) this.kick(t);
    if (s === 4 || s === 12) this.clap(t, build ? 0.5 : 1);
    if (s % 4 === 2) this.hat(t, 0.5);
    else if (!build && s % 2 === 1) this.hat(t, 0.18);
    if (!build && BASS_STEPS.has(s)) this.bass(t, mtof(chord[0] - 12));
    if (STAB_STEPS.has(s)) this.stab(t, chord, build ? 0.6 : 1);
    if (bar >= 4 && !build) this.arp(t, mtof(chord[(s * 3) % 4] + 24));
    if (bar === 14 && s === 0) this.riser(t, 32 * (60 / 120 / 4));
    if (bar === 0 && s === 0 && n > 0) this.cheer(t);
  }

  private env(t: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(this.dry);
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, dur: number, dest: AudioNode): OscillatorNode {
    const o = this.ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    o.onended = () => o.disconnect();
    return o;
  }

  private noise(buf: AudioBuffer, t: number, dur: number, dest: AudioNode): void {
    const s = this.ac.createBufferSource();
    s.buffer = buf;
    s.loop = dur > buf.duration * 0.8;
    s.connect(dest);
    s.start(t, s.loop ? 0 : Math.random() * Math.max(0.01, buf.duration - dur - 0.1));
    s.stop(t + dur + 0.05);
    s.onended = () => s.disconnect();
  }

  private kick(t: number): void {
    const g = this.env(t, 0.9, 0.002, 0.32);
    const o = this.osc('sine', 150, t, 0.4, g);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
  }

  private clap(t: number, amt: number): void {
    const g = this.env(t, 0.42 * amt, 0.003, 0.16);
    const bp = this.ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 0.9;
    bp.connect(g);
    this.noise(this.bank.white!, t, 0.2, bp);
  }

  private hat(t: number, amt: number): void {
    const g = this.env(t, 0.16 * amt, 0.001, 0.045);
    const hp = this.ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    hp.connect(g);
    this.noise(this.bank.white!, t, 0.06, hp);
  }

  private bass(t: number, f: number): void {
    const g = this.env(t, 0.34, 0.005, 0.2);
    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    lp.connect(g);
    this.osc('sawtooth', f, t, 0.22, lp);
  }

  private stab(t: number, chord: number[], amt: number): void {
    const g = this.env(t, 0.09 * amt, 0.005, 0.26);
    const lp = this.ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2200;
    lp.connect(g);
    for (const m of chord) this.osc('sawtooth', mtof(m + 12) * (1 + (Math.random() - 0.5) * 0.004), t, 0.3, lp);
  }

  private arp(t: number, f: number): void {
    const g = this.env(t, 0.035, 0.003, 0.09);
    this.osc('square', f, t, 0.11, g);
  }

  private riser(t: number, dur: number): void {
    const g = this.ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    g.connect(this.dry);
    const hp = this.ac.createBiquadFilter();
    hp.type = 'bandpass';
    hp.Q.value = 1.2;
    hp.frequency.setValueAtTime(400, t);
    hp.frequency.exponentialRampToValueAtTime(6000, t + dur);
    hp.connect(g);
    this.noise(this.bank.white!, t, dur, hp);
  }

  private cheer(t: number): void {
    const g = this.crowdG.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.05, t);
    g.linearRampToValueAtTime(0.32, t + 0.25);
    g.setTargetAtTime(0.05, t + 1.2, 1.4);
  }
}
