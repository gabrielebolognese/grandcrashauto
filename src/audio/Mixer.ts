import { CONFIG } from '../config';
import type { Settings } from '../core/Settings';
import { keep, setSmooth } from './Voices';

export type BusName = 'engine' | 'sfx' | 'ambience' | 'ui';
export const BUS_NAMES: readonly BusName[] = ['engine', 'sfx', 'ambience', 'ui'];

export interface Bus {
  /** Voices / loops connect here. */
  readonly input: GainNode;
  /** Bus volume (settings × ducking). */
  readonly vol: GainNode;
  /** Reverb send entry, scaled like `vol` (null for ui). */
  readonly send: GainNode | null;
  analyser: AnalyserNode | null;
}

export interface DuckState {
  engine: number;
  sfx: number;
  ambience: number;
  cutoff: number;
}

/**
 * Mix graph:
 *   engine/sfx/ambience bus → vol ─┐                     ┌→ (analysers in ?debug)
 *   bus.send ─→ convolver ─→ return ┴→ world lowpass ─→ master → compressor → limiter → destination
 *   ui bus → vol ───────────────────────────────────────↗
 * The world lowpass muffles everything but UI when paused / in the garage.
 */
export class Mixer {
  readonly buses: Record<BusName, Bus>;
  readonly world: BiquadFilterNode;
  readonly master: GainNode;
  readonly comp: DynamicsCompressorNode;
  readonly limiter: DynamicsCompressorNode;
  readonly reverb: ConvolverNode;
  readonly reverbReturn: GainNode;
  masterAnalyser: AnalyserNode | null = null;
  /** Tunnel slap-back echo (two taps + damped feedback), fed from the engine/sfx buses by setTunnel(). */
  private echoSendE!: GainNode;
  private echoSendS!: GainNode;
  private scratch: Float32Array<ArrayBuffer> | null = null;

  constructor(
    readonly ac: AudioContext,
    debug: boolean,
  ) {
    const C = CONFIG.audio;
    this.master = keep(ac.createGain());
    this.master.gain.value = 0;
    this.comp = keep(ac.createDynamicsCompressor());
    this.limiter = keep(ac.createDynamicsCompressor());
    const setComp = (n: DynamicsCompressorNode, c: { threshold: number; knee: number; ratio: number; attack: number; release: number }) => {
      n.threshold.value = c.threshold;
      n.knee.value = c.knee;
      n.ratio.value = c.ratio;
      n.attack.value = c.attack;
      n.release.value = c.release;
    };
    setComp(this.comp, C.compressor);
    setComp(this.limiter, C.limiter);
    this.master.connect(this.comp).connect(this.limiter).connect(ac.destination);

    this.world = keep(ac.createBiquadFilter());
    this.world.type = 'lowpass';
    this.world.frequency.value = 20000;
    this.world.Q.value = 0.5;
    this.world.connect(this.master);

    this.reverb = keep(ac.createConvolver());
    this.reverb.normalize = true;
    this.reverbReturn = keep(ac.createGain());
    this.reverbReturn.gain.value = C.reverb.returnGain;
    this.reverb.connect(this.reverbReturn).connect(this.world);

    const mk = (name: BusName): Bus => {
      const input = keep(ac.createGain());
      const vol = keep(ac.createGain());
      vol.gain.value = 0;
      input.connect(vol);
      vol.connect(name === 'ui' ? this.master : this.world);
      let send: GainNode | null = null;
      if (name !== 'ui') {
        send = keep(ac.createGain());
        send.gain.value = 0;
        send.connect(this.reverb);
      }
      let analyser: AnalyserNode | null = null;
      if (debug) {
        analyser = keep(ac.createAnalyser());
        analyser.fftSize = 2048;
        vol.connect(analyser);
      }
      return { input, vol, send, analyser };
    };
    this.buses = { engine: mk('engine'), sfx: mk('sfx'), ambience: mk('ambience'), ui: mk('ui') };
    // tunnel echo
    const T = C.tunnel;
    const echoIn = keep(ac.createGain());
    const d1 = keep(ac.createDelay(0.5));
    d1.delayTime.value = T.delay1;
    const d2 = keep(ac.createDelay(0.5));
    d2.delayTime.value = T.delay2;
    const elp = keep(ac.createBiquadFilter());
    elp.type = 'lowpass';
    elp.frequency.value = 3200;
    const efb = keep(ac.createGain());
    efb.gain.value = T.feedback;
    const eout = keep(ac.createGain());
    eout.gain.value = 0.75;
    echoIn.connect(d1);
    echoIn.connect(d2);
    d1.connect(elp);
    d2.connect(elp);
    elp.connect(efb);
    efb.connect(d1);
    elp.connect(eout);
    eout.connect(this.world);
    this.echoSendE = keep(ac.createGain());
    this.echoSendE.gain.value = 0;
    this.echoSendS = keep(ac.createGain());
    this.echoSendS.gain.value = 0;
    this.buses.engine.vol.connect(this.echoSendE).connect(echoIn);
    this.buses.sfx.vol.connect(this.echoSendS).connect(echoIn);
    if (debug) {
      this.masterAnalyser = keep(ac.createAnalyser());
      this.masterAnalyser.fftSize = 2048;
      this.limiter.connect(this.masterAnalyser);
    }
  }

  setImpulse(buf: AudioBuffer): void {
    try {
      this.reverb.buffer = buf;
    } catch {
      /* some browsers refuse odd sample rates — reverb just stays dry */
    }
  }

  /** Apply settings volumes + ducking (call every frame; only schedules automation on change). */
  apply(s: Readonly<Settings>, duck: DuckState, extraAmbience: number, tau: number, tunnel = 0): void {
    const C = CONFIG.audio;
    const ac = this.ac;
    const curve = (v: number) => Math.pow(Math.max(0, Math.min(1, v)), C.volumeCurve);
    setSmooth(ac, this.master.gain, s.muted ? 0 : curve(s.masterVolume) * C.masterGain, 0.05);
    const lv: Record<BusName, number> = {
      engine: curve(s.engineVolume) * C.busGain.engine * duck.engine,
      sfx: curve(s.sfxVolume) * C.busGain.sfx * duck.sfx,
      ambience: curve(s.ambienceVolume) * C.busGain.ambience * duck.ambience * extraAmbience * (1 - tunnel * (1 - C.tunnel.ambienceDuck)),
      ui: curve(s.sfxVolume) * C.busGain.ui,
    };
    for (const name of BUS_NAMES) {
      const b = this.buses[name];
      setSmooth(ac, b.vol.gain, lv[name], tau);
      if (b.send) setSmooth(ac, b.send.gain, lv[name], tau);
    }
    setSmooth(ac, this.world.frequency, duck.cutoff, tau);
    setSmooth(ac, this.reverbReturn.gain, C.reverb.returnGain * (1 + tunnel * C.tunnel.reverbBoost), 0.15);
    setSmooth(ac, this.echoSendE.gain, tunnel * C.tunnel.echoSend, 0.15, 1e-3);
    setSmooth(ac, this.echoSendS.gain, tunnel * C.tunnel.echoSend * 0.8, 0.15, 1e-3);
  }

  /** Instantaneous RMS of a bus (post volume) or the master output, over the analyser window. */
  rms(name: BusName | 'master'): number {
    const an = name === 'master' ? this.masterAnalyser : this.buses[name].analyser;
    if (!an) return -1;
    if (!this.scratch || this.scratch.length !== an.fftSize) this.scratch = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(this.scratch);
    let s = 0;
    for (let i = 0; i < this.scratch.length; i++) s += this.scratch[i] * this.scratch[i];
    return Math.sqrt(s / this.scratch.length);
  }
}
