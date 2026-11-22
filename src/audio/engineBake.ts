import type { CONFIG } from '../config';
import { Biquad, OnePole, Rand, normalizePeak, normalizeRms } from './dsp';

export type EngineProfile = (typeof CONFIG.audio.models)['muscle'];

export interface EngineLayerData {
  /** Exact rpm the loop was rendered at (cycle length rounded to whole samples). */
  rpm: number;
  onLoad: boolean;
  sampleRate: number;
  data: Float32Array<ArrayBuffer>;
  ms: number;
}

/**
 * Bake one seamless engine loop at a fixed rpm and load, physically flavoured:
 *
 *   per-cylinder exhaust pulses (sharp attack, exponential blow-down, damped port "ring" + combustion noise),
 *   fired in the model's firing pattern with per-cylinder variance + per-firing jitter (misfires / pops off-load)
 *   → per-bank DC block → exhaust pipe feedback comb (with damping) → fixed body/muffler formants → muffler lowpass
 *   → soft clip → RMS normalize.
 *
 * Rendering several of these per model (idle → redline, on/off load) and crossfading them by rpm at runtime keeps the
 * resonances fixed in frequency while the firing harmonics sweep through them — the thing that makes an engine sound
 * like an engine instead of a pitched-up synth. The loop holds an integer number of 4-stroke cycles and the filters are
 * pre-warmed on the periodic input, so it loops without a seam.
 */
export function bakeEngineLayer(sr: number, p: EngineProfile, rpmTarget: number, onLoad: boolean, seed: number, loopSeconds: number): EngineLayerData {
  const t0 = performance.now();
  const cyl = Math.max(1, Math.round(p.cylinders));
  const cycleS = Math.max(cyl * 8, Math.round((sr * 120) / rpmTarget));
  const rpm = (sr * 120) / cycleS;
  const cycles = Math.max(3, Math.round((loopSeconds * sr) / cycleS));
  const N = cycles * cycleS;

  // Static per-cylinder character is seeded per model only, so every layer of a model shares it.
  const rc = new Rand(seed);
  const cylAmp: number[] = [];
  for (let i = 0; i < cyl; i++) cylAmp.push(1 + rc.gauss() * p.cylVariance);
  const r = new Rand(seed * 7919 + Math.round(rpmTarget) * 31 + (onLoad ? 1 : 2));

  const banks = p.banks.length >= cyl ? p.banks : new Array<number>(cyl).fill(0);
  const twoBanks = banks.some((b) => b === 1);
  const x: Float32Array[] = [new Float32Array(N)];
  if (twoBanks) x.push(new Float32Array(N));

  // Pulse kernel.
  const attack = Math.max(1, Math.round((p.attackMs / 1000) * sr));
  const decay = Math.max(1, ((onLoad ? p.decayOnMs : p.decayOffMs) / 1000) * sr);
  const ringAmp = onLoad ? p.ringOn : p.ringOff;
  const ringDecay = Math.max(1, (p.ringMs / 1000) * sr);
  const ringW = (2 * Math.PI * Math.min(p.ringHz, sr * 0.45)) / sr;
  const noiseAmt = onLoad ? p.noiseOn : p.noiseOff;
  const klen = Math.min(N - 1, Math.round(attack + decay * 6));
  const kernel = new Float32Array(klen);
  const kenv = new Float32Array(klen);
  for (let j = 0; j < klen; j++) {
    const env = j < attack ? j / attack : Math.exp(-(j - attack) / decay);
    kenv[j] = env;
    kernel[j] = env + ringAmp * Math.sin(ringW * j) * Math.exp(-j / ringDecay) * Math.min(1, j / attack);
  }

  const interval = cycleS / cyl;
  const bankOff = Math.round((p.bankDelayMs / 1000) * sr);
  const jit = onLoad ? p.jitterOn : p.jitterOff;
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < cyl; i++) {
      let amp = cylAmp[i] * (1 + jit * r.gauss());
      if (!onLoad) {
        if (r.chance(p.misfireOff)) amp *= 0.25;
        else if (r.chance(p.popOff)) amp *= 1.8;
      }
      amp = Math.max(0.05, amp);
      const b = twoBanks ? banks[i] : 0;
      let pos = Math.round(c * cycleS + i * interval + r.gauss() * p.timingJitter * interval + (b ? bankOff : 0));
      pos = ((pos % N) + N) % N;
      const buf = x[b];
      for (let j = 0; j < klen; j++) {
        let idx = pos + j;
        if (idx >= N) idx -= N;
        buf[idx] += amp * (kernel[j] + noiseAmt * kenv[j] * r.bi());
      }
    }
  }

  // Exhaust + body processing. Warm the (periodic) filters on the tail of the loop first, then record one period.
  const nb = x.length;
  const hp = [new Biquad('highpass', sr, 28, 0.7), new Biquad('highpass', sr, 28, 0.7)];
  const pipe = [p.pipeHz[0] ?? 80, p.pipeHz[1] ?? p.pipeHz[0] ?? 80];
  const D = [Math.max(2, Math.round(sr / pipe[0])), Math.max(2, Math.round(sr / pipe[1]))];
  const delay = [new Float32Array(D[0]), new Float32Array(D[1])];
  const di = [0, 0];
  const damp = [new OnePole(sr, p.pipeDampHz), new OnePole(sr, p.pipeDampHz)];
  const forms = p.formants.map(([f, q, g]) => ({ bq: new Biquad('bandpass', sr, f, q), g }));
  const lpHz = onLoad ? p.lowpassOn : p.lowpassOff;
  const lp1 = new Biquad('lowpass', sr, lpHz, 0.6);
  const lp2 = new Biquad('lowpass', sr, lpHz * 1.7, 0.5);
  const out = new Float32Array(N);
  const warm = Math.min(N, Math.round(0.4 * sr));
  const fb = p.pipeFb;
  for (let k = -warm; k < N; k++) {
    const n = k < 0 ? N + k : k;
    let s = 0;
    for (let b = 0; b < nb; b++) {
      const v = hp[b].run(x[b][n]);
      const d = delay[b];
      const ix = di[b];
      const y = v + fb * damp[b].run(d[ix]);
      d[ix] = y;
      di[b] = ix + 1 === D[b] ? 0 : ix + 1;
      s += y;
    }
    let f = s * p.dry;
    for (let q = 0; q < forms.length; q++) f += forms[q].bq.run(s) * forms[q].g;
    f = lp2.run(lp1.run(f));
    if (k >= 0) out[k] = f;
  }

  // Soft clip for grit, then level-match every layer.
  normalizePeak(out, 1);
  const drive = Math.max(0.1, p.drive);
  const norm = Math.tanh(drive);
  for (let i = 0; i < N; i++) out[i] = Math.tanh(drive * out[i]) / norm;
  // remove any DC the clipper produced (mean subtraction keeps the loop seamless)
  let mean = 0;
  for (let i = 0; i < N; i++) mean += out[i];
  mean /= N;
  for (let i = 0; i < N; i++) out[i] -= mean;
  normalizeRms(out, 0.25, 0.97);
  return { rpm, onLoad, sampleRate: sr, data: out, ms: performance.now() - t0 };
}
