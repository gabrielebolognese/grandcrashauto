import { CONFIG } from '../config';
import { clamp, damp, smoothstep } from '../core/math';
import type { DistrictId } from '../world/types';
import type { SfxBank } from './bakes';
import type { Mixer } from './Mixer';
import type { Sfx } from './Sfx';
import { keep, setSmooth, type Listener } from './Voices';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

export interface AmbienceInput {
  night: number; // 0 day .. 1 night
  npcDensity: number; // 0..~1.2 (active NPCs / preset count)
  speedKmh: number;
  schedule: boolean; // spawn one-shots (birds, far horns, pass-bys)
  shoreZ: number;
  district: DistrictId;
}

/**
 * City ambience: distant traffic bed (+ far horns and pass-bys), ocean swells near the beach (+Z), crowd babble scaled
 * by NPC density, gulls & songbirds by day, crickets at night, a light breeze. Persistent layers are built once and
 * modulated; one-shots go through the voice pool at low priority.
 */
export class Ambience {
  private built = false;
  private trafficOut!: GainNode;
  private oceanLp!: BiquadFilterNode;
  private oceanWave!: GainNode;
  private foamG!: GainNode;
  private oceanDistLp!: BiquadFilterNode;
  private oceanOut!: GainNode;
  private oceanPan: StereoPannerNode | null = null;
  private crowdOut!: GainNode;
  private talkG: GainNode[] = [];
  private talkBp: BiquadFilterNode[] = [];
  private talkT: number[] = [];
  private cricketOut!: GainNode;
  private breezeG!: GainNode;
  private nextWave = 0;
  private nextGull = 0;
  private nextSong = 0;
  private nextHorn = 0;
  private nextPass = 0;
  private f = { traffic: 0.6, crowd: 0.5, birds: 0.5 };
  private p = { x: 0, y: 0, z: 0 };
  readonly dbg = { traffic: 0, ocean: 0, crowd: 0, crickets: 0, district: 'downtown' as string };

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
    const bus = this.mixer.buses.ambience.input;
    const loop = (b: AudioBuffer) => {
      const s = keep(ac.createBufferSource());
      s.buffer = b;
      s.loop = true;
      s.start(0, Math.random() * (b.duration - 0.5));
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
    const lfo = (hz: number, depth: number, target: AudioParam, type: OscillatorType = 'sine') => {
      const o = keep(ac.createOscillator());
      o.type = type;
      o.frequency.value = hz;
      const g = gain(depth);
      o.connect(g).connect(target);
      o.start();
    };
    const white = loop(bank.white);
    const pink = loop(bank.pink);
    const brown = loop(bank.brown);

    // traffic hum: low rumble + distant tyre hiss, each with a slow swell
    this.trafficOut = gain(0);
    this.trafficOut.connect(bus);
    const tl = filt('lowpass', 280, 0.6);
    const tg1 = gain(0.75);
    brown.connect(tl).connect(tg1).connect(this.trafficOut);
    lfo(0.061, 0.25, tg1.gain);
    const tb = filt('bandpass', 650, 0.6);
    const tg2 = gain(0.3);
    pink.connect(tb).connect(tg2).connect(this.trafficOut);
    lfo(0.113, 0.14, tg2.gain);

    // ocean
    this.oceanOut = gain(0);
    this.oceanDistLp = filt('lowpass', 12000, 0.5);
    this.oceanOut.connect(this.oceanDistLp);
    if (typeof ac.createStereoPanner === 'function') {
      this.oceanPan = keep(ac.createStereoPanner());
      this.oceanDistLp.connect(this.oceanPan).connect(bus);
    } else this.oceanDistLp.connect(bus);
    this.oceanLp = filt('lowpass', 500, 0.6);
    this.oceanWave = gain(0.3);
    pink.connect(this.oceanLp).connect(this.oceanWave).connect(this.oceanOut);
    const fh = filt('highpass', 2500, 0.6);
    this.foamG = gain(0);
    white.connect(fh).connect(this.foamG).connect(this.oceanOut);

    // crowd babble: three "talkers" = moving formant bands with syllable-rate gating
    this.crowdOut = gain(0);
    const clp = filt('lowpass', 2200, 0.6);
    clp.connect(this.crowdOut).connect(bus);
    for (let i = 0; i < 3; i++) {
      const bp = filt('bandpass', rnd(450, 1400), 2.5);
      const g = gain(0);
      pink.connect(bp).connect(g).connect(clp);
      this.talkBp.push(bp);
      this.talkG.push(g);
      this.talkT.push(0);
    }

    // crickets (night): pulsed sine chirps, two individuals
    this.cricketOut = gain(0);
    this.cricketOut.connect(bus);
    for (const [hz, pulse, chirp] of [[4350, 30, 2.3], [4780, 34, 1.7]] as const) {
      const o = keep(ac.createOscillator());
      o.frequency.value = hz;
      const ga = gain(0.5);
      const gb = gain(0.5);
      lfo(pulse, 0.5, ga.gain, 'square');
      lfo(chirp, 0.5, gb.gain, 'square');
      o.connect(ga).connect(gb).connect(this.cricketOut);
      o.start();
    }

    // breeze
    const bb = filt('bandpass', 450, 0.5);
    this.breezeG = gain(0);
    pink.connect(bb).connect(this.breezeG).connect(bus);

    const now = ac.currentTime;
    this.nextWave = now + 0.5;
    this.nextGull = now + rnd(2, 6);
    this.nextSong = now + rnd(1, 4);
    this.nextHorn = now + rnd(4, 10);
    this.nextPass = now + rnd(3, 8);
    this.built = true;
  }

  private wave(now: number): void {
    const A = CONFIG.audio.ambience;
    const t = now + 0.05;
    const rise = rnd(1.6, 2.6);
    const fall = rnd(3, 4.5);
    const peak = rnd(0.75, 1);
    const g = this.oceanWave.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(peak, t, rise / 3);
    g.setTargetAtTime(0.28, t + rise, fall / 3);
    const f = this.oceanLp.frequency;
    f.cancelScheduledValues(t);
    f.setTargetAtTime(rnd(1600, 2200), t, rise / 3);
    f.setTargetAtTime(450, t + rise, fall / 2.5);
    const fg = this.foamG.gain;
    fg.cancelScheduledValues(t);
    fg.setTargetAtTime(0.02, t, 0.3);
    fg.setTargetAtTime(peak * 0.7, t + rise * 0.85, 0.15);
    fg.setTargetAtTime(0, t + rise + 0.4, fall / 3);
    this.nextWave = now + rnd(A.waveMin, A.waveMax);
  }

  update(now: number, dt: number, inp: AmbienceInput): void {
    if (!this.built) {
      this.build();
      if (!this.built) return;
    }
    const A = CONFIG.audio.ambience;
    const ac = this.ac;
    const L = this.listener;
    const dz = inp.shoreZ - L.pos.z; // > 0: inland of the waterline
    const night = clamp(inp.night, 0, 1);
    const day = 0.15 + 0.85 * (1 - night);

    const df = (A.district as Record<string, { traffic: number; crowd: number; birds: number }>)[inp.district] ?? A.district.downtown;
    this.f.traffic = damp(this.f.traffic, df.traffic, 0.6, dt);
    this.f.crowd = damp(this.f.crowd, df.crowd, 0.6, dt);
    this.f.birds = damp(this.f.birds, df.birds, 0.6, dt);
    this.dbg.district = inp.district;

    // traffic
    const traffic = A.trafficLevel * this.f.traffic * (1 - 0.35 * night);
    setSmooth(ac, this.trafficOut.gain, traffic, 0.5, 1e-3);
    this.dbg.traffic = traffic;

    // ocean
    const prox = 1 - smoothstep(A.oceanNear, A.oceanFar, dz);
    const ocean = A.oceanLevel * prox;
    setSmooth(ac, this.oceanOut.gain, ocean, 0.4, 1e-3);
    setSmooth(ac, this.oceanDistLp.frequency, 12000 * Math.pow(1200 / 12000, smoothstep(A.oceanNear, A.oceanFar, dz)), 0.4, 1e-2);
    if (this.oceanPan) setSmooth(ac, this.oceanPan.pan, clamp(L.right.z * 0.75 * smoothstep(0, 60, dz), -0.8, 0.8), 0.2, 1e-2);
    if (now >= this.nextWave) this.wave(now);
    this.dbg.ocean = ocean;
    const beach = 1 - smoothstep(10, 150, dz);

    // crowd
    const crowd = A.crowdLevel * clamp(inp.npcDensity, 0, 1.2) * this.f.crowd * (1 - 0.5 * night) * (1 - 0.6 * smoothstep(30, 90, inp.speedKmh));
    setSmooth(ac, this.crowdOut.gain, crowd, 0.5, 1e-3);
    this.dbg.crowd = crowd;
    if (crowd > 0.002) {
      for (let i = 0; i < 3; i++) {
        if (now < this.talkT[i]) continue;
        this.talkT[i] = now + rnd(0.07, 0.28);
        this.talkG[i].gain.setTargetAtTime(Math.random() < 0.3 ? 0 : rnd(0.3, 1), now, 0.03);
        if (Math.random() < 0.25) this.talkBp[i].frequency.setTargetAtTime(rnd(450, 1500), now, 0.05);
      }
    }

    // crickets + breeze
    const crickets = A.cricketLevel * night * this.f.birds * (1 - 0.5 * smoothstep(20, 70, inp.speedKmh));
    setSmooth(ac, this.cricketOut.gain, crickets, 0.8, 1e-3);
    this.dbg.crickets = crickets;
    const gust = 0.6 + 0.4 * Math.sin(now * 0.31) * Math.sin(now * 0.17 + 1);
    setSmooth(ac, this.breezeG.gain, A.breezeLevel * (0.5 + 0.5 * beach) * gust, 0.5, 2e-3);

    // one-shots
    if (!inp.schedule) return;
    const p = this.p;
    if (now >= this.nextGull) {
      this.nextGull = now + rnd(A.gullEvery[0], A.gullEvery[1]);
      if (Math.random() < day * (beach + 0.12)) {
        const a = Math.random() * Math.PI * 2;
        const r = rnd(25, 70);
        p.x = L.pos.x + Math.cos(a) * r;
        p.z = L.pos.z + Math.abs(Math.sin(a)) * r * (beach > 0.2 ? 1 : Math.sign(Math.sin(a)));
        p.y = L.pos.y + rnd(10, 25);
        this.sfx.gull(p);
      }
    }
    if (now >= this.nextSong) {
      this.nextSong = now + rnd(A.songbirdEvery[0], A.songbirdEvery[1]);
      if (Math.random() < day * day * this.f.birds * (1 - 0.6 * beach) * (1 - smoothstep(40, 100, inp.speedKmh))) {
        const a = Math.random() * Math.PI * 2;
        const r = rnd(10, 40);
        p.x = L.pos.x + Math.cos(a) * r;
        p.z = L.pos.z + Math.sin(a) * r;
        p.y = L.pos.y + rnd(3, 9);
        this.sfx.songbird(p);
      }
    }
    if (now >= this.nextHorn) {
      this.nextHorn = now + rnd(A.farHornEvery[0], A.farHornEvery[1]);
      if (Math.random() < this.f.traffic * (1 - 0.5 * night)) {
        const a = Math.random() * Math.PI * 2;
        const r = rnd(110, 170);
        p.x = L.pos.x + Math.cos(a) * r;
        p.z = L.pos.z + Math.sin(a) * r;
        p.y = L.pos.y;
        this.sfx.farHorn(p);
      }
    }
    if (now >= this.nextPass) {
      this.nextPass = now + rnd(A.passbyEvery[0], A.passbyEvery[1]);
      if (Math.random() < this.f.traffic * (1 - 0.4 * night)) {
        const side = Math.random() < 0.5 ? -1 : 1;
        p.x = L.pos.x + L.fwd.x * 50;
        p.y = L.pos.y;
        p.z = L.pos.z + L.fwd.z * 50;
        this.sfx.passby(p, side);
      }
    }
  }
}
