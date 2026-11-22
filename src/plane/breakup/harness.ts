import * as THREE from 'three';
import { CONFIG } from '../../config';
import { G, RAPIER, groups } from '../../core/Physics';
import type { GameContext } from '../../game/contracts';
import type { BlastInfo, CrashOutcome, ImpactInfo, PlaneTypeId, PlaneVisual, TrackedPlane, WreckPiece } from '../types';
import type { Breakup } from './Breakup';

/**
 * Debug harness (?debug only): `window.__breakup` drives the breakup system without the flight module.
 *   __breakup.test(type, scenario, opts?) — spawn a plane body (per-part cuboids, tagged like the flight module does),
 *       register it, set the scenario pose/velocity and trigger the API (explodeTotal / breakJoints / crash physics).
 *   __breakup.stats() — momentum numbers, events, piece counts, trajectories; __breakup.clear(); __breakup.cam(mode).
 * Scenarios: total, middle, tail, nose, wingtip, belly, hard, water, watercart, ditch, building, fly.
 */

interface Opts {
  kmh?: number;
  alt?: number;
  x?: number;
  z?: number;
  yawDeg?: number;
  pitchDeg?: number;
  gammaDeg?: number;
  bankDeg?: number;
  delay?: number;
  lift?: number;
  target?: [number, number, number];
}

interface Sample {
  t: number;
  body: number[] | null;
  pieces: { id: number; parts: number; mass: number; p: number[]; v: number[]; w: number[]; pitch: number; burning: number }[];
}

export function installHarness(bk: Breakup, ctx: GameContext): void {
  const { physics, engine } = ctx;
  let visual: PlaneVisual | null = null;
  let plane: TrackedPlane | null = null;
  let gearDown = true;
  let liftK = 0;
  let liftUntil = 0;
  let t = 0;
  let action: (() => void) | null = null;
  let actionAt = -1;
  let log: string[] = [];
  let samples: Sample[] = [];
  let sampleN = 0;
  const prevP = new THREE.Vector3();
  const currP = new THREE.Vector3();
  const prevQ = new THREE.Quaternion();
  const currQ = new THREE.Quaternion();
  let hardWatch: { vs: number } | null = null;
  let hidden: THREE.Object3D[] = [];
  const crashes: { outcome: CrashOutcome; info: ImpactInfo }[] = [];
  let splitInfo: { pieces: number; cockpit: number | null } | null = null;
  const lost: string[] = [];
  let camMode: string | null = null;
  let camFixed = new THREE.Vector3();
  let camOff = new THREE.Vector3(30, 12, -60);
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  let camPrimed = false;
  const tmp = new THREE.Vector3();
  const origUpdate = ctx.cameraRig.update?.bind(ctx.cameraRig);
  const evOff: (() => void)[] = [];

  const ev = (s: string) => {
    log.push(`${t.toFixed(2)} ${s}`);
    if (log.length > 200) log.shift();
  };
  evOff.push(ctx.events.on('planeImpact', (e) => ev(`planeImpact ${e.outcome} ${e.surface} vn=${e.normalSpeed.toFixed(1)} E=${(e.energy / 1e6).toFixed(1)}MJ`)));
  evOff.push(ctx.events.on('planeBreak', (e) => ev(`planeBreak pieces=${e.pieces} i=${e.intensity.toFixed(2)}`)));
  evOff.push(ctx.events.on('planeExplosion', (e) => ev(`planeExplosion ${e.kind} r=${e.radius.toFixed(1)} v=${e.velocity.length().toFixed(0)}`)));
  evOff.push(ctx.events.on('gearCollapse', () => ev('gearCollapse')));
  void evOff;

  function cleanup(): void {
    bk.clear();
    if (plane) {
      bk.untrack(plane);
      if (plane.body) physics.removeBody(plane.body);
      plane.body = null;
    }
    for (const o of hidden) o.visible = true;
    hidden = [];
    if (visual) {
      visual.repair();
      visual.root.removeFromParent();
      visual.dispose();
    }
    visual = null;
    plane = null;
    action = null;
    hardWatch = null;
    liftK = 0;
    samples = [];
    log = [];
    crashes.length = 0;
    lost.length = 0;
    splitInfo = null;
    bk.stats.lastSplit = null;
    bk.stats.events.length = 0;
  }

  function spawn(type: PlaneTypeId, pos: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, withGear: boolean): void {
    cleanup();
    const v = ctx.planeModels.create(type);
    visual = v;
    engine.scene.add(v.root);
    v.root.position.copy(pos);
    v.root.quaternion.copy(quat);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setLinvel(vel.x, vel.y, vel.z)
      .setAdditionalMassProperties(v.mass, { x: 0, y: 0, z: 0 }, { x: v.inertia.x, y: v.inertia.y, z: v.inertia.z }, { x: 0, y: 0, z: 0, w: 1 })
      .setCcdEnabled(true);
    const body = physics.world.createRigidBody(desc);
    for (const p of v.parts) {
      if (p.kind === 'gear' && !withGear) continue;
      const cd = RAPIER.ColliderDesc.cuboid(p.halfExtents.x, p.halfExtents.y, p.halfExtents.z)
        .setTranslation(p.boxCenter.x, p.boxCenter.y, p.boxCenter.z)
        .setDensity(0)
        .setFriction(0.5)
        .setCollisionGroups(groups(G.PLANE))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(v.mass * 2);
      physics.tag(physics.world.createCollider(cd, body), { kind: 'plane', material: 'metal', data: { part: p.name } });
    }
    gearDown = withGear;
    if (!withGear) for (const p of v.parts) if (p.kind === 'gear') (p.object.visible = false), hidden.push(p.object);
    const tp: TrackedPlane = {
      type,
      visual: v,
      body,
      brokenJoints: new Set<string>(),
      isGearDown: () => gearDown,
      onGearCollapse: () => {
        gearDown = false;
        ev('onGearCollapse');
      },
      onPartsLost: (parts) => {
        lost.push(...parts);
        ev(`onPartsLost ${parts.join(',')}`);
      },
      onSplit: (pieces: WreckPiece[], cockpit: WreckPiece | null) => {
        splitInfo = { pieces: pieces.length, cockpit: cockpit?.id ?? null };
        ev(`onSplit ${pieces.length} cockpit=${cockpit ? cockpit.parts.join('+') : 'none'}`);
      },
      onCrash: (outcome, info) => {
        crashes.push({ outcome, info });
        ev(`onCrash ${outcome} part=${info.part} vn=${info.normalSpeed.toFixed(1)} vt=${info.tangentSpeed.toFixed(1)} ang=${info.angleDeg.toFixed(0)}`);
      },
    };
    plane = tp;
    bk.track(tp);
    prevP.copy(pos);
    currP.copy(pos);
    prevQ.copy(quat);
    currQ.copy(quat);
    t = 0;
    camPrimed = false;
  }

  function pose(o: Opts, defaults: Required<Pick<Opts, 'kmh' | 'alt' | 'x' | 'z' | 'yawDeg' | 'gammaDeg' | 'bankDeg'>> & { pitchDeg?: number }) {
    const kmh = o.kmh ?? defaults.kmh;
    const yaw = THREE.MathUtils.degToRad(o.yawDeg ?? defaults.yawDeg);
    const gamma = THREE.MathUtils.degToRad(o.gammaDeg ?? defaults.gammaDeg);
    const pitch = THREE.MathUtils.degToRad(o.pitchDeg ?? defaults.pitchDeg ?? (o.gammaDeg ?? defaults.gammaDeg) + 2);
    const bank = THREE.MathUtils.degToRad(o.bankDeg ?? defaults.bankDeg);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch, yaw, bank, 'YXZ'));
    const sp = kmh / 3.6;
    const vel = new THREE.Vector3(Math.sin(yaw) * Math.cos(gamma), Math.sin(gamma), Math.cos(yaw) * Math.cos(gamma)).multiplyScalar(sp);
    const pos = new THREE.Vector3(o.x ?? defaults.x, o.alt ?? defaults.alt, o.z ?? defaults.z);
    return { pos, q, vel, sp };
  }

  function blastAt(jointIds: string[], kind: BlastInfo['kind'], energy: number): BlastInfo {
    const v = visual!;
    const c = new THREE.Vector3();
    let n = 0;
    for (const id of jointIds) {
      const j = v.joints.find((x) => x.id === id);
      if (j) (c.add(j.position), n++);
    }
    if (n) c.multiplyScalar(1 / n);
    const b = plane!.body!;
    const tr = b.translation();
    const r = b.rotation();
    c.applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(new THREE.Vector3(tr.x, tr.y, tr.z));
    return { center: c, energy, kind };
  }

  function test(type: PlaneTypeId = 'airliner', scenario = 'total', o: Opts = {}): string {
    const delay = o.delay ?? 0.15;
    const stall = CONFIG.planes[type].stallKmh;
    let withGear = true;
    let p;
    switch (scenario) {
      case 'total':
        p = pose(o, { kmh: 700, alt: 300, x: 0, z: -250, yawDeg: 0, gammaDeg: 0, bankDeg: 0 });
        liftK = o.lift ?? 1;
        liftUntil = delay;
        action = () => plane && bk.explodeTotal(plane);
        break;
      case 'middle':
        p = pose(o, { kmh: 450, alt: 600, x: 0, z: -250, yawDeg: 0, gammaDeg: 0, bankDeg: 0 });
        liftK = o.lift ?? 1;
        liftUntil = delay;
        action = () => {
          if (!plane || !visual) return;
          const ids = visual.breakModes.middle;
          bk.breakJoints(plane, ids, blastAt(ids, 'middle', 0.25));
        };
        break;
      case 'tail':
        p = pose(o, { kmh: 420, alt: 500, x: 0, z: -250, yawDeg: 0, gammaDeg: 0, bankDeg: 0 });
        liftK = o.lift ?? 1;
        liftUntil = 1e9; // the intact remainder keeps (crippled) lift; the flight module does this in game
        action = () => {
          if (!plane || !visual) return;
          const ids = [...visual.breakModes.tailRequired, ...visual.breakModes.tailOptional];
          bk.breakJoints(plane, ids, blastAt(ids, 'tail', 0.08));
        };
        break;
      case 'nose':
        p = pose(o, { kmh: 300, alt: 60, x: 0, z: -300, yawDeg: 0, gammaDeg: -40, bankDeg: 0, pitchDeg: -42 });
        break;
      case 'wingtip':
        p = pose(o, { kmh: 260, alt: 20, x: -150, z: -250, yawDeg: 0, gammaDeg: -9, bankDeg: 55, pitchDeg: -4 });
        break;
      case 'belly':
        withGear = false;
        p = pose(o, { kmh: 300, alt: 4, x: -150, z: -350, yawDeg: 0, gammaDeg: -1.2, bankDeg: 0, pitchDeg: 1.5 });
        liftK = o.lift ?? 0.92;
        liftUntil = 1e9;
        break;
      case 'hard':
        p = pose(o, { kmh: 250, alt: 8, x: -150, z: -350, yawDeg: 0, gammaDeg: -1.1, bankDeg: 0, pitchDeg: 3 });
        liftK = o.lift ?? 0.97;
        liftUntil = 1e9;
        hardWatch = { vs: 0 };
        break;
      case 'water':
        p = pose(o, { kmh: 400, alt: 120, x: 0, z: 650, yawDeg: 0, gammaDeg: -35, bankDeg: 0, pitchDeg: -37 });
        break;
      case 'watercart':
        p = pose(o, { kmh: 300, alt: 22, x: 0, z: 650, yawDeg: 0, gammaDeg: -7, bankDeg: 70, pitchDeg: -3 });
        liftK = o.lift ?? 0.5;
        liftUntil = 1e9;
        break;
      case 'ditch':
        p = pose(o, { kmh: stall * 1.2, alt: 6, x: 0, z: 600, yawDeg: 0, gammaDeg: -1.3, bankDeg: 0, pitchDeg: 6 });
        liftK = o.lift ?? 0.97;
        liftUntil = 1e9;
        break;
      case 'building': {
        const tgt = o.target ?? [134, 12, 68];
        p = pose(o, { kmh: 250, alt: tgt[1], x: tgt[0] - 260, z: tgt[2], yawDeg: 90, gammaDeg: 0, bankDeg: 0 });
        liftK = o.lift ?? 1;
        liftUntil = 1e9;
        break;
      }
      default:
        p = pose(o, { kmh: 300, alt: 300, x: 0, z: -250, yawDeg: 0, gammaDeg: 0, bankDeg: 0 });
        liftK = o.lift ?? 1;
        liftUntil = 1e9;
    }
    const keepAction = action;
    const keepLift = liftK;
    const keepUntil = liftUntil;
    const keepHard = hardWatch;
    spawn(type, p.pos, p.q, p.vel, withGear);
    action = keepAction;
    liftK = keepLift;
    liftUntil = keepUntil;
    hardWatch = keepHard;
    actionAt = action ? delay : -1;
    ev(`test ${type} ${scenario} v=${p.sp.toFixed(0)}m/s`);
    return `ok ${type} ${scenario}`;
  }

  // ─── loop hooks ───
  bk.harness = {
    fixed(dt) {
      if (!plane) return;
      t += dt;
      if (action && actionAt >= 0 && t >= actionAt) {
        const a = action;
        action = null;
        actionAt = -1;
        a();
      }
      const b = plane.body;
      if (b && liftK > 0 && t < liftUntil && !crashes.length) {
        // crude stand-in for the flight model: lift along body up, scaled by (v / v0)²
        const v = b.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        const m = b.mass();
        const r = b.rotation();
        const up = tmp.set(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
        const g = Math.abs(CONFIG.physics.gravity);
        const k = liftK * Math.min(1.2, (sp * sp) / Math.max(1, sp * sp));
        b.applyImpulse({ x: up.x * m * g * k * dt, y: up.y * m * g * k * dt, z: up.z * m * g * k * dt }, true);
        b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
      if (b && hardWatch && visual) {
        // gear touch → hard landing call (what the plane system does on a 3–6 m/s touchdown)
        const tr = b.translation();
        const r = b.rotation();
        const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        let low = Infinity;
        for (const gpart of visual.gear) {
          const w = tmp.copy(gpart.wheel).applyQuaternion(q);
          low = Math.min(low, tr.y + w.y - gpart.radius);
        }
        const ground = ctx.world.groundHeightAt(tr.x, tr.z);
        if (low - ground < 0.15) {
          const v = b.linvel();
          const info: ImpactInfo = {
            position: new THREE.Vector3(tr.x, ground, tr.z),
            velocity: new THREE.Vector3(v.x, v.y, v.z),
            normalSpeed: Math.max(0, -v.y),
            tangentSpeed: Math.hypot(v.x, v.z),
            angleDeg: (Math.atan2(-v.y, Math.hypot(v.x, v.z)) * 180) / Math.PI,
            part: 'gearL',
            energy: 0.5 * b.mass() * (v.x * v.x + v.y * v.y + v.z * v.z),
            surface: 'runway',
          };
          hardWatch = null;
          liftK = 0;
          bk.hardLanding(plane, info);
        }
      }
    },
    post() {
      if (!plane) return;
      const b = plane.body;
      if (b) {
        const tr = b.translation();
        const r = b.rotation();
        prevP.copy(currP);
        prevQ.copy(currQ);
        currP.set(tr.x, tr.y, tr.z);
        currQ.set(r.x, r.y, r.z, r.w);
      }
      if (++sampleN % 6 === 0 && samples.length < 900) {
        const s: Sample = { t: +t.toFixed(2), body: null, pieces: [] };
        if (b) {
          const v = b.linvel();
          s.body = [currP.x, currP.y, currP.z, v.x, v.y, v.z].map((x) => +x.toFixed(2));
        }
        for (const pc of bk.pieces) {
          const pb = pc.body;
          const c = pb.worldCom();
          const v = pb.linvel();
          const w = pb.angvel();
          const r = pb.rotation();
          const fwd = tmp.set(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
          s.pieces.push({
            id: pc.id,
            parts: pc.parts.length,
            mass: Math.round(pc.mass),
            p: [c.x, c.y, c.z].map((x) => +x.toFixed(1)),
            v: [v.x, v.y, v.z].map((x) => +x.toFixed(1)),
            w: [w.x, w.y, w.z].map((x) => +x.toFixed(2)),
            pitch: +((Math.asin(Math.max(-1, Math.min(1, fwd.y))) * 180) / Math.PI).toFixed(0),
            burning: +pc.burning.toFixed(2),
          });
        }
        samples.push(s);
      }
    },
    update(_dt, alpha) {
      if (plane?.body && visual) {
        visual.root.position.lerpVectors(prevP, currP, alpha);
        visual.root.quaternion.slerpQuaternions(prevQ, currQ, alpha);
      }
    },
  };

  ctx.events.on('originShift', (e) => {
    prevP.sub(e.delta);
    currP.sub(e.delta);
    camPos.sub(e.delta);
    camFixed.sub(e.delta);
  });

  // ─── camera ───
  function focusPoint(out: THREE.Vector3): boolean {
    if (plane?.body && visual) {
      out.copy(visual.root.position);
      return true;
    }
    const f = bk.focusPiece ?? bk.pieces.find((p) => p.hasCockpit) ?? bk.pieces.reduce<WreckPiece | null>((a, b) => (!a || b.mass > a.mass ? b : a), null);
    if (!f) return false;
    const c = (f as WreckPiece).body.worldCom();
    out.set(c.x, c.y, c.z);
    return true;
  }
  function cam(mode: string | null, a?: number[], b?: number[]): string {
    camMode = mode;
    camPrimed = false;
    if (a) (mode === 'fixed' ? camFixed : camOff).set(a[0], a[1], a[2]);
    if (b) camLook.set(b[0], b[1], b[2]);
    if (!mode) {
      if (origUpdate) ctx.cameraRig.update = origUpdate;
      return 'restored';
    }
    ctx.cameraRig.update = (dt: number) => {
      const c = engine.camera;
      if (!focusPoint(tmp)) return;
      if (camMode === 'fixed') {
        c.position.copy(camFixed);
        c.lookAt(tmp);
      } else if (camMode === 'look') {
        c.position.copy(camFixed);
        c.lookAt(camLook);
      } else {
        const target = tmp.clone().add(camOff);
        if (!camPrimed) {
          camPos.copy(target);
          camLook.copy(tmp);
          camPrimed = true;
        }
        const k = 1 - Math.exp(-4 * Math.max(0.001, dt));
        camPos.lerp(target, k);
        camLook.lerp(tmp, Math.min(1, k * 2));
        c.position.copy(camPos);
        c.lookAt(camLook);
      }
      c.updateMatrixWorld();
    };
    return mode;
  }

  function stats() {
    const ls = bk.stats.lastSplit;
    return {
      t: +t.toFixed(2),
      intact: !!plane?.body,
      pieces: bk.pieces.length,
      bodies: physics.world.bodies.len(),
      colliders: physics.world.colliders.len(),
      lastSplit: ls,
      crashes: crashes.map((c) => ({ outcome: c.outcome, part: c.info.part, vn: +c.info.normalSpeed.toFixed(1), vt: +c.info.tangentSpeed.toFixed(1), angle: +c.info.angleDeg.toFixed(0) })),
      split: splitInfo,
      lost,
      focus: bk.focusPiece ? { id: bk.focusPiece.id, parts: bk.focusPiece.parts, burning: +bk.focusPiece.burning.toFixed(2) } : null,
      log: log.slice(-60),
      events: bk.stats.events.slice(-30),
      created: bk.stats.bodiesCreated,
      removed: bk.stats.bodiesRemoved,
    };
  }

  (window as unknown as { __breakup: unknown }).__breakup = {
    test,
    stats,
    clear: cleanup,
    cam,
    samples: () => samples,
    pieceSummary: () =>
      bk.pieces.map((p) => {
        const c = p.body.worldCom();
        const v = p.body.linvel();
        const w = p.body.angvel();
        return { id: p.id, parts: p.parts.join('+'), mass: Math.round(p.mass), y: +c.y.toFixed(1), z: +c.z.toFixed(1), x: +c.x.toFixed(1), speed: +Math.hypot(v.x, v.y, v.z).toFixed(1), spin: +Math.hypot(w.x, w.y, w.z).toFixed(2), burning: +p.burning.toFixed(2) };
      }),
    bk,
  };
}
