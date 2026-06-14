import { defineConfig } from 'vite'

export default defineConfig({
  base: '/PalimpsestII/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  // Persistence.ts's LAYER_CLASSES registry keys on `constructor.name` —
  // keep class names intact through minification so save files load correctly
  // on the deployed (built) site, not just in `npm run dev`.
  esbuild: {
    keepNames: true,
  },
  server: {
    headers: {
      // Required if SharedArrayBuffer is ever needed; harmless otherwise
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
})
