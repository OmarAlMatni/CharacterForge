import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, migrateProjectData, ProjectFormatError } from '../src/core/migrations.ts';
import type { Migration } from '../src/core/migrations.ts';
import { createProject, parseProject, pruneUnusedAssets, referencedAssetIds, unusedAssetIds } from '../src/core/project.ts';
import { validateProjectFile } from '../src/core/schema.ts';
import { validProject } from './helpers.ts';

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const errorsOf = (p: unknown) => {
  const r = validateProjectFile(p);
  return r.ok ? [] : r.errors;
};

describe('project validation', () => {
  it('accepts a valid project and survives a JSON round trip', () => {
    const p = validProject();
    expect(validateProjectFile(p).ok).toBe(true);
    expect(parseProject(clone(p)).project).toEqual(p);
  });
  it('accepts a freshly created empty project', () => {
    expect(validateProjectFile(createProject('x', { width: 100, height: 100 }, 1)).ok).toBe(true);
  });
  it('rejects non-objects', () => {
    expect(errorsOf(null)).toHaveLength(1);
    expect(errorsOf([])).toHaveLength(1);
  });
  it('rejects layers pointing at missing assets, parents or joints', () => {
    const p = validProject();
    p.doc.layers[0]!.assetId = 'ghost';
    p.doc.layers[1]!.parentId = 'ghost';
    p.doc.layers[1]!.jointId = 'ghost';
    const e = errorsOf(p).join('\n');
    expect(e).toContain('assetId');
    expect(e).toContain('parentId');
    expect(e).toContain('jointId');
  });
  it('rejects duplicate ids, zero scale and bad opacity', () => {
    const p = validProject();
    p.doc.layers[1]!.id = p.doc.layers[0]!.id;
    p.doc.layers[0]!.transform.scaleX = 0;
    p.doc.layers[0]!.opacity = 2;
    const e = errorsOf(p).join('\n');
    expect(e).toContain('duplicate');
    expect(e).toContain('scale');
    expect(e).toContain('opacity');
  });
  it('rejects layer and joint cycles', () => {
    const p = validProject();
    const g1 = { ...p.doc.layers[0]!, id: 'g1', kind: 'group' as const, parentId: 'g2', assetId: null };
    const g2 = { ...p.doc.layers[0]!, id: 'g2', kind: 'group' as const, parentId: 'g1', assetId: null };
    p.doc.layers.push(g1, g2);
    expect(errorsOf(p).join('\n')).toContain('layers: hierarchy contains a cycle');
    const q = validProject();
    q.doc.joints[0]!.parentId = 'j2';
    expect(errorsOf(q).join('\n')).toContain('joints: hierarchy contains a cycle');
  });
  it('rejects poses that reference unknown joints and absurd canvases', () => {
    const p = validProject();
    p.doc.pose.rotations = { ghost: 5 };
    p.doc.canvas = { width: 99999, height: 10 };
    const e = errorsOf(p).join('\n');
    expect(e).toContain('unknown joint');
    expect(e).toContain('canvas');
  });
  it('rejects NaN transforms', () => {
    const p = validProject();
    p.doc.layers[0]!.transform.x = Number.NaN;
    expect(errorsOf(p).join('\n')).toContain('transform');
  });
  it('parseProject surfaces readable details', () => {
    const p = clone(validProject());
    p.doc.layers[0]!.assetId = 'ghost';
    try {
      parseProject(p);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e instanceof ProjectFormatError).toBe(true);
      expect((e as ProjectFormatError).details.join(' ')).toContain('assetId');
    }
  });
});

describe('asset bookkeeping', () => {
  it('keeps preserved sources even when no layer uses them', () => {
    const p = validProject();
    p.assets.push({ id: 'orphan', kind: 'mask', mime: 'image/png', width: 1, height: 1, size: 1 });
    p.doc.layers[0]!.assetId = 'asset_l2';
    expect(referencedAssetIds(p).has('asset_l1')).toBe(true); // source
    expect(unusedAssetIds(p)).toEqual(['orphan']);
    expect(pruneUnusedAssets(p).assets.some((a) => a.id === 'orphan')).toBe(false);
  });
});

describe('migrations', () => {
  const v1 = () => ({ schemaVersion: 1, marker: 'a' });
  const steps: Record<number, Migration> = {
    1: (d) => ({ ...d, schemaVersion: 2, upgradedTo2: true }),
    2: (d) => ({ ...d, schemaVersion: 3, upgradedTo3: true }),
  };
  it('current data needs no migration', () => {
    expect(migrateProjectData(validProject()).migratedFrom).toBeNull();
    expect(CURRENT_SCHEMA_VERSION).toBe(5);
  });
  it('chains migrations in order', () => {
    const r = migrateProjectData(v1(), steps, 3);
    expect(r.migratedFrom).toBe(1);
    expect(r.data).toEqual({ schemaVersion: 3, marker: 'a', upgradedTo2: true, upgradedTo3: true });
  });
  it('rejects data from a newer app version with a clear message', () => {
    expect(() => migrateProjectData({ schemaVersion: 9 })).toThrow('newer version');
  });
  it('rejects missing versions, missing steps and bad steps', () => {
    expect(() => migrateProjectData({})).toThrow('schemaVersion');
    expect(() => migrateProjectData(v1(), {}, 2)).toThrow('No migration');
    expect(() => migrateProjectData(v1(), { 1: (d) => d }, 2)).toThrow('did not set');
  });
  it('does not mutate its input', () => {
    const input = v1();
    migrateProjectData(input, steps, 3);
    expect(input).toEqual({ schemaVersion: 1, marker: 'a' });
  });
});
