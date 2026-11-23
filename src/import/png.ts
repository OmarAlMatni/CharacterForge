import { detectKind, mimeFor, pngSize } from '../core/files.ts';
import { makeRasterLayer } from '../core/layers.ts';
import { LIMITS } from '../core/schema.ts';
import { decodeToCanvas } from '../render/pngEncode.ts';
import type { ImportResult } from './types.ts';
import { ImportError } from './types.ts';

export interface PngImportInput {
  fileName: string;
  bytes: Uint8Array;
  makeId: (prefix: string) => string;
  now: number;
  /** Canvas the layer is placed in (centred). Omit for a new project: the canvas becomes the image size. */
  targetCanvas?: { width: number; height: number };
}

export async function importPng(i: PngImportInput): Promise<ImportResult> {
  if (detectKind(i.bytes) !== 'png') throw new ImportError(`"${i.fileName}" is not a PNG file.`);
  const size = pngSize(i.bytes);
  if (!size || size.width < 1 || size.height < 1) throw new ImportError(`"${i.fileName}" has an invalid PNG header.`);
  if (size.width > LIMITS.maxCanvas || size.height > LIMITS.maxCanvas || size.width * size.height > LIMITS.maxPixels) {
    throw new ImportError(`"${i.fileName}" is ${size.width}×${size.height}px, which is larger than the supported maximum (${LIMITS.maxCanvas}px per side, ${LIMITS.maxPixels / 1e6} megapixels).`);
  }
  try {
    const c = await decodeToCanvas(i.bytes, 'image/png');
    if (c.width !== size.width || c.height !== size.height) throw new Error('size mismatch');
  } catch {
    throw new ImportError(`"${i.fileName}" could not be decoded. The file may be damaged or use an unsupported PNG variant.`);
  }
  const assetId = i.makeId('asset');
  const canvas = i.targetCanvas ?? { width: size.width, height: size.height };
  const name = i.fileName.replace(/\.png$/i, '') || 'Artwork';
  return {
    source: { assetId, fileName: i.fileName, mime: mimeFor('png'), kind: 'png', importedAt: i.now },
    // The layer uses the original file's bytes directly: nothing is re-encoded, so the source stays pristine.
    assets: [{ id: assetId, kind: 'source', mime: mimeFor('png'), width: size.width, height: size.height, bytes: i.bytes }],
    layers: [makeRasterLayer({ id: i.makeId('layer'), name, assetId, width: size.width, height: size.height, x: canvas.width / 2, y: canvas.height / 2 })],
    canvas: { width: canvas.width, height: canvas.height },
    warnings: [],
  };
}
