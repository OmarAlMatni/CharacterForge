import { readFileSync } from 'node:fs';
import { getBodyModel, parseGlb, prepareBodyModel, setBodyModel } from '../src/pose/index.ts';
import type { BodyModel } from '../src/pose/index.ts';

export const MODEL_URL = new URL('../public/models/anime-character-base-mesh.glb', import.meta.url);

/** Load the bundled character model once and register it, like the app does at start-up. */
export function loadTestModel(): BodyModel {
  const existing = getBodyModel();
  if (existing) return existing;
  const model = prepareBodyModel(parseGlb(new Uint8Array(readFileSync(MODEL_URL))));
  setBodyModel(model);
  return model;
}
