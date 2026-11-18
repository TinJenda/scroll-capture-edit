import type { Rect, Size } from './types';

export function rectFromPoints(ax: number, ay: number, bx: number, by: number): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Intersection of two rects, or null when they do not overlap. */
export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Clamp a rect into [0,0,bounds.width,bounds.height]. Returns null when nothing remains. */
export function clampRect(rect: Rect, bounds: Size): Rect | null {
  return intersectRect(rect, { x: 0, y: 0, width: bounds.width, height: bounds.height });
}

export interface AxisScale {
  x: number;
  y: number;
}

/**
 * Image pixels per CSS pixel, derived from the *actual* captured bitmap rather than
 * window.devicePixelRatio. This stays correct under browser zoom, OS scaling and
 * fractional DPRs, where the two can disagree by a rounding step.
 */
export function getCaptureScale(image: Size, viewport: Size): AxisScale {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 1, y: 1 };
  return { x: image.width / viewport.width, y: image.height / viewport.height };
}

/**
 * Image pixels per CSS pixel for a capture.
 *
 * window.innerWidth is rounded to an integer, so image/innerWidth is off by up to ~0.1% at fractional
 * zoom levels (e.g. 1.5003 instead of 1.5) – which drifts by a whole pixel after ~1500px of scrolling.
 * devicePixelRatio (which already includes browser zoom) is exact, so it wins whenever it agrees
 * with the captured bitmap; the measured ratio is only the fallback.
 */
export function resolveScale(imageWidth: number, viewportWidth: number, dpr: number): number {
  const ratio = viewportWidth > 0 ? imageWidth / viewportWidth : 1;
  if (dpr > 0 && viewportWidth > 0 && Math.abs(imageWidth - dpr * viewportWidth) <= dpr + 1) return dpr;
  return ratio;
}

/**
 * Convert a CSS-pixel rectangle (viewport coordinates) into integer image pixels.
 * Edges are rounded independently so adjacent regions never drift apart, then the
 * result is clamped to the image and guaranteed to be at least 1px in each axis.
 */
export function cssRectToImageRect(rect: Rect, scale: AxisScale, image: Size): Rect | null {
  const left = Math.round(rect.x * scale.x);
  const top = Math.round(rect.y * scale.y);
  const right = Math.round((rect.x + rect.width) * scale.x);
  const bottom = Math.round((rect.y + rect.height) * scale.y);
  const x1 = clamp(left, 0, image.width);
  const y1 = clamp(top, 0, image.height);
  const x2 = clamp(Math.max(right, left + 1), 0, image.width);
  const y2 = clamp(Math.max(bottom, top + 1), 0, image.height);
  if (x2 - x1 < 1 || y2 - y1 < 1) return null;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/**
 * Clamp a selection to `bounds` and snap edges that are within `tol` px of a bound onto it (a drag that stops
 * 3px short of a container's edge should still mean "the whole width"). Only the axes flagged in `axes`
 * are narrowed; the other axes always span the full bounds.
 */
export function snapSelection(
  sel: Rect,
  bounds: Rect,
  axes: { x: boolean; y: boolean },
  tol = 12,
): Rect {
  const snap = (lo: number, hi: number, min: number, max: number): [number, number] => {
    const a = Math.max(min, Math.min(lo, hi));
    const b = Math.min(max, Math.max(lo, hi));
    if (b - a < 20) return [min, max]; // degenerate → no narrowing
    return [a - min <= tol ? min : a, max - b <= tol ? max : b];
  };
  const [x0, x1] = axes.x ? snap(sel.x, sel.x + sel.width, bounds.x, bounds.x + bounds.width) : [bounds.x, bounds.x + bounds.width];
  const [y0, y1] = axes.y ? snap(sel.y, sel.y + sel.height, bounds.y, bounds.y + bounds.height) : [bounds.y, bounds.y + bounds.height];
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Rounds a size to integers, never below 1. */
export function roundSize(width: number, height: number): Size {
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}
