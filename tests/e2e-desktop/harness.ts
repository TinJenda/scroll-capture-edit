import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export { expect };

export const FIXTURE = 'http://127.0.0.1:4173';
const APP_DIR = path.resolve('dist-desktop-e2e');

export type Rgb = [number, number, number, number];

export const bandColor = (i: number): [number, number, number] => [(i * 6) % 256, (((255 - i * 6) % 256) + 256) % 256, (i * 37) % 256];
export const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 3) => [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) <= tol);
export const describe = (c: ArrayLike<number>) => `rgb(${c[0]},${c[1]},${c[2]})`;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureSample {
  id: string;
  width: number;
  height: number;
  scale: number;
  mode: string;
  title?: string;
  warnings: Array<{ code: string; message: string }>;
  colors: Rgb[];
}

export interface Desktop {
  app: ElectronApplication;
  downloads: string;
  scale: number;
  /** Opens a fixture page in a plain top-most window and returns its content area (DIP). */
  fixture(pathAndQuery: string, size?: { width: number; height: number }): Promise<Bounds>;
  /** Interactive entry points of the app (what the tray / hotkeys call). */
  startFromLauncher(label: string): Promise<void>;
  /** Capture a rectangle without the selection overlay. Resolves when the preview is shown. */
  captureRect(mode: 'region' | 'scrolling', rect: Bounds): Promise<boolean>;
  page(part: string): Promise<Page>;
  /** Newest stored capture, sampled at the given image-pixel points. */
  latest(points?: Array<[number, number]>): Promise<CaptureSample>;
}

export const test = base.extend<{ d: Desktop }>({
  d: async ({}, use) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-desktop-'));
    const downloads = path.join(base, 'downloads');
    fs.mkdirSync(downloads);
    // SNAPFLOW_EXE: run the suite against the packaged executable instead of `electron dist-desktop-e2e`.
    const exe = process.env.SNAPFLOW_EXE;
    const app = await electron.launch({
      ...(exe ? { executablePath: path.resolve(exe), args: [] } : { args: [APP_DIR] }),
      env: { ...process.env, SNAPFLOW_TEST: '1', SNAPFLOW_USER_DATA: path.join(base, 'user'), SNAPFLOW_DOWNLOADS: downloads },
    });
    for (let i = 0; i < 100; i++) {
      if (await app.evaluate(() => !!(globalThis as Record<string, unknown>).__snapflowTest)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const scale = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor);

    const find = (part: string) => app.windows().find((w) => w.url().includes(part));
    const page = async (part: string): Promise<Page> => {
      const existing = find(part);
      if (existing) return existing;
      return app.waitForEvent('window', { predicate: (w) => w.url().includes(part), timeout: 30_000 });
    };

    const d: Desktop = {
      app,
      downloads,
      scale,
      fixture: (pathAndQuery, size = { width: 900, height: 700 }) =>
        app.evaluate((_e, a) => (globalThis as any).__snapflowTest.fixture(a.url, a.size), { url: FIXTURE + pathAndQuery, size }),
      captureRect: (mode, rect) => app.evaluate((_e, a) => (globalThis as any).__snapflowTest.captureRect(a.mode, a.rect), { mode, rect }),
      startFromLauncher: async (label) => {
        const launcher = await page('/launcher/');
        await launcher.locator('.tile', { has: launcher.locator('strong', { hasText: new RegExp('^' + label + '$') }) }).click();
      },
      page,
      latest: async (points = []) => {
        const hub = await page('/hub/');
        return hub.evaluate(async (pts) => {
          const db: IDBDatabase = await new Promise((res, rej) => {
            const r = indexedDB.open('snapflow');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          const all: any[] = await new Promise((res) => {
            const r = db.transaction('captures').objectStore('captures').getAll();
            r.onsuccess = () => res(r.result);
          });
          all.sort((a, b) => b.createdAt - a.createdAt);
          const rec = all[0];
          if (!rec) throw new Error('no capture stored');
          const bmp = await createImageBitmap(rec.blob);
          const canvas = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bmp, 0, 0);
          const colors = pts.map(([x, y]) => Array.from(ctx.getImageData(Math.min(x, bmp.width - 1), Math.min(y, bmp.height - 1), 1, 1).data));
          return {
            id: rec.id,
            width: bmp.width,
            height: bmp.height,
            scale: rec.meta.scale,
            mode: rec.meta.mode,
            title: rec.meta.pageTitle,
            warnings: rec.meta.warnings,
            colors,
          };
        }, points) as Promise<CaptureSample>;
      },
    };
    await use(d);
    await app.evaluate(() => (globalThis as any).__snapflowTest.closeFixtures()).catch(() => undefined);
    await app.close().catch(() => undefined);
    fs.rmSync(base, { recursive: true, force: true });
  },
});

/** Band order and EXACT boundaries for a stack of equal-height bands (no seam, no duplicate, no missing row). */
export async function expectBands(
  d: Desktop,
  opts: { first?: number; count: number; bandH: number; offset?: number; sampleX?: number },
) {
  const { first = 0, count, bandH, offset = 0, sampleX = 10 } = opts;
  const k = d.scale;
  const sx = Math.round(sampleX * k);
  const points: Array<[number, number]> = [];
  for (let i = first; i < count; i++) points.push([sx, Math.round((offset + i * bandH + bandH / 2) * k)]);
  for (let i = first + 1; i < count; i++) {
    const yb = Math.round((offset + i * bandH) * k);
    points.push([sx, yb - 1], [sx, yb]);
  }
  const cap = await d.latest(points);
  const n = count - first;
  const bad: string[] = [];
  for (let i = 0; i < n; i++) {
    if (!near(cap.colors[i], bandColor(first + i))) bad.push(`band ${first + i} centre ${describe(cap.colors[i])} ≠ ${describe(bandColor(first + i))}`);
  }
  for (let i = 1; i < n; i++) {
    const above = cap.colors[n + (i - 1) * 2];
    const below = cap.colors[n + (i - 1) * 2 + 1];
    if (!near(above, bandColor(first + i - 1))) bad.push(`boundary ${first + i}: row above is ${describe(above)}, not band ${first + i - 1}`);
    if (!near(below, bandColor(first + i))) bad.push(`boundary ${first + i}: row below is ${describe(below)}, not band ${first + i}`);
  }
  expect(bad, bad.slice(0, 6).join('\n')).toEqual([]);
  return cap;
}
