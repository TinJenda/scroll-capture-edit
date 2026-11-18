// Builds a portable Windows app: release/snapflow-desktop-<version>-win32-x64.zip
//   <zip>/SnapFlow-<version>-win32-x64/SnapFlow.exe  (+ Electron runtime, resources/app = the built app)
// No installer, no Node needed on the target machine: unzip and run SnapFlow.exe.
// Usage: npm run desktop:pack   (builds first)
//        node scripts/package-desktop.mjs --e2e   → release/e2e/SnapFlow-e2e/ (test build, not zipped; used to
//        run the Playwright suite against the packaged executable)
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk, writeZip } from './zip.mjs';

if (process.platform !== 'win32') {
  console.error('The portable package is built for Windows (win32-x64) and must be created on Windows.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2e = process.argv.includes('--e2e');
const appBuild = path.join(root, e2e ? 'dist-desktop-e2e' : 'dist-desktop');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

for (const needed of [path.join(appBuild, 'main.cjs'), path.join(electronDist, 'electron.exe')]) {
  if (!existsSync(needed)) {
    console.error(`${path.relative(root, needed)} not found – run \`npm run desktop:build\` (and \`npm install\`) first.`);
    process.exit(1);
  }
}

const folder = e2e ? 'SnapFlow-e2e' : `SnapFlow-${pkg.version}-win32-x64`;
const stage = path.join(root, 'release', ...(e2e ? ['e2e'] : []), folder);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 1. The Electron runtime (renamed), without the demo app and with only the languages we ship.
const keepLocales = new Set(['en-US.pak', 'vi.pak']);
cpSync(electronDist, stage, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(electronDist, src).replaceAll('\\', '/');
    if (rel === 'resources/default_app.asar') return false;
    if (rel.startsWith('locales/') && !keepLocales.has(path.basename(rel))) return false;
    return true;
  },
});
renameSync(path.join(stage, 'electron.exe'), path.join(stage, 'SnapFlow.exe'));

// 2. The app itself plus the one native dependency (koffi: mouse-wheel injection).
const appDir = path.join(stage, 'resources', 'app');
cpSync(appBuild, appDir, { recursive: true, filter: (src) => e2e || !src.endsWith('.map') });
for (const mod of ['koffi', path.join('@koromix', 'koffi-win32-x64')]) {
  const from = path.join(root, 'node_modules', mod);
  if (!existsSync(from)) {
    console.error(`node_modules/${mod} is missing – run \`npm install\`.`);
    process.exit(1);
  }
  cpSync(from, path.join(appDir, 'node_modules', mod), { recursive: true });
}

writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `SnapFlow ${pkg.version} (desktop, Windows 64-bit)`,
    '',
    'Run SnapFlow.exe. It lives in the system tray (bottom-right, near the clock).',
    '',
    '  Ctrl+Shift+1  Capture a region        Ctrl+Shift+3  Full screen',
    '  Ctrl+Shift+2  Scrolling region        Ctrl+Shift+4  A window',
    '',
    'Scrolling region: drag over the area that scrolls (a web page, a table, a document...). SnapFlow rolls the',
    'mouse wheel over it and stitches what it sees. Keep the mouse still and do not cover the area. Esc stops and',
    'keeps what has been captured so far.',
    '',
    'The app is not code-signed, so Windows SmartScreen may say "unknown publisher": More info -> Run anyway.',
    'Nothing is sent anywhere; screenshots stay on this computer.',
    '',
  ].join('\r\n'),
);

if (e2e) {
  console.log(`test build staged at ${path.relative(root, path.join(stage, 'SnapFlow.exe'))}`);
  process.exit(0);
}

// 3. Zip it (the folder is the top level, so unzipping gives one tidy directory).
const outFile = path.join(root, 'release', `snapflow-desktop-${pkg.version}-win32-x64.zip`);
rmSync(outFile, { force: true });
const files = walk(stage, { base: folder });
const { count, bytes } = writeZip(
  files.map((f) => ({ rel: f.rel, full: f.full })),
  outFile,
  { level: 6 },
);
console.log(`packed ${count} files -> ${path.relative(root, outFile)} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`unpacked copy for a quick test: ${path.relative(root, path.join(stage, 'SnapFlow.exe'))}`);
