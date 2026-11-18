/**
 * Window helpers (Win32, via koffi): bring a window to the front and measure the frame the user actually
 * sees. The screenshot itself comes from the screen, so what is captured is exactly what is visible – the
 * same result as the system's own window snip, without per-window capture quirks.
 */
import koffi from 'koffi';

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SW_RESTORE = 9;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

export function activateAndMeasure(hwnd: number): PhysicalRect {
  if (process.platform !== 'win32') throw new Error('Window capture currently needs Windows.');
  const user32 = koffi.load('user32.dll');
  const dwm = koffi.load('dwmapi.dll');
  koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hwnd)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hwnd, int cmd)');
  const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hwnd)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *rect)');
  const DwmGetWindowAttribute = dwm.func('int __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ RECT *rect, uint32 size)');

  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  SetForegroundWindow(hwnd);

  const r = { left: 0, top: 0, right: 0, bottom: 0 };
  // The extended frame is the visible window; GetWindowRect also includes the invisible resize borders.
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0) GetWindowRect(hwnd, r);
  const width = r.right - r.left;
  const height = r.bottom - r.top;
  if (width < 8 || height < 8) throw new Error('That window has no visible area to capture (is it minimised?).');
  return { x: r.left, y: r.top, width, height };
}
