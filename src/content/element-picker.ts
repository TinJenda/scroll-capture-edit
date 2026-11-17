import { BASE_CSS, createLayer, el, waitForPaint, type Layer } from './dom';

const CSS =
  BASE_CSS +
  `
  .hl { position: fixed; display: none; border: 2px solid #4f6df5; background: rgba(79,109,245,.16); pointer-events: none; border-radius: 2px; }
  .tag { position: fixed; display: none; padding: 3px 7px; border-radius: 6px; background: #1d2030; color: #fff; font: 600 11px/1.2 ui-monospace, Menlo, Consolas, monospace; pointer-events: none; white-space: nowrap; max-width: 80vw; overflow: hidden; text-overflow: ellipsis; }
  .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; background: rgba(20,22,28,.92); color: #fff; font-size: 13px; pointer-events: none; box-shadow: 0 4px 18px rgba(0,0,0,.35); white-space: nowrap; }
  .choice { position: fixed; display: none; flex-direction: column; gap: 6px; padding: 10px; border-radius: 12px; background: rgba(20,22,28,.96); box-shadow: 0 8px 28px rgba(0,0,0,.45); pointer-events: auto; color: #fff; font-size: 12px; min-width: 230px; }
  .choice p { margin: 0 0 2px; color: #c4c8d8; }
`;

const BLOCKED_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'pointerdown', 'pointerup', 'touchstart', 'touchend'];

export interface ElementPickerCallbacks {
  onPick(target: Element, fullContent: boolean): void;
  onCancel(): void;
}

/** Descend into open shadow roots so components built with Web Components can be picked. */
export function deepElementFromPoint(x: number, y: number): Element | null {
  let node: Element | null = document.elementFromPoint(x, y);
  while (node?.shadowRoot) {
    const inner: Element | null = node.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === node) break;
    node = inner;
  }
  return node;
}

export function isVerticallyScrollable(node: Element): boolean {
  const isRoot = node === document.documentElement || node === document.body || node === document.scrollingElement;
  if (isRoot) {
    const se = document.scrollingElement ?? document.documentElement;
    return se.scrollHeight - se.clientHeight > 4;
  }
  const overflowY = getComputedStyle(node).overflowY;
  return /(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight - node.clientHeight > 4;
}

function describe(node: Element): string {
  const id = node.id ? `#${node.id}` : '';
  const cls = typeof node.className === 'string' && node.className.trim()
    ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  const r = node.getBoundingClientRect();
  return `${node.tagName.toLowerCase()}${id}${cls}  ${Math.round(r.width)}×${Math.round(r.height)}`.slice(0, 120);
}

/**
 * DevTools-style element inspector: hover to highlight, click to choose.
 * ↑ selects the parent, ↓ goes back to the child, Esc cancels.
 * Scrollable elements offer "visible part" or "entire content".
 */
export class ElementPicker {
  private layer: Layer;
  private hl: HTMLElement;
  private tag: HTMLElement;
  private hint: HTMLElement;
  private choice: HTMLElement;
  private current: Element | null = null;
  private childStack: Element[] = [];
  private choosing = false;
  private finished = false;

  constructor(private readonly cb: ElementPickerCallbacks) {
    this.layer = createLayer(CSS);
    this.hl = el('div', { className: 'hl' });
    this.tag = el('div', { className: 'tag' });
    this.hint = el('div', { className: 'hint', text: 'Hover an element and click  ·  ↑ parent  ·  ↓ child  ·  Esc to cancel' });
    this.choice = el('div', { className: 'choice' });
    this.layer.root.append(this.hl, this.tag, this.hint, this.choice);

    window.addEventListener('mousemove', this.onMove, true);
    window.addEventListener('click', this.onClick, true);
    window.addEventListener('keydown', this.onKey, true);
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, this.block, true);
  }

  private fromOurUi(e: Event): boolean {
    return e.composedPath().includes(this.layer.host);
  }

  private block = (e: Event) => {
    if (this.fromOurUi(e) || e.type === 'click') return; // click handled separately
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  private onMove = (e: MouseEvent) => {
    if (this.choosing || this.finished) return;
    const node = deepElementFromPoint(e.clientX, e.clientY);
    if (!node || node === this.current) return;
    this.childStack = [];
    this.setCurrent(node);
  };

  private onClick = (e: MouseEvent) => {
    if (this.finished || this.fromOurUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.choosing) return;
    if (!this.current) {
      const node = deepElementFromPoint(e.clientX, e.clientY);
      if (!node) return;
      this.setCurrent(node);
    }
    this.choose();
  };

  private onKey = (e: KeyboardEvent) => {
    if (this.finished) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
    } else if (this.choosing) {
      const k = e.key.toLowerCase();
      if ((k === 'f' || k === 'enter') && this.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.finish(this.current, true);
      } else if (k === 'v' && this.current) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.finish(this.current, false);
      }
      return;
    } else if (e.key === 'ArrowUp' && this.current?.parentElement) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.childStack.push(this.current);
      this.setCurrent(this.current.parentElement);
    } else if (e.key === 'ArrowDown' && this.childStack.length) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setCurrent(this.childStack.pop() as Element);
    } else if (e.key === 'Enter' && this.current) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.choose();
    }
  };

  private setCurrent(node: Element): void {
    this.current = node;
    const r = node.getBoundingClientRect();
    Object.assign(this.hl.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
    this.tag.textContent = describe(node);
    Object.assign(this.tag.style, {
      display: 'block',
      left: `${Math.max(4, Math.min(r.left, window.innerWidth - 220))}px`,
      top: `${r.top > 28 ? r.top - 26 : Math.min(window.innerHeight - 26, r.bottom + 4)}px`,
    });
    this.hint.style.display = 'none';
  }

  private choose(): void {
    const node = this.current;
    if (!node) return;
    if (!isVerticallyScrollable(node)) {
      void this.finish(node, false);
      return;
    }
    // Scrollable: offer the explicit choice.
    this.choosing = true;
    const r = node.getBoundingClientRect();
    this.choice.replaceChildren(
      el('p', { text: 'This element scrolls.' }),
      this.choiceButton('Capture visible part  (V)', () => void this.finish(node, false), false),
      this.choiceButton('Capture entire scrollable content  (F)', () => void this.finish(node, true), true),
      this.choiceButton('Cancel', () => this.cancel(), false),
    );
    Object.assign(this.choice.style, {
      display: 'flex',
      left: `${Math.max(8, Math.min(r.left + 8, window.innerWidth - 260))}px`,
      top: `${Math.max(8, Math.min(r.top + 8, window.innerHeight - 170))}px`,
    });
  }

  private choiceButton(label: string, onClick: () => void, primary: boolean): HTMLButtonElement {
    const b = el('button', { type: 'button', className: primary ? 'primary' : '', text: label });
    b.addEventListener('click', onClick);
    return b;
  }

  private async finish(node: Element, fullContent: boolean): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.layer.setHidden(true);
    await waitForPaint(30);
    this.destroy();
    this.cb.onPick(node, fullContent);
  }

  private cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.destroy();
    this.cb.onCancel();
  }

  destroy(): void {
    window.removeEventListener('mousemove', this.onMove, true);
    window.removeEventListener('click', this.onClick, true);
    window.removeEventListener('keydown', this.onKey, true);
    for (const type of BLOCKED_EVENTS) window.removeEventListener(type, this.block, true);
    this.layer.remove();
  }
}
