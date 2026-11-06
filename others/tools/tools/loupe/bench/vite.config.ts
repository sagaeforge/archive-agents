// A separate build for the manual bench. Its output stays in the ignored .cache folder.
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: { alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) } },
  build: { target: 'es2023', outDir: '../.cache/bench/dist', emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
