import 'fake-indexeddb/auto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addGeneration, addReference, applyStudioPose, approvedReferences, characterAssetIds, deleteGeneration, deleteStudioPose, emptyCharacter,
  overwriteStudioPose, removeReference, renameStudioPose, saveStudioPose, setGenerationStatus, setOriginal, updateAppearance, updateReference, updateStudio,
} from '../src/core/character.ts';
import type { CharacterState, GenerationRecord, ReferenceImage } from '../src/core/character.ts';
import { detectImageKind, looksLikeMime } from '../src/core/files.ts';
import { CURRENT_SCHEMA_VERSION } from '../src/core/migrations.ts';
import { createProject, parseProject, pruneUnusedAssets, referencedAssetIds, unusedAssetIds } from '../src/core/project.ts';
import { validateProjectFile } from '../src/core/schema.ts';
import type { ProjectFile } from '../src/core/types.ts';
import { DEFAULT_CAMERA, restPose, setRot } from '../src/pose/index.ts';
import { exportBundle, importBundle } from '../src/storage/bundle.ts';
import { CharacterForgeDB } from '../src/storage/db.ts';
import { loadProject, saveProject } from '../src/storage/projectService.ts';
import type { AssetData } from '../src/storage/projectService.ts';
import { legacyV1Project, legacyV2Project, validProject } from './helpers.ts';
import { DEFAULT_SHAPE } from '../src/pose/index.ts';

const png = (n: number, mime = 'image/png'): Uint8Array => {
  const b = new Uint8Array(40 + n);
  if (mime === 'image/png') b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === 'image/jpeg') b.set([0xff, 0xd8, 0xff, 0xe0]);
  if (mime === 'image/webp') b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return b;
};

const ref = (id: string, assetId: string, over: Partial<ReferenceImage> = {}): ReferenceImage => ({ id, assetId, label: id, role: 'face', notes: '', fileName: `${id}.png`, approved: true, addedAt: 1, ...over });

function record(id: string, outputAssetId: string, over: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id, createdAt: 5, origin: 'imported', status: 'candidate', outputAssetId, note: '', decidedAt: null,
    provenance: {
      providerId: 'manual-import', providerName: 'Imported by you', model: null, requestedAt: 5, completedAt: 5,
      settings: { width: 768, height: 1152, instructions: '', seed: null },
      originalAssetId: 'orig', referenceAssetIds: ['r1'], guideAssetIds: { pose: 'guide1' },
      pose: restPose(), camera: DEFAULT_CAMERA, proportions: emptyCharacter().studio.proportions, poseId: null, poseName: null, parentId: null,
    },
    ...over,
  };
}

/** A fully populated v2 project with the asset list its character data needs. */
function populated(): ProjectFile {
  const p = createProject('Hero', { width: 100, height: 100 }, 1);
  for (const [id, kind] of [['orig', 'source'], ['r1', 'reference'], ['guide1', 'guide'], ['out1', 'generated'], ['old', 'source']] as const) {
    p.assets.push({ id, kind, mime: 'image/png', width: 10, height: 10, size: 40 });
  }
  p.sources.push({ assetId: 'orig', fileName: 'hero.png', mime: 'image/png', kind: 'png', importedAt: 1 });
  let c: CharacterState = emptyCharacter('orig');
  c = addReference(c, ref('ref1', 'r1', { role: 'clothing', notes: 'Red scarf' }));
  c = updateAppearance(c, { hair: 'black, shoulder length', palette: ['#112233', '#ffcc00'] });
  c = updateStudio(c, { pose: setRot(restPose(), 'head', { y: 20 }) });
  c = saveStudioPose(c, 'pose1', 'Looking aside', 3);
  c = addGeneration(c, record('gen1', 'out1', { status: 'accepted', decidedAt: 6 }));
  p.character = c;
  return p;
}

describe('schema v2 migration', () => {
  it('upgrades a v1 project, keeps its data and adopts the preserved PNG source as the original artwork', () => {
    const v1 = legacyV1Project();
    expect('character' in v1).toBe(false);
    const { project, migratedFrom } = parseProject(structuredClone(v1));
    expect(migratedFrom).toBe(1);
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project.character.originalAssetId).toBe('asset_l1');
    expect(project.character.references).toEqual([]);
    expect(project.character.generations).toEqual([]);
    expect(project.doc).toEqual(v1.doc);
    expect(project.sources).toEqual(v1.sources);
    expect(project.assets).toEqual(v1.assets);
    expect(project.name).toBe('Test');
  });
  it('does not invent an original when the project has none (no PNG source)', () => {
    const v1 = legacyV1Project();
    v1.sources = [];
    expect(parseProject(v1).project.character.originalAssetId).toBeNull();
    const psd = legacyV1Project();
    psd.sources = [{ assetId: 'asset_l1', fileName: 'a.psd', mime: 'image/vnd.adobe.photoshop', kind: 'psd', importedAt: 1 }];
    expect(parseProject(psd).project.character.originalAssetId).toBeNull();
  });
  it('survives a migrated project being saved and re-read without further migration', () => {
    const { project } = parseProject(legacyV1Project());
    const again = parseProject(JSON.parse(JSON.stringify(project)));
    expect(again.migratedFrom).toBeNull();
    expect(again.project).toEqual(project);
  });
  it('keeps real layer/joint/pose data of an old project intact', () => {
    const v1 = legacyV1Project() as unknown as ProjectFile;
    v1.doc.pose = { rotations: { j1: 33 }, rootOffset: { x: 1, y: 2 } };
    v1.doc.poses = [{ id: 'p1', name: 'Old pose', createdAt: 9, rotations: { j1: -10 }, rootOffset: { x: 0, y: 0 } }];
    const { project } = parseProject(structuredClone(v1));
    expect(project.doc.pose).toEqual(v1.doc.pose);
    expect(project.doc.poses).toEqual(v1.doc.poses);
  });
});

describe('schema v2 validation', () => {
  const ok = () => validateProjectFile(populated());
  it('accepts a fully populated character', () => {
    const r = ok();
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  const bad = (mutate: (p: ProjectFile) => void): string => {
    const p = populated();
    mutate(p);
    const r = validateProjectFile(p);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.errors.join(' | ');
  };
  it('rejects references to assets that do not exist', () => {
    expect(bad((p) => (p.character.originalAssetId = 'nope'))).toContain('originalAssetId');
    expect(bad((p) => (p.character.references[0]!.assetId = 'nope'))).toContain('references[0].assetId');
    expect(bad((p) => (p.character.generations[0]!.outputAssetId = 'nope'))).toContain('outputAssetId');
    expect(bad((p) => (p.character.generations[0]!.provenance.guideAssetIds = { pose: 'nope' }))).toContain('guideAssetIds.pose');
  });
  it('rejects invalid fields', () => {
    expect(bad((p) => ((p.character.references[0] as { role: string }).role = 'weird'))).toContain('role');
    expect(bad((p) => ((p.character.generations[0] as { status: string }).status = 'maybe'))).toContain('status');
    expect(bad((p) => ((p.character.generations[0] as { origin: string }).origin = 'magic'))).toContain('origin');
    expect(bad((p) => (p.character.studio.output = { width: 10, height: 99999 }))).toContain('output');
    expect(bad((p) => ((p.character.studio.proportions as { legs: number }).legs = 50))).toContain('legs');
    expect(bad((p) => ((p.character.studio.camera as { fov: number }).fov = 1))).toContain('fov');
    expect(bad((p) => ((p.character.studio.pose.rotations as Record<string, unknown>).elbowQ = { x: 0, y: 0, z: 0 }))).toContain('unknown joint');
    expect(bad((p) => (p.character.appearance.palette = ['red']))).toContain('palette');
  });
  it('rejects duplicate ids and a missing character section', () => {
    expect(bad((p) => p.character.references.push({ ...p.character.references[0]! }))).toContain('duplicate');
    expect(bad((p) => p.character.studio.poses.push({ ...p.character.studio.poses[0]! }))).toContain('duplicate');
    expect(bad((p) => delete (p as { character?: unknown }).character)).toContain('character');
  });
});

describe('character operations', () => {
  it('replacing the original keeps the previous one (never silently overwritten)', () => {
    const a = emptyCharacter('orig');
    const b = setOriginal(a, 'newer', 50);
    expect(b.originalAssetId).toBe('newer');
    expect(b.previousOriginals).toEqual([{ assetId: 'orig', replacedAt: 50 }]);
    expect(setOriginal(b, 'newer', 60)).toBe(b);
    expect(characterAssetIds(b)).toEqual(new Set(['orig', 'newer']));
  });
  it('refuses to replace the original once the earlier-originals list is full, instead of silently dropping one', () => {
    let c = emptyCharacter('o0');
    for (let i = 1; i <= 50; i++) c = setOriginal(c, `o${i}`, i);
    expect(c.previousOriginals).toHaveLength(50);
    expect(() => setOriginal(c, 'o51', 51)).toThrow(/will not discard/);
    expect(c.originalAssetId).toBe('o50');
    expect(characterAssetIds(c).has('o0')).toBe(true); // the very first original is still referenced
  });
  it('accepting or rejecting a result changes only its status', () => {
    const c0 = addGeneration(emptyCharacter('orig'), record('g', 'out1'));
    const c1 = setGenerationStatus(c0, 'g', 'accepted', 99);
    expect(c1.originalAssetId).toBe('orig');
    expect(c1.generations[0]).toMatchObject({ status: 'accepted', decidedAt: 99, outputAssetId: 'out1' });
    const c2 = setGenerationStatus(c1, 'g', 'candidate', 100);
    expect(c2.generations[0]!.decidedAt).toBeNull();
    expect(c0.generations[0]!.status).toBe('candidate'); // original state untouched
  });
  it('refuses to delete an accepted result but deletes others', () => {
    let c = addGeneration(emptyCharacter('orig'), record('g', 'out1'));
    c = setGenerationStatus(c, 'g', 'accepted', 1);
    expect(() => deleteGeneration(c, 'g')).toThrow('Un-accept');
    c = setGenerationStatus(c, 'g', 'rejected', 2);
    expect(deleteGeneration(c, 'g').generations).toEqual([]);
  });
  it('manages references and passes only approved ones on', () => {
    let c = emptyCharacter();
    c = addReference(c, ref('a', 'ra'));
    c = addReference(c, ref('b', 'rb', { approved: false }));
    expect(approvedReferences(c).map((r) => r.id)).toEqual(['a']);
    c = updateReference(c, 'b', { approved: true, notes: 'x'.repeat(5000) });
    expect(approvedReferences(c).length).toBe(2);
    expect(c.references[1]!.notes.length).toBe(4000);
    expect(removeReference(c, 'a').references.map((r) => r.id)).toEqual(['b']);
  });
  it('limits the number of references', () => {
    let c = emptyCharacter();
    for (let i = 0; i < 64; i++) c = addReference(c, ref(`r${i}`, `a${i}`));
    expect(() => addReference(c, ref('x', 'x'))).toThrow('at most 64');
  });
  it('sanitises appearance data', () => {
    const c = updateAppearance(emptyCharacter(), { palette: ['#FFFFFF', 'bad', '#12345', ...Array.from({ length: 30 }, () => '#000000')], hair: 'h'.repeat(9000) });
    expect(c.appearance.palette[0]).toBe('#FFFFFF');
    expect(c.appearance.palette.every((x) => /^#[0-9a-fA-F]{6}$/.test(x))).toBe(true);
    expect(c.appearance.palette.length).toBe(16);
    expect(c.appearance.hair.length).toBe(4000);
  });
  it('saves, restores, updates, renames and deletes studio poses (pose + camera)', () => {
    let c = emptyCharacter();
    c = updateStudio(c, { pose: setRot(restPose(), 'shoulderL', { z: 90 }), camera: { ...DEFAULT_CAMERA, azimuth: 40 } });
    c = saveStudioPose(c, 'p1', '  T pose  ', 1);
    c = updateStudio(c, { pose: restPose(), camera: DEFAULT_CAMERA });
    c = applyStudioPose(c, 'p1');
    expect(c.studio.pose.rotations.shoulderL!.z).toBe(90);
    expect(c.studio.camera.azimuth).toBe(40);
    expect(c.studio.poses[0]!.name).toBe('T pose');
    c = updateStudio(c, { pose: setRot(restPose(), 'head', { x: 10 }) });
    c = overwriteStudioPose(c, 'p1');
    expect(c.studio.poses[0]!.pose.rotations.head!.x).toBe(10);
    c = renameStudioPose(c, 'p1', 'Nod');
    expect(c.studio.poses[0]!.name).toBe('Nod');
    expect(renameStudioPose(c, 'p1', '   ').studio.poses[0]!.name).toBe('Nod');
    expect(deleteStudioPose(c, 'p1').studio.poses).toEqual([]);
    expect(saveStudioPose(emptyCharacter(), 'x', '', 1).studio.poses[0]!.name).toBe('Pose 1');
  });
  it('a saved pose is a snapshot, not a live reference', () => {
    let c = emptyCharacter();
    c = saveStudioPose(c, 'p1', 'a', 1);
    c = updateStudio(c, { pose: setRot(c.studio.pose, 'head', { y: 50 }) });
    expect(c.studio.poses[0]!.pose.rotations.head).toBeUndefined();
  });
});

describe('asset tracking', () => {
  it('counts character assets as referenced, so they are never pruned', () => {
    const p = populated();
    const used = referencedAssetIds(p);
    for (const id of ['orig', 'r1', 'guide1', 'out1']) expect(used.has(id)).toBe(true);
    expect(unusedAssetIds(p)).toEqual(['old']);
    expect(pruneUnusedAssets(p).assets.map((a) => a.id).sort()).toEqual(['guide1', 'orig', 'out1', 'r1']);
  });
  it('keeps replaced originals', () => {
    const p = populated();
    p.character = setOriginal(p.character, 'old', 7);
    expect(unusedAssetIds(p)).toEqual([]);
  });
});

describe('image sniffing', () => {
  it('detects PNG, JPEG and WebP', () => {
    expect(detectImageKind(png(0))).toBe('png');
    expect(detectImageKind(png(0, 'image/jpeg'))).toBe('jpeg');
    expect(detectImageKind(png(0, 'image/webp'))).toBe('webp');
    expect(detectImageKind(new Uint8Array(40))).toBe('unknown');
    expect(looksLikeMime(png(0, 'image/jpeg'), 'image/jpeg')).toBe(true);
    expect(looksLikeMime(png(0, 'image/jpeg'), 'image/png')).toBe(false);
  });
});

/** Bytes whose HEADER really says w×h (the importer checks the header against the project), padded so every image differs. */
function sized(mime: string, w: number, h: number, pad: number): Uint8Array {
  const b = new Uint8Array(40 + pad);
  const v = new DataView(b.buffer);
  if (mime === 'image/png') {
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    v.setUint32(16, w);
    v.setUint32(20, h);
  } else if (mime === 'image/jpeg') {
    b.set([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8]); // SOI, SOF0 segment
    v.setUint16(7, h);
    v.setUint16(9, w);
  } else if (mime === 'image/webp') {
    b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]); // RIFF....WEBPVP8X
    b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = ((w - 1) >> 16) & 255;
    b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = ((h - 1) >> 16) & 255;
  }
  return b;
}

function assetsFor(p: ProjectFile): Map<string, AssetData> {
  const m = new Map<string, AssetData>();
  p.assets.forEach((a, i) => {
    const bytes = sized(a.mime, a.width, a.height, i);
    a.size = bytes.byteLength;
    m.set(a.id, { id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, bytes });
  });
  return m;
}

describe('bundle and storage round trips with character data', () => {
  it('round-trips a full character through a bundle, including JPEG/WebP references', () => {
    const p = populated();
    p.assets.push({ id: 'ref-jpg', kind: 'reference', mime: 'image/jpeg', width: 5, height: 5, size: 1 }, { id: 'ref-webp', kind: 'reference', mime: 'image/webp', width: 5, height: 5, size: 1 });
    p.character = addReference(addReference(p.character, ref('rj', 'ref-jpg', { fileName: 'face.jpg' })), ref('rw', 'ref-webp', { fileName: 'dress.webp' }));
    const assets = assetsFor(p);
    const back = importBundle(exportBundle(p, assets, '0.2.0', 1));
    expect(back.project).toEqual(pruneUnusedAssets(p));
    expect(back.project.character.generations[0]!.provenance.guideAssetIds.pose).toBe('guide1');
    for (const id of ['ref-jpg', 'ref-webp', 'orig']) expect([...back.assets.get(id)!.bytes]).toEqual([...assets.get(id)!.bytes]);
  });
  it('rejects a bundle whose JPEG asset is not a JPEG', () => {
    const p = populated();
    p.assets.push({ id: 'ref-jpg', kind: 'reference', mime: 'image/jpeg', width: 5, height: 5, size: 1 });
    p.character = addReference(p.character, ref('rj', 'ref-jpg'));
    const assets = assetsFor(p);
    assets.get('ref-jpg')!.bytes = png(0); // PNG bytes under a JPEG mime
    p.assets.find((a) => a.id === 'ref-jpg')!.size = assets.get('ref-jpg')!.bytes.byteLength;
    expect(() => importBundle(exportBundle(p, assets, '0.2.0', 1))).toThrow('not a valid JPEG');
  });
  it('imports a bundle written by the previous release (schema v1, no character) and upgrades it', () => {
    const v2 = validProject();
    const assets = assetsFor(v2);
    const files = unzipSync(exportBundle(v2, assets, '0.1.0', 1));
    const v1 = legacyV1Project();
    (v1.assets as { size: number }[]).forEach((x, i) => (x.size = png(i).byteLength));
    files['project.json'] = strToU8(JSON.stringify(v1));
    const back = importBundle(zipSync(files));
    expect(back.migratedFrom).toBe(1);
    expect(back.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(back.project.character.originalAssetId).toBe('asset_l1');
    expect(back.project.doc).toEqual(v1.doc);
    expect([...back.assets.get('asset_l1')!.bytes]).toEqual([...assets.get('asset_l1')!.bytes]);
  });

  let db: CharacterForgeDB;
  let n = 0;
  beforeEach(() => {
    db = new CharacterForgeDB(`char-test-${++n}`);
  });
  it('saves and reopens a character profile with identical data', async () => {
    const p = populated();
    const assets = assetsFor(p);
    await saveProject(db, p, [...assets.values()]);
    const back = await loadProject(db, p.id);
    expect(back.project).toEqual(p);
    expect(back.migratedFrom).toBeNull();
    expect(back.assets.size).toBe(p.assets.length);
  });
  it('reopens a project saved by the previous release (v1) and upgrades it', async () => {
    const v1 = legacyV1Project() as unknown as ProjectFile;
    const assets = assetsFor(v1);
    await db.projects.put({ id: v1.id, name: v1.name, createdAt: 1, updatedAt: 2, data: v1 });
    await db.assets.bulkPut([...assets.values()].map((a) => ({ key: `${v1.id}/${a.id}`, projectId: v1.id, ...a })));
    const back = await loadProject(db, v1.id);
    expect(back.migratedFrom).toBe(1);
    expect(back.project.character.originalAssetId).toBe('asset_l1');
    expect(back.project.doc).toEqual(v1.doc);
  });
  it('refuses to open a character whose result image is missing from storage', async () => {
    const p = populated();
    const assets = assetsFor(p);
    assets.delete('out1');
    await saveProject(db, p, [...assets.values()]);
    await expect(loadProject(db, p.id)).rejects.toThrow('incomplete');
  });
});

describe('schema v3 migration (character body and artwork projection)', () => {
  it('upgrades a v2 project, adds the new settings at their defaults and keeps everything else', () => {
    const v2 = legacyV2Project() as unknown as { character: { studio: Record<string, unknown> } };
    expect('shape' in v2.character.studio).toBe(false);
    expect('artwork' in v2.character.studio).toBe(false);
    v2.character.studio.proportions = { ...(v2.character.studio.proportions as object), height: 1.9, shoulders: 1.2 };
    v2.character.studio.pose = setRot(restPose(), 'head', { y: 25 });
    const before = structuredClone(v2.character.studio);
    const { project, migratedFrom } = parseProject(structuredClone(v2));
    expect(migratedFrom).toBe(2);
    expect(project.schemaVersion).toBe(3);
    const st = project.character.studio;
    expect(st.shape).toEqual(DEFAULT_SHAPE);
    expect(st.artwork.front).toBeNull();
    expect(st.artwork.back).toBeNull();
    expect(st.artwork.bakedPose).toBeNull();
    expect(st.artwork.show).toBe(true);
    expect(st.proportions).toEqual(before.proportions);
    expect(st.pose).toEqual(before.pose);
    expect(st.camera).toEqual(before.camera);
    expect(st.output).toEqual(before.output);
  });

  it('keeps saved poses, references and results of a v2 project', () => {
    const p = populated();
    const { shape: _s, artwork: _a, ...studio } = p.character.studio;
    void _s;
    void _a;
    const v2 = { ...p, schemaVersion: 2, character: { ...p.character, studio } };
    const back = parseProject(structuredClone(v2)).project;
    expect(back.character.studio.poses).toEqual(p.character.studio.poses);
    expect(back.character.references).toEqual(p.character.references);
    expect(back.character.generations).toEqual(p.character.generations); // old results have no `shape` in their provenance: still valid
    expect(back.character.generations[0]!.provenance.shape).toBeUndefined();
  });

  it('upgrades a v1 project all the way to v3 in one go', () => {
    const { project, migratedFrom } = parseProject(legacyV1Project());
    expect(migratedFrom).toBe(1);
    expect(project.schemaVersion).toBe(3);
    expect(project.character.studio.shape).toEqual(DEFAULT_SHAPE);
    expect(project.character.studio.artwork.front).toBeNull();
  });

  it('is stable: a migrated project is saved and re-read without further changes', () => {
    const { project } = parseProject(legacyV2Project());
    const again = parseProject(JSON.parse(JSON.stringify(project)));
    expect(again.migratedFrom).toBeNull();
    expect(again.project).toEqual(project);
  });

  it('does not mutate the data it migrates', () => {
    const v2 = legacyV2Project();
    const copy = structuredClone(v2);
    parseProject(v2);
    expect(v2).toEqual(copy);
  });

  it('leaves a damaged v2 project for validation to report instead of crashing', () => {
    const v2 = legacyV2Project() as { character: unknown };
    v2.character = 'nope';
    let details = '';
    try {
      parseProject(v2);
    } catch (e) {
      details = ((e as { details?: string[] }).details ?? []).join(' ');
    }
    expect(details).toMatch(/character/);
  });
});

describe('schema v3 validation', () => {
  const withStudio = (patch: Record<string, unknown>) => {
    const p = populated();
    return { ...p, character: { ...p.character, studio: { ...p.character.studio, ...patch } } } as unknown;
  };
  const projected = (extra: Record<string, unknown> = {}) => ({
    front: { assetId: 'orig', width: 600, height: 900, fit: { ppm: 500, ox: 300, oy: 880 } },
    back: null,
    bakedPose: restPose(),
    show: true,
    fill: '#aabbcc',
    shading: 0.4,
    overlay: { show: true, opacity: 0.5 },
    ...extra,
  });
  const errs = (p: unknown) => {
    const r = validateProjectFile(p);
    return r.ok ? [] : r.errors;
  };

  it('accepts a projected artwork and an adjusted body', () => {
    expect(errs(withStudio({ artwork: projected(), shape: { ...DEFAULT_SHAPE, chest: 1.3 } }))).toEqual([]);
  });
  it('rejects out-of-range or missing body shape values', () => {
    expect(errs(withStudio({ shape: { ...DEFAULT_SHAPE, chest: 9 } })).join(' ')).toMatch(/shape\.chest/);
    expect(errs(withStudio({ shape: undefined })).join(' ')).toMatch(/shape/);
  });
  it('rejects artwork that points at an unknown asset, has a bad fit or has no baked pose', () => {
    expect(errs(withStudio({ artwork: projected({ front: { assetId: 'nope', width: 6, height: 9, fit: { ppm: 1, ox: 0, oy: 0 } } }) })).join(' ')).toMatch(/unknown asset/);
    expect(errs(withStudio({ artwork: projected({ front: { assetId: 'orig', width: 600, height: 900, fit: { ppm: 0, ox: 0, oy: 0 } } }) })).join(' ')).toMatch(/ppm/);
    expect(errs(withStudio({ artwork: projected({ bakedPose: null }) })).join(' ')).toMatch(/bakedPose/);
  });
  it('rejects a bad fill colour, shading and overlay opacity', () => {
    expect(errs(withStudio({ artwork: projected({ fill: 'red' }) })).join(' ')).toMatch(/fill/);
    expect(errs(withStudio({ artwork: projected({ shading: 2 }) })).join(' ')).toMatch(/shading/);
    expect(errs(withStudio({ artwork: projected({ overlay: { show: true, opacity: -1 } }) })).join(' ')).toMatch(/overlay/);
  });
  it('treats projected images as referenced assets (they survive pruning and bundles)', () => {
    const p = populated();
    p.character = updateStudio(p.character, { artwork: { ...p.character.studio.artwork, front: { assetId: 'old', width: 10, height: 10, fit: { ppm: 100, ox: 5, oy: 9 } }, bakedPose: restPose() } });
    expect(referencedAssetIds(p).has('old')).toBe(true);
    const assets = assetsFor(p);
    const back = importBundle(exportBundle(p, assets, '0.3.0', 1));
    expect(back.project.character.studio.artwork.front!.assetId).toBe('old');
    expect(back.project.character.studio).toEqual(p.character.studio);
  });
  it('accepts the new textured guide in result provenance', () => {
    const p = populated();
    p.character.generations[0]!.provenance.guideAssetIds = { textured: 'guide1' };
    p.character.generations[0]!.provenance.shape = { ...DEFAULT_SHAPE };
    expect(errs(p)).toEqual([]);
    p.character.generations[0]!.provenance.shape = { ...DEFAULT_SHAPE, arms: 7 };
    expect(errs(p).join(' ')).toMatch(/provenance\.shape/);
  });
});
