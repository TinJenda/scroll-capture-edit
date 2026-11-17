/**
 * SnapFlow service worker: validates messages, routes toolbar/shortcut commands and
 * delegates to the capture orchestrator. Holds no long-lived state (it can be killed at any time).
 */
import { serializeError, SnapflowError } from '@/shared/errors';
import {
  classifySender,
  parseAgentEvent,
  parsePageRequest,
  type PageRequest,
  type Reply,
  type TabSupport,
} from '@/shared/messages';
import type { CaptureMode } from '@/shared/types';
import {
  cancelCapture,
  discardCapture,
  handleAgentEvent,
  openEditor,
  openHistory,
  openPreviewTab,
  openSettings,
  openShortcuts,
  purgeOnStartup,
  recapture,
  startCapture,
} from './capture';
import { tabSupport } from './tabs';

const COMMAND_MODES: Record<string, CaptureMode> = {
  'capture-visible': 'visible',
  'capture-area': 'area',
  'capture-full-page': 'fullPage',
  'capture-scroll-area': 'scrollArea',
  'capture-element': 'element',
};

async function handlePageRequest(req: PageRequest, sender: chrome.runtime.MessageSender): Promise<Reply<TabSupport | undefined>> {
  switch (req.type) {
    case 'START_CAPTURE': {
      // The preview overlay is an iframe (frameId > 0) inside the page being captured; popups have no tab.
      const overlayTab = sender.frameId !== undefined && sender.frameId > 0 ? sender.tab?.id : undefined;
      await startCapture(req.mode, req.tabId ?? overlayTab);
      return { ok: true };
    }
    case 'GET_TAB_SUPPORT':
      return { ok: true, data: await tabSupport(req.tabId) };
    case 'CANCEL_CAPTURE': {
      const id = req.tabId ?? sender.tab?.id;
      if (typeof id === 'number') cancelCapture(id);
      return { ok: true };
    }
    case 'OPEN_EDITOR':
      await openEditor(req.id, sender);
      return { ok: true };
    case 'OPEN_PREVIEW':
      await openPreviewTab(req.id);
      return { ok: true };
    case 'RECAPTURE':
      await recapture(req.id, sender);
      return { ok: true };
    case 'DISCARD_CAPTURE':
      await discardCapture(req.id);
      return { ok: true };
    case 'OPEN_HISTORY':
      await openHistory();
      return { ok: true };
    case 'OPEN_SETTINGS':
      await openSettings();
      return { ok: true };
    case 'OPEN_SHORTCUTS':
      await openShortcuts();
      return { ok: true };
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  const kind = classifySender(sender, chrome.runtime.id);

  if (kind === 'extension-page') {
    const req = parsePageRequest(raw);
    if (!req) {
      sendResponse({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Unrecognised request.' } });
      return false;
    }
    handlePageRequest(req, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: serializeError(err) }));
    return true;
  }

  if (kind === 'content-agent') {
    const evt = parseAgentEvent(raw);
    const tabId = sender.tab?.id;
    if (evt && typeof tabId === 'number') {
      void handleAgentEvent(evt, tabId).catch((err) => console.error('[snapflow] agent event failed', err));
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Unrecognised event.' } });
    }
    return false;
  }

  sendResponse({ ok: false, error: { code: 'INVALID_REQUEST', message: 'Sender not allowed.' } });
  return false;
});

// The content agent keeps a port open during a full-page capture; if this worker dies the port
// closes and the page restores itself. Accepting the connection is all that is needed here.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'snapflow-fullpage' || port.sender?.id !== chrome.runtime.id) port.disconnect();
});

chrome.commands.onCommand.addListener((command, tab) => {
  const mode = COMMAND_MODES[command];
  if (!mode) return;
  startCapture(mode, tab?.id).catch((err) => {
    const e = serializeError(err instanceof SnapflowError ? err : err);
    console.error('[snapflow] command failed:', e.message);
    if (typeof tab?.id === 'number') {
      void chrome.action.setBadgeBackgroundColor({ color: '#d92d20', tabId: tab.id });
      void chrome.action.setBadgeText({ text: '!', tabId: tab.id });
      void chrome.action.setTitle({ title: `SnapFlow: ${e.message}`, tabId: tab.id });
      setTimeout(() => void chrome.action.setBadgeText({ text: '', tabId: tab.id as number }), 8000);
    }
  });
});

chrome.runtime.onStartup.addListener(() => void purgeOnStartup().catch(() => undefined));
chrome.runtime.onInstalled.addListener(() => void purgeOnStartup().catch(() => undefined));
