import type { Page } from '@playwright/test';
import { bandColor, describeColor, expect, near, test, type Harness } from './fixtures';
import { expectBands, pageInfo, px, type Pt } from './helpers';

async function finishFullPage(h: Harness, page: Page) {
  await h.capture(page, 'fullPage');
  await h.previewFrame(page);
}

test.describe('area capture', () => {
  test('select a region → preview (no editor) → exact pixels', async ({ h }) => {
    const page = await h.open('/page.html');
    await h.capture(page, 'area');
    await page.waitForTimeout(300);
    await page.mouse.move(90, 90);
    await page.mouse.down();
    await page.mouse.move(200, 200, { steps: 6 });
    await page.mouse.move(320, 310, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await h.previewFrame(page);

    const info = await pageInfo(page);
    const s = info.dpr;
    const cap = await h.latestCapture([px(5, 5, s), px(150, 150, s), px(222, 150, s), px(150, 215, s)]);
    expect(Math.abs(cap.width - 230 * s)).toBeLessThanOrEqual(2);
    expect(Math.abs(cap.height - 220 * s)).toBeLessThanOrEqual(2);
    // selection starts at (90,90): the red square begins 10px in
    expect(cap.colors[0].slice(0, 3)).toEqual([255, 255, 255]);
    expect(cap.colors[1].slice(0, 3)).toEqual([255, 0, 0]);
    expect(cap.colors[2].slice(0, 3)).toEqual([255, 255, 255]); // right of the square
    expect(cap.colors[3].slice(0, 3)).toEqual([255, 255, 255]); // below the square
    expect(h.context.pages().some((p) => p.url().includes('/editor/'))).toBe(false);
  });

  test('Escape cancels without capturing and removes the overlay', async ({ h }) => {
    const page = await h.open('/page.html');
    await h.capture(page, 'area');
    await page.waitForTimeout(300);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(250, 250, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect(page.frames().some((f) => f.url().includes('/preview/'))).toBe(false);
    await expect(h.latestCapture()).rejects.toThrow(/no capture stored/);
  });

  test('the selection UI never appears in the screenshot (taken after overlay removal)', async ({ h }) => {
    const page = await h.open('/page.html');
    await h.capture(page, 'area');
    await page.waitForTimeout(300);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await h.previewFrame(page);
    const s = (await pageInfo(page)).dpr;
    // Selection exactly covers the red square → every sampled pixel must be pure red (no dim overlay / border).
    const cap = await h.latestCapture([px(2, 2, s), px(100, 100, s), px(197, 197, s), px(100, 2, s)]);
    for (const c of cap.colors) expect(c.slice(0, 3)).toEqual([255, 0, 0]);
  });
});

test.describe('full page capture', () => {
  test('long static page: correct order, exact boundaries, scroll position restored', async ({ h }) => {
    const page = await h.open('/long.html?n=40');
    await page.evaluate(() => window.scrollTo(0, 300));
    const info = await pageInfo(page);
    await finishFullPage(h, page);

    const cap = await expectBands(h, { count: 40, bandH: 200, scale: info.dpr });
    expect(cap.height).toBe(Math.round(8000 * info.dpr));
    expect(Math.abs(cap.width - info.cw * info.dpr)).toBeLessThanOrEqual(1); // scrollbar excluded
    expect(cap.warnings).toEqual([]);

    const after = await page.evaluate(() => ({
      y: window.scrollY,
      styles: document.querySelectorAll('style[data-snapflow-style]').length,
    }));
    expect(after.y).toBe(300);
    expect(after.styles).toBe(0);
  });

  test('sticky header appears once; fixed footer only at the very bottom', async ({ h }) => {
    const page = await h.open('/sticky.html?n=30');
    const info = await pageInfo(page);
    const s = info.dpr;
    await finishFullPage(h, page);

    const total = 60 + 30 * 200;
    const colorAt = (y: number): number[] => (y < 60 ? [17, 17, 17] : bandColor(Math.floor((y - 60) / 200)));
    const pts: Pt[] = [px(10, 30, s), px(10, total - 25, s)];
    const checkYs: number[] = [];
    for (let k = 1; (k + 1) * info.ch < total; k++) {
      for (const dy of [-25, 25]) {
        const y = k * info.ch + dy;
        if ((y - 60) % 200 > 4 && (y - 60) % 200 < 196) checkYs.push(y);
      }
    }
    expect(checkYs.length, 'test must actually sample frame joins').toBeGreaterThanOrEqual(3);
    for (const y of checkYs) pts.push(px(10, y, s));
    const cap = await h.latestCapture(pts);

    expect(cap.height).toBe(Math.round(total * s));
    expect(near(cap.colors[0], [17, 17, 17], 2), `header ${describeColor(cap.colors[0])}`).toBe(true);
    expect(near(cap.colors[1], [0, 170, 0], 2), `footer at bottom ${describeColor(cap.colors[1])}`).toBe(true);
    checkYs.forEach((y, i) => {
      const got = cap.colors[2 + i];
      expect(near(got, colorAt(y), 2), `y=${y}: ${describeColor(got)} expected ${describeColor(colorAt(y))} (no repeated header/footer)`).toBe(true);
    });

    const restored = await page.evaluate(() => ({
      pos: getComputedStyle(document.getElementById('hdr') as HTMLElement).position,
      vis: getComputedStyle(document.getElementById('ftr') as HTMLElement).visibility,
    }));
    expect(restored).toEqual({ pos: 'sticky', vis: 'visible' });
  });

  test('fixed navigation bar is captured at the top only', async ({ h }) => {
    const page = await h.open('/fixed.html?n=30');
    const info = await pageInfo(page);
    const s = info.dpr;
    await finishFullPage(h, page);
    const ys = [28, info.ch + 28, 2 * info.ch + 28, 3 * info.ch + 28].filter((y) => y % 200 > 4 && y % 200 < 196);
    const cap = await h.latestCapture(ys.map((y) => px(600, y, s)));
    expect(near(cap.colors[0], [0, 0, 255], 2), `nav ${describeColor(cap.colors[0])}`).toBe(true);
    ys.slice(1).forEach((y, i) => {
      expect(near(cap.colors[i + 1], bandColor(Math.floor(y / 200)), 2), `y=${y} ${describeColor(cap.colors[i + 1])}`).toBe(true);
    });
    expect(cap.height).toBe(Math.round(6000 * s));
  });

  test('lazy-loaded images are loaded before each frame is captured', async ({ h }) => {
    const page = await h.open('/lazy.html?n=12');
    const s = (await pageInfo(page)).dpr;
    await finishFullPage(h, page);
    const pts: Pt[] = [];
    for (let i = 0; i < 12; i++) pts.push(px(400, i * 300 + 150, s));
    const cap = await h.latestCapture(pts);
    const bad = cap.colors.map((c, i) => (near(c, bandColor(i), 3) ? '' : `img ${i}: ${describeColor(c)}`)).filter(Boolean);
    expect(bad).toEqual([]);
  });

  test('page that scrolls inside a nested container is captured automatically', async ({ h }) => {
    const page = await h.open('/nested.html?n=30');
    const s = (await pageInfo(page)).dpr;
    await finishFullPage(h, page);
    const cap = await expectBands(h, { count: 30, bandH: 200, scale: s });
    expect(cap.height).toBe(Math.round(6000 * s));
    expect(cap.warnings.some((w) => w.code === 'nested-scroll')).toBe(true);
  });

  test('page that grows while being captured is extended (bounded) with a warning', async ({ h }) => {
    const page = await h.open('/dynamic.html');
    const s = (await pageInfo(page)).dpr;
    await finishFullPage(h, page);
    const cap = await expectBands(h, { count: 22, bandH: 200, scale: s });
    expect(cap.height).toBe(Math.round(4400 * s));
    expect(cap.warnings.some((w) => w.code === 'height-changed')).toBe(true);
  });

  test('very tall page is scaled to fit canvas limits and says so (never silently truncated)', async ({ h }) => {
    test.setTimeout(240_000);
    const page = await h.open('/tall.html?n=18&h=1000');
    const s = (await pageInfo(page)).dpr;
    await finishFullPage(h, page);
    const cap = await h.latestCapture([]);
    const outScale = cap.height / (18000 * s);
    expect(cap.height).toBeLessThanOrEqual(16384);
    expect(outScale).toBeLessThan(1);
    expect(outScale).toBeGreaterThan(0.5);
    expect(cap.warnings.some((w) => w.code === 'downscaled')).toBe(true);
    // all 18 sections present, in order
    const pts: Pt[] = [];
    for (let i = 0; i < 18; i++) pts.push([10, Math.round((i * 1000 + 500) * s * outScale)]);
    const colored = await h.latestCapture(pts);
    const bad = colored.colors.map((c, i) => (near(c, bandColor(i), 3) ? '' : `section ${i}: ${describeColor(c)}`)).filter(Boolean);
    expect(bad).toEqual([]);
  });

  test('cancelling mid-capture restores the page and stores nothing', async ({ h }) => {
    const page = await h.open('/sticky.html?n=100');
    await page.evaluate(() => window.scrollTo(0, 450));
    await h.capture(page, 'fullPage');
    await page.waitForTimeout(1600); // a few frames in
    const during = await page.evaluate(() => window.scrollY);
    expect(during).not.toBe(450);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1800);
    const state = await page.evaluate(() => ({
      y: window.scrollY,
      styles: document.querySelectorAll('style[data-snapflow-style]').length,
      footer: getComputedStyle(document.getElementById('ftr') as HTMLElement).visibility,
      header: getComputedStyle(document.getElementById('hdr') as HTMLElement).position,
    }));
    expect(state).toEqual({ y: 450, styles: 0, footer: 'visible', header: 'sticky' });
    expect(page.frames().some((f) => f.url().includes('/preview/'))).toBe(false);
    await expect(h.latestCapture()).rejects.toThrow(/no capture stored/);
  });
});

test.describe('element capture', () => {
  test('hover + click captures exactly the element', async ({ h }) => {
    const page = await h.open('/element.html');
    const s = (await pageInfo(page)).dpr;
    await h.capture(page, 'element');
    await page.waitForTimeout(300);
    await page.mouse.move(500, 140, { steps: 4 });
    await page.waitForTimeout(150);
    await page.mouse.click(500, 140);
    await h.previewFrame(page);
    const cap = await h.latestCapture([px(100, 60, s), px(2, 2, s), px(197, 117, s)]);
    expect(Math.abs(cap.width - 200 * s)).toBeLessThanOrEqual(1);
    expect(Math.abs(cap.height - 120 * s)).toBeLessThanOrEqual(1);
    for (const c of cap.colors) expect(c.slice(0, 3)).toEqual([255, 136, 0]);
    expect(cap.mode).toBe('element');
  });

  test('scrollable element: “entire content” stitches all of its rows', async ({ h }) => {
    const page = await h.open('/element.html');
    const s = (await pageInfo(page)).dpr;
    await h.capture(page, 'element');
    await page.waitForTimeout(300);
    await page.mouse.move(150, 200, { steps: 4 }); // a row inside #box
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowUp'); // row → #box (moving the mouse again would reset this)
    await page.keyboard.press('Enter');
    await page.waitForTimeout(250);
    await page.keyboard.press('f'); // capture entire scrollable content
    await h.previewFrame(page);
    const cap = await expectBands(h, { count: 20, bandH: 100, scale: s, sampleX: 10 });
    expect(Math.abs(cap.height - 2000 * s)).toBeLessThanOrEqual(2);
    // the box scroll position was restored
    expect(await page.evaluate(() => (document.getElementById('box') as HTMLElement).scrollTop)).toBe(0);
  });
});

test.describe('unsupported pages', () => {
  test('browser pages are refused with a clear message', async ({ h }) => {
    const page = await h.context.newPage();
    await page.goto('chrome://version');
    const tabId = await h.helper.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('chrome://version'))?.id ?? -1);
    const reply = await h.helper.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'START_CAPTURE', mode: 'visible', tabId: id }), tabId);
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('RESTRICTED_PAGE');
    expect(reply.error.message).toMatch(/browser pages|extensions/i);
  });
});

test.describe('hi-DPI (device scale factor 2)', () => {
  test.use({ env: { scaleFactor: 2, width: 1280, height: 800 } });

  test('full page keeps native resolution and exact alignment', async ({ h }) => {
    const page = await h.open('/long.html?n=20');
    const info = await pageInfo(page);
    expect(info.dpr).toBe(2);
    await finishFullPage(h, page);
    const cap = await expectBands(h, { count: 20, bandH: 200, scale: 2 });
    expect(cap.scale).toBeCloseTo(2, 1);
    expect(cap.height).toBe(8000);
    expect(Math.abs(cap.width - info.cw * 2)).toBeLessThanOrEqual(1);
  });

  test('area selection maps CSS pixels to device pixels', async ({ h }) => {
    const page = await h.open('/page.html');
    await h.capture(page, 'area');
    await page.waitForTimeout(300);
    await page.mouse.move(100, 100);
    await page.mouse.down();
    await page.mouse.move(300, 300, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Enter');
    await h.previewFrame(page);
    const cap = await h.latestCapture([[4, 4], [200, 200], [395, 395]]);
    expect(Math.abs(cap.width - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(cap.height - 400)).toBeLessThanOrEqual(2);
    for (const c of cap.colors) expect(c.slice(0, 3)).toEqual([255, 0, 0]);
  });
});

test.describe('browser zoom', () => {
  test('150% zoom: scale follows the zoom level and the capture is still exact', async ({ h }) => {
    const page = await h.open('/long.html?n=20');
    const tabId = await h.helper.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? -1, page.url());
    await h.helper.evaluate(async (id) => chrome.tabs.setZoom(id, 1.5), tabId);
    await page.waitForTimeout(500);
    const info = await pageInfo(page);
    expect(info.dpr).toBeCloseTo(1.5, 2);
    await finishFullPage(h, page);
    const cap = await expectBands(h, { count: 20, bandH: 200, scale: info.dpr });
    expect(cap.scale).toBeCloseTo(1.5, 1);
    expect(Math.abs(cap.height - Math.round(info.sh * info.dpr))).toBeLessThanOrEqual(1);
  });
});
