import type { CharacterState, GenerationProvenance, GenerationRecord, GuideKind } from '../core/character.ts';
import { approvedReferences } from '../core/character.ts';
import type { ID } from '../core/types.ts';
import { MANUAL_IMPORT_ID } from './registry.ts';

export interface ProvenanceInput {
  character: CharacterState;
  providerId: string;
  providerName: string;
  model: string | null;
  seed: number | null;
  requestedAt: number;
  completedAt: number;
  guideAssetIds: Partial<Record<GuideKind, ID>>;
  parentId: ID | null;
  poseId?: ID | null;
}

/** Snapshot of everything that produced a result: sources, references, pose, camera, proportions and settings. */
export function buildProvenance(i: ProvenanceInput): GenerationProvenance {
  const c = i.character;
  const matchedPose = i.poseId ? c.studio.poses.find((p) => p.id === i.poseId) : undefined;
  return {
    providerId: i.providerId,
    providerName: i.providerName,
    model: i.model,
    requestedAt: i.requestedAt,
    completedAt: i.completedAt,
    settings: { width: c.studio.output.width, height: c.studio.output.height, instructions: c.instructions, seed: i.seed },
    originalAssetId: c.originalAssetId,
    referenceAssetIds: approvedReferences(c).map((r) => r.assetId),
    guideAssetIds: i.guideAssetIds,
    pose: structuredClone(c.studio.pose),
    camera: structuredClone(c.studio.camera),
    proportions: structuredClone(c.studio.proportions),
    shape: structuredClone(c.studio.shape),
    poseId: matchedPose?.id ?? null,
    poseName: matchedPose?.name ?? null,
    parentId: i.parentId,
  };
}

export function makeRecord(id: ID, outputAssetId: ID, origin: GenerationRecord['origin'], provenance: GenerationProvenance, now: number): GenerationRecord {
  return { id, createdAt: now, origin, status: 'candidate', outputAssetId, note: '', decidedAt: null, provenance };
}

/** Provenance for an image the user made elsewhere and imported: the provider is explicitly "imported", never a model. */
export const importedProvider = { id: MANUAL_IMPORT_ID, name: 'Imported by you (not generated here)' } as const;
