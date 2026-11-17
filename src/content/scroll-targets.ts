import { intersectRect } from '@/shared/geometry';
import { isAmbiguous, rankTargets, suggestedIndex } from '@/shared/scroll-detect';
import type { Rect } from '@/shared/types';
import { allElements, isViewportOverflowBlocked } from './page-driver';

export interface ScrollCandidate {
  /** null = the document itself. */
  el: HTMLElement | null;
  isDocument: boolean;
  /** Client box of the scroller in viewport CSS px. */
  rect: Rect;
  vertical: boolean;
  horizontal: boolean;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  label: string;
  score: number;
}

export interface Detection {
  /** Best match first. */
  candidates: ScrollCandidate[];
  /** Index to pre-select, or null when the user has to choose (nothing found or ambiguous). */
  suggested: number | null;
  ambiguous: boolean;
}

const SCROLLY = /(auto|scroll|overlay)/;

function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 48);
}

/**
 * ScrollTargetDetector – finds the scroll containers that a user's selection is probably about.
 *
 * It inspects every scrollable element that intersects the selection (ancestors *and* descendants of
 * whatever is under it), plus the page itself, ranks them by how well their client box matches the
 * selection, and reports whether the ranking is ambiguous. It never decides for the user when it is.
 */
export class ScrollTargetDetector {
  documentAxes(): { x: boolean; y: boolean } {
    const se = document.scrollingElement ?? document.documentElement;
    return {
      y: se.scrollHeight - se.clientHeight > 4 && !isViewportOverflowBlocked('y'),
      x: se.scrollWidth - se.clientWidth > 4 && !isViewportOverflowBlocked('x'),
    };
  }

  detect(selection: Rect): Detection {
    const selArea = selection.width * selection.height;
    const raw: Array<Omit<ScrollCandidate, 'score'>> = [];

    for (const el of allElements(document)) {
      if (el === document.documentElement || el === document.body) continue;
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw < 40 || ch < 40) continue;
      const overV = el.scrollHeight - ch > 4;
      const overH = el.scrollWidth - cw > 4;
      if (!overV && !overH) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const vertical = overV && SCROLLY.test(cs.overflowY);
      const horizontal = overH && SCROLLY.test(cs.overflowX);
      if (!vertical && !horizontal) continue;

      const r = el.getBoundingClientRect();
      const box: Rect = { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: cw, height: ch };
      const inter = intersectRect(box, selection);
      if (!inter) continue;
      const interArea = inter.width * inter.height;
      // Ignore containers that merely graze the selection.
      if (interArea < 0.05 * selArea && interArea < 0.5 * cw * ch) continue;

      raw.push({
        el,
        isDocument: false,
        rect: box,
        vertical,
        horizontal,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: cw,
        clientHeight: ch,
        label: describeElement(el),
      });
    }

    const axes = this.documentAxes();
    if (axes.x || axes.y) {
      const se = document.scrollingElement ?? document.documentElement;
      raw.push({
        el: null,
        isDocument: true,
        rect: { x: 0, y: 0, width: se.clientWidth || window.innerWidth, height: se.clientHeight || window.innerHeight },
        vertical: axes.y,
        horizontal: axes.x,
        scrollWidth: se.scrollWidth,
        scrollHeight: se.scrollHeight,
        clientWidth: se.clientWidth,
        clientHeight: se.clientHeight,
        label: 'Whole page',
      });
    }

    const candidates = rankTargets(selection, raw);
    return { candidates, suggested: suggestedIndex(candidates), ambiguous: isAmbiguous(candidates) };
  }
}

/** Human description of how far a candidate scrolls, e.g. "scrolls ↓ 6,000 px". */
export function describeScroll(c: Pick<ScrollCandidate, 'vertical' | 'horizontal' | 'scrollWidth' | 'scrollHeight'>): string {
  const parts: string[] = [];
  if (c.vertical) parts.push(`↓ ${c.scrollHeight.toLocaleString()} px`);
  if (c.horizontal) parts.push(`→ ${c.scrollWidth.toLocaleString()} px`);
  return parts.join('  ');
}
