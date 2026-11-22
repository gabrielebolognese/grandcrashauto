import { CONFIG, type QualityLevel } from '../config';
import type { EventBus } from './EventBus';
import type { GameEvents } from './events';
import type { SaveStore } from './Save';

/** Player settings (spec §13). Persisted inside the SaveStore. Owner: core. */
export interface Settings {
  // graphics
  quality: QualityLevel;
  qualityUserSet: boolean; // false = auto-detected preset in use
  shadows: boolean;
  bloom: boolean;
  npcDensity: number; // multiplier 0..1.5 of the preset's npcCount
  renderScale: number; // 0.5..1 upper bound for the render scale
  dynamicResolution: boolean;
  timeOfDay: 'day' | 'sunset' | 'night';
  showFps: boolean;
  // controls
  steeringMode: 'slider' | 'buttons' | 'tilt';
  leftHanded: boolean;
  controlsScale: number; // 0.75..1.4
  controlsOpacity: number; // 0.2..1
  steerSensitivity: number; // 0.5..1.5
  vibration: boolean;
  // gameplay
  units: 'kmh' | 'mph';
  autoReset: boolean; // auto reset 6 s after explosion
  // audio
  muted: boolean;
  masterVolume: number; // 0..1
  sfxVolume: number;
  engineVolume: number;
  ambienceVolume: number;
}

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium',
  qualityUserSet: false,
  shadows: CONFIG.quality.presets.medium.shadows,
  bloom: CONFIG.quality.presets.medium.bloom,
  npcDensity: 1,
  renderScale: 1,
  dynamicResolution: true,
  timeOfDay: 'day',
  showFps: false,
  steeringMode: 'slider',
  leftHanded: false,
  controlsScale: 1,
  controlsOpacity: 0.55,
  steerSensitivity: 1,
  vibration: true,
  units: 'kmh',
  autoReset: false,
  muted: false,
  masterVolume: 0.8,
  sfxVolume: 0.9,
  engineVolume: 0.8,
  ambienceVolume: 0.7,
};

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const def = DEFAULT_SETTINGS[key];
    const v = r[key];
    if (typeof def === typeof v) (out as any)[key] = v;
  }
  if (!['low', 'medium', 'high'].includes(out.quality)) out.quality = 'medium';
  if (!['day', 'sunset', 'night'].includes(out.timeOfDay)) out.timeOfDay = 'day';
  if (!['slider', 'buttons', 'tilt'].includes(out.steeringMode)) out.steeringMode = 'slider';
  if (!['kmh', 'mph'].includes(out.units)) out.units = 'kmh';
  return out;
}

/** Live settings accessor: read `settings.values.x`, write with `settings.set({...})`. */
export class SettingsStore {
  constructor(
    private save: SaveStore,
    private events: EventBus<GameEvents>,
  ) {}

  get values(): Readonly<Settings> {
    return this.save.data.settings;
  }

  set(patch: Partial<Settings>): void {
    const cur = this.save.data.settings;
    const keys: (keyof Settings)[] = [];
    for (const k of Object.keys(patch) as (keyof Settings)[]) {
      if (patch[k] !== undefined && patch[k] !== cur[k]) {
        (cur as any)[k] = patch[k];
        keys.push(k);
      }
    }
    if (!keys.length) return;
    this.save.scheduleWrite();
    this.events.emit('settingsChanged', { settings: cur, keys });
  }

  /** Apply a quality preset: sets the preset and resets the per-feature toggles to the preset's values. */
  applyPreset(level: QualityLevel, userSet: boolean): void {
    const p = CONFIG.quality.presets[level];
    this.set({ quality: level, qualityUserSet: userSet, shadows: p.shadows, bloom: p.bloom, npcDensity: 1, renderScale: 1 });
  }
}
