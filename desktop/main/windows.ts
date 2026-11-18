import { BrowserWindow, ipcMain, nativeImage, type Display, type Rectangle } from 'electron';
import path from 'node:path';
import { APP_ORIGIN } from '../shared/ipc';

const preload = path.join(__dirname, 'preload.cjs');
const iconPath = path.join(__dirname, 'renderer', 'icons', 'icon-128.png');

export const appIcon = () => nativeImage.createFromPath(iconPath);

export function appUrl(page: string, query: Record<string, string> = {}): string {
  const url = new URL(`${page}/index.html`, APP_ORIGIN);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url.href;
}

const webPreferences = { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } as const;

/* ---------- ordinary windows ---------- */

let launcher: BrowserWindow | null = null;
let viewer: BrowserWindow | null = null;
let history: BrowserWindow | null = null;
let settings: BrowserWindow | null = null;
let hub: BrowserWindow | null = null;

const alive = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed();

function ordinary(opts: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow({ icon: appIcon(), autoHideMenuBar: true, show: false, backgroundColor: '#14161c', webPreferences, ...opts });
}

function showWhenReady(w: BrowserWindow): void {
  w.once('ready-to-show', () => {
    w.show();
    w.focus();
  });
}

export function showLauncher(): void {
  if (!alive(launcher)) {
    launcher = ordinary({ width: 560, height: 520, title: 'SnapFlow', resizable: false, maximizable: false });
    launcher.on('closed', () => (launcher = null));
    void launcher.loadURL(appUrl('launcher'));
    showWhenReady(launcher);
  } else {
    launcher.show();
    launcher.focus();
  }
}

/** Preview and editor share one window: "Edit" and "Back to preview" navigate inside it. */
export function showViewer(page: 'preview' | 'editor', id: string): void {
  if (!alive(viewer)) {
    viewer = ordinary({ width: 1180, height: 780, minWidth: 700, minHeight: 500, title: 'SnapFlow' });
    viewer.on('closed', () => (viewer = null));
    void viewer.loadURL(appUrl(page, { id, host: 'tab' }));
    showWhenReady(viewer);
  } else {
    void viewer.loadURL(appUrl(page, { id, host: 'tab' }));
    viewer.show();
    viewer.focus();
  }
}

function singleton(
  get: () => BrowserWindow | null,
  set: (w: BrowserWindow | null) => void,
  page: string,
  size: { width: number; height: number },
  title: string,
): void {
  const existing = get();
  if (alive(existing)) {
    existing.show();
    existing.focus();
    return;
  }
  const w = ordinary({ ...size, minWidth: 520, minHeight: 420, title });
  w.on('closed', () => set(null));
  set(w);
  void w.loadURL(appUrl(page));
  showWhenReady(w);
}

export const showHistory = () => singleton(() => history, (w) => (history = w), 'history', { width: 1000, height: 720 }, 'SnapFlow – Recent screenshots');
export const showSettings = () => singleton(() => settings, (w) => (settings = w), 'options', { width: 820, height: 760 }, 'SnapFlow – Settings');

/** Windows that must stay on screen while a capture runs (the page being captured, in tests). */
const keep = new Set<BrowserWindow>();
export const keepVisible = (w: BrowserWindow) => void keep.add(w);

/** Windows of the app that are visible right now – hidden while a capture runs so they are not in the picture. */
export function hideAppWindows(): () => void {
  const hidden: BrowserWindow[] = [];
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === hub || keep.has(w) || w.isDestroyed() || !w.isVisible()) continue;
    hidden.push(w);
    w.hide();
  }
  return () => {
    for (const w of hidden) if (!w.isDestroyed()) w.show();
  };
}

export function closeViewer(): void {
  if (alive(viewer)) viewer.close();
}

/* ---------- hub (hidden storage page) ---------- */

let hubSeq = 0;
const hubPending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

export async function createHub(): Promise<void> {
  hub = new BrowserWindow({ show: false, webPreferences });
  ipcMain.on('hub:reply', (_e, r: { reqId: number; ok: boolean; error?: string }) => {
    const p = hubPending.get(r.reqId);
    if (!p) return;
    hubPending.delete(r.reqId);
    if (r.ok) p.resolve();
    else p.reject(new Error(r.error ?? 'Could not store the screenshot.'));
  });
  await hub.loadURL(appUrl('hub'));
}

export function storeCapture(payload: Record<string, unknown>): Promise<void> {
  if (!alive(hub)) return Promise.reject(new Error('Storage page is not running.'));
  const reqId = ++hubSeq;
  return new Promise((resolve, reject) => {
    hubPending.set(reqId, { resolve, reject });
    hub?.webContents.send('hub:store', { reqId, ...payload });
    setTimeout(() => {
      if (hubPending.delete(reqId)) reject(new Error('Storing the screenshot timed out.'));
    }, 30_000);
  });
}

/* ---------- capture UI ---------- */

export function createOverlay(display: Display, shotUrl: string, mode: 'region' | 'scrolling'): BrowserWindow {
  const b = display.bounds;
  const w = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    enableLargerThanScreen: true,
    backgroundColor: '#000000',
    webPreferences,
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setBounds(b);
  void w.loadURL(appUrl('overlay', { shot: shotUrl, mode }));
  w.once('ready-to-show', () => {
    w.show();
    w.setBounds(b);
    w.focus();
  });
  return w;
}

export function createPicker(): BrowserWindow {
  const w = ordinary({ width: 900, height: 640, minWidth: 560, minHeight: 420, title: 'SnapFlow – Pick a window', alwaysOnTop: true });
  void w.loadURL(appUrl('picker'));
  showWhenReady(w);
  return w;
}

/** Progress pill for a scrolling capture. Excluded from screen capture, so it can never end up in the image. */
export function createPill(area: Rectangle, display: Display): BrowserWindow {
  const width = 420;
  const height = 48;
  const wa = display.workArea;
  // Prefer just above the capture area, otherwise just below, otherwise bottom-centre of the display.
  let y = area.y - height - 10;
  if (y < wa.y) y = area.y + area.height + 10;
  if (y + height > wa.y + wa.height) y = wa.y + wa.height - height - 10;
  const x = Math.min(Math.max(area.x + Math.round((area.width - width) / 2), wa.x + 8), wa.x + wa.width - width - 8);
  const w = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences,
  });
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setContentProtection(true);
  void w.loadURL(appUrl('pill'));
  w.once('ready-to-show', () => w.showInactive());
  return w;
}
