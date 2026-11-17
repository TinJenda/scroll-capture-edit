import { Check, ChevronDown, Copy, Download, Maximize2, Minimize2, Pencil, RotateCcw, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyImageToClipboard } from '@/core/clipboard';
import { defaultFilename, encodeBlob, formatBytes, qualityFor, saveImage } from '@/core/export';
import { getCapture } from '@/shared/captures';
import { serializeError } from '@/shared/errors';
import type { CaptureRecord, ImageFormat } from '@/shared/types';
import { captureIdFromUrl, closeThisTab, request } from '@/ui/api';
import { useSettings, useToast } from '@/ui/hooks';

type View = 'original' | 'edited';
type Status = { kind: 'idle' | 'success' | 'error'; text: string };

const MODE_LABEL: Record<string, string> = {
  visible: 'Visible area',
  area: 'Selected area',
  fullPage: 'Full page',
  element: 'Element',
};

const hostParam = () => new URLSearchParams(location.search).get('host') ?? 'tab';

/**
 * Lightweight post-capture preview. It never loads the editor: Copy and Save work straight from
 * the stored PNG, so the common "capture → Ctrl+C → paste" path stays one keystroke long.
 */
export function Preview() {
  const id = useMemo(captureIdFromUrl, []);
  const host = useMemo(hostParam, []);
  const overlay = host === 'overlay';
  const [settings] = useSettings();
  const toast = useToast();

  const [record, setRecord] = useState<CaptureRecord | null | undefined>(undefined);
  const [view, setView] = useState<View>('original');
  const [fit, setFit] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const busyRef = useRef(false);

  /* ---- load ---- */
  useEffect(() => {
    let alive = true;
    if (!id) {
      setRecord(null);
      return;
    }
    getCapture(id)
      .then((r) => {
        if (!alive) return;
        setRecord(r ?? null);
        if (r?.edited) setView('edited');
      })
      .catch(() => alive && setRecord(null));
    return () => {
      alive = false;
    };
  }, [id]);

  const shown = record ? (view === 'edited' && record.edited ? record.edited : record) : null;
  const shownBlob = shown?.blob ?? null;
  const dims = shown ? { width: shown.width, height: shown.height } : null;

  const imageUrl = useMemo(() => (shownBlob ? URL.createObjectURL(shownBlob) : null), [shownBlob]);
  useEffect(() => () => void (imageUrl && URL.revokeObjectURL(imageUrl)), [imageUrl]);

  useEffect(() => {
    window.focus();
  }, []);

  /* ---- actions ---- */
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const doSave = useCallback(
    (format: ImageFormat) =>
      run(async () => {
        if (!shownBlob) return;
        setMenuOpen(false);
        try {
          const out = format === 'png' ? shownBlob : await encodeBlob(shownBlob, format, qualityFor(format, settings));
          const result = await saveImage(out, {
            format,
            quality: qualityFor(format, settings),
            filename: defaultFilename(settings, format),
            saveAs: settings.askWhereToSave,
          });
          if (result === 'saved') {
            setStatus({ kind: 'success', text: `Saved as ${format.toUpperCase()}.` });
            toast.push('success', 'Saved to your downloads folder');
          }
        } catch (err) {
          const e = serializeError(err);
          setStatus({ kind: 'error', text: e.message });
          toast.push('error', e.message);
        }
      }),
    [run, shownBlob, settings, toast],
  );

  const doCopy = useCallback(
    () =>
      run(async () => {
        if (!shownBlob) return;
        try {
          await copyImageToClipboard(shownBlob);
          // Only reached after the browser confirmed the write.
          setStatus({ kind: 'success', text: 'Copied to clipboard — paste it anywhere with Ctrl+V.' });
        } catch (err) {
          const e = serializeError(err);
          setStatus({ kind: 'error', text: e.message });
          toast.push('error', 'Could not copy the image', { label: 'Save instead', run: () => void doSave(settings.exportFormat) }, 6000);
        }
      }),
    [run, shownBlob, toast, doSave, settings.exportFormat],
  );

  const doEdit = useCallback(async () => {
    if (!id) return;
    try {
      await request({ type: 'OPEN_EDITOR', id });
    } catch (err) {
      toast.push('error', serializeError(err).message);
    }
  }, [id, toast]);

  const doClose = useCallback(async () => {
    if (overlay) {
      if (id) void request({ type: 'DISCARD_CAPTURE', id }).catch(() => undefined);
      window.parent.postMessage({ snapflow: 'preview', type: 'close' }, '*');
    } else {
      await closeThisTab();
    }
  }, [overlay, id]);

  const doRecapture = useCallback(async () => {
    if (!record || !id) return;
    try {
      if (overlay) await request({ type: 'START_CAPTURE', mode: record.meta.mode });
      else await request({ type: 'RECAPTURE', id });
    } catch (err) {
      toast.push('error', serializeError(err).message);
    }
  }, [record, id, overlay, toast]);

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const typing = e.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(e.target.tagName);
      if (typing) return;
      if (mod && key === 'c') {
        if (window.getSelection()?.toString()) return; // leave native text copy alone
        e.preventDefault();
        void doCopy();
      } else if (mod && key === 's') {
        e.preventDefault();
        void doSave(settings.exportFormat);
      } else if (!mod && !e.altKey && key === 'e') {
        e.preventDefault();
        void doEdit();
      } else if (!mod && !e.altKey && key === 'f') {
        setFit((v) => !v);
      } else if (key === 'escape') {
        if (menuOpen) setMenuOpen(false);
        else void doClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doCopy, doSave, doEdit, doClose, menuOpen, settings.exportFormat]);

  /* ---- render ---- */
  if (record === undefined) return <div className="preview host-loading" aria-busy="true" />;

  if (record === null || !shown) {
    return (
      <div className={`preview host-${host}`}>
        <div className="empty">
          <h3>Screenshot not available</h3>
          <p className="muted">It may have been discarded or expired. Capture the page again from the SnapFlow toolbar icon.</p>
          <button type="button" className="btn" onClick={() => void doClose()}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const warnings = record.meta.warnings;
  return (
    <div className={`preview host-${host}`}>
      <header>
        <div className="title">
          <strong>{MODE_LABEL[record.meta.mode] ?? 'Screenshot'}</strong>
          <span>
            {dims?.width} × {dims?.height} px · {formatBytes(shown.blob.size)}
            {record.meta.pageTitle ? ` · ${record.meta.pageTitle}` : ''}
          </span>
        </div>
        {record.edited && (
          <div className="seg" role="group" aria-label="Version">
            <button type="button" aria-pressed={view === 'edited'} onClick={() => setView('edited')}>
              Edited
            </button>
            <button type="button" aria-pressed={view === 'original'} onClick={() => setView('original')}>
              Original
            </button>
          </div>
        )}
        <button
          type="button"
          className="icon-btn"
          title={fit ? 'Show actual size (F)' : 'Zoom to fit (F)'}
          aria-label={fit ? 'Show actual size' : 'Zoom to fit'}
          onClick={() => setFit((v) => !v)}
        >
          {fit ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
        </button>
        <button type="button" className="icon-btn" title="Capture again" aria-label="Capture again" onClick={() => void doRecapture()}>
          <RotateCcw size={16} />
        </button>
        <button type="button" className="icon-btn" title="Close (Esc)" aria-label="Close preview" onClick={() => void doClose()}>
          <X size={17} />
        </button>
      </header>

      {warnings.length > 0 && (
        <div className="banner" role="note">
          <TriangleAlert size={16} style={{ flex: 'none', marginTop: 1 }} />
          <ul>
            {warnings.map((w) => (
              <li key={w.code + w.message}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}

      <main className={`stage checker ${fit ? 'fit' : 'actual'}`} data-testid="preview-stage">
        {imageUrl && <img src={imageUrl} width={dims?.width} height={dims?.height} alt="Captured screenshot" data-testid="preview-image" />}
      </main>

      <footer>
        <div className={`status ${status.kind}`} role="status" aria-live="polite" data-testid="preview-status">
          {status.text || (
            <>
              <kbd>Ctrl</kbd> + <kbd>C</kbd> to copy
            </>
          )}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void doCopy()} disabled={busy} title="Copy image (Ctrl+C)" data-testid="copy">
          {status.kind === 'success' && status.text.startsWith('Copied') ? <Check size={15} /> : <Copy size={15} />}
          Copy
        </button>
        <button type="button" className="btn" onClick={() => void doEdit()} title="Edit (E)" data-testid="edit">
          <Pencil size={15} />
          Edit
        </button>
        <div className="save-group">
          <button type="button" className="btn" onClick={() => void doSave(settings.exportFormat)} disabled={busy} title="Save (Ctrl+S)" data-testid="save">
            <Download size={15} />
            Save
          </button>
          <button
            type="button"
            className="btn caret"
            aria-label="Choose format"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <ChevronDown size={14} />
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              {(['png', 'jpeg', 'webp'] as const).map((f) => (
                <button key={f} type="button" role="menuitem" onClick={() => void doSave(f)}>
                  <span>Save as {f === 'jpeg' ? 'JPEG' : f.toUpperCase()}</span>
                  {settings.exportFormat === f && <Check size={14} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
