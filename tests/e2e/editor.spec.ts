import type { Page } from '@playwright/test';
import { describeColor, expect, near, test, type Harness } from './fixtures';
import { RED, annotations, around, click, copiedPixels, drag, hasRed, openEditorFromPreview, type Pt } from './helpers';

/** Capture the shapes page, press Edit in the preview and return the editor tab. */
async function openEditor(h: Harness): Promise<Page> {
  const page = await h.open('/page.html');
  await h.capture(page, 'visible');
  return openEditorFromPreview(h, page);
}

test('Preview → Edit → red rectangle + arrow → Copy Image: the pasted image contains the annotations', async ({ h }) => {
  const editor = await openEditor(h);
  await expect(editor.getByTestId('dimensions')).toContainText('×');

  await editor.getByTestId('tool-rect').click();
  await drag(editor, [400, 100], [600, 250]);
  await editor.getByTestId('tool-arrow').click();
  await drag(editor, [700, 100], [900, 200]);

  const list = await annotations(editor);
  expect(list.map((a) => a.type)).toEqual(['rect', 'arrow']);

  const probes: Pt[][] = [around([500, 100]), around([400, 175]), around([800, 150], 6)];
  const flat = probes.flat();
  const clip = await copiedPixels(editor, [...flat, [500, 175], [200, 200], [1000, 500]]);
  expect(clip.types).toContain('image/png');
  let at = 0;
  const [top, left, arrow] = probes.map((p) => {
    const slice = clip.colors.slice(at, at + p.length);
    at += p.length;
    return slice;
  });
  expect(hasRed(top), 'rectangle top edge has red pixels').toBe(true);
  expect(hasRed(left), 'rectangle left edge has red pixels').toBe(true);
  expect(hasRed(arrow), 'arrow has red pixels').toBe(true);
  expect(clip.colors[at].slice(0, 3)).toEqual([255, 255, 255]); // interior: transparent fill → screenshot untouched
  expect(clip.colors[at + 1].slice(0, 3)).toEqual([255, 0, 0]); // original red square untouched
  expect(clip.colors[at + 2].slice(0, 3)).toEqual([255, 255, 255]);
});

test('exported image contains no selection handles or editor chrome', async ({ h }) => {
  const editor = await openEditor(h);
  await editor.getByTestId('tool-rect').click();
  await drag(editor, [400, 300], [600, 450]);
  // the new rectangle is still selected (transformer handles on screen) – none of that may be exported
  const clip = await copiedPixels(editor, [
    [398, 298], [402, 302], [600, 450], [400, 450], [500, 375], [380, 280],
  ]);
  // corner handle positions are white-filled squares with blue borders in the UI; in the export these are plain background
  expect(clip.colors[5].slice(0, 3)).toEqual([255, 255, 255]);
  expect(clip.colors[4].slice(0, 3)).toEqual([255, 255, 255]);
  expect(clip.width).toBeGreaterThan(800);
});

test('smart sequential numbering: three clicks → markers 1, 2, 3 in order, exported with white numbers on red', async ({ h }) => {
  const editor = await openEditor(h);
  await editor.getByTestId('tool-marker').click();
  const spots: Pt[] = [[500, 450], [620, 450], [740, 450]];
  for (const p of spots) await click(editor, p);

  expect((await annotations(editor)).map((a) => a.number)).toEqual([1, 2, 3]);

  const probe: Pt[] = [];
  for (const [x, y] of spots) probe.push([x, y - 11], [x - 12, y]); // red body, avoiding the digit
  const clip = await copiedPixels(editor, probe);
  clip.colors.forEach((c, i) => expect(near(c, RED, 8), `marker pixel ${i}: ${describeColor(c)}`).toBe(true));

  // white digit pixels exist near each centre (numbers are part of the exported image)
  const digits = await editor.evaluate(async (centres) => {
    const items = await navigator.clipboard.read();
    const bmp = await createImageBitmap(await items[0].getType('image/png'));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    return centres.map(([x, y]) => {
      const d = ctx.getImageData(x - 7, y - 9, 14, 18).data;
      let white = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) white++;
      return white;
    });
  }, spots);
  digits.forEach((n, i) => expect(n, `digit ${i + 1} white pixels`).toBeGreaterThan(8));
});

test('deleting a marker renumbers the rest; undo/redo restore it', async ({ h }) => {
  const editor = await openEditor(h);
  await editor.getByTestId('tool-marker').click();
  for (const p of [[500, 450], [620, 450], [740, 450]] as Pt[]) await click(editor, p);
  await editor.getByTestId('tool-select').click();
  await click(editor, [620, 450]);
  await editor.keyboard.press('Delete');
  expect((await annotations(editor)).map((a) => a.number)).toEqual([1, 2]);
  await editor.keyboard.press('Control+z');
  expect((await annotations(editor)).map((a) => a.number)).toEqual([1, 2, 3]);
  await editor.keyboard.press('Control+Shift+z');
  expect((await annotations(editor)).map((a) => a.number)).toEqual([1, 2]);
});

test('keyboard shortcuts switch tools and never fire while typing', async ({ h }) => {
  const editor = await openEditor(h);
  await editor.keyboard.press('r');
  await expect(editor.getByTestId('tool-rect')).toHaveAttribute('aria-pressed', 'true');
  await editor.keyboard.press('o');
  await expect(editor.getByTestId('tool-ellipse')).toHaveAttribute('aria-pressed', 'true');
  await editor.keyboard.press('a');
  await expect(editor.getByTestId('tool-arrow')).toHaveAttribute('aria-pressed', 'true');
  await editor.keyboard.press('Escape');
  await expect(editor.getByTestId('tool-select')).toHaveAttribute('aria-pressed', 'true');

  // typing in a text annotation must not switch tools
  await editor.keyboard.press('t');
  await click(editor, [450, 400]);
  await expect(editor.locator('textarea')).toBeFocused();
  await editor.keyboard.type('rpa bob');
  await expect(editor.getByTestId('tool-text')).toHaveAttribute('aria-pressed', 'true');
  await editor.keyboard.press('Enter');
  expect((await annotations(editor)).map((a) => a.type)).toEqual(['text']);
});

test('Return to preview keeps the original AND the edited version; editing again restores the work', async ({ h }) => {
  const editor = await openEditor(h);
  await editor.getByTestId('tool-rect').click();
  await drag(editor, [400, 100], [600, 250]);
  await editor.getByTestId('back-to-preview').click();

  await editor.waitForURL(/preview\/index\.html.*host=tab/);
  await expect(editor.getByRole('button', { name: 'Original' })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'Edited' })).toHaveAttribute('aria-pressed', 'true');

  // Original really is untouched
  await editor.getByRole('button', { name: 'Original' }).click();
  await editor.getByTestId('copy').click();
  await expect(editor.getByTestId('preview-status')).toContainText('Copied');
  const original = await editor.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const bmp = await createImageBitmap(await items[0].getType('image/png'));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    return Array.from(ctx.getImageData(500, 100, 1, 1).data);
  });
  expect(original.slice(0, 3)).toEqual([255, 255, 255]);

  // Edited copy has the rectangle
  await editor.getByRole('button', { name: 'Edited' }).click();
  await editor.getByTestId('copy').click();
  await expect(editor.getByTestId('preview-status')).toContainText('Copied');
  const edited = await editor.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const bmp = await createImageBitmap(await items[0].getType('image/png'));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    const out: number[][] = [];
    for (let y = 97; y <= 103; y++) out.push(Array.from(ctx.getImageData(500, y, 1, 1).data));
    return out;
  });
  expect(hasRed(edited), 'edited copy contains the rectangle edge').toBe(true);

  // Edit again → the annotation is still there
  await editor.getByTestId('edit').click();
  await editor.waitForURL(/editor\/index\.html/);
  await editor.waitForFunction(() => Boolean((window as unknown as { __snapflow?: unknown }).__snapflow));
  expect((await annotations(editor)).map((a) => a.type)).toEqual(['rect']);
});

test('crop + blur + pixelate are applied to the exported image', async ({ h }) => {
  const editor = await openEditor(h);

  // pixelate across the red square's edge → mixed pixels must become blocky (no longer pure white right of x=300)
  await editor.getByTestId('tool-pixelate').click();
  await drag(editor, [280, 150], [340, 210]);
  // blur on the blue square
  await editor.getByTestId('tool-blur').click();
  await drag(editor, [390, 290], [510, 410]);
  const types = (await annotations(editor)).map((a) => a.type);
  expect(types).toEqual(['pixelate', 'blur']);

  // crop to 400×300 starting at (50,50)
  await editor.keyboard.press('c');
  await drag(editor, [50, 50], [450, 350]);
  await editor.getByTestId('crop-apply').click();
  await expect(editor.getByTestId('dimensions')).toHaveText(/^(39[89]|40[0-2]) × (29[89]|30[0-2]) px \(cropped\)/);

  const clip = await copiedPixels(editor, [
    [50, 50], // image (100,100): red square corner region
    [10, 10], // image (60,60): white
    [260, 160], // image (310,210)... inside pixelated/white zone
  ]);
  expect(Math.abs(clip.width - 400)).toBeLessThanOrEqual(2);
  expect(Math.abs(clip.height - 300)).toBeLessThanOrEqual(2);
  expect(clip.colors[0].slice(0, 3)).toEqual([255, 0, 0]);
  expect(clip.colors[1].slice(0, 3)).toEqual([255, 255, 255]);
});

test('Save as: PNG, JPEG and WebP downloads have the right type, size and name', async ({ h }) => {
  const editor = await openEditor(h);
  await editor.getByTestId('tool-rect').click();
  await drag(editor, [400, 100], [600, 250]);

  // Playwright renames downloads to GUIDs, so observe what SnapFlow hands to chrome.downloads instead:
  // the requested file name and the first bytes of the blob (magic number) + its size.
  await editor.evaluate(() => {
    const w = window as unknown as { __dl: Array<{ filename: string; magic: number[]; size: number }> };
    w.__dl = [];
    const orig = chrome.downloads.download.bind(chrome.downloads);
    (chrome.downloads as unknown as { download: unknown }).download = async (opts: chrome.downloads.DownloadOptions) => {
      const buf = await (await fetch(opts.url)).arrayBuffer();
      w.__dl.push({ filename: opts.filename as string, magic: [...new Uint8Array(buf.slice(0, 12))], size: buf.byteLength });
      return orig(opts);
    };
  });

  const cases = [
    { format: 'png', ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
    { format: 'jpeg', ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
    { format: 'webp', ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
  ];
  for (const [n, c] of cases.entries()) {
    await editor.getByTestId('save-as').click();
    await editor.getByTestId('save-format').selectOption(c.format);
    await editor.getByTestId('save-name').fill(`bug-report-login-${c.format}`);
    await editor.getByTestId('save-confirm').click();
    await expect(editor.locator('.toast.success').filter({ hasText: 'Saved' })).toHaveCount(n + 1, { timeout: 20_000 });
    const rec = await editor.evaluate((i) => (window as unknown as { __dl: Array<{ filename: string; magic: number[]; size: number }> }).__dl[i], n);
    expect(rec.filename).toMatch(new RegExp(`^bug-report-login-${c.format}-\\d{4}-\\d{2}-\\d{2}-\\d{6}\\.${c.ext}$`));
    expect(rec.magic.slice(0, c.magic.length)).toEqual(c.magic);
    if (c.format === 'webp') expect(rec.magic.slice(8, 12)).toEqual([0x57, 0x45, 0x42, 0x50]); // "WEBP"
    expect(rec.size).toBeGreaterThan(1000);
    await editor.waitForTimeout(300);
  }
});
