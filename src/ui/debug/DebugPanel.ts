import * as THREE from 'three';
import { CONFIG, type QualityLevel } from '../../config';
import type { GameContext } from '../../game/contracts';
import type { DistrictId, Pose } from '../../world/types';
import { h } from '../dom';
import type { UIHost } from '../host';

/**
 * ?debug panel: collapsible drawer with live stats, quick actions (teleports, time of day, explode, presets) and
 * auto-generated live sliders for every CONFIG section. Edits write straight into CONFIG (modules read at use time).
 */
export class DebugPanel {
  readonly el: HTMLDivElement;
  private drawer: HTMLDivElement;
  private stats: HTMLPreElement;
  private actions: HTMLDivElement;
  private config: HTMLDivElement;
  private open = false;
  private built = false;
  private statT = 0;
  private defaults: Record<string, unknown>;
  private actionsSig = '';

  constructor(private host: UIHost) {
    this.defaults = JSON.parse(JSON.stringify(CONFIG));
    const tab = h('button', { class: 'dbg-tab', type: 'button', title: 'Debug panel (`)' }, h('span', { text: 'DEBUG' }));
    tab.addEventListener('click', () => this.toggle());
    this.stats = h('pre', { class: 'dbg-stats' });
    this.actions = h('div', { class: 'dbg-actions' });
    this.config = h('div', { class: 'dbg-config' });
    const copy = h('button', { class: 'dbg-btn', type: 'button', text: 'Copy config JSON' });
    copy.addEventListener('click', () => this.copyConfig());
    const reset = h('button', { class: 'dbg-btn', type: 'button', text: 'Reset all to defaults' });
    reset.addEventListener('click', () => {
      deepAssign(CONFIG as unknown as Record<string, unknown>, JSON.parse(JSON.stringify(this.defaults)));
      this.config.textContent = '';
      this.buildConfig();
      host.toast('CONFIG reset to defaults');
    });
    this.drawer = h(
      'div',
      { class: 'dbg-drawer scroll' },
      h('div', { class: 'dbg-h' }, h('b', { text: 'Debug' }), h('span', { class: 'dbg-close', text: '×', onClick: () => this.toggle(false) })),
      h('details', { class: 'dbg-sec', open: true }, h('summary', { text: 'Stats' }), this.stats),
      h('details', { class: 'dbg-sec', open: true }, h('summary', { text: 'Quick actions' }), this.actions),
      h('details', { class: 'dbg-sec', open: true }, h('summary', { text: 'CONFIG (live)' }), h('div', { class: 'dbg-row-btns' }, copy, reset), this.config),
    );
    this.el = h('div', { class: 'dbg' }, tab, this.drawer);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote' && !e.repeat) this.toggle();
    });
    try {
      if (sessionStorage.getItem('coastline.debugOpen') === '1') this.toggle(true);
    } catch {
      /* storage blocked */
    }
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.classList.toggle('open', this.open);
    try {
      sessionStorage.setItem('coastline.debugOpen', this.open ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.open && !this.built) {
      this.built = true;
      this.buildConfig();
    }
    if (this.open) this.buildActions();
  }

  update(dt: number): void {
    if (!this.open) return;
    this.statT -= dt;
    if (this.statT > 0) return;
    this.statT = 0.25;
    const c = this.host.ctx;
    const st = c.engine.stats;
    const v = c.vehicle.state;
    let bodies = '?';
    try {
      bodies = String(c.physics.world?.bodies.len());
    } catch {
      /* not ready */
    }
    const mem = c.engine.renderer.info.memory;
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    this.stats.textContent = [
      `fps ${st.fps.toFixed(1).padStart(5)}   frame ${st.frameMs.toFixed(1)} ms`,
      `calls ${String(st.calls).padStart(4)}   tris ${(st.triangles / 1000).toFixed(1)}k`,
      `scale ${st.renderScale.toFixed(2)}  × pr ${st.pixelRatio.toFixed(2)}`,
      `npcs ${c.npcs?.activeCount ?? 0}   bodies ${bodies}`,
      `geo ${mem.geometries}  tex ${mem.textures}${heap ? `  heap ${Math.round(heap.usedJSHeapSize / 1e6)}MB` : ''}`,
      `state ${c.game.state}   q ${c.quality.level}   cam ${c.cameraRig?.mode}`,
      `car ${v.position.x.toFixed(0)},${v.position.y.toFixed(1)},${v.position.z.toFixed(0)}  ${Math.round(v.speedKmh)} km/h  g${v.gear}`,
      `rpm ${Math.round(v.rpm)}  thr ${c.input.state.throttle.toFixed(1)} brk ${c.input.state.brake.toFixed(1)} str ${c.input.state.steer.toFixed(2)}${c.input.state.handbrake ? ' HB' : ''}`,
      `dev ${c.input.lastDevice}  ${v.exploded ? 'EXPLODED' : v.upsideDown ? 'upside-down' : v.airborne ? 'airborne' : ''}`,
    ].join('\n');
    // Rebuild teleport list when the world data appears/changes.
    const d = c.world?.data;
    const sig = d ? `${d.roads?.edges?.length}|${d.buildings?.length}|${d.seed}` : '';
    if (sig !== this.actionsSig) this.buildActions();
  }

  // ─────────────────────────────── actions ───────────────────────────────
  private buildActions(): void {
    const c = this.host.ctx;
    const d = c.world?.data;
    this.actionsSig = d ? `${d.roads?.edges?.length}|${d.buildings?.length}|${d.seed}` : '';
    const a = this.actions;
    a.textContent = '';
    const btn = (label: string, fn: () => void) => {
      const b = h('button', { class: 'dbg-btn', type: 'button', text: label });
      b.addEventListener('click', () => {
        try {
          fn();
        } catch (err) {
          console.error(err);
          this.host.toast(`Action failed: ${String(err)}`);
        }
      });
      return b;
    };
    const group = (title: string, ...btns: HTMLElement[]) => h('div', { class: 'dbg-agroup' }, h('div', { class: 'dbg-alabel', text: title }), h('div', { class: 'dbg-row-btns' }, ...btns));
    const tps = teleportTargets(c);
    a.append(group('Teleport', ...tps.map((t) => btn(t.label, () => this.teleport(t.pose)))));
    a.append(
      group(
        'Car',
        btn('💥 Explode / Reset', () => c.game.explodeOrReset()),
        btn('Reset', () => c.game.requestReset()),
        btn('Flip', () => c.input.press('flip')),
        btn('Camera', () => c.input.press('camera')),
        btn('Garage', () => c.game.openGarage()),
      ),
    );
    const hrs = { day: 12.5, sunset: 19.25, night: 23 } as const;
    a.append(
      group(
        'Time of day',
        ...(['day', 'sunset', 'night'] as const).map((t) =>
          btn(t, () => {
            c.settings.set({ timeOfDay: t });
            c.env?.setTime?.(hrs[t]);
          }),
        ),
      ),
    );
    a.append(group('Quality', ...(['low', 'medium', 'high'] as QualityLevel[]).map((q) => btn(q, () => c.settings.applyPreset(q, true)))));
    const ts = h('input', { type: 'range', min: 0.05, max: 2, step: 0.05, value: c.engine.timeScale, class: 'dbg-range' }) as HTMLInputElement;
    const tsv = h('span', { class: 'dbg-val', text: c.engine.timeScale.toFixed(2) });
    ts.addEventListener('input', () => {
      c.engine.timeScale = Number(ts.value);
      tsv.textContent = Number(ts.value).toFixed(2);
    });
    a.append(h('div', { class: 'dbg-agroup' }, h('div', { class: 'dbg-alabel', text: 'Time scale' }), h('div', { class: 'dbg-num' }, ts, tsv)));
    a.append(
      group(
        'UI',
        btn('Toggle HUD', () => document.getElementById('ui-root')?.classList.toggle('ui-hidden')),
        btn('Show FPS', () => c.settings.set({ showFps: !c.settings.values.showFps })),
        btn('Toast test', () => c.events.emit('toast', { text: 'Hello from the debug panel 👋' })),
        btn('Flip prompt', () => c.events.emit('prompt', { id: 'flip', show: true })),
        btn('Hide prompt', () => c.events.emit('prompt', { id: 'flip', show: false })),
      ),
    );
  }

  private teleport(pose: Pose): void {
    const c = this.host.ctx;
    if (c.game.state === 'menu' || c.game.state === 'title') c.game.play();
    if (c.game.state === 'paused') c.game.resume();
    if (!c.vehicle.active) return;
    c.ui.fade(() => {
      c.vehicle.reset(pose);
      c.fx.clearAll();
      c.cameraRig.snap();
      c.events.emit('carReset', { position: c.vehicle.state.position, yaw: pose.yaw });
    });
  }

  private async copyConfig(): Promise<void> {
    const json = JSON.stringify(CONFIG, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      this.host.toast('CONFIG copied to clipboard');
    } catch {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' }) as HTMLTextAreaElement;
      ta.value = json;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
      this.host.toast(ok ? 'CONFIG copied to clipboard' : 'Copy failed — see console');
      if (!ok) console.log(json);
    }
  }

  // ─────────────────────────────── config sliders ───────────────────────────────
  private buildConfig(): void {
    const root = CONFIG as unknown as Record<string, unknown>;
    for (const key of Object.keys(root)) {
      const v = root[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) this.config.append(this.group(key, v as Record<string, unknown>, (this.defaults[key] ?? {}) as Record<string, unknown>, 0));
    }
  }

  private group(name: string, obj: Record<string, unknown>, def: Record<string, unknown>, depth: number): HTMLElement {
    const det = h('details', { class: `dbg-group d${depth}` }, h('summary', { text: name }));
    let lazy = true;
    det.addEventListener('toggle', () => {
      if (!det.open || !lazy) return;
      lazy = false;
      const reset = h('button', { class: 'dbg-mini', type: 'button', text: 'reset' });
      reset.addEventListener('click', () => {
        deepAssign(obj, JSON.parse(JSON.stringify(def)));
        det.querySelectorAll(':scope > .dbg-field, :scope > details').forEach((n) => n.remove());
        lazy = true;
        det.open = false;
        det.open = true;
      });
      if (!det.querySelector(':scope > .dbg-mini')) det.append(reset);
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        const dv = def?.[k];
        if (typeof v === 'number') det.append(numberField(obj, k, v));
        else if (typeof v === 'boolean') det.append(boolField(obj, k));
        else if (typeof v === 'string') det.append(stringField(obj, k));
        else if (Array.isArray(v)) det.append(arrayField(obj, k));
        else if (v && typeof v === 'object') det.append(this.group(k, v as Record<string, unknown>, (dv ?? {}) as Record<string, unknown>, depth + 1));
      }
    });
    return det;
  }
}

// ─────────────────────────────── field builders ───────────────────────────────
function rangeFor(key: string, v: number): { min: number; max: number; step: number } {
  const k = key.toLowerCase();
  const int = Number.isInteger(v);
  if (/deg$|deg[A-Z]?|angle/i.test(key) && Math.abs(v) <= 360) return { min: -180, max: 360, step: 0.5 };
  if (v === 0) return k.includes('ms') ? { min: 0, max: 2000, step: 10 } : { min: -1, max: 1, step: 0.01 };
  if (v > 0 && v < 1) return { min: 0, max: 1, step: 0.005 };
  if (v === 1) return { min: 0, max: 3, step: 0.01 };
  const a = Math.abs(v);
  const mag = Math.pow(10, Math.floor(Math.log10(a)));
  const max = Math.ceil((a * 3) / mag) * mag;
  const step = int && a >= 10 ? Math.max(1, mag / 10) : mag / 100;
  return v > 0 ? { min: 0, max, step } : { min: -max, max, step };
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 10 ? +v.toFixed(2) + '' : +v.toFixed(4) + '');

function numberField(obj: Record<string, unknown>, key: string, v: number): HTMLElement {
  const isColor = /colou?r|tint/i.test(key) && Number.isInteger(v) && v >= 0 && v <= 0xffffff;
  if (isColor) {
    const inp = h('input', { type: 'color', value: '#' + v.toString(16).padStart(6, '0') }) as HTMLInputElement;
    inp.addEventListener('input', () => (obj[key] = parseInt(inp.value.slice(1), 16)));
    return h('label', { class: 'dbg-field' }, h('span', { class: 'dbg-k', text: key }), inp);
  }
  const r = rangeFor(key, v);
  const range = h('input', { type: 'range', min: r.min, max: r.max, step: r.step, value: v, class: 'dbg-range' }) as HTMLInputElement;
  const num = h('input', { type: 'number', step: 'any', value: fmt(v), class: 'dbg-numin' }) as HTMLInputElement;
  range.addEventListener('input', () => {
    const n = Number(range.value);
    obj[key] = n;
    num.value = fmt(n);
  });
  num.addEventListener('change', () => {
    const n = Number(num.value);
    if (!Number.isFinite(n)) return;
    obj[key] = n;
    if (n > Number(range.max)) range.max = String(n * 2 || 1);
    if (n < Number(range.min)) range.min = String(n * 2 || -1);
    range.value = String(n);
  });
  return h('label', { class: 'dbg-field' }, h('span', { class: 'dbg-k', text: key, title: key }), h('span', { class: 'dbg-num' }, range, num));
}

function boolField(obj: Record<string, unknown>, key: string): HTMLElement {
  const inp = h('input', { type: 'checkbox' }) as HTMLInputElement;
  inp.checked = !!obj[key];
  inp.addEventListener('change', () => (obj[key] = inp.checked));
  return h('label', { class: 'dbg-field dbg-bool' }, h('span', { class: 'dbg-k', text: key }), inp);
}

function stringField(obj: Record<string, unknown>, key: string): HTMLElement {
  const v = String(obj[key]);
  const color = /^#[0-9a-f]{6}$/i.test(v);
  const inp = h('input', { type: color ? 'color' : 'text', value: v, class: color ? '' : 'dbg-text' }) as HTMLInputElement;
  inp.addEventListener(color ? 'input' : 'change', () => (obj[key] = inp.value));
  return h('label', { class: 'dbg-field' }, h('span', { class: 'dbg-k', text: key }), inp);
}

function arrayField(obj: Record<string, unknown>, key: string): HTMLElement {
  const arr = obj[key] as unknown[];
  if (arr.length <= 4 && arr.every((x) => typeof x === 'number')) {
    const wrap = h('span', { class: 'dbg-arr' });
    arr.forEach((x, i) => {
      const inp = h('input', { type: 'number', step: 'any', value: fmt(x as number), class: 'dbg-numin' }) as HTMLInputElement;
      inp.addEventListener('change', () => {
        const n = Number(inp.value);
        if (Number.isFinite(n)) arr[i] = n;
      });
      wrap.append(inp);
    });
    return h('label', { class: 'dbg-field' }, h('span', { class: 'dbg-k', text: key }), wrap);
  }
  return h('div', { class: 'dbg-field' }, h('span', { class: 'dbg-k', text: key }), h('code', { class: 'dbg-json', text: JSON.stringify(arr).slice(0, 120) }));
}

function deepAssign(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const s = src[k];
    const t = target[k];
    if (s && typeof s === 'object' && !Array.isArray(s) && t && typeof t === 'object' && !Array.isArray(t)) deepAssign(t as Record<string, unknown>, s as Record<string, unknown>);
    else target[k] = s;
  }
}

// ─────────────────────────────── teleport targets ───────────────────────────────
const tmp = new THREE.Vector3();

function teleportTargets(c: GameContext): { label: string; pose: Pose }[] {
  const d = c.world?.data;
  if (!d) return [];
  const out: { label: string; pose: Pose }[] = [{ label: 'Garage', pose: d.spawn }];
  if (d.jumpRamp) {
    const r = d.jumpRamp;
    const fx = Math.sin(r.yaw);
    const fz = Math.cos(r.yaw);
    const back = 80;
    const x = r.position.x - fx * back;
    const z = r.position.z - fz * back;
    let y = r.position.y;
    try {
      y = c.world.groundHeightAt(x, z);
    } catch {
      /* keep ramp height */
    }
    out.push({ label: 'Jump ramp', pose: { position: { x, y, z }, yaw: r.yaw } });
  }
  const edges = d.roads?.edges ?? [];
  const n = d.districtGridSize || 0;
  const ids: [DistrictId, string][] = [
    ['downtown', 'Downtown'],
    ['beach', 'Beach'],
    ['residential', 'Residential'],
    ['park', 'Park'],
    ['hub', 'Hub'],
    ['highway', 'Highway'],
  ];
  for (const [id, label] of ids) {
    // Centroid of the district's grid cells.
    let sx = 0;
    let sz = 0;
    let cnt = 0;
    if (n > 0 && d.districtGrid?.length === n * n) {
      const cell = d.size / n;
      for (let iz = 0; iz < n; iz++)
        for (let ix = 0; ix < n; ix++)
          if (d.districtGrid[iz * n + ix] === id) {
            sx += -d.size / 2 + (ix + 0.5) * cell;
            sz += -d.size / 2 + (iz + 0.5) * cell;
            cnt++;
          }
    }
    let best: Pose | null = null;
    let bestD = Infinity;
    for (const e of edges) {
      if (!e.points || e.points.length < 2) continue;
      if (id === 'highway' ? e.kind !== 'highway' : e.kind === 'highway' || e.kind === 'ramp') continue;
      const mi = Math.floor((e.points.length - 1) / 2);
      const p = e.points[mi];
      const q = e.points[mi + 1] ?? e.points[mi - 1];
      if (id !== 'highway') {
        let did: DistrictId | null = null;
        try {
          did = c.world.districtAt(p.x, p.z);
        } catch {
          did = null;
        }
        if (did !== id) continue;
      }
      const dist = cnt ? Math.hypot(p.x - sx / cnt, p.z - sz / cnt) : 0;
      if (dist < bestD) {
        bestD = dist;
        tmp.set(q.x - p.x, 0, q.z - p.z);
        best = { position: { x: p.x, y: p.y, z: p.z }, yaw: Math.atan2(tmp.x, tmp.z) };
      }
    }
    if (!best && id === 'beach' && d.coast) {
      const z = d.coast.seaWallZ - 8;
      best = { position: { x: 0, y: 0, z }, yaw: Math.PI / 2 };
    }
    if (best) out.push({ label, pose: best });
  }
  if (d.airport?.carPark) out.push({ label: 'Airport', pose: d.airport.carPark });
  // Part 3 points of interest (local poses): highway landmarks, terrain viewpoints.
  for (const p of [...(c.highways?.pois ?? []).slice(0, 6), ...(c.terrain?.pois ?? []).slice(0, 4)]) out.push({ label: p.name, pose: p.pose });
  return out;
}
