import type { Mask } from './silhouette.ts';
import { silhouetteBoundary } from './uvRelax.ts';

/**
 * Directional side-fill for the projection texture.
 *
 * v0.4.1's `padFigureTexture` replaced the background with the NEAREST figure pixel. Nearest-pixel propagation produces
 * radial streaks, and its band (4% of the image) ran out long before the flank of a body wider than the drawing — which
 * is why the sides of the model showed a flat fill colour.
 *
 * Here every boundary pixel of the figure is extruded OUTWARD along the silhouette's outward normal for `band` pixels,
 * carrying that boundary pixel's colour with a linear alpha falloff. The colour therefore wraps around the curve: a
 * sleeve's colour continues around the arm, a trouser leg's continues around the thigh. Where several boundary pixels
 * reach the same outside pixel, the nearest one wins, so the extrusion never crosses itself into a smear.
 *
 * Returns RGBA. Every pixel in the band gets a colour (so texture filtering never mixes in the background) and an alpha
 * that says how much to trust it; the figure itself is copied unchanged.
 */
export function extrudeSilhouetteColor(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  mask: Mask,
  band: number,
): Uint8ClampedArray {
  if (mask.w !== w || mask.h !== h) throw new Error('The mask must have the same size as the image.');
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const edge = silhouetteBoundary(mask);

  // figure pixels are copied verbatim
  let any = false;
  for (let i = 0; i < n; i++) {
    if (!mask.data[i]) continue;
    any = true;
    out[i * 4] = rgba[i * 4]!;
    out[i * 4 + 1] = rgba[i * 4 + 1]!;
    out[i * 4 + 2] = rgba[i * 4 + 2]!;
    out[i * 4 + 3] = rgba[i * 4 + 3]!;
  }
  if (!any) return out;

  // best (nearest) source boundary pixel per outside pixel
  const bestDist = new Float32Array(n).fill(Infinity);
  const bestSrc = new Int32Array(n).fill(-1);

  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && !!mask.data[y * w + x];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!edge[i]) continue;
      // outward normal from the local mask gradient (points from inside toward outside)
      let gx = 0;
      let gy = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const v = inside(x + dx, y + dy) ? 1 : 0;
          gx -= dx * v;
          gy -= dy * v;
        }
      }
      const len = Math.hypot(gx, gy);
      if (len < 1e-6) continue;
      gx /= len;
      gy /= len;
      const r = rgba[i * 4]!;
      const g = rgba[i * 4 + 1]!;
      const b = rgba[i * 4 + 2]!;
      for (let s = 1; s <= band; s++) {
        const px = Math.round(x + gx * s);
        const py = Math.round(y + gy * s);
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        const j = py * w + px;
        if (mask.data[j]) continue; // never overwrite the figure
        const d = Math.hypot(px - x, py - y);
        if (d >= bestDist[j]!) continue;
        bestDist[j] = d;
        bestSrc[j] = i;
        out[j * 4] = r;
        out[j * 4 + 1] = g;
        out[j * 4 + 2] = b;
        out[j * 4 + 3] = Math.round(255 * Math.max(0, 1 - d / band));
      }
    }
  }
  return out;
}

/**
 * The band width to use for a figure: a fraction of the figure's own larger dimension, so it scales with the character
 * rather than with the canvas. Clamped so a tiny figure still gets a usable band and a huge one does not smear.
 */
export function sideFillBand(mask: Mask, fraction = 0.12): number {
  let x0 = mask.w, y0 = mask.h, x1 = -1, y1 = -1;
  for (let y = 0; y < mask.h; y++) {
    for (let x = 0; x < mask.w; x++) {
      if (!mask.data[y * mask.w + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return 0;
  const size = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  return Math.max(6, Math.min(Math.round(size * fraction), Math.round(0.35 * Math.max(mask.w, mask.h))));
}
