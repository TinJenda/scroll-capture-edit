import { SnapflowError } from '@/shared/errors';
import type { TabSupport } from '@/shared/messages';

const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'microsoftedge.microsoft.com'];

/**
 * Why Chrome will not let an extension capture/script this URL (or null when it should work).
 * File URLs additionally need the user to enable "Allow access to file URLs"; that case is
 * reported when the injection actually fails.
 */
export function restrictedReason(url: string | undefined): string | null {
  if (!url) {
    return 'SnapFlow has no access to this tab yet. Click the SnapFlow toolbar icon (or use its shortcut) on the page itself.';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'This page address is not supported.';
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) {
    return 'Chrome does not allow extensions to capture browser pages (chrome://, about:, extension pages…).';
  }
  if (BLOCKED_HOSTS.includes(parsed.hostname) && (parsed.hostname !== 'chrome.google.com' || parsed.pathname.startsWith('/webstore'))) {
    return 'Chrome does not allow extensions to capture the Chrome Web Store.';
  }
  return null;
}

/** URL stripped of query string and hash, which routinely carry tokens and personal data. */
export function sanitizePageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return `file://…/${decodeURIComponent(u.pathname.split('/').pop() ?? '')}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

export async function getActiveTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (typeof tabId === 'number') {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new SnapflowError('TAB_CHANGED', 'That tab no longer exists.');
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    throw new SnapflowError('TAB_CHANGED', 'No active tab found.');
  }
  return tab;
}

export async function tabSupport(tabId?: number): Promise<TabSupport> {
  try {
    const tab = await getActiveTab(tabId);
    const reason = restrictedReason(tab.url);
    return reason ? { supported: false, reason, tabId: tab.id } : { supported: true, tabId: tab.id };
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : 'No active tab.' };
  }
}
