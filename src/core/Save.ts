import { CONFIG, type QualityLevel } from '../config';
import { type CarBuild, normalizeBuild, stockBuild } from '../vehicle/CarBuild';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './Settings';

/**
 * All persisted data lives in ONE versioned localStorage key (spec §14), with migrations.
 * Owner: core. To add persisted data: add a field to SaveData + default in freshSave(), bump SAVE_VERSION,
 * and add a migration step that fills the new field for older saves.
 */
export const SAVE_VERSION = 1;

export interface SaveData {
  version: number;
  settings: Settings;
  /** Quality level detected by the first-launch probe (null = not probed yet). */
  detectedQuality: QualityLevel | null;
  garage: {
    current: CarBuild; // auto-saved last car
    slots: (CarBuild | null)[]; // 3 manual save slots
  };
  stats: { explosions: number; distanceKm: number };
  /** Part 3: discovered points of interest (ids) for map teleport; last clock time. */
  discovered: string[];
  clockHours: number;
}

function freshSave(): SaveData {
  return {
    version: SAVE_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    detectedQuality: null,
    garage: { current: stockBuild('coupe'), slots: [null, null, null] },
    stats: { explosions: 0, distanceKm: 0 },
    discovered: [],
    clockHours: 10,
  };
}

/** migrations[n] upgrades a save from version n to n+1. */
const migrations: Record<number, (d: any) => any> = {
  // 1: (d) => ({ ...d, newField: default, version: 2 }),
};

function migrate(raw: any): SaveData {
  if (!raw || typeof raw !== 'object' || typeof raw.version !== 'number') return freshSave();
  let d = raw;
  while (d.version < SAVE_VERSION) {
    const m = migrations[d.version];
    if (!m) return freshSave();
    d = m(d);
  }
  // Validate everything (never trust storage).
  const base = freshSave();
  return {
    version: SAVE_VERSION,
    settings: normalizeSettings(d.settings),
    detectedQuality: ['low', 'medium', 'high'].includes(d.detectedQuality) ? d.detectedQuality : null,
    garage: {
      current: normalizeBuild(d.garage?.current ?? base.garage.current),
      slots: [0, 1, 2].map((i) => (d.garage?.slots?.[i] ? normalizeBuild(d.garage.slots[i]) : null)),
    },
    stats: {
      explosions: Number(d.stats?.explosions) || 0,
      distanceKm: Number(d.stats?.distanceKm) || 0,
    },
    discovered: Array.isArray(d.discovered) ? d.discovered.filter((x: unknown) => typeof x === 'string').slice(0, 500) : [],
    clockHours: Number.isFinite(d.clockHours) ? Math.min(24, Math.max(0, d.clockHours)) : 10,
  };
}

export class SaveStore {
  data: SaveData;
  private timer: number | null = null;
  private readonly key = CONFIG.game.saveKey;

  constructor() {
    let raw: unknown = null;
    try {
      const s = localStorage.getItem(this.key);
      raw = s ? JSON.parse(s) : null;
    } catch {
      raw = null;
    }
    this.data = migrate(raw);
  }

  /** Mutate the save and schedule a debounced write. */
  update(fn: (d: SaveData) => void): void {
    fn(this.data);
    this.scheduleWrite();
  }

  scheduleWrite(): void {
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => this.flush(), 400);
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch (err) {
      console.warn('[save] write failed', err);
    }
  }

  /** Wipe everything (Settings → reset). */
  clear(): void {
    this.data = freshSave();
    this.flush();
  }
}
