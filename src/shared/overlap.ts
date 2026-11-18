/**
 * Content-based scroll stitching for the desktop app.
 *
 * In the browser the extension knows exactly how far a page scrolled. A native window gives no such
 * information, so the distance between two consecutive screenshots of the same region is *measured*
 * from their pixels: `findVerticalShift` finds the `d` for which `next[y] == prev[y + d]`.
 *
 * Real windows make that harder than it sounds, so the matcher is deliberately tolerant:
 *   - sticky headers / footers are detected (rows identical at the same position) and not counted,
 *   - fixed side panels and scrollbars are ignored (only columns that actually move are compared),
 *   - a few changed rows (hover highlight, caret, animation) do not break a match,
 *   - blank rows never vote (they match at every shift),
 *   - a hint for the expected distance resolves repetitive content (identical table rows).
 * It never guesses: when no shift reaches the confidence bar it reports `lost`.
 */

export interface PixelFrame {
  width: number;
  height: number;
  /** One 32-bit value per pixel, row-major. Channel order does not matter, only equality. */
  px: Uint32Array;
}

export interface ShiftOptions {
  /** Distance the caller expects (from calibration). Used to resolve ambiguity and to narrow the search. */
  expected?: number;
  /** Largest shift considered (default 92% of the frame height). */
  maxShift?: number;
  /** Diagnostics for tests and debugging. */
  debug?: (message: string) => void;
}

export type ShiftResult =
  | { kind: 'same' }
  | { kind: 'lost' }
  | {
      kind: 'shift';
      /** Rows the content moved up between the two frames. */
      shift: number;
      /** Rows at the top / bottom that did not move (sticky header / footer). */
      top: number;
      bottom: number;
      /** Fraction of informative rows that agree (0..1). */
      score: number;
    };

const COLUMN_STATIC_FRACTION = 0.985;
const MAX_SAMPLE_COLUMNS = 192;
const MAX_PROBES = 48;
const MIN_PROBES = 6;
const MIN_MATCHED_ROWS = 6;
const ACCEPT_SCORE = 0.9;
/** A row is "unchanged" when at most this fraction of its pixels differ (scrollbar, cursor, caret). */
const ROW_STATIC_TOLERANCE = 0.02;
/** A shifted row matches when at most this fraction of the compared columns differ. */
const ROW_MATCH_TOLERANCE = 0.08;
/**
 * Rows this close to the edge of the frame are not used as evidence: text that is clipped by the edge is
 * rasterised slightly differently depending on how much of it is visible.
 */
const EDGE_MARGIN = 12;

function evenlySpaced(values: number[], count: number): number[] {
  if (values.length <= count) return values;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(values[Math.floor((i * (values.length - 1)) / (count - 1))]);
  return out;
}

/** Wrap raw bytes (BGRA/RGBA) as a PixelFrame. Copies when the buffer is not 4-byte aligned. */
export function frameFromBytes(bytes: Uint8Array, width: number, height: number): PixelFrame {
  const n = width * height;
  if (bytes.byteLength < n * 4) throw new Error('Pixel buffer is smaller than width × height × 4');
  const aligned = bytes.byteOffset % 4 === 0;
  const px = aligned
    ? new Uint32Array(bytes.buffer, bytes.byteOffset, n)
    : new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + n * 4));
  return { width, height, px };
}

export function findVerticalShift(prev: PixelFrame, next: PixelFrame, opts: ShiftOptions = {}): ShiftResult {
  const W = next.width;
  const H = next.height;
  if (prev.width !== W || prev.height !== H || H < 16 || W < 8) return { kind: 'lost' };
  const a = prev.px;
  const b = next.px;

  /* ---- 1. what moved? ---- */
  const colBad = new Int32Array(W);
  const rowBad = new Int32Array(H);
  for (let y = 0, o = 0; y < H; y++, o += W) {
    let bad = 0;
    for (let x = 0; x < W; x++) {
      if (a[o + x] !== b[o + x]) {
        colBad[x]++;
        bad++;
      }
    }
    rowBad[y] = bad;
  }
  const staticRowLimit = Math.max(1, Math.floor(W * ROW_STATIC_TOLERANCE));
  const staticRow = new Uint8Array(H);
  let changedRows = 0;
  for (let y = 0; y < H; y++) {
    if (rowBad[y] <= staticRowLimit) staticRow[y] = 1;
    else changedRows++;
  }
  opts.debug?.(`changedRows=${changedRows}`);
  if (changedRows <= Math.max(2, Math.floor(H * 0.01))) return { kind: 'same' };

  /* ---- 2. columns that carry the scrolling content ---- */
  const moving: number[] = [];
  const movingLimit = H * (1 - COLUMN_STATIC_FRACTION);
  // The scrollbar lives at the right edge and its thumb moves with the content: never compare those columns.
  const scrollbarMargin = W > 200 ? Math.max(24, Math.ceil(W * 0.025)) : 0;
  for (let x = 0; x < W - scrollbarMargin; x++) if (colBad[x] > movingLimit) moving.push(x);
  opts.debug?.(`moving=${moving.length}`);
  if (moving.length < 4) return { kind: 'same' };
  const cols = Int32Array.from(evenlySpaced(moving, MAX_SAMPLE_COLUMNS));
  const nCols = cols.length;

  /* ---- 3. informative rows of the new frame (blank rows match everywhere, so they must not vote) ---- */
  const info = new Uint8Array(H);
  const edgeNeed = 3;
  for (let y = 0, o = 0; y < H; y++, o += W) {
    let edges = 0;
    let last = b[o + cols[0]];
    for (let i = 1; i < nCols && edges < edgeNeed; i++) {
      const v = b[o + cols[i]];
      if (v !== last) edges++;
      last = v;
    }
    info[y] = edges >= edgeNeed ? 1 : 0;
  }

  /* sticky bands: runs of rows that did not move at all (what the stitcher holds back as header/footer). */
  let top = 0;
  while (top < H && staticRow[top]) top++;
  let bottom = 0;
  while (bottom < H - top && staticRow[H - 1 - bottom]) bottom++;

  /*
   * Rows are compared by their *foreground*: the pixels that differ from the row's own background. A page
   * with big flat areas and a little text would otherwise "match" at any shift, because the text covers only
   * a few percent of the width. The background colour of both rows must agree, and the tolerance for stray
   * differences (hover, caret, scrollbar thumb) is a fraction of the foreground, not of the width.
   */
  const dominant = (px: Uint32Array, y: number): number => {
    const o = y * W;
    let cand = px[o + cols[0]];
    let count = 0;
    for (let i = 0; i < nCols; i++) {
      const v = px[o + cols[i]];
      if (count === 0) cand = v;
      count += v === cand ? 1 : -1;
    }
    return cand;
  };
  const domA = new Uint32Array(H);
  const domB = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    domA[y] = dominant(a, y);
    domB[y] = dominant(b, y);
  }

  const rowEq = (ya: number, yb: number): boolean => {
    const da = domA[ya];
    if (da !== domB[yb]) return false;
    const ao = ya * W;
    const bo = yb * W;
    let fg = 0;
    let bad = 0;
    for (let i = 0; i < nCols; i++) {
      const c = cols[i];
      const pa = a[ao + c];
      const pb = b[bo + c];
      if (pa !== da || pb !== da) {
        fg++;
        if (pa !== pb) bad++;
      }
    }
    return bad <= Math.floor(fg * ROW_MATCH_TOLERANCE);
  };

  /* ---- 4. coarse scan with a handful of probe rows ---- */
  // A sticky header / footer is a run of unmoved rows that carries content. Blank unmoved rows are just blank
  // page and must not shrink the area we can use as evidence.
  let headEnd = 0;
  for (let y = 0; y < top; y++) if (info[y]) headEnd = top;
  let footStart = H;
  for (let y = H - 1; y >= H - bottom; y--) if (info[y]) footStart = H - bottom;
  const lo = Math.max(EDGE_MARGIN, headEnd);
  const hi = Math.min(H - EDGE_MARGIN, footStart);

  const probeRows: number[] = [];
  for (let y = lo; y < hi; y++) if (info[y]) probeRows.push(y);
  opts.debug?.(`top=${top} bottom=${bottom} info=${info.reduce((n, v) => n + v, 0)} probeRows=${probeRows.length}`);
  if (probeRows.length < MIN_PROBES) return { kind: 'lost' };
const maxShift = Math.max(1, Math.min(opts.maxShift ?? Math.floor(H * 0.92), H - 2 * EDGE_MARGIN - 8));

  const scan = (dLo: number, dHi: number): Array<{ d: number; hits: number; ratio: number }> => {
    const found: Array<{ d: number; hits: number; ratio: number }> = [];
    for (let d = Math.max(1, dLo); d <= Math.min(maxShift, dHi); d++) {
      // Only probe rows whose partner (y + d) is still inside the evidence area.
      let n = 0;
      while (n < probeRows.length && probeRows[n] + d < hi) n++;
      if (n < MIN_PROBES) continue;
      const stride = Math.max(1, Math.floor(n / MAX_PROBES));
      let valid = 0;
      let hits = 0;
      for (let i = 0; i < n; i += stride) {
        valid++;
        if (rowEq(probeRows[i] + d, probeRows[i])) hits++;
      }
      if (hits / valid >= 0.7) found.push({ d, hits, ratio: hits / valid });
    }
    return found.sort((p, q) => q.ratio - p.ratio || q.hits - p.hits);
  };

  /* ---- 5. verify candidates against every informative row ---- */
  const verify = (d: number): { matched: number; score: number } => {
    let matched = 0;
    let unmatched = 0;
    for (let y = lo; y < hi - d; y++) {
      if (!info[y]) continue;
      if (rowEq(y + d, y)) matched++;
      else unmatched++;
    }
    return { matched, score: matched / Math.max(1, matched + unmatched) };
  };

  const pick = (cands: Array<{ d: number; hits: number; ratio: number }>): { d: number; score: number } | null => {
    const verified: Array<{ d: number; matched: number; score: number }> = [];
    const e0 = opts.expected;
    const nearest = e0 ? cands.slice(8).sort((p, q) => Math.abs(p.d - e0) - Math.abs(q.d - e0)).slice(0, 3) : [];
    for (const c of [...cands.slice(0, 8), ...nearest]) {
      const v = verify(c.d);
      if (v.matched >= MIN_MATCHED_ROWS && v.score >= ACCEPT_SCORE) verified.push({ d: c.d, ...v });
    }
    if (!verified.length) return null;
    const best = Math.max(...verified.map((v) => v.score));
    const close = verified.filter((v) => v.score >= best - 0.02);
    const e = opts.expected;
    close.sort((p, q) => (e ? Math.abs(p.d - e) - Math.abs(q.d - e) : p.d - q.d));
    return { d: close[0].d, score: close[0].score };
  };

  opts.debug?.(`scan(1..${maxShift}) found=${scan(1, maxShift).slice(0, 5).map((c) => `${c.d}:${c.hits}`).join(',')}`);
  let chosen: { d: number; score: number } | null = null;
  if (opts.expected && opts.expected > 0) {
    chosen = pick(scan(Math.floor(opts.expected * 0.5), Math.ceil(opts.expected * 1.8)));
  }
  chosen ??= pick(scan(1, maxShift));
  if (!chosen) return { kind: 'lost' };

  return { kind: 'shift', shift: chosen.d, top, bottom, score: chosen.score };
}

/* ------------------------------------------------------------------------------------------------ */

export type AddResult =
  | { kind: 'added'; shift: number; rows: number; top: number; bottom: number }
  | { kind: 'same' }
  | { kind: 'lost' }
  | { kind: 'full' };

/**
 * Builds one tall image from consecutive frames of a scrolling region.
 *
 * Invariant: the output holds the content above the footer band of the *latest* frame; that band is
 * appended once, by `finish()`, so a sticky footer appears a single time at the very bottom.
 */
export class VerticalStitcher {
  private chunks: Uint32Array[] = [];
  private rows = 0;
  private prev: PixelFrame | null = null;
  /** Row of `prev` up to which the output is complete (everything below is the held-back footer). */
  private frontier = 0;
  readonly width: number;
  readonly frameHeight: number;

  constructor(
    frame: PixelFrame,
    private readonly maxRows: number,
  ) {
    this.width = frame.width;
    this.frameHeight = frame.height;
    this.append(frame, 0, frame.height);
    this.prev = frame;
    this.frontier = frame.height;
  }

  /** Rows currently stitched (excluding the held-back footer). */
  get height(): number {
    return this.rows;
  }

  private append(frame: PixelFrame, y0: number, y1: number): void {
    if (y1 <= y0) return;
    this.chunks.push(frame.px.slice(y0 * this.width, y1 * this.width));
    this.rows += y1 - y0;
  }

  private trim(n: number): void {
    const W = this.width;
    while (n > 0 && this.chunks.length) {
      const last = this.chunks[this.chunks.length - 1];
      const lastRows = last.length / W;
      if (lastRows <= n) {
        this.chunks.pop();
        this.rows -= lastRows;
        n -= lastRows;
      } else {
        this.chunks[this.chunks.length - 1] = last.subarray(0, (lastRows - n) * W);
        this.rows -= n;
        n = 0;
      }
    }
  }

  add(frame: PixelFrame, opts: ShiftOptions = {}): AddResult {
    const prev = this.prev;
    if (!prev) return { kind: 'lost' };
    const r = findVerticalShift(prev, frame, opts);
    if (r.kind !== 'shift') return { kind: r.kind };
    const H = this.frameHeight;
    const foot = H - r.bottom; // first footer row (same position in both frames)
    if (this.rows + r.shift + (H - foot) > this.maxRows) return { kind: 'full' };

    // Align the output end with this pair's footer boundary.
    if (this.frontier > foot) this.trim(this.frontier - foot);
    else if (this.frontier < foot) this.append(prev, this.frontier, foot);

    // New rows: those of the new frame that were below the old frame's body.
    const from = foot - r.shift;
    this.append(frame, from, foot);

    this.prev = frame;
    this.frontier = foot;
    return { kind: 'added', shift: r.shift, rows: r.shift, top: r.top, bottom: r.bottom };
  }

  /** The finished image (body + the final frame's footer band). */
  finish(): PixelFrame {
    const prev = this.prev as PixelFrame;
    const tail = this.frameHeight - this.frontier;
    const total = this.rows + tail;
    const px = new Uint32Array(total * this.width);
    let o = 0;
    for (const c of this.chunks) {
      px.set(c, o);
      o += c.length;
    }
    if (tail > 0) px.set(prev.px.subarray(this.frontier * this.width, this.frameHeight * this.width), o);
    return { width: this.width, height: total, px };
  }
}
