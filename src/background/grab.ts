import { blobToBitmap, dataUrlToBlob } from '@/core/image';
import { MIN_CAPTURE_INTERVAL_MS } from '@/shared/constants';
import { classifyChromeError, SnapflowError } from '@/shared/errors';

let lastCaptureAt = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Grabbed {
  blob: Blob;
  bitmap: ImageBitmap;
}

/**
 * One call to chrome.tabs.captureVisibleTab, rate-limited (Chrome allows ~2 per second),
 * retried on quota errors, and guarded so we never grab the wrong tab if the user switched.
 */
export async function grabVisibleTab(windowId: number, tabId: number): Promise<Grabbed> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastCaptureAt + MIN_CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new SnapflowError('TAB_CHANGED', 'The tab was closed during capture.');
    }
    if (!tab.active || tab.windowId !== windowId) {
      throw new SnapflowError('TAB_CHANGED', 'You switched tabs during capture. Keep the page in front until it finishes.');
    }

    lastCaptureAt = Date.now();
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const blob = await dataUrlToBlob(dataUrl);
      const bitmap = await blobToBitmap(blob);
      return { blob, bitmap };
    } catch (err) {
      console.warn('[snapflow] captureVisibleTab failed:', err instanceof Error ? err.message : err);
      const c = classifyChromeError(err);
      if (c.code === 'RATE_LIMIT' && attempt < 4) {
        await sleep(MIN_CAPTURE_INTERVAL_MS * (attempt + 1));
        continue;
      }
      throw err instanceof SnapflowError ? err : new SnapflowError(c.code, c.message, { cause: err });
    }
  }
}

export function resetThrottleForTests(): void {
  lastCaptureAt = 0;
}
