import { useEffect, useRef, useState } from 'react';
import { unusedAssetIds } from '../core/project.ts';
import type { DocState } from '../core/types.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import type { RenderedExport } from '../render/export.ts';
import { canvasToBlob } from '../render/pngEncode.ts';
import { getDb } from '../storage/db.ts';
import { listProjects } from '../storage/projectService.ts';
import type { ProjectSummary } from '../storage/projectService.ts';
import { Modal, download } from './controls.tsx';

export function ProjectsDialog() {
  const { project } = useApp();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [name, setName] = useState('');
  const [usage, setUsage] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const reload = () =>
    listProjects(getDb())
      .then(setList)
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void reload();
    void navigator.storage?.estimate?.().then((e) => e.usage !== undefined && e.quota !== undefined && setUsage(`${(e.usage / 1048576).toFixed(1)} MB used of about ${(e.quota / 1073741824).toFixed(1)} GB available to this browser`));
  }, []);
  const create = async () => {
    await store.newProject(name || 'Untitled character');
    setName('');
  };
  const unused = project ? unusedAssetIds(project).length : 0;
  return (
    <Modal title="Projects" onClose={() => store.setDialog(null)} wide>
      <div className="row new-project">
        <input type="text" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} autoFocus />
        <button className="primary" onClick={() => void create()}>
          Create project
        </button>
      </div>
      {loadErr && <p className="error">Could not read local storage: {loadErr}. Private/incognito windows may block it.</p>}
      {list && list.length === 0 && <p className="muted">No saved projects in this browser yet.</p>}
      <ul className="projects">
        {list?.map((p) => (
          <li key={p.id} className={project?.id === p.id ? 'current' : ''}>
            <div>
              <b>{p.name}</b>
              <span className="muted">
                {p.canvas.width}×{p.canvas.height} · {p.layerCount} layer{p.layerCount === 1 ? '' : 's'} · {new Date(p.updatedAt).toLocaleString()}
              </span>
            </div>
            <div className="row">
              <button className="primary" onClick={() => void store.openProject(p.id)}>
                {project?.id === p.id ? 'Reopen' : 'Open'}
              </button>
              <button onClick={() => void store.duplicateProjectById(p.id).then(reload)}>Duplicate</button>
              <button className="danger" onClick={() => window.confirm(`Delete "${p.name}" and all its images from this browser? This cannot be undone. Export a bundle first if you want a backup.`) && void store.deleteProjectById(p.id).then(reload)}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <h3 className="sub">Backup and transfer</h3>
      <div className="row wrap">
        <label className="button">
          Import bundle…
          <input type="file" accept=".cfbundle,.zip,application/zip" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void f.arrayBuffer().then((b) => store.importBundleBytes(new Uint8Array(b))).then(reload);
          }} />
        </label>
        <button
          disabled={!project}
          onClick={() => {
            try {
              const { bytes, fileName } = store.exportBundleFile();
              download(bytes, fileName, 'application/zip');
            } catch (e) {
              store.fail(e);
            }
          }}
        >
          Export current project as bundle
        </button>
        {unused > 0 && (
          <button onClick={() => window.confirm('Remove unused image data? This also clears undo history.') && void store.compactUnused()}>
            Clean up {unused} unused image{unused === 1 ? '' : 's'}
          </button>
        )}
      </div>
      <p className="hint">Projects live only in this browser (IndexedDB). Clearing site data deletes them, so export a bundle for backups.{usage ? ' ' + usage + '.' : ''}</p>
    </Modal>
  );
}

function poseLabel(doc: DocState): string {
  const same = (a: Record<string, number>, b: Record<string, number>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-6);
  const m = doc.poses.find((p) => same(p.rotations, doc.pose.rotations) && Math.abs(p.rootOffset.x - doc.pose.rootOffset.x) < 1e-6 && Math.abs(p.rootOffset.y - doc.pose.rootOffset.y) < 1e-6);
  return m ? `pose “${m.name}”` : 'the current pose';
}

export function ExportDialog() {
  const { doc, project } = useApp();
  const [scale, setScale] = useState(1);
  const [res, setRes] = useState<RenderedExport | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let dead = false;
    setErr(null);
    store
      .renderExportPreview(scale)
      .then((r) => {
        if (dead) return;
        r.canvas.style.cssText = 'max-width:100%;max-height:52vh;width:auto;height:auto;display:block;margin:auto';
        setRes(r);
        host.current?.replaceChildren(r.canvas);
      })
      .catch((e) => {
        if (dead) return;
        setRes(null);
        host.current?.replaceChildren();
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
  }, [scale]);
  if (!doc || !project) return null;
  const file = `${project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'character'}${scale > 1 ? `@${scale}x` : ''}.png`;
  const save = async () => {
    if (!res) return;
    try {
      download(await canvasToBlob(res.canvas), file, 'image/png');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal
      wide
      title="Export transparent PNG"
      onClose={() => store.setDialog(null)}
      footer={
        <>
          <button onClick={() => store.setDialog(null)}>Close</button>
          <button className="primary" disabled={!res} onClick={() => void save()}>
            Download {file}
          </button>
        </>
      }
    >
      <div className="row wrap">
        <label className="field inline">
          <span>Size</span>
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            {[1, 2, 4].map((s) => (
              <option key={s} value={s}>
                {s}× — {Math.round(doc.canvas.width * s)}×{Math.round(doc.canvas.height * s)} px
              </option>
            ))}
          </select>
        </label>
        <span className="muted">Exports {poseLabel(doc)} at the canvas resolution.</span>
      </div>
      {err && <p className="error">{err}</p>}
      <div ref={host} className="checker export-preview" />
      {res && <p className="hint">{res.width}×{res.height}px · {Math.round(res.transparentFraction * 100)}% of pixels are fully transparent. The checkerboard above is only the preview backdrop and is not part of the file.</p>}
    </Modal>
  );
}

export function ReportDialog(props: { title: string; lines: string[] }) {
  return (
    <Modal title={props.title} onClose={() => store.setDialog(null)} footer={<button className="primary" onClick={() => store.setDialog(null)}>OK</button>}>
      <p>The artwork was imported, but some features could not be preserved. Nothing was silently flattened:</p>
      <ul className="plain report">
        {props.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </Modal>
  );
}

export function HelpDialog() {
  return (
    <Modal title="Help and shortcuts" onClose={() => store.setDialog(null)} wide>
      <div className="help">
        <div>
          <h3>Workflow</h3>
          <ol>
            <li><b>Character:</b> create a character, import the original full-body drawing, optionally add references (face, other views, clothing).</li>
            <li><b>Pose studio:</b> size the character model with the Body sliders (or Fit body to artwork), project your artwork onto it, then pose it — presets, orange handles (hands, feet) use IK, blue dots rotate a joint. Orbit with drag, pan with Shift/right-drag, zoom with the wheel.</li>
            <li>Download <b>pose guides</b> (clay model, character render, pose map, depth, silhouette) from the studio.</li>
            <li><b>Generate &amp; review:</b> if a local generation server is running, generate from the current pose; otherwise import an image you made elsewhere. Accept, reject or retry; results keep their provenance.</li>
            <li><b>2D canvas:</b> the layer tools (masks, rig, 2D poses, PNG export) for manual correction.</li>
          </ol>
          <h3>Honest limits</h3>
          <p>The 3D character is the bundled “Anime Character Base mesh” by Marc Ed (CC BY 4.0), rigged for posing. You size it to your character and wrap your drawing around it; it is a base body, not a model of your exact character (hands are one piece without separate fingers, the face has no features, and hair or clothes outside the body outline are not 3D). CharacterForge does not include an image model: generation needs a backend you run locally (see the README). Imported results are labelled as imported. The original artwork is never overwritten.</p>
        </div>
        <table className="keys">
          <tbody>
            {[
              ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
              ['Ctrl+S', 'Save now'],
              ['Ctrl+E', 'Export PNG'],
              ['Ctrl+D', 'Duplicate layer'],
              ['Ctrl+G / +Shift', 'Group / ungroup'],
              ['1 · 2 · 3', 'Layout · Rig · Pose (2D canvas tab)'],
              ['F', 'Fit canvas to window'],
              ['Wheel · Space+drag', 'Zoom · pan'],
              ['Arrows (Shift = ×10)', 'Nudge layer'],
              ['P', 'Set pivot tool'],
              ['J', 'Add-joint tool (Rig)'],
              ['Alt (Pose drag)', 'Switch IK ↔ FK'],
              ['Shift (Rig drag)', 'Move joint with children'],
              ['Delete', 'Delete layer / joint'],
              ['Esc', 'Back to select tool'],
            ].map(([k, v]) => (
              <tr key={k}>
                <td>
                  <kbd>{k}</kbd>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

export function Toasts() {
  const { ui } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {ui.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div>
            <p>{t.text}</p>
            {t.details && (
              <ul>
                {t.details.slice(0, 6).map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
          <button className="ghost" onClick={() => store.dismissToast(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
