import type { Box, Mask } from '../pose/index.ts';
import { averageFigureColor, extrudeSilhouetteColor, maskBounds, maskFromImage, sideFillBand } from '../pose/index.ts';
import { ctx2d, decodeToCanvas, newCanvas } from '../render/pngEncode.ts';

/**
 * A decoded artwork image prepared for the studio: a texture-sized canvas, the figure mask and the figure's bounding box.
 * `width`/`height` are the ORIGINAL pixel size; every `ArtworkFit` is expressed in those pixels, so the texture canvas can be
 * smaller without changing any mapping (texture coordinates are normalised).
 */
export interface ArtImage {
  /** The drawing as it was imported, at texture size (at most `TEXTURE_MAX` px on a side). Used for the overlay. */
  canvas: HTMLCanvasElement;
  /** The texture projected onto the body: the figure with its outline extended outward, so surfaces just outside it never pick up the background. */
  projection: HTMLCanvasElement;
  width: number;
  height: number;
  /** Figure mask at working resolution (at most `MASK_MAX` px on a side). */
  mask: Mask;
  /** Working-resolution pixels per original pixel. */
  maskScale: number;
  /** Figure bounding box in ORIGINAL pixels, or null when no figure was found. */
  box: Box | null;
  /** Mean figure colour, the default fill for surfaces the drawing does not show. */
  avgColor: string;
}

export const TEXTURE_MAX = 2048;
export const MASK_MAX = 1024;

function scaled(src: HTMLCanvasElement, max: number): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  if (scale >= 1) return { canvas: src, scale: 1 };
  const c = newCanvas(Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale)));
  const ctx = ctx2d(c);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, scale: c.width / src.width };
}

/**
 * The texture projected onto the body: the figure with its outline colour extruded OUTWARD along the silhouette, so a
 * surface just outside the drawing still shows the character's own colour instead of the flat fill (see
 * `extrudeSilhouetteColor`). The band scales with the figure, not the canvas, so it covers the flank of a body wider than
 * the drawing.
 */
function projectionTexture(tex: HTMLCanvasElement): HTMLCanvasElement {
  const px = ctx2d(tex).getImageData(0, 0, tex.width, tex.height);
  const mask = maskFromImage({ w: px.width, h: px.height, data: px.data });
  const padded = extrudeSilhouetteColor(px.data, px.width, px.height, mask, sideFillBand(mask));
  const c = newCanvas(tex.width, tex.height);
  ctx2d(c).putImageData(new ImageData(padded as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  return c;
}

/** Decode once per asset and keep the result; the studio asks for images synchronously through `get`. */
export class ArtworkCache {
  private done = new Map<string, ArtImage>();
  private pending = new Map<string, Promise<ArtImage>>();

  get(id: string | null | undefined): ArtImage | null {
    return id ? (this.done.get(id) ?? null) : null;
  }

  /** Decode (or return the cached result). `onReady` runs once when a new image became available. */
  async load(id: string, bytes: Uint8Array, mime: string): Promise<ArtImage> {
    const hit = this.done.get(id);
    if (hit) return hit;
    let p = this.pending.get(id);
    if (!p) {
      p = (async () => {
        const full = await decodeToCanvas(bytes, mime);
        const tex = scaled(full, TEXTURE_MAX);
        const work = scaled(full, MASK_MAX);
        const wctx = ctx2d(work.canvas);
        const px = wctx.getImageData(0, 0, work.canvas.width, work.canvas.height);
        const rgba = { w: px.width, h: px.height, data: px.data };
        const mask = maskFromImage(rgba);
        const mb = maskBounds(mask);
        const box: Box | null = mb
          ? {
              x0: Math.floor(mb.x0 / work.scale),
              y0: Math.floor(mb.y0 / work.scale),
              x1: Math.min(full.width - 1, Math.ceil((mb.x1 + 1) / work.scale) - 1),
              y1: Math.min(full.height - 1, Math.ceil((mb.y1 + 1) / work.scale) - 1),
            }
          : null;
        const img: ArtImage = { canvas: tex.canvas, projection: projectionTexture(tex.canvas), width: full.width, height: full.height, mask, maskScale: work.scale, box, avgColor: averageFigureColor(rgba, mask) };
        this.done.set(id, img);
        return img;
      })().finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }

  clear(): void {
    this.done.clear();
    this.pending.clear();
  }
}
