import Konva from 'konva';
import { clamp, rectFromPoints } from '@/shared/geometry';
import type { Rect, Size } from '@/shared/types';
import type { Annotation, ToolId } from './model';
import { ANNOTATION_NAME, createNode, FONT_FAMILY, updateNode, type AnnNode, type NodeContext } from './nodes';
import { buildAnnotation, kindForTool } from './props';
import { useEditor } from './store';

const ACCENT = '#4f6df5';
const MIN_DRAW = 4;
const ZOOM_MIN = 0.05;
const ZOOM_MAX = 8;

const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName));

const luminance = (hex: string) => {
  const m = /^#([0-9a-f]{6})/i.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

interface Draft {
  tool: ToolId;
  start: { x: number; y: number };
  last: { x: number; y: number };
  points: number[];
  node: AnnNode | null;
}

interface InlineEditor {
  el: HTMLTextAreaElement | HTMLInputElement;
  commit(): void;
  cancel(): void;
  annotationId?: string;
}

/**
 * Imperative Konva controller. React owns the toolbars and state; this class owns the pixels:
 * it mirrors the Zustand document into Konva nodes, translates pointer input into new
 * annotations, and manages selection handles, crop UI, pan and zoom.
 */
export class EditorCanvas {
  readonly stage: Konva.Stage;
  private contentLayer = new Konva.Layer();
  private uiLayer = new Konva.Layer();
  private docGroup = new Konva.Group();
  private uiGroup = new Konva.Group();
  private baseNode: Konva.Image;
  private nodes = new Map<string, AnnNode>();
  private lastAnn = new Map<string, Annotation>();
  private transformer: Konva.Transformer;
  private handles: Konva.Circle[] = [];
  private handleFor: string | null = null;

  private cropRect: Konva.Rect;
  private cropMask: Konva.Rect[] = [];
  private cropTransformer: Konva.Transformer;

  private draft: Draft | null = null;
  private panning: { sx: number; sy: number; vx: number; vy: number } | null = null;
  private spaceDown = false;
  private shiftDown = false;
  private view = { zoom: 1, x: 0, y: 0 };
  private fitMode = true;
  private inline: InlineEditor | null = null;
  private lastCrop: Rect | null | undefined;
  private raf = 0;
  private observer: ResizeObserver;
  private ctx: NodeContext;
  private destroyed = false;

  constructor(
    private readonly container: HTMLDivElement,
    base: ImageBitmap,
    private readonly size: Size,
  ) {
    this.ctx = { base, size };
    this.stage = new Konva.Stage({
      container,
      width: Math.max(10, container.clientWidth),
      height: Math.max(10, container.clientHeight),
    });
    this.baseNode = new Konva.Image({ image: base, x: 0, y: 0, width: size.width, height: size.height, listening: false });
    this.docGroup.add(this.baseNode);
    this.contentLayer.add(this.docGroup);

    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      flipEnabled: false,
      ignoreStroke: true,
      keepRatio: false,
      anchorSize: 9,
      anchorCornerRadius: 2,
      anchorStroke: ACCENT,
      anchorFill: '#ffffff',
      borderStroke: ACCENT,
      borderStrokeWidth: 1.5,
      padding: 2,
      boundBoxFunc: (oldBox, newBox) => (newBox.width < 6 || newBox.height < 6 ? oldBox : newBox),
    });

    // Crop overlay: four dim rectangles around a draggable/resizable crop rectangle.
    for (let i = 0; i < 4; i++) {
      const r = new Konva.Rect({ fill: 'rgba(8,10,16,0.62)', listening: false, visible: false });
      this.cropMask.push(r);
      this.uiGroup.add(r);
    }
    this.cropRect = new Konva.Rect({
      stroke: '#ffffff',
      strokeWidth: 1.5,
      dash: [6, 4],
      strokeScaleEnabled: false,
      fill: 'rgba(0,0,0,0)',
      draggable: true,
      visible: false,
    });
    this.uiGroup.add(this.cropRect);
    this.cropTransformer = new Konva.Transformer({
      rotateEnabled: false,
      flipEnabled: false,
      keepRatio: false,
      ignoreStroke: true,
      anchorSize: 10,
      anchorStroke: ACCENT,
      anchorFill: '#ffffff',
      borderStroke: ACCENT,
      boundBoxFunc: (oldBox, newBox) => (newBox.width < 8 || newBox.height < 8 ? oldBox : newBox),
    });
    this.cropTransformer.nodes([]);

    this.uiLayer.add(this.uiGroup, this.transformer, this.cropTransformer);
    this.stage.add(this.contentLayer, this.uiLayer);

    for (let i = 0; i < 2; i++) {
      const h = new Konva.Circle({ radius: 6, fill: '#ffffff', stroke: ACCENT, strokeWidth: 2, draggable: true, visible: false });
      h.on('dragmove', () => this.onHandleDrag(i));
      h.on('dragend', () => this.onHandleDragEnd());
      this.handles.push(h);
      this.uiGroup.add(h);
    }

    this.cropRect.on('dragmove transform', () => this.onCropChange());
    this.cropRect.on('transformend', () => this.onCropChange(true));

    this.stage.on('mousedown touchstart', (e) => this.onDown(e));
    this.stage.on('wheel', (e) => this.onWheel(e));
    this.stage.on('dblclick dbltap', (e) => this.onDouble(e));
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('touchmove', this.onMove, { passive: false });
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('touchend', this.onUp);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    this.observer = new ResizeObserver(() => this.onResize());
    this.observer.observe(container);

    this.fit();
    this.render();
  }

  /* ================================================================ */
  /* View: fit / zoom / pan                                            */
  /* ================================================================ */

  private applyView(): void {
    const { zoom, x, y } = this.view;
    for (const g of [this.docGroup, this.uiGroup]) {
      g.position({ x, y });
      g.scale({ x: zoom, y: zoom });
    }
    // Handles keep a constant on-screen size.
    for (const h of this.handles) h.setAttrs({ radius: 6.5 / zoom, strokeWidth: 2 / zoom });
    useEditor.getState().setView(zoom, this.fitMode);
    this.requestDraw();
  }

  private contentBounds(): Rect {
    const s = useEditor.getState();
    const crop = s.history.present.crop;
    return s.tool !== 'crop' && crop ? crop : { x: 0, y: 0, width: this.size.width, height: this.size.height };
  }

  fit(): void {
    const b = this.contentBounds();
    const pad = 28;
    const w = Math.max(10, this.stage.width());
    const h = Math.max(10, this.stage.height());
    const zoom = clamp(Math.min((w - pad * 2) / b.width, (h - pad * 2) / b.height, 1), ZOOM_MIN, ZOOM_MAX);
    this.fitMode = true;
    this.view = {
      zoom,
      x: (w - b.width * zoom) / 2 - b.x * zoom,
      y: (h - b.height * zoom) / 2 - b.y * zoom,
    };
    this.applyView();
  }

  setZoom(zoom: number, anchor?: { x: number; y: number }): void {
    const z = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    const a = anchor ?? { x: this.stage.width() / 2, y: this.stage.height() / 2 };
    const docX = (a.x - this.view.x) / this.view.zoom;
    const docY = (a.y - this.view.y) / this.view.zoom;
    this.fitMode = false;
    this.view = { zoom: z, x: a.x - docX * z, y: a.y - docY * z };
    this.applyView();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.view.zoom * factor);
  }

  private onResize(): void {
    if (this.destroyed) return;
    const w = Math.max(10, this.container.clientWidth);
    const h = Math.max(10, this.container.clientHeight);
    if (w === this.stage.width() && h === this.stage.height()) return;
    this.stage.size({ width: w, height: h });
    if (this.fitMode) this.fit();
    else this.applyView();
  }

  private onWheel(e: Konva.KonvaEventObject<WheelEvent>): void {
    e.evt.preventDefault();
    const p = this.stage.getPointerPosition();
    if (e.evt.ctrlKey || e.evt.metaKey) {
      // Pinch-zoom (ctrl+wheel from trackpads) and ctrl+wheel from a mouse.
      const factor = Math.exp(-e.evt.deltaY * 0.0022);
      this.setZoom(this.view.zoom * factor, p ?? undefined);
    } else {
      this.fitMode = false;
      this.view = {
        ...this.view,
        x: this.view.x - (e.evt.shiftKey ? e.evt.deltaY : e.evt.deltaX),
        y: this.view.y - (e.evt.shiftKey ? 0 : e.evt.deltaY),
      };
      this.applyView();
    }
  }

  /* ================================================================ */
  /* Coordinates                                                       */
  /* ================================================================ */

  private docPoint(): { x: number; y: number } {
    const p = this.stage.getPointerPosition() ?? { x: 0, y: 0 };
    return { x: (p.x - this.view.x) / this.view.zoom, y: (p.y - this.view.y) / this.view.zoom };
  }

  private clampToImage(p: { x: number; y: number }) {
    return { x: clamp(p.x, 0, this.size.width), y: clamp(p.y, 0, this.size.height) };
  }

  private annotationFromTarget(target: Konva.Node | Konva.Stage): Konva.Node | null {
    let n: Konva.Node | null = target;
    while (n && n !== (this.stage as Konva.Node)) {
      if (n.name() === ANNOTATION_NAME) return n;
      n = n.getParent();
    }
    return null;
  }

  private isTransformerPart(target: Konva.Node): boolean {
    const p = target.getParent();
    return p instanceof Konva.Transformer || target instanceof Konva.Transformer;
  }

  /* ================================================================ */
  /* Pointer input                                                     */
  /* ================================================================ */

  private onDown(e: Konva.KonvaEventObject<MouseEvent | TouchEvent>): void {
    if (this.inline) {
      this.inline.commit();
      return;
    }
    const evt = e.evt;
    const isMouse = evt instanceof MouseEvent;
    if (isMouse && (evt.button === 1 || (evt.button === 0 && this.spaceDown))) {
      const p = this.stage.getPointerPosition();
      if (p) this.panning = { sx: p.x, sy: p.y, vx: this.view.x, vy: this.view.y };
      this.updateCursor();
      return;
    }
    if (isMouse && evt.button !== 0) return;
    if (this.isTransformerPart(e.target)) return;

    const store = useEditor.getState();
    const tool = store.tool;

    if (tool === 'select') {
      const hit = this.annotationFromTarget(e.target);
      store.select(hit ? hit.id() : null, true);
      return;
    }

    if (tool === 'crop') {
      // Dragging inside an existing partial crop moves it; with the full image selected there is
      // nothing to move, so the drag draws a new crop region instead.
      if (e.target === this.cropRect && this.cropRect.draggable()) return;
      const p = this.clampToImage(this.docPoint());
      this.draft = { tool, start: p, last: p, points: [], node: null };
      store.setCropDraft({ x: p.x, y: p.y, width: 0, height: 0 });
      return;
    }

    const kind = kindForTool(tool);
    if (!kind) return;
    const p = this.clampToImage(this.docPoint());
    store.select(null);
    this.draft = { tool, start: p, last: p, points: [p.x, p.y], node: null };
    this.updateDraftNode();
  }

  private onMove = (e: MouseEvent | TouchEvent): void => {
    if (this.destroyed) return;
    this.stage.setPointersPositions(e);
    if (this.panning) {
      const p = this.stage.getPointerPosition();
      if (p) {
        this.fitMode = false;
        this.view = { ...this.view, x: this.panning.vx + (p.x - this.panning.sx), y: this.panning.vy + (p.y - this.panning.sy) };
        this.applyView();
      }
      return;
    }
    const d = this.draft;
    if (!d) return;
    if (e.cancelable && e instanceof TouchEvent) e.preventDefault();
    const shift = 'shiftKey' in e && e.shiftKey;
    let p = this.clampToImage(this.docPoint());
    if (shift && (d.tool === 'arrow' || d.tool === 'line')) p = snapAngle(d.start, p);
    d.last = p;
    if (d.tool === 'pen' || d.tool === 'highlighter') {
      const n = d.points.length;
      if (Math.hypot(p.x - d.points[n - 2], p.y - d.points[n - 1]) >= 1.5 / Math.max(this.view.zoom, 0.5)) d.points.push(p.x, p.y);
    }
    if (d.tool === 'crop') {
      useEditor.getState().setCropDraft(this.rectFromDraft(d, shift));
      return;
    }
    this.updateDraftNode(shift);
  };

  private onUp = (): void => {
    if (this.destroyed) return;
    if (this.panning) {
      this.panning = null;
      this.updateCursor();
      return;
    }
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    this.destroyDraftNode(d);
    const store = useEditor.getState();

    if (d.tool === 'crop') {
      const r = store.cropDraft;
      if (!r || r.width < MIN_DRAW || r.height < MIN_DRAW) store.setCropDraft(store.history.present.crop ?? { x: 0, y: 0, ...this.size });
      return;
    }

    const moved = Math.hypot(d.last.x - d.start.x, d.last.y - d.start.y);
    switch (d.tool) {
      case 'rect':
      case 'ellipse':
      case 'blur':
      case 'pixelate': {
        const r = this.rectFromDraft(d, false);
        if (r.width < MIN_DRAW || r.height < MIN_DRAW) return;
        this.create(d.tool, r);
        break;
      }
      case 'arrow':
      case 'line':
        if (moved < MIN_DRAW) return;
        this.create(d.tool, { points: [d.start.x, d.start.y, d.last.x, d.last.y] });
        break;
      case 'pen':
      case 'highlighter': {
        const pts = d.points.length >= 4 ? d.points : [d.start.x, d.start.y, d.start.x + 0.01, d.start.y];
        this.create(d.tool, { points: pts });
        break;
      }
      case 'marker':
        this.create('marker', { x: d.start.x, y: d.start.y });
        break;
      case 'text':
        this.startTextEdit({ at: d.start });
        break;
      default:
        break;
    }
  };

  private create(tool: ToolId, geo: Parameters<typeof buildAnnotation>[1]): void {
    const store = useEditor.getState();
    const a = buildAnnotation(tool, geo, store.style, store.history.present.annotations);
    if (a) store.addAnnotation(a);
  }

  private rectFromDraft(d: Draft, constrain: boolean): Rect {
    let { x, y } = d.last;
    if (constrain) {
      const dx = x - d.start.x;
      const dy = y - d.start.y;
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      x = d.start.x + Math.sign(dx || 1) * s;
      y = d.start.y + Math.sign(dy || 1) * s;
    }
    return rectFromPoints(d.start.x, d.start.y, clamp(x, 0, this.size.width), clamp(y, 0, this.size.height));
  }

  /* ---- draft preview ---- */

  private updateDraftNode(constrain = false): void {
    const d = this.draft;
    if (!d) return;
    const store = useEditor.getState();
    const geo =
      d.tool === 'rect' || d.tool === 'ellipse' || d.tool === 'blur' || d.tool === 'pixelate'
        ? this.rectFromDraft(d, constrain)
        : d.tool === 'arrow' || d.tool === 'line'
          ? { points: [d.start.x, d.start.y, d.last.x, d.last.y] }
          : d.tool === 'pen' || d.tool === 'highlighter'
            ? { points: d.points.length >= 4 ? d.points : [d.start.x, d.start.y, d.start.x + 0.01, d.start.y] }
            : null;
    if (!geo) return; // text / marker have no live preview

    if (d.tool === 'blur' || d.tool === 'pixelate') {
      const r = geo as Rect;
      if (!d.node) {
        d.node = new Konva.Rect({ stroke: ACCENT, strokeWidth: 1.5, dash: [6, 4], strokeScaleEnabled: false, fill: 'rgba(79,109,245,0.18)', listening: false });
        this.docGroup.add(d.node as Konva.Shape);
      }
      d.node.setAttrs({ x: r.x, y: r.y, width: r.width, height: r.height });
    } else {
      const a = buildAnnotation(d.tool, geo, store.style, []);
      if (!a) return;
      if (!d.node) {
        d.node = createNode(a, this.ctx);
        d.node.listening(false);
        this.docGroup.add(d.node as Konva.Shape);
      } else {
        updateNode(d.node, a, this.ctx);
      }
    }
    this.requestDraw();
  }

  private destroyDraftNode(d: Draft): void {
    d.node?.destroy();
    d.node = null;
    this.requestDraw();
  }

  /** Abort whatever is in progress. Returns true if something was cancelled. */
  cancelOperation(): boolean {
    if (this.inline) {
      this.inline.cancel();
      return true;
    }
    if (this.draft) {
      this.destroyDraftNode(this.draft);
      this.draft = null;
      if (useEditor.getState().tool === 'crop') {
        const s = useEditor.getState();
        s.setCropDraft(s.history.present.crop ?? { x: 0, y: 0, ...this.size });
      }
      return true;
    }
    return false;
  }

  /* ================================================================ */
  /* Keyboard (pan with space)                                         */
  /* ================================================================ */

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') this.shiftDown = true;
    if (e.code === 'Space' && !isEditable(e.target)) {
      e.preventDefault();
      if (!this.spaceDown) {
        this.spaceDown = true;
        this.updateCursor();
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Shift') this.shiftDown = false;
    if (e.code === 'Space') {
      this.spaceDown = false;
      this.updateCursor();
    }
  };

  private updateCursor(): void {
    const tool = useEditor.getState().tool;
    let c = 'default';
    if (this.panning) c = 'grabbing';
    else if (this.spaceDown) c = 'grab';
    else if (tool === 'text') c = 'text';
    else if (tool !== 'select') c = 'crosshair';
    this.stage.container().style.cursor = c;
  }

  /* ================================================================ */
  /* Node events: dragging / transforming / double click               */
  /* ================================================================ */

  private attachNodeEvents(node: AnnNode): void {
    node.on('dragend transformend', () => this.commitNode(node));
  }

  private commitNode(node: AnnNode): void {
    const store = useEditor.getState();
    const a = store.history.present.annotations.find((x) => x.id === node.id());
    if (!a) return;
    const sx = Math.abs(node.scaleX());
    const sy = Math.abs(node.scaleY());
    let patch: Partial<Annotation> | null = null;

    switch (a.type) {
      case 'rect':
      case 'blur':
      case 'pixelate':
        patch = { x: node.x(), y: node.y(), width: Math.max(1, node.width() * sx), height: Math.max(1, node.height() * sy) };
        break;
      case 'ellipse': {
        const e = node as Konva.Ellipse;
        const rx = e.radiusX() * sx;
        const ry = e.radiusY() * sy;
        patch = { x: node.x() - rx, y: node.y() - ry, width: rx * 2, height: ry * 2 };
        break;
      }
      case 'line':
      case 'arrow':
      case 'pen':
      case 'highlighter': {
        const pts = (node as Konva.Line).points();
        const ox = node.x();
        const oy = node.y();
        patch = { points: pts.map((v, i) => (i % 2 === 0 ? ox + v * node.scaleX() : oy + v * node.scaleY())) };
        break;
      }
      case 'text':
        patch = { x: node.x(), y: node.y(), fontSize: Math.max(6, Math.round(a.fontSize * sx)) };
        break;
      case 'marker':
        patch = { x: node.x(), y: node.y(), radius: Math.max(6, Math.round(a.radius * sx)) };
        break;
    }
    if (patch) store.updateAnnotation(a.id, patch);
    const latest = useEditor.getState().history.present.annotations.find((x) => x.id === a.id);
    if (latest) {
      updateNode(node, latest, this.ctx); // bakes the transform into geometry and resets scale
      this.lastAnn.set(latest.id, latest);
    }
    this.requestDraw();
  }

  private onDouble(e: Konva.KonvaEventObject<MouseEvent>): void {
    const store = useEditor.getState();
    if (store.tool !== 'select') return;
    const hit = this.annotationFromTarget(e.target);
    if (!hit) return;
    const a = store.history.present.annotations.find((x) => x.id === hit.id());
    if (a?.type === 'text') this.startTextEdit({ id: a.id });
    else if (a?.type === 'marker') this.startNumberEdit(a.id);
  }

  /* ================================================================ */
  /* Line endpoint handles                                             */
  /* ================================================================ */

  private onHandleDrag(index: number): void {
    const id = this.handleFor;
    if (!id) return;
    const node = this.nodes.get(id) as Konva.Line | undefined;
    const a = useEditor.getState().history.present.annotations.find((x) => x.id === id);
    if (!node || !a || (a.type !== 'line' && a.type !== 'arrow')) return;
    const pts = [...a.points];
    const h = this.handles[index];
    let pos = this.clampToImage({ x: h.x(), y: h.y() });
    const other = { x: pts[index === 0 ? 2 : 0], y: pts[index === 0 ? 3 : 1] };
    if (this.shiftDown) pos = snapAngle(other, pos);
    h.position(pos);
    pts[index * 2] = pos.x;
    pts[index * 2 + 1] = pos.y;
    node.points(pts);
    this.requestDraw();
  }

  private onHandleDragEnd(): void {
    const id = this.handleFor;
    if (!id) return;
    const node = this.nodes.get(id) as Konva.Line | undefined;
    if (node) useEditor.getState().updateAnnotation(id, { points: node.points().slice(0, 4) });
  }

  /* ================================================================ */
  /* Crop UI                                                           */
  /* ================================================================ */

  private onCropChange(final = false): void {
    const sx = this.cropRect.scaleX();
    const sy = this.cropRect.scaleY();
    let r: Rect = {
      x: this.cropRect.x(),
      y: this.cropRect.y(),
      width: this.cropRect.width() * sx,
      height: this.cropRect.height() * sy,
    };
    const x1 = clamp(r.x, 0, this.size.width);
    const y1 = clamp(r.y, 0, this.size.height);
    const x2 = clamp(r.x + r.width, 0, this.size.width);
    const y2 = clamp(r.y + r.height, 0, this.size.height);
    r = { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
    if (final) {
      this.cropRect.setAttrs({ ...r, scaleX: 1, scaleY: 1 });
    }
    useEditor.getState().setCropDraft(r);
    this.layoutCropMask(r);
    this.requestDraw();
  }

  private layoutCropMask(r: Rect): void {
    const W = this.size.width;
    const H = this.size.height;
    const [top, bottom, left, right] = this.cropMask;
    top.setAttrs({ x: 0, y: 0, width: W, height: r.y });
    bottom.setAttrs({ x: 0, y: r.y + r.height, width: W, height: Math.max(0, H - r.y - r.height) });
    left.setAttrs({ x: 0, y: r.y, width: r.x, height: r.height });
    right.setAttrs({ x: r.x + r.width, y: r.y, width: Math.max(0, W - r.x - r.width), height: r.height });
  }

  private syncCropUi(): void {
    const s = useEditor.getState();
    const on = s.tool === 'crop' && !!s.cropDraft;
    for (const m of this.cropMask) m.visible(on);
    this.cropRect.visible(on);
    if (!on || !s.cropDraft) {
      this.cropTransformer.nodes([]);
      return;
    }
    const r = s.cropDraft;
    const drawing = !!this.draft;
    // While Konva itself is dragging/resizing the rectangle it is the source of truth.
    if (!this.cropRect.isDragging() && !this.cropTransformer.isTransforming()) {
      this.cropRect.setAttrs({ x: r.x, y: r.y, width: r.width, height: r.height, scaleX: 1, scaleY: 1 });
    }
    const isFull = r.x <= 0 && r.y <= 0 && r.width >= this.size.width && r.height >= this.size.height;
    this.cropRect.draggable(!isFull);
    this.layoutCropMask(r);
    this.cropTransformer.nodes(drawing || r.width < 1 ? [] : [this.cropRect]);
  }

  /* ================================================================ */
  /* Inline editors (text / marker number)                             */
  /* ================================================================ */

  startTextEdit(opts: { id?: string; at?: { x: number; y: number } }): void {
    this.inline?.commit();
    const store = useEditor.getState();
    const existing = opts.id ? store.history.present.annotations.find((a) => a.id === opts.id) : undefined;
    const base = existing?.type === 'text' ? existing : null;
    const style = store.style;
    const fontSize = base?.fontSize ?? style.fontSize;
    const color = base?.fill ?? style.textColor;
    const pos = base ? { x: base.x, y: base.y } : (opts.at ?? { x: 0, y: 0 });

    const ta = document.createElement('textarea');
    ta.value = base?.text ?? '';
    ta.rows = Math.max(1, ta.value.split('\n').length);
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Annotation text');
    Object.assign(ta.style, {
      position: 'absolute',
      left: `${this.view.x + pos.x * this.view.zoom}px`,
      top: `${this.view.y + pos.y * this.view.zoom}px`,
      minWidth: '120px',
      margin: '0',
      padding: '0',
      border: `1.5px dashed ${ACCENT}`,
      borderRadius: '2px',
      outline: 'none',
      resize: 'none',
      overflow: 'hidden',
      background: luminance(color) > 0.65 ? 'rgba(20,22,30,0.78)' : 'rgba(255,255,255,0.9)',
      color,
      fontFamily: FONT_FAMILY,
      fontWeight: (base?.bold ?? style.bold) ? '700' : '400',
      fontSize: `${fontSize * this.view.zoom}px`,
      lineHeight: '1.25',
      textAlign: base?.align ?? style.textAlign,
      whiteSpace: 'pre',
      zIndex: '5',
    } as Partial<CSSStyleDeclaration>);
    const autosize = () => {
      ta.style.width = '0px';
      ta.style.height = '0px';
      ta.style.width = `${Math.max(120, ta.scrollWidth + 6)}px`;
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener('input', autosize);

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.inline = null;
      const text = ta.value;
      ta.remove();
      const st = useEditor.getState();
      if (base) {
        const node = this.nodes.get(base.id);
        node?.visible(true);
        if (save) {
          if (text.trim() === '') {
            st.select(base.id, true);
            st.deleteSelected();
          } else if (text !== base.text) {
            st.updateAnnotation(base.id, { text });
          }
        }
      } else if (save && text.trim()) {
        const a = buildAnnotation('text', { x: pos.x, y: pos.y, text }, st.style, st.history.present.annotations);
        if (a) st.addAnnotation(a);
      }
      this.requestDraw();
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation(); // never let editor shortcuts fire while typing
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(true);
      }
    });
    ta.addEventListener('blur', () => finish(true));

    this.container.appendChild(ta);
    if (base) this.nodes.get(base.id)?.visible(false);
    this.requestDraw();
    this.inline = { el: ta, commit: () => finish(true), cancel: () => finish(false), annotationId: base?.id };
    autosize();
    // Defer focus so the mouseup that created the box does not immediately blur it.
    setTimeout(() => {
      ta.focus();
      ta.select();
    }, 0);
  }

  startNumberEdit(id: string): void {
    this.inline?.commit();
    const store = useEditor.getState();
    const a = store.history.present.annotations.find((x) => x.id === id);
    if (!a || a.type !== 'marker') return;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '9999';
    input.value = String(a.number);
    input.setAttribute('aria-label', 'Marker number');
    const size = Math.max(48, a.radius * 2 * this.view.zoom);
    Object.assign(input.style, {
      position: 'absolute',
      left: `${this.view.x + a.x * this.view.zoom - size / 2}px`,
      top: `${this.view.y + a.y * this.view.zoom - 16}px`,
      width: `${size}px`,
      height: '32px',
      textAlign: 'center',
      font: '700 16px system-ui, sans-serif',
      border: `2px solid ${ACCENT}`,
      borderRadius: '8px',
      outline: 'none',
      zIndex: '5',
    } as Partial<CSSStyleDeclaration>);
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this.inline = null;
      const n = Number.parseInt(input.value, 10);
      input.remove();
      if (save && Number.isFinite(n) && n >= 0 && n !== a.number) useEditor.getState().updateAnnotation(id, { number: Math.min(9999, n) } as Partial<Annotation>);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter') finish(true);
    });
    input.addEventListener('blur', () => finish(true));
    this.container.appendChild(input);
    this.inline = { el: input, commit: () => finish(true), cancel: () => finish(false), annotationId: id };
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  get isEditingInline(): boolean {
    return this.inline !== null;
  }

  /* ================================================================ */
  /* Rendering                                                         */
  /* ================================================================ */

  requestDraw(): void {
    if (this.raf || this.destroyed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.contentLayer.batchDraw();
      this.uiLayer.batchDraw();
    });
  }

  /** Mirror the store into Konva. Cheap when nothing changed. */
  render(): void {
    if (this.destroyed) return;
    const s = useEditor.getState();
    const doc = s.history.present;

    const seen = new Set<string>();
    doc.annotations.forEach((a, i) => {
      seen.add(a.id);
      let node = this.nodes.get(a.id);
      if (!node) {
        node = createNode(a, this.ctx);
        this.attachNodeEvents(node);
        this.nodes.set(a.id, node);
        this.docGroup.add(node as Konva.Shape);
      } else if (this.lastAnn.get(a.id) !== a) {
        updateNode(node, a, this.ctx);
      }
      this.lastAnn.set(a.id, a);
      if (node.zIndex() !== i + 1) node.zIndex(i + 1);
      node.draggable(s.tool === 'select');
      if (this.inline?.annotationId !== a.id) node.visible(true);
    });
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) {
        node.destroy();
        this.nodes.delete(id);
        this.lastAnn.delete(id);
      }
    }

    // Crop: clip the document when a crop is applied (and we are not editing it).
    const clip = s.tool !== 'crop' ? doc.crop : null;
    this.docGroup.setAttrs(
      clip
        ? { clipX: clip.x, clipY: clip.y, clipWidth: clip.width, clipHeight: clip.height }
        : { clipX: undefined, clipY: undefined, clipWidth: undefined, clipHeight: undefined },
    );
    if (this.lastCrop !== undefined && this.lastCrop !== doc.crop && this.fitMode) this.fit();
    if (this.lastCrop === undefined || this.lastCrop !== doc.crop) this.lastCrop = doc.crop;

    this.syncSelection();
    this.syncCropUi();
    this.updateCursor();
    this.requestDraw();
  }

  /** Re-fit after a tool switch that changes what is shown (entering/leaving crop). */
  onToolChanged(): void {
    if (this.fitMode) this.fit();
  }

  private syncSelection(): void {
    const s = useEditor.getState();
    const a = s.selectedId ? s.history.present.annotations.find((x) => x.id === s.selectedId) : undefined;
    const node = a ? this.nodes.get(a.id) : undefined;

    if (!a || !node || s.tool === 'crop' || this.inline?.annotationId === a.id) {
      this.transformer.nodes([]);
      this.setHandlesVisible(false);
      return;
    }

    if (a.type === 'line' || a.type === 'arrow') {
      this.transformer.nodes([]);
      this.handleFor = a.id;
      this.handles.forEach((h, i) => {
        if (!h.isDragging()) h.position({ x: a.points[i * 2], y: a.points[i * 2 + 1] });
        h.visible(true);
      });
      return;
    }

    this.setHandlesVisible(false);
    const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const all = [...corners, 'top-center', 'middle-left', 'middle-right', 'bottom-center'];
    const ratio = a.type === 'marker' || a.type === 'text';
    this.transformer.setAttrs({ keepRatio: ratio, enabledAnchors: ratio || a.type === 'pen' || a.type === 'highlighter' ? corners : all });
    this.transformer.nodes([node]);
  }

  private setHandlesVisible(v: boolean): void {
    for (const h of this.handles) h.visible(v);
    if (!v) this.handleFor = null;
  }

  /* ================================================================ */

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.inline?.el.remove();
    this.observer.disconnect();
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('touchmove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('touchend', this.onUp);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.stage.destroy();
  }
}

/** Snap the segment start→end to the nearest 45°. */
export function snapAngle(start: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return end;
  const step = Math.PI / 4;
  const ang = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: start.x + Math.cos(ang) * len, y: start.y + Math.sin(ang) * len };
}
