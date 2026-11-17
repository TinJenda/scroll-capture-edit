export type ErrorCode =
  | 'RESTRICTED_PAGE'
  | 'NO_ACCESS'
  | 'CANCELLED'
  | 'TAB_CHANGED'
  | 'CAPTURE_FAILED'
  | 'RATE_LIMIT'
  | 'VIEWPORT_CHANGED'
  | 'TOO_LARGE'
  | 'STITCH_GAP'
  | 'AGENT_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'CLIPBOARD_DENIED'
  | 'CLIPBOARD_NOT_FOCUSED'
  | 'CLIPBOARD_UNSUPPORTED'
  | 'CLIPBOARD_FAILED'
  | 'UNKNOWN';

export class SnapflowError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SnapflowError';
    this.code = code;
  }
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof SnapflowError) return { code: err.code, message: err.message };
  return classifyChromeError(err);
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Maps raw Chrome API failures to errors a user can act on. */
export function classifyChromeError(err: unknown): SerializedError {
  if (err instanceof SnapflowError) return { code: err.code, message: err.message };
  const raw = errorMessage(err);
  const lower = raw.toLowerCase();

  if (lower.includes('max_capture_visible_tab_calls_per_second') || lower.includes('exceeds the max')) {
    return { code: 'RATE_LIMIT', message: 'Chrome limited the capture rate. Please try again in a moment.' };
  }
  if (lower.includes('cannot access a chrome://') || lower.includes('cannot access contents of the page') ||
      lower.includes('cannot be scripted') || lower.includes('chrome-extension://') && lower.includes('cannot access')) {
    return { code: 'RESTRICTED_PAGE', message: 'Chrome does not allow extensions to capture this page (browser pages, the Web Store and some protected pages are blocked).' };
  }
  if (lower.includes('file://') || lower.includes('file urls')) {
    return { code: 'NO_ACCESS', message: 'Enable "Allow access to file URLs" for SnapFlow in chrome://extensions to capture local files.' };
  }
  if (lower.includes('activetab') || lower.includes('permission') || lower.includes('cannot access contents of url')) {
    return { code: 'NO_ACCESS', message: 'SnapFlow has no access to this tab yet. Click the SnapFlow toolbar icon (or use its shortcut) on the page you want to capture.' };
  }
  if (lower.includes('no tab with id') || lower.includes('tab was closed') || lower.includes('no window with id')) {
    return { code: 'TAB_CHANGED', message: 'The tab was closed or changed during capture.' };
  }
  if (lower.includes('receiving end does not exist') || lower.includes('could not establish connection') ||
      lower.includes('extension context invalidated') || lower.includes('message port closed')) {
    return { code: 'AGENT_UNAVAILABLE', message: 'SnapFlow lost contact with the page. Reload the page and try again.' };
  }
  return { code: 'UNKNOWN', message: raw || 'Something went wrong.' };
}
