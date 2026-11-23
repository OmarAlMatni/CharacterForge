import { describe, expect, it } from 'vitest';
import { renderComposition } from '../src/core/composite.ts';
import type { Ctx2DLike } from '../src/core/composite.ts';
import { groupLayers, updateLayer } from '../src/core/layers.ts';
import { computePlacements, placementMatrix } from '../src/core/rig.ts';
import { attachLayers } from '../src/core/doc.ts';
import { emptyDoc, joint, layer } from './helpers.ts';

type Call = { op: string; args: unknown[]; alpha?: number };

function recorder() {
  const calls: Call[] = [];
  const ctx: Ctx2DLike = {
    globalAlpha: 1,
    imageSmoothingEnabled: false,
    setTransform: (...args) => void calls.push({ op: 'setTransform', args }),
    clearRect: (...args) => void calls.push({ op: 'clearRect', args }),
    drawImage: (img, ...rest) => void calls.push({ op: 'drawImage', args: [img, ...rest], alpha: ctx.globalAlpha }),
  };
  return { ctx, calls };
}

const bitmaps = (l: { id: string }) => `bmp:${l.id}`;
const draws = (calls: Call[]) => calls.filter((c) => c.op === 'drawImage');

describe('renderComposition (export path)', () => {
  it('clears to transparent at the canvas size and draws layers bottom to top', () => {
    const { ctx, calls } = recorder();
    const doc = emptyDoc([layer('a'), layer('b')]);
    const r = renderComposition(ctx, doc, bitmaps);
    expect(r.drawn).toBe(2);
    expect(calls.find((c) => c.op === 'clearRect')!.args).toEqual([0, 0, 200, 200]);
    expect(draws(calls).map((c) => c.args[0])).toEqual(['bmp:a', 'bmp:b']);
  });
  it('draws only bitmaps: no fills, patterns or extra images (no checkerboard)', () => {
    const { ctx, calls } = recorder();
    renderComposition(ctx, emptyDoc([layer('a')]), bitmaps);
    expect(new Set(calls.map((c) => c.op))).toEqual(new Set(['setTransform', 'clearRect', 'drawImage']));
  });
  it('skips hidden layers, hidden groups and layers without bitmaps', () => {
    const { ctx, calls } = recorder();
    let ls = [layer('a'), layer('b'), layer('c'), layer('d')];
    ls = groupLayers(ls, ['c'], 'g', 'G');
    ls = updateLayer(ls, 'g', { visible: false });
    ls = updateLayer(ls, 'a', { visible: false });
    renderComposition(ctx, emptyDoc(ls), (l) => (l.id === 'd' ? null : bitmaps(l)));
    expect(draws(calls).map((c) => c.args[0])).toEqual(['bmp:b']);
  });
  it('applies effective opacity', () => {
    const { ctx, calls } = recorder();
    let ls = [layer('a')];
    ls = groupLayers(ls, ['a'], 'g', 'G');
    ls = updateLayer(updateLayer(ls, 'g', { opacity: 0.5 }), 'a', { opacity: 0.5 });
    renderComposition(ctx, emptyDoc(ls), bitmaps);
    expect(draws(calls)[0]!.alpha).toBeCloseTo(0.25, 9);
    expect(ctx.globalAlpha).toBe(1);
  });
  it('scales output size and transforms', () => {
    const { ctx, calls } = recorder();
    const l = { ...layer('a'), transform: { x: 60, y: 40, rotation: 0, scaleX: 1, scaleY: 1 } };
    renderComposition(ctx, emptyDoc([l]), bitmaps, { scale: 2 });
    expect(calls.find((c) => c.op === 'clearRect')!.args).toEqual([0, 0, 400, 400]);
    const t = calls.filter((c) => c.op === 'setTransform')[1]!.args as number[];
    // pivot (50,25) at (60,40) → origin at (10,15); doubled → (20,30), scale 2
    expect(t).toEqual([2, 0, 0, 2, 20, 30]);
  });
  it('uses the same placement maths as the editor for posed layers', () => {
    const joints = [joint('root', null, 100, 100)];
    let doc = emptyDoc([{ ...layer('a'), transform: { x: 100, y: 120, rotation: 0, scaleX: 1, scaleY: 1 } }], joints);
    doc = attachLayers(doc, ['a'], 'root');
    const pose = { rotations: { root: 90 }, rootOffset: { x: 5, y: 0 } };
    const { ctx, calls } = recorder();
    renderComposition(ctx, doc, bitmaps, { pose });
    const expected = placementMatrix(doc.layers[0]!, computePlacements(doc.layers, doc.joints, pose).get('a')!);
    const t = calls.filter((c) => c.op === 'setTransform')[1]!.args as number[];
    expect(t[0]).toBeCloseTo(expected.a, 9);
    expect(t[1]).toBeCloseTo(expected.b, 9);
    expect(t[4]).toBeCloseTo(expected.e, 9);
    expect(t[5]).toBeCloseTo(expected.f, 9);
    expect(Math.abs(t[0]!)).toBeLessThan(1e-9); // rotated 90°
  });
  it('defaults to the document pose', () => {
    let doc = emptyDoc([{ ...layer('a'), jointId: 'root' }], [joint('root', null, 100, 100)]);
    doc = { ...doc, pose: { rotations: {}, rootOffset: { x: 30, y: 0 } } };
    const { ctx, calls } = recorder();
    renderComposition(ctx, doc, bitmaps);
    const t = calls.filter((c) => c.op === 'setTransform')[1]!.args as number[];
    expect(t[4]).toBeCloseTo(30, 9);
  });
});
