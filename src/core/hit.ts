import { apply, fromTRS, invert, mul, translation } from './math.ts';
import type { Transform, Vec2 } from './math.ts';
import { isEffectivelyVisible, renderOrder } from './layers.ts';
import { placementMatrix } from './rig.ts';
import type { DocState, ID, Layer } from './types.ts';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Layer rectangle corners in canvas space: TL, TR, BR, BL. */
export function layerCorners(layer: Layer, placement: Transform): Vec2[] {
  const m = placementMatrix(layer, placement);
  return [
    { x: 0, y: 0 },
    { x: layer.width, y: 0 },
    { x: layer.width, y: layer.height },
    { x: 0, y: layer.height },
  ].map((p) => apply(m, p));
}

export function pointToLayerLocal(layer: Layer, placement: Transform, p: Vec2): Vec2 | null {
  const inv = invert(placementMatrix(layer, placement));
  return inv ? apply(inv, p) : null;
}

/** Topmost visible, unlocked-or-not layer whose opaque pixel is under `p` (canvas coords). */
export function hitTestLayers(
  doc: DocState,
  placements: Map<ID, Transform>,
  p: Vec2,
  alphaAt: (layer: Layer, x: number, y: number) => number,
  alphaThreshold = 8,
): ID | null {
  const order = renderOrder(doc.layers);
  for (let i = order.length - 1; i >= 0; i--) {
    const layer = order[i]!;
    if (!isEffectivelyVisible(doc.layers, layer.id)) continue;
    const pl = placements.get(layer.id);
    if (!pl) continue;
    const local = pointToLayerLocal(layer, pl, p);
    if (!local || local.x < 0 || local.y < 0 || local.x >= layer.width || local.y >= layer.height) continue;
    if (alphaAt(layer, Math.floor(local.x), Math.floor(local.y)) >= alphaThreshold) return layer.id;
  }
  return null;
}

export function boundsOfPoints(points: Vec2[]): Bounds | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Bounding box of all visible raster layers at their rest placement. */
export function contentBounds(doc: DocState): Bounds | null {
  const pts: Vec2[] = [];
  for (const l of renderOrder(doc.layers)) {
    if (!isEffectivelyVisible(doc.layers, l.id)) continue;
    pts.push(...layerCorners(l, l.transform));
  }
  return boundsOfPoints(pts);
}

/** Layer-space matrix helpers re-exported for the interaction code. */
export const restMatrix = (layer: Layer) => mul(fromTRS(layer.transform), translation(-layer.pivot.x, -layer.pivot.y));
