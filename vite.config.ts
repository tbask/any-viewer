import { defineConfig } from 'vite';
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Copies the static PDF.js resources (CMaps, standard fonts, wasm decoders) to dist/pdfjs. */
function copyPdfAssets() {
  return {
    name: 'copy-pdf-assets',
    closeBundle() {
      const from = resolve(__dirname, 'node_modules/pdfjs-dist');
      const to = resolve(__dirname, 'dist/pdfjs');
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        if (existsSync(resolve(from, dir))) cpSync(resolve(from, dir), resolve(to, dir), { recursive: true });
      }
      cpSync(resolve(from, 'LICENSE'), resolve(to, 'LICENSE'));
    },
  };
}

export default defineConfig({
  build: {
    target: 'es2020',
    lib: {
      entry: { index: resolve(__dirname, 'src/index.ts'), react: resolve(__dirname, 'src/react.ts') },
      formats: ['es'],
      fileName: (_format: string, name: string) => `${name}.js`,
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime'],
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
    sourcemap: true,
  },
  worker: { format: 'es' },
  plugins: [copyPdfAssets()],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as any);
