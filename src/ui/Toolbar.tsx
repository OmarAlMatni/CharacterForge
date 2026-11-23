import { store } from '../app/store.ts';
import type { Mode, Workspace } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import { TextField } from './controls.tsx';

const WORKSPACES: { id: Workspace; label: string; hint: string }[] = [
  { id: 'character', label: 'Character', hint: 'Original artwork, references, appearance' },
  { id: 'studio', label: 'Pose studio', hint: '3D character model: size, pose, project artwork, camera' },
  { id: 'generate', label: 'Generate & review', hint: 'Create a new illustration from the pose, then accept or reject it' },
  { id: 'canvas', label: '2D canvas', hint: 'Layers, masks, cropping, transforms, transparent PNG export, 2D puppet rig' },
];

const MODES: { id: Mode; label: string; key: string }[] = [
  { id: 'layout', label: 'Layout', key: '1' },
  { id: 'rig', label: '2D rig', key: '2' },
  { id: 'pose', label: '2D pose', key: '3' },
];

export function Toolbar() {
  const { doc, project, ui, canUndo, canRedo, undoLabel, redoLabel } = useApp();
  const save = ui.saveState;
  const ws = ui.workspace;
  return (
    <header className="toolbar">
      <div className="brand" aria-label="CharacterForge">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#242831" />
          <circle cx="16" cy="9" r="4" fill="none" stroke="#7cc8ee" strokeWidth="2" />
          <path d="M16 13v8M16 16l-7 5M16 16l7 5M16 21l-5 8M16 21l5 8" fill="none" stroke="#7cc8ee" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span>CharacterForge</span>
      </div>
      <div className="proj">
        {project ? <TextField className="projname" value={project.name} onCommit={(v) => store.renameProject(v)} /> : <span className="muted">No character open</span>}
        {project &&
          (save === 'error' ? (
            <button className="badge bad" onClick={() => void store.save(true)}>
              Save failed — retry
            </button>
          ) : (
            <span className={`badge ${save}`}>{save === 'saved' ? 'Saved' : save === 'saving' ? 'Saving…' : 'Unsaved changes'}</span>
          ))}
      </div>
      <nav className="seg workspaces" role="tablist" aria-label="Workspace">
        {WORKSPACES.map((w) => (
          <button key={w.id} role="tab" data-testid={`ws-${w.id}`} aria-selected={ws === w.id} className={ws === w.id ? 'on' : ''} disabled={!project} onClick={() => store.setWorkspace(w.id)} title={w.hint}>
            {w.label}
          </button>
        ))}
      </nav>
      {ws === 'canvas' && (
        <div className="seg modes" role="tablist" aria-label="2D editing mode">
          {MODES.map((m) => (
            <button key={m.id} role="tab" aria-selected={ui.mode === m.id} className={ui.mode === m.id ? 'on' : ''} disabled={!doc} onClick={() => store.setMode(m.id)} title={`${m.label} (${m.key})`}>
              {m.label}
            </button>
          ))}
        </div>
      )}
      <div className="spacer" />
      {ws === 'canvas' && (
        <label className="button" title="Import PNG or PSD as 2D layers">
          Import layers
          <input type="file" accept=".png,.psd,image/png" multiple hidden onChange={(e) => void store.importFiles([...(e.target.files ?? [])]).then(() => (e.target.value = ''))} />
        </label>
      )}
      <button disabled={!canUndo} onClick={() => store.undo()} title={undoLabel ? `Undo: ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} data-testid="undo">
        Undo
      </button>
      <button disabled={!canRedo} onClick={() => store.redo()} title={redoLabel ? `Redo: ${redoLabel} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)'} data-testid="redo">
        Redo
      </button>
      {ws === 'canvas' && (
        <>
          <button disabled={!doc} onClick={() => store.fitToCanvas()} title="Fit canvas (F)">
            Fit
          </button>
          <button className="primary" disabled={!doc || doc.layers.length === 0} onClick={() => store.setDialog({ kind: 'export' })} title="Export transparent PNG (Ctrl+E)">
            Export PNG
          </button>
        </>
      )}
      <button disabled={!project} onClick={() => void store.save(true)} title="Save (Ctrl+S)">
        Save
      </button>
      <button onClick={() => store.setDialog({ kind: 'projects' })} data-testid="open-projects">
        Characters
      </button>
      <button className="ghost" onClick={() => store.setDialog({ kind: 'help' })} title="Help and shortcuts">
        ?
      </button>
    </header>
  );
}
