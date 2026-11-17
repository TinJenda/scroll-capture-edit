import { SnapflowError } from '@/shared/errors';
import { placeFrame, type OutputPlan } from '@/shared/stitch';
import type { Rect } from '@/shared/types';
import { canvasToBlob, createCanvas, get2d, type Ctx2D } from './image';

/**
 * Streaming stitcher: every captured viewport frame is drawn into the output
 * canvas immediately and then released, so memory stays at
 * "one output canvas + one frame" no matter how long the page is.
 */
export class Stitcher {
  private canvas: OffscreenCanvas;
  private ctx: Ctx2D;
  private coveredUntil = 0; // full-resolution px
  private plan: OutputPlan;
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

  /** Full-resolution rows stitched so far. */
  get covered(): number {
    return this.coveredUntil;
  }

  /**
   * Allow the output to grow (page got taller while capturing). Only possible at native
   * scale; otherwise the caller keeps the original plan and reports a warning.
   */
  grow(newFullHeight: number, limits: { maxDimension: number; maxArea: number }): boolean {
    const p = this.plan;
    if (p.scale !== 1 || p.truncated) return false;
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
   * @param frame     full viewport bitmap from captureVisibleTab
   * @param scrollY   actual scroll offset of the scroller for this frame (CSS px)
   * @param region    capture region inside the bitmap (px) – excludes scrollbars / is the element box
   * @param imageScale image px per CSS px for this capture
   */
  addFrame(frame: ImageBitmap, scrollY: number, region: Rect, imageScale: number): void {
    // Positions are computed in full-resolution space, then mapped to the (possibly scaled) output.
    const placed = placeFrame({
      scrollY,
      scale: imageScale,
      frameHeight: region.height,
      outHeight: this.plan.capturedFullHeight,
      coveredUntil: this.coveredUntil,
    });
    if (placed.gap > 0) {
      throw new SnapflowError(
        'STITCH_GAP',
        'The page moved unexpectedly while scrolling (scroll-snapping or a layout shift), so the capture would have a gap. Try again, or capture a visible area instead.',
      );
    }
    this.frames += 1;
    const seg = placed.segment;
    this.coveredUntil = placed.coveredUntil;
    if (!seg) return;

    const k = this.plan.scale;
    const dy0 = Math.round(seg.destY * k);
    const dy1 = Math.min(this.canvas.height, Math.round((seg.destY + seg.height) * k));
    if (dy1 <= dy0) return;
    this.ctx.drawImage(
      frame,
      region.x,
      region.y + seg.srcY,
      region.width,
      seg.height,
      0,
      dy0,
      this.canvas.width,
      dy1 - dy0,
    );
  }

  /** True once the whole planned height has been covered. */
  get complete(): boolean {
    return this.coveredUntil >= this.plan.capturedFullHeight;
  }

  async finish(): Promise<Blob> {
    return canvasToBlob(this.canvas, 'png');
  }
}
