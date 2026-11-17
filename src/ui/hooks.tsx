import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { applyTheme, DEFAULT_SETTINGS, loadSettings, saveSettings, subscribeSettings, type Settings } from '@/shared/settings';

/* ---------------------------- settings ---------------------------- */

export function useSettings(): [Settings, (patch: Partial<Settings>) => Promise<void>, boolean] {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      applyTheme(s.theme);
      setReady(true);
    });
    const unsub = subscribeSettings((s) => {
      setSettings(s);
      applyTheme(s.theme);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const update = useCallback(async (patch: Partial<Settings>) => {
    const next = await saveSettings(patch);
    setSettings(next);
    applyTheme(next.theme);
  }, []);

  return [settings, update, ready];
}

/* ---------------------------- toasts ---------------------------- */

export interface ToastItem {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

interface ToastApi {
  push(kind: ToastItem['kind'], text: string, action?: ToastItem['action'], ms?: number): void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback<ToastApi['push']>((kind, text, action, ms = 3800) => {
    const id = nextId.current++;
    setItems((prev) => [...prev.slice(-2), { id, kind, text, action }]);
    window.setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), action ? Math.max(ms, 7000) : ms);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-host" aria-live="polite" role="status">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            {t.action && (
              <button type="button" className="btn btn-sm" onClick={t.action.run}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
