import { isLoopbackUrl, normalizeBaseUrl } from './endpoint.ts';

export type SegmentMode = 'foreground' | 'parts';

export interface BackendStatus {
  available: boolean;
  model?: string;
  license?: string;
  detail?: string;
}

export interface ProviderStatus {
  ok: boolean;
  version?: string;
  backends: Partial<Record<SegmentMode, BackendStatus>>;
}

export interface MaskProposal {
  id: string;
  label: string;
  score: number | null;
  /** [x, y, width, height] in source-image pixels */
  bbox: [number, number, number, number] | null;
  /** PNG, same pixel size as the submitted image. Alpha channel = proposed visibility. */
  png: Uint8Array;
}

export interface SegmentProgress {
  stage: 'uploading' | 'running' | 'decoding';
  message: string;
}

export interface SegmentRequest {
  png: Uint8Array;
  width: number;
  height: number;
  mode: SegmentMode;
  maxMasks: number;
}

/** Error with a message that is safe to show directly to the artist. */
export class SegmentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentationError';
  }
}

/** Integration point: implement this to plug in any other model runner (WASM, remote, …). */
export interface SegmentationProvider {
  readonly id: string;
  readonly name: string;
  check(signal?: AbortSignal): Promise<ProviderStatus>;
  segment(req: SegmentRequest, onProgress: (p: SegmentProgress) => void, signal?: AbortSignal): Promise<MaskProposal[]>;
}

interface WireProposal {
  id: string;
  label: string;
  score?: number | null;
  bbox?: [number, number, number, number] | null;
  mask_png_base64: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Talks to the optional Python server in /server (runs on your own machine). */
export class LocalHttpProvider implements SegmentationProvider {
  readonly id = 'local-http';
  readonly name = 'Local segmentation server';
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = normalizeBaseUrl(baseUrl);
  }

  private unreachable(): SegmentationError {
    return new SegmentationError(
      `Cannot reach the segmentation server at ${this.base}. Start it (see "AI segmentation server" in the README) or change the address. Core editing still works without it.`,
    );
  }

  async check(signal?: AbortSignal): Promise<ProviderStatus> {
    this.guard();
    let res: Response;
    try {
      res = await fetch(`${this.base}/health`, { signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw this.unreachable();
    }
    if (!res.ok) throw new SegmentationError(`The server answered with an error (${res.status}).`);
    const j = (await res.json()) as { version?: string; backends?: ProviderStatus['backends'] };
    return { ok: true, version: j.version, backends: j.backends ?? {} };
  }

  private guard(): void {
    if (!isLoopbackUrl(this.base)) {
      throw new SegmentationError('For privacy, artwork is only sent to servers on this computer (localhost). Remote servers are blocked.');
    }
  }

  async segment(req: SegmentRequest, onProgress: (p: SegmentProgress) => void, signal?: AbortSignal): Promise<MaskProposal[]> {
    this.guard();
    const form = new FormData();
    form.append('file', new Blob([req.png as BlobPart], { type: 'image/png' }), 'layer.png');
    form.append('mode', req.mode);
    form.append('max_masks', String(req.maxMasks));
    onProgress({ stage: 'uploading', message: 'Sending the layer to the local server…' });
    let res: Response;
    try {
      onProgress({ stage: 'running', message: 'Running the model. This can take a minute or more on a CPU.' });
      res = await fetch(`${this.base}/segment`, { method: 'POST', body: form, signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      throw this.unreachable();
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j = (await res.json()) as { detail?: unknown };
        detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      } catch {
        /* ignore */
      }
      throw new SegmentationError(detail || `The server could not process this image (HTTP ${res.status}).`);
    }
    onProgress({ stage: 'decoding', message: 'Reading the proposed masks…' });
    const j = (await res.json()) as { width: number; height: number; proposals: WireProposal[] };
    if (j.width !== req.width || j.height !== req.height) {
      throw new SegmentationError(`The server returned masks for a ${j.width}×${j.height} image, but the layer is ${req.width}×${req.height}. Update the server.`);
    }
    return j.proposals.map((p) => ({ id: p.id, label: p.label, score: p.score ?? null, bbox: p.bbox ?? null, png: b64ToBytes(p.mask_png_base64) }));
  }
}
