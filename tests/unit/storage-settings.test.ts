import { describe, expect, it } from 'vitest';
import { selectRecordsToPurge } from '@/shared/captures';
import { TRANSIENT_TTL_MS } from '@/shared/constants';
import { DEFAULT_SETTINGS, normalizeSettings } from '@/shared/settings';
import type { CaptureRecord } from '@/shared/types';

const NOW = 1_000_000_000;
const rec = (id: string, ageMs: number, keep: boolean, bytes = 1000): CaptureRecord => ({
  id,
  createdAt: NOW - ageMs,
  width: 1,
  height: 1,
  blob: new Blob([new Uint8Array(bytes)]),
  keep,
  meta: { mode: 'visible', scale: 1, viewport: { width: 1, height: 1 }, warnings: [] },
});

describe('local storage policy (history is opt-in)', () => {
  it('purges expired transient captures but never history entries by age', () => {
    const ids = selectRecordsToPurge(
      [rec('fresh', 1000, false), rec('stale', TRANSIENT_TTL_MS + 1, false), rec('old-history', TRANSIENT_TTL_MS * 10, true)],
      { historyLimit: 20, historyMaxBytes: 1e9, now: NOW },
    );
    expect(ids).toEqual(['stale']);
  });
  it('enforces the history count limit, newest first', () => {
    const ids = selectRecordsToPurge([rec('a', 100, true), rec('b', 200, true), rec('c', 300, true)], { historyLimit: 2, historyMaxBytes: 1e9, now: NOW });
    expect(ids).toEqual(['c']);
  });
  it('enforces the storage budget', () => {
    const ids = selectRecordsToPurge([rec('a', 100, true, 600), rec('b', 200, true, 600)], { historyLimit: 20, historyMaxBytes: 1000, now: NOW });
    expect(ids).toEqual(['b']);
  });
});

describe('settings', () => {
  it('defaults are privacy-first', () => {
    expect(DEFAULT_SETTINGS.historyEnabled).toBe(false);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });
  it('clamps and repairs corrupt stored values', () => {
    const s = normalizeSettings({
      theme: 'neon',
      jpegQuality: 5,
      historyLimit: -3,
      exportFormat: 'gif',
      userPresets: [{ id: 1 }, { id: 'p', name: 'Mine', tool: 'rect', color: '#fff', strokeWidth: 2 }],
    });
    expect(s.theme).toBe('system');
    expect(s.jpegQuality).toBe(1);
    expect(s.historyLimit).toBe(1);
    expect(s.exportFormat).toBe('png');
    expect(s.userPresets).toHaveLength(1);
  });
});
