import { useEffect, useRef, useState } from 'react';
import type { Layer } from '../core/types.ts';
import { LocalHttpProvider, SegmentationError } from '../ai/segmentation.ts';
import type { MaskProposal, ProviderStatus, SegmentMode } from '../ai/segmentation.ts';
import { isLoopbackUrl } from '../ai/endpoint.ts';
import { store } from '../app/store.ts';
import { ctx2d, decodeToCanvas, newCanvas } from '../render/pngEncode.ts';

const KEY = 'cf.aiUrl';
const readUrl = () => {
  try {
    return localStorage.getItem(KEY) ?? 'http://127.0.0.1:8765';
  } catch {
    return 'http://127.0.0.1:8765';
  }
};

function Thumb(props: { base: HTMLCanvasElement | null; png: Uint8Array }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    void (async () => {
      const el = ref.current;
      if (!el || !props.base) return;
      const mask = await decodeToCanvas(props.png, 'image/png');
      if (dead) return;
      const k = 96 / Math.max(props.base.width, props.base.height);
      el.width = Math.max(1, Math.round(props.base.width * k));
      el.height = Math.max(1, Math.round(props.base.height * k));
      const tmp = newCanvas(el.width, el.height);
      const c = ctx2d(tmp);
      c.drawImage(props.base, 0, 0, el.width, el.height);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(mask, 0, 0, el.width, el.height);
      const out = el.getContext('2d')!;
      out.clearRect(0, 0, el.width, el.height);
      out.drawImage(tmp, 0, 0);
    })();
    return () => {
      dead = true;
    };
  }, [props.base, props.png]);
  return <canvas ref={ref} className="thumb" />;
}

type Row = MaskProposal & { picked: boolean; name: string };

/** Optional AI-assisted separation. The layer's pixels go only to the local server you run yourself. */
export function SegmentationPanel({ layer }: { layer: Layer }) {
  const [url, setUrl] = useState(readUrl);
  const [mode, setMode] = useState<SegmentMode>('foreground');
  const [maxMasks, setMaxMasks] = useState(8);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [hideSource, setHideSource] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const busy = progress !== null;
  const base = layer.assetId ? store.bitmaps.getRaw(layer.assetId) : null;

  useEffect(() => {
    setRows([]);
    setError(null);
  }, [layer.id]);
  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    return () => clearInterval(t);
  }, [busy]);

  const explain = (e: unknown) => (e instanceof DOMException && e.name === 'AbortError' ? 'Cancelled.' : e instanceof SegmentationError ? e.message : e instanceof Error ? e.message : String(e));

  const check = async () => {
    setError(null);
    try {
      localStorage.setItem(KEY, url);
    } catch {
      /* ignore */
    }
    try {
      setStatus(await new LocalHttpProvider(url).check());
    } catch (e) {
      setStatus(null);
      setError(explain(e));
    }
  };

  const propose = async () => {
    const asset = layer.assetId ? store.getAsset(layer.assetId) : undefined;
    if (!asset) return setError('This layer has no pixel data.');
    setError(null);
    setRows([]);
    setElapsed(0);
    setProgress('Starting…');
    abort.current = new AbortController();
    try {
      const props = await new LocalHttpProvider(url).segment({ png: asset.bytes, width: layer.width, height: layer.height, mode, maxMasks }, (p) => setProgress(p.message), abort.current.signal);
      setRows(props.map((p) => ({ ...p, picked: true, name: p.label })));
      if (!props.length) setError('The model did not find any regions. Try the other mode or paint a mask by hand.');
    } catch (e) {
      setError(explain(e));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const accept = async () => {
    const chosen = rows.filter((r) => r.picked);
    if (!chosen.length) return;
    await store.acceptProposals(layer.id, chosen.map((r) => ({ label: r.name || r.label, png: r.png })), hideSource);
    setRows([]);
  };

  const remote = !isLoopbackUrl(url);
  return (
    <div className="ai">
      <p className="hint">
        Optional. Proposes masks with a model running on <b>your computer</b>; nothing else changes until you accept. Results are suggestions: refine them with the mask editor.
      </p>
      <label className="field">
        <span>Server</span>
        <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      </label>
      {remote && <p className="warn">Only localhost servers are allowed, so your artwork never leaves this computer.</p>}
      <div className="row">
        <button onClick={() => void check()} disabled={busy}>
          Check server
        </button>
        <select value={mode} onChange={(e) => setMode(e.target.value as SegmentMode)} disabled={busy} aria-label="Segmentation mode">
          <option value="foreground">Character vs background</option>
          <option value="parts">Split into parts</option>
        </select>
      </div>
      {status && (
        <ul className="status">
          {(['foreground', 'parts'] as const).map((m) => (
            <li key={m} className={status.backends[m]?.available ? 'ok' : 'bad'}>
              {m === 'foreground' ? 'Character vs background' : 'Split into parts'}: {status.backends[m]?.available ? `ready (${status.backends[m]?.model ?? 'model'})` : `unavailable${status.backends[m]?.detail ? ' — ' + status.backends[m]?.detail : ''}`}
            </li>
          ))}
        </ul>
      )}
      {mode === 'parts' && (
        <label className="num">
          <span>Max regions</span>
          <input type="number" min={1} max={30} value={maxMasks} onChange={(e) => setMaxMasks(Math.min(30, Math.max(1, Number(e.target.value) || 1)))} />
        </label>
      )}
      <div className="row">
        {busy ? (
          <button className="danger" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        ) : (
          <button className="primary" disabled={remote || layer.kind !== 'raster'} onClick={() => void propose()}>
            Propose masks
          </button>
        )}
      </div>
      {busy && (
        <p className="progress" role="status">
          {progress} <span className="muted">({elapsed}s)</span>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <>
          <ul className="proposals">
            {rows.map((r, i) => (
              <li key={r.id}>
                <Thumb base={base} png={r.png} />
                <div>
                  <input type="text" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} aria-label="Layer name" />
                  <label className="check">
                    <input type="checkbox" checked={r.picked} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, picked: e.target.checked } : x)))} />
                    Use{r.score !== null ? ` · confidence ${Math.round(r.score * 100)}%` : ''}
                  </label>
                </div>
              </li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={hideSource} onChange={(e) => setHideSource(e.target.checked)} />
            Hide the source layer afterwards
          </label>
          <div className="row">
            <button className="primary" onClick={() => void accept()} disabled={!rows.some((r) => r.picked)}>
              Create layers from selected
            </button>
            <button onClick={() => setRows([])}>Discard</button>
          </div>
        </>
      )}
    </div>
  );
}
