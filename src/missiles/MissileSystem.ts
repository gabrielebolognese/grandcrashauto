import * as THREE from 'three';
import './missiles.css';
import { CONFIG } from '../config';
import { clamp } from '../core/math';
import { GLOBAL_UNIFORMS } from '../core/uniforms';
import type { GameContext, IMissiles, LauncherInfo, SkyPlaneInfo, TrailHandle } from '../game/contracts';
import type { PlaneVisual, TrackedPlane } from '../plane/types';
import { AirTraffic, type SkyPlane } from './AirTraffic';
import { Launchers, missileModel, type Launcher } from './Launchers';
import { LAUNCHER_TYPES, type LauncherType } from './types';

interface Missile {
  obj: THREE.Group;
  type: LauncherType;
  pos: THREE.Vector3;
  prev: THREE.Vector3;
  dir: THREE.Vector3;
  speed: number;
  t: number;
  climb: number; // s of straight climb (silo)
  target: SkyPlane | null; // locked on (always hits)
  seek: SkyPlane | null; // fired without a lock: it locks on if this plane crosses its seeker
  ground: THREE.Vector3 | null; // nuke at a place (LOCAL)
  u: number; // aim offset on the target: + = its right wing, - = left
  v: number; // + = nose, - = tail
  controlled: boolean;
  trail: TrailHandle | null;
  done: boolean;
}

interface Control {
  launcher: Launcher;
  target: SkyPlane;
  phase: 'aim' | 'missile' | 'impact';
  first: Missile | null;
  impactAt: THREE.Vector3;
  impactT: number;
  spread: boolean;
  u: number;
  v: number;
  inputWas: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const ENERGY: Record<string, number> = { small: 500, medium: 1600, big: 4200, nuke: 30000 };
const JOINT_R: Record<string, number> = { small: 3.5, medium: 7, big: 12, nuke: 999 };

/** Readable name of the part an aim point lands on. */
function partLabel(name: string): string {
  if (name === 'cockpit' || name === 'nose') return 'NOSE';
  if (name === 'fuselageFwd') return 'FRONT FUSELAGE';
  if (name === 'fuselageCenter') return 'MIDDLE';
  if (name === 'fuselageRear') return 'REAR FUSELAGE';
  if (name === 'tailCone' || name === 'fin' || name.startsWith('tailplane')) return 'TAIL';
  if (name.startsWith('engine')) return `ENGINE ${name.slice(6)}`;
  const w = /^wing([LR])(\d)$/.exec(name);
  if (w) return `${w[1] === 'L' ? 'LEFT' : 'RIGHT'} WING ${w[2] === '1' ? 'ROOT' : w[2] === '2' ? 'MIDDLE' : 'TIP'}`;
  return name.toUpperCase();
}

/**
 * MISSILES AND NUKES (user request). Air-defence sites in the city and the mountains (5 custom kinds), perpetual sky
 * traffic, and the control room:
 *  - pick a plane on the map → SHOOT → pick a site: you are in its control room — the view from behind the launcher,
 *    a reticle, the target lit and marked from any distance. Aim roughly at it (A/D/W/arrows or drag) and press S:
 *    the missile locks on. Each S fires again (Twin Titan one, Hexa Pike a pair, Hornet one — ALL fires the salvo,
 *    SPREAD spreads it over the plane). You fly the first missile: it ALWAYS hits, steering only picks where (nose,
 *    tail, a wing, an engine…). The impact breaks the plane apart and it falls and crashes; the replay shows it.
 *  - BACK returns to your car / plane while the missiles keep homing. Flying, you can also RAM a sky plane on
 *    autopilot, or just crash into one.
 *  - The Doomsday Silo fires a nuke: everything flying within ~1.8 km goes, the ground below is flattened.
 */
export class MissileSystem implements IMissiles {
  readonly name = 'missiles';
  readonly traffic: AirTraffic;
  readonly launchers: Launchers;
  private missiles: Missile[] = [];
  private control: Control | null = null;
  private inputWasEnabled = true;
  private keys = new Set<string>();
  private drag: { id: number; x: number; y: number } | null = null;
  private dragD = { x: 0, y: 0 };
  private hud: HTMLDivElement | null = null;
  private el: Record<string, HTMLElement> = {};
  private camPos = new THREE.Vector3();
  private camSet = false;
  private msgT = 0;
  private ramId: number | null = null;
  // spectator cameras (user request): ride your nuke / missile, or follow the sky plane you just hit
  private spec: { kind: 'missile' | 'hit'; m: Missile | null; p: SkyPlane | null; at: THREE.Vector3 | null; t: number; holdT: number } | null = null;
  private lastHit: { p: SkyPlane; t: number } | null = null;
  private specBar: HTMLDivElement | null = null;
  private specKey = '';
  private specAnchor = new THREE.Vector3();
  private specOff = new THREE.Vector3();
  private specSide = new THREE.Vector3(1, 0, 0);
  // the camera while we have it (control room / spectator cams). The FOV is OUR value: the camera rig stays off, and
  // blending from cam.fov (which the rig rewrote every frame) made the zoom pump = the "flicker" (user report)
  private camFov = 60;
  private camDir = new THREE.Vector3(0, 0, 1); // the chase direction, turned smoothly (guidance corrections don't swing it)
  private camOff = new THREE.Vector3();
  private camAnch = false;
  private igniteT = -9; // last launch flash (a salvo flashes once, not 8 strobes)
  private boomT = -9; // last impact light
  private clock = 0;
  private flashT = 0;
  private focusV = new THREE.Vector3();
  private flareMat: THREE.SpriteMaterial | null = null;

  constructor(private ctx: GameContext) {
    this.traffic = new AirTraffic(ctx);
    this.launchers = new Launchers(ctx);
  }

  init(): void {
    const { ctx } = this;
    this.traffic.init();
    ctx.events.on('originShift', ({ delta }) => {
      for (const m of this.missiles) {
        m.pos.sub(delta);
        m.prev.sub(delta);
        m.ground?.sub(delta);
      }
      this.camPos.sub(delta);
      this.control?.impactAt.sub(delta);
      this.spec?.at?.sub(delta);
    });
    ctx.events.on('planeSpawned', () => this.spectate(null));
    ctx.events.on('modeChanged', () => this.spectate(null));
    // mid-air collisions: a plane (yours or a wreck piece) slamming into a sky plane breaks it where it was hit
    ctx.events.on('contact', (e) => {
      const a = this.traffic.byCollider(e.h1), b = this.traffic.byCollider(e.h2);
      if (!a && !b) return;
      if (a && b && a === b) return;
      const p = a ?? b!;
      const other = a ? e.tag2 : e.tag1;
      if (!other || (other.kind !== 'plane' && other.kind !== 'wreck')) return;
      this.collide(p, a ? e.h1 : e.h2);
    });
    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    const cv = ctx.engine.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => {
      if (!this.control) return;
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.control || !this.drag || e.pointerId !== this.drag.id) return;
      this.dragD.x += e.clientX - this.drag.x;
      this.dragD.y += e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
    });
    window.addEventListener('pointerup', (e) => {
      if (this.drag?.id === e.pointerId) this.drag = null;
    });
    // the plane system's "ram" autopilot asks us where the target will be
    (ctx.planes as { ramTarget?: (() => THREE.Vector3 | null) | null }).ramTarget = () => this.ramPoint();
  }

  // ───────────────────────────── contract ─────────────────────────────
  get sky(): SkyPlaneInfo[] {
    const o = this.ctx.origin.offset;
    return this.traffic.planes.map((p) => ({
      id: p.id, type: p.type, name: p.name, ax: p.pos.x + o.x, az: p.pos.z + o.z, alt: p.pos.y,
      heading: ((Math.atan2(p.vel.x, -p.vel.z) * 180) / Math.PI + 360) % 360, speed: p.vel.length(), hit: p.hit,
    }));
  }

  get sites(): LauncherInfo[] {
    return this.launchers.list.map((l) => ({
      id: l.id, name: l.name, kind: l.type.name, ax: l.ax, az: l.az, tubes: l.ready.length, ready: l.ready.filter(Boolean).length,
      warhead: l.type.warhead, blurb: l.type.blurb,
    }));
  }

  get pois() {
    return this.launchers.pois;
  }

  get controlling(): boolean {
    return !!this.control;
  }

  /** Streaming focus while in the control room (the launcher, the flying missile, the impact). */
  get focus(): THREE.Vector3 | null {
    const s = this.spec;
    if (s) {
      // the world streams around what you watch: the plane (the target of the missile) or the blast point
      const p = s.p ?? s.m?.target ?? null;
      if (p) return this.focusV.copy(p.pos);
      if (s.at) return this.focusV.copy(s.at);
      if (s.m?.ground) return this.focusV.copy(s.m.ground);
      return null;
    }
    const c = this.control;
    if (!c) return null;
    // the world keeps streaming around the turret: chasing a 600 m/s missile / a far crash re-streamed terrain every frame
    return this.launchers.pivot(c.launcher, this.focusV);
  }

  enterControl(launcherId: string, planeId: number): string {
    const { ctx } = this;
    const l = this.launchers.list.find((x) => x.id === launcherId);
    const p = this.traffic.planes.find((x) => x.id === planeId);
    if (!l) return 'no such air-defence site';
    if (!p) return 'that plane is gone';
    if (ctx.game.state !== 'driving') return 'not playing';
    if (this.control) this.exitControl();
    if (this.spec) this.spectate(null);
    if (ctx.walker.active && ctx.walker.mode === 'cabin') ctx.walker.stop();
    this.control = { launcher: l, target: p, phase: 'aim', first: null, impactAt: new THREE.Vector3(), impactT: 0, spread: false, u: 0, v: 0, inputWas: false };
    // start aimed at the target (a little off, so you aim it yourself)
    this.launchers.pivot(l, _v);
    _v2.subVectors(p.pos, _v);
    l.aimYaw = Math.atan2(_v2.x, _v2.z) + 0.25;
    l.aimPitch = clamp(Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z)) - 0.08, 0.05, 1.45);
    this.inputWasEnabled = ctx.input.enabled;
    ctx.input.enabled = false;
    if (ctx.game.mode === 'plane') (ctx.planes as { freeze?: (on: boolean) => void }).freeze?.(true);
    this.camSet = false;
    this.showHud(true);
    ctx.events.emit('toast', { text: `🎯 ${l.name}: aim at the ${p.name.split(' · ')[0]}, press S to fire`, ms: 2600 });
    return '';
  }

  exitControl(): void {
    const { ctx } = this;
    if (!this.control) return;
    // your missiles keep homing (the first one too, it just flies itself)
    for (const m of this.missiles) m.controlled = false;
    this.control = null;
    ctx.input.enabled = this.inputWasEnabled;
    (ctx.planes as { freeze?: (on: boolean) => void }).freeze?.(false);
    this.showHud(false);
    const cam = ctx.engine.camera;
    cam.fov = 60;
    cam.updateProjectionMatrix();
    try {
      ctx.cameraRig.snap();
    } catch {
      /* camera not ready */
    }
  }

  /** Fire from the control room: n missiles (or the salvo rule), spread = different spots of the plane. */
  fire(n = 0, opts: { all?: boolean; spread?: boolean } = {}): string {
    const c = this.control;
    if (!c) return 'not in a control room';
    const l = c.launcher;
    // a lock is not needed: locked = it always hits; no lock = it flies where the launcher points and locks on only
    // if the plane crosses its seeker on the way
    const locked = this.locked(c);
    const free = l.ready.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
    if (!free.length) return 'reloading…';
    let count = n > 0 ? n : opts.all ? free.length : 1;
    count = Math.min(count, free.length);
    const spread = opts.spread ?? c.spread;
    for (let k = 0; k < count; k++) {
      const i = free[k];
      // the camera / your steering follow the newest locked missile if the current one flies blind
      const first = !c.first || c.first.done || (locked && k === 0 && !c.first.target);
      if (first && c.first && !c.first.done) c.first.controlled = false;
      const m = this.launch(l, i, locked ? c.target : null, null, first ? c.u : spread ? (Math.random() * 2 - 1) * 0.9 : c.u, first ? c.v : spread ? (Math.random() * 2 - 1) * 0.9 : c.v, first, k * 0.18);
      m.seek = c.target;
      if (first) {
        c.first = m;
        c.phase = 'missile';
        this.camSet = false;
        try {
          (this.ctx.replay as { watch?: (v: unknown, extra: THREE.Object3D[]) => void }).watch?.(c.target.visual, this.missiles.filter((x) => x.target === c.target).map((x) => x.obj));
        } catch {
          /* replay busy */
        }
      } else (this.ctx.replay as { addExtra?: (o: THREE.Object3D) => void }).addExtra?.(m.obj);
    }
    return `${locked ? 'locked — ' : 'no lock — '}fired ${count} (${l.ready.filter(Boolean).length} left)`;
  }

  /** Steer the controlled missile's impact point: u = right wing (+) / left (-), v = nose (+) / tail (-), -1..1. */
  steer(u: number, v: number): void {
    const c = this.control;
    if (!c) return;
    c.u = clamp(u, -1, 1);
    c.v = clamp(v, -1, 1);
    if (c.first && !c.first.done) {
      c.first.u = c.u;
      c.first.v = c.v;
    }
  }

  /** Flying: the plane system's autopilot rams this sky plane (null = off). */
  ram(planeId: number | null): string {
    if (planeId === null) {
      this.ramId = null;
      this.traffic.ramId = null;
      return 'ram autopilot off';
    }
    const p = this.traffic.planes.find((x) => x.id === planeId);
    if (!p) return 'that plane is gone';
    if (this.ctx.game.mode !== 'plane' || !this.ctx.planes.active || this.ctx.planes.crashed) return 'you need to be flying a plane';
    this.ramId = planeId;
    return `autopilot: ramming the ${p.name}`;
  }

  /** Nuke a sky plane (from the Doomsday Silo, no control room) or an ABSOLUTE ground point. */
  nuke(planeId: number | null, at?: { x: number; z: number }): string {
    const silo = this.launchers.list.find((l) => l.type.kind === 'nuke');
    if (!silo) return 'no nuke turret';
    const i = silo.ready.findIndex(Boolean);
    if (i < 0) return 'the nuke turret is reloading';
    if (planeId !== null) {
      const p = this.traffic.planes.find((x) => x.id === planeId);
      if (!p) return 'that plane is gone';
      this.launch(silo, i, p, null, 0, 0, false, 0);
      return `nuke launched at the ${p.name} — K / NUKE CAM rides it`;
    }
    if (!at) return 'nuke what?';
    const o = this.ctx.origin.offset;
    const g = new THREE.Vector3(at.x - o.x, 0, at.z - o.z);
    g.y = this.groundAt(g.x, g.z) + 30; // airburst
    this.launch(silo, i, null, g, 0, 0, false, 0);
    return 'nuke launched — K / NUKE CAM rides it';
  }

  // ───────────────────────────── spectator cameras ─────────────────────────────
  get viewing(): boolean {
    return !!this.spec;
  }

  /** Your newest missile / nuke still flying (or about to fire). */
  private watchable(): Missile | null {
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (!m.done && (m.target || m.seek || m.ground)) return m;
    }
    return null;
  }

  /** The sky plane you hit last, while it is still around (90 s). */
  private hitWatchable(): SkyPlane | null {
    const h = this.lastHit;
    if (!h || this.clock - h.t > 90 || !this.traffic.planes.includes(h.p)) return null;
    return h.p;
  }

  /** The cameras on offer (the plane HUD shows them as dock buttons, so they never cover the top bar). */
  camOffer(): { missile: 'nuke' | 'missile' | null; hit: boolean } {
    if (this.spec || this.control) return { missile: null, hit: false };
    const m = this.watchable();
    return { missile: m ? (m.type.warhead === 'nuke' ? 'nuke' : 'missile') : null, hit: !!this.hitWatchable() };
  }

  /** Switch the view (user request): ride your missile / nuke, follow the plane you hit, or back (null). */
  spectate(kind: 'missile' | 'hit' | null): string {
    const { ctx } = this;
    if (kind === null) {
      if (!this.spec) return '';
      this.spec = null;
      (ctx.planes as { freeze?: (on: boolean) => void }).freeze?.(false);
      document.getElementById('ui-root')?.classList.remove('msl-control');
      const cam = ctx.engine.camera;
      cam.fov = 60;
      cam.updateProjectionMatrix();
      try {
        ctx.cameraRig.snap();
      } catch {
        /* camera not ready */
      }
      return 'back to your view';
    }
    if (this.control) return 'leave the control room first';
    if (ctx.game.state !== 'driving') return 'not playing';
    const m = kind === 'missile' ? this.watchable() : null;
    const p = kind === 'hit' ? this.hitWatchable() : null;
    if (kind === 'missile' && !m) return 'no missile or nuke of yours is flying';
    if (kind === 'hit' && !p) return 'you have not hit a plane yet';
    this.spec = { kind, m, p, at: null, t: 0, holdT: 0 };
    this.camSet = false;
    // your plane waits in the air while you watch (it would fly on unattended)
    if (ctx.game.mode === 'plane') (ctx.planes as { freeze?: (on: boolean) => void }).freeze?.(true);
    document.getElementById('ui-root')?.classList.add('msl-control');
    if (m) return m.type.warhead === 'nuke' ? '☢ riding the nuke' : '🚀 riding the missile';
    return `🎯 watching the ${p!.name.split(' · ')[0]}`;
  }

  /** Replay: the other plane to record with yours — the ram target, the plane you hit, else the nearest within 3 km. */
  coSubject(fallback: PlaneVisual | null = null): PlaneVisual | null {
    const T = this.traffic.planes;
    if (this.ramId !== null) {
      const r = T.find((x) => x.id === this.ramId);
      if (r) return r.visual;
    }
    const h = this.lastHit;
    if (h && this.clock - h.t < 30 && T.includes(h.p)) return h.p.visual;
    if (fallback) return fallback; // the plane you shot at (replay)
    const me = this.ctx.planes.currentTracked?.visual?.root ?? null;
    if (!me || this.ctx.game.mode !== 'plane') return null;
    me.getWorldPosition(_v);
    let best: SkyPlane | null = null, bd = 3000;
    for (const p of T) {
      const d = p.pos.distanceTo(_v);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best?.visual ?? null;
  }

  private toast(text: string): void {
    if (text) this.ctx.events.emit('toast', { text, ms: 1600 });
  }

  private updateSpec(dt: number): void {
    const { ctx } = this;
    const s = this.spec;
    this.drawSpecBar();
    if (!s) return;
    s.t += dt;
    if (s.m) {
      if (s.m.done) {
        // the missile went off: watch the plane it hit (or the blast)
        if (s.m.target && this.traffic.planes.includes(s.m.target)) s.p = s.m.target;
        else s.at = (s.m.ground ?? s.m.pos).clone();
        s.m = null;
        s.holdT = 0;
        this.camSet = false;
      }
    }
    if (s.p && !this.traffic.planes.includes(s.p)) {
      this.spectate(null);
      return;
    }
    if (!s.m && !s.p) {
      s.holdT += dt;
      if (s.holdT > 8) {
        this.spectate(null);
        return;
      }
    }
    const cam = ctx.engine.camera;
    const eye = _v.set(0, 0, 0), look = _v2.set(0, 0, 0);
    const first = !this.camSet;
    let fov = 55;
    if (s.m) {
      // a three-quarter chase from the side: the nuke big in frame, its trail streaming away (never through the lens)
      const m = s.m;
      const back = m.type.missileLen * 3 + 15;
      if (first) this.camDir.copy(m.dir);
      else this.camDir.lerp(m.dir, 1 - Math.exp(-dt / 0.3)).normalize();
      const md = this.camDir;
      const side = _v3.crossVectors(md, UP);
      if (side.lengthSq() > 1e-3) {
        if (first) this.specSide.copy(side.normalize());
        else this.specSide.lerp(side.normalize(), 1 - Math.exp(-dt / 0.5)).normalize(); // climbing straight up: keep the last side
      }
      this.specAnchor.copy(m.obj.position);
      // beside it and a touch ahead: the fire trail streams AWAY from the lens (close to it, it washes the frame out)
      eye.copy(m.obj.position).addScaledVector(md, back * 0.15).addScaledVector(this.specSide, back * 1.1).addScaledVector(UP, back * 0.35);
      // look just ahead of its nose (the nuke near the centre of the frame), a touch toward where it is going
      look.copy(m.obj.position).addScaledVector(md, back * 0.45);
      const tgt = m.target ?? m.seek;
      const goal = tgt ? tgt.pos : m.ground;
      if (goal) look.lerp(_v3.subVectors(goal, m.obj.position).normalize().multiplyScalar(back * 0.45).add(m.obj.position), 0.15);
      fov = 60;
    } else if (s.p) {
      // chase the plane going down: behind its motion, above and a little to the side
      const p = s.p;
      const L = clamp(p.visual.dims.length, 10, 75);
      const dir = _v3.copy(p.vel);
      if (dir.lengthSq() < 4) dir.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
      dir.y *= 0.5;
      dir.normalize();
      const side = _v4.crossVectors(dir, UP);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize();
      this.specAnchor.copy(p.pos);
      eye.copy(p.pos).addScaledVector(dir, -L * 2.4).addScaledVector(UP, L * 0.7).addScaledVector(side, L * 0.9);
      look.copy(p.pos);
      fov = 58;
    } else if (s.at) {
      // a blast with nothing to follow: a wide look from a safe distance
      this.specAnchor.copy(s.at);
      eye.copy(s.at).add(_v3.set(900, 500, 900));
      look.copy(s.at);
      fov = 60;
    }
    // smooth the camera's offset from the subject, not its world position (no lag behind a fast nuke)
    _v3.subVectors(eye, this.specAnchor);
    if (!this.camSet) this.specOff.copy(_v3);
    else this.specOff.lerp(_v3, 1 - Math.exp(-dt / 0.25));
    this.camSet = true;
    this.camPos.copy(this.specAnchor).add(this.specOff);
    const gy = this.groundAt(this.camPos.x, this.camPos.z) + 2;
    if (this.camPos.y < gy) this.camPos.y = gy;
    cam.position.copy(this.camPos);
    _m.lookAt(this.camPos, look, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    this.setFov(fov, dt, first);
    cam.updateMatrixWorld();
  }

  /** Our FOV, smoothed on our own value (never read back from cam.fov), written every frame we have the camera. */
  private setFov(fov: number, dt: number, snap: boolean): void {
    const cam = this.ctx.engine.camera;
    this.camFov = snap ? fov : this.camFov + (fov - this.camFov) * (1 - Math.exp(-dt / 0.2));
    if (Math.abs(cam.fov - this.camFov) > 1e-4) {
      cam.fov = this.camFov;
      cam.updateProjectionMatrix();
    }
  }

  /** The small bar with the camera buttons (NUKE CAM / MISSILE CAM / HIT PLANE CAM / BACK). */
  private drawSpecBar(): void {
    const { ctx } = this;
    const s = this.spec;
    const offers = !s && !this.control && ctx.game.mode !== 'plane'; // flying: the dock buttons (FlightHud)
    const m = offers ? this.watchable() : null;
    const hp = offers ? this.hitWatchable() : null;
    const show = ctx.game.state === 'driving' && !ctx.replay.active && (!!s || !!m || !!hp);
    let key = '';
    if (show) {
      if (s) {
        const what = s.m ? (s.m.type.warhead === 'nuke' ? '☢ riding the nuke' : '🚀 riding the missile') : s.p ? `🎯 ${s.p.name.split(' · ')[0]}${s.p.down ? ' · down' : s.p.hit ? ' · going down' : ''}` : '💥 the blast';
        key = `s|${what}`;
      } else key = `a|${m ? m.type.warhead : ''}|${hp ? hp.id : ''}`;
    }
    if (key === this.specKey) return;
    this.specKey = key;
    if (!show) {
      this.specBar?.classList.remove('on');
      return;
    }
    if (!this.specBar) {
      const b = document.createElement('div');
      b.className = 'msl-spec';
      b.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest('button')?.dataset.a;
        if (!a) return;
        e.stopPropagation();
        if (a === 'back') this.spectate(null);
        else if (a === 'mcam') this.toast(this.spectate('missile'));
        else if (a === 'hcam') this.toast(this.spectate('hit'));
      });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      (document.getElementById('ui-root') ?? document.body).append(b);
      this.specBar = b;
    }
    const parts: string[] = [];
    if (s) {
      parts.push(`<span class="msl-spec-t">${key.slice(2)}</span>`);
      parts.push('<button class="msl-b msl-back" data-a="back">◀ BACK <kbd>K</kbd></button>');
    } else {
      if (m) parts.push(`<button class="msl-b msl-fire" data-a="mcam">${m.type.warhead === 'nuke' ? '☢ NUKE CAM' : '🚀 MISSILE CAM'} <kbd>K</kbd></button>`);
      if (hp) parts.push(`<button class="msl-b msl-lock" data-a="hcam">🎯 HIT PLANE CAM${m ? '' : ' <kbd>K</kbd>'}</button>`);
    }
    this.specBar.innerHTML = parts.join('');
    this.specBar.classList.toggle('offer', !s);
    this.specBar.classList.add('on');
  }

  /** AUTO LOCK (button / L): the turret swings onto the target, and any missile flying blind locks on now. */
  autoLock(): string {
    const c = this.control;
    if (!c) return '';
    this.autoAim();
    let n = 0;
    for (const m of this.missiles) if (!m.done && !m.target && !m.ground && m.seek === c.target) {
      m.target = c.target;
      n++;
    }
    return n ? `locked ${n} missile${n > 1 ? 's' : ''} in flight` : 'LOCKED — S fires, it will hit';
  }

  /** Point the control room's launcher straight at its target (agent / scripted shots). */
  autoAim(): void {
    const c = this.control;
    if (!c) return;
    const l = c.launcher;
    this.launchers.pivot(l, _v);
    _v2.subVectors(c.target.pos, _v);
    l.aimYaw = Math.atan2(_v2.x, _v2.z);
    l.aimPitch = clamp(Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z)), 0.02, 1.5);
  }

  private locked(c: Control): boolean {
    const l = c.launcher;
    this.launchers.pivot(l, _v);
    const d = _v2.subVectors(c.target.pos, _v).normalize();
    const a = this.aimDir(l, _v3);
    return a.dot(d) > Math.cos(CONFIG.missiles.lockCone);
  }

  private aimDir(l: Launcher, out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(l.aimPitch);
    return out.set(Math.sin(l.aimYaw) * cp, Math.sin(l.aimPitch), Math.cos(l.aimYaw) * cp);
  }

  private launch(l: Launcher, tube: number, target: SkyPlane | null, ground: THREE.Vector3 | null, u: number, v: number, controlled: boolean, delay: number): Missile {
    const { ctx } = this;
    const t = l.type;
    l.ready[tube] = false;
    l.reloadT[tube] = t.reload;
    l.loaded[tube].visible = false;
    const pos = new THREE.Vector3(), dir = new THREE.Vector3();
    this.launchers.tubeWorld(l, tube, pos, dir);
    pos.addScaledVector(dir, t.missileLen * 0.1);
    const obj = missileModel(t);
    obj.userData.noOriginShift = true;
    ctx.engine.scene.add(obj);
    const m: Missile = {
      obj, type: t, pos, prev: pos.clone(), dir, speed: 30, t: -delay, climb: 0, target, seek: target, ground,
      u, v, controlled, trail: null, done: false,
    };
    obj.position.copy(pos);
    obj.quaternion.setFromUnitVectors(Z, dir);
    obj.visible = delay <= 0;
    if (delay <= 0) this.ignite(m);
    this.missiles.push(m);
    return m;
  }

  private ignite(m: Missile): void {
    const { ctx } = this;
    const t = m.type;
    m.trail = ctx.fx.attachTrail?.(m.obj, new THREE.Vector3(0, 0, -t.missileLen * 0.5), { fire: 0.7, smoke: 0.5, size: Math.max(0.3, t.missileR * 2.2), cap: 2 }) ?? null;
    m.obj.add(this.flare(t));
    ctx.fx.smoke(m.pos, t.warhead === 'nuke' ? 3 : 1.2);
    if (this.clock - this.igniteT > 0.6) {
      this.igniteT = this.clock;
      ctx.fx.flash?.(m.pos.x, m.pos.y, m.pos.z, 18, 6, 40);
    }
  }

  /** The exhaust flare: an additive glow at the tail, always a few pixels big, brighter at night (user request). */
  private flare(t: LauncherType): THREE.Sprite {
    if (!this.flareMat) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d')!;
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,240,1)');
      grd.addColorStop(0.25, 'rgba(255,214,120,0.9)');
      grd.addColorStop(0.6, 'rgba(255,120,40,0.35)');
      grd.addColorStop(1, 'rgba(255,80,20,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.flareMat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true, toneMapped: false });
    }
    const s = new THREE.Sprite(this.flareMat);
    s.name = 'missile-flare';
    s.position.z = -t.missileLen * 0.55;
    s.renderOrder = 6;
    s.userData.base = Math.max(1.2, t.missileR * 6);
    return s;
  }

  // ───────────────────────────── target geometry ─────────────────────────────
  /** Aim point on the target in its root frame (u right wing / v nose) → world, plus the part it lands on. */
  private aimPoint(p: SkyPlane, u: number, v: number, out: THREE.Vector3): string {
    const vis = p.visual;
    const half = vis.dims;
    // root frame: nose +Z, LEFT = +X → u (right wing) = -X
    _v2.set(-u * half.span * 0.45, 0, v * half.length * 0.45);
    let best = vis.parts[0], bd = Infinity;
    for (const part of vis.parts) {
      if (part.kind === 'gear' || !part.object.parent) continue;
      const d = part.com.distanceToSquared(_v2) * (part.kind === 'engine' ? 1.6 : 1);
      if (d < bd) {
        bd = d;
        best = part;
      }
    }
    if (p.tracked.body && best.object.parent === vis.root) {
      vis.root.updateMatrixWorld(true);
      out.copy(_v2).applyMatrix4(vis.root.matrixWorld);
    } else {
      // split: the part itself (it rides its wreck piece)
      best.object.updateWorldMatrix(true, false);
      out.setFromMatrixPosition(best.object.matrixWorld);
    }
    return best.name;
  }

  private ramPoint(): THREE.Vector3 | null {
    if (this.ramId === null) return null;
    const p = this.traffic.planes.find((x) => x.id === this.ramId);
    const me = this.ctx.planes.state.position;
    if (!p || p.hit || this.ctx.planes.crashed || this.ctx.game.mode !== 'plane') {
      this.ramId = null;
      this.traffic.ramId = null;
      return null;
    }
    this.traffic.ramId = p.id;
    this.traffic.ramAlt = me.y;
    this.traffic.ramFrom.copy(me);
    const st = this.ctx.planes.state;
    const hr = (st.heading * Math.PI) / 180;
    this.traffic.ramVel.set(Math.sin(hr) * st.airspeed, st.verticalSpeed, -Math.cos(hr) * st.airspeed);
    const d = me.distanceTo(p.pos);
    // far: lead pursuit; close: straight at it (plus half a second of its motion)
    const tgo = d < 600 ? 0.5 : d / Math.max(60, this.ctx.planes.state.airspeed + 20);
    return this.traffic.lead(p, Math.min(tgo, 4), new THREE.Vector3());
  }

  // ───────────────────────────── simulation ─────────────────────────────
  fixedUpdate(dt: number): void {
    if (this.ctx.game.state !== 'driving') return;
    this.traffic.fixedUpdate(dt);
    for (const m of this.missiles) if (!m.done) this.fly(m, dt);
    if (this.missiles.some((m) => m.done && !m.obj.parent)) this.missiles = this.missiles.filter((m) => !(m.done && !m.obj.parent));
  }

  postStep(): void {
    this.traffic.postStep();
  }

  private fly(m: Missile, dt: number): void {
    m.t += dt;
    if (m.t < 0) return;
    if (!m.obj.visible) {
      m.obj.visible = true;
      this.ignite(m);
    }
    const t = m.type;
    m.speed = 30 + (t.speed - 30) * Math.min(1, m.t / t.boost) ** 1.3;
    m.prev.copy(m.pos);
    let tp: THREE.Vector3 | null = null;
    let part = '';
    if (!m.target && !m.ground && m.seek && !m.seek.hit && m.t > 0.4) {
      // fired without a lock: the seeker picks the plane up if it comes into its cone
      const to = _v2.subVectors(m.seek.pos, m.pos);
      const d = to.length();
      if (d < CONFIG.missiles.seekRange && to.normalize().dot(m.dir) > Math.cos(CONFIG.missiles.seekCone)) m.target = m.seek;
    }
    if (m.target) {
      tp = _v;
      part = this.aimPoint(m.target, m.u, m.v, tp);
    } else if (m.ground) tp = _v.copy(m.ground);
    if (!tp) {
      // unguided: straight on, a little gravity, self-destructs after a while (or on the ground)
      m.dir.y -= 0.01 * dt;
      m.dir.normalize();
      m.pos.addScaledVector(m.dir, m.speed * dt);
      if (m.t > CONFIG.missiles.unguidedS || (m.t > 1.2 && m.pos.y < this.groundAt(m.pos.x, m.pos.z) + 1)) this.detonate(m, m.pos, null, '');
      return;
    }
    const dist = tp.distanceTo(m.pos);
    if (m.climb > 0 && m.t < m.climb) {
      m.dir.lerp(UP, Math.min(1, dt * 2)).normalize();
    } else {
      // lead pursuit with a turn-rate limit; inside the terminal basket it flies straight at the aim point (never misses)
      const tgo = dist / Math.max(60, m.speed);
      const lead = _v2.copy(tp);
      if (m.target) lead.addScaledVector(m.target.vel, tgo * 0.9);
      const want = lead.sub(m.pos).normalize();
      if (dist < CONFIG.missiles.terminal) m.dir.copy(want);
      else {
        const maxTurn = (1.4 + 6 * clamp(1 - dist / 900, 0, 1)) * dt;
        const ang = m.dir.angleTo(want);
        if (ang <= maxTurn) m.dir.copy(want);
        else m.dir.lerp(want, maxTurn / ang).normalize();
      }
    }
    const step = m.speed * dt;
    if (dist <= Math.max(6, step * 1.2) || m.t > 45) {
      this.detonate(m, tp, m.target, part);
      return;
    }
    m.pos.addScaledVector(m.dir, step);
    // ground in the way (a low target): blow up there
    if (m.t > 1.5 && m.pos.y < this.groundAt(m.pos.x, m.pos.z) + 1) this.detonate(m, m.pos, null, '');
  }

  private groundAt(x: number, z: number): number {
    try {
      const g = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(g) ? g : 0;
    } catch {
      return 0;
    }
  }

  private detonate(m: Missile, at: THREE.Vector3, target: SkyPlane | null, part: string): void {
    const { ctx } = this;
    m.done = true;
    m.trail?.stop();
    m.obj.visible = false;
    const pos = at.clone();
    const t = m.type;
    m.obj.removeFromParent();
    if (t.warhead === 'nuke') {
      this.nukeBlast(pos);
    } else {
      const vel = target ? target.vel.clone() : new THREE.Vector3();
      const light = this.clock - this.boomT > 0.4; // a salvo hitting one after another: one light flash, not a strobe
      if (light) this.boomT = this.clock;
      ctx.fx.explosionEx?.({ position: pos, velocity: vel, radius: t.blast, kind: t.warhead === 'small' ? 'engine' : 'plane', light });
      ctx.events.emit('planeExplosion', { position: pos, velocity: vel, radius: t.blast, kind: 'missile' });
      if (target) this.hitPlane(target, pos, part, t.warhead);
    }
    const c = this.control;
    if (c && c.first === m) {
      c.phase = 'impact';
      c.impactAt.copy(pos);
      c.impactT = 0;
      this.camSet = false;
    }
    ctx.events.emit('vibrate', { pattern: [60, 30, 90] });
  }

  /** A warhead on a sky plane: the joints around the hit part break, it falls burning. */
  private hitPlane(p: SkyPlane, pos: THREE.Vector3, part: string, warhead: string): void {
    const { ctx } = this;
    if (!this.lastHit || this.lastHit.p !== p) this.lastHit = { p, t: this.clock };
    const vis = p.visual;
    const R = JOINT_R[warhead];
    // impact point in the root frame (intact) — or the part's rest position (split)
    const info = vis.partByName[part];
    const local = new THREE.Vector3();
    if (p.tracked.body) {
      vis.root.updateMatrixWorld(true);
      local.copy(pos).applyMatrix4(_m.copy(vis.root.matrixWorld).invert());
    } else if (info) local.copy(info.com);
    const ids = vis.joints
      .filter((j) => !p.tracked.brokenJoints.has(j.id) && (j.a === part || j.b === part || j.position.distanceTo(local) < R))
      .map((j) => j.id);
    this.traffic.markHit(p);
    try {
      if (warhead === 'nuke') ctx.breakup.explodeTotal(p.tracked);
      else if (ids.length) ctx.breakup.breakJoints(p.tracked, ids, { center: pos, energy: ENERGY[warhead], kind: 'impact' });
    } catch {
      /* already in pieces */
    }
    if (info?.kind === 'engine') {
      const n = parseInt(part.slice(6), 10);
      if (n > 0) vis.setEngineDamaged(n, true);
    }
    vis.setCharred(part, 0.9);
    if (info && ctx.fx.attachTrail) {
      const off = local.clone().sub(info.com);
      ctx.fx.attachTrail(info.object, off.clampLength(0, 3), { fire: 1, smoke: 1, size: clamp(vis.dims.span * 0.03, 0.6, 2.2) });
    }
  }

  private collide(p: SkyPlane, handle: number): void {
    if (p.hit) return;
    const col = this.ctx.physics.world.getCollider(handle);
    const part = (this.ctx.physics.tagOf(handle)?.data as { part?: string } | undefined)?.part ?? 'fuselageCenter';
    const at = col ? new THREE.Vector3().copy(col.translation() as THREE.Vector3Like) : p.pos.clone();
    this.ctx.fx.explosionEx?.({ position: at, velocity: p.vel.clone(), radius: 14, kind: 'impact', light: true });
    this.ctx.events.emit('planeExplosion', { position: at, velocity: p.vel.clone(), radius: 14, kind: 'secondary' });
    this.hitPlane(p, at, part, 'big');
    // and your plane: the joints near the contact break too
    const me = this.ctx.planes.currentTracked;
    const vis = me?.visual;
    if (me?.body && vis) {
      vis.root.updateMatrixWorld(true);
      const local = at.clone().applyMatrix4(_m.copy(vis.root.matrixWorld).invert());
      const ids = vis.joints.filter((j) => !me.brokenJoints.has(j.id) && j.position.distanceTo(local) < 10).map((j) => j.id);
      try {
        if (ids.length) this.ctx.breakup.breakJoints(me as TrackedPlane, ids, { center: at, energy: 3000, kind: 'impact' });
      } catch {
        /* already broken */
      }
    }
  }

  /** The nuke: a blinding flash, a fireball, a mushroom cloud and a shock wave through the sky and the ground. */
  private nukeBlast(pos: THREE.Vector3): void {
    const { ctx } = this;
    const N = CONFIG.missiles.nuke;
    ctx.fx.explosionEx?.({ position: pos.clone(), velocity: new THREE.Vector3(), radius: N.fireball, kind: 'plane', light: true });
    ctx.fx.flash?.(pos.x, pos.y, pos.z, 900, 0.6, N.skyRadius);
    ctx.events.emit('planeExplosion', { position: pos.clone(), velocity: new THREE.Vector3(), radius: N.fireball, kind: 'nuke' });
    ctx.events.emit('explosion', { position: pos.clone(), radius: N.groundRadius * 0.6, force: 3 });
    if (!this.hud) this.buildHud();
    this.flashT = 1;
    // the mushroom: a rising column of fireballs and smoke, a wide cap
    for (let k = 1; k <= 7; k++) {
      window.setTimeout(() => {
        const p = pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 40, k * N.fireball * 0.32, (Math.random() - 0.5) * 40));
        ctx.fx.explosionEx?.({ position: p, velocity: new THREE.Vector3(0, 30, 0), radius: N.fireball * (k === 7 ? 1.25 : 0.55), kind: 'secondary', light: k === 7 });
        ctx.fx.smoke(p, 3);
      }, k * 380);
    }
    // the shock wave: sky planes (and you) within reach break up, a moment later the further you are
    for (const p of this.traffic.planes) {
      const d = p.pos.distanceTo(pos);
      if (d > N.skyRadius || p.hit) continue;
      window.setTimeout(() => this.hitPlane(p, p.pos.clone(), 'fuselageCenter', d < N.skyRadius * 0.5 ? 'nuke' : 'big'), (d / 340) * 1000);
    }
    const me = this.ctx.planes.currentTracked;
    if (me?.body && this.ctx.game.mode === 'plane' && this.ctx.planes.state.position.distanceTo(pos) < N.skyRadius * 0.7) {
      window.setTimeout(() => {
        try {
          this.ctx.breakup.explodeTotal(me);
        } catch {
          /* gone */
        }
      }, (this.ctx.planes.state.position.distanceTo(pos) / 340) * 1000);
    }
    // the ground below: trees flattened
    const gy = this.groundAt(pos.x, pos.z);
    if (pos.y - gy < N.groundRadius) {
      const terrain = ctx.terrain as { blastTrees?: (c: THREE.Vector3, r: number) => number };
      terrain.blastTrees?.(new THREE.Vector3(pos.x, gy, pos.z), N.groundRadius * (1 - (pos.y - gy) / N.groundRadius));
    }
  }

  // ───────────────────────────── control room ─────────────────────────────
  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!this.control && down && !e.repeat && e.code === 'KeyK' && this.ctx.game.state === 'driving' && !this.ctx.replay.active) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (this.spec) this.spectate(null);
      else if (this.watchable()) this.toast(this.spectate('missile'));
      else if (this.hitWatchable()) this.toast(this.spectate('hit'));
      else return;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!this.control && this.spec && down && !e.repeat && (e.code === 'Escape' || e.code === 'KeyB')) {
      this.spectate(null);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!this.control) return;
    const k = e.code;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (!down || e.repeat) {
      if (['KeyS', 'Space', 'KeyF', 'KeyB', 'Escape'].includes(k)) e.preventDefault();
      return;
    }
    if (k === 'KeyS') this.say(this.fire());
    else if (k === 'Space') this.say(this.fire(0, { all: true }));
    else if (k === 'KeyF') this.toggleSpread();
    else if (k === 'KeyL') this.say(this.autoLock());
    else if (k === 'KeyB' || k === 'Escape') this.exitControl();
    else if (k === 'KeyC' && this.ctx.replay.canReplay) this.ctx.replay.start();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private toggleSpread(): void {
    const c = this.control;
    if (!c) return;
    c.spread = !c.spread;
    this.say(c.spread ? 'SPREAD: the rest hit different spots' : 'SAME SPOT: the rest follow your aim');
  }

  private say(text: string): void {
    if (!text) return;
    if (this.el.msg) {
      this.el.msg.textContent = text;
      this.msgT = 2.2;
    }
  }

  update(dt: number, alpha: number): void {
    const { ctx } = this;
    if (ctx.game.state !== 'driving') return;
    this.launchers.update(dt);
    this.traffic.update(dt, alpha);
    for (const m of this.missiles) {
      if (m.done) continue;
      m.obj.position.lerpVectors(m.prev, m.pos, alpha);
      m.obj.quaternion.setFromUnitVectors(Z, m.dir);
    }
    this.flashT = Math.max(0, this.flashT - dt * 0.7);
    if (this.el.flash) this.el.flash.style.opacity = String(this.flashT * this.flashT);
    this.clock += dt;
    this.updateSpec(dt);
    const c = this.control;
    if (c) {
      if (!this.traffic.planes.includes(c.target)) this.exitControl();
      else {
        this.input(c, dt);
        this.camera(c, dt);
        this.drawHud(c, dt);
      }
    }
    this.sizeFlares();
  }

  /**
   * The exhaust flares, sized for where the camera finally is this frame (after the control room / nuke cam moved it:
   * sized for the chase camera kilometres away, a flare filled the whole screen up close).
   */
  private sizeFlares(): void {
    const cam = this.ctx.engine.camera.position;
    const night = GLOBAL_UNIFORMS.uNight.value;
    for (const m of this.missiles) {
      if (m.done) continue;
      const fl = m.obj.getObjectByName('missile-flare') as THREE.Sprite | undefined;
      if (!fl) continue;
      const d = cam.distanceTo(m.obj.position);
      // the flare is for seeing it from far away; close up the fire trail shows it. It grows in between 80 and 200 m
      // (no on/off pop) and no longer jitters every frame (a big additive sprite jittering = the screen flickering)
      const fade = clamp((d - 80) / 120, 0, 1);
      fl.visible = fade > 0;
      const k = Math.max(fl.userData.base as number, d * 0.012) * (0.8 + 1.2 * night) * fade;
      fl.scale.set(k, k, 1);
    }
  }

  private input(c: Control, dt: number): void {
    const k = this.keys;
    const ax = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ay = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    const dx = this.dragD.x, dy = this.dragD.y;
    this.dragD.x = this.dragD.y = 0;
    if (c.phase === 'aim' || (c.phase === 'impact' && !c.first)) {
      const l = c.launcher;
      l.aimYaw -= ax * dt * 0.9 + dx * 0.004;
      l.aimPitch = clamp(l.aimPitch + ay * dt * 0.6 - dy * 0.004, 0.02, 1.5);
    } else if (c.phase === 'missile' && c.first?.target) {
      // locked on: steering only moves the hit point across the plane (the missile always hits)
      this.steer(c.u + ax * dt * 1.2 + dx * 0.006, c.v + ay * dt * 1.2 - dy * 0.006);
    } else if (c.phase === 'missile' && c.first) {
      // no lock: steer the missile itself toward the plane (its seeker locks once the plane is in front of it)
      const m = c.first;
      const right = _v3.crossVectors(m.dir, UP).normalize();
      m.dir.applyAxisAngle(UP, -(ax * dt * 0.9 + dx * 0.004)).applyAxisAngle(right, ay * dt * 0.7 - dy * 0.004).normalize();
    } else {
      // after the impact: aim again for the next shot
      const l = c.launcher;
      l.aimYaw -= ax * dt * 0.9 + dx * 0.004;
      l.aimPitch = clamp(l.aimPitch + ay * dt * 0.6 - dy * 0.004, 0.02, 1.5);
    }
  }

  private camera(c: Control, dt: number): void {
    const cam = this.ctx.engine.camera;
    const l = c.launcher;
    const eye = _v.set(0, 0, 0), look = _v2.set(0, 0, 0);
    const first = !this.camSet;
    let fov = 58;
    let anchor: THREE.Vector3 | null = null; // riding a moving object: only the offset from it is smoothed
    if (c.phase === 'missile' && c.first && !c.first.done) {
      const m = c.first;
      // the chase direction turns smoothly: the guidance's small corrections no longer swing the camera
      if (first || !this.camAnch) this.camDir.copy(m.dir);
      else this.camDir.lerp(m.dir, 1 - Math.exp(-dt / 0.25)).normalize();
      const md = this.camDir;
      // behind, above and a little to the side: never looking down its own smoke trail
      const back = m.type.missileLen * 2.6 + 12;
      const side = _v3.crossVectors(md, UP);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      side.normalize();
      anchor = m.obj.position;
      eye.copy(anchor).addScaledVector(md, -back).addScaledVector(UP, back * 0.35).addScaledVector(side, back * 0.22);
      // locked: keep the plane in frame; no lock: look where the missile goes (you steer it)
      if (m.target) look.copy(c.target.pos);
      else look.copy(anchor).addScaledVector(md, 400);
      fov = 55;
    } else if (c.phase === 'impact') {
      c.impactT += dt;
      // watch it go down: a little off the impact point, keeping the plane in frame
      const tp = c.target.pos;
      eye.copy(c.impactAt).addScaledVector(_v3.subVectors(c.impactAt, this.launchers.pivot(l, _v3)).normalize(), -c.target.visual.dims.length * 2.2).addScaledVector(UP, c.target.visual.dims.length * 0.6);
      look.copy(tp);
      const d = eye.distanceTo(look);
      fov = clamp((2 * Math.atan((c.target.visual.dims.span * 1.4) / Math.max(1, d)) * 180) / Math.PI, 10, 62);
      if (c.impactT > CONFIG.missiles.impactHold) {
        c.phase = 'aim';
        c.first = null;
        this.camSet = false;
      }
    } else {
      // the control room view: behind the launcher, along the aim
      // right behind the launcher along its aim, a little above the tubes: the rack at the bottom of the frame,
      // the reticle (screen centre) where it points
      const p = this.launchers.pivot(l, _v3);
      const dir = this.aimDir(l, new THREE.Vector3());
      const back = l.type.missileLen * 1.3 + 7;
      eye.copy(p).addScaledVector(dir, -back).addScaledVector(UP, 1.4 + back * 0.1);
      look.copy(p).addScaledVector(dir, 3000);
      fov = 55;
    }
    const gy = this.groundAt(eye.x, eye.z) + 1.5;
    if (eye.y < gy) eye.y = gy;
    if (anchor) {
      // a 500 m/s missile: smoothing the camera's world position left it 25–50 m behind, by an amount that changed
      // with every frame's length — the missile pumped back and forth on screen. Smooth the offset instead.
      _v4.subVectors(eye, anchor);
      if (first) this.camOff.copy(_v4);
      else if (!this.camAnch) this.camOff.subVectors(this.camPos, anchor); // carry on from where the camera is
      this.camOff.lerp(_v4, first ? 1 : 1 - Math.exp(-dt / 0.12));
      this.camPos.copy(anchor).add(this.camOff);
    } else if (first) this.camPos.copy(eye);
    else this.camPos.lerp(eye, 1 - Math.exp(-dt / 0.08));
    this.camAnch = !!anchor;
    const cy = this.groundAt(this.camPos.x, this.camPos.z) + 1.5;
    if (this.camPos.y < cy) this.camPos.y = cy;
    this.camSet = true;
    cam.position.copy(this.camPos);
    _m.lookAt(this.camPos, look, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    this.setFov(fov, dt, first);
    cam.updateMatrixWorld();
  }

  // ───────────────────────────── HUD ─────────────────────────────
  private showHud(on: boolean): void {
    if (on && !this.hud) this.buildHud();
    document.getElementById('ui-root')?.classList.toggle('msl-control', on);
    if (this.hud) this.hud.classList.toggle('on', on);
  }

  private buildHud(): void {
    const h = document.createElement('div');
    h.className = 'msl-hud';
    h.innerHTML = `
      <div class="msl-top"><b class="msl-site"></b><span class="msl-tgt"></span></div>
      <div class="msl-reticle"><i></i><i></i><i></i><i></i></div>
      <div class="msl-guide"></div>
      <div class="msl-mark"><div class="msl-ring"></div><div class="msl-mlabel"></div></div>
      <div class="msl-edge">➤</div>
      <div class="msl-state"></div>
      <div class="msl-part"></div>
      <div class="msl-msg"></div>
      <div class="msl-ammo"></div>
      <div class="msl-btns">
        <button class="msl-b msl-lock" data-a="lock">AUTO LOCK <kbd>L</kbd></button>
        <button class="msl-b msl-fire" data-a="fire">FIRE <kbd>S</kbd></button>
        <button class="msl-b msl-all" data-a="all">ALL <kbd>␣</kbd></button>
        <button class="msl-b msl-spread" data-a="spread">SPREAD <kbd>F</kbd></button>
        <button class="msl-b msl-replay" data-a="replay">REPLAY <kbd>C</kbd></button>
        <button class="msl-b msl-back" data-a="back">BACK <kbd>B</kbd></button>
      </div>
      <div class="msl-hint">aim: drag / A D W ↑ ↓ ← → · S fires · locked: the same keys pick WHERE it hits · no lock: they steer the missile</div>`;
    const flash = document.createElement('div');
    flash.className = 'msl-flash';
    (document.getElementById('ui-root') ?? document.body).append(h, flash);
    this.hud = h;
    const q = (s: string) => h.querySelector(s) as HTMLElement;
    this.el = {
      site: q('.msl-site'), tgt: q('.msl-tgt'), mark: q('.msl-mark'), mlabel: q('.msl-mlabel'), edge: q('.msl-edge'), state: q('.msl-state'),
      ring: q('.msl-ring'), ret: q('.msl-reticle'), guide: q('.msl-guide'),
      part: q('.msl-part'), msg: q('.msl-msg'), ammo: q('.msl-ammo'), all: q('.msl-all'), spread: q('.msl-spread'), replay: q('.msl-replay'), flash,
    };
    h.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (!a) return;
      e.stopPropagation();
      if (a === 'lock') this.say(this.autoLock());
      else if (a === 'fire') this.say(this.fire());
      else if (a === 'all') this.say(this.fire(0, { all: true }));
      else if (a === 'spread') this.toggleSpread();
      else if (a === 'replay' && this.ctx.replay.canReplay) this.ctx.replay.start();
      else if (a === 'back') this.exitControl();
    });
    h.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  private drawHud(c: Control, dt: number): void {
    const el = this.el;
    if (!el.site) return;
    const l = c.launcher;
    const p = c.target;
    const cam = this.ctx.engine.camera;
    const d = this.launchers.pivot(l, _v).distanceTo(p.pos);
    el.site.textContent = `${l.name} · ${l.type.name}`;
    el.tgt.textContent = `target: ${p.name} · ${(d / 1000).toFixed(1)} km · ${Math.round(p.pos.y)} m${p.hit ? ' · HIT' : ''}`;
    // the target box (from any distance): a square around the plane on screen, red = no lock, green = locked; off
    // screen an arrow at the edge. The reticle circle is the lock cone itself: box inside the circle = locked.
    const locked = this.locked(c);
    const aiming = c.phase === 'aim' || (c.phase === 'impact' && !c.first);
    const W = window.innerWidth, H = window.innerHeight;
    const tanH = Math.tan((cam.fov * Math.PI) / 360);
    const rPx = clamp((Math.tan(CONFIG.missiles.lockCone) / tanH) * (H / 2), 30, H * 0.45);
    el.ret.style.width = el.ret.style.height = `${Math.round(rPx * 2)}px`;
    this.hud?.style.setProperty('--rr', `${Math.round(rPx)}px`);
    el.ret.classList.toggle('lock', aiming && locked);
    el.ret.style.opacity = aiming ? '1' : '0.35';
    _v2.copy(p.pos).project(cam);
    const on = _v2.z < 1 && Math.abs(_v2.x) < 1 && Math.abs(_v2.y) < 1;
    if (on) {
      const sx = ((_v2.x + 1) / 2) * W, sy = ((1 - _v2.y) / 2) * H;
      const dc = Math.max(1, cam.position.distanceTo(p.pos));
      const box = clamp(((p.visual.dims.span * 1.25) / dc / tanH) * (H / 2), 30, 260);
      el.mark.style.display = 'block';
      el.edge.style.display = 'none';
      el.mark.style.transform = `translate(${sx}px, ${sy}px)`;
      el.ring.style.width = el.ring.style.height = `${Math.round(box)}px`;
      el.ring.style.left = el.ring.style.top = `${-Math.round(box / 2)}px`;
      el.mlabel.style.left = `${Math.round(box / 2) + 8}px`;
      el.mlabel.style.top = `${-Math.round(box / 2)}px`;
      el.mark.classList.toggle('lock', locked || !!c.first?.target);
      el.mlabel.textContent = `${locked && aiming ? 'LOCKED · ' : ''}${p.name.split(' · ')[0]} · ${(d / 1000).toFixed(1)} km`;
      // aiming without a lock: a dashed line from the reticle to the box (drag / steer along it)
      const gx = sx - W / 2, gy = sy - H / 2, gl = Math.hypot(gx, gy);
      if (aiming && !locked && gl > rPx + 4) {
        el.guide.style.display = 'block';
        el.guide.style.width = `${Math.round(gl - rPx - box / 2)}px`;
        el.guide.style.transform = `translate(${W / 2 + (gx / gl) * rPx}px, ${H / 2 + (gy / gl) * rPx}px) rotate(${Math.atan2(gy, gx)}rad)`;
      } else el.guide.style.display = 'none';
    } else {
      el.guide.style.display = 'none';
      el.mark.style.display = 'none';
      el.edge.style.display = 'block';
      let x = _v2.x, y = _v2.y;
      if (_v2.z > 1) {
        x = -x;
        y = -y;
      }
      const a = Math.atan2(-y, x);
      const r = Math.min(W, H) * 0.42;
      el.edge.style.transform = `translate(${W / 2 + Math.cos(a) * r}px, ${H / 2 + Math.sin(a) * r}px) rotate(${a}rad)`;
    }
    el.state.className = `msl-state ${c.phase === 'aim' ? (locked ? 'lock' : 'seek') : 'fly'}`;
    const guided = !!c.first?.target;
    el.state.textContent = c.phase === 'aim' ? (locked ? 'LOCKED — S fires, it will hit' : 'NO LOCK — bring the red box into the circle (or AUTO LOCK)') : c.phase === 'missile' ? (guided ? 'LOCKED ON — steer where it hits' : 'NO LOCK — flying straight, seeking…') : p.hit ? 'TARGET HIT' : 'MISSED';
    if (c.phase === 'missile' && c.first?.target) {
      const part = this.aimPoint(p, c.u, c.v, _v3);
      el.part.textContent = `HIT: ${partLabel(part)}`;
      el.part.style.display = 'block';
    } else el.part.style.display = 'none';
    el.ammo.innerHTML = l.ready.map((r, i) => `<i class="${r ? 'r' : ''}" style="--k:${r ? 1 : 1 - l.reloadT[i] / l.type.reload}"></i>`).join('');
    el.all.style.display = '';
    el.spread.style.display = l.type.kind === 'octo' ? '' : 'none';
    el.spread.classList.toggle('active', c.spread);
    el.replay.style.display = this.ctx.replay.canReplay ? '' : 'none';
    this.msgT -= dt;
    el.msg.style.opacity = this.msgT > 0 ? '1' : '0';
  }

  dispose(): void {
    this.exitControl();
    this.traffic.dispose();
    this.launchers.dispose();
    for (const m of this.missiles) m.obj.removeFromParent();
    this.hud?.remove();
  }
}
void LAUNCHER_TYPES;
void _q;
