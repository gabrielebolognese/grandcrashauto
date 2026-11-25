import * as THREE from 'three';
import { CONFIG } from '../config';
import { clamp } from '../core/math';
import type { GameEvents } from '../core/events';
import type { GameContext, IReplay } from '../game/contracts';
import type { PlaneVisual } from '../plane/types';

type EvKind = 'planeExplosion' | 'engineExplode' | 'planeImpact';
interface Frame {
  t: number;
  m: Float32Array; // world matrix per plane part
  a: Float32Array | null; // the on-foot character
  vs: Float32Array | null; // the plane's visual damage state (torn caps, interiors, charring, crush…)
  fc: number; // the fx clock (fires born later stay dormant in the replay)
  x: Float32Array | null; // extra objects (missiles): 17 floats each (world matrix + visible)
  // the other plane (user request: the replay shows the plane you rammed / crashed into too): a sky plane near you
  cv: PlaneVisual | null;
  cm: Float32Array | null; // its parts' world matrices
  cvs: Float32Array | null; // its visual damage state
}
interface RecEvent {
  t: number;
  kind: EvKind;
  data: Record<string, unknown>;
}
type Shot = 'Missile' | 'Chase' | 'Hit plane' | 'Side' | 'Ground' | 'Orbit' | 'Tail' | 'Top' | 'You';

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * CRASH REPLAY (user request): always records the last ~14 s of the flown plane — every part's world matrix (so split
 * pieces, tumbling wings and the falling cockpit are all in it), its visual damage state (torn edges, open cabins,
 * charring), the fx clock, the on-foot character and the explosion / impact events. After a crash (or any explosion)
 * REPLAY plays it back with the simulation frozen: parts are posed from the recording, the plane looks intact until
 * the moment it broke, fires appear only when they started (the fx rewind), explosions are re-fired (effects + sound),
 * slow motion around the big moments.
 * ONE camera per pass, complete (user request): chase → side spectator → ground spectator → orbit → tail → top
 * (→ you, when you were walking); each pass plays the whole clip from one camera, the next pass switches; NEXT CAM
 * switches and restarts the clip. No cockpit shot (that is a normal game view).
 */
export class Replay implements IReplay {
  readonly name = 'replay';
  active = false;
  speed = 1;
  private frames: Frame[] = [];
  private events: RecEvent[] = [];
  private visual: PlaneVisual | null = null;
  private recT = 0;
  private acc = 0;
  private hadEvent = false;
  // playback
  private t = 0;
  private t0 = 0;
  private t1 = 0;
  private fi = 0;
  private evIdx = 0;
  private shots: Shot[] = [];
  private shot = 0;
  private saved: { obj: THREE.Object3D; inv: THREE.Matrix4; i: number }[] = [];
  private keyEvents: RecEvent[] = [];
  private camSaved: { fov: number; near: number } | null = null;
  private liveState: Float32Array | null = null;
  private appliedVs: Float32Array | null = null;
  private anchor = new THREE.Vector3();
  private orbitA = 0;
  private subj = new THREE.Vector3();
  private subjVel = new THREE.Vector3();
  private chaseDir = new THREE.Vector3(0, 0, 1);
  private camPos = new THREE.Vector3();
  private camSet = false;
  private size = 30;
  private subjIdx = 0;

  constructor(private ctx: GameContext) {}

  init(): void {
    const ev = this.ctx.events;
    const rec = (kind: EvKind) => (e: GameEvents[EvKind]) => {
      if ((e as { replay?: boolean }).replay || this.active) return;
      const data: Record<string, unknown> = { ...e };
      for (const k of Object.keys(data)) if ((data[k] as THREE.Vector3)?.isVector3) data[k] = (data[k] as THREE.Vector3).clone();
      this.events.push({ t: this.recT, kind, data });
      if (kind !== 'planeImpact' || (e as GameEvents['planeImpact']).outcome !== 'landing') this.hadEvent = true;
    };
    ev.on('planeExplosion', rec('planeExplosion'));
    ev.on('engineExplode', rec('engineExplode'));
    ev.on('planeImpact', rec('planeImpact'));
    ev.on('planeSpawned', () => {
      if (this.active) this.stop();
      this.clear();
      this.watchVisual = null;
      this.extras = [];
    });
    ev.on('modeChanged', ({ mode }) => {
      if (mode !== 'plane' && !this.watchVisual) {
        if (this.active) this.stop();
        this.clear();
      }
    });
    ev.on('originShift', ({ delta }) => {
      for (const f of this.frames) {
        for (let o = 0; o < f.m.length; o += 16) {
          f.m[o + 12] -= delta.x;
          f.m[o + 14] -= delta.z;
        }
        if (f.a) {
          f.a[12] -= delta.x;
          f.a[14] -= delta.z;
        }
        if (f.cm) for (let o = 0; o < f.cm.length; o += 16) {
          f.cm[o + 12] -= delta.x;
          f.cm[o + 14] -= delta.z;
        }
        if (f.x) for (let o = 0; o < f.x.length; o += 17) {
          // the missiles (they were never shifted: after a shift they replayed 2 km off)
          f.x[o + 12] -= delta.x;
          f.x[o + 14] -= delta.z;
        }
      }
      if (this.active) {
        // playing: the planes' parents (roots / wreck pieces) just moved by -delta with the world, and the recorded
        // matrices too — the saved parent inverses must follow, or every pose lands one shift (~2 km) off and the
        // cameras film empty sky (the streaming focus follows the replayed plane, so a pass usually shifts once)
        for (const s of this.saved.concat(this.coSaved)) {
          const p = s.obj.parent;
          if (!p) continue;
          p.updateWorldMatrix(true, false);
          s.inv.copy(p.matrixWorld).invert();
        }
      }
      for (const e of this.events) {
        const p = e.data.position as THREE.Vector3 | undefined;
        if (p?.isVector3) p.sub(delta);
      }
      this.anchor.sub(delta);
      this.camPos.sub(delta);
    });
  }

  private clear(): void {
    this.frames = [];
    this.events = [];
    this.visual = null;
    this.recT = 0;
    this.hadEvent = false;
    this.extras = [];
    this.watchT = -1;
  }

  // a sky plane your missiles fly at (src/missiles), with the missiles. Flying, YOUR plane stays the recorded subject
  // and this plane is recorded beside it (the co track): a crash of yours afterwards replays your plane, not the one
  // you shot down (user report). In the car it is the subject itself.
  private watchVisual: PlaneVisual | null = null;
  private extras: THREE.Object3D[] = [];
  private extrasAdded: THREE.Object3D[] = [];
  private watchT = -1; // recording time of the last shot at it
  // playback: the cameras follow the co track (the plane you shot) instead of the subject (your plane, flying on)
  private camCo = false;

  /** Record another plane (+ extra objects: the missiles) from now on, next to yours (or instead, in the car). */
  watch(visual: PlaneVisual, extra: THREE.Object3D[]): void {
    if (this.active) this.stop();
    const flying = this.ctx.game.mode === 'plane' && !!this.ctx.planes.active;
    if (visual !== this.watchVisual) {
      if (!flying) this.clear();
      this.watchVisual = visual;
      if (!flying) this.visual = visual;
    }
    // keep the indices of the missiles already recorded (each frame stores them in this order)
    for (const o of extra) if (!this.extras.includes(o)) this.extras.push(o);
    this.watchT = this.recT;
  }

  addExtra(obj: THREE.Object3D): void {
    if (this.watchVisual && !this.extras.includes(obj)) this.extras.push(obj);
  }

  get canReplay(): boolean {
    const p = this.ctx.planes;
    return !this.active && this.frames.length > 45 && (p.crashed || this.hadEvent) && this.ctx.game.state === 'driving';
  }

  get camName(): string {
    return this.shots[this.shot] ?? '';
  }

  /** While replaying: the replayed plane (the world streams around it, not around the wreck). */
  get focus(): THREE.Vector3 | null {
    return this.active ? this.subj : null;
  }

  // ───────────────────────────── recording ─────────────────────────────
  update(dt: number): void {
    if (this.active) return;
    const { ctx } = this;
    const planes = ctx.planes;
    if (ctx.game.state !== 'driving') return;
    const subject = (ctx.game.mode === 'plane' && planes.active ? planes.visual : null) ?? this.watchVisual;
    if (!subject) return;
    if (subject !== this.visual) {
      this.clear();
      this.visual = subject;
    }
    this.recT += dt;
    this.acc += dt;
    if (this.acc < 1 / CONFIG.replay.hz) return;
    this.acc = 0;
    const parts = this.visual.parts;
    const R = CONFIG.replay;
    // reuse the oldest frame's buffers once the window is full
    let f: Frame | null = null;
    if (this.frames.length && this.recT - this.frames[0].t > R.seconds) f = this.frames.shift()!;
    const m = f && f.m.length === parts.length * 16 ? f.m : new Float32Array(parts.length * 16);
    for (let i = 0; i < parts.length; i++) {
      const o = parts[i].object;
      o.updateWorldMatrix(true, false);
      m.set(o.matrixWorld.elements, i * 16);
    }
    let a: Float32Array | null = null;
    const av = ctx.walker.active ? (ctx.walker as unknown as { avatar?: { object?: THREE.InstancedMesh } }).avatar?.object : null;
    if (av) {
      a = f?.a ?? new Float32Array(16);
      av.getMatrixAt(0, _m);
      a.set(_m.elements);
    }
    const vs = this.visual.captureState?.(f?.vs) ?? null;
    let x: Float32Array | null = null;
    if (this.extras.length) {
      x = f?.x && f.x.length === this.extras.length * 17 ? f.x : new Float32Array(this.extras.length * 17);
      this.extras.forEach((o, i) => {
        o.updateWorldMatrix(true, false);
        x!.set(o.matrixWorld.elements, i * 17);
        x![i * 17 + 16] = o.visible && !!o.parent ? 1 : 0;
      });
    }
    let cv: PlaneVisual | null = null, cm: Float32Array | null = null, cvs: Float32Array | null = null;
    {
      // the other plane: the one you shot at, else the ram target / the plane you hit / the nearest
      // (the ram target, else the plane you hit last, else the one you shot at in the last minute, else the nearest)
      const shotAt = this.watchVisual && this.recT - this.watchT < 60 ? this.watchVisual : null;
      cv = (ctx.missiles as { coSubject?: (fallback?: PlaneVisual | null) => PlaneVisual | null } | undefined)?.coSubject?.(shotAt) ?? shotAt;
      if (cv && cv !== this.visual) {
        const cp = cv.parts;
        const same = f?.cv === cv;
        cm = same && f!.cm && f!.cm.length === cp.length * 16 ? f!.cm : new Float32Array(cp.length * 16);
        for (let i = 0; i < cp.length; i++) {
          const o = cp[i].object;
          o.updateWorldMatrix(true, false);
          cm.set(o.matrixWorld.elements, i * 16);
        }
        cvs = cv.captureState?.(same ? f!.cvs : null) ?? null;
      } else cv = null;
    }
    this.frames.push({ t: this.recT, m, a, vs, fc: ctx.fx.clock ?? 0, x, cv, cm, cvs });
    while (this.events.length && this.recT - this.events[0].t > R.seconds + 1) this.events.shift();
  }

  // ───────────────────────────── playback ─────────────────────────────
  start(): void {
    if (!this.canReplay || !this.visual) return;
    const { ctx } = this;
    this.active = true;
    document.getElementById('ui-root')?.classList.add('replaying');
    const last = this.frames[this.frames.length - 1].t;
    this.t1 = last + 1.2;
    this.t0 = Math.max(this.frames[0].t, last - CONFIG.replay.seconds);
    this.saved = [];
    this.visual.parts.forEach((p, i) => {
      const o = p.object;
      if (!this.inScene(o) || !o.parent) return;
      o.parent.updateWorldMatrix(true, false);
      this.saved.push({ obj: o, inv: new THREE.Matrix4().copy(o.parent.matrixWorld).invert(), i });
      o.matrixAutoUpdate = false;
    });
    this.liveState = this.visual.captureState?.() ?? null;
    // the other plane: the one recorded last (the plane you hit), posed from its own frames
    this.co = null;
    this.coSaved = [];
    for (let i = this.frames.length - 1; i >= 0 && !this.co; i--) this.co = this.frames[i].cv;
    if (this.co) {
      this.co.parts.forEach((p, i) => {
        const o = p.object;
        if (!this.inScene(o) || !o.parent) return;
        o.parent.updateWorldMatrix(true, false);
        this.coSaved.push({ obj: o, inv: new THREE.Matrix4().copy(o.parent.matrixWorld).invert(), i });
        o.matrixAutoUpdate = false;
      });
      this.coLive = this.co.captureState?.() ?? null;
      this.coVs = null;
      this.coA = this.coB = null;
      const ci = this.co.parts.findIndex((p) => p.name === 'fuselageCenter');
      this.coIdx = ci >= 0 ? ci : 0;
    }
    (ctx.walker as unknown as { setHandVisible?: (on: boolean) => void }).setHandVisible?.(false);
    this.appliedVs = null;
    const idx = this.visual.parts.findIndex((p) => p.name === 'fuselageCenter');
    this.subjIdx = idx >= 0 ? idx : 0;
    // whose story: your own crash (or an engine you blew after the shot) = your plane, with a pass on the other one;
    // a missile kill while you fly on (the control room's REPLAY) = the plane you shot down, from the missile
    const planes = ctx.planes;
    const own = ctx.game.mode === 'plane' && this.visual === planes.visual;
    const ownLast = this.events.reduce((t, e) => (e.kind === 'engineExplode' ? Math.max(t, e.t) : t), -1);
    this.camCo = own && !!this.co && this.co === this.watchVisual && this.coSaved.length > 0 && !planes.crashed && ownLast < this.watchT;
    const missileStory = this.camCo || (!!this.watchVisual && this.visual === this.watchVisual);
    // start a few seconds before the first big moment if there is one; slow motion only around the main moments
    // (engine blasts, the split / tail / total explosion, the first hard impact) — not every secondary pop, and only
    // what happened to the plane the cameras follow (your crash: not the missiles that hit another plane km away)
    const followed = this.camCo && this.co ? this.co : this.visual;
    const nearR = Math.max(300, clamp(followed.dims.length, 10, 75) * 5);
    const near = (e: RecEvent): boolean => {
      const p = e.data.position as THREE.Vector3 | undefined;
      return !p?.isVector3 || p.distanceTo(this.subjectAt(e.t, _v)) < nearR;
    };
    let impact = false;
    this.keyEvents = this.events.filter((e) => {
      if (!near(e)) return false;
      if (e.kind === 'engineExplode') return true;
      if (e.kind === 'planeExplosion') return (e.data.kind as string) !== 'secondary';
      if ((e.data.outcome as string) === 'landing' || impact) return false;
      impact = true;
      return true;
    });
    const first = this.keyEvents.find((e) => e.t >= this.t0);
    if (first) this.t0 = Math.max(this.t0, first.t - CONFIG.replay.leadIn);
    this.subjectAt(this.t0, this.subj); // the streaming focus is valid from the first frame
    this.shots = missileStory && this.extras.length ? ['Missile', 'Chase'] : ['Chase'];
    if (!this.camCo && this.co && this.coSaved.length) this.shots.push('Hit plane'); // a whole pass on the plane you rammed / shot
    // the missiles (removed from the scene after their impact) come back for the replay
    this.extrasAdded = [];
    for (const o of this.extras) {
      o.matrixAutoUpdate = false;
      if (!o.parent) {
        ctx.engine.scene.add(o);
        this.extrasAdded.push(o);
      }
    }
    if (!this.camCo && this.frames.some((f) => f.a)) this.shots.push('You');
    this.shots.push('Side', 'Ground', 'Orbit');
    const cv = this.camCo && this.co ? this.co : this.visual;
    if (cv.partByName.fin || cv.partByName.tailCone) this.shots.push('Tail');
    this.shots.push('Top');
    this.shot = 0;
    this.size = clamp(cv.dims.length, 10, 75);
    const cam = ctx.engine.camera;
    this.camSaved = { fov: cam.fov, near: cam.near };
    this.restart();
    ctx.events.emit('toast', { text: '🎬 Replay — NEXT CAM for another angle', ms: 1800 });
  }

  restart(): void {
    this.t = this.t0;
    this.fi = 0;
    this.evIdx = this.events.findIndex((e) => e.t >= this.t0);
    if (this.evIdx < 0) this.evIdx = this.events.length;
    this.camSet = false;
    this.orbitA = 0;
    this.placeAnchor();
    // fx rewind: everything that happened after the start of the clip goes (and the previous pass's re-fired blasts)
    if (this.active) this.ctx.fx.replayClock?.(this.fcAt(this.t0), true);
  }

  /** Next camera: the clip starts again from the beginning, complete, from the new angle. */
  nextCam(): void {
    if (!this.active) return;
    this.shot = (this.shot + 1) % this.shots.length;
    this.restart();
  }

  stop(): void {
    if (!this.active) return;
    const { ctx } = this;
    this.active = false;
    document.getElementById('ui-root')?.classList.remove('replaying');
    for (const s of this.saved) {
      s.obj.matrixAutoUpdate = true;
      s.obj.updateMatrix();
    }
    this.saved = [];
    for (const s of this.coSaved) {
      s.obj.matrixAutoUpdate = true;
      s.obj.updateMatrix();
    }
    this.coSaved = [];
    if (this.co && this.coLive && this.co.applyState) this.co.applyState(this.coLive);
    this.co = null;
    this.coLive = null;
    this.camCo = false;
    for (const o of this.extras) o.matrixAutoUpdate = true;
    for (const o of this.extrasAdded) o.removeFromParent();
    this.extrasAdded = [];
    if (this.liveState && this.visual?.applyState) this.visual.applyState(this.liveState);
    this.liveState = null;
    this.appliedVs = null;
    ctx.fx.replayClock?.(null);
    const av = (ctx.walker as unknown as { avatar?: { object?: THREE.Object3D } }).avatar?.object;
    if (av && !ctx.walker.active) av.visible = false;
    const cam = ctx.engine.camera;
    if (this.camSaved) {
      cam.fov = this.camSaved.fov;
      cam.near = this.camSaved.near;
      cam.updateProjectionMatrix();
      this.camSaved = null;
    }
    try {
      ctx.cameraRig.snap();
    } catch {
      /* ignore */
    }
  }

  private inScene(o: THREE.Object3D): boolean {
    let p: THREE.Object3D | null = o;
    while (p) {
      if (p === this.ctx.engine.scene) return true;
      p = p.parent;
    }
    return false;
  }

  /** Per frame while replaying (the simulation is frozen by Game). */
  play(realDt: number): void {
    if (!this.active || !this.frames.length) return;
    const R = CONFIG.replay;
    // slow motion around the big moments
    let slow = 1;
    for (const e of this.keyEvents) {
      const d = Math.abs(this.t - e.t);
      if (d < R.slowWindow) slow = Math.min(slow, R.slowSpeed + (1 - R.slowSpeed) * (d / R.slowWindow) ** 2);
    }
    this.speed = slow;
    this.t += realDt * slow;
    if (this.t > this.t1) {
      // the pass is complete: play it again from the next camera
      this.shot = (this.shot + 1) % this.shots.length;
      this.restart();
    }
    // frame pair around t
    const F = this.frames;
    while (this.fi < F.length - 2 && F[this.fi + 1].t < this.t) this.fi++;
    while (this.fi > 0 && F[this.fi].t > this.t) this.fi--;
    const a = F[this.fi], b = F[Math.min(F.length - 1, this.fi + 1)];
    const u = b.t > a.t ? clamp((this.t - a.t) / (b.t - a.t), 0, 1) : 0;
    for (const s of this.saved) {
      const o = s.i * 16;
      if (o + 16 > a.m.length || o + 16 > b.m.length) continue;
      this.lerpMat(a.m, b.m, o, u, _m);
      s.obj.matrix.multiplyMatrices(s.inv, _m);
      s.obj.matrixWorldNeedsUpdate = true;
    }
    // the plane looks the way it did then (intact until it broke, no charring before the fire…)
    const vs = u < 0.5 ? a.vs : b.vs;
    if (vs && vs !== this.appliedVs && this.visual?.applyState) {
      this.visual.applyState(vs);
      this.appliedVs = vs;
    }
    this.ctx.fx.replayClock?.(a.fc + (b.fc - a.fc) * u);
    this.playCo(a, b, u);
    // the missiles
    if (a.x && b.x) {
      const n = Math.min(this.extras.length, a.x.length / 17, b.x.length / 17);
      for (let i = 0; i < n; i++) {
        const o = this.extras[i];
        const vis = (u < 0.5 ? a.x : b.x)[i * 17 + 16] > 0.5;
        o.visible = vis;
        if (!vis) continue;
        const A = a.x.subarray(i * 17, i * 17 + 16), B = b.x.subarray(i * 17, i * 17 + 16);
        this.lerpMat(A, B, 0, u, _m);
        o.matrix.copy(_m);
        o.matrixWorldNeedsUpdate = true;
      }
    }
    // the character
    const avatar = (this.ctx.walker as unknown as { avatar?: { object?: THREE.InstancedMesh; play?: (c: string, f?: number) => void; update?: (dt: number) => void } }).avatar;
    if (avatar?.object) {
      if (a.a && b.a) {
        this.lerpMat(a.a, b.a, 0, u, _m);
        avatar.object.setMatrixAt(0, _m);
        avatar.object.instanceMatrix.needsUpdate = true;
        avatar.object.visible = true;
        _p2.set(b.a[12] - a.a[12], b.a[13] - a.a[13], b.a[14] - a.a[14]);
        avatar.play?.(_p2.length() * CONFIG.replay.hz > 4 ? 'tumble' : 'idle', 0.2);
        avatar.update?.(realDt * slow);
      } else avatar.object.visible = false;
    }
    // re-fire the recorded explosions / impacts (fx + sound only)
    while (this.evIdx < this.events.length && this.events[this.evIdx].t <= this.t) {
      const e = this.events[this.evIdx++];
      const data: Record<string, unknown> = { ...e.data, replay: true };
      for (const k of Object.keys(data)) if ((data[k] as THREE.Vector3)?.isVector3) data[k] = (data[k] as THREE.Vector3).clone();
      this.ctx.events.emit(e.kind, data as never);
    }
    this.updateSubject(a, b, u, realDt);
    this.direct(realDt);
  }

  private co: PlaneVisual | null = null;
  private coSaved: { obj: THREE.Object3D; inv: THREE.Matrix4; i: number }[] = [];
  private coLive: Float32Array | null = null;
  private coVs: Float32Array | null = null;
  private coA: Frame | null = null;
  private coB: Frame | null = null;
  private coK = 0;
  private coIdx = 0;

  /** The other plane at this moment (before it was first recorded: where it was then). */
  private playCo(a: Frame, b: Frame, u: number): void {
    const co = this.co;
    if (!co || !this.coSaved.length) return;
    let A = a.cv === co ? a : null, B = b.cv === co ? b : null;
    if (!A && !B) {
      // not recorded yet at this time: hold it at its first recorded pose
      const first = this.frames.find((f) => f.cv === co && f.t >= a.t);
      if (!first) return;
      A = B = first;
    }
    if (!A) A = B;
    if (!B) B = A;
    const k = A === B ? 0 : u;
    this.coA = A;
    this.coB = B;
    this.coK = k;
    for (const s of this.coSaved) {
      const o = s.i * 16;
      if (!A!.cm || !B!.cm || o + 16 > A!.cm.length || o + 16 > B!.cm.length) continue;
      this.lerpMat(A!.cm, B!.cm, o, k, _m);
      s.obj.matrix.multiplyMatrices(s.inv, _m);
      s.obj.matrixWorldNeedsUpdate = true;
    }
    const vs = k < 0.5 ? A!.cvs : B!.cvs;
    if (vs && vs !== this.coVs && co.applyState) {
      co.applyState(vs);
      this.coVs = vs;
    }
  }

  private fcAt(t: number): number {
    const F = this.frames;
    if (!F.length) return this.ctx.fx.clock ?? 0;
    let i = 0;
    while (i < F.length - 2 && F[i + 1].t < t) i++;
    const a = F[i], b = F[Math.min(F.length - 1, i + 1)];
    const u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
    return a.fc + (b.fc - a.fc) * u;
  }

  /** The camera subject (centre fuselage) at recording time t. */
  private subjectAt(t: number, out: THREE.Vector3): THREE.Vector3 {
    const F = this.frames;
    let i = 0;
    while (i < F.length - 2 && F[i + 1].t < t) i++;
    const a = F[i], b = F[Math.min(F.length - 1, i + 1)];
    const u = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
    const okA = this.trackPos(a, out), okB = this.trackPos(b, _s2);
    if (okA && okB) return out.lerp(_s2, u);
    if (okB) return out.copy(_s2);
    if (okA) return out;
    // the other plane before it was first recorded: where it was first seen
    for (const f of F) if (f.t >= t && this.trackPos(f, out)) return out;
    return out.set(0, 0, 0);
  }

  /** The followed plane's centre in a frame: yours (subject track) or the one you shot (co track, camCo). */
  private trackPos(f: Frame, out: THREE.Vector3): boolean {
    if (this.camCo) {
      const c = this.coIdx * 16;
      if (f.cv !== this.co || !f.cm || c + 16 > f.cm.length) return false;
      out.set(f.cm[c + 12], f.cm[c + 13], f.cm[c + 14]);
      return true;
    }
    const o = this.subjIdx * 16;
    if (o + 16 > f.m.length) return false;
    out.set(f.m[o + 12], f.m[o + 13], f.m[o + 14]);
    return true;
  }

  /** Fixed spectator positions for this pass (side: by the big moment; ground: by where it all ended). */
  private placeAnchor(): void {
    const shot = this.shots[this.shot];
    if (shot !== 'Side' && shot !== 'Ground') return;
    const S = this.size;
    const key = this.keyEvents.find((e) => e.t >= this.t0);
    const tk = shot === 'Side' ? (key ? key.t : (this.t0 + this.t1) / 2) : this.frames[this.frames.length - 1].t;
    const at = this.subjectAt(tk, new THREE.Vector3());
    const before = this.subjectAt(Math.max(this.t0, tk - 1.5), new THREE.Vector3());
    const dir = at.clone().sub(before).setY(0);
    if (dir.lengthSq() < 1) dir.set(0, 0, 1);
    dir.normalize();
    const side = new THREE.Vector3().crossVectors(dir, UP).normalize();
    if (shot === 'Side') {
      // beside the path where the big moment happens, a little ahead and above
      this.anchor.copy(at).addScaledVector(dir, S * 0.8).addScaledVector(side, S * 2 + 40).addScaledVector(UP, S * 0.25 + 6);
      const gy = this.ground(this.anchor.x, this.anchor.z) + 2;
      if (this.anchor.y < gy) this.anchor.y = gy;
    } else {
      // a spectator standing on the ground off to the side of the crash site
      this.anchor.copy(at).addScaledVector(side, -(S * 2.5 + 70)).addScaledVector(dir, -S);
      this.anchor.y = this.ground(this.anchor.x, this.anchor.z) + 1.7;
    }
  }

  private lerpMat(A: Float32Array, B: Float32Array, o: number, u: number, out: THREE.Matrix4): void {
    _m2.fromArray(A, o).decompose(_p, _q, _s);
    out.fromArray(B, o).decompose(_p2, _q2, _s2);
    _p.lerp(_p2, u);
    _q.slerp(_q2, u);
    _s.lerp(_s2, u);
    out.compose(_p, _q, _s);
  }

  /** What the cameras look at: the centre fuselage (else the first part), velocity from the recording. */
  private updateSubject(a: Frame, b: Frame, u: number, realDt: number): void {
    const o = this.subjIdx * 16;
    if ((this.camCo || this.shots[this.shot] === 'Hit plane') && this.coA?.cm && this.coB?.cm) {
      const c = this.coIdx * 16;
      _p.set(this.coA.cm[c + 12], this.coA.cm[c + 13], this.coA.cm[c + 14]);
      _p2.set(this.coB.cm[c + 12], this.coB.cm[c + 13], this.coB.cm[c + 14]);
      u = this.coK;
      if (this.coA !== this.coB) {
        a = this.coA;
        b = this.coB;
      }
    } else {
      _p.set(a.m[o + 12], a.m[o + 13], a.m[o + 14]);
      _p2.set(b.m[o + 12], b.m[o + 13], b.m[o + 14]);
    }
    this.subj.copy(_p).lerp(_p2, u);
    const dt = Math.max(1e-3, b.t - a.t);
    _v.subVectors(_p2, _p).divideScalar(dt);
    if (_v.lengthSq() > 0.01) this.subjVel.lerp(_v, 0.25);
    // the chase direction turns slowly (a tumbling piece does not whip the camera around)
    _v.copy(this.subjVel).setY(this.subjVel.y * 0.5);
    if (_v.lengthSq() > 4) {
      _v.normalize();
      this.chaseDir.lerp(_v, 1 - Math.exp(-realDt * 1.5)).normalize();
    }
  }

  private partPos(name: string, out: THREE.Vector3): THREE.Vector3 | null {
    const p = (this.camCo && this.co ? this.co : this.visual)?.partByName[name];
    if (!p) return null;
    p.object.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(p.object.matrixWorld);
  }

  private ground(x: number, z: number): number {
    try {
      const g = this.ctx.world.groundHeightAt(x, z);
      return Number.isFinite(g) ? Math.max(g, 0) : 0;
    } catch {
      return 0;
    }
  }

  private direct(realDt: number): void {
    const { ctx } = this;
    const cam = ctx.engine.camera;
    const shot = this.shots[this.shot];
    const S = shot === 'Hit plane' && this.co ? clamp(this.co.dims.length, 10, 75) : this.size;
    const subj = this.subj;
    const eye = _p.copy(subj);
    const look = _p2.copy(subj);
    let fov = 55;
    let smooth = 0; // seconds of position smoothing (0 = locked)
    switch (shot) {
      case 'Chase':
      case 'Hit plane':
        eye.addScaledVector(this.chaseDir, -S * 1.5).addScaledVector(UP, S * 0.35);
        smooth = 0.25;
        break;
      case 'Missile': {
        // behind the first missile still flying, looking at the plane; after the impacts: a chase of the wreck
        const f0 = this.frames[this.fi], f1 = this.frames[Math.min(this.frames.length - 1, this.fi + 1)];
        let k = -1;
        if (f0?.x && f1?.x) for (let i = 0; i < f0.x.length / 17; i++) if (f0.x[i * 17 + 16] > 0.5 && f1.x[i * 17 + 16] > 0.5) {
          k = i;
          break;
        }
        if (k >= 0 && f0.x && f1.x) {
          const mp = _s.set(f1.x[k * 17 + 12], f1.x[k * 17 + 13], f1.x[k * 17 + 14]);
          const md = _s2.set(mp.x - f0.x[k * 17 + 12], mp.y - f0.x[k * 17 + 13], mp.z - f0.x[k * 17 + 14]);
          if (md.lengthSq() < 1e-6) md.copy(this.chaseDir);
          md.normalize();
          eye.copy(mp).addScaledVector(md, -14).addScaledVector(UP, 3);
          const d = eye.distanceTo(subj);
          fov = clamp((2 * Math.atan((S * 1.2) / Math.max(1, d)) * 180) / Math.PI, 10, 62);
          smooth = 0.06;
        } else {
          eye.addScaledVector(this.chaseDir, -S * 1.8).addScaledVector(UP, S * 0.5);
          smooth = 0.3;
        }
        break;
      }
      case 'Side':
      case 'Ground': {
        eye.copy(this.anchor);
        // long lens: keep the plane a good size in frame however far it is
        const d = eye.distanceTo(subj);
        fov = clamp((2 * Math.atan((S * 0.9) / Math.max(1, d)) * 180) / Math.PI, 3, shot === 'Ground' ? 50 : 58);
        break;
      }
      case 'Orbit':
        this.orbitA += realDt * 0.35;
        eye.set(subj.x + Math.cos(this.orbitA) * S * 1.6, subj.y + S * 0.45, subj.z + Math.sin(this.orbitA) * S * 1.6);
        smooth = 0.15;
        break;
      case 'Tail': {
        const tp = this.partPos('fin', _s) ?? this.partPos('tailCone', _s);
        const cp = this.partPos('cockpit', _s2);
        if (tp && cp) {
          eye.copy(tp).addScaledVector(UP, S * 0.12);
          look.copy(cp);
          fov = 62;
        }
        break;
      }
      case 'Top':
        eye.set(subj.x + S * 0.4, subj.y + S * 3.2, subj.z + S * 0.4);
        smooth = 0.2;
        break;
      case 'You': {
        const f = this.frames[this.fi];
        if (f?.a) {
          look.set(f.a[12], f.a[13] + 1, f.a[14]);
          eye.copy(look).addScaledVector(this.chaseDir, -5).addScaledVector(UP, 2);
          fov = 62;
          smooth = 0.15;
        }
        break;
      }
    }
    const gy = this.ground(eye.x, eye.z) + 1;
    if (eye.y < gy) eye.y = gy;
    if (!this.camSet || smooth <= 0) this.camPos.copy(eye);
    else this.camPos.lerp(eye, 1 - Math.exp(-realDt / smooth));
    this.camSet = true;
    cam.position.copy(this.camPos);
    _m.lookAt(this.camPos, look, UP);
    cam.quaternion.setFromRotationMatrix(_m);
    if (Math.abs(cam.fov - fov) > 0.01 || cam.near !== 0.1) {
      cam.fov = fov;
      cam.near = 0.1;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
