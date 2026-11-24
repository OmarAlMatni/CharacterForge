import { describe, expect, it } from 'vitest';
import { extrudeSilhouetteColor, sideFillBand } from '../src/pose/sideFill.ts';
import { maskFromImage, newMask } from '../src/pose/silhouette.ts';
import type { Mask } from '../src/pose/silhouette.ts';

function figureImage(w = 80, h = 60): { rgba: Uint8ClampedArray; w: number; h: number } {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255); // opaque white background
  for (let y = 20; y < 40; y++) for (let x = 30; x < 50; x++) rgba.set([200, 30, 30, 255], (y * w + x) * 4); // red figure
  return { rgba, w, h };
}

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Mask {
  const m = newMask(w, h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m.data[y * w + x] = 1;
  return m;
}

describe('extrudeSilhouetteColor (projection side-fill)', () => {
  const { rgba, w, h } = figureImage();
  const mask = maskFromImage({ w, h, data: rgba });
  const out = extrudeSilhouetteColor(rgba, w, h, mask, 10);
  const at = (x: number, y: number): number[] => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

  it('leaves the figure itself untouched', () => {
    expect(at(40, 30)).toEqual([200, 30, 30, 255]);
    expect(at(30, 20)).toEqual([200, 30, 30, 255]);
  });

  it('extends the figure colour outward instead of the white background', () => {
    expect(at(27, 30).slice(0, 3)).toEqual([200, 30, 30]); // 3 px outside the left edge
    expect(at(40, 43).slice(0, 3)).toEqual([200, 30, 30]); // 4 px below
  });

  it('never writes a background-coloured pixel into the band', () => {
    for (let i = 0; i < w * h; i++) {
      if (out[i * 4 + 3]! > 0) expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual([200, 30, 30]);
    }
  });

  it('fades alpha monotonically with distance from the outline', () => {
    const a1 = at(29, 30)[3]!; // 1 px out
    const a5 = at(25, 30)[3]!; // 5 px out
    const a9 = at(21, 30)[3]!; // 9 px out
    expect(a1).toBeGreaterThan(a5);
    expect(a5).toBeGreaterThan(a9);
    expect(a9).toBeGreaterThanOrEqual(0);
  });

  it('stays transparent beyond the band', () => {
    expect(at(5, 30)[3]).toBe(0);
    expect(at(0, 0)[3]).toBe(0);
  });

  it('without a figure it returns a fully transparent texture rather than inventing colours', () => {
    const empty = extrudeSilhouetteColor(rgba, w, h, newMask(w, h), 10);
    expect(empty.every((v) => v === 0)).toBe(true);
  });

  it('rejects a mask of the wrong size', () => {
    expect(() => extrudeSilhouetteColor(rgba, w, h, newMask(4, 4), 10)).toThrow(/same size/);
  });

  it('wraps the colour around a curve rather than smearing it radially', () => {
    // a disc: the extrusion should follow the outward normal, so a pixel directly above the top of the disc gets the
    // top boundary colour, and a pixel directly right of the right edge gets the right boundary colour
    const m = rectMask(40, 40, 10, 10, 29, 29);
    const img = new Uint8ClampedArray(40 * 40 * 4);
    for (let y = 10; y <= 29; y++) for (let x = 10; x <= 29; x++) img.set([10, 200, 10, 255], (y * 40 + x) * 4);
    const e = extrudeSilhouetteColor(img, 40, 40, m, 6);
    const above = Array.from(e.slice((9 * 40 + 20) * 4, (9 * 40 + 20) * 4 + 4));
    const right = Array.from(e.slice((20 * 40 + 30) * 4, (20 * 40 + 30) * 4 + 4));
    expect(above.slice(0, 3)).toEqual([10, 200, 10]);
    expect(right.slice(0, 3)).toEqual([10, 200, 10]);
    expect(above[3]).toBeGreaterThan(0);
    expect(right[3]).toBeGreaterThan(0);
  });
});

describe('sideFillBand', () => {
  it('scales with the figure, not the canvas', () => {
    const small = sideFillBand(rectMask(200, 200, 90, 90, 110, 110)); // 21 px figure
    const big = sideFillBand(rectMask(200, 200, 20, 20, 180, 180)); // 161 px figure
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(6);
  });

  it('is zero for an empty mask', () => {
    expect(sideFillBand(newMask(50, 50))).toBe(0);
  });
});
