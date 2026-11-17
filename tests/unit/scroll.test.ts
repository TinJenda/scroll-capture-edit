import { describe, expect, it } from 'vitest';
import { estimateFrameCount, frameRole, isFullyCovered, isLastFrame, nextScrollTop, planScrollPositions, shouldHideFixed } from '@/shared/scroll';

describe('scroll position calculations', () => {
  it('steps one viewport at a time and pulls the last frame back to the bottom', () => {
    expect(planScrollPositions(2500, 1000)).toEqual([0, 1000, 1500]);
  });
  it('exact multiples have no redundant extra frame', () => {
    expect(planScrollPositions(3000, 1000)).toEqual([0, 1000, 2000]);
  });
  it('short pages need a single frame', () => {
    expect(planScrollPositions(600, 800)).toEqual([0]);
    expect(planScrollPositions(800, 800)).toEqual([0]);
  });
  it('fractional heights', () => {
    expect(planScrollPositions(2400.5, 800)).toEqual([0, 800, 1600]);
    expect(estimateFrameCount(2400.5, 800)).toBe(3);
  });
  it('nextScrollTop asks for one more viewport (browser clamps the last step)', () => {
    expect(nextScrollTop(1000, 800)).toBe(1800);
  });
  it('detects the last frame with a 1px tolerance', () => {
    expect(isLastFrame(1700, 2500, 800)).toBe(true);
    expect(isLastFrame(1699.4, 2500, 800)).toBe(true);
    expect(isLastFrame(1000, 2500, 800)).toBe(false);
    expect(isFullyCovered(2499.5, 2500)).toBe(true);
    expect(isFullyCovered(2000, 2500)).toBe(false);
  });
});

describe('fixed / sticky element visibility per frame', () => {
  it('headers only on the first frame, footers only on the last', () => {
    expect(shouldHideFixed('header', 'first')).toBe(false);
    expect(shouldHideFixed('footer', 'first')).toBe(true);
    expect(shouldHideFixed('header', 'middle')).toBe(true);
    expect(shouldHideFixed('footer', 'middle')).toBe(true);
    expect(shouldHideFixed('header', 'last')).toBe(true);
    expect(shouldHideFixed('footer', 'last')).toBe(false);
  });
  it('a single-frame page keeps everything', () => {
    expect(shouldHideFixed('header', 'only')).toBe(false);
    expect(shouldHideFixed('footer', 'only')).toBe(false);
  });
  it('derives the frame role', () => {
    expect(frameRole(0, true)).toBe('only');
    expect(frameRole(0, false)).toBe('first');
    expect(frameRole(3, false)).toBe('middle');
    expect(frameRole(3, true)).toBe('last');
  });
});
