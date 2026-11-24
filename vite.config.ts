import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** The endpoint contract version (public/endpoint.md, "Endpoint version: N") baked into the game as gca.version. */
function endpointVersion(): number {
  try {
    const m = /Endpoint version:\s*(\d+)/.exec(readFileSync(new URL('./public/endpoint.md', import.meta.url), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * LIVE_PREVIEW=1 (npm run live): while many agents edit files, collapse the flood of HMR updates into one full page
 * reload after changes settle (15 s quiet) — at most one reload per minute while edits keep coming.
 */
function debouncedReload(): Plugin {
  const QUIET = 15_000;
  const MAX = 60_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first = 0;
  return {
    name: 'debounced-reload',
    apply: 'serve',
    handleHotUpdate({ server }) {
      if (!process.env.LIVE_PREVIEW) return;
      const now = Date.now();
      if (!first) first = now;
      if (timer) clearTimeout(timer);
      const wait = Math.max(0, Math.min(QUIET, first + MAX - now));
      timer = setTimeout(() => {
        first = 0;
        timer = null;
        server.ws.send({ type: 'full-reload' });
      }, wait);
      return [];
    },
  };
}

// base './' => the build works from any static host or sub-path (GitHub Pages, Netlify, Vercel, file server).
export default defineConfig({
  base: './',
  define: { __ENDPOINT_VERSION__: JSON.stringify(endpointVersion()) },
  plugins: [debouncedReload()],
  server: {
    host: false,
    port: 5999,
    watch: { ignored: ['**/.smoke/**', '**/docs/**', '**/scripts/**', '**/dist/**'] },
  },
  build: {
    target: 'es2022',
    outDir: process.env.OUT_DIR || 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
});
