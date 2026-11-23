import type { Mask } from './silhouette.ts';

/**
 * Build the texture that is projected onto the body from a drawing.
 *
 * A drawing is a flat picture of a figure on a background. The posed body is never exactly the size of the figure, so some of its
 * surface samples the picture just outside the figure's outline and — when the background is white or any other flat colour —
 * shows up as bright slivers along the sides of the head, torso and legs, and at every grazing angle when the model is turned.
 *
 * `padFigureTexture` keeps the figure's pixels and replaces everything outside the figure with the colour of the nearest figure
 * pixel for `band` pixels, fading to fully transparent over the outer 40% of the band (the viewer then falls back to the fill
 * colour). The figure itself is not altered, so line art and the shading in the drawing are untouched.
 *
 * Returns RGBA; every pixel gets a colour (so texture filtering never mixes in an unrelated background colour) and the alpha says
 * how much to trust it.
 */
export function padFigureTexture(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, mask: Mask, band: number): Uint8ClampedArray {
  const n = w * h;
  if (mask.w !== w || mask.h !== h) throw new Error('The mask must have the same size as the image.');
  const out = new Uint8ClampedArray(n * 4);
  // nearest figure pixel (index) and its squared distance, by two-pass chamfer propagation over the 8-neighbourhood
  const src = new Int32Array(n).fill(-1);
  const dist = new Float32Array(n).fill(Infinity);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (mask.data[i]) {
      src[i] = i;
      dist[i] = 0;
      any = true;
    }
  }
  if (!any) {
    // no figure found: nothing sensible to extend, so the texture is fully transparent (the fill colour shows)
    return out;
  }
  const relax = (i: number, x: number, y: number, nx: number, ny: number): void => {
    const j = ny * w + nx;
    const s = src[j]!;
    if (s < 0) return;
    const sx = s % w, sy = (s / w) | 0;
    const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
    if (d < dist[i]!) {
      dist[i] = d;
      src[i] = s;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      if (x > 0) relax(i, x, y, x - 1, y);
      if (y > 0) {
        relax(i, x, y, x, y - 1);
        if (x > 0) relax(i, x, y, x - 1, y - 1);
        if (x < w - 1) relax(i, x, y, x + 1, y - 1);
      }
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (dist[i] === 0) continue;
      if (x < w - 1) relax(i, x, y, x + 1, y);
      if (y < h - 1) {
        relax(i, x, y, x, y + 1);
        if (x < w - 1) relax(i, x, y, x + 1, y + 1);
        if (x > 0) relax(i, x, y, x - 1, y + 1);
      }
    }
  }
  const solid = band * 0.6;
  for (let i = 0; i < n; i++) {
    const s = src[i]!;
    const o = i * 4;
    out[o] = rgba[s * 4]!;
    out[o + 1] = rgba[s * 4 + 1]!;
    out[o + 2] = rgba[s * 4 + 2]!;
    const d = Math.sqrt(dist[i]!);
    out[o + 3] = d <= solid ? 255 : d >= band ? 0 : Math.round((255 * (band - d)) / (band - solid));
  }
  return out;
}
