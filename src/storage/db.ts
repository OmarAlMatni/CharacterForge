import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { AssetKind, ID, ProjectFile } from '../core/types.ts';

export interface ProjectRecord {
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  data: ProjectFile;
}

/** Binary asset. Stored as raw bytes (not Blob) for portability and testability. */
export interface AssetRecord {
  /** `${projectId}/${assetId}` */
  key: string;
  projectId: ID;
  id: ID;
  kind: AssetKind;
  mime: string;
  width: number;
  height: number;
  bytes: Uint8Array;
}

/**
 * The stored project exactly as it was before a schema migration rewrote it. A migration only ever happens in memory when a project is
 * opened; the next autosave then replaces the stored v(N) data with v(N+1). This is the copy that survives that.
 */
export interface MigrationBackup {
  /** `${projectId}@v${fromVersion}` */
  key: string;
  projectId: ID;
  fromVersion: number;
  savedAt: number;
  /** The untouched stored project JSON. */
  data: unknown;
}

export class CharacterForgeDB extends Dexie {
  declare projects: Table<ProjectRecord, string>;
  declare assets: Table<AssetRecord, string>;
  declare backups: Table<MigrationBackup, string>;

  constructor(name = 'characterforge') {
    super(name);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      assets: 'key, projectId',
    });
    // v2 only ADDS a table: existing projects and assets are not touched by the upgrade
    this.version(2).stores({
      projects: 'id, updatedAt, name',
      assets: 'key, projectId',
      backups: 'key, projectId',
    });
  }
}

let shared: CharacterForgeDB | null = null;
export function getDb(): CharacterForgeDB {
  return (shared ??= new CharacterForgeDB());
}
