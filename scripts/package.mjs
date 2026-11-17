// Packs dist/ into release/snapflow-<version>.zip – the file you send to other people
// (or upload to the Chrome Web Store). Pure Node, no dependencies; manifest.json sits at the zip root.
// Usage: npm run package   (builds first)   |   node scripts/package.mjs   (zips the existing dist/)
import { deflateRawSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name; // zip entries always use forward slashes
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else if (!name.endsWith('.map')) out.push({ rel, full });
  }
  return out;
}

const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const locals = [];
const centrals = [];
let offset = 0;
for (const { rel, full } of walk(dist)) {
  const data = readFileSync(full);
  const packed = deflateRawSync(data, { level: 9 });
  const useDeflate = packed.length < data.length;
  const body = useDeflate ? packed : data;
  const name = Buffer.from(rel, 'utf8');
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4); // version needed
  lh.writeUInt16LE(0x0800, 6); // UTF-8 names
  lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
  lh.writeUInt16LE(dosTime, 10);
  lh.writeUInt16LE(dosDate, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26);
  locals.push(lh, name, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4); // version made by
  ch.writeUInt16LE(20, 6); // version needed
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
  ch.writeUInt16LE(dosTime, 12);
  ch.writeUInt16LE(dosDate, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);
  offset += lh.length + name.length + body.length;
}

const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(path.join(root, 'release'), { recursive: true });
const outFile = path.join(root, 'release', `snapflow-${pkg.version}.zip`);
writeFileSync(outFile, Buffer.concat([...locals, ...centrals, end]));
console.log(`packed ${centrals.length / 2} files -> ${path.relative(root, outFile)} (${(statSync(outFile).size / 1024).toFixed(0)} KB)`);
