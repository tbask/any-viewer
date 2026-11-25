import { defineConfig } from 'vite';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Standalone build: a single classic script (global `AnyViewer`) plus the WebView host page.
 * Everything, PDF.js included, is inlined, so the file is large; pages that can use ES modules
 * should import the package instead and get per-format lazy loading.
 */
export default defineConfig({
  build: {
    target: 'es2020',
    outDir: 'dist/standalone',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/standalone.ts'),
      formats: ['iife'],
      name: 'AnyViewer',
      fileName: () => 'any-viewer.global.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
    sourcemap: false,
  },
  worker: { format: 'iife', rollupOptions: { output: { inlineDynamicImports: true } } },
  plugins: [
    {
      name: 'copy-host-page',
      closeBundle() {
        copyFileSync(resolve(__dirname, 'standalone/viewer.html'), resolve(__dirname, 'dist/standalone/viewer.html'));
      },
    },
  ],
});
