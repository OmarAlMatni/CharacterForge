import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../src/core/project.ts';
import { makeRasterLayer } from '../src/core/layers.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/core/migrations.ts';
import { CharacterForgeDB } from '../src/storage/db.ts';
import { deleteProject, duplicateProject, listMigrationBackups, listProjects, loadProject, restoreMigrationBackup, saveProject } from '../src/storage/projectService.ts';
import type { AssetData } from '../src/storage/projectService.ts';

let db: CharacterForgeDB;
let n = 0;
beforeEach(() => {
  db = new CharacterForgeDB(`test-${++n}`);
});

function sample() {
  const p = createProject('Heroine', { width: 300, height: 400 }, 10);
  const bytes = new Uint8Array(40).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  p.assets.push({ id: 'a1', kind: 'source', mime: 'image/png', width: 300, height: 400, size: bytes.length });
  p.sources.push({ assetId: 'a1', fileName: 'hero.png', mime: 'image/png', kind: 'png', importedAt: 10 });
  p.doc.layers.push(makeRasterLayer({ id: 'l1', name: 'Body', assetId: 'a1', width: 300, height: 400 }));
  p.doc.joints.push({ id: 'j1', name: 'Hips', parentId: null, offset: { x: 150, y: 200 }, limits: null, bend: 0 });
  p.doc.layers[0]!.jointId = 'j1';
  p.doc.pose = { rotations: { j1: 12.5 }, rootOffset: { x: 3, y: 4 } };
  p.doc.poses.push({ id: 'pose1', name: 'Lean', createdAt: 11, rotations: { j1: -20 }, rootOffset: { x: 0, y: 0 } });
  const asset: AssetData = { id: 'a1', kind: 'source', mime: 'image/png', width: 300, height: 400, bytes };
  return { p, asset, bytes };
}

describe('local persistence (IndexedDB)', () => {
  it('saves and reopens a project with identical data and bytes', async () => {
    const { p, asset, bytes } = sample();
    await saveProject(db, p, [asset]);
    const back = await loadProject(db, p.id);
    expect(back.project).toEqual(p);
    expect([...back.assets.get('a1')!.bytes]).toEqual([...bytes]);
  });
  it('lists projects newest first with summaries', async () => {
    const a = sample().p;
    const b = { ...sample().p, id: 'proj_other', name: 'Other', updatedAt: 999 };
    const s = sample();
    await saveProject(db, a, [s.asset]);
    await saveProject(db, b, [s.asset]);
    const list = await listProjects(db);
    expect(list.map((x) => x.name)).toEqual(['Other', 'Heroine']);
    expect(list[1]).toMatchObject({ layerCount: 1, canvas: { width: 300, height: 400 } });
  });
  it('keeps assets of different projects separate', async () => {
    const s = sample();
    const other = { ...sample().p, id: 'proj_other' };
    await saveProject(db, s.p, [s.asset]);
    await saveProject(db, other, [{ ...s.asset, bytes: new Uint8Array(40).fill(9) }]);
    expect((await loadProject(db, s.p.id)).assets.get('a1')!.bytes[39]).toBe(7);
    expect((await loadProject(db, 'proj_other')).assets.get('a1')!.bytes[39]).toBe(9);
  });
  it('reports missing images instead of loading a broken project', async () => {
    const { p } = sample();
    await saveProject(db, p, []);
    await expect(loadProject(db, p.id)).rejects.toThrow('missing');
  });
  it('rejects unknown ids and corrupt stored data', async () => {
    await expect(loadProject(db, 'nope')).rejects.toThrow('no longer exists');
    const { p, asset } = sample();
    await saveProject(db, { ...p, doc: { ...p.doc, canvas: { width: -1, height: 5 } } }, [asset]);
    await expect(loadProject(db, p.id)).rejects.toThrow('invalid or damaged');
  });
  it('duplicates a project independently', async () => {
    const { p, asset } = sample();
    await saveProject(db, p, [asset]);
    const copy = await duplicateProject(db, p.id, 50);
    expect(copy.id).not.toBe(p.id);
    expect(copy.name).toBe('Heroine copy');
    await deleteProject(db, p.id);
    expect((await loadProject(db, copy.id)).assets.has('a1')).toBe(true);
  });
  it('deletes a project and its assets', async () => {
    const { p, asset } = sample();
    await saveProject(db, p, [asset]);
    await deleteProject(db, p.id);
    expect(await listProjects(db)).toHaveLength(0);
    expect(await db.assets.count()).toBe(0);
  });
});

describe('migration safety', () => {
  async function storedV2() {
    const { p, asset } = sample();
    const v3 = createProjectLike(p);
    const { shape: _s, artwork: _a, ...studioV2 } = v3.character.studio as unknown as Record<string, unknown>;
    void _s;
    void _a;
    const v2 = { ...v3, schemaVersion: 2, character: { ...v3.character, studio: studioV2 } };
    await db.assets.put({ key: `${p.id}/a1`, projectId: p.id, ...asset });
    await db.projects.put({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, data: v2 as never });
    return { id: p.id, v2: structuredClone(v2) };
  }
  const createProjectLike = (p: ReturnType<typeof sample>['p']) => structuredClone(p);

  it('opening an older project keeps an untouched copy of what was stored', async () => {
    const { id, v2 } = await storedV2();
    const { project, migratedFrom } = await loadProject(db, id);
    expect(migratedFrom).toBe(2);
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const rows = await db.backups.toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: id, fromVersion: 2 });
    expect(rows[0]!.data).toEqual(v2);
    // the stored project itself is only replaced when the app saves
    expect((await db.projects.get(id))!.data).toEqual(v2);
  });
  it('the backup survives the save in the new format and is not replaced by later opens', async () => {
    const { id, v2 } = await storedV2();
    const first = await loadProject(db, id);
    await saveProject(db, { ...first.project, updatedAt: 500 });
    expect((await db.projects.get(id))!.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const again = await loadProject(db, id);
    expect(again.migratedFrom).toBeNull();
    expect((await db.backups.get(`${id}@v2`))!.data).toEqual(v2);
    expect(await listMigrationBackups(db, id)).toEqual([{ fromVersion: 2, savedAt: expect.any(Number) }]);
  });
  it('a backup is restored as a separate project; nothing existing is overwritten', async () => {
    const { id } = await storedV2();
    const first = await loadProject(db, id);
    await saveProject(db, { ...first.project, name: 'Edited since', updatedAt: 500 });
    const restored = await restoreMigrationBackup(db, id, 2, 900);
    expect(restored.id).not.toBe(id);
    expect(restored.name).toContain('before upgrade from format 2');
    expect((await loadProject(db, id)).project.name).toBe('Edited since');
    const reopened = await loadProject(db, restored.id);
    expect(reopened.project.name).toBe(restored.name);
    expect([...reopened.assets.get('a1')!.bytes]).toEqual([...first.assets.get('a1')!.bytes]);
    await expect(restoreMigrationBackup(db, id, 1, 1)).rejects.toThrow('no backup');
  });
  it('a project that cannot be migrated is left exactly as stored, with no backup row', async () => {
    const { id, v2 } = await storedV2();
    const broken = { ...v2, character: 'not an object' };
    await db.projects.put({ id, name: 'x', createdAt: 1, updatedAt: 1, data: broken as never });
    await expect(loadProject(db, id)).rejects.toThrow();
    expect((await db.projects.get(id))!.data).toEqual(broken);
    expect(await db.backups.count()).toBe(0);
  });
  it('deleting a project deletes its backups too', async () => {
    const { id } = await storedV2();
    await loadProject(db, id);
    await deleteProject(db, id);
    expect(await db.backups.count()).toBe(0);
  });
});

describe('database upgrade', () => {
  it('a database created by v0.4.0 (schema 1) opens with the new backups table and keeps every project and image', async () => {
    const { default: Dexie } = await import('dexie');
    const name = `legacy-${Date.now()}`;
    const old = new Dexie(name);
    old.version(1).stores({ projects: 'id, updatedAt, name', assets: 'key, projectId' });
    const { p, asset } = sample();
    await old.table('assets').put({ key: `${p.id}/a1`, projectId: p.id, ...asset });
    await old.table('projects').put({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt, data: p });
    old.close();
    const upgraded = new CharacterForgeDB(name);
    const back = await loadProject(upgraded, p.id);
    expect(back.project).toEqual(p);
    expect(await upgraded.backups.count()).toBe(0);
    upgraded.close();
  });
});
