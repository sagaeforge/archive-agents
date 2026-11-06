import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { APP_CSP as CSP } from './server/csp.ts';

// Design 9. Build only: the dev server needs Vite's inline scripts. `loupe serve` also sends this policy as a header (server/csp.ts).
const cspMeta = (): Plugin => ({
  name: 'loupe-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

const kbDev = process.env.KB_DEV_TARGET ?? 'http://127.0.0.1:4811';

export default defineConfig({
  // Relative assets plus hash history: the build runs under any mount path without rebuilding (design 10).
  base: './',
  plugins: [react(), tailwindcss(), cspMeta()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The package sits in the workspace root's node_modules, so it is resolved, not addressed by a local path.
      // Its browser build calls document.createElement, and the Markdown parser runs in a worker. The plain build is a lookup table.
      'decode-named-character-reference': createRequire(import.meta.url).resolve('decode-named-character-reference'),
    },
  },
  server: {
    host: '127.0.0.1', port: 4810, strictPort: true,
    // The browser only knows `kb/`. In dev, Vite plays the part of loupe serve and strips the prefix.
    proxy: { '/kb': { target: kbDev, changeOrigin: false, rewrite: (p) => p.replace(/^\/kb/, '') } },
  },
  preview: { host: '127.0.0.1', port: 4812, strictPort: true },
  // ES workers can split: Shiki languages load only when a document uses them (design 9).
  worker: { format: 'es' },
  build: {
    target: 'es2023', sourcemap: false, chunkSizeWarningLimit: 800,
    // Its own chunk so the budget in design 11 reads one file. Only the graph route imports it.
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'graph-vendor', test: /node_modules\/(sigma|graphology|graphology-utils|graphology-types|events)\// }] } } },
  },
});
