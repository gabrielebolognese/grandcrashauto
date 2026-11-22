import * as THREE from 'three';
import { CONFIG } from '../config';
import { RAPIER, G, groups } from '../core/Physics';
import { disposeObject } from '../core/Engine';
import type { GameContext } from '../game/contracts';
import type { AirportData } from '../world/types';
import type { PlaneTypeId } from './types';

/**
 * Airfield data used by the plane system (runways for spawns, one stand per plane type), in LOCAL coordinates.
 * Built from CityData.airport when the world provides it, else from a TEMPORARY test airfield (below) that the
 * plane system creates itself until the world module ships the real airport. Owner: flight.
 */

export interface AirfieldStand {
  type: PlaneTypeId;
  p: THREE.Vector3; // ground point under the plane's centre of mass
  yaw: number; // nose direction (yaw 0 = +Z)
}

export interface AirfieldRunway {
  a: THREE.Vector3;
  b: THREE.Vector3;
  width: number;
}

export interface AirfieldInfo {
  runways: AirfieldRunway[];
  stands: AirfieldStand[];
  elevation: number;
  temp: boolean;
}

export function airfieldFromCity(ap: AirportData): AirfieldInfo {
  return {
    runways: ap.runways.map((r) => ({ a: new THREE.Vector3(r.a.x, r.a.y, r.a.z), b: new THREE.Vector3(r.b.x, r.b.y, r.b.z), width: r.width })),
    stands: ap.stands.map((s) => ({ type: s.type, p: new THREE.Vector3(s.p.x, s.p.y, s.p.z), yaw: s.yaw })),
    elevation: ap.elevation,
    temp: false,
  };
}

export function shiftAirfield(info: AirfieldInfo, dx: number, dz: number): void {
  for (const r of info.runways) {
    r.a.x -= dx;
    r.a.z -= dz;
    r.b.x -= dx;
    r.b.z -= dz;
  }
  for (const s of info.stands) {
    s.p.x -= dx;
    s.p.z -= dz;
  }
}

// Temporary layout, ABSOLUTE coordinates: E–W runway inside CONFIG.world.airportBounds, take-offs west over the sea.
const RWY = { x0: -3300, x1: -1100, z: -300, width: 60 };
const STANDS: { type: PlaneTypeId; x: number; z: number }[] = [
  { type: 'prop', x: -1425, z: -150 },
  { type: 'bizjet', x: -1390, z: -150 },
  { type: 'airliner', x: -1335, z: -150 },
  { type: 'jumbo', x: -1255, z: -150 },
];
const APRON = { x0: -1470, x1: -1180, z0: -225, z1: -70 };
const TAXI = { x0: -1215, x1: -1185, z0: -275, z1: -220 };

/** Flat test airfield (collider + one merged vertex-coloured mesh). Removed when the real airport exists. */
export class TempAirfield {
  readonly info: AirfieldInfo;
  private group = new THREE.Group();
  private body: RAPIER.RigidBody;

  constructor(private ctx: GameContext) {
    const { physics, engine, origin } = ctx;
    const b = CONFIG.world.airportBounds;
    const ox = origin.offset.x;
    const oz = origin.offset.z;
    const cx = (RWY.x0 + RWY.x1) / 2 - ox;
    const cz = RWY.z - oz;
    let base = 0;
    try {
      base = Math.max(0, ctx.world.groundHeightAt(cx, cz));
    } catch {
      base = 0;
    }
    // Raised slightly above the sea surface so the stub ocean never z-fights with it.
    const elev = base + 1.2;
    const L = (x: number) => x - ox;
    const Z = (z: number) => z - oz;

    // ---- physics: one big fixed slab + a gentle ramp down to the city ground (x ≈ -400) ----
    const body = (this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
    const x0 = b.minX;
    const x1 = Math.max(b.maxX, -460);
    const hx = (x1 - x0) / 2;
    const hz = (b.maxZ - b.minZ) / 2;
    physics.tag(
      physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, 2, hz).setTranslation(L((x0 + x1) / 2), elev - 2, Z((b.minZ + b.maxZ) / 2)).setCollisionGroups(groups(G.WORLD)).setFriction(0.9),
        body,
      ),
      { kind: 'road', material: 'asphalt' },
    );
    const rampLen = -400 - x1; // m
    if (rampLen > 1) {
      const th = Math.atan2(elev, rampLen);
      const phi = -th;
      const upX = -Math.sin(phi);
      const upY = Math.cos(phi);
      const topX = (x1 + -400) / 2;
      const topY = elev / 2;
      physics.tag(
        physics.world.createCollider(
          RAPIER.ColliderDesc.cuboid(rampLen / 2 / Math.cos(th) + 0.5, 0.5, 350)
            .setTranslation(L(topX) - upX * 0.5, topY - upY * 0.5, Z(-50))
            .setRotation({ x: 0, y: 0, z: Math.sin(phi / 2), w: Math.cos(phi / 2) })
            .setCollisionGroups(groups(G.WORLD))
            .setFriction(0.9),
          body,
        ),
        { kind: 'road', material: 'asphalt' },
      );
    }

    // ---- visuals: one merged non-indexed geometry with vertex colours ----
    const pos: number[] = [];
    const col: number[] = [];
    const nrm: number[] = [];
    const c = new THREE.Color();
    const rect = (ax: number, az: number, bx: number, bz: number, y: number, hex: number) => {
      c.set(hex);
      const xa = L(Math.min(ax, bx));
      const xb = L(Math.max(ax, bx));
      const za = Z(Math.min(az, bz));
      const zb = Z(Math.max(az, bz));
      const v = [xa, y, za, xa, y, zb, xb, y, zb, xa, y, za, xb, y, zb, xb, y, za];
      for (let i = 0; i < 18; i += 3) {
        pos.push(v[i], v[i + 1], v[i + 2]);
        col.push(c.r, c.g, c.b);
        nrm.push(0, 1, 0);
      }
    };
    const wall = (ax: number, az: number, bx: number, bz: number, y0: number, y1: number, hex: number, nx: number, nz: number) => {
      c.set(hex);
      const v = [L(ax), y0, Z(az), L(bx), y0, Z(bz), L(bx), y1, Z(bz), L(ax), y0, Z(az), L(bx), y1, Z(bz), L(ax), y1, Z(az)];
      for (let i = 0; i < 18; i += 3) {
        pos.push(v[i], v[i + 1], v[i + 2]);
        col.push(c.r, c.g, c.b);
        nrm.push(nx, 0, nz);
      }
    };
    const y = elev;
    rect(x0, b.minZ, x1, b.maxZ, y, 0x9fc47e); // grass
    wall(x0, b.minZ, x1, b.minZ, -3, y, 0xe7d3a8, 0, -1);
    wall(x1, b.maxZ, x0, b.maxZ, -3, y, 0xe7d3a8, 0, 1);
    wall(x0, b.maxZ, x0, b.minZ, -3, y, 0xe7d3a8, -1, 0);
    if (rampLen > 1) rect(x1, -400, -400, 300, y * 0.5, 0x8a8d96);
    rect(RWY.x0, RWY.z - RWY.width / 2, RWY.x1, RWY.z + RWY.width / 2, y + 0.03, 0x4a4d57); // runway
    rect(RWY.x0, RWY.z - RWY.width / 2 + 1, RWY.x1, RWY.z - RWY.width / 2 + 2, y + 0.05, 0xf4f4f0); // edge lines
    rect(RWY.x0, RWY.z + RWY.width / 2 - 2, RWY.x1, RWY.z + RWY.width / 2 - 1, y + 0.05, 0xf4f4f0);
    for (let x = RWY.x0 + 120; x < RWY.x1 - 120; x += 60) rect(x, RWY.z - 0.5, x + 30, RWY.z + 0.5, y + 0.05, 0xf4f4f0); // centreline
    for (const end of [RWY.x0 + 6, RWY.x1 - 36]) {
      for (let i = 0; i < 6; i++) {
        const zz = RWY.z - RWY.width / 2 + 5 + i * 4.2;
        rect(end, zz, end + 30, zz + 2, y + 0.05, 0xf4f4f0);
        rect(end, RWY.z + RWY.width / 2 - 5 - i * 4.2 - 2, end + 30, RWY.z + RWY.width / 2 - 5 - i * 4.2, y + 0.05, 0xf4f4f0);
      }
    }
    rect(APRON.x0, APRON.z0, APRON.x1, APRON.z1, y + 0.03, 0xc9c4b8); // apron
    rect(TAXI.x0, TAXI.z0, TAXI.x1, TAXI.z1, y + 0.025, 0x55585f); // taxiway
    rect((TAXI.x0 + TAXI.x1) / 2 - 0.4, TAXI.z0, (TAXI.x0 + TAXI.x1) / 2 + 0.4, TAXI.z1, y + 0.05, 0xf2c94c);
    rect(TAXI.x0, TAXI.z1 - 4, TAXI.x1, TAXI.z1 - 3, y + 0.05, 0xf2c94c); // hold short
    rect(APRON.x0 + 5, APRON.z0 + 8, APRON.x1 - 5, APRON.z0 + 8.8, y + 0.05, 0xf2c94c); // apron taxi line
    for (const s of STANDS) {
      rect(s.x - 0.4, APRON.z0 + 8, s.x + 0.4, s.z + 10, y + 0.05, 0xf2c94c); // lead-in line
      rect(s.x - 5, s.z - 1, s.x + 5, s.z - 0.2, y + 0.05, 0xf2c94c); // stop bar
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
    try {
      ctx.env.patchMaterial?.(mat, 'road');
    } catch {
      /* optional */
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'temp-airfield';
    this.group.add(mesh);
    this.group.name = 'temp-airfield';
    engine.scene.add(this.group);

    this.info = {
      runways: [{ a: new THREE.Vector3(L(RWY.x0), y, Z(RWY.z)), b: new THREE.Vector3(L(RWY.x1), y, Z(RWY.z)), width: RWY.width }],
      stands: STANDS.map((s) => ({ type: s.type, p: new THREE.Vector3(L(s.x), y, Z(s.z)), yaw: Math.PI })),
      elevation: y,
      temp: true,
    };
  }

  dispose(): void {
    this.ctx.physics.removeBody(this.body);
    this.ctx.engine.scene.remove(this.group);
    disposeObject(this.group);
  }
}
