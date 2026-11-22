import { isEditable } from './dom';

/**
 * Block the browser's default touch gestures everywhere (spec §9): page scroll / rubber-band, pinch-zoom,
 * double-tap zoom, long-press callouts and text selection. Elements marked `.scroll` (settings, credits,
 * debug panel) still scroll vertically with one finger.
 */
export function installGestureGuards(): void {
  const opts = { passive: false } as AddEventListenerOptions;
  const inScroll = (t: EventTarget | null): boolean => {
    const el = t instanceof Element ? t : null;
    return !!el?.closest('.scroll');
  };

  // iOS Safari pinch (ignores user-scalable=no since iOS 10).
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), opts);

  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 || !inScroll(e.target)) {
        if (e.cancelable) e.preventDefault();
      }
      // iOS reports a scale on pinch even inside scroll containers.
      if ((e as TouchEvent & { scale?: number }).scale !== undefined && (e as TouchEvent & { scale?: number }).scale !== 1 && e.cancelable) e.preventDefault();
    },
    opts,
  );

  // Double-tap zoom on iOS: swallow a second quick tap on non-interactive surfaces.
  let lastEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      const t = e.target as Element | null;
      const interactive = !!t?.closest?.('button, a, input, select, textarea, [role="slider"], .touch-ctl, .scroll');
      if (!interactive && now - lastEnd < 320 && e.cancelable) e.preventDefault();
      lastEnd = now;
    },
    opts,
  );

  document.addEventListener('dblclick', (e) => e.preventDefault(), opts);
  document.addEventListener('contextmenu', (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
  document.addEventListener('selectstart', (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
  // Ctrl+wheel / trackpad pinch zoom on desktop.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    opts,
  );
  // Never let a drag start an HTML drag-and-drop ghost image.
  document.addEventListener('dragstart', (e) => e.preventDefault());
}
