/** Small DOM utilities shared by the content agent. No page-visible globals except the agent handle. */

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

export async function nextFrames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await nextFrame();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the compositor has certainly presented a frame without our UI.
 * rAF callbacks run before paint, so two frames plus a short timeout is the
 * dependable way to know the previous frame reached the screen.
 */
export async function waitForPaint(extraMs = 40): Promise<void> {
  await nextFrames(2);
  await sleep(extraMs);
}

/** A shadow-DOM host so page CSS can never leak into (or out of) SnapFlow's UI. */
export interface Layer {
  host: HTMLElement;
  root: ShadowRoot;
  setHidden(hidden: boolean): void;
  remove(): void;
}

const layers = new Set<Layer>();

export function createLayer(css: string, opts: { interactive?: boolean } = {}): Layer {
  const host = document.createElement('div');
  host.setAttribute('data-snapflow', '');
  host.style.cssText =
    'all: initial !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;' +
    `pointer-events: ${opts.interactive ? 'auto' : 'none'} !important; contain: layout style !important;`;
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);
  (document.documentElement || document.body).appendChild(host);

  const layer: Layer = {
    host,
    root,
    setHidden(hidden) {
      host.style.setProperty('display', hidden ? 'none' : 'block', 'important');
    },
    remove() {
      host.remove();
      layers.delete(layer);
    },
  };
  layers.add(layer);
  return layer;
}

/** Hide/show every SnapFlow layer (used right before a screenshot is taken). */
export function setAllLayersHidden(hidden: boolean): void {
  for (const l of layers) l.setHidden(hidden);
}

export function removeAllLayers(): void {
  for (const l of [...layers]) l.remove();
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<{ className: string; text: string; title: string; html: never }> & Record<string, string | undefined> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

/** Inline SVG icons (strings are static; no user data is ever interpolated). */
export const ICONS = {
  check:
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

export function iconButton(svg: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.innerHTML = svg + `<span></span>`;
  (b.querySelector('span') as HTMLElement).textContent = label;
  return b;
}

export const BASE_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  button {
    display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 8px; cursor: pointer;
    padding: 7px 12px; font-size: 13px; font-weight: 600; line-height: 1; color: #fff; background: #3b3f4a;
  }
  button:hover { filter: brightness(1.15); }
  button.primary { background: #4f6df5; }
  button:focus-visible { outline: 2px solid #9db0ff; outline-offset: 2px; }
`;
