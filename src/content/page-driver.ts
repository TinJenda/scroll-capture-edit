import { intersectRect } from '@/shared/geometry';
import { IMAGE_WAIT_MS } from '@/shared/constants';
import { SnapflowError } from '@/shared/errors';
import type { AxisInfo, FullPagePrepareResult, FullPageScrollResult } from '@/shared/messages';
import { resolveAxes } from '@/shared/scroll-coords';
import { frameRole, shouldHideFixed, type FixedPhase } from '@/shared/scroll';
import type { Rect, ScrollDirection } from '@/shared/types';
import { nextFrame, nextFrames, sleep } from './dom';

/** Every element, descending into open shadow roots. Our own UI hosts are skipped. */
export function* allElements(root: ParentNode): Generator<HTMLElement> {
  for (const node of root.querySelectorAll<HTMLElement>('*')) {
    if (node.hasAttribute('data-snapflow')) continue;
    yield node;
    if (node.shadowRoot) yield* allElements(node.shadowRoot);
  }
}

/** What to scroll. 'element' needs the element passed to prepare(); 'region' carries a viewport rectangle. */
export interface ScrollSpec {
  kind: 'document' | 'element' | 'region';
  direction: ScrollDirection;
  /** region: the capture window in viewport CSS px. */
  rect?: Rect;
  /**
   * element: the user's selection relative to the container's client box. It narrows the capture across
   * the scroll axis (e.g. one column of a table); along the scroll axis the whole content is always used.
   */
  rel?: Rect | null;
}

interface FixedEntry {
  el: HTMLElement;
  anchor: 'header' | 'footer';
  hidden: boolean;
  prevValue: string;
  prevPriority: string;
}

interface SavedProp {
  value: string;
  priority: string;
}

type ScrollerEl = Element & { scrollTo: Element['scrollTo'] };

const HIDDEN_OVERFLOW = /^(hidden|clip)$/;

/** True when `overflow: hidden|clip` on <html> (or <body>) stops the page itself from scrolling on that axis. */
export function isViewportOverflowBlocked(axis: 'x' | 'y'): boolean {
  const pick = (cs: CSSStyleDeclaration) => (axis === 'x' ? cs.overflowX : cs.overflowY);
  let value = pick(getComputedStyle(document.documentElement));
  if (value === 'visible' && document.body) value = pick(getComputedStyle(document.body));
  return HIDDEN_OVERFLOW.test(value);
}

/**
 * Page-side half of the scrolling capture engine. It never takes screenshots; it only
 * (1) works out what scrolls and where the capture window is, (2) scrolls deterministically on one or
 * both axes, (3) keeps fixed/sticky chrome from repeating in every tile, and (4) restores the page – always.
 *
 * Every modification is recorded so restore() can undo it exactly, even after errors or cancellation.
 */
export class PageDriver {
  private active = false;
  private styleEl: HTMLStyleElement | null = null;
  private saved = new Map<HTMLElement, Map<string, SavedProp>>();
  private fixed: FixedEntry[] = [];
  private scroller: HTMLElement | null = null; // null = the document
  private spec: ScrollSpec = { kind: 'document', direction: 'vertical' };
  private scrollsX = false;
  private scrollsY = false;
  private origin = { winX: 0, winY: 0, elTop: 0, elLeft: 0 };
  private role: FixedPhase | null = null;

  get isActive(): boolean {
    return this.active;
  }

  /* ------------------------------ helpers ------------------------------ */

  private docScroller(): HTMLElement {
    return (document.scrollingElement ?? document.documentElement) as HTMLElement;
  }

  /** Remember an element's inline value once, then apply an `!important` override. */
  private override(node: HTMLElement, prop: string, value: string): void {
    let props = this.saved.get(node);
    if (!props) {
      props = new Map();
      this.saved.set(node, props);
    }
    if (!props.has(prop)) {
      props.set(prop, { value: node.style.getPropertyValue(prop), priority: node.style.getPropertyPriority(prop) });
    }
    node.style.setProperty(prop, value, 'important');
  }

  private restoreStyles(): void {
    for (const [node, props] of this.saved) {
      for (const [prop, prev] of props) {
        if (prev.value) node.style.setProperty(prop, prev.value, prev.priority);
        else node.style.removeProperty(prop);
      }
    }
    this.saved.clear();
  }

  /** null leaves that axis where it is. */
  private setScroll(left: number | null, top: number | null): void {
    const opts: ScrollToOptions = { behavior: 'instant' };
    if (top !== null) opts.top = top;
    if (left !== null) opts.left = left;
    if (this.scroller) (this.scroller as ScrollerEl).scrollTo(opts);
    else window.scrollTo(opts);
  }

  /* ------------------------------ geometry ------------------------------ */

  private viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** Viewport area without scrollbars (CSS px). */
  private viewportArea(): Rect {
    const se = this.docScroller();
    return { x: 0, y: 0, width: se.clientWidth || window.innerWidth, height: se.clientHeight || window.innerHeight };
  }

  /**
   * The capture window (CSS px, viewport coordinates). It stays anchored while the content scrolls
   * through it, and never includes scrollbars:
   *  - document → the whole viewport area
   *  - container → the container's client box
   *  - manual region → the user's rectangle
   */
  private windowRect(): Rect {
    const area = this.viewportArea();
    if (this.spec.kind === 'region' && this.spec.rect) {
      return intersectRect(this.spec.rect, area) ?? this.spec.rect;
    }
    if (!this.scroller) return area;
    const r = this.scroller.getBoundingClientRect();
    const box = {
      x: r.left + this.scroller.clientLeft,
      y: r.top + this.scroller.clientTop,
      width: this.scroller.clientWidth,
      height: this.scroller.clientHeight,
    };
    const full = intersectRect(box, area) ?? box;

    // Narrow across the scroll axis to the user's selection (single-axis captures only).
    const rel = this.spec.kind === 'element' ? this.spec.rel : null;
    if (!rel) return full;
    const cross = this.scrollsY && !this.scrollsX ? 'x' : this.scrollsX && !this.scrollsY ? 'y' : null;
    if (cross === 'x') {
      const x0 = Math.max(full.x, box.x + rel.x);
      const x1 = Math.min(full.x + full.width, box.x + rel.x + rel.width);
      if (x1 - x0 >= 20) return { ...full, x: x0, width: x1 - x0 };
    } else if (cross === 'y') {
      const y0 = Math.max(full.y, box.y + rel.y);
      const y1 = Math.min(full.y + full.height, box.y + rel.y + rel.height);
      if (y1 - y0 >= 20) return { ...full, y: y0, height: y1 - y0 };
    }
    return full;
  }

  private metrics() {
    const target = this.scroller ?? this.docScroller();
    const area = this.viewportArea();
    const clientHeight = this.scroller ? this.scroller.clientHeight : area.height;
    const clientWidth = this.scroller ? this.scroller.clientWidth : area.width;
    const scrollTop = target.scrollTop;
    const scrollLeft = target.scrollLeft;
    const scrollHeight = target.scrollHeight;
    const scrollWidth = target.scrollWidth;
    return {
      scrollTop,
      scrollLeft,
      scrollHeight,
      scrollWidth,
      clientHeight,
      clientWidth,
      maxTop: Math.max(0, scrollHeight - clientHeight),
      maxLeft: Math.max(0, scrollWidth - clientWidth),
      atBottom: scrollTop + clientHeight >= scrollHeight - 1,
      atRight: scrollLeft + clientWidth >= scrollWidth - 1,
      window: this.windowRect(),
    };
  }

  private axes(): { x: AxisInfo; y: AxisInfo } {
    const m = this.metrics();
    // A container can be scrolled by script even with overflow:hidden; the viewport cannot.
    const docBlocked = (axis: 'x' | 'y') => !this.scroller && isViewportOverflowBlocked(axis);
    return {
      y: {
        scrollable: !docBlocked('y') && m.scrollHeight - m.clientHeight > 1,
        scroll: m.scrollTop,
        scrollLen: m.scrollHeight,
        clientLen: m.clientHeight,
        maxScroll: m.maxTop,
      },
      x: {
        scrollable: !docBlocked('x') && m.scrollWidth - m.clientWidth > 1,
        scroll: m.scrollLeft,
        scrollLen: m.scrollWidth,
        clientLen: m.clientWidth,
        maxScroll: m.maxLeft,
      },
    };
  }

  /* ------------------------------ scroller selection ------------------------------ */

  private findMainScroller(): HTMLElement | null {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const node of allElements(document)) {
      if (node === document.documentElement) continue;
      const ch = node.clientHeight;
      if (ch < 80 || node.clientWidth < 80 || node.scrollHeight - ch < 40) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) continue;
      const r = node.getBoundingClientRect();
      const vis = intersectRect({ x: r.left, y: r.top, width: r.width, height: r.height }, { x: 0, y: 0, width: vw, height: vh });
      if (!vis) continue;
      const area = vis.width * vis.height;
      if (area >= 0.4 * vw * vh && area > bestArea) {
        best = node;
        bestArea = area;
      }
    }
    return best;
  }

  /* ------------------------------ fixed / sticky ------------------------------ */

  private classifyPositioned(win: Rect): number {
    this.fixed = [];
    const horizontalOnly = this.scrollsX && !this.scrollsY;
    for (const node of allElements(document)) {
      const cs = getComputedStyle(node);
      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (this.scroller && (node === this.scroller || node.contains(this.scroller))) continue;
      if (cs.display === 'none') continue;

      if (pos === 'sticky') {
        // A sticky element's *natural* position equals its static position, so making it
        // static removes the "stuck" duplicates without hiding any real content.
        this.override(node, 'position', 'static');
        continue;
      }

      if (cs.visibility === 'hidden') continue;
      const r = node.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!intersectRect({ x: r.left, y: r.top, width: r.width, height: r.height }, win)) continue;
      // Persistent fixed elements (side navigation, modal backdrops) span most of the window on the
      // scrolled axis; they are part of every frame on purpose.
      const tallV = r.height >= win.height * 0.7;
      const wideH = r.width >= win.width * 0.7;
      if (this.scrollsX && this.scrollsY ? tallV || wideH : horizontalOnly ? wideH : tallV) continue;

      const anchor = horizontalOnly
        ? r.left + r.width / 2 - win.x < win.width / 2
        : r.top + r.height / 2 - win.y < win.height / 2;
      this.fixed.push({
        el: node,
        anchor: anchor ? 'header' : 'footer',
        hidden: false,
        prevValue: node.style.getPropertyValue('visibility'),
        prevPriority: node.style.getPropertyPriority('visibility'),
      });
    }
    return this.fixed.length;
  }

  private applyRole(role: FixedPhase): void {
    if (this.role === role) return;
    this.role = role;
    for (const f of this.fixed) {
      const hide = shouldHideFixed(f.anchor, role);
      if (hide === f.hidden) continue;
      if (hide) f.el.style.setProperty('visibility', 'hidden', 'important');
      else if (f.prevValue) f.el.style.setProperty('visibility', f.prevValue, f.prevPriority);
      else f.el.style.removeProperty('visibility');
      f.hidden = hide;
    }
  }

  /* ------------------------------ lifecycle ------------------------------ */

  prepare(spec: ScrollSpec, picked: Element | null): FullPagePrepareResult {
    this.restore();
    this.active = true;
    this.spec = spec;
    const notes: string[] = [];
    let autoNested = false;

    try {
      this.styleEl = document.createElement('style');
      this.styleEl.setAttribute('data-snapflow-style', '');
      this.styleEl.textContent =
        ':root, :root * { scroll-behavior: auto !important; scroll-snap-type: none !important; overflow-anchor: none !important; }';
      (document.head ?? document.documentElement).appendChild(this.styleEl);

      this.origin.winX = window.scrollX;
      this.origin.winY = window.scrollY;

      const se = this.docScroller();
      const isDocElement = (n: Element) => n === document.documentElement || n === document.body || n === se;

      if (spec.kind === 'element') {
        if (!picked) throw new SnapflowError('CAPTURE_FAILED', 'The chosen element is no longer available.');
        // <body> can be the real scroller on app-style pages (html{overflow:hidden}; body{overflow:auto}).
        const docScrolls = se.scrollHeight - se.clientHeight > 1 || se.scrollWidth - se.clientWidth > 1;
        this.scroller = isDocElement(picked) && docScrolls ? null : (picked as HTMLElement);
      } else if (spec.kind === 'region') {
        this.scroller = null;
      } else if (spec.direction === 'vertical' && se.scrollHeight - se.clientHeight <= 1) {
        // Full page of an "app shell" whose real scrolling happens in an inner container.
        const nested = this.findMainScroller();
        if (nested) {
          this.scroller = nested;
          autoNested = true;
          notes.push('This page scrolls inside an inner container, so that container was captured.');
        }
      }

      if (this.scroller) {
        this.origin.elTop = this.scroller.scrollTop;
        this.origin.elLeft = this.scroller.scrollLeft;
        const r = this.scroller.getBoundingClientRect();
        this.scroller.scrollIntoView({ block: r.height > window.innerHeight ? 'start' : 'nearest', inline: 'nearest', behavior: 'instant' });
      }

      // Which axes does this target really scroll? A request is reduced to what is possible.
      const can = this.axes();
      const r = resolveAxes(spec.direction, { x: can.x.scrollable, y: can.y.scrollable });
      const singleFrameFullPage = spec.kind === 'document' && spec.direction === 'vertical';
      if (!r.x && !r.y && !singleFrameFullPage) {
        throw new SnapflowError(
          'CAPTURE_FAILED',
          `The selected ${spec.kind === 'region' ? 'page' : 'area'} does not scroll ${spec.direction === 'both' ? 'in either direction' : spec.direction + 'ly'}. ` +
            'Choose another direction or another container.',
        );
      }
      if (spec.direction === 'both' && r.direction !== 'both') {
        notes.push(`The target only scrolls ${r.direction}ly, so only that direction was captured.`);
      }
      this.scrollsX = r.x;
      this.scrollsY = r.y;

      this.setScroll(r.x ? 0 : null, r.y ? 0 : null); // start of every scrolled axis
      const win = this.windowRect();
      if (win.width < 20 || win.height < 20) {
        throw new SnapflowError('CAPTURE_FAILED', 'The selected area is too small to capture.');
      }
      if (this.scroller && !this.scrollsX && win.height < this.scroller.clientHeight - 2) {
        notes.push('The element is taller than the window, so only its visible part could be captured.');
      }

      const fixedCount = this.classifyPositioned(win);
      this.role = null;
      const m = this.metrics();
      const axes = this.axes();
      const target2 = this.scroller ?? se;
      return {
        viewport: this.viewport(),
        dpr: window.devicePixelRatio || 1,
        kind: this.scroller ? 'element' : spec.kind === 'region' ? 'region' : 'document',
        region: m.window,
        direction: r.direction,
        x: axes.x,
        y: axes.y,
        scrollHeight: m.scrollHeight,
        scrollTop: target2.scrollTop,
        horizontalOverflow: target2.scrollWidth - target2.clientWidth > 4,
        notes,
        autoNested,
        fixedCount,
      };
    } catch (err) {
      this.restore();
      throw err;
    }
  }

  /** Waits for images in view that are still decoding/loading (bounded). */
  private async waitForImages(timeoutMs: number): Promise<void> {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const pending: Promise<unknown>[] = [];
    for (const img of Array.from(document.images)) {
      if (img.complete && img.naturalWidth > 0) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width === 0) continue;
      pending.push(img.decode().catch(() => undefined));
    }
    if (pending.length) await Promise.race([Promise.allSettled(pending), sleep(timeoutMs)]);
  }

  async scrollTo(x: number, y: number, frame: number, settleMs: number): Promise<FullPageScrollResult> {
    if (!this.active) throw new SnapflowError('CAPTURE_FAILED', 'Scrolling capture was not prepared.');

    // Scroll, let layout/lazy content settle. If the content grew and the target is now reachable, scroll again.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.setScroll(this.scrollsX ? x : null, this.scrollsY ? y : null);
      await nextFrames(2);
      await sleep(settleMs);
      await this.waitForImages(IMAGE_WAIT_MS);
      await nextFrame();
      const m = this.metrics();
      const okY = !this.scrollsY || Math.abs(m.scrollTop - y) <= 1 || m.scrollTop >= m.maxTop - 1;
      const okX = !this.scrollsX || Math.abs(m.scrollLeft - x) <= 1 || m.scrollLeft >= m.maxLeft - 1;
      if (okX && okY) break;
    }

    let m = this.metrics();
    const isLast = (!this.scrollsY || m.atBottom) && (!this.scrollsX || m.atRight);
    this.applyRole(frameRole(frame, isLast));
    await nextFrame();
    m = this.metrics();

    return {
      scrollTop: m.scrollTop,
      scrollLeft: m.scrollLeft,
      scrollHeight: m.scrollHeight,
      scrollWidth: m.scrollWidth,
      maxScrollTop: m.maxTop,
      maxScrollLeft: m.maxLeft,
      atBottom: m.atBottom,
      atRight: m.atRight,
      region: m.window,
      viewport: this.viewport(),
    };
  }

  measure(): { scrollHeight: number; scrollTop: number; scrollWidth: number; scrollLeft: number } {
    const target = this.scroller ?? this.docScroller();
    return { scrollHeight: target.scrollHeight, scrollTop: target.scrollTop, scrollWidth: target.scrollWidth, scrollLeft: target.scrollLeft };
  }

  restore(): void {
    if (!this.active && !this.styleEl && this.saved.size === 0 && this.fixed.length === 0) return;
    this.active = false;
    for (const f of this.fixed) {
      if (!f.hidden) continue;
      if (f.prevValue) f.el.style.setProperty('visibility', f.prevValue, f.prevPriority);
      else f.el.style.removeProperty('visibility');
    }
    this.fixed = [];
    this.restoreStyles();
    this.styleEl?.remove();
    this.styleEl = null;
    this.role = null;
    try {
      if (this.scroller) {
        this.scroller.scrollTo({ top: this.origin.elTop, left: this.origin.elLeft, behavior: 'instant' });
      }
      window.scrollTo({ top: this.origin.winY, left: this.origin.winX, behavior: 'instant' });
    } catch {
      /* the element may have been removed from the DOM */
    }
    this.scroller = null;
    this.scrollsX = false;
    this.scrollsY = false;
  }
}
