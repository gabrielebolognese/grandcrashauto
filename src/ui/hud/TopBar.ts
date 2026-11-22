import { CONFIG } from '../../config';
import { toggleFullscreen } from '../../game/Game';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { ICON, icon, type IconName } from '../icons';
import { uiSound } from '../widgets';

const CAM_NAMES: Record<string, string> = { chase: 'Chase cam', hood: 'Hood cam', orbit: 'Orbit cam', cinematic: 'Cinematic', showcase: 'Showcase' };

export const fullscreenSupported = (): boolean => {
  const d = document as Document & { webkitFullscreenEnabled?: boolean };
  return !!(document.fullscreenEnabled || d.webkitFullscreenEnabled);
};
export const isFullscreen = (): boolean => !!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);

/**
 * Driving top bar (spec §9/§10): 💥 Explode / ↺ Reset (tap; long-press = reset any time, with a progress ring),
 * camera, horn (hold), look-back (hold), pause, fullscreen. Shown on desktop too (clickable, with key hints).
 */
export class TopBar {
  readonly el: HTMLDivElement;
  private boom: HTMLButtonElement;
  private boomLabel: HTMLSpanElement;
  private boomEmoji: HTMLSpanElement;
  private ring: SVGRectElement;
  private camLabel: HTMLDivElement;
  private fsBtn: HTMLButtonElement;
  private lpPtr: number | null = null;
  private lpStart = -1;
  private lpFired = false;
  private exploded: boolean | null = null;
  private camPending = 0;
  private camLabelT = 0;

  constructor(private host: UIHost) {
    const { ctx } = host;
    // ── Explode / Reset ──
    this.boomEmoji = h('span', { class: 'boom-emoji', text: '💥' });
    this.boomLabel = h('span', { class: 'boom-label', text: 'Explode' });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'boom-ring');
    svg.setAttribute('viewBox', '0 0 160 56');
    svg.setAttribute('preserveAspectRatio', 'none');
    this.ring = document.createElementNS(svgNS, 'rect');
    for (const [k, v] of Object.entries({ x: '2', y: '2', width: '156', height: '52', rx: '26', pathLength: '100' })) this.ring.setAttribute(k, v);
    svg.append(this.ring);
    this.boom = h(
      'button',
      { class: 'boom-btn touch-ctl', type: 'button', 'aria-label': 'Explode' },
      h('span', { class: 'boom-face' }, svg, this.boomEmoji, this.boomLabel),
      h('kbd', { class: 'tb-key', text: 'X' }),
      h('span', { class: 'boom-hint', text: 'Hold to reset' }),
    );
    this.bindBoom();

    // ── icon buttons ──
    const tap = (name: IconName, label: string, key: string | null, fn: () => void, cls = '') => {
      const b = h('button', { class: `tb-btn touch-ctl ${cls}`, type: 'button', 'aria-label': label, title: label }, h('span', { class: 'tb-face' }, icon(name)), key ? h('kbd', { class: 'tb-key', text: key }) : null);
      b.addEventListener('click', () => {
        uiSound('click');
        fn();
      });
      return b;
    };
    const hold = (name: IconName, label: string, key: string, cls: string, set: (on: boolean) => void) => {
      const b = h('button', { class: `tb-btn touch-ctl ${cls}`, type: 'button', 'aria-label': label, title: label }, h('span', { class: 'tb-face' }, icon(name)), h('kbd', { class: 'tb-key', text: key }));
      let ptr: number | null = null;
      b.addEventListener('pointerdown', (e) => {
        if (ptr !== null) return;
        e.preventDefault();
        ptr = e.pointerId;
        try {
          b.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        b.classList.add('down');
        set(true);
      });
      const end = (e: PointerEvent) => {
        if (e.pointerId !== ptr) return;
        ptr = null;
        b.classList.remove('down');
        set(false);
      };
      b.addEventListener('pointerup', end);
      b.addEventListener('pointercancel', end);
      b.addEventListener('lostpointercapture', end);
      return b;
    };
    const horn = hold('horn', 'Horn', 'H', 'tb-horn', (on) => (ctx.input.touch.horn = on));
    const look = hold('lookBack', 'Look back', 'Q', 'tb-look', (on) => (ctx.input.touch.lookBack = on));
    const cam = tap('camera', 'Camera', 'C', () => {
      ctx.input.press('camera');
      this.camPending = 2;
    });
    this.fsBtn = tap('fullscreen', 'Fullscreen', null, () => toggleFullscreen(), 'tb-fs');
    if (!fullscreenSupported()) this.fsBtn.style.display = 'none';
    const pause = tap('pause', 'Pause', 'Esc', () => ctx.game.pause(), 'tb-pause');
    this.camLabel = h('div', { class: 'cam-label' });

    const onFs = () => {
      const fs = isFullscreen();
      this.fsBtn.querySelector('.ic')!.innerHTML = fs ? ICON.fullscreenExit : ICON.fullscreen;
      this.fsBtn.setAttribute('aria-label', fs ? 'Exit fullscreen' : 'Fullscreen');
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);

    this.el = h(
      'div',
      { class: 'topbar', 'aria-hidden': 'true' },
      h('div', { class: 'tb-center' }, this.boom),
      h('div', { class: 'tb-right' }, horn, look, cam, this.fsBtn, pause),
      this.camLabel,
    );
  }

  setVisible(on: boolean): void {
    setVisible(this.el, on);
    if (!on) this.cancelLongPress();
  }

  private bindBoom(): void {
    const b = this.boom;
    b.addEventListener('pointerdown', (e) => {
      if (this.lpPtr !== null) return;
      e.preventDefault();
      this.lpPtr = e.pointerId;
      this.lpStart = performance.now();
      this.lpFired = false;
      try {
        b.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      b.classList.add('pressed');
    });
    b.addEventListener('pointerup', (e) => {
      if (e.pointerId !== this.lpPtr) return;
      const fired = this.lpFired;
      this.cancelLongPress();
      if (!fired) this.fire();
    });
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === this.lpPtr) this.cancelLongPress();
    };
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('lostpointercapture', cancel);
    // Keyboard activation (Enter/Space while focused) arrives as a click with detail 0.
    b.addEventListener('click', (e) => {
      if (e.detail === 0) this.fire();
    });
  }

  private fire(): void {
    const { ctx } = this.host;
    const wasExploded = ctx.vehicle.state.exploded;
    uiSound(wasExploded ? 'confirm' : 'click');
    ctx.game.explodeOrReset(); // the 'explosion' event triggers the haptic buzz
  }

  private cancelLongPress(): void {
    this.lpPtr = null;
    this.lpStart = -1;
    this.boom.classList.remove('pressed', 'charging');
    this.ring.style.strokeDashoffset = '100';
  }

  update(dt: number): void {
    const { ctx } = this.host;
    const exploded = !!ctx.vehicle.state.exploded;
    if (exploded !== this.exploded) {
      this.exploded = exploded;
      this.boom.classList.toggle('is-reset', exploded);
      setText(this.boomEmoji, exploded ? '↺' : '💥');
      setText(this.boomLabel, exploded ? 'Reset' : 'Explode');
      this.boom.setAttribute('aria-label', exploded ? 'Reset car' : 'Explode');
      const key = this.boom.querySelector('.tb-key') as HTMLElement;
      setText(key, exploded ? 'R' : 'X');
    }
    // Long-press progress ring → reset at any time.
    if (this.lpStart >= 0 && !this.lpFired) {
      const held = performance.now() - this.lpStart;
      const t = held / Math.max(1, CONFIG.ui.longPressResetMs);
      if (held > 120) {
        this.boom.classList.add('charging');
        this.ring.style.strokeDashoffset = String(100 - Math.min(1, t) * 100);
      }
      if (t >= 1) {
        this.lpFired = true;
        this.boom.classList.remove('charging');
        this.boom.classList.add('fired');
        window.setTimeout(() => this.boom.classList.remove('fired'), 400);
        uiSound('confirm');
        this.host.vibrate(25);
        ctx.game.requestReset();
      }
    }
    // Camera mode label after the camera button (read on the next frames once the rig switched).
    if (this.camPending > 0 && --this.camPending === 0) {
      setText(this.camLabel, CAM_NAMES[ctx.cameraRig.mode] ?? ctx.cameraRig.mode);
      this.camLabel.classList.add('show');
      this.camLabelT = 1.1;
    }
    if (this.camLabelT > 0) {
      this.camLabelT -= dt;
      if (this.camLabelT <= 0) this.camLabel.classList.remove('show');
    }
  }
}
