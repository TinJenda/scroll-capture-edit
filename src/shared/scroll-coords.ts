import { FRAME_OVERLAP_CSS } from './constants';
import type { ScrollDirection } from './types';

/**
 * ScrollCoordinateManager – the pure arithmetic of a scrolling capture, shared by the engine and the tests.
 *
 * Model (per axis, CSS px): the *capture window* has a fixed size `windowLen` and stays anchored to the
 * viewport (or to the scroll container's client box). Frame k shows scroller content
 * `[scroll_k + windowOffset, scroll_k + windowOffset + windowLen)`. If the first frame is taken at
 * scroll 0 and the last at `maxScroll`, the stitched output spans
 *
 *     outputLength = maxScroll + windowLen
 *
 * and frame k is placed at output offset `scroll_k` – independent of where the window sits in the
 * viewport. That one formula covers full-page, container and manual-region captures.
 */
export interface AxisSpec {
  /** Whether this axis is scrolled at all. */
  scrollable: boolean;
  /** scrollLen - clientLen of the scroller. */
  maxScroll: number;
  /** Length of the capture window along this axis. */
  windowLen: number;
}

export type Axis = 'x' | 'y';

/** Which axes a direction follows, given what the target can actually scroll. */
export function resolveAxes(
  direction: ScrollDirection,
  can: { x: boolean; y: boolean },
): { x: boolean; y: boolean; direction: ScrollDirection } {
  const x = direction !== 'vertical' && can.x;
  const y = direction !== 'horizontal' && can.y;
  const resolved: ScrollDirection = x && y ? 'both' : x ? 'horizontal' : 'vertical';
  return { x, y, direction: resolved };
}

/** Number of frames needed to cross `maxScroll` with a window of `windowLen`, advancing by (windowLen − overlap). */
export function axisFrameCount(maxScroll: number, windowLen: number, overlap = FRAME_OVERLAP_CSS): number {
  if (maxScroll <= 0) return 1;
  const step = Math.max(1, windowLen - overlap);
  return Math.ceil(maxScroll / step) + 1;
}

export interface PartialState {
  scrollsX: boolean;
  scrollsY: boolean;
  /** Full-resolution columns / rows covered so far. */
  coveredX: number;
  coveredY: number;
  /** coveredY at the moment the current row started (2-D captures). */
  rowStartCovered: number;
  /** Row and column index of the last tile that was drawn, and how many columns a row has. */
  row: number;
  col: number;
  columns: number;
  /** The full planned output size, used for axes that are not scrolled. */
  fullWidth: number;
  fullHeight: number;
}

/**
 * Size (full-resolution px) of the part of the stitched image that is complete when a capture is
 * stopped early. A half-finished row of a 2-D grid is left out, so the result is always a clean rectangle.
 */
export function partialExtent(s: PartialState): { width: number; height: number } {
  const width = s.scrollsX ? s.coveredX : s.fullWidth;
  let height = s.scrollsY ? s.coveredY : s.fullHeight;
  const rowComplete = !s.scrollsX || s.col + 1 >= s.columns;
  if (s.scrollsX && s.scrollsY && s.row > 0 && !rowComplete) height = s.rowStartCovered;
  return { width: Math.max(1, Math.min(width, s.fullWidth)), height: Math.max(1, Math.min(height, s.fullHeight)) };
}

export class ScrollCoordinateManager {
  constructor(
    private x: AxisSpec,
    private y: AxisSpec,
    readonly overlap: number = FRAME_OVERLAP_CSS,
  ) {}

  private axis(a: Axis): AxisSpec {
    return a === 'x' ? this.x : this.y;
  }

  scrolls(a: Axis): boolean {
    return this.axis(a).scrollable;
  }

  /** Length of the stitched output along an axis (CSS px). */
  outputLength(a: Axis): number {
    const s = this.axis(a);
    return s.scrollable ? s.maxScroll + s.windowLen : s.windowLen;
  }

  /** Where to scroll after a frame captured at `lastScroll`: one window further, minus the safety overlap. */
  nextPosition(a: Axis, lastScroll: number): number {
    return lastScroll + Math.max(1, this.axis(a).windowLen - this.overlap);
  }

  /** The page grew (lazy content): update the scrollable range. */
  updateMaxScroll(a: Axis, maxScroll: number): void {
    this.axis(a).maxScroll = Math.max(this.axis(a).maxScroll, maxScroll);
  }

  framesAlong(a: Axis): number {
    const s = this.axis(a);
    return s.scrollable ? axisFrameCount(s.maxScroll, s.windowLen, this.overlap) : 1;
  }

  /** Total tiles (columns × rows) – used for progress and the frame cap. */
  estimateFrames(): number {
    return this.framesAlong('x') * this.framesAlong('y');
  }
}
