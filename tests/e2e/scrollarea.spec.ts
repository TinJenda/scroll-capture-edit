import type { Page } from '@playwright/test';
import { bandColor, describeColor, expect, near, test } from './fixtures';
import {
  annotations,
  around,
  click,
  copiedPixels,
  drag,
  expectBands,
  expectColumns,
  hasRed,
  openEditorFromPreview,
  pageInfo,
  px,
  startScrollCapture,
  type Pt,
} from './helpers';

const noPreview = (page: Page) => !page.frames().some((f) => f.url().includes('/preview/'));

test.describe('Scenario A – scrollable table (200 rows)', () => {
  test('one continuous image: every row once, in order, nothing else from the page', async ({ h }) => {
    const page = await h.open('/scroll-table.html?start=500');
    const s = (await pageInfo(page)).dpr;
    const dims = await page.evaluate(() => {
      const t = document.getElementById('table') as HTMLElement;
      return { cw: t.clientWidth, sh: t.scrollHeight };
    });
    expect(dims.sh).toBe(6000);

    await startScrollCapture(h, page, { from: [50, 110], to: [640, 490] });
    const frame = await h.previewFrame(page);
    await expect(frame.locator('.title strong')).toHaveText('Scrolling area');

    const cap = await expectBands(h, { count: 200, bandH: 30, scale: s, sampleX: 5 });
    expect(cap.mode).toBe('scrollArea');
    expect(cap.height).toBe(Math.round(6000 * s));
    expect(Math.abs(cap.width - dims.cw * s)).toBeLessThanOrEqual(1); // the table only, scrollbar excluded
    expect(cap.warnings).toEqual([]);

    // the capture started from the top although the table was scrolled to 500, and it was put back afterwards
    const after = await page.evaluate(() => ({
      top: (document.getElementById('table') as HTMLElement).scrollTop,
      styles: document.querySelectorAll('style[data-snapflow-style]').length,
    }));
    expect(after).toEqual({ top: 500, styles: 0 });
    // the editor never opens by itself
    expect(h.context.pages().some((p) => p.url().includes('/editor/'))).toBe(false);
  });
});

test.describe('Scenario B – long modal with its own scrollbar', () => {
  test('captures the modal’s full scrollable content and nothing from the page behind it', async ({ h }) => {
    const page = await h.open('/modal.html');
    const s = (await pageInfo(page)).dpr;
    const dims = await page.evaluate(() => {
      const m = document.getElementById('modal') as HTMLElement;
      return { cw: m.clientWidth, sh: m.scrollHeight };
    });
    expect(dims.sh).toBe(2400);

    // The page behind is scrollable too; the modal must be recognised as the better match.
    await startScrollCapture(h, page, { from: [190, 70], to: [710, 490] });
    await h.previewFrame(page);

    const cap = await expectBands(h, { count: 40, bandH: 60, scale: s, sampleX: 3 });
    expect(cap.height).toBe(Math.round(2400 * s));
    expect(Math.abs(cap.width - dims.cw * s)).toBeLessThanOrEqual(1);
    // right edge is still modal content (not the dimmed page / shadow)
    const right = await h.latestCapture([[cap.width - 3, Math.round(1000 * s)]]);
    expect(near(right.colors[0], bandColor(Math.floor(1000 / 60)), 2), describeColor(right.colors[0])).toBe(true);
  });
});

test.describe('Scenario C – main article column of a page', () => {
  for (const [how, keys] of [['Manual region (M)', ['m']], ['Auto detect (default – the page is the only candidate)', []]] as const) {
  test(`${how}: captures only the selected column, not the whole page`, async ({ h }) => {
    const page = await h.open('/article.html');
    const info = await pageInfo(page);
    const s = info.dpr;
    const top = 120;
    const bottom = info.ch - 120;

    await startScrollCapture(h, page, { from: [220, top], to: [820, bottom], keys: [...keys] });
    await h.previewFrame(page);

    // output row r  ⇄  document row top + r;  length = scrollHeight − top − (viewport − bottom)
    const len = info.sh - top - (info.ch - bottom);
    const pts: Pt[] = [];
    for (let i = 1; i <= 28; i++) pts.push(px(5, 200 * i + 100 - top, s));
    for (let i = 1; i <= 29; i++) {
      const yb = Math.round((200 * i - top) * s);
      pts.push([Math.round(5 * s), yb - 1], [Math.round(5 * s), yb]);
    }
    const cap = await h.latestCapture(pts);
    expect(Math.abs(cap.width - 600 * s)).toBeLessThanOrEqual(1);
    expect(Math.abs(cap.height - len * s)).toBeLessThanOrEqual(1);

    const bad: string[] = [];
    for (let i = 1; i <= 28; i++) if (!near(cap.colors[i - 1], bandColor(i), 2)) bad.push(`band ${i}: ${describeColor(cap.colors[i - 1])}`);
    for (let i = 1; i <= 29; i++) {
      const above = cap.colors[28 + (i - 1) * 2];
      const below = cap.colors[28 + (i - 1) * 2 + 1];
      if (!near(above, bandColor(i - 1), 2)) bad.push(`boundary ${i} above: ${describeColor(above)}`);
      if (!near(below, bandColor(i), 2)) bad.push(`boundary ${i} below: ${describeColor(below)}`);
    }
    expect(bad, bad.slice(0, 5).join('\n')).toEqual([]);

    // neither the dark left sidebar (#333) nor the orange ad column (#f90) may appear in the first/last columns
    const edges: Pt[] = [];
    for (let r = 100; r < len; r += 700) edges.push(px(0, r, s), px(599.5, r, s));
    const e = await h.latestCapture(edges);
    for (const c of e.colors) {
      expect(near(c, [51, 51, 51], 6), `sidebar leaked: ${describeColor(c)}`).toBe(false);
      expect(near(c, [255, 153, 0], 6), `ad leaked: ${describeColor(c)}`).toBe(false);
    }
  });
  }
});

test.describe('Scenario D – table wider than its container', () => {
  test('horizontal capture: all 40 columns, exact boundaries, no duplicates', async ({ h }) => {
    const page = await h.open('/wide-table.html');
    const s = (await pageInfo(page)).dpr;
    const dims = await page.evaluate(() => {
      const t = document.getElementById('wt') as HTMLElement;
      return { sw: t.scrollWidth, ch: t.clientHeight };
    });
    expect(dims.sw).toBe(4000);

    await startScrollCapture(h, page, { from: [50, 90], to: [630, 270], keys: ['h'] });
    await h.previewFrame(page);

    const cap = await expectColumns(h, { count: 40, bandW: 100, scale: s, sampleY: 50 });
    expect(cap.width).toBe(Math.round(4000 * s));
    expect(Math.abs(cap.height - dims.ch * s)).toBeLessThanOrEqual(1);
    expect(cap.warnings).toEqual([]);
    expect(await page.evaluate(() => (document.getElementById('wt') as HTMLElement).scrollLeft)).toBe(0);
  });

  test('direction switches to horizontal by itself when that is the only possible one', async ({ h }) => {
    const page = await h.open('/wide-table.html');
    const s = (await pageInfo(page)).dpr;
    await startScrollCapture(h, page, { from: [50, 90], to: [630, 270] }); // no key pressed
    await h.previewFrame(page);
    const cap = await h.latestCapture([]);
    expect(cap.width).toBe(Math.round(4000 * s));
  });
});

test.describe('The selection defines what is captured', () => {
  test('a page region is never expanded to the whole page: sidebars, ads and the rest are absent', async ({ h }) => {
    const page = await h.open('/article.html');
    const info = await pageInfo(page);
    const s = info.dpr;
    await startScrollCapture(h, page, { from: [230, 20], to: [810, info.ch - 20] }); // Auto detect, nothing else pressed
    await h.previewFrame(page);
    const cap = await h.latestCapture([px(2, 400, s), px(575, 400, s)]);
    // far narrower than the page (≈1247px) – exactly the selected column
    expect(Math.abs(cap.width - 580 * s)).toBeLessThanOrEqual(2);
    expect(cap.width).toBeLessThan(info.cw * s * 0.6);
    for (const c of cap.colors) {
      expect(near(c, [51, 51, 51], 6), 'left sidebar leaked').toBe(false);
      expect(near(c, [255, 153, 0], 6), 'ad column leaked').toBe(false);
    }
  });

  test('inside a scroll container the selection narrows the capture across the scroll direction (one column)', async ({ h }) => {
    const page = await h.open('/scroll-table.html?n=60');
    const s = (await pageInfo(page)).dpr;
    await startScrollCapture(h, page, { from: [200, 110], to: [400, 490] }); // a 200px-wide slice of the 585px table
    await h.previewFrame(page);
    const cap = await expectBands(h, { count: 60, bandH: 30, scale: s, sampleX: 3 });
    expect(Math.abs(cap.width - 200 * s)).toBeLessThanOrEqual(2);
    expect(cap.height).toBe(Math.round(1800 * s)); // all rows, along the scroll direction
  });

  test('a drag that stops a few pixels short of the container edge still means the whole width', async ({ h }) => {
    const page = await h.open('/scroll-table.html?n=60');
    const s = (await pageInfo(page)).dpr;
    const cw = await page.evaluate(() => (document.getElementById('table') as HTMLElement).clientWidth);
    await startScrollCapture(h, page, { from: [47, 110], to: [620, 490] }); // 5px inside the left edge, 7px inside the right
    await h.previewFrame(page);
    const cap = await h.latestCapture([]);
    expect(Math.abs(cap.width - cw * s)).toBeLessThanOrEqual(1);
  });

  test('pages that scroll inside <body> (html is overflow:hidden) are detected as a container', async ({ h }) => {
    const page = await h.open('/body-scroll.html');
    const s = (await pageInfo(page)).dpr;
    await startScrollCapture(h, page, { from: [100, 100], to: [700, 500] });
    await h.previewFrame(page);
    const cap = await expectBands(h, { count: 30, bandH: 200, scale: s, sampleX: 3 });
    expect(cap.height).toBe(Math.round(6000 * s));
    expect(Math.abs(cap.width - 600 * s)).toBeLessThanOrEqual(2);
  });
});

test.describe('Both directions (2-D tile grid)', () => {
  test('a 1000×1000 grid inside a small container is stitched from tiles without seams', async ({ h }) => {
    const page = await h.open('/grid.html');
    const s = (await pageInfo(page)).dpr;
    await startScrollCapture(h, page, { from: [50, 50], to: [430, 330], keys: ['b'] });
    await h.previewFrame(page);

    const colour = (c: number, r: number) => [c * 25, r * 25, 128];
    const pts: Pt[] = [];
    const expected: number[][] = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) { pts.push(px(c * 100 + 50, r * 100 + 50, s)); expected.push(colour(c, r)); }
    for (const r of [0, 4, 9]) for (let c = 1; c < 10; c++) {
      const xb = Math.round(c * 100 * s);
      const y = Math.round((r * 100 + 50) * s);
      pts.push([xb - 1, y], [xb, y]);
      expected.push(colour(c - 1, r), colour(c, r));
    }
    for (const c of [0, 4, 9]) for (let r = 1; r < 10; r++) {
      const yb = Math.round(r * 100 * s);
      const x = Math.round((c * 100 + 50) * s);
      pts.push([x, yb - 1], [x, yb]);
      expected.push(colour(c, r - 1), colour(c, r));
    }
    const cap = await h.latestCapture(pts);
    expect(cap.width).toBe(Math.round(1000 * s));
    expect(cap.height).toBe(Math.round(1000 * s));
    const bad = cap.colors.map((c, i) => (near(c, expected[i], 2) ? '' : `#${i} ${describeColor(c)} ≠ ${describeColor(expected[i])}`)).filter(Boolean);
    expect(bad, bad.slice(0, 5).join('\n')).toEqual([]);
  });
});

test.describe('Smart detection never guesses', () => {
  test('two nested containers match equally well → nothing starts until the user chooses', async ({ h }) => {
    const page = await h.open('/nested-scroll.html');
    const s = (await pageInfo(page)).dpr;
    const dims = await page.evaluate(() => {
      const i = document.getElementById('inner') as HTMLElement;
      return { cw: i.clientWidth, sh: i.scrollHeight };
    });

    await startScrollCapture(h, page, { from: [42, 42], to: [527, 442] }); // presses Enter
    await page.waitForTimeout(1500);
    expect(noPreview(page), 'ambiguous selection must not start a capture by itself').toBe(true);
    await expect(h.latestCapture()).rejects.toThrow(/no capture stored/);

    await page.keyboard.press('1'); // the user picks the best match (the inner container)
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await h.previewFrame(page);
    const cap = await expectBands(h, { count: 40, bandH: 50, scale: s, sampleX: 4 });
    expect(cap.height).toBe(Math.round(dims.sh * s));
    expect(Math.abs(cap.width - dims.cw * s)).toBeLessThanOrEqual(1);
  });

  test('refuses to start when there is nothing scrollable to capture', async ({ h }) => {
    const page = await h.open('/element.html');
    // over the orange box: no scroll container here → auto detect finds nothing …
    await startScrollCapture(h, page, { from: [420, 80], to: [620, 200] });
    await page.waitForTimeout(800);
    // … and manual region needs a page that itself scrolls, which this one does not.
    await page.keyboard.press('m');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    expect(noPreview(page)).toBe(true);
    await expect(h.latestCapture()).rejects.toThrow(/no capture stored/);
    await page.keyboard.press('Escape');
  });
});

test.describe('Cancellation and cleanup', () => {
  test('Esc during the scroll stops and makes the image from the rows captured so far', async ({ h }) => {
    const page = await h.open('/scroll-table.html?start=500');
    const sc = (await pageInfo(page)).dpr;
    await startScrollCapture(h, page, { from: [50, 110], to: [640, 490] });
    await page.waitForTimeout(2300); // a few frames in
    expect(await page.evaluate(() => (document.getElementById('table') as HTMLElement).scrollTop)).not.toBe(500);
    await page.keyboard.press('Escape');
    await h.previewFrame(page);

    const meta = await h.latestCapture([]);
    expect(meta.warnings.some((w) => w.code === 'stopped')).toBe(true);
    expect(meta.height).toBeGreaterThan(400 * sc);
    expect(meta.height).toBeLessThan(6000 * sc * 0.5);
    const rows = Math.floor(meta.height / sc / 30);
    await expectBands(h, { count: rows, bandH: 30, scale: sc, sampleX: 5 });
    const edge = await h.latestCapture([[5, meta.height - 1]]);
    expect(edge.colors[0][3]).toBe(255); // no blank tail

    const after = await page.evaluate(() => ({
      top: (document.getElementById('table') as HTMLElement).scrollTop,
      styles: document.querySelectorAll('style[data-snapflow-style]').length,
    }));
    expect(after).toEqual({ top: 500, styles: 0 });
  });

  test('Esc during a 2-D capture leaves a clean rectangle of correct tiles (no half-finished row)', async ({ h }) => {
    const page = await h.open('/grid.html');
    const sc = (await pageInfo(page)).dpr;
    await startScrollCapture(h, page, { from: [50, 50], to: [430, 330], keys: ['b'] });
    await page.waitForTimeout(3300); // several tiles in, not finished (9 tiles take ~6 s)
    await page.keyboard.press('Escape');
    await h.previewFrame(page);

    const meta = await h.latestCapture([]);
    expect(meta.warnings.some((w) => w.code === 'stopped')).toBe(true);
    expect(meta.width * meta.height).toBeLessThan(1000 * sc * 1000 * sc);
    const pts: Pt[] = [];
    const want: number[][] = [];
    for (let r = 0; r < 10; r++) for (let c = 0; c < 10; c++) {
      const [x, y] = px(c * 100 + 50, r * 100 + 50, sc);
      if (x < meta.width && y < meta.height) { pts.push([x, y]); want.push([c * 25, r * 25, 128]); }
    }
    pts.push([meta.width - 1, meta.height - 1], [meta.width - 1, 0], [0, meta.height - 1]);
    const cap = await h.latestCapture(pts);
    expect(want.length).toBeGreaterThanOrEqual(4);
    const bad = want.map((w, i) => (near(cap.colors[i], w, 2) ? '' : `cell #${i}: ${describeColor(cap.colors[i])}`)).filter(Boolean);
    expect(bad, bad.join(', ')).toEqual([]);
    for (const corner of cap.colors.slice(want.length)) expect(corner[3], 'corners are real content').toBe(255);
    expect(await page.evaluate(() => { const g = document.getElementById('g') as HTMLElement; return [g.scrollLeft, g.scrollTop]; })).toEqual([0, 0]);
  });

  test('Discard during the scroll restores the container and stores nothing', async ({ h }) => {
    const page = await h.open('/scroll-table.html?start=500');
    await startScrollCapture(h, page, { from: [50, 110], to: [640, 490] });
    await page.waitForTimeout(1500);
    await h.discard(page);
    await page.waitForTimeout(2000);
    const state = await page.evaluate(() => ({
      top: (document.getElementById('table') as HTMLElement).scrollTop,
      styles: document.querySelectorAll('style[data-snapflow-style]').length,
    }));
    expect(state).toEqual({ top: 500, styles: 0 });
    expect(noPreview(page)).toBe(true);
    await expect(h.latestCapture()).rejects.toThrow(/no capture stored/);
  });

  test('Esc in the selection overlay cancels without capturing', async ({ h }) => {
    const page = await h.open('/scroll-table.html');
    await h.capture(page, 'scrollArea');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect(noPreview(page)).toBe(true);
    await expect(h.latestCapture()).rejects.toThrow(/no capture stored/);
  });
});

test.describe('Scenario E – copy without editing', () => {
  test('Ctrl+C in the preview puts the whole stitched image on the clipboard as a PNG', async ({ h }) => {
    const page = await h.open('/scroll-table.html?n=60');
    const s = (await pageInfo(page)).dpr;
    const cw = await page.evaluate(() => (document.getElementById('table') as HTMLElement).clientWidth);
    await startScrollCapture(h, page, { from: [50, 110], to: [640, 490] });
    const frame = await h.previewFrame(page);
    await frame.locator('body').click({ position: { x: 5, y: 5 } }); // focus the preview, then use the keyboard
    await page.keyboard.press('Control+c');
    await expect(frame.getByTestId('preview-status')).toContainText('Copied', { timeout: 10_000 });

    const clip = await frame.evaluate(async (rows) => {
      const items = await navigator.clipboard.read();
      const blob = await items[0].getType('image/png');
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bmp, 0, 0);
      return {
        type: blob.type,
        w: bmp.width,
        h: bmp.height,
        colors: rows.map((y) => Array.from(ctx.getImageData(5, y, 1, 1).data)),
      };
    }, [0, 29, 30, 900, 1799].map((r) => Math.round(r * s)));
    expect(clip.type).toBe('image/png');
    expect(Math.abs(clip.w - cw * s)).toBeLessThanOrEqual(1);
    expect(clip.h).toBe(Math.round(1800 * s));
    [0, 0, 1, 30, 59].forEach((band, i) => expect(near(clip.colors[i], bandColor(band), 2), `row sample ${i}: ${describeColor(clip.colors[i])}`).toBe(true));
    expect(h.context.pages().some((p) => p.url().includes('/editor/'))).toBe(false);
  });
});

test.describe('Scenario F – edit after capture', () => {
  test('red rectangle + sequential markers on the stitched image are all in the copied picture', async ({ h }) => {
    const page = await h.open('/scroll-table.html?n=60');
    await startScrollCapture(h, page, { from: [50, 110], to: [640, 490] });
    const editor = await openEditorFromPreview(h, page);
    await expect(editor.getByTestId('dimensions')).toContainText('1800 px');

    await editor.getByTestId('tool-rect').click();
    await drag(editor, [100, 300], [400, 420]);
    await editor.getByTestId('tool-marker').click();
    const spots: Pt[] = [[150, 700], [250, 700], [350, 700]];
    for (const p of spots) await click(editor, p);
    expect((await annotations(editor)).map((a) => a.number ?? a.type)).toEqual(['rect', 1, 2, 3]);

    const probes = [around([250, 300], 4), around([100, 360], 4), ...spots.map((p) => around([p[0], p[1] - 11], 3))];
    const clip = await copiedPixels(editor, probes.flat());
    let at = 0;
    const slices = probes.map((p) => {
      const sl = clip.colors.slice(at, at + p.length);
      at += p.length;
      return sl;
    });
    expect(hasRed(slices[0]), 'rectangle top edge').toBe(true);
    expect(hasRed(slices[1]), 'rectangle left edge').toBe(true);
    slices.slice(2).forEach((sl, i) => expect(hasRed(sl, 10), `marker ${i + 1} body`).toBe(true));
    expect(clip.height).toBeGreaterThan(1000);
  });
});

test.describe('Browser zoom', () => {
  test('150% zoom: scale follows the zoom level and boundaries stay exact', async ({ h }) => {
    const page = await h.open('/scroll-table.html?n=100');
    const tabId = await h.helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? -1, page.url());
    await h.helper.evaluate(async (id) => chrome.tabs.setZoom(id, 1.5), tabId);
    await page.waitForTimeout(500);
    const s = (await pageInfo(page)).dpr;
    expect(s).toBeCloseTo(1.5, 2);

    await startScrollCapture(h, page, { from: [50, 110], to: [640, 490] });
    await h.previewFrame(page);
    const cap = await expectBands(h, { count: 100, bandH: 30, scale: s, sampleX: 5 });
    expect(cap.scale).toBeCloseTo(1.5, 1);
    expect(cap.height).toBe(Math.round(3000 * s));
  });
});
