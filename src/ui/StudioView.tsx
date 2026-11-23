import { zipSync } from 'fflate';
import { useEffect, useRef, useState } from 'react';
import { GUIDE_KINDS } from '../core/character.ts';
import type { GuideKind } from '../core/character.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import type { JointId } from '../pose/index.ts';
import { BODY_PRESETS, MODEL_CREDIT, JOINT_DEFS, POSABLE_JOINTS, POSE_PRESETS, PROPORTION_RANGES, SHAPE_KEYS, SHAPE_RANGES, VIEW_PRESETS, buildRestSkeleton, getRot, jointDef } from '../pose/index.ts';
import type { Proportions } from '../pose/index.ts';
import { GUIDE_DEFAULT_TRANSPARENT } from '../render/poseGuideImages.ts';
import { StudioViewport } from '../render/studioViewport.ts';
import { NumberField, Section, TextField, download } from './controls.tsx';

const OUTPUT_PRESETS: [string, number, number][] = [
  ['Portrait 2:3 — 768×1152', 768, 1152],
  ['Portrait 3:4 — 768×1024', 768, 1024],
  ['Square — 1024×1024', 1024, 1024],
  ['Landscape 3:2 — 1152×768', 1152, 768],
  ['Tall 9:16 — 720×1280', 720, 1280],
  ['Wide 16:9 — 1280×720', 1280, 720],
];

function StudioCanvas() {
  const snap = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<StudioViewport | null>(null);
  const c = snap.character!;
  const ui = snap.ui;
  const stateFor = () => ({
    rest: buildRestSkeleton(c.studio.proportions),
    pose: c.studio.pose,
    camera: c.studio.camera,
    aspect: c.studio.output.width / c.studio.output.height,
    shape: c.studio.shape,
    artwork: store.bodyArtwork(c),
    overlay: store.overlayState(c),
    selected: ui.selectedJoint3d,
    pinFeet: ui.studio.pinFeet,
    showHandles: ui.studio.showHandles,
    showGrid: ui.studio.showGrid,
  });

  useEffect(() => {
    const host = hostRef.current!;
    let vp: StudioViewport;
    try {
      vp = new StudioViewport(host, stateFor(), {
        onPose: (pose, phase) => {
          if (phase === 'start') store.beginStudioGesture();
          else if (phase === 'drag') store.previewStudioPose(pose);
          else {
            store.previewStudioPose(pose);
            store.endStudioGesture('Pose with handle');
          }
        },
        onCamera: (cam) => store.setStudioCamera(cam),
        onSelect: (id) => store.selectJoint3d(id),
        onNotice: (m) => store.studioNotice(m),
      });
    } catch (e) {
      store.fail(new Error(`The 3D viewport could not start (${e instanceof Error ? e.message : String(e)}). It needs WebGL — enable hardware acceleration in your browser.`));
      return;
    }
    vpRef.current = vp;
    if (new URLSearchParams(location.search).has('e2e')) (window as unknown as Record<string, unknown>).__cfStudio = vp;
    return () => {
      vp.dispose();
      vpRef.current = null;
      delete (window as unknown as Record<string, unknown>).__cfStudio;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    vpRef.current?.setState(stateFor());
  });

  // decode the artwork images the viewport needs (original, projected front/back)
  const art = c.studio.artwork;
  useEffect(() => {
    void store.ensureArtwork();
  }, [c.originalAssetId, art.front?.assetId, art.back?.assetId, art.overlay.show]);

  return (
    <div className="studio-center">
      <div ref={hostRef} className="studio-host" data-testid="studio-host" />
      <div className="studio-overlay top">
        {VIEW_PRESETS.map((v) => (
          <button key={v.id} className="ghost small" onClick={() => store.setCameraView(v.id)}>
            {v.label}
          </button>
        ))}
        <button className="small" onClick={() => store.frameStudioCamera()} title="Zoom and centre so the whole figure fits with a margin">
          Frame figure
        </button>
      </div>
      {ui.studio.notice && <div className="studio-notice">{ui.studio.notice}</div>}
      <div className="studio-overlay bottom">
        Drag <b className="o">orange handles</b> (hands, feet) to pose limbs · <b className="o">diamond</b> moves the body (Shift = along the floor) · <b className="b">blue dots</b> rotate a joint · drag empty space to orbit · Shift/right-drag pans · wheel zooms
      </div>
    </div>
  );
}

function LeftPanel() {
  const { character: c } = useApp();
  const [name, setName] = useState('');
  if (!c) return null;
  const st = c.studio;
  return (
    <aside className="panel left studio-left">
      <div className="panel-h">
        <h2>Poses</h2>
      </div>
      <div className="scroll">
        <Section title="Preset poses">
          <div className="preset-grid" data-testid="presets">
            {POSE_PRESETS.map((p) => (
              <button key={p.id} title={p.description} data-testid={`preset-${p.id}`} onClick={() => store.applyPosePreset(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="row wrap">
            <button onClick={() => store.mirrorStudioPose()} title="Swap left and right">
              Mirror L↔R
            </button>
            <button onClick={() => store.resetStudioPose()}>Reset</button>
            <button onClick={() => store.groundStudioPose()} title="Lower or raise the body so the feet touch the floor">
              Place on ground
            </button>
          </div>
        </Section>
        <Section title="Saved poses" hint="Saved with this character: joint angles, body position and camera.">
          <div className="row">
            <input type="text" placeholder="Name this pose" value={name} data-testid="pose-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (store.saveStudioPoseAs(name), setName(''))} />
            <button
              className="primary"
              data-testid="save-pose"
              onClick={() => {
                store.saveStudioPoseAs(name);
                setName('');
              }}
            >
              Save
            </button>
          </div>
          {st.poses.length === 0 && <p className="muted">No saved poses yet.</p>}
          <ul className="poses" data-testid="saved-poses">
            {st.poses.map((p) => (
              <li key={p.id}>
                <TextField value={p.name} onCommit={(v) => store.renameSavedStudioPose(p.id, v)} />
                <div className="row wrap">
                  <button onClick={() => store.applySavedStudioPose(p.id)}>Apply</button>
                  <button onClick={() => store.overwriteSavedStudioPose(p.id)} title="Replace this saved pose with the current pose and camera">
                    Update
                  </button>
                  <button className="danger" onClick={() => window.confirm(`Delete saved pose "${p.name}"?`) && store.deleteSavedStudioPose(p.id)}>
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
        <BodySection />
        <ArtworkSection />
      </div>
    </aside>
  );
}

function BodySection() {
  const { character: c } = useApp();
  if (!c) return null;
  const st = c.studio;
  return (
    <Section title="Character body" hint="Size the model to match your character. Height and width change the whole body; the shape sliders refine chest, waist, limbs, hands and feet.">
      <select
        aria-label="Body preset"
        data-testid="body-preset"
        value=""
        onChange={(e) => {
          if (e.target.value) store.applyBodyPreset(e.target.value);
        }}
      >
        <option value="">Body presets…</option>
        {BODY_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <h4 className="sub">Size and proportions</h4>
      {(Object.keys(PROPORTION_RANGES) as (keyof Proportions)[]).map((k) => {
        const r = PROPORTION_RANGES[k];
        return (
          <label key={k} className="slider-row">
            <span>{r.label}</span>
            <input type="range" min={r.min} max={r.max} step={r.step} value={st.proportions[k]} aria-label={r.label} data-testid={`prop-${k}`} onChange={(e) => store.setProportions({ [k]: Number(e.target.value) })} />
            <em>{k === 'height' ? `${st.proportions[k].toFixed(2)} m` : `${Math.round(st.proportions[k] * 100)}%`}</em>
          </label>
        );
      })}
      <h4 className="sub">Body shape</h4>
      {SHAPE_KEYS.map((k) => {
        const r = SHAPE_RANGES[k];
        return (
          <label key={k} className="slider-row">
            <span>{r.label}</span>
            <input type="range" min={r.min} max={r.max} step={r.step} value={st.shape[k]} aria-label={r.label} data-testid={`shape-${k}`} onChange={(e) => store.setShape({ [k]: Number(e.target.value) })} />
            <em>{Math.round(st.shape[k] * 100)}%</em>
          </label>
        );
      })}
      <button className="ghost small" onClick={() => store.resetBodyShape()}>
        Reset body shape
      </button>
      <p className="muted" data-testid="model-credit">
        Model: “{MODEL_CREDIT.title}” by{' '}
        <a href={MODEL_CREDIT.authorUrl} target="_blank" rel="noreferrer">
          {MODEL_CREDIT.author}
        </a>
        , <a href={MODEL_CREDIT.licenseUrl} target="_blank" rel="noreferrer">{MODEL_CREDIT.license}</a>. Rigged and sized for CharacterForge.
      </p>
    </Section>
  );
}

function ArtworkSection() {
  const { character: c, ui } = useApp();
  if (!c) return null;
  const a = c.studio.artwork;
  const fit = ui.studio.fit;
  const hasOriginal = !!c.originalAssetId;
  const stale = !!a.front && a.front.assetId !== c.originalAssetId;
  return (
    <Section title="Match to artwork" hint="Line the model up with your drawing, then project the drawing onto it. The model keeps the drawing as you pose it for your panels.">
      {!hasOriginal ? (
        <p className="muted">Import the original artwork in the Character tab first.</p>
      ) : (
        <>
          <ol className="steps">
            <li>Pose the model like your drawing (usually Reset or the A-pose preset), then use <b>Match view</b>.</li>
            <li>Turn on the overlay to compare, adjust the body, or let <b>Fit body to artwork</b> do it.</li>
            <li><b>Project artwork onto model</b>. Then pose it however you like.</li>
          </ol>
          <div className="row wrap">
            <button onClick={() => store.matchView()} data-testid="match-view" title="Front view with a narrow lens, framed on the figure">
              Match view
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={a.overlay.show} data-testid="overlay-toggle" onChange={(e) => store.setOverlay({ show: e.target.checked })} />
            Show drawing over the viewport
          </label>
          {a.overlay.show && (
            <label className="slider-row">
              <span>Opacity</span>
              <input type="range" min={0.1} max={1} step={0.05} value={a.overlay.opacity} aria-label="Overlay opacity" onChange={(e) => store.setOverlay({ opacity: Number(e.target.value) })} />
              <em>{Math.round(a.overlay.opacity * 100)}%</em>
            </label>
          )}
          <div className="row wrap">
            {fit.running ? (
              <button className="danger" onClick={() => store.cancelFit()} data-testid="fit-cancel">
                Stop fitting
              </button>
            ) : (
              <button onClick={() => void store.fitToArtwork()} data-testid="fit-body" title="Adjusts proportions and body shape so the model's front silhouette matches the drawing's. Height is kept.">
                Fit body to artwork
              </button>
            )}
          </div>
          {fit.running && <progress max={1} value={fit.fraction} aria-label="Fitting progress" />}
          {fit.message && <p className="muted" data-testid="fit-message">{fit.message}{fit.running && fit.iou !== null ? ` Match ${(fit.iou * 100).toFixed(0)}%` : ''}</p>}
          <div className="row wrap">
            <button className="primary" onClick={() => void store.projectArtwork(a.back?.assetId ?? null)} data-testid="project-artwork" title="Wraps the drawing onto the model in its current pose">
              {a.front ? 'Project again' : 'Project artwork onto model'}
            </button>
            {a.front && (
              <button className="danger" onClick={() => store.clearProjection()} data-testid="clear-projection">
                Remove
              </button>
            )}
          </div>
          {stale && <p className="error">The original artwork changed since it was projected. Project again.</p>}
          {a.front && (
            <>
              <label className="check">
                <input type="checkbox" checked={a.show} data-testid="artwork-show" onChange={(e) => store.setArtworkOptions({ show: e.target.checked })} />
                Show artwork on the model
              </label>
              <label className="slider-row">
                <span>Fill</span>
                <input type="color" value={a.fill} aria-label="Fill colour" onChange={(e) => store.setArtworkOptions({ fill: e.target.value })} />
                <em />
              </label>
              <label className="slider-row">
                <span>Shading</span>
                <input type="range" min={0} max={1} step={0.05} value={a.shading} aria-label="Shading" onChange={(e) => store.setArtworkOptions({ shading: Number(e.target.value) })} />
                <em>{Math.round(a.shading * 100)}%</em>
              </label>
              {c.references.length > 0 && (
                <label className="slider-row">
                  <span>Back view</span>
                  <select aria-label="Back-view image" value={a.back?.assetId ?? ''} onChange={(e) => void store.setBackView(e.target.value || null)}>
                    <option value="">None (fill colour)</option>
                    {c.references.map((r) => (
                      <option key={r.id} value={r.assetId}>
                        {r.label || r.fileName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p className="muted">
                The drawing covers what faces the camera in the projected pose. Sides, and the back without a back view, use the fill colour. Project again after changing the body.
              </p>
            </>
          )}
        </>
      )}
    </Section>
  );
}

const AXES: { key: 'x' | 'y' | 'z'; label: string }[] = [
  { key: 'x', label: 'Bend fwd/back (X)' },
  { key: 'y', label: 'Twist / turn (Y)' },
  { key: 'z', label: 'Tilt sideways (Z)' },
];

function JointInspector() {
  const { character: c, ui } = useApp();
  if (!c) return null;
  const id = ui.selectedJoint3d;
  const def = id ? jointDef(id) : null;
  return (
    <Section title="Selected joint" hint="Click a blue dot in the viewport (or choose here), then drag it or use the sliders. For arms and legs a negative X swings the limb forward.">
      <select aria-label="Joint" value={id ?? ''} data-testid="joint-select" onChange={(e) => store.selectJoint3d((e.target.value || null) as JointId | null)}>
        <option value="">— none —</option>
        {POSABLE_JOINTS.map((j) => (
          <option key={j} value={j}>
            {JOINT_DEFS.find((d) => d.id === j)!.label}
          </option>
        ))}
      </select>
      {id && def && (
        <>
          {AXES.map((a) => {
            const lim = def.limits[a.key];
            const v = getRot(c.studio.pose, id)[a.key];
            const locked = lim.min === lim.max;
            return (
              <label key={a.key} className={`slider-row${locked ? ' locked' : ''}`}>
                <span>{a.label}</span>
                <input type="range" min={lim.min} max={lim.max} step={1} value={v} disabled={locked} aria-label={`${def.label} ${a.label}`} onChange={(e) => store.setJointEuler(id, { [a.key]: Number(e.target.value) })} />
                <NumberField value={v} digits={0} min={lim.min} max={lim.max} width={46} onCommit={(n) => store.setJointEuler(id, { [a.key]: n })} />
              </label>
            );
          })}
          <button onClick={() => store.setJointEuler(id, { x: 0, y: 0, z: 0 })}>Reset this joint</button>
        </>
      )}
    </Section>
  );
}

function BodyInspector() {
  const { character: c, ui } = useApp();
  if (!c) return null;
  const r = c.studio.pose.root;
  return (
    <Section title="Body position">
      <div className="grid3">
        {(['x', 'y', 'z'] as const).map((k) => (
          <NumberField key={k} label={k.toUpperCase()} value={r[k]} step={0.05} digits={2} width={54} onCommit={(n) => store.setRootPosition({ [k]: n })} />
        ))}
      </div>
      <label className="check" title="While dragging the body, keep both feet where they are (the legs bend to follow)">
        <input type="checkbox" checked={ui.studio.pinFeet} onChange={(e) => store.setStudioFlag({ pinFeet: e.target.checked })} />
        Keep feet planted when moving the body
      </label>
      <label className="check">
        <input type="checkbox" checked={ui.studio.showHandles} onChange={(e) => store.setStudioFlag({ showHandles: e.target.checked })} />
        Show joint handles
      </label>
      <label className="check">
        <input type="checkbox" checked={ui.studio.showGrid} onChange={(e) => store.setStudioFlag({ showGrid: e.target.checked })} />
        Show floor grid
      </label>
    </Section>
  );
}

function CameraInspector() {
  const { character: c } = useApp();
  if (!c) return null;
  const cam = c.studio.camera;
  const o = c.studio.output;
  const presetValue = OUTPUT_PRESETS.find((p) => p[1] === o.width && p[2] === o.height)?.[0] ?? '';
  return (
    <Section title="Camera and output frame" hint="The viewport shows exactly the frame that is rendered.">
      <label className="slider-row">
        <span>Angle</span>
        <input type="range" min={-180} max={180} value={Math.round(cam.azimuth)} aria-label="Camera angle" onChange={(e) => store.setCameraField('azimuth', Number(e.target.value))} />
        <em>{Math.round(cam.azimuth)}°</em>
      </label>
      <label className="slider-row">
        <span>Height</span>
        <input type="range" min={-85} max={85} value={Math.round(cam.elevation)} aria-label="Camera elevation" onChange={(e) => store.setCameraField('elevation', Number(e.target.value))} />
        <em>{Math.round(cam.elevation)}°</em>
      </label>
      <label className="slider-row">
        <span>Lens</span>
        <input type="range" min={10} max={80} value={Math.round(cam.fov)} aria-label="Field of view" onChange={(e) => store.setCameraField('fov', Number(e.target.value))} />
        <em>{Math.round(cam.fov)}° FOV</em>
      </label>
      <select
        aria-label="Output size"
        value={presetValue}
        data-testid="output-size"
        onChange={(e) => {
          const p = OUTPUT_PRESETS.find((x) => x[0] === e.target.value);
          if (p) store.setOutputSize(p[1], p[2]);
        }}
      >
        <option value="">Custom {o.width}×{o.height}</option>
        {OUTPUT_PRESETS.map((p) => (
          <option key={p[0]} value={p[0]}>
            {p[0]}
          </option>
        ))}
      </select>
      <div className="row">
        <NumberField label="W" value={o.width} digits={0} min={64} max={4096} width={58} onCommit={(n) => store.setOutputSize(Math.round(n), o.height)} />
        <NumberField label="H" value={o.height} digits={0} min={64} max={4096} width={58} onCommit={(n) => store.setOutputSize(o.width, Math.round(n))} />
      </div>
    </Section>
  );
}

function GuideInspector() {
  const { character: c, project } = useApp();
  const [kind, setKind] = useState<GuideKind>('mannequin');
  const [transparent, setTransparent] = useState(GUIDE_DEFAULT_TRANSPARENT.mannequin);
  const [open, setOpen] = useState(true);
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const artRev = useApp().ui.studio.artRev;
  const key = JSON.stringify([c?.studio, kind, transparent, open, artRev]);
  useEffect(() => {
    if (!open || !c) return;
    const t = setTimeout(() => {
      try {
        const cv = store.renderGuidePreview(kind, transparent);
        cv.style.cssText = 'width:100%;height:auto;display:block';
        host.current?.replaceChildren(cv);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!c || !project) return null;
  const save = async (k: GuideKind, tr: boolean, scale = 1) => {
    try {
      const f = await store.renderGuideFile(k, tr, scale);
      download(f.bytes, f.fileName, 'image/png');
    } catch (e) {
      store.fail(e);
    }
  };
  const pack = async () => {
    try {
      const files: Record<string, Uint8Array> = {};
      for (const g of GUIDE_KINDS) {
        // the character render needs projected artwork; leave it out of the pack when there is none
        if (g.id === 'textured' && !c.studio.artwork.front && !c.studio.artwork.back) continue;
        const f = await store.renderGuideFile(g.id, GUIDE_DEFAULT_TRANSPARENT[g.id]);
        files[`${g.id}.png`] = f.bytes;
      }
      files['pose.json'] = new TextEncoder().encode(store.poseGuideJson());
      download(zipSync(files, { level: 0 }), `${project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'character'}-guides.zip`, 'application/zip');
    } catch (e) {
      store.fail(e);
    }
  };
  return (
    <Section title="Pose-guide images" hint="Rendered with the same camera and frame as the viewport. These are the images a generation backend (or your own tool) receives.">
      <div className="seg small-seg" role="tablist">
        {GUIDE_KINDS.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={kind === g.id}
            className={kind === g.id ? 'on' : ''}
            title={g.description}
            data-testid={`guide-${g.id}`}
            onClick={() => {
              setKind(g.id);
              setTransparent(GUIDE_DEFAULT_TRANSPARENT[g.id]);
            }}
          >
            {g.label}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={transparent} data-testid="guide-transparent" onChange={(e) => setTransparent(e.target.checked)} />
        Transparent background
      </label>
      {err && <p className="error">{err}</p>}
      <div ref={host} className="guide-preview checker" data-testid="guide-preview" />
      <div className="row wrap">
        <button className="primary" data-testid="download-guide" onClick={() => void save(kind, transparent)}>
          Download PNG
        </button>
        <button onClick={() => void save(kind, transparent, 2)} title="Twice the output size">
          2×
        </button>
        <button onClick={() => void pack()} title="All guide images plus pose.json (joint positions and keypoints)">
          Guide pack (.zip)
        </button>
      </div>
      <button className="ghost small" onClick={() => setOpen(!open)}>
        {open ? 'Pause preview' : 'Resume preview'}
      </button>
    </Section>
  );
}

export function StudioView() {
  const { character: c, ui } = useApp();
  useEffect(() => {
    if (ui.studio.model === 'idle') void store.ensureModel().catch(() => undefined);
  }, [ui.studio.model]);
  if (!c) return null;
  if (ui.studio.model !== 'ready') {
    return (
      <div className="workspace studio" data-testid="studio-view">
        <main className="center">
          <div className="empty" data-testid="model-status" style={{ pointerEvents: 'auto' }}>
            {ui.studio.model === 'error' ? (
              <>
                <p className="error">{ui.studio.modelError}</p>
                <button onClick={() => void store.ensureModel().catch(() => undefined)}>Try again</button>
              </>
            ) : (
              <p>Loading the character model…</p>
            )}
          </div>
        </main>
      </div>
    );
  }
  return (
    <div className="workspace studio" data-testid="studio-view">
      <LeftPanel />
      <main className="center">
        <StudioCanvas />
        <footer className="status">
          <span>
            Pose studio — a smooth character model you size, pose and project your artwork onto. {c.originalAssetId ? '' : 'Import original artwork in the Character tab to match and generate from it.'}
          </span>
          <span className="spacer" />
          <span className="muted">
            {c.studio.output.width}×{c.studio.output.height} · {c.studio.poses.length} saved pose{c.studio.poses.length === 1 ? '' : 's'}
          </span>
        </footer>
      </main>
      <aside className="panel right">
        <div className="panel-h">
          <h2>Inspector</h2>
        </div>
        <div className="scroll">
          <JointInspector />
          <BodyInspector />
          <CameraInspector />
          <GuideInspector />
        </div>
      </aside>
    </div>
  );
}
