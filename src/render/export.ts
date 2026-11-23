import { renderComposition } from '../core/composite.ts';
import type { Ctx2DLike } from '../core/composite.ts';
import { LIMITS } from '../core/schema.ts';
import { transparentFraction } from '../core/maskMath.ts';
import type { DocState } from '../core/types.ts';
import type { BitmapStore } from './bitmaps.ts';
import { canvasToBlob, ctx2d, newCanvas } from './pngEncode.ts';

export interface RenderedExport {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Fraction of pixels that are fully transparent (0..1). */
  transparentFraction: number;
}

/** Render the current pose at canvas resolution × scale onto a fresh, fully transparent canvas. */
export function renderExportCanvas(doc: DocState, bitmaps: BitmapStore, scale = 1): RenderedExport {
  const width = Math.round(doc.canvas.width * scale);
  const height = Math.round(doc.canvas.height * scale);
  if (width < 1 || height < 1 || width > LIMITS.maxCanvas || height > LIMITS.maxCanvas || width * height > 268_000_000) {
    throw new Error(`Cannot export at ${width}×${height}px: browsers limit canvas size. Choose a smaller scale.`);
  }
  const canvas = newCanvas(width, height);
  const ctx = ctx2d(canvas);
  renderComposition(ctx as unknown as Ctx2DLike, doc, (l) => bitmaps.get(l), { scale });
  // Sample (downscaled) to report how much of the image is transparent.
  const probe = newCanvas(Math.min(256, width), Math.min(256, height));
  ctx2d(probe).drawImage(canvas, 0, 0, probe.width, probe.height);
  const frac = transparentFraction(ctx2d(probe).getImageData(0, 0, probe.width, probe.height).data);
  return { canvas, width, height, transparentFraction: frac };
}

export async function exportPngBlob(doc: DocState, bitmaps: BitmapStore, scale = 1): Promise<{ blob: Blob; width: number; height: number }> {
  const r = renderExportCanvas(doc, bitmaps, scale);
  return { blob: await canvasToBlob(r.canvas), width: r.width, height: r.height };
}
