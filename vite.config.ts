import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  server: {
    headers: {
      // Required if SharedArrayBuffer is ever needed; harmless otherwise
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
})
