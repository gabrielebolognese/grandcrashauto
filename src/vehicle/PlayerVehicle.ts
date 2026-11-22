import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups, BodyInterpolator } from '../core/Physics';
import { KMH } from '../core/math';
import type { CarBuild } from './CarBuild';
import type { CarVisual, GameContext, IPlayerVehicle, VehicleState } from '../game/contracts';
import type { Pose } from '../world/types';

/** STUB — minimal raycast vehicle. Replaced by the vehicle module (full physics, gears, damage, explosion). */
export class PlayerVehicle implements IPlayerVehicle {
  readonly name = 'vehicle';
  active = false;
  object: THREE.Object3D | null = null;
  visual: CarVisual | null = null;
  chassis: RAPIER.RigidBody | null = null;
  build: CarBuild | null = null;
  readonly state: VehicleState = {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, 1),
    speed: 0,
    speedKmh: 0,
    rpm: 800,
    rpmNorm: 0,
    gear: 1,
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    airborne: false,
    upsideDown: false,
    exploded: false,
    boost: 0,
    wheels: [],
  };
  private controller: RAPIER.DynamicRayCastVehicleController | null = null;
  private interp = new BodyInterpolator();

  constructor(private ctx: GameContext) {}
  init(): void {}

  spawn(build: CarBuild, pose: Pose): void {
    this.despawn();
    const { physics, engine } = this.ctx;
    this.build = build;
    const visual = (this.visual = this.ctx.cars.create(build));
    engine.scene.add(visual.root);
    this.object = visual.root;
    const d = visual.dims;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw);
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pose.position.x, pose.position.y + 0.6, pose.position.z)
        .setRotation(q)
        .setCanSleep(false)
        .setAngularDamping(0.6),
    );
    const col = RAPIER.ColliderDesc.cuboid(d.halfExtents.x, d.halfExtents.y, d.halfExtents.z)
      .setTranslation(d.colliderOffset.x, d.colliderOffset.y, d.colliderOffset.z)
      .setMass(d.mass)
      .setCollisionGroups(groups(G.PLAYER))
      .setFriction(0.4);
    physics.tag(physics.world.createCollider(col, body), { kind: 'player', material: 'metal' });
    const c = physics.world.createVehicleController(body);
    c.indexUpAxis = 1;
    c.setIndexForwardAxis = 2;
    for (const wp of d.wheelPositions) {
      c.addWheel({ x: wp.x, y: wp.y + 0.3, z: wp.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, 0.3, d.wheelRadius);
    }
    for (let i = 0; i < 4; i++) {
      c.setWheelSuspensionStiffness(i, 28);
      c.setWheelSuspensionCompression(i, 2.6);
      c.setWheelSuspensionRelaxation(i, 3.2);
      c.setWheelMaxSuspensionForce(i, 100000);
      c.setWheelMaxSuspensionTravel(i, 0.3);
      c.setWheelFrictionSlip(i, 2.2);
      c.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.chassis = body;
    this.controller = c;
    this.interp.reset(body);
    this.active = true;
    this.state.exploded = false;
    this.ctx.events.emit('carSpawned', { build });
  }

  despawn(): void {
    if (!this.active) return;
    const { physics, engine } = this.ctx;
    if (this.controller) physics.world.removeVehicleController(this.controller);
    physics.removeBody(this.chassis);
    if (this.visual) {
      engine.scene.remove(this.visual.root);
      this.visual.dispose();
    }
    this.controller = null;
    this.chassis = null;
    this.visual = null;
    this.object = null;
    this.active = false;
  }

  applyBuild(build: CarBuild): void {
    this.build = build;
    this.visual?.applyBuild(build);
  }

  fixedUpdate(dt: number): void {
    const c = this.controller;
    const body = this.chassis;
    if (!c || !body) return;
    const inp = this.ctx.input.state;
    const s = this.state;
    const speed = c.currentVehicleSpeed();
    let engineF = 0;
    let brake = 0;
    if (!s.exploded) {
      if (inp.throttle > 0) engineF = inp.throttle * 5200;
      if (inp.brake > 0) {
        if (speed > 1) brake = inp.brake * 60;
        else engineF = -inp.brake * 3000;
      }
    }
    // Positive Rapier steering turns toward +X (the car's left), so negate the input.
    const steer = -inp.steer * THREE.MathUtils.lerp(0.6, 0.15, Math.min(1, Math.abs(speed) / 45));
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      c.setWheelSteering(i, front ? steer : 0);
      c.setWheelEngineForce(i, front ? 0 : engineF);
      c.setWheelBrake(i, brake + (!front && inp.handbrake ? 40 : 0));
      c.setWheelSideFrictionStiffness(i, !front && inp.handbrake ? 0.35 : 1.0);
    }
    c.updateVehicle(dt, undefined, groups(G.ALL, G.WORLD | G.PARKED), (col) => col.parent()?.handle !== body.handle);
    s.speed = speed;
    s.speedKmh = Math.abs(speed) * KMH;
    s.throttle = inp.throttle;
    s.brake = inp.brake;
    s.steer = inp.steer;
    s.handbrake = inp.handbrake;
    s.gear = speed < -0.5 ? -1 : 1;
    s.rpmNorm = Math.min(1, Math.abs(speed) / 55);
    s.rpm = 800 + s.rpmNorm * 6200;
    if (body.translation().y < CONFIG.world.killY) this.ctx.game.requestReset();
  }

  postStep(): void {
    if (this.chassis) this.interp.capture(this.chassis);
  }

  update(_dt: number, alpha: number): void {
    const body = this.chassis;
    const c = this.controller;
    const visual = this.visual;
    if (!body || !c || !this.object || !visual) return;
    this.interp.apply(this.object, alpha);
    this.state.position.copy(this.object.position);
    this.state.quaternion.copy(this.object.quaternion);
    this.state.forward.set(0, 0, 1).applyQuaternion(this.object.quaternion);
    const v = body.linvel();
    this.state.velocity.set(v.x, v.y, v.z);
    visual.wheels.forEach((w, i) => {
      const len = c.wheelSuspensionLength(i) ?? 0.3;
      w.pivot.position.y = visual.dims.wheelPositions[i].y + 0.3 - len;
      w.pivot.rotation.y = c.wheelSteering(i) ?? 0;
      w.spin.rotation.x = c.wheelRotation(i) ?? 0;
    });
  }

  explode(): void {
    if (!this.chassis || this.state.exploded) return;
    this.state.exploded = true;
    this.chassis.applyImpulse({ x: 0, y: 9000, z: 0 }, true);
    this.chassis.applyTorqueImpulse({ x: 3000, y: 500, z: 2000 }, true);
    this.visual?.setCharred(1);
    this.ctx.events.emit('explosion', { position: this.state.position.clone(), radius: 18, force: 1 });
  }

  reset(pose?: Pose): void {
    const body = this.chassis;
    if (!body || !this.build) return;
    const yaw = Math.atan2(this.state.forward.x, this.state.forward.z);
    const p = pose ?? this.ctx.world.findRespawn(this.state.position, yaw);
    body.setTranslation({ x: p.position.x, y: p.position.y + 0.8, z: p.position.z }, true);
    body.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw), true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.interp.reset(body);
    this.state.exploded = false;
    this.visual?.repair();
  }

  flip(): void {
    const p = this.state.position;
    this.reset({ position: { x: p.x, y: p.y, z: p.z }, yaw: Math.atan2(this.state.forward.x, this.state.forward.z) });
  }
}
