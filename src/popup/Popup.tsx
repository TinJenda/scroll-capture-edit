import { ArrowDownUp, Crop, History, Keyboard, Monitor, MousePointerClick, ScrollText, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { serializeError } from '@/shared/errors';
import type { TabSupport } from '@/shared/messages';
import type { CaptureMode } from '@/shared/types';
import { getTabSupport, request } from '@/ui/api';
import { useSettings } from '@/ui/hooks';

interface ModeDef {
  mode: CaptureMode;
  command: string;
  title: string;
  hint: string;
  Icon: LucideIcon;
}

const MODES: ModeDef[] = [
  { mode: 'visible', command: 'capture-visible', title: 'Capture Visible Area', hint: 'Exactly what you see in the window', Icon: Monitor },
  { mode: 'area', command: 'capture-area', title: 'Capture Selected Area', hint: 'Drag to select a region on the page', Icon: Crop },
  { mode: 'fullPage', command: 'capture-full-page', title: 'Capture Full Page', hint: 'Scroll and stitch the whole page', Icon: ScrollText },
  { mode: 'scrollArea', command: 'capture-scroll-area', title: 'Capture Scrolling Area', hint: 'Select a table, panel or region and scroll it', Icon: ArrowDownUp },
  { mode: 'element', command: 'capture-element', title: 'Capture Element', hint: 'Hover and click any element', Icon: MousePointerClick },
];

export function Popup() {
  useSettings(); // applies the saved theme
  const [support, setSupport] = useState<TabSupport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<CaptureMode | null>(null);
  const [shortcuts, setShortcuts] = useState<Record<string, string>>({});

  useEffect(() => {
    void getTabSupport().then(setSupport, () => setSupport({ supported: true }));
    void chrome.commands.getAll().then((all) => {
      const map: Record<string, string> = {};
      for (const c of all) if (c.name && c.shortcut) map[c.name] = c.shortcut;
      setShortcuts(map);
    });
  }, []);

  const start = async (mode: CaptureMode) => {
    setError(null);
    setStarting(mode);
    try {
      await request({ type: 'START_CAPTURE', mode, tabId: support?.tabId });
      window.close(); // capture continues on the page; nothing more to do here
    } catch (err) {
      setError(serializeError(err).message);
      setStarting(null);
    }
  };

  const openPage = (type: 'OPEN_HISTORY' | 'OPEN_SETTINGS' | 'OPEN_SHORTCUTS') => {
    void request({ type }).then(() => window.close());
  };

  const blocked = support?.supported === false;

  return (
    <div className="popup">
      <header>
        <img src="../icons/icon-48.png" alt="" />
        <div>
          <h1>SnapFlow</h1>
          <p>Capture, copy, annotate. All local.</p>
        </div>
      </header>

      {blocked && <p className="notice">{support?.reason}</p>}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <div className="modes">
        {MODES.map(({ mode, command, title, hint, Icon }) => (
          <button
            key={mode}
            type="button"
            className="mode"
            disabled={blocked || starting !== null}
            onClick={() => void start(mode)}
            data-testid={`mode-${mode}`}
          >
            <span className="ico">
              <Icon size={19} />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{starting === mode ? 'Starting…' : hint}</small>
            </span>
            {shortcuts[command] ? <kbd>{shortcuts[command]}</kbd> : <span />}
          </button>
        ))}
      </div>

      <div className="links">
        <button type="button" className="btn btn-ghost" onClick={() => openPage('OPEN_HISTORY')}>
          <History size={14} /> Recent
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => openPage('OPEN_SETTINGS')}>
          <SettingsIcon size={14} /> Settings
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => openPage('OPEN_SHORTCUTS')}>
          <Keyboard size={14} /> Shortcuts
        </button>
      </div>
    </div>
  );
}
