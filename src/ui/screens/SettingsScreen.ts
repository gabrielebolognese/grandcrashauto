import { CONFIG, type QualityLevel } from '../../config';
import type { Settings } from '../../core/Settings';
import { h, setVisible } from '../dom';
import type { Screen, UIHost } from '../host';
import { icon, type IconName } from '../icons';
import { button, decoTitle, iconButton, row, sectionTitle, Segmented, Slider, Toggle, uiSound } from '../widgets';

type TabId = 'graphics' | 'controls' | 'gameplay' | 'audio';
const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'graphics', label: 'Graphics', icon: 'sun' },
  { id: 'controls', label: 'Controls', icon: 'controller' },
  { id: 'gameplay', label: 'Gameplay', icon: 'flip' },
  { id: 'audio', label: 'Audio', icon: 'volume' },
];
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Settings (spec §13) in four tabs. Every control applies live through ctx.settings and re-syncs on settingsChanged. */
export class SettingsScreen implements Screen {
  readonly el: HTMLDivElement;
  private tabBtns = new Map<TabId, HTMLButtonElement>();
  private pages = new Map<TabId, HTMLDivElement>();
  private body: HTMLDivElement;
  private sync: (() => void)[] = [];
  private tab: TabId = 'graphics';
  private onBack: () => void = () => {};

  constructor(private host: UIHost) {
    const back = iconButton('back', 'Back', () => this.back(), 'set-back');
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    for (const t of TABS) {
      const b = h('button', { class: 'tab', type: 'button', role: 'tab' }, icon(t.icon), h('span', { text: t.label }));
      b.addEventListener('click', () => {
        if (this.tab !== t.id) uiSound('toggle');
        this.show(t.id);
      });
      this.tabBtns.set(t.id, b);
      tabs.append(b);
    }
    this.body = h('div', { class: 'set-body scroll' });
    this.pages.set('graphics', this.graphics());
    this.pages.set('controls', this.controls());
    this.pages.set('gameplay', this.gameplay());
    this.pages.set('audio', this.audio());
    for (const p of this.pages.values()) this.body.append(p);
    this.el = h(
      'div',
      { class: 'screen settings-screen', 'aria-hidden': 'true', role: 'dialog', 'aria-label': 'Settings' },
      h('div', { class: 'sub-backdrop' }),
      h('div', { class: 'panel set-panel' }, h('div', { class: 'set-head' }, back, h('div', { class: 'set-title' }, decoTitle('Settings')), tabs), this.body),
    );
    host.ctx.events.on('settingsChanged', () => this.refresh());
    host.ctx.events.on('qualityChanged', () => this.refresh());
    this.show('graphics');
  }

  open(onBack: () => void): void {
    this.onBack = onBack;
    this.refresh();
    this.setVisible(true);
  }

  setVisible(on: boolean): void {
    setVisible(this.el, on);
  }

  back(): boolean {
    uiSound('back');
    this.onBack();
    return true;
  }

  private show(id: TabId): void {
    this.tab = id;
    for (const [k, b] of this.tabBtns) {
      b.classList.toggle('on', k === id);
      b.setAttribute('aria-selected', String(k === id));
    }
    for (const [k, p] of this.pages) p.style.display = k === id ? '' : 'none';
    this.body.scrollTop = 0;
  }

  refresh(): void {
    for (const f of this.sync) f();
  }

  private get s(): Readonly<Settings> {
    return this.host.ctx.settings.values;
  }
  private set(patch: Partial<Settings>): void {
    this.host.ctx.settings.set(patch);
  }

  private toggle(label: string, desc: string | null, key: keyof Settings, extra?: (v: boolean) => void, patch?: (v: boolean) => Partial<Settings>): HTMLDivElement {
    const t = new Toggle(label, (v) => {
      this.set(patch ? patch(v) : ({ [key]: v } as Partial<Settings>));
      extra?.(v);
    });
    this.sync.push(() => t.set(!!this.s[key]));
    return row(label, desc, t.el);
  }

  private slider(label: string, desc: string | null, key: keyof Settings, min: number, max: number, step: number, format: (v: number) => string, patch?: (v: number) => Partial<Settings>): HTMLDivElement {
    const sl = new Slider({ label, min, max, step, format, onInput: (v) => this.set(patch ? patch(v) : ({ [key]: v } as Partial<Settings>)) });
    this.sync.push(() => sl.set(this.s[key] as number));
    return row(label, desc, sl.el, 'row-slider');
  }

  // ─────────────────────────────── tabs ───────────────────────────────
  private graphics(): HTMLDivElement {
    const { ctx } = this.host;
    const preset = new Segmented<'auto' | QualityLevel>(
      'Quality preset',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
      (v) => {
        if (v === 'auto') ctx.settings.applyPreset(ctx.save.data.detectedQuality ?? ctx.settings.values.quality, false);
        else ctx.settings.applyPreset(v, true);
      },
    );
    const presetDesc = h('span');
    this.sync.push(() => {
      const s = this.s;
      preset.set(s.qualityUserSet ? s.quality : 'auto');
      const det = ctx.save.data.detectedQuality;
      presetDesc.textContent = s.qualityUserSet
        ? `${cap(s.quality)} preset${det ? ` · auto-detect picked ${cap(det)}` : ''}`
        : `Auto-detected: ${cap(s.quality)}${ctx.quality.gpuName && ctx.quality.gpuName !== 'unknown' ? ` · ${shortGpu(ctx.quality.gpuName)}` : ''}`;
    });
    const presetRow = row('Quality', null, preset.el, 'row-wide');
    presetRow.querySelector('.set-text')!.append(h('div', { class: 'set-desc' }, presetDesc));

    const tod = new Segmented<Settings['timeOfDay']>(
      'Time of day',
      [
        { value: 'day', label: 'Day', icon: 'sun' },
        { value: 'sunset', label: 'Sunset', icon: 'sunset' },
        { value: 'night', label: 'Night', icon: 'moon' },
      ],
      (v) => this.set({ timeOfDay: v }),
    );
    this.sync.push(() => tod.set(this.s.timeOfDay));
    const custom = (v: boolean, k: keyof Settings) => ({ [k]: v, qualityUserSet: true }) as Partial<Settings>;

    return h(
      'div',
      { class: 'set-page' },
      sectionTitle('Preset'),
      presetRow,
      sectionTitle('Look'),
      row('Time of day', 'Sunset and night light up windows, streetlights and headlights', tod.el, 'row-wide'),
      this.toggle('Shadows', 'Soft sun shadows (costly on older phones)', 'shadows', undefined, (v) => custom(v, 'shadows')),
      this.toggle('Bloom', 'Glow around bright lights', 'bloom', undefined, (v) => custom(v, 'bloom')),
      sectionTitle('Performance'),
      this.slider('Pedestrians', 'Crowd density relative to the preset', 'npcDensity', 0, 1.5, 0.05, (v) => {
        const n = Math.round(CONFIG.quality.presets[this.s.quality].npcCount * v);
        return `${n}`;
      }, (v) => ({ npcDensity: v, qualityUserSet: true })),
      this.slider('Render scale', 'Maximum resolution — lower is faster', 'renderScale', 0.5, 1, 0.05, pct, (v) => ({ renderScale: v, qualityUserSet: true })),
      this.toggle('Dynamic resolution', 'Lowers the resolution when the frame rate drops', 'dynamicResolution'),
      this.toggle('Show FPS', null, 'showFps'),
    );
  }

  private controls(): HTMLDivElement {
    const { host } = this;
    const steer = new Segmented<Settings['steeringMode']>(
      'Steering',
      [
        { value: 'slider', label: 'Slider', icon: 'sliderSteer' },
        { value: 'buttons', label: 'Buttons', icon: 'arrows' },
        { value: 'tilt', label: 'Tilt', icon: 'phoneTilt' },
      ],
      (v) => {
        if (v !== 'tilt') {
          this.set({ steeringMode: v });
          return;
        }
        // Must be requested inside the tap (iOS permission prompt).
        void host.tilt.request().then((ok) => {
          if (ok) {
            host.tilt.calibrate();
            this.set({ steeringMode: 'tilt' });
            host.toast('Tilt on — hold the phone how you like, it auto-centres');
          } else {
            host.toast(host.tilt.permission === 'unsupported' ? 'This device has no motion sensor' : 'Motion access was denied');
            this.refresh();
          }
        });
      },
    );
    this.sync.push(() => steer.set(this.s.steeringMode));
    const calib = button('Centre tilt', {
      icon: 'reset',
      cls: 'btn-sm',
      onClick: () => {
        host.tilt.calibrate();
        host.toast('Tilt centred');
      },
    });
    const calibRow = row('Tilt centre', 'Hold the phone in your neutral position, then tap', calib);
    this.sync.push(() => (calibRow.style.display = this.s.steeringMode === 'tilt' ? '' : 'none'));

    const touchSection = h(
      'div',
      { class: 'set-group' },
      sectionTitle('Touch'),
      row('Steering', 'Drag slider, arrow buttons or tilt the phone', steer.el, 'row-wide'),
      calibRow,
      this.toggle('Left-handed', 'Pedals on the left, steering on the right', 'leftHanded'),
      this.slider('Controls size', null, 'controlsScale', 0.75, 1.4, 0.05, pct),
      this.slider('Controls opacity', null, 'controlsOpacity', 0.2, 1, 0.05, pct),
      this.toggle('Vibration', 'Buzz on crashes and explosions', 'vibration', (v) => v && host.vibrate(40)),
    );
    const keys = h(
      'div',
      { class: 'set-group key-ref' },
      sectionTitle('Keyboard & gamepad'),
      ...(
        [
          ['W / ↑', 'RT', 'Accelerate'],
          ['S / ↓', 'LT', 'Brake / reverse'],
          ['A D / ← →', 'L-stick', 'Steer'],
          ['Space', 'X / RB', 'Handbrake'],
          ['H', 'L3', 'Horn'],
          ['C', 'R3', 'Camera'],
          ['Q', 'LB', 'Look back'],
          ['X', 'Y', 'Explode'],
          ['R', 'B', 'Reset car'],
          ['F', 'D-pad ↑', 'Flip car'],
          ['Esc / P', 'Start', 'Pause'],
        ] as [string, string, string][]
      ).map(([k, p, l]) => h('div', { class: 'key-row' }, h('span', { class: 'key-l', text: l }), h('kbd', { text: k }), h('kbd', { class: 'pad', text: p }))),
    );
    return h(
      'div',
      { class: 'set-page' },
      touchSection,
      sectionTitle('Driving'),
      this.slider('Steering sensitivity', null, 'steerSensitivity', 0.5, 1.5, 0.05, (v) => `×${v.toFixed(2)}`),
      keys,
    );
  }

  private gameplay(): HTMLDivElement {
    const { host } = this;
    const units = new Segmented<Settings['units']>(
      'Units',
      [
        { value: 'kmh', label: 'km/h' },
        { value: 'mph', label: 'mph' },
      ],
      (v) => this.set({ units: v }),
    );
    this.sync.push(() => units.set(this.s.units));
    const wipe = button('Reset all data', {
      variant: 'danger',
      icon: 'trash',
      cls: 'btn-sm',
      onClick: async () => {
        const ok = await host.confirm({
          title: 'Reset all data?',
          message: 'This erases your settings, saved cars and stats on this device, then reloads the game.',
          confirm: 'Erase & reload',
          cancel: 'Keep my stuff',
          danger: true,
        });
        if (!ok) return;
        host.ctx.save.clear();
        window.setTimeout(() => location.reload(), 60);
      },
    });
    return h(
      'div',
      { class: 'set-page' },
      sectionTitle('Driving'),
      row('Speed units', null, units.el),
      this.toggle('Auto-reset after explosion', `Respawn automatically ${CONFIG.game.autoResetDelay} s after blowing up`, 'autoReset'),
      sectionTitle('Data'),
      row('Saved data', 'Settings, garage slots and stats live in this browser only', wipe, 'row-danger'),
    );
  }

  private audio(): HTMLDivElement {
    return h(
      'div',
      { class: 'set-page' },
      sectionTitle('Sound'),
      this.toggle('Mute', null, 'muted'),
      this.slider('Master volume', null, 'masterVolume', 0, 1, 0.05, pct),
      this.slider('Effects', 'Crashes, tyres, explosions, horn', 'sfxVolume', 0, 1, 0.05, pct),
      this.slider('Engine', null, 'engineVolume', 0, 1, 0.05, pct),
      this.slider('Ambience', 'City hum, ocean, crowd', 'ambienceVolume', 0, 1, 0.05, pct),
    );
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shortGpu = (n: string) =>
  n
    .replace(/ANGLE \((.*)\)/, '$1')
    .replace(/Direct3D.*|vs_\d.*|\(0x[0-9a-f]+\)/gi, '')
    .split(',')
    .slice(-1)[0]
    .trim()
    .slice(0, 40);
