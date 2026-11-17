/**
 * Pure helpers for the full-page scroll engine. They contain no DOM or Chrome
 * access so they can be unit-tested exhaustively.
 */

/**
 * Static scroll plan: viewport-sized steps from the top, with the last step
 * pulled back so the final frame ends exactly at the bottom of the page
 * (the last frame therefore overlaps the one before it).
 */
export function planScrollPositions(totalHeight: number, viewportHeight: number): number[] {
  if (viewportHeight <= 0) return [0];
  const maxScroll = Math.max(0, totalHeight - viewportHeight);
  const positions: number[] = [];
  for (let y = 0; y < maxScroll; y += viewportHeight) positions.push(y);
  // A final step within half a pixel of the previous one would only re-capture the same frame.
  if (positions.length === 0 || maxScroll - positions[positions.length - 1] > 0.5) positions.push(maxScroll);
  return positions;
}

/** Number of frames a page of the given height needs. */
export function estimateFrameCount(totalHeight: number, viewportHeight: number): number {
  return planScrollPositions(totalHeight, viewportHeight).length;
}

/**
 * Where to scroll next, given the scroll position of the frame just captured.
 * The browser clamps scrolling to the maximum, so asking for "one more viewport"
 * on the last step simply lands at the bottom (producing the overlap the
 * stitcher then removes).
 */
export function nextScrollTop(lastScrollTop: number, viewportHeight: number): number {
  return lastScrollTop + viewportHeight;
}

/** True when a frame captured at `scrollTop` shows the very bottom of the scroller. */
export function isLastFrame(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
  epsilon = 1,
): boolean {
  return scrollTop + viewportHeight >= scrollHeight - epsilon;
}

/** True when everything up to `scrollHeight` has been covered by captured frames. */
export function isFullyCovered(coveredUntilCss: number, scrollHeight: number, epsilon = 1): boolean {
  return coveredUntilCss >= scrollHeight - epsilon;
}

export type FixedPhase = 'only' | 'first' | 'middle' | 'last';

/**
 * Which kind of position:fixed / position:sticky element should be hidden for a
 * frame, so headers show up once (on the first frame) and footers once (on the last).
 * - 'header' = anchored in the top half of the capture region, 'footer' = bottom half.
 */
export function shouldHideFixed(anchor: 'header' | 'footer', phase: FixedPhase): boolean {
  switch (phase) {
    case 'only':
      return false;
    case 'first':
      return anchor === 'footer';
    case 'last':
      return anchor === 'header';
    case 'middle':
      return true;
  }
}

export function frameRole(index: number, isLast: boolean): FixedPhase {
  if (index === 0 && isLast) return 'only';
  if (index === 0) return 'first';
  return isLast ? 'last' : 'middle';
}
