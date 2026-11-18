/**
 * Mouse input for the scrolling capture, via the Win32 API (koffi = FFI, no native build step).
 *
 * The wheel event goes to whatever window is under the cursor – that is how a real user scrolls – so the
 * capture works for any application (browser, Excel, a PDF viewer, an IDE …) without per-app code.
 * Other platforms need their own implementation of `Scroller`; until then they report a clear error.
 */
import koffi from 'koffi';

export interface Scroller {
  /** Move the cursor to a point in physical screen pixels. */
  moveTo(x: number, y: number): void;
  /** Scroll down by `notches` wheel notches (negative = up). */
  wheel(notches: number): void;
  position(): { x: number; y: number };
}

const MOUSEEVENTF_WHEEL = 0x0800;
const WHEEL_DELTA = 120;

export function createScroller(): Scroller {
  if (process.platform !== 'win32') {
    throw new Error('Scrolling capture currently needs Windows (mouse-wheel injection is not implemented for this OS yet).');
  }
  const user32 = koffi.load('user32.dll');
  const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
  const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
  const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *p)');
  const mouseEvent = user32.func('void __stdcall mouse_event(uint32 flags, int32 dx, int32 dy, int32 data, uintptr_t extra)');
  void POINT;

  return {
    moveTo: (x, y) => void SetCursorPos(Math.round(x), Math.round(y)),
    wheel: (notches) => {
      // A negative delta rolls the wheel towards the user, i.e. scrolls the content down.
      mouseEvent(MOUSEEVENTF_WHEEL, 0, 0, -Math.round(notches) * WHEEL_DELTA, 0);
    },
    position: () => {
      const p = { x: 0, y: 0 };
      GetCursorPos(p);
      return p;
    },
  };
}
