// Packs dist/ into release/snapflow-<version>.zip – the file you send to other people
// (or upload to the Chrome Web Store). Pure Node, no dependencies; manifest.json sits at the zip root.
// Usage: npm run package   (builds first)   |   node scripts/package.mjs   (zips the existing dist/)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, writeZip } from './zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

let manifest;
try {
  manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
} catch {
  console.error('dist/manifest.json not found – run `npm run build` first.');
  process.exit(1);
}
if (manifest.name?.includes('E2E')) {
  console.error('dist/ contains the E2E test build. Run `npm run build` (production) before packaging.');
  process.exit(1);
}

const outFile = path.join(root, 'release', `snapflow-${pkg.version}.zip`);
const { count, bytes } = writeZip(walk(dist, { skip: (n) => n.endsWith('.map') }), outFile);
console.log(`packed ${count} files -> ${path.relative(root, outFile)} (${(bytes / 1024).toFixed(0)} KB)`);
