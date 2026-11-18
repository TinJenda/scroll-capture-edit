import { BrowserWindow, desktopCapturer, nativeImage, screen, type Display, type NativeImage } from 'electron';
import { cssRectToImageRect } from '@/shared/geometry';
import { frameFromBytes, type PixelFrame } from '@/shared/overlap';
import type { Rect } from '@/shared/types';
import { APP_ORIGIN, type PickerWindow } from '../shared/ipc';

export interface Shot {
  display: Display;
  image: NativeImage;
  width: number;
  height: number;
  /** Image pixels per DIP (device-independent pixel), measured from the bitmap rather than assumed. */
  scaleX: number;
  scaleY: number;
}

/** Full-resolution screenshot of one display. */
export async function grabDisplay(display: Display): Promise<Shot> {
  const sf = display.scaleFactor || 1;
  const thumbnailSize = { width: Math.round(display.bounds.width * sf), height: Math.round(display.bounds.height * sf) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
  const index = screen.getAllDisplays().findIndex((d) => d.id === display.id);
  const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[Math.max(0, index)] ?? sources[0];
  if (!src || src.thumbnail.isEmpty()) {
    throw new Error('Could not read the screen. On macOS, allow screen recording for SnapFlow in System Settings.');
  }
  const size = src.thumbnail.getSize();
  return {
    display,
    image: src.thumbnail,
    width: size.width,
    height: size.height,
    scaleX: size.width / display.bounds.width,
    scaleY: size.height / display.bounds.height,
  };
}

/** A DIP rectangle relative to the display's top-left corner → integer pixels of the screenshot. */
export function toImageRect(shot: Shot, dipRect: Rect): Rect {
  const r = cssRectToImageRect(dipRect, { x: shot.scaleX, y: shot.scaleY }, { width: shot.width, height: shot.height });
  if (!r) throw new Error('The selected area is outside the screen.');
  return r;
}

export function frameOf(image: NativeImage): PixelFrame {
  const { width, height } = image.getSize();
  return frameFromBytes(image.toBitmap(), width, height);
}

export function pngOf(frame: PixelFrame): Buffer {
  const bytes = Buffer.from(frame.px.buffer, frame.px.byteOffset, frame.px.byteLength);
  return nativeImage.createFromBitmap(bytes, { width: frame.width, height: frame.height }).toPNG();
}

/** Open top-level windows (without SnapFlow's own), with a small preview each. */
export async function listWindows(): Promise<PickerWindow[]> {
  const own = new Set(
    BrowserWindow.getAllWindows()
      .filter((w) => w.webContents.getURL().startsWith(APP_ORIGIN))
      .map((w) => {
        const h = w.getNativeWindowHandle();
        return h.length >= 4 ? h.readUInt32LE(0) : -1;
      }),
  );
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 360, height: 220 }, fetchWindowIcons: false });
  return sources
    .filter((s) => s.name.trim() && !own.has(hwndOf(s.id)))
    .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
}

/** `window:<HWND>:<n>` → the native window handle. */
export function hwndOf(sourceId: string): number {
  return Number(sourceId.split(':')[1] ?? NaN);
}

export function displayAt(point: { x: number; y: number }): Display {
  return screen.getDisplayNearestPoint(point);
}
