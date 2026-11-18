import { SnapflowError } from '@/shared/errors';
import { placeFrame, type OutputPlan } from '@/shared/stitch';
import type { Rect } from '@/shared/types';
import { canvasToBlob, createCanvas, get2d, type Ctx2D } from './image';

/** A run of rows (or columns) of one frame, and where it lands in the output (full-resolution px). */
export interface AxisSegment {
  src: number;
  dest: number;
  len: number;
}

const GAP_MESSAGE =
  'The content moved unexpectedly while scrolling (scroll-snapping or a layout shift), so the capture would have a gap. Try again, or capture a visible area instead.';

/**
 * ImageStitchingService – streaming, axis-independent stitcher.
 *
 * Every captured tile is drawn into the output canvas immediately and then released, so memory stays at
 * "one output canvas + one frame" no matter how large the scrolled area is. Placement works per axis:
 * `placeX` / `placeY` decide which rows/columns of a tile are *new* (removing overlap exactly, using the
 * tile's actual scroll offset), and `draw` copies the product of the two segments. Vertical, horizontal and
 * 2-D (tile grid) captures are all the same operation with an axis that does or does not scroll.
 */
export class ImageStitchingService {
  private canvas: OffscreenCanvas;
  private ctx: Ctx2D;
  private plan: OutputPlan;
  private coveredX = 0;
  private coveredY = 0;
  frames = 0;

  constructor(plan: OutputPlan) {
    this.plan = plan;
    this.canvas = createCanvas(plan.outWidth, plan.outHeight);
    this.ctx = get2d(this.canvas);
    this.ctx.imageSmoothingQuality = 'high';
  }

  get currentPlan(): OutputPlan {
    return this.plan;
  }

  /** Full-resolution columns / rows stitched so far. */
  get coveredWidth(): number {
    return this.coveredX;
  }
  get coveredHeight(): number {
    return this.coveredY;
  }

  get completeX(): boolean {
    return this.coveredX >= this.plan.capturedFullWidth;
  }
  get completeY(): boolean {
    return this.coveredY >= this.plan.capturedFullHeight;
  }

  private place(axis: 'x' | 'y', scroll: number, frameLen: number, scale: number): AxisSegment {
    const covered = axis === 'x' ? this.coveredX : this.coveredY;
    const outLen = axis === 'x' ? this.plan.capturedFullWidth : this.plan.capturedFullHeight;
    const r = placeFrame({ scrollY: scroll, scale, frameHeight: frameLen, outHeight: outLen, coveredUntil: covered });
    if (r.gap > 0) throw new SnapflowError('STITCH_GAP', GAP_MESSAGE);
    if (axis === 'x') this.coveredX = r.coveredUntil;
    else this.coveredY = r.coveredUntil;
    return r.segment
      ? { src: r.segment.srcY, dest: r.segment.destY, len: r.segment.height }
      : { src: 0, dest: covered, len: 0 };
  }

  /** New columns of a tile captured at horizontal scroll `scrollX` (CSS px). */
  placeX(scrollX: number, frameWidthPx: number, imageScale: number): AxisSegment {
    return this.place('x', scrollX, frameWidthPx, imageScale);
  }

  /** New rows of a tile captured at vertical scroll `scrollY` (CSS px). */
  placeY(scrollY: number, frameHeightPx: number, imageScale: number): AxisSegment {
    return this.place('y', scrollY, frameHeightPx, imageScale);
  }

  /**
   * Copy a tile into the output.
   * @param region window inside the frame bitmap (px)
   * @param xSeg   columns to copy (null = the whole window width, axis does not scroll)
   * @param ySeg   rows to copy (null = the whole window height)
   */
  draw(frame: ImageBitmap, region: Rect, xSeg: AxisSegment | null, ySeg: AxisSegment | null): void {
    this.frames += 1;
    const k = this.plan.scale;
    const sx = region.x + (xSeg?.src ?? 0);
    const sw = xSeg ? xSeg.len : region.width;
    const sy = region.y + (ySeg?.src ?? 0);
    const sh = ySeg ? ySeg.len : region.height;
    const dx0 = xSeg ? Math.round(xSeg.dest * k) : 0;
    const dx1 = xSeg ? Math.min(this.canvas.width, Math.round((xSeg.dest + xSeg.len) * k)) : this.canvas.width;
    const dy0 = ySeg ? Math.round(ySeg.dest * k) : 0;
    const dy1 = ySeg ? Math.min(this.canvas.height, Math.round((ySeg.dest + ySeg.len) * k)) : this.canvas.height;
    if (sw <= 0 || sh <= 0 || dx1 <= dx0 || dy1 <= dy0) return;
    this.ctx.drawImage(frame, sx, sy, sw, sh, dx0, dy0, dx1 - dx0, dy1 - dy0);
  }

  /**
   * Allow the output to grow taller (the scrolled content got longer while capturing). Only possible at
   * native scale; otherwise the caller keeps the original plan and reports a warning.
   */
  growY(newFullHeight: number, limits: { maxDimension: number; maxArea: number }): boolean {
    const p = this.plan;
    if (p.scale !== 1 || p.truncatedY) return false;
    if (newFullHeight <= p.outHeight) return true;
    if (newFullHeight > limits.maxDimension || newFullHeight * p.outWidth > limits.maxArea) return false;
    const next = createCanvas(p.outWidth, newFullHeight);
    const nextCtx = get2d(next);
    nextCtx.drawImage(this.canvas, 0, 0);
    this.canvas = next;
    this.ctx = nextCtx;
    this.plan = { ...p, fullHeight: newFullHeight, outHeight: newFullHeight, capturedFullHeight: newFullHeight };
    return true;
  }

  /**
   * Encode the result. With `extent` (full-resolution px) only the top-left part is kept – used when the
   * capture was stopped early so the image contains exactly what was captured, not blank space.
   */
  async finish(extent?: { width: number; height: number }): Promise<{ blob: Blob; width: number; height: number }> {
    const k = this.plan.scale;
    const w = extent ? Math.max(1, Math.min(this.canvas.width, Math.round(extent.width * k))) : this.canvas.width;
    const h = extent ? Math.max(1, Math.min(this.canvas.height, Math.round(extent.height * k))) : this.canvas.height;
    if (w === this.canvas.width && h === this.canvas.height) {
      return { blob: await canvasToBlob(this.canvas, 'png'), width: w, height: h };
    }
    const out = createCanvas(w, h);
    get2d(out).drawImage(this.canvas, 0, 0, w, h, 0, 0, w, h);
    return { blob: await canvasToBlob(out, 'png'), width: w, height: h };
  }
}
