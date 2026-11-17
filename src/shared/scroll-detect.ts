import { intersectRect } from './geometry';
import type { Rect } from './types';

/**
 * Pure ranking of scroll-container candidates for a user selection (the DOM-facing half lives in the
 * content script). Kept separate so the heuristics can be unit-tested without a browser.
 */
export interface TargetBox {
  /** Client box of the scroller in viewport CSS px (the document uses the viewport). */
  rect: Rect;
  isDocument: boolean;
}

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

/** How well a container matches a selection: 70 % overlap quality (IoU), 30 % "how much of the selection it covers". */
export function scoreTarget(selection: Rect, box: Rect): number {
  const inter = intersectRect(selection, box);
  if (!inter) return 0;
  const interArea = area(inter);
  const union = area(selection) + area(box) - interArea;
  const iou = union > 0 ? interArea / union : 0;
  const coverage = area(selection) > 0 ? interArea / area(selection) : 0;
  return 0.7 * iou + 0.3 * coverage;
}

export function rankTargets<T extends TargetBox>(selection: Rect, targets: T[]): Array<T & { score: number }> {
  return targets
    .map((t) => ({ ...t, score: scoreTarget(selection, t.rect) }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** The runner-up must be at least this fraction of the best score to count as "could also be meant". */
export const AMBIGUITY_RATIO = 0.75;

/**
 * Detection is ambiguous when two or more containers match the selection about equally well.
 * In that case SnapFlow never guesses – the user has to pick one.
 */
export function isAmbiguous(ranked: Array<{ score: number }>): boolean {
  return ranked.length > 1 && ranked[1].score >= ranked[0].score * AMBIGUITY_RATIO;
}

/** Index of the candidate to pre-select (null = the user must choose). */
export function suggestedIndex(ranked: Array<{ score: number }>): number | null {
  if (ranked.length === 0 || isAmbiguous(ranked)) return null;
  return 0;
}
