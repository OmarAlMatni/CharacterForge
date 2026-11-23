/** Pure helpers for RGBA mask data. A mask's ALPHA channel is its visibility (255 = visible). */

export function invertAlpha(data: Uint8ClampedArray): void {
  for (let i = 3; i < data.length; i += 4) data[i] = 255 - data[i]!;
}

/** Multiplies alpha channels: result visible only where both are visible. Arrays must have equal length. */
export function intersectAlpha(a: Uint8ClampedArray, b: Uint8ClampedArray): Uint8ClampedArray {
  if (a.length !== b.length) throw new Error('Masks must have the same size.');
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = Math.round((a[i + 3]! * b[i + 3]!) / 255);
  }
  return out;
}

/** Fraction (0..1) of pixels with any visibility. */
export function alphaCoverage(data: Uint8ClampedArray, threshold = 1): number {
  const px = data.length / 4;
  if (px === 0) return 0;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! >= threshold) n++;
  return n / px;
}

/** Fraction of pixels that are fully transparent (alpha 0). */
export function transparentFraction(data: Uint8ClampedArray): number {
  const px = data.length / 4;
  if (px === 0) return 0;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] === 0) n++;
  return n / px;
}
