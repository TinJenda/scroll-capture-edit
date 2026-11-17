import { describe, expect, it } from 'vitest';
import { SnapflowError } from '@/shared/errors';
import { placeFrame, planOutputSize, planStitch } from '@/shared/stitch';

describe('image overlap and stitching', () => {
  it('copies only the new rows of the overlapping last frame', () => {
    // 2500px page, 800px viewport → the browser clamps the final scroll to 1700
    const plan = planStitch(
      [0, 800, 1600, 1700].map((y) => ({ scrollY: y, frameHeight: 800 })),
      1,
      2500,
    );
    expect(plan.segments).toEqual([
      { srcY: 0, destY: 0, height: 800 },
      { srcY: 0, destY: 800, height: 800 },
      { srcY: 0, destY: 1600, height: 800 },
      { srcY: 700, destY: 2400, height: 100 }, // last viewport: skip the 700px already covered
    ]);
    expect(plan.complete).toBe(true);
  });

  it('segments tile the output exactly: no gaps, no duplicated rows', () => {
    const frames = [0, 640, 1280, 1920, 2400].map((y) => ({ scrollY: y, frameHeight: 800 }));
    const { segments, covered } = planStitch(frames, 1, 3200);
    let next = 0;
    for (const s of segments) {
      if (!s) continue;
      expect(s.destY).toBe(next);
      next = s.destY + s.height;
    }
    expect(next).toBe(3200);
    expect(covered).toBe(3200);
  });

  it('handles fractional scroll offsets at fractional scales (2px frame overlap, rounding)', () => {
    const scale = 1.25;
    const vh = 713;
    const frameHeight = Math.round(vh * scale);
    // the engine advances by (viewport - 2px) and the browser clamps the final scroll to the maximum
    const ys = [0.4, 711.4, 1422.4, 2133.4, 2139.4];
    const out = Math.round(2852 * scale);
    const plan = planStitch(ys.map((y) => ({ scrollY: y, frameHeight })), scale, out);
    expect(plan.maxGap).toBe(0);
    expect(plan.covered).toBe(out);
    const rows = plan.segments.reduce((n, s) => n + (s?.height ?? 0), 0);
    expect(rows).toBe(out); // every row exactly once
  });

  it('closes a 1-2px rounding hairline instead of leaving a seam', () => {
    const r = placeFrame({ scrollY: 801, scale: 1, frameHeight: 800, outHeight: 2000, coveredUntil: 800 });
    expect(r.gap).toBe(0);
    expect(r.segment).toEqual({ srcY: 0, destY: 800, height: 800 });
  });

  it('reports a real gap (e.g. scroll-snapping jumped past content)', () => {
    const r = placeFrame({ scrollY: 1000, scale: 1, frameHeight: 800, outHeight: 3000, coveredUntil: 800 });
    expect(r.gap).toBe(200);
  });

  it('last viewport cropping: a frame overshooting the output by rounding is shifted back, not cropped', () => {
    const r = placeFrame({ scrollY: 1700.6, scale: 1, frameHeight: 800, outHeight: 2500, coveredUntil: 1700 });
    expect(r.segment).toEqual({ srcY: 0, destY: 1700, height: 800 });
    expect(r.coveredUntil).toBe(2500);
  });

  it('truncates (not shifts) frames that run past a deliberately limited output', () => {
    const r = placeFrame({ scrollY: 1000, scale: 1, frameHeight: 800, outHeight: 1500, coveredUntil: 1000 });
    expect(r.segment).toEqual({ srcY: 0, destY: 1000, height: 500 });
  });
});

describe('output size planning (never silently truncates)', () => {
  it('fits at native resolution', () => {
    const p = planOutputSize(1920, 8000);
    expect(p).toMatchObject({ scale: 1, outWidth: 1920, outHeight: 8000, downscaled: false, truncated: false });
  });
  it('downscales uniformly (flagged) when slightly over the limit', () => {
    const p = planOutputSize(1280, 20000);
    expect(p.downscaled).toBe(true);
    expect(p.truncated).toBe(false);
    expect(p.outHeight).toBeLessThanOrEqual(16384);
    expect(p.scale).toBeGreaterThan(0.5);
    expect(p.capturedFullHeight).toBe(20000);
  });
  it('flags truncation when readable scale cannot hold the page', () => {
    const p = planOutputSize(1280, 80000);
    expect(p.truncated).toBe(true);
    expect(p.scale).toBe(0.5);
    expect(p.outHeight).toBeLessThanOrEqual(16384);
    expect(p.capturedFullHeight).toBeLessThan(80000);
  });
  it('respects the area budget as well as the edge limit', () => {
    const p = planOutputSize(8000, 16000, { maxDimension: 16384, maxArea: 100_000_000, minScale: 0.5 });
    expect(p.outWidth * p.outHeight).toBeLessThanOrEqual(100_000_000);
  });
  it('refuses absurdly wide pages and empty sizes', () => {
    expect(() => planOutputSize(50000, 1000)).toThrow(SnapflowError);
    expect(() => planOutputSize(0, 10)).toThrow(SnapflowError);
  });
});
