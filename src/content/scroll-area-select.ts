import type { FullPageTarget } from '@/shared/messages';
import type { Rect, ScrollDirection } from '@/shared/types';
import { AreaSelector } from './area-select';
import { el } from './dom';
import { describeScroll, ScrollTargetDetector, type Detection, type ScrollCandidate } from './scroll-targets';

export interface ScrollAreaChoice {
  target: FullPageTarget;
  direction: ScrollDirection;
  /** The scroll container (for target 'picked'). */
  element: HTMLElement | null;
  /** The selection in viewport CSS px (the capture window for target 'region'). */
  rect: Rect;
}

type Mode = 'auto' | 'manual';

const DIRECTIONS: Array<{ id: ScrollDirection; label: string; key: string }> = [
  { id: 'vertical', label: 'Vertical ↓', key: 'V' },
  { id: 'horizontal', label: 'Horizontal →', key: 'H' },
  { id: 'both', label: 'Both ↘', key: 'B' },
];

const CSS = `
  .sa-panel { position: fixed; top: 14px; left: 14px; width: 340px; max-height: calc(100vh - 28px); overflow: auto;
    padding: 12px; border-radius: 14px; background: rgba(20,22,28,.96); color: #fff; font-size: 12.5px; line-height: 1.4;
    box-shadow: 0 10px 34px rgba(0,0,0,.5); border: 1px solid rgba(255,255,255,.12);
    /* Click-through except for the controls, so a drag that starts under the panel still draws a selection. */
    pointer-events: none; user-select: none; -webkit-user-select: none; }
  .sa-panel button, .sa-panel .sa-cands { pointer-events: auto; }
  .sa-panel h2 { margin: 0 0 8px; font-size: 13px; }
  .sa-row { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 8px; margin: 6px 0; }
  .sa-row > span { color: #aab0c4; }
  .sa-seg { display: flex; gap: 4px; flex-wrap: wrap; }
  .sa-seg button { padding: 5px 8px; font-size: 12px; border-radius: 7px; background: #2b2f3c; }
  .sa-seg button[aria-pressed='true'] { background: #4f6df5; }
  .sa-seg button:disabled { opacity: .35; cursor: not-allowed; }
  kbd { margin-left: 5px; padding: 0 4px; border-radius: 4px; background: rgba(255,255,255,.16); font: 600 10px/1.5 ui-monospace, Consolas, monospace; }
  .sa-cands { display: flex; flex-direction: column; gap: 4px; margin: 8px 0; max-height: 180px; overflow: auto; }
  .sa-cand { display: grid; grid-template-columns: 20px 1fr; gap: 2px 8px; text-align: left; padding: 6px 8px; border-radius: 8px; background: #262a36; width: 100%; }
  .sa-cand.on { background: #34408a; outline: 1.5px solid #8ea2ff; }
  .sa-cand b { grid-row: span 2; align-self: center; text-align: center; border-radius: 50%; background: #f5a623; color: #1a1a1a; width: 18px; height: 18px; line-height: 18px; font-size: 11px; }
  .sa-cand .name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sa-cand .meta { color: #b9bfd4; font-weight: 400; font-size: 11.5px; }
  .sa-cand em { color: #7ee2a8; font-style: normal; margin-left: 6px; font-size: 11px; }
  .sa-summary { padding: 8px 10px; border-radius: 8px; background: #1b1e27; color: #d7dbea; }
  .sa-summary.warn { background: #3b2e10; color: #ffd98a; }
  .sa-keys { margin-top: 8px; color: #8e95ac; font-size: 11px; }
  .sa-hl { position: fixed; border: 2px dashed #f5a623; border-radius: 3px; pointer-events: none; background: rgba(245,166,35,.08); }
  .sa-hl.chosen { border: 2.5px solid #7ee2a8; background: rgba(126,226,168,.10); }
  .sa-hl.hover { border-color: #8ea2ff; background: rgba(142,162,255,.16); }
  .sa-hl i { position: absolute; top: -1px; left: -1px; min-width: 18px; padding: 0 5px; border-radius: 0 0 6px 0; background: #f5a623; color: #1a1a1a; font: 700 11px/18px system-ui, sans-serif; text-align: center; }
  .sa-hl.chosen i { background: #7ee2a8; }
`;

/**
 * Selection UI for "Capture Scrolling Area": drag a rectangle, then either
 *  - **Auto detect** – the scroll containers under the selection are found, ranked and highlighted
 *    (when several match equally well the user must pick one), or
 *  - **Manual region** – the rectangle itself stays fixed on screen while the page scrolls through it.
 * It reuses the AreaSelector overlay (drag/move/resize, Esc, Enter) and adds a side panel.
 */
export class ScrollAreaSelector {
  private selector: AreaSelector;
  private detector = new ScrollTargetDetector();
  private mode: Mode = 'auto';
  private direction: ScrollDirection = 'vertical';
  private sel: Rect | null = null;
  private det: Detection = { candidates: [], suggested: null, ambiguous: false };
  private chosen: number | null = null;
  private hover: number | null = null;

  private modeBtns = new Map<Mode, HTMLButtonElement>();
  private dirBtns = new Map<ScrollDirection, HTMLButtonElement>();
  private candsEl!: HTMLElement;
  private summaryEl!: HTMLElement;
  private hlLayer!: HTMLElement;
  private panel!: HTMLElement;

  constructor(private readonly cb: { onDone(choice: ScrollAreaChoice): void; onCancel(): void }) {
    this.selector = new AreaSelector(
      { onDone: (rect) => this.finish(rect), onCancel: () => this.cb.onCancel() },
      {
        hint: 'Drag to select the scrollable area  ·  Esc to cancel',
        confirmLabel: 'Start capture',
        css: CSS,
        mount: (root) => this.mount(root),
        onSelectionChange: (r) => this.onSelection(r),
        onDragState: (dragging) => this.onDragState(dragging),
        canConfirm: () => this.reason(),
        onKey: (e) => this.onKey(e),
      },
    );
    this.render();
  }

  /* ---------------- UI construction ---------------- */

  private mount(root: ShadowRoot): void {
    const modeSeg = el('div', { className: 'sa-seg' });
    for (const [id, label, key] of [['auto', 'Auto detect', 'A'], ['manual', 'Manual region', 'M']] as const) {
      const b = el('button', { type: 'button' }, [label, el('kbd', { text: key })]);
      b.addEventListener('click', () => this.setMode(id));
      this.modeBtns.set(id, b);
      modeSeg.append(b);
    }
    const dirSeg = el('div', { className: 'sa-seg' });
    for (const d of DIRECTIONS) {
      const b = el('button', { type: 'button' }, [d.label, el('kbd', { text: d.key })]);
      b.addEventListener('click', () => this.setDirection(d.id));
      this.dirBtns.set(d.id, b);
      dirSeg.append(b);
    }
    this.candsEl = el('div', { className: 'sa-cands', role: 'listbox', 'aria-label': 'Detected scroll containers' });
    this.summaryEl = el('div', { className: 'sa-summary', role: 'status' });
    this.hlLayer = el('div');

    const panel = (this.panel = el('div', { className: 'sa-panel', role: 'dialog', 'aria-label': 'Scrolling area capture' }, [
      el('h2', { text: 'Scrolling area capture' }),
      el('div', { className: 'sa-row' }, [el('span', { text: 'Method' }), modeSeg]),
      el('div', { className: 'sa-row' }, [el('span', { text: 'Direction' }), dirSeg]),
      this.candsEl,
      this.summaryEl,
      el('div', { className: 'sa-keys', text: 'Keys: A / M method · V / H / B direction · 1–9 choose container · Enter start · Esc cancel' }),
    ]));
    root.append(this.hlLayer, panel);
  }

  /* ---------------- state ---------------- */

  private axes(): { x: boolean; y: boolean } {
    if (!this.sel) return { x: true, y: true };
    if (this.mode === 'manual') return this.detector.documentAxes();
    const c = this.chosen !== null ? this.det.candidates[this.chosen] : null;
    if (c) return { x: c.horizontal, y: c.vertical };
    const list = this.det.candidates;
    return { x: list.some((k) => k.horizontal), y: list.some((k) => k.vertical) };
  }

  private allowed(d: ScrollDirection): boolean {
    const a = this.axes();
    return d === 'vertical' ? a.y : d === 'horizontal' ? a.x : a.x && a.y;
  }

  private normalizeDirection(): void {
    if (this.allowed(this.direction)) return;
    const next = DIRECTIONS.find((d) => this.allowed(d.id));
    if (next) this.direction = next.id;
  }

  private reason(): string | null {
    if (!this.sel) return 'Drag to select an area first.';
    if (this.mode === 'auto') {
      if (!this.det.candidates.length) return 'No scrollable container found in this area. Select a different area, or use Manual region (M).';
      if (this.chosen === null) return 'More than one container matches. Choose the one you want: click it, or press its number.';
    }
    if (!this.allowed(this.direction)) {
      return this.mode === 'manual'
        ? `The page itself does not scroll ${this.direction === 'both' ? 'in both directions' : this.direction + 'ly'}. Use Auto detect to pick a scroll container instead.`
        : `The chosen container does not scroll ${this.direction === 'both' ? 'in both directions' : this.direction + 'ly'}.`;
    }
    return null;
  }

  private recompute(): void {
    if (this.sel && this.mode === 'auto') {
      this.det = this.detector.detect(this.sel);
      this.chosen = this.det.suggested;
    } else {
      this.det = { candidates: [], suggested: null, ambiguous: false };
      this.chosen = null;
    }
    this.hover = null;
    this.normalizeDirection();
  }

  /** The panel never sits under a drag: it is hidden while dragging and until a selection exists. */
  private onDragState(dragging: boolean): void {
    if (this.panel) this.panel.style.visibility = dragging ? 'hidden' : 'visible';
  }

  private onSelection(rect: Rect | null): void {
    this.sel = rect;
    this.recompute();
    this.render();
    this.selector.refresh();
  }

  private setMode(m: Mode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.recompute();
    this.render();
    this.selector.refresh();
  }

  private setDirection(d: ScrollDirection): void {
    if (!this.allowed(d)) return;
    this.direction = d;
    this.render();
    this.selector.refresh();
  }

  private choose(i: number): void {
    if (i < 0 || i >= this.det.candidates.length) return;
    this.chosen = i;
    this.normalizeDirection();
    this.render();
    this.selector.refresh();
  }

  private onKey(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (k === 'a') this.setMode('auto');
    else if (k === 'm') this.setMode('manual');
    else if (k === 'v') this.setDirection('vertical');
    else if (k === 'h') this.setDirection('horizontal');
    else if (k === 'b') this.setDirection('both');
    else if (/^[1-9]$/.test(k) && this.mode === 'auto') this.choose(Number(k) - 1);
    else return false;
    return true;
  }

  /* ---------------- rendering ---------------- */

  private render(): void {
    for (const [id, b] of this.modeBtns) b.setAttribute('aria-pressed', String(this.mode === id));
    for (const [id, b] of this.dirBtns) {
      b.setAttribute('aria-pressed', String(this.direction === id));
      b.disabled = !this.allowed(id);
    }

    // candidate list (auto mode only)
    this.candsEl.replaceChildren();
    this.candsEl.style.display = this.mode === 'auto' && this.det.candidates.length ? 'flex' : 'none';
    this.det.candidates.forEach((c, i) => {
      const name = el('span', { className: 'name', text: c.label });
      if (i === this.det.suggested) name.append(el('em', { text: 'suggested' }));
      const b = el('button', { type: 'button', className: `sa-cand${this.chosen === i ? ' on' : ''}`, role: 'option' }, [
        el('b', { text: String(i + 1) }),
        name,
        el('span', { className: 'meta', text: `${Math.round(c.clientWidth)}×${Math.round(c.clientHeight)} px · scrolls ${describeScroll(c)}` }),
      ]);
      b.setAttribute('aria-selected', String(this.chosen === i));
      b.addEventListener('click', () => this.choose(i));
      b.addEventListener('mouseenter', () => {
        this.hover = i;
        this.renderHighlights();
      });
      b.addEventListener('mouseleave', () => {
        this.hover = null;
        this.renderHighlights();
      });
      this.candsEl.append(b);
    });

    // summary: what will be captured, before starting
    const why = this.reason();
    this.summaryEl.className = `sa-summary${why ? ' warn' : ''}`;
    this.summaryEl.textContent = why ?? this.summary();
    this.renderHighlights();
    this.panel.style.display = this.sel ? 'block' : 'none';
    this.placePanel();
  }

  /** Park the panel in the first screen corner that does not cover the selection. */
  private placePanel(): void {
    if (!this.panel) return;
    const pw = this.panel.offsetWidth || 340;
    const ph = this.panel.offsetHeight || 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = 14;
    const corners: Array<{ x: number; y: number; css: Partial<CSSStyleDeclaration> }> = [
      { x: m, y: m, css: { left: m + 'px', top: m + 'px', right: 'auto', bottom: 'auto' } },
      { x: vw - pw - m, y: m, css: { right: m + 'px', top: m + 'px', left: 'auto', bottom: 'auto' } },
      { x: m, y: vh - ph - m, css: { left: m + 'px', bottom: m + 'px', right: 'auto', top: 'auto' } },
      { x: vw - pw - m, y: vh - ph - m, css: { right: m + 'px', bottom: m + 'px', left: 'auto', top: 'auto' } },
    ];
    const sel = this.sel;
    const overlaps = (c: { x: number; y: number }) =>
      !!sel && c.x < sel.x + sel.width + 8 && c.x + pw > sel.x - 8 && c.y < sel.y + sel.height + 8 && c.y + ph > sel.y - 8;
    const pick = corners.find((c) => !overlaps(c)) ?? corners[0];
    Object.assign(this.panel.style, pick.css);
  }

  private summary(): string {
    const dir = this.direction === 'both' ? 'both directions' : this.direction;
    if (this.mode === 'manual' && this.sel) {
      return `Target: the selected region (${Math.round(this.sel.width)}×${Math.round(this.sel.height)} px), fixed on screen while the page scrolls ${dir}.`;
    }
    const c = this.chosen !== null ? this.det.candidates[this.chosen] : null;
    if (!c) return '';
    const w = Math.round(c.isDocument ? c.scrollWidth : c.horizontal && this.direction !== 'vertical' ? c.scrollWidth : c.clientWidth);
    const h = Math.round(c.isDocument ? c.scrollHeight : c.vertical && this.direction !== 'horizontal' ? c.scrollHeight : c.clientHeight);
    return `Target: ${c.label}. Direction: ${dir}. Result ≈ ${w.toLocaleString()} × ${h.toLocaleString()} px (CSS).`;
  }

  private renderHighlights(): void {
    this.hlLayer.replaceChildren();
    if (this.mode !== 'auto') return;
    this.det.candidates.forEach((c, i) => {
      const box = el('div', { className: `sa-hl${this.chosen === i ? ' chosen' : ''}${this.hover === i ? ' hover' : ''}` }, [el('i', { text: String(i + 1) })]);
      Object.assign(box.style, {
        left: `${c.rect.x}px`,
        top: `${c.rect.y}px`,
        width: `${c.rect.width}px`,
        height: `${c.rect.height}px`,
      });
      this.hlLayer.append(box);
    });
  }

  /* ---------------- completion ---------------- */

  private finish(rect: Rect): void {
    if (this.mode === 'manual') {
      this.cb.onDone({ target: 'region', direction: this.direction, element: null, rect });
      return;
    }
    const c: ScrollCandidate | undefined = this.chosen !== null ? this.det.candidates[this.chosen] : undefined;
    if (!c) {
      this.cb.onCancel();
      return;
    }
    this.cb.onDone({ target: c.isDocument ? 'document' : 'picked', direction: this.direction, element: c.el, rect });
  }

  destroy(): void {
    this.selector.destroy();
  }
}
