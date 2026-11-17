import { describe, expect, it } from 'vitest';
import { isAmbiguous, rankTargets, scoreTarget, suggestedIndex } from '@/shared/scroll-detect';
import type { Rect } from '@/shared/types';

const r = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
const viewport = r(0, 0, 1280, 700);

describe('scroll target ranking', () => {
  it('a perfect match scores 1, a disjoint box 0', () => {
    expect(scoreTarget(r(10, 10, 100, 100), r(10, 10, 100, 100))).toBeCloseTo(1, 5);
    expect(scoreTarget(r(0, 0, 10, 10), r(100, 100, 10, 10))).toBe(0);
  });

  it('scrollable table under the selection beats the page behind it → suggested, not ambiguous', () => {
    const table = { rect: r(42, 102, 585, 400), isDocument: false, name: 'table' };
    const page = { rect: viewport, isDocument: true, name: 'page' };
    const ranked = rankTargets(r(50, 110, 590, 380), [page, table]);
    expect(ranked[0].name).toBe('table');
    expect(isAmbiguous(ranked)).toBe(false);
    expect(suggestedIndex(ranked)).toBe(0);
  });

  it('a modal over a long page is recognised as the target', () => {
    const modal = { rect: r(200, 80, 485, 400), isDocument: false, name: 'modal' };
    const page = { rect: viewport, isDocument: true, name: 'page' };
    const ranked = rankTargets(r(190, 70, 520, 420), [page, modal]);
    expect(ranked[0].name).toBe('modal');
    expect(suggestedIndex(ranked)).toBe(0);
  });

  it('nested containers of nearly the same size are AMBIGUOUS – nothing is pre-selected', () => {
    const inner = { rect: r(42, 42, 485, 400), isDocument: false, name: 'inner' };
    const outer = { rect: r(42, 42, 505, 420), isDocument: false, name: 'outer' };
    const ranked = rankTargets(r(42, 42, 485, 400), [outer, inner]);
    expect(ranked.map((t) => t.name)).toEqual(['inner', 'outer']); // best match first
    expect(isAmbiguous(ranked)).toBe(true);
    expect(suggestedIndex(ranked)).toBeNull();
  });

  it('a selection that is mostly the page itself is ambiguous against a big container', () => {
    const container = { rect: r(0, 40, 1200, 640), isDocument: false };
    const page = { rect: viewport, isDocument: true };
    const ranked = rankTargets(r(0, 0, 1280, 700), [container, page]);
    expect(isAmbiguous(ranked)).toBe(true);
  });

  it('nothing under the selection → no candidates and no suggestion', () => {
    const ranked = rankTargets(r(900, 600, 50, 50), [{ rect: r(0, 0, 100, 100), isDocument: false }]);
    expect(ranked).toEqual([]);
    expect(suggestedIndex(ranked)).toBeNull();
    expect(isAmbiguous(ranked)).toBe(false);
  });

  it('a single candidate is suggested', () => {
    const ranked = rankTargets(r(0, 0, 200, 200), [{ rect: r(0, 0, 220, 220), isDocument: false }]);
    expect(ranked).toHaveLength(1);
    expect(suggestedIndex(ranked)).toBe(0);
  });

  it('is deterministic and sorted best-first', () => {
    const boxes = [r(0, 0, 50, 50), r(0, 0, 200, 200), r(0, 0, 120, 120)].map((rect) => ({ rect, isDocument: false }));
    const ranked = rankTargets(r(0, 0, 200, 200), boxes);
    const scores = ranked.map((t) => t.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });
});
