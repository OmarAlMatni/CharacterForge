import type { BodyMesh, BodyQuality } from './bodyMesh.ts';
import type { BodyModel } from './bodyModel.ts';
import { buildModelMesh } from './bodyModel.ts';
import type { BodyShape } from './bodyShape.ts';
import type { RestSkeleton } from './skeleton.ts';

/**
 * The character model the studio poses. The model file is loaded once at start-up (`loadBodyModel` in the app, or the test
 * helper) and registered here, so the pure pose code (fitting, projection, guides) can ask for "the body" without knowing
 * where it came from.
 */
let active: BodyModel | null = null;

export function setBodyModel(model: BodyModel | null): void {
  active = model;
}
export const getBodyModel = (): BodyModel | null => active;
export const hasBodyModel = (): boolean => active !== null;

/** The character body for a frame and shape. Throws if the model has not been loaded yet. */
export function buildCharacterMesh(rest: RestSkeleton, shape: Partial<BodyShape> | undefined, quality: BodyQuality = 'normal'): BodyMesh {
  if (!active) throw new Error('The character model is not loaded.');
  return buildModelMesh(active, rest, shape, quality);
}
