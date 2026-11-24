import { useEffect } from 'react';
import { store } from './app/store.ts';
import { useApp } from './app/useApp.ts';
import { CanvasView } from './ui/CanvasView.tsx';
import { CharacterView } from './ui/CharacterView.tsx';
import { GenerateView } from './ui/GenerateView.tsx';
import { ExportDialog, HelpDialog, ProjectsDialog, ReportDialog, Toasts } from './ui/Dialogs.tsx';
import { LayoutInspector } from './ui/Inspector.tsx';
import { LayerPanel } from './ui/LayerPanel.tsx';
import { MaskEditor } from './ui/MaskEditor.tsx';
import { PageView } from './ui/PageView.tsx';
import { PoseInspector, RigInspector } from './ui/RigPanel.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import { lazy, Suspense } from 'react';

const StudioView = lazy(() => import('./ui/StudioView.tsx').then((m) => ({ default: m.StudioView })));

function isTyping(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement) return !['range', 'checkbox', 'button'].includes(t.type);
  return t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 's') {
        e.preventDefault();
        return void store.save(true);
      }
      if (isTyping(e.target)) return;
      const s = store.getSnapshot();
      if (s.ui.dialog) return;
      if (mod && k === 'z') {
        e.preventDefault();
        return e.shiftKey ? store.redo() : store.undo();
      }
      if (mod && k === 'y') {
        e.preventDefault();
        return store.redo();
      }
      const doc = s.doc;
      if (!doc || s.ui.workspace !== 'canvas') return;
      const first = s.ui.selectedLayerIds[0];
      if (mod && k === 'e') {
        e.preventDefault();
        return doc.layers.length ? store.setDialog({ kind: 'export' }) : undefined;
      }
      if (mod && k === 'd') {
        e.preventDefault();
        return first ? store.duplicateLayer(first) : undefined;
      }
      if (mod && k === 'g') {
        e.preventDefault();
        return e.shiftKey ? (first && store.ungroup(first)) : store.groupSelected();
      }
      if (mod || e.altKey) return;
      const mode = s.ui.mode;
      switch (k) {
        case '1':
          return store.setMode('layout');
        case '2':
          return store.setMode('rig');
        case '3':
          return store.setMode('pose');
        case 'f':
          return store.fitToCanvas();
        case 'j':
          return mode === 'rig' ? store.setRigTool(s.ui.rigTool === 'add' ? 'select' : 'add') : undefined;
        case 'p':
          return mode === 'layout' ? store.setLayoutTool(s.ui.layoutTool === 'pivot' ? 'select' : 'pivot') : undefined;
        case 'v':
        case 'escape':
          store.setRigTool('select');
          return store.setLayoutTool('select');
        case 'delete':
        case 'backspace':
          if (mode === 'layout' && s.ui.selectedLayerIds.length) store.deleteLayers(s.ui.selectedLayerIds);
          else if (mode === 'rig' && s.ui.selectedJointId) store.deleteJoint(s.ui.selectedJointId);
          return;
        case 'arrowleft':
        case 'arrowright':
        case 'arrowup':
        case 'arrowdown': {
          if (mode !== 'layout') return;
          const ids = store.expandToRaster(s.ui.selectedLayerIds).filter((id) => !doc.layers.find((l) => l.id === id)?.locked);
          if (!ids.length) return;
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
          const dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
          if (ids.length === 1) {
            const t = doc.layers.find((l) => l.id === ids[0])!.transform;
            return store.setLayerTransform(ids[0]!, { x: t.x + dx, y: t.y + dy });
          }
          store.beginGesture();
          store.previewDoc({ ...doc, layers: doc.layers.map((l) => (ids.includes(l.id) ? { ...l, transform: { ...l.transform, x: l.transform.x + dx, y: l.transform.y + dy } } : l)) });
          return store.endGesture('Nudge layers');
        }
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function useFileDrop() {
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const bundle = files.find((f) => /\.(cfbundle|zip)$/i.test(f.name));
      if (bundle) return void bundle.arrayBuffer().then((b) => store.importBundleBytes(new Uint8Array(b)));
      const s = store.getSnapshot();
      if (!s.project) return void store.toast('info', 'Create or open a character first, then drop images here.');
      if (s.ui.workspace === 'canvas') return void store.importFiles(files);
      if (s.ui.workspace === 'character') {
        const imgs = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
        if (!imgs.length) return void store.toast('error', 'Drop PNG, JPEG or WebP images.');
        if (!s.character?.originalAssetId) {
          void store.importOriginal(imgs[0]!).then(() => (imgs.length > 1 ? store.importReferences(imgs.slice(1)) : undefined));
        } else void store.importReferences(imgs);
        return;
      }
      store.toast('info', 'Drop images on the Character tab (originals and references) or the 2D canvas tab (layers).');
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (store.getSnapshot().ui.saveState !== 'saved') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
}

const HINTS = {
  layout: 'Layout — click to select, drag to move; corner handles scale, the round handle rotates (Shift snaps 15°).',
  rig: '2D rig — drag joints to place them; use Add joint (J) to extend the skeleton.',
  pose: '2D pose — drag joints. Wrists and ankles use IK; hold Alt for FK.',
} as const;

function Welcome() {
  return (
    <div className="welcome" data-testid="welcome">
      <div className="empty-card">
        <h2>CharacterForge</h2>
        <p>Draw or import your character once, pose a 3D character model, and get a new illustration of the same character in that pose. Everything stays in this browser.</p>
        <div className="row">
          <button className="primary" onClick={() => store.setDialog({ kind: 'projects' })} data-testid="new-character">
            New or open character
          </button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const s = useApp();
  useShortcuts();
  useFileDrop();
  useEffect(() => {
    void store.restoreLast();
  }, []);
  const { ui, doc, project } = s;
  const dlg = ui.dialog;
  const ws = ui.workspace;
  return (
    <div className="app">
      <Toolbar />
      {!project ? (
        <Welcome />
      ) : ws === 'character' ? (
        <CharacterView />
      ) : ws === 'studio' ? (
        <Suspense fallback={<div className="welcome muted">Loading the 3D studio…</div>}>
          <StudioView />
        </Suspense>
      ) : ws === 'generate' ? (
        <GenerateView />
      ) : ws === 'page' ? (
        <PageView />
      ) : (
        <div className="workspace">
          <LayerPanel />
          <main className="center">
            <CanvasView />
            <footer className="status">
              <span>{doc ? HINTS[ui.mode] : 'Create or open a project to begin.'}</span>
              <span className="spacer" />
              {ui.busy && <span className="busy">{ui.busy}</span>}
              {doc && (
                <span className="muted">
                  {doc.canvas.width}×{doc.canvas.height} · {Math.round(ui.view.zoom * 100)}%
                </span>
              )}
            </footer>
          </main>
          <aside className="panel right">
            <div className="panel-h">
              <h2>{ui.mode === 'layout' ? 'Inspector' : ui.mode === 'rig' ? '2D rig' : '2D pose'}</h2>
              {project && <span className="muted">{project.name}</span>}
            </div>
            <div className="scroll">{ui.mode === 'layout' ? <LayoutInspector /> : ui.mode === 'rig' ? <RigInspector /> : <PoseInspector />}</div>
          </aside>
        </div>
      )}
      {ui.busy && ws !== 'canvas' && <div className="busy-pill">{ui.busy}</div>}
      {dlg?.kind === 'projects' && <ProjectsDialog />}
      {dlg?.kind === 'export' && <ExportDialog />}
      {dlg?.kind === 'mask' && <MaskEditor layerId={dlg.layerId} />}
      {dlg?.kind === 'report' && <ReportDialog title={dlg.title} lines={dlg.lines} />}
      {dlg?.kind === 'help' && <HelpDialog />}
      <Toasts />
    </div>
  );
}
