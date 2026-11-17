import { describe, expect, it } from 'vitest';
import {
  clampCrop,
  cloneAnnotation,
  defaultStyle,
  nextMarkerNumber,
  parseDoc,
  removeAnnotation,
  renumberMarkers,
  serializeDoc,
  type Annotation,
  type EditorDoc,
  type MarkerAnn,
} from '@/editor/model';
import { applyPropsToAnnotation, buildAnnotation, propsOfAnnotation } from '@/editor/props';

const marker = (id: string, n: number): MarkerAnn => ({
  id,
  type: 'marker',
  x: 10 * n,
  y: 10,
  number: n,
  radius: 14,
  fill: '#FF3B30',
  textColor: '#FFFFFF',
});
const nums = (a: Annotation[]) => a.filter((x): x is MarkerAnn => x.type === 'marker').map((m) => m.number);

describe('smart sequential numbering', () => {
  it('numbers 1, 2, 3 … in order of clicks', () => {
    const list: Annotation[] = [];
    for (let i = 0; i < 3; i++) {
      const m = buildAnnotation('marker', { x: i * 50, y: 10 }, defaultStyle(), list) as MarkerAnn;
      list.push(m);
    }
    expect(nums(list)).toEqual([1, 2, 3]);
  });
  it('reuses the smallest free number after a gap', () => {
    expect(nextMarkerNumber([marker('a', 1), marker('c', 3)])).toBe(2);
    expect(nextMarkerNumber([])).toBe(1);
  });
  it('deleting renumbers automatically when enabled', () => {
    const list = [marker('a', 1), marker('b', 2), marker('c', 3)];
    expect(nums(removeAnnotation(list, 'b', true))).toEqual([1, 2]);
  });
  it('deleting keeps numbers when auto-renumber is off', () => {
    const list = [marker('a', 1), marker('b', 2), marker('c', 3)];
    expect(nums(removeAnnotation(list, 'b', false))).toEqual([1, 3]);
  });
  it('renumber restores 1…n in creation order', () => {
    expect(nums(renumberMarkers([marker('a', 5), marker('b', 2), marker('c', 9)]))).toEqual([1, 2, 3]);
  });
  it('markers keep red background / white number by default and are editable', () => {
    const s = defaultStyle();
    expect(s.markerFill).toBe('#FF3B30');
    expect(s.markerTextColor).toBe('#FFFFFF');
    const m = applyPropsToAnnotation(marker('a', 1), { number: 7, radius: 22 }) as MarkerAnn;
    expect([m.number, m.radius]).toEqual([7, 22]);
    expect(propsOfAnnotation(m).number).toBe(7);
  });
});

describe('defaults', () => {
  it('uses the specified red, 3px lines and transparent rectangle fill', () => {
    const s = defaultStyle(1);
    expect(s.stroke).toBe('#FF3B30');
    expect(s.strokeWidth).toBe(3);
    expect(s.fill).toBeNull();
    expect(s.textColor).toBe('#FF3B30');
    const r = buildAnnotation('rect', { x: 0, y: 0, width: 10, height: 10 }, s, []);
    expect(r).toMatchObject({ type: 'rect', stroke: '#FF3B30', fill: null });
  });
  it('scales with HiDPI captures', () => {
    expect(defaultStyle(2).strokeWidth).toBe(6);
  });
});

describe('annotation serialization', () => {
  const doc: EditorDoc = {
    crop: { x: 10, y: 20, width: 300, height: 200 },
    annotations: [
      { id: 'r1', type: 'rect', x: 1, y: 2, width: 30, height: 40, stroke: '#FF3B30', strokeWidth: 3, fill: null },
      { id: 'a1', type: 'arrow', points: [0, 0, 50, 50], stroke: '#0A84FF', strokeWidth: 4 },
      { id: 't1', type: 'text', x: 5, y: 5, text: 'Expected', fontSize: 24, fill: '#FF3B30', align: 'left', bold: true },
      marker('m1', 1),
      { id: 'p1', type: 'pen', points: [0, 0, 1, 1, 2, 3], stroke: '#111111', strokeWidth: 2, opacity: 1 },
      { id: 'b1', type: 'blur', x: 0, y: 0, width: 50, height: 20, strength: 10 },
    ],
  };
  it('round-trips without loss', () => {
    expect(parseDoc(serializeDoc(doc))).toEqual(doc);
  });
  it('rejects garbage and wrong versions', () => {
    expect(parseDoc('not json')).toBeNull();
    expect(parseDoc(JSON.stringify({ v: 99, annotations: [] }))).toBeNull();
    expect(parseDoc(undefined)).toBeNull();
  });
  it('drops invalid annotations and sanitises values instead of trusting stored data', () => {
    const parsed = parseDoc(
      JSON.stringify({
        v: 1,
        crop: { x: 0, y: 0, width: -5, height: 10 },
        annotations: [
          { id: 'ok', type: 'rect', x: 1, y: 1, width: 10, height: 10, stroke: 'javascript:alert(1)', strokeWidth: 3, fill: null },
          { id: 'bad', type: 'script', x: 1 },
          { id: 'nan', type: 'arrow', points: [0, null, 1, 1], stroke: '#fff', strokeWidth: 1 },
          { id: 'ok', type: 'rect', x: 0, y: 0, width: 1, height: 1, stroke: '#fff', strokeWidth: 1, fill: null },
        ],
      }),
    );
    expect(parsed?.annotations).toHaveLength(1);
    expect(parsed?.annotations[0]).toMatchObject({ id: 'ok', stroke: '#FF3B30' });
    expect(parsed?.crop).toBeNull();
  });
  it('clones with a new id and offset', () => {
    const c = cloneAnnotation(doc.annotations[0], 10, 10);
    expect(c.id).not.toBe('r1');
    expect(c).toMatchObject({ x: 11, y: 12 });
  });
  it('clamps crops to the image', () => {
    expect(clampCrop({ x: -20, y: -5, width: 500, height: 500 }, { width: 400, height: 300 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(clampCrop({ x: 10, y: 10, width: 2, height: 2 }, { width: 400, height: 300 })).toBeNull();
  });
});
