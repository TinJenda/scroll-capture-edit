import { BrowserWindow, dialog, globalShortcut, ipcMain, screen, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { CaptureMode, CaptureWarning, Rect } from '@/shared/types';
import type { DesktopMode, OverlayDone, PillUpdate } from '../shared/ipc';
import { createScroller } from './input-win';
import { runScrollCapture, type ScrollEnd } from './scroll-capture';
import { displayAt, frameOf, grabDisplay, hwndOf, pngOf, toImageRect, type Shot } from './screen';
import { activateAndMeasure } from './win32-window';
import { createOverlay, createPicker, createPill, hideAppWindows, showViewer, storeCapture } from './windows';

/** Screenshots of every display, served to the selection overlays as `snapflow://shot/<token>.jpg`. */
export const shotStore = new Map<string, Buffer>();

let debugFrame = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let busy = false;
let onBusy: (b: boolean) => void = () => undefined;
export const isBusy = () => busy;
export const setBusyListener = (fn: (b: boolean) => void) => (onBusy = fn);

/** Time the compositor needs to drop our own windows from the screen before we photograph it. */
const HIDE_SETTLE_MS = 260;

interface Selection {
  shot: Shot;
  /** DIP rectangle relative to the display's top-left corner. */
  rect: Rect;
  mode: 'region' | 'scrolling';
}

/* ------------------------------------------------------------------ entry points */

export async function startCapture(mode: DesktopMode): Promise<void> {
  await guarded(async () => {
    switch (mode) {
      case 'region':
      case 'scrolling': {
        const sel = await pickRegion(mode);
        return sel ? runSelection(sel) : false;
      }
      case 'screen':
        await sleep(HIDE_SETTLE_MS);
        return fullScreen();
      case 'window':
        return windowCapture();
    }
  });
}

/** Test/automation entry: capture an absolute screen rectangle (DIP) without the interactive overlay. */
export async function captureRect(mode: 'region' | 'scrolling', abs: Rect): Promise<boolean> {
  return guarded(async () => {
    const display = displayAt({ x: Math.round(abs.x + abs.width / 2), y: Math.round(abs.y + abs.height / 2) });
    await sleep(HIDE_SETTLE_MS);
    const shot = await grabDisplay(display);
    return runSelection({ shot, mode, rect: { x: abs.x - display.bounds.x, y: abs.y - display.bounds.y, width: abs.width, height: abs.height } });
  });
}

async function guarded(fn: () => Promise<boolean>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  onBusy(true);
  const restore = hideAppWindows();
  let delivered = false;
  try {
    delivered = await fn();
  } catch (err) {
    dialog.showErrorBox('SnapFlow', err instanceof Error ? err.message : String(err));
  } finally {
    if (!delivered) restore();
    busy = false;
    onBusy(false);
  }
  return delivered;
}

/* ------------------------------------------------------------------ selection overlay */

async function pickRegion(initial: 'region' | 'scrolling'): Promise<Selection | null> {
  await sleep(HIDE_SETTLE_MS);
  const displays = screen.getAllDisplays();
  const shots = await Promise.all(displays.map((d) => grabDisplay(d)));
  const cursor = screen.getCursorScreenPoint();

  return new Promise<Selection | null>((resolve) => {
    const windows = new Map<number, { win: BrowserWindow; shot: Shot; token: string }>();

    const finish = (result: Selection | null) => {
      ipcMain.removeListener('overlay:done', onDone);
      ipcMain.removeListener('overlay:cancel', onCancel);
      for (const { win, token } of windows.values()) {
        shotStore.delete(token);
        if (!win.isDestroyed()) win.destroy();
      }
      windows.clear();
      resolve(result);
    };
    const owner = (e: IpcMainEvent) => windows.get(e.sender.id);
    const onDone = (e: IpcMainEvent, payload: OverlayDone) => {
      const o = owner(e);
      if (!o) return;
      finish({ shot: o.shot, rect: payload.rect, mode: payload.mode === 'scrolling' ? 'scrolling' : 'region' });
    };
    const onCancel = (e: IpcMainEvent) => {
      if (owner(e)) finish(null);
    };
    ipcMain.on('overlay:done', onDone);
    ipcMain.on('overlay:cancel', onCancel);

    let focused = false;
    for (const shot of shots) {
      const token = randomUUID();
      shotStore.set(token, shot.image.toJPEG(90));
      const win = createOverlay(shot.display, `snapflow://shot/${token}.jpg`, initial);
      windows.set(win.webContents.id, { win, shot, token });
      const b = shot.display.bounds;
      if (!focused && cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height) {
        focused = true;
        win.once('ready-to-show', () => win.focus());
      }
    }
  });
}

/* ------------------------------------------------------------------ window picker */

async function pickWindow(): Promise<{ id: string; name: string } | null> {
  return new Promise((resolve) => {
    const win = createPicker();
    const finish = (r: { id: string; name: string } | null) => {
      ipcMain.removeListener('picker:choose', onChoose);
      ipcMain.removeListener('picker:cancel', onCancel);
      win.removeListener('closed', onClosed);
      if (!win.isDestroyed()) win.destroy();
      resolve(r);
    };
    const mine = (e: IpcMainEvent) => e.sender.id === win.webContents.id;
    const onChoose = (e: IpcMainEvent, c: { id?: unknown; name?: unknown }) => {
      if (mine(e) && typeof c?.id === 'string') finish({ id: c.id, name: String(c.name ?? '') });
    };
    const onCancel = (e: IpcMainEvent) => {
      if (mine(e)) finish(null);
    };
    const onClosed = () => finish(null);
    ipcMain.on('picker:choose', onChoose);
    ipcMain.on('picker:cancel', onCancel);
    win.on('closed', onClosed);
  });
}

async function windowCapture(): Promise<boolean> {
  const choice = await pickWindow();
  if (!choice) return false;
  const hwnd = hwndOf(choice.id);
  if (!Number.isFinite(hwnd)) throw new Error('Could not identify that window.');
  const phys = activateAndMeasure(hwnd);
  await sleep(450); // let the window come to the front and finish repainting

  // Physical pixels → the display that holds most of the window.
  const centre = screen.screenToDipPoint({ x: Math.round(phys.x + phys.width / 2), y: Math.round(phys.y + phys.height / 2) });
  const display = displayAt(centre);
  const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
  const shot = await grabDisplay(display);
  const x = Math.max(0, phys.x - origin.x);
  const y = Math.max(0, phys.y - origin.y);
  const width = Math.min(shot.width - x, phys.x + phys.width - origin.x - x);
  const height = Math.min(shot.height - y, phys.y + phys.height - origin.y - y);
  if (width < 4 || height < 4) throw new Error('That window is off-screen.');
  const crop = shot.image.crop({ x, y, width, height });
  await deliver(crop.toPNG(), width, height, { mode: 'element', scale: shot.scaleX, title: choice.name });
  return true;
}

/* ------------------------------------------------------------------ results */

interface DeliverMeta {
  mode: CaptureMode;
  scale: number;
  title: string;
  warnings?: CaptureWarning[];
}

async function deliver(png: Buffer, width: number, height: number, meta: DeliverMeta): Promise<void> {
  const id = randomUUID();
  await storeCapture({
    id,
    png: new Uint8Array(png.buffer, png.byteOffset, png.byteLength),
    width,
    height,
    meta: {
      mode: meta.mode,
      scale: meta.scale,
      viewport: { width: Math.round(width / meta.scale), height: Math.round(height / meta.scale) },
      pageTitle: meta.title,
      warnings: meta.warnings ?? [],
    },
  });
  showViewer('preview', id);
}

const displayName = (shot: Shot): string => {
  const i = screen.getAllDisplays().findIndex((d) => d.id === shot.display.id);
  return `Display ${i + 1}`;
};

async function fullScreen(): Promise<boolean> {
  const display = displayAt(screen.getCursorScreenPoint());
  const shot = await grabDisplay(display);
  await deliver(shot.image.toPNG(), shot.width, shot.height, { mode: 'visible', scale: shot.scaleX, title: displayName(shot) });
  return true;
}

async function runSelection(sel: Selection): Promise<boolean> {
  const { shot } = sel;
  if (sel.mode === 'region') {
    const r = toImageRect(shot, sel.rect);
    const crop = shot.image.crop(r);
    await deliver(crop.toPNG(), r.width, r.height, { mode: 'area', scale: shot.scaleX, title: displayName(shot) });
    return true;
  }
  return scrollingCapture(sel);
}

/* ------------------------------------------------------------------ scrolling capture */

const END_WARNING: Partial<Record<ScrollEnd, CaptureWarning>> = {
  stopped: { code: 'stopped', message: 'Capture stopped early – the image contains what was captured up to that point.' },
  lost: {
    code: 'truncated',
    message: 'The content changed while scrolling and could not be lined up any more, so the image ends there.',
  },
  full: { code: 'truncated', message: 'The image reached its maximum height, so the rest of the content was not captured.' },
  frames: { code: 'frames', message: 'Stopped after the maximum number of scroll steps.' },
};

async function scrollingCapture(sel: Selection): Promise<boolean> {
  const { shot, rect } = sel;
  const display = shot.display;
  const imgRect = toImageRect(shot, rect);
  const abs: Rect = { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height };
  const scroller = createScroller();
  const centre = screen.dipToScreenPoint({ x: Math.round(abs.x + abs.width / 2), y: Math.round(abs.y + abs.height / 2) });

  let stop = false;
  let discard = false;
  const onStop = () => (stop = true);
  const onDiscard = () => {
    discard = true;
    stop = true;
  };
  ipcMain.on('pill:stop', onStop);
  ipcMain.on('pill:discard', onDiscard);
  globalShortcut.register('Escape', onStop);

  await sleep(HIDE_SETTLE_MS); // the overlays are gone from the screen
  const pill = createPill(abs, display);
  const origin = scroller.position();
  scroller.moveTo(centre.x, centre.y);
  await sleep(120);

  try {
    const result = await runScrollCapture({
      maxRows: Math.min(30_000, Math.floor(100_000_000 / imgRect.width)),
      sleep,
      log: process.env.SNAPFLOW_DEBUG ? (m) => console.log(`[scroll] ${m}`) : undefined,
      shouldStop: () => stop,
      grab: async () => {
        const crop = (await grabDisplay(display)).image.crop(imgRect);
        // Diagnostics: SNAPFLOW_DEBUG_DIR=<folder> keeps every grabbed frame as a PNG.
        if (process.env.SNAPFLOW_DEBUG_DIR) writeFileSync(`${process.env.SNAPFLOW_DEBUG_DIR}/frame-${String(debugFrame++).padStart(3, '0')}.png`, crop.toPNG());
        return frameOf(crop);
      },
      wheel: (n) => {
        scroller.moveTo(centre.x, centre.y);
        for (let i = 0; i < Math.abs(n); i++) scroller.wheel(Math.sign(n));
      },
      progress: (p) => {
        if (!pill.isDestroyed()) pill.webContents.send('pill:update', p satisfies PillUpdate);
      },
    });

    if (discard) return false;
    if (result.end === 'nothing') {
      throw new Error(
        'Nothing scrolled in the selected area. Select an area whose content scrolls with the mouse wheel, and make sure that window is not covered by another one.',
      );
    }
    const warning = END_WARNING[result.end];
    const png = pngOf(result.image);
    await deliver(png, result.image.width, result.image.height, {
      mode: 'scrollArea',
      scale: shot.scaleX,
      title: `${displayName(shot)} · ${result.frames} frame${result.frames === 1 ? '' : 's'}`,
      warnings: warning ? [warning] : [],
    });
    return true;
  } finally {
    scroller.moveTo(origin.x, origin.y);
    globalShortcut.unregister('Escape');
    ipcMain.removeListener('pill:stop', onStop);
    ipcMain.removeListener('pill:discard', onDiscard);
    if (!pill.isDestroyed()) pill.destroy();
  }
}
