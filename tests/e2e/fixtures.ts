import { test as base, chromium, expect, type BrowserContext, type Frame, type Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export { expect };

export const FIXTURE = 'http://127.0.0.1:4173';
const EXT_PATH = path.resolve(process.env.SNAPFLOW_EXT ?? 'dist-e2e');

export interface Env {
  scaleFactor: number;
  width: number;
  height: number;
}

export interface Harness {
  context: BrowserContext;
  extId: string;
  /** An extension page kept open in the background; used to send messages as an extension page. */
  helper: Page;
  open(pathAndQuery: string): Promise<Page>;
  /** Chrome tab id of a page. */
  tabId(page: Page): Promise<number>;
  /** Discard a capture in progress (what the "Discard" button in the progress pill does). */
  discard(page: Page): Promise<void>;
  /** Start a capture on the page like the popup would. */
  capture(page: Page, mode: 'visible' | 'area' | 'fullPage' | 'scrollArea' | 'element'): Promise<void>;
  /** Wait for the in-page preview overlay iframe and return its frame. */
  previewFrame(page: Page): Promise<Frame>;
  /** Latest capture saved in IndexedDB, sampled at the given image-pixel points. */
  latestCapture(points?: Array<[number, number]>): Promise<CaptureSample>;
}

export interface CaptureSample {
  id: string;
  width: number;
  height: number;
  scale: number;
  warnings: Array<{ code: string; message: string }>;
  mode: string;
  colors: Array<[number, number, number, number]>;
}

export const test = base.extend<{ env: Env; h: Harness }>({
  env: [{ scaleFactor: 1, width: 1280, height: 800 }, { option: true }],
  h: async ({ env }, use) => {
    const exe = process.env.SNAPFLOW_CHROMIUM;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapflow-e2e-'));
    // Branded Chrome (137+) ignores --load-extension, so the extension is loaded through the
    // DevTools protocol instead, which is also how current stable Chrome is meant to be driven.
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(exe ? { executablePath: exe } : { channel: (process.env.SNAPFLOW_CHANNEL ?? 'chrome') as 'chrome' }),
      headless: process.env.HEADED ? false : true,
      viewport: null,
      ignoreDefaultArgs: ['--disable-extensions', '--hide-scrollbars'],
      args: [
        '--enable-unsafe-extension-debugging',
        `--window-size=${env.width},${env.height}`,
        `--force-device-scale-factor=${env.scaleFactor}`,
        '--no-first-run',
        '--disable-search-engine-choice-screen',
      ],
    });
    if (process.env.SNAPFLOW_DEBUG) {
      const hook = (w: import('@playwright/test').Worker) => w.on('console', (m) => console.log('[sw]', m.type(), m.text()));
      context.serviceWorkers().forEach(hook);
      context.on('serviceworker', hook);
      context.on('console', (m) => console.log('[page]', m.type(), m.text()));
      context.on('weberror', (e) => console.log('[weberror]', e.error().message));
    }
    const browserSession = await (context.browser() as NonNullable<ReturnType<BrowserContext['browser']>>).newBrowserCDPSession();
    const { id: extId } = (await browserSession.send('Extensions.loadUnpacked' as never, { path: EXT_PATH } as never)) as unknown as { id: string };

    const helper = await context.newPage();
    await helper.goto(`chrome-extension://${extId}/options/index.html`);

    const tabIdFor = async (page: Page): Promise<number> => {
      const url = page.url();
      const id = await helper.evaluate(async (u) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((t) => t.url === u)?.id ?? -1;
      }, url);
      if (id < 0) throw new Error(`tab not found for ${url}`);
      return id;
    };

    const harness: Harness = {
      context,
      extId,
      helper,
      async open(p) {
        const page = await context.newPage();
        await page.goto(`${FIXTURE}${p}`);
        await page.bringToFront();
        return page;
      },
      tabId: (page) => tabIdFor(page),
      async discard(page) {
        const id = await tabIdFor(page);
        await helper.evaluate(async (t) => chrome.runtime.sendMessage({ type: 'CANCEL_CAPTURE', tabId: t }), id);
      },
      async capture(page, mode) {
        await page.bringToFront();
        const tabId = await tabIdFor(page);
        const reply = await helper.evaluate(
          async ([m, id]) => chrome.runtime.sendMessage({ type: 'START_CAPTURE', mode: m, tabId: id }),
          [mode, tabId] as const,
        );
        if (!reply?.ok) throw new Error(`START_CAPTURE failed: ${JSON.stringify(reply)}`);
      },
      async previewFrame(page) {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const f = page.frames().find((fr) => fr.url().includes('/preview/index.html'));
          if (f) {
            await f.waitForSelector('[data-testid="preview-image"]', { timeout: 20_000 });
            await page.waitForTimeout(450); // let the card's slide-in animation finish so clicks land on the buttons
            return f;
          }
          await page.waitForTimeout(150);
        }
        throw new Error('preview overlay did not appear');
      },
      async latestCapture(points = []) {
        return helper.evaluate(async (pts) => {
          const db: IDBDatabase = await new Promise((res, rej) => {
            const r = indexedDB.open('snapflow');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          const all: Array<{ id: string; createdAt: number; width: number; height: number; blob: Blob; meta: { scale: number; mode: string; warnings: Array<{ code: string; message: string }> } }> = await new Promise((res, rej) => {
            const r = db.transaction('captures').objectStore('captures').getAll();
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
          });
          db.close();
          all.sort((a, b) => b.createdAt - a.createdAt);
          const rec = all[0];
          if (!rec) throw new Error('no capture stored');
          const bmp = await createImageBitmap(rec.blob);
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bmp, 0, 0);
          const colors = pts.map(([x, y]) => {
            const d = ctx.getImageData(Math.max(0, Math.min(bmp.width - 1, x)), Math.max(0, Math.min(bmp.height - 1, y)), 1, 1).data;
            return [d[0], d[1], d[2], d[3]] as [number, number, number, number];
          });
          return {
            id: rec.id,
            width: bmp.width,
            height: bmp.height,
            scale: rec.meta.scale,
            warnings: rec.meta.warnings,
            mode: rec.meta.mode,
            colors,
          };
        }, points);
      },
    };

    await use(harness);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },
});

/** Mirror of the colour generator used by the fixture pages. */
export const bandColor = (i: number): [number, number, number] => [(i * 6) % 256, (((255 - i * 6) % 256) + 256) % 256, (i * 37) % 256];

export function near(actual: ArrayLike<number>, expected: ArrayLike<number>, tol = 3): boolean {
  for (let i = 0; i < 3; i++) if (Math.abs(actual[i] - expected[i]) > tol) return false;
  return true;
}

export const describeColor = (c: ArrayLike<number>) => `rgb(${c[0]},${c[1]},${c[2]})`;
