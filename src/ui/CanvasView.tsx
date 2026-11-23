import { useEffect, useRef } from 'react';
import { ikChainFor, solveFKDrag, solveTwoBoneIK } from '../core/ik.ts';
import { moveJointRest } from '../core/doc.ts';
import { hitTestLayers, layerCorners, pointToLayerLocal } from '../core/hit.ts';
import { canvasToScreen, dist, normalizeDeg, screenToCanvas, toDeg, zoomAt } from '../core/math.ts';
import type { Transform, Vec2 } from '../core/math.ts';
import { computePlacements, jointFrames, sanitizePose, REST } from '../core/rig.ts';
import type { DocState, ID } from '../core/types.ts';
import { store } from '../app/store.ts';
import { useApp } from '../app/useApp.ts';
import type { OverlayJoint, OverlaySelection } from '../render/stage.ts';
import { Stage } from '../render/stage.ts';

type Drag =
  | { kind: 'pan'; sx: number; sy: number; panX: number; panY: number }
  | { kind: 'move'; start: Vec2; orig: Map<ID, Transform> }
  | { kind: 'rotate'; id: ID; center: Vec2; startAngle: number; orig: number }
  | { kind: 'scale'; id: ID; center: Vec2; startDist: number; orig: Transform }
  | { kind: 'joint-rest'; id: ID; start: Vec2; origPos: Vec2 }
  | { kind: 'joint-pose'; id: ID; grab: Vec2 };

const HIT_PX = 10;

function displayPose(doc: DocState, mode: string) {
  return mode === 'pose' ? doc.pose : REST;
}

/** Handle position: above the top edge, 28 screen-px away, along the layer's "up" direction. */
function rotateHandle(corners: Vec2[], zoom: number): Vec2 {
  const [tl, tr, br, bl] = corners as [Vec2, Vec2, Vec2, Vec2];
  const tc = { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 };
  const bc = { x: (bl.x + br.x) / 2, y: (bl.y + br.y) / 2 };
  const ux = tc.x - bc.x;
  const uy = tc.y - bc.y;
  const l = Math.hypot(ux, uy) || 1;
  return { x: tc.x + (ux / l) * (28 / zoom), y: tc.y + (uy / l) * (28 / zoom) };
}

export function CanvasView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Stage | null>(null);
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const snap = useApp();

  const redraw = () => {
    const st = stageRef.current;
    if (!st) return;
    const s = store.getSnapshot();
    st.setActive(!!s.doc);
    st.setView(s.ui.view);
    const doc = s.doc;
    if (!doc) return;
    const pose = displayPose(doc, s.ui.mode);
    const placements = computePlacements(doc.layers, doc.joints, pose);
    st.sync(doc, placements, store.bitmaps);

    let selection: OverlaySelection | null = null;
    const extraBoxes: Vec2[][] = [];
    if (s.ui.mode === 'layout') {
      const rasters = store.expandToRaster(s.ui.selectedLayerIds);
      rasters.forEach((id, i) => {
        const l = doc.layers.find((x) => x.id === id);
        const pl = placements.get(id);
        if (!l || !pl) return;
        const corners = layerCorners(l, pl);
        if (i === rasters.length - 1) selection = { corners, rotateHandle: rotateHandle(corners, s.ui.view.zoom), pivot: { x: pl.x, y: pl.y } };
        else extraBoxes.push(corners);
      });
    }
    const joints: OverlayJoint[] = [];
    if (s.ui.mode !== 'layout') {
      const frames = jointFrames(doc.joints, pose);
      const sel = s.ui.selectedJointId;
      const chain = s.ui.mode === 'pose' && s.ui.ik && sel ? ikChainFor(doc.joints, sel) : null;
      for (const j of doc.joints) {
        joints.push({
          id: j.id,
          pos: frames.get(j.id)!.pos,
          parentPos: j.parentId ? (frames.get(j.parentId)?.pos ?? null) : null,
          selected: j.id === sel,
          chain: !!chain && (j.id === chain.midId || j.id === chain.endId),
        });
      }
    }
    st.drawOverlay({ zoom: s.ui.view.zoom, canvas: doc.canvas, selection, extraBoxes, joints });
  };

  // create / destroy the PixiJS stage
  useEffect(() => {
    let dead = false;
    let st: Stage | null = null;
    void Stage.create(hostRef.current!).then((created) => {
      if (dead) return created.destroy();
      st = created;
      stageRef.current = created;
      redraw();
    });
    const ro = new ResizeObserver(() => {
      const r = hostRef.current?.getBoundingClientRect();
      if (r) store.setViewport(Math.round(r.width), Math.round(r.height));
    });
    ro.observe(hostRef.current!);
    return () => {
      dead = true;
      ro.disconnect();
      stageRef.current = null;
      st?.destroy();
    };
  }, []);

  useEffect(redraw);

  // pointer / wheel interaction
  useEffect(() => {
    const host = hostRef.current!;
    const local = (e: PointerEvent | WheelEvent): Vec2 => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLSelectElement)) {
        space.current = true;
        host.style.cursor = 'grab';
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        space.current = false;
        host.style.cursor = '';
      }
    };

    const jointAt = (pts: Map<ID, { pos: Vec2 }>, screen: Vec2): ID | null => {
      const v = store.getSnapshot().ui.view;
      let best: ID | null = null;
      let bd = HIT_PX;
      for (const [id, f] of pts) {
        const d = dist(canvasToScreen(v, f.pos), screen);
        if (d <= bd) (best = id), (bd = d);
      }
      return best;
    };

    const down = (e: PointerEvent) => {
      const s = store.getSnapshot();
      const doc = s.doc;
      if (!doc) return;
      const screen = local(e);
      const v = s.ui.view;
      const pt = screenToCanvas(v, screen);
      host.setPointerCapture(e.pointerId);
      if (e.button === 1 || space.current || e.button === 2) {
        drag.current = { kind: 'pan', sx: screen.x, sy: screen.y, panX: v.panX, panY: v.panY };
        host.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      const mode = s.ui.mode;
      const pose = displayPose(doc, mode);

      if (mode === 'layout') {
        const placements = computePlacements(doc.layers, doc.joints, pose);
        const rasters = store.expandToRaster(s.ui.selectedLayerIds);
        const primaryId = rasters[rasters.length - 1];
        const primary = doc.layers.find((l) => l.id === primaryId);
        const pl = primary ? placements.get(primary.id) : undefined;
        if (s.ui.layoutTool === 'pivot') {
          if (primary && pl && !primary.locked) {
            const lp = pointToLayerLocal(primary, pl, pt);
            if (lp) store.setLayerPivot(primary.id, lp);
          } else store.toast('info', 'Select an unlocked pixel layer, then click where its pivot should be.');
          return;
        }
        if (primary && pl && !primary.locked) {
          const corners = layerCorners(primary, pl);
          const rh = rotateHandle(corners, v.zoom);
          const center = { x: pl.x, y: pl.y };
          store.beginGesture();
          if (dist(canvasToScreen(v, rh), screen) <= HIT_PX) {
            drag.current = { kind: 'rotate', id: primary.id, center, startAngle: toDeg(Math.atan2(pt.y - center.y, pt.x - center.x)), orig: pl.rotation };
            return;
          }
          if (corners.some((c) => dist(canvasToScreen(v, c), screen) <= HIT_PX)) {
            drag.current = { kind: 'scale', id: primary.id, center, startDist: Math.max(1e-6, dist(pt, center)), orig: { ...primary.transform } };
            return;
          }
          store.cancelGesture();
        }
        const hit = hitTestLayers(doc, placements, pt, (l, x, y) => store.bitmaps.alphaAt(l, x, y));
        if (!hit) {
          if (!e.shiftKey) store.selectLayers([]);
          return;
        }
        // select the layer; clicking inside an already-selected set keeps the set
        const already = store.expandToRaster(s.ui.selectedLayerIds).includes(hit);
        let ids = s.ui.selectedLayerIds;
        if (e.shiftKey) ids = ids.includes(hit) ? ids.filter((x) => x !== hit) : [...ids, hit];
        else if (!already) ids = [hit];
        store.selectLayers(ids);
        const movable = store.expandToRaster(ids).filter((id) => !doc.layers.find((l) => l.id === id)!.locked);
        if (!movable.length) return;
        store.beginGesture();
        drag.current = { kind: 'move', start: pt, orig: new Map(movable.map((id) => [id, { ...doc.layers.find((l) => l.id === id)!.transform }])) };
        return;
      }

      const frames = jointFrames(doc.joints, pose);
      const hitJoint = jointAt(frames, screen);
      if (mode === 'rig') {
        if (hitJoint) {
          store.selectJoint(hitJoint);
          store.beginGesture();
          drag.current = { kind: 'joint-rest', id: hitJoint, start: pt, origPos: frames.get(hitJoint)!.pos };
        } else if (s.ui.rigTool === 'add') {
          store.addJoint(e.altKey ? null : s.ui.selectedJointId, pt);
        } else store.selectJoint(null);
        return;
      }
      // pose mode
      if (hitJoint) {
        store.selectJoint(hitJoint);
        store.beginGesture();
        const p = frames.get(hitJoint)!.pos;
        drag.current = { kind: 'joint-pose', id: hitJoint, grab: { x: p.x - pt.x, y: p.y - pt.y } };
      } else store.selectJoint(null);
    };

    const move = (e: PointerEvent) => {
      const d = drag.current;
      const s = store.getSnapshot();
      const doc = s.doc;
      if (!d || !doc) return;
      const screen = local(e);
      const pt = screenToCanvas(s.ui.view, screen);
      switch (d.kind) {
        case 'pan':
          store.setView({ ...s.ui.view, panX: d.panX + screen.x - d.sx, panY: d.panY + screen.y - d.sy });
          break;
        case 'move': {
          const dx = pt.x - d.start.x;
          const dy = pt.y - d.start.y;
          store.previewDoc({ ...doc, layers: doc.layers.map((l) => (d.orig.has(l.id) ? { ...l, transform: { ...d.orig.get(l.id)!, x: d.orig.get(l.id)!.x + dx, y: d.orig.get(l.id)!.y + dy } } : l)) });
          break;
        }
        case 'rotate': {
          let rot = d.orig + (toDeg(Math.atan2(pt.y - d.center.y, pt.x - d.center.x)) - d.startAngle);
          if (e.shiftKey) rot = Math.round(rot / 15) * 15;
          store.previewDoc({ ...doc, layers: doc.layers.map((l) => (l.id === d.id ? { ...l, transform: { ...l.transform, rotation: normalizeDeg(rot) } } : l)) });
          break;
        }
        case 'scale': {
          const k = Math.min(100, Math.max(0.01, dist(pt, d.center) / d.startDist));
          store.previewDoc({ ...doc, layers: doc.layers.map((l) => (l.id === d.id ? { ...l, transform: { ...l.transform, scaleX: d.orig.scaleX * k, scaleY: d.orig.scaleY * k } } : l)) });
          break;
        }
        case 'joint-rest':
          store.previewDoc(moveJointRest(doc, d.id, { x: d.origPos.x + pt.x - d.start.x, y: d.origPos.y + pt.y - d.start.y }, e.shiftKey));
          break;
        case 'joint-pose': {
          const target = { x: pt.x + d.grab.x, y: pt.y + d.grab.y };
          const useIk = s.ui.ik !== e.altKey;
          const chain = useIk ? ikChainFor(doc.joints, d.id) : null;
          const pose = chain ? solveTwoBoneIK(doc.joints, doc.pose, chain, target).pose : solveFKDrag(doc.joints, doc.pose, d.id, target);
          store.previewDoc({ ...doc, pose: sanitizePose(doc.joints, pose) });
          break;
        }
      }
    };

    const up = (e: PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
      host.style.cursor = space.current ? 'grab' : '';
      if (!d || d.kind === 'pan') return;
      const labels = { move: 'Move layer', rotate: 'Rotate layer', scale: 'Scale layer', 'joint-rest': 'Move joint', 'joint-pose': 'Pose character' } as const;
      store.endGesture(labels[d.kind]);
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = store.getSnapshot();
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      store.setView(zoomAt(s.ui.view, local(e), factor));
    };

    host.addEventListener('pointerdown', down);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    host.addEventListener('wheel', wheel, { passive: false });
    host.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      host.removeEventListener('pointerdown', down);
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      host.removeEventListener('wheel', wheel);
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, []);

  const empty = !snap.doc ? 'no-project' : snap.doc.layers.length === 0 ? 'no-art' : null;
  const cursor = snap.ui.mode === 'rig' && snap.ui.rigTool === 'add' ? 'crosshair' : snap.ui.mode === 'layout' && snap.ui.layoutTool === 'pivot' ? 'crosshair' : undefined;
  return (
    <div className="canvas-wrap">
      <div ref={hostRef} className="canvas-host" style={{ cursor }} />
      {empty && (
        <div className="empty tone">
          <div className="empty-card">
            {empty === 'no-project' ? (
              <>
                <h2>Start a character project</h2>
                <p>Import your own artwork, split it into layers, add a skeleton, and pose it. Your files stay in this browser.</p>
                <div className="row">
                  <button className="primary" onClick={() => store.setDialog({ kind: 'projects' })}>
                    New or open project
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>Import artwork</h2>
                <p>Drop a PNG or layered PSD here, or choose a file. The original is kept untouched inside the project.</p>
                <div className="row">
                  <label className="button primary">
                    Choose files
                    <input type="file" accept=".png,.psd,image/png" multiple hidden onChange={(e) => void store.importFiles([...(e.target.files ?? [])]).then(() => (e.target.value = ''))} />
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {snap.doc && snap.ui.mode === 'pose' && snap.doc.joints.length === 0 && (
        <div className="banner">No skeleton yet. Switch to Rig (2) and add joints or the humanoid template.</div>
      )}
    </div>
  );
}

