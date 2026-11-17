import type { Page } from '@playwright/test';
import { bandColor, describeColor, expect, near, type Harness } from './fixtures';

export type Pt = [number, number];

export async function pageInfo(page: Page) {
  return page.evaluate(() => ({
    cw: document.documentElement.clientWidth,
    ch: document.documentElement.clientHeight,
    sh: document.documentElement.scrollHeight,
    iw: window.innerWidth,
    ih: window.innerHeight,
    dpr: window.devicePixelRatio,
    sy: window.scrollY,
  }));
}

/** Image-pixel sample point for a CSS-pixel position. */
export const px = (x: number, y: number, s: number): Pt => [Math.round(x * s), Math.round(y * s)];

/**
 * Checks band order and EXACT boundaries (no seams, no duplicated or missing rows) for a stack of
 * equal-height bands. `offset` is the output row (CSS px) where band 0 would start; bands first…last are checked.
 */
export async function expectBands(
  h: Harness,
  opts: { count: number; bandH: number; scale: number; offset?: number; sampleX?: number; outScale?: number; first?: number },
) {
  const { count, bandH, scale, offset = 0, sampleX = 10, first = 0 } = opts;
  const k = opts.outScale ?? scale;
  const points: Pt[] = [];
  for (let i = first; i < count; i++) points.push(px(sampleX, offset + i * bandH + bandH / 2, k));
  for (let i = first + 1; i < count; i++) {
    const yb = Math.round((offset + i * bandH) * k);
    points.push([Math.round(sampleX * k), yb - 1], [Math.round(sampleX * k), yb]);
  }
  const cap = await h.latestCapture(points);
  const n = count - first;
  const bad: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!near(cap.colors[i], bandColor(first + i), 2)) bad.push(`band ${first + i} centre ${describeColor(cap.colors[i])} ≠ ${describeColor(bandColor(first + i))}`);
  }
  for (let i = 1; i < n; i++) {
    const above = cap.colors[n + (i - 1) * 2];
    const below = cap.colors[n + (i - 1) * 2 + 1];
    if (!near(above, bandColor(first + i - 1), 2)) bad.push(`boundary ${first + i}: row above is ${describeColor(above)} not band ${first + i - 1}`);
    if (!near(below, bandColor(first + i), 2)) bad.push(`boundary ${first + i}: row below is ${describeColor(below)} not band ${first + i}`);
  }
  expect(bad, bad.slice(0, 6).join('\n')).toEqual([]);
  return cap;
}

/** Same check for a row of equal-width column bands. */
export async function expectColumns(h: Harness, opts: { count: number; bandW: number; scale: number; sampleY?: number }) {
  const { count, bandW, scale, sampleY = 40 } = opts;
  const y = Math.round(sampleY * scale);
  const points: Pt[] = [];
  for (let i = 0; i < count; i++) points.push([Math.round((i * bandW + bandW / 2) * scale), y]);
  for (let i = 1; i < count; i++) {
    const xb = Math.round(i * bandW * scale);
    points.push([xb - 1, y], [xb, y]);
  }
  const cap = await h.latestCapture(points);
  const bad: string[] = [];
  for (let i = 0; i < count; i++) {
    if (!near(cap.colors[i], bandColor(i), 2)) bad.push(`column ${i} centre ${describeColor(cap.colors[i])} ≠ ${describeColor(bandColor(i))}`);
  }
  for (let i = 1; i < count; i++) {
    if (!near(cap.colors[count + (i - 1) * 2], bandColor(i - 1), 2)) bad.push(`boundary ${i}: column left is ${describeColor(cap.colors[count + (i - 1) * 2])}`);
    if (!near(cap.colors[count + (i - 1) * 2 + 1], bandColor(i), 2)) bad.push(`boundary ${i}: column right is ${describeColor(cap.colors[count + (i - 1) * 2 + 1])}`);
  }
  expect(bad, bad.slice(0, 6).join('\n')).toEqual([]);
  return cap;
}

/* ------------------------------------------------------------------ */
/* Editor helpers                                                      */
/* ------------------------------------------------------------------ */

export const RED = [255, 59, 48];

/** From a visible preview overlay: press Edit and return the editor tab. */
export async function openEditorFromPreview(h: Harness, page: Page): Promise<Page> {
  const frame = await h.previewFrame(page);
  const opened = h.context.waitForEvent('page');
  await frame.getByTestId('edit').click();
  const editor = await opened;
  await editor.waitForSelector('[data-testid="canvas-host"] canvas', { timeout: 20_000 });
  await editor.waitForFunction(() => Boolean((window as unknown as { __snapflow?: unknown }).__snapflow));
  await editor.bringToFront();
  return editor;
}

/** Document (image) coordinates → screen coordinates inside the editor tab. */
export async function toScreen(editor: Page, pts: Pt[]): Promise<Pt[]> {
  return editor.evaluate((points) => {
    const host = (document.querySelector('[data-testid="canvas-host"]') as HTMLElement).getBoundingClientRect();
    const v = (window as unknown as { __snapflow: { canvas: { view: { zoom: number; x: number; y: number } } } }).__snapflow.canvas.view;
    return points.map(([x, y]) => [host.left + v.x + x * v.zoom, host.top + v.y + y * v.zoom] as [number, number]);
  }, pts);
}

export async function drag(editor: Page, from: Pt, to: Pt) {
  const [a, b] = await toScreen(editor, [from, to]);
  await editor.mouse.move(a[0], a[1]);
  await editor.mouse.down();
  await editor.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, { steps: 4 });
  await editor.mouse.move(b[0], b[1], { steps: 4 });
  await editor.mouse.up();
}

export async function click(editor: Page, at: Pt) {
  const [p] = await toScreen(editor, [at]);
  await editor.mouse.click(p[0], p[1]);
}

export const annotations = (editor: Page) =>
  editor.evaluate(
    () =>
      (window as unknown as { __snapflow: { store: { getState(): { history: { present: { annotations: Array<{ type: string; number?: number }> } } } } } }).__snapflow.store.getState().history.present
        .annotations,
  );

/** Click “Copy Image”, then read the real system clipboard back and sample it. */
export async function copiedPixels(editor: Page, points: Pt[]) {
  await editor.getByTestId('copy-image').click();
  await expect(editor.locator('.toast.success')).toContainText('copied', { timeout: 10_000 });
  return editor.evaluate(async (pts) => {
    const items = await navigator.clipboard.read();
    const blob = await items[0].getType('image/png');
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bmp, 0, 0);
    return {
      width: bmp.width,
      height: bmp.height,
      types: items.flatMap((i) => [...i.types]),
      colors: pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data)),
    };
  }, points);
}

/** Stroke edges are anti-aliased and the pointer maps to fractional image px, so probe a small window. */
export const around = ([x, y]: Pt, r = 2): Pt[] => {
  const out: Pt[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) out.push([x + dx, y + dy]);
  return out;
};
export const hasRed = (colors: number[][], tol = 6) => colors.some((c) => near(c, RED, tol));

/* ------------------------------------------------------------------ */
/* Scrolling-area selection helpers                                    */
/* ------------------------------------------------------------------ */

export async function dragSelect(page: Page, from: Pt, to: Pt) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 5 });
  await page.mouse.move(to[0], to[1], { steps: 5 });
  await page.mouse.up();
}

/**
 * Start "Scrolling area", drag a selection, press the given keys (A/M method, V/H/B direction,
 * 1–9 container) and confirm with Enter – exactly what a user does.
 */
export async function startScrollCapture(h: Harness, page: Page, opts: { from: Pt; to: Pt; keys?: string[]; confirm?: boolean }) {
  await h.capture(page, 'scrollArea');
  await page.waitForTimeout(350);
  await dragSelect(page, opts.from, opts.to);
  await page.waitForTimeout(400); // detection runs when the drag ends
  for (const k of opts.keys ?? []) {
    await page.keyboard.press(k);
    await page.waitForTimeout(100);
  }
  if (opts.confirm !== false) await page.keyboard.press('Enter');
}
