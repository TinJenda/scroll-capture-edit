import { Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { clearCaptures } from '@/shared/captures';
import type { ImageFormat } from '@/shared/types';
import { request } from '@/ui/api';
import { useSettings, useToast } from '@/ui/hooks';

function Setting({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Options() {
  const [s, update] = useSettings();
  const toast = useToast();
  const [confirmClear, setConfirmClear] = useState(false);

  const clearAll = async () => {
    await clearCaptures();
    setConfirmClear(false);
    toast.push('success', 'All locally stored screenshots were deleted.');
  };

  return (
    <div className="options">
      <header>
        <img src="../icons/icon-48.png" alt="" />
        <div>
          <h1>SnapFlow settings</h1>
          <span className="muted">Everything is stored on this device. Nothing is uploaded.</span>
        </div>
      </header>

      <section className="card">
        <h2>Appearance</h2>
        <Setting label="Theme">
          <select value={s.theme} onChange={(e) => void update({ theme: e.target.value as typeof s.theme })} aria-label="Theme">
            <option value="system">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Setting>
      </section>

      <section className="card">
        <h2>Saving</h2>
        <Setting label="Default format" hint="Used by the Save buttons.">
          <select value={s.exportFormat} onChange={(e) => void update({ exportFormat: e.target.value as ImageFormat })} aria-label="Default format">
            <option value="png">PNG (lossless)</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
        </Setting>
        <Setting label="JPEG quality">
          <div className="inline">
            <input type="range" min={0.3} max={1} step={0.01} value={s.jpegQuality} onChange={(e) => void update({ jpegQuality: Number(e.target.value) })} aria-label="JPEG quality" />
            <span>{Math.round(s.jpegQuality * 100)}%</span>
          </div>
        </Setting>
        <Setting label="WebP quality">
          <div className="inline">
            <input type="range" min={0.3} max={1} step={0.01} value={s.webpQuality} onChange={(e) => void update({ webpQuality: Number(e.target.value) })} aria-label="WebP quality" />
            <span>{Math.round(s.webpQuality * 100)}%</span>
          </div>
        </Setting>
        <Setting label="File name prefix" hint="e.g. “bug-report” → bug-report-2026-11-17-153000.png">
          <input type="text" value={s.filenamePrefix} maxLength={60} onChange={(e) => void update({ filenamePrefix: e.target.value })} aria-label="File name prefix" />
        </Setting>
        <Setting label="Add timestamp">
          <input type="checkbox" checked={s.includeTimestamp} onChange={(e) => void update({ includeTimestamp: e.target.checked })} aria-label="Add timestamp" />
        </Setting>
        <Setting label="Ask where to save" hint="Show Chrome’s Save As dialog for every download.">
          <input type="checkbox" checked={s.askWhereToSave} onChange={(e) => void update({ askWhereToSave: e.target.checked })} aria-label="Ask where to save" />
        </Setting>
      </section>

      <section className="card">
        <h2>Capture</h2>
        <Setting label="Scroll settle delay" hint="Extra wait after each scroll in full-page capture. Raise it for pages that load content slowly.">
          <div className="inline">
            <input type="range" min={0} max={1000} step={20} value={s.settleMs} onChange={(e) => void update({ settleMs: Number(e.target.value) })} aria-label="Scroll settle delay" />
            <span>{s.settleMs} ms</span>
          </div>
        </Setting>
        <Setting label="Renumber markers automatically" hint="When you delete numbered marker 2, markers 3, 4… shift down.">
          <input type="checkbox" checked={s.autoRenumberMarkers} onChange={(e) => void update({ autoRenumberMarkers: e.target.checked })} aria-label="Renumber markers automatically" />
        </Setting>
      </section>

      <section className="card">
        <h2>Screenshot history</h2>
        <Setting label="Keep recent screenshots" hint="Off by default. When off, captures are discarded automatically a few hours after you take them.">
          <input type="checkbox" checked={s.historyEnabled} onChange={(e) => void update({ historyEnabled: e.target.checked })} aria-label="Keep recent screenshots" />
        </Setting>
        <Setting label="Maximum number of screenshots">
          <input type="number" min={1} max={200} value={s.historyLimit} onChange={(e) => void update({ historyLimit: Number(e.target.value) })} aria-label="Maximum number of screenshots" />
        </Setting>
        <Setting label="Maximum storage (MB)">
          <input type="number" min={10} max={2000} value={s.historyMaxMB} onChange={(e) => void update({ historyMaxMB: Number(e.target.value) })} aria-label="Maximum storage in megabytes" />
        </Setting>
        <Setting label="Delete everything" hint="Removes all stored screenshots, including drafts.">
          {confirmClear ? (
            <div className="inline">
              <button type="button" className="btn btn-danger" onClick={() => void clearAll()}>
                <Trash2 size={14} /> Yes, delete all
              </button>
              <button type="button" className="btn" onClick={() => setConfirmClear(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmClear(true)}>
              <Trash2 size={14} /> Delete all stored screenshots
            </button>
          )}
        </Setting>
      </section>

      <section className="card">
        <h2>Annotation presets</h2>
        {s.userPresets.length === 0 ? (
          <p className="muted">
            No custom presets yet. In the editor, choose a tool, set its colour and width, then use “Save current style as…”.
          </p>
        ) : (
          <div className="preset-list">
            {s.userPresets.map((p) => (
              <span key={p.id} className="btn btn-sm">
                <i style={{ background: p.color, width: 10, height: 10, borderRadius: '50%', display: 'inline-block' }} />
                {p.name}
                <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} aria-label={`Delete preset ${p.name}`} onClick={() => void update({ userPresets: s.userPresets.filter((x) => x.id !== p.id) })}>
                  <Trash2 size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Keyboard shortcuts</h2>
        <p className="muted">Capture shortcuts are managed by Chrome so you can change them to anything you like.</p>
        <button type="button" className="btn" onClick={() => void request({ type: 'OPEN_SHORTCUTS' })}>
          Open Chrome shortcut settings
        </button>
      </section>

      <section className="card privacy">
        <h2>Privacy</h2>
        <ul>
          <li>Screenshots are processed and stored only in this browser. SnapFlow has no server and never uploads anything.</li>
          <li>No analytics, tracking, accounts or remote code.</li>
          <li>SnapFlow only touches the tab you invoke it on, and only while you capture.</li>
          <li>Page addresses are stored without query strings or fragments, which often contain tokens.</li>
        </ul>
      </section>
    </div>
  );
}
