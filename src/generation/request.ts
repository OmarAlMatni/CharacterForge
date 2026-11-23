import type { CharacterState, GuideKind } from '../core/character.ts';
import { approvedReferences } from '../core/character.ts';
import type { ID } from '../core/types.ts';
import { buildRestSkeleton, computePoseGuide } from '../pose/index.ts';
import type { AssetData } from '../storage/projectService.ts';
import type { GenerationRequest, ImagePayload } from './types.ts';
import { GenerationError } from './types.ts';

const payload = (a: AssetData): ImagePayload => ({ bytes: a.bytes, mime: a.mime, width: a.width, height: a.height });

/**
 * Assemble the provider-independent request from the character profile. Pure and deterministic given its inputs.
 * `guides` are the already-rendered guide images (rendering needs a browser; see render/poseGuideImages.ts).
 */
export function buildGenerationRequest(
  c: CharacterState,
  getAsset: (id: ID) => AssetData | undefined,
  guides: Partial<Record<GuideKind, ImagePayload>>,
  seed: number | null,
): GenerationRequest {
  if (!c.originalAssetId) throw new GenerationError('invalid-request', 'Import the original character artwork first (Character tab).');
  const orig = getAsset(c.originalAssetId);
  if (!orig) throw new GenerationError('invalid-request', 'The original artwork image is missing from this project.');
  const references = approvedReferences(c).map((r) => {
    const a = getAsset(r.assetId);
    if (!a) throw new GenerationError('invalid-request', `Reference image "${r.label}" is missing from this project.`);
    return { ...payload(a), id: r.id, role: r.role, label: r.label, notes: r.notes };
  });
  const { width, height } = c.studio.output;
  const rest = buildRestSkeleton(c.studio.proportions);
  return {
    original: payload(orig),
    references,
    guides,
    pose: computePoseGuide(rest, c.studio.pose, c.studio.camera, width, height),
    output: { width, height },
    instructions: c.instructions,
    appearance: structuredClone(c.appearance),
    seed,
  };
}
