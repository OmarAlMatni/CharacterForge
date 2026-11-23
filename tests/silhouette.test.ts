import { describe, expect, it } from 'vitest';
import { loadTestModel } from './model.ts';
import {
  BODY_PRESETS, DEFAULT_SHAPE, FIT_PARAMS, applyPreset, bodySilhouette, boundsXY, buildCharacterMesh, buildRestSkeleton, cropMask, downscaleMask, fitBodyToArtwork, iou, maskArea, maskBounds,
  maskFromImage, newMask, posedPositions, presetById, rasterizeTriangles, restoreStandingHeight, scoreCandidate, alignFit, averageFigureColor,
} from '../src/pose/index.ts';

loadTestModel();

function image(w: number, h: number, fill: [number, number, number, number]): { w: number; h: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(fill, i * 4);
  return { w, h, data };
}
function rect(img: { w: number; data: Uint8ClampedArray }, x0: number, y0: number, x1: number, y1: number, c: [number, number, number, number]): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.data.set(c, (y * img.w + x) * 4);
}

describe('masks', () => {
  it('uses transparency when the image has it', () => {
    const img = image(40, 60, [0, 0, 0, 0]);
    rect(img, 10, 5, 29, 54, [200, 50, 50, 255]);
    const m = maskFromImage(img);
    expect(maskBounds(m)).toEqual({ x0: 10, y0: 5, x1: 29, y1: 54 });
    expect(maskArea(m)).toBe(20 * 50);
  });

  it('separates a figure from an opaque white background but keeps enclosed white areas', () => {
    const img = image(60, 80, [255, 255, 255, 255]);
    rect(img, 15, 10, 44, 69, [20, 20, 20, 255]); // outline block
    rect(img, 18, 13, 41, 66, [255, 255, 255, 255]); // white inside the outline (a white shirt)
    const m = maskFromImage(img);
    expect(m.data[40 * 60 + 30]).toBe(1); // enclosed white = inside
    expect(m.data[2 * 60 + 2]).toBe(0); // background
    expect(maskBounds(m)).toEqual({ x0: 15, y0: 10, x1: 44, y1: 69 });
  });

  it('computes IoU, crops and downscales', () => {
    const a = newMask(10, 10), b = newMask(10, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) a.data[y * 10 + x] = 1;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) b.data[y * 10 + x] = 1;
    expect(iou(a, a)).toBe(1);
    expect(iou(a, b)).toBeCloseTo(0.5, 6);
    expect(iou(newMask(4, 4), newMask(4, 4))).toBe(0);
    expect(() => iou(a, newMask(5, 5))).toThrow();
    expect(cropMask(b, { x0: 2, y0: 2, x1: 4, y1: 7 }).w).toBe(3);
    expect(downscaleMask(b, 2).w).toBe(5);
  });

  it('rasterises triangles of either winding', () => {
    const xy = new Float32Array([2, 2, 18, 2, 2, 18]);
    const m1 = rasterizeTriangles(xy, new Uint32Array([0, 1, 2]), 20, 20);
    const m2 = rasterizeTriangles(xy, new Uint32Array([0, 2, 1]), 20, 20);
    expect(maskArea(m1)).toBe(maskArea(m2));
    expect(maskArea(m1)).toBeGreaterThan(110);
    expect(maskArea(m1)).toBeLessThan(140);
  });

  it('averages the figure colour', () => {
    const img = image(20, 20, [255, 255, 255, 255]);
    rect(img, 5, 5, 14, 14, [200, 100, 50, 255]);
    const m = maskFromImage(img);
    expect(averageFigureColor(img, m)).toBe('#c86432');
  });
});

describe('fitting the body to an artwork silhouette', () => {
  // Build a "drawing" from a body with known proportions, then check the fit moves a default body towards it.
  const truth = { ...buildRestSkeleton().proportions, shoulders: 1.3, legs: 1.12, build: 1.25, head: 1.15 };
  const truthShape = { ...DEFAULT_SHAPE, chest: 1.25, pelvis: 1.2, arms: 1.2 };
  const pose = applyPreset(buildRestSkeleton(), presetById('a-pose')!);
  function drawingMask() {
    const rest = buildRestSkeleton(truth);
    const mesh = buildCharacterMesh(rest, truthShape, 'normal');
    const pos = posedPositions(mesh, rest, pose);
    const fit = alignFit(boundsXY(pos, mesh.vertexCount), { x0: 40, y0: 30, x1: 359, y1: 929 });
    return bodySilhouette(pos, mesh, fit, 400, 960);
  }

  it('scores a body against itself as a near-perfect match', () => {
    const mask = drawingMask();
    const target = { mask: downscaleMask(cropMask(mask, maskBounds(mask)!), 6) };
    expect(scoreCandidate(truth, truthShape, pose, target).iou).toBeGreaterThan(0.9);
  });

  it('improves the overlap and recovers the direction of the real proportions', async () => {
    const mask = drawingMask();
    const start = buildRestSkeleton().proportions;
    const progress: number[] = [];
    const r = await fitBodyToArtwork({ proportions: start, shape: DEFAULT_SHAPE, pose, mask, workHeight: 90, rounds: 3, onProgress: (p) => progress.push(p.fraction) });
    expect(r.iou).toBeGreaterThan(r.iouBefore + 0.03);
    expect(r.iou).toBeGreaterThan(0.9);
    expect(r.proportions.shoulders).toBeGreaterThan(start.shoulders + 0.05);
    expect(r.proportions.build).toBeGreaterThan(start.build + 0.05);
    expect(r.shape.chest).toBeGreaterThanOrEqual(1);
    expect(r.evaluations).toBeGreaterThan(FIT_PARAMS.length);
    expect(r.fit.ppm).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBeCloseTo(1, 6);
  }, 120_000);

  it('does not change the standing height and can be stopped early', async () => {
    const mask = drawingMask();
    const start = buildRestSkeleton().proportions;
    let calls = 0;
    const r = await fitBodyToArtwork({ proportions: start, shape: DEFAULT_SHAPE, pose, mask, workHeight: 60, rounds: 2, shouldStop: () => ++calls > 4 });
    expect(r.stopped).toBe(true);
    expect(r.iou).toBeGreaterThanOrEqual(r.iouBefore);
    const keep = buildRestSkeleton(start).restHeight;
    const restored = restoreStandingHeight({ ...r.proportions }, keep);
    expect(buildRestSkeleton(restored).restHeight).toBeCloseTo(keep, 2);
  }, 60_000);

  it('refuses an empty artwork', async () => {
    await expect(fitBodyToArtwork({ proportions: buildRestSkeleton().proportions, shape: DEFAULT_SHAPE, pose, mask: newMask(20, 20) })).rejects.toThrow(/no figure/);
  });

  it('keeps the presets within the parameter ranges used by the search', () => {
    for (const p of BODY_PRESETS) expect(Object.values(p.proportions).every(Number.isFinite)).toBe(true);
  });
});
