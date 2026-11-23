import { describe, expect, it } from 'vitest';
import { maskFromImage, padFigureTexture } from '../src/pose/index.ts';

function figureImage(w = 80, h = 60): { rgba: Uint8ClampedArray; w: number; h: number } {
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255); // opaque white background
  for (let y = 20; y < 40; y++) for (let x = 30; x < 50; x++) rgba.set([200, 30, 30, 255], (y * w + x) * 4); // red figure
  return { rgba, w, h };
}

describe('padFigureTexture (artwork projection texture)', () => {
  const { rgba, w, h } = figureImage();
  const mask = maskFromImage({ w, h, data: rgba });
  const out = padFigureTexture(rgba, w, h, mask, 10);
  const at = (x: number, y: number): number[] => Array.from(out.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

  it('leaves the figure itself untouched', () => {
    expect(at(40, 30)).toEqual([200, 30, 30, 255]);
    expect(at(30, 20)).toEqual([200, 30, 30, 255]);
  });
  it('extends the figure colour outward instead of the white background', () => {
    expect(at(27, 30)).toEqual([200, 30, 30, 255]); // 3 px outside the left edge
    expect(at(40, 43)).toEqual([200, 30, 30, 255]); // 4 px below
    expect(at(26, 17)).toEqual([200, 30, 30, expect.any(Number)]); // diagonal corner
  });
  it('fades to transparent at the band edge and stays transparent beyond it', () => {
    const mid = at(23, 30)[3]!; // 7 px away (band 10, solid up to 6)
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(255);
    expect(at(5, 30)[3]).toBe(0);
    expect(at(0, 0)[3]).toBe(0);
  });
  it('never contains an opaque background-coloured pixel', () => {
    for (let i = 0; i < w * h; i++) {
      if (out[i * 4 + 3]! > 0) expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]).toEqual([200, 30, 30]);
    }
  });
  it('without a figure it returns a fully transparent texture rather than inventing colours', () => {
    const empty = padFigureTexture(rgba, w, h, { w, h, data: new Uint8Array(w * h) }, 10);
    expect(empty.every((v) => v === 0)).toBe(true);
  });
  it('rejects a mask of the wrong size', () => {
    expect(() => padFigureTexture(rgba, w, h, { w: 4, h: 4, data: new Uint8Array(16) }, 10)).toThrow(/same size/);
  });
});
