import { cropBitmapToBlob, makeThumbnail } from '@/core/image';
import { newCaptureId, patchCapture, purgeCaptures, putCapture, deleteCapture, getCapture } from '@/shared/captures';
import { EDITOR_PATH, HISTORY_PATH, OPTIONS_PATH, PREVIEW_PATH } from '@/shared/constants';
import { classifyChromeError, SnapflowError, serializeError } from '@/shared/errors';
import { cssRectToImageRect, resolveScale } from '@/shared/geometry';
import type { AgentEvent, ViewportInfo } from '@/shared/messages';
import { loadSettings } from '@/shared/settings';
import type { CaptureMeta, CaptureMode, CaptureRecord, CaptureWarning, ScrollDirection, Size } from '@/shared/types';
import { agentCall, agentTry, injectAgent } from './agent';
import { captureScrolling } from './scrolling-engine';
import { grabVisibleTab } from './grab';
import { getActiveTab, restrictedReason, sanitizePageUrl } from './tabs';

/** What we need to remember between "user started a capture" and "user finished selecting". */
interface Session {
  tabId: number;
  windowId: number;
  mode: CaptureMode;
  startedAt: number;
  pageUrl?: string;
  pageTitle?: string;
}

const SESSIONS_KEY = 'snapflow:sessions';
const running = new Map<number, { cancelled: boolean; stopped: boolean }>();

/* ------------------------------------------------------------------ */
/* Session persistence (chrome.storage.session survives worker restarts) */
/* ------------------------------------------------------------------ */

async function readSessions(): Promise<Record<string, Session>> {
  const stored = await chrome.storage.session.get(SESSIONS_KEY);
  return (stored[SESSIONS_KEY] as Record<string, Session> | undefined) ?? {};
}

async function writeSessions(sessions: Record<string, Session>): Promise<void> {
  await chrome.storage.session.set({ [SESSIONS_KEY]: sessions });
}

async function saveSession(session: Session): Promise<void> {
  const all = await readSessions();
  all[String(session.tabId)] = session;
  await writeSessions(all);
}

async function takeSession(tabId: number): Promise<Session | undefined> {
  const all = await readSessions();
  const s = all[String(tabId)];
  if (s) {
    delete all[String(tabId)];
    await writeSessions(all);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

async function setBadge(tabId: number, text: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#4f6df5', tabId });
    await chrome.action.setBadgeText({ text, tabId });
  } catch {
    /* tab gone */
  }
}

async function reportFailure(tabId: number, err: unknown): Promise<void> {
  const e = serializeError(err);
  if (e.code === 'CANCELLED') {
    await agentTry(tabId, { type: 'AGENT_CANCEL_UI' });
    return;
  }
  console.error('[snapflow] capture failed:', e.code, e.message, err);
  const shown = await agentTry(tabId, { type: 'AGENT_TOAST', text: e.message, kind: 'error' });
  if (!shown) {
    // No agent on the page (restricted page): fall back to the toolbar badge.
    await chrome.action.setBadgeBackgroundColor({ color: '#d92d20', tabId }).catch(() => undefined);
    await chrome.action.setBadgeText({ text: '!', tabId }).catch(() => undefined);
    await chrome.action.setTitle({ title: `SnapFlow: ${e.message}`, tabId }).catch(() => undefined);
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: '', tabId }).catch(() => undefined);
      void chrome.action.setTitle({ title: 'SnapFlow – capture a screenshot', tabId }).catch(() => undefined);
    }, 8000);
  }
}

/* ------------------------------------------------------------------ */
/* Finalizing: store the capture and present the preview               */
/* ------------------------------------------------------------------ */

interface Finished {
  blob: Blob;
  width: number;
  height: number;
  scale: number;
  viewport: Size;
  warnings?: CaptureWarning[];
}

async function finalize(session: Session, done: Finished): Promise<void> {
  const settings = await loadSettings();
  const meta: CaptureMeta = {
    mode: session.mode,
    tabId: session.tabId,
    windowId: session.windowId,
    pageUrl: session.pageUrl,
    pageTitle: session.pageTitle?.slice(0, 200),
    scale: done.scale,
    viewport: done.viewport,
    warnings: done.warnings ?? [],
  };
  const record: CaptureRecord = {
    id: newCaptureId(),
    createdAt: Date.now(),
    width: done.width,
    height: done.height,
    blob: done.blob,
    meta,
    keep: settings.historyEnabled,
  };
  if (settings.historyEnabled) {
    try {
      record.thumb = await makeThumbnail(done.blob, done.width, done.height);
    } catch (err) {
      console.error('[snapflow] thumbnail failed', err);
    }
  }
  await putCapture(record);
  void purgeCaptures({
    historyLimit: settings.historyLimit,
    historyMaxBytes: settings.historyMaxMB * 1024 * 1024,
  }).catch(() => undefined);
  await showPreview(session.tabId, record.id);
}

async function showPreview(tabId: number, captureId: string): Promise<void> {
  try {
    const alive = await agentTry(tabId, { type: 'AGENT_PING' });
    if (!alive) await injectAgent(tabId);
    await agentCall(tabId, { type: 'AGENT_SHOW_PREVIEW', id: captureId });
    await chrome.action.setBadgeText({ text: '', tabId }).catch(() => undefined);
  } catch {
    // Pages we cannot inject into (PDF viewer…): show the preview in its own window instead.
    await chrome.windows.create({
      url: chrome.runtime.getURL(`${PREVIEW_PATH}?id=${captureId}&host=window`),
      type: 'popup',
      width: 980,
      height: 760,
      focused: true,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Capture modes                                                       */
/* ------------------------------------------------------------------ */

async function runVisible(session: Session, agentPresent: boolean): Promise<void> {
  let info: ViewportInfo | undefined;
  if (agentPresent) info = await agentCall<ViewportInfo>(session.tabId, { type: 'AGENT_HIDE_UI' }).catch(() => undefined);
  const { bitmap, blob } = await grabVisibleTab(session.windowId, session.tabId);
  try {
    const viewport = info?.viewport ?? { width: bitmap.width, height: bitmap.height };
    const scale = info ? resolveScale(bitmap.width, info.viewport.width, info.dpr) : 1;
    await finalize(session, { blob, width: bitmap.width, height: bitmap.height, scale, viewport });
  } finally {
    bitmap.close();
  }
}

type RegionEvent = Extract<AgentEvent, { type: 'EVT_AREA_SELECTED' | 'EVT_ELEMENT_PICKED' }>;

async function runRegion(session: Session, rect: RegionEvent): Promise<void> {
  const { bitmap } = await grabVisibleTab(session.windowId, session.tabId);
  try {
    const k = resolveScale(bitmap.width, rect.viewport.width, rect.dpr);
    const scale = { x: k, y: k };
    const px = cssRectToImageRect(rect.rect, scale, bitmap);
    if (!px) throw new SnapflowError('CAPTURE_FAILED', 'The selected area is outside the visible page.');
    const blob = await cropBitmapToBlob(bitmap, px);
    await finalize(session, { blob, width: px.width, height: px.height, scale: scale.x, viewport: rect.viewport });
  } finally {
    bitmap.close();
  }
}

async function runScrolling(
  session: Session,
  target: 'document' | 'picked' | 'region',
  direction: ScrollDirection = 'vertical',
): Promise<void> {
  const run = running.get(session.tabId) ?? { cancelled: false, stopped: false };
  running.set(session.tabId, run);
  const settings = await loadSettings();
  try {
    const result = await captureScrolling({
      tabId: session.tabId,
      windowId: session.windowId,
      target,
      direction,
      settleMs: settings.settleMs,
      isCancelled: () => run.cancelled,
      shouldStop: () => run.stopped,
      onProgress: (frame, total) => void setBadge(session.tabId, `${Math.min(frame + 1, total)}/${total}`),
    });
    await finalize(session, result);
  } finally {
    running.delete(session.tabId);
    await chrome.action.setBadgeText({ text: '', tabId: session.tabId }).catch(() => undefined);
  }
}

/** Runs `fn`, converting any failure into user feedback instead of an unhandled rejection. */
async function guarded(session: Session, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await reportFailure(session.tabId, err);
  }
}

/* ------------------------------------------------------------------ */
/* Public API used by the message router                               */
/* ------------------------------------------------------------------ */

/**
 * Validates the tab, injects the agent and launches the requested capture. Resolves as soon as the
 * capture has *started* (so the popup can close); long-running work continues in the background.
 */
export async function startCapture(mode: CaptureMode, requestedTabId?: number): Promise<void> {
  const tab = await getActiveTab(requestedTabId);
  const tabId = tab.id as number;
  const reason = restrictedReason(tab.url);
  if (reason) throw new SnapflowError('RESTRICTED_PAGE', reason);
  if (running.has(tabId)) {
    throw new SnapflowError('CAPTURE_FAILED', 'A full-page capture is already running on this tab. Press Esc on the page to cancel it.');
  }

  const session: Session = {
    tabId,
    windowId: tab.windowId,
    mode,
    startedAt: Date.now(),
    pageUrl: sanitizePageUrl(tab.url),
    pageTitle: tab.title,
  };

  let agentPresent = true;
  try {
    await injectAgent(tabId);
  } catch (err) {
    if (mode !== 'visible') throw err; // visible capture also works where scripts cannot run (PDF viewer)
    agentPresent = false;
  }

  switch (mode) {
    case 'visible':
      void guarded(session, () => runVisible(session, agentPresent));
      break;
    case 'area':
      await saveSession(session);
      await agentCall(tabId, { type: 'AGENT_SELECT_AREA' });
      break;
    case 'element':
      await saveSession(session);
      await agentCall(tabId, { type: 'AGENT_PICK_ELEMENT' });
      break;
    case 'fullPage':
      running.set(tabId, { cancelled: false, stopped: false });
      void guarded(session, () => runScrolling(session, 'document'));
      break;
    case 'scrollArea':
      await saveSession(session);
      await agentCall(tabId, { type: 'AGENT_SELECT_SCROLL_AREA' });
      break;
  }
}

export async function handleAgentEvent(evt: AgentEvent, tabId: number): Promise<void> {
  switch (evt.type) {
    case 'EVT_AREA_SELECTED': {
      const session = await takeSession(tabId);
      if (session) await guarded(session, () => runRegion(session, evt));
      return;
    }
    case 'EVT_ELEMENT_PICKED': {
      const session = await takeSession(tabId);
      if (!session) return;
      if (evt.fullContent) await guarded(session, () => runScrolling(session, 'picked'));
      else await guarded(session, () => runRegion(session, evt));
      return;
    }
    case 'EVT_SCROLL_AREA_SELECTED': {
      const session = await takeSession(tabId);
      if (session) await guarded(session, () => runScrolling(session, evt.target, evt.direction));
      return;
    }
    case 'EVT_CAPTURE_ABORT': {
      await takeSession(tabId);
      if (evt.reason === 'error' && evt.message) {
        await agentTry(tabId, { type: 'AGENT_TOAST', text: evt.message, kind: 'error' });
      }
      return;
    }
    case 'EVT_CANCEL_FULLPAGE':
      cancelCapture(tabId);
      return;
    case 'EVT_STOP_FULLPAGE':
      stopCapture(tabId);
      return;
  }
}

/** Esc during a scrolling capture: stop scrolling and keep what has been captured so far. */
export function stopCapture(tabId: number): void {
  const run = running.get(tabId);
  if (run) run.stopped = true;
}

export function cancelCapture(tabId: number): void {
  const run = running.get(tabId);
  if (run) run.cancelled = true;
  void takeSession(tabId);
}

/* ------------------------------------------------------------------ */
/* Stored captures: editor / preview / recapture / discard             */
/* ------------------------------------------------------------------ */

export async function openEditor(id: string, sender: chrome.runtime.MessageSender): Promise<void> {
  const record = await getCapture(id);
  if (!record) throw new SnapflowError('NOT_FOUND', 'That screenshot is no longer available.');
  await patchCapture(id, { editorOpened: true });
  const url = chrome.runtime.getURL(`${EDITOR_PATH}?id=${id}`);
  const tabHosted = sender.url?.includes('host=tab') && typeof sender.tab?.id === 'number';
  if (tabHosted) {
    await chrome.tabs.update(sender.tab!.id as number, { url });
  } else {
    await chrome.tabs.create({ url, index: sender.tab ? sender.tab.index + 1 : undefined, active: true });
  }
}

export async function openPreviewTab(id: string): Promise<void> {
  const record = await getCapture(id);
  if (!record) throw new SnapflowError('NOT_FOUND', 'That screenshot is no longer available.');
  await chrome.tabs.create({ url: chrome.runtime.getURL(`${PREVIEW_PATH}?id=${id}&host=tab`), active: true });
}

export async function openExtensionPage(path: string): Promise<void> {
  const url = chrome.runtime.getURL(path);
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

export const openHistory = () => openExtensionPage(HISTORY_PATH);
export const openSettings = () => openExtensionPage(OPTIONS_PATH);
export const openShortcuts = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

/** Re-run the original capture mode on the tab the screenshot came from. */
export async function recapture(id: string, sender: chrome.runtime.MessageSender): Promise<void> {
  const record = await getCapture(id);
  if (!record) throw new SnapflowError('NOT_FOUND', 'That screenshot is no longer available.');
  const { tabId, windowId, mode } = record.meta;
  if (typeof tabId !== 'number') throw new SnapflowError('TAB_CHANGED', 'The original tab is unknown.');
  try {
    await chrome.tabs.get(tabId);
  } catch {
    throw new SnapflowError('TAB_CHANGED', 'The original tab was closed, so it cannot be captured again. Open the page and capture it from the toolbar.');
  }
  await chrome.tabs.update(tabId, { active: true });
  if (typeof windowId === 'number') await chrome.windows.update(windowId, { focused: true }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 350));
  try {
    await startCapture(mode, tabId);
  } catch (err) {
    const c = classifyChromeError(err);
    throw new SnapflowError(c.code, c.message);
  }
  // Retaking replaces the editor/preview tab that asked for it.
  const senderTab = sender.tab?.id;
  if (typeof senderTab === 'number' && senderTab !== tabId && sender.url?.startsWith('chrome-extension://')) {
    await chrome.tabs.remove(senderTab).catch(() => undefined);
  }
}

/** Delete a transient capture (history captures and ones opened in the editor are kept). */
export async function discardCapture(id: string): Promise<void> {
  const record = await getCapture(id);
  if (record && !record.keep && !record.editorOpened) await deleteCapture(id);
}

export async function purgeOnStartup(): Promise<void> {
  const s = await loadSettings();
  await purgeCaptures({ historyLimit: s.historyLimit, historyMaxBytes: s.historyMaxMB * 1024 * 1024 });
}
