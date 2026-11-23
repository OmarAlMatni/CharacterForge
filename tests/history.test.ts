import { describe, expect, it } from 'vitest';
import { History } from '../src/core/history.ts';

describe('History', () => {
  it('undoes and redoes commits', () => {
    const h = new History({ n: 0 });
    h.commit({ n: 1 }, 'one');
    h.commit({ n: 2 }, 'two');
    expect(h.undoLabel).toBe('two');
    expect(h.undo()).toBe(true);
    expect(h.present.n).toBe(1);
    expect(h.redoLabel).toBe('two');
    expect(h.redo()).toBe(true);
    expect(h.present.n).toBe(2);
    expect(h.redo()).toBe(false);
  });
  it('a new commit clears redo', () => {
    const h = new History(0);
    h.commit(1, 'a');
    h.undo();
    h.commit(2, 'b');
    expect(h.canRedo).toBe(false);
  });
  it('turns a drag into one undo step', () => {
    const h = new History(0);
    h.beginTransient();
    for (let i = 1; i <= 20; i++) h.preview(i);
    h.endTransient('drag');
    expect(h.present).toBe(20);
    h.undo();
    expect(h.present).toBe(0);
    expect(h.canUndo).toBe(false);
  });
  it('a drag that changes nothing records nothing', () => {
    const s = { a: 1 };
    const h = new History(s);
    h.beginTransient();
    h.preview(s);
    h.endTransient('noop');
    expect(h.canUndo).toBe(false);
  });
  it('cancelTransient restores the baseline', () => {
    const h = new History(5);
    h.beginTransient();
    h.preview(9);
    h.cancelTransient();
    expect(h.present).toBe(5);
    expect(h.canUndo).toBe(false);
  });
  it('undo during a drag aborts it first', () => {
    const h = new History(1);
    h.commit(2, 'x');
    h.beginTransient();
    h.preview(3);
    h.undo();
    expect(h.present).toBe(1);
  });
  it('coalesces edits with the same key', () => {
    const h = new History('');
    h.commit('a', 'rename', 'name:1');
    h.commit('ab', 'rename', 'name:1');
    h.commit('abc', 'rename', 'name:1');
    h.undo();
    expect(h.present).toBe('');
    expect(h.canUndo).toBe(false);
  });
  it('ignores commits that do not change state and honours the limit', () => {
    const h = new History(0, 3);
    h.commit(0, 'same');
    expect(h.canUndo).toBe(false);
    for (let i = 1; i <= 10; i++) h.commit(i, `s${i}`);
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(3);
  });
});
