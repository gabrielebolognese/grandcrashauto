import * as THREE from 'three';
import type { BoxPart, RoofPart, TankPart } from '../gen/model';
import { createFacadeMaterial, createRoofMaterial } from './materials';

/**
 * All buildings as 3 instanced meshes (facade boxes, gable roofs, rooftop tanks). Instances are grouped per 100 m
 * chunk; the visible set (loaded chunks + all towers for the skyline) is re-packed when streaming changes, sorted
 * front-to-back around the focus to help early-z (facade shader is the most expensive fragment work in the city).
 */
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const tmpC = new THREE.Color();

interface Packed {
  m: Float32Array; // 16 per instance
  c: Float32Array; // 3
  st: Float32Array; // 4
  ex: Float32Array; // 4
  ac: Float32Array; // 3
  cx: Float32Array; // centre x (sorting)
  cz: Float32Array;
  tower: Uint8Array;
  count: number;
}

const chunkKeyOf = (x: number, z: number, cs: number) => `${Math.floor(x / cs)},${Math.floor(z / cs)}`;

export class BuildingRenderer {
  readonly group = new THREE.Group();
  readonly boxMesh: THREE.InstancedMesh;
  readonly roofMesh: THREE.InstancedMesh;
  readonly tankMesh: THREE.InstancedMesh;
  readonly facade: THREE.MeshStandardMaterial;
  readonly roofMat: THREE.MeshStandardMaterial;
  readonly tankMat: THREE.MeshStandardMaterial;
  private boxChunks = new Map<string, Packed>();
  private roofChunks = new Map<string, { m: Float32Array; c: Float32Array; count: number }>();
  private tankChunks = new Map<string, { m: Float32Array; c: Float32Array; count: number }>();
  private towerKeys = new Set<string>();
  private order: Int32Array;
  private dist: Float32Array;
  /** Detail level: 0 full, 1 = skip small parts (high altitude). */
  detail = 0;

  constructor(parts: BoxPart[], roofs: RoofPart[], tanks: TankPart[], private chunkSize: number, facade?: THREE.Material, roofMat?: THREE.Material, tankMat?: THREE.Material) {
    this.facade = (facade as THREE.MeshStandardMaterial) ?? createFacadeMaterial();
    this.roofMat = (roofMat as THREE.MeshStandardMaterial) ?? createRoofMaterial();
    this.tankMat = (tankMat as THREE.MeshStandardMaterial) ?? new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.boxMesh = new THREE.InstancedMesh(boxGeo, this.facade, Math.max(1, parts.length));
    const nb = Math.max(1, parts.length);
    boxGeo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(new Float32Array(nb * 4), 4));
    boxGeo.setAttribute('aExtra', new THREE.InstancedBufferAttribute(new Float32Array(nb * 4), 4));
    boxGeo.setAttribute('aAccent', new THREE.InstancedBufferAttribute(new Float32Array(nb * 3), 3));
    this.boxMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nb * 3), 3);
    this.order = new Int32Array(nb);
    this.dist = new Float32Array(nb);

    // pack box parts per chunk
    const byChunk = new Map<string, BoxPart[]>();
    for (const p of parts) {
      const k = chunkKeyOf(p.cx, p.cz, chunkSize);
      let a = byChunk.get(k);
      if (!a) byChunk.set(k, (a = []));
      a.push(p);
    }
    for (const [k, list] of byChunk) {
      const n = list.length;
      const pk: Packed = { m: new Float32Array(n * 16), c: new Float32Array(n * 3), st: new Float32Array(n * 4), ex: new Float32Array(n * 4), ac: new Float32Array(n * 3), cx: new Float32Array(n), cz: new Float32Array(n), tower: new Uint8Array(n), count: n };
      list.forEach((p, i) => {
        tmpQ.setFromAxisAngle(UP, p.yaw);
        tmpM.compose(tmpP.set(p.cx, p.y, p.cz), tmpQ, tmpS.set(p.w, p.h, p.d));
        tmpM.toArray(pk.m, i * 16);
        tmpC.setHex(p.color);
        pk.c.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
        tmpC.setHex(p.accent);
        pk.ac.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
        pk.st.set([p.style, p.seed, p.floorH, p.baseOff], i * 4);
        pk.ex.set([p.groundH, p.lit, p.tower ? 1 : 0, 0], i * 4);
        pk.cx[i] = p.cx;
        pk.cz[i] = p.cz;
        pk.tower[i] = p.tower ? 1 : 0;
        if (p.tower) this.towerKeys.add(k);
      });
      this.boxChunks.set(k, pk);
    }

    // gable roofs: triangular prism, ridge along local X, base y=0..1
    const roofGeo = gableGeometry();
    this.roofMesh = new THREE.InstancedMesh(roofGeo, this.roofMat, Math.max(1, roofs.length));
    this.roofMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, roofs.length) * 3), 3);
    const rb = new Map<string, RoofPart[]>();
    for (const r of roofs) {
      const k = chunkKeyOf(r.cx, r.cz, chunkSize);
      let a = rb.get(k);
      if (!a) rb.set(k, (a = []));
      a.push(r);
    }
    for (const [k, list] of rb) {
      const m = new Float32Array(list.length * 16), c = new Float32Array(list.length * 3);
      list.forEach((r, i) => {
        tmpQ.setFromAxisAngle(UP, r.yaw);
        tmpM.compose(tmpP.set(r.cx, r.y, r.cz), tmpQ, tmpS.set(r.w, r.h, r.d)).toArray(m, i * 16);
        tmpC.setHex(r.color);
        c.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      });
      this.roofChunks.set(k, { m, c, count: list.length });
    }

    const tankGeo = tankGeometry();
    this.tankMesh = new THREE.InstancedMesh(tankGeo, this.tankMat, Math.max(1, tanks.length));
    this.tankMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, tanks.length) * 3), 3);
    const tb = new Map<string, TankPart[]>();
    for (const t of tanks) {
      const k = chunkKeyOf(t.cx, t.cz, chunkSize);
      let a = tb.get(k);
      if (!a) tb.set(k, (a = []));
      a.push(t);
    }
    for (const [k, list] of tb) {
      const m = new Float32Array(list.length * 16), c = new Float32Array(list.length * 3);
      list.forEach((t, i) => {
        tmpM.compose(tmpP.set(t.cx, t.y, t.cz), tmpQ.identity(), tmpS.set(t.r, t.h, t.r)).toArray(m, i * 16);
        tmpC.setHex(t.color);
        c.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
      });
      this.tankChunks.set(k, { m, c, count: list.length });
    }

    for (const mesh of [this.boxMesh, this.roofMesh, this.tankMesh]) {
      mesh.count = 0;
      mesh.frustumCulled = false; // spans the whole city; culling per instance is not worth it
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  /** Re-pack visible instances: chunks in `loaded` (keys "cx,cz") + towers anywhere. focus = absolute x,z. */
  rebuild(loaded: Set<string>, focusX: number, focusZ: number): void {
    const bm = this.boxMesh;
    const geo = bm.geometry;
    const aSt = geo.getAttribute('aStyle') as THREE.InstancedBufferAttribute;
    const aEx = geo.getAttribute('aExtra') as THREE.InstancedBufferAttribute;
    const aAc = geo.getAttribute('aAccent') as THREE.InstancedBufferAttribute;
    const ic = bm.instanceColor!;
    // gather candidates
    const srcs: { pk: Packed; i: number }[] = [];
    let n = 0;
    for (const [k, pk] of this.boxChunks) {
      const full = loaded.has(k);
      if (!full && !this.towerKeys.has(k)) continue;
      for (let i = 0; i < pk.count; i++) {
        if (!full && !pk.tower[i]) continue;
        if (this.detail > 0 && pk.st[i * 4] === 4 && pk.m[i * 16 + 5] < 3) continue; // tiny trims at altitude
        srcs.push({ pk, i });
        this.dist[n] = (pk.cx[i] - focusX) ** 2 + (pk.cz[i] - focusZ) ** 2;
        this.order[n] = n;
        n++;
      }
    }
    const ord = Array.from(this.order.subarray(0, n)).sort((a, b) => this.dist[a] - this.dist[b]);
    const M = bm.instanceMatrix.array as Float32Array;
    const C = ic.array as Float32Array;
    const S = aSt.array as Float32Array, E = aEx.array as Float32Array, A = aAc.array as Float32Array;
    for (let o = 0; o < n; o++) {
      const { pk, i } = srcs[ord[o]];
      M.set(pk.m.subarray(i * 16, i * 16 + 16), o * 16);
      C.set(pk.c.subarray(i * 3, i * 3 + 3), o * 3);
      S.set(pk.st.subarray(i * 4, i * 4 + 4), o * 4);
      E.set(pk.ex.subarray(i * 4, i * 4 + 4), o * 4);
      A.set(pk.ac.subarray(i * 3, i * 3 + 3), o * 3);
    }
    bm.count = n;
    for (const a of [bm.instanceMatrix, ic, aSt, aEx, aAc]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    this.repackSimple(this.roofMesh, this.roofChunks, loaded);
    this.repackSimple(this.tankMesh, this.tankChunks, loaded, this.detail > 0);
  }

  private repackSimple(mesh: THREE.InstancedMesh, chunks: Map<string, { m: Float32Array; c: Float32Array; count: number }>, loaded: Set<string>, skip = false): void {
    let n = 0;
    const M = mesh.instanceMatrix.array as Float32Array;
    const C = mesh.instanceColor!.array as Float32Array;
    if (!skip)
      for (const [k, ch] of chunks) {
        if (!loaded.has(k)) continue;
        M.set(ch.m, n * 16);
        C.set(ch.c, n * 3);
        n += ch.count;
      }
    mesh.count = n;
    for (const a of [mesh.instanceMatrix, mesh.instanceColor!]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
      a.needsUpdate = true;
    }
  }

  dispose(materials = true): void {
    for (const m of [this.boxMesh, this.roofMesh, this.tankMesh]) {
      m.geometry.dispose();
      m.dispose();
    }
    if (!materials) return;
    this.facade.dispose();
    this.roofMat.dispose();
    this.tankMat.dispose();
  }
}

function gableGeometry(): THREE.BufferGeometry {
  // prism: base rectangle x∈[-.5,.5], z∈[-.5,.5] at y=0, ridge along x at y=1, z=0; flat-shaded faces
  const v: number[] = [];
  const n: number[] = [];
  const push = (a: number[], b: number[], c: number[]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    v.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) n.push(nx, ny, nz);
  };
  const A = [-0.5, 0, -0.5], B = [0.5, 0, -0.5], C = [0.5, 0, 0.5], D = [-0.5, 0, 0.5], R1 = [-0.5, 1, 0], R2 = [0.5, 1, 0];
  // slopes (CCW from outside)
  push(A, R1, R2);
  push(A, R2, B);
  push(D, C, R2);
  push(D, R2, R1);
  // gables
  push(A, D, R1);
  push(B, R2, C);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  return g;
}

function tankGeometry(): THREE.BufferGeometry {
  // water tank on legs: cylinder r=1 (scaled) h=0.75 on top of 0.25 legs + cone cap
  const body = new THREE.CylinderGeometry(1, 1, 0.62, 12, 1).translate(0, 0.25 + 0.31, 0);
  const cap = new THREE.ConeGeometry(1.05, 0.22, 12, 1).translate(0, 0.25 + 0.62 + 0.11, 0);
  const legs = new THREE.BoxGeometry(1.5, 0.25, 0.12).translate(0, 0.125, 0);
  const legs2 = new THREE.BoxGeometry(0.12, 0.25, 1.5).translate(0, 0.125, 0);
  const geos = [body, cap, legs, legs2].map((g) => g.toNonIndexed());
  const pos: number[] = [];
  const nor: number[] = [];
  for (const g of geos) {
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nor.push(...(g.getAttribute('normal').array as Float32Array));
    g.dispose();
  }
  for (const g of [body, cap, legs, legs2]) g.dispose();
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
