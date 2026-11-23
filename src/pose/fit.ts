import type { BodyShape } from './bodyShape.ts';
import { SHAPE_KEYS, SHAPE_RANGES, clampShape } from './bodyShape.ts';
import { buildCharacterMesh } from './characterMesh.ts';
import type { ArtworkFit } from './projection.ts';
import { alignFit, bodySilhouette, boundsXY, posedPositions } from './projection.ts';
import type { Pose3D } from './pose.ts';
import type { Mask } from './silhouette.ts';
import { cropMask, downscaleMask, iou, maskBounds } from './silhouette.ts';
import type { Proportions } from './skeleton.ts';
import { PROPORTION_RANGES, buildRestSkeleton, clampProportions } from './skeleton.ts';

/**
 * Fit the body to a drawing: search the proportions and shape that make the posed model's front silhouette overlap the artwork's
 * figure mask as much as possible (intersection over union). Coordinate descent with shrinking steps; deterministic.
 * Height is NOT searched: only the ratios change, so the character keeps the standing height the artist chose.
 */
export type FitParam = { group: 'proportions'; key: Exclude<keyof Proportions, 'height'> } | { group: 'shape'; key: keyof BodyShape };

export const FIT_PARAMS: FitParam[] = [
  { group: 'proportions', key: 'legs' }, { group: 'proportions', key: 'torso' }, { group: 'proportions', key: 'arms' },
  { group: 'proportions', key: 'shoulders' }, { group: 'proportions', key: 'hips' }, { group: 'proportions', key: 'head' }, { group: 'proportions', key: 'build' },
  ...SHAPE_KEYS.map((key): FitParam => ({ group: 'shape', key })),
];

export interface FitRequest {
  proportions: Proportions;
  shape: BodyShape;
  /** The pose the drawing shows (e.g. A-pose). The model is posed like this before its silhouette is compared. */
  pose: Pose3D;
  /** Figure mask of the artwork at full resolution. */
  mask: Mask;
  /** Working resolution: the figure box is scaled to about this many pixels tall. */
  workHeight?: number;
  rounds?: number;
  onProgress?: (p: { fraction: number; iou: number }) => void;
  /** Return true to stop early (the best result so far is returned). */
  shouldStop?: () => boolean;
  /** Awaited between evaluations so a UI can stay responsive. */
  yieldFn?: () => Promise<void>;
}

export interface FitResult {
  proportions: Proportions;
  shape: BodyShape;
  iouBefore: number;
  iou: number;
  /** Mapping from model metres to FULL-resolution artwork pixels for the fitted body. */
  fit: ArtworkFit;
  evaluations: number;
  stopped: boolean;
}

interface Target {
  mask: Mask;
  /** Scale from full-res pixels to the working mask, and the crop origin in full-res pixels. */
  scale: number;
  x0: number;
  y0: number;
  fullBox: { x0: number; y0: number; x1: number; y1: number };
}

function makeTarget(full: Mask, workHeight: number): Target {
  const box = maskBounds(full);
  if (!box) throw new Error('The artwork has no figure to fit to (the mask is empty).');
  const cropped = cropMask(full, box);
  const factor = Math.max(1, cropped.h / workHeight);
  return { mask: downscaleMask(cropped, factor), scale: 1 / factor, x0: box.x0, y0: box.y0, fullBox: box };
}

/** IoU of one candidate against the target, with the candidate's silhouette box aligned to the target box. */
export function scoreCandidate(proportions: Proportions, shape: BodyShape, pose: Pose3D, target: Pick<Target, 'mask'>): { iou: number; fit: ArtworkFit } {
  const rest = buildRestSkeleton(proportions);
  const mesh = buildCharacterMesh(rest, shape, 'draft');
  const pos = posedPositions(mesh, rest, pose);
  const b = boundsXY(pos, mesh.vertexCount);
  const fit = alignFit(b, { x0: 0, y0: 0, x1: target.mask.w - 1, y1: target.mask.h - 1 });
  const sil = bodySilhouette(pos, mesh, fit, target.mask.w, target.mask.h);
  return { iou: iou(sil, target.mask), fit };
}

export async function fitBodyToArtwork(req: FitRequest): Promise<FitResult> {
  const target = makeTarget(req.mask, req.workHeight ?? 150);
  let props = clampProportions(req.proportions);
  let shape = clampShape(req.shape);
  const first = scoreCandidate(props, shape, req.pose, target);
  const iouBefore = first.iou;
  let best = first.iou;
  let evals = 1;
  const rounds = req.rounds ?? 4;
  const steps = [0.1, 0.05, 0.025, 0.012].slice(0, rounds);
  const total = steps.length * FIT_PARAMS.length;
  let done = 0;
  let stopped = false;
  outer: for (const step of steps) {
    for (const prm of FIT_PARAMS) {
      if (req.shouldStop?.()) {
        stopped = true;
        break outer;
      }
      const range = prm.group === 'proportions' ? PROPORTION_RANGES[prm.key] : SHAPE_RANGES[prm.key];
      const cur = prm.group === 'proportions' ? props[prm.key] : shape[prm.key];
      let improved: { value: number; score: number } | null = null;
      for (const dir of [1, -1]) {
        const value = Math.min(range.max, Math.max(range.min, cur + dir * step));
        if (Math.abs(value - cur) < 1e-9) continue;
        const p2 = prm.group === 'proportions' ? { ...props, [prm.key]: value } : props;
        const s2 = prm.group === 'shape' ? { ...shape, [prm.key]: value } : shape;
        const score = scoreCandidate(p2, s2, req.pose, target).iou;
        evals++;
        if (score > best + 1e-6 && (!improved || score > improved.score)) improved = { value, score };
      }
      if (improved) {
        best = improved.score;
        if (prm.group === 'proportions') props = { ...props, [prm.key]: improved.value };
        else shape = { ...shape, [prm.key]: improved.value };
      }
      done++;
      req.onProgress?.({ fraction: done / total, iou: best });
      if (req.yieldFn) await req.yieldFn();
    }
  }
  // final placement against the FULL-resolution figure box
  const rest = buildRestSkeleton(props);
  const mesh = buildCharacterMesh(rest, shape, 'normal');
  const pos = posedPositions(mesh, rest, req.pose);
  const fit = alignFit(boundsXY(pos, mesh.vertexCount), target.fullBox);
  return { proportions: props, shape, iouBefore, iou: best, fit, evaluations: evals, stopped };
}

/** Rescale `height` so the fitted body stands as tall as the original did (the search only changes ratios). */
export function restoreStandingHeight(fitted: Proportions, targetRestHeight: number): Proportions {
  const rest = buildRestSkeleton(fitted);
  const k = targetRestHeight / rest.restHeight;
  return clampProportions({ ...fitted, height: fitted.height * k });
}
