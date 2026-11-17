/**
 * Editor document model: plain, serializable data. Nothing in here touches Konva or the DOM,
 * so it can be unit-tested and round-tripped through JSON safely.
 */
import type { Rect } from '@/shared/types';

export type ToolId =
  | 'select'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'text'
  | 'pen'
  | 'highlighter'
  | 'blur'
  | 'pixelate'
  | 'marker'
  | 'crop';

export const DEFAULT_COLOR = '#FF3B30';

interface Base {
  id: string;
}

export interface RectAnn extends Base {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  /** null = transparent (the default). */
  fill: string | null;
}

export interface EllipseAnn extends Base {
  type: 'ellipse';
  /** Bounding box. */
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string;
  strokeWidth: number;
  fill: string | null;
}

export interface LineAnn extends Base {
  type: 'line' | 'arrow';
  /** [x1, y1, x2, y2] */
  points: number[];
  stroke: string;
  strokeWidth: number;
}

export interface PenAnn extends Base {
  type: 'pen' | 'highlighter';
  points: number[];
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

export type TextAlign = 'left' | 'center' | 'right';

export interface TextAnn extends Base {
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fill: string;
  align: TextAlign;
  bold: boolean;
}

export interface MarkerAnn extends Base {
  type: 'marker';
  /** Centre of the circle. */
  x: number;
  y: number;
  number: number;
  radius: number;
  fill: string;
  textColor: string;
}

export interface EffectAnn extends Base {
  type: 'blur' | 'pixelate';
  x: number;
  y: number;
  width: number;
  height: number;
  /** Blur radius, or mosaic block size, in image pixels. */
  strength: number;
}

export type Annotation = RectAnn | EllipseAnn | LineAnn | PenAnn | TextAnn | MarkerAnn | EffectAnn;
export type AnnotationType = Annotation['type'];

export interface EditorDoc {
  annotations: Annotation[];
  /** Non-destructive crop (image pixels); null = whole image. */
  crop: Rect | null;
}

export const EMPTY_DOC: EditorDoc = { annotations: [], crop: null };

/** Per-tool defaults the user can tweak before drawing. */
export interface ToolStyle {
  stroke: string;
  strokeWidth: number;
  fill: string | null;
  fontSize: number;
  textColor: string;
  textAlign: TextAlign;
  bold: boolean;
  markerFill: string;
  markerTextColor: string;
  markerRadius: number;
  highlighterColor: string;
  highlighterWidth: number;
  highlighterOpacity: number;
  blurStrength: number;
  pixelSize: number;
}

/** Defaults scale with the capture (a 2× HiDPI screenshot needs 2× thicker lines to look the same). */
export function defaultStyle(scale = 1): ToolStyle {
  const k = Math.max(1, Math.round(scale * 10) / 10);
  const px = (n: number) => Math.max(1, Math.round(n * k));
  return {
    stroke: DEFAULT_COLOR,
    strokeWidth: px(3),
    fill: null,
    fontSize: px(24),
    textColor: DEFAULT_COLOR,
    textAlign: 'left',
    bold: true,
    markerFill: DEFAULT_COLOR,
    markerTextColor: '#FFFFFF',
    markerRadius: px(14),
    highlighterColor: '#FFD60A',
    highlighterWidth: px(18),
    highlighterOpacity: 0.4,
    blurStrength: px(10),
    pixelSize: px(10),
  };
}

export function newId(): string {
  return crypto.randomUUID().slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* Markers                                                             */
/* ------------------------------------------------------------------ */

/** Smallest positive integer not already used – so 1,2,3 → 4, and a deleted 2 is reused. */
export function nextMarkerNumber(annotations: Annotation[]): number {
  const used = new Set<number>();
  for (const a of annotations) if (a.type === 'marker') used.add(a.number);
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

/** Renumber every marker 1…n in creation (z-) order. */
export function renumberMarkers(annotations: Annotation[]): Annotation[] {
  let n = 0;
  let changed = false;
  const out = annotations.map((a) => {
    if (a.type !== 'marker') return a;
    n += 1;
    if (a.number === n) return a;
    changed = true;
    return { ...a, number: n };
  });
  return changed ? out : annotations;
}

/**
 * Remove an annotation. With `autoRenumber`, deleting marker k closes the gap by shifting
 * higher-numbered markers down, so the sequence stays 1…n.
 */
export function removeAnnotation(annotations: Annotation[], id: string, autoRenumber: boolean): Annotation[] {
  const target = annotations.find((a) => a.id === id);
  if (!target) return annotations;
  const rest = annotations.filter((a) => a.id !== id);
  if (target.type !== 'marker' || !autoRenumber) return rest;
  const removed = target.number;
  return rest.map((a) => (a.type === 'marker' && a.number > removed ? { ...a, number: a.number - 1 } : a));
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

export function translateAnnotation<T extends Annotation>(a: T, dx: number, dy: number): T {
  switch (a.type) {
    case 'line':
    case 'arrow':
    case 'pen':
    case 'highlighter':
      return { ...a, points: a.points.map((v, i) => v + (i % 2 === 0 ? dx : dy)) };
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

export function cloneAnnotation(a: Annotation, dx = 16, dy = 16): Annotation {
  return { ...translateAnnotation(a, dx, dy), id: newId() };
}

export function clampCrop(rect: Rect, size: { width: number; height: number }): Rect | null {
  const x1 = Math.max(0, Math.min(rect.x, rect.x + rect.width));
  const y1 = Math.max(0, Math.min(rect.y, rect.y + rect.height));
  const x2 = Math.min(size.width, Math.max(rect.x, rect.x + rect.width));
  const y2 = Math.min(size.height, Math.max(rect.y, rect.y + rect.height));
  const r = { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) };
  return r.width >= 4 && r.height >= 4 ? r : null;
}

/** Output size after the (optional) crop. */
export function outputSize(doc: EditorDoc, imageSize: { width: number; height: number }) {
  return doc.crop ? { width: doc.crop.width, height: doc.crop.height } : { ...imageSize };
}

export function isEmptyDoc(doc: EditorDoc): boolean {
  return doc.annotations.length === 0 && doc.crop === null;
}

/* ------------------------------------------------------------------ */
/* Serialization (versioned, validated)                                */
/* ------------------------------------------------------------------ */

const DOC_VERSION = 1;
const MAX_ANNOTATIONS = 2000;
const MAX_POINTS = 40000;

export function serializeDoc(doc: EditorDoc): string {
  return JSON.stringify({ v: DOC_VERSION, crop: doc.crop, annotations: doc.annotations });
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const pos = (v: unknown, fallback: number, max = 1e6): number => {
  const n = num(v, fallback);
  return n > 0 && n <= max ? n : fallback;
};
const color = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : fallback;
const points = (v: unknown, min: number): number[] | null => {
  if (!Array.isArray(v) || v.length < min || v.length > MAX_POINTS || v.length % 2 !== 0) return null;
  return v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as number[]) : null;
};

function parseAnnotation(raw: unknown): Annotation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 ? r.id : newId();
  switch (r.type) {
    case 'rect':
    case 'ellipse':
      return {
        id,
        type: r.type,
        x: num(r.x),
        y: num(r.y),
        width: pos(r.width, 1),
        height: pos(r.height, 1),
        stroke: color(r.stroke, DEFAULT_COLOR),
        strokeWidth: pos(r.strokeWidth, 3, 200),
        fill: r.fill === null || r.fill === undefined ? null : color(r.fill, DEFAULT_COLOR),
      };
    case 'line':
    case 'arrow': {
      const p = points(r.points, 4);
      return p ? { id, type: r.type, points: p.slice(0, 4), stroke: color(r.stroke, DEFAULT_COLOR), strokeWidth: pos(r.strokeWidth, 3, 200) } : null;
    }
    case 'pen':
    case 'highlighter': {
      const p = points(r.points, 4);
      return p
        ? {
            id,
            type: r.type,
            points: p,
            stroke: color(r.stroke, DEFAULT_COLOR),
            strokeWidth: pos(r.strokeWidth, 3, 200),
            opacity: Math.min(1, Math.max(0.05, num(r.opacity, r.type === 'highlighter' ? 0.4 : 1))),
          }
        : null;
    }
    case 'text':
      if (typeof r.text !== 'string') return null;
      return {
        id,
        type: 'text',
        x: num(r.x),
        y: num(r.y),
        text: r.text.slice(0, 2000),
        fontSize: pos(r.fontSize, 24, 500),
        fill: color(r.fill, DEFAULT_COLOR),
        align: r.align === 'center' || r.align === 'right' ? r.align : 'left',
        bold: r.bold !== false,
      };
    case 'marker':
      return {
        id,
        type: 'marker',
        x: num(r.x),
        y: num(r.y),
        number: Math.min(9999, Math.max(0, Math.round(num(r.number, 1)))),
        radius: pos(r.radius, 14, 500),
        fill: color(r.fill, DEFAULT_COLOR),
        textColor: color(r.textColor, '#FFFFFF'),
      };
    case 'blur':
    case 'pixelate':
      return {
        id,
        type: r.type,
        x: num(r.x),
        y: num(r.y),
        width: pos(r.width, 1),
        height: pos(r.height, 1),
        strength: pos(r.strength, 10, 300),
      };
    default:
      return null;
  }
}

/** Returns null for anything that is not a valid document; invalid annotations are dropped, never trusted. */
export function parseDoc(json: string | undefined | null): EditorDoc | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || raw.v !== DOC_VERSION || !Array.isArray(raw.annotations)) return null;
    const seen = new Set<string>();
    const annotations: Annotation[] = [];
    for (const item of raw.annotations.slice(0, MAX_ANNOTATIONS)) {
      const a = parseAnnotation(item);
      if (!a || seen.has(a.id)) continue;
      seen.add(a.id);
      annotations.push(a);
    }
    let crop: Rect | null = null;
    const c = raw.crop as Record<string, unknown> | null;
    if (c && typeof c === 'object' && [c.x, c.y, c.width, c.height].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      crop = { x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number };
      if (crop.width < 1 || crop.height < 1) crop = null;
    }
    return { annotations, crop };
  } catch {
    return null;
  }
}
