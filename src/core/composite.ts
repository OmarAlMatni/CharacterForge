import { mul, translation } from './math.ts';
import { computePlacements, placementMatrix } from './rig.ts';
import { effectiveOpacity, isEffectivelyVisible, renderOrder } from './layers.ts';
import type { DocState, Layer, PoseState } from './types.ts';

/** The subset of CanvasRenderingContext2D used for composition (lets tests record calls). */
export interface Ctx2DLike {
  globalAlpha: number;
  imageSmoothingEnabled: boolean;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(img: never, dx: number, dy: number): void;
}

export interface CompositionOptions {
  scale?: number;
  pose?: PoseState;
}

/**
 * Paints the character exactly as the editor shows it: same layer order, visibility, opacity,
 * mask-applied bitmaps and joint-driven placement. The target starts fully transparent and no
 * checkerboard or UI overlay is ever drawn here.
 */
export function renderComposition(
  ctx: Ctx2DLike,
  doc: DocState,
  getBitmap: (layer: Layer) => unknown | null,
  opts: CompositionOptions = {},
): { drawn: number } {
  const scale = opts.scale ?? 1;
  const placements = computePlacements(doc.layers, doc.joints, opts.pose ?? doc.pose);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, Math.round(doc.canvas.width * scale), Math.round(doc.canvas.height * scale));
  ctx.imageSmoothingEnabled = true;
  let drawn = 0;
  for (const layer of renderOrder(doc.layers)) {
    if (!isEffectivelyVisible(doc.layers, layer.id)) continue;
    const bmp = getBitmap(layer);
    const placement = placements.get(layer.id);
    if (!bmp || !placement) continue;
    const m = mul(translation(0, 0), placementMatrix(layer, placement));
    ctx.setTransform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e * scale, m.f * scale);
    ctx.globalAlpha = effectiveOpacity(doc.layers, layer.id);
    ctx.drawImage(bmp as never, 0, 0);
    drawn++;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  return { drawn };
}
