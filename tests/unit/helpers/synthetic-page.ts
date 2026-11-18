import type { PixelFrame } from '@/shared/overlap';

/* ---------- synthetic "document" -------------------------------------------------------------- */

export function hash(a: number, b: number, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export const WHITE = 0xffffffff;
export const DARK = 0xff202020;

/** A tall page made of unique "text lines" separated by blank rows. */
export function makePage(width: number, height: number, seed = 1, lineHeight = 20): PixelFrame {
  const px = new Uint32Array(width * height).fill(WHITE);
  for (let y = 0; y < height; y++) {
    const line = Math.floor(y / lineHeight);
    const inLine = y % lineHeight;
    if (inLine < 6) continue; // blank gap
    for (let x = 0; x < width; x++) {
      if (hash(seed + line, inLine >> 2, x >> 1) % 3 === 0) px[y * width + x] = DARK;
    }
  }
  return { width, height, px };
}

export interface Chrome {
  header?: number;
  footer?: number;
  /** Fixed panel on the left that never scrolls. */
  sidebar?: number;
  /** Scrollbar thumb drawn in the last columns. */
  scrollbar?: number;
  /** Row (in frame coordinates) with a hover highlight. */
  hoverRow?: number;
}

export function render(page: PixelFrame, offset: number, H: number, c: Chrome = {}): PixelFrame {
  const W = page.width;
  const px = new Uint32Array(W * H);
  const header = c.header ?? 0;
  const footer = c.footer ?? 0;
  for (let y = 0; y < H; y++) {
    let row: Uint32Array;
    if (y < header) row = headerRow(W, y);
    else if (y >= H - footer) row = footerRow(W, y - (H - footer));
    else row = page.px.subarray((offset + y - header) * W, (offset + y - header + 1) * W);
    px.set(row, y * W);
  }
  if (c.sidebar) {
    for (let y = 0; y < H; y++) for (let x = 0; x < c.sidebar; x++) px[y * W + x] = hash(y, x, 77) % 2 ? 0xff884400 : 0xffeeeeee;
  }
  if (c.scrollbar) {
    const thumbTop = Math.floor((offset / page.height) * H);
    for (let y = 0; y < H; y++) {
      for (let x = W - c.scrollbar; x < W; x++) px[y * W + x] = y >= thumbTop && y < thumbTop + 40 ? 0xff555555 : 0xfff0f0f0;
    }
  }
  if (c.hoverRow !== undefined) for (let x = 0; x < W; x++) px[c.hoverRow * W + x] = 0xffcce0ff;
  return { width: W, height: H, px };
}

export function headerRow(W: number, y: number): Uint32Array {
  const r = new Uint32Array(W);
  for (let x = 0; x < W; x++) r[x] = hash(y, x, 5) % 2 ? 0xff112233 : 0xff223344;
  return r;
}
export function footerRow(W: number, y: number): Uint32Array {
  const r = new Uint32Array(W);
  for (let x = 0; x < W; x++) r[x] = hash(y, x, 9) % 2 ? 0xff334455 : 0xff445566;
  return r;
}

export function rowsOf(f: PixelFrame, y0: number, y1: number): Uint32Array {
  return f.px.subarray(y0 * f.width, y1 * f.width);
}

export function equal(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

