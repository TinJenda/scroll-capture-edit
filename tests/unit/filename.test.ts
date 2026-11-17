import { describe, expect, it } from 'vitest';
import { buildFilename, formatTimestamp, sanitizeFilename } from '@/shared/filename';

const now = new Date(2026, 10, 17, 15, 30, 0);

describe('export filenames', () => {
  it('formats timestamps', () => {
    expect(formatTimestamp(now)).toBe('2026-11-17-153000');
  });
  it('default prefix + timestamp', () => {
    expect(buildFilename({ includeTimestamp: true, format: 'png', now })).toBe('snapflow-2026-11-17-153000.png');
  });
  it('custom names without timestamp', () => {
    expect(buildFilename({ name: 'bug-report-login', includeTimestamp: false, format: 'png', now })).toBe('bug-report-login.png');
    expect(buildFilename({ name: 'api-response-difference.png', includeTimestamp: false, format: 'webp', now })).toBe('api-response-difference.webp');
  });
  it('custom prefix', () => {
    expect(buildFilename({ prefix: 'qa', includeTimestamp: true, format: 'jpeg', now })).toBe('qa-2026-11-17-153000.jpg');
  });
  it('never produces an empty name', () => {
    expect(buildFilename({ prefix: '', includeTimestamp: false, format: 'png', now })).toBe('2026-11-17-153000.png');
  });
  it('sanitises illegal and reserved names', () => {
    expect(sanitizeFilename('a/b\\c:d*e?"f<g>h|i')).toBe('a-b-c-d-e--f-g-h-i');
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('..hidden. ')).toBe('hidden');
    expect(sanitizeFilename('x'.repeat(300)).length).toBeLessThanOrEqual(120);
  });
});
