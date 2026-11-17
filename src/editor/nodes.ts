/**
 * Single source of truth for how an annotation looks. The live editor AND the exporter both build
 * their Konva nodes through createNode()/updateNode(), so what you see is exactly what you copy.
 */
import Konva from 'konva';
import type { Size } from '@/shared/types';
import { regionWithin, renderEffect } from './effects';
import type { Annotation } from './model';

export interface NodeContext {
  base: CanvasImageSource;
  size: Size;
}

export const FONT_FAMILY = 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const ANNOTATION_NAME = 'ann';

export type AnnNode = Konva.Node;

export function createNode(a: Annotation, ctx: NodeContext): AnnNode {
  let node: AnnNode;
  switch (a.type) {
    case 'rect':
      node = new Konva.Rect();
      break;
    case 'ellipse':
      node = new Konva.Ellipse();
      break;
    case 'arrow':
      node = new Konva.Arrow();
      break;
    case 'line':
    case 'pen':
    case 'highlighter':
      node = new Konva.Line();
      break;
    case 'text':
      node = new Konva.Text();
      break;
    case 'marker': {
      const g = new Konva.Group();
      g.add(new Konva.Circle({ name: 'bg' }), new Konva.Text({ name: 'num', listening: false }));
      node = g;
      break;
    }
    case 'blur':
    case 'pixelate':
      node = new Konva.Image({ image: undefined });
      break;
  }
  node.name(ANNOTATION_NAME);
  node.id(a.id);
  updateNode(node, a, ctx);
  return node;
}

/** Bring an existing node in line with the annotation. Safe to call repeatedly. */
export function updateNode(node: AnnNode, a: Annotation, ctx: NodeContext): void {
  const reset = { scaleX: 1, scaleY: 1, rotation: 0 };
  switch (a.type) {
    case 'rect':
      node.setAttrs({
        ...reset,
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        stroke: a.stroke,
        strokeWidth: a.strokeWidth,
        // A fully transparent fill keeps the interior clickable without changing any pixel.
        fill: a.fill ?? 'rgba(0,0,0,0)',
        strokeScaleEnabled: false,
        hitStrokeWidth: Math.max(a.strokeWidth, 12),
      });
      break;

    case 'ellipse':
      node.setAttrs({
        ...reset,
        x: a.x + a.width / 2,
        y: a.y + a.height / 2,
        radiusX: a.width / 2,
        radiusY: a.height / 2,
        stroke: a.stroke,
        strokeWidth: a.strokeWidth,
        fill: a.fill ?? 'rgba(0,0,0,0)',
        strokeScaleEnabled: false,
        hitStrokeWidth: Math.max(a.strokeWidth, 12),
      });
      break;

    case 'arrow': {
      const head = Math.max(10, a.strokeWidth * 3.6);
      node.setAttrs({
        ...reset,
        x: 0,
        y: 0,
        points: a.points,
        stroke: a.stroke,
        fill: a.stroke,
        strokeWidth: a.strokeWidth,
        pointerLength: head,
        pointerWidth: head,
        lineCap: 'round',
        lineJoin: 'round',
        strokeScaleEnabled: false,
        hitStrokeWidth: Math.max(a.strokeWidth, 14),
      });
      break;
    }

    case 'line':
      node.setAttrs({
        ...reset,
        x: 0,
        y: 0,
        points: a.points,
        stroke: a.stroke,
        strokeWidth: a.strokeWidth,
        lineCap: 'round',
        lineJoin: 'round',
        strokeScaleEnabled: false,
        hitStrokeWidth: Math.max(a.strokeWidth, 14),
      });
      break;

    case 'pen':
    case 'highlighter':
      node.setAttrs({
        ...reset,
        x: 0,
        y: 0,
        points: a.points,
        stroke: a.stroke,
        strokeWidth: a.strokeWidth,
        opacity: a.opacity,
        tension: 0.4,
        lineCap: a.type === 'highlighter' ? 'butt' : 'round',
        lineJoin: 'round',
        strokeScaleEnabled: false,
        hitStrokeWidth: Math.max(a.strokeWidth, 14),
      });
      break;

    case 'text':
      node.setAttrs({
        ...reset,
        x: a.x,
        y: a.y,
        text: a.text,
        fontSize: a.fontSize,
        fontFamily: FONT_FAMILY,
        fontStyle: a.bold ? 'bold' : 'normal',
        fill: a.fill,
        align: a.align,
        lineHeight: 1.25,
        wrap: 'none',
      });
      break;

    case 'marker': {
      const g = node as Konva.Group;
      g.setAttrs({ ...reset, x: a.x, y: a.y });
      const digits = String(a.number).length;
      const fontSize = a.radius * (digits <= 1 ? 1.15 : digits === 2 ? 0.95 : 0.75);
      (g.findOne('.bg') as Konva.Circle).setAttrs({ radius: a.radius, fill: a.fill });
      (g.findOne('.num') as Konva.Text).setAttrs({
        text: String(a.number),
        fontSize,
        fontFamily: FONT_FAMILY,
        fontStyle: 'bold',
        fill: a.textColor,
        align: 'center',
        verticalAlign: 'middle',
        width: a.radius * 2,
        height: a.radius * 2,
        offsetX: a.radius,
        offsetY: a.radius,
      });
      break;
    }

    case 'blur':
    case 'pixelate': {
      const region = regionWithin(a, ctx.size);
      node.setAttrs({ ...reset, x: region.x, y: region.y, width: region.width, height: region.height });
      const key = `${a.type}|${region.x}|${region.y}|${region.width}|${region.height}|${a.strength}`;
      if (node.getAttr('fxKey') !== key) {
        (node as Konva.Image).image(renderEffect(ctx.base, ctx.size, a.type, region, a.strength));
        node.setAttr('fxKey', key);
      }
      break;
    }
  }
}
