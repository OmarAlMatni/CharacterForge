import { emptyCharacter } from '../src/core/character.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/core/migrations.ts';
import { makeRasterLayer } from '../src/core/layers.ts';
import type { RasterLayerInit } from '../src/core/layers.ts';
import type { DocState, Joint, Layer, ProjectFile } from '../src/core/types.ts';

export const layer = (id: string, over: Partial<RasterLayerInit> = {}): Layer =>
  makeRasterLayer({ id, name: id, assetId: `asset_${id}`, width: 100, height: 50, ...over });

export const joint = (id: string, parentId: string | null, x: number, y: number, over: Partial<Joint> = {}): Joint => ({
  id,
  name: id,
  parentId,
  offset: { x, y },
  limits: null,
  bend: 0,
  ...over,
});

export const emptyDoc = (layers: Layer[] = [], joints: Joint[] = []): DocState => ({
  canvas: { width: 200, height: 200 },
  layers,
  joints,
  pose: { rotations: {}, rootOffset: { x: 0, y: 0 } },
  poses: [],
});

export function validProject(): ProjectFile {
  const layers = [layer('l1'), layer('l2')];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'proj_1',
    name: 'Test',
    createdAt: 1,
    updatedAt: 2,
    sources: [{ assetId: 'asset_l1', fileName: 'a.png', mime: 'image/png', kind: 'png', importedAt: 1 }],
    assets: ['l1', 'l2'].map((n) => ({ id: `asset_${n}`, kind: 'layer' as const, mime: 'image/png', width: 100, height: 50, size: 10 })),
    doc: emptyDoc(layers, [joint('j1', null, 10, 10), joint('j2', 'j1', 0, 40)]),
    character: emptyCharacter(),
  };
}

/** A project exactly as the previous release (schema v1, before character profiles) saved it. */
export function legacyV1Project(): Record<string, unknown> {
  const { character: _c, ...rest } = validProject();
  void _c;
  return { ...rest, schemaVersion: 1 };
}

/** A project exactly as release 0.2.0 saved it (schema v2: a character profile, but no body shape or artwork projection). */
export function legacyV2Project(): Record<string, unknown> {
  const p = validProject();
  const { shape: _s, artwork: _a, ...studio } = p.character.studio;
  void _s;
  void _a;
  return { ...p, schemaVersion: 2, character: { ...p.character, studio } };
}
