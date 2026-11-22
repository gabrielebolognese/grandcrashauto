import * as THREE from 'three';
import { CONFIG } from '../../config';
import { GLOBAL_UNIFORMS } from '../../core/uniforms';
import type { GameContext, IEnvironment, WeatherKind, WeatherState } from '../../game/contracts';
import { applyWeather, makePalette, samplePalette, type Palette } from './atmosphere';
import { Clock } from './Clock';
import { Clouds } from './Clouds';
import { Lightning } from './Lightning';
import { Ocean } from './Ocean';
import { BloomPost, TurboDirect } from './Post';
import { Precip } from './Precip';
import { Scenery } from './Scenery';
import { ScreenFx } from './ScreenFx';
import { SKY_UNIFORMS } from './shaders';
import { Sky } from './Sky';
import { Weather } from './Weather';
import { patchMaterial as patchWet, puddleMask, WET_UNIFORMS, type PatchKind } from './wet';

/**
 * Environment (SPEC §5 look/water, PART2 ocean & altitude, PART3 §5 day/night + §6 weather + §7 turbo post).
 * Sole writer of GLOBAL_UNIFORMS (except uOrigin). Owns: sky dome, sun/moon directional light (ONE light, shadows
 * follow the focus with texel snapping), hemisphere light, PMREM env map (refreshed every few game minutes / on
 * weather change — never per frame), fog + camera near/far (visibility), clouds, ocean, distant islands, rain/snow,
 * lightning, screen drops, wet/snow material patch, bloom + turbo post.
 *
 * Draw calls: sky 1 + ocean 1 + clouds 1 + scenery 1 (+ precip 1, lightning 1, screen overlay 1 when active).
 */

const UP = new THREE.Vector3(0, 1, 0);

/** GLSL-style smoothstep that also works for descending edges (THREE.MathUtils.smoothstep does not). */
function sstep(x: number, e0: number, e1: number): number {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
const DAY_SUN_INTENSITY = 3.3; // GLOBAL_UNIFORMS.uSunColor is normalised to ≈1 for the full day sun
const WEATHER_KINDS: WeatherKind[] = ['clear', 'fewClouds', 'cloudy', 'overcast', 'lightRain', 'heavyRain', 'storm', 'fog', 'snow'];

export class Environment implements IEnvironment {
  readonly name = 'env';
  readonly sun = new THREE.DirectionalLight(0xfff1dc, DAY_SUN_INTENSITY);
  nightFactor = 0;
  envMap: THREE.Texture | null = null;
  readonly wind = GLOBAL_UNIFORMS.uWind.value;

  private hemi = new THREE.HemisphereLight(0xbfe0ff, 0x8a86b0, 1);
  private fog = new THREE.Fog(0xcfe6f0, 60, 400);
  private clock = new Clock();
  private weatherSim: Weather;
  private sky: Sky | null = null;
  private ocean: Ocean | null = null;
  private clouds: Clouds | null = null;
  private scenery: Scenery | null = null;
  private precip: Precip | null = null;
  private lightning: Lightning | null = null;
  private screen: ScreenFx | null = null;
  private bloomPost: BloomPost | null = null;
  private turboPost: TurboDirect | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private captureScene = new THREE.Scene();
  private applied = new Set<THREE.Scene>();
  private unsubs: (() => void)[] = [];

  private pal = makePalette();
  private envKey = { hours: -99, cover: -1, fog: -1, time: -99, sun: new THREE.Vector3(), zenith: new THREE.Color(-1, -1, -1), horizon: new THREE.Color(-1, -1, -1), light: new THREE.Color(-1, -1, -1) };
  private saveTimer = 0;
  private focus = new THREE.Vector3();
  private lightDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  private seabedReady = false;
  private whiteout = 0;
  private flash = 0;
  private nextStrike = 8;
  private turbo = 0;
  private visibility = 3000;
  private dawnMist = 0;
  private qLevel = 1;
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private v4 = new THREE.Vector3();
  private camAbs = new THREE.Vector3();
  private c1 = new THREE.Color();
  private c2 = new THREE.Color();

  constructor(private ctx: GameContext) {
    const s = ctx.settings.values as { weather?: string };
    const initial = (s.weather && s.weather !== 'auto' ? s.weather : CONFIG.env.weather.initial) as WeatherKind;
    this.weatherSim = new Weather(WEATHER_KINDS.includes(initial) ? initial : 'fewClouds');
    this.weatherSim.onChange = (kind) => this.ctx.events.emit('weatherChanged', { kind });
  }

  // ─────────────────────────────── IEnvironment (part 3) ───────────────────────────────
  get clockHours(): number {
    return this.clock.hours;
  }

  get weather(): WeatherState {
    return this.weatherSim.state;
  }

  setTime(hours: number): void {
    this.clock.setHours(hours);
    this.envKey.hours = -99; // force an env-map refresh
    this.persistClock();
  }

  puddleAt(x: number, z: number): number {
    const o = this.ctx.origin?.offset;
    return puddleMask(x + (o?.x ?? 0), z + (o?.z ?? 0), this.weatherSim.state.wetness);
  }

  patchMaterial(material: THREE.Material, kind: PatchKind): void {
    patchWet(material, kind);
  }

  setShadowFocus(pos: THREE.Vector3): void {
    this.focus.copy(pos);
    this.placeShadow();
  }

  applyTo(scene: THREE.Scene): void {
    this.applied.add(scene);
    scene.environment = this.envMap;
  }

  // ─────────────────────────────── lifecycle ───────────────────────────────
  init(): void {
    const { engine, quality, settings, events, save } = this.ctx;
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

    const aniso = Math.min(4, engine.renderer.capabilities.getMaxAnisotropy());
    const ocean = (this.ocean = new Ocean(aniso));
    scene.add(ocean.mesh);
    SKY_UNIFORMS.uCloudTex.value = ocean.noiseTexture;

    const sky = (this.sky = new Sky());
    scene.add(sky.mesh);
    this.captureScene.add(sky.envMesh);

    this.clouds = new Clouds();
    scene.add(this.clouds.mesh);

    this.scenery = new Scenery(CONFIG.world.coast.southZ);
    scene.add(this.scenery.mesh);

    this.precip = new Precip(CONFIG.env.weather.drops[1]);
    scene.add(this.precip.mesh);
    this.lightning = new Lightning();
    scene.add(this.lightning.mesh);
    this.screen = new ScreenFx();
    scene.add(this.screen.mesh);

    // Clock from the save (legacy timeOfDay presets map onto setTime shortcuts).
    const savedHours = (save.data as { clockHours?: number }).clockHours;
    this.clock.setHours(Number.isFinite(savedHours) ? (savedHours as number) : CONFIG.env.presetHours.day);

    this.updateSky(0);
    this.pmrem = new THREE.PMREMGenerator(engine.renderer);
    this.refreshEnvMap();
    this.applyQuality();
    this.placeShadow();
    this.writeGlobals();

    this.unsubs.push(
      events.on('settingsChanged', ({ keys }) => {
        if (keys.includes('timeOfDay')) {
          const tod = this.ctx.settings.values.timeOfDay;
          this.setTime(CONFIG.env.presetHours[tod] ?? CONFIG.env.presetHours.day);
        }
        if (keys.includes('postFx')) this.syncPost();
      }),
      events.on('qualityChanged', () => this.applyQuality()),
      events.on('originShift', ({ delta }) => {
        this.ocean?.shift(delta.x, delta.z);
        this.lightning?.shift(delta.x, delta.z);
        this.focus.x -= delta.x;
        this.focus.z -= delta.z;
        this.scenery?.mesh.updateMatrix(); // core moved it (static mesh, matrixAutoUpdate off)
      }),
    );
    void settings;
  }

  /** Pre-warm (behind the loading bar): post chains compiled, turbo pass ready, env map baked. Never compile mid-game. */
  warmup(): void {
    const { engine } = this.ctx;
    if (!this.envMap) this.refreshEnvMap();
    try {
      this.bloomPost?.warm();
      const q = this.ctx.quality.current as { postFx?: boolean };
      if (q.postFx) {
        if (!this.turboPost) this.turboPost = new TurboDirect(engine.renderer, engine.scene, engine.camera);
        this.turboPost.warm();
      }
    } catch (err) {
      console.warn('[env] post warmup failed', err);
    }
  }

  update(dt: number): void {
    const { engine, settings } = this.ctx;
    const realDt = engine.realDt;
    const cam = engine.camera;
    const sv = settings.values as { dayLengthMin?: number; timeLocked?: boolean; weather?: string };

    // ── clock ──
    if (!sv.timeLocked) this.clock.advance(realDt, sv.dayLengthMin ?? 24);
    this.saveTimer += realDt;
    if (this.saveTimer > CONFIG.env.clockSaveInterval) {
      this.saveTimer = 0;
      this.persistClock();
    }

    // ── weather ──
    const locked = sv.weather && sv.weather !== 'auto' && WEATHER_KINDS.includes(sv.weather as WeatherKind) ? (sv.weather as WeatherKind) : null;
    this.weatherSim.update(realDt, locked, this.focus.y);

    // ── sky & light ──
    this.updateSky(realDt);
    if (this.envNeedsRefresh()) this.refreshEnvMap();

    // ── seabed sampler (world inits after env) ──
    if (!this.seabedReady && this.ctx.world?.data) {
      this.seabedReady = true;
      const world = this.ctx.world;
      this.ocean?.setSampler((x, z) => world.groundHeightAt(x, z));
    }

    // ── camera-dependent pieces ──
    const origin = this.ctx.origin?.offset ?? this.v1.set(0, 0, 0);
    this.camAbs.set(cam.position.x + origin.x, cam.position.y, cam.position.z + origin.z);
    const ws = this.weatherSim.state;
    const camH = Math.max(0, cam.position.y - CONFIG.world.waterLevel);
    this.ocean?.update(cam, engine.time, origin, ws.windSpeed + ws.gust * 0.5, (1 - 0.8 * ws.fog) * (1 - 0.45 * this.dawnMist));
    this.scenery?.update(cam, (1 - 0.85 * ws.fog) * (1 - 0.4 * this.dawnMist));
    if (this.clouds && this.clouds.mesh.visible) {
      this.clouds.update(cam, dt, this.wind, origin, ws.cloudCover);
      const frac = this.qLevel >= 2 ? 1 : 0.7;
      this.clouds.setAmount(Math.max(0.05, this.weatherSim.clouds * frac));
      const inside = this.clouds.insideAmount(cam.position);
      this.whiteout += (inside - this.whiteout) * (1 - Math.exp(-realDt * 6));
    } else {
      this.whiteout = 0;
    }
    this.updatePrecip(realDt);
    this.updateLightning(realDt);
    // Height above the ground/sea (not sea level): mountain roads must not act like flying.
    let ground = CONFIG.world.waterLevel;
    try {
      ground = Math.max(ground, this.ctx.world?.groundHeightAt(cam.position.x, cam.position.z) ?? ground);
    } catch {
      /* world not ready */
    }
    this.updateVisibility(Math.max(0, cam.position.y - ground), camH);
    this.updateScreen(realDt);
    this.updateTurbo(realDt);

    this.placeShadow();
    this.writeGlobals();
  }

  // ─────────────────────────────── sky / light ───────────────────────────────
  private updateSky(realDt: number): void {
    const p = this.pal;
    const clk = this.clock;
    const ws = this.weatherSim.state;
    samplePalette(clk.sunElevation, p);
    applyWeather(p, { cover: ws.cloudCover, rain: ws.rain + ws.snow, storm: ws.storm, fog: ws.fog });

    // One directional light: the sun by day, the moon by night (swap while its intensity is ~0 at twilight).
    const moonCfg = CONFIG.env.moon;
    const sunUp = THREE.MathUtils.smoothstep(clk.sunElevation, -4, 2);
    let intensity: number;
    if (clk.sunElevation > -4) {
      this.lightDir.copy(clk.sunDir);
      if (this.lightDir.y < 0.035) {
        this.lightDir.y = 0.035; // keep shadows sane right at the horizon
        this.lightDir.normalize();
      }
      intensity = p.sunIntensity;
      this.sun.color.copy(p.sunColor);
    } else {
      // Moon: always somewhere usable at night (never below minElevation), dimmed by its phase.
      this.lightDir.copy(clk.moonDir);
      const minY = Math.sin((moonCfg.minElevation * Math.PI) / 180);
      if (this.lightDir.y < minY) {
        const h = Math.hypot(this.lightDir.x, this.lightDir.z) || 1;
        const k = Math.sqrt(1 - minY * minY) / h;
        this.lightDir.set(this.lightDir.x * k, minY, this.lightDir.z * k);
      }
      const phaseLight = moonCfg.minLight + (1 - moonCfg.minLight) * clk.moonIllum;
      const fadeIn = sstep(clk.sunElevation, -4, -9);
      intensity = moonCfg.intensity * phaseLight * fadeIn * (1 - 0.8 * THREE.MathUtils.smoothstep(ws.cloudCover, 0.4, 1));
      this.sun.color.set(moonCfg.color);
    }
    this.sun.intensity = intensity * (1 + this.flash * (this.qLevel >= 1 ? 6 : 0));
    // Shadows fade out at twilight (and under thick cloud); the moon casts soft faint ones.
    this.sun.shadow.intensity = clk.sunElevation > -4
      ? THREE.MathUtils.smoothstep(clk.sunElevation, -1, 6) * (1 - 0.75 * THREE.MathUtils.smoothstep(ws.cloudCover, 0.5, 1))
      : 0.55;

    this.hemi.color.copy(p.hemiSky);
    this.hemi.groundColor.copy(p.hemiGround);
    this.hemi.intensity = p.hemiIntensity * (1 + this.flash * (this.qLevel >= 1 ? 5 : 0));
    this.fog.color.copy(p.fog);
    (this.ctx.engine.scene.background as THREE.Color | null)?.copy?.(p.horizon);
    this.ctx.engine.scene.environmentIntensity = p.envIntensity * (1 + this.flash * 2);
    this.ctx.engine.renderer.toneMappingExposure = CONFIG.env.exposure * p.exposure;
    this.nightFactor = THREE.MathUtils.clamp(p.night, 0, 1);

    const U = SKY_UNIFORMS;
    U.uZenith.value.copy(p.zenith);
    U.uSkyMid.value.copy(p.skyMid);
    U.uHorizon.value.copy(p.horizon);
    U.uSkyGround.value.copy(p.ground);
    U.uGlow.value.copy(p.glow);
    U.uGlowStrength.value = p.glowStrength;
    U.uSkySun.value.copy(clk.sunDir);
    U.uSunDisk.value = p.sunDisk;
    U.uSunSize.value = p.sunSize;
    const moonVis = (1 - sunUp) * sstep(clk.sunElevation, -2, -8);
    U.uMoon.value = moonVis;
    U.uMoonDir.value.copy(clk.sunElevation > -4 ? clk.moonDir : this.lightDir);
    U.uStars.value = p.stars;
    U.uMilky.value = p.stars * (1 - THREE.MathUtils.smoothstep(ws.cloudCover, 0.15, 0.5)) * (1 - ws.fog);
    U.uCover.value = ws.cloudCover;
    const drift = U.uCloudOff.value;
    drift.x = (drift.x + this.wind.x * realDt * 0.00012) % 1;
    drift.y = (drift.y + this.wind.z * realDt * 0.00012) % 1;
    U.uCloudLit.value.copy(p.cloudLit);
    U.uCloudShade.value.copy(p.cloudShade);
    U.uSunLight.value.copy(this.sun.color).multiplyScalar(intensity);
    U.uAmbient.value.copy(p.hemiSky).multiplyScalar(p.hemiIntensity);
    U.uAmbientGround.value.copy(p.hemiGround).multiplyScalar(p.hemiIntensity);
    this.ocean?.setColors(p.waterDeep, p.waterMid, p.waterShallow);
    this.bloomPost?.setParams(p.bloomStrength + this.flash * 0.6, CONFIG.env.bloom.radius, p.bloomThreshold);
  }

  /** Throttled PMREM refresh: every few game minutes, on weather changes, or after setTime. Never per frame. */
  private envNeedsRefresh(): boolean {
    const k = this.envKey;
    const ws = this.weatherSim.state;
    const dh = Math.abs(this.clock.hours - k.hours);
    const minutes = Math.min(dh, 24 - dh) * 60;
    const now = this.ctx.engine.time;
    if (now - k.time < 1.5) return false; // hard rate limit
    if (k.hours < -50) return true;
    // Only when the sky actually changed (dawn/dusk, weather), at most every few game minutes.
    if (minutes < CONFIG.env.envRefreshGameMinutes * 0.5) return false;
    const p = this.pal;
    const tol = this.qLevel === 0 ? 0.09 : 0.05;
    const dc = (a: THREE.Color, b: THREE.Color) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) / Math.max(0.05, (b.r + b.g + b.b) / 3);
    this.c2.copy(this.sun.color).multiplyScalar(this.sun.intensity / DAY_SUN_INTENSITY);
    return (
      Math.abs(ws.cloudCover - k.cover) > 0.08 ||
      Math.abs(ws.fog - k.fog) > 0.15 ||
      this.clock.sunDir.dot(k.sun) < 0.99 ||
      dc(p.zenith, k.zenith) > tol ||
      dc(p.horizon, k.horizon) > tol ||
      dc(this.c2, k.light) > tol * 2
    );
  }

  private refreshEnvMap(): void {
    if (!this.pmrem) return;
    const k = this.envKey;
    k.hours = this.clock.hours;
    k.cover = this.weatherSim.state.cloudCover;
    k.fog = this.weatherSim.state.fog;
    k.time = this.ctx.engine.time;
    k.sun.copy(this.clock.sunDir);
    k.zenith.copy(this.pal.zenith);
    k.horizon.copy(this.pal.horizon);
    k.light.copy(this.sun.color).multiplyScalar(this.sun.intensity / DAY_SUN_INTENSITY);
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

  private persistClock(): void {
    const h = this.clock.hours;
    try {
      this.ctx.save.update((d) => {
        (d as { clockHours?: number }).clockHours = h;
      });
    } catch {
      /* save unavailable */
    }
  }

  // ─────────────────────────────── weather visuals ───────────────────────────────
  private updatePrecip(realDt: number): void {
    const ws = this.weatherSim.state;
    const amount = ws.rain + ws.snow;
    const snowFrac = amount > 0 ? ws.snow / amount : 0;
    const lowSnowOverlay = this.qLevel === 0 && snowFrac > 0.5;
    const p = this.pal;
    // Rain colour: catches the ambient light (bright grey by day, dim blue at night), snow nearly white.
    this.c1.copy(p.fog).lerp(this.c2.setRGB(1, 1, 1), 0.35).multiplyScalar(0.55 + 0.45 * (1 - this.nightFactor));
    this.c2.copy(p.hemiSky).multiplyScalar(0.25 * p.hemiIntensity).addScalar(0.55 * (1 - this.nightFactor * 0.7));
    if (this.precip && ws.rain > 0.05) {
      const cam = this.ctx.engine.camera;
      let gy = -1e4;
      try {
        gy = this.ctx.world?.groundHeightAt(cam.position.x, cam.position.z) ?? -1e4;
      } catch {
        gy = -1e4;
      }
      this.precip.setGround(gy, this.qLevel >= 1);
    }
    this.precip?.update(realDt, this.ctx.engine.time, this.ctx.engine.camera, this.camAbs, lowSnowOverlay ? ws.rain : amount, snowFrac, this.wind, this.c1, this.c2);
    GLOBAL_UNIFORMS.uRain.value = ws.rain;
  }

  private updateLightning(realDt: number): void {
    const ws = this.weatherSim.state;
    const lightning = this.lightning;
    if (!lightning) return;
    if (ws.storm > 0.3) {
      this.nextStrike -= realDt * ws.storm;
      if (this.nextStrike <= 0) {
        const cfg = CONFIG.env.weather;
        this.nextStrike = cfg.lightningMin + Math.random() * (cfg.lightningMax - cfg.lightningMin);
        this.strike();
      }
    }
    const f = lightning.update(realDt);
    this.flash = f;
    GLOBAL_UNIFORMS.uLightning.value = f;
  }

  private strike(): void {
    const cam = this.ctx.engine.camera;
    const fwd = cam.getWorldDirection(this.v2);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const ang = (Math.random() - 0.5) * 2.2;
    const dist = 350 + Math.random() * 2200;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const dx = fwd.x * ca - fwd.z * sa, dz = fwd.x * sa + fwd.z * ca;
    const x = cam.position.x + dx * dist, z = cam.position.z + dz * dist;
    let gy = 0;
    try {
      gy = Math.max(CONFIG.world.waterLevel, this.ctx.world?.groundHeightAt(x, z) ?? 0);
    } catch {
      gy = 0;
    }
    const bottom = this.v3.set(x, gy, z);
    const top = this.v4.set(x + (Math.random() - 0.5) * 300, Math.max(gy + 450, CONFIG.env.clouds.altitudeMin + 80), z + (Math.random() - 0.5) * 300);
    if (this.qLevel >= 1) this.lightning?.strike(top, bottom, cam.position);
    this.ctx.events.emit('lightning', { position: bottom.clone(), intensity: 1 - dist / 2600 });
  }

  /** @param agl camera height above ground/sea, seaH height above sea level */
  private updateVisibility(agl: number, seaH: number): void {
    const camH = agl;
    void seaH;
    const q = this.ctx.quality.current as typeof this.ctx.quality.current & { terrainViewDistance?: number };
    const cam = this.ctx.engine.camera;
    const ws = this.weatherSim.state;
    const cfg = CONFIG.env;
    const base = Math.max(q.viewDistance, (q.terrainViewDistance ?? q.viewDistance * 4) * 0.9) * cfg.fogFarMul;
    const altBoost = 1 + camH * cfg.altitudeFog;
    let far = base * altBoost;
    // Dawn mist (calm mornings): thicker, paler haze for a couple of hours after sunrise.
    const hrs = this.clock.hours;
    const dawn = THREE.MathUtils.smoothstep(hrs, 4.6, 5.8) * (1 - THREE.MathUtils.smoothstep(hrs, 7.2, 8.8)) * (1 - Math.min(1, ws.rain + ws.storm)) * (1 - THREE.MathUtils.smoothstep(camH, 150, 600));
    far *= 1 - 0.5 * dawn;
    if (dawn > 0.001) this.fog.color.lerp(this.c2.setRGB(0.86, 0.8, 0.84).multiplyScalar(0.25 + 0.75 * (1 - this.nightFactor)), 0.35 * dawn);
    this.dawnMist = dawn;
    // Weather: overcast/rain thicken the haze, fog → ~80 m.
    far *= 1 - 0.45 * THREE.MathUtils.smoothstep(ws.cloudCover, 0.5, 1) - 0.2 * (ws.rain + ws.snow);
    far = THREE.MathUtils.lerp(far, 85 + camH * 0.6, Math.pow(ws.fog, 0.6));
    let near = Math.min(far * cfg.fogNearFrac, 120) * (1 - 0.9 * ws.fog);
    const w = this.whiteout;
    if (w > 0.001) {
      far = THREE.MathUtils.lerp(far, 30, w);
      near = THREE.MathUtils.lerp(near, 0, w);
      this.fog.color.lerp(this.c1.copy(this.pal.cloudLit).multiplyScalar(1.05), w);
    }
    far = Math.min(far, cam.far * 0.96); // fully fogged before the far plane clips anything
    this.fog.near = Math.min(near, far * 0.5);
    this.fog.far = Math.max(this.fog.near + 10, far);
    this.visibility = this.fog.far;
    ws.visibility = Math.round(far);
    SKY_UNIFORMS.uWhiteout.value = w;
    GLOBAL_UNIFORMS.uFogDensity.value = Math.max(ws.fog, w);

    // (camera near/far are owned by the camera rig; the fog is clamped to its far plane above)
  }

  private updateScreen(realDt: number): void {
    const screen = this.screen;
    if (!screen) return;
    const ws = this.weatherSim.state;
    const rig = this.ctx.cameraRig as { mode?: string; view?: string } | undefined;
    const planes = this.ctx.planes as { inCockpitSequence?: boolean } | undefined;
    const view = rig?.view ?? rig?.mode;
    const close = view === 'hood' || view === 'cockpit' || !!planes?.inCockpitSequence;
    const target = close && this.qLevel >= 0 ? Math.min(1, ws.rain * 1.4) : 0;
    if (!close) screen.drops = 0; // the drops live on the lens/windshield of the close camera
    else screen.drops += (target - screen.drops) * (1 - Math.exp(-realDt * (target > screen.drops ? 0.8 : 0.3)));
    const amount = ws.snow;
    screen.snow = this.qLevel === 0 ? amount : 0;
    screen.flash = this.flash * 0.9;
    const aspect = this.ctx.engine.size.width / Math.max(1, this.ctx.engine.size.height);
    this.c1.copy(this.pal.hemiSky).multiplyScalar(0.5 + 0.5 * (1 - this.nightFactor)).lerp(this.c2.setRGB(1, 1, 1), 0.5);
    screen.update(this.ctx.engine.time, aspect, this.c1);
  }

  // ─────────────────────────────── shadows ───────────────────────────────
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

    const Z = this.lightDir;
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
    this.sun.target.updateMatrixWorld();

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

  private writeGlobals(): void {
    const G = GLOBAL_UNIFORMS;
    const ws = this.weatherSim.state;
    G.uTime.value = this.ctx.engine.time;
    G.uNight.value = this.nightFactor;
    G.uSunDir.value.copy(this.lightDir);
    G.uSunColor.value.copy(this.sun.color).multiplyScalar(this.sun.intensity / DAY_SUN_INTENSITY);
    G.uFogColor.value.copy(this.fog.color);
    G.uFogNear.value = this.fog.near;
    G.uFogFar.value = this.fog.far;
    G.uWetness.value = ws.wetness;
    G.uSnow.value = this.weatherSim.snowCover;
    G.uSnowLine.value = this.weatherSim.snowLine;
    // uWind is the same Vector3 as this.wind / weather.wind.
    G.uWind.value.copy(this.weatherSim.wind);
  }

  // ─────────────────────────────── quality / post ───────────────────────────────
  private applyQuality(): void {
    const { quality } = this.ctx;
    const q = quality.current as typeof quality.current & { weatherLevel?: number };
    this.qLevel = quality.level === 'low' ? 0 : quality.level === 'medium' ? 1 : 2;
    // Toggling castShadow changes the lights hash → lit materials recompile with/without shadow sampling
    // (renderer.shadowMap.enabled alone would not trigger it). Quality sets shadowMap.enabled.
    this.sun.castShadow = q.shadows;
    const sz = q.shadowMapSize;
    if (this.sun.shadow.mapSize.x !== sz) {
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
      this.sun.shadow.mapSize.set(sz, sz);
    }
    this.ocean?.setDetail(q.waterDetail, CONFIG.env.maxFar);
    if (this.clouds) this.clouds.mesh.visible = q.clouds;
    const wl = THREE.MathUtils.clamp(Math.round(q.weatherLevel ?? this.qLevel), 0, 2);
    this.precip?.setMax(CONFIG.env.weather.drops[wl]);
    WET_UNIFORMS.uPuddles.value = wl >= 1 ? 1 : 0;
    this.syncPost();
  }

  private postFxAllowed(): boolean {
    const q = this.ctx.quality.current as { postFx?: boolean };
    const s = this.ctx.settings.values as { postFx?: boolean };
    return (q.postFx ?? false) && (s.postFx ?? true);
  }

  private syncPost(): void {
    const { engine, quality } = this.ctx;
    const want = quality.current.bloom;
    if (want && !this.bloomPost) {
      const { width, height } = engine.size;
      const samples = quality.current.antialias && !quality.isMobile ? 4 : 0;
      try {
        this.bloomPost = new BloomPost(engine.renderer, engine.scene, engine.camera, width, height, engine.renderer.getPixelRatio(), samples);
        const p = this.pal;
        this.bloomPost.setParams(p.bloomStrength, CONFIG.env.bloom.radius, p.bloomThreshold);
        if (this.ctx.game.state !== 'boot') this.bloomPost.warm();
      } catch (err) {
        console.warn('[env] bloom unavailable', err);
        this.bloomPost = null;
      }
    } else if (!want && this.bloomPost) {
      if (engine.post === this.bloomPost) engine.post = null;
      this.bloomPost.dispose();
      this.bloomPost = null;
    }
    this.choosePost();
  }

  private choosePost(): void {
    const { engine } = this.ctx;
    let want: typeof engine.post = null;
    if (this.bloomPost) want = this.bloomPost;
    else if (this.turbo > 0.002 && this.postFxAllowed()) {
      if (!this.turboPost) this.turboPost = new TurboDirect(engine.renderer, engine.scene, engine.camera);
      want = this.turboPost;
    }
    if (engine.post !== want && (engine.post === null || engine.post === this.bloomPost || engine.post === this.turboPost)) engine.post = want;
  }

  /** Turbo radial blur + chromatic aberration (Medium/High, settings.postFx), eased in/out. */
  private updateTurbo(realDt: number): void {
    const v = this.ctx.vehicle as { active?: boolean; state?: { turboActive?: boolean; speedKmh?: number } } | undefined;
    const cfg = CONFIG.env.turbo;
    const active = !!(v?.active && v.state?.turboActive) && this.postFxAllowed();
    const speed = (v?.state?.speedKmh ?? 0) / 3.6;
    const target = active ? THREE.MathUtils.clamp(0.35 + 0.65 * (speed / cfg.speedRef), 0, 1) : 0;
    const rate = target > this.turbo ? 1 / cfg.rampIn : 1 / cfg.rampOut;
    this.turbo += THREE.MathUtils.clamp(target - this.turbo, -rate * realDt, rate * realDt);
    const blur = this.turbo * cfg.blur;
    const ab = cfg.aberration;
    this.bloomPost?.setTurbo(blur, ab);
    this.turboPost?.setTurbo(blur, ab);
    this.choosePost();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    const { engine } = this.ctx;
    if (engine.post === this.bloomPost || engine.post === this.turboPost) engine.post = null;
    this.bloomPost?.dispose();
    this.turboPost?.dispose();
    this.bloomPost = null;
    this.turboPost = null;
    for (const o of [this.sky?.mesh, this.ocean?.mesh, this.clouds?.mesh, this.scenery?.mesh, this.precip?.mesh, this.lightning?.mesh, this.screen?.mesh, this.hemi, this.sun, this.sun.target]) o?.removeFromParent();
    this.sky?.dispose();
    this.ocean?.dispose();
    this.clouds?.dispose();
    this.scenery?.dispose();
    this.precip?.dispose();
    this.lightning?.dispose();
    this.screen?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.sun.shadow.map?.dispose();
    if (engine.scene.environment === this.envMap) engine.scene.environment = null;
    this.envMap = null;
  }

  /** Debug helper: current palette (read-only). */
  get palette(): Readonly<Palette> {
    return this.pal;
  }
}
