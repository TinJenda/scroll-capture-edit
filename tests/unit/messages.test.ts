import { describe, expect, it } from 'vitest';
import { classifySender, parseAgentCommand, parseAgentEvent, parsePageRequest } from '@/shared/messages';

const ID = 'abcdefghijklmnop';

describe('message validation', () => {
  it('accepts well-formed page requests', () => {
    expect(parsePageRequest({ type: 'START_CAPTURE', mode: 'fullPage', tabId: 4 })).toEqual({ type: 'START_CAPTURE', mode: 'fullPage', tabId: 4 });
    expect(parsePageRequest({ type: 'OPEN_EDITOR', id: '515a25ae-c0ec-464d-8cdd-4dcfa7ccfba3' })).toMatchObject({ type: 'OPEN_EDITOR' });
  });
  it('rejects unknown types, bad modes, bad ids and junk', () => {
    expect(parsePageRequest({ type: 'START_CAPTURE', mode: 'rm -rf' })).toBeNull();
    expect(parsePageRequest({ type: 'START_CAPTURE', mode: 'area', tabId: -1 })).toBeNull();
    expect(parsePageRequest({ type: 'OPEN_EDITOR', id: '../../etc/passwd' })).toBeNull();
    expect(parsePageRequest({ type: 'DELETE_EVERYTHING' })).toBeNull();
    expect(parsePageRequest(null)).toBeNull();
    expect(parsePageRequest('START_CAPTURE')).toBeNull();
  });
  it('agent events need finite geometry', () => {
    const ok = { type: 'EVT_AREA_SELECTED', rect: { x: 1, y: 2, width: 3, height: 4 }, viewport: { width: 100, height: 100 }, dpr: 2 };
    expect(parseAgentEvent(ok)).toEqual(ok);
    expect(parseAgentEvent({ ...ok, rect: { x: Infinity, y: 0, width: 1, height: 1 } })).toBeNull();
    expect(parseAgentEvent({ ...ok, dpr: 0 })).toBeNull();
    expect(parseAgentEvent({ type: 'START_CAPTURE', mode: 'visible' })).toBeNull();
  });
  it('agent commands are validated too', () => {
    expect(parseAgentCommand({ type: 'AGENT_FP_SCROLL', y: 10, frame: 0, totalFrames: 3, settleMs: 100 })).not.toBeNull();
    expect(parseAgentCommand({ type: 'AGENT_FP_SCROLL', y: 'x' })).toBeNull();
    expect(parseAgentCommand({ type: 'AGENT_SHOW_PREVIEW', id: ID })).not.toBeNull();
  });
  it('separates extension pages from page-hosted content scripts by sender', () => {
    expect(classifySender({ id: 'ext', url: 'chrome-extension://ext/popup/index.html' }, 'ext')).toBe('extension-page');
    expect(classifySender({ id: 'ext', url: 'https://evil.example/', tab: { id: 1 } as chrome.tabs.Tab }, 'ext')).toBe('content-agent');
    expect(classifySender({ id: 'other', url: 'chrome-extension://other/x.html' }, 'ext')).toBe('unknown');
    expect(classifySender({ id: 'ext', url: 'https://evil.example/' }, 'ext')).toBe('unknown');
  });
});
