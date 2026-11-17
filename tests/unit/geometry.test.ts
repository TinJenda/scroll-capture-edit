import { describe, expect, it } from 'vitest';
import { clampRect, cssRectToImageRect, getCaptureScale, intersectRect, rectFromPoints, resolveScale } from '@/shared/geometry';

describe('pixel ratio / scale', () => {
  it('uses devicePixelRatio when it agrees with the bitmap (avoids innerWidth rounding drift)', () => {
    // 1280 device px at 150% zoom → innerWidth is rounded to 853, so image/innerWidth = 1.50059…
    expect(1280 / 853).not.toBe(1.5);
    expect(resolveScale(1280, 853, 1.5)).toBe(1.5);
  });
  it('falls back to the measured ratio when dpr disagrees with the bitmap', () => {
    expect(resolveScale(2000, 1000, 1)).toBe(2);
  });
  it('handles degenerate input', () => {
    expect(resolveScale(100, 0, 2)).toBe(1);
    expect(getCaptureScale({ width: 100, height: 100 }, { width: 0, height: 0 })).toEqual({ x: 1, y: 1 });
  });
  it('getCaptureScale is per axis', () => {
    expect(getCaptureScale({ width: 2560, height: 1440 }, { width: 1280, height: 720 })).toEqual({ x: 2, y: 2 });
  });
});

describe('crop boundaries', () => {
  const img = { width: 2000, height: 1000 };
  it('converts CSS px to device px with independent edge rounding', () => {
    expect(cssRectToImageRect({ x: 10.2, y: 20.4, width: 100.4, height: 50.2 }, { x: 2, y: 2 }, img)).toEqual({
      x: 20,
      y: 41,
      width: 201,
      height: 100,
    });
  });
  it('clamps to the image and never returns less than 1px', () => {
    expect(cssRectToImageRect({ x: 900, y: 450, width: 500, height: 500 }, { x: 2, y: 2 }, img)).toEqual({ x: 1800, y: 900, width: 200, height: 100 });
    expect(cssRectToImageRect({ x: 5, y: 5, width: 0.01, height: 0.01 }, { x: 1, y: 1 }, img)).toEqual({ x: 5, y: 5, width: 1, height: 1 });
  });
  it('returns null when fully outside', () => {
    expect(cssRectToImageRect({ x: 5000, y: 5000, width: 10, height: 10 }, { x: 1, y: 1 }, img)).toBeNull();
  });
  it('adjacent regions share an edge exactly (no drift)', () => {
    const a = cssRectToImageRect({ x: 0, y: 0, width: 33.3, height: 10 }, { x: 1.5, y: 1.5 }, img);
    const b = cssRectToImageRect({ x: 33.3, y: 0, width: 33.3, height: 10 }, { x: 1.5, y: 1.5 }, img);
    expect(a && b && a.x + a.width).toBe(b?.x);
  });
});

describe('rect helpers', () => {
  it('normalises drag points', () => {
    expect(rectFromPoints(10, 50, 4, 20)).toEqual({ x: 4, y: 20, width: 6, height: 30 });
  });
  it('intersects / clamps', () => {
    expect(intersectRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
    expect(intersectRect({ x: 0, y: 0, width: 5, height: 5 }, { x: 5, y: 5, width: 5, height: 5 })).toBeNull();
    expect(clampRect({ x: -10, y: -10, width: 30, height: 30 }, { width: 15, height: 15 })).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });
});
