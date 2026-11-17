import { SnapflowError } from '@/shared/errors';
import { cssRectToImageRect } from '@/shared/geometry';
import type { Rect } from '@/shared/types';
import type { AxisSegment, ImageStitchingService } from './stitcher';

/**
 * CaptureTileProcessor – turns one screenshot of the viewport into a tile of the stitched image.
 *
 * It (1) crops the screenshot to the capture window, (2) asks the stitcher which columns/rows of this
 * tile are new, and (3) draws them. In a 2-D capture the column layout is decided on the first row and
 * reused for every following row (same horizontal scroll positions), the row layout once per row.
 */
export class CaptureTileProcessor {
  private xSegs: AxisSegment[] = [];
  private ySeg: AxisSegment | null = null;
  private firstSize: { width: number; height: number } | null = null;

  constructor(
    private readonly stitcher: ImageStitchingService,
    private readonly scale: number,
    private readonly scrollsX: boolean,
    private readonly scrollsY: boolean,
  ) {}

  /** Number of columns laid out so far (known once the first row is complete). */
  get columns(): number {
    return this.xSegs.length;
  }

  /** The capture window in image pixels for this screenshot. */
  windowPx(bitmap: ImageBitmap, win: Rect): Rect {
    const px = cssRectToImageRect(win, { x: this.scale, y: this.scale }, bitmap);
    if (!px) throw new SnapflowError('CAPTURE_FAILED', 'The capture area is outside the screenshot.');
    return px;
  }

  addTile(bitmap: ImageBitmap, win: Rect, pos: { left: number; top: number }, col: number, row: number): void {
    const px = this.windowPx(bitmap, win);
    if (!this.firstSize) this.firstSize = { width: px.width, height: px.height };
    else if (Math.abs(px.width - this.firstSize.width) > 2 || Math.abs(px.height - this.firstSize.height) > 2) {
      throw new SnapflowError('VIEWPORT_CHANGED', 'The page layout changed size during capture. Please try again without resizing the window.');
    }
    const region: Rect = { ...px, width: Math.min(px.width, this.firstSize.width), height: Math.min(px.height, this.firstSize.height) };

    let xSeg: AxisSegment | null = null;
    if (this.scrollsX) {
      if (row === 0) {
        xSeg = this.stitcher.placeX(pos.left, region.width, this.scale);
        this.xSegs[col] = xSeg;
      } else {
        xSeg = this.xSegs[col] ?? null;
        if (!xSeg) throw new SnapflowError('VIEWPORT_CHANGED', 'The page layout changed while capturing. Please try again.');
      }
    }

    if (this.scrollsY) {
      if (col === 0) this.ySeg = this.stitcher.placeY(pos.top, region.height, this.scale);
      if (!this.ySeg) throw new SnapflowError('CAPTURE_FAILED', 'Internal error: row layout missing.');
    }

    this.stitcher.draw(bitmap, region, xSeg, this.scrollsY ? this.ySeg : null);
  }
}
