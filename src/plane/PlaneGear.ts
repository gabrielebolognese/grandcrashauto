import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { G, groups } from '../core/Physics';
import type { Physics } from '../core/Physics';
import type { PlaneCfg } from './FlightModel';
import type { PlaneVisual } from './types';

/**
 * Landing gear as a Rapier DynamicRayCastVehicleController (SPEC-PART2 §6.7). Owner: flight.
 * One raycast wheel per PlaneGearInfo; suspension stiffness per wheel from the static load share, so every strut
 * sags the same amount (short, well damped struts). Thrust never goes through the wheels (engine force = 0); the
 * `brake` impulse doubles as rolling resistance, nose-wheel steering on the steerable wheels.
 */

export interface GearWheel {
  name: string;
  steerable: boolean;
  load: number; // N static share
  rest: number;
  radius: number;
  sag: number; // m static compression
  alive: boolean;
  contact: boolean;
}

const _p = { x: 0, y: 0, z: 0 };

export class PlaneGear {
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly wheels: GearWheel[] = [];
  contacts = 0;
  /** Index of the first wheel that touched in the last step that went from 0 contacts to >0 (or -1). */
  firstContact = -1;
  readonly contactPoint = new THREE.Vector3();
  groundHandle = -1;
  private filter = groups(G.ALL, G.WORLD);
  private aliveMains = 1;

  constructor(
    private physics: Physics,
    private body: RAPIER.RigidBody,
    visual: PlaneVisual,
    private cfg: PlaneCfg,
    mass: number,
  ) {
    const world = physics.world;
    const c = (this.controller = world.createVehicleController(body));
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    const g = CONFIG.planes.gravity;
    const W = mass * g;
    const gear = visual.gear;
    const noses = gear.filter((w) => w.steerable);
    const mains = gear.filter((w) => !w.steerable);
    const zn = noses.length ? noses.reduce((a, w) => a + w.wheel.z, 0) / noses.length : 0;
    const zm = mains.length ? mains.reduce((a, w) => a + w.wheel.z, 0) / mains.length : 0;
    let noseShare = noses.length && mains.length && zn - zm > 0.1 ? clamp01(-zm / (zn - zm)) : noses.length / Math.max(1, gear.length);
    if (!mains.length) noseShare = 1;
    if (!noses.length) noseShare = 0;
    const [restCfg, sagFrac, slip] = cfg.suspension;
    gear.forEach((w, i) => {
      const load = Math.max(W * 0.04, w.steerable ? (W * noseShare) / Math.max(1, noses.length) : (W * (1 - noseShare)) / Math.max(1, mains.length));
      const rest = restCfg;
      const sag = rest * sagFrac;
      _p.x = w.wheel.x;
      _p.y = w.wheel.y + rest;
      _p.z = w.wheel.z;
      c.addWheel(_p, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, rest, w.radius);
      // Rapier: suspension force = stiffness · compression · chassisMass (+ damping · velocity · chassisMass).
      const k = load / (mass * sag);
      const crit = (2 * load) / (mass * Math.sqrt(sag * g));
      c.setWheelSuspensionStiffness(i, k);
      c.setWheelSuspensionCompression(i, crit * 0.55);
      c.setWheelSuspensionRelaxation(i, crit * 0.85);
      c.setWheelMaxSuspensionForce(i, load * 9);
      c.setWheelMaxSuspensionTravel(i, rest * 0.92);
      c.setWheelFrictionSlip(i, slip);
      c.setWheelSideFrictionStiffness(i, 1);
      this.wheels.push({ name: w.name, steerable: w.steerable, load, rest, radius: w.radius, sag, alive: true, contact: false });
    });
    this.aliveMains = Math.max(1, mains.length);
  }

  /** Root height above the ground at which the plane sits on its struts (static sag). */
  static restHeight(visual: PlaneVisual, cfg: PlaneCfg): number {
    const [rest, sagFrac] = cfg.suspension;
    let h = 0.5;
    for (const w of visual.gear) h = Math.max(h, w.radius - (w.wheel.y + rest * sagFrac));
    return h;
  }

  setWheelAlive(name: string, alive: boolean): void {
    const i = this.wheels.findIndex((w) => w.name === name);
    if (i < 0) return;
    this.wheels[i].alive = alive;
    this.controller.setWheelMaxSuspensionForce(i, alive ? this.wheels[i].load * 9 : 0);
    this.controller.setWheelSuspensionStiffness(i, alive ? this.wheels[i].load / (this.body.mass() * this.wheels[i].sag) : 0);
    let n = 0;
    for (const w of this.wheels) if (!w.steerable && w.alive) n++;
    this.aliveMains = Math.max(1, n);
  }

  /**
   * Run the raycast gear for this fixed step. `active` false (gear retracted/collapsed) skips it entirely.
   * steer: rad (+ = toward +X / left), brake: 0..1, parking: hold, grip: tyre friction multiplier (weather).
   */
  update(dt: number, active: boolean, steer: number, brake: number, parking: boolean, grip: number): void {
    const prev = this.contacts;
    this.firstContact = -1;
    if (!active) {
      this.contacts = 0;
      for (const w of this.wheels) w.contact = false;
      return;
    }
    const c = this.controller;
    const cfg = this.cfg;
    const mass = this.body.mass();
    const mains = this.aliveMains;
    const mu = CONFIG.planes.rollingFriction;
    const [, , slip] = cfg.suspension;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      c.setWheelSteering(i, w.steerable ? steer : 0);
      c.setWheelEngineForce(i, 0);
      const roll = mu * w.load * dt;
      let b = roll;
      if (!w.steerable) {
        if (parking) b = Math.max(b, (mass * 6 * dt) / mains);
        else if (brake > 0) b = Math.max(b, (mass * cfg.brakeDecel * brake * dt) / mains);
      }
      c.setWheelBrake(i, b);
      c.setWheelFrictionSlip(i, slip * grip);
    }
    c.updateVehicle(dt, undefined, this.filter);
    let n = 0;
    let first = -1;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      w.contact = w.alive && c.wheelIsInContact(i);
      if (w.contact) {
        n++;
        if (first < 0) first = i;
      }
    }
    this.contacts = n;
    if (n > 0) {
      const cp = c.wheelContactPoint(first);
      if (cp) this.contactPoint.set(cp.x, cp.y, cp.z);
      const gobj = c.wheelGroundObject(first);
      this.groundHandle = gobj ? gobj.handle : -1;
      if (prev === 0) this.firstContact = first;
    }
  }

  /** Suspension length of wheel i (for visuals), or rest when airborne. */
  suspensionLength(i: number): number {
    return this.controller.wheelSuspensionLength(i) ?? this.wheels[i].rest;
  }

  wheelRotation(i: number): number {
    return this.controller.wheelRotation(i) ?? 0;
  }

  dispose(): void {
    try {
      this.physics.world.removeVehicleController(this.controller);
    } catch {
      /* already gone with the world */
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
