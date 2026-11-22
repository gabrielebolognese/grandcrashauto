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
 * Driving controls that are not pedals/steering:
 *  - one grouped cluster (top-centre): map, camera, lights, horn (hold), look-back (hold), fullscreen, pause;
 *  - 💥 Explode / ↺ Reset at the bottom-centre (tap; long-press = reset at any time, with a progress ring), and in
 *    plane mode also Explode middle, Explode tail and Reset.
 */
export class TopBar {
  readonly el: HTMLDivElement;
  private boom: HTMLButtonElement;
  private boomLabel: HTMLSpanElement;
  private boomEmoji: HTMLSpanElement;
  private ring: SVGRectElement;
  private camLabel: HTMLDivElement;
  private fsBtn: HTMLButtonElement;
  private lightsBtn: HTMLButtonElement;
  private midBtn: HTMLButtonElement;
  private tailBtn: HTMLButtonElement;
  private lpPtr: number | null = null;
  private lpStart = -1;
  private lpFired = false;
  private boomState = '';
  private lightsState = '';
  private camPending = 0;
  private camLabelT = 0;

  constructor(private host: UIHost) {
    const { ctx } = host;
    // ── 💥 / ↺ ──
    this.boomEmoji = h('span', { class: 'boom-emoji', text: '💥' });
    this.boomLabel = h('span', { class: 'boom-label', text: 'Explode' });
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'boom-ring');
    svg.setAttribute('viewBox', '0 0 130 46');
    svg.setAttribute('preserveAspectRatio', 'none');
    this.ring = document.createElementNS(svgNS, 'rect');
    for (const [k, v] of Object.entries({ x: '1.5', y: '1.5', width: '127', height: '43', rx: '21.5', pathLength: '100' })) this.ring.setAttribute(k, v);
    svg.append(this.ring);
    this.boom = h(
      'button',
      { class: 'boom-btn touch-ctl boom-fade', type: 'button', 'aria-label': 'Explode' },
      h('span', { class: 'boom-face' }, svg, this.boomEmoji, this.boomLabel),
      h('kbd', { class: 'tb-key', text: 'X' }),
      h('span', { class: 'boom-hint', text: 'Hold to reset' }),
    );
    this.bindBoom();
    const round = (name: IconName, label: string, key: string, fn: () => void) => {
      const b = h('button', { class: 'round-act touch-ctl boom-fade only-plane', type: 'button', 'aria-label': label, title: label }, icon(name), h('kbd', { class: 'tb-key', text: key }));
      b.addEventListener('click', () => {
        uiSound('click');
        fn();
      });
      return b;
    };
    this.midBtn = round('split', 'Explode middle', 'M', () => ctx.input.press('explodeMiddle'));
    this.tailBtn = round('tail', 'Explode tail', 'T', () => ctx.input.press('explodeTail'));
    const resetBtn = round('reset', 'Reset plane', 'R', () => ctx.game.requestReset());

    // ── grouped cluster ──
    const tap = (name: IconName, label: string, key: string | null, fn: () => void, cls = '') => {
      const b = h('button', { class: `tb-btn touch-ctl ${cls}`, type: 'button', 'aria-label': label, title: label }, icon(name), key ? h('kbd', { class: 'tb-key', text: key }) : null);
      b.addEventListener('click', () => {
        uiSound('click');
        fn();
      });
      return b;
    };
    const hold = (name: IconName, label: string, key: string, cls: string, set: (on: boolean) => void) => {
      const b = h('button', { class: `tb-btn touch-ctl ${cls}`, type: 'button', 'aria-label': label, title: label }, icon(name), h('kbd', { class: 'tb-key', text: key }));
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
    const map = tap('map', 'Map', 'N', () => ctx.nav?.openMap?.());
    const cam = tap('camera', 'Camera', 'C', () => {
      ctx.input.press('camera');
      this.camPending = 2;
    });
    this.lightsBtn = tap('headlight', 'Headlights', 'L', () => ctx.input.press('lights'), 'only-car');
    const horn = hold('horn', 'Horn', 'H', 'only-car only-touch', (on) => (ctx.input.touch.horn = on));
    const look = hold('lookBack', 'Look back', 'B', 'only-car only-touch', (on) => (ctx.input.touch.lookBack = on));
    this.fsBtn = tap('fullscreen', 'Fullscreen', null, () => toggleFullscreen());
    if (!fullscreenSupported()) this.fsBtn.style.display = 'none';
    const pause = tap('pause', 'Pause', 'Esc', () => ctx.game.pause());
    // One-tap time of day: day → sunset → night → day (user request).
    const dayNight = tap('sun', 'Day / night', null, () => {
      const env = ctx.env;
      if (!env?.setTime) return;
      const hr = env.clockHours ?? 12;
      const next = hr >= 6.5 && hr < 17.5 ? 19.3 : hr >= 17.5 && hr < 21.5 ? 23 : 12;
      env.setTime(next);
      ctx.events.emit('toast', { text: next === 12 ? '☀ Day' : next === 23 ? '🌙 Night' : '🌇 Sunset', ms: 900 });
    });
    // Plane: Explode middle / tail live behind a small "more" toggle so the view stays clear.
    const more = h('button', { class: 'round-act touch-ctl boom-fade only-plane more-btn', type: 'button', 'aria-label': 'More explosions', title: 'Explode middle / tail' }, h('span', { text: '⋯' }));
    this.midBtn.classList.add('extra');
    this.tailBtn.classList.add('extra');
    void resetBtn; // plane reset = long-press 💥 or R (no separate button)
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
      h('div', { class: 'tb-cluster fade-ctl', role: 'toolbar', 'aria-label': 'Game controls' }, map, cam, dayNight, this.lightsBtn, horn, look, this.fsBtn, pause),
      h('div', { class: 'boom-wrap' }, this.midBtn, this.boom, this.tailBtn, more),
      this.camLabel,
    );
    const wrap = this.el.querySelector('.boom-wrap') as HTMLDivElement;
    more.addEventListener('click', () => {
      uiSound('click');
      wrap.classList.toggle('extra-open');
    });
    for (const b of [this.midBtn, this.tailBtn]) b.addEventListener('click', () => wrap.classList.remove('extra-open'));
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

  private isResetState(): boolean {
    const { ctx } = this.host;
    return ctx.game.mode === 'plane' ? !!ctx.planes?.crashed : !!ctx.vehicle.state.exploded;
  }

  private fire(): void {
    uiSound(this.isResetState() ? 'confirm' : 'click');
    this.host.ctx.game.explodeOrReset(); // the 'explosion' event triggers the haptic buzz
  }

  private cancelLongPress(): void {
    this.lpPtr = null;
    this.lpStart = -1;
    this.boom.classList.remove('pressed', 'charging');
    this.ring.style.strokeDashoffset = '100';
  }

  update(dt: number): void {
    const { ctx } = this.host;
    const plane = ctx.game.mode === 'plane';
    const reset = this.isResetState();
    const st = `${plane}|${reset}`;
    if (st !== this.boomState) {
      this.boomState = st;
      this.boom.classList.toggle('is-reset', reset);
      setText(this.boomEmoji, reset ? '↺' : '💥');
      setText(this.boomLabel, reset ? 'Reset' : 'Explode');
      this.boom.setAttribute('aria-label', reset ? (plane ? 'Respawn plane' : 'Reset car') : 'Explode');
      setText(this.boom.querySelector('.tb-key') as HTMLElement, reset ? 'R' : 'X');
    }
    if (plane) {
      const ps = ctx.planes?.state;
      const crashed = !!ctx.planes?.crashed;
      this.midBtn.disabled = crashed || !!ps?.damage.split;
      this.tailBtn.disabled = crashed || !!ps?.damage.split || !!ps?.damage.tailLost;
    } else {
      const hl = ctx.vehicle.state.headlights ?? 'off';
      if (hl !== this.lightsState) {
        this.lightsState = hl;
        this.lightsBtn.classList.toggle('on', hl === 'low');
        this.lightsBtn.classList.toggle('hi', hl === 'high');
        this.lightsBtn.title = `Headlights: ${hl}`;
      }
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
    // Camera mode label (read a couple of frames later, once the rig switched).
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
