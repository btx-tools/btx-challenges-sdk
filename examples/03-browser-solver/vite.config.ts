import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      // Two pages: the original gate-flow demo + the Phase-2 WASM bench.
      input: {
        main: resolve(__dirname, 'index.html'),
        bench: resolve(__dirname, 'bench.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
});
