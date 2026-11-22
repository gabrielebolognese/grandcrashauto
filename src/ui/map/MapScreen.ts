import './map.css';
import * as THREE from 'three';
import type { RenderView } from '../../core/Engine';
import { CONFIG } from '../../config';
import type { GameContext } from '../../game/contracts';
import { formatDistance, niceScale } from '../../nav/format';
import { navIcon, type NavIconName } from '../../nav/icons';
import type { Nav } from '../../nav/Nav';
import type { NavPoi } from '../../nav/pois';
import { MapRenderer, mapLevel } from './MapRenderer';
import { TileCache } from './TileCache';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * The Map screen (SPEC-PART2 §3, SPEC-PART3 §2): full-screen, zoomable/pannable top-down map generated from the
 * seed, with places (discovered vs not), the car, the active route, Directions and Teleport. Mobile-first landscape
 * layout. The game is paused while it's open, so it runs its own rAF loop and renders only when something changed.
 * Input: drag / pinch / wheel / double-tap, keyboard (arrows/WASD pan, +/- zoom, Enter directions, T teleport,
 * C recentre, L places, Esc/N close) and gamepad (left stick pan, triggers zoom, A select/directions, Y teleport).
 */
export class MapScreen {
  isOpen = false;
  private built = false;
  private root!: HTMLDivElement;
  private canvas!: HTMLCanvasElement;
  private pulse!: HTMLDivElement;
  private renderer!: MapRenderer;
  private tiles: TileCache | null = null;
  private sub!: HTMLDivElement;
  private routeChip!: HTMLDivElement;
  private routeText!: HTMLSpanElement;
  private scaleBar!: HTMLElement;
  private scaleLabel!: HTMLSpanElement;
  private loading!: HTMLDivElement;
  private list!: HTMLDivElement;
  private listBtn!: HTMLButtonElement;
  private card!: HTMLDivElement;
  private cardIc!: HTMLDivElement;
  private cardName!: HTMLDivElement;
  private cardMeta!: HTMLDivElement;
  private cardWhy!: HTMLDivElement;
  private dirBtn!: HTMLButtonElement;
  private tpBtn!: HTMLButtonElement;
  private listOpen = false;
  private dirty = true;
  private raf = 0;
  private lastT = 0;
  private lastDraw = 0;
  private listSig = '';
  // interaction
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private pinch: { d: number; ppm: number; mx: number; my: number; ax: number; az: number } | null = null;
  private vel = { x: 0, y: 0 };
  private lastMove = 0;
  private lastTap = { t: 0, x: 0, y: 0 };
  private anim: { cx: number; cz: number; ppm: number; t: number } | null = null;
  private keysHeld = new Set<string>();
  private padPrev: boolean[] = [];
  private savedPpm = CONFIG.nav.mapStartPpm;
  /** The 3D view while the (opaque) map covers it: an empty scene saves the GPU/battery and keeps panning smooth. */
  private savedView: RenderView | null = null;
  private blankScene: THREE.Scene | null = null;
  private blankTimer = 0;

  constructor(
    private nav: Nav,
    private ctx: GameContext,
  ) {}

  // ─────────────────────────────── DOM ───────────────────────────────
  private build(): void {
    if (this.built) return;
    this.built = true;
    const root = el('div', 'nav-map');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Map');
    root.setAttribute('aria-hidden', 'true');
    this.root = root;
    this.canvas = el('canvas', 'nm-canvas');
    this.pulse = el('div', 'nm-pulse');
    this.pulse.append(el('i'));
    root.append(this.canvas, this.pulse, el('div', 'nm-vignette'));

    // top-left: back + title
    const top = el('div', 'nm-top');
    const back = this.roundBtn('back', 'Close map (Esc)', () => this.nav.dismissMap());
    const title = el('div', 'nm-title');
    const deco = el('div', 'deco-title');
    deco.append(el('i'), el('span', '', 'Map'), el('i'));
    this.sub = el('div', 'nm-sub', '');
    title.append(deco, this.sub);
    top.append(back, title);

    // active route chip (top centre)
    this.routeChip = el('div', 'nm-route');
    this.routeText = el('span');
    const stop = el('button', '', 'Stop');
    stop.type = 'button';
    stop.addEventListener('click', () => {
      this.click();
      this.nav.setDestination(null);
      this.markDirty();
    });
    this.routeChip.append(this.routeText, stop);

    // right: zoom / locate / places
    const ctrls = el('div', 'nm-ctrls');
    ctrls.append(
      this.roundBtn('plus', 'Zoom in (+)', () => this.zoomBy(1.6)),
      this.roundBtn('minus', 'Zoom out (−)', () => this.zoomBy(1 / 1.6)),
      this.roundBtn('locate', 'Centre on car (C)', () => this.recenter()),
      (this.listBtn = this.roundBtn('list', 'Places (L)', () => this.toggleList())),
    );
    const compass = el('div', 'nm-compass', 'N');

    // scale bar + hint + loading
    this.scaleBar = el('i');
    this.scaleLabel = el('span', '', '');
    const scale = el('div', 'nm-scale');
    scale.append(this.scaleLabel, this.scaleBar);
    const hint = el('div', 'nm-hint', 'Drag to pan · scroll to zoom · tap a place to teleport or get directions');
    this.loading = el('div', 'nm-loading', 'Charting the land…');

    // places panel
    const places = el('aside', 'nm-places panel');
    const ph = el('div', 'nm-places-h');
    const pdeco = el('div', 'deco-title');
    pdeco.append(el('i'), el('span', '', 'Places'), el('i'));
    ph.append(pdeco, this.roundBtn('close', 'Close list', () => this.toggleList(false)));
    (ph.lastChild as HTMLElement).style.cssText = 'width:36px;height:36px';
    this.list = el('div', 'nm-list');
    places.append(ph, this.list);

    // selected place card
    this.card = el('div', 'nm-card panel');
    this.cardIc = el('div', 'nm-card-ic');
    const ct = el('div', 'nm-card-t');
    this.cardName = el('div', 'nm-card-n');
    this.cardMeta = el('div', 'nm-card-m');
    this.cardWhy = el('div', 'nm-card-why');
    ct.append(this.cardName, this.cardMeta, this.cardWhy);
    const cb = el('div', 'nm-card-b');
    this.dirBtn = this.bigBtn('route', 'Directions', 'btn btn-mint', () => this.onDirections());
    this.tpBtn = this.bigBtn('teleport', 'Teleport', 'btn btn-primary', () => this.onTeleport());
    cb.append(this.dirBtn, this.tpBtn);
    this.card.append(this.cardIc, ct, cb);

    root.append(top, this.routeChip, ctrls, compass, scale, hint, this.loading, places, this.card);
    (document.getElementById('ui-root') ?? document.body).append(root);

    this.tiles = new TileCache();
    this.tiles.onTile = () => this.markDirty();
    this.renderer = new MapRenderer(this.canvas, this.nav, this.ctx, this.tiles);
    this.bindPointer();
    window.addEventListener('resize', () => this.isOpen && this.markDirty());
  }

  private roundBtn(icon: NavIconName, label: string, fn: () => void): HTMLButtonElement {
    const b = el('button', 'nm-round');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.append(navIcon(icon));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.click();
      fn();
    });
    return b;
  }

  private bigBtn(icon: NavIconName, label: string, cls: string, fn: () => void): HTMLButtonElement {
    const b = el('button', cls);
    b.type = 'button';
    b.append(navIcon(icon), el('span', 'nm-lbl', label));
    b.addEventListener('click', () => fn());
    return b;
  }

  private click(): void {
    try {
      this.ctx.audio?.ui?.('click');
    } catch {
      /* audio not ready */
    }
  }

  // ─────────────────────────────── open / close ───────────────────────────────
  open(): void {
    this.build();
    this.isOpen = true;
    this.root.classList.add('visible');
    this.root.setAttribute('aria-hidden', 'false');
    document.getElementById('ui-root')?.classList.add('nav-map-open');
    const wide = window.innerWidth >= 1000 && window.innerHeight >= 560;
    this.toggleList(wide);
    // centre on the player (keep the zoom from last time)
    const f = this.nav.focusAbs();
    const v = this.renderer.view;
    v.cx = f.x;
    v.cz = f.z;
    v.ppm = this.savedPpm;
    // with a route, frame the destination too
    const d = this.nav.destination;
    if (d) this.frame([f.x, d.ax], [f.z, d.az], false);
    this.anim = null;
    this.vel.x = this.vel.y = 0;
    this.select(this.renderer.selected && this.nav.entries().includes(this.renderer.selected) ? this.renderer.selected : null);
    this.listSig = '';
    this.padPrev = [];
    this.markDirty();
    this.lastT = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
    clearTimeout(this.blankTimer);
    this.blankTimer = window.setTimeout(() => this.blank3D(true), 320); // after the fade-in
    try {
      this.ctx.audio?.ui?.('confirm');
    } catch {
      /* audio not ready */
    }
  }

  close(): void {
    if (!this.built) return;
    this.isOpen = false;
    clearTimeout(this.blankTimer);
    this.blank3D(false);
    this.root.classList.remove('visible');
    this.root.setAttribute('aria-hidden', 'true');
    document.getElementById('ui-root')?.classList.remove('nav-map-open');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pointers.clear();
    this.pinch = null;
    this.keysHeld.clear();
    this.savedPpm = this.renderer.view.ppm;
    this.tiles?.cancelQueued();
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  markDirty(): void {
    this.dirty = true;
  }

  private blank3D(on: boolean): void {
    const engine = this.ctx.engine;
    try {
      if (on && this.isOpen && !this.savedView) {
        this.blankScene ??= new THREE.Scene();
        this.savedView = engine.view;
        engine.setView({ scene: this.blankScene, camera: engine.view.camera });
      } else if (!on && this.savedView) {
        if (engine.view.scene === this.blankScene) engine.setView(this.savedView);
        this.savedView = null;
      }
    } catch (err) {
      console.warn('[map] view swap failed', err);
      this.savedView = null;
    }
  }

  /**
   * Warm the tile cache in the background (workers) around the player at the default zoom, so the first open is
   * instant. Called by Nav a few seconds into driving.
   */
  prefetch(): void {
    this.build();
    const tiles = this.tiles;
    if (!tiles) return;
    const f = this.nav.focusAbs();
    const ppm = this.savedPpm;
    const size = CONFIG.nav.mapTilePx;
    const L = mapLevel(ppm);
    const halfW = window.innerWidth / 2 / ppm;
    const halfH = window.innerHeight / 2 / ppm;
    tiles.beginFrame();
    for (const lv of [Math.min(8, L + 2), L]) {
      const tw = size * Math.pow(2, lv);
      for (let tz = Math.floor((f.z - halfH) / tw); tz <= Math.floor((f.z + halfH) / tw); tz++)
        for (let tx = Math.floor((f.x - halfW) / tw); tx <= Math.floor((f.x + halfW) / tw); tx++)
          tiles.need(lv, tx, tz, (lv === L ? 1e5 : 0) + Math.hypot((tx + 0.5) * tw - f.x, (tz + 0.5) * tw - f.z));
    }
    tiles.flush();
  }

  // ─────────────────────────────── loop ───────────────────────────────
  private loop = (now: number): void => {
    if (!this.isOpen) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    const v = this.renderer.view;
    // fly-to animation
    if (this.anim) {
      const k = 1 - Math.exp(-dt * 9);
      v.cx += (this.anim.cx - v.cx) * k;
      v.cz += (this.anim.cz - v.cz) * k;
      v.ppm *= Math.pow(this.anim.ppm / v.ppm, k);
      if (Math.abs(this.anim.cx - v.cx) * v.ppm < 0.5 && Math.abs(this.anim.cz - v.cz) * v.ppm < 0.5 && Math.abs(Math.log(this.anim.ppm / v.ppm)) < 0.004) this.anim = null;
      this.dirty = true;
    }
    // pan inertia
    if (!this.pointers.size && (Math.abs(this.vel.x) > 2 || Math.abs(this.vel.y) > 2)) {
      v.cx -= (this.vel.x * dt) / v.ppm;
      v.cz -= (this.vel.y * dt) / v.ppm;
      const damp = Math.exp(-dt * 5);
      this.vel.x *= damp;
      this.vel.y *= damp;
      this.dirty = true;
    }
    // held keys + gamepad
    let px = 0;
    let py = 0;
    let zoom = 0;
    const kh = this.keysHeld;
    if (kh.has('ArrowLeft') || kh.has('KeyA')) px -= 1;
    if (kh.has('ArrowRight') || kh.has('KeyD')) px += 1;
    if (kh.has('ArrowUp') || kh.has('KeyW')) py -= 1;
    if (kh.has('ArrowDown') || kh.has('KeyS')) py += 1;
    if (kh.has('Equal') || kh.has('NumpadAdd') || kh.has('PageUp') || kh.has('KeyE')) zoom += 1;
    if (kh.has('Minus') || kh.has('NumpadSubtract') || kh.has('PageDown') || kh.has('KeyQ')) zoom -= 1;
    const pad = this.pollPad();
    px += pad.x;
    py += pad.y;
    zoom += pad.zoom;
    if (px || py) {
      const speed = 620;
      v.cx += (px * speed * dt) / v.ppm;
      v.cz += (py * speed * dt) / v.ppm;
      this.anim = null;
      this.dirty = true;
    }
    if (zoom) {
      this.zoomAt(Math.pow(2, zoom * dt * 2.2), this.renderer.W / 2, this.renderer.H / 2);
      this.anim = null;
    }
    // render only on change (the player pulse is a CSS animation on a DOM element)
    if (this.renderer.resize()) this.dirty = true;
    if (this.dirty) this.draw(now);
  };

  private draw(now: number): void {
    this.dirty = false;
    this.lastDraw = now;
    const v = this.renderer.view;
    v.ppm = Math.min(CONFIG.nav.mapMaxPpm, Math.max(CONFIG.nav.mapMinPpm, v.ppm));
    this.renderer.render(now);
    const R = this.renderer;
    const on = R.playerX > -30 && R.playerY > -30 && R.playerX < R.W + 30 && R.playerY < R.H + 30;
    this.pulse.style.transform = on ? `translate(${R.playerX.toFixed(1)}px, ${R.playerY.toFixed(1)}px)` : 'translate(-9999px, 0)';
    this.updateChrome();
  }

  private updateChrome(): void {
    const units = this.ctx.settings.values.units;
    const list = this.nav.entries();
    const disc = list.filter((p) => p.discovered).length;
    const s = `📍 ${disc} / ${list.length} discovered`;
    if (this.sub.textContent !== s) this.sub.textContent = s;
    // scale bar
    const sc = niceScale(1 / this.renderer.view.ppm, 90, units);
    this.scaleBar.style.width = `${Math.round(sc.px)}px`;
    if (this.scaleLabel.textContent !== sc.label) this.scaleLabel.textContent = sc.label;
    // route chip
    const d = this.nav.destination;
    const r = this.nav.active;
    this.routeChip.classList.toggle('show', !!d && !!r);
    if (d && r) {
      const t = `🧭 ${d.name} · ${formatDistance(r.remaining, units)}`;
      if (this.routeText.textContent !== t) this.routeText.textContent = t;
    }
    this.loading.classList.toggle('show', !!this.tiles?.busy && (this.tiles?.size ?? 0) < 6);
    // places list (rebuild when membership / discovery / destination change; distances refresh on open)
    const sig = list.map((p) => `${p.id}:${p.discovered ? 1 : 0}`).join(',') + `|${d?.id ?? ''}|${this.renderer.selected?.id ?? ''}|${units}|${this.ctx.vehicle.state.exploded}`;
    if (sig !== this.listSig) {
      this.listSig = sig;
      this.buildList(list);
    }
    if (this.renderer.selected) this.fillCard(this.renderer.selected);
  }

  private buildList(list: NavPoi[]): void {
    const f = this.nav.focusAbs();
    const units = this.ctx.settings.values.units;
    const sorted = [...list].sort((a, b) => Number(b.discovered) - Number(a.discovered) || Math.hypot(a.ax - f.x, a.az - f.z) - Math.hypot(b.ax - f.x, b.az - f.z));
    this.list.textContent = '';
    for (const p of sorted) {
      const row = el('div', 'nm-row');
      const b = el('button', `nm-item${p.discovered ? '' : ' locked'}${p === this.renderer.selected ? ' sel' : ''}`);
      b.type = 'button';
      const ic = el('span', 'nm-item-ic', p.icon);
      const t = el('span', 'nm-item-t');
      t.append(el('span', 'nm-item-n', p.name), el('span', 'nm-item-m', `${formatDistance(Math.hypot(p.ax - f.x, p.az - f.z), units)}${p.discovered ? '' : ' · undiscovered'}`));
      b.append(ic, t);
      if (this.nav.destination?.id === p.id) b.append(el('span', 'nm-item-dest', '🧭'));
      b.addEventListener('click', () => {
        this.click();
        this.select(p);
        this.flyTo(p.ax, p.az, Math.max(this.renderer.view.ppm, 0.3));
        if (window.innerWidth < 1000) this.toggleList(false);
      });
      row.append(b);
      // one-tap teleport for discovered places (the fastest way back to the fun)
      if (p.discovered) {
        const tp = el('button', 'nm-tp');
        tp.type = 'button';
        tp.title = `Teleport to ${p.name}`;
        tp.setAttribute('aria-label', `Teleport to ${p.name}`);
        tp.append(navIcon('teleport'));
        tp.disabled = !this.nav.canTeleport(p).ok;
        tp.addEventListener('click', (e) => {
          e.stopPropagation();
          this.select(p);
          this.onTeleport();
        });
        row.append(tp);
      }
      this.list.append(row);
    }
  }

  private toggleList(on = !this.listOpen): void {
    this.listOpen = on;
    this.root.classList.toggle('list-open', on);
    this.listBtn.classList.toggle('on', on);
  }

  // ─────────────────────────────── selection / card ───────────────────────────────
  private select(p: NavPoi | null): void {
    this.renderer.selected = p;
    this.root.classList.toggle('has-sel', !!p);
    if (p) this.fillCard(p);
    this.markDirty();
  }

  private fillCard(p: NavPoi): void {
    const units = this.ctx.settings.values.units;
    const f = this.nav.focusAbs();
    if (this.cardIc.textContent !== p.icon) this.cardIc.textContent = p.icon;
    if (this.cardName.textContent !== p.name) this.cardName.textContent = p.name;
    this.card.classList.toggle('locked', !p.discovered);
    const dist = formatDistance(Math.hypot(p.ax - f.x, p.az - f.z), units);
    const metaSig = `${dist}|${p.discovered}`;
    if (this.cardMeta.dataset.sig !== metaSig) {
      this.cardMeta.dataset.sig = metaSig;
      this.cardMeta.textContent = '';
      this.cardMeta.append(el('span', 'chip', `${dist} away`), el('span', p.discovered ? 'chip ok' : 'chip lock', p.discovered ? 'Discovered' : '🔒 Undiscovered'));
    }
    const tp = this.nav.canTeleport(p);
    const isDest = this.nav.destination?.id === p.id;
    const why = !tp.ok ? tp.reason : isDest ? 'Route active — follow the glowing chevrons' : 'Jump straight there, or follow directions';
    if (this.cardWhy.textContent !== why) this.cardWhy.textContent = why;
    this.tpBtn.disabled = !tp.ok;
    const dl = this.dirBtn.querySelector('.nm-lbl');
    const label = isDest ? 'Stop route' : 'Directions';
    if (dl && dl.textContent !== label) dl.textContent = label;
    // Teleport is the primary action when available; otherwise Directions takes the coral style
    this.dirBtn.classList.toggle('btn-primary', !isDest && !tp.ok);
    this.dirBtn.classList.toggle('btn-mint', !isDest && tp.ok);
    this.dirBtn.classList.toggle('btn-ghost', isDest);
  }

  private onDirections(): void {
    const p = this.renderer.selected;
    if (!p) return;
    try {
      this.ctx.audio?.ui?.('confirm');
    } catch {
      /* ignore */
    }
    if (this.nav.destination?.id === p.id) {
      this.nav.setDestination(null);
      this.markDirty();
      return;
    }
    this.nav.directionsFromMap(p.id);
  }

  /** Enter / gamepad A: teleport when allowed, else directions. */
  private primaryAction(): void {
    const p = this.renderer.selected;
    if (!p) return;
    if (this.nav.canTeleport(p).ok) this.onTeleport();
    else this.onDirections();
  }

  private onTeleport(): void {
    const p = this.renderer.selected;
    if (!p) return;
    if (!this.nav.canTeleport(p).ok) return;
    try {
      this.ctx.audio?.ui?.('confirm');
    } catch {
      /* ignore */
    }
    this.nav.teleport(p.id);
  }

  // ─────────────────────────────── view helpers ───────────────────────────────
  private flyTo(cx: number, cz: number, ppm = this.renderer.view.ppm): void {
    this.anim = { cx, cz, ppm: Math.min(CONFIG.nav.mapMaxPpm, Math.max(CONFIG.nav.mapMinPpm, ppm)), t: 0 };
    this.vel.x = this.vel.y = 0;
  }

  private frame(xs: number[], zs: number[], animate: boolean): void {
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const r = this.root.getBoundingClientRect();
    const w = Math.max(200, r.width - (this.listOpen ? 340 : 140));
    const h = Math.max(150, r.height - 190);
    const ppm = Math.min(this.renderer.view.ppm, w / Math.max(50, maxX - minX), h / Math.max(50, maxZ - minZ));
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    if (animate) this.flyTo(cx, cz, ppm);
    else {
      const v = this.renderer.view;
      v.cx = cx;
      v.cz = cz;
      v.ppm = Math.min(CONFIG.nav.mapMaxPpm, Math.max(CONFIG.nav.mapMinPpm, ppm));
    }
  }

  private recenter(): void {
    const f = this.nav.focusAbs();
    this.flyTo(f.x, f.z, Math.max(this.renderer.view.ppm, 0.25));
  }

  private zoomBy(f: number): void {
    const v = this.renderer.view;
    const a = this.anim;
    this.flyTo(a ? a.cx : v.cx, a ? a.cz : v.cz, (a ? a.ppm : v.ppm) * f);
  }

  /** Zoom by factor f keeping the world point under screen (x, y) fixed. */
  private zoomAt(f: number, x: number, y: number): void {
    const R = this.renderer;
    const v = R.view;
    const ax = R.wx(x);
    const az = R.wz(y);
    v.ppm = Math.min(CONFIG.nav.mapMaxPpm, Math.max(CONFIG.nav.mapMinPpm, v.ppm * f));
    v.cx = ax - (x - R.W / 2) / v.ppm;
    v.cz = az - (y - R.H / 2) / v.ppm;
    this.dirty = true;
  }

  // ─────────────────────────────── pointer ───────────────────────────────
  private bindPointer(): void {
    const cv = this.canvas;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    cv.addEventListener('pointerdown', (e) => {
      const p = local(e);
      this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now() });
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      this.anim = null;
      this.vel.x = this.vel.y = 0;
      cv.classList.add('dragging');
      if (this.pointers.size === 2) this.startPinch();
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const ptr = this.pointers.get(e.pointerId);
      if (!ptr) return;
      const p = local(e);
      const dx = p.x - ptr.x;
      const dy = p.y - ptr.y;
      ptr.x = p.x;
      ptr.y = p.y;
      const v = this.renderer.view;
      if (this.pointers.size >= 2 && this.pinch) {
        const [a, b] = Array.from(this.pointers.values());
        const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        v.ppm = Math.min(CONFIG.nav.mapMaxPpm, Math.max(CONFIG.nav.mapMinPpm, (this.pinch.ppm * d) / this.pinch.d));
        // keep the world point that was under the pinch midpoint under the current midpoint
        v.cx = this.pinch.ax - (mx - this.renderer.W / 2) / v.ppm;
        v.cz = this.pinch.az - (my - this.renderer.H / 2) / v.ppm;
        this.dirty = true;
      } else if (this.pointers.size === 1) {
        v.cx -= dx / v.ppm;
        v.cz -= dy / v.ppm;
        const now = performance.now();
        const dtm = Math.max(1, now - this.lastMove) / 1000;
        this.lastMove = now;
        // smoothed release velocity (px/s)
        this.vel.x = this.vel.x * 0.6 + (dx / dtm) * 0.4;
        this.vel.y = this.vel.y * 0.6 + (dy / dtm) * 0.4;
        this.dirty = true;
      }
    });
    const end = (e: PointerEvent) => {
      const ptr = this.pointers.get(e.pointerId);
      if (!ptr) return;
      this.pointers.delete(e.pointerId);
      const now = performance.now();
      const moved = Math.hypot(ptr.x - ptr.sx, ptr.y - ptr.sy);
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 1) {
        // continue panning with the remaining finger without a jump
        this.vel.x = this.vel.y = 0;
      }
      if (!this.pointers.size) cv.classList.remove('dragging');
      if (now - this.lastMove > 90) this.vel.x = this.vel.y = 0; // finger rested before release: no fling
      if (e.type === 'pointerup' && moved < 8 && now - ptr.t < 450 && !this.pointers.size) {
        this.vel.x = this.vel.y = 0;
        const dbl = now - this.lastTap.t < 320 && Math.hypot(ptr.x - this.lastTap.x, ptr.y - this.lastTap.y) < 30;
        this.lastTap = { t: now, x: ptr.x, y: ptr.y };
        const hit = this.renderer.hitPoi(ptr.x, ptr.y);
        if (hit) {
          this.click();
          this.select(hit);
        } else if (dbl) {
          const R = this.renderer;
          this.flyTo(R.wx(ptr.x), R.wz(ptr.y), R.view.ppm * 2);
        } else this.select(null);
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.anim = null;
        this.zoomAt(Math.pow(1.0018, -delta), p.x, p.y);
      },
      { passive: false },
    );
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private startPinch(): void {
    const [a, b] = Array.from(this.pointers.values());
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    this.pinch = { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), ppm: this.renderer.view.ppm, mx, my, ax: this.renderer.wx(mx), az: this.renderer.wz(my) };
    this.vel.x = this.vel.y = 0;
  }

  // ─────────────────────────────── keyboard / gamepad ───────────────────────────────
  /** Window capture-phase keydown (registered before the UI menu navigator). */
  onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const stop = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const code = e.code;
    switch (code) {
      case 'Escape':
      case 'Backspace':
      case 'KeyN':
      case 'KeyM':
      case 'Tab':
        stop();
        if (!e.repeat) this.nav.dismissMap();
        return;
      case 'Enter':
      case 'NumpadEnter':
      case 'Space':
        stop();
        if (!e.repeat && this.renderer.selected) this.primaryAction();
        return;
      case 'KeyG':
        stop();
        if (!e.repeat && this.renderer.selected) this.onDirections();
        return;
      case 'KeyT':
        stop();
        if (!e.repeat) this.onTeleport();
        return;
      case 'KeyC':
      case 'Home':
        stop();
        this.recenter();
        return;
      case 'KeyL':
        stop();
        if (!e.repeat) this.toggleList();
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown':
      case 'KeyW':
      case 'KeyA':
      case 'KeyS':
      case 'KeyD':
      case 'KeyQ':
      case 'KeyE':
      case 'Equal':
      case 'Minus':
      case 'NumpadAdd':
      case 'NumpadSubtract':
      case 'PageUp':
      case 'PageDown':
        stop();
        this.keysHeld.add(code);
        if (!this.keyUpBound) {
          this.keyUpBound = true;
          window.addEventListener('keyup', (ev) => this.keysHeld.delete(ev.code));
          window.addEventListener('blur', () => this.keysHeld.clear());
        }
        return;
      default:
        // swallow other keys so they don't reach the paused game / menus (except browser keys)
        if (!code.startsWith('F') || code === 'KeyF') stop();
    }
  }
  private keyUpBound = false;

  private pollPad(): { x: number; y: number; zoom: number } {
    const res = { x: 0, y: 0, zoom: 0 };
    const pads = navigator.getGamepads?.() ?? [];
    let gp: Gamepad | null = null;
    for (const g of pads) if (g && g.connected) {
      gp = g;
      break;
    }
    if (!gp) return res;
    const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82);
    res.x = dz(gp.axes[0] ?? 0);
    res.y = dz(gp.axes[1] ?? 0);
    const rt = gp.buttons[7]?.value ?? 0;
    const lt = gp.buttons[6]?.value ?? 0;
    res.zoom = rt - lt + -dz(gp.axes[3] ?? 0);
    const edge = (i: number) => {
      const now = gp!.buttons[i]?.pressed ?? false;
      const was = this.padPrev[i] ?? true;
      this.padPrev[i] = now;
      return now && !was;
    };
    if (edge(0)) {
      // A: select the place nearest the centre, or get directions to the selected one
      const R = this.renderer;
      const hit = R.hitPoi(R.W / 2, R.H / 2);
      if (hit && hit !== R.selected) this.select(hit);
      else if (R.selected) this.primaryAction();
    }
    if (edge(3)) this.onDirections();
    if (edge(2)) this.recenter();
    return res;
  }

  dispose(): void {
    this.close();
    this.tiles?.dispose();
    this.root?.remove();
  }
}
