import { clamp, rectFromPoints } from '@/shared/geometry';
import type { Rect } from '@/shared/types';
import { BASE_CSS, createLayer, el, ICONS, waitForPaint, type Layer } from './dom';

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSORS: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};
const MIN_SIZE = 4;
const HIT = 9;

const CSS =
  BASE_CSS +
  `
  .stage { position: fixed; inset: 0; cursor: crosshair; background: rgba(0,0,0,.28); pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; }
  .stage.has-sel { background: transparent; }
  .box { position: fixed; display: none; border: 1.5px solid #78a2ff; box-shadow: 0 0 0 100vmax rgba(0,0,0,.5); pointer-events: none; }
  .handle { position: fixed; display: none; width: 9px; height: 9px; margin: -4.5px 0 0 -4.5px; background: #fff; border: 1.5px solid #3f5ce0; border-radius: 2px; pointer-events: none; }
  .label { position: fixed; display: none; padding: 3px 7px; border-radius: 6px; background: rgba(20,22,28,.92); color: #fff; font: 600 12px/1.2 system-ui, sans-serif; pointer-events: none; white-space: nowrap; }
  .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; background: rgba(20,22,28,.92); color: #fff; font-size: 13px; pointer-events: none; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
  .bar { position: fixed; display: none; gap: 6px; padding: 5px; border-radius: 10px; background: rgba(20,22,28,.95); box-shadow: 0 6px 22px rgba(0,0,0,.4); pointer-events: auto; }
`;

type Action =
  | { kind: 'draw'; sx: number; sy: number }
  | { kind: 'move'; dx: number; dy: number; orig: Rect }
  | { kind: 'resize'; handle: Handle; orig: Rect };

export interface AreaSelectorCallbacks {
  onDone(rect: Rect): void;
  onCancel(): void;
}

/** Customisation points so other capture modes (e.g. scrolling area) can reuse the selection overlay. */
export interface AreaSelectorOptions {
  hint?: string;
  confirmLabel?: string;
  /** Extra CSS for UI added through `mount`. */
  css?: string;
  /** Add extra UI (panels, highlights) to the overlay's shadow root. */
  mount?(root: ShadowRoot): void;
  /** Called when the selection settles (drag end, nudge) or is cleared. */
  onSelectionChange?(rect: Rect | null): void;
  /** True while a pointer drag (new selection, move or resize) is in progress. */
  onDragState?(dragging: boolean): void;
  /** null = capture may start; a string = why it cannot (the Capture button is disabled). */
  canConfirm?(): string | null;
  /** Return true if the key was handled (and must not reach the page). */
  onKey?(e: KeyboardEvent): boolean;
}

/**
 * Lightshot-style region selector: drag to select, then move/resize the selection,
 * confirm with Enter / the Capture button, cancel with Esc. All UI lives in a closed
 * shadow root and is removed (and a paint awaited) before the screenshot is taken.
 */
export class AreaSelector {
  private layer: Layer;
  private stage: HTMLElement;
  private box: HTMLElement;
  private label: HTMLElement;
  private hint: HTMLElement;
  private bar: HTMLElement;
  private captureBtn: HTMLButtonElement;
  private handleEls = new Map<Handle, HTMLElement>();
  private sel: Rect | null = null;
  private action: Action | null = null;
  private finished = false;

  constructor(
    private readonly cb: AreaSelectorCallbacks,
    private readonly opts: AreaSelectorOptions = {},
  ) {
    this.layer = createLayer(CSS + (opts.css ?? ''));
    this.stage = el('div', { className: 'stage', role: 'application', 'aria-label': 'Select an area to capture' });
    this.box = el('div', { className: 'box' });
    this.label = el('div', { className: 'label' });
    this.hint = el('div', { className: 'hint', text: opts.hint ?? 'Drag to select an area  ·  Esc to cancel' });

    const capture = el('button', { type: 'button', className: 'primary', 'aria-label': 'Capture selection' });
    capture.innerHTML = ICONS.check;
    capture.append(` ${opts.confirmLabel ?? 'Capture'}`);
    capture.addEventListener('click', () => void this.confirm());
    this.captureBtn = capture;
    const cancel = el('button', { type: 'button', 'aria-label': 'Cancel' });
    cancel.innerHTML = ICONS.x;
    cancel.append(' Cancel');
    cancel.addEventListener('click', () => this.cancel());
    this.bar = el('div', { className: 'bar' }, [capture, cancel]);

    const root = this.layer.root;
    root.append(this.stage, this.box);
    for (const h of HANDLES) {
      const node = el('div', { className: 'handle' });
      this.handleEls.set(h, node);
      root.append(node);
    }
    root.append(this.label, this.hint, this.bar);
    opts.mount?.(root);

    this.stage.addEventListener('pointerdown', this.onPointerDown);
    this.stage.addEventListener('pointermove', this.onPointerMove);
    this.stage.addEventListener('pointerup', this.onPointerUp);
    this.stage.addEventListener('pointercancel', this.onPointerUp);
    this.stage.addEventListener('dblclick', this.onDblClick);
    this.stage.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
    this.stage.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  /* ---------------- geometry ---------------- */

  private bounds() {
    return { w: window.innerWidth, h: window.innerHeight };
  }

  private clampPoint(x: number, y: number) {
    const b = this.bounds();
    return { x: clamp(x, 0, b.w), y: clamp(y, 0, b.h) };
  }

  private handlePoint(h: Handle, r: Rect) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : cx;
    const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : cy;
    return { x, y };
  }

  private hitTest(x: number, y: number): { kind: 'handle'; handle: Handle } | { kind: 'inside' } | null {
    const r = this.sel;
    if (!r) return null;
    for (const h of HANDLES) {
      const p = this.handlePoint(h, r);
      if (Math.abs(p.x - x) <= HIT && Math.abs(p.y - y) <= HIT) return { kind: 'handle', handle: h };
    }
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return { kind: 'inside' };
    return null;
  }

  /* ---------------- pointer handling ---------------- */

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    this.stage.setPointerCapture(e.pointerId);
    const hit = this.hitTest(e.clientX, e.clientY);
    if (hit?.kind === 'handle' && this.sel) {
      this.action = { kind: 'resize', handle: hit.handle, orig: { ...this.sel } };
    } else if (hit?.kind === 'inside' && this.sel) {
      this.action = { kind: 'move', dx: e.clientX - this.sel.x, dy: e.clientY - this.sel.y, orig: { ...this.sel } };
    } else {
      const p = this.clampPoint(e.clientX, e.clientY);
      this.action = { kind: 'draw', sx: p.x, sy: p.y };
      this.sel = { x: p.x, y: p.y, width: 0, height: 0 };
    }
    this.hint.style.display = 'none';
    this.opts.onDragState?.(true);
    this.render();
  };

  private onPointerMove = (e: PointerEvent) => {
    const a = this.action;
    if (!a) {
      const hit = this.hitTest(e.clientX, e.clientY);
      this.stage.style.cursor =
        hit?.kind === 'handle' ? CURSORS[hit.handle] : hit?.kind === 'inside' ? 'move' : 'crosshair';
      return;
    }
    const p = this.clampPoint(e.clientX, e.clientY);
    if (a.kind === 'draw') {
      this.sel = rectFromPoints(a.sx, a.sy, p.x, p.y);
    } else if (a.kind === 'move') {
      const b = this.bounds();
      this.sel = {
        x: clamp(e.clientX - a.dx, 0, b.w - a.orig.width),
        y: clamp(e.clientY - a.dy, 0, b.h - a.orig.height),
        width: a.orig.width,
        height: a.orig.height,
      };
    } else {
      const o = a.orig;
      let l = o.x, t = o.y, r = o.x + o.width, bt = o.y + o.height;
      if (a.handle.includes('w')) l = p.x;
      if (a.handle.includes('e')) r = p.x;
      if (a.handle.includes('n')) t = p.y;
      if (a.handle.includes('s')) bt = p.y;
      this.sel = rectFromPoints(l, t, r, bt);
    }
    this.render();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.action) return;
    try {
      this.stage.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    this.action = null;
    this.opts.onDragState?.(false);
    if (this.sel && (this.sel.width < MIN_SIZE || this.sel.height < MIN_SIZE)) {
      this.sel = null;
      this.hint.style.display = '';
    }
    this.render();
    this.opts.onSelectionChange?.(this.sel);
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.hitTest(e.clientX, e.clientY)?.kind === 'inside') void this.confirm();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.finished) return;
    if (e.key !== 'Escape' && e.key !== 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && this.opts.onKey?.(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      void this.confirm();
    } else if (this.sel && e.key.startsWith('Arrow')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const step = e.shiftKey ? 10 : 1;
      const b = this.bounds();
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      this.sel = {
        ...this.sel,
        x: clamp(this.sel.x + dx, 0, b.w - this.sel.width),
        y: clamp(this.sel.y + dy, 0, b.h - this.sel.height),
      };
      this.render();
      this.opts.onSelectionChange?.(this.sel);
    }
  };

  /* ---------------- rendering ---------------- */

  private render(): void {
    const r = this.sel;
    const has = !!r && (r.width > 0 || r.height > 0);
    this.stage.classList.toggle('has-sel', has);
    const big = !!r && r.width >= MIN_SIZE && r.height >= MIN_SIZE;
    const showHandles = has && big && this.action?.kind !== 'draw';
    this.box.style.display = has ? 'block' : 'none';
    this.label.style.display = has ? 'block' : 'none';
    this.bar.style.display = !this.action && big ? 'flex' : 'none';
    this.captureBtn.disabled = this.opts.canConfirm?.() != null;
    this.captureBtn.style.opacity = this.captureBtn.disabled ? '0.45' : '';
    for (const [h, node] of this.handleEls) {
      node.style.display = showHandles ? 'block' : 'none';
      if (r) {
        const p = this.handlePoint(h, r);
        node.style.left = `${p.x}px`;
        node.style.top = `${p.y}px`;
      }
    }
    if (!r || !has) return;

    this.box.style.left = `${r.x}px`;
    this.box.style.top = `${r.y}px`;
    this.box.style.width = `${r.width}px`;
    this.box.style.height = `${r.height}px`;

    const dpr = window.devicePixelRatio || 1;
    this.label.textContent = `${Math.round(r.width * dpr)} × ${Math.round(r.height * dpr)} px`;
    const b = this.bounds();
    const above = r.y > 30;
    this.label.style.left = `${clamp(r.x, 4, Math.max(4, b.w - 120))}px`;
    this.label.style.top = `${above ? r.y - 28 : r.y + 6}px`;

    // Toolbar sits below the selection, or above it when there is no room.
    const barW = 190;
    const below = r.y + r.height + 52 < b.h;
    this.bar.style.left = `${clamp(r.x + r.width - barW, 6, Math.max(6, b.w - barW - 6))}px`;
    this.bar.style.top = `${below ? r.y + r.height + 8 : Math.max(6, r.y - 52)}px`;
  }

  /* ---------------- completion ---------------- */

  private async confirm(): Promise<void> {
    const r = this.sel;
    if (this.finished || !r || r.width < MIN_SIZE || r.height < MIN_SIZE) return;
    if (this.opts.canConfirm?.() != null) return;
    this.finished = true;
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    // The overlay must be gone from the compositor *before* the screenshot is taken.
    this.layer.setHidden(true);
    await waitForPaint(70);
    this.destroy();
    this.cb.onDone(rect);
  }

  private cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.destroy();
    this.cb.onCancel();
  }

  /** The current selection (viewport CSS px), if any. */
  get selection(): Rect | null {
    return this.sel ? { ...this.sel } : null;
  }

  /** Re-evaluate button state after the host UI changed what is allowed. */
  refresh(): void {
    this.render();
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.layer.remove();
  }
}
