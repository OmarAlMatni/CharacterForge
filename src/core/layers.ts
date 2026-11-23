import { apply, fromTRS } from './math.ts';
import type { Vec2 } from './math.ts';
import type { ID, Layer } from './types.ts';

export const byId = (layers: Layer[], id: ID): Layer | undefined => layers.find((l) => l.id === id);
export const childrenOf = (layers: Layer[], parentId: ID | null): Layer[] => layers.filter((l) => l.parentId === parentId);

export interface RasterLayerInit {
  id: ID;
  name: string;
  assetId: ID;
  width: number;
  height: number;
  /** Canvas position of the layer's pivot (defaults to canvas-agnostic centre = width/2). */
  x?: number;
  y?: number;
  parentId?: ID | null;
  visible?: boolean;
  opacity?: number;
}

export function makeRasterLayer(i: RasterLayerInit): Layer {
  return {
    id: i.id,
    name: i.name,
    kind: 'raster',
    parentId: i.parentId ?? null,
    visible: i.visible ?? true,
    locked: false,
    opacity: i.opacity ?? 1,
    assetId: i.assetId,
    maskAssetId: null,
    width: i.width,
    height: i.height,
    transform: { x: i.x ?? i.width / 2, y: i.y ?? i.height / 2, rotation: 0, scaleX: 1, scaleY: 1 },
    pivot: { x: i.width / 2, y: i.height / 2 },
    jointId: null,
  };
}

export function makeGroup(id: ID, name: string, parentId: ID | null = null): Layer {
  return {
    id,
    name,
    kind: 'group',
    parentId,
    visible: true,
    locked: false,
    opacity: 1,
    assetId: null,
    maskAssetId: null,
    width: 0,
    height: 0,
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    pivot: { x: 0, y: 0 },
    jointId: null,
  };
}

export function ancestors(layers: Layer[], id: ID): Layer[] {
  const out: Layer[] = [];
  const seen = new Set<ID>([id]);
  let cur = byId(layers, id);
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = byId(layers, cur.parentId);
    if (cur) out.push(cur);
  }
  return out;
}

/** True when `id` is inside the subtree rooted at `ancestorId` (or equals it). */
export function isInSubtree(layers: Layer[], id: ID, ancestorId: ID): boolean {
  if (id === ancestorId) return true;
  return ancestors(layers, id).some((a) => a.id === ancestorId);
}

export function descendantIds(layers: Layer[], id: ID): ID[] {
  return layers.filter((l) => l.id !== id && isInSubtree(layers, l.id, id)).map((l) => l.id);
}

/** Raster layers in paint order (bottom → top), walking groups depth-first. */
export function renderOrder(layers: Layer[]): Layer[] {
  const out: Layer[] = [];
  const seen = new Set<ID>();
  const walk = (parent: ID | null) => {
    for (const l of layers) {
      if (l.parentId !== parent || seen.has(l.id)) continue;
      seen.add(l.id);
      if (l.kind === 'group') walk(l.id);
      else out.push(l);
    }
  };
  walk(null);
  return out;
}

export function isEffectivelyVisible(layers: Layer[], id: ID): boolean {
  const l = byId(layers, id);
  if (!l || !l.visible) return false;
  return ancestors(layers, id).every((a) => a.visible);
}

/** Layer opacity multiplied by all ancestor group opacities. */
export function effectiveOpacity(layers: Layer[], id: ID): number {
  const l = byId(layers, id);
  if (!l) return 0;
  return ancestors(layers, id).reduce((o, a) => o * a.opacity, l.opacity);
}

export function updateLayer(layers: Layer[], id: ID, patch: Partial<Layer>): Layer[] {
  return layers.map((l) => (l.id === id ? { ...l, ...patch } : l));
}

export type MoveDir = 'up' | 'down' | 'top' | 'bottom';

/** Reorder a layer among its siblings. "up" moves toward the top of the stack. */
export function moveLayer(layers: Layer[], id: ID, dir: MoveDir): Layer[] {
  const layer = byId(layers, id);
  if (!layer) return layers;
  const sibIdx = layers.map((l, i) => (l.parentId === layer.parentId ? i : -1)).filter((i) => i >= 0);
  const pos = sibIdx.indexOf(layers.indexOf(layer));
  const target = dir === 'up' ? pos + 1 : dir === 'down' ? pos - 1 : dir === 'top' ? sibIdx.length - 1 : 0;
  if (target < 0 || target >= sibIdx.length || target === pos) return layers;
  const targetSibId = layers[sibIdx[target]!]!.id;
  const without = layers.filter((l) => l.id !== id);
  const ti = without.findIndex((l) => l.id === targetSibId);
  const at = target > pos ? ti + 1 : ti;
  return [...without.slice(0, at), layer, ...without.slice(at)];
}

/** Group layers that share a parent. The group takes the z-slot of the top-most selected layer. */
export function groupLayers(layers: Layer[], ids: ID[], groupId: ID, name: string): Layer[] {
  const sel = layers.filter((l) => ids.includes(l.id));
  if (sel.length === 0) return layers;
  const parent = sel[0]!.parentId;
  if (!sel.every((l) => l.parentId === parent)) throw new Error('Select layers that share the same parent to group them.');
  const top = Math.max(...sel.map((l) => layers.indexOf(l)));
  const moved = layers.map((l) => (ids.includes(l.id) ? { ...l, parentId: groupId } : l));
  return [...moved.slice(0, top + 1), makeGroup(groupId, name, parent), ...moved.slice(top + 1)];
}

/** Dissolve a group; its children take the group's place in the stack. */
export function ungroupLayer(layers: Layer[], groupId: ID): Layer[] {
  const g = byId(layers, groupId);
  if (!g || g.kind !== 'group') return layers;
  const kids = layers.filter((l) => l.parentId === groupId);
  const kidIds = new Set(kids.map((k) => k.id));
  const out: Layer[] = [];
  for (const l of layers) {
    if (l.id === groupId) kids.forEach((k) => out.push({ ...k, parentId: g.parentId }));
    else if (!kidIds.has(l.id)) out.push(l);
  }
  return out;
}

/** Move a layer into a group (or to the root with null). It lands on top of its new siblings. */
export function moveIntoGroup(layers: Layer[], id: ID, groupId: ID | null): Layer[] {
  const l = byId(layers, id);
  if (!l) return layers;
  if (groupId !== null) {
    const g = byId(layers, groupId);
    if (!g || g.kind !== 'group') throw new Error('The target is not a group.');
    if (isInSubtree(layers, groupId, id)) throw new Error('A group cannot be moved into itself.');
  }
  return [...layers.filter((x) => x.id !== id), { ...l, parentId: groupId }];
}

/** Delete a layer and everything inside it. */
export function deleteLayerTree(layers: Layer[], id: ID): { layers: Layer[]; removed: Layer[] } {
  const gone = new Set<ID>([id, ...descendantIds(layers, id)]);
  return { layers: layers.filter((l) => !gone.has(l.id)), removed: layers.filter((l) => gone.has(l.id)) };
}

/** Duplicate a layer (and its subtree). The copy sits directly above the original. */
export function duplicateLayerTree(layers: Layer[], id: ID, makeId: () => ID): { layers: Layer[]; newRootId: ID } | null {
  const root = byId(layers, id);
  if (!root) return null;
  const subtree = layers.filter((l) => isInSubtree(layers, l.id, id));
  const map = new Map<ID, ID>(subtree.map((l) => [l.id, makeId()]));
  const clones = subtree.map((l) => ({
    ...l,
    id: map.get(l.id)!,
    name: l.id === id ? `${l.name} copy` : l.name,
    parentId: l.id === id ? l.parentId : (map.get(l.parentId ?? '') ?? l.parentId),
    transform: { ...l.transform },
    pivot: { ...l.pivot },
  }));
  const at = layers.indexOf(root) + 1;
  return { layers: [...layers.slice(0, at), ...clones, ...layers.slice(at)], newRootId: map.get(id)! };
}

/** Change a layer's pivot without moving it visually. `pivot` is in layer pixel coordinates. */
export function setPivotKeepingPlacement(layer: Layer, pivot: Vec2): Layer {
  const t = apply(fromTRS(layer.transform), { x: pivot.x - layer.pivot.x, y: pivot.y - layer.pivot.y });
  return { ...layer, pivot, transform: { ...layer.transform, x: t.x, y: t.y } };
}
