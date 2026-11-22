import { CONFIG } from '../../config';
import { reportError } from '../../core/debugOverlay';
import type { CarModelInfo, CarVisual, GameContext, IGarage } from '../../game/contracts';
import { cloneBuild, stockBuild, type CarBuild, type CarModelId } from '../../vehicle/CarBuild';
import { randomizeBuild } from '../../vehicle/customization/randomize';
import { decodeShareCode, encodeShareCode, quantizeBuild, runShareSelfTest, sameBuild, shareLink } from '../../vehicle/customization/shareCode';
import { GarageOrbit } from './GarageOrbit';
import { GarageScene } from './GarageScene';
import { GarageUI, type GarageHost, type UISound } from './GarageUI';

/**
 * Garage (spec §7, owner: garage): studio scene + orbit camera + customization UI + save slots + share codes.
 * open(): swaps the engine view to the garage scene and shows the DOM; close(): restores the world view and hides it.
 * Every change is previewed live (applied once per frame) and auto-saved to save.data.garage.current.
 */
export class Garage implements IGarage, GarageHost {
  readonly name = 'garage';
  isOpen = false;

  private build: CarBuild = stockBuild('coupe');
  private scene3d: GarageScene | null = null;
  private orbit: GarageOrbit | null = null;
  private ui: GarageUI | null = null;
  private visual: CarVisual | null = null;
  private visualModel: CarModelId | null = null;
  private appliedKey = '';
  private dirty = false;
  private spin = 0;
  private prevRenderScale = 1;
  private insetsDirty = true;

  constructor(private ctx: GameContext) {}

  get models(): CarModelInfo[] {
    return this.ctx.cars.models;
  }

  init(): void {
    this.handleUrlShareCode();
    this.scene3d = new GarageScene(this.ctx.engine.renderer);
    this.ui = new GarageUI(this);
    this.orbit = new GarageOrbit(this.scene3d.camera, this.ui.stage, () => this.ui?.hideHint());
    this.scene3d.compile();
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    this.ctx.events.on('qualityChanged', () => {
      if (this.isOpen) this.applyQuality();
    });
    if (this.ctx.debug) {
      const w = window as unknown as Record<string, unknown>;
      w.__shareTest = (n?: number) => runShareSelfTest(n ?? 200);
      w.__garage = this;
    }
  }

  // ───────────────────────────── IGarage ─────────────────────────────
  open(): void {
    if (this.isOpen || !this.scene3d || !this.ui || !this.orbit) return;
    this.isOpen = true;
    const { engine } = this.ctx;
    this.build = quantizeBuild(this.ctx.save.data.garage.current);
    this.applyQuality();
    this.syncVisual(false);
    engine.setView({ scene: this.scene3d.scene, camera: this.scene3d.camera });
    // The garage is a still scene: render it crisp (up to the player's render-scale cap), restore on close.
    this.prevRenderScale = engine.getRenderScale();
    engine.setRenderScale(Math.max(this.prevRenderScale, Math.min(1, this.ctx.settings.values.renderScale ?? 1)));
    this.ui.show();
    this.ui.refresh(this.build);
    this.updateInsets();
    this.orbit.setEnabled(true);
    this.orbit.frame(this.scene3d.carSize, this.scene3d.carCenterY, true);
    this.orbit.intro();
    this.spin = CONFIG.garage.turntableSpeed;
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.orbit?.setEnabled(false);
    this.ui?.hide();
    this.ctx.engine.setView(null);
    this.ctx.engine.setRenderScale(this.prevRenderScale);
    this.ctx.save.update((d) => (d.garage.current = cloneBuild(this.build)));
  }

  update(dt: number): void {
    if (!this.isOpen || !this.scene3d || !this.orbit) return;
    if (this.dirty) {
      this.dirty = false;
      this.syncVisual(true);
    }
    if (this.insetsDirty) this.updateInsets();
    this.orbit.update(dt);
    const cfg = CONFIG.garage;
    const want = this.orbit.interacting || this.orbit.idle < cfg.idleResume ? 0 : cfg.turntableSpeed;
    this.spin += (want - this.spin) * (1 - Math.exp(-dt * (want > this.spin ? 0.9 : 7)));
    this.scene3d.update(dt, this.spin);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    window.visualViewport?.removeEventListener('resize', this.onResize);
    this.visual?.dispose();
    this.visual = null;
    this.scene3d?.dispose();
    this.ui?.dispose();
  }

  // ───────────────────────────── GarageHost (called by the UI) ─────────────────────────────
  getBuild(): CarBuild {
    return this.build;
  }

  change(fn: (b: CarBuild) => void, sound: UISound | null = null): void {
    const next = cloneBuild(this.build);
    fn(next);
    const q = quantizeBuild(next);
    if (JSON.stringify(q) === JSON.stringify(this.build)) {
      this.ui?.refresh(this.build);
      return;
    }
    this.build = q;
    this.dirty = true;
    if (sound) this.sound(sound);
    this.ui?.refresh(this.build);
    this.ctx.save.update((d) => (d.garage.current = cloneBuild(this.build)));
  }

  setModel(id: CarModelId): void {
    // An untouched stock car switches to the new model's stock look; a customized one keeps its customization.
    const wasStock = sameBuild(this.build, stockBuild(this.build.model));
    this.change((b) => {
      if (wasStock) Object.assign(b, stockBuild(id));
      else b.model = id;
    }, 'click');
  }

  drive(): void {
    this.sound('confirm');
    const b = cloneBuild(this.build);
    this.ctx.save.update((d) => (d.garage.current = cloneBuild(b)));
    this.ctx.game.driveFromGarage(b);
  }

  back(): void {
    this.sound('back');
    this.ctx.game.toMainMenu();
  }

  randomize(): void {
    this.change((b) => Object.assign(b, randomizeBuild(b)), 'confirm');
    this.scene3d?.pulse(1);
  }

  stock(): void {
    const s = stockBuild(this.build.model);
    if (sameBuild(s, this.build)) {
      this.sound('click');
      return;
    }
    this.change((b) => Object.assign(b, s), 'confirm');
    this.scene3d?.pulse(0.8);
    this.toast('Back to stock');
  }

  slots(): (CarBuild | null)[] {
    return this.ctx.save.data.garage.slots;
  }

  saveSlot(i: number): void {
    this.ctx.save.update((d) => (d.garage.slots[i] = cloneBuild(this.build)));
    this.ctx.save.flush();
    this.sound('confirm');
    this.toast(`Saved to slot ${i + 1}`);
    this.ui?.refresh(this.build);
  }

  loadSlot(i: number): void {
    const s = this.slots()[i];
    if (!s) return;
    this.change((b) => Object.assign(b, quantizeBuild(s)), 'confirm');
    this.scene3d?.pulse(1);
    this.toast(`Loaded slot ${i + 1}`);
  }

  clearSlot(i: number): void {
    this.ctx.save.update((d) => (d.garage.slots[i] = null));
    this.ctx.save.flush();
    this.sound('back');
    this.ui?.refresh(this.build);
  }

  shareCode(): string {
    return encodeShareCode(this.build);
  }

  shareLinkText(): string {
    return shareLink(this.build);
  }

  async copyLink(): Promise<boolean> {
    const ok = await copyText(this.shareLinkText());
    this.sound(ok ? 'confirm' : 'back');
    if (ok) this.toast('Link copied — share your car!');
    return ok;
  }

  loadCode(text: string): boolean {
    const b = decodeShareCode(text);
    if (!b) {
      this.sound('back');
      this.toast("That code doesn't look right");
      return false;
    }
    this.change((x) => Object.assign(x, b), 'confirm');
    this.scene3d?.pulse(1);
    this.toast('Shared car loaded');
    return true;
  }

  sound(kind: UISound): void {
    try {
      this.ctx.audio.ui(kind);
    } catch {
      /* audio is optional */
    }
  }

  speedUnit(): 'kmh' | 'mph' {
    return this.ctx.settings.values.units === 'mph' ? 'mph' : 'kmh';
  }

  layoutChanged(): void {
    this.insetsDirty = true;
  }

  // ───────────────────────────── internals ─────────────────────────────
  private toast(text: string): void {
    this.ctx.events.emit('toast', { text, ms: 1800 });
  }

  private applyQuality(): void {
    const level = this.ctx.quality.level;
    this.scene3d?.setReflections(level !== 'low', level === 'high');
  }

  private updateInsets(): void {
    if (!this.ui || !this.orbit) return;
    const { top, bottom } = this.ui.getInsets();
    this.orbit.setViewInsets(top, bottom);
    this.insetsDirty = false;
  }

  /** Create / update the preview car for the current build. */
  private syncVisual(animate: boolean): void {
    const scene = this.scene3d;
    if (!scene) return;
    const b = this.build;
    const key = `${b.model}|${b.wheels.size}|${b.wheels.tyre}|${b.kit.spoiler}|${b.kit.splitter}|${b.kit.skirts}|${b.kit.scoop}`;
    try {
      if (!this.visual || this.visualModel !== b.model) {
        const old = this.visual;
        const v = this.ctx.cars.create(cloneBuild(b), { lod: 'high' });
        scene.setCar(v, animate);
        this.visual = v;
        this.visualModel = b.model;
        if (old) {
          try {
            old.dispose();
          } catch (err) {
            reportError('[garage] dispose of previous car failed', err);
          }
        }
        this.orbit?.frame(scene.carSize, scene.carCenterY, !old);
      } else {
        this.visual.applyBuild(cloneBuild(b));
        if (key !== this.appliedKey) {
          scene.refreshCar();
          this.orbit?.frame(scene.carSize, scene.carCenterY, false);
        }
        if (animate) scene.pulse(0.35);
      }
      this.appliedKey = key;
      scene.applyStance(b);
      this.visual.setLights({ brake: false, reverse: false, headlights: true, underglow: b.extras.underglow !== null });
      scene.setAccent(b.extras.underglow ?? '#ff8a7a');
    } catch (err) {
      reportError('[garage] car preview failed', err);
    }
  }

  /** `?car=CODE` in the URL → becomes the current car; the param is removed from the address bar. */
  private handleUrlShareCode(): void {
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(location.search);
    } catch {
      return;
    }
    const code = params.get('car');
    if (code === null) return;
    const b = decodeShareCode(code);
    params.delete('car');
    try {
      const qs = params.toString().replace(/=(&|$)/g, '$1');
      history.replaceState(history.state, '', `${location.pathname}${qs ? '?' + qs : ''}${location.hash}`);
    } catch {
      /* ignore (sandboxed iframes) */
    }
    if (b) {
      this.ctx.save.update((d) => (d.garage.current = cloneBuild(b)));
      this.announce('Shared car loaded');
    } else this.announce("That share link didn't work");
  }

  /** Toast once the player can see it (after the title screen). */
  private announce(text: string): void {
    const visible = (s: string) => s === 'menu' || s === 'driving' || s === 'garage';
    if (visible(this.ctx.game.state)) {
      this.ctx.events.emit('toast', { text, ms: 2600 });
      return;
    }
    const off = this.ctx.events.on('stateChanged', ({ to }) => {
      if (!visible(to)) return;
      off();
      window.setTimeout(() => this.ctx.events.emit('toast', { text, ms: 2600 }), 300);
    });
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (typing) t!.blur();
      else this.back();
      e.preventDefault();
    }
  };

  private onResize = (): void => {
    this.insetsDirty = true;
  };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
