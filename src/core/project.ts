import { characterAssetIds, emptyCharacter } from './character.ts';
import { newId } from './ids.ts';
import { defaultPage, pageAssetIds } from './page.ts';
import { CURRENT_SCHEMA_VERSION, migrateProjectData, ProjectFormatError } from './migrations.ts';
import { validateProjectFile } from './schema.ts';
import { REST } from './rig.ts';
import type { AssetInfo, ID, ProjectFile } from './types.ts';

export function createProject(name: string, canvas: { width: number; height: number }, now: number): ProjectFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('proj'),
    name: name.trim() || 'Untitled character',
    createdAt: now,
    updatedAt: now,
    sources: [],
    assets: [],
    doc: { canvas: { ...canvas }, layers: [], joints: [], pose: { rotations: {}, rootOffset: { ...REST.rootOffset } }, poses: [] },
    character: emptyCharacter(),
    page: defaultPage(),
  };
}

/** Migrate to the current schema, then validate. Throws ProjectFormatError with readable details. */
export function parseProject(raw: unknown): { project: ProjectFile; migratedFrom: number | null } {
  const { data, migratedFrom } = migrateProjectData(raw);
  const res = validateProjectFile(data);
  if (!res.ok) throw new ProjectFormatError('The project file is invalid or damaged.', res.errors);
  return { project: res.value, migratedFrom };
}

export function referencedAssetIds(p: ProjectFile): Set<ID> {
  const ids = new Set<ID>(p.sources.map((s) => s.assetId));
  characterAssetIds(p.character).forEach((id) => ids.add(id));
  if (p.page) pageAssetIds(p.page).forEach((id) => ids.add(id));
  for (const l of p.doc.layers) {
    if (l.assetId) ids.add(l.assetId);
    if (l.maskAssetId) ids.add(l.maskAssetId);
  }
  return ids;
}

export function addAssetInfo(p: ProjectFile, info: AssetInfo): ProjectFile {
  return p.assets.some((a) => a.id === info.id) ? p : { ...p, assets: [...p.assets, info] };
}

/** Assets no layer, mask or preserved source refers to. */
export function unusedAssetIds(p: ProjectFile): ID[] {
  const used = referencedAssetIds(p);
  return p.assets.filter((a) => !used.has(a.id)).map((a) => a.id);
}

export function pruneUnusedAssets(p: ProjectFile): ProjectFile {
  const used = referencedAssetIds(p);
  return { ...p, assets: p.assets.filter((a) => used.has(a.id)) };
}
