import { describe, expect, it } from 'vitest';
import {
  deleteLayerTree,
  duplicateLayerTree,
  effectiveOpacity,
  groupLayers,
  isEffectivelyVisible,
  moveIntoGroup,
  moveLayer,
  renderOrder,
  setPivotKeepingPlacement,
  ungroupLayer,
  updateLayer,
} from '../src/core/layers.ts';
import { apply, fromTRS, translation, mul } from '../src/core/math.ts';
import { layer } from './helpers.ts';

const names = (ls: { name: string }[]) => ls.map((l) => l.name);

describe('layer ordering and visibility', () => {
  it('renders bottom to top, walking groups depth-first', () => {
    let ls = [layer('a'), layer('b'), layer('c')];
    ls = groupLayers(ls, ['a', 'b'], 'g1', 'Group');
    expect(names(renderOrder(ls))).toEqual(['a', 'b', 'c']);
  });
  it('moves layers up and down among siblings only', () => {
    const ls = [layer('a'), layer('b'), layer('c')];
    expect(names(moveLayer(ls, 'a', 'up'))).toEqual(['b', 'a', 'c']);
    expect(names(moveLayer(ls, 'c', 'down'))).toEqual(['a', 'c', 'b']);
    expect(names(moveLayer(ls, 'a', 'top'))).toEqual(['b', 'c', 'a']);
    expect(names(moveLayer(ls, 'c', 'bottom'))).toEqual(['c', 'a', 'b']);
    expect(moveLayer(ls, 'c', 'up')).toBe(ls);
    expect(moveLayer(ls, 'a', 'down')).toBe(ls);
  });
  it('reordering inside a group does not touch root siblings', () => {
    let ls = [layer('a'), layer('b'), layer('c')];
    ls = groupLayers(ls, ['a', 'b'], 'g', 'G');
    const moved = moveLayer(ls, 'a', 'up');
    expect(names(renderOrder(moved))).toEqual(['b', 'a', 'c']);
  });
  it('hiding a group hides its children; opacity multiplies', () => {
    let ls = [layer('a'), layer('b')];
    ls = groupLayers(ls, ['a'], 'g', 'G');
    ls = updateLayer(ls, 'g', { visible: false, opacity: 0.5 });
    ls = updateLayer(ls, 'a', { opacity: 0.5 });
    expect(isEffectivelyVisible(ls, 'a')).toBe(false);
    expect(isEffectivelyVisible(ls, 'b')).toBe(true);
    expect(effectiveOpacity(ls, 'a')).toBeCloseTo(0.25, 9);
  });
  it('groups only layers that share a parent', () => {
    let ls = [layer('a'), layer('b'), layer('c')];
    ls = groupLayers(ls, ['a', 'b'], 'g', 'G');
    expect(() => groupLayers(ls, ['a', 'c'], 'g2', 'G2')).toThrow('same parent');
  });
  it('ungroup puts children where the group was', () => {
    let ls = [layer('a'), layer('b'), layer('c')];
    ls = groupLayers(ls, ['b'], 'g', 'G');
    const out = ungroupLayer(ls, 'g');
    expect(out.find((l) => l.id === 'g')).toBeUndefined();
    expect(out.find((l) => l.id === 'b')!.parentId).toBeNull();
    expect(names(renderOrder(out))).toEqual(['a', 'b', 'c']);
  });
  it('moveIntoGroup rejects non-groups and cycles', () => {
    let ls = [layer('a'), layer('b')];
    ls = groupLayers(ls, ['a'], 'g1', 'G1');
    ls = groupLayers(ls, ['g1'], 'g2', 'G2');
    expect(() => moveIntoGroup(ls, 'g2', 'g1')).toThrow('itself');
    expect(() => moveIntoGroup(ls, 'b', 'a')).toThrow('not a group');
    expect(moveIntoGroup(ls, 'b', 'g2').find((l) => l.id === 'b')!.parentId).toBe('g2');
    expect(moveIntoGroup(ls, 'a', null).find((l) => l.id === 'a')!.parentId).toBeNull();
  });
  it('deleting a group deletes its subtree', () => {
    let ls = [layer('a'), layer('b')];
    ls = groupLayers(ls, ['a'], 'g', 'G');
    const { layers, removed } = deleteLayerTree(ls, 'g');
    expect(layers.map((l) => l.id)).toEqual(['b']);
    expect(removed.map((l) => l.id).sort()).toEqual(['a', 'g']);
  });
  it('duplicates a group with remapped parents and fresh ids', () => {
    let ls = [layer('a'), layer('b')];
    ls = groupLayers(ls, ['a'], 'g', 'G');
    let n = 0;
    const r = duplicateLayerTree(ls, 'g', () => `new${++n}`)!;
    const copy = r.layers.find((l) => l.id === r.newRootId)!;
    expect(copy.name).toBe('G copy');
    const childCopy = r.layers.find((l) => l.parentId === r.newRootId)!;
    expect(childCopy.id).not.toBe('a');
    expect(r.layers).toHaveLength(ls.length + 2);
  });
  it('changing the pivot keeps the layer visually in place', () => {
    const l = { ...layer('a'), transform: { x: 80, y: 60, rotation: 30, scaleX: 2, scaleY: 1.5 } };
    const before = mul(fromTRS(l.transform), translation(-l.pivot.x, -l.pivot.y));
    const l2 = setPivotKeepingPlacement(l, { x: 10, y: 5 });
    const after = mul(fromTRS(l2.transform), translation(-l2.pivot.x, -l2.pivot.y));
    for (const p of [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 33, y: 7 }]) {
      const a = apply(before, p);
      const b = apply(after, p);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
  });
});
