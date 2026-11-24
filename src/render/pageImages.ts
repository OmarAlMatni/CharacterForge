import type { ID } from '../core/types.ts';
import type { AssetData } from '../storage/projectService.ts';
import { decodeToCanvas } from './pngEncode.ts';

/**
 * Decoded images for the page, keyed by asset id. The page renderer asks synchronously through `get`, so the UI decodes
 * ahead of time with `ensure` and re-renders when something new arrives.
 */
export class PageImageCache {
  private done = new Map<ID, HTMLCanvasElement>();
  private pending = new Map<ID, Promise<HTMLCanvasElement>>();

  get(assetId: ID): HTMLCanvasElement | null {
    return this.done.get(assetId) ?? null;
  }

  has(assetId: ID): boolean {
    return this.done.has(assetId);
  }

  /** Decode every asset the page needs that is not decoded yet. Returns true if anything new became available. */
  async ensure(assetIds: Iterable<ID>, assets: Map<ID, AssetData>): Promise<boolean> {
    let changed = false;
    for (const id of assetIds) {
      if (this.done.has(id)) continue;
      const a = assets.get(id);
      if (!a) continue;
      let p = this.pending.get(id);
      if (!p) {
        p = decodeToCanvas(a.bytes, a.mime)
          .then((c) => {
            this.done.set(id, c);
            return c;
          })
          .finally(() => this.pending.delete(id));
        this.pending.set(id, p);
      }
      try {
        await p;
        changed = true;
      } catch {
        // a damaged image simply does not draw; the placement stays in the page so the artist can relink it
      }
    }
    return changed;
  }

  clear(): void {
    this.done.clear();
    this.pending.clear();
  }
}
