/**
 * Offline DSP toolkit used to BAKE procedural audio buffers in plain JS (engine loops, explosion, debris, glass,
 * fire crackle, impulse responses). Synchronous, allocation-light, no Web Audio dependency — so everything we bake
 * can also be inspected numerically (see window.__audioDebug in ?debug).
 */

/** Small fast PRNG (mulberry32). Audio jitter only — never used for world generation. */
export class Rand {
  private s: number;
  constructor(seed: number = (Math.random() * 2 ** 32) >>> 0) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Uniform in [-1, 1). */
  bi(): number {
    return this.next() * 2 - 1;
  }
  /** Approximately normal, mean 0, std 1. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 2;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peaking';

/** RBJ-cookbook biquad (direct form I). bandpass = constant 0 dB peak gain. */
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(kind?: BiquadKind, sr = 48000, f = 1000, q = 0.707, db = 0) {
    if (kind) this.set(kind, sr, f, q, db);
  }

  set(kind: BiquadKind, sr: number, f: number, q = 0.707, db = 0): this {
    const w = (2 * Math.PI * Math.min(Math.max(f, 5), sr * 0.45)) / sr;
    const c = Math.cos(w);
    const s = Math.sin(w);
    const al = s / (2 * Math.max(1e-3, q));
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    switch (kind) {
      case 'lowpass':
        b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2;
        a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
        break;
      case 'highpass':
        b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2;
        a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
        break;
      case 'bandpass':
        b0 = al; b1 = 0; b2 = -al;
        a0 = 1 + al; a1 = -2 * c; a2 = 1 - al;
        break;
      case 'peaking': {
        const A = Math.pow(10, db / 40);
        b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A;
        a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
    return this;
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** One-pole lowpass. */
export class OnePole {
  y = 0;
  a = 1;
  constructor(sr = 48000, f = 1000) {
    this.setF(sr, f);
  }
  setF(sr: number, f: number): this {
    this.a = 1 - Math.exp((-2 * Math.PI * f) / sr);
    return this;
  }
  run(x: number): number {
    return (this.y += this.a * (x - this.y));
  }
}

// ─────────────────────────────── noise ───────────────────────────────
export function whiteNoise(n: number, r: Rand): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = r.bi();
  return a;
}

/** Paul Kellett's refined pink noise filter (≈ -3 dB/oct), ~unit peak. */
export function pinkNoise(n: number, r: Rand): Float32Array {
  const a = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r.bi();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return a;
}

/** Leaky-integrated (brown/red) noise, ≈ -6 dB/oct. */
export function brownNoise(n: number, r: Rand): Float32Array {
  const a = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * r.bi()) / 1.02;
    a[i] = last * 3.5;
  }
  return a;
}

/**
 * Make a seamless loop of length n from a signal of length n + fade, with an equal-power crossfade of the tail into
 * the head (for uncorrelated material like noise).
 */
export function loopify(src: Float32Array, n: number, fade: number): Float32Array {
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    out[i] = src[i] * Math.sin(t * Math.PI * 0.5) + src[n + i] * Math.cos(t * Math.PI * 0.5);
  }
  return out;
}

export function rmsOf(a: Float32Array, start = 0, end = a.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export function peakOf(a: Float32Array): number {
  let p = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > p) p = v;
  }
  return p;
}

export function scale(a: Float32Array, k: number): Float32Array {
  for (let i = 0; i < a.length; i++) a[i] *= k;
  return a;
}

export function normalizePeak(a: Float32Array, peak = 0.95): Float32Array {
  const p = peakOf(a);
  return p > 1e-9 ? scale(a, peak / p) : a;
}

/** Scale to a target RMS, then soft-limit any peaks above `ceiling`. */
export function normalizeRms(a: Float32Array, target: number, ceiling = 0.98): Float32Array {
  const r = rmsOf(a);
  if (r > 1e-9) scale(a, target / r);
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v > ceiling || v < -ceiling) a[i] = Math.sign(v) * (ceiling + (1 - ceiling) * Math.tanh((Math.abs(v) - ceiling) / (1 - ceiling)));
  }
  return a;
}

/** Remove DC + sub-rumble with a 2nd-order highpass. */
export function highpassInPlace(a: Float32Array, sr: number, f: number): Float32Array {
  const hp = new Biquad('highpass', sr, f, 0.707);
  for (let i = 0; i < a.length; i++) a[i] = hp.run(a[i]);
  return a;
}

/** Short fade in/out to avoid clicks at buffer edges. */
export function fadeEdges(a: Float32Array, sr: number, inMs = 1, outMs = 20): Float32Array {
  const fi = Math.min(a.length, Math.round((inMs / 1000) * sr));
  const fo = Math.min(a.length, Math.round((outMs / 1000) * sr));
  for (let i = 0; i < fi; i++) a[i] *= i / fi;
  for (let i = 0; i < fo; i++) a[a.length - 1 - i] *= i / fo;
  return a;
}

/** Waveshaper transfer curve: normalized tanh soft clip. */
export function softClipCurve(drive: number, n = 1024): Float32Array {
  const c = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / norm;
  }
  return c;
}

/**
 * Stereo reverb impulse response: a few discrete early reflections (city façades) + a dense noise tail whose high
 * band decays faster than the low band (air absorption).
 */
export function impulseResponse(sr: number, seconds: number, r: Rand, lowDecay: number, highDecay: number, taps: number): [Float32Array, Float32Array] {
  const n = Math.max(256, Math.round(seconds * sr));
  const pre = Math.round(0.011 * sr);
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)];
  for (let ch = 0; ch < 2; ch++) {
    const a = out[ch];
    const lp = new OnePole(sr, 1800);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const w = r.bi();
      const lo = lp.run(w);
      const hi = w - lo;
      // smooth onset (diffusion build-up over ~25 ms)
      const onset = Math.min(1, t / 0.025);
      a[i] = onset * (lo * 1.6 * Math.exp(-t / lowDecay) + hi * 0.7 * Math.exp(-t / highDecay));
    }
    for (let k = 0; k < taps; k++) {
      const t = 0.018 + r.next() * 0.13;
      const i = Math.round(t * sr) + pre;
      if (i >= n) continue;
      const amp = (0.55 - t * 2) * (0.6 + r.next() * 0.6) * ((k + ch) % 2 ? 1 : 0.55);
      a[i] += amp * (r.chance(0.5) ? 1 : -1);
      if (i + 1 < n) a[i + 1] += amp * 0.5;
    }
    fadeEdges(a, sr, 0, 60);
  }
  return out;
}

/** Biquad bandpass ping helper used by bakes: adds a decaying sine partial into `a` at sample `at`. */
export function addPartial(a: Float32Array, sr: number, at: number, freq: number, amp: number, decay: number, phase = 0): void {
  const len = Math.min(a.length - at, Math.round(decay * 7 * sr));
  if (len <= 0 || freq >= sr * 0.48) return;
  const w = (2 * Math.PI * freq) / sr;
  const k = Math.exp(-1 / (decay * sr));
  // recursive oscillator (cheap): y[n] = sin(w n + phase) via rotation
  let c = Math.cos(phase), s = Math.sin(phase);
  const cw = Math.cos(w), sw = Math.sin(w);
  let env = amp;
  const atk = Math.max(1, Math.round(0.0006 * sr));
  for (let i = 0; i < len; i++) {
    const e = i < atk ? env * (i / atk) : env;
    a[at + i] += s * e;
    const nc = c * cw - s * sw;
    s = s * cw + c * sw;
    c = nc;
    env *= k;
  }
}

/** Adds a filtered noise burst (exponential decay) into `a` at sample `at`. */
export function addNoiseBurst(a: Float32Array, sr: number, at: number, r: Rand, amp: number, decay: number, bp: Biquad | null, attack = 0.0005): void {
  const len = Math.min(a.length - at, Math.round(decay * 7 * sr));
  if (len <= 0) return;
  const k = Math.exp(-1 / (decay * sr));
  const atk = Math.max(1, Math.round(attack * sr));
  let env = amp;
  for (let i = 0; i < len; i++) {
    const w = r.bi();
    const x = bp ? bp.run(w) : w;
    a[at + i] += x * (i < atk ? env * (i / atk) : env);
    env *= k;
  }
}
