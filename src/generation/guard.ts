import { detectImageKind } from '../core/files.ts';
import type { GenerationOutput, GenerationRequest, ImagePayload } from './types.ts';
import { GenerationError } from './types.ts';

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * Honesty guard applied to every provider result before it is stored as a "generated" image:
 * it must be a real raster image, and it must not be one of the inputs handed back unchanged
 * (returning the original drawing or a guide image is not generation).
 */
export function assertGenuineResult(out: GenerationOutput, req: GenerationRequest): void {
  if (!out.bytes || out.bytes.byteLength < 64) throw new GenerationError('invalid-output', 'The provider returned an empty or truncated image.');
  const kind = detectImageKind(out.bytes);
  if (kind === 'unknown') throw new GenerationError('invalid-output', 'The provider did not return a PNG, JPEG or WebP image.');
  const inputs: { name: string; p: ImagePayload }[] = [
    { name: 'the original drawing', p: req.original },
    ...req.references.map((r) => ({ name: `reference "${r.label}"`, p: r as ImagePayload })),
    ...Object.entries(req.guides).flatMap(([k, p]) => (p ? [{ name: `the ${k} guide image`, p }] : [])),
  ];
  for (const i of inputs) {
    if (sameBytes(out.bytes, i.p.bytes)) throw new GenerationError('invalid-output', `The provider returned ${i.name} unchanged. That is not a generated image, so it was discarded.`);
  }
}
