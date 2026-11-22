import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, damp, smoothstep } from '../core/math';
import type { PlaneState, PlaneTypeId, PlaneVisual } from '../plane/types';
import type { SfxBank } from './bakes';
import type { Mixer } from './Mixer';
import type { Held, Sfx } from './Sfx';
import { audioStats, setSmooth, type Listener, type SpatialResult, type Vec3Like, type Voice } from './Voices';

type TypeParams = (typeof CONFIG.audio.plane)['prop'];

interface EngineVoice {
  prop: boolean;
  dist: GainNode;
  pan: StereoPannerNode | null;
  // jet
  whine?: OscillatorNode;
  whine2?: OscillatorNode;
  whineG?: GainNode;
  fan?: OscillatorNode;
  fanBp?: BiquadFilterNode;
  fanG?: GainNode;
  roarLp?: BiquadFilterNode;
  roarG?: GainNode;
  // prop
  piston?: OscillatorNode;
  pistonLp?: BiquadFilterNode;
  pistonG?: GainNode;
  buzz?: OscillatorNode;
  buzzBp?: BiquadFilterNode;
  buzzG?: GainNode;
  washG?: GainNode;
  // both
  rumbleG: GainNode;
  spool: number;
  pos: THREE.Vector3;
}

export interface PlaneInput {
  active: boolean;
  state: PlaneState;
  visual: PlaneVisual | null;
  interior: boolean;
  sequence: boolean;
  burning: { pos: Vec3Like; amount: number } | null; // nearest burning wreck piece
}

/**
 * Plane audio: per-engine voices (prop = piston firing + blade-pass buzz + prop wash; jet = turbine whine + fan
 * buzz-saw + exhaust roar + rumble) driven by each engine's spool/status, airspeed wind, engine-fire roar torn by the
 * airflow, stall horn, master-caution tones, out-of-map beeping, and the explode-middle cockpit sequence (alarm
 * whoops + wind roar + shake rumble). Persistent nodes exist only while a plane is active.
 */
export class PlaneSounds {
  private up = false;
  private type: PlaneTypeId | null = null;
  private nodes: AudioNode[] = [];
  private srcs: AudioScheduledSourceNode[] = [];
  private engines: EngineVoice[] = [];
  private interiorLp!: BiquadFilterNode;
  private windBp!: BiquadFilterNode;
  private windG!: GainNode;
  private hissG!: GainNode;
  private fireLp!: BiquadFilterNode;
  private fireG!: GainNode;
  private fireAm!: GainNode;
  private firePan: StereoPannerNode | null = null;
  private seqG!: GainNode;
  private sp: SpatialResult = { gain: 1, pan: 0, dist: 0, cutoff: 20000 };
  private tmp = new THREE.Vector3();
  private firePos = new THREE.Vector3();
  private inactiveT = 0;
  private stallV: Voice | null = null;
  private stallEvt = false;
  private oom: 'ok' | 'warning' | 'failing' = 'ok';
  private nextBeep = 0;
  private beepAlt = false;
  private nextAlarm = 0;
  private lastCaution = -10;
  private wreckFire: Held | null = null;
  readonly dbg = { type: '' as string, spools: [] as number[], wind: 0, fire: 0, oom: 'ok' as string, stall: false, seq: false };

  constructor(
    private ac: AudioContext,
    private mixer: Mixer,
    private sfx: Sfx,
    private listener: Listener,
    private bank: SfxBank,
  ) {}

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    audioStats.persistentNodes++;
    return n;
  }

  private build(type: PlaneTypeId, visual: PlaneVisual | null, engineCount: number): boolean {
    const { ac, bank } = this;
    if (!bank.white || !bank.pink || !bank.brown) return false;
    const gain = (v = 0) => {
      const g = this.node(ac.createGain());
      g.gain.value = v;
      return g;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.707) => {
      const n = this.node(ac.createBiquadFilter());
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const loop = (b: AudioBuffer) => {
      const s = this.node(ac.createBufferSource());
      s.buffer = b;
      s.loop = true;
      s.start(0, Math.random() * (b.duration - 0.5));
      this.srcs.push(s);
      return s;
    };
    const osc = (type: OscillatorType, f: number) => {
      const o = this.node(ac.createOscillator());
      o.type = type;
      o.frequency.value = f;
      o.start();
      this.srcs.push(o);
      return o;
    };
    const pink = loop(bank.pink);
    const brown = loop(bank.brown);
    const white = loop(bank.white);
    const engBus = this.mixer.buses.engine.input;
    const sfxBus = this.mixer.buses.sfx.input;
    const hasPan = typeof ac.createStereoPanner === 'function';

    this.interiorLp = filt('lowpass', 20000, 0.5);
    this.interiorLp.connect(engBus);
    const n = Math.max(1, Math.min(4, engineCount));
    this.engines = [];
    for (let i = 0; i < n; i++) {
      const prop = visual?.engines?.[i]?.propeller ?? type === 'prop';
      const dist = gain(0);
      let pan: StereoPannerNode | null = null;
      if (hasPan) {
        pan = this.node(ac.createStereoPanner());
        dist.connect(pan).connect(this.interiorLp);
      } else dist.connect(this.interiorLp);
      const rumbleLp = filt('lowpass', 140, 0.7);
      const rumbleG = gain(0);
      brown.connect(rumbleLp).connect(rumbleG).connect(dist);
      const e: EngineVoice = { prop, dist, pan, rumbleG, spool: 0, pos: new THREE.Vector3() };
      if (prop) {
        e.piston = osc('sawtooth', 50);
        e.pistonLp = filt('lowpass', 600, 1.2);
        e.pistonG = gain(0);
        e.piston.connect(e.pistonLp).connect(e.pistonG).connect(dist);
        e.buzz = osc('square', 60);
        e.buzzBp = filt('bandpass', 300, 0.9);
        e.buzzG = gain(0);
        e.buzz.connect(e.buzzBp).connect(e.buzzG).connect(dist);
        const washBp = filt('bandpass', 900, 0.8);
        e.washG = gain(0);
        pink.connect(washBp).connect(e.washG).connect(dist);
      } else {
        e.whine = osc('sine', 2000);
        e.whine2 = osc('sine', 3000);
        e.whineG = gain(0);
        const w2 = gain(0.3);
        e.whine.connect(e.whineG);
        e.whine2.connect(w2).connect(e.whineG);
        e.whineG.connect(dist);
        e.fan = osc('sawtooth', 300);
        e.fanBp = filt('bandpass', 600, 1.5);
        e.fanG = gain(0);
        e.fan.connect(e.fanBp).connect(e.fanG).connect(dist);
        e.roarLp = filt('lowpass', 800, 0.6);
        e.roarG = gain(0);
        pink.connect(e.roarLp).connect(e.roarG).connect(dist);
      }
      this.engines.push(e);
    }

    // airspeed wind (non-positional)
    this.windBp = filt('bandpass', 400, 0.6);
    this.windG = gain(0);
    pink.connect(this.windBp).connect(this.windG).connect(sfxBus);
    const hp = filt('highpass', 3000, 0.6);
    this.hissG = gain(0);
    white.connect(hp).connect(this.hissG).connect(sfxBus);

    // engine fire roar, torn by the airflow
    const fireMix = gain(1);
    if (bank.fire) loop(bank.fire).connect(fireMix);
    const roarLp = filt('lowpass', 280, 0.7);
    const roarG = gain(1.2);
    brown.connect(roarLp).connect(roarG).connect(fireMix);
    this.fireLp = filt('lowpass', 4000, 0.6);
    this.fireAm = gain(1);
    this.fireG = gain(0);
    fireMix.connect(this.fireLp).connect(this.fireAm).connect(this.fireG);
    if (hasPan) {
      this.firePan = this.node(ac.createStereoPanner());
      this.fireG.connect(this.firePan).connect(sfxBus);
    } else this.fireG.connect(sfxBus);

    // cockpit-sequence shake rumble
    const seqLp = filt('lowpass', 170, 0.7);
    this.seqG = gain(0);
    brown.connect(seqLp).connect(this.seqG).connect(sfxBus);

    this.type = type;
    this.up = true;
    return true;
  }

  private teardown(): void {
    if (!this.up) return;
    const now = this.ac.currentTime;
    for (const s of this.srcs) {
      try {
        s.stop(now + 0.15);
      } catch {
        /* ignore */
      }
    }
    const nodes = this.nodes;
    for (const e of this.engines) e.dist.gain.setTargetAtTime(0, now, 0.03);
    this.windG.gain.setTargetAtTime(0, now, 0.03);
    this.hissG.gain.setTargetAtTime(0, now, 0.03);
    this.fireG.gain.setTargetAtTime(0, now, 0.03);
    this.seqG.gain.setTargetAtTime(0, now, 0.03);
    window.setTimeout(() => {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {
          /* ignore */
        }
      }
      audioStats.persistentNodes -= nodes.length;
    }, 300);
    this.nodes = [];
    this.srcs = [];
    this.engines = [];
    this.up = false;
    this.type = null;
  }

  // ── events ──
  stallWarning(on: boolean): void {
    this.stallEvt = on;
  }

  outOfMap(state: 'ok' | 'warning' | 'failing'): void {
    if (state !== this.oom) this.nextBeep = 0;
    this.oom = state;
  }

  masterCaution(level: 'caution' | 'warning'): void {
    const now = this.ac.currentTime;
    if (now - this.lastCaution < 0.8) return;
    this.lastCaution = now;
    this.sfx.caution(level);
  }

  /** Floating origin: shift cached world positions. */
  shift(dx: number, dz: number): void {
    for (const e of this.engines) {
      e.pos.x -= dx;
      e.pos.z -= dz;
    }
    this.firePos.x -= dx;
    this.firePos.z -= dz;
  }

  private params(): TypeParams {
    return (CONFIG.audio.plane as unknown as Record<string, TypeParams>)[this.type ?? 'prop'] ?? CONFIG.audio.plane.prop;
  }

  update(now: number, dt: number, inp: PlaneInput): void {
    const P = CONFIG.audio.plane;
    const ps = inp.state;
    const type = ps.type;
    const active = inp.active && !!type;
    if (active) {
      this.inactiveT = 0;
      const nEng = Math.max(ps.engines?.length ?? 0, inp.visual?.engines?.length ?? 0, 1);
      if (this.up && (this.type !== type || this.engines.length !== Math.min(4, nEng))) this.teardown();
      if (!this.up && !this.build(type!, inp.visual, nEng)) return;
    } else {
      this.inactiveT += dt;
      if (this.stallV) this.stopStall();
      if (this.up && this.inactiveT > 2) this.teardown();
      this.updateWreckFire(inp);
      if (!this.up) return;
    }
    this.dbg.type = this.type ?? '';
    const ac = this.ac;
    const T = this.params();
    const airKmh = active ? ps.airspeedKmh || 0 : 0;
    const air01 = smoothstep(60, P.windFullKmh, airKmh);

    // ── engines
    setSmooth(ac, this.interiorLp.frequency, inp.interior ? P.interiorCutoff : 20000, 0.1, 1e-2);
    const S = this.dbg.spools;
    S.length = this.engines.length;
    let fireAmt = 0;
    let fx = 0;
    let fy = 0;
    let fz = 0;
    for (let i = 0; i < this.engines.length; i++) {
      const e = this.engines[i];
      const es = ps.engines?.[i];
      const status = es?.status ?? 'ok';
      const dead = status === 'destroyed' || status === 'detached';
      let target = active ? (es ? clamp(es.spool, 0, 1) : clamp(ps.throttle, 0, 1)) : 0;
      if (dead) target = e.prop ? clamp(airKmh / 400, 0, 0.3) : 0; // windmilling prop / spooling-down turbine
      e.spool = damp(e.spool, target, dead ? 0.7 : target > e.spool ? 2.5 : 1.6, dt);
      const s = e.spool;
      S[i] = +s.toFixed(2);
      const ei = inp.visual?.engines?.[i];
      if (ei && inp.visual) inp.visual.root.localToWorld(e.pos.copy(ei.thrustPoint));
      else e.pos.copy(ps.position);
      this.listener.calc(e.pos, this.sp, T.ref, P.maxDistance);
      setSmooth(ac, e.dist.gain, active ? P.engineLevel * this.sp.gain : 0, 0.05, 1e-3);
      if (e.pan) setSmooth(ac, e.pan.pan, this.sp.pan, 0.05, 1e-3);
      if (e.prop) {
        const rpm = T.idleRpm + (T.maxRpm - T.idleRpm) * s;
        const firing = (rpm / 60) * 3; // flat-six: 3 firings per revolution
        const blade = (rpm / 60) * Math.max(1, T.blades);
        setSmooth(ac, e.piston!.frequency, Math.max(8, firing), 0.04, 2e-3);
        setSmooth(ac, e.pistonLp!.frequency, 300 + 1500 * s, 0.05, 5e-3);
        setSmooth(ac, e.pistonG!.gain, dead ? 0 : T.piston * (0.35 + 0.65 * s), 0.06, 1e-3);
        setSmooth(ac, e.buzz!.frequency, Math.max(4, blade), 0.04, 2e-3);
        setSmooth(ac, e.buzzBp!.frequency, Math.max(120, blade * 4), 0.05, 5e-3);
        setSmooth(ac, e.buzzG!.gain, T.buzz * Math.pow(s, 1.2), 0.06, 1e-3);
        setSmooth(ac, e.washG!.gain, T.wash * s * s, 0.08, 1e-3);
      } else {
        setSmooth(ac, e.whine!.frequency, T.whineHz * (0.32 + 0.68 * s), 0.05, 2e-3);
        setSmooth(ac, e.whine2!.frequency, T.whineHz * 1.51 * (0.32 + 0.68 * s), 0.05, 2e-3);
        setSmooth(ac, e.whineG!.gain, T.whine * smoothstep(0.02, 0.3, s) * (0.6 + 0.4 * s), 0.08, 1e-3);
        const fan = T.fanHz * (0.15 + 0.85 * s);
        setSmooth(ac, e.fan!.frequency, fan, 0.05, 2e-3);
        setSmooth(ac, e.fanBp!.frequency, fan * 2, 0.05, 5e-3);
        setSmooth(ac, e.fanG!.gain, T.fan * s * s * s, 0.08, 1e-3);
        setSmooth(ac, e.roarLp!.frequency, 250 + 2500 * Math.pow(s, 1.2), 0.08, 5e-3);
        setSmooth(ac, e.roarG!.gain, T.roar * Math.pow(s, 1.5) * (0.6 + 0.4 * clamp(ps.throttle, 0, 1)), 0.08, 1e-3);
      }
      setSmooth(ac, e.rumbleG.gain, T.rumble * (e.prop ? s : s * s), 0.1, 1e-3);
      const f = active ? clamp(es?.fire ?? (status === 'fire' ? 0.6 : 0), 0, 1) : 0;
      if (f > 0.01) {
        fireAmt += f;
        fx += e.pos.x * f;
        fy += e.pos.y * f;
        fz += e.pos.z * f;
      }
    }

    // ── fire roar (follows fire size, duller + flutter at speed)
    if (fireAmt > 0.01) this.firePos.set(fx / fireAmt, fy / fireAmt, fz / fireAmt);
    this.listener.calc(this.firePos, this.sp, 14, P.maxDistance);
    const fireLvl = P.fireLevel * Math.min(1.4, fireAmt) * this.sp.gain;
    setSmooth(ac, this.fireG.gain, fireLvl, 0.25, 1e-3);
    if (this.firePan) setSmooth(ac, this.firePan.pan, this.sp.pan, 0.08, 1e-3);
    setSmooth(ac, this.fireLp.frequency, 4500 - 3000 * air01, 0.2, 1e-2);
    if (fireLvl > 0.002) this.fireAm.gain.setTargetAtTime(1 - 0.5 * air01 * Math.random(), now, 0.02);
    this.dbg.fire = +fireAmt.toFixed(2);

    // ── wind (cockpit sequence: strong broadband roar)
    const seq = active && inp.sequence;
    let wind = P.windLevel * Math.pow(air01, 1.3) * (inp.interior ? 0.85 : 1);
    if (seq) wind = Math.max(wind, P.sequenceWind);
    setSmooth(ac, this.windG.gain, active ? wind : 0, 0.15, 1e-3);
    setSmooth(ac, this.windBp.frequency, seq ? 600 : 250 + airKmh * 2, 0.2, 1e-2);
    setSmooth(ac, this.windBp.Q, seq ? 0.35 : 0.6, 0.2, 1e-2);
    setSmooth(ac, this.hissG.gain, active ? P.windLevel * 0.4 * air01 * air01 + (seq ? 0.08 : 0) : 0, 0.15, 1e-3);
    this.dbg.wind = +wind.toFixed(3);
    this.dbg.seq = seq;
    if (seq) {
      this.seqG.gain.setTargetAtTime(0.25 + Math.random() * 0.35, now, 0.03);
      if (now >= this.nextAlarm) {
        this.nextAlarm = now + 0.72;
        this.sfx.alarmTone();
      }
    } else if (this.seqG.gain.value > 0.001) this.seqG.gain.setTargetAtTime(0, now, 0.1);

    // ── stall horn
    const stall = active && (ps.stallWarning || this.stallEvt) && ps.phase !== 'crashed' && ps.phase !== 'destroyed';
    if (stall && !this.stallV) this.stallV = this.sfx.stallHorn();
    else if (!stall && this.stallV) this.stopStall();
    this.dbg.stall = !!this.stallV;

    // ── out-of-map beeping
    const oom = active ? (ps.outOfMap?.state && ps.outOfMap.state !== 'ok' ? ps.outOfMap.state : this.oom) : 'ok';
    this.dbg.oom = oom;
    if (oom !== 'ok' && now >= this.nextBeep) {
      if (oom === 'warning') {
        this.sfx.beep(1000, 0.12);
        this.nextBeep = now + 1;
      } else {
        this.beepAlt = !this.beepAlt;
        this.sfx.beep(this.beepAlt ? 1320 : 990, 0.1, 1.2);
        this.nextBeep = now + 0.42;
      }
    }
    this.updateWreckFire(inp);
  }

  private updateWreckFire(inp: PlaneInput): void {
    const b = inp.burning;
    if (b && b.amount > 0.05) {
      if (!this.wreckFire || this.wreckFire.dead) this.wreckFire = this.sfx.startFire(b.pos, CONFIG.audio.plane.wreckFireLevel, 16, 1500);
      if (this.wreckFire) {
        this.wreckFire.pos.set(b.pos.x, b.pos.y, b.pos.z);
        this.wreckFire.base = clamp(b.amount, 0.2, 1.4);
      }
    } else if (this.wreckFire) {
      this.wreckFire.stop(1.2);
      this.wreckFire = null;
    }
  }

  private stopStall(): void {
    this.stallV?.release(this.ac.currentTime, 0.08);
    this.stallV = null;
  }

  /** Respawn / back to car: silence everything immediately. */
  reset(): void {
    this.stopStall();
    this.oom = 'ok';
    this.stallEvt = false;
    if (this.wreckFire) {
      this.wreckFire.stop(0.4);
      this.wreckFire = null;
    }
  }
}
