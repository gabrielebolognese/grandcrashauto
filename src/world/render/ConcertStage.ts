import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import type { GameContext } from '../../game/contracts';
import type { ConcertData } from '../types';
import { StageParts } from './StageParts';

/**
 * Beach concert dressing on top of the solid stage (CityGen.concertGrounds): animated LED wall, sweeping light beams,
 * lamp fixtures + hanging line arrays, festival banner. Everything animates in shaders off GLOBAL_UNIFORMS.uTime
 * (zero per-frame CPU apart from a distance check) and glows brighter at night. No real lights (light budget).
 * 4 draw calls, hidden beyond `hideDist`.
 */
export class ConcertStage {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];
  private hideDist = 1400;
  /** Breakable stage structure (deck, wall, trusses, roof, speakers, barrier). */
  readonly parts: StageParts | null = null;
  private powerOff = { value: 0 };
  private last = performance.now();

  constructor(c: ConcertData, ctx?: GameContext) {
    const st = c.stage;
    const g = this.group;
    g.name = 'world-concert';
    g.position.set(st.x, 0, st.z);
    g.rotation.y = st.yaw; // local +Z = toward the crowd, local x = across the stage
    const back = -st.d / 2;
    const front = st.d / 2;

    // ── LED wall ──
    const screenGeo = new THREE.PlaneGeometry(c.screen.w, c.screen.h);
    const screenMat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: GLOBAL_UNIFORMS.uTime, uNight: GLOBAL_UNIFORMS.uNight, uAspect: { value: c.screen.w / c.screen.h }, uOff: this.powerOff },
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform float uNight;
        uniform float uAspect;
        uniform float uOff;
        varying vec2 vUv;
        vec3 pal(float t) { return 0.55 + 0.45 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + t)); }
        void main() {
          vec2 uv = vUv;
          float t = uTime;
          float beat = pow(0.5 + 0.5 * cos(t * 12.566), 6.0); // 120 bpm
          float scene = mod(floor(t / 7.0), 4.0);
          vec3 col;
          if (scene < 0.5) {
            float bx = floor(uv.x * 26.0);
            float h = 0.18 + 0.62 * abs(sin(t * 3.1 + bx * 0.7) * sin(t * 1.3 + bx * 1.9)) + beat * 0.18;
            col = mix(vec3(0.05, 0.03, 0.12), pal(uv.y * 0.7 + t * 0.05), step(uv.y, h));
          } else if (scene < 1.5) {
            vec2 cc = (uv - 0.5) * vec2(uAspect, 1.0);
            float r = length(cc);
            col = pal(r * 0.4 - t * 0.2) * (0.25 + 0.75 * (0.5 + 0.5 * sin(r * 16.0 - t * 9.0))) * (0.7 + 0.5 * beat);
          } else if (scene < 2.5) {
            float s = step(0.5, fract((uv.x * uAspect + uv.y) * 2.2 - t * 1.1));
            col = mix(vec3(1.0, 0.48, 0.42), vec3(0.36, 0.78, 0.84), s) * (0.55 + 0.6 * beat);
          } else {
            // sun over the sea: synthwave horizon
            vec2 cc = (uv - vec2(0.5, 0.42)) * vec2(uAspect, 1.0);
            float sun = smoothstep(0.36, 0.34, length(cc)) * step(0.42, uv.y) * step(0.5, fract(uv.y * 14.0 - t * 0.4) + smoothstep(0.42, 0.8, uv.y));
            vec3 sky = mix(vec3(0.95, 0.4, 0.55), vec3(0.25, 0.12, 0.45), uv.y);
            float gl = step(uv.y, 0.42) * (step(0.92, fract(uv.y * 30.0 + t * 1.5)) + step(0.94, fract((uv.x - 0.5) / max(0.05, 0.45 - uv.y) * 2.0)));
            col = mix(sky, vec3(1.0, 0.85, 0.35), sun) + gl * vec3(0.4, 0.9, 1.0);
          }
          vec2 px = fract(uv * vec2(110.0, 50.0)) - 0.5;
          col *= 0.4 + 0.6 * smoothstep(0.5, 0.3, length(px)); // LED pixels
          // stage collapsed: the wall flickers and dies
          if (uOff > 0.0) col *= step(0.6, fract(sin(floor(t * 23.0) * 91.7) * 437.5)) * max(0.0, 1.0 - uOff) + 0.02;
          gl_FragColor = vec4(col * (1.1 + 0.9 * uNight), 1.0);
          #include <fog_fragment>
        }`,
      fog: true,
    });
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, c.screen.y, back + 0.05);
    screen.name = 'concert-screen';
    g.add(screen);
    this.disposables.push(screenGeo, screenMat);

    // ── lamp fixtures (under the roof front + on the back truss) and hanging line arrays ──
    const parts: THREE.BufferGeometry[] = [];
    const lamp = [0xff7a6b, 0xffe39a, 0x5cc8d6, 0xb8a6e8, 0x9ee0c8, 0xffffff];
    const addBox = (x: number, y: number, z: number, w: number, h: number, d: number, hex: number) => {
      const b = new THREE.BoxGeometry(w, h, d).toNonIndexed();
      b.translate(x, y, z);
      const col = new THREE.Color(hex);
      const arr = new Float32Array(b.attributes.position.count * 3);
      for (let i = 0; i < arr.length; i += 3) col.toArray(arr, i);
      b.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      b.deleteAttribute('uv');
      parts.push(b);
    };
    const beamOrigins: THREE.Vector3[] = [];
    for (let i = 0; i < 9; i++) {
      const x = (i - 4) * 2.6;
      addBox(x, 13.6, front - 0.2, 0.7, 0.6, 0.7, lamp[i % lamp.length]);
      if (i % 2 === 0) beamOrigins.push(new THREE.Vector3(x, 13.3, front - 0.2));
      addBox(x * 0.9, 12.9, back + 1.2, 0.5, 0.5, 0.5, lamp[(i + 2) % lamp.length]);
    }
    for (const s of [-1, 1]) {
      addBox(s * (st.w / 2 + 0.3), 9.6, front - 1, 1.3, 5.2, 1.5, 0x22242c); // line array
      addBox(s * (st.w / 2 + 0.3), 9.6, front - 0.24, 1.0, 4.8, 0.05, 0x3a3e4a);
    }
    const fixGeo = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    const fixMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    const fixtures = new THREE.Mesh(fixGeo, fixMat);
    fixtures.name = 'concert-fixtures';
    g.add(fixtures);
    this.disposables.push(fixGeo, fixMat);

    // ── light beams: down-pointing open cones, swept in the vertex shader ──
    const L = 38;
    const cones: THREE.BufferGeometry[] = [];
    const beamCols = [0xff7a6b, 0x5cc8d6, 0xffe39a, 0xb8a6e8, 0x9ee0c8];
    beamOrigins.forEach((o, i) => {
      const cg = new THREE.ConeGeometry(3.4, L, 14, 1, true).toNonIndexed();
      cg.translate(0, -L / 2, 0); // apex at the origin, pointing down
      const n = cg.attributes.position.count;
      const bi = new Float32Array(n).fill(i);
      const org = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      const cc = new THREE.Color(beamCols[i % beamCols.length]);
      for (let k = 0; k < n; k++) {
        o.toArray(org, k * 3);
        cc.toArray(col, k * 3);
      }
      cg.setAttribute('aBeam', new THREE.BufferAttribute(bi, 1));
      cg.setAttribute('aOrigin', new THREE.BufferAttribute(org, 3));
      cg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      cg.deleteAttribute('uv');
      cg.deleteAttribute('normal');
      cones.push(cg);
    });
    const beamGeo = mergeGeometries(cones)!;
    for (const cg of cones) cg.dispose();
    beamGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 8, front + 10), 45);
    const beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: GLOBAL_UNIFORMS.uTime, uNight: GLOBAL_UNIFORMS.uNight, uLen: { value: L } },
      vertexShader: /* glsl */ `
        attribute float aBeam;
        attribute vec3 aOrigin;
        attribute vec3 color;
        uniform float uTime;
        uniform float uLen;
        varying float vT;
        varying vec3 vCol;
        void main() {
          float i = aBeam;
          float t = uTime * (0.55 + 0.06 * i);
          float pitch = -(0.45 + 0.3 * sin(t * 0.9 + i * 1.7)); // tilt toward the crowd (+Z)
          float yw = 0.65 * sin(t + i * 0.8);
          vec3 p = position;
          float cp = cos(pitch), sp = sin(pitch);
          p = vec3(p.x, p.y * cp - p.z * sp, p.y * sp + p.z * cp);
          float cy = cos(yw), sy = sin(yw);
          p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
          vT = clamp(-position.y / uLen, 0.0, 1.0);
          vCol = color;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(aOrigin + p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uNight;
        varying float vT;
        varying vec3 vCol;
        void main() {
          float beat = pow(0.5 + 0.5 * cos(uTime * 12.566), 4.0);
          float a = pow(1.0 - vT, 1.4) * (0.05 + 0.3 * uNight) * (0.75 + 0.35 * beat);
          gl_FragColor = vec4(vCol * a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const beams = new THREE.Mesh(beamGeo, beamMat);
    beams.name = 'concert-beams';
    beams.renderOrder = 5;
    g.add(beams);
    this.disposables.push(beamGeo, beamMat);

    // ── festival banner on the roof front ──
    const cv = document.createElement('canvas');
    cv.width = 1024;
    cv.height = 64;
    const x2 = cv.getContext('2d');
    if (x2) {
      x2.fillStyle = '#ff7a6b';
      x2.fillRect(0, 0, cv.width, cv.height);
      x2.fillStyle = '#fff4e0';
      x2.font = '900 44px "Arial Black", Impact, system-ui, sans-serif';
      x2.textAlign = 'center';
      x2.textBaseline = 'middle';
      x2.fillText('★  GRAND CRASH FEST  ★', cv.width / 2, cv.height / 2 + 2);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const banGeo = new THREE.PlaneGeometry(st.w + 3.2, (st.w + 3.2) / 16);
    const banMat = new THREE.MeshBasicMaterial({ map: tex, fog: true });
    const banner = new THREE.Mesh(banGeo, banMat);
    banner.position.set(0, 14.8, front + 1.02);
    banner.name = 'concert-banner';
    g.add(banner);
    this.disposables.push(banGeo, banMat, tex);

    // ── breakable structure (user request) ──
    if (ctx && c.parts?.length) {
      const parts = new StageParts(ctx, c.parts, g);
      (this as { parts: StageParts | null }).parts = parts;
      parts.ride(screen, 'wall');
      parts.ride(fixtures, 'roof');
      parts.ride(banner, 'roof');
      parts.onBroken(() => {
        beams.visible = false; // the light show dies with the power
        this.powerOff.value = 0.001;
      });
    }
  }

  /** Per frame: hide the whole dressing when the camera is far (cam in LOCAL coordinates). */
  update(cam: THREE.Vector3): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.parts?.update(dt);
    if (this.powerOff.value > 0) this.powerOff.value = Math.min(1, this.powerOff.value + dt / 2.5);
    const p = this.group.position;
    const o = this.group.parent?.position; // world root (shifted with the floating origin)
    this.group.visible = Math.hypot(cam.x - p.x - (o?.x ?? 0), cam.z - p.z - (o?.z ?? 0)) < this.hideDist;
  }

  /** Floating origin: the group lives under the world root (shifted with it); nothing cached here. */
  dispose(): void {
    this.parts?.dispose();
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
