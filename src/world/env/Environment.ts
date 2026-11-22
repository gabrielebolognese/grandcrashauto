import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import type { GameContext, IEnvironment } from '../../game/contracts';
import { Clouds } from './Clouds';
import { Ocean } from './Ocean';
import { BloomPost } from './Post';
import { Scenery } from './Scenery';
import { SKY_UNIFORMS } from './shaders';
import { Sky } from './Sky';
import { copyState, lerpState, makeState, readPreset, sunDirection, type TodName } from './timeOfDay';

/**
 * Environment (spec §5 "Look" / "Water"): sky dome, sun + hemisphere lighting, shadows that follow the player with
 * texel snapping, PMREM env map from the sky, linear fog / haze, cumulus clouds, the ocean, distant islands, bloom,
 * and the day / sunset / night presets with a smooth transition. Sole writer of GLOBAL_UNIFORMS.
 *
 * Draw calls: sky 1 + ocean 1 + clouds 1 + scenery 1 (+ bloom passes on High).
 */

const UP = new THREE.Vector3(0, 1, 0);
const DAY_SUN_INTENSITY = 3.3; // GLOBAL_UNIFORMS.uSunColor is normalised to ≈1 for the day sun

export class Environment implements IEnvironment {
  readonly name = 'env';
  readonly sun = new THREE.DirectionalLight(0xfff1dc, DAY_SUN_INTENSITY);
  nightFactor = 0;
  envMap: THREE.Texture | null = null;

  private hemi = new THREE.HemisphereLight(0xbfe0ff, 0x8a86b0, 1);
  private fog = new THREE.Fog(0xcfe6f0, 60, 400);
  private sky: Sky | null = null;
  private ocean: Ocean | null = null;
  private clouds: Clouds | null = null;
  private scenery: Scenery | null = null;
  private post: BloomPost | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private captureScene = new THREE.Scene();
  private applied = new Set<THREE.Scene>();
  private unsubs: (() => void)[] = [];

  private todName: TodName = 'day';
  private todT = 1;
  private from = makeState();
  private target = makeState();
  private cur = makeState();
  private envTimer = 0;
  private envDirty = false;

  private focus = new THREE.Vector3();
  private sunDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private seabedStarted = false;
  private whiteout = 0;
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private v4 = new THREE.Vector3();
  private c1 = new THREE.Color();

  constructor(private ctx: GameContext) {}

  init(): void {
    const { engine, quality, settings, events } = this.ctx;
    const scene = engine.scene;
    scene.fog = this.fog;
    scene.background = new THREE.Color(0xcfe6f0);

    this.hemi.name = 'env.hemi';
    this.sun.name = 'env.sun';
    this.sun.target.name = 'env.sunTarget';
    scene.add(this.hemi, this.sun, this.sun.target);
    const sh = this.sun.shadow;
    sh.mapSize.set(quality.current.shadowMapSize, quality.current.shadowMapSize);
    sh.camera.near = 1;
    sh.camera.far = CONFIG.env.shadow.distance * 2;
    this.sun.castShadow = quality.current.shadows;

    const sky = (this.sky = new Sky());
    scene.add(sky.mesh);
    this.captureScene.add(sky.envMesh);

    const aniso = Math.min(4, engine.renderer.capabilities.getMaxAnisotropy());
    const ocean = (this.ocean = new Ocean(aniso));
    scene.add(ocean.mesh);

    this.clouds = new Clouds();
    scene.add(this.clouds.mesh);

    this.scenery = new Scenery(360);
    scene.add(this.scenery.mesh);

    // Initial time of day: no transition.
    this.todName = settings.values.timeOfDay;
    readPreset(this.todName, this.cur);
    copyState(this.from, this.cur);
    this.todT = 1;
    this.applyState();

    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.refreshEnvMap();

    this.applyQuality();
    this.placeShadow();

    this.unsubs.push(
      events.on('settingsChanged', ({ keys }) => {
        if (keys.includes('timeOfDay')) this.setTimeOfDay(this.ctx.settings.values.timeOfDay);
      }),
      events.on('qualityChanged', () => this.applyQuality()),
    );
  }

  /** Smoothly switch to another preset (CONFIG.env.todTransition seconds). */
  setTimeOfDay(name: TodName): void {
    if (name === this.todName && this.todT >= 1) return;
    copyState(this.from, this.cur);
    this.todName = name;
    this.todT = 0;
    this.envTimer = 0;
  }

  setShadowFocus(pos: THREE.Vector3): void {
    this.focus.copy(pos);
    this.placeShadow();
  }

  applyTo(scene: THREE.Scene): void {
    this.applied.add(scene);
    scene.environment = this.envMap;
  }

  update(dt: number): void {
    const { engine } = this.ctx;
    const realDt = engine.realDt;
    const cam = engine.camera;

    // ── time of day ──
    if (this.todT < 1) {
      this.todT = Math.min(1, this.todT + realDt / Math.max(0.01, CONFIG.env.todTransition));
      const t = this.todT * this.todT * (3 - 2 * this.todT);
      lerpState(this.cur, this.from, readPreset(this.todName, this.target), t);
      this.envTimer += realDt;
      if (this.envTimer >= CONFIG.env.envRefreshInterval || this.todT >= 1) {
        this.envTimer = 0;
        this.envDirty = true;
      }
    } else {
      readPreset(this.todName, this.cur); // live tuning via the debug panel
    }
    this.applyState();
    if (this.envDirty) {
      this.envDirty = false;
      this.refreshEnvMap();
    }

    // ── seabed (needs the world's data; world inits after env) ──
    if (!this.seabedStarted) this.startSeabed();

    // ── camera-dependent pieces ──
    const camH = Math.max(0, cam.position.y - CONFIG.world.waterLevel);
    this.ocean?.update(cam, engine.time, this.seabedStarted ? 2.5 : 0);
    this.scenery?.update(cam);
    if (this.clouds && this.clouds.mesh.visible) {
      this.clouds.update(cam, dt, this.cur.cloudLit, this.cur.cloudShade);
      const inside = this.clouds.insideAmount(cam.position);
      this.whiteout += (inside - this.whiteout) * (1 - Math.exp(-realDt * 6));
    } else {
      this.whiteout = 0;
    }

    // ── fog: viewDistance-based, grows with altitude, whiteout inside clouds ──
    const q = this.ctx.quality.current;
    const altBoost = 1 + camH / 70;
    let far = Math.min(cam.far * 0.98, q.viewDistance * CONFIG.env.fogFarMul * altBoost);
    let near = far * CONFIG.env.fogNearFrac;
    const w = this.whiteout;
    if (w > 0.001) {
      far = THREE.MathUtils.lerp(far, 30, w);
      near = THREE.MathUtils.lerp(near, 0, w);
      this.fog.color.lerp(this.c1.copy(this.cur.cloudLit).multiplyScalar(1.05), w);
    }
    this.fog.near = near;
    this.fog.far = far;
    SKY_UNIFORMS.uWhiteout.value = w;

    this.placeShadow();
    this.writeGlobals();
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private applyState(): void {
    const s = this.cur;
    sunDirection(s.sunElevation, s.sunAzimuth, this.sunDir);
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.hemi.color.copy(s.hemiSky);
    this.hemi.groundColor.copy(s.hemiGround);
    this.hemi.intensity = s.hemiIntensity;
    this.fog.color.copy(s.fog);
    (this.ctx.engine.scene.background as THREE.Color | null)?.copy?.(s.horizon);
    this.ctx.engine.scene.environmentIntensity = s.envIntensity;
    this.ctx.engine.renderer.toneMappingExposure = CONFIG.env.exposure * s.exposure;
    this.nightFactor = s.night;

    const U = SKY_UNIFORMS;
    U.uZenith.value.copy(s.zenith);
    U.uSkyMid.value.copy(s.skyMid);
    U.uHorizon.value.copy(s.horizon);
    U.uSkyGround.value.copy(s.ground);
    U.uGlow.value.copy(s.glow);
    U.uGlowStrength.value = s.glowStrength;
    U.uSunDisk.value = s.sunDisk;
    U.uSunSize.value = s.sunSize;
    U.uMoon.value = s.moon;
    U.uStars.value = s.stars;
    U.uSunLight.value.copy(s.sunColor).multiplyScalar(s.sunIntensity);
    U.uAmbient.value.copy(s.hemiSky).multiplyScalar(s.hemiIntensity);
    U.uAmbientGround.value.copy(s.hemiGround).multiplyScalar(s.hemiIntensity);
    GLOBAL_UNIFORMS.uSunDir.value.copy(this.sunDir);

    this.ocean?.setColors(s.waterDeep, s.waterMid, s.waterShallow);
    this.post?.setParams(s.bloomStrength, CONFIG.env.bloom.radius, s.bloomThreshold);
  }

  private writeGlobals(): void {
    const G = GLOBAL_UNIFORMS;
    G.uTime.value = this.ctx.engine.time;
    G.uNight.value = this.nightFactor;
    G.uSunDir.value.copy(this.sunDir);
    G.uSunColor.value.copy(this.cur.sunColor).multiplyScalar(this.cur.sunIntensity / DAY_SUN_INTENSITY);
    G.uFogColor.value.copy(this.fog.color);
    G.uFogNear.value = this.fog.near;
    G.uFogFar.value = this.fog.far;
  }

  /** Shadow frustum around the focus (shifted toward where the camera looks), snapped to shadow-map texels. */
  private placeShadow(): void {
    const cfg = CONFIG.env.shadow;
    const cam = this.ctx.engine.camera;
    const sh = this.sun.shadow;
    const camDist = cam.position.distanceTo(this.focus);
    const extent = Math.min(cfg.extent * 3, Math.max(cfg.extent, camDist * 1.6));
    const fwd = cam.getWorldDirection(this.v1);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    const center = this.v2.copy(this.focus).addScaledVector(fwd, extent * cfg.lookAhead);

    const Z = this.sunDir;
    const X = this.v3.crossVectors(UP, Z);
    if (X.lengthSq() < 1e-6) X.set(1, 0, 0);
    X.normalize();
    const Y = this.v4.crossVectors(Z, X);
    const size = sh.mapSize.x || 1024;
    const texel = (2 * extent) / size;
    const px = Math.round(center.dot(X) / texel) * texel;
    const py = Math.round(center.dot(Y) / texel) * texel;
    const pz = center.dot(Z);
    const tgt = this.sun.target.position;
    tgt.set(0, 0, 0).addScaledVector(X, px).addScaledVector(Y, py).addScaledVector(Z, pz);
    this.sun.position.copy(tgt).addScaledVector(Z, cfg.distance);

    const c = sh.camera;
    if (c.right !== extent || c.far !== cfg.distance * 2) {
      c.left = -extent;
      c.right = extent;
      c.top = extent;
      c.bottom = -extent;
      c.near = 1;
      c.far = cfg.distance * 2;
      c.updateProjectionMatrix();
    }
    sh.bias = cfg.bias;
    sh.normalBias = texel * cfg.normalBiasTexels;
    sh.radius = cfg.radius;
  }

  private refreshEnvMap(): void {
    if (!this.pmrem) return;
    try {
      const rt = this.pmrem.fromScene(this.captureScene, 0, 0.1, 100, { size: CONFIG.env.envMapSize });
      const old = this.envRT;
      this.envRT = rt;
      this.envMap = rt.texture;
      this.ctx.engine.scene.environment = rt.texture;
      for (const s of this.applied) s.environment = rt.texture;
      old?.dispose();
    } catch (err) {
      console.warn('[env] PMREM failed', err);
    }
  }

  private applyQuality(): void {
    const { quality, engine } = this.ctx;
    const q = quality.current;
    // Toggling castShadow changes the lights hash → lit materials recompile with/without shadow sampling
    // (renderer.shadowMap.enabled alone would not trigger it). Quality sets shadowMap.enabled.
    this.sun.castShadow = q.shadows;
    const sz = q.shadowMapSize;
    if (this.sun.shadow.mapSize.x !== sz) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(sz, sz);
    }
    this.ocean?.setDetail(q.waterDetail, Math.max(CONFIG.env.ocean.radius, engine.camera.far * 0.97));
    if (this.clouds) {
      this.clouds.mesh.visible = q.clouds;
      this.clouds.setAmount(quality.level === 'high' ? 1 : 0.7);
    }
    this.syncPost();
  }

  private syncPost(): void {
    const { engine, quality } = this.ctx;
    const want = quality.current.bloom;
    if (want && !this.post) {
      const { width, height } = engine.size;
      const samples = quality.current.antialias && !quality.isMobile ? 4 : 0;
      try {
        this.post = new BloomPost(engine.renderer, engine.scene, engine.camera, width, height, engine.renderer.getPixelRatio(), samples);
        const s = this.cur;
        this.post.setParams(s.bloomStrength, CONFIG.env.bloom.radius, s.bloomThreshold);
        engine.post = this.post;
      } catch (err) {
        console.warn('[env] bloom unavailable', err);
        this.post = null;
        engine.post = null;
      }
    } else if (!want && this.post) {
      if (engine.post === this.post) engine.post = null;
      this.post.dispose();
      this.post = null;
    }
  }

  private startSeabed(): void {
    const world = this.ctx.world;
    const data = world?.data;
    if (!data || !this.ocean) return;
    this.seabedStarted = true;
    this.ocean.setCoast(data.coast?.shoreZ ?? 360, data.size / 2);
    const isl = (CONFIG.world as { island?: { minX: number; maxX: number; minZ: number; maxZ: number } }).island;
    const m = 160;
    const half = data.size / 2;
    const minX = (isl ? Math.min(isl.minX, -half) : -half) - m;
    const maxX = (isl ? Math.max(isl.maxX, half) : half) + m;
    const minZ = (isl ? Math.min(isl.minZ, -half) : -half) - m;
    const maxZ = Math.max(isl ? isl.maxZ : half, (data.coast?.shoreZ ?? half) + 60) + m + 60;
    const texel = Math.max(2.5, Math.max(maxX - minX, maxZ - minZ) / 1024);
    this.ocean.bakeSeabed((x, z) => world.groundHeightAt(x, z), minX, minZ, maxX, maxZ, texel);
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    const { engine } = this.ctx;
    if (this.post) {
      if (engine.post === this.post) engine.post = null;
      this.post.dispose();
      this.post = null;
    }
    for (const o of [this.sky?.mesh, this.ocean?.mesh, this.clouds?.mesh, this.scenery?.mesh, this.hemi, this.sun, this.sun.target]) o?.removeFromParent();
    this.sky?.dispose();
    this.ocean?.dispose();
    this.clouds?.dispose();
    this.scenery?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.sun.shadow.map?.dispose();
    if (engine.scene.environment === this.envMap) engine.scene.environment = null;
    this.envMap = null;
  }
}
