import './flight.css';
import { MPH } from '../../core/math';
import { PLANE_TYPES, type PlaneEngineStatus, type PlaneTypeId } from '../../plane/types';
import { h, setText, setVisible } from '../dom';
import type { UIHost } from '../host';
import { icon, type IconName } from '../icons';
import { uiSound } from '../widgets';

const INK = 'rgba(255,255,255,0.95)';
const PANEL = 'rgba(24, 34, 60, 0.55)';
const PANEL_RED = 'rgba(190, 40, 34, 0.72)';

/** A small DPR-aware canvas that redraws only when its key changes. */
class Gauge {
  readonly canvas: HTMLCanvasElement;
  readonly g: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  dpr = 1;
  key = '';
  constructor(cls: string) {
    this.canvas = h('canvas', { class: cls, 'aria-hidden': 'true' });
    this.g = this.canvas.getContext('2d')!;
  }
  /** Returns false when the canvas is not laid out (hidden). */
  fit(): boolean {
    const w = this.canvas.clientWidth;
    const hh = this.canvas.clientHeight;
    if (!w || !hh) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w !== this.w || hh !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = hh;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(hh * dpr);
      this.key = '';
    }
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, hh: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + hh, r);
  g.arcTo(x + w, y + hh, x, y + hh, r);
  g.arcTo(x, y + hh, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Flight HUD (SPEC-PART2 §6/§7/§9): airspeed tape with Vr + stall band (red when the stall warning sounds),
 * altitude tape with vertical speed and ground band, heading strip, throttle/gear/flaps/brake status, engine
 * buttons 1..n with OK/fire/destroyed state, crash choices, Skip, out-of-map vignette + banner + countdown and
 * the flashing master-caution banner.
 */
export class FlightHud {
  readonly el: HTMLDivElement;
  readonly overlay: HTMLDivElement; // vignette (under everything)
  private spd = new Gauge('fl-tape fl-speed');
  private alt = new Gauge('fl-tape fl-alt');
  private hdg = new Gauge('fl-hdg');
  private thr: HTMLSpanElement;
  private gearChip: HTMLSpanElement;
  private flapChip: HTMLSpanElement;
  private brakeChip: HTMLSpanElement;
  private stall: HTMLDivElement;
  private engines: HTMLDivElement;
  private fireMeter: HTMLDivElement;
  private fireMeterKey = '';
  private engineBtns: HTMLButtonElement[] = [];
  private engineState: string[] = [];
  private crash: HTMLDivElement;
  private nudgePad: HTMLDivElement;
  private airborne: HTMLButtonElement;
  private switchPart: HTMLButtonElement;
  private dock: HTMLDivElement;
  private planeBtn: HTMLButtonElement;
  private walkBtn: HTMLButtonElement;
  private replayBtn: HTMLButtonElement;
  private camMBtn: HTMLButtonElement;
  private camMText: HTMLSpanElement;
  private camHBtn: HTMLButtonElement;
  private camHKey: HTMLElement;
  private watchBtn: HTMLButtonElement;
  private watchText: HTMLSpanElement;
  private wingsBtn: HTMLButtonElement;
  private wingsPanel: HTMLDivElement;
  private replayBar: HTMLDivElement;
  private replayCam: HTMLSpanElement;
  private picker: HTMLDivElement;
  private pickerBtns: { t: PlaneTypeId; b: HTMLButtonElement }[] = [];
  private skip: HTMLButtonElement;
  private oomBanner: HTMLDivElement;
  private oomText: HTMLSpanElement;
  private oomCount: HTMLSpanElement;
  private caution: HTMLDivElement;
  private cautionT = 0;
  private visible = false;
  private crashShown = false;

  constructor(private host: UIHost) {
    const { ctx } = host;
    this.thr = h('span', { class: 'fl-chip' });
    this.gearChip = h('span', { class: 'fl-chip' });
    this.flapChip = h('span', { class: 'fl-chip' });
    this.brakeChip = h('span', { class: 'fl-chip fl-brk', text: 'BRAKE' });
    this.stall = h('div', { class: 'fl-stall', text: 'STALL' });
    this.oomText = h('span', { class: 'oom-text' });
    this.oomCount = h('span', { class: 'oom-count' });
    this.oomBanner = h('div', { class: 'oom-banner' }, icon('plane'), this.oomText, this.oomCount);
    this.caution = h('div', { class: 'fl-caution' });
    this.engines = h('div', { class: 'fl-engines', role: 'group', 'aria-label': 'Engines' });
    this.fireMeter = h('div', { class: 'fire-meter' });

    const choice = (name: IconName, label: string, sub: string, cls: string, fn: () => void) => {
      const b = h('button', { class: `crash-btn ${cls}`, type: 'button' }, icon(name), h('span', { class: 'cb-label' }, label, h('small', { text: sub })));
      b.addEventListener('click', () => {
        uiSound('confirm');
        fn();
      });
      return b;
    };
    this.crash = h(
      'div',
      { class: 'crash-panel', role: 'dialog', 'aria-label': 'Crashed' },
      h('div', { class: 'cp-title', text: 'What now?' }),
      h(
        'div',
        { class: 'cp-row' },
        choice('car', 'Back to car', 'Drive again', '', () => ctx.planes.backToCar()),
        choice('reset', 'Respawn plane', 'On its stand', 'primary', () => ctx.planes.respawnPlane()),
        choice('plane', 'Retry in air', 'At 500 m', '', () => ctx.planes.retryInAir()),
        choice('camera', 'Replay', 'More cameras', 'replay', () => ctx.replay.start()),
      ),
    );
    this.skip = h('button', { class: 'skip-btn touch-ctl', type: 'button' }, h('span', { text: 'Skip' }), icon('skip'), h('kbd', { class: 'pb-key', text: 'Enter' }));
    this.skip.addEventListener('click', () => {
      uiSound('click');
      ctx.input.press('skip');
    });

    // Quick placement (crash-first design): spammable ±100 m nudges + AIRBORNE from standstill.
    const nb = (label: string, title: string, area: string, f: number, u: number) => {
      const b = h('button', { class: `nudge-btn touch-ctl n-${area}`, type: 'button', title, 'aria-label': title }, h('span', { text: label }));
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        uiSound('click');
        ctx.planes.nudge?.(f, u);
        this.host.vibrate(8);
      });
      return b;
    };
    this.nudgePad = h(
      'div',
      { class: 'fl-nudge', role: 'group', 'aria-label': 'Move plane 100 m' },
      nb('▲', 'Up 100 m', 'up', 0, 100),
      nb('◀', 'Back 100 m', 'back', -100, 0),
      nb('▶', 'Forward 100 m', 'fwd', 100, 0),
      nb('▼', 'Down 100 m', 'down', 0, -100),
      h('span', { class: 'n-mid', text: '100m' }),
    );
    this.airborne = h('button', { class: 'airborne-btn touch-ctl', type: 'button', 'aria-label': 'Airborne' }, icon('plane'), h('span', { text: 'AIRBORNE' }));
    this.airborne.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      uiSound('confirm');
      ctx.planes.takeOff?.();
      this.host.vibrate(20);
    });

    this.switchPart = h('button', { class: 'airborne-btn switch-part-btn touch-ctl', type: 'button', 'aria-label': 'Switch camera part' }, icon('camera'), h('span', { text: '⇄ SWITCH PART' }), h('kbd', { class: 'pb-key', text: 'V' }));
    this.switchPart.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      uiSound('click');
      ctx.planes.cycleTarget?.();
    });

    // Dock: switch plane mid-air (picker) + get up and walk the cabin
    const NAMES: Record<PlaneTypeId, string> = { prop: 'Prop', bizjet: 'Jet', airliner: 'Airliner', jumbo: 'Jumbo' };
    this.picker = h('div', { class: 'fl-picker' });
    for (const t of PLANE_TYPES) {
      const b = h('button', { type: 'button', text: NAMES[t] });
      b.addEventListener('click', () => {
        uiSound('confirm');
        this.picker.classList.remove('open');
        ctx.planes.switchType?.(t);
      });
      this.pickerBtns.push({ t, b });
      this.picker.append(b);
    }
    this.planeBtn = h('button', { class: 'fl-dock-btn', type: 'button', 'aria-label': 'Switch plane' }, icon('plane'), h('span', { text: 'PLANE' }));
    this.planeBtn.addEventListener('click', () => {
      uiSound('click');
      this.picker.classList.toggle('open');
    });
    this.walkBtn = h('button', { class: 'fl-dock-btn fl-walk', type: 'button', 'aria-label': 'Walk the cabin' }, h('span', { text: '🚶 WALK' }), h('kbd', { text: 'F' }));
    this.walkBtn.addEventListener('click', () => {
      uiSound('confirm');
      ctx.walker.start();
    });
    this.replayBtn = h('button', { class: 'fl-dock-btn fl-replay', type: 'button', 'aria-label': 'Replay the crash' }, h('span', { text: '🎬 REPLAY' }));
    this.replayBtn.addEventListener('click', () => {
      uiSound('confirm');
      ctx.replay.start();
    });
    // Camera switches (user request): ride your nuke / missile, follow the plane you hit — in the dock, never on the top bar
    const spec = (kind: 'missile' | 'hit') => {
      uiSound('confirm');
      const t = ctx.missiles?.spectate?.(kind);
      if (t) ctx.events.emit('toast', { text: t, ms: 1600 });
    };
    this.camMText = h('span', { text: '☢ NUKE CAM' });
    this.camMBtn = h('button', { class: 'fl-dock-btn fl-camm', type: 'button', 'aria-label': 'Ride your missile' }, this.camMText, h('kbd', { text: 'K' }));
    this.camMBtn.addEventListener('click', () => spec('missile'));
    this.camHKey = h('kbd', { text: 'K' });
    this.camHBtn = h('button', { class: 'fl-dock-btn fl-camh', type: 'button', 'aria-label': 'Follow the plane you hit' }, h('span', { text: '🎯 HIT PLANE CAM' }), this.camHKey);
    this.camHBtn.addEventListener('click', () => spec('hit'));
    // WATCH IT is on: your plane keeps its distance from that plane, the camera on it — this stops it
    this.watchText = h('span', { text: '👁 STOP WATCHING' });
    this.watchBtn = h('button', { class: 'fl-dock-btn fl-watch', type: 'button', 'aria-label': 'Stop watching the plane' }, this.watchText);
    this.watchBtn.addEventListener('click', () => {
      uiSound('click');
      const t = ctx.missiles?.watchPlane?.(null);
      if (t) ctx.events.emit('toast', { text: t, ms: 1400 });
    });
    // Wing break buttons: per wing, break FAR (wingtip: hard to fly) or HALF (fades into a stall + spin in 30 s)
    this.wingsPanel = h('div', { class: 'fl-wings' });
    for (const side of ['L', 'R'] as const) {
      const row = h('div', { class: 'fw-row' }, h('span', { class: 'fw-lbl', text: side === 'L' ? 'LEFT WING' : 'RIGHT WING' }));
      for (const mode of ['far', 'half'] as const) {
        const b = h('button', { type: 'button', class: `fw-${mode}`, title: mode === 'far' ? 'Tear the wingtip off: hard to control, still flies' : 'Tear the wing in half: stall and spin within 30 s', text: mode === 'far' ? 'BREAK FAR' : 'BREAK HALF' });
        b.addEventListener('click', () => {
          uiSound('confirm');
          ctx.planes.breakWing?.(side, mode);
          this.wingsPanel.classList.remove('open');
        });
        row.append(b);
      }
      this.wingsPanel.append(row);
    }
    this.wingsBtn = h('button', { class: 'fl-dock-btn fl-wingbtn', type: 'button', 'aria-label': 'Break a wing' }, h('span', { text: '✂ WINGS' }));
    this.wingsBtn.addEventListener('click', () => {
      uiSound('click');
      this.wingsPanel.classList.toggle('open');
    });
    this.dock = h(
      'div',
      { class: 'fl-dock' },
      h('div', { style: 'display:flex;gap:6px;align-items:center' }, this.picker, this.planeBtn),
      h('div', { style: 'display:flex;gap:6px;align-items:flex-start' }, this.wingsPanel, this.wingsBtn),
      this.walkBtn,
      this.replayBtn,
      this.camMBtn,
      this.camHBtn,
      this.watchBtn,
    );
    // replay bar (while replaying)
    const rb = (label: string, cls: string, fn: () => void) => {
      const b = h('button', { class: `rp-btn ${cls}`, type: 'button', text: label });
      b.addEventListener('click', () => {
        uiSound('click');
        fn();
      });
      return b;
    };
    this.replayCam = h('span', { class: 'rp-cam' });
    this.replayBar = h(
      'div',
      { class: 'replay-bar' },
      h('div', { class: 'rp-top' }, h('span', { class: 'rp-rec', text: '● REPLAY' }), this.replayCam),
      h('div', { class: 'rp-btns' }, rb('🎥 NEXT CAM', 'rp-next', () => ctx.replay.nextCam()), rb('⟲ RESTART', '', () => ctx.replay.restart()), rb('✕ EXIT', 'rp-exit', () => ctx.replay.stop())),
    );

    this.el = h(
      'div',
      { class: 'flight-hud', 'aria-hidden': 'true' },
      this.nudgePad,
      this.dock,
      this.replayBar,
      this.airborne,
      this.switchPart,
      // User request: keep the plane visible — no instrument tapes / heading / status chips, only alerts.
      h('div', { class: 'fl-top' }, h('div', { class: 'fl-alerts' }, this.oomBanner, this.caution, this.stall)),
      this.engines,
      this.crash,
      this.skip,
    );
    this.overlay = h('div', { class: 'oom-vignette', 'aria-hidden': 'true' });

    ctx.events.on('masterCaution', ({ text, level }) => {
      this.caution.textContent = `⚠ ${text}`;
      this.caution.classList.toggle('warning', level === 'warning');
      this.caution.classList.add('show');
      this.cautionT = 5;
      this.host.vibrate(level === 'warning' ? [40, 60, 40] : 30);
    });
    ctx.events.on('engineExplode', () => this.host.vibrate([50, 30, 80]));
    ctx.events.on('modeChanged', () => {
      this.engineState = [];
      this.cautionT = 0;
      this.caution.classList.remove('show');
    });
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    setVisible(this.el, on);
    if (!on) {
      this.overlay.classList.remove('on', 'failing');
      this.crashShown = false;
      this.crash.classList.remove('show');
    }
  }

  private buildEngines(n: number): void {
    this.engines.textContent = '';
    this.engineBtns = [];
    this.engineState = [];
    for (let i = 0; i < n; i++) {
      const b = h(
        'button',
        { class: 'eng-btn touch-ctl fade-ctl', type: 'button', 'aria-label': `Explode engine ${i + 1}`, title: `Explode engine ${i + 1} (${i + 1})` },
        h('span', { class: 'eng-num', text: String(i + 1) }),
        h('span', { class: 'eng-ic' }),
      );
      b.addEventListener('click', () => {
        uiSound('click');
        this.host.ctx.input.press(`engine${i + 1}` as 'engine1');
      });
      this.engineBtns.push(b);
      this.engineState.push('');
      this.engines.append(b);
    }
    this.engines.append(this.fireMeter);
  }

  update(dt: number): void {
    if (!this.visible) return;
    const { ctx } = this.host;
    const planes = ctx.planes;
    const ps = planes?.state;
    if (!ps) return;
    const crashed = !!planes.crashed;
    const seq = !!planes.inCockpitSequence;
    const mph = ctx.settings.values.units === 'mph';
    const k = mph ? MPH / 3.6 : 1; // km/h → display unit

    this.el.classList.toggle('crashed', crashed);
    this.el.classList.toggle('stalling', !!ps.stallWarning);
    const walking = !!ctx.walker?.active;
    setVisible(this.nudgePad, !crashed && !seq && !walking && typeof planes.nudge === 'function');
    setVisible(this.airborne, !crashed && !walking && !!ps.onGround && ps.airspeedKmh < 10 && typeof planes.takeOff === 'function');
    setVisible(this.planeBtn, !seq && typeof planes.switchType === 'function');
    setVisible(this.walkBtn, !walking && !!ctx.walker?.canStart());
    setVisible(this.wingsBtn, !crashed && !seq && typeof planes.breakWing === 'function' && !!planes.currentTracked?.body);
    if (crashed) this.wingsPanel.classList.remove('open');
    const rp = ctx.replay;
    setVisible(this.replayBtn, !!rp?.canReplay);
    const offer = rp?.active ? null : (ctx.missiles?.camOffer?.() ?? null);
    setVisible(this.camMBtn, !!offer?.missile);
    if (offer?.missile) setText(this.camMText, offer.missile === 'nuke' ? '☢ NUKE CAM' : '🚀 MISSILE CAM');
    setVisible(this.camHBtn, !!offer?.hit);
    this.camHKey.style.display = offer?.missile ? 'none' : ''; // K rides the missile first
    const wn = rp?.active ? null : (ctx.missiles?.watchingName ?? null);
    setVisible(this.watchBtn, !!wn);
    if (wn) setText(this.watchText, `👁 STOP WATCHING · ${wn.toUpperCase()}`);
    setVisible(this.replayBar, !!rp?.active);
    this.el.classList.toggle('replaying', !!rp?.active);
    if (rp?.active) setText(this.replayCam, `CAM · ${rp.camName}${rp.speed < 0.9 ? ' · SLOW-MO' : ''}`);
    for (const pb of this.pickerBtns) pb.b.classList.toggle('cur', planes.currentType === pb.t);
    setVisible(this.switchPart, !!planes.canCycleTarget);
    const fm = planes.fireMeter ?? null;
    const fmKey = fm ? fm.points + '/' + fm.needed : '';
    if (fmKey !== this.fireMeterKey) {
      this.fireMeterKey = fmKey;
      setVisible(this.fireMeter, !!fm);
      if (fm) setText(this.fireMeter, '🔥 ' + '●'.repeat(Math.min(fm.points, fm.needed)) + '○'.repeat(Math.max(0, fm.needed - fm.points)));
    }
    this.drawSpeed(ps.airspeedKmh * k, ps.rotationSpeedKmh * k, ps.stallSpeedKmh * k, !!ps.stallWarning, mph ? 'MPH' : 'KM/H');
    this.drawAlt(ps.altitude, ps.altitude - ps.altitudeAgl, ps.verticalSpeed);
    this.drawHeading(ps.heading);

    setText(this.thr, `THR ${Math.round(ps.throttle * 100)}%`);
    setText(this.gearChip, ps.gear > 0.98 ? 'GEAR ▼' : ps.gear < 0.02 ? 'GEAR ▲' : 'GEAR …');
    this.gearChip.classList.toggle('warn', ps.gear > 0.02 && ps.gear < 0.98);
    setText(this.flapChip, `FLAPS ${Math.round(ps.flaps * 100)}%`);
    this.brakeChip.classList.toggle('on', !!ps.brake);
    this.stall.classList.toggle('show', !!ps.stallWarning && !crashed);

    // Engine buttons.
    const n = ps.engines.length;
    if (n !== this.engineBtns.length) this.buildEngines(n);
    const wrecked = crashed || !!planes.wrecked; // no engine blasts after a crash (hard landings included)
    for (let i = 0; i < n; i++) {
      const st: PlaneEngineStatus = ps.engines[i].status;
      const key = `${st}|${wrecked}`;
      if (key === this.engineState[i]) continue;
      this.engineState[i] = key;
      const b = this.engineBtns[i];
      b.dataset.status = st;
      const dead = st === 'destroyed' || st === 'detached';
      b.disabled = dead || wrecked;
      const ic = b.querySelector('.eng-ic') as HTMLElement;
      ic.innerHTML = '';
      if (st === 'fire') ic.append(icon('flame'));
      else if (dead) ic.append(icon('crack'));
    }

    // Crash choices after 3 s; Skip during the cockpit sequence.
    const showCrash = crashed && planes.crashTime > 3;
    if (showCrash !== this.crashShown) {
      this.crashShown = showCrash;
      this.crash.classList.toggle('show', showCrash);
      if (showCrash) this.host.vibrate(20);
    }
    this.skip.classList.toggle('show', seq);

    // Out of map.
    const oom = ps.outOfMap;
    const warn = oom.state !== 'ok' && !crashed;
    this.overlay.classList.toggle('on', warn);
    this.overlay.classList.toggle('failing', oom.state === 'failing');
    this.oomBanner.classList.toggle('show', warn);
    this.oomBanner.classList.toggle('failing', oom.state === 'failing');
    if (warn) {
      if (oom.state === 'warning') {
        setText(this.oomText, 'OUT OF MAP — TURN BACK');
        setText(this.oomCount, String(Math.max(0, Math.ceil(oom.countdown))));
      } else {
        setText(this.oomText, oom.total > 0 ? `ENGINE FAILURE — ${oom.failed}/${oom.total}` : 'ENGINES FAILING');
        setText(this.oomCount, '');
      }
    }
    if (this.cautionT > 0) {
      this.cautionT -= dt;
      if (this.cautionT <= 0) this.caution.classList.remove('show');
    }
  }

  // ─────────────────────────────── tapes ───────────────────────────────
  private drawSpeed(v: number, vr: number, vs: number, stall: boolean, unit: string): void {
    const G = this.spd;
    if (!G.fit()) return;
    const key = `${v.toFixed(1)}|${vr}|${vs}|${stall}|${unit}`;
    if (key === G.key) return;
    G.key = key;
    const { g, w, h: H } = G;
    g.clearRect(0, 0, w, H);
    roundRect(g, 0.5, 0.5, w - 1, H - 1, 10);
    g.fillStyle = stall ? PANEL_RED : PANEL;
    g.fill();
    g.save();
    g.clip();
    g.beginPath();
    g.rect(0, 17, w, H - 34);
    g.clip();
    const span = 120; // display units visible
    const ppu = H / span;
    const cy = H / 2;
    const yOf = (u: number) => cy - (u - v) * ppu;
    // Stall band (right edge, below stall speed) and Vr bug.
    if (vs > 0) {
      const y0 = Math.max(0, yOf(vs));
      g.fillStyle = 'rgba(255, 80, 70, 0.85)';
      g.fillRect(w - 6, y0, 6, H - y0);
    }
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineWidth = 1.5;
    g.font = '700 11px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const start = Math.floor((v - span / 2) / 10) * 10;
    for (let u = start; u <= v + span / 2; u += 10) {
      if (u < 0) continue;
      const y = yOf(u);
      const major = u % 50 === 0;
      g.beginPath();
      g.moveTo(w - 7, y);
      g.lineTo(w - 7 - (major ? 12 : 6), y);
      g.stroke();
      if (major) g.fillText(String(u), 6, y);
    }
    if (vr > 0) {
      const y = yOf(vr);
      if (y > -10 && y < H + 10) {
        g.fillStyle = '#ffd36e';
        g.beginPath();
        g.moveTo(w - 1, y);
        g.lineTo(w - 12, y - 6);
        g.lineTo(w - 12, y + 6);
        g.closePath();
        g.fill();
        g.font = '900 9px system-ui, sans-serif';
        g.textAlign = 'right';
        g.fillText('R', w - 14, y);
      }
    }
    g.restore();
    // Current value box.
    const bh = 24;
    roundRect(g, 3, cy - bh / 2, w - 10, bh, 6);
    g.fillStyle = stall ? '#ffe1dc' : '#fff8ee';
    g.fill();
    g.fillStyle = stall ? '#c4281e' : '#22304d';
    g.font = '900 14px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(Math.round(v)), (w - 7) / 2 + 1, cy + 0.5);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.font = '800 8px system-ui, sans-serif';
    g.fillText(unit, w / 2, 9);
    if (vr > 0) {
      g.fillStyle = '#ffd36e';
      g.fillText(`Vr ${Math.round(vr)}`, w / 2, H - 8);
    }
  }

  private drawAlt(alt: number, ground: number, vsMs: number): void {
    const G = this.alt;
    if (!G.fit()) return;
    const key = `${alt.toFixed(1)}|${ground.toFixed(0)}|${vsMs.toFixed(1)}`;
    if (key === G.key) return;
    G.key = key;
    const { g, w, h: H } = G;
    g.clearRect(0, 0, w, H);
    roundRect(g, 0.5, 0.5, w - 1, H - 1, 10);
    g.fillStyle = PANEL;
    g.fill();
    g.save();
    g.clip();
    g.beginPath();
    g.rect(0, 17, w, H - 34);
    g.clip();
    const span = 300;
    const ppu = H / span;
    const cy = H / 2;
    const yOf = (m: number) => cy - (m - alt) * ppu;
    const gy = yOf(ground);
    if (gy < H) {
      g.fillStyle = 'rgba(160, 110, 70, 0.75)';
      g.fillRect(0, Math.max(0, gy), w, H);
    }
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineWidth = 1.5;
    g.font = '700 11px system-ui, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    const start = Math.floor((alt - span / 2) / 25) * 25;
    for (let m = start; m <= alt + span / 2; m += 25) {
      const y = yOf(m);
      const major = m % 100 === 0;
      g.beginPath();
      g.moveTo(7, y);
      g.lineTo(7 + (major ? 12 : 6), y);
      g.stroke();
      if (major) g.fillText(String(m), w - 6, y);
    }
    // Vertical speed needle on the left edge (±10 m/s full scale).
    const vsClamped = Math.max(-10, Math.min(10, vsMs));
    const vy = cy - (vsClamped / 10) * (H / 2 - 18);
    g.strokeStyle = vsMs < -6 ? '#ff6a59' : '#7fe3c4';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(3, cy);
    g.lineTo(3, vy);
    g.stroke();
    g.restore();
    const bh = 24;
    roundRect(g, 7, cy - bh / 2, w - 10, bh, 6);
    g.fillStyle = '#fff8ee';
    g.fill();
    g.fillStyle = '#22304d';
    g.font = '900 14px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(String(Math.round(alt)), (w + 4) / 2, cy + 0.5);
    g.font = '800 9px system-ui, sans-serif';
    g.fillStyle = vsMs < -6 ? '#ffb1a6' : 'rgba(255,255,255,0.9)';
    g.fillText(`${vsMs >= 0 ? '▲' : '▼'} ${Math.abs(vsMs).toFixed(1)}`, w / 2, H - 8);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.font = '800 8px system-ui, sans-serif';
    g.fillText('ALT M', w / 2, 9);
  }

  private drawHeading(hdg: number): void {
    const G = this.hdg;
    if (!G.fit()) return;
    const hd = ((hdg % 360) + 360) % 360;
    const key = hd.toFixed(1);
    if (key === G.key) return;
    G.key = key;
    const { g, w, h: H } = G;
    g.clearRect(0, 0, w, H);
    roundRect(g, 0.5, 0.5, w - 1, H - 1, H / 2);
    g.fillStyle = PANEL;
    g.fill();
    g.save();
    g.clip();
    const span = 90;
    const ppd = w / span;
    const cx = w / 2;
    g.strokeStyle = INK;
    g.fillStyle = INK;
    g.lineWidth = 1.4;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const start = Math.floor((hd - span / 2) / 5) * 5;
    for (let d = start; d <= hd + span / 2; d += 5) {
      const x = cx + (d - hd) * ppd;
      const dd = ((d % 360) + 360) % 360;
      const major = dd % 30 === 0;
      g.beginPath();
      g.moveTo(x, H - 4);
      g.lineTo(x, H - (major ? 11 : 7));
      g.stroke();
      if (major) {
        const lbl = dd === 0 ? 'N' : dd === 90 ? 'E' : dd === 180 ? 'S' : dd === 270 ? 'W' : String(dd / 10);
        g.font = dd % 90 === 0 ? '900 11px system-ui, sans-serif' : '700 9.5px system-ui, sans-serif';
        g.fillStyle = dd === 0 ? '#ffb38a' : INK;
        g.fillText(lbl, x, 9);
      }
    }
    g.restore();
    g.fillStyle = '#ffd36e';
    g.beginPath();
    g.moveTo(cx, H - 6);
    g.lineTo(cx - 5, H);
    g.lineTo(cx + 5, H);
    g.closePath();
    g.fill();
    g.fillRect(cx - 1, 3, 2, H - 8);
  }
}
