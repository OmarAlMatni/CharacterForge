import { useEffect, useRef, useState } from 'react';
import { invertAlpha } from '../core/maskMath.ts';
import type { ID } from '../core/types.ts';
import { store } from '../app/store.ts';
import { ctx2d, newCanvas } from '../render/pngEncode.ts';
import { Modal } from './controls.tsx';

/** Paint-to-hide / paint-to-reveal editor. The layer's pixels are never touched; only a separate mask changes. */
export function MaskEditor({ layerId }: { layerId: ID }) {
  const view = useRef<HTMLCanvasElement>(null);
  const work = useRef<{ base: HTMLCanvasElement; mask: HTMLCanvasElement; initial: ImageData } | null>(null);
  const undo = useRef<ImageData[]>([]);
  const last = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);
  const [ready, setReady] = useState(false);
  const [tool, setTool] = useState<'hide' | 'reveal'>('hide');
  const [size, setSize] = useState(40);
  const [soft, setSoft] = useState(0.3);
  const [err, setErr] = useState<string | null>(null);
  const [steps, setSteps] = useState(0);
  const layerName = store.doc?.layers.find((l) => l.id === layerId)?.name ?? 'layer';

  const render = () => {
    const w = work.current;
    const v = view.current;
    if (!w || !v) return;
    const c = v.getContext('2d')!;
    c.clearRect(0, 0, v.width, v.height);
    c.drawImage(w.base, 0, 0);
    const tint = newCanvas(v.width, v.height);
    const t = ctx2d(tint);
    t.fillStyle = 'rgba(255,107,87,0.55)';
    t.fillRect(0, 0, v.width, v.height);
    t.globalCompositeOperation = 'destination-out';
    t.drawImage(w.mask, 0, 0);
    c.drawImage(tint, 0, 0);
  };
  const schedule = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(render);
  };

  useEffect(() => {
    let dead = false;
    void store.maskEditorInputs(layerId).then((r) => {
      if (dead) return;
      if (!r) return setErr('This layer cannot be masked (no pixels loaded).');
      const c = ctx2d(r.mask);
      work.current = { base: r.base, mask: r.mask, initial: c.getImageData(0, 0, r.mask.width, r.mask.height) };
      const v = view.current!;
      v.width = r.base.width;
      v.height = r.base.height;
      setReady(true);
      render();
    });
    return () => {
      dead = true;
      cancelAnimationFrame(raf.current);
    };
  }, [layerId]);

  const pushUndo = () => {
    const w = work.current!;
    undo.current.push(ctx2d(w.mask).getImageData(0, 0, w.mask.width, w.mask.height));
    if (undo.current.length > 8) undo.current.shift();
    setSteps(undo.current.length);
  };
  const stamp = (x: number, y: number) => {
    const c = ctx2d(work.current!.mask);
    c.globalCompositeOperation = tool === 'hide' ? 'destination-out' : 'source-over';
    const r = size / 2;
    const g = c.createRadialGradient(x, y, r * (1 - soft), x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = soft > 0 ? g : '#fff';
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
  };
  const pos = (e: React.PointerEvent) => {
    const v = view.current!;
    const r = v.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * v.width) / r.width, y: ((e.clientY - r.top) * v.height) / r.height };
  };
  const stroke = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(d / Math.max(1, size / 4)));
    for (let i = 1; i <= n; i++) stamp(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
  };
  const putAll = (value: 'show' | 'hide' | 'invert' | 'reset') => {
    const w = work.current!;
    pushUndo();
    const c = ctx2d(w.mask);
    if (value === 'reset') c.putImageData(w.initial, 0, 0);
    else if (value === 'invert') {
      const id = c.getImageData(0, 0, w.mask.width, w.mask.height);
      invertAlpha(id.data);
      c.putImageData(id, 0, 0);
    } else {
      c.clearRect(0, 0, w.mask.width, w.mask.height);
      if (value === 'show') {
        c.fillStyle = '#fff';
        c.fillRect(0, 0, w.mask.width, w.mask.height);
      }
    }
    render();
  };
  const undoStroke = () => {
    const prev = undo.current.pop();
    if (!prev) return;
    ctx2d(work.current!.mask).putImageData(prev, 0, 0);
    setSteps(undo.current.length);
    render();
  };

  const close = () => store.setDialog(null);
  const save = async () => {
    if (!work.current) return;
    await store.commitMask(layerId, work.current.mask);
    close();
  };
  const maxW = Math.min(720, window.innerWidth - 420);

  return (
    <Modal
      wide
      title={`Mask — ${layerName}`}
      onClose={close}
      footer={
        <>
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={() => void save()}>
            Apply mask
          </button>
        </>
      }
    >
      {err ? (
        <p className="error">{err}</p>
      ) : (
        <div className="mask-ed">
          <div className="mask-tools">
            <div className="seg">
              <button className={tool === 'hide' ? 'on' : ''} onClick={() => setTool('hide')}>
                Hide
              </button>
              <button className={tool === 'reveal' ? 'on' : ''} onClick={() => setTool('reveal')}>
                Reveal
              </button>
            </div>
            <label className="field">
              <span>Size</span>
              <input type="range" min={2} max={300} value={size} onChange={(e) => setSize(Number(e.target.value))} />
              <em>{size}px</em>
            </label>
            <label className="field">
              <span>Softness</span>
              <input type="range" min={0} max={0.9} step={0.05} value={soft} onChange={(e) => setSoft(Number(e.target.value))} />
            </label>
            <div className="row wrap">
              <button onClick={() => putAll('show')}>Show all</button>
              <button onClick={() => putAll('hide')}>Hide all</button>
              <button onClick={() => putAll('invert')}>Invert</button>
              <button onClick={() => putAll('reset')}>Reset</button>
              <button disabled={steps === 0} onClick={undoStroke}>
                Undo stroke
              </button>
            </div>
            <p className="hint">Red tint = hidden. Painting only changes the mask; the original pixels stay intact and the mask can be removed at any time.</p>
          </div>
          <div className="mask-view checker" style={{ maxWidth: maxW }}>
            <canvas
              ref={view}
              style={{ cursor: 'crosshair', touchAction: 'none', width: '100%', display: 'block' }}
              onPointerDown={(e) => {
                if (!ready || e.button !== 0) return;
                (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
                pushUndo();
                const p = pos(e);
                last.current = p;
                stamp(p.x, p.y);
                schedule();
              }}
              onPointerMove={(e) => {
                if (!last.current) return;
                const p = pos(e);
                stroke(last.current, p);
                last.current = p;
                schedule();
              }}
              onPointerUp={() => (last.current = null)}
              onPointerCancel={() => (last.current = null)}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
