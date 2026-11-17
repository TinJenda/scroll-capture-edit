import { describe, expect, it } from 'vitest';
import { ScrollCoordinateManager, axisFrameCount, resolveAxes } from '@/shared/scroll-coords';
import { planStitch } from '@/shared/stitch';

/** Simulate the engine's scroll loop along one axis; the browser clamps scroll to [0, maxScroll]. */
function simulate(maxScroll: number, windowLen: number, overlap = 2) {
  const m = new ScrollCoordinateManager({ scrollable: false, maxScroll: 0, windowLen: 1 }, { scrollable: true, maxScroll, windowLen }, overlap);
  const positions: number[] = [];
  let want = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const actual = Math.min(want, maxScroll);
    positions.push(actual);
    if (actual >= maxScroll) break;
    want = m.nextPosition('y', actual);
  }
  return { m, positions };
}

describe('ScrollCoordinateManager', () => {
  it('output length is maxScroll + window – for the page, a container or a manual region alike', () => {
    // page: 6000 tall, 800 viewport → window = whole viewport
    expect(new ScrollCoordinateManager({ scrollable: false, maxScroll: 0, windowLen: 1000 }, { scrollable: true, maxScroll: 5200, windowLen: 800 }).outputLength('y')).toBe(6000);
    // manual region 560px tall inside the same 800px viewport: rows from window-top to window-bottom only
    expect(new ScrollCoordinateManager({ scrollable: false, maxScroll: 0, windowLen: 600 }, { scrollable: true, maxScroll: 5200, windowLen: 560 }).outputLength('y')).toBe(5760);
  });

  it('an axis that does not scroll contributes just the window', () => {
    const m = new ScrollCoordinateManager({ scrollable: false, maxScroll: 999, windowLen: 600 }, { scrollable: true, maxScroll: 100, windowLen: 400 });
    expect(m.outputLength('x')).toBe(600);
    expect(m.scrolls('x')).toBe(false);
    expect(m.framesAlong('x')).toBe(1);
  });

  it('frames overlap by 2px so rounding can never leave a seam; the last is clamped to maxScroll', () => {
    const { positions } = simulate(5200, 800);
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBe(798);
    expect(positions.at(-1)).toBe(5200);
    for (let i = 1; i < positions.length; i++) expect(positions[i] - positions[i - 1]).toBeLessThanOrEqual(798);
  });

  it('the simulated positions stitch into a complete image, for many geometries', () => {
    for (const [maxScroll, win] of [[5200, 800], [1, 500], [799, 800], [2345, 333], [100000, 700], [0.5, 300]] as const) {
      const { m, positions } = simulate(maxScroll, win);
      const out = m.outputLength('y');
      const plan = planStitch(positions.map((p) => ({ scrollY: p, frameHeight: win })), 1, Math.round(out));
      expect(plan.maxGap, `maxScroll=${maxScroll} win=${win}`).toBe(0);
      expect(plan.covered).toBe(Math.round(out));
      expect(positions.length).toBeLessThanOrEqual(m.framesAlong('y') + 1);
    }
  });

  it('the same maths works for fractional scales (device pixel ratio / browser zoom)', () => {
    const scale = 1.5;
    const { m, positions } = simulate(2400.667, 645);
    const out = Math.round(m.outputLength('y') * scale);
    const plan = planStitch(positions.map((p) => ({ scrollY: p, frameHeight: Math.round(645 * scale) })), scale, out);
    expect(plan.maxGap).toBe(0);
    expect(plan.covered).toBe(out);
  });

  it('estimates tile counts for progress (columns × rows)', () => {
    const m = new ScrollCoordinateManager({ scrollable: true, maxScroll: 615, windowLen: 385 }, { scrollable: true, maxScroll: 715, windowLen: 285 });
    expect(axisFrameCount(615, 385)).toBe(3);
    expect(m.estimateFrames()).toBe(m.framesAlong('x') * m.framesAlong('y'));
    expect(m.estimateFrames()).toBeGreaterThanOrEqual(9);
  });

  it('growing content raises (never lowers) the scrollable range', () => {
    const m = new ScrollCoordinateManager({ scrollable: false, maxScroll: 0, windowLen: 100 }, { scrollable: true, maxScroll: 1000, windowLen: 500 });
    m.updateMaxScroll('y', 1500);
    m.updateMaxScroll('y', 900);
    expect(m.outputLength('y')).toBe(2000);
  });
});

describe('direction resolution', () => {
  it('a direction is reduced to what the target can scroll', () => {
    expect(resolveAxes('vertical', { x: true, y: true })).toEqual({ x: false, y: true, direction: 'vertical' });
    expect(resolveAxes('horizontal', { x: true, y: true })).toEqual({ x: true, y: false, direction: 'horizontal' });
    expect(resolveAxes('both', { x: true, y: true })).toEqual({ x: true, y: true, direction: 'both' });
    expect(resolveAxes('both', { x: false, y: true })).toEqual({ x: false, y: true, direction: 'vertical' });
    expect(resolveAxes('both', { x: true, y: false })).toEqual({ x: true, y: false, direction: 'horizontal' });
  });
  it('nothing scrollable resolves to no axes', () => {
    const r = resolveAxes('horizontal', { x: false, y: true });
    expect(r.x || r.y).toBe(false);
  });
});

describe('2-D tile grid: axes are independent', () => {
  it('every tile covers its column range × row range exactly once', () => {
    const xs = simulate(615, 385).positions; // reuse the 1-D simulation for the horizontal axis too
    const ys = simulate(715, 285).positions;
    const colPlan = planStitch(xs.map((p) => ({ scrollY: p, frameHeight: 385 })), 1, 1000);
    const rowPlan = planStitch(ys.map((p) => ({ scrollY: p, frameHeight: 285 })), 1, 1000);
    expect(colPlan.complete && rowPlan.complete).toBe(true);
    let area = 0;
    for (const c of colPlan.segments) for (const r of rowPlan.segments) area += (c?.height ?? 0) * (r?.height ?? 0);
    expect(area).toBe(1000 * 1000);
  });
});
