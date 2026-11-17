import {
  MAX_CANVAS_AREA,
  MAX_CANVAS_DIMENSION,
  MIN_OUTPUT_SCALE,
  STITCH_TOLERANCE_PX,
} from './constants';
import { SnapflowError } from './errors';

/** A horizontal strip of one captured frame to copy into the final image (full-resolution pixels). */
export interface StitchSegment {
  /** First row to read from the frame (relative to the frame/region top). */
  srcY: number;
  /** First row to write in the final (full-resolution) image. */
  destY: number;
  height: number;
}

export interface PlaceResult {
  segment: StitchSegment | null;
  /** Rows between the previous coverage and this frame that nobody covered (0 when seamless). */
  gap: number;
  /** New coverage edge (exclusive) after this frame. */
  coveredUntil: number;
}

/**
 * Decide which rows of a new frame are *new* content.
 *
 * Frames are positioned by their actual scroll offset (so fractional scroll
 * positions and clamped final steps are handled), but only rows beyond what is
 * already covered are copied. That removes the overlap of the last viewport and
 * makes the stitch independent of draw order.
 */
export function placeFrame(opts: {
  scrollY: number; // CSS px, actual scroll offset of the frame
  scale: number; // image px per CSS px
  frameHeight: number; // px height of the frame (capture region)
  outHeight: number; // px height of the full-resolution output
  coveredUntil: number; // px, exclusive
}): PlaceResult {
  const { scale, frameHeight, outHeight, coveredUntil } = opts;
  let destTop = Math.max(0, Math.round(opts.scrollY * scale));
  let end = destTop + frameHeight;

  // Rounding: a final frame that overshoots the output by a pixel or two is shifted back.
  if (end > outHeight && end - outHeight <= STITCH_TOLERANCE_PX && destTop > 0) {
    destTop -= end - outHeight;
    end = outHeight;
  }
  end = Math.min(end, outHeight);

  let gap = 0;
  let from = Math.max(destTop, coveredUntil);
  if (destTop > coveredUntil) {
    gap = destTop - coveredUntil;
    if (gap <= STITCH_TOLERANCE_PX) {
      // Pure rounding: close the hairline by shifting this frame up by `gap` px.
      from = coveredUntil;
      destTop = coveredUntil;
      end = Math.min(destTop + frameHeight, outHeight); // the shifted frame ends earlier: never read past it
      gap = 0;
    }
  }

  if (end <= from) return { segment: null, gap, coveredUntil };
  return {
    segment: { srcY: from - destTop, destY: from, height: end - from },
    gap,
    coveredUntil: end,
  };
}

export interface FramePlan {
  scrollY: number;
  frameHeight: number;
}

/** Plan a whole sequence at once (used by tests and for coverage validation). */
export function planStitch(frames: FramePlan[], scale: number, outHeight: number) {
  let covered = 0;
  let maxGap = 0;
  const segments: (StitchSegment | null)[] = [];
  for (const f of frames) {
    const r = placeFrame({ scrollY: f.scrollY, scale, frameHeight: f.frameHeight, outHeight, coveredUntil: covered });
    segments.push(r.segment);
    covered = r.coveredUntil;
    maxGap = Math.max(maxGap, r.gap);
  }
  return { segments, covered, maxGap, complete: covered >= outHeight && maxGap === 0 };
}

export interface OutputLimits {
  maxDimension: number;
  maxArea: number;
  minScale: number;
}

export const DEFAULT_LIMITS: OutputLimits = {
  maxDimension: MAX_CANVAS_DIMENSION,
  maxArea: MAX_CANVAS_AREA,
  minScale: MIN_OUTPUT_SCALE,
};

export interface OutputPlan {
  /** Full-resolution size of the captured region. */
  fullWidth: number;
  fullHeight: number;
  /** Scale applied to produce the output (1 = native resolution). */
  scale: number;
  outWidth: number;
  outHeight: number;
  downscaled: boolean;
  /** True when the region is larger than what can be produced at a readable scale. */
  truncated: boolean;
  truncatedX: boolean;
  truncatedY: boolean;
  /** Full-resolution columns / rows that will actually be captured (== full size unless truncated). */
  capturedFullWidth: number;
  capturedFullHeight: number;
}

/**
 * Decide how large the stitched image may be. Never silently truncates:
 *  1. Fits at native resolution → as is.
 *  2. Fits at ≥ minScale → uniformly downscaled (flag `downscaled`).
 *  3. Otherwise → captured up to what fits at minScale (flags `truncated`, `truncatedX` / `truncatedY`).
 * The caller turns the flags into user-visible warnings. Works for vertical, horizontal and 2-D captures.
 */
export function planOutputSize(
  fullWidth: number,
  fullHeight: number,
  limits: OutputLimits = DEFAULT_LIMITS,
): OutputPlan {
  if (fullWidth < 1 || fullHeight < 1) {
    throw new SnapflowError('CAPTURE_FAILED', 'The capture area has no measurable size.');
  }

  const fit = Math.min(
    1,
    limits.maxDimension / fullWidth,
    limits.maxDimension / fullHeight,
    Math.sqrt(limits.maxArea / (fullWidth * fullHeight)),
  );

  if (fit >= 1) {
    return {
      fullWidth,
      fullHeight,
      scale: 1,
      outWidth: fullWidth,
      outHeight: fullHeight,
      downscaled: false,
      truncated: false,
      truncatedX: false,
      truncatedY: false,
      capturedFullWidth: fullWidth,
      capturedFullHeight: fullHeight,
    };
  }

  if (fit >= limits.minScale) {
    return {
      fullWidth,
      fullHeight,
      scale: fit,
      outWidth: Math.max(1, Math.floor(fullWidth * fit)),
      outHeight: Math.max(1, Math.floor(fullHeight * fit)),
      downscaled: true,
      truncated: false,
      truncatedX: false,
      truncatedY: false,
      capturedFullWidth: fullWidth,
      capturedFullHeight: fullHeight,
    };
  }

  // Readable-scale floor reached: keep minScale and cut the dimension(s) that do not fit, loudly.
  const scale = limits.minScale;
  const wantW = Math.max(1, Math.floor(fullWidth * scale));
  const wantH = Math.max(1, Math.floor(fullHeight * scale));
  let outWidth = Math.min(wantW, limits.maxDimension);
  let outHeight = Math.min(wantH, limits.maxDimension);
  if (outWidth * outHeight > limits.maxArea) {
    if (outHeight >= outWidth) outHeight = Math.max(1, Math.floor(limits.maxArea / outWidth));
    else outWidth = Math.max(1, Math.floor(limits.maxArea / outHeight));
  }
  const truncatedX = outWidth < wantW;
  const truncatedY = outHeight < wantH;
  return {
    fullWidth,
    fullHeight,
    scale,
    outWidth,
    outHeight,
    downscaled: true,
    truncated: truncatedX || truncatedY,
    truncatedX,
    truncatedY,
    capturedFullWidth: truncatedX ? Math.min(fullWidth, Math.ceil(outWidth / scale)) : fullWidth,
    capturedFullHeight: truncatedY ? Math.min(fullHeight, Math.ceil(outHeight / scale)) : fullHeight,
  };
}
