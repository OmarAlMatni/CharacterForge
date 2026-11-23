import { readPsd } from 'ag-psd';
import { detectKind, mimeFor } from '../core/files.ts';
import { makeGroup, makeRasterLayer } from '../core/layers.ts';
import { planPsdImport } from '../core/psdPlan.ts';
import type { PsdLike } from '../core/psdPlan.ts';
import { LIMITS } from '../core/schema.ts';
import type { Layer } from '../core/types.ts';
import { canvasToPngBytes } from '../render/pngEncode.ts';
import type { ImportResult } from './types.ts';
import { ImportError } from './types.ts';
import type { AssetData } from '../storage/projectService.ts';

export interface PsdImportInput {
  fileName: string;
  bytes: Uint8Array;
  makeId: (prefix: string) => string;
  now: number;
  targetCanvas?: { width: number; height: number };
}

/**
 * Imports layer names, order, groups, visibility, opacity and position from a PSD. Anything that
 * cannot be represented (blend modes, masks, clipping, effects…) is reported as a warning rather
 * than silently flattened. The original PSD is stored untouched as the source asset.
 */
export async function importPsd(i: PsdImportInput): Promise<ImportResult> {
  if (detectKind(i.bytes) !== 'psd') throw new ImportError(`"${i.fileName}" is not a PSD file.`);
  let psd;
  try {
    const buf = i.bytes.buffer.slice(i.bytes.byteOffset, i.bytes.byteOffset + i.bytes.byteLength) as ArrayBuffer;
    psd = readPsd(buf, { skipCompositeImageData: true, skipThumbnail: true });
  } catch (e) {
    throw new ImportError(`"${i.fileName}" could not be read as a PSD (${e instanceof Error ? e.message : 'unknown error'}). Try saving it again from your editor, or export the layers as PNG files.`);
  }
  if (psd.width > LIMITS.maxCanvas || psd.height > LIMITS.maxCanvas) {
    throw new ImportError(`"${i.fileName}" is ${psd.width}×${psd.height}px, larger than the supported maximum of ${LIMITS.maxCanvas}px per side.`);
  }
  const plan = planPsdImport(psd as unknown as PsdLike);
  if (!plan.layers.some((l) => l.kind === 'raster')) {
    throw new ImportError(`"${i.fileName}" has no importable pixel layers.${plan.warnings.length ? ' ' + plan.warnings.join(' ') : ''}`);
  }
  const target = i.targetCanvas ?? { width: plan.width, height: plan.height };
  const dx = (target.width - plan.width) / 2;
  const dy = (target.height - plan.height) / 2;

  const sourceId = i.makeId('asset');
  const assets: AssetData[] = [{ id: sourceId, kind: 'source', mime: mimeFor('psd'), width: plan.width, height: plan.height, bytes: i.bytes }];
  const ids = plan.layers.map(() => i.makeId('layer'));
  const layers: Layer[] = [];
  for (const p of plan.layers) {
    const id = ids[p.index]!;
    const parentId = p.parentIndex === null ? null : ids[p.parentIndex]!;
    if (p.kind === 'group') {
      layers.push({ ...makeGroup(id, p.name, parentId), visible: p.visible, opacity: p.opacity });
      continue;
    }
    const assetId = i.makeId('asset');
    const bytes = await canvasToPngBytes(p.canvas as unknown as HTMLCanvasElement);
    assets.push({ id: assetId, kind: 'layer', mime: 'image/png', width: p.width, height: p.height, bytes });
    layers.push(makeRasterLayer({ id, name: p.name, assetId, width: p.width, height: p.height, x: p.left + p.width / 2 + dx, y: p.top + p.height / 2 + dy, parentId, visible: p.visible, opacity: p.opacity }));
  }
  return {
    source: { assetId: sourceId, fileName: i.fileName, mime: mimeFor('psd'), kind: 'psd', importedAt: i.now },
    assets,
    layers,
    canvas: { width: target.width, height: target.height },
    warnings: plan.warnings,
  };
}
