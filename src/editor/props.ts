/**
 * Maps between three views of "style": the properties panel, the per-tool defaults and a concrete
 * annotation. Keeping this in one pure module makes the panel generic and the mapping testable.
 */
import {
  newId,
  nextMarkerNumber,
  type Annotation,
  type AnnotationType,
  type TextAlign,
  type ToolId,
  type ToolStyle,
} from './model';

export interface PanelProps {
  color?: string;
  width?: number;
  fill?: string | null;
  fontSize?: number;
  align?: TextAlign;
  bold?: boolean;
  number?: number;
  textColor?: string;
  radius?: number;
  strength?: number;
  opacity?: number;
}

/** Which tool creates which annotation kind (select/crop create nothing). */
export function kindForTool(tool: ToolId): AnnotationType | null {
  switch (tool) {
    case 'rect':
    case 'ellipse':
    case 'arrow':
    case 'line':
    case 'pen':
    case 'highlighter':
    case 'text':
    case 'marker':
    case 'blur':
    case 'pixelate':
      return tool;
    default:
      return null;
  }
}

export function propsOfAnnotation(a: Annotation): PanelProps {
  switch (a.type) {
    case 'rect':
    case 'ellipse':
      return { color: a.stroke, width: a.strokeWidth, fill: a.fill };
    case 'line':
    case 'arrow':
      return { color: a.stroke, width: a.strokeWidth };
    case 'pen':
    case 'highlighter':
      return { color: a.stroke, width: a.strokeWidth, opacity: a.opacity };
    case 'text':
      return { color: a.fill, fontSize: a.fontSize, align: a.align, bold: a.bold };
    case 'marker':
      return { color: a.fill, textColor: a.textColor, radius: a.radius, number: a.number };
    case 'blur':
    case 'pixelate':
      return { strength: a.strength };
  }
}

export function propsOfStyle(kind: AnnotationType, s: ToolStyle): PanelProps {
  switch (kind) {
    case 'rect':
    case 'ellipse':
      return { color: s.stroke, width: s.strokeWidth, fill: s.fill };
    case 'line':
    case 'arrow':
    case 'pen':
      return { color: s.stroke, width: s.strokeWidth };
    case 'highlighter':
      return { color: s.highlighterColor, width: s.highlighterWidth, opacity: s.highlighterOpacity };
    case 'text':
      return { color: s.textColor, fontSize: s.fontSize, align: s.textAlign, bold: s.bold };
    case 'marker':
      return { color: s.markerFill, textColor: s.markerTextColor, radius: s.markerRadius };
    case 'blur':
      return { strength: s.blurStrength };
    case 'pixelate':
      return { strength: s.pixelSize };
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function applyPropsToAnnotation(a: Annotation, p: PanelProps): Annotation {
  switch (a.type) {
    case 'rect':
    case 'ellipse':
      return {
        ...a,
        stroke: p.color ?? a.stroke,
        strokeWidth: p.width !== undefined ? clamp(p.width, 1, 100) : a.strokeWidth,
        fill: p.fill !== undefined ? p.fill : a.fill,
      };
    case 'line':
    case 'arrow':
      return { ...a, stroke: p.color ?? a.stroke, strokeWidth: p.width !== undefined ? clamp(p.width, 1, 100) : a.strokeWidth };
    case 'pen':
    case 'highlighter':
      return {
        ...a,
        stroke: p.color ?? a.stroke,
        strokeWidth: p.width !== undefined ? clamp(p.width, 1, 100) : a.strokeWidth,
        opacity: p.opacity !== undefined ? clamp(p.opacity, 0.05, 1) : a.opacity,
      };
    case 'text':
      return {
        ...a,
        fill: p.color ?? a.fill,
        fontSize: p.fontSize !== undefined ? clamp(Math.round(p.fontSize), 6, 400) : a.fontSize,
        align: p.align ?? a.align,
        bold: p.bold ?? a.bold,
      };
    case 'marker':
      return {
        ...a,
        fill: p.color ?? a.fill,
        textColor: p.textColor ?? a.textColor,
        radius: p.radius !== undefined ? clamp(Math.round(p.radius), 6, 200) : a.radius,
        number: p.number !== undefined ? clamp(Math.round(p.number), 0, 9999) : a.number,
      };
    case 'blur':
    case 'pixelate':
      return { ...a, strength: p.strength !== undefined ? clamp(Math.round(p.strength), 1, 200) : a.strength };
  }
}

export function applyPropsToStyle(kind: AnnotationType, s: ToolStyle, p: PanelProps): ToolStyle {
  const next = { ...s };
  switch (kind) {
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'pen':
      if (p.color !== undefined) next.stroke = p.color;
      if (p.width !== undefined) next.strokeWidth = clamp(p.width, 1, 100);
      if (p.fill !== undefined && (kind === 'rect' || kind === 'ellipse')) next.fill = p.fill;
      break;
    case 'highlighter':
      if (p.color !== undefined) next.highlighterColor = p.color;
      if (p.width !== undefined) next.highlighterWidth = clamp(p.width, 1, 100);
      if (p.opacity !== undefined) next.highlighterOpacity = clamp(p.opacity, 0.05, 1);
      break;
    case 'text':
      if (p.color !== undefined) next.textColor = p.color;
      if (p.fontSize !== undefined) next.fontSize = clamp(Math.round(p.fontSize), 6, 400);
      if (p.align !== undefined) next.textAlign = p.align;
      if (p.bold !== undefined) next.bold = p.bold;
      break;
    case 'marker':
      if (p.color !== undefined) next.markerFill = p.color;
      if (p.textColor !== undefined) next.markerTextColor = p.textColor;
      if (p.radius !== undefined) next.markerRadius = clamp(Math.round(p.radius), 6, 200);
      break;
    case 'blur':
      if (p.strength !== undefined) next.blurStrength = clamp(Math.round(p.strength), 1, 200);
      break;
    case 'pixelate':
      if (p.strength !== undefined) next.pixelSize = clamp(Math.round(p.strength), 1, 200);
      break;
  }
  return next;
}

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
  points: number[];
  text: string;
}

/** Build a new annotation for a tool from drawn geometry + the current defaults. */
export function buildAnnotation(
  tool: ToolId,
  g: Partial<Geometry>,
  style: ToolStyle,
  existing: Annotation[],
): Annotation | null {
  const id = newId();
  const x = g.x ?? 0;
  const y = g.y ?? 0;
  const width = g.width ?? 0;
  const height = g.height ?? 0;
  switch (tool) {
    case 'rect':
    case 'ellipse':
      return { id, type: tool, x, y, width, height, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill };
    case 'arrow':
    case 'line':
      return g.points && g.points.length >= 4
        ? { id, type: tool, points: g.points.slice(0, 4), stroke: style.stroke, strokeWidth: style.strokeWidth }
        : null;
    case 'pen':
      return g.points && g.points.length >= 4
        ? { id, type: 'pen', points: g.points, stroke: style.stroke, strokeWidth: style.strokeWidth, opacity: 1 }
        : null;
    case 'highlighter':
      return g.points && g.points.length >= 4
        ? { id, type: 'highlighter', points: g.points, stroke: style.highlighterColor, strokeWidth: style.highlighterWidth, opacity: style.highlighterOpacity }
        : null;
    case 'text':
      return g.text && g.text.trim()
        ? { id, type: 'text', x, y, text: g.text, fontSize: style.fontSize, fill: style.textColor, align: style.textAlign, bold: style.bold }
        : null;
    case 'marker':
      return {
        id,
        type: 'marker',
        x,
        y,
        number: nextMarkerNumber(existing),
        radius: style.markerRadius,
        fill: style.markerFill,
        textColor: style.markerTextColor,
      };
    case 'blur':
      return { id, type: 'blur', x, y, width, height, strength: style.blurStrength };
    case 'pixelate':
      return { id, type: 'pixelate', x, y, width, height, strength: style.pixelSize };
    default:
      return null;
  }
}
