import { CONFIG } from '../config';
import { clamp, smoothstep } from '../core/math';
import type { SfxBank } from './bakes';
import type { Mixer } from './Mixer';
import type { Sfx } from './Sfx';
import { keep, setSmooth } from './Voices';

export interface WeatherInput {
  rain: number; // 0..1 precipitation
  snow: number; // 0..1 falling snow
  storm: number; // 0..1
  wind: number; // m/s (mean + gust)
  interior: boolean; // hood / cockpit view
  tunnel: number; // 0..1
  altitude: number; // listener height above sea level (m)
  wipers: boolean; // car interior view, car active
}

/**
 * Weather audio (SPEC-PART3 §6): rain hiss + droplet patter (seamless baked loops), roof drumming in the hood/cockpit
 * view, wipers in the hood view, wind howling at altitude and in storms (two wandering resonant bands + gust rush).
 * Thunder is a one-shot (Sfx.thunder) delayed by distance in Audio. Everything is cut inside tunnels.
 */
export class WeatherSounds {
  private built = false;
  private hissG!: GainNode;
  private patterG!: GainNode;
  private roofG!: GainNode;
  private howlBp1!: BiquadFilterNode;
  private howlBp2!: BiquadFilterNode;
  private howlG!: GainNode;
  private gustG!: GainNode;
  private nextWipe = 0;
  readonly dbg = { rain: 0, roof: 0, howl: 0, wipers: false };

  constructor(
    private ac: AudioContext,
    private mixer: Mixer,
    private sfx: Sfx,
    private bank: SfxBank,
  ) {}

  private build(): void {
    const { ac, bank } = this;
    if (!bank.white || !bank.pink || !bank.rain || !bank.roof) return;
    const bus = this.mixer.buses.ambience.input;
    const loop = (b: AudioBuffer) => {
      const s = keep(ac.createBufferSource());
      s.buffer = b;
      s.loop = true;
      s.start(0, Math.random() * (b.duration - 0.2));
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
    // rain: broadband hiss + droplet patter
    const hb = filt('bandpass', 4500, 0.5);
    this.hissG = gain(0);
    loop(bank.white).connect(hb).connect(this.hissG).connect(bus);
    const ph = filt('highpass', 1200, 0.6);
    this.patterG = gain(0);
    loop(bank.rain).connect(ph).connect(this.patterG).connect(bus);
    // roof drumming (heard from inside)
    const rl = filt('lowpass', 2600, 0.6);
    this.roofG = gain(0);
    loop(bank.roof).connect(rl).connect(this.roofG).connect(bus);
    // wind howl
    const pink = loop(bank.pink);
    this.howlG = gain(0);
    this.howlG.connect(bus);
    this.howlBp1 = filt('bandpass', 600, 6);
    this.howlBp2 = filt('bandpass', 1150, 8);
    const g1 = gain(1.6);
    const g2 = gain(1.0);
    pink.connect(this.howlBp1).connect(g1).connect(this.howlG);
    pink.connect(this.howlBp2).connect(g2).connect(this.howlG);
    const gl = filt('lowpass', 500, 0.6);
    this.gustG = gain(0);
    pink.connect(gl).connect(this.gustG).connect(bus);
    this.built = true;
  }

  update(now: number, inp: WeatherInput): void {
    const W = CONFIG.audio.weather;
    if (!this.built) {
      // Lazy: no idle noise loops on clear, calm days at low altitude (mobile CPU).
      const needed = inp.rain > 0.01 || inp.snow > 0.01 || inp.storm > 0.01 || inp.wind > 7 || inp.altitude > W.howlAltStart;
      if (!needed) return;
      this.build();
      if (!this.built) return;
    }
    const ac = this.ac;
    const open = 1 - clamp(inp.tunnel, 0, 1);
    const r = clamp(inp.rain, 0, 1) * (1 - smoothstep(0.2, 0.8, inp.snow)) * open;
    const snowHush = clamp(inp.snow, 0, 1) * 0.04 * open;
    setSmooth(ac, this.hissG.gain, W.rainLevel * 0.55 * Math.pow(r, 0.9) + snowHush, 0.4, 1e-3);
    setSmooth(ac, this.patterG.gain, W.rainLevel * Math.pow(r, 0.8) * (inp.interior ? 0.55 : 1), 0.4, 1e-3);
    const roof = W.roofLevel * Math.pow(r, 0.8) * (inp.interior ? 1 : 0.22);
    setSmooth(ac, this.roofG.gain, roof, 0.3, 1e-3);
    this.dbg.rain = +r.toFixed(2);
    this.dbg.roof = +roof.toFixed(3);

    // wipers (hood view, raining)
    const wipe = inp.wipers && r > 0.1;
    this.dbg.wipers = wipe;
    if (wipe && now >= this.nextWipe) {
      const period = 2.4 - 1.45 * r;
      const stroke = 0.42;
      this.sfx.wiper(stroke);
      window.setTimeout(() => this.sfx.wiper(stroke), (stroke + 0.06) * 1000);
      this.nextWipe = now + Math.max(period, stroke * 2 + 0.15);
    }

    // wind: altitude + storm + strong wind
    const alt = smoothstep(W.howlAltStart, W.howlAltFull, inp.altitude);
    const windy = smoothstep(8, 22, inp.wind);
    const storm = clamp(inp.storm, 0, 1);
    const howl = (W.howlLevel * Math.max(alt * 0.85, windy) + W.stormWind * storm) * open;
    setSmooth(ac, this.howlG.gain, howl * (0.75 + 0.25 * Math.sin(now * 0.7) * Math.sin(now * 0.23 + 2)), 0.3, 1e-3);
    setSmooth(ac, this.howlBp1.frequency, 520 + 260 * Math.sin(now * 0.31) + 120 * windy, 0.4, 1e-2);
    setSmooth(ac, this.howlBp2.frequency, 1100 + 300 * Math.sin(now * 0.19 + 1.3) + 200 * alt, 0.4, 1e-2);
    const gust = (0.5 + 0.5 * Math.sin(now * 1.3) * Math.sin(now * 0.47 + 0.6)) * (windy * 0.6 + storm) * 0.12 * open;
    setSmooth(ac, this.gustG.gain, gust, 0.25, 1e-3);
    this.dbg.howl = +howl.toFixed(3);
  }
}
