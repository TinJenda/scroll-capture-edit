import Konva from 'konva';
import type { Size } from '@/shared/types';
import type { EditorDoc } from './model';
import { createNode } from './nodes';

/**
 * Flatten the screenshot + every annotation into one canvas at the screenshot's native resolution
 * (cropped if a crop is set). This is what Copy Image and Save use, so it contains ONLY image
 * pixels: no selection outlines, transformer handles, toolbars or checkerboard.
 */
export function renderComposite(base: CanvasImageSource, size: Size, doc: EditorDoc): HTMLCanvasElement {
  const region = doc.crop ?? { x: 0, y: 0, width: size.width, height: size.height };

  // Konva sizes its canvases by devicePixelRatio; the export must be exactly 1 canvas px = 1 image px.
  const previousRatio = Konva.pixelRatio;
  Konva.pixelRatio = 1;
  const container = document.createElement('div');
  let stage: Konva.Stage | null = null;
  try {
    stage = new Konva.Stage({ container, width: region.width, height: region.height });
    const layer = new Konva.Layer({ listening: false });
    stage.add(layer);
    const group = new Konva.Group({ x: -region.x, y: -region.y });
    layer.add(group);
    group.add(new Konva.Image({ image: base as CanvasImageSource & Konva.Image['attrs']['image'], x: 0, y: 0, width: size.width, height: size.height }));
    for (const a of doc.annotations) group.add(createNode(a, { base, size }) as Konva.Shape);
    layer.draw();
    return stage.toCanvas({ pixelRatio: 1 }) as HTMLCanvasElement;
  } finally {
    stage?.destroy();
    Konva.pixelRatio = previousRatio;
  }
}
