import { BASE_CSS, createLayer, el, ICONS, type Layer } from './dom';

const CSS =
  BASE_CSS +
  `
  .pill {
    position: fixed; top: 14px; left: 50%; transform: translateX(-50%); pointer-events: auto;
    display: flex; align-items: center; gap: 12px; padding: 8px 8px 8px 14px; border-radius: 999px;
    background: rgba(24, 26, 33, 0.94); color: #fff; font-size: 13px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
    border: 1px solid rgba(255,255,255,.12);
  }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.3); border-top-color: #fff; animation: s 0.8s linear infinite; }
  @keyframes s { to { transform: rotate(360deg); } }
  .bar { width: 120px; height: 4px; border-radius: 4px; background: rgba(255,255,255,.2); overflow: hidden; }
  .bar > i { display: block; height: 100%; background: #6ee7a8; width: 0%; transition: width .2s; }
  .toast {
    position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); pointer-events: auto; max-width: min(520px, 90vw);
    padding: 10px 14px; border-radius: 10px; color: #fff; font-size: 13px; line-height: 1.4;
    box-shadow: 0 6px 24px rgba(0,0,0,.35); background: rgba(24,26,33,.96); border: 1px solid rgba(255,255,255,.12);
  }
  .toast.error { background: rgba(160, 30, 30, .97); }
  .toast.success { background: rgba(22, 120, 70, .97); }
`;

/** Full-page progress pill with a Cancel button, plus transient toasts. */
export class ProgressUi {
  private layer: Layer | null = null;
  private label: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private toastTimer: number | undefined;
  private toastLayer: Layer | null = null;

  constructor(private readonly onCancel: () => void) {}

  show(text: string, fraction: number): void {
    if (!this.layer) {
      this.layer = createLayer(CSS);
      this.label = el('span');
      this.bar = el('i');
      const cancel = el('button', { type: 'button', 'aria-label': 'Cancel capture' });
      cancel.innerHTML = ICONS.x;
      cancel.append(' Cancel');
      cancel.addEventListener('click', () => this.onCancel());
      const pill = el('div', { className: 'pill', role: 'status' }, [
        el('span', { className: 'spin' }),
        this.label,
        el('span', { className: 'bar' }, [this.bar]),
        cancel,
      ]);
      this.layer.root.appendChild(pill);
    }
    this.layer.setHidden(false);
    if (this.label) this.label.textContent = text;
    if (this.bar) this.bar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }

  setHidden(hidden: boolean): void {
    this.layer?.setHidden(hidden);
  }

  hide(): void {
    this.layer?.remove();
    this.layer = null;
    this.label = null;
    this.bar = null;
  }

  toast(text: string, kind: 'info' | 'error' | 'success' = 'info', ms = 4200): void {
    this.toastLayer?.remove();
    const layer = createLayer(CSS);
    this.toastLayer = layer;
    const t = el('div', { className: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status', text });
    layer.root.appendChild(t);
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      layer.remove();
      if (this.toastLayer === layer) this.toastLayer = null;
    }, ms);
  }

  destroy(): void {
    window.clearTimeout(this.toastTimer);
    this.toastLayer?.remove();
    this.toastLayer = null;
    this.hide();
  }
}
