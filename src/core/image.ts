import { SnapflowError } from '@/shared/errors';
import { IMAGE_MIME, type ImageFormat, type Rect, type Size } from '@/shared/types';

export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createCanvas(width: number, height: number): OffscreenCanvas {
  return new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

export function get2d(canvas: AnyCanvas, opts?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = canvas.getContext('2d', opts) as Ctx2D | null;
  if (!ctx) throw new SnapflowError('CAPTURE_FAILED', 'Could not allocate a drawing surface (the image may be too large).');
  return ctx;
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function blobToBitmap(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch (err) {
    throw new SnapflowError('CAPTURE_FAILED', 'The captured image could not be decoded.', { cause: err });
  }
}

export async function canvasToBlob(canvas: AnyCanvas, format: ImageFormat = 'png', quality?: number): Promise<Blob> {
  const type = IMAGE_MIME[format];
  let blob: Blob | null;
  if (canvas instanceof OffscreenCanvas) {
    blob = await canvas.convertToBlob({ type, quality });
  } else {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  }
  if (!blob || blob.size === 0) {
    throw new SnapflowError('TOO_LARGE', 'The image is too large for this browser to encode.');
  }
  // Chrome silently falls back to PNG for unsupported types; make that visible.
  if (blob.type !== type) {
    throw new SnapflowError('CAPTURE_FAILED', `This browser cannot encode ${format.toUpperCase()} images.`);
  }
  return blob;
}

/** Crop a pixel rectangle out of a bitmap into a PNG blob (lossless, native resolution). */
export async function cropBitmapToBlob(bitmap: ImageBitmap, rect: Rect): Promise<Blob> {
  const canvas = createCanvas(rect.width, rect.height);
  const ctx = get2d(canvas);
  ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'png');
}

export function fitWithin(size: Size, maxEdge: number): Size {
  const k = Math.min(1, maxEdge / Math.max(size.width, size.height));
  return { width: Math.max(1, Math.round(size.width * k)), height: Math.max(1, Math.round(size.height * k)) };
}

/** Small JPEG used by the history list. The decoder resizes while decoding, so large pages stay cheap. */
export async function makeThumbnail(blob: Blob, width: number, height: number, maxEdge = 360): Promise<Blob> {
  const size = fitWithin({ width, height }, maxEdge);
  const bitmap = await createImageBitmap(blob, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
  try {
    const canvas = createCanvas(size.width, size.height);
    const ctx = get2d(canvas);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    ctx.drawImage(bitmap, 0, 0, size.width, size.height);
    return await canvasToBlob(canvas, 'jpeg', 0.8);
  } finally {
    bitmap.close();
  }
}

/**
 * Re-encode an image blob. JPEG has no alpha channel, so transparent pixels are flattened
 * onto white first (otherwise Chrome renders them black).
 */
export async function convertImageBlob(blob: Blob, format: ImageFormat, quality = 0.92): Promise<Blob> {
  if (blob.type === IMAGE_MIME[format] && format === 'png') return blob;
  const bitmap = await blobToBitmap(blob);
  try {
    const canvas = createCanvas(bitmap.width, bitmap.height);
    const ctx = get2d(canvas);
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    return await canvasToBlob(canvas, format, format === 'png' ? undefined : quality);
  } finally {
    bitmap.close();
  }
}

export async function ensurePng(blob: Blob): Promise<Blob> {
  return blob.type === 'image/png' ? blob : convertImageBlob(blob, 'png');
}

export async function imageSize(blob: Blob): Promise<Size> {
  const bmp = await blobToBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return size;
}
