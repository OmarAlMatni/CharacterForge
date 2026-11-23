import { newId } from '../core/ids.ts';
import { ProjectFormatError } from '../core/migrations.ts';
import { parseProject, referencedAssetIds } from '../core/project.ts';
import type { AssetInfo, ID, ProjectFile } from '../core/types.ts';
import type { AssetRecord, CharacterForgeDB } from './db.ts';

export interface AssetData {
  id: ID;
  kind: AssetInfo['kind'];
  mime: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

export interface ProjectSummary {
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  layerCount: number;
  canvas: { width: number; height: number };
}

export const assetKey = (projectId: ID, assetId: ID): string => `${projectId}/${assetId}`;

const toRecord = (projectId: ID, a: AssetData): AssetRecord => ({ key: assetKey(projectId, a.id), projectId, ...a });
const toData = (r: AssetRecord): AssetData => ({ id: r.id, kind: r.kind, mime: r.mime, width: r.width, height: r.height, bytes: r.bytes });

/** Atomically store the project JSON and any new/changed assets. */
export async function saveProject(db: CharacterForgeDB, project: ProjectFile, newAssets: AssetData[] = []): Promise<void> {
  await db.transaction('rw', db.projects, db.assets, async () => {
    if (newAssets.length) await db.assets.bulkPut(newAssets.map((a) => toRecord(project.id, a)));
    await db.projects.put({ id: project.id, name: project.name, createdAt: project.createdAt, updatedAt: project.updatedAt, data: project });
  });
}

/** Load + migrate + validate a project and verify that every asset it needs is present. */
export async function loadProject(
  db: CharacterForgeDB,
  id: ID,
): Promise<{ project: ProjectFile; assets: Map<ID, AssetData>; migratedFrom: number | null }> {
  const rec = await db.projects.get(id);
  if (!rec) throw new ProjectFormatError('That project no longer exists in this browser.');
  const { project, migratedFrom } = parseProject(rec.data);
  if (migratedFrom !== null) await keepMigrationBackup(db, id, migratedFrom, rec.data);
  const records = await db.assets.where('projectId').equals(id).toArray();
  const assets = new Map<ID, AssetData>(records.map((r) => [r.id, toData(r)]));
  const missing = [...referencedAssetIds(project)].filter((a) => !assets.has(a));
  if (missing.length) throw new ProjectFormatError(`Project data is incomplete: ${missing.length} image(s) are missing from local storage.`, missing);
  return { project, assets, migratedFrom };
}

/** Keep the pre-migration data (once per project and version). The data is only parsed, never changed, so this cannot lose anything. */
async function keepMigrationBackup(db: CharacterForgeDB, projectId: ID, fromVersion: number, data: unknown): Promise<void> {
  const key = `${projectId}@v${fromVersion}`;
  if (await db.backups.get(key)) return;
  await db.backups.put({ key, projectId, fromVersion, savedAt: Date.now(), data: structuredClone(data) });
}

export async function listMigrationBackups(db: CharacterForgeDB, projectId: ID): Promise<{ fromVersion: number; savedAt: number }[]> {
  const rows = await db.backups.where('projectId').equals(projectId).toArray();
  return rows.map((r) => ({ fromVersion: r.fromVersion, savedAt: r.savedAt })).sort((a, b) => a.fromVersion - b.fromVersion);
}

/** Bring a pre-migration backup back as a NEW project (migrated again, so it opens in this version). Nothing existing is overwritten. */
export async function restoreMigrationBackup(db: CharacterForgeDB, projectId: ID, fromVersion: number, now: number): Promise<ProjectFile> {
  const row = await db.backups.get(`${projectId}@v${fromVersion}`);
  if (!row) throw new ProjectFormatError('There is no backup of that project from before the format upgrade.');
  const { project } = parseProject(row.data);
  const records = await db.assets.where('projectId').equals(projectId).toArray();
  const copy: ProjectFile = { ...project, id: newId('proj'), name: `${project.name} (before upgrade from format ${fromVersion})`, createdAt: now, updatedAt: now };
  await saveProject(db, copy, records.map(toData));
  return copy;
}

export async function listProjects(db: CharacterForgeDB): Promise<ProjectSummary[]> {
  const recs = await db.projects.orderBy('updatedAt').reverse().toArray();
  return recs.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    layerCount: r.data.doc?.layers?.filter((l) => l.kind === 'raster').length ?? 0,
    canvas: r.data.doc?.canvas ?? { width: 0, height: 0 },
  }));
}

export async function deleteProject(db: CharacterForgeDB, id: ID): Promise<void> {
  await db.transaction('rw', db.projects, db.assets, db.backups, async () => {
    await db.assets.where('projectId').equals(id).delete();
    await db.backups.where('projectId').equals(id).delete();
    await db.projects.delete(id);
  });
}

export async function deleteAssets(db: CharacterForgeDB, projectId: ID, assetIds: ID[]): Promise<void> {
  await db.assets.bulkDelete(assetIds.map((a) => assetKey(projectId, a)));
}

/** Deep copy a project (new id, same asset ids — asset keys are namespaced by project). */
export async function duplicateProject(db: CharacterForgeDB, id: ID, now: number, name?: string): Promise<ProjectFile> {
  const { project, assets } = await loadProject(db, id);
  const copy: ProjectFile = { ...structuredClone(project), id: newId('proj'), name: name ?? `${project.name} copy`, createdAt: now, updatedAt: now };
  await saveProject(db, copy, [...assets.values()]);
  return copy;
}

/** Store a project that came from a bundle under a fresh id so it never overwrites an existing one. */
export async function storeImportedProject(db: CharacterForgeDB, project: ProjectFile, assets: Map<ID, AssetData>, now: number): Promise<ProjectFile> {
  const fresh: ProjectFile = { ...project, id: newId('proj'), createdAt: now, updatedAt: now };
  await saveProject(db, fresh, [...assets.values()]);
  return fresh;
}
