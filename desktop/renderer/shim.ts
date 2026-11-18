/**
 * A tiny stand-in for the parts of the `chrome.*` API that SnapFlow's shared UI (preview, editor, history,
 * options) touches, so those pages run unchanged inside the desktop app. Import this module first.
 *
 *   chrome.runtime.sendMessage → IPC to the main process (or local IndexedDB work)
 *   chrome.storage.local       → localStorage (+ change events across windows)
 *   chrome.downloads           → "save file" dialog / Downloads folder through the main process
 *   chrome.tabs.*              → close this window
 */
import { deleteCapture, getCapture } from '@/shared/captures';
import type { CaptureMode } from '@/shared/types';
import { APP_ORIGIN, type DesktopMode, type SnapflowDesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    snapflowDesktop: SnapflowDesktopApi;
  }
}

const bridge = (): SnapflowDesktopApi => window.snapflowDesktop;

/** The extension's capture modes → the desktop equivalents (and back, for "capture again"). */
const MODE_TO_DESKTOP: Record<CaptureMode, DesktopMode> = {
  visible: 'screen',
  area: 'region',
  element: 'window',
  scrollArea: 'scrolling',
  fullPage: 'scrolling',
};

type Reply = { ok: true; data?: unknown } | { ok: false; error: { code: string; message: string } };

async function handleRequest(req: { type?: string; id?: string; mode?: CaptureMode }): Promise<Reply> {
  try {
    switch (req.type) {
      case 'OPEN_EDITOR':
        await bridge().invoke('viewer:open-editor', req.id);
        return { ok: true };
      case 'OPEN_PREVIEW':
        await bridge().invoke('viewer:open-preview', req.id);
        return { ok: true };
      case 'DISCARD_CAPTURE':
        if (req.id) await deleteCapture(req.id);
        return { ok: true };
      case 'RECAPTURE': {
        const rec = req.id ? await getCapture(req.id) : undefined;
        const mode = rec ? MODE_TO_DESKTOP[rec.meta.mode] : 'region';
        if (req.id) await deleteCapture(req.id).catch(() => undefined);
        await bridge().invoke('capture:start', mode);
        return { ok: true };
      }
      case 'START_CAPTURE':
        await bridge().invoke('capture:start', req.mode ? MODE_TO_DESKTOP[req.mode] : 'region');
        return { ok: true };
      case 'OPEN_HISTORY':
        await bridge().invoke('history:open');
        return { ok: true };
      case 'OPEN_SETTINGS':
        await bridge().invoke('settings:open');
        return { ok: true };
      case 'OPEN_SHORTCUTS':
        return { ok: true };
      default:
        return { ok: false, error: { code: 'UNKNOWN', message: 'This action is not available in the desktop app.' } };
    }
  } catch (err) {
    return { ok: false, error: { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) } };
  }
}

/* ---------- storage ---------- */

type StorageListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
const storageListeners = new Set<StorageListener>();
const STORAGE_PREFIX = 'snapflow:storage:';

const readKey = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};

window.addEventListener('storage', (e) => {
  if (!e.key?.startsWith(STORAGE_PREFIX)) return;
  const key = e.key.slice(STORAGE_PREFIX.length);
  let newValue: unknown;
  try {
    newValue = e.newValue === null ? undefined : JSON.parse(e.newValue);
  } catch {
    newValue = undefined;
  }
  for (const l of storageListeners) l({ [key]: { newValue } }, 'local');
});

const storageLocal = {
  async get(key: string | string[] | null): Promise<Record<string, unknown>> {
    const keys = Array.isArray(key) ? key : typeof key === 'string' ? [key] : [];
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = readKey(k);
      if (v !== undefined) out[k] = v;
    }
    return out;
  },
  async set(items: Record<string, unknown>): Promise<void> {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: readKey(k), newValue: v };
      localStorage.setItem(STORAGE_PREFIX + k, JSON.stringify(v));
    }
    // The `storage` event only reaches *other* windows; tell this one too.
    for (const l of storageListeners) l(changes, 'local');
  },
};

/* ---------- downloads ---------- */

type DownloadListener = (delta: { id: number; state?: { current: string }; error?: { current: string } }) => void;
const downloadListeners = new Set<DownloadListener>();
const finished = new Map<number, { state: 'complete' | 'interrupted'; error?: string }>();
let downloadSeq = 0;

const downloads = {
  async download(opts: { url: string; filename?: string; saveAs?: boolean }): Promise<number | undefined> {
    const bytes = new Uint8Array(await (await fetch(opts.url)).arrayBuffer());
    const id = ++downloadSeq;
    const res = await bridge().invoke<{ saved: boolean }>('file:save', { filename: opts.filename ?? 'screenshot.png', bytes, saveAs: !!opts.saveAs });
    if (!res.saved) throw new Error('Download cancelled');
    finished.set(id, { state: 'complete' });
    queueMicrotask(() => downloadListeners.forEach((l) => l({ id, state: { current: 'complete' } })));
    return id;
  },
  async search(q: { id: number }): Promise<Array<{ state: string; error?: string }>> {
    const f = finished.get(q.id);
    return f ? [f] : [];
  },
  onChanged: {
    addListener: (l: DownloadListener) => void downloadListeners.add(l),
    removeListener: (l: DownloadListener) => void downloadListeners.delete(l),
  },
};

/* ---------- install ---------- */

const shim = {
  runtime: {
    id: 'snapflow-desktop',
    sendMessage: handleRequest,
    getURL: (path: string) => new URL(path, APP_ORIGIN).href,
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    lastError: undefined,
  },
  storage: {
    local: storageLocal,
    onChanged: {
      addListener: (l: StorageListener) => void storageListeners.add(l),
      removeListener: (l: StorageListener) => void storageListeners.delete(l),
    },
  },
  tabs: {
    getCurrent: async () => ({ id: 1 }),
    remove: async () => {
      await bridge().invoke('window:close');
    },
  },
  commands: { getAll: async () => [] },
  downloads,
};

Object.defineProperty(globalThis, 'chrome', { value: shim, configurable: true, writable: true });
