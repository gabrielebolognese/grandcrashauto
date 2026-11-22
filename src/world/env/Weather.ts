import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { WeatherKind, WeatherState } from '../../game/contracts';

/**
 * Weather state machine (SPEC-PART3 §6): clear → fewClouds → cloudy → overcast → rain → storm, fog, snow.
 * Auto mode picks weighted random successors (plausible neighbours only) with 1–3 min transitions; a locked
 * setting jumps there quickly and stays. Derives wetness, snow cover, grip, wind with gusts.
 */

interface Params {
  cover: number;
  rain: number;
  storm: number;
  fog: number;
  wind: number;
  clouds: number;
  snowAll: number;
}

const NEXT: Record<WeatherKind, WeatherKind[]> = {
  clear: ['fewClouds', 'cloudy', 'fog'],
  fewClouds: ['clear', 'cloudy', 'fog'],
  cloudy: ['fewClouds', 'overcast', 'lightRain', 'clear'],
  overcast: ['cloudy', 'lightRain', 'heavyRain', 'snow', 'fog'],
  lightRain: ['overcast', 'heavyRain', 'cloudy'],
  heavyRain: ['lightRain', 'storm', 'overcast'],
  storm: ['heavyRain', 'lightRain'],
  fog: ['clear', 'fewClouds', 'cloudy'],
  snow: ['overcast', 'cloudy'],
};

function params(kind: WeatherKind, out: Params): Params {
  const k = (CONFIG.env.weather.kinds as unknown as Record<string, Partial<Params>>)[kind] ?? {};
  out.cover = k.cover ?? 0;
  out.rain = k.rain ?? 0;
  out.storm = k.storm ?? 0;
  out.fog = k.fog ?? 0;
  out.wind = k.wind ?? 3;
  out.clouds = k.clouds ?? 0.5;
  out.snowAll = k.snowAll ?? 0;
  return out;
}

function blank(): Params {
  return { cover: 0, rain: 0, storm: 0, fog: 0, wind: 3, clouds: 0.5, snowAll: 0 };
}

export class Weather {
  readonly state: WeatherState = {
    kind: 'fewClouds', transition: 1, cloudCover: 0.2, rain: 0, snow: 0, fog: 0, wetness: 0, storm: 0,
    grip: 1, visibility: 3000, windSpeed: 3, gust: 0,
  };
  /** Current blended parameters (read by the environment). */
  readonly cur: Params = blank();
  readonly wind = new THREE.Vector3(2, 0, 1);
  snowCover = 0;
  snowLine = 600;
  /** Fraction of the cumulus field shown. */
  get clouds(): number {
    return this.cur.clouds;
  }

  private from: Params = blank();
  private to: Params = blank();
  private t = 1;
  private dur = 1;
  private remaining = 300;
  private time = Math.random() * 1000;
  private windAngle = 1.2;
  onChange: ((kind: WeatherKind) => void) | null = null;

  constructor(initial: WeatherKind) {
    this.state.kind = initial;
    params(initial, this.to);
    Object.assign(this.from, this.to);
    Object.assign(this.cur, this.to);
    this.remaining = this.randomDuration();
  }

  /** Go to `kind` over `seconds` (0 = instantly). */
  set(kind: WeatherKind, seconds: number): void {
    Object.assign(this.from, this.cur);
    params(kind, this.to);
    this.t = seconds <= 0 ? 1 : 0;
    this.dur = Math.max(0.01, seconds);
    if (this.t >= 1) Object.assign(this.cur, this.to);
    const changed = kind !== this.state.kind;
    this.state.kind = kind;
    this.remaining = this.randomDuration() + seconds;
    if (changed) this.onChange?.(kind);
  }

  private randomDuration(): number {
    const w = CONFIG.env.weather;
    return w.durationMin + Math.random() * (w.durationMax - w.durationMin);
  }

  private pickNext(): WeatherKind {
    const weights = CONFIG.env.weather.weights as unknown as Record<string, number>;
    const options = NEXT[this.state.kind] ?? ['clear'];
    let total = 0;
    for (const o of options) total += weights[o] ?? 1;
    let r = Math.random() * total;
    for (const o of options) {
      r -= weights[o] ?? 1;
      if (r <= 0) return o;
    }
    return options[0];
  }

  /**
   * @param locked null = auto, else the player's chosen weather
   * @param focusY altitude of the player (snow instead of rain above the snow line)
   */
  update(realDt: number, locked: WeatherKind | null, focusY: number): void {
    const cfg = CONFIG.env.weather;
    this.time += realDt;
    if (locked) {
      if (locked !== this.state.kind) this.set(locked, cfg.lockedTransition);
    } else {
      this.remaining -= realDt;
      if (this.remaining <= 0 && this.t >= 1) {
        this.set(this.pickNext(), cfg.transitionMin + Math.random() * (cfg.transitionMax - cfg.transitionMin));
      }
    }
    if (this.t < 1) {
      this.t = Math.min(1, this.t + realDt / this.dur);
      const s = this.t * this.t * (3 - 2 * this.t);
      const c = this.cur, a = this.from, b = this.to;
      c.cover = a.cover + (b.cover - a.cover) * s;
      // Rain lags the clouds a little (clouds build first, rain clears first).
      const sr = THREE.MathUtils.smoothstep(this.t, b.rain > a.rain ? 0.35 : 0, b.rain > a.rain ? 1 : 0.65);
      c.rain = a.rain + (b.rain - a.rain) * sr;
      c.storm = a.storm + (b.storm - a.storm) * sr;
      c.fog = a.fog + (b.fog - a.fog) * s;
      c.wind = a.wind + (b.wind - a.wind) * s;
      c.clouds = a.clouds + (b.clouds - a.clouds) * s;
      c.snowAll = a.snowAll + (b.snowAll - a.snowAll) * s;
    } else {
      params(this.state.kind, this.cur); // live tuning
    }

    const c = this.cur;
    this.snowLine = THREE.MathUtils.lerp(cfg.snowLine, -80, c.snowAll);
    const snowFrac = Math.max(c.snowAll, THREE.MathUtils.smoothstep(focusY, this.snowLine - 40, this.snowLine + 40));
    const precip = c.rain;
    const st = this.state;
    st.transition = this.t;
    st.cloudCover = c.cover;
    st.rain = precip * (1 - snowFrac);
    st.snow = precip * snowFrac;
    st.fog = c.fog;
    st.storm = c.storm;

    // Wet roads fade in over ~1 min of rain and dry over minutes; snow piles up and melts slowly.
    if (st.rain > 0.08) st.wetness = Math.min(1, st.wetness + (realDt / cfg.wetIn) * (0.4 + st.rain));
    else st.wetness = Math.max(0, st.wetness - realDt / cfg.dryOut);
    if (st.snow > 0.08) this.snowCover = Math.min(1, this.snowCover + (realDt / cfg.snowIn) * (0.4 + st.snow));
    else this.snowCover = Math.max(0, this.snowCover - realDt / cfg.snowOut);

    const snowAtFocus = Math.max(st.snow, this.snowCover * Math.max(c.snowAll, focusY > this.snowLine ? 1 : 0));
    const rainGrip = 1 - 0.25 * st.wetness - 0.1 * st.storm * st.wetness;
    st.grip = Math.min(rainGrip, 1 - 0.55 * THREE.MathUtils.clamp(snowAtFocus, 0, 1));

    // Wind: slowly veering direction, gusts from layered sines (storms gust hard).
    this.windAngle += realDt * 0.004 * Math.sin(this.time * 0.013);
    const t = this.time;
    const g = 0.5 + 0.5 * (Math.sin(t * 0.73) * 0.5 + Math.sin(t * 1.91 + 1.3) * 0.3 + Math.sin(t * 4.3 + 0.4) * 0.2);
    st.windSpeed = c.wind;
    st.gust = g * g * c.wind * (0.35 + 0.9 * c.storm);
    const speed = st.windSpeed + st.gust;
    this.wind.set(Math.sin(this.windAngle) * speed, 0, Math.cos(this.windAngle) * speed);
  }
}
