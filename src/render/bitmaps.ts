import type { ID, Layer } from '../core/types.ts';
import type { AssetData } from '../storage/projectService.ts';
import { ctx2d, decodeToCanvas, newCanvas } from './pngEncode.ts';

/**
 * Decoded pixels for assets, plus "effective" bitmaps (pixels × mask). Original assets are never
 * modified: a mask is applied on a copy, so removing the mask restores the artwork exactly.
 */
export class BitmapStore {
  private raw = new Map<ID, HTMLCanvasElement>();
  private effective = new Map<string, HTMLCanvasElement>();

  has(assetId: ID): boolean {
    return this.raw.has(assetId);
  }

  async load(asset: AssetData): Promise<void> {
    if (this.raw.has(asset.id)) return;
    this.raw.set(asset.id, await decodeToCanvas(asset.bytes, asset.mime));
  }

  /** Decode every asset referenced by raster layers that isn't decoded yet. Returns true if anything new loaded. */
  async ensure(layers: Layer[], assets: Map<ID, AssetData>): Promise<boolean> {
    let changed = false;
    for (const l of layers) {
      if (l.kind !== 'raster') continue;
      for (const id of [l.assetId, l.maskAssetId]) {
        if (!id || this.raw.has(id)) continue;
        const a = assets.get(id);
        if (a) {
          await this.load(a);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Register an already-decoded canvas (e.g. a freshly painted mask). */
  put(assetId: ID, canvas: HTMLCanvasElement): void {
    this.raw.set(assetId, canvas);
  }

  getRaw(assetId: ID): HTMLCanvasElement | null {
    return this.raw.get(assetId) ?? null;
  }

  /** Bitmap to draw for a layer: its pixels, multiplied by its mask when it has one. */
  get(layer: Layer): HTMLCanvasElement | null {
    if (layer.kind !== 'raster' || !layer.assetId) return null;
    const base = this.raw.get(layer.assetId);
    if (!base) return null;
    if (!layer.maskAssetId) return base;
    const mask = this.raw.get(layer.maskAssetId);
    if (!mask) return base;
    const key = `${layer.assetId}|${layer.maskAssetId}`;
    let eff = this.effective.get(key);
    if (!eff) {
      eff = newCanvas(base.width, base.height);
      const c = ctx2d(eff);
      c.drawImage(base, 0, 0);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(mask, 0, 0, base.width, base.height);
      this.effective.set(key, eff);
    }
    return eff;
  }

  /** Alpha (0–255) of a layer's effective bitmap at a pixel; 0 outside or if not loaded. */
  alphaAt(layer: Layer, x: number, y: number): number {
    const bmp = this.get(layer);
    if (!bmp || x < 0 || y < 0 || x >= bmp.width || y >= bmp.height) return 0;
    return ctx2d(bmp).getImageData(x, y, 1, 1).data[3] ?? 0;
  }

  /** Drop effective bitmaps that no layer uses any more (after mask edits). */
  prune(layers: Layer[]): void {
    const live = new Set(layers.filter((l) => l.kind === 'raster' && l.assetId && l.maskAssetId).map((l) => `${l.assetId}|${l.maskAssetId}`));
    for (const k of this.effective.keys()) if (!live.has(k)) this.effective.delete(k);
  }

  clear(): void {
    this.raw.clear();
    this.effective.clear();
  }
}
