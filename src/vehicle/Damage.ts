import * as THREE from 'three';
import { CONFIG } from '../config';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { ColliderTag, SurfaceMaterial } from '../core/Physics';
import type { CarVisual, GameContext } from '../game/contracts';

/** What the damage model needs from the player vehicle. */
export interface DamageHost {
  readonly ctx: GameContext;
  readonly chassis: RAPIER.RigidBody | null;
  readonly chassisCollider: RAPIER.Collider | null;
  readonly visual: CarVisual | null;
  readonly exploded: boolean;
  readonly mass: number;
  /** Chassis velocity before the current physics step. */
  readonly preVelocity: THREE.Vector3;
  /** Half length of the chassis box (bumper zones). */
  readonly halfLength: number;
  hangBumper(end: 'F' | 'R'): void;
  detachBumper(end: 'F' | 'R'): void;
}

const HARD: ReadonlySet<SurfaceMaterial> = new Set<SurfaceMaterial>(['concrete', 'asphalt', 'metal', 'glass']);

/**
 * Impacts, scrapes and light damage (spec §6): contact-force events on the chassis → `impact` / `scrape` / `vibrate`
 * events, vertex dents, cracked → shattered glass, bumpers that hang and then fall off. Owner: src/vehicle.
 */
export class Damage {
  glassLevel: 0 | 1 | 2 = 0;
  private glassAccum = 0;
  private bumper = { F: 0, R: 0 };
  private hung = { F: false, R: false };
  private gone = { F: false, R: false };
  private cooldown = new Map<number, { t: number; s: number }>();
  private time = 0;

  private scrapeIntensity = 0;
  private scrapePos = new THREE.Vector3();

  // temps
  private point = new THREE.Vector3();
  private normal = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private v3b = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private qi = new THREE.Quaternion();
  private up = new THREE.Vector3();
  private localP = new THREE.Vector3();
  private localD = new THREE.Vector3();
  private rv = { x: 0, y: 0, z: 0 };
  private evPos = new THREE.Vector3();
  private evNormal = new THREE.Vector3();

  constructor(private host: DamageHost) {}

  reset(): void {
    this.glassLevel = 0;
    this.glassAccum = 0;
    this.bumper.F = this.bumper.R = 0;
    this.hung.F = this.hung.R = false;
    this.gone.F = this.gone.R = false;
    this.cooldown.clear();
    this.scrapeIntensity = 0;
  }

  tick(dt: number): void {
    this.time += dt;
    if (this.cooldown.size > 48) {
      for (const [k, v] of this.cooldown) if (this.time - v.t > 2) this.cooldown.delete(k);
    }
  }

  /** Raw core `contact` event involving the chassis collider. */
  onContact(otherHandle: number, otherTag: ColliderTag | null, force: number): void {
    const { ctx, chassis: body, chassisCollider: col } = this.host;
    if (!body || !col) return;
    const world = ctx.physics.world;
    const other = world.getCollider(otherHandle);
    if (!other) return;
    const I = CONFIG.vehicle.impact;

    // Contact point (average of solver contacts) and normal pointing from the other surface toward the car.
    let n = 0;
    const point = this.point.set(0, 0, 0);
    const normal = this.normal.set(0, 0, 0);
    world.contactPair(col, other, (manifold, flipped) => {
      const c = manifold.numSolverContacts();
      if (c === 0) return;
      const mn = manifold.normal(this.rv);
      const sgn = flipped ? c : -c;
      normal.x += mn.x * sgn;
      normal.y += mn.y * sgn;
      normal.z += mn.z * sgn;
      for (let i = 0; i < c; i++) {
        const p = manifold.solverContactPoint(i, this.rv);
        if (p) point.x += p.x, point.y += p.y, point.z += p.z;
      }
      n += c;
    });
    const t = body.translation();
    if (n === 0) {
      point.set(t.x, t.y + 0.5, t.z);
      normal.set(0, 1, 0);
    } else {
      point.multiplyScalar(1 / n);
      if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
      normal.normalize();
    }

    const r = body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    const carUp = this.up.set(0, 1, 0).applyQuaternion(this.q);
    const belly = normal.dot(carUp) > 0.7 && normal.y > 0.6; // landing / bottoming out on the ground
    const material: SurfaceMaterial = otherTag?.material ?? 'concrete';

    // Sliding speed along the surface (relative to the other body if it moves).
    const vp = body.velocityAtPoint(point, this.rv);
    const rel = this.v3.set(vp.x, vp.y, vp.z);
    const ob = other.parent();
    if (ob && ob.isDynamic()) {
      const ov = ob.velocityAtPoint(point, this.rv);
      rel.x -= ov.x, rel.y -= ov.y, rel.z -= ov.z;
    }
    const vn = rel.dot(normal);
    const vt = this.v3b.copy(rel).addScaledVector(normal, -vn).length();
    if (vt > I.scrapeSpeed && (HARD.has(material) || !otherTag)) {
      const s = Math.min(1, (vt - I.scrapeSpeed) / Math.max(0.1, I.scrapeFull - I.scrapeSpeed));
      if (s > this.scrapeIntensity) {
        this.scrapeIntensity = Math.max(0.05, s);
        this.scrapePos.copy(point);
      }
    }

    // Impact strength from the velocity change this step (mass-normalised, so light props barely register).
    const dv = (force * ctx.physics.dt) / Math.max(1, this.host.mass);
    let strength = Math.min(1, Math.max(0, (dv - I.minDv) / Math.max(0.1, I.maxDv - I.minDv)));
    if (belly) strength *= I.groundScale;
    if (strength <= 0.02) return;

    const cd = this.cooldown.get(otherHandle);
    if (cd && this.time - cd.t < I.cooldown && strength < cd.s * 1.6) return;
    this.cooldown.set(otherHandle, { t: this.time, s: strength });

    const pv = this.host.preVelocity;
    this.evPos.copy(point);
    this.evNormal.copy(normal);
    ctx.events.emit('impact', { position: this.evPos, normal: this.evNormal, strength, force, material, other: otherTag, speed: pv.length() });
    if (strength > I.vibrateMin) ctx.events.emit('vibrate', { pattern: Math.round(20 + 70 * strength) });

    if (this.host.exploded || belly) return;
    this.applyDamage(point, normal, strength, t);
  }

  private applyDamage(point: THREE.Vector3, normal: THREE.Vector3, strength: number, t: { x: number; y: number; z: number }): void {
    const D = CONFIG.vehicle.damage;
    const visual = this.host.visual;
    if (!visual) return;
    // World → car local
    this.qi.copy(this.q).invert();
    const lp = this.localP.set(point.x - t.x, point.y - t.y, point.z - t.z).applyQuaternion(this.qi);
    const ld = this.localD.copy(normal).applyQuaternion(this.qi);

    if (strength >= D.dentMin) visual.dent(lp, ld, Math.min(1, strength * D.dentScale));

    // Glass: cracked, then shattered
    this.glassAccum += strength;
    let level: 0 | 1 | 2 = this.glassLevel;
    if (strength >= D.glassShatter || this.glassAccum >= D.glassShatterAccum) level = 2;
    else if (strength >= D.glassCrack || this.glassAccum >= D.glassCrackAccum) level = Math.max(level, 1) as 0 | 1 | 2;
    if (level > this.glassLevel) {
      this.glassLevel = level;
      visual.setGlassDamage(level);
      const pos = this.v3.set(0, 1.1, 0).applyQuaternion(this.q).add(this.v3b.set(t.x, t.y, t.z));
      this.host.ctx.events.emit('glassBreak', { position: pos, shattered: level === 2 });
    }

    // Bumpers
    const zone = this.host.halfLength * D.bumperZone;
    const end: 'F' | 'R' | null = lp.z > zone ? 'F' : lp.z < -zone ? 'R' : null;
    if (end && strength > 0.12 && !this.gone[end]) {
      this.bumper[end] += strength;
      if (this.bumper[end] >= D.bumperDetach) {
        this.gone[end] = true;
        this.host.detachBumper(end);
      } else if (this.bumper[end] >= D.bumperHang && !this.hung[end]) {
        this.hung[end] = true;
        this.host.hangBumper(end);
      }
    }
  }

  /** Called once per fixed step after physics: emits the strongest scrape of the step. */
  flushScrape(): void {
    if (this.scrapeIntensity > 0) {
      this.host.ctx.events.emit('scrape', { position: this.scrapePos, intensity: this.scrapeIntensity });
      this.scrapeIntensity = 0;
    }
  }
}
