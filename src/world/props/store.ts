import * as THREE from 'three';

/** Item flags. */
export const F = {
  MOVED: 1, // rendered from pos/quat instead of the base matrix (lives in movedList)
  DISTURBED: 2, // knocked significantly from its spot (IProps.isDisturbed)
  TOPPLED: 4, // heavy prop snapped (now dynamic, lamp dark)
  GLASS: 8, // parked car windows shattered
  HIDDEN: 16, // thinned by density / unknown kind
  ACTIVE: 32, // has a physics record
} as const;

/**
 * Structure-of-arrays store of every placed item (owner: props). Items [0, nProps) map 1:1 to CityData.props
 * (so isDisturbed(propIndex) is a direct lookup); parked cars follow.
 */
export class ItemStore {
  n = 0;
  nProps = 0;
  kind!: Int16Array;
  flags!: Uint8Array;
  pos!: Float32Array; // current position (3n)
  quat!: Float32Array; // current rotation (4n)
  scale!: Float32Array;
  basePos!: Float32Array; // original position (3n)
  baseYaw!: Float32Array;
  mat!: Float32Array; // base matrix (16n)
  tint!: Float32Array; // instance tint (3n)
  inst!: Float32Array; // shader params (4n): x phase, y glass, z lit, w soot (props) | car: x glass, y soot, z halfLen, w lights
  hash!: Float32Array; // deterministic thinning value
  rec!: Int32Array; // physics record index or -1
  slotB!: Int16Array; // render batch of the last cull
  slot!: Int32Array;
  slotGen!: Uint32Array;
  awayT!: Float32Array;
  movedList: number[] = [];

  // grid (CSR) over base positions
  cell = 32;
  gx0 = 0;
  gz0 = 0;
  gw = 1;
  gh = 1;
  cellStart!: Int32Array;
  cellItems!: Int32Array;
  cellY!: Float32Array;

  alloc(n: number): void {
    this.n = n;
    this.kind = new Int16Array(n).fill(-1);
    this.flags = new Uint8Array(n);
    this.pos = new Float32Array(n * 3);
    this.quat = new Float32Array(n * 4);
    this.scale = new Float32Array(n).fill(1);
    this.basePos = new Float32Array(n * 3);
    this.baseYaw = new Float32Array(n);
    this.mat = new Float32Array(n * 16);
    this.tint = new Float32Array(n * 3).fill(1);
    this.inst = new Float32Array(n * 4);
    this.hash = new Float32Array(n);
    this.rec = new Int32Array(n).fill(-1);
    this.slotB = new Int16Array(n).fill(-1);
    this.slot = new Int32Array(n).fill(-1);
    this.slotGen = new Uint32Array(n);
    this.awayT = new Float32Array(n);
    this.movedList = [];
  }

  private static _m = new THREE.Matrix4();
  private static _p = new THREE.Vector3();
  private static _q = new THREE.Quaternion();
  private static _s = new THREE.Vector3();
  private static _y = new THREE.Vector3(0, 1, 0);

  setBase(i: number, x: number, y: number, z: number, yaw: number, scale: number): void {
    const b = i * 3;
    this.basePos[b] = this.pos[b] = x;
    this.basePos[b + 1] = this.pos[b + 1] = y;
    this.basePos[b + 2] = this.pos[b + 2] = z;
    this.baseYaw[i] = yaw;
    this.scale[i] = scale;
    const q = ItemStore._q.setFromAxisAngle(ItemStore._y, yaw);
    q.toArray(this.quat, i * 4);
    ItemStore._m.compose(ItemStore._p.set(x, y, z), q, ItemStore._s.set(scale, scale, scale)).toArray(this.mat, i * 16);
  }

  /** Restore pos/quat to the base pose. */
  restore(i: number): void {
    const b = i * 3;
    this.pos[b] = this.basePos[b];
    this.pos[b + 1] = this.basePos[b + 1];
    this.pos[b + 2] = this.basePos[b + 2];
    ItemStore._q.setFromAxisAngle(ItemStore._y, this.baseYaw[i]).toArray(this.quat, i * 4);
  }

  markMoved(i: number): void {
    if (this.flags[i] & F.MOVED) return;
    this.flags[i] |= F.MOVED;
    this.movedList.push(i);
  }

  unmarkMoved(i: number): void {
    if (!(this.flags[i] & F.MOVED)) return;
    this.flags[i] &= ~F.MOVED;
    const k = this.movedList.indexOf(i);
    if (k >= 0) {
      this.movedList[k] = this.movedList[this.movedList.length - 1];
      this.movedList.pop();
    }
  }

  /** Displacement of the current pose from the base: [metres, radians of tilt/turn]. */
  displacement(i: number): [number, number] {
    const b = i * 3;
    const d = Math.hypot(this.pos[b] - this.basePos[b], this.pos[b + 1] - this.basePos[b + 1], this.pos[b + 2] - this.basePos[b + 2]);
    const q = ItemStore._q.fromArray(this.quat, i * 4);
    const yaw = this.baseYaw[i];
    // angle between current rotation and base yaw rotation
    const bw = Math.cos(yaw / 2), by = Math.sin(yaw / 2);
    const dot = Math.abs(q.w * bw + q.y * by);
    return [d, 2 * Math.acos(Math.min(1, dot))];
  }

  buildGrid(cell = 32): void {
    this.cell = cell;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < this.n; i++) {
      const x = this.basePos[i * 3], z = this.basePos[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minX)) minX = minZ = maxX = maxZ = 0;
    this.gx0 = minX - cell;
    this.gz0 = minZ - cell;
    this.gw = Math.max(1, Math.ceil((maxX - this.gx0) / cell) + 2);
    this.gh = Math.max(1, Math.ceil((maxZ - this.gz0) / cell) + 2);
    const nc = this.gw * this.gh;
    const counts = new Int32Array(nc + 1);
    const cellOf = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const c = this.cellIndex(this.basePos[i * 3], this.basePos[i * 3 + 2]);
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < nc; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.cellItems = new Int32Array(this.n);
    const fill = counts.slice(0, nc);
    const ySum = new Float32Array(nc);
    for (let i = 0; i < this.n; i++) {
      const c = cellOf[i];
      this.cellItems[fill[c]++] = i;
      ySum[c] += this.basePos[i * 3 + 1];
    }
    this.cellY = new Float32Array(nc);
    for (let c = 0; c < nc; c++) {
      const k = counts[c + 1] - counts[c];
      this.cellY[c] = k ? ySum[c] / k : 0;
    }
  }

  cellIndex(x: number, z: number): number {
    const cx = Math.min(this.gw - 1, Math.max(0, Math.floor((x - this.gx0) / this.cell)));
    const cz = Math.min(this.gh - 1, Math.max(0, Math.floor((z - this.gz0) / this.cell)));
    return cz * this.gw + cx;
  }

  /** Visit every item whose base cell intersects the square around (x, z) of half size r. */
  forEachNear(x: number, z: number, r: number, fn: (i: number) => void): void {
    const c = this.cell;
    const x0 = Math.max(0, Math.floor((x - r - this.gx0) / c));
    const x1 = Math.min(this.gw - 1, Math.floor((x + r - this.gx0) / c));
    const z0 = Math.max(0, Math.floor((z - r - this.gz0) / c));
    const z1 = Math.min(this.gh - 1, Math.floor((z + r - this.gz0) / c));
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const ci = cz * this.gw + cx;
        for (let k = this.cellStart[ci]; k < this.cellStart[ci + 1]; k++) fn(this.cellItems[k]);
      }
    }
  }

  /** Floating origin: move every cached world-space position by -(dx, dz). */
  shift(dx: number, dz: number): void {
    for (let i = 0; i < this.n; i++) {
      this.pos[i * 3] -= dx;
      this.pos[i * 3 + 2] -= dz;
      this.basePos[i * 3] -= dx;
      this.basePos[i * 3 + 2] -= dz;
      this.mat[i * 16 + 12] -= dx;
      this.mat[i * 16 + 14] -= dz;
    }
    this.gx0 -= dx;
    this.gz0 -= dz;
  }
}
