import { expect, test, FIXTURE } from './fixtures';

test('extension loads: service worker runs and the popup lists all four capture modes', async ({ h }) => {
  const popup = await h.context.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup/index.html`);
  for (const mode of ['visible', 'area', 'fullPage', 'element']) {
    await expect(popup.getByTestId(`mode-${mode}`)).toBeVisible();
  }
  expect(await h.helper.evaluate(() => chrome.runtime.getManifest().manifest_version)).toBe(3);
});

test('visible capture → preview overlay → Copy writes a real PNG image to the clipboard', async ({ h }) => {
  const page = await h.open('/page.html');
  await h.capture(page, 'visible');
  const frame = await h.previewFrame(page);

  // The preview opens, the full editor does not.
  expect(h.context.pages().some((p) => p.url().includes('/editor/'))).toBe(false);

  const origin = await frame.evaluate(() => `${location.origin}|${chrome.runtime.id}`);
  console.log('preview frame origin|id', origin, frame.url());

  await frame.getByTestId('copy').click();
  await expect(frame.getByTestId('preview-status')).toContainText('Copied', { timeout: 10_000 });

  const clip = await frame.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const types = items.flatMap((i) => [...i.types]);
    const blob = await items[0].getType('image/png');
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { types, w: bmp.width, h: bmp.height, red: px(200, 200), white: px(700, 120) };
  });
  expect(clip.types).toContain('image/png');
  expect(clip.w).toBeGreaterThan(800);
  expect(clip.red.slice(0, 3)).toEqual([255, 0, 0]);
  expect(clip.white.slice(0, 3)).toEqual([255, 255, 255]);
  void FIXTURE;
});
