// Build orchestrator. One extension needs three different bundle shapes:
//   1. extension pages (popup / preview / editor / options / history) – HTML apps
//   2. background service worker – single ES module
//   3. content agent – single classic script (IIFE), injected with chrome.scripting
// Usage: node scripts/build.mjs [--watch] [--e2e]
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifest } from './manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const e2e = args.has('--e2e');
const outDir = path.join(root, e2e ? 'dist-e2e' : 'dist');
const src = path.join(root, 'src');

const common = {
  configFile: false,
  logLevel: 'warn',
  root: src,
  base: './',
  resolve: { alias: { '@': src } },
  define: {
    __E2E__: JSON.stringify(e2e),
    'process.env.NODE_ENV': JSON.stringify(watch || e2e ? 'development' : 'production'),
  },
};

function outputConfig(extra = {}, emptyOutDir = false) {
  return {
    outDir,
    emptyOutDir,
    target: 'es2022',
    sourcemap: watch || e2e,
    minify: !(watch || e2e),
    chunkSizeWarningLimit: 1500,
    ...extra,
  };
}

const pages = {
  popup: path.join(src, 'popup/index.html'),
  preview: path.join(src, 'preview/index.html'),
  editor: path.join(src, 'editor/index.html'),
  options: path.join(src, 'options/index.html'),
  history: path.join(src, 'history/index.html'),
};

const pagesConfig = (emptyOutDir, w) => ({
  ...common,
  publicDir: path.join(root, 'public'),
  plugins: [react()],
  build: outputConfig({ rollupOptions: { input: pages }, ...(w ? { watch: {} } : {}) }, emptyOutDir),
});

const backgroundConfig = (w) => ({
  ...common,
  publicDir: false,
  build: outputConfig(
    {
      lib: {
        entry: path.join(src, 'background/index.ts'),
        formats: ['es'],
        fileName: () => 'background.js',
      },
      ...(w ? { watch: {} } : {}),
    },
    false,
  ),
});

const contentConfig = (w) => ({
  ...common,
  publicDir: false,
  build: outputConfig(
    {
      lib: {
        entry: path.join(src, 'content/index.ts'),
        formats: ['iife'],
        name: 'SnapflowAgent',
        fileName: () => 'content.js',
      },
      ...(w ? { watch: {} } : {}),
    },
    false,
  ),
});

async function writeManifest() {
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(createManifest({ e2e }), null, 2));
}

const started = Date.now();
console.log(`[snapflow] building ${e2e ? 'E2E' : 'production'} bundle -> ${path.relative(root, outDir)}`);
await build(pagesConfig(true, false));
await build(backgroundConfig(false));
await build(contentConfig(false));
await writeManifest();
console.log(`[snapflow] done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (watch) {
  console.log('[snapflow] watching for changes… reload the extension in chrome://extensions after each rebuild');
  await build(pagesConfig(false, true));
  await build(backgroundConfig(true));
  await build(contentConfig(true));
}
