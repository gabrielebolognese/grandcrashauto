import { CONFIG, type QualityLevel, type QualityPreset } from '../config';
import type { Engine } from './Engine';
import type { EventBus } from './EventBus';
import type { GameEvents } from './events';
import type { SaveStore } from './Save';
import type { SettingsStore } from './Settings';

/**
 * Quality presets, first-launch auto-detection (GPU tier + 3 s frame probe) and dynamic resolution (spec §4).
 * Owner: core. Systems read `quality.current` (effective preset incl. user overrides) and listen to 'qualityChanged'.
 */

const LEVELS: QualityLevel[] = ['low', 'medium', 'high'];

export const isMobileDevice = (): boolean =>
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ||
  (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820);

export class Quality {
  level: QualityLevel = 'medium';
  /** Effective preset values (preset + user overrides). Treat as read-only. */
  current: QualityPreset = { ...CONFIG.quality.presets.medium };
  readonly isMobile = isMobileDevice();
  gpuName = 'unknown';

  private probing = false;
  private probeT = 0;
  private probeFrames = 0;
  private probeMs = 0;
  private slowT = 0;
  private fastT = 0;
  private dynScale = 1;

  constructor(
    private engine: Engine,
    private settings: SettingsStore,
    private save: SaveStore,
    private events: EventBus<GameEvents>,
  ) {
    events.on('settingsChanged', ({ keys }) => {
      if (keys.some((k) => ['quality', 'shadows', 'bloom', 'npcDensity', 'renderScale', 'dynamicResolution'].includes(k))) this.applyFromSettings();
    });
  }

  /** Initial level before the renderer exists (decides antialias). */
  static initialLevel(save: SaveStore): QualityLevel {
    const forced = new URLSearchParams(location.search).get('quality');
    if (forced && LEVELS.includes(forced as QualityLevel)) return forced as QualityLevel;
    const s = save.data.settings;
    if (s.qualityUserSet) return s.quality;
    return save.data.detectedQuality ?? Quality.guessTier(null);
  }

  /** GPU-tier heuristic from the renderer string. */
  static guessTier(gl: WebGL2RenderingContext | null): QualityLevel {
    const mobile = isMobileDevice();
    let name = '';
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)).toLowerCase();
    }
    if (mobile) {
      if (/mali-[gt][0-7]\d\b|mali-4|adreno \(tm\) [2-5]\d\d|adreno [2-5]\d\d|powervr|sgx|videocore/.test(name)) return 'low';
      if (/adreno \(tm\) 6[0-3]\d|adreno 6[0-3]\d|mali-g5\d|mali-g6[0-8]/.test(name)) return 'low';
      return 'medium';
    }
    if (/swiftshader|llvmpipe|software|basic render/.test(name)) return 'low';
    if (/nvidia|geforce|rtx|gtx|radeon rx|radeon pro|apple m\d|apple gpu|arc\b/.test(name)) return 'high';
    return 'medium'; // integrated desktop GPUs (Intel UHD/Iris, Radeon Graphics)
  }

  init(): void {
    const gl = this.engine.renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    this.gpuName = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    const forced = new URLSearchParams(location.search).get('quality') as QualityLevel | null;
    const s = this.settings.values;
    if (forced && LEVELS.includes(forced)) {
      this.settings.applyPreset(forced, true);
    } else if (!s.qualityUserSet) {
      const detected = this.save.data.detectedQuality ?? Quality.guessTier(gl);
      if (detected !== s.quality) this.settings.applyPreset(detected, false);
      this.probing = this.save.data.detectedQuality === null; // run the 3 s probe once on first launch
    }
    this.applyFromSettings(true);
  }

  private applyFromSettings(force = false): void {
    const s = this.settings.values;
    const prevLevel = this.level;
    this.level = s.quality;
    const base = CONFIG.quality.presets[this.level];
    const cap = this.isMobile ? Math.min(base.pixelRatioCap, 1.5) : base.pixelRatioCap;
    this.current = {
      ...base,
      pixelRatioCap: cap,
      shadows: s.shadows,
      bloom: s.bloom,
      npcCount: Math.round(base.npcCount * s.npcDensity),
    };
    this.engine.setPixelRatioCap(cap);
    this.dynScale = Math.min(this.dynScale, s.renderScale);
    this.engine.setRenderScale(s.dynamicResolution ? this.dynScale : s.renderScale);
    this.engine.renderer.shadowMap.enabled = this.current.shadows;
    void force; void prevLevel;
    this.events.emit('qualityChanged', { level: this.level });
  }

  /** Per-frame: runs the first-launch probe and the dynamic resolution controller. */
  update(realDt: number, simulating: boolean): void {
    const ms = realDt * 1000;
    if (this.probing && simulating) {
      this.probeT += realDt;
      if (this.probeT > 0.5) {
        // skip the first half-second (shader compiles)
        this.probeFrames++;
        this.probeMs += ms;
      }
      if (this.probeT >= CONFIG.quality.probeSeconds + 0.5) this.finishProbe();
      return;
    }
    const s = this.settings.values;
    if (!s.dynamicResolution || !simulating) return;
    const budget = 1000 / this.current.targetFps;
    const frameMs = this.engine.stats.frameMs;
    const dr = CONFIG.quality.dynRes;
    if (frameMs > budget) {
      this.slowT += realDt;
      this.fastT = 0;
    } else if (frameMs < budget * dr.hysteresis) {
      this.fastT += realDt;
      this.slowT = 0;
    } else {
      this.slowT = Math.max(0, this.slowT - realDt);
      this.fastT = Math.max(0, this.fastT - realDt);
    }
    if (this.slowT > dr.downAfter && this.dynScale > this.current.renderScaleMin) {
      this.dynScale = Math.max(this.current.renderScaleMin, this.dynScale - dr.step);
      this.engine.setRenderScale(this.dynScale);
      this.slowT = 0;
    } else if (this.fastT > dr.upAfter && this.dynScale < s.renderScale) {
      this.dynScale = Math.min(s.renderScale, this.dynScale + dr.step * 0.5);
      this.engine.setRenderScale(this.dynScale);
      this.fastT = 0;
    }
  }

  private finishProbe(): void {
    this.probing = false;
    const avg = this.probeMs / Math.max(1, this.probeFrames);
    const fps = 1000 / avg;
    let idx = LEVELS.indexOf(this.level);
    const target = this.current.targetFps;
    if (fps < target * 0.8 && idx > 0) idx--;
    else if (!this.isMobile && fps > 57 && idx < 2 && this.level !== 'low') idx++;
    const level = LEVELS[idx];
    console.info(`[quality] probe ${fps.toFixed(1)} fps on ${this.gpuName} → ${level}`);
    this.save.update((d) => (d.detectedQuality = level));
    if (level !== this.level && !this.settings.values.qualityUserSet) this.settings.applyPreset(level, false);
  }
}
