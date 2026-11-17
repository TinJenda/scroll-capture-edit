import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageDriver } from '@/content/page-driver';

/**
 * jsdom has no layout engine, so geometry is stubbed. What matters here is the contract:
 * whatever prepare() / the capture loop changes, restore() puts back exactly – also after errors/cancel.
 */
describe('cleanup after cancellation or failure', () => {
  let scrollTo: ReturnType<typeof vi.fn>;
  let header: HTMLElement;
  let footer: HTMLElement;
  let sticky: HTMLElement;

  const rect = (top: number, height: number): DOMRect =>
    ({ x: 0, y: top, top, left: 0, right: 1000, bottom: top + height, width: 1000, height, toJSON: () => ({}) }) as DOMRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    const root = document.documentElement;
    for (const [k, v] of Object.entries({ clientWidth: 1000, clientHeight: 800, scrollHeight: 3000, scrollWidth: 1000, scrollTop: 0 })) {
      Object.defineProperty(root, k, { configurable: true, value: v, writable: true });
    }
    Object.defineProperty(document, 'scrollingElement', { configurable: true, value: root });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    scrollTo = vi.fn();
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 450 });
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });

    header = document.createElement('div');
    header.style.cssText = 'position: fixed; top: 0; visibility: visible';
    header.getBoundingClientRect = () => rect(0, 60);
    footer = document.createElement('div');
    footer.style.cssText = 'position: fixed; bottom: 0';
    footer.getBoundingClientRect = () => rect(740, 60);
    sticky = document.createElement('div');
    sticky.style.cssText = 'position: sticky; top: 0';
    document.body.append(header, footer, sticky);
  });
  afterEach(() => vi.restoreAllMocks());

  it('restore() undoes every page modification and the scroll position', () => {
    const d = new PageDriver();
    const prep = d.prepare({ kind: 'document', direction: 'vertical' }, null);
    expect(prep.fixedCount).toBe(2);
    expect(document.querySelector('style[data-snapflow-style]')).not.toBeNull();
    expect(sticky.style.position).toBe('static'); // sticky → static while capturing

    // hide everything as the middle frame of a capture would
    (d as unknown as { applyRole(r: string): void }).applyRole('middle');
    expect(header.style.visibility).toBe('hidden');
    expect(footer.style.visibility).toBe('hidden');

    d.restore(); // e.g. the user pressed Cancel
    expect(document.querySelector('style[data-snapflow-style]')).toBeNull();
    expect(header.style.visibility).toBe('visible'); // original inline value, not just "unset"
    expect(footer.style.visibility).toBe('');
    expect(sticky.style.position).toBe('sticky');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 450, left: 0, behavior: 'instant' });
    expect(d.isActive).toBe(false);
  });

  it('restore() is idempotent and safe when nothing was prepared', () => {
    const d = new PageDriver();
    expect(() => d.restore()).not.toThrow();
    d.prepare({ kind: 'document', direction: 'vertical' }, null);
    d.restore();
    expect(() => d.restore()).not.toThrow();
  });

  it('a failing prepare() restores the page itself', () => {
    Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 5 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 5 });
    const d = new PageDriver();
    expect(() => d.prepare({ kind: 'document', direction: 'vertical' }, null)).toThrow(/too small/);
    expect(document.querySelector('style[data-snapflow-style]')).toBeNull();
    expect(sticky.style.position).toBe('sticky');
    expect(d.isActive).toBe(false);
  });
});
