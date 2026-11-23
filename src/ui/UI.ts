import './theme.css';
import './ui.css';
import './hud.css';
import { CONFIG } from '../config';
import type { GameState } from '../core/events';
import type { InputDevice } from '../core/Input';
import { isMobileDevice } from '../core/Quality';
import { toggleFullscreen } from '../game/Game';
import type { GameContext, IUI } from '../game/contracts';
import { DebugPanel } from './debug/DebugPanel';
import { h, isTouchPrimary } from './dom';
import { installGestureGuards } from './gestures';
import type { ConfirmOpts, Screen, UIHost } from './host';
import { Hud, Toasts } from './hud/Hud';
import { fullscreenSupported, isFullscreen, TopBar } from './hud/TopBar';
import { MenuNav } from './MenuNav';
import { Fader, RotateOverlay, showFatal } from './overlays';
import { BootScreen } from './screens/BootScreen';
import { ConfirmDialog } from './screens/ConfirmDialog';
import { CreditsScreen } from './screens/CreditsScreen';
import { MainMenu } from './screens/MainMenu';
import { PauseMenu } from './screens/PauseMenu';
import { SettingsScreen } from './screens/SettingsScreen';
import { TitleScreen } from './screens/TitleScreen';
import { Tilt } from './touch/Tilt';
import { TouchControls } from './touch/TouchControls';
import { FlightControls } from './touch/FlightControls';
import { WalkControls } from './touch/WalkControls';
import { FlightHud } from './hud/FlightHud';
import { Stunts } from './hud/Stunts';
import { setWidgetSound } from './widgets';

type SubScreen = { kind: 'settings' | 'credits'; parent: GameState };

/**
 * UI module (spec §9, §10, §13): loading/title, main & pause menus, settings, credits, HUD + minimap, touch
 * controls, top bar (💥/↺), rotate overlay, reset fade, debug panel. Plain DOM + CSS inside #ui-root.
 */
export class UI implements IUI, UIHost {
  readonly name = 'ui';
  readonly tilt = new Tilt();
  readonly isMobile = isMobileDevice();

  private root!: HTMLElement;
  private boot: BootScreen | null = null;
  private title!: TitleScreen;
  private menu!: MainMenu;
  private pause!: PauseMenu;
  private settings!: SettingsScreen;
  private credits!: CreditsScreen;
  private dialog!: ConfirmDialog;
  private hud!: Hud;
  private toasts!: Toasts;
  private topbar!: TopBar;
  private touch!: TouchControls;
  private flightCtl!: FlightControls;
  private flightHud!: FlightHud;
  private walkCtl!: WalkControls;
  private stunts!: Stunts;
  private fader!: Fader;
  private rotate!: RotateOverlay;
  private debugPanel: DebugPanel | null = null;
  private nav!: MenuNav;

  private inited = false;
  private state: GameState = 'boot';
  private sub: SubScreen | null = null;
  private device: InputDevice;
  private seenInputDevice: InputDevice;
  private touchOn = false;
  private forceTouch = new URLSearchParams(location.search).has('touch');
  private dragId: number | null = null;
  private dragX = 0;
  private dragY = 0;
  private lastImpactVib = 0;
  private rotateT = 0;
  private padHeld = true;
  private moving = false;
  private pedaling = false;
  private planeMode: boolean | null = null;

  constructor(readonly ctx: GameContext) {
    this.device = isTouchPrimary() || this.isMobile ? 'touch' : 'keyboard';
    this.seenInputDevice = 'keyboard';
  }

  // ─────────────────────────────── IUI ───────────────────────────────
  init(): void {
    if (this.inited) return;
    this.inited = true;
    const { ctx } = this;
    installGestureGuards();
    setWidgetSound((k) => ctx.audio?.ui?.(k));
    this.boot ??= new BootScreen();

    let root = document.getElementById('ui-root');
    if (!root) {
      root = h('div', { id: 'ui-root' });
      document.body.append(root);
    }
    this.root = root;
    root.classList.toggle('is-mobile', this.isMobile);

    this.nav = new MenuNav();
    this.hud = new Hud(this);
    this.toasts = new Toasts();
    this.topbar = new TopBar(this);
    this.touch = new TouchControls(this);
    this.flightCtl = new FlightControls(this);
    this.flightHud = new FlightHud(this);
    this.walkCtl = new WalkControls(this);
    this.stunts = new Stunts(this);
    this.title = new TitleScreen(this, () => this.startFromTitle());
    this.menu = new MainMenu(this);
    this.pause = new PauseMenu(this);
    this.settings = new SettingsScreen(this);
    this.credits = new CreditsScreen(this);
    this.dialog = new ConfirmDialog();
    this.fader = new Fader();
    this.rotate = new RotateOverlay(() => this.onRotateTap());
    root.append(
      this.flightHud.overlay,
      this.stunts.lines,
      this.hud.el,
      this.walkCtl.el,
      this.flightHud.el,
      this.stunts.el,
      this.flightCtl.el,
      this.touch.el,
      this.topbar.el,
      this.hud.fps,
      this.toasts.el,
      this.title.el,
      this.menu.el,
      this.pause.el,
      this.settings.el,
      this.credits.el,
      this.dialog.el,
      this.fader.el,
      this.rotate.el,
    );
    if (ctx.debug) {
      this.debugPanel = new DebugPanel(this);
      root.append(this.debugPanel.el);
    }

    // ── events ──
    ctx.events.on('stateChanged', ({ to }) => this.applyState(to));
    ctx.events.on('settingsChanged', () => this.applySettings());
    ctx.events.on('toast', ({ text, ms }) => this.toast(text, ms));
    ctx.events.on('vibrate', ({ pattern }) => this.vibrate(pattern));
    ctx.events.on('impact', ({ strength }) => {
      if (this.state !== 'driving' || strength < CONFIG.ui.vibrateImpactMin) return;
      const now = performance.now();
      if (now - this.lastImpactVib < 140) return;
      this.lastImpactVib = now;
      this.vibrate(Math.round(12 + Math.min(1, strength) * 60));
    });
    ctx.events.on('explosion', () => this.vibrate([60, 40, 150]));
    ctx.events.on('turbo', ({ on }) => on && this.vibrate(22));
    ctx.events.on('modeChanged', () => this.refreshMode());

    // 'Opacity while moving' replaced the old idle opacity (old default 0.55 → new default 0.3).
    if (Math.abs(ctx.settings.values.controlsOpacity - 0.55) < 1e-6) ctx.settings.set({ controlsOpacity: 0.3 });

    // ── title: any key / gamepad button also starts ──
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.state === 'title' && !e.repeat && !e.metaKey && !e.altKey && e.key !== 'Tab') this.startFromTitle();
      },
      true,
    );
    // ── orbit drag on empty canvas while driving ──
    this.bindOrbitDrag(ctx.engine.canvas);
    // ── orientation / visibility ──
    const onResize = () => this.checkRotate();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => window.setTimeout(onResize, 120));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'driving') ctx.game.pause();
    });

    this.applySettings();
    this.refreshTouchMode(true);
    this.applyState(ctx.game.state);
  }

  setLoading(progress: number, label: string): void {
    this.boot ??= new BootScreen();
    this.boot.setLoading(progress, label);
  }

  fade(cb: () => void): void {
    if (!this.fader) {
      cb();
      return;
    }
    this.fader.fade(cb);
  }

  showFatal(message: string): void {
    showFatal(message);
  }

  // ─────────────────────────────── UIHost ───────────────────────────────
  touchMode(): boolean {
    return this.forceTouch || this.device === 'touch';
  }

  openSettings(tab?: string): void {
    if (this.state !== 'menu' && this.state !== 'paused') return;
    if (tab) this.settings.showTab(tab);
    this.sub = { kind: 'settings', parent: this.state };
    this.menu.setVisible(false);
    this.pause.setVisible(false);
    this.credits.setVisible(false);
    this.settings.open(() => this.closeSub());
    this.updateScope();
  }

  openCredits(): void {
    if (this.state !== 'menu' && this.state !== 'paused') return;
    this.sub = { kind: 'credits', parent: this.state };
    this.menu.setVisible(false);
    this.pause.setVisible(false);
    this.settings.setVisible(false);
    this.credits.open(() => this.closeSub());
    this.updateScope();
  }

  closeSub(): void {
    this.sub = null;
    this.settings.setVisible(false);
    this.credits.setVisible(false);
    this.menu.setVisible(this.state === 'menu');
    this.pause.setVisible(this.state === 'paused');
    this.updateScope();
  }

  confirm(opts: ConfirmOpts): Promise<boolean> {
    const p = this.dialog.ask(opts);
    this.updateScope();
    return p.finally(() => this.updateScope());
  }

  toast(text: string, ms?: number): void {
    this.toasts?.show(text, ms ?? CONFIG.ui.toastMs);
  }

  vibrate(pattern: number | number[]): void {
    if (!this.ctx.settings.values.vibration) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* unsupported */
    }
  }

  // ─────────────────────────────── state & settings ───────────────────────────────
  private applyState(to: GameState): void {
    this.state = to;
    this.root.dataset.state = to;
    if (to !== 'boot') this.boot?.hide();
    if (this.sub && this.sub.parent !== to) {
      this.sub = null;
      this.settings.setVisible(false);
      this.credits.setVisible(false);
    }
    if (this.dialog.open && to !== 'menu' && to !== 'paused') this.dialog.back();
    this.title.setVisible(to === 'title');
    this.menu.setVisible(to === 'menu' && !this.sub);
    this.pause.setVisible(to === 'paused' && !this.sub);
    this.hud.setVisible(to === 'driving');
    this.topbar.setVisible(to === 'driving');
    this.refreshLayers();
    this.dragId = null;
    this.refreshTouchMode(true);
    this.checkRotate();
    this.updateScope();
  }

  private updateScope(): void {
    let s: Screen | null = null;
    if (this.dialog.open) s = this.dialog;
    else if (this.sub) s = this.sub.kind === 'settings' ? this.settings : this.credits;
    else if (this.state === 'menu') s = this.menu;
    else if (this.state === 'paused') s = this.pause;
    this.nav.setScope(s);
  }

  private applySettings(): void {
    const s = this.ctx.settings.values;
    this.root.style.setProperty('--cs', String(s.controlsScale));
    this.root.style.setProperty('--co', String(s.controlsOpacity));
    this.root.classList.toggle('lefty', s.leftHanded);
    this.touch.applyMode();
    this.flightCtl.el.classList.toggle('lefty', s.leftHanded);
  }

  /** Track the active input device; show touch controls only for touch play. */
  private refreshTouchMode(force = false): void {
    const ld = this.ctx.input.lastDevice;
    if (ld !== this.seenInputDevice) {
      this.seenInputDevice = ld;
      this.device = ld;
    }
    const on = this.touchMode();
    if (on !== this.touchOn || force) {
      this.touchOn = on;
      this.root.classList.toggle('is-touch', on);
    }
    this.refreshLayers();
  }

  private checkRotate(): void {
    const portrait = window.innerHeight > window.innerWidth * 1.08;
    const show = portrait && (this.isMobile || this.device === 'touch') && this.state !== 'boot';
    this.rotate.set(show);
    if (show && this.state === 'driving') this.ctx.game.pause();
    this.refreshLayers();
  }

  private onRotateTap(): void {
    if (fullscreenSupported() && !isFullscreen()) toggleFullscreen();
    else lockLandscape();
  }

  private startFromTitle(): void {
    if (this.state !== 'title') return;
    const { ctx } = this;
    if (this.touchMode() || this.isMobile) {
      if (fullscreenSupported() && !isFullscreen()) toggleFullscreen();
      else lockLandscape();
    }
    if (ctx.settings.values.steeringMode === 'tilt' && this.tilt.permission === 'unknown') void this.tilt.request();
    try {
      ctx.audio?.ui?.('confirm');
    } catch {
      /* audio not ready */
    }
    ctx.game.titleDone();
  }

  private bindOrbitDrag(cv: HTMLCanvasElement): void {
    cv.addEventListener('pointerdown', (e) => {
      if (this.state !== 'driving' || this.dragId !== null) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      this.dragId = e.pointerId;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.dragId) return;
      const dx = e.clientX - this.dragX;
      const dy = e.clientY - this.dragY;
      this.dragX = e.clientX;
      this.dragY = e.clientY;
      if ((dx || dy) && this.state === 'driving') {
        const k = CONFIG.ui.orbitDragScale;
        this.ctx.cameraRig.orbitDrag?.(dx * k, dy * k);
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.dragId) this.dragId = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', end);
  }

  // ─────────────────────────────── per frame ───────────────────────────────
  update(dt: number): void {
    if (!this.inited) return;
    const st = this.state;
    this.refreshTouchMode();
    this.refreshMode();
    this.refreshMoving();
    this.rotateT -= dt;
    if (this.rotateT <= 0) {
      this.rotateT = 0.5;
      this.checkRotate();
    }
    this.nav.update(dt);
    if (st === 'title') this.pollTitlePad();
    if (st === 'driving') {
      this.refreshLayers();
      this.hud.update(dt);
      this.topbar.update(dt);
      this.touch.update(dt);
      this.flightHud.update(dt);
      this.flightCtl.update(dt);
      this.walkCtl.update();
      this.stunts.update();
    } else if (st === 'paused') {
      // The nav Map screen can open from the pause menu: get out of its way while it is up.
      const mapOpen = !!this.ctx.nav?.mapOpen;
      this.pause.el.classList.toggle('under-map', mapOpen);
    }
    this.hud.updateFps(dt);
    this.debugPanel?.update(dt);
  }

  /** Which control/HUD layers are up: car vs plane, touch vs desktop, crash/cockpit sequence, portrait. */
  private refreshLayers(): void {
    const driving = this.state === 'driving';
    const plane = driving && this.ctx.game.mode === 'plane';
    const touch = this.touchOn && !this.rotate?.shown;
    const planes = this.ctx.planes;
    this.touch.setVisible(driving && !plane && touch);
    this.flightHud.setVisible(plane);
    const walking = plane && !!this.ctx.walker?.active;
    const replay = !!this.ctx.replay?.active;
    this.flightCtl.setVisible(plane && touch && !planes?.crashed && !planes?.inCockpitSequence && !walking && !replay);
    this.walkCtl.setVisible(walking && !replay);
    this.root.classList.toggle('replaying', replay);
    this.stunts.setVisible(driving && !plane);
  }

  private refreshMode(): void {
    const plane = this.ctx.game.mode === 'plane';
    if (plane === this.planeMode) return;
    this.planeMode = plane;
    this.root.classList.toggle('mode-plane', plane);
    this.touch.releaseAll();
    this.flightCtl.releaseAll();
  }

  /** Controls are fully opaque when (nearly) stopped and fade to settings.controlsOpacity while moving. */
  private refreshMoving(): void {
    const { ctx } = this;
    let kmh = 0;
    if (this.state === 'driving') {
      if (ctx.game.mode === 'plane') kmh = ctx.planes?.state?.groundSpeedKmh ?? ctx.planes?.state?.airspeedKmh ?? 0;
      else kmh = ctx.vehicle.state.speedKmh || 0;
    }
    const on = CONFIG.ui.fadeMovingKmh;
    const moving = this.moving ? kmh > on * 0.6 : kmh > on;
    if (moving !== this.moving) {
      this.moving = moving;
      this.root.classList.toggle('moving', moving);
    }
    // Gas/brake (car) or stick (plane) held → the explode button may fade; released → solid at once.
    const st = ctx.input.state;
    const t = ctx.input.touch;
    const pedaling =
      this.state === 'driving' &&
      (ctx.game.mode === 'plane'
        ? Math.abs(st.pitch) > 0.05 || Math.abs(st.roll) > 0.05 || Math.abs(t.pitch) > 0.05 || Math.abs(t.roll) > 0.05
        : st.throttle > 0.05 || st.brake > 0.05 || t.throttle > 0.05 || t.brake > 0.05 || t.turbo);
    if (pedaling !== this.pedaling) {
      this.pedaling = pedaling;
      this.root.classList.toggle('pedaling', pedaling);
    }
  }

  private pollTitlePad(): void {
    const pads = navigator.getGamepads?.() ?? [];
    let any = false;
    for (const g of pads) if (g && g.connected && g.buttons.some((b) => b.pressed)) any = true;
    if (any && !this.padHeld) this.startFromTitle();
    this.padHeld = any;
  }
}

function lockLandscape(): void {
  try {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    o?.lock?.('landscape').catch(() => {});
  } catch {
    /* unsupported */
  }
}
