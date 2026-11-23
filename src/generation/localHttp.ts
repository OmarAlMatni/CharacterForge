import type { GuideKind } from '../core/character.ts';
import { isLoopbackUrl, normalizeBaseUrl } from '../ai/endpoint.ts';
import type { GenerateOptions, GenerationOutput, GenerationProvider, GenerationRequest, ProviderCapabilities, ProviderStatus } from './types.ts';
import { GenerationError } from './types.ts';
import { assertGenuineResult } from './guard.ts';

export const LOCAL_PROVIDER_ID = 'local-http';
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8765';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MB = 1024 * 1024;
/** What the server accepts unless its /generate/status says otherwise (these are the server's own defaults, see server/limits.py). */
export const DEFAULT_LIMITS = { maxRequestBytes: 256 * MB, maxFileBytes: 64 * MB, maxResultBytes: 64 * MB };
export type ServerLimits = typeof DEFAULT_LIMITS;
const STATUS_TIMEOUT_MS = 8000;
const DEFAULT_GENERATION_TIMEOUT_MS = 20 * 60 * 1000;

/** Total bytes the multipart request will carry (images plus a generous allowance for the JSON and part headers). */
export function requestBytes(req: GenerationRequest): number {
  let n = JSON.stringify(wireRequestJson(req)).length + 2048;
  n += req.original.bytes.byteLength;
  for (const r of req.references) n += r.bytes.byteLength + 512;
  for (const g of Object.values(req.guides)) if (g) n += g.bytes.byteLength + 512;
  return n;
}

/** Refuse a request the server would refuse, BEFORE uploading it. Throws a GenerationError that says what to shrink. */
export function checkRequestSize(req: GenerationRequest, limits: ServerLimits = DEFAULT_LIMITS): void {
  const mb = (b: number): string => `${(b / MB).toFixed(1)} MB`;
  const parts: { name: string; bytes: number }[] = [
    { name: 'the original artwork', bytes: req.original.bytes.byteLength },
    ...req.references.map((r) => ({ name: `reference "${r.label}"`, bytes: r.bytes.byteLength })),
    ...Object.entries(req.guides).flatMap(([k, g]) => (g ? [{ name: `the ${k} guide`, bytes: g.bytes.byteLength }] : [])),
  ];
  for (const p of parts) {
    if (p.bytes > limits.maxFileBytes) throw new GenerationError('too-large', `${p.name[0]!.toUpperCase()}${p.name.slice(1)} is ${mb(p.bytes)}; the server accepts at most ${mb(limits.maxFileBytes)} per image. Use a smaller version.`);
  }
  const total = requestBytes(req);
  if (total > limits.maxRequestBytes) {
    const biggest = [...parts].sort((a, b) => b.bytes - a.bytes)[0]!;
    throw new GenerationError('too-large', `The request is ${mb(total)} in total; the server accepts at most ${mb(limits.maxRequestBytes)}. Un-approve some references (the largest is ${biggest.name}, ${mb(biggest.bytes)}) or use smaller images.`);
  }
}

/** Read a response body but stop (and cancel the download) once it is larger than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    throw new GenerationError('too-large', `The server's result is ${(declared / MB).toFixed(0)} MB, more than the ${(max / MB).toFixed(0)} MB this app will accept.`);
  }
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength > max) throw new GenerationError('too-large', 'The server returned an oversized result.');
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      throw new GenerationError('too-large', `The server's result is larger than the ${(max / MB).toFixed(0)} MB this app will accept.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) (out.set(c, o), (o += c.byteLength));
  return out;
}

/** An AbortSignal that fires when `signal` does or after `ms`, and says which one it was. */
function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; done: () => void } {
  const ctl = new AbortController();
  let timed = false;
  const timer = setTimeout(() => ((timed = true), ctl.abort()), ms);
  const onAbort = (): void => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  return { signal: ctl.signal, timedOut: () => timed, done: () => (clearTimeout(timer), signal?.removeEventListener('abort', onAbort)) };
}

/** What the wire protocol needs to know about a request, minus the binary parts (which travel as multipart files). */
export function wireRequestJson(req: GenerationRequest): Record<string, unknown> {
  return {
    protocol: 1,
    output: req.output,
    instructions: req.instructions,
    appearance: req.appearance,
    seed: req.seed,
    pose: req.pose,
    original: { width: req.original.width, height: req.original.height },
    references: req.references.map((r, i) => ({ index: i, id: r.id, role: r.role, label: r.label, notes: r.notes, width: r.width, height: r.height })),
    guides: Object.fromEntries(Object.entries(req.guides).map(([k, v]) => [k, { width: v!.width, height: v!.height }])),
  };
}

const blob = (b: Uint8Array, mime: string): Blob => new Blob([b as BlobPart], { type: mime });

export function buildForm(req: GenerationRequest): FormData {
  const f = new FormData();
  f.set('request', JSON.stringify(wireRequestJson(req)));
  f.set('original', blob(req.original.bytes, req.original.mime), 'original');
  req.references.forEach((r, i) => f.set(`reference_${i}`, blob(r.bytes, r.mime), `reference_${i}`));
  for (const [k, v] of Object.entries(req.guides)) if (v) f.set(`guide_${k}`, blob(v.bytes, v.mime), `guide_${k}.png`);
  return f;
}

/**
 * Client for a generation backend running on THIS computer (see server/ and docs/GENERATION_PROTOCOL.md).
 * It refuses any non-loopback address: artwork is never sent to a remote service from this adapter.
 */
export class LocalHttpProvider implements GenerationProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly name = 'Local generation server';
  readonly description = 'A generation backend running on this computer, reached over localhost HTTP. Artwork never leaves your machine.';
  readonly sendsArtworkOffDevice = false;
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  /** Learned from /generate/status; the server's defaults until then. */
  private limits: ServerLimits = DEFAULT_LIMITS;

  constructor(baseUrl: string = DEFAULT_LOCAL_URL, fetchImpl: FetchLike = (u, i) => fetch(u, i), timeoutMs: number = DEFAULT_GENERATION_TIMEOUT_MS) {
    this.base = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private guardUrl(): void {
    if (!isLoopbackUrl(this.base)) throw new GenerationError('rejected', 'Only a server on this computer (localhost) can be used. Artwork is not sent to other machines without your explicit approval, and this adapter has no remote mode.');
  }

  async status(signal?: AbortSignal): Promise<ProviderStatus> {
    const down = (message: string, state: ProviderStatus['state'] = 'unavailable'): ProviderStatus => ({ state, message, model: null, capabilities: null });
    try {
      this.guardUrl();
    } catch (e) {
      return down((e as Error).message, 'error');
    }
    let res: Response;
    const t = withTimeout(signal, STATUS_TIMEOUT_MS);
    try {
      res = await this.fetchImpl(`${this.base}/generate/status`, { signal: t.signal });
    } catch {
      if (signal?.aborted) return down('Cancelled.');
      return down(t.timedOut() ? `The server at ${this.base} did not answer within ${STATUS_TIMEOUT_MS / 1000} s. It may be busy or stuck.` : `Cannot reach a server at ${this.base}. Start it (see README → Running the server) or change the address.`);
    } finally {
      t.done();
    }
    if (res.status === 404) return down(`The server at ${this.base} is running but is an older version without generation support (no /generate/status).`);
    if (!res.ok) return down(`The server answered with HTTP ${res.status}.`, 'error');
    let j: Record<string, unknown>;
    try {
      j = (await res.json()) as Record<string, unknown>;
    } catch {
      return down('The server returned an unreadable status.', 'error');
    }
    const lim = j.limits as Record<string, unknown> | undefined;
    const pos = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
    this.limits = { maxRequestBytes: pos(lim?.max_request_bytes, DEFAULT_LIMITS.maxRequestBytes), maxFileBytes: pos(lim?.max_file_bytes, DEFAULT_LIMITS.maxFileBytes), maxResultBytes: pos(lim?.max_result_bytes, DEFAULT_LIMITS.maxResultBytes) };
    const caps = j.capabilities as { references?: boolean; max_references?: number; guides?: unknown } | undefined;
    if (j.busy === true && j.available === true) {
      return { state: 'ready', message: 'Ready, but the server is still busy with another job. A new generation will be refused until it finishes.', model: typeof j.model === 'string' ? j.model : null, capabilities: this.capsFrom(caps) };
    }
    if (j.available !== true) return down(typeof j.detail === 'string' ? j.detail : 'The server reports that no generation backend is available.');
    return {
      state: 'ready',
      message: typeof j.detail === 'string' ? j.detail : 'Ready.',
      model: typeof j.model === 'string' ? j.model : null,
      capabilities: this.capsFrom(caps),
    };
  }

  private capsFrom(caps: { references?: boolean; max_references?: number; guides?: unknown } | undefined): ProviderCapabilities {
    const max = caps?.max_references;
    const guides = Array.isArray(caps?.guides) ? (caps!.guides as unknown[]) : ['pose'];
    return {
      acceptsReferences: caps?.references !== false,
      maxReferences: typeof max === 'number' && Number.isInteger(max) && max >= 0 && max <= 64 ? max : 8,
      guides: guides.filter((g): g is GuideKind => typeof g === 'string' && ['mannequin', 'textured', 'pose', 'depth', 'silhouette'].includes(g)),
    };
  }

  async generate(req: GenerationRequest, opts: GenerateOptions = {}): Promise<GenerationOutput> {
    this.guardUrl();
    if (!req.original.bytes.byteLength) throw new GenerationError('invalid-request', 'There is no original artwork to generate from.');
    checkRequestSize(req, this.limits);
    opts.onProgress?.({ stage: 'Sending to the local server', fraction: null });
    const t = withTimeout(opts.signal, this.timeoutMs);
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/generate`, { method: 'POST', body: buildForm(req), signal: t.signal });
      } catch (e) {
        if (opts.signal?.aborted) throw new GenerationError('cancelled', 'Generation was cancelled.');
        if (t.timedOut()) throw new GenerationError('timeout', `The server did not answer within ${Math.round(this.timeoutMs / 60000)} minutes. It may still be running the job; check its console before starting another.`);
        if (e instanceof DOMException && e.name === 'AbortError') throw new GenerationError('cancelled', 'Generation was cancelled.');
        throw new GenerationError('network', await this.explainLostConnection());
      }
      if (!res.ok) throw await this.errorFor(res);
      opts.onProgress?.({ stage: 'Receiving the result', fraction: null });
      const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type && !type.startsWith('image/')) {
        void res.body?.cancel().catch(() => undefined);
        throw new GenerationError('protocol', `The server answered with "${type}" instead of an image. Is something else running on ${this.base}?`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readCapped(res, this.limits.maxResultBytes);
      } catch (e) {
        if (e instanceof GenerationError) throw e;
        if (opts.signal?.aborted) throw new GenerationError('cancelled', 'Generation was cancelled.');
        throw new GenerationError('network', 'The connection to the server was lost while the result was being sent. The result is incomplete and was discarded.');
      }
      const seedHeader = res.headers.get('x-cf-seed');
      const out: GenerationOutput = {
        bytes,
        mime: type || 'image/png',
        model: res.headers.get('x-cf-model'),
        seed: seedHeader !== null && seedHeader.trim() !== '' && Number.isFinite(Number(seedHeader)) ? Number(seedHeader) : null,
        info: res.headers.get('x-cf-info'),
      };
      assertGenuineResult(out, req);
      return out;
    } finally {
      t.done();
    }
  }

  /** Turn an error response into a specific message. Never assumes the body is JSON (a proxy or another program may answer). */
  private async errorFor(res: Response): Promise<GenerationError> {
    let detail = '';
    try {
      const text = (await res.text()).slice(0, 4000);
      try {
        const j = JSON.parse(text) as { detail?: unknown };
        if (typeof j.detail === 'string') detail = j.detail;
        else if (Array.isArray(j.detail)) detail = j.detail.map((d) => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : '')).filter(Boolean).join('; ');
      } catch {
        /* not JSON: ignore the body, it could be an HTML error page */
      }
    } catch {
      /* the body could not be read */
    }
    const s = res.status;
    if (s === 429) return new GenerationError('busy', detail || 'The server is busy with another job. Wait for it to finish and try again.');
    if (s === 413) return new GenerationError('too-large', detail || 'The server refused the request as too large. Use smaller images or fewer references.');
    if (s === 503 || s === 501) return new GenerationError('unavailable', detail || `The server cannot generate right now (HTTP ${s}).`);
    if (s === 504) return new GenerationError('timeout', detail || 'The generation backend timed out.');
    if (s === 502) return new GenerationError('invalid-output', detail || 'The generation backend returned an unusable result.');
    if (s === 421 || s === 403) return new GenerationError('rejected', detail || 'The server refused this app (check its allowed origins, see docs/SECURITY.md).');
    if (s >= 400 && s < 500) return new GenerationError('rejected', detail || `The server rejected the request (HTTP ${s}).`);
    return new GenerationError('protocol', detail || `The generation server failed (HTTP ${s}). Its console shows why; no result was saved.`);
  }

  /** After a fetch failure: is the server gone (crashed, killed, out of memory) or still up (the request itself was interrupted)? */
  private async explainLostConnection(): Promise<string> {
    const t = withTimeout(undefined, 2500);
    try {
      const r = await this.fetchImpl(`${this.base}/health`, { signal: t.signal });
      if (r.ok) return `The connection was interrupted, but the server at ${this.base} is still running. No result was saved; try again.`;
    } catch {
      /* fall through */
    } finally {
      t.done();
    }
    return `Lost the connection to the local server at ${this.base}. It may have crashed or run out of memory while generating (check its console and restart it). No result was saved.`;
  }
}
