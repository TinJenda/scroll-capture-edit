// Generates the extension icons (PNG) without any image dependency.
// Design: indigo→blue rounded square, white viewfinder corners, red capture dot.
// Usage: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- shape helpers in a 128x128 design space ----
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function bracket(x, y) {
  const inset = 28;
  const len = 28;
  const t = 9;
  const lo = inset;
  const hi = 128 - inset;
  const hBar = (y0) => y >= y0 && y <= y0 + t;
  const vBar = (x0) => x >= x0 && x <= x0 + t;
  // top-left
  if ((hBar(lo) && x >= lo && x <= lo + len) || (vBar(lo) && y >= lo && y <= lo + len)) return true;
  // top-right
  if ((hBar(lo) && x >= hi - len && x <= hi) || (vBar(hi - t) && y >= lo && y <= lo + len)) return true;
  // bottom-left
  if ((hBar(hi - t) && x >= lo && x <= lo + len) || (vBar(lo) && y >= hi - len && y <= hi)) return true;
  // bottom-right
  if ((hBar(hi - t) && x >= hi - len && x <= hi) || (vBar(hi - t) && y >= hi - len && y <= hi)) return true;
  return false;
}

function sample(x, y) {
  if (!inRoundRect(x, y, 4, 4, 124, 124, 28)) return null;
  const k = (x + y) / 256;
  let color = [99 + (59 - 99) * k, 102 + (130 - 102) * k, 241 + (246 - 241) * k, 255];
  if (bracket(x, y)) color = [255, 255, 255, 255];
  if (inCircle(x, y, 64, 64, 15)) color = [255, 59, 48, 255];
  else if (inCircle(x, y, 64, 64, 21)) color = [255, 255, 255, 255];
  return color;
}

function render(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 128;
          const y = ((py + (sy + 0.5) / ss) / size) * 128;
          const c = sample(x, y);
          if (c) {
            r += c[0]; g += c[1]; b += c[2]; a += c[3];
          }
        }
      }
      const n = ss * ss;
      const o = (py * size + px) * 4;
      const cov = a / 255 / n;
      buf[o] = cov ? Math.round(r / (cov * n)) : 0;
      buf[o + 1] = cov ? Math.round(g / (cov * n)) : 0;
      buf[o + 2] = cov ? Math.round(b / (cov * n)) : 0;
      buf[o + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(path.join(outDir, `icon-${size}.png`), encodePng(size, size, render(size)));
  console.log(`wrote icon-${size}.png`);
}
