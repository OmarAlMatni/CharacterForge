/**
 * Silhouette tools: turn an artwork image into an inside/outside mask, rasterise the character's silhouette, and score how well
 * the two match (intersection over union). Pure TypeScript on plain arrays: usable in Node tests and in the browser.
 */
export interface Mask {
  w: number;
  h: number;
  /** 1 = inside the figure, 0 = outside. */
  data: Uint8Array;
}

export interface Box {
  x0: number;
  y0: number;
  /** Inclusive max pixel (x1 >= x0). */
  x1: number;
  y1: number;
}

export const newMask = (w: number, h: number): Mask => ({ w, h, data: new Uint8Array(w * h) });

export function maskBounds(m: Mask): Box | null {
  let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.data[y * m.w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

export const maskArea = (m: Mask): number => {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i]!;
  return n;
};

/** Intersection over union of two equally sized masks (0..1). Two empty masks score 0. */
export function iou(a: Mask, b: Mask): number {
  if (a.w !== b.w || a.h !== b.h) throw new Error('iou: mask sizes differ.');
  let i = 0, u = 0;
  for (let k = 0; k < a.data.length; k++) {
    const x = a.data[k]!, y = b.data[k]!;
    if (x & y) i++;
    if (x | y) u++;
  }
  return u === 0 ? 0 : i / u;
}

export interface Rgba {
  w: number;
  h: number;
  data: ArrayLike<number>;
}

/**
 * Figure mask of an artwork image.
 *  - If the image has real transparency, the figure is where alpha is above `alphaMin`.
 *  - Otherwise the background colour is estimated from the image border and everything connected to the border that is close to
 *    it counts as background. White areas that are ENCLOSED by the outline (a white shirt) therefore stay inside the figure.
 */
export function maskFromImage(img: Rgba, alphaMin = 24, bgTolerance = 36): Mask {
  const { w, h, data } = img;
  const m = newMask(w, h);
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3]! < 250) transparent++;
  if (transparent > 0.02 * w * h) {
    for (let i = 0; i < w * h; i++) m.data[i] = data[i * 4 + 3]! >= alphaMin ? 1 : 0;
    return m;
  }
  // opaque image: estimate the background colour from the border pixels (median per channel)
  const border: number[][] = [[], [], []];
  const take = (x: number, y: number): void => {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) border[c]!.push(data[o + c]!);
  };
  for (let x = 0; x < w; x++) { take(x, 0); take(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { take(0, y); take(w - 1, y); }
  const bg = border.map((a) => a.sort((p, q) => p - q)[a.length >> 1]!);
  const isBg = (i: number): boolean => Math.abs(data[i * 4]! - bg[0]!) + Math.abs(data[i * 4 + 1]! - bg[1]!) + Math.abs(data[i * 4 + 2]! - bg[2]!) <= bgTolerance;
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number): void => {
    if (!outside[i] && isBg(i)) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < w * h; i++) m.data[i] = outside[i] ? 0 : 1;
  return m;
}

/** Box-filter downscale (a pixel is inside when at least half of its source block is inside). */
export function downscaleMask(m: Mask, factor: number): Mask {
  if (factor <= 1) return m;
  const w = Math.max(1, Math.floor(m.w / factor)), h = Math.max(1, Math.floor(m.h / factor));
  const out = newMask(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = (y * factor) | 0; yy < Math.min(m.h, ((y + 1) * factor) | 0); yy++) {
        for (let xx = (x * factor) | 0; xx < Math.min(m.w, ((x + 1) * factor) | 0); xx++) {
          s += m.data[yy * m.w + xx]!;
          n++;
        }
      }
      out.data[y * w + x] = n > 0 && s * 2 >= n ? 1 : 0;
    }
  }
  return out;
}

/** Crop a mask to a box (inclusive). */
export function cropMask(m: Mask, b: Box): Mask {
  const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
  const out = newMask(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data[y * w + x] = m.data[(y + b.y0) * m.w + (x + b.x0)]!;
  return out;
}

/**
 * Fill triangles (2D pixel coordinates, 2 floats per vertex) into a mask. Pixel centres are sampled at +0.5.
 * Triangles of either winding are filled, so the result is the figure's silhouette.
 */
export function rasterizeTriangles(xy: Float32Array | Float64Array, indices: Uint32Array, w: number, h: number): Mask {
  const m = newMask(w, h);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 2, b = indices[t + 1]! * 2, c = indices[t + 2]! * 2;
    const ax = xy[a]!, ay = xy[a + 1]!, bx = xy[b]!, by = xy[b + 1]!, cx = xy[c]!, cy = xy[c + 1]!;
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy) - 0.5)), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy) - 0.5));
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx) - 0.5)), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx) - 0.5));
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) m.data[y * w + x] = 1;
      }
    }
  }
  return m;
}
