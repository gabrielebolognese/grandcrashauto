import { CONFIG } from '../config';
import {
  Biquad, Rand, addNoiseBurst, addPartial, brownNoise, fadeEdges, highpassInPlace, impulseResponse, loopify,
  normalizePeak, normalizeRms, pinkNoise, whiteNoise,
} from './dsp';

/** Baked one-shot / loop buffers shared by every sound (filled progressively by bake jobs after unlock). */
export interface SfxBank {
  white: AudioBuffer | null;
  pink: AudioBuffer | null;
  brown: AudioBuffer | null;
  boom: AudioBuffer[];
  debris: AudioBuffer[];
  fire: AudioBuffer | null;
  glass: AudioBuffer[];
  crunch: AudioBuffer[];
  ir: AudioBuffer | null;
  /** Raw baked data for numeric inspection in ?debug. */
  raw: Record<string, Float32Array>;
  ms: Record<string, number>;
}

export function emptyBank(): SfxBank {
  return { white: null, pink: null, brown: null, boom: [], debris: [], fire: null, glass: [], crunch: [], ir: null, raw: {}, ms: {} };
}

export function toBuffer(ac: BaseAudioContext, chans: Float32Array[], sr: number): AudioBuffer {
  const b = ac.createBuffer(chans.length, chans[0].length, sr);
  for (let c = 0; c < chans.length; c++) b.getChannelData(c).set(chans[c]);
  return b;
}

const NOISE_SECONDS = 4;

/** Ordered bake jobs (cheapest / most needed first). Each job fills part of `bank`. */
export function sfxBakeJobs(ac: AudioContext, bank: SfxBank, lowQuality: boolean, onIr: (b: AudioBuffer) => void): [string, () => void][] {
  const sr = ac.sampleRate;
  const seed = (Math.random() * 1e9) | 0;
  const timed = (name: string, fn: () => void) => (): void => {
    const t0 = performance.now();
    fn();
    bank.ms[name] = +(performance.now() - t0).toFixed(2);
  };
  const noise = (gen: (n: number, r: Rand) => Float32Array, s: number) => {
    const n = Math.round(NOISE_SECONDS * sr);
    const fade = Math.round(0.08 * sr);
    const a = loopify(gen(n + fade, new Rand(seed + s)), n, fade);
    normalizeRms(a, 0.3, 0.99);
    return toBuffer(ac, [a], sr);
  };
  const jobs: [string, () => void][] = [
    ['white', () => (bank.white = noise(whiteNoise, 1))],
    ['pink', () => (bank.pink = noise(pinkNoise, 2))],
    ['brown', () => (bank.brown = noise(brownNoise, 3))],
    ['crunch0', () => bank.crunch.push(toBuffer(ac, [store(bank, 'crunch0', bakeCrunch(sr, seed + 10))], sr))],
    ['boom0', () => bank.boom.push(toBuffer(ac, [store(bank, 'boom0', bakeBoom(sr, seed + 20))], sr))],
    ['debris0', () => bank.debris.push(toBuffer(ac, bakeDebris(sr, seed + 30), sr))],
    ['fire', () => (bank.fire = toBuffer(ac, [store(bank, 'fire', bakeFire(sr, seed + 40))], sr))],
    ['glass0', () => bank.glass.push(toBuffer(ac, [store(bank, 'glass0', bakeGlass(sr, seed + 50))], sr))],
    ['crunch1', () => bank.crunch.push(toBuffer(ac, [bakeCrunch(sr, seed + 11)], sr))],
    [
      'ir',
      () => {
        const R = CONFIG.audio.reverb;
        const ir = impulseResponse(sr, lowQuality ? R.secondsLow : R.seconds, new Rand(seed + 60), R.lowDecay, R.highDecay, R.earlyTaps);
        bank.ir = toBuffer(ac, ir, sr);
        onIr(bank.ir);
      },
    ],
    ['boom1', () => bank.boom.push(toBuffer(ac, [bakeBoom(sr, seed + 21)], sr))],
    ['glass1', () => bank.glass.push(toBuffer(ac, [bakeGlass(sr, seed + 51)], sr))],
    ['crunch2', () => bank.crunch.push(toBuffer(ac, [bakeCrunch(sr, seed + 12)], sr))],
    ['debris1', () => bank.debris.push(toBuffer(ac, bakeDebris(sr, seed + 31), sr))],
  ];
  return jobs.map(([n, fn]) => [n, timed(n, fn)]);
}

function store(bank: SfxBank, name: string, a: Float32Array): Float32Array {
  bank.raw[name] = a;
  return a;
}

// ─────────────────────────────── recipes ───────────────────────────────

/**
 * Explosion boom: high-passed noise crack → brown-noise body under a lowpass that sweeps 2.7 kHz → 120 Hz →
 * a sub "thump" sine dropping 95 → 30 Hz → a rolling-thunder tail with slow AM. All through a tanh drive.
 */
export function bakeBoom(sr: number, seed: number): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(3.6 * sr);
  const a = new Float32Array(n);
  // 1. crack
  const hp = new Biquad('highpass', sr, 900, 0.7);
  const crackN = Math.round(0.07 * sr);
  for (let i = 0; i < crackN; i++) a[i] += hp.run(r.bi()) * 0.85 * Math.exp(-i / sr / 0.013);
  // 2. body
  const lp = new Biquad();
  let br = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if ((i & 31) === 0) lp.set('lowpass', sr, 120 + 2600 * Math.exp(-t / 0.22), 0.8);
    br = (br + 0.02 * r.bi()) / 1.02;
    const env = (t < 0.004 ? t / 0.004 : 1) * (0.75 * Math.exp(-t / 0.33) + 0.25 * Math.exp(-t / 1.25));
    a[i] += lp.run(br * 3.5) * env * 1.7;
  }
  // 3. sub thump
  let ph = 0;
  const subN = Math.min(n, Math.round(2.2 * sr));
  const ph0 = r.next() * 0.3;
  for (let i = 0; i < subN; i++) {
    const t = i / sr;
    ph += (2 * Math.PI * (30 + 65 * Math.exp(-t / 0.17))) / sr;
    const env = (t < 0.003 ? t / 0.003 : 1) * Math.exp(-t / 0.42);
    a[i] += Math.sin(ph + ph0) * env * 0.95;
  }
  // 4. rolling rumble
  const lp2 = new Biquad('lowpass', sr, 170, 0.7);
  const f1 = r.range(1.2, 2.2);
  const f2 = r.range(0.5, 1.0);
  const pr = r.next() * 6;
  for (let i = Math.round(0.12 * sr); i < n; i++) {
    const t = i / sr;
    const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * f1 * t + pr) * Math.sin(2 * Math.PI * f2 * t);
    const env = Math.min(1, (t - 0.12) / 0.35) * Math.exp(-(t - 0.3) / 1.05);
    a[i] += lp2.run(r.bi()) * env * am * 2.4;
  }
  normalizePeak(a, 1);
  const drive = 2.2;
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) a[i] = Math.tanh(drive * a[i]) / norm;
  highpassInPlace(a, sr, 22);
  fadeEdges(a, sr, 0.2, 120);
  return normalizePeak(a, 0.97);
}

/** Debris rattle (stereo): a Poisson storm of metal clinks, thuds and glass tinkles thinning out over ~2.6 s. */
export function bakeDebris(sr: number, seed: number): Float32Array[] {
  const r = new Rand(seed);
  const n = Math.round(2.9 * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const tmp = new Float32Array(Math.round(0.9 * sr));
  let t = 0.02;
  while (true) {
    const rate = 26 * Math.exp(-t / 0.55) + 2.2;
    t += -Math.log(1 - r.next()) / rate;
    if (t >= 2.6) break;
    tmp.fill(0);
    const amp = (0.35 + 0.65 * r.next()) * (0.35 + 0.65 * Math.exp(-t / 0.8));
    const kind = r.next();
    if (kind < 0.55) {
      const f0 = r.range(700, 3600);
      const d0 = r.range(0.035, 0.15);
      addPartial(tmp, sr, 0, f0, amp, d0, r.next() * 6);
      addPartial(tmp, sr, 0, f0 * 2.31, amp * 0.5, d0 * 0.7, r.next() * 6);
      addPartial(tmp, sr, 0, f0 * 3.76, amp * 0.3, d0 * 0.45, r.next() * 6);
    } else if (kind < 0.85) {
      addNoiseBurst(tmp, sr, 0, r, amp * 1.1, r.range(0.018, 0.05), new Biquad('lowpass', sr, r.range(300, 900), 0.8));
      addPartial(tmp, sr, 0, r.range(110, 190), amp * 0.5, 0.04);
    } else {
      const f = r.range(4000, 7500);
      addPartial(tmp, sr, 0, f, amp * 0.6, r.range(0.02, 0.05));
      addPartial(tmp, sr, 0, f * 1.47, amp * 0.3, 0.02);
    }
    const pan = r.bi() * 0.8;
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    const at = Math.round(t * sr);
    const len = Math.min(tmp.length, n - at);
    for (let i = 0; i < len; i++) {
      L[at + i] += tmp[i] * gl;
      R[at + i] += tmp[i] * gr;
    }
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak > 0 ? 0.9 / peak : 1;
  for (let i = 0; i < n; i++) {
    L[i] *= k;
    R[i] *= k;
  }
  fadeEdges(L, sr, 0.5, 60);
  fadeEdges(R, sr, 0.5, 60);
  return [L, R];
}

/** Seamless 4 s fire loop: lowpassed roar bed with periodic AM + heavy-tailed crackles + a few pops. */
export function bakeFire(sr: number, seed: number): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(4 * sr);
  const fade = Math.round(0.1 * sr);
  const bedSrc = loopify(brownNoise(n + fade, r), n, fade);
  const bed = new Float32Array(n);
  const lp = new Biquad('lowpass', sr, 380, 0.7);
  // two passes so the filter state wraps seamlessly
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) bed[i] = lp.run(bedSrc[i]);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const am = 0.55 + 0.25 * Math.sin(2 * Math.PI * 2 * u) + 0.2 * Math.sin(2 * Math.PI * 5 * u + 1.3);
    a[i] = bed[i] * am * 0.9;
  }
  // crackles into an oversized buffer, then fold the tail into the head
  const ext = new Float32Array(n + Math.round(0.1 * sr));
  const count = Math.round(4 * 24);
  for (let k = 0; k < count; k++) {
    const at = r.int(n);
    const amp = Math.min(1, 0.12 / Math.pow(Math.max(0.02, r.next()), 0.65));
    addPartial(ext, sr, at, r.range(1200, 5800), amp, r.range(0.0008, 0.0035), r.next() * 6);
    if (r.chance(0.3)) addPartial(ext, sr, at + r.int(40), r.range(2500, 7000), amp * 0.5, 0.0012);
  }
  for (let k = 0; k < 9; k++) addNoiseBurst(ext, sr, r.int(n), r, r.range(0.25, 0.6), r.range(0.006, 0.014), new Biquad('lowpass', sr, r.range(350, 800), 0.8));
  for (let i = 0; i < ext.length; i++) a[i % n] += ext[i];
  return normalizePeak(a, 0.9);
}

/** Glass shatter: crack transient + a shower of high inharmonic pings + a bright noise wash. */
export function bakeGlass(sr: number, seed: number): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(1.3 * sr);
  const a = new Float32Array(n);
  addNoiseBurst(a, sr, 0, r, 0.9, 0.008, new Biquad('highpass', sr, 2500, 0.7), 0.0002);
  addNoiseBurst(a, sr, Math.round(0.008 * sr), r, 0.22, 0.22, new Biquad('highpass', sr, 4200, 0.7));
  const count = 55;
  for (let k = 0; k < count; k++) {
    let t = -Math.log(1 - r.next()) * 0.12;
    if (r.chance(0.2)) t += r.range(0.2, 0.85);
    t = Math.min(1.15, t);
    const at = Math.round(t * sr);
    const f = r.range(2500, 8500);
    const amp = r.range(0.1, 0.5) * (1 - t / 1.3);
    const d = r.range(0.012, 0.07);
    addPartial(a, sr, at, f, amp, d, r.next() * 6);
    addPartial(a, sr, at, f * r.range(1.3, 1.6), amp * 0.5, d * 0.7, r.next() * 6);
  }
  fadeEdges(a, sr, 0.1, 40);
  return normalizePeak(a, 0.95);
}

/** Metal crunch (body crumple): dense band-passed micro-impacts + low thump + faint inharmonic ring + body noise. */
export function bakeCrunch(sr: number, seed: number): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(1.0 * sr);
  const a = new Float32Array(n);
  let t = 0;
  while (true) {
    const rate = 900 * Math.exp(-t / 0.07) + 55;
    t += -Math.log(1 - r.next()) / rate;
    if (t > 0.6) break;
    const amp = (0.2 + 0.8 * r.next() * r.next()) * Math.exp(-t / 0.16);
    addNoiseBurst(a, sr, Math.round(t * sr), r, amp, r.range(0.0008, 0.003), new Biquad('bandpass', sr, r.range(700, 4500), 1.4));
  }
  let ph = 0;
  for (let i = 0; i < Math.round(0.6 * sr); i++) {
    const tt = i / sr;
    ph += (2 * Math.PI * (42 + 40 * Math.exp(-tt / 0.05))) / sr;
    a[i] += Math.sin(ph) * 0.9 * Math.min(1, tt / 0.002) * Math.exp(-tt / 0.11);
  }
  const f0 = r.range(380, 700);
  const ratios = [1, 2.08, 2.94, 4.1];
  const decays = [0.35, 0.25, 0.18, 0.12];
  for (let k = 0; k < 4; k++) addPartial(a, sr, 0, f0 * ratios[k], 0.12 / (k + 1), decays[k], r.next() * 6);
  addNoiseBurst(a, sr, 0, r, 0.7, 0.07, new Biquad('lowpass', sr, 1800, 0.7));
  fadeEdges(a, sr, 0.05, 50);
  return normalizePeak(a, 0.95);
}
