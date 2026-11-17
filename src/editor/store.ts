import { create } from 'zustand';
import type { Rect, Size } from '@/shared/types';
import { canRedo, canUndo, commit, createHistory, redo, undo, type History } from './history';
import {
  clampCrop,
  cloneAnnotation,
  defaultStyle,
  EMPTY_DOC,
  nextMarkerNumber,
  removeAnnotation,
  renumberMarkers,
  type Annotation,
  type EditorDoc,
  type ToolId,
  type ToolStyle,
} from './model';
import {
  applyPropsToAnnotation,
  applyPropsToStyle,
  kindForTool,
  type PanelProps,
} from './props';

export interface EditorState {
  history: History<EditorDoc>;
  tool: ToolId;
  selectedId: string | null;
  /** True when the user picked the annotation themselves (vs. it being selected right after drawing). */
  selectionExplicit: boolean;
  style: ToolStyle;
  imageSize: Size;
  scale: number;
  autoRenumber: boolean;
  /** Internal annotation clipboard (Ctrl+C / Ctrl+V on a selected annotation). */
  clipboard: Annotation | null;
  cropDraft: Rect | null;
  zoom: number;
  fit: boolean;
  /** Bumped whenever the document changes; used to trigger autosave. */
  revision: number;

  init(args: { imageSize: Size; scale: number; doc?: EditorDoc | null; autoRenumber: boolean }): void;
  setTool(tool: ToolId): void;
  select(id: string | null, explicit?: boolean): void;
  setProps(p: PanelProps): void;
  setStyle(style: ToolStyle): void;
  addAnnotation(a: Annotation, opts?: { select?: boolean }): void;
  updateAnnotation(id: string, patch: Partial<Annotation>, coalesceKey?: string): void;
  deleteSelected(): void;
  duplicateSelected(): void;
  copySelected(): boolean;
  pasteAnnotation(): void;
  bringToFront(): void;
  sendToBack(): void;
  renumber(): void;
  undo(): void;
  redo(): void;
  setCropDraft(r: Rect | null): void;
  applyCrop(): void;
  clearCrop(): void;
  setView(zoom: number, fit: boolean): void;
  setAutoRenumber(v: boolean): void;
}

function reconcileSelection(doc: EditorDoc, selectedId: string | null): string | null {
  return selectedId && doc.annotations.some((a) => a.id === selectedId) ? selectedId : null;
}

export const useEditor = create<EditorState>()((set, get) => {
  /** Commit a new document to history and keep the selection valid. */
  const commitDoc = (doc: EditorDoc, coalesceKey?: string, extra: Partial<EditorState> = {}) => {
    const s = get();
    const history = commit(s.history, doc, { coalesceKey });
    if (history === s.history) return;
    set({
      history,
      selectedId: reconcileSelection(doc, extra.selectedId !== undefined ? extra.selectedId : s.selectedId),
      revision: s.revision + 1,
      ...extra,
    });
  };

  const doc = () => get().history.present;

  return {
    history: createHistory(EMPTY_DOC),
    tool: 'select',
    selectedId: null,
    selectionExplicit: false,
    style: defaultStyle(1),
    imageSize: { width: 1, height: 1 },
    scale: 1,
    autoRenumber: true,
    clipboard: null,
    cropDraft: null,
    zoom: 1,
    fit: true,
    revision: 0,

    init({ imageSize, scale, doc: initial, autoRenumber }) {
      set({
        history: createHistory(initial ?? EMPTY_DOC),
        imageSize,
        scale,
        style: defaultStyle(scale),
        autoRenumber,
        selectedId: null,
        tool: 'select',
        cropDraft: null,
        revision: 0,
      });
    },

    setTool(tool) {
      const s = get();
      if (s.tool === tool) return;
      set({
        tool,
        // Drawing tools start from a clean slate; leaving crop discards an unapplied draft.
        selectedId: tool === 'select' ? s.selectedId : null,
        cropDraft: tool === 'crop' ? (s.history.present.crop ?? { x: 0, y: 0, width: s.imageSize.width, height: s.imageSize.height }) : null,
      });
    },

    select(id, explicit = true) {
      set({ selectedId: id, selectionExplicit: id !== null && explicit });
    },

    setProps(p) {
      const s = get();
      const selected = s.selectedId ? doc().annotations.find((a) => a.id === s.selectedId) : undefined;
      if (selected) {
        const next = applyPropsToAnnotation(selected, p);
        commitDoc(
          { ...doc(), annotations: doc().annotations.map((a) => (a.id === selected.id ? next : a)) },
          `props:${selected.id}:${Object.keys(p).join(',')}`,
        );
        set({ style: applyPropsToStyle(selected.type, get().style, p) });
        return;
      }
      const kind = kindForTool(s.tool);
      if (kind) set({ style: applyPropsToStyle(kind, s.style, p) });
    },

    setStyle(style) {
      set({ style });
    },

    addAnnotation(a, opts = {}) {
      const d = doc();
      commitDoc({ ...d, annotations: [...d.annotations, a] }, undefined, {
        selectedId: opts.select === false ? get().selectedId : a.id,
        selectionExplicit: false,
      });
    },

    updateAnnotation(id, patch, coalesceKey) {
      const d = doc();
      let changed = false;
      const annotations = d.annotations.map((a) => {
        if (a.id !== id) return a;
        changed = true;
        return { ...a, ...patch } as Annotation;
      });
      if (changed) commitDoc({ ...d, annotations }, coalesceKey);
    },

    deleteSelected() {
      const s = get();
      if (!s.selectedId) return;
      const d = doc();
      commitDoc({ ...d, annotations: removeAnnotation(d.annotations, s.selectedId, s.autoRenumber) }, undefined, { selectedId: null });
    },

    duplicateSelected() {
      const s = get();
      const a = doc().annotations.find((x) => x.id === s.selectedId);
      if (!a) return;
      let copy = cloneAnnotation(a);
      if (copy.type === 'marker') copy = { ...copy, number: nextMarkerNumber(doc().annotations) };
      get().addAnnotation(copy);
      set({ selectionExplicit: true });
    },

    copySelected() {
      const a = doc().annotations.find((x) => x.id === get().selectedId);
      if (!a) return false;
      set({ clipboard: a });
      return true;
    },

    pasteAnnotation() {
      const a = get().clipboard;
      if (!a) return;
      const copy = cloneAnnotation(a, 20, 20);
      get().addAnnotation(copy.type === 'marker' ? { ...copy, number: nextMarkerNumber(doc().annotations) } : copy);
      set({ selectionExplicit: true, clipboard: copy });
    },

    bringToFront() {
      const s = get();
      const d = doc();
      const a = d.annotations.find((x) => x.id === s.selectedId);
      if (a) commitDoc({ ...d, annotations: [...d.annotations.filter((x) => x.id !== a.id), a] });
    },

    sendToBack() {
      const s = get();
      const d = doc();
      const a = d.annotations.find((x) => x.id === s.selectedId);
      if (a) commitDoc({ ...d, annotations: [a, ...d.annotations.filter((x) => x.id !== a.id)] });
    },

    renumber() {
      const d = doc();
      commitDoc({ ...d, annotations: renumberMarkers(d.annotations) });
    },

    undo() {
      const s = get();
      if (!canUndo(s.history)) return;
      const history = undo(s.history);
      set({ history, selectedId: reconcileSelection(history.present, s.selectedId), revision: s.revision + 1 });
    },

    redo() {
      const s = get();
      if (!canRedo(s.history)) return;
      const history = redo(s.history);
      set({ history, selectedId: reconcileSelection(history.present, s.selectedId), revision: s.revision + 1 });
    },

    setCropDraft(r) {
      set({ cropDraft: r });
    },

    applyCrop() {
      const s = get();
      if (!s.cropDraft) return;
      const rect = clampCrop(s.cropDraft, s.imageSize);
      const full = rect && rect.x === 0 && rect.y === 0 && rect.width === s.imageSize.width && rect.height === s.imageSize.height;
      commitDoc({ ...doc(), crop: full ? null : rect }, undefined, { tool: 'select', cropDraft: null });
    },

    clearCrop() {
      const d = doc();
      if (d.crop) commitDoc({ ...d, crop: null });
      set({ cropDraft: null, tool: 'select' });
    },

    setView(zoom, fit) {
      set({ zoom, fit });
    },

    setAutoRenumber(v) {
      set({ autoRenumber: v });
    },
  };
});

export const selectDoc = (s: EditorState) => s.history.present;
export const selectSelected = (s: EditorState): Annotation | undefined =>
  s.selectedId ? s.history.present.annotations.find((a) => a.id === s.selectedId) : undefined;
