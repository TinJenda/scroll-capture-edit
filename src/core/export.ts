import { buildFilename } from '@/shared/filename';
import type { Settings } from '@/shared/settings';
import { type ImageFormat } from '@/shared/types';
import { canvasToBlob, convertImageBlob, createCanvas, get2d, type AnyCanvas } from './image';
import { downloadBlob, type SaveResult } from './download';

export interface ExportOptions {
  format: ImageFormat;
  /** 0..1, used for JPEG and WebP. */
  quality: number;
  filename: string;
  saveAs?: boolean;
}

export function qualityFor(format: ImageFormat, settings: Pick<Settings, 'jpegQuality' | 'webpQuality'>): number {
  return format === 'jpeg' ? settings.jpegQuality : format === 'webp' ? settings.webpQuality : 1;
}

/** Encode a rendered canvas. JPEG has no alpha, so it is flattened onto white (never black). */
export async function encodeCanvas(canvas: AnyCanvas, format: ImageFormat, quality: number): Promise<Blob> {
  if (format !== 'jpeg') return canvasToBlob(canvas, format, format === 'png' ? undefined : quality);
  const flat = createCanvas(canvas.width, canvas.height);
  const ctx = get2d(flat);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  return canvasToBlob(flat, 'jpeg', quality);
}

/** Convert an existing image blob (e.g. the original PNG capture) to another format. */
export function encodeBlob(blob: Blob, format: ImageFormat, quality: number): Promise<Blob> {
  return convertImageBlob(blob, format, quality);
}

export async function saveImage(blob: Blob, opts: ExportOptions): Promise<SaveResult> {
  return downloadBlob(blob, opts.filename, { saveAs: opts.saveAs });
}

/** Default file name for quick-save buttons, honouring the user's prefix/timestamp settings. */
export function defaultFilename(settings: Settings, format: ImageFormat, name?: string): string {
  return buildFilename({
    name,
    prefix: settings.filenamePrefix,
    includeTimestamp: settings.includeTimestamp,
    format,
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
