import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ID, Layer } from '../core/types.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import { TextField } from './controls.tsx';

export function LayerPanel() {
  const { doc, ui } = useApp();
  const [renaming, setRenaming] = useState<ID | null>(null);
  if (!doc) {
    return (
      <aside className="panel left">
        <div className="panel-h">
          <h2>Layers</h2>
        </div>
        <p className="muted pad">No project open.</p>
      </aside>
    );
  }
  const sel = new Set(ui.selectedLayerIds);
  const jointName = (id: ID | null) => doc.joints.find((j) => j.id === id)?.name;

  const click = (e: React.MouseEvent, l: Layer) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) store.selectLayers(sel.has(l.id) ? ui.selectedLayerIds.filter((x) => x !== l.id) : [...ui.selectedLayerIds, l.id]);
    else store.selectLayers([l.id]);
  };

  const rows: ReactNode[] = [];
  const walk = (parentId: ID | null, depth: number) => {
    for (const l of doc.layers.filter((x) => x.parentId === parentId).reverse()) {
      rows.push(
        <li key={l.id} className={`layer-row${sel.has(l.id) ? ' sel' : ''}${l.kind === 'group' ? ' group' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={(e) => click(e, l)} onDoubleClick={() => setRenaming(l.id)}>
          <button className={`icon${l.visible ? '' : ' off'}`} title={l.visible ? 'Hide' : 'Show'} aria-label={l.visible ? 'Hide layer' : 'Show layer'} onClick={(e) => (e.stopPropagation(), store.setLayerVisible(l.id, !l.visible))}>
            {l.visible ? '◉' : '○'}
          </button>
          <button className={`icon${l.locked ? ' on' : ''}`} title={l.locked ? 'Unlock' : 'Lock'} aria-label={l.locked ? 'Unlock layer' : 'Lock layer'} onClick={(e) => (e.stopPropagation(), store.setLayerLocked(l.id, !l.locked))}>
            {l.locked ? '▣' : '▢'}
          </button>
          {renaming === l.id ? (
            <TextField className="rename" autoFocus value={l.name} onCommit={(v) => store.renameLayer(l.id, v)} onDone={() => setRenaming(null)} />
          ) : (
            <span className="lname" title={l.name}>
              {l.kind === 'group' ? '▾ ' : ''}
              {l.name}
            </span>
          )}
          {l.maskAssetId && <span className="tag" title="Has a mask">mask</span>}
          {l.jointId && <span className="tag blue" title={`Follows joint ${jointName(l.jointId)}`}>{jointName(l.jointId)}</span>}
        </li>,
      );
      if (l.kind === 'group') walk(l.id, depth + 1);
    }
  };
  walk(null, 0);

  const first = ui.selectedLayerIds[0];
  const firstLayer = doc.layers.find((l) => l.id === first);
  const hasSel = ui.selectedLayerIds.length > 0;
  return (
    <aside className="panel left">
      <div className="panel-h">
        <h2>Layers</h2>
        <span className="muted">{doc.layers.filter((l) => l.kind === 'raster').length}</span>
      </div>
      {rows.length === 0 ? <p className="muted pad">No layers yet. Import a PNG or PSD.</p> : <ul className="layers">{rows}</ul>}
      <div className="panel-f">
        <button disabled={!hasSel} title="Move up (toward top)" onClick={() => first && store.moveLayerOrder(first, 'up')}>
          Up
        </button>
        <button disabled={!hasSel} title="Move down" onClick={() => first && store.moveLayerOrder(first, 'down')}>
          Down
        </button>
        <button disabled={!hasSel} title="Group selected (Ctrl+G)" onClick={() => store.groupSelected()}>
          Group
        </button>
        <button disabled={firstLayer?.kind !== 'group'} title="Ungroup (Ctrl+Shift+G)" onClick={() => first && store.ungroup(first)}>
          Ungroup
        </button>
        <button disabled={!hasSel} title="Duplicate (Ctrl+D)" onClick={() => first && store.duplicateLayer(first)}>
          Duplicate
        </button>
        <button className="danger" disabled={!hasSel} title="Delete (Delete)" onClick={() => window.confirm(`Delete ${ui.selectedLayerIds.length} layer(s)? You can undo this.`) && store.deleteLayers(ui.selectedLayerIds)}>
          Delete
        </button>
      </div>
    </aside>
  );
}
