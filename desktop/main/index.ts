import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, net, protocol, screen, session, Tray, type IpcMainInvokeEvent } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ORIGIN, isDesktopMode, type DesktopMode, type LauncherState } from '../shared/ipc';
import { captureRect, isBusy, setBusyListener, shotStore, startCapture } from './flow';
import { listWindows } from './screen';
import {
  appIcon,
  closeViewer,
  createHub,
  keepVisible,
  showHistory,
  showLauncher,
  showSettings,
  showViewer,
} from './windows';

const rendererDir = path.join(__dirname, 'renderer');
// `__E2E__` is false in production builds, so the automation hooks below are not even compiled in.
const isTest = __E2E__ && process.env.SNAPFLOW_TEST === '1';
if (isTest && process.env.SNAPFLOW_USER_DATA) app.setPath('userData', process.env.SNAPFLOW_USER_DATA);
if (isTest && process.env.SNAPFLOW_DOWNLOADS) app.setPath('downloads', process.env.SNAPFLOW_DOWNLOADS);

protocol.registerSchemesAsPrivileged([
  { scheme: 'snapflow', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock() && !isTest) {
  app.quit();
}

/** Pages ship with the app and load nothing from the network. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: snapflow:",
  "connect-src 'self' blob: snapflow:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

const HOTKEYS: Array<{ mode: DesktopMode; accelerator: string }> = [
  { mode: 'region', accelerator: 'CommandOrControl+Shift+1' },
  { mode: 'scrolling', accelerator: 'CommandOrControl+Shift+2' },
  { mode: 'screen', accelerator: 'CommandOrControl+Shift+3' },
  { mode: 'window', accelerator: 'CommandOrControl+Shift+4' },
];
const registered = new Map<DesktopMode, boolean>();

const launcherState = (): LauncherState => ({
  busy: isBusy(),
  hotkeys: HOTKEYS.map((h) => ({ ...h, registered: registered.get(h.mode) ?? false })),
});

function pushLauncherState(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('launcher:update', launcherState());
  }
}

/** Only our own pages may talk to the main process. */
function trusted(e: IpcMainInvokeEvent): boolean {
  return (e.senderFrame?.url ?? '').startsWith(APP_ORIGIN);
}

function registerProtocol(): void {
  protocol.handle('snapflow', async (request) => {
    const url = new URL(request.url);
    if (url.hostname === 'shot') {
      const token = path.basename(url.pathname, '.jpg');
      const buf = shotStore.get(token);
      return buf ? new Response(new Uint8Array(buf), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' } }) : new Response('Not found', { status: 404 });
    }
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(rendererDir, rel));
    if (!file.startsWith(rendererDir + path.sep)) return new Response('Forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    if (!file.endsWith('.html')) return res;
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}

/** Deny every permission request except the clipboard, and keep app pages from navigating away. */
function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read');
  });
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      if (wc.getURL().startsWith(APP_ORIGIN) && !url.startsWith(APP_ORIGIN)) event.preventDefault();
    });
  });
}

function registerIpc(): void {
  ipcMain.handle('capture:start', async (e, mode: unknown) => {
    if (!trusted(e) || !isDesktopMode(mode)) return;
    // Do not block the caller (a window about to hide itself) on the whole capture.
    void startCapture(mode);
  });
  ipcMain.handle('viewer:open-editor', (e, id: unknown) => {
    if (trusted(e) && typeof id === 'string') showViewer('editor', id);
  });
  ipcMain.handle('viewer:open-preview', (e, id: unknown) => {
    if (trusted(e) && typeof id === 'string') showViewer('preview', id);
  });
  ipcMain.handle('history:open', (e) => void (trusted(e) && showHistory()));
  ipcMain.handle('settings:open', (e) => void (trusted(e) && showSettings()));
  ipcMain.handle('window:close', (e) => {
    if (trusted(e)) BrowserWindow.fromWebContents(e.sender)?.close();
  });
  ipcMain.handle('app:info', (e) => (trusted(e) ? launcherState() : null));
  ipcMain.handle('picker:list', (e) => (trusted(e) ? listWindows() : []));

  ipcMain.handle('file:save', async (e, req: { filename: string; bytes: Uint8Array; saveAs: boolean }) => {
    if (!trusted(e)) return { saved: false };
    // eslint-disable-next-line no-control-regex -- control characters are exactly what must not reach a file name
    const safe = path.basename(String(req.filename)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'screenshot.png';
    let target: string;
    if (req.saveAs) {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      const opts = { defaultPath: path.join(app.getPath('downloads'), safe) };
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { saved: false };
      target = r.filePath;
    } else {
      target = await uniquePath(path.join(app.getPath('downloads'), safe));
    }
    await fs.writeFile(target, Buffer.from(req.bytes));
    return { saved: true, path: target };
  });
}

async function uniquePath(file: string): Promise<string> {
  const { dir, name, ext } = path.parse(file);
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? file : path.join(dir, `${name} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return file;
}

let tray: Tray | null = null;
function createTray(): void {
  tray = new Tray(appIcon().resize({ width: 16, height: 16 }));
  tray.setToolTip('SnapFlow');
  const item = (label: string, mode: DesktopMode, accelerator: string) => ({ label, accelerator, registerAccelerator: false, click: () => void startCapture(mode) });
  tray.setContextMenu(
    Menu.buildFromTemplate([
      item('Capture region', 'region', 'Ctrl+Shift+1'),
      item('Scrolling region', 'scrolling', 'Ctrl+Shift+2'),
      item('Full screen', 'screen', 'Ctrl+Shift+3'),
      item('Window', 'window', 'Ctrl+Shift+4'),
      { type: 'separator' },
      { label: 'Open SnapFlow', click: showLauncher },
      { label: 'Recent screenshots', click: showHistory },
      { label: 'Settings', click: showSettings },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', showLauncher);
}

function registerHotkeys(): void {
  for (const h of HOTKEYS) {
    let ok: boolean;
    try {
      ok = globalShortcut.register(h.accelerator, () => void startCapture(h.mode));
    } catch {
      ok = false;
    }
    registered.set(h.mode, ok);
  }
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerProtocol();
  hardenSession();
  registerIpc();
  setBusyListener(pushLauncherState);
  await createHub();
  createTray();
  registerHotkeys();
  if (!isTest) showLauncher();

  if (isTest) {
    // Automation hooks used by the Playwright suite (never set in a normal run).
    (globalThis as Record<string, unknown>).__snapflowTest = {
      captureRect,
      showLauncher,
      closeViewer,
      /** Opens a plain window on top of everything, to be captured. Returns its content area in DIP. */
      async fixture(url: string, size: { width: number; height: number }) {
        const wa = screen.getPrimaryDisplay().workArea;
        const width = Math.min(size.width, wa.width - 80);
        const height = Math.min(size.height, wa.height - 80);
        const win = new BrowserWindow({
          x: wa.x + 40,
          y: wa.y + 40,
          width,
          height,
          useContentSize: true,
          frame: false,
          alwaysOnTop: true,
          show: false,
          backgroundColor: '#ffffff',
        });
        keepVisible(win);
        await win.loadURL(url);
        win.show();
        await new Promise((r) => setTimeout(r, 400));
        return win.getContentBounds();
      },
      closeFixtures() {
        for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().startsWith(APP_ORIGIN)) w.destroy();
      },
    };
  }
});

// The app lives in the tray: closing every window must not quit it.
app.on('window-all-closed', () => undefined);
app.on('second-instance', showLauncher);
app.on('will-quit', () => globalShortcut.unregisterAll());
