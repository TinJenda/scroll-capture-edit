import type { ImageFormat } from './types';

export type ThemeSetting = 'system' | 'light' | 'dark';

export type PresetTool = 'rect' | 'ellipse' | 'arrow' | 'line' | 'pen' | 'highlighter' | 'text' | 'marker';

export interface AnnotationPreset {
  id: string;
  name: string;
  tool: PresetTool;
  color: string;
  strokeWidth: number;
  /** Highlighter / semi-transparent fills. */
  opacity?: number;
  /** True for the built-in presets (not deletable). */
  builtin?: boolean;
}

export interface Settings {
  theme: ThemeSetting;
  exportFormat: ImageFormat;
  jpegQuality: number;
  webpQuality: number;
  filenamePrefix: string;
  includeTimestamp: boolean;
  /** Show Chrome's "Save as…" dialog instead of downloading straight to the default folder. */
  askWhereToSave: boolean;
  historyEnabled: boolean;
  historyLimit: number;
  historyMaxMB: number;
  autoRenumberMarkers: boolean;
  settleMs: number;
  userPresets: AnnotationPreset[];
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  exportFormat: 'png',
  jpegQuality: 0.92,
  webpQuality: 0.9,
  filenamePrefix: 'snapflow',
  includeTimestamp: true,
  askWhereToSave: false,
  historyEnabled: false,
  historyLimit: 20,
  historyMaxMB: 200,
  autoRenumberMarkers: true,
  settleMs: 140,
  userPresets: [],
};

export const BUILTIN_PRESETS: AnnotationPreset[] = [
  { id: 'red-rect', name: 'Red rectangle', tool: 'rect', color: '#FF3B30', strokeWidth: 3, builtin: true },
  { id: 'red-arrow', name: 'Red arrow', tool: 'arrow', color: '#FF3B30', strokeWidth: 4, builtin: true },
  { id: 'yellow-highlight', name: 'Yellow highlighter', tool: 'highlighter', color: '#FFD60A', strokeWidth: 18, opacity: 0.4, builtin: true },
  { id: 'blue-text', name: 'Blue text', tool: 'text', color: '#0A84FF', strokeWidth: 3, builtin: true },
  { id: 'callouts', name: 'Numbered callouts', tool: 'marker', color: '#FF3B30', strokeWidth: 3, builtin: true },
];

const KEY = 'settings';

const clampNum = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

/** Merge stored data over defaults and clamp every value; corrupt storage can never break the UI. */
export function normalizeSettings(raw: unknown): Settings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  const d = DEFAULT_SETTINGS;
  const formats: ImageFormat[] = ['png', 'jpeg', 'webp'];
  const themes: ThemeSetting[] = ['system', 'light', 'dark'];
  return {
    theme: themes.includes(s.theme as ThemeSetting) ? (s.theme as ThemeSetting) : d.theme,
    exportFormat: formats.includes(s.exportFormat as ImageFormat) ? (s.exportFormat as ImageFormat) : d.exportFormat,
    jpegQuality: clampNum(s.jpegQuality, 0.1, 1, d.jpegQuality),
    webpQuality: clampNum(s.webpQuality, 0.1, 1, d.webpQuality),
    filenamePrefix: typeof s.filenamePrefix === 'string' ? s.filenamePrefix.slice(0, 60) : d.filenamePrefix,
    includeTimestamp: typeof s.includeTimestamp === 'boolean' ? s.includeTimestamp : d.includeTimestamp,
    askWhereToSave: typeof s.askWhereToSave === 'boolean' ? s.askWhereToSave : d.askWhereToSave,
    historyEnabled: typeof s.historyEnabled === 'boolean' ? s.historyEnabled : d.historyEnabled,
    historyLimit: Math.round(clampNum(s.historyLimit, 1, 200, d.historyLimit)),
    historyMaxMB: Math.round(clampNum(s.historyMaxMB, 10, 2000, d.historyMaxMB)),
    autoRenumberMarkers: typeof s.autoRenumberMarkers === 'boolean' ? s.autoRenumberMarkers : d.autoRenumberMarkers,
    settleMs: Math.round(clampNum(s.settleMs, 0, 2000, d.settleMs)),
    userPresets: Array.isArray(s.userPresets)
      ? s.userPresets
          .filter(
            (p): p is AnnotationPreset =>
              typeof p === 'object' && p !== null && typeof p.id === 'string' && typeof p.name === 'string' &&
              typeof p.color === 'string' && typeof p.strokeWidth === 'number' && typeof p.tool === 'string',
          )
          .slice(0, 30)
          .map((p) => ({ ...p, name: p.name.slice(0, 40), builtin: false }))
      : [],
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return normalizeSettings(stored[KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function subscribeSettings(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb(normalizeSettings(changes[KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Applies the theme to <html data-theme>. 'system' removes the attribute so CSS media queries decide. */
export function applyTheme(theme: ThemeSetting, root: HTMLElement = document.documentElement): void {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}
