import type { Layer, SourceInfo } from '../core/types.ts';
import type { AssetData } from '../storage/projectService.ts';

export interface ImportResult {
  source: SourceInfo;
  /** New assets, including the untouched original file. */
  assets: AssetData[];
  /** New layers in paint order (bottom → top), parents before children. */
  layers: Layer[];
  /** Natural canvas size of the artwork (used when the project has no layers yet). */
  canvas: { width: number; height: number };
  warnings: string[];
}

/** Error with a message that is safe to show directly to the artist. */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}
