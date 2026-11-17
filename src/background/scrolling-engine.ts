import { CaptureTileProcessor } from '@/core/tiles';
import { ImageStitchingService } from '@/core/stitcher';
import { MAX_FRAMES, MAX_GROWTH_RETRIES } from '@/shared/constants';
import { SnapflowError } from '@/shared/errors';
import { resolveScale } from '@/shared/geometry';
import type { FullPagePrepareResult, FullPageScrollResult, FullPageTarget } from '@/shared/messages';
import { ScrollCoordinateManager } from '@/shared/scroll-coords';
import { DEFAULT_LIMITS, planOutputSize } from '@/shared/stitch';
import type { CaptureWarning, ScrollDirection, Size } from '@/shared/types';
import { agentCall, agentTry } from './agent';
import { grabVisibleTab } from './grab';

export interface ScrollCaptureOptions {
  tabId: number;
  windowId: number;
  target: FullPageTarget;
  direction: ScrollDirection;
  settleMs: number;
  isCancelled: () => boolean;
  onProgress?: (frame: number, total: number) => void;
}

export interface ScrollCaptureResult {
  blob: Blob;
  width: number;
  height: number;
  /** Image px per CSS px of the final image. */
  scale: number;
  viewport: Size;
  warnings: CaptureWarning[];
  frames: number;
}

const cancelled = () => new SnapflowError('CANCELLED', 'Capture cancelled.');

/**
 * ScrollingAreaCaptureEngine – drives one scrolling capture end to end:
 *
 *   prepare → ( scroll → settle → grab → crop to the window → stitch )* → finish → restore (always)
 *
 * The page side (PageDriver) scrolls the document, a container or a viewport-anchored region on one or
 * both axes; this side takes the screenshots, rate-limits them, and feeds tiles to the stitcher at their
 * *actual* scroll offsets. Vertical, horizontal and 2-D captures differ only in which axes advance.
 * The output is never silently truncated: size limits become explicit warnings.
 */
export class ScrollingAreaCaptureEngine {
  constructor(private readonly opts: ScrollCaptureOptions) {}

  async run(): Promise<ScrollCaptureResult> {
    const { tabId, windowId, settleMs } = this.opts;
    const prep = await agentCall<FullPagePrepareResult>(tabId, {
      type: 'AGENT_FP_PREPARE',
      target: this.opts.target,
      direction: this.opts.direction,
    });
    const warnings: CaptureWarning[] = [];

    try {
      for (const note of prep.notes) warnings.push({ code: 'nested-scroll', message: note });

      const scrollsX = prep.direction !== 'vertical' && prep.x.scrollable;
      const scrollsY = prep.direction !== 'horizontal' && prep.y.scrollable;
      if (!scrollsX && prep.horizontalOverflow && prep.kind !== 'region') {
        warnings.push({
          code: 'horizontal-overflow',
          message: 'The content is wider than the capture window; only the visible width was captured. Choose the Horizontal or Both direction to capture all of it.',
        });
      }

      const win0 = prep.region;
      const coords = new ScrollCoordinateManager(
        { scrollable: scrollsX, maxScroll: prep.x.maxScroll, windowLen: win0.width },
        { scrollable: scrollsY, maxScroll: prep.y.maxScroll, windowLen: win0.height },
      );

      let stitcher: ImageStitchingService | null = null;
      let tiles: CaptureTileProcessor | null = null;
      let scale = 1;
      let x = 0;
      let y = 0;
      let col = 0;
      let row = 0;
      let frameIdx = 0;
      let lastLeft = -1;
      let lastTop = -1;
      let growthRetries = 0;
      let warnedGrowth = false;
      let hitFrameCap = false;

      for (;;) {
        if (this.opts.isCancelled()) throw cancelled();

        this.opts.onProgress?.(frameIdx, coords.estimateFrames());
        const s = await agentCall<FullPageScrollResult>(tabId, {
          type: 'AGENT_FP_SCROLL',
          x,
          y,
          frame: frameIdx,
          totalFrames: coords.estimateFrames(),
          settleMs,
        });
        if (this.opts.isCancelled()) throw cancelled();

        if (s.viewport.width !== prep.viewport.width || s.viewport.height !== prep.viewport.height) {
          throw new SnapflowError('VIEWPORT_CHANGED', 'The window was resized or zoomed during capture. Please try again without changing the window.');
        }

        const { bitmap } = await grabVisibleTab(windowId, tabId);
        let discard = false;
        try {
          if (!stitcher || !tiles) {
            scale = resolveScale(bitmap.width, s.viewport.width, prep.dpr);
            // Output size per axis: what is scrolled spans maxScroll + window; the rest is just the window.
            const lenX = scrollsX ? s.maxScrollLeft + s.region.width : s.region.width;
            const lenY = scrollsY ? s.maxScrollTop + s.region.height : s.region.height;
            const plan = planOutputSize(Math.round(lenX * scale), Math.round(lenY * scale), DEFAULT_LIMITS);
            stitcher = new ImageStitchingService(plan);
            tiles = new CaptureTileProcessor(stitcher, scale, scrollsX, scrollsY);
            if (plan.downscaled && !plan.truncated) {
              warnings.push({
                code: 'downscaled',
                message: `The captured area is very large (${plan.fullWidth} × ${plan.fullHeight}px), so the screenshot was scaled to ${Math.round(plan.scale * 100)}% to fit browser limits.`,
              });
            }
            if (plan.truncated) {
              const parts: string[] = [];
              if (plan.truncatedY) parts.push(`only the first ${Math.round(plan.capturedFullHeight / scale)} of ${Math.round(plan.fullHeight / scale)} CSS pixels vertically`);
              if (plan.truncatedX) parts.push(`only the first ${Math.round(plan.capturedFullWidth / scale)} of ${Math.round(plan.fullWidth / scale)} CSS pixels horizontally`);
              warnings.push({
                code: 'truncated',
                message: `The area is too large to capture in one image: ${parts.join(' and ')} were captured${plan.scale < 1 ? ` (scaled to ${Math.round(plan.scale * 100)}%)` : ''}.`,
              });
            }
          }

          // The content grew after settling while we were at the bottom → this tile's "last frame"
          // treatment (footer shown) is wrong. Re-take it, bounded.
          if (scrollsY && s.atBottom) {
            const m = await agentCall<{ scrollHeight: number }>(tabId, { type: 'AGENT_FP_MEASURE' });
            if (m.scrollHeight > s.scrollHeight + 1 && growthRetries < MAX_GROWTH_RETRIES) {
              growthRetries++;
              coords.updateMaxScroll('y', s.maxScrollTop + (m.scrollHeight - s.scrollHeight));
              y = s.scrollTop;
              discard = true;
            }
          }

          if (!discard) {
            // Content got taller than planned (lazy content, infinite scroll).
            if (scrollsY) {
              const neededFull = Math.round((s.maxScrollTop + s.region.height) * scale);
              const plan = stitcher.currentPlan;
              if (neededFull > plan.fullHeight + 2) {
                const grew = stitcher.growY(neededFull, DEFAULT_LIMITS);
                if (!warnedGrowth) {
                  warnedGrowth = true;
                  warnings.push({
                    code: 'height-changed',
                    message: grew
                      ? 'The content grew while it was being captured (lazy-loaded content); the screenshot was extended to include it.'
                      : 'The content grew while it was being captured; anything beyond the original height is not included.',
                  });
                }
              }
              coords.updateMaxScroll('y', s.maxScrollTop);
            }
            tiles.addTile(bitmap, s.region, { left: s.scrollLeft, top: s.scrollTop }, col, row);
            frameIdx++;
          }
        } finally {
          bitmap.close();
        }
        if (discard) continue;
        if (!stitcher || !tiles) throw new SnapflowError('CAPTURE_FAILED', 'No frames were captured.');

        // Is this row finished? (a single column when the horizontal axis does not scroll)
        const rowDone =
          !scrollsX ||
          s.atRight ||
          (row === 0 ? stitcher.completeX : col + 1 >= tiles.columns) ||
          (col > 0 && s.scrollLeft <= lastLeft + 0.5); // cannot scroll any further

        // Everything covered? Checked before the frame cap so a capture that ends exactly at the cap is not flagged.
        if (rowDone && (!scrollsY || s.atBottom || stitcher.completeY)) break;
        if (frameIdx >= MAX_FRAMES) {
          hitFrameCap = true;
          break;
        }

        if (!rowDone) {
          // next column in this row
          lastLeft = s.scrollLeft;
          x = coords.nextPosition('x', s.scrollLeft);
          col++;
          continue;
        }

        // next row
        if (row > 0 && s.scrollTop <= lastTop + 0.5) break; // cannot scroll any further
        lastTop = s.scrollTop;
        y = coords.nextPosition('y', s.scrollTop);
        x = 0;
        col = 0;
        lastLeft = -1;
        row++;
      }

      if (!stitcher) throw new SnapflowError('CAPTURE_FAILED', 'No frames were captured.');
      const plan = stitcher.currentPlan;

      if (hitFrameCap) {
        warnings.push({
          code: 'frames',
          message: `The area is extremely large, so capture stopped after ${MAX_FRAMES} screens. The rest is not included.`,
        });
      } else if (
        (scrollsY && !stitcher.completeY && stitcher.coveredHeight < plan.capturedFullHeight - 3) ||
        (scrollsX && !stitcher.completeX && stitcher.coveredWidth < plan.capturedFullWidth - 3)
      ) {
        warnings.push({
          code: 'truncated',
          message: 'Capture ended before the end of the scrollable area was reached; part of it may be missing.',
        });
      }

      const blob = await stitcher.finish();
      return {
        blob,
        width: plan.outWidth,
        height: plan.outHeight,
        scale: scale * plan.scale,
        viewport: prep.viewport,
        warnings,
        frames: stitcher.frames,
      };
    } finally {
      // Restore scroll position, un-hide fixed elements, remove injected styles – success, error or cancel.
      await agentTry(tabId, { type: 'AGENT_FP_RESTORE' });
    }
  }
}

export function captureScrolling(opts: ScrollCaptureOptions): Promise<ScrollCaptureResult> {
  return new ScrollingAreaCaptureEngine(opts).run();
}
