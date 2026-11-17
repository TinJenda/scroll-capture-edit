import type { Rect, Size } from '@/shared/types';

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function regionWithin(region: Rect, size: Size): Rect {
  const x = Math.min(Math.max(0, Math.round(region.x)), size.width - 1);
  const y = Math.min(Math.max(0, Math.round(region.y)), size.height - 1);
  const w = Math.max(1, Math.min(Math.round(region.width), size.width - x));
  const h = Math.max(1, Math.min(Math.round(region.height), size.height - y));
  return { x, y, width: w, height: h };
}

/**
 * Average-pool a region down to (tw × th) by repeated halving. A single bilinear
 * downscale by 10× samples only a handful of source pixels and produces noisy mosaics.
 */
function downscale(source: CanvasImageSource, region: Rect, tw: number, th: number): HTMLCanvasElement {
  let cur = makeCanvas(region.width, region.height);
  const first = cur.getContext('2d') as CanvasRenderingContext2D;
  first.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  while (cur.width > tw * 2 || cur.height > th * 2) {
    const next = makeCanvas(Math.max(tw, Math.ceil(cur.width / 2)), Math.max(th, Math.ceil(cur.height / 2)));
    const ctx = next.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, next.width, next.height);
    cur = next;
  }
  if (cur.width !== tw || cur.height !== th) {
    const last = makeCanvas(tw, th);
    const ctx = last.getContext('2d') as CanvasRenderingContext2D;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, cur.width, cur.height, 0, 0, tw, th);
    cur = last;
  }
  return cur;
}

/**
 * Render the blurred / pixelated version of a region of the *original screenshot*.
 * Output size equals the (clamped, integer) region so it can be placed 1:1.
 */
export function renderEffect(
  source: CanvasImageSource,
  size: Size,
  kind: 'blur' | 'pixelate',
  rawRegion: Rect,
  strength: number,
): HTMLCanvasElement {
  const region = regionWithin(rawRegion, size);
  const out = makeCanvas(region.width, region.height);
  const ctx = out.getContext('2d') as CanvasRenderingContext2D;

  if (kind === 'pixelate') {
    const block = Math.max(2, Math.round(strength));
    const tw = Math.max(1, Math.ceil(region.width / block));
    const th = Math.max(1, Math.ceil(region.height / block));
    const small = downscale(source, region, tw, th);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(small, 0, 0, tw, th, 0, 0, tw * block, th * block);
    return out;
  }

  // Blur: include a margin so edge pixels blur with their real neighbours, then crop it away.
  const radius = Math.max(1, strength);
  const pad = Math.ceil(radius * 3);
  const sx = Math.max(0, region.x - pad);
  const sy = Math.max(0, region.y - pad);
  const ex = Math.min(size.width, region.x + region.width + pad);
  const ey = Math.min(size.height, region.y + region.height + pad);
  const tmp = makeCanvas(ex - sx, ey - sy);
  const tctx = tmp.getContext('2d') as CanvasRenderingContext2D;
  tctx.filter = `blur(${radius}px)`;
  tctx.drawImage(source, sx, sy, ex - sx, ey - sy, 0, 0, ex - sx, ey - sy);
  // Opaque base first so image-edge transparency from the blur never shows through.
  ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  ctx.drawImage(tmp, region.x - sx, region.y - sy, region.width, region.height, 0, 0, region.width, region.height);
  return out;
}
