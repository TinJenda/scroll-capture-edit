import { Stitcher } from '@/core/stitcher';
import { FRAME_OVERLAP_CSS, MAX_FRAMES, MAX_GROWTH_RETRIES } from '@/shared/constants';
import { SnapflowError } from '@/shared/errors';
import { cssRectToImageRect, resolveScale } from '@/shared/geometry';
import type { FullPagePrepareResult, FullPageScrollResult, FullPageTarget } from '@/shared/messages';
import { estimateFrameCount } from '@/shared/scroll';
import { DEFAULT_LIMITS, planOutputSize } from '@/shared/stitch';
import type { CaptureWarning, Rect, Size } from '@/shared/types';
import { agentCall, agentTry } from './agent';
import { grabVisibleTab } from './grab';

export interface FullPageOptions {
  tabId: number;
  windowId: number;
  target: FullPageTarget;
  settleMs: number;
  isCancelled: () => boolean;
  onProgress?: (frame: number, total: number) => void;
}

export interface FullPageResult {
  blob: Blob;
  width: number;
  height: number;
  scale: number;
  viewport: Size;
  warnings: CaptureWarning[];
  frames: number;
}

const cancelled = () => new SnapflowError('CANCELLED', 'Capture cancelled.');

/**
 * Full-page scrolling capture:
 *   prepare → (scroll → settle → grab → stitch)* → finish → restore (always).
 *
 * The stitcher is streaming, frames are positioned by their *actual* scroll offsets
 * (so fractional positions, scroll clamping and the overlapping last frame are exact),
 * and the output is never silently truncated: size limits turn into explicit warnings.
 */
export async function captureFullPage(opts: FullPageOptions): Promise<FullPageResult> {
  const { tabId, windowId } = opts;
  const prep = await agentCall<FullPagePrepareResult>(tabId, { type: 'AGENT_FP_PREPARE', target: opts.target });
  const warnings: CaptureWarning[] = [];

  try {
    for (const note of prep.notes) warnings.push({ code: 'nested-scroll', message: note });
    if (prep.horizontalOverflow) {
      warnings.push({
        code: 'horizontal-overflow',
        message: 'The page is wider than the window; only the visible width was captured.',
      });
    }

    let stitcher: Stitcher | null = null;
    let scale = 1;
    let frameWidthPx = 0;
    let knownHeight = prep.scrollHeight;
    let y = 0;
    let frameIdx = 0;
    let lastTop = -1;
    let growthRetries = 0;
    let warnedGrowth = false;
    let hitFrameCap = false;

    for (;;) {
      if (opts.isCancelled()) throw cancelled();

      const total = estimateFrameCount(knownHeight, prep.region.height);
      opts.onProgress?.(frameIdx, total);
      const s = await agentCall<FullPageScrollResult>(tabId, {
        type: 'AGENT_FP_SCROLL',
        y,
        frame: frameIdx,
        totalFrames: total,
        settleMs: opts.settleMs,
      });
      if (opts.isCancelled()) throw cancelled();

      if (s.viewport.width !== prep.viewport.width || s.viewport.height !== prep.viewport.height) {
        throw new SnapflowError('VIEWPORT_CHANGED', 'The window was resized or zoomed during capture. Please try again without changing the window.');
      }

      const { bitmap } = await grabVisibleTab(windowId, tabId);
      let discard = false;
      try {
        if (!stitcher) {
          scale = resolveScale(bitmap.width, s.viewport.width, prep.dpr);
          const plan = planOutputSize(Math.round(s.region.width * scale), Math.round(s.scrollHeight * scale), DEFAULT_LIMITS);
          stitcher = new Stitcher(plan);
          frameWidthPx = Math.round(s.region.width * scale);
          if (plan.downscaled) {
            warnings.push({
              code: 'downscaled',
              message: `The page is very large (${plan.fullWidth} × ${plan.fullHeight}px), so the screenshot was scaled to ${Math.round(plan.scale * 100)}% to fit browser limits.`,
            });
          }
          if (plan.truncated) {
            warnings.push({
              code: 'truncated',
              message: `The page is too tall to capture in one image: only the top ${Math.round(plan.capturedFullHeight / scale)} of ${Math.round(plan.fullHeight / scale)} CSS pixels were captured.`,
            });
          }
        }

        // The page grew after settling while we were at the bottom → this frame's "last frame"
        // treatment (footer shown) is wrong. Re-take it, bounded.
        if (s.atBottom) {
          const m = await agentCall<{ scrollHeight: number; scrollTop: number }>(tabId, { type: 'AGENT_FP_MEASURE' });
          if (m.scrollHeight > s.scrollHeight + 1 && growthRetries < MAX_GROWTH_RETRIES) {
            growthRetries++;
            knownHeight = m.scrollHeight;
            y = s.scrollTop;
            discard = true;
          }
        }

        if (!discard) {
          const px = cssRectToImageRect(s.region, { x: scale, y: scale }, bitmap);
          if (!px) throw new SnapflowError('CAPTURE_FAILED', 'The capture area is outside the screenshot.');
          if (Math.abs(px.width - frameWidthPx) > 2) {
            throw new SnapflowError('VIEWPORT_CHANGED', 'The page layout changed width during capture. Please try again.');
          }
          const normalized: Rect = { ...px, width: Math.min(px.width, frameWidthPx) };

          // Page got taller than planned (lazy content, infinite scroll).
          const neededFull = Math.round(s.scrollHeight * scale);
          const plan = stitcher.currentPlan;
          if (neededFull > plan.fullHeight + 2) {
            const grew = stitcher.grow(neededFull, DEFAULT_LIMITS);
            if (!warnedGrowth) {
              warnedGrowth = true;
              warnings.push({
                code: 'height-changed',
                message: grew
                  ? 'The page grew while it was being captured (lazy-loaded content); the screenshot was extended to include it.'
                  : 'The page grew while it was being captured; content beyond the original height is not included.',
              });
            }
          }
          knownHeight = Math.max(knownHeight, s.scrollHeight);
          stitcher.addFrame(bitmap, s.scrollTop, normalized, scale);
          frameIdx++;
        }
      } finally {
        bitmap.close();
      }
      if (discard) continue;

      if (s.atBottom || stitcher.complete) break;
      if (frameIdx > 1 && s.scrollTop <= lastTop + 0.5) break; // cannot scroll any further
      if (frameIdx >= MAX_FRAMES) {
        hitFrameCap = true;
        break;
      }
      lastTop = s.scrollTop;
      // Advance slightly less than a full viewport: the 2px overlap guarantees rounding at fractional
      // zoom / DPR can never leave a one-pixel hairline between frames (the stitcher drops the overlap).
      y = s.scrollTop + Math.max(1, s.region.height - FRAME_OVERLAP_CSS);
    }

    if (!stitcher) throw new SnapflowError('CAPTURE_FAILED', 'No frames were captured.');
    const plan = stitcher.currentPlan;

    if (hitFrameCap) {
      warnings.push({
        code: 'frames',
        message: `The page is extremely long, so capture stopped after ${MAX_FRAMES} screens. The rest is not included.`,
      });
    } else if (!stitcher.complete && stitcher.covered < plan.capturedFullHeight - 3) {
      warnings.push({
        code: 'truncated',
        message: 'Capture ended before the bottom of the page was reached; the lower part may be missing.',
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
