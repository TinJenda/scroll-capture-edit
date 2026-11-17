import { SnapflowError, type ErrorCode } from '@/shared/errors';
import type { PageRequest, TabSupport } from '@/shared/messages';

/** Send a validated request to the service worker; rejects with a SnapflowError on failure. */
export async function request<T = undefined>(req: PageRequest): Promise<T> {
  let reply: { ok: boolean; data?: T; error?: { code: ErrorCode; message: string } } | undefined;
  try {
    reply = await chrome.runtime.sendMessage(req);
  } catch (err) {
    throw new SnapflowError('UNKNOWN', err instanceof Error ? err.message : 'Could not reach the extension.');
  }
  if (!reply) throw new SnapflowError('UNKNOWN', 'No response from the extension. Try reloading it.');
  if (!reply.ok) throw new SnapflowError(reply.error?.code ?? 'UNKNOWN', reply.error?.message ?? 'Request failed.');
  return reply.data as T;
}

export const getTabSupport = (tabId?: number) => request<TabSupport>({ type: 'GET_TAB_SUPPORT', tabId });

export function captureIdFromUrl(): string | null {
  return new URLSearchParams(location.search).get('id');
}

/** Close the current extension tab/window (window.close() alone is unreliable for user-opened tabs). */
export async function closeThisTab(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id !== undefined) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    /* fall through */
  }
  window.close();
}
