import { Copy, ExternalLink, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { copyImageToClipboard } from '@/core/clipboard';
import { formatBytes } from '@/core/export';
import { deleteCapture, listCaptures, clearCaptures, recordSize } from '@/shared/captures';
import { serializeError } from '@/shared/errors';
import type { CaptureRecord } from '@/shared/types';
import { request } from '@/ui/api';
import { useSettings, useToast } from '@/ui/hooks';

function Thumb({ record, onOpen }: { record: CaptureRecord; onOpen(): void }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const u = URL.createObjectURL(record.thumb ?? record.edited?.blob ?? record.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [record]);
  return (
    <button type="button" className="thumb checker" onClick={onOpen} aria-label="Open screenshot">
      {url && <img src={url} alt="" />}
    </button>
  );
}

const MODE: Record<string, string> = { visible: 'Visible area', area: 'Selected area', fullPage: 'Full page', element: 'Element' };

export function History() {
  const [settings, update] = useSettings();
  const toast = useToast();
  const [items, setItems] = useState<CaptureRecord[] | null>(null);

  const reload = useCallback(async () => {
    const all = await listCaptures();
    setItems(all.filter((r) => r.keep));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const open = (id: string) => void request({ type: 'OPEN_PREVIEW', id }).catch((e) => toast.push('error', serializeError(e).message));

  const copy = async (r: CaptureRecord) => {
    try {
      await copyImageToClipboard(r.edited?.blob ?? r.blob);
      toast.push('success', 'Image copied to the clipboard');
    } catch (e) {
      toast.push('error', serializeError(e).message);
    }
  };

  const remove = async (r: CaptureRecord) => {
    await deleteCapture(r.id);
    await reload();
  };

  const clearAll = async () => {
    if (!window.confirm('Delete all screenshots in history?')) return;
    await clearCaptures();
    await reload();
  };

  const total = (items ?? []).reduce((n, r) => n + recordSize(r), 0);

  return (
    <div className="history">
      <header>
        <img src="../icons/icon-48.png" alt="" width={32} height={32} />
        <h1>Recent screenshots</h1>
        {items && items.length > 0 && (
          <>
            <span className="muted">
              {items.length} · {formatBytes(total)}
            </span>
            <button type="button" className="btn btn-danger" onClick={() => void clearAll()}>
              <Trash2 size={14} /> Clear all
            </button>
          </>
        )}
      </header>

      {items === null ? null : !settings.historyEnabled && items.length === 0 ? (
        <div className="empty-state">
          <h2>History is off</h2>
          <p className="muted">By default SnapFlow keeps nothing after you finish with a screenshot. Turn history on to keep your most recent captures on this device.</p>
          <button type="button" className="btn btn-primary" onClick={() => void update({ historyEnabled: true })}>
            Turn on history
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h2>No screenshots yet</h2>
          <p className="muted">New captures will appear here (up to {settings.historyLimit}, {settings.historyMaxMB} MB).</p>
        </div>
      ) : (
        <div className="grid">
          {items.map((r) => (
            <article className="item" key={r.id}>
              <Thumb record={r} onOpen={() => open(r.id)} />
              <div className="meta">
                <strong>{r.meta.pageTitle || MODE[r.meta.mode]}</strong>
                <span className="muted">
                  {MODE[r.meta.mode]} · {r.width} × {r.height} · {new Date(r.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="actions">
                <button type="button" className="btn btn-sm" onClick={() => open(r.id)}>
                  <ExternalLink size={13} /> Open
                </button>
                <button type="button" className="btn btn-sm" onClick={() => void copy(r)}>
                  <Copy size={13} /> Copy
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => void remove(r)} aria-label="Delete">
                  <Trash2 size={13} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
