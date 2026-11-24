import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import {
  PAGE_LAYOUTS, PAGE_PRESETS, bubbleOutline, hitTestPage, mmToPx, pageExportSize, pagePixelSize, pagePrintInfo, panelContentPolygon, polygonBounds,
} from '../core/page.ts';
import type { BubbleKind, LayoutKind, PageState, PanelShape, Placement } from '../core/page.ts';
import type { Vec2 } from '../core/math.ts';
import { renderPage } from '../render/pageRender.ts';
import { NumberField, Section, download } from './controls.tsx';

/**
 * The Page workspace: lay out panels, drop accepted results into them, letter the page, export at print DPI.
 *
 * The canvas is a single <canvas> painted by `renderPage` — the same function the export uses — so the preview cannot
 * drift from the print. Selection outlines and handles are drawn on top in a second pass.
 */

const HANDLE = 7;

type Drag =
  | { kind: 'move-placement'; id: string; start: Vec2; orig: { x: number; y: number } }
  | { kind: 'move-bubble'; id: string; start: Vec2; orig: { x: number; y: number } }
  | { kind: 'scale-placement'; id: string; start: Vec2; origScale: number; origDist: number }
  | { kind: 'resize-bubble'; id: string; start: Vec2; orig: { width: number; height: number } }
  | { kind: 'move-panel'; id: string; start: Vec2; orig: Vec2[] }
  | { kind: 'pan'; start: Vec2; origPan: Vec2 };

export function PageView() {
  const { page, character, ui } = useApp();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(0.5);
  const [pan, setPan] = useState<Vec2>({ x: 0, y: 0 });
  const dragRef = useRef<Drag | null>(null);
  const [dragTick, setDragTick] = useState(0);

  const sel = ui.page.selection;

  // decode page images whenever the page or the asset set changes
  useEffect(() => {
    void store.refreshPageImages();
  }, [page?.placements.length, ui.page.imageRev]);

  const pageSize = page ? pagePixelSize(page) : { width: 1, height: 1 };

  // fit the page into the viewport on first show
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !page) return;
    const r = el.getBoundingClientRect();
    const z = Math.min((r.width - 80) / pageSize.width, (r.height - 80) / pageSize.height);
    setZoom(Math.max(0.05, Math.min(2, z)));
    setPan({ x: 0, y: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.size.width, page?.size.height, page?.dpi]);

  // paint
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !page) return;
    const out = renderPage(page, {
      scale: zoom,
      borders: ui.page.showBorders,
      bubbles: ui.page.showBubbles,
      bleed: false,
      image: (id) => store.pageImage(id),
      measure: (text, fontSize) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return text.length * fontSize * 0.55;
        ctx.font = `600 ${fontSize * zoom}px 'Segoe UI', 'Hiragino Sans', 'Yu Gothic UI', system-ui, sans-serif`;
        return ctx.measureText(text).width / zoom;
      },
    });
    canvas.width = out.width;
    canvas.height = out.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(out.canvas, 0, 0);
    drawOverlay(ctx, page, sel, zoom);
  }, [page, zoom, sel, ui.page.showBorders, ui.page.showBubbles, ui.page.imageRev, dragTick]);

  const toPage = useCallback(
    (e: { clientX: number; clientY: number }): Vec2 => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
    },
    [zoom],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (!page) return;
    const p = toPage(e);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);

    // middle button or space-less empty area pans
    if (e.button === 1) {
      dragRef.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origPan: pan };
      return;
    }

    const hit = hitTestPage(page, p);
    if (!hit) {
      store.selectPageItem(null);
      dragRef.current = { kind: 'pan', start: { x: e.clientX, y: e.clientY }, origPan: pan };
      return;
    }
    store.selectPageItem({ kind: hit.kind, id: hit.id });

    if (hit.kind === 'placement') {
      const pl = page.placements.find((x) => x.id === hit.id)!;
      const b = polygonBounds(placementCorners(pl));
      const nearCorner = Math.hypot(p.x - b.x1, p.y - b.y1) < HANDLE * 2 / zoom;
      if (nearCorner) {
        dragRef.current = { kind: 'scale-placement', id: pl.id, start: p, origScale: pl.scale, origDist: Math.max(1, Math.hypot(p.x - pl.x, p.y - pl.y)) };
      } else {
        dragRef.current = { kind: 'move-placement', id: pl.id, start: p, orig: { x: pl.x, y: pl.y } };
      }
    } else if (hit.kind === 'bubble') {
      const b = page.bubbles.find((x) => x.id === hit.id)!;
      const right = b.x + b.width / 2;
      const bottom = b.y + b.height / 2;
      if (Math.hypot(p.x - right, p.y - bottom) < HANDLE * 2 / zoom) {
        dragRef.current = { kind: 'resize-bubble', id: b.id, start: p, orig: { width: b.width, height: b.height } };
      } else {
        dragRef.current = { kind: 'move-bubble', id: b.id, start: p, orig: { x: b.x, y: b.y } };
      }
    } else if (hit.kind === 'panel') {
      const panel = page.panels.find((x) => x.id === hit.id)!;
      dragRef.current = { kind: 'move-panel', id: panel.id, start: p, orig: panel.points.map((q) => ({ ...q })) };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !page) return;
    if (d.kind === 'pan') {
      setPan({ x: d.origPan.x + (e.clientX - d.start.x), y: d.origPan.y + (e.clientY - d.start.y) });
      return;
    }
    const p = toPage(e);
    if (d.kind === 'move-placement') {
      store.updatePlacement(d.id, { x: d.orig.x + (p.x - d.start.x), y: d.orig.y + (p.y - d.start.y) });
    } else if (d.kind === 'scale-placement') {
      const dist = Math.max(1, Math.hypot(p.x - (page.placements.find((x) => x.id === d.id)?.x ?? 0), p.y - (page.placements.find((x) => x.id === d.id)?.y ?? 0)));
      store.updatePlacement(d.id, { scale: Math.max(0.01, (d.origScale * dist) / d.origDist) });
    } else if (d.kind === 'move-bubble') {
      store.updateBubble(d.id, { x: d.orig.x + (p.x - d.start.x), y: d.orig.y + (p.y - d.start.y) });
    } else if (d.kind === 'resize-bubble') {
      store.updateBubble(d.id, { width: Math.max(20, d.orig.width + (p.x - d.start.x) * 2), height: Math.max(20, d.orig.height + (p.y - d.start.y) * 2) });
    } else if (d.kind === 'move-panel') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      store.updatePanel(d.id, { points: d.orig.map((q) => ({ x: q.x + dx, y: q.y + dy })) });
    }
    setDragTick((t) => t + 1);
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.max(0.05, Math.min(3, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  };

  if (!page) return null;

  const info = pagePrintInfo(page);
  const selectedPlacement = sel?.kind === 'placement' ? page.placements.find((p) => p.id === sel.id) ?? null : null;
  const selectedBubble = sel?.kind === 'bubble' ? page.bubbles.find((b) => b.id === sel.id) ?? null : null;
  const selectedPanel = sel?.kind === 'panel' ? page.panels.find((p) => p.id === sel.id) ?? null : null;

  return (
    <div className="workspace page-ws" data-testid="page-view">
      <aside className="panel left">
        <div className="panel-h">
          <h2>Page</h2>
          <span className="muted">{info.mm}</span>
        </div>
        <div className="scroll">
          <Section title="Size & print" hint={`Exports at ${info.width} × ${info.height} px · ${info.dpi} dpi · ${info.megapixels.toFixed(1)} MP`}>
            <label className="field col-field">
              <span>Preset</span>
              <select
                data-testid="page-preset"
                value={PAGE_PRESETS.find((p) => p.width === page.size.width && p.height === page.size.height)?.id ?? 'custom'}
                onChange={(e) => {
                  const p = PAGE_PRESETS.find((x) => x.id === e.target.value);
                  if (p) store.setPageSize({ width: p.width, height: p.height }, p.dpi);
                }}
              >
                {PAGE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
            </label>
            <div className="row">
              <NumberField label="W" value={page.size.width} digits={0} min={20} max={2000} width={64} suffix="mm" onCommit={(v) => store.setPageSize({ width: v, height: page.size.height }, page.dpi)} />
              <NumberField label="H" value={page.size.height} digits={0} min={20} max={2000} width={64} suffix="mm" onCommit={(v) => store.setPageSize({ width: page.size.width, height: v }, page.dpi)} />
            </div>
            <div className="row">
              <NumberField label="DPI" value={page.dpi} digits={0} min={72} max={600} width={64} onCommit={(v) => store.setPageSize(page.size, v)} />
              <NumberField label="Bleed" value={page.bleed} digits={1} min={0} max={20} width={56} suffix="mm" onCommit={(v) => store.setPageSettings({ bleed: v })} />
            </div>
          </Section>

          <Section title="Panels" hint="A layout replaces the frames. Images already placed stay on the page.">
            <div className="preset-grid">
              {PAGE_LAYOUTS.map((l) => (
                <button key={l.id} data-testid={`layout-${l.id}`} onClick={() => store.applyPageLayout(l.id as LayoutKind)}>
                  {l.label}
                </button>
              ))}
            </div>
            <div className="row wrap">
              <button data-testid="add-panel" onClick={() => store.addPanel('rect')}>
                + Rect
              </button>
              <button onClick={() => store.addPanel('skewed')}>+ Skewed</button>
            </div>
            <div className="row">
              <NumberField label="Gutter" value={page.gutter} digits={1} min={0} max={40} width={56} suffix="mm" onCommit={(v) => store.setPageSettings({ gutter: v })} />
              <NumberField label="Border" value={page.borderWidth} digits={2} min={0} max={10} width={56} suffix="mm" onCommit={(v) => store.setPageSettings({ borderWidth: v })} />
            </div>
            <div className="row">
              <label className="field inline">
                <span>Paper</span>
                <input type="color" value={page.background} onChange={(e) => store.setPageSettings({ background: e.target.value })} />
              </label>
              <label className="field inline">
                <span>Ink</span>
                <input type="color" value={page.borderColor} onChange={(e) => store.setPageSettings({ borderColor: e.target.value })} />
              </label>
            </div>
          </Section>

          <Section title="Lettering">
            <div className="row wrap">
              {(['speech', 'thought', 'caption', 'shout'] as BubbleKind[]).map((k) => (
                <button key={k} data-testid={`add-bubble-${k}`} onClick={() => store.addBubble(k)}>
                  + {k}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Export">
            <div className="row wrap">
              <button
                className="primary"
                data-testid="export-page"
                onClick={async () => {
                  const r = await store.exportPagePng();
                  if (r) {
                    const name = (character ? 'page' : 'page').replace(/\s+/g, '-');
                    download(r.blob, `${name}-${r.width}x${r.height}-${r.dpi}dpi.png`, 'image/png');
                    store.toast('ok', `Exported ${r.width} × ${r.height} px at ${r.dpi} dpi.`);
                  }
                }}
              >
                Export page PNG
              </button>
            </div>
            <p className="hint">Print size: {info.mm} at {info.dpi} dpi. The bleed is included in the export.</p>
          </Section>
        </div>
      </aside>

      <main className="center page-center">
        <div className="page-stage" ref={wrapRef} onWheel={onWheel}>
          <div className="page-paper" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
            <canvas
              ref={canvasRef}
              data-testid="page-canvas"
              className="page-canvas"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </div>
        </div>
        <footer className="status">
          <span>
            {page.panels.length} panel{page.panels.length === 1 ? '' : 's'} · {page.placements.length} image{page.placements.length === 1 ? '' : 's'} · {page.bubbles.length} bubble
            {page.bubbles.length === 1 ? '' : 's'}
          </span>
          <span className="spacer" />
          <label className="check">
            <input type="checkbox" checked={ui.page.showBorders} onChange={(e) => store.setPageOption({ showBorders: e.target.checked })} /> Borders
          </label>
          <label className="check">
            <input type="checkbox" checked={ui.page.showBubbles} onChange={(e) => store.setPageOption({ showBubbles: e.target.checked })} /> Lettering
          </label>
          <span className="muted">{Math.round(zoom * 100)}%</span>
        </footer>
      </main>

      <aside className="panel right">
        <div className="panel-h">
          <h2>{selectedPlacement ? 'Placed image' : selectedBubble ? 'Bubble' : selectedPanel ? 'Panel' : 'Page'}</h2>
        </div>
        <div className="scroll">
          {selectedPlacement ? (
            <PlacementInspector placement={selectedPlacement} page={page} />
          ) : selectedBubble ? (
            <BubbleInspector id={selectedBubble.id} />
          ) : selectedPanel ? (
            <PanelInspector id={selectedPanel.id} />
          ) : (
            <PlacementPicker page={page} />
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- inspectors

function PlacementPicker({ page }: { page: PageState }) {
  const { character } = useApp();
  const accepted = character ? character.generations.filter((g) => g.status === 'accepted') : [];
  const [target, setTarget] = useState<string>('');
  const panelId = target || page.panels[0]?.id || '';
  return (
    <>
      <Section title="Add a character" hint="Accepted results from the Generate tab. Pick a panel, then place.">
        <label className="field col-field">
          <span>Into panel</span>
          <select value={panelId} onChange={(e) => setTarget(e.target.value)} data-testid="target-panel">
            {page.panels.map((p, i) => (
              <option key={p.id} value={p.id}>
                {p.name || `Panel ${i + 1}`}
              </option>
            ))}
            <option value="">On the page (no frame)</option>
          </select>
        </label>
        {accepted.length === 0 ? (
          <p className="hint">No accepted results yet. Generate or import one in the Generate tab and accept it.</p>
        ) : (
          <ul className="page-picker" data-testid="accepted-list">
            {accepted.map((g) => {
              const url = store.assetUrl(g.outputAssetId);
              return (
                <li key={g.id}>
                  <div className="thumb checker">{url ? <img src={url} alt="Accepted result" /> : null}</div>
                  <div className="grow">
                    <div className="muted">{g.provenance.poseName ?? 'unsaved pose'}</div>
                    <div className="muted">{new Date(g.createdAt).toLocaleDateString()}</div>
                  </div>
                  <button data-testid="place-result" onClick={() => store.placeResult(g.id, panelId || null)}>
                    Place
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Section title="Or place the 2D canvas" hint="Composites the 2D canvas layers as they are now.">
        <button onClick={() => void store.placeCanvas(panelId || null)}>Place 2D canvas</button>
      </Section>
      <Section title="How this works">
        <p className="hint">
          Each placed image keeps a link to the character profile and the pose it was made in. Re-pose the character, generate a new result, then use
          <b> Update image</b> on the placement to swap it in without moving it.
        </p>
      </Section>
    </>
  );
}

function PlacementInspector({ placement, page }: { placement: Placement; page: PageState }) {
  const { character } = useApp();
  const accepted = character ? character.generations.filter((g) => g.status === 'accepted') : [];
  const src = placement.source;
  return (
    <>
      <Section title="Position">
        <div className="row">
          <NumberField label="X" value={placement.x} digits={0} width={64} onCommit={(v) => store.updatePlacement(placement.id, { x: v })} />
          <NumberField label="Y" value={placement.y} digits={0} width={64} onCommit={(v) => store.updatePlacement(placement.id, { y: v })} />
        </div>
        <div className="row">
          <NumberField label="Scale" value={placement.scale} digits={3} step={0.01} min={0.01} width={64} onCommit={(v) => store.updatePlacement(placement.id, { scale: v })} />
          <NumberField label="Rot" value={placement.rotation} digits={1} width={56} suffix="°" onCommit={(v) => store.updatePlacement(placement.id, { rotation: v })} />
        </div>
        <div className="row">
          <NumberField label="Opacity" value={placement.opacity} digits={2} step={0.05} min={0} max={1} width={56} onCommit={(v) => store.updatePlacement(placement.id, { opacity: v })} />
          <label className="check">
            <input type="checkbox" checked={placement.flipX} onChange={(e) => store.updatePlacement(placement.id, { flipX: e.target.checked })} /> Flip
          </label>
        </div>
        <label className="field col-field">
          <span>Panel</span>
          <select value={placement.panelId ?? ''} onChange={(e) => store.updatePlacement(placement.id, { panelId: e.target.value || null })}>
            <option value="">On the page (no frame)</option>
            {page.panels.map((p, i) => (
              <option key={p.id} value={p.id}>
                {p.name || `Panel ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
        <div className="row wrap">
          <button onClick={() => store.movePlacement(placement.id, 'up')}>Bring forward</button>
          <button onClick={() => store.movePlacement(placement.id, 'down')}>Send back</button>
          <button className="danger" onClick={() => store.deletePlacement(placement.id)}>
            Remove
          </button>
        </div>
      </Section>
      <Section title="Where it came from">
        {src ? (
          <dl className="prov">
            <dt>Source</dt>
            <dd>{src.kind === 'result' ? 'A result from this character' : src.kind === 'canvas' ? 'The 2D canvas' : 'Imported'}</dd>
            <dt>Pose</dt>
            <dd>{src.poseName ?? 'unsaved pose'}</dd>
            <dt>Placed</dt>
            <dd>{new Date(src.capturedAt).toLocaleString()}</dd>
          </dl>
        ) : (
          <p className="hint">No link recorded for this image.</p>
        )}
        {accepted.length > 0 && (
          <label className="field col-field">
            <span>Update image</span>
            <select
              data-testid="relink-select"
              value=""
              onChange={(e) => {
                if (e.target.value) store.relinkPlacement(placement.id, e.target.value);
              }}
            >
              <option value="">Choose a newer result…</option>
              {accepted.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.provenance.poseName ?? 'unsaved pose'} · {new Date(g.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
        )}
      </Section>
    </>
  );
}

function BubbleInspector({ id }: { id: string }) {
  const { page } = useApp();
  const b = page?.bubbles.find((x) => x.id === id);
  if (!b) return null;
  return (
    <>
      <Section title="Text">
        <textarea rows={4} value={b.text} data-testid="bubble-text" onChange={(e) => store.updateBubble(id, { text: e.target.value })} />
        <label className="field col-field">
          <span>Kind</span>
          <select value={b.kind} onChange={(e) => store.updateBubble(id, { kind: e.target.value as BubbleKind })}>
            <option value="speech">Speech</option>
            <option value="thought">Thought</option>
            <option value="caption">Caption</option>
            <option value="shout">Shout</option>
          </select>
        </label>
      </Section>
      <Section title="Shape">
        <div className="row">
          <NumberField label="W" value={b.width} digits={0} min={20} width={64} onCommit={(v) => store.updateBubble(id, { width: v })} />
          <NumberField label="H" value={b.height} digits={0} min={20} width={64} onCommit={(v) => store.updateBubble(id, { height: v })} />
        </div>
        <div className="row">
          <NumberField label="Font" value={b.fontSize} digits={0} min={4} width={56} onCommit={(v) => store.updateBubble(id, { fontSize: v })} />
          <NumberField label="Tail" value={b.tail ?? 0} digits={0} width={56} suffix="°" onCommit={(v) => store.updateBubble(id, { tail: v })} />
        </div>
        <div className="row wrap">
          <button onClick={() => store.updateBubble(id, { tail: null })}>No tail</button>
          <button className="danger" onClick={() => store.deleteBubble(id)}>
            Delete
          </button>
        </div>
      </Section>
    </>
  );
}

function PanelInspector({ id }: { id: string }) {
  const { page } = useApp();
  const p = page?.panels.find((x) => x.id === id);
  if (!p) return null;
  const b = polygonBounds(p.points);
  return (
    <Section title="Panel">
      <label className="field col-field">
        <span>Name</span>
        <input type="text" value={p.name} onChange={(e) => store.updatePanel(id, { name: e.target.value })} />
      </label>
      <dl className="prov">
        <dt>Shape</dt>
        <dd>{p.shape}</dd>
        <dt>Size</dt>
        <dd>
          {Math.round(b.x1 - b.x0)} × {Math.round(b.y1 - b.y0)} px
        </dd>
        <dt>Points</dt>
        <dd>{p.points.length}</dd>
      </dl>
      <div className="row wrap">
        <button onClick={() => store.updatePanel(id, { shape: 'skewed' })}>Make skewed</button>
        <button onClick={() => store.updatePanel(id, { shape: 'rect' })}>Make rect</button>
        <button className="danger" onClick={() => store.deletePanel(id)}>
          Delete panel
        </button>
      </div>
      <p className="hint">Drag the panel on the page to move it. Images inside it move with the frame.</p>
    </Section>
  );
}

// ---------------------------------------------------------------- overlay

function placementCorners(pl: Placement): Vec2[] {
  const w = (pl.width * pl.scale) / 2;
  const h = (pl.height * pl.scale) / 2;
  const r = (pl.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const pt = (dx: number, dy: number): Vec2 => ({ x: pl.x + dx * c - dy * s, y: pl.y + dx * s + dy * c });
  return [pt(-w, -h), pt(w, -h), pt(w, h), pt(-w, h)];
}

function drawOverlay(ctx: CanvasRenderingContext2D, page: PageState, sel: { kind: string; id: string } | null, zoom: number): void {
  ctx.save();
  ctx.lineWidth = 1.5 / zoom;
  ctx.strokeStyle = '#7cc8ee';
  ctx.setLineDash([6 / zoom, 4 / zoom]);

  if (sel?.kind === 'panel') {
    const panel = page.panels.find((p) => p.id === sel.id);
    if (panel) {
      const content = panelContentPolygon(panel, page);
      ctx.beginPath();
      content.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
    }
  }

  if (sel?.kind === 'placement') {
    const pl = page.placements.find((p) => p.id === sel.id);
    if (pl) {
      const corners = placementCorners(pl);
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      const b = polygonBounds(corners);
      ctx.fillStyle = '#7cc8ee';
      ctx.fillRect(b.x1 - HANDLE / zoom, b.y1 - HANDLE / zoom, (HANDLE * 2) / zoom, (HANDLE * 2) / zoom);
    }
  }

  if (sel?.kind === 'bubble') {
    const b = page.bubbles.find((x) => x.id === sel.id);
    if (b) {
      const outline = bubbleOutline(b);
      ctx.beginPath();
      outline.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#7cc8ee';
      ctx.fillRect(b.x + b.width / 2 - HANDLE / zoom, b.y + b.height / 2 - HANDLE / zoom, (HANDLE * 2) / zoom, (HANDLE * 2) / zoom);
    }
  }
  ctx.restore();
}
