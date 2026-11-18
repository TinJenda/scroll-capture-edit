// Desktop (Electron) build. Three bundles, all into dist-desktop/:
//   renderer/  – HTML pages (preview, editor, history, options, launcher, overlay, pill, hub)
//   main.cjs   – main process (Node/Electron, CommonJS)
//   preload.cjs– the sandboxed bridge
// Usage: node scripts/build-desktop.mjs [--e2e]
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const outDir = path.join(root, e2e ? 'dist-desktop-e2e' : 'dist-desktop');
const src = path.join(root, 'src');
const desktop = path.join(root, 'desktop');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const common = {
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@': src } },
  define: {
    __E2E__: JSON.stringify(e2e),
    'process.env.NODE_ENV': JSON.stringify(e2e ? 'development' : 'production'),
  },
};

const started = Date.now();
console.log(`[snapflow-desktop] building ${e2e ? 'E2E' : 'production'} bundle -> ${path.relative(root, outDir)}`);
await rm(outDir, { recursive: true, force: true });

const pageNames = ['launcher', 'preview', 'editor', 'history', 'options', 'overlay', 'pill', 'hub', 'picker'];
await build({
  ...common,
  root: path.join(desktop, 'renderer'),
  base: './',
  publicDir: path.join(root, 'public'),
  plugins: [react()],
  build: {
    outDir: path.join(outDir, 'renderer'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: e2e,
    minify: !e2e,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: Object.fromEntries(pageNames.map((n) => [n, path.join(desktop, 'renderer', n, 'index.html')])),
    },
  },
});

const nodeBundle = (entry, fileName) =>
  build({
    ...common,
    root: desktop,
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'node22',
      sourcemap: e2e,
      minify: false,
      ssr: path.join(desktop, entry),
      rollupOptions: { output: { format: 'cjs', entryFileNames: fileName } },
    },
    ssr: { target: 'node', external: ['electron', 'koffi'] },
  });

await nodeBundle('main/index.ts', 'main.cjs');
await nodeBundle('preload/index.ts', 'preload.cjs');

await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, 'package.json'),
  JSON.stringify({ name: 'snapflow-desktop', productName: 'SnapFlow', version: pkg.version, main: 'main.cjs', private: true }, null, 2),
);
console.log(`[snapflow-desktop] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
