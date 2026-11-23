/**
 * Pure planning step for PSD import: walks an ag-psd–shaped tree and decides what becomes a layer,
 * what becomes a group, and what is skipped (with a human-readable warning for every loss).
 * Pixel encoding is done by the caller, so this logic is testable without a canvas.
 */
export interface PixelSource {
  width: number;
  height: number;
}

export interface PsdLikeLayer {
  name?: string;
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  hidden?: boolean;
  /** 0..1 in ag-psd */
  opacity?: number;
  blendMode?: string;
  canvas?: PixelSource;
  children?: PsdLikeLayer[];
  mask?: unknown;
  vectorMask?: unknown;
  clipping?: boolean;
  text?: unknown;
  adjustment?: unknown;
  effects?: unknown;
}

export interface PsdLike {
  width: number;
  height: number;
  bitsPerChannel?: number;
  colorMode?: number;
  children?: PsdLikeLayer[];
}

export interface PlannedLayer {
  index: number;
  parentIndex: number | null;
  kind: 'raster' | 'group';
  name: string;
  visible: boolean;
  opacity: number;
  left: number;
  top: number;
  width: number;
  height: number;
  canvas?: PixelSource;
}

export interface PsdPlan {
  width: number;
  height: number;
  layers: PlannedLayer[];
  warnings: string[];
}

const NORMAL_BLEND = new Set(['normal', 'pass through']);

export function planPsdImport(psd: PsdLike): PsdPlan {
  const layers: PlannedLayer[] = [];
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };
  if (psd.bitsPerChannel !== undefined && psd.bitsPerChannel !== 8) warn(`This PSD uses ${psd.bitsPerChannel} bits per channel; colours were converted to 8-bit.`);
  if (psd.colorMode !== undefined && psd.colorMode !== 3) warn('This PSD is not in RGB colour mode; colours may differ from Photoshop.');

  const walk = (nodes: PsdLikeLayer[], parentIndex: number | null) => {
    nodes.forEach((n, i) => {
      const name = n.name?.trim() || `Layer ${layers.length + 1}`;
      const rawOp = n.opacity ?? 1;
      const opacity = Math.min(1, Math.max(0, rawOp > 1 ? rawOp / 255 : rawOp));
      const visible = !n.hidden;
      if (n.children) {
        const index = layers.length;
        layers.push({ index, parentIndex, kind: 'group', name, visible, opacity, left: 0, top: 0, width: 0, height: 0 });
        walk(n.children, index);
        return;
      }
      if (n.adjustment) return void warn(`Adjustment layer "${name}" was skipped (adjustment layers are not supported).`);
      const w = n.canvas?.width ?? 0;
      const h = n.canvas?.height ?? 0;
      if (!n.canvas || w < 1 || h < 1) return void warn(`Layer "${name}" has no pixels and was skipped.`);
      if (n.blendMode && !NORMAL_BLEND.has(n.blendMode)) warn(`Layer "${name}" uses blend mode "${n.blendMode}"; it is imported as Normal.`);
      if (n.mask || n.vectorMask) warn(`Layer "${name}" has a layer mask that was not imported. Use the mask editor to rebuild it.`);
      if (n.clipping) warn(`Layer "${name}" is a clipping layer; clipping was not preserved.`);
      if (n.text) warn(`Text layer "${name}" was imported as pixels and is no longer editable text.`);
      if (n.effects) warn(`Layer effects on "${name}" were not imported.`);
      void i;
      layers.push({ index: layers.length, parentIndex, kind: 'raster', name, visible, opacity, left: n.left ?? 0, top: n.top ?? 0, width: w, height: h, canvas: n.canvas });
    });
  };
  walk(psd.children ?? [], null);
  return { width: psd.width, height: psd.height, layers, warnings };
}
