import { SnapflowError } from '@/shared/errors';
import { ensurePng } from './image';

/**
 * Writes a real PNG *image* to the system clipboard (not a data URL, URL or HTML).
 *
 * Must run in an extension-owned document (preview / editor). Chrome additionally requires the
 * document to be focused; callers are triggered by a click or key press, which satisfies that.
 * Resolves only after the browser confirms the write, so callers may show "Copied" safely.
 */
export async function copyImageToClipboard(source: Blob): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new SnapflowError('CLIPBOARD_UNSUPPORTED', 'This browser cannot copy images to the clipboard. Use Save instead.');
  }
  const png = await ensurePng(source);
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (err) {
    throw mapClipboardError(err);
  }
}

export function mapClipboardError(err: unknown): SnapflowError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (/focus/i.test(msg)) {
    return new SnapflowError('CLIPBOARD_NOT_FOCUSED', 'Click inside the SnapFlow window first, then copy again (Chrome only allows copying from the focused window).', { cause: err });
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new SnapflowError('CLIPBOARD_DENIED', 'Chrome blocked clipboard access. Allow clipboard access for SnapFlow, or use Save instead.', { cause: err });
  }
  return new SnapflowError('CLIPBOARD_FAILED', `Copying to the clipboard failed: ${msg}`, { cause: err });
}
