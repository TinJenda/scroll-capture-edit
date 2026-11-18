/**
 * SnapFlow content agent – a classic (IIFE) script injected on demand with
 * chrome.scripting.executeScript. It is a thin, dumb driver for the page:
 * the service worker orchestrates, this file only touches the DOM.
 */
import { SnapflowError, serializeError } from '@/shared/errors';
import {
  parseAgentCommand,
  type AgentCommand,
  type AgentEvent,
  type FullPageTarget,
  type ViewportInfo,
} from '@/shared/messages';
import type { Rect } from '@/shared/types';
import { AreaSelector } from './area-select';
import { setAllLayersHidden, removeAllLayers, waitForPaint } from './dom';
import { ElementPicker } from './element-picker';
import { PageDriver, type ScrollSpec } from './page-driver';
import { PreviewOverlay } from './preview-overlay';
import { ProgressUi } from './progress';
import { ScrollAreaSelector } from './scroll-area-select';

interface AgentHandle {
  destroy(): void;
}

/** What the user chose to scroll; consumed by the next AGENT_FP_PREPARE. */
interface PendingScroll {
  target: FullPageTarget;
  element: Element | null;
  rect: Rect | null;
  /** Selection relative to the container (narrows across the scroll axis). */
  rel?: Rect | null;
}

const GLOBAL_KEY = '__snapflowAgent__';

class Agent implements AgentHandle {
  private progress = new ProgressUi(
    () => this.send({ type: 'EVT_STOP_FULLPAGE' }),
    () => this.send({ type: 'EVT_CANCEL_FULLPAGE' }),
  );
  private driver = new PageDriver();
  private preview = new PreviewOverlay();
  private selector: AreaSelector | null = null;
  private picker: ElementPicker | null = null;
  private scrollSelector: ScrollAreaSelector | null = null;
  private pending: PendingScroll | null = null;
  private port: chrome.runtime.Port | null = null;
  private destroyed = false;

  constructor() {
    chrome.runtime.onMessage.addListener(this.onMessage);
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  /* ---------------- messaging ---------------- */

  private send(evt: AgentEvent): void {
    if (this.destroyed) return;
    try {
      void chrome.runtime.sendMessage(evt).catch(() => this.destroy());
    } catch {
      this.destroy(); // extension was reloaded/removed: this script is orphaned
    }
  }

  private onMessage = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean | undefined => {
    // Commands come only from our own service worker (which has no `tab`).
    if (sender.id !== chrome.runtime.id || sender.tab) return undefined;
    const cmd = parseAgentCommand(raw);
    if (!cmd) return undefined;
    this.handle(cmd).then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: serializeError(err) }),
    );
    return true; // async response
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.driver.isActive) {
      // Esc while scrolling = stop here and keep what was captured so far.
      e.preventDefault();
      this.send({ type: 'EVT_STOP_FULLPAGE' });
    } else if (this.preview.isOpen && !this.selector && !this.picker) {
      this.preview.close();
    }
  };

  /* ---------------- command handling ---------------- */

  private viewportInfo(): ViewportInfo {
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dpr: window.devicePixelRatio || 1,
    };
  }

  private closeInteractive(): void {
    this.selector?.destroy();
    this.picker?.destroy();
    this.scrollSelector?.destroy();
    this.selector = null;
    this.picker = null;
    this.scrollSelector = null;
  }

  private async handle(cmd: AgentCommand): Promise<unknown> {
    switch (cmd.type) {
      case 'AGENT_PING':
        return true;

      case 'AGENT_HIDE_UI':
        setAllLayersHidden(true);
        await waitForPaint(30);
        return this.viewportInfo();

      case 'AGENT_CANCEL_UI':
        this.closeInteractive();
        this.driver.restore();
        this.progress.hide();
        this.disconnectPort();
        this.preview.setHidden(false);
        return true;

      case 'AGENT_SELECT_AREA': {
        this.closeInteractive();
        this.preview.setHidden(true);
        this.selector = new AreaSelector({
          onDone: (rect) => {
            this.selector = null;
            this.send({
              type: 'EVT_AREA_SELECTED',
              rect,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              dpr: window.devicePixelRatio || 1,
            });
          },
          onCancel: () => {
            this.selector = null;
            this.preview.setHidden(false);
            this.send({ type: 'EVT_CAPTURE_ABORT', reason: 'cancelled' });
          },
        });
        return true;
      }

      case 'AGENT_SELECT_SCROLL_AREA': {
        this.closeInteractive();
        this.preview.setHidden(true);
        this.scrollSelector = new ScrollAreaSelector({
          onDone: (choice) => {
            this.scrollSelector = null;
            this.pending = { target: choice.target, element: choice.element, rect: choice.rect, rel: choice.rel };
            this.send({
              type: 'EVT_SCROLL_AREA_SELECTED',
              target: choice.target,
              direction: choice.direction,
              viewport: { width: window.innerWidth, height: window.innerHeight },
              dpr: window.devicePixelRatio || 1,
            });
          },
          onCancel: () => {
            this.scrollSelector = null;
            this.preview.setHidden(false);
            this.send({ type: 'EVT_CAPTURE_ABORT', reason: 'cancelled' });
          },
        });
        return true;
      }

      case 'AGENT_PICK_ELEMENT': {
        this.closeInteractive();
        this.preview.setHidden(true);
        this.picker = new ElementPicker({
          onPick: (node, fullContent) => void this.onElementPicked(node, fullContent),
          onCancel: () => {
            this.picker = null;
            this.preview.setHidden(false);
            this.send({ type: 'EVT_CAPTURE_ABORT', reason: 'cancelled' });
          },
        });
        return true;
      }

      case 'AGENT_FP_PREPARE': {
        this.preview.setHidden(true);
        const pending = this.pending;
        this.pending = null;
        let spec: ScrollSpec;
        let element: Element | null = null;
        if (cmd.target === 'region') {
          if (!pending?.rect) throw new SnapflowError('CAPTURE_FAILED', 'The selected region is no longer available. Please select it again.');
          spec = { kind: 'region', direction: cmd.direction, rect: pending.rect };
        } else if (cmd.target === 'picked') {
          element = pending?.element ?? null;
          spec = { kind: 'element', direction: cmd.direction, rel: pending?.rel ?? null };
        } else {
          spec = { kind: 'document', direction: cmd.direction };
        }
        const result = this.driver.prepare(spec, element);
        this.connectPort();
        this.progress.show('Preparing capture…', 0);
        return result;
      }

      case 'AGENT_FP_SCROLL': {
        const total = Math.max(1, cmd.totalFrames);
        this.progress.show(`Capturing… ${Math.min(cmd.frame + 1, total)} / ${total}`, cmd.frame / total);
        const result = await this.driver.scrollTo(cmd.x, cmd.y, cmd.frame, cmd.settleMs);
        // The progress pill must not appear in the screenshot.
        this.progress.setHidden(true);
        await waitForPaint(30);
        return result;
      }

      case 'AGENT_FP_MEASURE':
        return this.driver.measure();

      case 'AGENT_FP_RESTORE':
        this.driver.restore();
        this.progress.hide();
        this.disconnectPort();
        return true;

      case 'AGENT_SHOW_PREVIEW':
        this.progress.hide();
        this.preview.show(cmd.id);
        return true;

      case 'AGENT_TOAST':
        this.preview.setHidden(false);
        this.progress.toast(cmd.text, cmd.kind);
        return true;
    }
  }

  private async onElementPicked(node: Element, fullContent: boolean): Promise<void> {
    this.picker = null;
    try {
      if (fullContent) this.pending = { target: 'picked', element: node, rect: null };
      else {
        node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        await waitForPaint(30);
      }
      const r = node.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const x1 = Math.max(0, r.left);
      const y1 = Math.max(0, r.top);
      const x2 = Math.min(vw, r.right);
      const y2 = Math.min(vh, r.bottom);
      if (x2 - x1 < 1 || y2 - y1 < 1) throw new SnapflowError('CAPTURE_FAILED', 'That element has no visible area to capture.');
      this.send({
        type: 'EVT_ELEMENT_PICKED',
        rect: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        dpr: window.devicePixelRatio || 1,
        fullContent,
      });
    } catch (err) {
      this.send({ type: 'EVT_CAPTURE_ABORT', reason: 'error', message: serializeError(err).message });
    }
  }

  /**
   * While a full-page capture is running a port stays open to the service worker.
   * If the worker dies (or the extension reloads) the port closes and we restore the page.
   */
  private connectPort(): void {
    this.disconnectPort();
    try {
      const port = chrome.runtime.connect({ name: 'snapflow-fullpage' });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.port = null;
        this.driver.restore();
        this.progress.hide();
        this.preview.setHidden(false);
      });
      this.port = port;
    } catch {
      /* extension context gone – nothing to coordinate with */
    }
  }

  private disconnectPort(): void {
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      /* already closed */
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      chrome.runtime.onMessage.removeListener(this.onMessage);
    } catch {
      /* context invalidated */
    }
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.closeInteractive();
    this.driver.restore();
    this.disconnectPort();
    this.preview.close();
    this.progress.destroy();
    removeAllLayers();
  }
}

// Replace any agent from a previous injection (or a previous extension version).
const root = globalThis as unknown as Record<string, AgentHandle | undefined>;
try {
  root[GLOBAL_KEY]?.destroy();
} catch {
  /* orphaned agent whose context is gone */
}
root[GLOBAL_KEY] = new Agent();
