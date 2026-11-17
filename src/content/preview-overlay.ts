import { BASE_CSS, createLayer, el, type Layer } from './dom';

const CSS =
  BASE_CSS +
  `
  .card {
    position: fixed; right: 16px; bottom: 16px; width: min(560px, calc(100vw - 32px)); height: min(560px, calc(100vh - 32px));
    border-radius: 14px; overflow: hidden; pointer-events: auto; background: #16181f;
    box-shadow: 0 22px 70px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.14);
    animation: in .16s ease-out;
  }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
  @keyframes in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
`;

/**
 * Hosts the extension-owned preview document in an iframe. The iframe runs in the
 * extension's origin, which is what makes clipboard + storage access reliable –
 * the page itself never sees (or can script) the screenshot.
 */
export class PreviewOverlay {
  private layer: Layer | null = null;
  private frame: HTMLIFrameElement | null = null;

  get isOpen(): boolean {
    return this.layer !== null;
  }

  show(captureId: string): void {
    this.close();
    const layer = createLayer(CSS);
    const frame = el('iframe', {
      title: 'SnapFlow screenshot preview',
      // With use_dynamic_url the frame's URL origin differs from its real origin, so delegate to any origin
      // ('src' would point at the wrong one). Only our own extension document is ever loaded here.
      allow: 'clipboard-write *; clipboard-read *',
      referrerpolicy: 'no-referrer',
    });
    frame.src = `${chrome.runtime.getURL('preview/index.html')}?id=${encodeURIComponent(captureId)}&host=overlay`;
    layer.root.appendChild(el('div', { className: 'card' }, [frame]));
    this.layer = layer;
    this.frame = frame;
    window.addEventListener('message', this.onMessage);
    frame.addEventListener('load', () => frame.focus(), { once: true });
  }

  focus(): void {
    this.frame?.focus();
  }

  setHidden(hidden: boolean): void {
    this.layer?.setHidden(hidden);
  }

  private onMessage = (e: MessageEvent) => {
    // Only trust messages from our own iframe window.
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const d = e.data as { snapflow?: string; type?: string } | null;
    if (d && d.snapflow === 'preview' && d.type === 'close') this.close();
  };

  close(): void {
    window.removeEventListener('message', this.onMessage);
    this.layer?.remove();
    this.layer = null;
    this.frame = null;
  }
}
