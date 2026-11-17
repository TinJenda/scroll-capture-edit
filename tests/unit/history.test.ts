import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, commit, createHistory, MAX_HISTORY, redo, undo } from '@/editor/history';

describe('undo / redo history', () => {
  it('undoes and redoes in order', () => {
    let h = createHistory(0);
    h = commit(h, 1);
    h = commit(h, 2);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(1);
    h = undo(h);
    expect(h.present).toBe(0);
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe(2);
    expect(canRedo(h)).toBe(false);
  });
  it('a new edit clears the redo stack', () => {
    let h = commit(commit(createHistory('a'), 'b'), 'c');
    h = undo(h);
    h = commit(h, 'x');
    expect(canRedo(h)).toBe(false);
    expect(undo(h).present).toBe('b');
  });
  it('ignores no-op commits', () => {
    const h = createHistory({ a: 1 });
    expect(commit(h, h.present)).toBe(h);
  });
  it('coalesces rapid edits with the same key into one undo step', () => {
    let h = createHistory(0);
    h = commit(h, 1, { coalesceKey: 'slider', now: 1000 });
    h = commit(h, 2, { coalesceKey: 'slider', now: 1200 });
    h = commit(h, 3, { coalesceKey: 'slider', now: 1400 });
    expect(h.past).toEqual([0]);
    expect(undo(h).present).toBe(0);
  });
  it('does not coalesce across different keys or after a pause', () => {
    let h = createHistory(0);
    h = commit(h, 1, { coalesceKey: 'a', now: 1000 });
    h = commit(h, 2, { coalesceKey: 'b', now: 1100 });
    h = commit(h, 3, { coalesceKey: 'b', now: 5000 });
    expect(h.past).toEqual([0, 1, 2]);
  });
  it('caps the history length', () => {
    let h = createHistory(0);
    for (let i = 1; i <= MAX_HISTORY + 50; i++) h = commit(h, i);
    expect(h.past.length).toBe(MAX_HISTORY);
  });
  it('undo/redo are no-ops at the ends', () => {
    const h = createHistory(1);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });
});
