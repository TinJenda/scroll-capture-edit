import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  HelpCircle,
  Maximize,
  Minus,
  Plus,
  Redo2,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { copyImageToClipboard } from '@/core/clipboard';
import { defaultFilename, encodeCanvas, qualityFor, saveImage } from '@/core/export';
import { getCapture, patchCapture } from '@/shared/captures';
import { serializeError } from '@/shared/errors';
import { PREVIEW_PATH } from '@/shared/constants';
import type { AnnotationPreset, PresetTool } from '@/shared/settings';
import type { CaptureRecord } from '@/shared/types';
import { captureIdFromUrl, request } from '@/ui/api';
import { useSettings, useToast } from '@/ui/hooks';
import { EditorCanvas } from './canvas';
import { canRedo, canUndo } from './history';
import { isEmptyDoc, newId, outputSize, parseDoc, serializeDoc, translateAnnotation, type Annotation } from './model';
import { Properties } from './Properties';
import { applyPropsToStyle, kindForTool, propsOfAnnotation, propsOfStyle } from './props';
import { renderComposite } from './render';
import { SaveDialog, type SaveRequest } from './SaveDialog';
import { MOD, SHORTCUT_HELP, TOOL_BY_KEY, TOOLS } from './shortcuts';
import { selectSelected, useEditor } from './store';

interface Loaded {
  record: CaptureRecord;
  bitmap: ImageBitmap;
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));

export function Editor() {
  const id = useMemo(captureIdFromUrl, []);
  const [settings, updateSettings] = useSettings();
  const toast = useToast();

  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<EditorCanvas | null>(null);
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const [data, setData] = useState<Loaded | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [draftState, setDraftState] = useState<'saved' | 'pending'>('saved');

  const tool = useEditor((s) => s.tool);
  const zoom = useEditor((s) => s.zoom);
  const undoable = useEditor((s) => canUndo(s.history));
  const redoable = useEditor((s) => canRedo(s.history));
  const doc = useEditor((s) => s.history.present);
  const imageSize = useEditor((s) => s.imageSize);
  const selected = useEditor(selectSelected);
  const cropDraft = useEditor((s) => s.cropDraft);
  const autoRenumber = useEditor((s) => s.autoRenumber);

  /* ---------------------------- load ---------------------------- */

  useEffect(() => {
    let alive = true;
    let bitmap: ImageBitmap | null = null;
    (async () => {
      if (!id) return setData(null);
      const record = await getCapture(id);
      if (!record) return setData(null);
      bitmap = await createImageBitmap(record.blob);
      if (!alive) {
        bitmap.close();
        return;
      }
      const restored = parseDoc(record.draft);
      useEditor.getState().init({
        imageSize: { width: record.width, height: record.height },
        scale: record.meta.scale || 1,
        doc: restored,
        autoRenumber: true,
      });
      setData({ record, bitmap });
      if (restored && !isEmptyDoc(restored)) toast.push('info', 'Restored your previous edits for this screenshot.');
    })().catch(() => alive && setData(null));
    return () => {
      alive = false;
      bitmap?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    useEditor.getState().setAutoRenumber(settings.autoRenumberMarkers);
  }, [settings.autoRenumberMarkers]);

  /* ---------------------------- canvas ---------------------------- */

  useEffect(() => {
    if (!data || !hostRef.current) return;
    const canvas = new EditorCanvas(hostRef.current, data.bitmap, { width: data.record.width, height: data.record.height });
    canvasRef.current = canvas;
    let prevTool = useEditor.getState().tool;
    let raf = 0;
    const unsub = useEditor.subscribe((s) => {
      if (s.tool !== prevTool) {
        prevTool = s.tool;
        canvas.onToolChanged();
      }
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          canvas.render();
        });
    });
    if (__E2E__) (window as unknown as Record<string, unknown>).__snapflow = { store: useEditor, canvas };
    return () => {
      unsub();
      cancelAnimationFrame(raf);
      canvas.destroy();
      canvasRef.current = null;
    };
  }, [data]);

  /* ---------------------------- autosave of the draft ---------------------------- */

  useEffect(() => {
    if (!id || !data) return;
    let timer = 0;
    let lastRev = useEditor.getState().revision;
    const flush = async () => {
      window.clearTimeout(timer);
      timer = 0;
      await patchCapture(id, { draft: serializeDoc(useEditor.getState().history.present) }).catch(() => undefined);
      setDraftState('saved');
    };
    flushRef.current = flush;
    const unsub = useEditor.subscribe((s) => {
      if (s.revision === lastRev) return;
      lastRev = s.revision;
      setDraftState('pending');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void flush(), 500);
    });
    const onHide = () => {
      if (timer) void flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      unsub();
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [id, data]);

  /* ---------------------------- rendering helpers ---------------------------- */

  const renderFinal = useCallback((): HTMLCanvasElement => {
    // Commit a text box that is still open so it is part of the export.
    const active = document.activeElement;
    if (active instanceof HTMLElement && hostRef.current?.contains(active)) active.blur();
    if (!data) throw new Error('Nothing to render');
    return renderComposite(data.bitmap, { width: data.record.width, height: data.record.height }, useEditor.getState().history.present);
  }, [data]);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (err) {
        const msg = serializeError(err).message;
        toast.push('error', msg, undefined, 6000);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  /* ---------------------------- actions ---------------------------- */

  const copyImage = useCallback(
    () =>
      run(async () => {
        try {
          const blob = await encodeCanvas(renderFinal(), 'png', 1);
          await copyImageToClipboard(blob);
          // Only reached after the clipboard write really succeeded.
          toast.push('success', 'Image copied — paste it with Ctrl+V');
        } catch (err) {
          const code = (err as { code?: string }).code ?? '';
          if (code.startsWith('CLIPBOARD')) {
            toast.push('error', serializeError(err).message, { label: 'Save instead', run: () => setSaveOpen(true) }, 7000);
          } else throw err;
        }
      }),
    [run, renderFinal, toast],
  );

  const saveWith = useCallback(
    (req: SaveRequest) =>
      run(async () => {
        const blob = await encodeCanvas(renderFinal(), req.format, req.quality);
        const result = await saveImage(blob, { format: req.format, quality: req.quality, filename: req.filename, saveAs: settings.askWhereToSave });
        setSaveOpen(false);
        if (result === 'saved') toast.push('success', `Saved ${req.filename}`);
        void updateSettings({
          exportFormat: req.format,
          includeTimestamp: req.timestamp,
          ...(req.format === 'jpeg' ? { jpegQuality: req.quality } : req.format === 'webp' ? { webpQuality: req.quality } : {}),
        });
      }),
    [run, renderFinal, settings.askWhereToSave, toast, updateSettings],
  );

  const quickSave = useCallback(() => {
    const format = settings.exportFormat;
    void saveWith({
      format,
      quality: qualityFor(format, settings),
      filename: defaultFilename(settings, format),
      timestamp: settings.includeTimestamp,
      name: '',
    });
  }, [saveWith, settings]);

  const returnToPreview = useCallback(
    () =>
      run(async () => {
        if (!id || !data) return;
        const current = useEditor.getState().history.present;
        await flushRef.current();
        if (isEmptyDoc(current)) {
          await patchCapture(id, { edited: undefined, draft: undefined });
        } else {
          const canvas = renderFinal();
          const blob = await encodeCanvas(canvas, 'png', 1);
          await patchCapture(id, {
            edited: { blob, width: canvas.width, height: canvas.height, updatedAt: Date.now() },
            draft: serializeDoc(current),
          });
        }
        location.href = `${chrome.runtime.getURL(PREVIEW_PATH)}?id=${encodeURIComponent(id)}&host=tab`;
      }),
    [run, id, data, renderFinal],
  );

  const recapture = useCallback(async () => {
    if (!id) return;
    if (!isEmptyDoc(useEditor.getState().history.present) && !window.confirm('Discard your edits and capture this page again?')) return;
    try {
      await request({ type: 'RECAPTURE', id });
    } catch (err) {
      toast.push('error', serializeError(err).message, undefined, 7000);
    }
  }, [id, toast]);

  /* ---------------------------- presets ---------------------------- */

  const applyPreset = useCallback((p: AnnotationPreset) => {
    const s = useEditor.getState();
    s.setTool(p.tool);
    const kind = kindForTool(p.tool);
    if (kind) {
      s.setStyle(
        applyPropsToStyle(kind, useEditor.getState().style, {
          color: p.color,
          width: p.tool === 'text' || p.tool === 'marker' ? undefined : p.strokeWidth,
          opacity: p.opacity,
        }),
      );
    }
  }, []);

  const savePreset = useCallback(
    (name: string) => {
      const s = useEditor.getState();
      const kind = selected?.type ?? kindForTool(s.tool);
      if (!kind || kind === 'blur' || kind === 'pixelate') return;
      const p = selected ? propsOfAnnotation(selected) : propsOfStyle(kind, s.style);
      const preset: AnnotationPreset = {
        id: newId(),
        name,
        tool: kind as PresetTool,
        color: p.color ?? '#FF3B30',
        strokeWidth: p.width ?? 3,
        opacity: p.opacity,
      };
      void updateSettings({ userPresets: [...settings.userPresets, preset] });
      toast.push('success', `Saved preset “${name}”`);
    },
    [selected, settings.userPresets, updateSettings, toast],
  );

  /* ---------------------------- keyboard ---------------------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!data || isTyping(e.target) || canvasRef.current?.isEditingInline) return;
      if (saveOpen || helpOpen) return;
      const store = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod) {
        if (key === 'z') {
          e.preventDefault();
          if (e.shiftKey) store.redo();
          else store.undo();
        } else if (key === 'y') {
          e.preventDefault();
          store.redo();
        } else if (key === 'c') {
          e.preventDefault();
          if (e.shiftKey) void copyImage();
          else if (store.selectedId && store.selectionExplicit) {
            store.copySelected();
            toast.push('info', `Annotation copied — ${MOD}+V pastes it, ${MOD}+Shift+C copies the image`);
          } else void copyImage();
        } else if (key === 'v') {
          if (store.clipboard) {
            e.preventDefault();
            store.pasteAnnotation();
          }
        } else if (key === 'd') {
          e.preventDefault();
          store.duplicateSelected();
        } else if (key === 's') {
          e.preventDefault();
          if (e.shiftKey) setSaveOpen(true);
          else quickSave();
        } else if (key === '0') {
          e.preventDefault();
          canvasRef.current?.fit();
        } else if (key === '=' || key === '+') {
          e.preventDefault();
          canvasRef.current?.zoomBy(1.25);
        } else if (key === '-') {
          e.preventDefault();
          canvasRef.current?.zoomBy(0.8);
        }
        return;
      }
      if (e.altKey) return;

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          if (store.selectedId) {
            e.preventDefault();
            store.deleteSelected();
          }
          return;
        case 'Escape':
          if (canvasRef.current?.cancelOperation()) return;
          if (store.tool === 'crop') store.setTool('select');
          else if (store.selectedId) store.select(null);
          else if (store.tool !== 'select') store.setTool('select');
          return;
        case 'Enter':
          if (store.tool === 'crop') {
            e.preventDefault();
            store.applyCrop();
          }
          return;
        case '?':
          setHelpOpen(true);
          return;
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          const a = store.history.present.annotations.find((x) => x.id === store.selectedId);
          if (!a) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          store.updateAnnotation(a.id, translateAnnotation(a, dx, dy) as Partial<Annotation>, `nudge:${a.id}`);
          return;
        }
      }
      const t = TOOL_BY_KEY[key];
      if (t && !e.shiftKey) {
        e.preventDefault();
        store.setTool(t);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, copyImage, quickSave, saveOpen, helpOpen, toast]);

  /* ---------------------------- render ---------------------------- */

  if (data === undefined) return <div className="editor-loading" aria-busy="true">Loading…</div>;
  if (data === null) {
    return (
      <div className="editor-loading">
        <h2>Screenshot not available</h2>
        <p className="muted">It may have been discarded or expired. Capture the page again from the SnapFlow toolbar icon.</p>
      </div>
    );
  }

  const out = outputSize(doc, imageSize);
  const showProps = tool !== 'crop' && (selected !== undefined || kindForTool(tool) !== null);
  const groups = TOOLS.reduce<Record<number, typeof TOOLS>>((acc, t) => {
    (acc[t.group] ??= []).push(t);
    return acc;
  }, {});

  return (
    <div className="editor">
      <header className="topbar">
        <button type="button" className="btn btn-ghost" onClick={() => void returnToPreview()} disabled={busy} data-tip="Back to preview" data-testid="back-to-preview">
          <ArrowLeft size={16} /> Preview
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void recapture()} disabled={busy} data-tip="Capture this page again" data-testid="recapture">
          <RotateCcw size={15} /> Recapture
        </button>
        <span className="sep" />
        <button type="button" className="icon-btn" disabled={!undoable} onClick={() => useEditor.getState().undo()} data-tip={`Undo  ${MOD}+Z`} aria-label="Undo" data-testid="undo">
          <Undo2 size={17} />
        </button>
        <button type="button" className="icon-btn" disabled={!redoable} onClick={() => useEditor.getState().redo()} data-tip={`Redo  ${MOD}+Shift+Z`} aria-label="Redo" data-testid="redo">
          <Redo2 size={17} />
        </button>
        <span className="draft-state muted" aria-live="polite">
          {draftState === 'pending' ? 'Saving draft…' : doc.annotations.length || doc.crop ? 'Draft saved' : ''}
        </span>
        <span className="grow" />
        <button type="button" className="icon-btn" onClick={() => setHelpOpen(true)} data-tip="Keyboard shortcuts  ?" aria-label="Keyboard shortcuts">
          <HelpCircle size={17} />
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void copyImage()} disabled={busy} data-tip={`Copy image  ${MOD}+Shift+C`} data-testid="copy-image">
          <Copy size={15} /> Copy Image
        </button>
        <div className="save-group">
          <button type="button" className="btn" onClick={quickSave} disabled={busy} data-tip={`Save  ${MOD}+S`} data-testid="save-image">
            <Download size={15} /> Save
          </button>
          <button type="button" className="btn caret" onClick={() => setSaveOpen(true)} aria-label="Save as…" data-tip={`Save as…  ${MOD}+Shift+S`} data-testid="save-as">
            <ChevronDown size={14} />
          </button>
        </div>
      </header>

      <div className="workspace">
        <nav className="toolbar" aria-label="Tools">
          {Object.entries(groups).map(([g, tools], gi) => (
            <Fragment key={g}>
              {gi > 0 && <hr />}
              {tools.map(({ id: tid, label, key, Icon }) => (
                <button
                  key={tid}
                  type="button"
                  className={`icon-btn tool${tool === tid ? ' active' : ''}`}
                  aria-label={label}
                  aria-pressed={tool === tid}
                  data-tip={`${label}  ${key}`}
                  data-testid={`tool-${tid}`}
                  onClick={() => useEditor.getState().setTool(tid)}
                >
                  <Icon size={18} />
                </button>
              ))}
            </Fragment>
          ))}
        </nav>

        <main className="canvas-wrap">
          <div ref={hostRef} className="canvas-host checker" data-testid="canvas-host" />
          {tool === 'crop' && cropDraft && (
            <div className="cropbar" role="toolbar" aria-label="Crop">
              <span>
                Crop {Math.round(cropDraft.width)} × {Math.round(cropDraft.height)} px
              </span>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => useEditor.getState().applyCrop()} data-testid="crop-apply">
                <Check size={14} /> Apply <kbd>Enter</kbd>
              </button>
              <button type="button" className="btn btn-sm" onClick={() => useEditor.getState().clearCrop()} disabled={!doc.crop && !cropDraft}>
                Reset
              </button>
              <button type="button" className="btn btn-sm" onClick={() => useEditor.getState().setTool('select')}>
                <X size={14} /> Cancel <kbd>Esc</kbd>
              </button>
            </div>
          )}
        </main>

        {showProps && (
          <Properties
            userPresets={settings.userPresets}
            onApplyPreset={applyPreset}
            onSavePreset={savePreset}
            onDeletePreset={(pid) => void updateSettings({ userPresets: settings.userPresets.filter((p) => p.id !== pid) })}
            autoRenumber={autoRenumber}
            onAutoRenumber={(v) => {
              useEditor.getState().setAutoRenumber(v);
              void updateSettings({ autoRenumberMarkers: v });
            }}
          />
        )}
      </div>

      <footer className="statusbar">
        <span data-testid="dimensions">
          {out.width} × {out.height} px{doc.crop ? ' (cropped)' : ''}
        </span>
        <span className="muted">
          {doc.annotations.length} annotation{doc.annotations.length === 1 ? '' : 's'}
        </span>
        <span className="grow" />
        <button type="button" className="icon-btn sm" onClick={() => canvasRef.current?.zoomBy(0.8)} aria-label="Zoom out" data-tip={`Zoom out  ${MOD}+−`}>
          <Minus size={14} />
        </button>
        <button type="button" className="btn btn-ghost btn-sm zoomlabel" onClick={() => canvasRef.current?.setZoom(1)} data-tip="Actual size (100%)" data-testid="zoom-label">
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" className="icon-btn sm" onClick={() => canvasRef.current?.zoomBy(1.25)} aria-label="Zoom in" data-tip={`Zoom in  ${MOD}++`}>
          <Plus size={14} />
        </button>
        <button type="button" className="icon-btn sm" onClick={() => canvasRef.current?.fit()} aria-label="Fit to window" data-tip={`Fit to window  ${MOD}+0`}>
          <Maximize size={14} />
        </button>
      </footer>

      {saveOpen && (
        <SaveDialog
          settings={settings}
          busy={busy}
          dimensions={out}
          onCancel={() => setSaveOpen(false)}
          onSave={(req) => void saveWith(req)}
        />
      )}

      {helpOpen && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setHelpOpen(false)} onKeyDown={(e) => e.key === 'Escape' && setHelpOpen(false)}>
          <div className="modal wide" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
            <h2>Keyboard shortcuts</h2>
            <dl className="shortcuts">
              {SHORTCUT_HELP.map(([k, d]) => (
                <Fragment key={k}>
                  <dt>
                    <kbd>{k}</kbd>
                  </dt>
                  <dd>{d}</dd>
                </Fragment>
              ))}
            </dl>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" autoFocus onClick={() => setHelpOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
