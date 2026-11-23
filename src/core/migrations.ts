import { emptyArtwork, emptyCharacter } from './character.ts';
import { DEFAULT_SHAPE } from '../pose/bodyShape.ts';

export const CURRENT_SCHEMA_VERSION = 3;

export class ProjectFormatError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'ProjectFormatError';
    this.details = details;
  }
}

/** A migration upgrades data from version N to N+1. The registry is keyed by N. */
export type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Registered migrations, keyed by the version they upgrade FROM.
 *  v1 -> v2: adds the `character` profile (original artwork, references, 3D studio, generated results).
 *            The first PNG source the project already preserved becomes the profile's original artwork, so existing
 *            projects keep their source image. Nothing in `doc`, `assets` or `sources` is changed.
 *  v2 -> v3: the capsule mannequin became a character body. The studio gets `shape` (body thickness controls, all at their
 *            defaults) and `artwork` (projection of the drawing onto the body, empty). Existing proportions, poses, cameras,
 *            references and results are untouched, so a project looks the same until the artist changes the new settings.
 */
export const MIGRATIONS: Record<number, Migration> = {
  1: (d) => {
    const sources = Array.isArray(d.sources) ? (d.sources as unknown[]) : [];
    const firstPng = sources.find((s): s is { assetId: string } => typeof s === 'object' && s !== null && (s as { kind?: unknown }).kind === 'png' && typeof (s as { assetId?: unknown }).assetId === 'string');
    // build the character as schema v2 stored it: the body shape and artwork projection only arrive with v3
    const { shape: _shape, artwork: _artwork, ...studioV2 } = emptyCharacter(firstPng ? firstPng.assetId : null).studio;
    void _shape;
    void _artwork;
    return { ...d, schemaVersion: 2, character: { ...emptyCharacter(firstPng ? firstPng.assetId : null), studio: studioV2 } };
  },
  2: (d) => {
    const c = d.character;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return { ...d, schemaVersion: 3 }; // left for validation to report
    const char = c as Record<string, unknown>;
    const st = char.studio;
    if (typeof st !== 'object' || st === null || Array.isArray(st)) return { ...d, schemaVersion: 3 };
    const studio = { ...(st as Record<string, unknown>) };
    if (studio.shape === undefined) studio.shape = { ...DEFAULT_SHAPE };
    if (studio.artwork === undefined) studio.artwork = emptyArtwork();
    return { ...d, schemaVersion: 3, character: { ...char, studio } };
  },
};

export function migrateProjectData(
  raw: unknown,
  registry: Record<number, Migration> = MIGRATIONS,
  target: number = CURRENT_SCHEMA_VERSION,
): { data: Record<string, unknown>; migratedFrom: number | null } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectFormatError('Project data is not a JSON object.');
  }
  let data = raw as Record<string, unknown>;
  const from = data.schemaVersion;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 1) {
    throw new ProjectFormatError('Project data has no valid schemaVersion.');
  }
  if (from > target) {
    throw new ProjectFormatError(
      `This project was saved by a newer version of CharacterForge (schema ${from}; this build supports up to ${target}). Update the app to open it.`,
    );
  }
  let v = from;
  while (v < target) {
    const step = registry[v];
    if (!step) throw new ProjectFormatError(`No migration available from schema version ${v}.`);
    data = step(data);
    if (data.schemaVersion !== v + 1) throw new ProjectFormatError(`Migration from version ${v} did not set schemaVersion to ${v + 1}.`);
    v += 1;
  }
  return { data, migratedFrom: from === target ? null : from };
}
