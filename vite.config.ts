import { defineConfig } from 'vite';

// base './' => the build works from any static host or sub-path (GitHub Pages, Netlify, Vercel, file server).
export default defineConfig({
  base: './',
  server: { host: false, port: 5173 },
  build: {
    target: 'es2022',
    outDir: process.env.OUT_DIR || 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    assetsInlineLimit: 0,
  },
});
