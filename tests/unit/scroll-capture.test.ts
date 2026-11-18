// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { PixelFrame } from '@/shared/overlap';
import { runScrollCapture, type ScrollRunDeps } from '../../desktop/main/scroll-capture';
import { equal, makePage, render, WHITE, type Chrome } from './helpers/synthetic-page';

/** A fake window: wheel notches move the offset; `smooth` makes the content glide over a few grabs. */
function fakeWindow(page: PixelFrame, H: number, opts: { pxPerNotch: number; chrome?: Chrome; smooth?: boolean; stopAfterWheels?: number }) {
  const c = opts.chrome ?? {};
  const vp = H - (c.header ?? 0) - (c.footer ?? 0);
  const maxOffset = Math.max(0, page.height - vp);
  let offset = 0;
  let target = 0;
  let wheels = 0;
  let stop = false;
  const deps: ScrollRunDeps = {
    maxRows: 100_000,
    settleDelayMs: 0,
    sleep: async () => undefined,
    shouldStop: () => stop,
    progress: () => undefined,
    wheel: (n) => {
      wheels++;
      target = Math.max(0, Math.min(maxOffset, target + n * opts.pxPerNotch));
      if (!opts.smooth) offset = target;
      if (opts.stopAfterWheels && wheels >= opts.stopAfterWheels) stop = true;
    },
    grab: async () => {
      if (opts.smooth && offset !== target) offset = offset + Math.ceil((target - offset) / 2); // glides over several grabs
      return render(page, offset, H, c);
    },
  };
  return { deps, get offset() { return offset; } };
}

/** Mostly blank page with a short block of content every `period` rows – hard to line up across a big step. */
function sparsePage(width: number, height: number, period: number, block: number): PixelFrame {
  const dense = makePage(width, height, 7);
  const px = new Uint32Array(width * height).fill(WHITE);
  for (let y = 0; y < height; y++) if (y % period < block) px.set(dense.px.subarray(y * width, (y + 1) * width), y * width);
  return { width, height, px };
}

describe('runScrollCapture', () => {
  it('backs off to a smaller step when a big one cannot be lined up (sparse content)', async () => {
    const page = sparsePage(260, 6000, 420, 30);
    const w = fakeWindow(page, 640, { pxPerNotch: 80 });
    const res = await runScrollCapture(w.deps);
    expect(res.end).toBe('bottom');
    expect(equal(res.image.px, page.px)).toBe(true);
  });

  it('scrolls to the bottom and returns the whole page', async () => {
    const page = makePage(260, 6000);
    const w = fakeWindow(page, 640, { pxPerNotch: 53 });
    const res = await runScrollCapture(w.deps);
    expect(res.end).toBe('bottom');
    expect(res.image.height).toBe(6000);
    expect(equal(res.image.px, page.px)).toBe(true);
  });

  it('waits for smooth scrolling to finish before measuring', async () => {
    const page = makePage(260, 4200);
    const w = fakeWindow(page, 600, { pxPerNotch: 100, smooth: true });
    const res = await runScrollCapture(w.deps);
    expect(res.end).toBe('bottom');
    expect(equal(res.image.px, page.px)).toBe(true);
  });

  it('handles sticky header/footer and a side panel', async () => {
    const page = makePage(300, 5000);
    const chrome = { header: 44, footer: 28, sidebar: 40 };
    const w = fakeWindow(page, 620, { pxPerNotch: 60, chrome });
    const res = await runScrollCapture(w.deps);
    expect(res.end).toBe('bottom');
    expect(res.image.height).toBe(44 + 5000 + 28);
    // compare the scrolling columns of the body
    for (let y = 0; y < 5000; y += 11) {
      const got = res.image.px.subarray((44 + y) * 300 + 40, (44 + y) * 300 + 300);
      const want = page.px.subarray(y * 300 + 40, y * 300 + 300);
      if (!equal(got, want)) throw new Error(`row ${y} differs`);
    }
  });

  it('reports "nothing" when the region does not scroll', async () => {
    const page = makePage(200, 500);
    const w = fakeWindow(page, 500, { pxPerNotch: 50 }); // page == viewport: nothing to scroll
    const res = await runScrollCapture(w.deps);
    expect(res.end).toBe('nothing');
    expect(res.image.height).toBe(500);
  });

  it('keeps the partial result when stopped early', async () => {
    const page = makePage(260, 9000);
    const w = fakeWindow(page, 600, { pxPerNotch: 100, stopAfterWheels: 4 });
    const res = await runScrollCapture(w.deps);
    expect(res.end).toBe('stopped');
    expect(res.image.height).toBeGreaterThan(600);
    expect(res.image.height).toBeLessThan(9000);
    expect(equal(res.image.px, page.px.subarray(0, res.image.height * 260))).toBe(true);
  });

  it('stops at the size cap instead of growing forever', async () => {
    const page = makePage(260, 9000);
    const w = fakeWindow(page, 600, { pxPerNotch: 100 });
    const res = await runScrollCapture({ ...w.deps, maxRows: 2000 });
    expect(res.end).toBe('full');
    expect(res.image.height).toBeLessThanOrEqual(2000);
  });
});
