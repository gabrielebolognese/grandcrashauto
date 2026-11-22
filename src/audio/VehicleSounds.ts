import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp, smoothstep } from '../core/math';
import type { VehicleState } from '../game/contracts';
import type { CarModelId } from '../vehicle/CarBuild';
import type { SfxBank } from './bakes';
import type { Mixer } from './Mixer';
import type { Held, Sfx } from './Sfx';
import { forgetParam, keep, setSmooth, type Listener, type SpatialResult, type Vec3Like } from './Voices';

/**
 * Continuous car-attached layers that live as long as the audio graph: tyre squeal, rolling road noise, off-road
 * crunch / water splash, wind rush, metal scrape. Plus the horn and the landing thump.
 * Built once (when the shared noise buffers exist) and only modulated afterwards.
 */
export interface VehicleExtra {
  snow: number; // 0..1 falling snow (muffles tyres)
  wet: number; // 0..1 road wetness
  turbo: boolean; // turbo boosting
  gliding: boolean; // turbo glide in the air
}

export class VehicleSounds {
  private built = false;
  private carOut!: GainNode;
  private carPan: StereoPannerNode | null = null;
  // squeal
  private sqOsc!: OscillatorNode;
  private sqBp!: BiquadFilterNode;
  private sqTone!: GainNode;
  private sqNoiseBp!: BiquadFilterNode;
  private sqNoise!: GainNode;
  // road / off-road
  private roadLp!: BiquadFilterNode;
  private roadG!: GainNode;
  private offRumble!: GainNode;
  private offBp!: BiquadFilterNode;
  private offHiss!: GainNode;
  private offAm!: GainNode;
  // wind
  private windBp!: BiquadFilterNode;
  private windG!: GainNode;
  // scrape
  private scBp1!: BiquadFilterNode;
  private scG1!: GainNode;
  private scG2!: GainNode;
  private scOut!: GainNode;
  private scPan: StereoPannerNode | null = null;
  private srcs: AudioScheduledSourceNode[] = [];
  // part 3: wet spray hiss, turbo turbine + rush
  private wetBp!: BiquadFilterNode;
  private wetG!: GainNode;
  private tbOsc!: OscillatorNode;
  private tbOsc2!: OscillatorNode;
  private tbWhineG!: GainNode;
  private tbBp!: BiquadFilterNode;
  private tbRushG!: GainNode;
  private turboAmt = 0;
  private suppressLandingUntil = 0;

  private sp: SpatialResult = { gain: 1, pan: 0, dist: 0, cutoff: 20000 };
  private tmp = new THREE.Vector3();
  private scrapePos = new THREE.Vector3();
  private scrapeT = -10;
  private scrapeI = 0;
  private scrapeHz = 2600;
  private gust = 0;
  private airT = 0;
  private vyMin = 0;
  private squealDrift = 0;
  private hornH: Held | null = null;
  private hornWanted = false;
  /** Debug */
  readonly dbg = { slip: 0, squeal: 0, road: 0, off: 0, wind: 0, scrape: 0 };

  constructor(
    private ac: AudioContext,
    private mixer: Mixer,
    private sfx: Sfx,
    private listener: Listener,
    private bank: SfxBank,
  ) {}

  private build(): void {
    const { ac, bank } = this;
    if (!bank.white || !bank.pink || !bank.brown) return;
    const bus = this.mixer.buses.sfx.input;
    const loop = (b: AudioBuffer) => {
      const s = keep(ac.createBufferSource());
      s.buffer = b;
      s.loop = true;
      s.start(0, Math.random() * (b.duration - 0.5));
      this.srcs.push(s);
      return s;
    };
    const gain = (v = 0) => {
      const g = keep(ac.createGain());
      g.gain.value = v;
      return g;
    };
    const filt = (type: BiquadFilterType, f: number, q = 0.707) => {
      const n = keep(ac.createBiquadFilter());
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const white = loop(bank.white);
    const pink = loop(bank.pink);
    const brown = loop(bank.brown);

    this.carOut = gain(0);
    if (typeof ac.createStereoPanner === 'function') {
      this.carPan = keep(ac.createStereoPanner());
      this.carOut.connect(this.carPan);
      this.carPan.connect(bus);
    } else this.carOut.connect(bus);

    // squeal: warbling sawtooth through a resonant band + band-passed noise
    this.sqOsc = keep(ac.createOscillator());
    this.sqOsc.type = 'sawtooth';
    this.sqOsc.frequency.value = CONFIG.audio.tyres.squealHz;
    const lfo1 = keep(ac.createOscillator());
    lfo1.frequency.value = 7.3;
    const lfo2 = keep(ac.createOscillator());
    lfo2.frequency.value = 11.7;
    const lg1 = gain(22);
    const lg2 = gain(11);
    lfo1.connect(lg1).connect(this.sqOsc.frequency);
    lfo2.connect(lg2).connect(this.sqOsc.frequency);
    this.sqBp = filt('bandpass', CONFIG.audio.tyres.squealHz * 1.15, 2.6);
    this.sqTone = gain(0);
    this.sqOsc.connect(this.sqBp).connect(this.sqTone).connect(this.carOut);
    this.sqNoiseBp = filt('bandpass', 2200, 1.3);
    this.sqNoise = gain(0);
    white.connect(this.sqNoiseBp).connect(this.sqNoise).connect(this.carOut);
    for (const o of [this.sqOsc, lfo1, lfo2]) {
      o.start();
      this.srcs.push(o);
    }

    // rolling road noise
    this.roadLp = filt('lowpass', 400, 0.6);
    this.roadG = gain(0);
    brown.connect(this.roadLp).connect(this.roadG).connect(this.carOut);

    // off-road rumble + surface hiss (sand spray / grass swish / water splash) with granular AM
    const offLp = filt('lowpass', 450, 0.7);
    this.offRumble = gain(0);
    brown.connect(offLp).connect(this.offRumble).connect(this.carOut);
    this.offBp = filt('bandpass', 2000, 0.8);
    this.offHiss = gain(0);
    this.offAm = gain(1);
    white.connect(this.offBp).connect(this.offHiss).connect(this.offAm).connect(this.carOut);

    // wind (non-positional: air rushing past the listener)
    this.windBp = filt('bandpass', 500, 0.7);
    this.windG = gain(0);
    pink.connect(this.windBp).connect(this.windG).connect(bus);

    // metal scrape: screech band + low grind
    this.scBp1 = filt('bandpass', 2600, 4);
    this.scG1 = gain(0.8);
    const scBp2 = filt('bandpass', 750, 1.5);
    this.scG2 = gain(0.9);
    this.scOut = gain(0);
    white.connect(this.scBp1).connect(this.scG1).connect(this.scOut);
    brown.connect(scBp2).connect(this.scG2).connect(this.scOut);
    if (typeof ac.createStereoPanner === 'function') {
      this.scPan = keep(ac.createStereoPanner());
      this.scOut.connect(this.scPan).connect(bus);
    } else this.scOut.connect(bus);
    // wet-road tyre spray
    this.wetBp = filt('bandpass', 3800, 0.7);
    this.wetG = gain(0);
    white.connect(this.wetBp).connect(this.wetG).connect(this.carOut);
    // turbo: turbine whine (two partials) + jet-like rush
    this.tbOsc = keep(ac.createOscillator());
    this.tbOsc.frequency.value = 2500;
    this.tbOsc2 = keep(ac.createOscillator());
    this.tbOsc2.type = 'triangle';
    this.tbOsc2.frequency.value = 3700;
    this.tbWhineG = gain(0);
    const tb2 = gain(0.35);
    this.tbOsc.connect(this.tbWhineG);
    this.tbOsc2.connect(tb2).connect(this.tbWhineG);
    this.tbWhineG.connect(this.carOut);
    for (const o of [this.tbOsc, this.tbOsc2]) {
      o.start();
      this.srcs.push(o);
    }
    this.tbBp = filt('bandpass', 1400, 0.9);
    this.tbRushG = gain(0);
    pink.connect(this.tbBp).connect(this.tbRushG).connect(this.carOut);
    this.built = true;
  }

  /** A stunt landing slam was played: skip the generic landing thump for a moment. */
  suppressLanding(sec = 0.6): void {
    this.suppressLandingUntil = this.ac.currentTime + sec;
  }

  shift(dx: number, dz: number): void {
    this.scrapePos.x -= dx;
    this.scrapePos.z -= dz;
  }

  scrape(e: { position: Vec3Like; intensity: number }): void {
    const now = this.ac.currentTime;
    const i = clamp(Number.isFinite(e.intensity) ? e.intensity : 0, 0, 1);
    this.scrapeI = now - this.scrapeT > 0.2 ? i : Math.max(i, this.scrapeI * 0.9);
    this.scrapeT = now;
    this.scrapePos.set(e.position.x, e.position.y, e.position.z);
  }

  hornOn(pos: Vec3Like, model: CarModelId | null): void {
    this.hornWanted = true;
    if (this.hornH && !this.hornH.dead) return;
    const freqs = CONFIG.audio.models[model ?? 'coupe']?.horn ?? [415, 523];
    this.hornH = this.sfx.horn(pos, freqs);
  }

  hornOff(): void {
    this.hornWanted = false;
    if (this.hornH) {
      this.hornH.stop(0.06);
      this.hornH = null;
    }
  }

  update(now: number, dt: number, st: VehicleState, alive: boolean, model: CarModelId | null, ext: VehicleExtra = { snow: 0, wet: 0, turbo: false, gliding: false }): void {
    if (!this.built) {
      this.build();
      if (!this.built) return;
    }
    const ac = this.ac;
    const T = CONFIG.audio.tyres;
    const prof = CONFIG.audio.models[model ?? 'coupe'];

    // horn follows the car
    if (this.hornH) {
      if (this.hornH.dead) this.hornH = null;
      else if (!alive) this.hornOff();
      else this.hornH.pos.copy(st.position);
    }

    // ── wheel analysis
    let n = 0;
    let hard = 0;
    let offN = 0;
    let wetN = 0;
    let sandN = 0;
    let maxSlip = 0;
    let sumSlip = 0;
    let slipX = 0;
    let slipZ = 0;
    let slipW = 0;
    const wheels = st.wheels ?? [];
    for (const w of wheels) {
      if (!w || !w.contact) continue;
      n++;
      const s = w.surface;
      if (s === 'sand' || s === 'grass') {
        offN++;
        if (s === 'sand') sandN++;
      } else if (s === 'water') wetN++;
      else {
        hard++;
        const sl = clamp(w.slip || 0, 0, 1);
        if (sl > maxSlip) maxSlip = sl;
        sumSlip += sl;
        slipX += w.position.x * sl;
        slipZ += w.position.z * sl;
        slipW += sl;
      }
    }
    const speed = Math.abs(st.speed || 0);
    let slip = n ? 0.65 * maxSlip + 0.35 * (sumSlip / n) : 0;
    if (!wheels.length && !st.airborne) {
      // Fallback (no per-wheel data): lateral sliding speed + handbrake.
      const v = st.velocity;
      const f = st.forward;
      const along = v.x * f.x + v.z * f.z;
      const lat = Math.hypot(v.x - f.x * along, v.z - f.z * along);
      slip = smoothstep(2, 9, lat) + (st.handbrake && speed > 5 ? 0.35 : 0);
      n = 4;
      hard = 4;
    }
    if (!alive) slip = 0;
    const hardFrac = n ? hard / n : 0;
    const offFrac = n ? offN / n : 0;
    const wetFrac = n ? wetN / n : 0;
    const spd01 = clamp(speed / 30, 0, 1.4);

    // ── car-attached spatial (position = car, biased to the sliding wheels)
    const pos = this.tmp.copy(st.position);
    if (slipW > 0.05) pos.set(slipX / slipW, st.position.y, slipZ / slipW);
    this.listener.calc(pos, this.sp, CONFIG.audio.spatial.refDistance);
    setSmooth(ac, this.carOut.gain, alive ? this.sp.gain : 0, 0.05, 1e-3);
    if (this.carPan) setSmooth(ac, this.carPan.pan, this.sp.pan, 0.06, 1e-3);

    // ── squeal
    const moving = Math.max(smoothstep(0.3, 2, speed), st.throttle > 0.5 ? 1 : 0);
    const tone = smoothstep(T.squealToneOn[0], T.squealToneOn[1], slip) * moving;
    const hiss = smoothstep(T.squealNoiseOn[0], T.squealNoiseOn[1], slip) * moving;
    this.squealDrift += (Math.random() - 0.5) * dt * 2;
    this.squealDrift = clamp(this.squealDrift * (1 - dt * 0.8), -0.08, 0.08);
    const f = (T.squealHz * (prof?.squeal ?? 1) + T.squealHzSlip * slip) * (1 + this.squealDrift) * (1 + Math.min(speed, 40) * 0.002);
    setSmooth(ac, this.sqOsc.frequency, f, 0.05, 2e-3);
    setSmooth(ac, this.sqBp.frequency, f * 1.15, 0.05, 2e-3);
    const snow = clamp(ext.snow, 0, 1) * CONFIG.audio.snowMuffle;
    setSmooth(ac, this.sqTone.gain, T.squealLevel * Math.pow(tone, 1.2) * Math.max(0, 1 - snow * 1.1), 0.04, 1e-3);
    setSmooth(ac, this.sqNoise.gain, T.squealLevel * 0.9 * Math.pow(hiss, 1.3) * (1 - snow * 0.6), 0.04, 1e-3);
    setSmooth(ac, this.sqNoiseBp.frequency, 2200 * (1 - snow * 0.55), 0.2, 1e-2);
    this.dbg.slip = slip;
    this.dbg.squeal = tone;

    // ── rolling road noise
    const road = alive ? T.roadLevel * Math.min(1.5, Math.pow(speed / 28, 1.3)) * hardFrac * (1 - snow * 0.35) : 0;
    setSmooth(ac, this.roadG.gain, road, 0.08, 1e-3);
    setSmooth(ac, this.roadLp.frequency, (250 + speed * 12) * (1 - snow), 0.1, 1e-2);
    // wet spray hiss (rolling through water film), quieter in snow
    const spray = alive ? CONFIG.audio.wetHiss * clamp(ext.wet, 0, 1) * Math.min(1.4, Math.pow(speed / 28, 1.2)) * hardFrac * (1 - snow) : 0;
    setSmooth(ac, this.wetG.gain, spray, 0.1, 1e-3);
    setSmooth(ac, this.wetBp.frequency, 2600 + speed * 40, 0.2, 1e-2);
    this.dbg.road = road;

    // ── off-road
    const off = alive ? T.offroadLevel * Math.min(1, spd01) * Math.min(1, offFrac + snow * 0.6) : 0;
    const wet = alive ? T.offroadLevel * Math.min(1, spd01 * 1.3) * wetFrac : 0;
    setSmooth(ac, this.offRumble.gain, off, 0.08, 1e-3);
    setSmooth(ac, this.offHiss.gain, off * 0.7 + wet * 1.3, 0.08, 1e-3);
    const sandW = offN ? sandN / offN : 0;
    const hz = offN + wetN > 0 ? ((3200 * sandW + 1600 * (1 - sandW)) * offN + 900 * wetN) / (offN + wetN) : 2000;
    setSmooth(ac, this.offBp.frequency, hz, 0.1, 1e-2);
    if (off + wet > 0.001) this.offAm.gain.setTargetAtTime(0.45 + Math.random() * 0.8, now, 0.015);
    this.dbg.off = off + wet;

    // ── turbo turbine + rush (and the air-glide rush)
    const TB = CONFIG.audio.turbo;
    const tOn = alive && (ext.turbo || ext.gliding);
    this.turboAmt += ((tOn ? 1 : 0) - this.turboAmt) * (1 - Math.exp(-dt * (tOn ? 4 : 1.6)));
    const ta = this.turboAmt;
    const tf = 2400 + Math.min(speed, 80) * 45 * (0.4 + 0.6 * ta);
    setSmooth(ac, this.tbOsc.frequency, tf, 0.06, 2e-3);
    setSmooth(ac, this.tbOsc2.frequency, tf * 1.48, 0.06, 2e-3);
    setSmooth(ac, this.tbWhineG.gain, TB.whine * ta * ta, 0.05, 1e-3);
    setSmooth(ac, this.tbRushG.gain, (TB.rush * ta + (ext.gliding && alive ? TB.glideRush : 0)) * (0.5 + 0.5 * Math.min(1, speed / 40)), 0.08, 1e-3);
    setSmooth(ac, this.tbBp.frequency, 900 + Math.min(speed, 80) * 25, 0.1, 1e-2);

    // ── wind
    const W = CONFIG.audio.wind;
    const kmh = alive ? st.speedKmh || 0 : 0;
    const w = Math.pow(smoothstep(W.startKmh, W.fullKmh, kmh), 1.5);
    this.gust += ((Math.random() - 0.5) * 3 - this.gust * 0.8) * dt;
    const windAmt = W.level * w * (st.airborne ? W.airborneBoost : 1) * clamp(1 + this.gust * 0.5, 0.6, 1.4);
    setSmooth(ac, this.windG.gain, windAmt, 0.12, 1e-3);
    setSmooth(ac, this.windBp.frequency, 350 + kmh * 6, 0.2, 1e-2);
    this.dbg.wind = windAmt;

    // ── scrape
    const S = CONFIG.audio.scrape;
    const scraping = now - this.scrapeT < S.holdMs / 1000;
    if (scraping) {
      this.listener.calc(this.scrapePos, this.sp, CONFIG.audio.spatial.refDistance);
      const lvl = S.level * Math.pow(this.scrapeI, 0.7) * (0.75 + Math.random() * 0.5) * this.sp.gain;
      this.scOut.gain.setTargetAtTime(lvl, now, 0.02);
      if (this.scPan) this.scPan.pan.setTargetAtTime(this.sp.pan, now, 0.05);
      this.scrapeHz = clamp(this.scrapeHz + (Math.random() - 0.5) * 900, 1800, 3500);
      this.scBp1.frequency.setTargetAtTime(this.scrapeHz, now, 0.03);
      this.dbg.scrape = lvl;
    } else if (this.dbg.scrape > 0) {
      this.scOut.gain.setTargetAtTime(0, now, 0.05);
      this.dbg.scrape = 0;
    }

    // ── landing thump
    if (alive && st.airborne) {
      this.airT += dt;
      this.vyMin = Math.min(this.vyMin, st.velocity.y);
    } else {
      if (alive && this.airT > T.landingMinAir && this.vyMin < -2 && now > this.suppressLandingUntil) this.sfx.landing(st.position, clamp(-this.vyMin / 10, 0.15, 1));
      this.airT = 0;
      this.vyMin = 0;
    }
    if (!this.hornWanted && this.hornH) this.hornOff();
  }

  /** Immediate silence for the continuous layers (explosion / despawn). */
  silence(): void {
    if (!this.built) return;
    const now = this.ac.currentTime;
    for (const g of [this.sqTone, this.sqNoise, this.roadG, this.offRumble, this.offHiss, this.scOut, this.wetG, this.tbWhineG, this.tbRushG]) {
      forgetParam(g.gain);
      g.gain.setTargetAtTime(0, now, 0.03);
    }
    this.hornOff();
  }
}
