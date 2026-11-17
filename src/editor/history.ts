/**
 * Generic undo/redo over immutable snapshots.
 * `coalesceKey` merges rapid consecutive edits of the same kind (a colour slider drag,
 * typing in a field) into ONE undo step.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  lastKey?: string;
  lastAt?: number;
}

export const MAX_HISTORY = 200;
export const COALESCE_WINDOW_MS = 600;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function commit<T>(h: History<T>, next: T, opts: { coalesceKey?: string; now?: number } = {}): History<T> {
  if (Object.is(next, h.present)) return h;
  const now = opts.now ?? Date.now();
  const key = opts.coalesceKey;

  if (key && h.lastKey === key && h.lastAt !== undefined && now - h.lastAt < COALESCE_WINDOW_MS && h.past.length > 0) {
    return { ...h, present: next, future: [], lastAt: now };
  }
  const past = [...h.past, h.present];
  if (past.length > MAX_HISTORY) past.shift();
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export const canUndo = <T,>(h: History<T>) => h.past.length > 0;
export const canRedo = <T,>(h: History<T>) => h.future.length > 0;

export function undo<T>(h: History<T>): History<T> {
  if (!canUndo(h)) return h;
  const previous = h.past[h.past.length - 1];
  return { past: h.past.slice(0, -1), present: previous, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!canRedo(h)) return h;
  const [next, ...rest] = h.future;
  return { past: [...h.past, h.present], present: next, future: rest };
}
