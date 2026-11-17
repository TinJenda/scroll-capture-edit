import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFilename } from '@/shared/filename';
import type { Settings } from '@/shared/settings';
import type { ImageFormat } from '@/shared/types';

export interface SaveRequest {
  format: ImageFormat;
  quality: number;
  filename: string;
  timestamp: boolean;
  name: string;
}

interface Props {
  settings: Settings;
  busy: boolean;
  dimensions: { width: number; height: number };
  onCancel(): void;
  onSave(req: SaveRequest): void;
}

const LABEL: Record<ImageFormat, string> = { png: 'PNG – lossless', jpeg: 'JPEG – smaller files', webp: 'WebP – small + sharp' };

/** "Save as…": format, quality, file name and optional timestamp. Resolution is never changed. */
export function SaveDialog({ settings, busy, dimensions, onCancel, onSave }: Props) {
  const [format, setFormat] = useState<ImageFormat>(settings.exportFormat);
  const [quality, setQuality] = useState(settings.exportFormat === 'webp' ? settings.webpQuality : settings.jpegQuality);
  const [name, setName] = useState('');
  const [timestamp, setTimestamp] = useState(settings.includeTimestamp);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const filename = useMemo(
    () => buildFilename({ name, prefix: settings.filenamePrefix, includeTimestamp: timestamp, format }),
    [name, settings.filenamePrefix, timestamp, format],
  );

  const changeFormat = (f: ImageFormat) => {
    setFormat(f);
    if (f === 'jpeg') setQuality(settings.jpegQuality);
    if (f === 'webp') setQuality(settings.webpQuality);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-title"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ format, quality, filename, timestamp, name });
        }}
      >
        <h2 id="save-title">Save image</h2>
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => changeFormat(e.target.value as ImageFormat)} data-testid="save-format">
            {(Object.keys(LABEL) as ImageFormat[]).map((f) => (
              <option key={f} value={f}>
                {LABEL[f]}
              </option>
            ))}
          </select>
        </label>
        {format !== 'png' && (
          <label className="field">
            <span>Quality · {Math.round(quality * 100)}%</span>
            <input type="range" min={0.3} max={1} step={0.01} value={quality} onChange={(e) => setQuality(Number(e.target.value))} data-testid="save-quality" />
          </label>
        )}
        <label className="field">
          <span>File name</span>
          <input ref={nameRef} className="txt" value={name} placeholder={`${settings.filenamePrefix || 'snapflow'} (default)`} maxLength={100} onChange={(e) => setName(e.target.value)} data-testid="save-name" />
        </label>
        <label className="check">
          <input type="checkbox" checked={timestamp} onChange={(e) => setTimestamp(e.target.checked)} />
          <span>Add timestamp</span>
        </label>
        <p className="muted small" data-testid="save-preview">
          {filename} · {dimensions.width} × {dimensions.height} px (original resolution)
        </p>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="save-confirm">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
