import * as THREE from 'three';
import './agent.css';
import { CONFIG } from '../config';
import type { ControlState } from '../core/Input';
import { G, groups } from '../core/Physics';
import { clamp, DEG } from '../core/math';
import type { FlightSnapshot, GameContext, IAgent } from '../game/contracts';
import type { PlaneTypeId } from '../plane/types';
import { fallForecast, forecastFlight, wreckG, type FlightForecast, type GhostControls, type GhostView, type GroundSample } from './predict';

/**
 * Agent mode (?agent) — the game made playable from TEXT by an AI agent (Claude in Chrome & co).
 *
 *  - A live text view (DOM panel #agent-panel, also gca.state()): what is happening now, the held controls, the
 *    autopilot, a FORECAST of the next seconds ("+2.0 s split at 48 m, front half hits the ground ≈ +5.3 s"), the
 *    queue of timed commands, timers (wing spin, tail fire), recent events and the keys.
 *  - Keys latch: a TAP acts like holding the key for 1 s (each extra tap adds 1 s), so an agent that can only tap
 *    can still fly and drive. Opposite key = switch direction, Backspace = release everything.
 *  - Commands with timing: gca.do("night; fly jumbo agl 25; alt 25; wait 4; pitch up 2; wait 2; split").
 *  - Autopilot helpers: terrain-following altitude hold, heading hold, bank hold, speed hold.
 *  - Turn-based: K freezes the world (the frame stays), "." / "run 1" advances exactly 1 s of game time.
 *  - The game keeps running when the browser window is in the background (engine worker clock).
 */

type Axis = 'pitch' | 'roll' | 'yaw' | 'throttle' | 'brake' | 'steer' | 'handbrake' | 'turbo' | 'moveX' | 'moveY' | 'grab' | 'run' | 'jump';
interface Hold {
  value: number;
  left: number;
}
interface Autopilot {
  alt: number | null; // m above ground (wheels), terrain following
  heading: number | null; // deg, 0 = north, 90 = east
  bank: number | null; // deg, + = right
  speed: number | null; // m/s airspeed
  /** Homing (fly … target <place>): ABSOLUTE point the plane steers and dives into. */
  target: { x: number; y: number; z: number; name: string } | null;
}
interface Queued {
  at: number;
  cmd: string;
}
type Plan =
  | { k: 'hold'; axis: Axis; value: number; secs: number }
  | { k: 'ap'; key: keyof Autopilot; value: number | null }
  | { k: 'stop'; label: string }
  | { k: 'none' };

/** Endpoint contract version: read from public/endpoint.md ("Endpoint version: N") at build time (vite.config.ts). */
declare const __ENDPOINT_VERSION__: number;
const PULSE = 1; // s of hold per key tap
const MAX_HOLD = 20;
const PLANE_NAMES: Record<PlaneTypeId, string> = { prop: 'Prop plane', bizjet: 'Private jet', airliner: 'Airliner', jumbo: 'Jumbo (747)' };
const TYPE_ALIAS: Record<string, PlaneTypeId> = {
  prop: 'prop', propeller: 'prop', cessna: 'prop', small: 'prop',
  jet: 'bizjet', bizjet: 'bizjet', private: 'bizjet', privatejet: 'bizjet',
  airliner: 'airliner', liner: 'airliner', '737': 'airliner', a320: 'airliner',
  jumbo: 'jumbo', '747': 'jumbo', b747: 'jumbo', boeing: 'jumbo',
};
const WEATHER: Record<string, string> = {
  clear: 'clear', sunny: 'clear', cloudy: 'cloudy', clouds: 'fewClouds', overcast: 'overcast', rain: 'heavyRain', drizzle: 'lightRain',
  storm: 'storm', thunder: 'storm', fog: 'fog', foggy: 'fog', snow: 'snow', auto: 'auto',
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const HEADINGS: Record<string, number> = { n: 0, north: 0, ne: 45, e: 90, east: 90, se: 135, s: 180, south: 180, sw: 225, w: 270, west: 270, nw: 315 };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p = new THREE.Vector3();

const f0 = (n: number) => String(Math.round(n));
const s0 = (n: number) => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n));
const t1 = (n: number) => n.toFixed(1);
const hdg = (h: number) => `${String(Math.round(((h % 360) + 360) % 360)).padStart(3, '0')}° ${COMPASS[Math.round((((h % 360) + 360) % 360) / 45) % 8]}`;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

export class Agent implements IAgent {
  readonly name = 'agent';
  frozen = false;
  private simT = 0;
  private runUntil = Infinity;
  private holds = new Map<Axis, Hold>();
  private ap: Autopilot = { alt: null, heading: null, bank: null, speed: null, target: null };
  private throttleCmd: number | null = null;
  private queue: Queued[] = [];
  private override: Partial<ControlState> = {};
  private events: { t: number; text: string }[] = [];
  private panel!: HTMLPreElement;
  private body!: HTMLDivElement;
  private collapsed = false;
  private textT = 0;
  private fcT = 0;
  private fc: FlightForecast | null = null;
  private fcDirty = true;
  private fcLines: string[] = [];
  private lastText = '';
  private snap: FlightSnapshot | null = null;
  private weatherBefore: string | null = null;
  private groundCache = new Map<number, GroundSample>();
  private groundCacheT = 0;
  private filmBuf: { w: number; h: number; c: HTMLCanvasElement; x: CanvasRenderingContext2D; px: Uint8Array; img: ImageData } | null = null;

  constructor(private ctx: GameContext) {}

  // ─────────────────────────────── lifecycle ───────────────────────────────
  init(): void {
    const { ctx } = this;
    ctx.engine.keepRunning();
    // panel
    const root = document.getElementById('ui-root') ?? document.body;
    this.panel = document.createElement('pre');
    this.panel.className = 'agent-text';
    this.panel.id = 'agent-panel-text';
    this.panel.setAttribute('aria-label', 'Agent view');
    const head = document.createElement('button');
    head.className = 'agent-head';
    head.type = 'button';
    head.textContent = '🤖 AGENT VIEW';
    head.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.body.classList.toggle('collapsed', this.collapsed);
    });
    this.body = document.createElement('div');
    this.body.className = 'agent-panel';
    this.body.id = 'agent-panel';
    this.body.append(head, this.panel);
    root.append(this.body);
    // keys: a tap = a timed hold
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    // event log
    const log = (text: string) => this.log(text);
    ctx.events.on('masterCaution', (e) => log(`⚠ ${e.text}`));
    ctx.events.on('planeExplosion', (e) => !e.replay && log(`💥 explosion (${e.kind})`));
    ctx.events.on('planeBreak', (e) => log(`airframe tore (${e.pieces} pieces)`));
    ctx.events.on('planeImpact', (e) => !e.replay && log(`impact: ${e.outcome} on ${e.surface} at ${f0(e.normalSpeed)} m/s`));
    ctx.events.on('touchdown', (e) => log(`touchdown ${e.hard ? 'HARD' : 'soft'} (${t1(e.verticalSpeed)} m/s)`));
    ctx.events.on('explosion', () => log('💥 car exploded'));
    ctx.events.on('stunt', (e) => log(`stunt: ${e.kind}${e.rolls ? ` ×${e.rolls}` : ''} (${t1(e.airTime)} s air)`));
    ctx.events.on('planeSpawned', (e) => {
      log(`spawned ${PLANE_NAMES[e.type]}${e.inAir ? ' in the air' : ''}`);
      this.resetFlightAids();
    });
    ctx.events.on('modeChanged', (e) => {
      log(`mode → ${e.mode}`);
      this.holds.clear();
      if (e.mode === 'car') this.resetFlightAids();
    });
    ctx.events.on('toast', (e) => log(e.text));
    // weather changes from the agent are temporary: restore the player's own setting when the page goes away
    window.addEventListener('pagehide', () => {
      if (this.weatherBefore) ctx.settings.set({ weather: this.weatherBefore as never });
    });
    // JS entry point for agents
    const api = {
      do: (cmds: string) => this.run(cmds),
      run: (cmds: string) => this.run(cmds),
      state: () => this.text(),
      text: () => this.text(),
      json: () => this.json(),
      help: () => HELP,
      freeze: (on = true) => this.run(on ? 'freeze' : 'go'),
      step: (s = 1) => this.run(`run ${s}`),
      cancel: () => this.run('cancel'),
      places: () => this.run('places'),
      /** Endpoint contract version (public/endpoint.md, "Endpoint version: N"). */
      version: typeof __ENDPOINT_VERSION__ === 'number' ? __ENDPOINT_VERSION__ : 0,
      /** True once the game has booted (title, menu or playing): commands work from then on. */
      ready: () => ctx.game.state !== 'boot',
      /**
       * Frame-exact filming (public/endpoint/film.mjs drives it): while filming the game advances ONLY on frame() /
       * advance(), each call = exactly dt of game time, so the footage is smooth whatever the machine.
       */
      film: {
        start: () => {
          ctx.engine.setFilming(true);
          return 'filming: the game now advances only on gca.film.frame() / gca.film.advance()';
        },
        /** Advance dt s of game time, render, return the frame as a JPEG data URL (pure 3D view, no buttons). */
        frame: (dt = 1 / 30, quality = 0.94) => this.filmFrame(dt, quality),
        /** Advance n frames of dt s without capturing (pre-roll, dry runs). */
        advance: (n = 1, dt = 1 / 30) => {
          if (!ctx.engine.filming) ctx.engine.setFilming(true);
          for (let i = 0; i < n; i++) ctx.engine.filmStep(dt);
          return this.simT;
        },
        stop: () => {
          ctx.engine.setFilming(false);
          return 'live';
        },
      },
      raw: { game: ctx.game, ctx, CONFIG },
    };
    (window as unknown as { gca: typeof api }).gca = api;
    this.render(true);
  }

  private resetFlightAids(): void {
    this.ap = { alt: null, heading: null, bank: null, speed: null, target: null };
    this.throttleCmd = null;
    this.fc = null;
  }

  private log(text: string): void {
    if (!text) return;
    const last = this.events[this.events.length - 1];
    if (last && last.text === text && this.simT - last.t < 1) return;
    this.events.push({ t: this.simT, text });
    if (this.events.length > 8) this.events.shift();
  }

  fixedUpdate(dt: number): void {
    this.simT += dt;
    // queued commands (exact game time)
    while (this.queue.length && this.queue[0].at <= this.simT + 1e-6) {
      const q = this.queue.shift()!;
      const r = this.exec(q.cmd);
      this.log(`▶ ${q.cmd}${r.startsWith('error') ? ` (${r})` : ''}`);
      this.fcDirty = true;
    }
    // holds count down
    for (const [axis, h] of this.holds) {
      h.left -= dt;
      if (h.left <= 0) this.holds.delete(axis);
    }
    this.applyControls(dt);
    if (this.simT >= this.runUntil - 1e-6) {
      this.runUntil = Infinity;
      this.frozen = true;
      this.fcDirty = true;
    }
  }

  update(realDt: number): void {
    this.textT -= realDt;
    this.fcT -= realDt;
    if (this.fcT <= 0 || this.fcDirty) {
      this.fcT = 0.25;
      this.fcDirty = false;
      this.computeForecast();
    }
    if (this.textT <= 0) {
      this.textT = 0.25;
      this.render();
    }
  }

  // ─────────────────────────────── controls ───────────────────────────────
  private get flying(): boolean {
    const { ctx } = this;
    return ctx.game.mode === 'plane' && !!ctx.planes.currentTracked?.body && !ctx.planes.crashed;
  }

  /** Latched holds + autopilot → the input override (read by the vehicle / plane / walker this step). */
  private applyControls(dt: number): void {
    const { ctx } = this;
    const o = this.override;
    for (const k of Object.keys(o)) delete (o as Record<string, unknown>)[k];
    const hv = (a: Axis) => this.holds.get(a)?.value;
    const plane = ctx.game.mode === 'plane';
    const walking = plane && ctx.walker.active;
    let gamma: number | null = null;
    this.snap = plane ? ctx.planes.flightSnapshot?.() ?? null : null;
    if (plane) {
      const snap = this.snap;
      if (snap) {
        const ctl = this.autopilot(this.liveView(snap), this.ap, (x, z) => this.groundY(x, z));
        if (ctl.roll !== null) o.roll = ctl.roll;
        gamma = ctl.gamma;
        if (ctl.throttle !== null) this.throttleCmd = ctl.throttle;
      }
      const p = hv('pitch');
      const r = hv('roll');
      const y = hv('yaw');
      if (p !== undefined) {
        o.pitch = p;
        gamma = null;
      }
      if (r !== undefined) o.roll = r;
      if (y !== undefined) o.yaw = y;
      if (this.throttleCmd !== null) o.throttleSet = this.throttleCmd;
      if (walking) {
        const mx = hv('moveX'), my = hv('moveY');
        if (mx !== undefined) o.moveX = mx;
        if (my !== undefined) o.moveY = my;
        if (this.holds.has('grab')) o.grab = true;
        if (this.holds.has('run')) o.run = true;
        if (this.holds.has('jump')) o.jump = true;
      }
    } else {
      const th = hv('throttle'), br = hv('brake'), st = hv('steer');
      if (th !== undefined) o.throttle = th;
      if (br !== undefined) o.brake = br;
      if (st !== undefined) o.steer = st;
      if (this.holds.has('handbrake')) o.handbrake = true;
      if (this.holds.has('turbo')) o.turbo = true;
    }
    if (ctx.planes.crashed) this.ap.target = null; // homing ends at the crash
    if (ctx.planes.autopilotGamma !== undefined || gamma !== null) ctx.planes.autopilotGamma = gamma;
    const any = Object.keys(o).length > 0;
    ctx.input.agentOverride = any ? o : null;
    if (any && ctx.input.enabled) Object.assign(ctx.input.state, o);
    void dt;
  }

  private liveView(snap: FlightSnapshot): GhostView {
    const b = snap.body;
    const t = b.translation();
    const v = b.linvel();
    const ps = this.ctx.planes.state;
    return {
      t: 0, x: t.x, y: t.y, z: t.z, vx: v.x, vy: v.y, vz: v.z, V: Math.hypot(v.x, v.y, v.z), agl: ps.altitudeAgl,
      pitch: ps.pitch, bank: ps.bank, heading: ps.heading, rest: snap.rest, throttle: snap.throttle,
    };
  }

  /**
   * Autopilot (shared by the live plane and the ghost forecast). alt: terrain following — the vertical speed needed
   * to clear every point of the ground ahead (look-ahead scaled to how slowly this plane answers) by `alt` metres;
   * heading → bank toward it; bank hold; speed → throttle.
   */
  private autopilot(v: GhostView, ap: Autopilot, ground: (x: number, z: number) => number): { roll: number | null; gamma: number | null; throttle: number | null } {
    let roll: number | null = null;
    let gamma: number | null = null;
    let throttle: number | null = null;
    const V = Math.max(1, v.V);
    if (ap.alt !== null) {
      const cfg = this.ctx.planes.currentType ? CONFIG.planes[this.ctx.planes.currentType] : null;
      const gk = cfg ? (cfg as { gammaK: number }).gammaK : 0.8;
      const T = clamp(1.9 / gk, 2, 5);
      let need = -Infinity;
      for (let tau = 0.5; tau <= T + 1e-6; tau += 0.5) {
        const gy = ground(v.x + v.vx * tau, v.z + v.vz * tau);
        need = Math.max(need, (gy + v.rest + ap.alt - v.y) / tau);
      }
      const vs = clamp(need, -0.11 * V, 0.3 * V);
      gamma = Math.asin(clamp(vs / V, -0.42, 0.42));
    }
    if (ap.heading !== null) {
      const err = wrap180(ap.heading - v.heading);
      const max = ap.alt !== null && ap.alt < 80 ? 25 : 35;
      roll = clamp(err * 1.1, -max, max) / CONFIG.planes.assist.bankLimitDeg;
    }
    if (ap.bank !== null) roll = clamp(ap.bank, -60, 60) / CONFIG.planes.assist.bankLimitDeg;
    if (ap.target) {
      // homing: point the flight path straight at the target (bearing + glide angle), so it crashes right there
      const o = this.ctx.origin.offset;
      const dx = ap.target.x - o.x - v.x, dz = ap.target.z - o.z - v.z;
      const dist = Math.max(1, Math.hypot(dx, dz));
      const brg = Math.atan2(dx, -dz) / DEG;
      const err = wrap180(brg - v.heading);
      roll = clamp(err * 1.4, -40, 40) / CONFIG.planes.assist.bankLimitDeg;
      gamma = clamp(Math.atan2(ap.target.y - v.y, dist), -0.62, 0.2);
    }
    if (ap.speed !== null) {
      const base = this.throttleCmd ?? v.throttle;
      throttle = clamp(base + (ap.speed - V) * 0.01, 0, 1);
    }
    return { roll, gamma, throttle };
  }

  private hold(axis: Axis, value: number, secs: number, add = false): void {
    const h = this.holds.get(axis);
    if (add && h && Math.sign(h.value) === Math.sign(value)) h.left = Math.min(MAX_HOLD, h.left + secs);
    else this.holds.set(axis, { value, left: Math.min(MAX_HOLD, secs) });
    this.fcDirty = true;
  }

  private onKey(e: KeyboardEvent): void {
    const { ctx } = this;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.repeat || e.ctrlKey && e.code !== 'ControlLeft' && e.code !== 'ControlRight' || e.metaKey || e.altKey) return;
    // freeze / step work in any playing state
    if (e.code === 'KeyK') {
      this.run(this.frozen ? 'go' : 'freeze');
      return;
    }
    if (e.code === 'Period') {
      this.run('run 1');
      return;
    }
    if (ctx.game.state !== 'driving' || ctx.replay.active) return;
    if (e.code === 'Backspace') {
      this.run('release');
      e.preventDefault();
      return;
    }
    const plane = ctx.game.mode === 'plane';
    const walking = plane && ctx.walker.active;
    const k = e.code;
    const up = k === 'KeyW' || k === 'ArrowUp', down = k === 'KeyS' || k === 'ArrowDown';
    const left = k === 'KeyA' || k === 'ArrowLeft', right = k === 'KeyD' || k === 'ArrowRight';
    if (walking) {
      if (up || down) this.hold('moveY', up ? 1 : -1, PULSE, true);
      else if (left || right) this.hold('moveX', right ? 1 : -1, PULSE, true);
      else if (k === 'KeyE') {
        if (this.holds.has('grab')) this.holds.delete('grab');
        else this.hold('grab', 1, MAX_HOLD);
      } else if (k === 'ShiftLeft' || k === 'ShiftRight') this.hold('run', 1, 3);
      else if (k === 'Space') this.hold('jump', 1, 0.15);
      return;
    }
    if (plane) {
      if (up || down) this.hold('pitch', down ? 1 : -1, PULSE, true);
      else if (left || right) this.hold('roll', right ? 1 : -1, PULSE, true);
      else if (k === 'KeyQ' || k === 'KeyE') this.hold('yaw', k === 'KeyE' ? 1 : -1, PULSE, true);
      else if (k === 'ShiftLeft' || k === 'ShiftRight' || k === 'Equal' || k === 'PageUp') this.run('throttle +10');
      else if (k === 'ControlLeft' || k === 'ControlRight' || k === 'Minus' || k === 'PageDown') this.run('throttle -10');
      return;
    }
    if (up) this.hold('throttle', 1, PULSE, true);
    else if (down) this.hold('brake', 1, PULSE, true);
    else if (left || right) this.hold('steer', right ? 1 : -1, 0.5, true);
    else if (k === 'Space') this.hold('handbrake', 1, 0.6, true);
    else if (k === 'ShiftLeft' || k === 'ShiftRight') this.hold('turbo', 1, PULSE, true);
  }

  // ─────────────────────────────── commands ───────────────────────────────
  run(cmds: string): string {
    const parts = String(cmds ?? '').split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
    const out: string[] = [];
    let offset = 0;
    for (const p of parts) {
      const m = /^(wait|sleep|after)\s+([\d.]+)\s*s?$/i.exec(p);
      if (m) {
        offset += Math.max(0, Number(m[2]) || 0);
        continue;
      }
      if (offset > 0) {
        this.queue.push({ at: this.simT + offset, cmd: p });
        this.queue.sort((a, b) => a.at - b.at);
        out.push(`queued at +${t1(offset)} s: ${p}`);
      } else {
        out.push(`${p} → ${this.exec(p)}`);
      }
    }
    this.fcDirty = false;
    this.computeForecast();
    this.render(true);
    const fc = this.fcLines.length ? `\nFORECAST\n${this.fcLines.join('\n')}` : '';
    return out.join('\n') + fc;
  }

  private exec(raw: string): string {
    const { ctx } = this;
    const w = raw.toLowerCase().replace(/[,]/g, ' ').split(/\s+/).filter(Boolean);
    const c = w[0] ?? '';
    const num = (i: number, d = NaN) => {
      const n = parseFloat(w[i] ?? '');
      return Number.isFinite(n) ? n : d;
    };
    const opt = (key: string) => {
      const i = w.indexOf(key);
      return i >= 0 ? w[i + 1] : undefined;
    };
    const planes = ctx.planes;
    const flying = this.flying;
    try {
      switch (c) {
        case 'help':
          return HELP;
        // ── world ──
        case 'night':
        case 'day':
        case 'sunset':
        case 'dawn':
        case 'time': {
          const h = c === 'night' ? 23 : c === 'day' ? 12 : c === 'sunset' ? 19.3 : c === 'dawn' ? 6.2 : parseTime(w[1]);
          if (!Number.isFinite(h) || !ctx.env.setTime) return 'error: time HH or HH:MM';
          ctx.env.setTime(h);
          return `time ${fmtTime(h)}`;
        }
        case 'weather': {
          const k = WEATHER[w[1] ?? ''];
          if (!k) return `error: weather ${Object.keys(WEATHER).join('|')}`;
          if (this.weatherBefore === null) this.weatherBefore = ctx.settings.values.weather;
          ctx.settings.set({ weather: k as never });
          return `weather ${k}`;
        }
        // ── flying ──
        case 'fly':
        case 'plane':
          return this.cmdFly(w);
        case 'switch': {
          const t = TYPE_ALIAS[w[1] ?? ''];
          if (!t || !planes.switchType) return 'error: switch prop|jet|airliner|jumbo';
          planes.switchType(t);
          return `switched to ${PLANE_NAMES[t]}`;
        }
        case 'car':
        case 'drive':
          if (ctx.game.state !== 'driving') ctx.game.play();
          if (ctx.game.mode === 'plane') planes.backToCar();
          return 'back in the car';
        case 'target':
        case 'crash':
          return this.cmdTarget(w.slice(1));
        case 'traffic':
        case 'sky': {
          const M = ctx.missiles;
          if (!M) return 'error: no sky traffic';
          const o = ctx.origin.offset;
          const me = this.flying ? ctx.planes.state.position : ctx.engine.camera.position;
          return M.sky.map((p) => `#${p.id} ${p.name} · ${p.hit ? 'SHOT DOWN' : `${f0(p.alt)} m · hdg ${f0(p.heading)}° · ${f0(p.speed * 3.6)} km/h`} · ${(Math.hypot(p.ax - o.x - me.x, p.az - o.z - me.z) / 1000).toFixed(1)} km`).join('\n') || 'no planes yet';
        }
        case 'sites':
        case 'launchers':
          return (ctx.missiles?.sites ?? []).map((s) => `${s.id} · ${s.name} · ${s.kind} · ${s.ready}/${s.tubes} ready · ${s.blurb}`).join('\n') || 'error: no sites';
        case 'shoot':
        case 'fire': {
          const M = ctx.missiles;
          if (!M) return 'error: no missiles';
          // shoot <plane# | nearest> [from <site id | kind>] [n | all] [spread] [aim nose|tail|left|right|middle]
          const id = w[1] === 'nearest' ? this.nearestSky(w.indexOf('from') >= 0 ? w[w.indexOf('from') + 1] : '') : parseInt((w[1] ?? '').replace('#', ''), 10);
          if (!M.controlling || Number.isFinite(id)) {
            if (!Number.isFinite(id)) return 'error: shoot <plane #> [from <site>] [2 | all] [spread] [aim nose|tail|left|right|middle]  ("traffic" lists the planes)';
            const fi = w.indexOf('from');
            const want = this.turretAlias(fi >= 0 ? w[fi + 1] ?? '' : '');
            const p = M.sky.find((q) => q.id === id);
            if (!p) return `error: no plane #${id}`;
            const sites = [...M.sites].filter((s) => s.ready > 0 && (!want || s.id === want || s.id.includes(want) || s.kind.toLowerCase().includes(want) || s.name.toLowerCase().includes(want)));
            sites.sort((a, b) => Math.hypot(a.ax - p.ax, a.az - p.az) - Math.hypot(b.ax - p.ax, b.az - p.az));
            if (!sites.length) return 'error: no ready site matches';
            const err = M.enterControl(sites[0].id, id);
            if (err) return `error: ${err}`;
            M.autoAim?.();
          }
          const ai = w.indexOf('aim');
          const where = ai >= 0 ? w[ai + 1] : '';
          const AIM: Record<string, [number, number]> = { nose: [0, 0.95], front: [0, 0.6], tail: [0, -0.95], rear: [0, -0.6], left: [-0.9, 0.05], right: [0.9, 0.05], middle: [0, 0], center: [0, 0], engine: [-0.35, 0.15] };
          if (AIM[where]) M.steer(AIM[where][0], AIM[where][1]);
          const all = w.includes('all');
          const nIdx = w.findIndex((x, i) => i > 1 && /^\d+$/.test(x) && w[i - 1] !== 'from');
          const n = nIdx >= 0 ? parseInt(w[nIdx], 10) : 0;
          M.autoAim?.();
          return M.fire(n, { all, spread: w.includes('spread') }) + (M.controlling ? ' — in the control room ("back" leaves, "steer u v" picks where)' : '');
        }
        case 'steer': {
          const M = ctx.missiles;
          if (!M?.controlling) return 'error: not in a control room';
          M.steer(num(1, 0), num(2, 0));
          return `aim point u ${num(1, 0)} (+ right wing) v ${num(2, 0)} (+ nose)`;
        }
        case 'back':
          if (ctx.missiles?.viewing) return ctx.missiles.spectate?.(null) ?? '';
          ctx.missiles?.exitControl();
          return 'back to your vehicle (missiles keep homing)';
        case 'watch': {
          // spectator cameras: ride your newest missile / nuke, or follow the sky plane you just hit
          const M = ctx.missiles;
          if (!M?.spectate) return 'error: no missiles system';
          const k = w[1] ?? 'nuke';
          if (k === 'off' || k === 'back' || k === 'stop') {
            const a = M.spectate(null), b = M.watchFocus ? M.watchPlane?.(null) ?? '' : '';
            return [a, b].filter(Boolean).join(' · ') || 'not watching';
          }
          if (k === 'nearest' || /^#?\d+$/.test(k)) {
            // WATCH IT: your plane keeps its distance from that sky plane, your camera on it
            const id = k === 'nearest' ? this.nearestSky('me') : parseInt(k.replace('#', ''), 10);
            this.ap = { alt: null, heading: null, bank: null, speed: null, target: null };
            this.throttleCmd = null;
            this.holds.clear();
            return M.watchPlane?.(id) ?? 'error: no watch';
          }
          if (k === 'nuke' || k === 'missile') return M.spectate('missile');
          if (k === 'hit' || k === 'plane') return M.spectate('hit');
          return 'error: watch nuke | missile | hit | <plane #> | nearest | off';
        }
        case 'ram': {
          const M = ctx.missiles;
          if (!M) return 'error: no sky traffic';
          if (w[1] === 'off') return M.ram(null);
          const id = w[1] === 'nearest' ? this.nearestSky('me') : parseInt((w[1] ?? '').replace('#', ''), 10);
          if (!Number.isFinite(id)) return 'error: ram <plane #> | ram off';
          // the ram autopilot flies: hand over (no holds / heading / speed of ours fighting it)
          this.ap = { alt: null, heading: null, bank: null, speed: null, target: null };
          this.throttleCmd = null;
          this.holds.clear();
          return M.ram(id);
        }
        case 'nuke': {
          const M = ctx.missiles;
          if (!M) return 'error: no silo';
          const id = w[1] === 'nearest' ? this.nearestSky('nuke') : parseInt((w[1] ?? '').replace('#', ''), 10);
          if (Number.isFinite(id) && !Number.isFinite(parseFloat(w[2] ?? ''))) return M.nuke(id);
          const t = this.findTarget(w.slice(1));
          if (!t) return 'error: nuke <plane #> | nuke <place> | nuke <x z>';
          return M.nuke(null, { x: t.x, z: t.z }) + ` at ${t.name}`;
        }
        case 'places': {
          const ps = ctx.nav.pois as { id: string; name: string; discovered?: boolean }[];
          const open = ps.filter((p) => p.discovered !== false), locked = ps.filter((p) => p.discovered === false);
          return `places you can teleport to (in the car): ${open.map((p) => `${p.id} = ${p.name}`).join(' · ') || 'none'}${locked.length ? `\nlocked until you drive within reach: ${locked.map((p) => p.name).join(' · ')}` : ''}`;
        }
        case 'teleport':
        case 'goto': {
          const q = w.slice(1).join(' ');
          if (!q) return 'error: teleport <place> — "places" lists them';
          const poi = ctx.nav.pois.find((p) => p.id === q) ?? ctx.nav.pois.find((p) => p.name.toLowerCase().includes(q));
          if (!poi) return `error: unknown place. Known: ${ctx.nav.pois.map((p) => p.id).join(', ')}`;
          if (ctx.game.state !== 'driving') ctx.game.play();
          if (ctx.game.mode === 'plane') return 'error: teleport works from the car — "car" first';
          const chk = (ctx.nav as { canTeleport?: (p: unknown) => { ok: boolean; reason: string } }).canTeleport?.(poi);
          if (chk && !chk.ok) return `error: ${chk.reason}`;
          ctx.nav.teleport(poi.id);
          return `teleporting to ${poi.name} (wait ~2 s)`;
        }
        case 'pitch':
        case 'nose':
        case 'climb':
        case 'dive': {
          const dir = c === 'climb' ? 'up' : c === 'dive' ? 'down' : w[1];
          if (dir !== 'up' && dir !== 'down') return 'error: pitch up|down [seconds] [strength 0..1]';
          const base = c === 'climb' || c === 'dive' ? 1 : 2;
          const secs = num(base, 1);
          const k = clamp(num(base + 1, 1), 0.05, 1);
          this.hold('pitch', dir === 'up' ? k : -k, secs);
          return `nose ${dir} ${t1(secs)} s${k < 1 ? ` at ${Math.round(k * 100)} %` : ''}`;
        }
        case 'bank':
        case 'roll':
        case 'turn': {
          const dir = w[1];
          if (dir === 'off') {
            this.ap.bank = null;
            return 'bank hold off';
          }
          if (dir === 'left' || dir === 'right') {
            const secs = num(2, 1);
            const k = clamp(num(3, 1), 0.05, 1);
            this.hold('roll', dir === 'right' ? k : -k, secs);
            return `bank ${dir} ${t1(secs)} s`;
          }
          const deg = num(1);
          if (!Number.isFinite(deg)) return 'error: bank left|right [seconds]  or  bank <degrees> (+right / −left)  or  bank off';
          this.ap.bank = clamp(deg, -60, 60);
          this.ap.heading = null;
          return `holding bank ${s0(this.ap.bank)}°`;
        }
        case 'yaw':
        case 'rudder': {
          const dir = w[1];
          if (dir !== 'left' && dir !== 'right') return 'error: yaw left|right [seconds]';
          this.hold('yaw', dir === 'right' ? 1 : -1, num(2, 1));
          return `rudder ${dir}`;
        }
        case 'hold': {
          const ok: Axis[] = ['pitch', 'roll', 'yaw', 'throttle', 'brake', 'steer', 'handbrake', 'turbo', 'moveX', 'moveY'];
          const axis = ok.find((a) => a.toLowerCase() === w[1]); // commands are lowercased (moveX → movex)
          if (!axis) return `error: hold <${ok.join('|')}> <value -1..1> <seconds>`;
          this.hold(axis, clamp(num(2, 1), -1, 1), num(3, 1));
          return `holding ${axis} ${num(2, 1)} for ${t1(num(3, 1))} s`;
        }
        case 'stick': {
          const p = clamp(num(1, 0), -1, 1), r = clamp(num(2, 0), -1, 1), s = num(3, 1);
          if (p) this.hold('pitch', p, s);
          if (r) this.hold('roll', r, s);
          return `stick pitch ${p} roll ${r} for ${t1(s)} s`;
        }
        case 'throttle':
        case 'power': {
          if (!flying && ctx.game.mode !== 'plane') return 'error: not in a plane (cars: gas/brake)';
          const arg = w[1] ?? '';
          const cur = this.throttleCmd ?? planes.state.throttle;
          let v = /^[+-]/.test(arg) ? cur + parseFloat(arg) / 100 : parseFloat(arg);
          if (arg === 'max' || arg === 'full') v = 1;
          if (arg === 'idle') v = 0;
          if (!Number.isFinite(v)) return 'error: throttle 0..100 | +10 | -10 | max | idle';
          if (!/^[+-]/.test(arg) && v > 1.0001) v /= 100;
          this.throttleCmd = clamp(v, 0, 1);
          this.ap.speed = null;
          return `throttle ${Math.round(this.throttleCmd * 100)} %`;
        }
        case 'alt':
        case 'agl':
        case 'altitude': {
          if (w[1] === 'off') {
            this.ap.alt = null;
            return 'altitude hold off';
          }
          const a = num(1);
          if (!Number.isFinite(a)) return 'error: alt <metres above ground> | alt off';
          this.ap.alt = clamp(a, 3, 3000);
          return `terrain-following ${f0(this.ap.alt)} m above the ground`;
        }
        case 'heading':
        case 'hdg': {
          if (w[1] === 'off') {
            this.ap.heading = null;
            return 'heading hold off';
          }
          const h = HEADINGS[w[1] ?? ''] ?? num(1);
          if (!Number.isFinite(h)) return 'error: heading <0..359|n|e|s|w> | heading off';
          this.ap.heading = ((h % 360) + 360) % 360;
          this.ap.bank = null;
          return `heading ${hdg(this.ap.heading)}`;
        }
        case 'speed': {
          if (w[1] === 'off') {
            this.ap.speed = null;
            return 'speed hold off';
          }
          const s = parseSpeed(w[1], w[2]);
          if (!Number.isFinite(s)) return 'error: speed <m/s> | speed <km/h> kmh | speed off';
          this.ap.speed = s;
          return `speed ${f0(s)} m/s (${f0(s * 3.6)} km/h)`;
        }
        case 'level':
          this.ap.bank = 0;
          this.ap.heading = null;
          this.holds.delete('pitch');
          this.holds.delete('roll');
          return 'wings level';
        case 'ap':
        case 'autopilot':
          if (w[1] === 'off') {
            this.ap = { alt: null, heading: null, bank: null, speed: null, target: null };
            return 'autopilot off';
          }
          return 'error: ap off  (use alt / heading / bank / speed to engage)';
        case 'split':
        case 'middle':
        case 'half':
          if (!flying) return 'error: no intact plane';
          planes.explodeMiddle();
          return 'split in half';
        case 'tail':
          if (!flying) return 'error: no intact plane';
          planes.explodeTail();
          return 'tail blown off';
        case 'engine': {
          const i = num(1);
          if (!flying || !Number.isFinite(i)) return 'error: engine <1..4> while flying';
          planes.explodeEngine(Math.round(i));
          return `engine ${Math.round(i)} exploded`;
        }
        case 'explode':
        case 'boom':
          ctx.game.explodeOrReset();
          return 'boom';
        case 'wing': {
          const side = w[1] === 'left' || w[1] === 'l' ? 'L' : w[1] === 'right' || w[1] === 'r' ? 'R' : null;
          const mode = w[2] === 'far' || w[2] === 'tip' ? 'far' : w[2] === 'half' ? 'half' : null;
          if (!side || !mode || !planes.breakWing) return 'error: wing left|right far|half';
          planes.breakWing(side, mode);
          return `${side === 'L' ? 'left' : 'right'} wing ${mode === 'far' ? 'tip' : 'half'} broken`;
        }
        case 'gear': {
          if (!flying) return 'error: no plane flying';
          const down = w[1] === 'down' ? true : w[1] === 'up' ? false : planes.state.gear < 0.5;
          planes.gearLock = down ? 1 : 0;
          return `gear ${down ? 'down' : 'up'}`;
        }
        case 'walk':
          return ctx.walker.start() ? 'walking in the cabin' : 'error: cannot walk here (big planes only, in flight or wreck)';
        case 'pilot':
        case 'interact':
          ctx.walker.active ? ctx.walker.interact() : ctx.input.press('interact');
          return 'interact';
        case 'window':
          ctx.walker.lookOutWindow();
          return 'window';
        case 'view':
          ctx.walker.toggleView();
          return 'view toggled';
        case 'flyagain':
          ctx.walker.flyAgain();
          return 'fly again';
        case 'respawn':
        case 'reset':
          ctx.game.requestReset();
          return 'reset';
        case 'retry':
          planes.retryInAir();
          return 'retry in the air';
        // ── car ──
        case 'gas':
        case 'accelerate':
          this.hold('throttle', clamp(num(2, 1), 0, 1), num(1, 1));
          return `gas ${t1(num(1, 1))} s`;
        case 'brake':
        case 'reverse':
          this.hold('brake', 1, num(1, 1));
          return `brake ${t1(num(1, 1))} s`;
        case 'steer': {
          const dir = w[1];
          if (dir !== 'left' && dir !== 'right') return 'error: steer left|right [seconds] [amount 0..1]';
          this.hold('steer', (dir === 'right' ? 1 : -1) * clamp(num(3, 1), 0.05, 1), num(2, 0.5));
          return `steer ${dir}`;
        }
        case 'handbrake':
          this.hold('handbrake', 1, num(1, 0.6));
          return 'handbrake';
        case 'turbo':
          this.hold('turbo', 1, num(1, 1));
          return 'turbo';
        case 'barrel': {
          ctx.input.press(w[1] === 'right' ? 'barrelRight' : 'barrelLeft');
          return 'barrel roll';
        }
        // ── camera / replay / time / ui ──
        case 'cam':
        case 'camera':
          return this.cmdCam(w[1]);
        case 'replay':
          if (w[1] === 'next') ctx.replay.nextCam();
          else if (w[1] === 'restart') ctx.replay.restart();
          else if (w[1] === 'stop' || w[1] === 'exit') ctx.replay.stop();
          else {
            if (!ctx.replay.canReplay) return 'error: nothing to replay yet (crash first)';
            ctx.replay.start();
          }
          return `replay ${w[1] ?? 'start'}`;
        case 'slowmo': {
          const s = clamp(num(1, 0.3), 0.05, 1), d = clamp(num(2, 2), 0.1, 30);
          ctx.game.slowMo(s, d);
          return `slow motion ×${s} easing back over ${t1(d)} s`;
        }
        case 'timescale': {
          const s = clamp(num(1, 1), 0.05, 2);
          ctx.engine.timeScale = s;
          return `time scale ×${s}`;
        }
        case 'freeze':
        case 'pause':
          this.frozen = true;
          this.runUntil = Infinity;
          return 'frozen (K or "go" to resume, "run N" to advance N s)';
        case 'go':
        case 'unfreeze':
        case 'resume':
          this.frozen = false;
          this.runUntil = Infinity;
          return 'running';
        case 'run':
        case 'step': {
          const s = clamp(num(1, 1), 0.02, 60);
          this.frozen = false;
          this.runUntil = this.simT + s;
          return `running ${t1(s)} s, then freezing`;
        }
        case 'release':
        case 'center':
        case 'centre':
          this.holds.clear();
          return 'all controls released';
        case 'cancel':
        case 'clear':
          this.queue.length = 0;
          return 'queue cleared';
        case 'rec':
        case 'record': {
          const ui = ctx.ui;
          if (!ui.setRecMode) return 'error: no recording mode';
          ui.setRecMode(w[1] === 'off' ? false : w[1] === 'on' ? true : !ui.recMode);
          return `recording mode ${ui.recMode ? 'on' : 'off'}`;
        }
        case 'panel':
          this.collapsed = w[1] === 'off' || (w[1] !== 'on' && !this.collapsed);
          this.body.classList.toggle('collapsed', this.collapsed);
          return `panel ${this.collapsed ? 'collapsed' : 'open'}`;
        case 'menu':
          ctx.game.toMainMenu();
          return 'main menu';
        case 'play':
          ctx.game.play();
          return 'playing';
        default:
          return `error: unknown command "${c}" — gca.help()`;
      }
    } catch (err) {
      return `error: ${(err as Error)?.message ?? err}`;
    }
  }

  /** Film mode: advance exactly dt s of game time, render, read the finished frame from the GL buffer → JPEG data URL. */
  private filmFrame(dt: number, quality: number): string {
    const e = this.ctx.engine;
    if (!e.filming) e.setFilming(true);
    e.filmStep(dt);
    // read in the same task as the render (readPixels waits for the finished image; screenshots raced the GPU)
    e.renderer.setRenderTarget(null);
    const gl = e.renderer.getContext();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, row = w * 4;
    let f = this.filmBuf;
    if (!f || f.w !== w || f.h !== h) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const x = c.getContext('2d')!;
      f = this.filmBuf = { w, h, c, x, px: new Uint8Array(w * h * 4), img: x.createImageData(w, h) };
    }
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, f.px);
    for (let y = 0; y < h; y++) f.img.data.set(f.px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    f.x.putImageData(f.img, 0, 0);
    return f.c.toDataURL('image/jpeg', quality);
  }

/** A target by name (concert, stage, crowd, city, downtown, beach, airport, park, any place id / name) or "x z" (absolute). */
  private findTarget(words: string[]): { x: number; z: number; name: string } | null {
    const { ctx } = this;
    const o = ctx.origin.offset;
    const a = parseFloat(words[0] ?? ''), b = parseFloat(words[1] ?? '');
    if (Number.isFinite(a) && Number.isFinite(b)) return { x: a, z: b, name: `${Math.round(a)} ${Math.round(b)}` };
    const q = words.join(' ').trim();
    if (!q) return null;
    const c = ctx.world.data?.concert;
    // the concert = between the stage and the crowd (it takes both); stage / crowd = just that
    const crowdX = c ? (c.floor.minX + c.floor.maxX) / 2 : 0;
    if (c && q === 'concert') return { x: (c.stage.x + c.floor.minX + 10) / 2 + o.x, z: c.stage.z + o.z, name: 'the concert' };
    if (c && q === 'stage') return { x: c.stage.x + o.x, z: c.stage.z + o.z, name: 'the concert stage' };
    if (c && (q === 'crowd' || q === 'fans' || q === 'audience')) return { x: crowdX + o.x, z: (c.floor.minZ + c.floor.maxZ) / 2 + o.z, name: 'the concert crowd' };
    if (q === 'city' || q === 'town') return this.findTarget(['downtown']);
    const poi = ctx.nav.pois.find((p) => p.id === q) ?? ctx.nav.pois.find((p) => p.name.toLowerCase().includes(q));
    if (poi) return { x: poi.pose.position.x + o.x, z: poi.pose.position.z + o.z, name: poi.name };
    return null;
  }

  /**
   * Homing crash set-up (user request: "crash it on the city / on the concert"): from the current position (or a fresh
   * spawn, see fly … target) the autopilot steers and dives so the plane hits the target. target off = stop homing.
   */
  private cmdTarget(w: string[]): string {
    if (w[0] === 'off' || w[0] === 'stop') {
      this.ap.target = null;
      return 'target off';
    }
    if (w[0] === 'into' || w[0] === 'on') w = w.slice(1);
    const stop = w.findIndex((x) => x === 'in' || x === 'from' || x === 'speed' || x === 'agl');
    const t = this.findTarget(stop >= 0 ? w.slice(0, stop) : w);
    if (!t) return 'error: target <concert | stage | crowd | city | beach | airport | park | place id | x z>  ("places" lists them)';
    if (!this.flying) return 'error: no plane flying — use "fly <type> target <place> [in s] [from n|e|s|w]"';
    const o = this.ctx.origin.offset;
    this.ap.target = { x: t.x, z: t.z, y: this.ctx.towers?.aimAt(t.x, t.z) ?? this.groundY(t.x - o.x, t.z - o.z), name: t.name };
    this.ap.alt = null;
    this.ap.heading = null;
    this.ap.bank = null;
    this.holds.delete('pitch');
    this.holds.delete('roll');
    const p = this.ctx.planes.state.position;
    const d = Math.hypot(t.x - o.x - p.x, t.z - o.z - p.z);
    return `homing on ${t.name}, ${f0(d)} m away — it will crash there (target off to stop)`;
  }

/** The sky plane nearest to a site (by id / kind / name, '' = any ready site, 'silo', or 'me' = your position). */
  /** Turret names the commands accept (old names too): twin / duo, quad, octo, nuke / silo. */
  private turretAlias(w: string): string {
    const A: Record<string, string> = { titan: 'twin', duo: 'twin', lancer: 'quad', hornet: 'octo', swarm: 'octo', pike: 'quad', silo: 'nuke', doom: 'nuke' };
    return A[w] ?? w;
  }

  private nearestSky(from: string): number {
    const M = this.ctx.missiles;
    if (!M) return NaN;
    from = this.turretAlias(from);
    const o = this.ctx.origin.offset;
    const pts: { x: number; z: number }[] = [];
    if (from === 'me') {
      const p = this.flying ? this.ctx.planes.state.position : this.ctx.engine.camera.position;
      pts.push({ x: p.x + o.x, z: p.z + o.z });
    } else for (const s of M.sites) if (s.ready > 0 && (!from || s.id.includes(from) || s.kind.toLowerCase().includes(from) || s.name.toLowerCase().includes(from))) pts.push({ x: s.ax, z: s.az });
    let best = NaN, bd = Infinity;
    for (const p of M.sky) {
      if (p.hit) continue;
      for (const q of pts) {
        const d = Math.hypot(p.ax - q.x, p.az - q.z);
        if (d < bd) {
          bd = d;
          best = p.id;
        }
      }
    }
    return best;
  }

  private cmdFly(w: string[]): string {
    const { ctx } = this;
    const ti = w.indexOf('target') >= 0 ? w.indexOf('target') : w.indexOf('into');
    if (ti >= 0) return this.cmdFlyTarget(w, ti);
    const type = TYPE_ALIAS[w[1] ?? 'jumbo'] ?? (w[1] && !['agl', 'alt', 'speed', 'heading', 'over', 'at'].includes(w[1]) ? null : 'jumbo');
    if (!type) return 'error: fly prop|jet|airliner|jumbo [agl m] [speed m/s|kmh] [heading deg|n|e|s|w] [over forest|city|sea] [at x z]';
    const get = (k: string) => {
      const i = w.findIndex((x) => x === k || (k === 'agl' && x === 'alt'));
      return i >= 0 ? w.slice(i + 1, i + 3) : null;
    };
    const aglArg = get('agl');
    const agl = aglArg ? parseFloat(aglArg[0]) : NaN;
    const spArg = get('speed');
    const speed = spArg ? parseSpeed(spArg[0], spArg[1]) : NaN;
    const hdArg = get('heading');
    const heading = hdArg ? HEADINGS[hdArg[0]] ?? parseFloat(hdArg[0]) : NaN;
    const over = get('over')?.[0] ?? (Number.isFinite(agl) && agl < 150 ? 'forest' : 'city');
    const at = get('at');
    if (ctx.game.state !== 'driving') ctx.game.play();
    if (ctx.game.state !== 'driving' || !ctx.planes.spawnAir) return 'error: cannot start a flight now';
    const o = ctx.origin.offset;
    const Q = CONFIG.planes.quickFly;
    let x = Q.x - o.x, z = Q.z - o.z, dx = Q.dirX, dz = Q.dirZ;
    let where = 'east of the city, heading west toward it';
    if (at && Number.isFinite(parseFloat(at[0])) && Number.isFinite(parseFloat(at[1]))) {
      x = parseFloat(at[0]) - o.x;
      z = parseFloat(at[1]) - o.z;
      where = `at ${at[0]} ${at[1]}`;
    } else if (over === 'forest' || over === 'trees' || over === 'woods') {
      const f = this.findForest();
      if (f) {
        ({ x, z, dx, dz } = f);
        where = `over a forest (${Math.round(f.frac * 100)} % trees for the next 3 km), heading ${hdg(Math.atan2(dx, -dz) / DEG)}`;
      } else where = 'no forest found nearby — default start';
    } else if (over === 'sea' || over === 'ocean' || over === 'coast') {
      x = 600 - o.x;
      z = 900 - o.z;
      dx = -1;
      dz = 0;
      where = 'off the south coast, heading west along the beach';
    }
    if (Number.isFinite(heading)) {
      dx = Math.sin(heading * DEG);
      dz = -Math.cos(heading * DEG);
    }
    const h = Number.isFinite(agl) ? agl : Q.agl;
    ctx.planes.spawnAir(type, x, z, h, dx, dz, Number.isFinite(speed) ? speed : undefined);
    if (Number.isFinite(agl) && agl < 300) {
      this.ap.alt = agl; // low starts keep their height (terrain following)
      ctx.planes.gearLock = 0; // and keep the gear up
    }
    return `${PLANE_NAMES[type]} in the air, ${f0(h)} m above the ground, ${where}${this.ap.alt !== null ? ` — terrain-following ${f0(this.ap.alt)} m (alt off to stop)` : ''}`;
  }

/** fly <type> target <place> [in s] [from n|e|s|w|deg] [speed v] [agl h]: spawn on a straight dive that hits it. */
  private cmdFlyTarget(w: string[], ti: number): string {
    const { ctx } = this;
    const type = TYPE_ALIAS[w[1] ?? 'jumbo'] ?? 'jumbo';
    const keys = ['in', 'from', 'speed', 'agl', 'alt', 'heading'];
    let end = w.length;
    for (let i = ti + 1; i < w.length; i++) if (keys.includes(w[i])) {
      end = i;
      break;
    }
    const t = this.findTarget(w.slice(ti + 1, end));
    if (!t) return 'error: fly <type> target <concert | stage | crowd | city | beach | airport | park | place id | x z> [in 14] [from s]';
    const get = (k: string) => {
      const i = w.indexOf(k);
      return i >= 0 ? w[i + 1] : undefined;
    };
    if (ctx.game.state !== 'driving') ctx.game.play();
    if (ctx.game.state !== 'driving' || !ctx.planes.spawnAir) return 'error: cannot start a flight now';
    const o = ctx.origin.offset;
    const T = clamp(parseFloat(get('in') ?? '') || 14, 4, 60);
    const cruise: Record<string, number> = { prop: 55, bizjet: 120, airliner: 110, jumbo: 110 };
    const spIn = get('speed');
    const sp = spIn ? parseSpeed(spIn, w[w.indexOf('speed') + 2]) : cruise[type];
    const ty = ctx.towers?.aimAt(t.x, t.z) ?? this.groundY(t.x - o.x, t.z - o.z);
    // approach direction: from the sea for targets on the coast, else from the east (or as asked)
    const from = get('from');
    let hd = HEADINGS[from ?? ''] ?? parseFloat(from ?? '');
    if (!Number.isFinite(hd)) hd = t.z > 150 ? 180 : 90;
    const fx = Math.sin(hd * DEG), fz = -Math.cos(hd * DEG); // unit vector from the target toward the start
    const aglIn = parseFloat(get('agl') ?? get('alt') ?? '');
    const D0 = sp * T;
    const ang = Number.isFinite(aglIn) ? Math.atan2(aglIn, D0) : 10 * DEG;
    const D = D0 * Math.cos(ang), H = D * Math.tan(ang);
    const sx = t.x + fx * D - o.x, sz = t.z + fz * D - o.z;
    const g0 = this.groundY(sx, sz);
    const agl = Math.max(20, ty + H - g0);
    ctx.planes.spawnAir(type, sx, sz, agl, -fx, -fz, sp);
    this.ap = { alt: null, heading: null, bank: null, speed: sp, target: { x: t.x, z: t.z, y: ty, name: t.name } };
    ctx.planes.gearLock = 0;
    return `${PLANE_NAMES[type]} ${f0(D)} m from ${t.name} (coming from the ${COMPASS[Math.round(((hd % 360) + 360) % 360 / 45) % 8]}), ${f0(agl)} m up at ${f0(sp)} m/s, homing — it crashes there in ≈ ${f0(T)} s (target off to stop)`;
  }

  private cmdCam(name?: string): string {
    const rig = this.ctx.cameraRig;
    if (!name || name === 'next') {
      if (this.ctx.replay.active) this.ctx.replay.nextCam();
      else rig.cycleMode();
      return `camera → ${rig.view ?? rig.mode}`;
    }
    for (let i = 0; i < 6; i++) {
      if ((rig.view ?? rig.mode) === name) return `camera ${name}`;
      rig.cycleMode();
    }
    return (rig.view ?? rig.mode) === name ? `camera ${name}` : `error: no "${name}" camera here (now ${rig.view ?? rig.mode})`;
  }

  /** A start over the most forested, flattest 3 km stretch within ~1.5–6 km of the city (land is north and east). */
  private findForest(): { x: number; z: number; dx: number; dz: number; frac: number } | null {
    const { terrain, origin } = this.ctx;
    if (!terrain?.biomeAt) return null;
    const o = origin.offset;
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let best: { x: number; z: number; dx: number; dz: number; frac: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 44; i++) {
      const a = -Math.PI * 0.95 + rnd() * Math.PI * 1.4; // north-west … south-east arc (land side)
      const r = 1600 + rnd() * 4400;
      const ax = Math.cos(a) * r * 1.1 + 300, az = Math.sin(a) * r - 300;
      for (let d = 0; d < 8; d++) {
        const ang = (d / 8) * Math.PI * 2;
        const dx = Math.sin(ang), dz = -Math.cos(ang);
        let n = 0, trees = 0, sum = 0, sum2 = 0, sea = false;
        for (let s = 0; s <= 3000; s += 200) {
          const lx = ax + dx * s - o.x, lz = az + dz * s - o.z;
          const b = terrain.biomeAt(lx, lz);
          if (b === 'ocean' || terrain.waterAt(lx, lz) !== null) sea = true;
          if (b === 'forest' || b === 'pine') trees++;
          const hh = terrain.heightAt(lx, lz);
          sum += hh;
          sum2 += hh * hh;
          n++;
        }
        if (sea) continue;
        const frac = trees / n;
        const std = Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2));
        const score = frac - std / 120;
        if (score > bestScore) {
          bestScore = score;
          best = { x: ax - o.x, z: az - o.z, dx, dz, frac };
        }
      }
    }
    return best && best.frac > 0.2 ? best : null;
  }

  // ─────────────────────────────── ground ───────────────────────────────
  private groundY(x: number, z: number): number {
    return this.ground(x, z).y;
  }

  /** Ground or water height (cached on a 16 m grid for a moment: the forecast asks a lot). */
  private ground(x: number, z: number): GroundSample {
    const { world, terrain } = this.ctx;
    const now = this.simT;
    if (now - this.groundCacheT > 2 || this.groundCache.size > 6000) {
      this.groundCache.clear();
      this.groundCacheT = now;
    }
    const kx = Math.round(x / 16), kz = Math.round(z / 16);
    const key = kx * 100003 + kz;
    const hit = this.groundCache.get(key);
    if (hit) return hit;
    let y = 0;
    let water = false;
    try {
      y = world.groundHeightAt(x, z);
    } catch {
      y = 0;
    }
    try {
      const wy = terrain?.waterAt?.(x, z);
      if (wy !== null && wy !== undefined && wy >= y) {
        y = wy;
        water = true;
      }
    } catch {
      /* terrain not ready */
    }
    const s = { y, water };
    this.groundCache.set(key, s);
    return s;
  }

  // ─────────────────────────────── forecast ───────────────────────────────
  private computeForecast(): void {
    const { ctx } = this;
    const lines: string[] = [];
    this.fcLines = lines;
    try {
      if (ctx.game.state !== 'driving') return;
      if (ctx.game.mode === 'plane') {
        if (ctx.walker.active && ctx.walker.mode !== 'cabin') this.forecastWalker(lines);
        else if (this.flying) this.forecastPlane(lines);
        else this.forecastPieces(lines);
      } else this.forecastCar(lines);
    } catch (err) {
      lines.push(`(forecast failed: ${(err as Error)?.message ?? err})`);
    }
  }

  /** Planned controls over the next seconds: current holds, queued holds / autopilot changes, break-up stops. */
  private planAhead(): { holdsAt: (t: number, axis: Axis) => number | undefined; apAt: (t: number) => Autopilot; throttleAt: (t: number) => number | null; stops: { t: number; label: string }[]; marks: { t: number; label: string }[] } {
    const now = this.simT;
    const fut: { t: number; plan: Plan; cmd: string }[] = this.queue.map((q) => ({ t: q.at - now, plan: this.planOf(q.cmd), cmd: q.cmd }));
    const cur = new Map(this.holds);
    const stops: { t: number; label: string }[] = [];
    const marks: { t: number; label: string }[] = [];
    for (const [axis, h] of cur) if (h.left < 30) marks.push({ t: h.left, label: `${axisName(axis, h.value)} hold ends` });
    for (const f of fut) {
      if (f.plan.k === 'stop') stops.push({ t: f.t, label: f.plan.label });
      else marks.push({ t: f.t, label: f.cmd });
    }
    const holdsAt = (t: number, axis: Axis): number | undefined => {
      let v: number | undefined;
      const h = cur.get(axis);
      if (h && t < h.left) v = h.value;
      for (const f of fut) if (f.plan.k === 'hold' && f.plan.axis === axis && t >= f.t && t < f.t + f.plan.secs) v = f.plan.value;
      return v;
    };
    const apAt = (t: number): Autopilot => {
      const a = { ...this.ap };
      for (const f of fut) if (f.plan.k === 'ap' && t >= f.t) (a as Record<string, number | null>)[f.plan.key] = f.plan.value;
      return a;
    };
    const throttleAt = () => this.throttleCmd;
    return { holdsAt, apAt, throttleAt, stops, marks };
  }

  /** What a queued command will do to the flight (for the ghost). */
  private planOf(cmd: string): Plan {
    const w = cmd.toLowerCase().split(/\s+/);
    const n = (i: number, d: number) => (Number.isFinite(parseFloat(w[i])) ? parseFloat(w[i]) : d);
    switch (w[0]) {
      case 'split':
      case 'middle':
      case 'half':
        return { k: 'stop', label: '✂ SPLIT — the plane breaks in half' };
      case 'explode':
      case 'boom':
        return { k: 'stop', label: '💥 EXPLODES' };
      case 'tail':
        return { k: 'stop', label: '🔥 TAIL BLOWN OFF' };
      case 'pitch':
      case 'nose':
        return w[1] === 'up' || w[1] === 'down' ? { k: 'hold', axis: 'pitch', value: (w[1] === 'up' ? 1 : -1) * clamp(n(3, 1), 0.05, 1), secs: n(2, 1) } : { k: 'none' };
      case 'climb':
      case 'dive':
        return { k: 'hold', axis: 'pitch', value: w[0] === 'climb' ? 1 : -1, secs: n(1, 1) };
      case 'bank':
      case 'roll':
      case 'turn':
        if (w[1] === 'left' || w[1] === 'right') return { k: 'hold', axis: 'roll', value: (w[1] === 'right' ? 1 : -1) * clamp(n(3, 1), 0.05, 1), secs: n(2, 1) };
        if (w[1] === 'off') return { k: 'ap', key: 'bank', value: null };
        return { k: 'ap', key: 'bank', value: n(1, 0) };
      case 'yaw':
      case 'rudder':
        return { k: 'hold', axis: 'yaw', value: w[1] === 'right' ? 1 : -1, secs: n(2, 1) };
      case 'alt':
      case 'agl':
      case 'altitude':
        return { k: 'ap', key: 'alt', value: w[1] === 'off' ? null : n(1, 30) };
      case 'heading':
      case 'hdg':
        return { k: 'ap', key: 'heading', value: w[1] === 'off' ? null : HEADINGS[w[1]] ?? n(1, 0) };
      case 'level':
        return { k: 'ap', key: 'bank', value: 0 };
      default:
        return { k: 'none' };
    }
  }

  private forecastPlane(lines: string[]): void {
    const { ctx } = this;
    const snap = ctx.planes.flightSnapshot?.();
    if (!snap) return;
    if (!(snap.inputs as { thrust: number[] }).thrust.length) {
      lines.push('  (the plane is just spawning — the forecast starts after its first physics step)');
      this.fcDirty = true;
      return;
    }
    const plan = this.planAhead();
    const lastStop = plan.stops.length ? Math.max(...plan.stops.map((s) => s.t)) : 0;
    const horizon = clamp(Math.max(6, lastStop + 0.1), 6, 16);
    let apCache: { t: number; c: ReturnType<Agent['autopilot']> } | null = null;
    const control = (v: GhostView): GhostControls => {
      const ap = plan.apAt(v.t);
      if (!apCache || v.t - apCache.t >= 0.1) apCache = { t: v.t, c: this.autopilot(v, ap, (x, z) => this.groundY(x, z)) };
      const c = apCache.c;
      const p = plan.holdsAt(v.t, 'pitch');
      const r = plan.holdsAt(v.t, 'roll');
      const y = plan.holdsAt(v.t, 'yaw');
      return { pitch: p ?? 0, roll: r ?? c.roll ?? 0, yaw: y ?? 0, gamma: p !== undefined ? null : c.gamma, throttle: c.throttle ?? plan.throttleAt(v.t) };
    };
    const fc = forecastFlight(snap, horizon, (x, z) => this.ground(x, z), control, plan.stops);
    this.fc = fc;
    // merge points + marks into one timeline
    const rows: { t: number; s: string }[] = [];
    for (const p of fc.points) {
      if (p.t > 6.01 && p.t % 1 > 0.01) continue; // past 6 s: whole seconds only
      rows.push({ t: p.t, s: `${f0(p.agl).padStart(5)} m  pitch ${s0(p.pitch).padStart(4)}°  bank ${s0(p.bank).padStart(4)}°  ${f0(p.speed)} m/s  climb ${s0(p.vs)}  hdg ${hdg(p.heading)}` });
    }
    for (const m of plan.marks) if (m.t <= horizon && m.t >= 0) rows.push({ t: m.t, s: `· ${m.label}` });
    if (fc.stall !== null) rows.push({ t: fc.stall, s: '⚠ STALL WARNING (too slow / nose too high)' });
    if (fc.stop) {
      const a = fc.stop.at;
      rows.push({ t: fc.stop.t, s: `${fc.stop.label} at ${f0(a.agl)} m, pitch ${s0(a.pitch)}°, ${f0(a.speed)} m/s` });
      const hit = fallForecast(fc.stop.pos, fc.stop.vel, (x, z) => this.ground(x, z), wreckG, 0.0004);
      if (hit) rows.push({ t: fc.stop.t + hit.t, s: `≈ the wreck hits the ${hit.water ? 'water' : 'ground'} at ≈ ${f0(hit.speed)} m/s, ${f0(hit.dist)} m further on` });
    }
    if (fc.impact) {
      const i = fc.impact;
      rows.push({ t: i.t, s: `‼ ${i.water ? 'WATER' : 'GROUND'} CONTACT at ${f0(i.speed)} m/s, sinking ${f0(-i.vs)} m/s, pitch ${s0(i.pitch)}°, bank ${s0(i.bank)}° → ${-i.vs > 6 || Math.abs(i.bank) > 20 ? 'CRASH' : 'touchdown'}` });
    }
    rows.sort((a, b) => a.t - b.t);
    for (const r of rows) lines.push(`  +${t1(r.t).padStart(4)} s  ${r.s}`);
    if (!fc.impact && !fc.stop) lines.push(`  no ground contact in the next ${f0(fc.horizon)} s · lowest ${f0(fc.lowest.agl)} m at +${t1(fc.lowest.t)} s`);
    // obstacles straight ahead (buildings / hills with colliders)
    const b = snap.body;
    const t = b.translation();
    const lv = b.linvel();
    const sp = Math.hypot(lv.x, lv.y, lv.z);
    if (sp > 5) {
      const hit = ctx.physics.raycast(_p.set(t.x, t.y, t.z), _v.set(lv.x / sp, lv.y / sp, lv.z / sp), sp * 8, groups(G.ALL, G.WORLD), b);
      if (hit) lines.push(`  ‼ OBSTACLE straight ahead (${hit.tag?.kind ?? 'solid'}) in ${f0(hit.toi)} m = ${t1(hit.toi / sp)} s on this path`);
    }
  }

  private forecastPieces(lines: string[]): void {
    const { ctx } = this;
    const pieces = [...ctx.breakup.pieces].sort((a, b) => b.mass - a.mass).slice(0, 3);
    if (!pieces.length) {
      if (ctx.planes.crashed) lines.push('  crashed — everything is on the ground. Try: replay · respawn · retry · car');
      return;
    }
    for (const p of pieces) {
      if (!ctx.physics.world.bodies.contains(p.body.handle)) continue;
      const t = p.body.translation();
      const v = p.body.linvel();
      const has = (n: string) => p.parts.some((s) => s.startsWith(n));
      const name = p.hasCockpit ? 'front section (cockpit)' : has('tail') || has('fin') ? 'rear section (tail)' : has('fuselageCenter') ? 'middle section (wings)' : has('wing') ? 'wing piece' : has('engine') ? 'engine' : `piece (${p.parts[0]})`;
      const g = this.ground(t.x, t.z);
      const h = t.y - g.y;
      const sp = Math.hypot(v.x, v.y, v.z);
      if (h < 4) {
        lines.push(`  ${name}: on the ${g.water ? 'water' : 'ground'}${sp > 3 ? `, sliding at ${f0(sp)} m/s` : ', stopped'}`);
        continue;
      }
      const hit = fallForecast(_p.set(t.x, t.y, t.z), _v2.set(v.x, v.y, v.z), (x, z) => this.ground(x, z), (tt) => wreckG(tt + 1.2), 0.0004);
      lines.push(`  ${name}: ${f0(h)} m up, ${f0(sp)} m/s${hit ? ` → hits the ${hit.water ? 'water' : 'ground'} in ≈ ${t1(hit.t)} s at ≈ ${f0(hit.speed)} m/s` : ''}`);
    }
  }

  private forecastWalker(lines: string[]): void {
    const { ctx } = this;
    const f = ctx.walker.focus;
    if (!f) return;
    if (ctx.walker.mode === 'ground') {
      lines.push('  on the ground — try: flyagain · car');
      return;
    }
    const prev = this.walkerPrev;
    const v = prev && this.simT > prev.t ? _v2.copy(f).sub(prev.p).divideScalar(Math.max(1e-3, this.simT - prev.t)) : _v2.set(0, 0, 0);
    this.walkerPrev = { p: f.clone(), t: this.simT };
    const g = this.ground(f.x, f.z);
    const W = CONFIG.walk;
    const hit = fallForecast(f, v, (x, z) => this.ground(x, z), () => 9.81, W.airDrag);
    lines.push(`  falling: ${f0(f.y - g.y)} m above the ${g.water ? 'water' : 'ground'}${hit ? ` → lands in ≈ ${t1(hit.t)} s at ≈ ${f0(hit.speed)} m/s (invincible)` : ''}`);
  }
  private walkerPrev: { p: THREE.Vector3; t: number } | null = null;

  private forecastCar(lines: string[]): void {
    const { ctx } = this;
    const vs = ctx.vehicle.state;
    if (!ctx.vehicle.active) return;
    if (vs.exploded) {
      lines.push('  exploded — "reset" (or X) for a new car');
      return;
    }
    const p = vs.position;
    const v = vs.velocity;
    const sp = v.length();
    if (vs.airborne) {
      const hit = fallForecast(p, v, (x, z) => this.ground(x, z), () => -CONFIG.physics.gravity);
      if (hit) lines.push(`  airborne → lands in ≈ ${t1(hit.t)} s, ${f0(hit.dist)} m ahead, at ${f0(hit.speed * 3.6)} km/h`);
    }
    if (sp > 2) {
      _v.copy(v).setY(0).normalize();
      const hit = ctx.physics.raycast(_p.copy(p).setY(p.y + 0.7), _v, Math.max(20, sp * 4), groups(G.ALL, G.WORLD | G.PARKED | G.PROP));
      if (hit) lines.push(`  ${hit.toi / sp < 1.5 ? '‼' : '·'} ${hit.tag?.kind ?? 'obstacle'} ahead in ${f0(hit.toi)} m = ${t1(hit.toi / sp)} s at this speed`);
      else lines.push(`  road clear for ${f0(Math.max(20, sp * 4))} m (${t1(Math.max(20, sp * 4) / sp)} s)`);
      const th = this.holds.get('throttle');
      if (th) lines.push(`  · gas held ${t1(th.left)} s more`);
    }
  }

  // ─────────────────────────────── text view ───────────────────────────────
  text(): string {
    return this.compose();
  }

  private render(force = false): void {
    if (!this.panel) return;
    const s = this.compose();
    if (!force && s === this.lastText) return;
    this.lastText = s;
    this.panel.textContent = s;
  }

  private compose(): string {
    const { ctx } = this;
    const L: string[] = [];
    const st = ctx.game.state;
    const env = ctx.env;
    const hrs = env.clockHours;
    const night = env.nightFactor ?? 0;
    const speedTag = this.frozen ? 'FROZEN — K / "go" resumes, "." or "run 1" = +1 s' : ctx.engine.filming ? `FILMING (frame-exact) ×${(ctx.engine.timeScale ?? 1).toFixed(2)}` : `LIVE ×${(ctx.engine.timeScale ?? 1).toFixed(2)}`;
    L.push(`GRAND CRASH AUTO · AGENT VIEW · t ${t1(this.simT)} s · ${speedTag}`);
    L.push(`WORLD   ${hrs !== undefined ? fmtTime(hrs) : '--:--'} ${night > 0.6 ? 'night' : night > 0.15 ? 'dusk' : 'day'} · weather ${env.weather?.kind ?? 'clear'}`);
    if (st !== 'driving') {
      L.push(`STATE   ${st}${st === 'title' || st === 'menu' ? ' — gca.do("fly jumbo") / "car" to start, or click' : ''}`);
      L.push(...this.footer());
      return L.join('\n');
    }
    if (ctx.replay.active) {
      L.push(`REPLAY  camera ${ctx.replay.camName}${ctx.replay.speed < 0.9 ? ' (slow-mo)' : ''} — "replay next" / "replay stop" (C / Esc)`);
      L.push(...this.footer());
      return L.join('\n');
    }
    const o = ctx.origin.offset;
    if (ctx.game.mode === 'plane') {
      const ps = ctx.planes.state;
      const type = ctx.planes.currentType;
      const pieces = ctx.breakup.pieces.length;
      const phase = ctx.planes.crashed ? (pieces ? `DESTROYED (${pieces} pieces)` : 'CRASHED') : ps.phase;
      const dmg: string[] = [];
      if (ps.damage?.tailLost) dmg.push('tail lost');
      const wf = ctx.planes.wingFailure;
      if (wf) dmg.push(`${wf.side === 'L' ? 'left' : 'right'} wing ${wf.mode === 'far' ? 'tip gone' : 'torn in half'}`);
      const fires = ps.engines.filter((e) => e.status !== 'ok').length;
      if (fires) dmg.push(`${fires} engine${fires > 1 ? 's' : ''} out`);
      L.push(`YOU     PLANE · ${type ? PLANE_NAMES[type] : '?'} · ${phase}${dmg.length ? ' · ' + dmg.join(', ') : this.flying ? ' · intact' : ''}${ctx.walker.active ? ` · you are ON FOOT (${ctx.walker.mode}${ctx.walker.seated ? ', seated' : ''})` : ''}`);
      if (this.flying) {
        const trees = ps.altitudeAgl < 25 ? ' (in the treetops!)' : ps.altitudeAgl < 60 ? ' (skimming the trees)' : '';
        L.push(`NOW     ${f0(ps.altitudeAgl)} m above ground${trees} · ${f0(ps.airspeed)} m/s (${f0(ps.airspeedKmh)} km/h) · climb ${s0(ps.verticalSpeed)} m/s · pitch ${s0(ps.pitch)}° · bank ${s0(ps.bank)}° · hdg ${hdg(ps.heading)} · throttle ${f0(ps.throttle * 100)} %${ps.stallWarning ? ' · ⚠ STALL' : ''}`);
        L.push(`        stall speed ${f0(ps.stallSpeedKmh / 3.6)} m/s · position x ${f0(ps.position.x + o.x)} z ${f0(ps.position.z + o.z)} · ${ps.gear > 0.5 ? 'gear down' : 'gear up'}`);
      } else if (ctx.walker.active && ctx.walker.focus) {
        const f = ctx.walker.focus;
        L.push(`NOW     you: ${f0(f.y - this.groundY(f.x, f.z))} m above ground · ${ctx.walker.firstPerson ? 'first person' : 'third person'}`);
      }
    } else {
      const vs = ctx.vehicle.state;
      L.push(`YOU     CAR · ${vs.exploded ? 'EXPLODED' : vs.airborne ? 'AIRBORNE' : 'on the road'} · ${f0(vs.speedKmh)} km/h · gear ${vs.gear < 0 ? 'R' : vs.gear}${vs.turboCharge !== undefined ? ` · turbo ${f0(vs.turboCharge * 100)} %` : ''}${vs.upsideDown ? ' · UPSIDE DOWN (F flips)' : ''}`);
      const fw = vs.forward;
      L.push(`NOW     heading ${hdg(Math.atan2(fw.x, -fw.z) / DEG)} · position x ${f0(vs.position.x + o.x)} z ${f0(vs.position.z + o.z)}`);
    }
    // held controls + autopilot
    const held = [...this.holds].map(([a, h]) => `${axisName(a, h.value)} ${t1(h.left)} s left`);
    if (this.throttleCmd !== null && ctx.game.mode === 'plane') held.push(`throttle set ${f0(this.throttleCmd * 100)} %`);
    L.push(`HELD    ${held.length ? held.join(' · ') : 'nothing — stick centred (assists hold the flight path, wings level)'}`);
    const ap: string[] = [];
    if (this.ap.alt !== null) ap.push(`terrain-follow ${f0(this.ap.alt)} m`);
    if (this.ap.heading !== null) ap.push(`heading ${hdg(this.ap.heading)}`);
    if (this.ap.bank !== null) ap.push(`bank ${s0(this.ap.bank)}°`);
    if (this.ap.speed !== null) ap.push(`speed ${f0(this.ap.speed)} m/s`);
    if (this.ap.target) {
      const p = ctx.planes.state.position;
      const d = Math.hypot(this.ap.target.x - o.x - p.x, this.ap.target.z - o.z - p.z);
      ap.push(`HOMING on ${this.ap.target.name} (${f0(d)} m, ≈ ${t1(d / Math.max(1, ctx.planes.state.airspeed))} s)`);
    }
    if (ctx.game.mode === 'plane') L.push(`AUTO    ${ap.length ? ap.join(' · ') : 'off'}`);
    // forecast
    if (this.fcLines.length) {
      L.push('FORECAST (same physics, your held keys + autopilot + queue; nothing else changes)');
      L.push(...this.fcLines);
    }
    // timers
    const timers: string[] = [];
    const wf = ctx.planes.wingFailure;
    if (wf && wf.mode === 'half' && this.flying) {
      const S = CONFIG.planes.wingBreak.spinAfterS;
      if (wf.t < S * 0.5) timers.push(`controls start failing in ${t1(S * 0.5 - wf.t)} s`);
      timers.push(wf.t < S ? `full stall + unrecoverable SPIN in ${t1(S - wf.t)} s` : 'SPINNING (unrecoverable)');
    }
    const snap = this.snap;
    if (snap?.tailExplodeIn !== null && snap?.tailExplodeIn !== undefined) timers.push(`tail fire explodes the plane in ≈ ${t1(snap.tailExplodeIn)} s`);
    const oom = ctx.planes.state.outOfMap;
    if (ctx.game.mode === 'plane' && oom && oom.state !== 'ok') timers.push(`out of map: ${oom.state}${oom.countdown > 0 ? ` (${t1(oom.countdown)} s)` : ''}`);
    if (timers.length) L.push(`TIMERS  ${timers.join(' · ')}`);
    if (this.queue.length) L.push(`QUEUE   ${this.queue.map((q) => `+${t1(q.at - this.simT)} s ${q.cmd}`).join(' · ')}`);
    if (this.events.length) L.push(`EVENTS  ${this.events.slice(-5).map((e) => `[${t1(e.t)}] ${e.text}`).join(' · ')}`);
    L.push(...this.footer());
    return L.join('\n');
  }

  private footer(): string[] {
    const { ctx } = this;
    const plane = ctx.game.mode === 'plane';
    const walking = plane && ctx.walker.active;
    const keys = walking
      ? 'W/S/A/D walk (tap = 1 s) · E grab seat (toggle) · Space jump · Q window · C view · F pilot'
      : plane
        ? 'tap = hold 1 s (taps add): S nose up · W nose down · A/D bank · Q/E rudder · Shift/Ctrl throttle ±10 % · Backspace release · M split · T tail · 1-4 engines · X explode · C camera · F walk'
        : 'tap = hold: W gas 1 s · S brake 1 s · A/D steer 0.5 s · Space handbrake · Shift turbo · Q/E barrel roll · X explode · R reset · C camera';
    return [`KEYS    ${keys} · K freeze · . step 1 s · U rec mode`, 'JS      gca.do("cmd; wait 2; cmd") · gca.help() · gca.state() · gca.json()'];
  }

  private json(): Record<string, unknown> {
    const { ctx } = this;
    const ps = ctx.planes.state;
    return {
      t: this.simT, frozen: this.frozen, state: ctx.game.state, mode: ctx.game.mode, clock: ctx.env.clockHours,
      plane: ctx.game.mode === 'plane' ? {
        type: ctx.planes.currentType, phase: ps.phase, crashed: ctx.planes.crashed, agl: ps.altitudeAgl, airspeed: ps.airspeed, vs: ps.verticalSpeed,
        pitch: ps.pitch, bank: ps.bank, heading: ps.heading, throttle: ps.throttle, pieces: ctx.breakup.pieces.length,
      } : null,
      car: ctx.game.mode === 'car' ? { speedKmh: ctx.vehicle.state.speedKmh, airborne: ctx.vehicle.state.airborne, exploded: ctx.vehicle.state.exploded } : null,
      walker: ctx.walker.active ? { mode: ctx.walker.mode, seated: ctx.walker.seated } : null,
      holds: Object.fromEntries([...this.holds].map(([a, h]) => [a, { value: h.value, left: h.left }])),
      autopilot: { ...this.ap }, throttleCmd: this.throttleCmd,
      queue: this.queue.map((q) => ({ in: q.at - this.simT, cmd: q.cmd })),
      forecast: this.fc ? { points: this.fc.points, impact: this.fc.impact, stop: this.fc.stop && { t: this.fc.stop.t, label: this.fc.stop.label, at: this.fc.stop.at }, stall: this.fc.stall } : null,
      forecastText: this.fcLines,
      events: this.events,
    };
  }
}

function axisName(a: Axis, v: number): string {
  switch (a) {
    case 'pitch':
      return v > 0 ? 'nose up' : 'nose down';
    case 'roll':
      return v > 0 ? 'bank right' : 'bank left';
    case 'yaw':
      return v > 0 ? 'rudder right' : 'rudder left';
    case 'steer':
      return v > 0 ? 'steer right' : 'steer left';
    case 'moveY':
      return v > 0 ? 'walk forward' : 'walk back';
    case 'moveX':
      return v > 0 ? 'step right' : 'step left';
    case 'throttle':
      return 'gas';
    default:
      return a;
  }
}

function parseTime(s?: string): number {
  if (!s) return NaN;
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s);
  if (!m) return NaN;
  return (Number(m[1]) % 24) + (m[2] ? Number(m[2]) / 60 : 0);
}

function fmtTime(h: number): string {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** "90" → m/s, "300 kmh" / "300kmh" → km/h. */
function parseSpeed(a?: string, b?: string): number {
  if (!a) return NaN;
  const n = parseFloat(a);
  if (!Number.isFinite(n)) return NaN;
  return /kmh|km\/h|kph/.test(a + ' ' + (b ?? '')) ? n / 3.6 : n;
}

const HELP = `GRAND CRASH AUTO — AGENT COMMANDS (gca.do("a; b; wait 2; c") — ";" separates, "wait N" delays what follows by N s of game time)
WORLD    night · day · sunset · dawn · time 23:30 · weather clear|cloudy|overcast|rain|drizzle|storm|fog|snow|auto
START    fly <prop|jet|airliner|jumbo> [agl 25] [speed 150 | speed 500 kmh] [heading 90|n|e|s|w] [over forest|city|sea] [at X Z]
         (agl < 150 starts over a forest and keeps terrain-following at that height) · switch <type> (mid-air) · car · teleport <place> · places
FLY      pitch up|down [s] [0..1] · climb [s] · dive [s] · bank left|right [s] · yaw left|right [s] · stick <pitch> <roll> <s>
         throttle 0..100 | +10 | -10 | max | idle · release (centre everything)
AUTO     alt <m above ground> (terrain following) · heading <deg|n|e|s|w> · bank <deg, +right> · speed <m/s> · level · ap off · alt off …
MISSILES traffic (sky planes #) · sites · shoot <# | nearest> [from <site|kind>] [2|all] [spread] [aim nose|tail|left|right|middle] · steer <u> <v>
         back · ram <# | nearest> | ram off (your plane flies into it) · nuke <# | nearest> | nuke <place|x z> · watch nuke|missile|hit|off (ride your nuke / follow the plane you hit) · watch <#|nearest> (WATCH IT: keep a good distance, camera on it)
TARGET   fly <type> target <concert|stage|crowd|city|beach|airport|park|place|x z> [in 14] [from n|e|s|w] [speed v] [agl h]
         (spawns on a dive that crashes there) · target <place> (home on it from where you are) · target off
CRASH    split · tail · engine 1..4 · explode · wing left|right far|half · gear · respawn · retry
ON FOOT  walk · pilot · window · view · flyagain   (keys: W/S/A/D tap = 1 s, E grab)
CAR      gas [s] · brake [s] · steer left|right [s] [0..1] · handbrake [s] · turbo [s] · barrel left|right · explode · reset
CAMERA   cam · cam chase|cockpit|wing|orbit|hood · replay · replay next|restart|stop
TIME     freeze · go · run <s> (advance then freeze) · slowmo <scale> <s> · timescale <x> · cancel (clear the queue)
UI       rec on|off (recording mode: buttons tiny in one corner) · panel on|off · menu
TEXT     gca.state() = this view · gca.json() = the same as data · the FORECAST is a ghost copy of the real physics run ahead
FILM     gca.film.start() · gca.film.frame(1/30) → JPEG of exactly 1/30 s later · gca.film.advance(n, dt) · gca.film.stop()
DOCS     /endpoint.md (how to play + make videos) · /endpoint/film.mjs (recorder: node film.mjs --scene "…")
RECIPES  (add "rec on;" first for clean footage)
  night tree-skim split   night; fly jumbo agl 22 speed 150; wait 6; pitch up 2; wait 2; split; wait 6; replay
  wing-off death spiral   fly airliner agl 700; wing left half; wait 32; cam
  engines one by one      fly jumbo; engine 1; wait 3; engine 2; wait 3; engine 3; wait 3; engine 4
  walk while it splits    fly jumbo agl 500; walk; wait 4; split
  tail off over the city  fly airliner agl 250 over city; wait 4; tail; wait 1; cam`;
