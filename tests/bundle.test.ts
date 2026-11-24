import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION, ProjectFormatError } from '../src/core/migrations.ts';
import { BUNDLE_FORMAT, BUNDLE_LIMITS, exportBundle, importBundle } from '../src/storage/bundle.ts';
import type { AssetData } from '../src/storage/projectService.ts';
import { validProject } from './helpers.ts';

/** Minimal valid PNG header (signature + IHDR) — enough for signature/size sniffing. */
function fakePng(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
}

function fixture() {
  const project = validProject();
  const assets = new Map<string, AssetData>();
  project.assets.forEach((a, i) => {
    const bytes = fakePng(100, 50, i + 1);
    a.size = bytes.byteLength;
    assets.set(a.id, { id: a.id, kind: a.kind, mime: a.mime, width: a.width, height: a.height, bytes });
  });
  return { project, assets };
}

describe('project bundle', () => {
  it('round-trips project data and asset bytes exactly', () => {
    const { project, assets } = fixture();
    const zip = exportBundle(project, assets, '0.1.0', 99);
    const back = importBundle(zip);
    expect(back.project).toEqual(project);
    for (const [id, a] of assets) expect([...back.assets.get(id)!.bytes]).toEqual([...a.bytes]);
  });
  it('drops unreferenced assets on export', () => {
    const { project, assets } = fixture();
    project.assets.push({ id: 'orphan', kind: 'mask', mime: 'image/png', width: 1, height: 1, size: 33 });
    assets.set('orphan', { id: 'orphan', kind: 'mask', mime: 'image/png', width: 1, height: 1, bytes: fakePng(1, 1) });
    const back = importBundle(exportBundle(project, assets, '0.1.0', 1));
    expect(back.project.assets.some((a) => a.id === 'orphan')).toBe(false);
  });
  it('refuses to export when an asset is missing from memory', () => {
    const { project, assets } = fixture();
    assets.delete('asset_l2');
    expect(() => exportBundle(project, assets, '0.1.0', 1)).toThrow('missing');
  });
  it('rejects random bytes and foreign ZIPs', () => {
    expect(() => importBundle(new Uint8Array([1, 2, 3, 4]))).toThrow('not a readable');
    expect(() => importBundle(zipSync({ 'hello.txt': strToU8('hi') }))).toThrow('manifest.json');
    expect(() => importBundle(zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'other' })) }))).toThrow('not a CharacterForge');
  });
  it('rejects bundles from a newer bundle or schema version', () => {
    const { project, assets } = fixture();
    const zip = exportBundle(project, assets, '0.1.0', 1);
    const files = { ...importRaw(zip) };
    files['manifest.json'] = strToU8(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(files['manifest.json'])), bundleVersion: 99 }));
    expect(() => importBundle(zipSync(files))).toThrow('newer version');
    const files2 = { ...importRaw(zip) };
    files2['project.json'] = strToU8(JSON.stringify({ ...project, schemaVersion: 99 }));
    expect(() => importBundle(zipSync(files2))).toThrow('newer version');
  });
  it('detects damaged images and missing images', () => {
    const { project, assets } = fixture();
    const files = importRaw(exportBundle(project, assets, '0.1.0', 1));
    const key = Object.keys(files).find((k) => k.startsWith('assets/'))!;
    const broken = { ...files, [key]: new Uint8Array(files[key]!.length) };
    expect(() => importBundle(zipSync(broken))).toThrow('not a valid PNG');
    // The fixture's fake PNGs are only ~34 bytes, so truncate relative to their real length (one byte short).
    const short = { ...files, [key]: files[key]!.slice(0, files[key]!.length - 1) };
    expect(() => importBundle(zipSync(short))).toThrow('size mismatch');
    const { [key]: _gone, ...without } = files;
    void _gone;
    expect(() => importBundle(zipSync(without))).toThrow('incomplete');
  });
  it('rejects invalid project JSON', () => {
    const { project, assets } = fixture();
    const files = importRaw(exportBundle(project, assets, '0.1.0', 1));
    files['project.json'] = strToU8('{nope');
    expect(() => importBundle(zipSync(files))).toThrow('not valid JSON');
    expect(BUNDLE_FORMAT).toBe('characterforge-bundle');
  });
});

import { unzipSync } from 'fflate';
function importRaw(zip: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zip);
}


describe('hostile bundles', () => {
  const base = () => {
    const { project, assets } = fixture();
    const files = importRaw(exportBundle(project, assets, '0.1.0', 1));
    return { project, assets, files };
  };
  const manifestOf = (files: Record<string, Uint8Array>) => JSON.parse(new TextDecoder().decode(files['manifest.json']));
  const withManifest = (files: Record<string, Uint8Array>, m: unknown) => ({ ...files, 'manifest.json': strToU8(JSON.stringify(m)) });

  /** Rewrite the uncompressed size an entry DECLARES (central directory and local header), as a bomb's author would. */
  const declare = (zip: Uint8Array, sizes: Record<string, number>): Uint8Array => {
    const out = zip.slice();
    const dv = new DataView(out.buffer);
    for (let i = 0; i + 46 < out.length; i++) {
      const central = dv.getUint32(i, true) === 0x02014b50;
      const local = dv.getUint32(i, true) === 0x04034b50;
      if (!central && !local) continue;
      const nameLen = dv.getUint16(i + (central ? 28 : 26), true);
      const name = new TextDecoder().decode(out.subarray(i + (central ? 46 : 30), i + (central ? 46 : 30) + nameLen));
      if (name in sizes) dv.setUint32(i + (central ? 24 : 22), sizes[name]!, true);
    }
    return out;
  };

  it('refuses a bundle in which a single byte of an image was changed (ZIP checksum)', () => {
    const { project, assets } = fixture();
    const zip = exportBundle(project, assets, '0.1.0', 1);
    // find the stored (or deflated) bytes of the first image entry and flip one bit in the middle of them
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    let flipped = false;
    for (let i = 0; i + 30 < zip.length && !flipped; i++) {
      if (dv.getUint32(i, true) !== 0x04034b50) continue;
      const nameLen = dv.getUint16(i + 26, true), extraLen = dv.getUint16(i + 28, true), size = dv.getUint32(i + 18, true);
      const name = new TextDecoder().decode(zip.subarray(i + 30, i + 30 + nameLen));
      if (name.startsWith('assets/') && size > 8) {
        const bad = zip.slice();
        bad[i + 30 + nameLen + extraLen + (size >> 1)]! ^= 0x01;
        expect(() => importBundle(bad)).toThrow(/damaged|not a readable/);
        flipped = true;
      }
    }
    expect(flipped).toBe(true);
    expect(() => importBundle(zip)).not.toThrow(); // the untouched bundle still opens
  });

  it('refuses a zip bomb by its declared sizes, in total as well as per entry, before inflating', () => {
    const { files } = base();
    const tiny = new Uint8Array(1000);
    const names = Array.from({ length: 30 }, (_, i) => `assets/bomb${i}.png`);
    const many = zipSync({ ...files, ...Object.fromEntries(names.map((n) => [n, tiny])) } as never);
    // 30 entries that each CLAIM 40 MB: 1.2 GB in total, from a file of a few KB
    const total = declare(many, Object.fromEntries(names.map((n) => [n, 40 * 1024 * 1024])));
    expect(total.byteLength).toBeLessThan(200_000);
    expect(() => importBundle(total)).toThrow(/larger than .* when unpacked/);
    const single = declare(zipSync({ ...files, 'assets/huge.png': tiny } as never), { 'assets/huge.png': 300 * 1024 * 1024 });
    expect(() => importBundle(single)).toThrow(/larger than 256 MB/);
    const proj = declare(zipSync(files as never), { 'project.json': 70 * 1024 * 1024 });
    expect(() => importBundle(proj)).toThrow(/project\.json.* larger than 64 MB/);
  });
  it('refuses a bundle file that is itself too large without trying to read it', () => {
    const big = { byteLength: BUNDLE_LIMITS.fileBytes + 1 } as unknown as Uint8Array;
    expect(() => importBundle(big)).toThrow(/larger than 1024 MB/);
  });
  it('does not trust sizes declared inside the zip: a lying entry cannot overflow, it just fails the size check', () => {
    const { files } = base();
    const key = Object.keys(files).find((k) => k.startsWith('assets/'))!;
    const zip = zipSync({ ...files, [key]: [new Uint8Array(5000).fill(1), { level: 6 }] } as never);
    const dv = new DataView(zip.buffer, zip.byteOffset);
    for (let i = 0; i + 30 < zip.length; i++) {
      if (dv.getUint32(i, true) === 0x02014b50 && new TextDecoder().decode(zip.subarray(i + 46, i + 46 + key.length)) === key) dv.setUint32(i + 24, 10, true);
      if (dv.getUint32(i, true) === 0x04034b50 && new TextDecoder().decode(zip.subarray(i + 30, i + 30 + key.length)) === key) dv.setUint32(i + 22, 10, true);
    }
    expect(() => importBundle(zip)).toThrow(/damaged|not a valid|size mismatch|readable/);
  });
  it('rejects duplicate entries and path tricks', () => {
    const { files } = base();
    const key = Object.keys(files).find((k) => k.startsWith('assets/'))!;
    const stray = importBundle(zipSync({ ...files, '../evil.png': files[key]!, 'assets/../evil.png': files[key]!, 'assets/sub/x.png': files[key]!, '/abs.png': files[key]! }));
    expect([...stray.assets.keys()].every((id) => stray.project.assets.some((a) => a.id === id))).toBe(true); // stray names are ignored, not extracted
    // a hand-built zip with the same name twice
    const raw = zipSync({ [key]: files[key]!, ['a'.repeat(key.length - 1) + 'x']: files[key]!, 'manifest.json': files['manifest.json']!, 'project.json': files['project.json']! });
    const dv = new DataView(raw.buffer, raw.byteOffset);
    const dupName = 'a'.repeat(key.length - 1) + 'x';
    const enc = new TextEncoder().encode(key);
    for (let i = 0; i + 46 + key.length < raw.length; i++) {
      for (const [sig, off] of [[0x02014b50, 46], [0x04034b50, 30]] as const) {
        if (dv.getUint32(i, true) === sig && new TextDecoder().decode(raw.subarray(i + off, i + off + dupName.length)) === dupName) raw.set(enc, i + off);
      }
    }
    expect(() => importBundle(raw)).toThrow(/duplicate entry/);
  });
  it('the manifest cannot redirect an image to project.json or another file', () => {
    const { files } = base();
    const m = manifestOf(files);
    m.assets[0].path = 'project.json';
    expect(() => importBundle(zipSync(withManifest(files, m)))).toThrow(/missing/);
    const m2 = manifestOf(files);
    m2.assets[0].path = m2.assets[1].path;
    expect(() => importBundle(zipSync(withManifest(files, m2)))).toThrow(/missing/);
  });
  it('rejects malformed manifests', () => {
    const { files } = base();
    for (const bad of [null, [], 'x', { format: BUNDLE_FORMAT, bundleVersion: 1 }, { format: BUNDLE_FORMAT, bundleVersion: 1, assets: [null] }, { format: BUNDLE_FORMAT, bundleVersion: 1, assets: [{ id: 5, path: 'x', mime: 'y' }] }]) {
      expect(() => importBundle(zipSync(withManifest(files, bad)))).toThrow(ProjectFormatError);
    }
    const dup = manifestOf(files);
    dup.assets.push(dup.assets[0]);
    expect(() => importBundle(zipSync(withManifest(files, dup)))).toThrow(/twice/);
  });
  it('rejects images whose header disagrees with the project, or claims an absurd size', () => {
    const { project, assets } = fixture();
    const wrong = structuredClone(project);
    wrong.assets[0]!.width = 999; // the PNG header says 100x50
    expect(() => importBundle(exportBundle(wrong, assets, '0.1.0', 1))).toThrow(/is 100×50px but the project says 999×50px/);
    const bombAssets = new Map(assets);
    const first = project.assets[0]!;
    const bomb = structuredClone(project);
    bomb.assets[0]!.width = 60000;
    bomb.assets[0]!.height = 60000;
    bombAssets.set(first.id, { ...assets.get(first.id)!, width: 60000, height: 60000, bytes: fakePng(60000, 60000, 1) });
    bomb.assets[0]!.size = bombAssets.get(first.id)!.bytes.byteLength;
    expect(() => importBundle(exportBundle(bomb, bombAssets, '0.1.0', 1))).toThrow(/larger than the supported maximum|invalid or damaged/);
  });
  it('rejects a project that refers to images it does not list', () => {
    const { project, assets } = fixture();
    const broken = structuredClone(project);
    broken.sources[0]!.assetId = 'asset_ghost';
    expect(() => importBundle(exportBundle(broken, assets, '0.1.0', 1))).toThrow(/does not list|invalid or damaged|missing/);
  });
  it('imports an older-schema bundle through the migrations without touching the bytes', () => {
    const { project, assets } = fixture();
    const { shape: _s, artwork: _a, ...studioV2 } = project.character.studio as unknown as Record<string, unknown>;
    void _s;
    void _a;
    const files = importRaw(exportBundle(project, assets, '0.1.0', 1));
    files['project.json'] = strToU8(JSON.stringify({ ...project, schemaVersion: 2, character: { ...project.character, studio: studioV2 } }));
    const back = importBundle(zipSync(files));
    expect(back.migratedFrom).toBe(2);
    expect(back.project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    for (const [id, a] of assets) expect([...back.assets.get(id)!.bytes]).toEqual([...a.bytes]);
  });
  it('migrations do not mutate the data they are given', async () => {
    const { migrateProjectData } = await import('../src/core/migrations.ts');
    const { project } = fixture();
    const { shape: _s, artwork: _a, ...studioV2 } = project.character.studio as unknown as Record<string, unknown>;
    void _s;
    void _a;
    const v2 = { ...project, schemaVersion: 2, character: { ...project.character, studio: studioV2 } };
    const frozen = structuredClone(v2);
    const deepFreeze = (o: unknown): void => { if (o && typeof o === 'object') { Object.freeze(o); Object.values(o).forEach(deepFreeze); } };
    deepFreeze(v2);
    const out = migrateProjectData(v2);
    expect(out.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(v2).toEqual(frozen);
  });
});
