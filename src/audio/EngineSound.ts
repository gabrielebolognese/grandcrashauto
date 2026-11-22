import { CONFIG } from '../config';
import { clamp, damp, smoothstep } from '../core/math';
import type { VehicleState } from '../game/contracts';
import type { CarBuild, CarModelId } from '../vehicle/CarBuild';
import type { SfxBank } from './bakes';
import type { Baker } from './Baker';
import { engineLayerRpm, type EngineProfile } from './engineBake';
import type { Mixer } from './Mixer';
import type { Sfx } from './Sfx';
import { audioStats, forgetParam, setSmooth, type Listener, type SpatialResult } from './Voices';

interface ModelBake {
  rpm: number[]; // exact baked rpm per point
  on: (AudioBuffer | null)[];
  off: (AudioBuffer | null)[];
  raw: Float32Array[];
  ms: number;
}

interface Layer {
  rpm: number;
  on: AudioBufferSourceNode;
  off: AudioBufferSourceNode;
  gOn: GainNode;
  gOff: GainNode;
}

const MODEL_SEED: Record<CarModelId, number> = { muscle: 101, coupe: 202, hatch: 303, suv: 404 };

/**
 * Engine: crossfaded baked loops (see engineBake.ts) pitched by rpm, blended on/off load by throttle, plus runtime
 * layers — intake roar, turbo spool whistle & whoosh (or supercharger whine on the muscle car), reverse whine — and
 * events: gear-shift cut, rev-limiter bounce, decel pops/burble, blow-off valve, starter + catch on spawn/reset.
 *
 * Graph: [layer sources → gains] → sum → load lowpass → shift gain → limiter gain → out (level × alive × distance)
 *        → panner → engine bus. Turbo/reverse layers join after the lowpass.
 */
export class EngineSound {
  private bakes = new Map<CarModelId, ModelBake>();
  private pendingCount = 0;
  private model: CarModelId | null = null;
  private perf = 0;
  private up = false;
  private nodes: AudioNode[] = [];
  private srcs: AudioScheduledSourceNode[] = [];
  private layers: Layer[] = [];
  private sum!: GainNode;
  private lp!: BiquadFilterNode;
  private shift!: GainNode;
  private limiter!: GainNode;
  private out!: GainNode;
  private pan: StereoPannerNode | null = null;
  private intakeBp!: BiquadFilterNode;
  private intakeG!: GainNode;
  private whistle!: OscillatorNode;
  private whistleG!: GainNode;
  private whooshBp!: BiquadFilterNode;
  private whooshG!: GainNode;
  private rev!: OscillatorNode;
  private revG!: GainNode;

  private sp: SpatialResult = { gain: 1, pan: 0, dist: 0, cutoff: 20000 };
  private rpmS = 800;
  private load = 0;
  private boostEst = 0;
  private alive = 0;
  private catchT = -1; // engine "catches" (fades in) at this ctx time
  private blipT = -10;
  private blipAmt = 0;
  private shiftUntil = -1;
  private downBlipUntil = -1;
  private prevThrottle = 0;
  private highLoadT = -10;
  private lastBlowoff = -10;
  private inactiveT = 0;
  private wasExploded = false;
  readonly dbg = { rpm: 0, load: 0, boost: 0, weights: [] as number[], bakeMs: 0, layersReady: 0, model: '' as string, limiter: false, alive: 0, out: 0, active: false, catchIn: 0 };

  constructor(
    private ac: AudioContext,
    private mixer: Mixer,
    private sfx: Sfx,
    private listener: Listener,
    private bank: SfxBank,
    private baker: Baker,
  ) {}

  private bakeSr(): number {
    return Math.max(22050, Math.round(this.ac.sampleRate / 2));
  }

  private profile(m: CarModelId | null): EngineProfile {
    return (CONFIG.audio.models as Record<string, EngineProfile>)[m ?? 'coupe'] ?? CONFIG.audio.models.coupe;
  }

  /** Queue the bake of a model's loops (worker; no-op if done / queued). */
  ensureBaked(m: CarModelId): void {
    if (this.bakes.has(m)) return;
    const p = this.profile(m);
    const k = p.bakeRpm.length;
    const entry: ModelBake = { rpm: new Array(k).fill(0), on: new Array(k).fill(null), off: new Array(k).fill(null), raw: [], ms: 0 };
    this.bakes.set(m, entry);
    const sr = this.bakeSr();
    const loopSeconds = CONFIG.audio.engine.loopSeconds;
    for (let i = 0; i < k; i++) {
      for (const onLoad of [true, false]) {
        this.pendingCount++;
        const name = `engine-${m}-${i}-${onLoad ? 'on' : 'off'}`;
        this.baker.bake(name, 'engine', { sr, seed: MODEL_SEED[m] ?? 1, profile: p, rpm: p.bakeRpm[i], onLoad, loopSeconds }, (chans) => {
          this.pendingCount = Math.max(0, this.pendingCount - 1);
          const data = chans[0];
          const buf = this.ac.createBuffer(1, data.length, sr);
          buf.getChannelData(0).set(data);
          entry.rpm[i] = engineLayerRpm(sr, p, p.bakeRpm[i]);
          (onLoad ? entry.on : entry.off)[i] = buf;
          entry.raw[i * 2 + (onLoad ? 0 : 1)] = data;
          entry.ms += this.baker.ms[name] ?? 0;
        });
      }
    }
  }

  get pendingBakes(): number {
    return this.pendingCount;
  }

  private ready(m: CarModelId): boolean {
    const b = this.bakes.get(m);
    return !!b && b.on.every(Boolean) && b.off.every(Boolean);
  }

  /** Raw baked data for analysis (?debug). */
  bakedData(m: CarModelId): { rpm: number[]; raw: Float32Array[]; sampleRate: number } | null {
    const b = this.bakes.get(m);
    if (!b) return null;
    return { rpm: b.rpm, raw: b.raw, sampleRate: this.bakeSr() };
  }

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    audioStats.persistentNodes++;
    return n;
  }

  private buildGraph(m: CarModelId): void {
    const ac = this.ac;
    const b = this.bakes.get(m)!;
    const gain = (v = 0) => {
      const g = this.node(ac.createGain());
      g.gain.value = v;
      return g;
    };
    this.sum = gain(1);
    this.lp = this.node(ac.createBiquadFilter());
    this.lp.type = 'lowpass';
    this.lp.Q.value = 0.6;
    this.lp.frequency.value = 3000;
    this.shift = gain(1);
    this.limiter = gain(1);
    this.out = gain(0);
    this.sum.connect(this.lp).connect(this.shift).connect(this.limiter).connect(this.out);
    if (typeof ac.createStereoPanner === 'function') {
      this.pan = this.node(ac.createStereoPanner());
      this.out.connect(this.pan).connect(this.mixer.buses.engine.input);
    } else {
      this.pan = null;
      this.out.connect(this.mixer.buses.engine.input);
    }
    const t = ac.currentTime + 0.02;
    this.layers = [];
    for (let i = 0; i < b.rpm.length; i++) {
      const mk = (buf: AudioBuffer) => {
        const s = this.node(ac.createBufferSource());
        s.buffer = buf;
        s.loop = true;
        s.start(t, Math.random() * buf.duration);
        this.srcs.push(s);
        return s;
      };
      const on = mk(b.on[i]!);
      const off = mk(b.off[i]!);
      const gOn = gain(0);
      const gOff = gain(0);
      on.connect(gOn).connect(this.sum);
      off.connect(gOff).connect(this.sum);
      this.layers.push({ rpm: b.rpm[i], on, off, gOn, gOff });
    }
    // intake roar
    if (this.bank.pink) {
      const s = this.node(ac.createBufferSource());
      s.buffer = this.bank.pink;
      s.loop = true;
      s.start(t, Math.random() * 3);
      this.srcs.push(s);
      this.intakeBp = this.node(ac.createBiquadFilter());
      this.intakeBp.type = 'bandpass';
      this.intakeBp.Q.value = 1.2;
      this.intakeBp.frequency.value = 600;
      this.intakeG = gain(0);
      s.connect(this.intakeBp).connect(this.intakeG).connect(this.sum);
      // turbo whoosh shares the source
      this.whooshBp = this.node(ac.createBiquadFilter());
      this.whooshBp.type = 'bandpass';
      this.whooshBp.Q.value = 1.6;
      this.whooshBp.frequency.value = 2500;
      this.whooshG = gain(0);
      s.connect(this.whooshBp).connect(this.whooshG).connect(this.shift);
    } else {
      this.intakeG = gain(0);
      this.whooshG = gain(0);
      this.intakeBp = this.node(ac.createBiquadFilter());
      this.whooshBp = this.node(ac.createBiquadFilter());
    }
    // turbo whistle / supercharger whine
    this.whistle = this.node(ac.createOscillator());
    this.whistle.type = 'sine';
    this.whistle.frequency.value = 2500;
    this.whistleG = gain(0);
    this.whistle.connect(this.whistleG).connect(this.shift);
    this.whistle.start(t);
    this.srcs.push(this.whistle);
    // reverse gear whine
    this.rev = this.node(ac.createOscillator());
    this.rev.type = 'triangle';
    this.rev.frequency.value = 300;
    this.revG = gain(0);
    this.rev.connect(this.revG).connect(this.shift);
    this.rev.start(t);
    this.srcs.push(this.rev);

    this.model = m;
    this.up = true;
    this.alive = 0;
    this.rpmS = this.profile(m).bakeRpm[0];
  }

  private teardown(): void {
    if (!this.up) return;
    const now = this.ac.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(0, now, 0.02);
    const srcs = this.srcs;
    const nodes = this.nodes;
    for (const s of srcs) {
      try {
        s.stop(now + 0.12);
      } catch {
        /* ignore */
      }
    }
    // disconnect after the fade
    window.setTimeout(() => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      audioStats.persistentNodes -= nodes.length;
    }, 250);
    this.srcs = [];
    this.nodes = [];
    this.layers = [];
    this.up = false;
    this.model = null;
  }

  /** Spawn / reset: starter motor then the engine catches with a rev blip. */
  start(pos: { x: number; y: number; z: number }): void {
    const dur = this.sfx.starter(pos);
    const now = this.ac.currentTime;
    this.catchT = now + dur * 0.85;
    this.blipT = this.catchT;
    this.blipAmt = 1;
    this.alive = 0;
    if (this.up) {
      forgetParam(this.out.gain);
      this.out.gain.cancelScheduledValues(now);
      this.out.gain.setTargetAtTime(0, now, 0.02);
    }
  }

  onGearShift(up: boolean, gear: number): void {
    if (!this.up) return;
    const C = CONFIG.audio.engine;
    const now = this.ac.currentTime;
    if (up && gear >= 2) {
      const cut = C.shiftCutMs / 1000;
      const g = this.shift.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(C.shiftDip, now + 0.035);
      g.setValueAtTime(C.shiftDip, now + cut);
      g.linearRampToValueAtTime(1, now + cut + 0.13);
      this.shiftUntil = now + cut + 0.08;
      const p = this.profile(this.model);
      if (this.load > 0.6 && Math.random() < p.shiftPop * (1 + this.perf * 0.6)) this.sfx.pop(now + 0.04, 0.8, this.lastPos);
    } else if (!up && gear >= 1) {
      this.downBlipUntil = now + 0.22;
    }
  }

  private lastPos = { x: 0, y: 0, z: 0 };

  update(now: number, dt: number, st: VehicleState, active: boolean, build: CarBuild | null): void {
    const C = CONFIG.audio.engine;
    const model = build?.model ?? null;
    this.perf = build?.perf?.engine ?? 0;
    if (active && model) {
      this.inactiveT = 0;
      this.ensureBaked(model);
      if (this.up && this.model !== model) this.teardown();
      if (!this.up && this.ready(model)) {
        this.buildGraph(model);
        if (this.catchT < 0) this.catchT = now + 0.05; // unlocked mid-drive: just fade in
      }
    } else {
      this.inactiveT += dt;
      if (this.up && this.inactiveT > C.sleepAfter) this.teardown();
    }
    this.dbg.model = this.model ?? '';
    const bk = model ? this.bakes.get(model) : undefined;
    this.dbg.layersReady = bk ? bk.on.filter(Boolean).length + bk.off.filter(Boolean).length : 0;
    this.dbg.bakeMs = bk ? +bk.ms.toFixed(1) : 0;
    if (!this.up) return;

    const ac = this.ac;
    const p = this.profile(this.model);
    const pts = p.bakeRpm;
    const r0 = pts[0];
    const rN = pts[pts.length - 1];
    const exploded = !!st.exploded;
    if (exploded && !this.wasExploded) this.catchT = -1;
    if (!exploded && this.wasExploded && this.catchT < 0) this.catchT = now + 0.4; // repaired without a start()
    this.wasExploded = exploded;
    this.lastPos.x = st.position.x;
    this.lastPos.y = st.position.y;
    this.lastPos.z = st.position.z;

    // ── rpm (with the start blip)
    let blip = 0;
    if (now >= this.blipT && this.blipAmt > 0) {
      const t = now - this.blipT;
      blip = t < 0.12 ? t / 0.12 : Math.exp(-(t - 0.12) / 0.3);
      if (t > 2) this.blipAmt = 0;
    }
    const rpmRaw = Number.isFinite(st.rpm) && st.rpm > 200 ? st.rpm : r0;
    const rpmT = Math.max(clamp(rpmRaw, r0 * 0.7, rN * 1.25), r0 + blip * this.blipAmt * 1400);
    this.rpmS = damp(this.rpmS, rpmT, C.rpmSmooth, dt);
    const rpm = this.rpmS;
    const rn = clamp((rpm - r0) / (rN * 1.05 - r0), 0, 1);

    // ── load
    let thr = exploded ? 0 : clamp(st.throttle || 0, 0, 1);
    if (now < this.shiftUntil) thr *= 0.3;
    if (now < this.downBlipUntil) thr = Math.max(thr, 0.7);
    thr = Math.max(thr, blip * this.blipAmt * 0.8);
    this.load = damp(this.load, thr, thr > this.load ? C.loadAttack : C.loadRelease, dt);
    const Lf = C.idleLoad + (1 - C.idleLoad) * this.load;
    this.dbg.rpm = Math.round(rpm);
    this.dbg.load = +this.load.toFixed(2);

    // ── alive (fade in after the catch; out on explosion / despawn)
    const on = active && !exploded && this.catchT >= 0 && now >= this.catchT;
    this.alive = damp(this.alive, on ? 1 : 0, on ? 9 : 14, dt);

    // ── layer weights (equal-power between neighbouring rpm points, log-rpm space)
    const W = this.dbg.weights;
    W.length = this.layers.length;
    let j = 0;
    while (j < this.layers.length - 1 && rpm > this.layers[j + 1].rpm) j++;
    for (let i = 0; i < this.layers.length; i++) W[i] = 0;
    if (rpm <= this.layers[0].rpm) W[0] = 1;
    else if (j >= this.layers.length - 1) W[this.layers.length - 1] = 1;
    else {
      const a = this.layers[j].rpm;
      const b = this.layers[j + 1].rpm;
      const t = clamp(Math.log(rpm / a) / Math.log(b / a), 0, 1);
      W[j] = Math.cos(t * Math.PI * 0.5);
      W[j + 1] = Math.sin(t * Math.PI * 0.5);
    }
    const onLvl = Math.sqrt(Lf) * (0.55 + 0.45 * rn);
    const offLvl = Math.sqrt(1 - Lf) * C.offLevel * (0.5 + 0.35 * rn);
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      setSmooth(ac, l.gOn.gain, W[i] * onLvl, 0.03, 1e-3);
      setSmooth(ac, l.gOff.gain, W[i] * offLvl, 0.03, 1e-3);
      const rate = rpm / l.rpm;
      setSmooth(ac, l.on.playbackRate, rate, 0.025, 5e-4);
      setSmooth(ac, l.off.playbackRate, rate, 0.025, 5e-4);
    }
    const lpT = clamp(Math.pow(Lf, 0.8) * (0.35 + 0.65 * rn), 0, 1);
    setSmooth(ac, this.lp.frequency, C.lpMin * Math.pow(C.lpMax / C.lpMin, lpT), 0.04, 5e-3);

    // ── intake roar
    const firing = (rpm / 60) * (p.cylinders / 2);
    setSmooth(ac, this.intakeBp.frequency, clamp(firing * 3.2, 250, 3500), 0.05, 5e-3);
    setSmooth(ac, this.intakeG.gain, C.intakeLevel * Math.pow(this.load, 1.5) * (0.3 + rn), 0.05, 1e-3);

    // ── rev limiter bounce
    const limiting = !exploded && (st.rpmNorm ?? 0) >= C.limiterNorm && thr > 0.6;
    this.dbg.limiter = limiting;
    if (limiting) {
      const ph = (now * C.limiterHz) % 1;
      this.limiter.gain.setTargetAtTime(ph < 0.45 ? 1 - C.limiterDepth : 1, now, 0.004);
    } else this.limiter.gain.setTargetAtTime(1, now, 0.02);

    // ── forced induction
    const perf = this.perf;
    const superCharged = perf >= 1 && this.model === 'muscle';
    const turbo = perf >= 1 && !superCharged;
    const k = perf >= 2 ? 1.4 : 1;
    this.boostEst = damp(this.boostEst, turbo ? this.load * smoothstep(0.2, 0.75, rn) : 0, this.load > this.boostEst ? 1.6 : 3.5, dt);
    const boost = turbo ? ((st.boost ?? 0) > 0.001 ? clamp(st.boost, 0, 1) : this.boostEst) : 0;
    this.dbg.boost = +boost.toFixed(2);
    if (turbo) {
      setSmooth(ac, this.whistle.frequency, 2200 + 5200 * boost, 0.05, 2e-3);
      setSmooth(ac, this.whistleG.gain, C.turboWhistle * k * boost * boost, 0.05, 1e-3);
      setSmooth(ac, this.whooshBp.frequency, 1800 + 2500 * boost, 0.05, 5e-3);
      setSmooth(ac, this.whooshG.gain, C.turboWhoosh * k * boost * this.load, 0.05, 1e-3);
      if (this.prevThrottle > 0.6 && thr < 0.2 && boost > 0.45 && now - this.lastBlowoff > 0.8) {
        this.lastBlowoff = now;
        this.sfx.blowoff(st.position, boost, perf >= 2 && Math.random() < 0.5);
        this.boostEst *= 0.2;
      }
    } else if (superCharged) {
      setSmooth(ac, this.whistle.frequency, rpm * 0.75, 0.03, 2e-3);
      setSmooth(ac, this.whistleG.gain, C.superchargerWhine * k * (0.3 + 0.7 * this.load) * rn, 0.05, 1e-3);
      setSmooth(ac, this.whooshG.gain, 0, 0.1, 1e-3);
    } else {
      setSmooth(ac, this.whistleG.gain, 0, 0.1, 1e-3);
      setSmooth(ac, this.whooshG.gain, 0, 0.1, 1e-3);
    }

    // ── reverse whine
    const spd = Math.abs(st.speed || 0);
    const rev = st.gear === -1 && spd > 0.3 && !exploded;
    setSmooth(ac, this.rev.frequency, 180 + spd * 110, 0.05, 2e-3);
    setSmooth(ac, this.revG.gain, rev ? C.reverseWhine * clamp(spd / 3, 0, 1) : 0, 0.06, 1e-3);

    // ── decel pops: on a sharp lift from high load, and a sparse burble while coasting at revs
    if (this.load > 0.6) this.highLoadT = now;
    if (!exploded && this.alive > 0.5) {
      const mult = perf >= 1 ? 1.5 : 1;
      if (this.prevThrottle > 0.5 && thr < 0.15 && now - this.highLoadT < 0.25 && rn > 0.45) {
        const n = Math.round((2 + Math.random() * 3) * p.popiness * mult);
        for (let i = 0; i < n; i++) this.sfx.pop(now + 0.06 + Math.random() * 0.6, 0.5 + Math.random() * 0.5, st.position);
        this.highLoadT = -10;
      } else if (thr < 0.08 && rn > 0.35 && spd > 4 && Math.random() < p.burble * 2.5 * rn * mult * dt) {
        this.sfx.pop(now, 0.3 + Math.random() * 0.4, st.position);
      }
    }
    this.prevThrottle = thr;

    // ── output level + position
    this.listener.calc(st.position, this.sp, CONFIG.audio.spatial.refDistance);
    const outG = C.level * p.level * this.alive * Math.min(1.15, this.sp.gain);
    setSmooth(ac, this.out.gain, outG, 0.03, 1e-3);
    this.dbg.alive = +this.alive.toFixed(2);
    this.dbg.out = +outG.toFixed(3);
    this.dbg.active = active;
    this.dbg.catchIn = +(this.catchT - now).toFixed(2);
    if (this.pan) setSmooth(ac, this.pan.pan, this.sp.pan, 0.05, 1e-3);
  }

  /** Model switched in the garage etc. → rebuild lazily. */
  reset(): void {
    this.teardown();
    this.catchT = -1;
  }

  get running(): boolean {
    return this.up;
  }
}
