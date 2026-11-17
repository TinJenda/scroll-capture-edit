import { intersectRect } from '@/shared/geometry';
import { IMAGE_WAIT_MS } from '@/shared/constants';
import { SnapflowError } from '@/shared/errors';
import type { FullPagePrepareResult, FullPageScrollResult, FullPageTarget } from '@/shared/messages';
import { frameRole, shouldHideFixed, type FixedPhase } from '@/shared/scroll';
import type { Rect } from '@/shared/types';
import { nextFrame, nextFrames, sleep } from './dom';

/** Every element, descending into open shadow roots. Our own UI hosts are skipped. */
export function* allElements(root: ParentNode): Generator<HTMLElement> {
  for (const node of root.querySelectorAll<HTMLElement>('*')) {
    if (node.hasAttribute('data-snapflow')) continue;
    yield node;
    if (node.shadowRoot) yield* allElements(node.shadowRoot);
  }
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

/**
 * Page-side half of the full-page capture engine. It never takes screenshots; it only
 * (1) chooses what scrolls, (2) scrolls it deterministically, (3) keeps fixed/sticky
 * chrome from repeating in every frame, and (4) restores the page – always.
 *
 * Every modification is recorded so restore() can undo it exactly, even after errors.
 */
export class PageDriver {
  private active = false;
  private styleEl: HTMLStyleElement | null = null;
  private saved = new Map<HTMLElement, Map<string, SavedProp>>();
  private fixed: FixedEntry[] = [];
  private scroller: HTMLElement | null = null; // null = the document
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

  private setScroll(top: number): void {
    if (this.scroller) {
      (this.scroller as ScrollerEl).scrollTo({ top, left: 0, behavior: 'instant' });
    } else {
      window.scrollTo({ top, left: 0, behavior: 'instant' });
    }
  }

  /* ------------------------------ geometry ------------------------------ */

  private viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  /** Capture region (CSS px, viewport coordinates). Excludes scrollbars so they never get stitched. */
  private region(): Rect {
    if (!this.scroller) {
      const se = this.docScroller();
      return {
        x: 0,
        y: 0,
        width: se.clientWidth || window.innerWidth,
        height: se.clientHeight || window.innerHeight,
      };
    }
    const r = this.scroller.getBoundingClientRect();
    const box = {
      x: r.left + this.scroller.clientLeft,
      y: r.top + this.scroller.clientTop,
      width: this.scroller.clientWidth,
      height: this.scroller.clientHeight,
    };
    const vp = this.docScroller();
    return (
      intersectRect(box, { x: 0, y: 0, width: vp.clientWidth || window.innerWidth, height: vp.clientHeight || window.innerHeight }) ??
      box
    );
  }

  private metrics() {
    const target = this.scroller ?? this.docScroller();
    const region = this.region();
    const scrollTop = target.scrollTop;
    const scrollHeight = target.scrollHeight;
    const clientHeight = this.scroller ? this.scroller.clientHeight : this.docScroller().clientHeight || window.innerHeight;
    return {
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScrollTop: Math.max(0, scrollHeight - clientHeight),
      atBottom: scrollTop + clientHeight >= scrollHeight - 1,
      region,
    };
  }

  /* ------------------------------ scroller selection ------------------------------ */

  private findMainScroller(): HTMLElement | null {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    for (const node of allElements(document)) {
      if (node === document.documentElement || node === document.body) continue;
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

  private classifyPositioned(region: Rect): number {
    this.fixed = [];
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
      if (!intersectRect({ x: r.left, y: r.top, width: r.width, height: r.height }, region)) continue;
      // Tall fixed elements (side navigation, modal backdrops) are part of the frame on purpose.
      if (r.height >= region.height * 0.7) continue;

      const centerY = r.top + r.height / 2 - region.y;
      this.fixed.push({
        el: node,
        anchor: centerY < region.height / 2 ? 'header' : 'footer',
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

  prepare(target: FullPageTarget, picked: Element | null): FullPagePrepareResult {
    this.restore();
    this.active = true;
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
      const docScrollable = se.scrollHeight - se.clientHeight > 1;

      if (target === 'picked' && picked && !isDocElement(picked)) {
        this.scroller = picked as HTMLElement;
      } else if (target === 'picked' && picked && isDocElement(picked) && docScrollable) {
        this.scroller = null;
      } else if (target === 'document' && !docScrollable) {
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

      this.setScroll(0);
      const region = this.region();
      if (region.width < 20 || region.height < 20) {
        throw new SnapflowError('CAPTURE_FAILED', 'The selected area is too small to capture.');
      }
      if (this.scroller && region.height < this.scroller.clientHeight - 2) {
        notes.push('The element is taller than the window, so only its visible part could be captured.');
      }

      const fixedCount = this.classifyPositioned(region);
      this.role = null;
      const m = this.metrics();
      const target2 = this.scroller ?? se;
      return {
        viewport: this.viewport(),
        dpr: window.devicePixelRatio || 1,
        kind: this.scroller ? 'element' : 'document',
        region: m.region,
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
    const pending: Promise<unknown>[] = [];
    for (const img of Array.from(document.images)) {
      if (img.complete && img.naturalWidth > 0) continue;
      const r = img.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
      pending.push(img.decode().catch(() => undefined));
    }
    if (pending.length) await Promise.race([Promise.allSettled(pending), sleep(timeoutMs)]);
  }

  async scrollTo(y: number, frame: number, settleMs: number): Promise<FullPageScrollResult> {
    if (!this.active) throw new SnapflowError('CAPTURE_FAILED', 'Full-page capture was not prepared.');

    // Scroll, let layout/lazy content settle. If the page grew and the target is now reachable, scroll again.
    for (let attempt = 0; attempt < 3; attempt++) {
      this.setScroll(y);
      await nextFrames(2);
      await sleep(settleMs);
      await this.waitForImages(IMAGE_WAIT_MS);
      await nextFrame();
      const m = this.metrics();
      if (Math.abs(m.scrollTop - y) <= 1 || m.scrollTop >= m.maxScrollTop - 1) break;
    }

    let m = this.metrics();
    this.applyRole(frameRole(frame, m.atBottom));
    await nextFrame();
    m = this.metrics();

    return {
      scrollTop: m.scrollTop,
      scrollHeight: m.scrollHeight,
      maxScrollTop: m.maxScrollTop,
      atBottom: m.atBottom,
      region: m.region,
      viewport: this.viewport(),
    };
  }

  measure(): { scrollHeight: number; scrollTop: number } {
    const target = this.scroller ?? this.docScroller();
    return { scrollHeight: target.scrollHeight, scrollTop: target.scrollTop };
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
  }
}
