import { useState } from 'react';
import type { Layer } from '../core/types.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import { unusedAssetIds } from '../core/project.ts';
import { NumberField, Section, TextField } from './controls.tsx';
import { SegmentationPanel } from './SegmentationPanel.tsx';

function CanvasSettings() {
  const { doc, project } = useApp();
  const [w, setW] = useState<number | null>(null);
  const [h, setH] = useState<number | null>(null);
  if (!doc || !project) return null;
  const unused = unusedAssetIds(project).length;
  return (
    <>
      <Section title="Canvas" hint="Export uses this size. Layers outside it are cropped.">
        <div className="row">
          <NumberField label="W" value={w ?? doc.canvas.width} onCommit={setW} min={1} max={16384} digits={0} width={70} suffix="px" />
          <NumberField label="H" value={h ?? doc.canvas.height} onCommit={setH} min={1} max={16384} digits={0} width={70} suffix="px" />
          <button disabled={(w ?? doc.canvas.width) === doc.canvas.width && (h ?? doc.canvas.height) === doc.canvas.height} onClick={() => (store.setCanvasSize(Math.round(w ?? doc.canvas.width), Math.round(h ?? doc.canvas.height)), setW(null), setH(null))}>
            Apply
          </button>
        </div>
      </Section>
      <Section title="Original files" hint="Imported files are kept byte-for-byte; editing never changes them.">
        {project.sources.length === 0 ? <p className="muted">None yet.</p> : <ul className="plain">{project.sources.map((s) => <li key={s.assetId}>{s.fileName} <span className="tag">{s.kind.toUpperCase()}</span></li>)}</ul>}
        {unused > 0 && (
          <button onClick={() => window.confirm('Remove unused image data? This also clears undo history.') && void store.compactUnused()}>
            Clean up {unused} unused image{unused === 1 ? '' : 's'}
          </button>
        )}
      </Section>
      <p className="hint pad">Select a layer to edit it. Tips: wheel zooms, Space+drag pans, Shift+click adds to the selection.</p>
    </>
  );
}

function LayerEditor({ layer }: { layer: Layer }) {
  const { doc, ui } = useApp();
  if (!doc) return null;
  const raster = layer.kind === 'raster';
  const groups = doc.layers.filter((l) => l.kind === 'group' && l.id !== layer.id);
  const t = layer.transform;
  const set = (patch: Partial<typeof t>) => store.setLayerTransform(layer.id, patch);
  return (
    <>
      <Section title={layer.kind === 'group' ? 'Group' : 'Layer'}>
        <TextField className="wide" value={layer.name} onCommit={(v) => store.renameLayer(layer.id, v)} />
        <label className="field">
          <span>Opacity</span>
          <input type="range" min={0} max={1} step={0.01} value={layer.opacity} onChange={(e) => store.setLayerOpacity(layer.id, Number(e.target.value))} />
          <em>{Math.round(layer.opacity * 100)}%</em>
        </label>
        <label className="field">
          <span>Group</span>
          <select value={layer.parentId ?? ''} onChange={(e) => store.moveToGroup(layer.id, e.target.value || null)}>
            <option value="">(none)</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      </Section>
      {raster && (
        <>
          <Section title="Placement" hint="Rest layout. Rotation and scale happen around the pivot.">
            <div className="grid2">
              <NumberField label="X" value={t.x} onCommit={(v) => set({ x: v })} />
              <NumberField label="Y" value={t.y} onCommit={(v) => set({ y: v })} />
              <NumberField label="Rot" value={t.rotation} onCommit={(v) => set({ rotation: v })} suffix="°" />
              <span />
              <NumberField label="Scale X" value={t.scaleX} onCommit={(v) => v !== 0 && set({ scaleX: v })} step={0.05} />
              <NumberField label="Scale Y" value={t.scaleY} onCommit={(v) => v !== 0 && set({ scaleY: v })} step={0.05} />
            </div>
            <div className="row">
              <button className={ui.layoutTool === 'pivot' ? 'primary' : ''} onClick={() => store.setLayoutTool(ui.layoutTool === 'pivot' ? 'select' : 'pivot')} title="Then click on the canvas (P)">
                {ui.layoutTool === 'pivot' ? 'Click canvas to set pivot…' : 'Set pivot'}
              </button>
              <button onClick={() => store.setLayerPivot(layer.id, { x: layer.width / 2, y: layer.height / 2 })}>Centre pivot</button>
            </div>
          </Section>
          <Section title="Mask" hint="Hides parts of this layer without changing its pixels.">
            <div className="row">
              <button onClick={() => store.setDialog({ kind: 'mask', layerId: layer.id })}>{layer.maskAssetId ? 'Edit mask' : 'Create mask'}</button>
              {layer.maskAssetId && <button onClick={() => store.removeMask(layer.id)}>Remove mask</button>}
            </div>
          </Section>
          {doc.joints.length > 0 && (
            <Section title="Skeleton">
              <label className="field">
                <span>Follows</span>
                <select value={layer.jointId ?? ''} onChange={(e) => store.attachSelectedLayers(e.target.value || null)}>
                  <option value="">(no joint)</option>
                  {doc.joints.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
                </select>
              </label>
            </Section>
          )}
          <Section title="AI-assisted separation">
            <SegmentationPanel layer={layer} />
          </Section>
        </>
      )}
    </>
  );
}

export function LayoutInspector() {
  const { doc, ui } = useApp();
  if (!doc) return <p className="muted pad">Open a project to begin.</p>;
  const id = ui.selectedLayerIds[ui.selectedLayerIds.length - 1];
  const layer = doc.layers.find((l) => l.id === id);
  if (ui.selectedLayerIds.length > 1) {
    return (
      <>
        <Section title={`${ui.selectedLayerIds.length} layers selected`} hint="Drag on the canvas to move them together, or use the buttons below the layer list. Select one layer to edit its details." />
        <button onClick={() => store.groupSelected()}>Group selected</button>
      </>
    );
  }
  return layer ? <LayerEditor layer={layer} /> : <CanvasSettings />;
}
