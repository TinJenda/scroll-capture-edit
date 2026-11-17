import { SnapflowError } from '@/shared/errors';

export type SaveResult = 'saved' | 'cancelled';

/**
 * Saves a blob through the Chrome Downloads API. The object URL is revoked as soon as the
 * download finishes (or after a generous timeout) so large screenshots never linger in memory.
 */
export async function downloadBlob(blob: Blob, filename: string, opts: { saveAs?: boolean } = {}): Promise<SaveResult> {
  const url = URL.createObjectURL(blob);
  let revoked = false;
  const revoke = () => {
    if (!revoked) {
      revoked = true;
      URL.revokeObjectURL(url);
    }
  };

  try {
    if (!chrome.downloads?.download) return fallbackAnchorDownload(url, filename, revoke);
    const id = await chrome.downloads.download({
      url,
      filename,
      saveAs: !!opts.saveAs,
      conflictAction: 'uniquify',
    });
    if (typeof id !== 'number') {
      revoke();
      return 'cancelled';
    }
    await waitForDownload(id);
    revoke();
    return 'saved';
  } catch (err) {
    revoke();
    const msg = err instanceof Error ? err.message : String(err);
    if (/cancel/i.test(msg)) return 'cancelled';
    throw new SnapflowError('UNKNOWN', `Saving failed: ${msg}`, { cause: err });
  }
}

function waitForDownload(id: number, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve(); // started fine; do not hang the UI
    }, timeoutMs);
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
      } else if (delta.state.current === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error(delta.error?.current ?? 'Download interrupted'));
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    // The download may already have finished before the listener existed.
    void chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') listener({ id, state: { current: 'complete' } } as chrome.downloads.DownloadDelta);
      else if (item?.state === 'interrupted') listener({ id, state: { current: 'interrupted' }, error: { current: item.error } } as chrome.downloads.DownloadDelta);
    });
  });
}

function fallbackAnchorDownload(url: string, filename: string, revoke: () => void): SaveResult {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(revoke, 30_000);
  return 'saved';
}
