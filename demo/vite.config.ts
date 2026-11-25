import { defineConfig, type Plugin } from 'vite';
import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, normalize } from 'node:path';

const pdfRoot = resolve(__dirname, '../node_modules/pdfjs-dist');
const dirs = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

/** Serves the PDF.js static assets at /pdfjs/ in development and copies them when the demo is built. */
function pdfAssets(): Plugin {
  let outDir = '';
  let isBuild = false;
  return {
    name: 'demo-pdf-assets',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      isBuild = config.command === 'build';
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const file = normalize(resolve(pdfRoot, '.' + (req.url ?? '').split('?')[0]));
        if (!file.startsWith(pdfRoot) || !existsSync(file) || !statSync(file).isFile()) return next();
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      // The hook is also called when the dev server stops; copying is needed only on build.
      if (!isBuild) return;
      for (const d of dirs) cpSync(resolve(pdfRoot, d), resolve(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [pdfAssets()],
  worker: { format: 'es' },
  build: { target: 'es2020' },
});
