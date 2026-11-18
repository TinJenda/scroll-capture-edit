// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findVerticalShift, frameFromBytes, VerticalStitcher, type PixelFrame } from '@/shared/overlap';

import { equal, makePage, render, rowsOf, WHITE, DARK, type Chrome } from './helpers/synthetic-page';

/** Drive the stitcher like the real capture loop: scroll by `step`, clamp at the end, stop on "same". */
function capture(page: PixelFrame, H: number, step: number, c: Chrome = {}, expectedHint = false) {
  const vp = H - (c.header ?? 0) - (c.footer ?? 0);
  const maxOffset = page.height - vp;
  let offset = 0;
  const stitcher = new VerticalStitcher(render(page, 0, H, c), 100_000);
  let frames = 1;
  let guard = 0;
  while (guard++ < 500) {
    offset = Math.min(offset + step, maxOffset);
    const r = stitcher.add(render(page, offset, H, c), expectedHint ? { expected: step } : {});
    if (r.kind === 'same') break;
    if (r.kind !== 'added') throw new Error(`unexpected ${r.kind} at offset ${offset}`);
    frames++;
  }
  return { out: stitcher.finish(), frames };
}

/* ---------- tests ------------------------------------------------------------------------------ */

describe('findVerticalShift', () => {
  const page = makePage(240, 4000);

  it('measures the exact distance between two frames', () => {
    for (const d of [1, 7, 100, 333, 450]) {
      const r = findVerticalShift(render(page, 500, 640), render(page, 500 + d, 640));
      expect(r.kind).toBe('shift');
      if (r.kind === 'shift') expect(r.shift).toBe(d);
    }
  });

  it('reports identical frames as "same"', () => {
    expect(findVerticalShift(render(page, 500, 640), render(page, 500, 640)).kind).toBe('same');
  });

  it('is not fooled by a hover highlight or a moving scrollbar thumb', () => {
    const c = { scrollbar: 14, hoverRow: 300 };
    const r = findVerticalShift(render(page, 800, 640, { scrollbar: 14 }), render(page, 1100, 640, c));
    expect(r.kind === 'shift' && r.shift).toBe(300);
  });

  it('ignores a fixed side panel', () => {
    const c = { sidebar: 60 };
    const r = findVerticalShift(render(page, 800, 640, c), render(page, 1010, 640, c));
    expect(r.kind === 'shift' && r.shift).toBe(210);
  });

  it('detects sticky header and footer bands', () => {
    const c = { header: 50, footer: 30 };
    const r = findVerticalShift(render(page, 800, 640, c), render(page, 1000, 640, c));
    expect(r.kind).toBe('shift');
    if (r.kind === 'shift') {
      expect(r.shift).toBe(200);
      expect(r.top).toBeGreaterThanOrEqual(50);
      expect(r.bottom).toBeGreaterThanOrEqual(30);
    }
  });

  it('reports "lost" for unrelated content instead of guessing', () => {
    expect(findVerticalShift(render(page, 0, 640), render(makePage(240, 4000, 99), 0, 640)).kind).toBe('lost');
  });

  it('refuses blank frames (nothing to anchor on)', () => {
    const blank = (): PixelFrame => ({ width: 120, height: 400, px: new Uint32Array(120 * 400).fill(WHITE) });
    const one = blank();
    one.px.fill(DARK, 0, 120 * 3); // a different thing in frame 2 so it is not "same"
    expect(findVerticalShift(blank(), one).kind).not.toBe('shift');
  });

  it('uses the expected distance to resolve repetitive content', () => {
    // Every line repeats every 4 lines (80px): shifts of 170, 250, 330 … look identical.
    const rep = makePage(240, 4000, 1);
    const px = rep.px;
    const W = rep.width;
    for (let y = 80; y < rep.height; y++) px.copyWithin(y * W, (y - 80) * W, (y - 80 + 1) * W);
    const a = render(rep, 400, 640);
    const b = render(rep, 400 + 250, 640);
    expect(findVerticalShift(a, b, { expected: 250 })).toMatchObject({ kind: 'shift', shift: 250 });
    expect(findVerticalShift(a, b, { expected: 335 })).toMatchObject({ kind: 'shift', shift: 330 });
  });
});

describe('VerticalStitcher', () => {
  it('reassembles a long page exactly', () => {
    const page = makePage(240, 5000);
    const { out, frames } = capture(page, 600, 380);
    expect(frames).toBeGreaterThan(5);
    expect(out.height).toBe(5000);
    expect(equal(out.px, page.px)).toBe(true);
  });

  it('handles a final step that is shorter than the others', () => {
    const page = makePage(240, 3333);
    const { out } = capture(page, 700, 450);
    expect(out.height).toBe(3333);
    expect(equal(out.px, page.px)).toBe(true);
  });

  it('keeps a sticky header once at the top and a sticky footer once at the bottom', () => {
    const page = makePage(240, 4000);
    const c = { header: 48, footer: 36 };
    const H = 600;
    const { out } = capture(page, H, 330, c);
    const first = render(page, 0, H, c);
    const last = render(page, page.height - (H - 84), H, c);
    expect(out.height).toBe(48 + 4000 + 36);
    expect(equal(rowsOf(out, 0, 48), rowsOf(first, 0, 48))).toBe(true);
    expect(equal(rowsOf(out, 48, 48 + 4000), page.px)).toBe(true);
    expect(equal(rowsOf(out, 48 + 4000, out.height), rowsOf(last, H - 36, H))).toBe(true);
  });

  it('stitches the scrolling columns correctly next to a fixed side panel and a scrollbar', () => {
    const page = makePage(300, 4000);
    const c = { sidebar: 50, scrollbar: 12 };
    const { out } = capture(page, 640, 300, c);
    expect(out.height).toBe(4000);
    for (let y = 0; y < 4000; y += 7) {
      const got = out.px.subarray(y * 300 + 50, y * 300 + 300 - 12);
      const want = page.px.subarray(y * 300 + 50, y * 300 + 300 - 12);
      if (!equal(got, want)) throw new Error(`row ${y} differs`);
    }
  });

  it('works when the scroll step varies (smooth-scroll acceleration)', () => {
    const page = makePage(240, 5000);
    const H = 600;
    const steps = [120, 410, 260, 500, 90, 480, 330, 300, 450, 200, 500, 500, 500, 500, 500, 500, 500, 500];
    let offset = 0;
    const st = new VerticalStitcher(render(page, 0, H), 100_000);
    for (const s of steps) {
      offset = Math.min(offset + s, page.height - H);
      const r = st.add(render(page, offset, H), { expected: 300 });
      if (r.kind === 'same') break;
      expect(r.kind).toBe('added');
    }
    expect(equal(st.finish().px, page.px)).toBe(true);
  });

  it('stops with "full" instead of growing without bound', () => {
    const page = makePage(240, 3000);
    const st = new VerticalStitcher(render(page, 0, 500), 900);
    expect(st.add(render(page, 300, 500)).kind).toBe('added');
    expect(st.add(render(page, 600, 500)).kind).toBe('full');
    expect(st.finish().height).toBeLessThanOrEqual(900);
  });

  it('keeps what it has when alignment is lost', () => {
    const page = makePage(240, 3000);
    const st = new VerticalStitcher(render(page, 0, 500), 10_000);
    expect(st.add(render(page, 300, 500)).kind).toBe('added');
    expect(st.add(render(makePage(240, 3000, 5), 0, 500)).kind).toBe('lost');
    const out = st.finish();
    expect(out.height).toBe(800);
    expect(equal(out.px, rowsOf(page, 0, 800))).toBe(true);
  });
});

describe('frameFromBytes', () => {
  it('views aligned buffers and copies unaligned ones', () => {
    const buf = new Uint8Array(4 * 4 * 2);
    buf.set([1, 2, 3, 4], 0);
    expect(frameFromBytes(buf, 4, 2).px[0]).toBe(new Uint32Array(buf.buffer)[0]);
    const shifted = new Uint8Array(buf.buffer, 0, 32).slice();
    const odd = new Uint8Array(33);
    odd.set(shifted, 1);
    const f = frameFromBytes(odd.subarray(1), 4, 2);
    expect(f.px[0]).toBe(new Uint32Array(shifted.buffer)[0]);
  });
});
