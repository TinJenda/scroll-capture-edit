import fs from 'node:fs';
import koffi from 'koffi';
import type { Page } from '@playwright/test';
import { describe as colorName, expect, expectBands, near, test, type Bounds, type Desktop } from './harness';

const px = (v: number, s: number) => Math.round(v * s);

async function previewFor(d: Desktop): Promise<Page> {
  const p = await d.page('/preview/');
  await p.waitForSelector('[data-testid="preview-image"]');
  return p;
}

test.describe('launcher', () => {
  test('shows the four capture modes and their shortcuts', async ({ d }) => {
    await d.app.evaluate(() => (globalThis as any).__snapflowTest.showLauncher());
    const launcher = await d.page('/launcher/');
    await expect(launcher.locator('.tile')).toHaveCount(4);
    await expect(launcher.locator('.tile', { hasText: 'Scrolling region' })).toContainText('Ctrl+Shift+2');
  });
});

test.describe('region and full-screen capture', () => {
  test('captures exactly the dragged rectangle in the selection overlay', async ({ d }) => {
    const win = await d.fixture('/long.html?n=40&h=200');
    await d.app.evaluate(() => (globalThis as any).__snapflowTest.showLauncher());
    const overlayPromise = d.page('/overlay/');
    await d.startFromLauncher('Region');
    const overlay = await overlayPromise;
    await overlay.waitForSelector('#shot');
    // Drag a rectangle that straddles the first two bands (band 0 is 200px tall).
    const from = { x: win.x + 30, y: win.y + 100 };
    const to = { x: win.x + 330, y: win.y + 400 };
    const display = await d.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    await overlay.mouse.move(from.x - display.x, from.y - display.y);
    await overlay.mouse.down();
    await overlay.mouse.move(to.x - display.x, to.y - display.y, { steps: 6 });
    await expect(overlay.locator('#dims')).toHaveText('300 × 300');
    await overlay.mouse.up();

    const preview = await previewFor(d);
    await expect(preview.locator('header .title')).toContainText('Selected area');
    const cap = await d.latest([
      [10, 10],
      [10, px(150, d.scale)],
    ]);
    expect(cap.width).toBe(px(300, d.scale));
    expect(cap.height).toBe(px(300, d.scale));
    expect(near(cap.colors[0], [0, 255, 0], 255)).toBe(true); // sanity: opaque pixel
    expect(near(cap.colors[0], bandAt(0))).toBe(true); // y 100..200 of the page is band 0
    expect(near(cap.colors[1], bandAt(1))).toBe(true); // y 250 of the page is band 1
  });

  test('captures the whole display', async ({ d }) => {
    await d.app.evaluate(() => (globalThis as any).__snapflowTest.showLauncher());
    await d.startFromLauncher('Full screen');
    await previewFor(d);
    const display = await d.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
    const cap = await d.latest();
    expect(Math.abs(cap.width - px(display.width, d.scale))).toBeLessThanOrEqual(2);
    expect(Math.abs(cap.height - px(display.height, d.scale))).toBeLessThanOrEqual(2);
    expect(cap.mode).toBe('visible');
  });
});

test.describe('window capture', () => {
  test('lists open windows and captures the picked one as it appears on screen', async ({ d }) => {
    const win = await d.fixture('/long.html?n=10&h=200');
    await d.app.evaluate(() => (globalThis as any).__snapflowTest.showLauncher());
    const pickerPromise = d.page('/picker/');
    await d.startFromLauncher('Window');
    const picker = await pickerPromise;
    await picker.waitForSelector('.card');
    // SnapFlow's own windows are not offered.
    const names = await picker.locator('.card').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));
    expect(names).toContain('Long static page');
    expect(names.some((n) => /SnapFlow/.test(n ?? ''))).toBe(false);
    await picker.locator('.card[data-name="Long static page"]').click();

    await previewFor(d);
    const cap = await d.latest([[10, 10]]);
    expect(cap.mode).toBe('element');
    expect(cap.title).toBe('Long static page');
    expect(Math.abs(cap.width - px(win.width, d.scale))).toBeLessThanOrEqual(3);
    expect(Math.abs(cap.height - px(win.height, d.scale))).toBeLessThanOrEqual(3);
    expect(near(cap.colors[0], bandAt(0))).toBe(true);
  });
});

const bandAt = (i: number) => [(i * 6) % 256, (((255 - i * 6) % 256) + 256) % 256, (i * 37) % 256];

test.describe('scrolling capture of a native window', () => {
  test('stitches a long page exactly (no seams, no duplicated or missing rows)', async ({ d }) => {
    const win = await d.fixture('/long.html?n=40&h=200');
    const ok = await d.captureRect('scrolling', win);
    expect(ok).toBe(true);
    await previewFor(d);
    const cap = await expectBands(d, { count: 40, bandH: 200 });
    expect(cap.mode).toBe('scrollArea');
    expect(Math.abs(cap.height - px(8000, d.scale))).toBeLessThanOrEqual(2);
    expect(cap.warnings).toEqual([]);
  });

  test('keeps a sticky header once at the top and a fixed footer once at the bottom', async ({ d }) => {
    const win = await d.fixture('/sticky.html?n=30');
    await d.captureRect('scrolling', win);
    await previewFor(d);
    const cap = await expectBands(d, { count: 29, bandH: 200, offset: 60 });
    // 60px header + 30 × 200px bands; the fixed 50px footer covers the last bit of the final band.
    expect(Math.abs(cap.height - px(6060, d.scale))).toBeLessThanOrEqual(2);
    const edge = await d.latest([
      [10, px(20, d.scale)], // header
      [10, cap.height - 5], // footer (bottom row)
      [10, px(1000, d.scale)], // a body row well away from the ends – must not be footer
    ]);
    expect(near(edge.colors[0], [17, 17, 17])).toBe(true);
    expect(near(edge.colors[1], [0, 170, 0])).toBe(true);
    expect(near(edge.colors[2], [0, 170, 0], 3)).toBe(false);
    // Exactly one footer: scan the left edge column for green rows – they must all be in the last 50 CSS px.
    const column = await d.latest(Array.from({ length: 60 }, (_, i) => [10, px(60 + i * 100, d.scale)] as [number, number]));
    const greenRows = column.colors.filter((c) => near(c, [0, 170, 0], 3)).length;
    expect(greenRows).toBe(0);
  });

  test('Stop on the progress pill keeps what was captured so far', async ({ d }) => {
    const win = await d.fixture('/long.html?n=100&h=200');
    const pillPromise = d.page('/pill/');
    const done = d.captureRect('scrolling', win);
    const pill = await pillPromise;
    await expect(pill.locator('#main')).toContainText(/Scrolling… [3-9] frames/, { timeout: 60_000 });
    await pill.locator('#stop').click();
    expect(await done).toBe(true);
    await previewFor(d);
    const cap = await d.latest();
    expect(cap.warnings.map((w) => w.code)).toEqual(['stopped']);
    expect(cap.height).toBeGreaterThan(px(win.height, d.scale) * 1.5);
    expect(cap.height).toBeLessThan(px(20000, d.scale));
    const bands = Math.floor(cap.height / px(200, d.scale));
    await expectBands(d, { count: bands, bandH: 200 });
  });

  test('pressing Esc stops the capture and keeps the partial image', async ({ d }) => {
    const win = await d.fixture('/long.html?n=100&h=200');
    const pillPromise = d.page('/pill/');
    const done = d.captureRect('scrolling', win);
    const pill = await pillPromise;
    await expect(pill.locator('#main')).toContainText(/Scrolling… [3-9] frames/, { timeout: 60_000 });
    pressEscape();
    expect(await done).toBe(true);
    await previewFor(d);
    const cap = await d.latest();
    expect(cap.warnings.map((w) => w.code)).toEqual(['stopped']);
    const bands = Math.floor(cap.height / px(200, d.scale));
    expect(bands).toBeGreaterThanOrEqual(3);
    await expectBands(d, { count: bands, bandH: 200 });
  });

  test('Discard throws the capture away', async ({ d }) => {
    const win = await d.fixture('/long.html?n=100&h=200');
    const pillPromise = d.page('/pill/');
    const done = d.captureRect('scrolling', win);
    const pill = await pillPromise;
    await expect(pill.locator('#main')).toContainText(/Scrolling… [2-9] frames/, { timeout: 60_000 });
    await pill.locator('#discard').click();
    expect(await done).toBe(false);
    expect(d.app.windows().some((w) => w.url().includes('/preview/'))).toBe(false);
  });

  test('says so when the selected area cannot scroll', async ({ d }) => {
    await d.app.evaluate(({ dialog }) => {
      (globalThis as any).__lastError = null;
      dialog.showErrorBox = (_t: string, msg: string) => void ((globalThis as any).__lastError = msg);
    });
    const win = await d.fixture('/long.html?n=2&h=200', { width: 900, height: 700 }); // 400px page in a 700px window
    expect(await d.captureRect('scrolling', win)).toBe(false);
    const msg = await d.app.evaluate(() => (globalThis as any).__lastError as string | null);
    expect(msg).toContain('Nothing scrolled');
  });

  test('captures only the selected part of the window', async ({ d }) => {
    const win = await d.fixture('/long.html?n=40&h=200');
    const region: Bounds = { x: win.x + 40, y: win.y + 100, width: 500, height: 400 };
    await d.captureRect('scrolling', region);
    await previewFor(d);
    const cap = await d.latest();
    expect(cap.width).toBe(px(500, d.scale));
    // The window shows page rows 100..500 first; scrolling down from there reveals the rest of the page.
    expect(cap.height).toBeGreaterThan(px(7000, d.scale));
    expect(cap.height).toBeLessThanOrEqual(px(8000 - 100, d.scale) + 4);
  });
});

test.describe('preview → copy / edit / save', () => {
  test('Copy puts a real image on the system clipboard', async ({ d }) => {
    const win = await d.fixture('/long.html?n=40&h=200');
    await d.captureRect('region', { x: win.x + 20, y: win.y + 20, width: 400, height: 260 });
    const preview = await previewFor(d);
    await d.app.evaluate(({ clipboard }) => clipboard.clear());
    await preview.locator('[data-testid="copy"]').click();
    await expect(preview.locator('[data-testid="preview-status"]')).toContainText('Copied');
    const size = await d.app.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      const item = items.find((i) => i.types.includes('image/png'));
      if (!item) return null;
      const bytes = new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      return { signature: Array.from(bytes.subarray(0, 4)), width: view.getUint32(16), height: view.getUint32(20) };
    });
    expect(size).not.toBeNull();
    expect(size?.signature).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect({ width: size?.width, height: size?.height }).toEqual({ width: px(400, d.scale), height: px(260, d.scale) });
  });

  test('Save writes a PNG file', async ({ d }) => {
    const win = await d.fixture('/long.html?n=40&h=200');
    await d.captureRect('region', { x: win.x + 20, y: win.y + 20, width: 320, height: 200 });
    const preview = await previewFor(d);
    await preview.locator('[data-testid="save"]').click();
    await expect(preview.locator('[data-testid="preview-status"]')).toContainText('Saved as PNG');
    const files = fs.readdirSync(d.downloads);
    expect(files).toHaveLength(1);
    const bytes = fs.readFileSync(`${d.downloads}/${files[0]}`);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(px(320, d.scale));
    expect(bytes.readUInt32BE(20)).toBe(px(200, d.scale));
  });

  test('Edit opens the editor in the same window and returns to the preview', async ({ d }) => {
    const win = await d.fixture('/long.html?n=40&h=200');
    await d.captureRect('region', { x: win.x + 20, y: win.y + 20, width: 400, height: 260 });
    const preview = await previewFor(d);
    await preview.locator('[data-testid="edit"]').click();
    await preview.waitForURL(/\/editor\//);
    await preview.waitForFunction(() => (window as any).__snapflow?.store?.getState().imageSize.width > 1);
    const size = await preview.evaluate(() => (window as any).__snapflow.store.getState().imageSize);
    expect(size).toEqual({ width: px(400, d.scale), height: px(260, d.scale) });

    // Return to the preview in the same window; the capture is still there.
    await preview.locator('[data-testid="back-to-preview"]').click();
    await preview.waitForURL(/\/preview\//);
    await expect(preview.locator('[data-testid="preview-image"]')).toBeVisible();
    expect(d.app.windows().filter((w) => w.url().includes('/preview/') || w.url().includes('/editor/'))).toHaveLength(1);
  });
});

function pressEscape(): void {
  const user32 = koffi.load('user32.dll');
  const keybd = user32.func('void __stdcall keybd_event(uint8 vk, uint8 scan, uint32 flags, uintptr_t extra)');
  keybd(0x1b, 0, 0, 0);
  keybd(0x1b, 0, 2, 0);
}

void colorName;
