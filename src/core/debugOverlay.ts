/** On-screen error overlay for ?debug (spec §14). Owner: core. */
let overlay: HTMLDivElement | null = null;
let enabled = false;

export function installDebugOverlay(): void {
  enabled = true;
  window.addEventListener('error', (e) => reportError('[window] ' + (e.message || 'error'), e.error));
  window.addEventListener('unhandledrejection', (e) => reportError('[promise] unhandled rejection', e.reason));
}

export function reportError(label: string, err?: unknown): void {
  console.error(label, err);
  if (!enabled) return;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'debug-errors';
    overlay.style.cssText =
      'position:fixed;left:8px;bottom:8px;max-width:60vw;max-height:40vh;overflow:auto;z-index:99999;' +
      'background:rgba(120,0,0,.85);color:#fff;font:11px/1.35 monospace;padding:6px 8px;border-radius:6px;pointer-events:auto;white-space:pre-wrap';
    overlay.title = 'click to dismiss';
    overlay.addEventListener('click', () => {
      overlay?.remove();
      overlay = null;
    });
    document.body.appendChild(overlay);
  }
  const msg = err instanceof Error ? `${err.message}\n${(err.stack ?? '').split('\n').slice(1, 4).join('\n')}` : err !== undefined ? String(err) : '';
  const line = document.createElement('div');
  line.textContent = `${label}${msg ? ': ' + msg : ''}`;
  overlay.appendChild(line);
  while (overlay.childElementCount > 12) overlay.firstElementChild?.remove();
}
