import { IMAGE_EXT, type ImageFormat } from './types';

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

/** 2026-11-17-153000 (local time). */
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Makes a user-typed name safe for Windows/macOS/Linux file systems. */
export function sanitizeFilename(input: string): string {
  let name = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (name.length > 120) name = name.slice(0, 120).trim();
  if (RESERVED.test(name)) name = `_${name}`;
  return name;
}

/** Strips a trailing image extension the user may have typed. */
export function stripImageExtension(name: string): string {
  return name.replace(/\.(png|jpe?g|webp)$/i, '');
}

export interface FilenameOptions {
  /** Custom base name typed by the user (e.g. "bug-report-login"). Overrides the prefix. */
  name?: string;
  prefix?: string;
  includeTimestamp: boolean;
  format: ImageFormat;
  now?: Date;
}

/**
 * snapflow-2026-11-17-153000.png · bug-report-login.png · bug-report-login-2026-11-17-153000.png
 */
export function buildFilename(opts: FilenameOptions): string {
  const now = opts.now ?? new Date();
  const custom = opts.name ? sanitizeFilename(stripImageExtension(opts.name)) : '';
  const prefix = sanitizeFilename(opts.prefix ?? 'snapflow');
  const parts: string[] = [];
  if (custom) {
    parts.push(custom);
  } else if (prefix) {
    parts.push(prefix);
  }
  if (opts.includeTimestamp || parts.length === 0) parts.push(formatTimestamp(now));
  return `${parts.join('-')}.${IMAGE_EXT[opts.format]}`;
}
