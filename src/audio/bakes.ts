import {
  Biquad, Rand, addNoiseBurst, addPartial, brownNoise, fadeEdges, highpassInPlace, impulseResponse, loopify,
  normalizePeak, normalizeRms, pinkNoise, whiteNoise,
} from './dsp';
import { bakeEngineLayer, type EngineProfile } from './engineBake';

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
  tear: AudioBuffer[];
  thunderNear: AudioBuffer | null;
  thunderFar: AudioBuffer | null;
  rain: AudioBuffer | null;
  roof: AudioBuffer | null;
  /** Raw baked data for numeric inspection in ?debug. */
  raw: Record<string, Float32Array>;
  ms: Record<string, number>;
}

export function emptyBank(): SfxBank {
  return { white: null, pink: null, brown: null, boom: [], debris: [], fire: null, glass: [], crunch: [], ir: null, tear: [], thunderNear: null, thunderFar: null, rain: null, roof: null, raw: {}, ms: {} };
}

export function toBuffer(ac: BaseAudioContext, chans: Float32Array[], sr: number): AudioBuffer {
  const b = ac.createBuffer(chans.length, chans[0].length, sr);
  for (let c = 0; c < chans.length; c++) b.getChannelData(c).set(chans[c]);
  return b;
}

export type BakeKind =
  | 'white' | 'pink' | 'brown' | 'boom' | 'debris' | 'fire' | 'glass' | 'crunch' | 'rain' | 'roof'
  | 'tear' | 'thunderNear' | 'thunderFar' | 'ir' | 'engine';

/** Plain-data bake arguments (structured-cloned into the bake worker). */
export interface BakeArgs {
  sr: number;
  seed: number;
  // ir
  seconds?: number;
  lowDecay?: number;
  highDecay?: number;
  taps?: number;
  // engine
  profile?: EngineProfile;
  rpm?: number;
  onLoad?: boolean;
  loopSeconds?: number;
}

const NOISE_SECONDS = 3;

function noiseLoop(gen: (n: number, r: Rand) => Float32Array, sr: number, seed: number): Float32Array {
  const n = Math.round(NOISE_SECONDS * sr);
  const fade = Math.round(0.08 * sr);
  return normalizeRms(loopify(gen(n + fade, new Rand(seed)), n, fade), 0.3, 0.99);
}

/**
 * Pure bake dispatch: kind + plain args → channel data. Runs in the bake worker (bakeWorker.ts) or, as a fallback,
 * on the main thread one job per frame (Baker).
 */
export function runBake(kind: BakeKind, a: BakeArgs): Float32Array[] {
  const { sr, seed } = a;
  switch (kind) {
    case 'white': return [noiseLoop(whiteNoise, sr, seed)];
    case 'pink': return [noiseLoop(pinkNoise, sr, seed)];
    case 'brown': return [noiseLoop(brownNoise, sr, seed)];
    case 'boom': return [bakeBoom(sr, seed)];
    case 'debris': return bakeDebris(sr, seed);
    case 'fire': return [bakeFire(sr, seed)];
    case 'glass': return [bakeGlass(sr, seed)];
    case 'crunch': return [bakeCrunch(sr, seed)];
    case 'rain': return [bakeRain(sr, seed, false)];
    case 'roof': return [bakeRain(sr, seed, true)];
    case 'tear': return [bakeTear(sr, seed)];
    case 'thunderNear': return [bakeThunder(sr, seed, true)];
    case 'thunderFar': return [bakeThunder(sr, seed, false)];
    case 'ir': return impulseResponse(sr, a.seconds ?? 2, new Rand(seed), a.lowDecay ?? 0.6, a.highDecay ?? 0.2, a.taps ?? 6);
    case 'engine': return [bakeEngineLayer(sr, a.profile!, a.rpm ?? 1000, !!a.onLoad, seed, a.loopSeconds ?? 1.2).data];
  }
}

// ─────────────────────────────── recipes ───────────────────────────────

/**
 * Explosion boom: high-passed noise crack → brown-noise body under a lowpass that sweeps 2.7 kHz → 120 Hz →
 * a sub "thump" sine dropping 95 → 30 Hz → a rolling-thunder tail with slow AM. All through a tanh drive.
 */
export function bakeBoom(sr: number, seed: number): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(3.4 * sr);
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
    if ((i & 127) === 0) lp.set('lowpass', sr, 120 + 2600 * Math.exp(-t / 0.22), 0.8);
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

/** Rain loop (3 s, seamless): dense droplet ticks; `roof` = fewer, lower, heavier drops (drumming on the car roof). */
export function bakeRain(sr: number, seed: number, roof: boolean): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(3 * sr);
  const ext = new Float32Array(n + Math.round(0.08 * sr));
  const count = roof ? 3 * 240 : 3 * 520;
  for (let k = 0; k < count; k++) {
    const at = r.int(n);
    const amp = Math.min(1, 0.06 / Math.pow(Math.max(0.03, r.next()), 0.7));
    if (roof) {
      addPartial(ext, sr, at, r.range(260, 1250), amp, r.range(0.003, 0.009), r.next() * 6);
      if (r.chance(0.5)) addPartial(ext, sr, at, r.range(1500, 3500), amp * 0.4, 0.0015, r.next() * 6);
    } else {
      addPartial(ext, sr, at, r.range(1800, 7500), amp, r.range(0.0008, 0.003), r.next() * 6);
    }
  }
  const a = new Float32Array(n);
  for (let i = 0; i < ext.length; i++) a[i % n] += ext[i];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[i];
  mean /= n;
  for (let i = 0; i < n; i++) a[i] -= mean;
  return normalizeRms(a, 0.2, 0.95);
}

/**
 * Metal tearing (airframe breakup): stick-slip excitation ringing three sharp structural resonances (groans/creaks),
 * a wandering resonant "shriek" band gated in bursts, and clusters of crackling rips.
 */
export function bakeTear(sr: number, seed: number): Float32Array {
  const r = new Rand(seed);
  const n = Math.round(1.9 * sr);
  const a = new Float32Array(n);
  const res = [new Biquad('bandpass', sr, r.range(240, 380), 14), new Biquad('bandpass', sr, r.range(620, 900), 16), new Biquad('bandpass', sr, r.range(1400, 2200), 11)];
  const rg = [70, 50, 30];
  const shriek = new Biquad();
  let ph = 0;
  let rate = 90;
  let target = 90;
  let fc = r.range(1800, 3200);
  let burst = 0;
  let burstS = 0;
  let burstT = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    if (i % 600 === 0 && r.chance(0.35)) target = r.range(35, 220);
    rate += (target - rate) * 0.002;
    ph += rate / sr;
    let ex = 0;
    if (ph >= 1) {
      ph -= 1;
      ex = 0.5 + r.next() * 0.5;
    }
    let s = 0;
    for (let k = 0; k < 3; k++) s += res[k].run(ex) * rg[k];
    if ((i & 63) === 0) {
      fc = Math.min(4200, Math.max(1400, fc + r.bi() * 260));
      shriek.set('bandpass', sr, fc, 7);
    }
    if (i >= burstT) {
      burst = r.chance(0.55) ? r.range(0.3, 1) : 0;
      burstT = i + Math.round(r.range(0.03, 0.14) * sr);
    }
    burstS += (burst - burstS) * 0.004;
    s += shriek.run(r.bi()) * burstS * 0.9;
    a[i] = s * Math.min(1, t / 0.01) * (0.35 + 0.65 * Math.exp(-t / 0.7));
  }
  for (let k = 0; k < 6; k++) {
    const at = Math.round(r.range(0, 1.2) * sr);
    const amp = 0.5 * (1 - k / 8);
    for (let g = 0; g < 22; g++) {
      addNoiseBurst(a, sr, at + Math.round(r.range(0, 0.12) * sr), r, r.range(0.3, 1) * amp, r.range(0.0008, 0.0025), new Biquad('bandpass', sr, r.range(1500, 5000), 1.5));
    }
  }
  highpassInPlace(a, sr, 60);
  fadeEdges(a, sr, 0.2, 80);
  return normalizePeak(a, 0.95);
}

/** Thunder: overlapping rolls of lowpassed brown noise; `near` adds the tearing crack and a sub boom. */
export function bakeThunder(sr: number, seed: number, near: boolean): Float32Array {
  const r = new Rand(seed);
  const n = Math.round((near ? 7 : 8) * sr);
  const a = new Float32Array(n);
  const count = near ? 7 : 9;
  const rolls: number[][] = [];
  for (let k = 0; k < count; k++) {
    const on = (near ? 0.05 : 0.3) + (k / count) * (near ? 3.2 : 4.2) + r.next() * 0.4;
    rolls.push([on, r.range(0.15, 0.6), r.range(0.8, 2.4), r.range(0.4, 1) * (1 - (0.6 * k) / count)]);
  }
  const lp = new Biquad('lowpass', sr, near ? 380 : 240, 0.7);
  const lp2 = new Biquad('lowpass', sr, near ? 650 : 320, 0.6);
  let br = 0;
  let env = 0;
  let envNext = 0;
  const block = 64;
  for (let i = 0; i < n; i++) {
    if (i % block === 0) {
      env = envNext;
      const t = (i + block) / sr;
      envNext = 0;
      for (const [on, rise, dec, amp] of rolls) {
        if (t < on) continue;
        const u = t - on;
        envNext += amp * (u < rise ? u / rise : Math.exp(-(u - rise) / dec));
      }
    }
    const e = env + (envNext - env) * ((i % block) / block);
    br = (br + 0.02 * r.bi()) / 1.02;
    a[i] = lp2.run(lp.run(br * 3.5)) * e;
  }
  if (near) {
    const hp = new Biquad('highpass', sr, 1200, 0.7);
    const crack = new Float32Array(Math.round(0.6 * sr));
    for (let k = 0; k < 8; k++) addNoiseBurst(crack, sr, Math.round(r.range(0, 0.22) * sr), r, r.range(0.4, 1), r.range(0.01, 0.05), null, 0.0003);
    for (let i = 0; i < crack.length; i++) a[i] += hp.run(crack[i]) * 0.6;
    let ph = 0;
    const m = Math.round(1.2 * sr);
    for (let i = 0; i < m; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * (28 + 40 * Math.exp(-t / 0.2))) / sr;
      a[i] += Math.sin(ph) * 0.6 * Math.min(1, t / 0.005) * Math.exp(-t / 0.35);
    }
  }
  normalizePeak(a, 1);
  const k = 1.6;
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) a[i] = Math.tanh(k * a[i]) / norm;
  fadeEdges(a, sr, 1, 200);
  return normalizePeak(a, 0.95);
}
