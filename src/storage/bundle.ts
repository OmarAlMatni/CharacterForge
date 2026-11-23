import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { ID_PATTERN } from '../core/ids.ts';
import { imageSize, looksLikeMime } from '../core/files.ts';
import { ProjectFormatError } from '../core/migrations.ts';
import { parseProject, pruneUnusedAssets, referencedAssetIds } from '../core/project.ts';
import { LIMITS } from '../core/schema.ts';
import type { ID, ProjectFile } from '../core/types.ts';
import type { AssetData } from './projectService.ts';

export const BUNDLE_FORMAT = 'characterforge-bundle';
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = '.cfbundle';
const MiB = 1024 * 1024;
/**
 * Limits applied while reading a bundle. A ZIP can be a few hundred KB and inflate to gigabytes (a "zip bomb"), and the sizes it
 * declares are the attacker's, so every limit is checked against the DECLARED size before anything is inflated, in total as well as
 * per entry.
 */
export const BUNDLE_LIMITS = {
  /** the .cfbundle file itself */
  fileBytes: 1024 * MiB,
  /** all accepted entries together, uncompressed */
  totalBytes: 1024 * MiB,
  /** one image */
  assetBytes: 256 * MiB,
  /** project.json */
  projectBytes: 64 * MiB,
  /** manifest.json */
  manifestBytes: 8 * MiB,
  entries: 20000,
} as const;

interface Manifest {
  format: typeof BUNDLE_FORMAT;
  bundleVersion: number;
  appVersion: string;
  createdAt: number;
  project: 'project.json';
  assets: { id: ID; path: string; mime: string; size: number }[];
}

const extFor = (mime: string): string => (mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : mime === 'image/vnd.adobe.photoshop' ? 'psd' : 'bin');

/**
 * Portable project archive (ZIP): manifest.json + project.json + assets/<id>.<ext>.
 * Only assets the project still references are included (unused edit history is dropped).
 */
export function exportBundle(project: ProjectFile, assets: Map<ID, AssetData>, appVersion: string, now: number): Uint8Array {
  const pruned = pruneUnusedAssets(project);
  const files: Zippable = {};
  const manifest: Manifest = { format: BUNDLE_FORMAT, bundleVersion: BUNDLE_VERSION, appVersion, createdAt: now, project: 'project.json', assets: [] };
  for (const info of pruned.assets) {
    const data = assets.get(info.id);
    if (!data) throw new Error(`Cannot export: image "${info.id}" is missing from memory.`);
    const path = `assets/${info.id}.${extFor(info.mime)}`;
    files[path] = [data.bytes, { level: 0 }]; // PNG/PSD are already compressed
    manifest.assets.push({ id: info.id, path, mime: info.mime, size: data.bytes.byteLength });
  }
  files['project.json'] = [strToU8(JSON.stringify(pruned, null, 2)), { level: 6 }];
  files['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }];
  return zipSync(files);
}

export interface ImportedBundle {
  project: ProjectFile;
  assets: Map<ID, AssetData>;
  migratedFrom: number | null;
}

function readJson(entries: Record<string, Uint8Array>, name: string): unknown {
  const raw = entries[name];
  if (!raw) throw new ProjectFormatError(`This is not a CharacterForge bundle: "${name}" is missing.`);
  try {
    return JSON.parse(strFromU8(raw));
  } catch {
    throw new ProjectFormatError(`"${name}" in the bundle is not valid JSON.`);
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The CRC-32 each entry was stored with, read from the ZIP's central directory (fflate inflates entries but does not check them). */
function storedCrcs(bytes: Uint8Array): Map<string, number> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no ZIP directory');
  const total = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || at === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const out = new Map<string, number>();
  for (let n = 0; n < total; n++) {
    if (at + 46 > bytes.length || dv.getUint32(at, true) !== 0x02014b50) throw new Error('damaged ZIP directory');
    const nameLen = dv.getUint16(at + 28, true), extraLen = dv.getUint16(at + 30, true), commentLen = dv.getUint16(at + 32, true);
    if (at + 46 + nameLen > bytes.length) throw new Error('damaged ZIP directory');
    out.set(strFromU8(bytes.subarray(at + 46, at + 46 + nameLen)), dv.getUint32(at + 16, true));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Every entry we read must match the checksum it was written with, so a flipped bit in an image or in project.json is refused instead of imported. */
function verifyChecksums(bytes: Uint8Array, entries: Record<string, Uint8Array>): void {
  const stored = storedCrcs(bytes);
  for (const [name, data] of Object.entries(entries)) {
    const want = stored.get(name);
    if (want === undefined) throw new Error(`"${name}" has no checksum`);
    if (crc32(data) !== want) throw new Error(`"${name}" is damaged (checksum mismatch)`);
  }
}

/** Parse and fully validate a bundle. Throws ProjectFormatError with a readable message. */
export function importBundle(bytes: Uint8Array): ImportedBundle {
  if (bytes.byteLength > BUNDLE_LIMITS.fileBytes) throw new ProjectFormatError(`The file is larger than ${BUNDLE_LIMITS.fileBytes / MiB} MB, the biggest bundle this app opens.`);
  let entries: Record<string, Uint8Array>;
  let count = 0;
  let declared = 0;
  const seen = new Set<string>();
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (++count > BUNDLE_LIMITS.entries) throw new Error('too many entries');
        const wanted = f.name === 'manifest.json' || f.name === 'project.json' || /^assets\/[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,5}$/.test(f.name);
        if (!wanted) return false;
        if (seen.has(f.name)) throw new Error(`duplicate entry "${f.name}"`);
        seen.add(f.name);
        const cap = f.name === 'project.json' ? BUNDLE_LIMITS.projectBytes : f.name === 'manifest.json' ? BUNDLE_LIMITS.manifestBytes : BUNDLE_LIMITS.assetBytes;
        if (f.originalSize > cap) throw new Error(`"${f.name}" is larger than ${cap / MiB} MB`);
        declared += f.originalSize;
        if (declared > BUNDLE_LIMITS.totalBytes) throw new Error(`the contents are larger than ${BUNDLE_LIMITS.totalBytes / MiB} MB when unpacked`);
        return true;
      },
    });
    verifyChecksums(bytes, entries);
  } catch (e) {
    throw new ProjectFormatError(`The file is not a readable CharacterForge bundle (${e instanceof Error ? e.message : 'invalid ZIP'}).`);
  }
  const manifest = readJson(entries, 'manifest.json') as Partial<Manifest>;
  if (typeof manifest !== 'object' || manifest === null || manifest.format !== BUNDLE_FORMAT) throw new ProjectFormatError('This ZIP is not a CharacterForge bundle.');
  if (typeof manifest.bundleVersion !== 'number' || manifest.bundleVersion > BUNDLE_VERSION) {
    throw new ProjectFormatError('This bundle was created by a newer version of CharacterForge. Update the app to open it.');
  }
  if (!Array.isArray(manifest.assets)) throw new ProjectFormatError('The bundle manifest has no image list.');
  const { project, migratedFrom } = parseProject(readJson(entries, 'project.json'));
  const listed = new Map<string, Manifest['assets'][number]>();
  for (const a of manifest.assets) {
    if (typeof a !== 'object' || a === null || typeof a.id !== 'string' || typeof a.path !== 'string' || typeof a.mime !== 'string') throw new ProjectFormatError('The bundle manifest lists an invalid image.');
    if (listed.has(a.id)) throw new ProjectFormatError(`The bundle manifest lists image "${a.id}" twice.`);
    listed.set(a.id, a);
  }
  const known = new Set(project.assets.map((a) => a.id));
  if (known.size !== project.assets.length) throw new ProjectFormatError('The project lists the same image twice.');
  const dangling = [...referencedAssetIds(project)].filter((id) => !known.has(id));
  if (dangling.length) throw new ProjectFormatError(`The project refers to ${dangling.length} image(s) it does not list ("${dangling[0]}").`, dangling);
  const assets = new Map<ID, AssetData>();
  for (const info of project.assets) {
    const entry = listed.get(info.id);
    if (!ID_PATTERN.test(info.id)) throw new ProjectFormatError(`The bundle is incomplete: image "${info.id}" has an invalid id.`);
    // the manifest may only point at the file name the exporter would have used, never at project.json or another image
    const raw = entry && entry.path === `assets/${info.id}.${extFor(info.mime)}` ? entries[entry.path] : undefined;
    if (!entry || !raw) throw new ProjectFormatError(`The bundle is incomplete: image "${info.id}" is missing.`);
    if (raw.byteLength !== info.size) throw new ProjectFormatError(`Image "${info.id}" is damaged (size mismatch).`);
    if (info.mime === 'image/png' && !looksLikeMime(raw, info.mime)) throw new ProjectFormatError(`Image "${info.id}" is not a valid PNG.`);
    if ((info.mime === 'image/jpeg' || info.mime === 'image/webp') && !looksLikeMime(raw, info.mime)) throw new ProjectFormatError(`Image "${info.id}" is not a valid ${info.mime === 'image/jpeg' ? 'JPEG' : 'WebP'} file.`);
    if (info.mime === 'image/vnd.adobe.photoshop' && !looksLikeMime(raw, info.mime)) throw new ProjectFormatError(`Image "${info.id}" is not a valid PSD file.`);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/vnd.adobe.photoshop'].includes(info.mime)) throw new ProjectFormatError(`Image "${info.id}" has an unsupported type (${info.mime.slice(0, 40)}).`);
    // what the file header says must agree with what the project says, and must be a size the app can handle
    const real = imageSize(raw, info.mime);
    if (info.mime !== 'image/vnd.adobe.photoshop') {
      if (!real) throw new ProjectFormatError(`Image "${info.id}" has an unreadable header.`);
      const same = (real.width === info.width && real.height === info.height) || (real.width === info.height && real.height === info.width); // EXIF-rotated photos are swapped
      if (!same) throw new ProjectFormatError(`Image "${info.id}" is ${real.width}×${real.height}px but the project says ${info.width}×${info.height}px.`);
      if (real.width < 1 || real.height < 1 || real.width > LIMITS.maxCanvas || real.height > LIMITS.maxCanvas || real.width * real.height > LIMITS.maxPixels) {
        throw new ProjectFormatError(`Image "${info.id}" is ${real.width}×${real.height}px, larger than the supported maximum.`);
      }
    }
    assets.set(info.id, { id: info.id, kind: info.kind, mime: info.mime, width: info.width, height: info.height, bytes: raw });
  }
  return { project, assets, migratedFrom };
}
