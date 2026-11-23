import type { BodyModel } from '../pose/index.ts';
import { MODEL_FILE, getBodyModel, parseGlb, prepareBodyModel, setBodyModel } from '../pose/index.ts';

let pending: Promise<BodyModel> | null = null;

/** Fetch, parse and rig the bundled character model once, and register it with the pose engine. */
export function loadBodyModel(): Promise<BodyModel> {
  const have = getBodyModel();
  if (have) return Promise.resolve(have);
  pending ??= (async () => {
    const res = await fetch(`${import.meta.env.BASE_URL}${MODEL_FILE}`);
    if (!res.ok) throw new Error(`The character model could not be loaded (${res.status}).`);
    const model = prepareBodyModel(parseGlb(new Uint8Array(await res.arrayBuffer())));
    setBodyModel(model);
    return model;
  })().catch((e) => {
    pending = null; // allow a retry
    throw e;
  });
  return pending;
}
