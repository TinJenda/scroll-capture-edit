import type { SerializedError } from './errors';
import type { CaptureMode, Rect, ScrollDirection, Size } from './types';

/* ------------------------------------------------------------------ */
/* Requests handled by the service worker                              */
/* ------------------------------------------------------------------ */

/** Sent by extension pages (popup, preview, editor, options, history). */
export type PageRequest =
  | { type: 'START_CAPTURE'; mode: CaptureMode; tabId?: number }
  | { type: 'GET_TAB_SUPPORT'; tabId?: number }
  | { type: 'OPEN_EDITOR'; id: string }
  | { type: 'OPEN_PREVIEW'; id: string }
  | { type: 'RECAPTURE'; id: string }
  | { type: 'DISCARD_CAPTURE'; id: string }
  | { type: 'OPEN_HISTORY' }
  | { type: 'OPEN_SETTINGS' }
  | { type: 'OPEN_SHORTCUTS' }
  | { type: 'CANCEL_CAPTURE'; tabId?: number };

/** Sent by the content agent running inside a web page. */
export type AgentEvent =
  | { type: 'EVT_AREA_SELECTED'; rect: Rect; viewport: Size; dpr: number }
  | { type: 'EVT_ELEMENT_PICKED'; rect: Rect; viewport: Size; dpr: number; fullContent: boolean }
  | { type: 'EVT_SCROLL_AREA_SELECTED'; target: FullPageTarget; direction: ScrollDirection; viewport: Size; dpr: number }
  | { type: 'EVT_CAPTURE_ABORT'; reason: 'cancelled' | 'error'; message?: string }
  /** Discard the capture in progress. */
  | { type: 'EVT_CANCEL_FULLPAGE' }
  /** Stop scrolling now and keep what has been captured so far (Esc during a scrolling capture). */
  | { type: 'EVT_STOP_FULLPAGE' };

export type BackgroundMessage = PageRequest | AgentEvent;

export type Reply<T = void> = { ok: true; data?: T } | { ok: false; error: SerializedError };

export interface TabSupport {
  supported: boolean;
  reason?: string;
  tabId?: number;
}

/* ------------------------------------------------------------------ */
/* Commands the service worker sends to the content agent               */
/* ------------------------------------------------------------------ */

/**
 * What scrolls during a scrolling capture:
 *  - 'document': the page itself (full page)
 *  - 'picked':   the container the agent remembered (element capture or auto-detected scroll container)
 *  - 'region':   a rectangle fixed to the viewport while the document scrolls (manual region)
 */
export type FullPageTarget = 'document' | 'picked' | 'region';

export type AgentCommand =
  | { type: 'AGENT_PING' }
  | { type: 'AGENT_HIDE_UI' }
  | { type: 'AGENT_SELECT_AREA' }
  | { type: 'AGENT_SELECT_SCROLL_AREA' }
  | { type: 'AGENT_PICK_ELEMENT' }
  | { type: 'AGENT_CANCEL_UI' }
  | { type: 'AGENT_FP_PREPARE'; target: FullPageTarget; direction: ScrollDirection }
  | {
      type: 'AGENT_FP_SCROLL';
      x: number;
      y: number;
      frame: number;
      totalFrames: number;
      settleMs: number;
    }
  | { type: 'AGENT_FP_MEASURE' }
  | { type: 'AGENT_FP_RESTORE' }
  | { type: 'AGENT_SHOW_PREVIEW'; id: string }
  | { type: 'AGENT_TOAST'; text: string; kind: 'info' | 'error' | 'success' };

/** Viewport facts the agent reports so the service worker can map CSS px to image px. */
export interface ViewportInfo {
  viewport: Size;
  dpr: number;
}

/** Scroll geometry of one axis of the scroller (CSS px). */
export interface AxisInfo {
  /** The scroller can move along this axis (content is larger than its client box). */
  scrollable: boolean;
  scroll: number;
  scrollLen: number;
  clientLen: number;
  maxScroll: number;
}

export interface FullPagePrepareResult {
  viewport: Size;
  dpr: number;
  kind: 'document' | 'element' | 'region';
  /** Capture window inside the viewport, in CSS px (excludes scrollbars; fixed while scrolling). */
  region: Rect;
  /** Direction actually used (a requested direction may be reduced to what the target supports). */
  direction: ScrollDirection;
  x: AxisInfo;
  y: AxisInfo;
  scrollHeight: number;
  scrollTop: number;
  horizontalOverflow: boolean;
  /** Human-readable notes (e.g. a nested scroll container was selected automatically). */
  notes: string[];
  autoNested: boolean;
  fixedCount: number;
}

export interface FullPageScrollResult {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  maxScrollTop: number;
  maxScrollLeft: number;
  /** True when the scroller is at (or within a pixel of) the very bottom after settling. */
  atBottom: boolean;
  atRight: boolean;
  region: Rect;
  viewport: Size;
}

/* ------------------------------------------------------------------ */
/* Runtime validation (defence in depth – messages cross trust zones)   */
/* ------------------------------------------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isOptId = (v: unknown) => v === undefined || (isNum(v) && Number.isInteger(v) && v >= 0);

export const CAPTURE_MODES: readonly CaptureMode[] = ['visible', 'area', 'fullPage', 'scrollArea', 'element'];

export const SCROLL_DIRECTIONS: readonly ScrollDirection[] = ['vertical', 'horizontal', 'both'];
export const isScrollDirection = (v: unknown): v is ScrollDirection =>
  typeof v === 'string' && (SCROLL_DIRECTIONS as readonly string[]).includes(v);
export const isFullPageTarget = (v: unknown): v is FullPageTarget => v === 'document' || v === 'picked' || v === 'region';

export function isCaptureMode(v: unknown): v is CaptureMode {
  return typeof v === 'string' && (CAPTURE_MODES as readonly string[]).includes(v);
}

export function isRect(v: unknown): v is Rect {
  return isObj(v) && isNum(v.x) && isNum(v.y) && isNum(v.width) && isNum(v.height) && v.width >= 0 && v.height >= 0;
}

export function isSize(v: unknown): v is Size {
  return isObj(v) && isNum(v.width) && isNum(v.height) && v.width > 0 && v.height > 0;
}

const CAPTURE_ID = /^[a-z0-9-]{8,64}$/i;
export function isCaptureId(v: unknown): v is string {
  return typeof v === 'string' && CAPTURE_ID.test(v);
}

export function parsePageRequest(raw: unknown): PageRequest | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'START_CAPTURE':
      return isCaptureMode(raw.mode) && isOptId(raw.tabId)
        ? { type: 'START_CAPTURE', mode: raw.mode, tabId: raw.tabId as number | undefined }
        : null;
    case 'GET_TAB_SUPPORT':
      return isOptId(raw.tabId) ? { type: 'GET_TAB_SUPPORT', tabId: raw.tabId as number | undefined } : null;
    case 'CANCEL_CAPTURE':
      return isOptId(raw.tabId) ? { type: 'CANCEL_CAPTURE', tabId: raw.tabId as number | undefined } : null;
    case 'OPEN_EDITOR':
    case 'OPEN_PREVIEW':
    case 'RECAPTURE':
    case 'DISCARD_CAPTURE':
      return isCaptureId(raw.id) ? ({ type: raw.type, id: raw.id } as PageRequest) : null;
    case 'OPEN_HISTORY':
    case 'OPEN_SETTINGS':
    case 'OPEN_SHORTCUTS':
      return { type: raw.type };
    default:
      return null;
  }
}

export function parseAgentEvent(raw: unknown): AgentEvent | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'EVT_AREA_SELECTED':
      return isRect(raw.rect) && isSize(raw.viewport) && isNum(raw.dpr) && raw.dpr > 0
        ? { type: 'EVT_AREA_SELECTED', rect: raw.rect, viewport: raw.viewport, dpr: raw.dpr }
        : null;
    case 'EVT_ELEMENT_PICKED':
      return isRect(raw.rect) && isSize(raw.viewport) && isNum(raw.dpr) && raw.dpr > 0 && typeof raw.fullContent === 'boolean'
        ? { type: 'EVT_ELEMENT_PICKED', rect: raw.rect, viewport: raw.viewport, dpr: raw.dpr, fullContent: raw.fullContent }
        : null;
    case 'EVT_SCROLL_AREA_SELECTED':
      return isFullPageTarget(raw.target) && isScrollDirection(raw.direction) && isSize(raw.viewport) && isNum(raw.dpr) && raw.dpr > 0
        ? { type: 'EVT_SCROLL_AREA_SELECTED', target: raw.target, direction: raw.direction, viewport: raw.viewport, dpr: raw.dpr }
        : null;
    case 'EVT_CAPTURE_ABORT':
      return raw.reason === 'cancelled' || raw.reason === 'error'
        ? {
            type: 'EVT_CAPTURE_ABORT',
            reason: raw.reason,
            message: typeof raw.message === 'string' ? raw.message.slice(0, 300) : undefined,
          }
        : null;
    case 'EVT_CANCEL_FULLPAGE':
      return { type: 'EVT_CANCEL_FULLPAGE' };
    case 'EVT_STOP_FULLPAGE':
      return { type: 'EVT_STOP_FULLPAGE' };
    default:
      return null;
  }
}

/** Commands are only ever sent by our own service worker; still validated on receipt. */
export function parseAgentCommand(raw: unknown): AgentCommand | null {
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'AGENT_PING':
    case 'AGENT_HIDE_UI':
    case 'AGENT_SELECT_AREA':
    case 'AGENT_SELECT_SCROLL_AREA':
    case 'AGENT_PICK_ELEMENT':
    case 'AGENT_CANCEL_UI':
    case 'AGENT_FP_MEASURE':
    case 'AGENT_FP_RESTORE':
      return { type: raw.type };
    case 'AGENT_FP_PREPARE':
      return isFullPageTarget(raw.target) && isScrollDirection(raw.direction)
        ? { type: 'AGENT_FP_PREPARE', target: raw.target, direction: raw.direction }
        : null;
    case 'AGENT_FP_SCROLL':
      return isNum(raw.x) && isNum(raw.y) && isNum(raw.frame) && isNum(raw.totalFrames) && isNum(raw.settleMs)
        ? { type: 'AGENT_FP_SCROLL', x: raw.x, y: raw.y, frame: raw.frame, totalFrames: raw.totalFrames, settleMs: raw.settleMs }
        : null;
    case 'AGENT_SHOW_PREVIEW':
      return isCaptureId(raw.id) ? { type: 'AGENT_SHOW_PREVIEW', id: raw.id } : null;
    case 'AGENT_TOAST':
      return isStr(raw.text, 400) && (raw.kind === 'info' || raw.kind === 'error' || raw.kind === 'success')
        ? { type: 'AGENT_TOAST', text: raw.text, kind: raw.kind }
        : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Sender classification                                               */
/* ------------------------------------------------------------------ */

export type SenderKind = 'extension-page' | 'content-agent' | 'unknown';

/**
 * Content scripts report the *page* URL as sender.url, extension documents report
 * chrome-extension://…, so the scheme reliably separates the two trust classes.
 */
export function classifySender(sender: chrome.runtime.MessageSender, extensionId: string): SenderKind {
  if (sender.id !== extensionId) return 'unknown';
  if (sender.url?.startsWith('chrome-extension://')) return 'extension-page';
  if (sender.tab && typeof sender.tab.id === 'number') return 'content-agent';
  return 'unknown';
}
