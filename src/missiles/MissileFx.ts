import * as THREE from 'three';
import { GLOBAL_UNIFORMS } from '../core/uniforms';

/**
 * Missile exhaust (user request: "the fire behind the missile is too buggy — the missile is way faster than a plane,
 * the particles do not generate fast enough"). Particles spawned per frame leave a dotted line of blobs behind a
 * 500 m/s missile (8+ m between frames), and more particles cost frames. Instead, per missile:
 *  - a FLAME: one camera-facing quad stretched along the missile axis (shader flame: white core → orange tip,
 *    flickering with time), plus a round glow at the nozzle for the view from straight behind;
 *  - a SMOKE RIBBON: one camera-facing triangle strip through the path the missile actually flew (a point every few
 *    metres, with its time), widening, drifting and fading with age. Continuous at any speed / frame rate; one draw
 *    call. The whole path is kept, so the crash replay can draw the trail exactly as it was at any moment (replayAt).
 */

const N = 192; // vertices pairs drawn per ribbon at most
const MAX_PTS = 2400; // path points kept per missile (≈ 40 s of flight)
const KEEP_S = 45; // a finished trail stays (hidden once faded) for the replay this long

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _p3 = new THREE.Vector3();

export interface MissileTrail {
  readonly id: number;
}

interface Trail extends MissileTrail {
  owner: THREE.Object3D;
  nozzleZ: number; // local z of the nozzle on the missile
  flame: THREE.Mesh;
  flameMat: THREE.ShaderMaterial;
  glow: THREE.Sprite;
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  pos: Float32Array;
  col: Float32Array;
  // the path: positions (LOCAL coords, shifted with the floating origin), fx time, drift velocity
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  pt: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  dz: Float32Array;
  n: number;
  t0: number; // fx time it ignited
  endT: number; // fx time it ended (Infinity while flying)
  w0: number; // smoke width at the nozzle (m)
  grow: number; // smoke widening (m / √s)
  life: number; // s a bit of smoke lasts
  seg: number; // m between path points
}

let flameGeo: THREE.BufferGeometry | null = null;
let smokeAlpha: THREE.Texture | null = null;
let glowTex: THREE.Texture | null = null;

/** The flame quad: aAlong 0 (nozzle) → 1 (tip), aSide -1 → 1, 8 rows so the outline can bulge. */
function getFlameGeo(): THREE.BufferGeometry {
  if (flameGeo) return flameGeo;
  const rows = 8;
  const along: number[] = [], side: number[] = [], idx: number[] = [], pos: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (const s of [-1, 1]) {
      along.push(r / rows);
      side.push(s);
      pos.push(0, 0, 0);
    }
    if (r < rows) {
      const i = r * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  return (flameGeo = g);
}

function getSmokeAlpha(): THREE.Texture {
  if (smokeAlpha) return smokeAlpha;
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, 'rgba(0,0,0,1)');
  grd.addColorStop(0.3, 'rgba(150,150,150,1)');
  grd.addColorStop(0.5, 'rgba(255,255,255,1)');
  grd.addColorStop(0.7, 'rgba(150,150,150,1)');
  grd.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 64);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.RepeatWrapping;
  return (smokeAlpha = t);
}

function getGlowTex(): THREE.Texture {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,245,1)');
  grd.addColorStop(0.3, 'rgba(255,220,140,0.85)');
  grd.addColorStop(0.65, 'rgba(255,130,50,0.25)');
  grd.addColorStop(1, 'rgba(255,90,30,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return (glowTex = t);
}

const FLAME_VS = /* glsl */ `
attribute float aAlong;
attribute float aSide;
uniform float uLen;
uniform float uWidth;
uniform float uNozzle;
uniform float uTime;
uniform float uSeed;
varying vec2 vUv;
void main() {
  // the missile's axis and nozzle in world space; the quad is stretched backwards along the axis and turned to face
  // the camera around it (an axial billboard)
  vec3 axis = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 nozzle = (modelMatrix * vec4(0.0, 0.0, uNozzle, 1.0)).xyz;
  float flick = 1.0 + 0.10 * sin(uTime * 47.0 + uSeed) + 0.07 * sin(uTime * 83.0 + uSeed * 2.3);
  vec3 p = nozzle - axis * (aAlong * uLen * flick);
  vec3 toCam = normalize(cameraPosition - p);
  vec3 side = cross(axis, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // outline: from the nozzle width it bulges a little, then tapers to a point
  float w = uWidth * (0.75 + 0.6 * sin(min(1.0, aAlong * 1.6 + 0.25) * 3.14159)) * (1.0 - aAlong * 0.92);
  p += side * aSide * w;
  vUv = vec2(aAlong, aSide);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FLAME_FS = /* glsl */ `
uniform float uTime;
uniform float uSeed;
uniform float uHeat;
varying vec2 vUv;
void main() {
  float a = vUv.x;
  float s = abs(vUv.y);
  // a hot core near the axis, soft edges, fading to nothing at the tip, a quick shimmer travelling backwards
  float edge = 1.0 - smoothstep(0.25, 1.0, s);
  float core = 1.0 - smoothstep(0.0, 0.45, s + a * 0.6);
  float tip = 1.0 - smoothstep(0.35, 1.0, a);
  float shimmer = 0.82 + 0.18 * sin(a * 26.0 - uTime * 70.0 + uSeed);
  vec3 col = mix(vec3(1.0, 0.62, 0.22), vec3(1.0, 0.86, 0.5), core);
  col = mix(col, vec3(1.0, 0.98, 0.9), core * (1.0 - a));
  float alpha = edge * tip * shimmer * uHeat;
  gl_FragColor = vec4(col * alpha, alpha);
}`;

export class MissileFx {
  private trails: Trail[] = [];
  private seq = 0;
  private playing: number | null = null; // replay: the fx time being shown (null = live)

  constructor(private scene: THREE.Scene) {}

  /** Light the motor: flame + nozzle glow on the missile, a smoke ribbon in the world. */
  start(owner: THREE.Object3D, len: number, radius: number, now: number, nuke: boolean): MissileTrail {
    const nozzleZ = -len * 0.5;
    const flameMat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VS,
      fragmentShader: FLAME_FS,
      uniforms: {
        uLen: { value: Math.max(1.6, len * (nuke ? 1.1 : 0.85)) },
        uWidth: { value: Math.max(0.22, radius * 1.15) },
        uNozzle: { value: nozzleZ },
        uTime: GLOBAL_UNIFORMS.uTime,
        uSeed: { value: Math.random() * 100 },
        uHeat: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const flame = new THREE.Mesh(getFlameGeo(), flameMat);
    flame.name = 'missile-flame';
    flame.frustumCulled = false;
    flame.renderOrder = 7;
    owner.add(flame);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTex(), color: 0xffb070, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    glow.name = 'missile-nozzle';
    glow.position.z = nozzleZ - radius * 0.6;
    const gs = Math.max(0.6, radius * 3.2);
    glow.scale.set(gs, gs, 1);
    glow.renderOrder = 7;
    owner.add(glow);

    const pos = new Float32Array(N * 2 * 3);
    const col = new Float32Array(N * 2 * 4);
    const uv = new Float32Array(N * 2 * 2);
    for (let i = 0; i < N; i++) {
      uv[i * 4] = uv[i * 4 + 2] = i / 8;
      uv[i * 4 + 1] = 0;
      uv[i * 4 + 3] = 1;
    }
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, alphaMap: getSmokeAlpha(), side: THREE.DoubleSide }),
    );
    mesh.name = 'missile-smoke';
    mesh.frustumCulled = false;
    mesh.userData.noOriginShift = true; // rebuilt every frame from the path (which the origin shift moves)
    this.scene.add(mesh);

    const k = Math.min(3, Math.max(0.6, radius / 0.3));
    const tr: Trail = {
      id: ++this.seq, owner, nozzleZ, flame, flameMat, glow, mesh, geo, pos, col,
      px: new Float32Array(MAX_PTS), py: new Float32Array(MAX_PTS), pz: new Float32Array(MAX_PTS), pt: new Float32Array(MAX_PTS),
      dx: new Float32Array(MAX_PTS), dy: new Float32Array(MAX_PTS), dz: new Float32Array(MAX_PTS),
      n: 0, t0: now, endT: Infinity,
      w0: 0.5 * k, grow: (nuke ? 5 : 3.2) * k, life: nuke ? 5 : 3.2, seg: 3,
    };
    this.trails.push(tr);
    return tr;
  }

  /** The motor burnt out / the missile went off: the flame goes, the smoke stays and fades. */
  end(h: MissileTrail | null, now: number): void {
    const tr = this.trails.find((x) => x === h);
    if (!tr || tr.endT !== Infinity) return;
    tr.endT = now;
    tr.flame.visible = false;
    tr.glow.visible = false;
  }

  /** Live frame: record where each motor is, then draw every ribbon for the camera. */
  update(now: number, cam: THREE.Camera): void {
    if (this.playing !== null) return;
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const tr = this.trails[i];
      if (tr.endT === Infinity && tr.owner.parent) this.record(tr, now);
      if (now - tr.endT > KEEP_S) {
        this.dispose(tr);
        this.trails.splice(i, 1);
        continue;
      }
      const night = GLOBAL_UNIFORMS.uNight.value;
      tr.flameMat.uniforms.uHeat.value = 1 + 0.25 * night;
      this.draw(tr, now, cam, tr.endT === Infinity && tr.owner.parent ? this.nozzle(tr, _d) : null);
    }
  }

  /** Crash replay: show every trail as it was at fx time t (null = back to live). */
  replayAt(t: number | null, cam: THREE.Camera): void {
    this.playing = t;
    if (t === null) return;
    for (const tr of this.trails) {
      // the motor burning at t (the replay poses the missile objects; their flame is a child)
      const burning = t >= tr.t0 && t < tr.endT && tr.owner.visible;
      tr.flame.visible = burning;
      tr.glow.visible = burning;
      this.draw(tr, t, cam, burning && tr.owner.parent ? this.nozzle(tr, _d) : null);
    }
  }

  /** The replay is over: flames back to how they are live. */
  live(): void {
    this.playing = null;
    for (const tr of this.trails) {
      const on = tr.endT === Infinity;
      tr.flame.visible = on;
      tr.glow.visible = on;
    }
  }

  shift(dx: number, dz: number): void {
    for (const tr of this.trails) {
      for (let i = 0; i < tr.n; i++) {
        tr.px[i] -= dx;
        tr.pz[i] -= dz;
      }
    }
  }

  clear(): void {
    for (const tr of this.trails) this.dispose(tr);
    this.trails = [];
  }

  private nozzle(tr: Trail, out: THREE.Vector3): THREE.Vector3 {
    tr.owner.updateWorldMatrix(true, false);
    return out.set(0, 0, tr.nozzleZ).applyMatrix4(tr.owner.matrixWorld);
  }

  private record(tr: Trail, now: number): void {
    const p = this.nozzle(tr, _a);
    const n = tr.n;
    if (n > 0) {
      const i = n - 1;
      const dd = (p.x - tr.px[i]) ** 2 + (p.y - tr.py[i]) ** 2 + (p.z - tr.pz[i]) ** 2;
      if (dd < tr.seg * tr.seg && now - tr.pt[i] < 0.05) return;
    }
    if (n >= MAX_PTS) return; // 40 s of flight: the rest is not recorded (the motor is long out by then)
    tr.px[n] = p.x;
    tr.py[n] = p.y;
    tr.pz[n] = p.z;
    tr.pt[n] = now;
    // each bit of smoke drifts its own way (no perfect tube), rising a little
    tr.dx[n] = (Math.random() * 2 - 1) * 1.6;
    tr.dy[n] = 0.4 + Math.random() * 0.8;
    tr.dz[n] = (Math.random() * 2 - 1) * 1.6;
    tr.n = n + 1;
  }

  /** Build the ribbon at time t: newest point first (optionally the live nozzle), back until the smoke has faded. */
  private draw(tr: Trail, t: number, cam: THREE.Camera, head: THREE.Vector3 | null): void {
    // the newest recorded point at or before t
    let hi = tr.n - 1;
    if (hi >= 0 && tr.pt[hi] > t) {
      let lo = 0;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tr.pt[mid] <= t) lo = mid;
        else hi = mid - 1;
      }
      hi = tr.pt[lo] <= t ? lo : -1;
    }
    if (hi < 0) {
      tr.mesh.visible = false;
      return;
    }
    // how many points are still visible, and the stride that fits them in N
    let lo = hi;
    while (lo > 0 && t - tr.pt[lo - 1] < tr.life) lo--;
    const avail = hi - lo + 1;
    const room = N - (head ? 1 : 0);
    const stride = Math.max(1, Math.ceil(avail / room));
    this.shade = 0.88 - 0.55 * GLOBAL_UNIFORMS.uNight.value; // white smoke by day, grey-blue at night
    this.v = 0;
    if (head) {
      this.at(tr, hi, t, _p1);
      this.put(tr, cam, head.x, head.y, head.z, 0, head.x - _p1.x, head.y - _p1.y, head.z - _p1.z);
    }
    for (let i = hi; i >= lo && this.v < N; i -= stride) {
      this.at(tr, i, t, _p1);
      if (head && i === hi) _p2.copy(head);
      else this.at(tr, Math.min(hi, i + stride), t, _p2);
      this.at(tr, Math.max(lo, i - stride), t, _p3);
      this.put(tr, cam, _p1.x, _p1.y, _p1.z, t - tr.pt[i], _p2.x - _p3.x, _p2.y - _p3.y, _p2.z - _p3.z);
    }
    const v = this.v;
    if (v < 2) {
      tr.mesh.visible = false;
      return;
    }
    tr.mesh.visible = true;
    tr.geo.setDrawRange(0, (v - 1) * 6);
    (tr.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (tr.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  private shade = 0.88;
  private v = 0;

  /** A path point at time t, with its drift. */
  private at(tr: Trail, i: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    const age = Math.max(0, t - tr.pt[i]);
    return out.set(tr.px[i] + tr.dx[i] * age, tr.py[i] + tr.dy[i] * age, tr.pz[i] + tr.dz[i] * age);
  }

  /** One cross-section of the ribbon: two vertices, camera-facing across the strip direction (nx, ny, nz). */
  private put(tr: Trail, cam: THREE.Camera, x: number, y: number, z: number, age: number, nx: number, ny: number, nz: number): void {
    const cp = cam.position;
    _b.set(nx, ny, nz);
    _c.set(cp.x - x, cp.y - y, cp.z - z);
    _a.crossVectors(_b, _c);
    const l = _a.length();
    if (l < 1e-6) _a.set(0, 1, 0);
    else _a.multiplyScalar(1 / l);
    const w = (tr.w0 + tr.grow * Math.sqrt(Math.max(0, age))) * 0.5;
    const v = this.v;
    const o = v * 6;
    tr.pos[o] = x + _a.x * w;
    tr.pos[o + 1] = y + _a.y * w;
    tr.pos[o + 2] = z + _a.z * w;
    tr.pos[o + 3] = x - _a.x * w;
    tr.pos[o + 4] = y - _a.y * w;
    tr.pos[o + 5] = z - _a.z * w;
    // colour: hot orange right at the nozzle, white smoke within a tenth of a second; fading out with age
    const sh = this.shade;
    const hot = Math.max(0, 1 - age / 0.1);
    const fade = Math.pow(Math.max(0, 1 - age / tr.life), 1.6);
    const fadeIn = Math.min(1, age / 0.03 + 0.15);
    const c = v * 8;
    tr.col[c] = tr.col[c + 4] = sh + (1 - sh) * hot;
    tr.col[c + 1] = tr.col[c + 5] = sh + (0.72 - sh) * hot;
    tr.col[c + 2] = tr.col[c + 6] = sh + (0.4 - sh) * hot;
    tr.col[c + 3] = tr.col[c + 7] = 0.62 * fade * fadeIn;
    this.v = v + 1;
  }

  private dispose(tr: Trail): void {
    tr.flame.removeFromParent();
    tr.flameMat.dispose();
    tr.glow.removeFromParent();
    (tr.glow.material as THREE.SpriteMaterial).dispose();
    tr.mesh.removeFromParent();
    tr.geo.dispose();
    (tr.mesh.material as THREE.Material).dispose();
  }
}
