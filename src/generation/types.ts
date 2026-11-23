import type { Appearance, GuideKind, ReferenceRole } from '../core/character.ts';
import type { PoseGuideData } from '../pose/index.ts';

/**
 * Provider-independent contract for pose-guided 2D generation.
 * The UI and the pose engine only know these types; each model backend lives behind `GenerationProvider`.
 * Different image models accept different control inputs, so a provider declares what it can use (`capabilities`)
 * and ignores the rest — it must never pretend to have used an input it did not.
 */
export interface ImagePayload {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

export interface ReferencePayload extends ImagePayload {
  id: string;
  role: ReferenceRole;
  label: string;
  notes: string;
}

export interface GenerationRequest {
  /** The original full-body character drawing. Required. */
  original: ImagePayload;
  /** Approved additional references (face close-ups, alternate views, clothing …). */
  references: ReferencePayload[];
  /** Rendered pose guidance images, keyed by kind. */
  guides: Partial<Record<GuideKind, ImagePayload>>;
  /** Structured pose data: joint positions, OpenPose keypoints, camera, facing direction. */
  pose: PoseGuideData;
  output: { width: number; height: number };
  /** Free-form user instructions. */
  instructions: string;
  /** Text appearance hints. These do NOT guarantee consistency; the reference images carry the identity. */
  appearance: Appearance;
  seed: number | null;
}

export interface GenerationOutput {
  bytes: Uint8Array;
  mime: string;
  /** Model/checkpoint identifier as reported by the backend (null if the backend did not say). */
  model: string | null;
  seed: number | null;
  /** Human-readable note from the backend (e.g. which control inputs it used). */
  info: string | null;
}

export interface ProviderCapabilities {
  acceptsReferences: boolean;
  maxReferences: number;
  guides: GuideKind[];
}

export type ProviderState = 'ready' | 'unavailable' | 'error';
export interface ProviderStatus {
  state: ProviderState;
  /** What is available, or exactly what is missing. Shown to the user verbatim. */
  message: string;
  model: string | null;
  capabilities: ProviderCapabilities | null;
}

export interface GenerationProgress {
  stage: string;
  /** 0..1, or null when the backend does not report progress. */
  fraction: number | null;
}

export interface GenerateOptions {
  signal?: AbortSignal;
  onProgress?: (p: GenerationProgress) => void;
}

export interface GenerationProvider {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** True if the provider sends artwork to a machine other than this computer. None of the built-in providers do. */
  readonly sendsArtworkOffDevice: boolean;
  status(signal?: AbortSignal): Promise<ProviderStatus>;
  generate(request: GenerationRequest, options?: GenerateOptions): Promise<GenerationOutput>;
}

export type GenerationErrorCode = 'unavailable' | 'rejected' | 'cancelled' | 'network' | 'protocol' | 'invalid-output' | 'invalid-request' | 'busy' | 'timeout' | 'too-large';

export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  constructor(code: GenerationErrorCode, message: string) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
  }
}
