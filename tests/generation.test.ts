import { describe, expect, it } from 'vitest';
import { addReference, emptyCharacter, setOriginal, updateAppearance, updateReference } from '../src/core/character.ts';
import type { ReferenceImage } from '../src/core/character.ts';
import { assertGenuineResult } from '../src/generation/guard.ts';
import { DEFAULT_LOCAL_URL, LocalHttpProvider, buildForm, checkRequestSize, requestBytes, wireRequestJson } from '../src/generation/localHttp.ts';
import { buildProvenance, makeRecord } from '../src/generation/provenance.ts';
import { createProvider } from '../src/generation/registry.ts';
import { buildGenerationRequest } from '../src/generation/request.ts';
import { GenerationError } from '../src/generation/types.ts';
import type { GenerationRequest } from '../src/generation/types.ts';
import type { AssetData } from '../src/storage/projectService.ts';

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const img = (seed: number, n = 120): Uint8Array => {
  const b = new Uint8Array(n).fill(seed);
  b.set(PNG_SIG);
  return b;
};
const asset = (id: string, seed: number, w = 100, h = 200): AssetData => ({ id, kind: 'source', mime: 'image/png', width: w, height: h, bytes: img(seed) });
const assets = new Map<string, AssetData>([['orig', asset('orig', 1)], ['r1', asset('r1', 2)], ['r2', asset('r2', 3)]]);
const ref = (id: string, assetId: string, over: Partial<ReferenceImage> = {}): ReferenceImage => ({ id, assetId, label: id, role: 'face', notes: 'n', fileName: id, approved: true, addedAt: 1, ...over });

function character() {
  let c = setOriginal(emptyCharacter(), 'orig', 1);
  c = addReference(c, ref('a', 'r1'));
  c = addReference(c, ref('b', 'r2', { approved: false }));
  c = updateAppearance(c, { hair: 'silver' });
  return { ...c, instructions: 'smiling' };
}
function request(): GenerationRequest {
  return buildGenerationRequest(character(), (id) => assets.get(id), { pose: { bytes: img(9), mime: 'image/png', width: 768, height: 1152 } }, 42);
}

describe('request builder', () => {
  it('includes the original, only approved references, guides, pose data and settings', () => {
    const r = request();
    expect(r.original.bytes).toBe(assets.get('orig')!.bytes);
    expect(r.references.map((x) => x.id)).toEqual(['a']);
    expect(r.references[0]).toMatchObject({ role: 'face', label: 'a', notes: 'n' });
    expect(Object.keys(r.guides)).toEqual(['pose']);
    expect(r.pose.keypoints.length).toBe(18);
    expect(r.pose.size).toEqual({ width: 768, height: 1152 });
    expect(r.output).toEqual({ width: 768, height: 1152 });
    expect(r.instructions).toBe('smiling');
    expect(r.appearance.hair).toBe('silver');
    expect(r.seed).toBe(42);
  });
  it('approving a reference includes it', () => {
    const c = updateReference(character(), 'b', { approved: true });
    expect(buildGenerationRequest(c, (id) => assets.get(id), {}, null).references.length).toBe(2);
  });
  it('fails clearly without an original or with missing images', () => {
    expect(() => buildGenerationRequest(emptyCharacter(), () => undefined, {}, null)).toThrow('original character artwork');
    expect(() => buildGenerationRequest(character(), (id) => (id === 'orig' ? undefined : assets.get(id)), {}, null)).toThrow('original artwork image is missing');
    expect(() => buildGenerationRequest(character(), (id) => (id === 'r1' ? undefined : assets.get(id)), {}, null)).toThrow('Reference image "a" is missing');
  });
  it('is deterministic', () => {
    expect(JSON.stringify(wireRequestJson(request()))).toBe(JSON.stringify(wireRequestJson(request())));
  });
});

describe('wire format', () => {
  it('sends JSON metadata plus every image as a named multipart file', async () => {
    const f = buildForm(request());
    const meta = JSON.parse(f.get('request') as string);
    expect(meta.protocol).toBe(1);
    expect(meta.references).toHaveLength(1);
    expect(meta.references[0]).toMatchObject({ index: 0, role: 'face' });
    expect(Object.keys(meta.guides)).toEqual(['pose']);
    expect(meta.pose.keypoints).toHaveLength(18);
    for (const name of ['original', 'reference_0', 'guide_pose']) expect(f.get(name)).toBeInstanceOf(Blob);
    expect(f.get('reference_1')).toBeNull();
    expect(new Uint8Array(await (f.get('original') as Blob).arrayBuffer())).toEqual(assets.get('orig')!.bytes);
  });
});

const okJson = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('local provider', () => {
  it('reports exactly what is missing when no backend is configured', async () => {
    const p = new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => okJson({ available: false, detail: 'No generation backend is configured (set CF_GENERATION_BACKEND).' }));
    const s = await p.status();
    expect(s.state).toBe('unavailable');
    expect(s.message).toContain('CF_GENERATION_BACKEND');
    expect(s.capabilities).toBeNull();
  });
  it('reports a missing server, an old server and a broken server differently', async () => {
    const unreachable = await new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => Promise.reject(new TypeError('fetch failed'))).status();
    expect(unreachable.message).toContain('Cannot reach');
    const old = await new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => new Response('nope', { status: 404 })).status();
    expect(old.message).toContain('older version');
    const broken = await new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => new Response('x', { status: 500 })).status();
    expect(broken.state).toBe('error');
  });
  it('reads capabilities when ready', async () => {
    const p = new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => okJson({ available: true, detail: 'ok', model: 'm-1', capabilities: { references: true, max_references: 3, guides: ['pose', 'depth', 'bogus'] } }));
    const s = await p.status();
    expect(s).toMatchObject({ state: 'ready', model: 'm-1' });
    expect(s.capabilities).toEqual({ acceptsReferences: true, maxReferences: 3, guides: ['pose', 'depth'] });
  });
  it('never talks to non-localhost addresses', async () => {
    let called = false;
    const p = new LocalHttpProvider('https://example.com', async () => ((called = true), okJson({})));
    expect((await p.status()).state).toBe('error');
    await expect(p.generate(request())).rejects.toMatchObject({ code: 'rejected' });
    expect(called).toBe(false);
    expect(createProvider('local-http', 'http://10.0.0.5:8765')).not.toBeNull(); // constructed, but every call is refused:
    await expect(createProvider('local-http', 'http://10.0.0.5:8765')!.generate(request())).rejects.toMatchObject({ code: 'rejected' });
  });
  it('returns the image and metadata from a successful response', async () => {
    const result = img(77, 400);
    let seen: FormData | null = null;
    const p = new LocalHttpProvider(DEFAULT_LOCAL_URL, async (_u, init) => {
      seen = init?.body as FormData;
      return new Response(result as BlobPart, { status: 200, headers: { 'content-type': 'image/png', 'x-cf-model': 'test-model', 'x-cf-seed': '1234', 'x-cf-info': 'used pose + 1 reference' } });
    });
    const stages: string[] = [];
    const out = await p.generate(request(), { onProgress: (g) => stages.push(g.stage) });
    expect(out).toMatchObject({ mime: 'image/png', model: 'test-model', seed: 1234, info: 'used pose + 1 reference' });
    expect(out.bytes).toEqual(result);
    expect(seen).not.toBeNull();
    expect(stages.length).toBeGreaterThan(0);
  });
  it('maps failures to specific error codes', async () => {
    const mk = (res: () => Response | Promise<Response>) => new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => res());
    await expect(mk(() => okJson({ detail: 'No backend.' }, 503)).generate(request())).rejects.toMatchObject({ code: 'unavailable', message: 'No backend.' });
    await expect(mk(() => okJson({ detail: 'Bad size.' }, 422)).generate(request())).rejects.toMatchObject({ code: 'rejected', message: 'Bad size.' });
    await expect(mk(() => new Response('boom', { status: 500 })).generate(request())).rejects.toMatchObject({ code: 'protocol' });
    await expect(mk(() => Promise.reject(new TypeError('x'))).generate(request())).rejects.toMatchObject({ code: 'network' });
  });
  it('supports cancellation', async () => {
    const ctl = new AbortController();
    const p = new LocalHttpProvider(DEFAULT_LOCAL_URL, (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const run = p.generate(request(), { signal: ctl.signal });
    ctl.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('honesty guard', () => {
  const out = (bytes: Uint8Array) => ({ bytes, mime: 'image/png', model: null, seed: null, info: null });
  it('rejects the original drawing handed back as a result', () => {
    expect(() => assertGenuineResult(out(assets.get('orig')!.bytes), request())).toThrow('original drawing unchanged');
  });
  it('rejects a reference or a guide image handed back', () => {
    expect(() => assertGenuineResult(out(assets.get('r1')!.bytes), request())).toThrow('reference "a" unchanged');
    expect(() => assertGenuineResult(out(img(9)), request())).toThrow('pose guide image unchanged');
  });
  it('rejects empty, truncated and non-image output', () => {
    expect(() => assertGenuineResult(out(new Uint8Array(0)), request())).toThrow('empty or truncated');
    expect(() => assertGenuineResult(out(new Uint8Array(200)), request())).toThrow('did not return a PNG');
    try {
      assertGenuineResult(out(new Uint8Array(200)), request());
    } catch (e) {
      expect(e).toBeInstanceOf(GenerationError);
      expect((e as GenerationError).code).toBe('invalid-output');
    }
  });
  it('accepts a genuinely different image', () => {
    expect(() => assertGenuineResult(out(img(55, 500)), request())).not.toThrow();
  });
  it('the provider applies the guard to what the server returns', async () => {
    const p = new LocalHttpProvider(DEFAULT_LOCAL_URL, async () => new Response(assets.get('orig')!.bytes as BlobPart, { status: 200, headers: { 'content-type': 'image/png' } }));
    await expect(p.generate(request())).rejects.toMatchObject({ code: 'invalid-output' });
  });
});

describe('provenance', () => {
  it('records sources, references, pose, camera and settings', () => {
    const c = character();
    const prov = buildProvenance({ character: c, providerId: 'local-http', providerName: 'Local', model: 'm', seed: 5, requestedAt: 1, completedAt: 2, guideAssetIds: { pose: 'g1' }, parentId: 'prev' });
    expect(prov.originalAssetId).toBe('orig');
    expect(prov.referenceAssetIds).toEqual(['r1']);
    expect(prov.guideAssetIds).toEqual({ pose: 'g1' });
    expect(prov.settings).toEqual({ width: 768, height: 1152, instructions: 'smiling', seed: 5 });
    expect(prov.parentId).toBe('prev');
    expect(prov.pose).toEqual(c.studio.pose);
    expect(prov.pose).not.toBe(c.studio.pose); // snapshot, not a live reference
    const rec = makeRecord('gen1', 'out', 'generated', prov, 3);
    expect(rec).toMatchObject({ status: 'candidate', origin: 'generated', decidedAt: null });
  });
});

describe('hardened local client', () => {
  const mkP = (fetchImpl: (u: string, i?: RequestInit) => Promise<Response>, timeoutMs?: number) => new LocalHttpProvider(DEFAULT_LOCAL_URL, fetchImpl, timeoutMs);
  const png = (n = 400) => img(77, n);
  const okImage = (bytes: Uint8Array = png(), headers: Record<string, string> = {}) => new Response(bytes as BlobPart, { status: 200, headers: { 'content-type': 'image/png', ...headers } });

  it('refuses an oversized request before uploading anything (per file and in total)', async () => {
    let called = 0;
    const p = mkP(async () => (called++, okImage()));
    const r = request();
    expect(() => checkRequestSize(r, { maxRequestBytes: 1e9, maxFileBytes: 100, maxResultBytes: 1e9 })).toThrowError(/original artwork is .*at most .* per image/i);
    const total = requestBytes(r);
    expect(total).toBeGreaterThan(r.original.bytes.byteLength);
    expect(() => checkRequestSize(r, { maxRequestBytes: total - 1, maxFileBytes: 1e9, maxResultBytes: 1e9 })).toThrowError(/in total.*Un-approve some references/s);
    expect(() => checkRequestSize(r)).not.toThrow();
    // through the provider: the limits learned from /generate/status are enforced
    const q = mkP(async (u) => (u.endsWith('/generate/status') ? okJson({ available: true, limits: { max_request_bytes: 300 } }) : (called++, okImage())));
    await q.status();
    await expect(q.generate(r)).rejects.toMatchObject({ code: 'too-large' });
    expect(called).toBe(0);
    await expect(p.generate(r)).resolves.toBeTruthy();
  });

  it('maps every server failure to a specific, honest error', async () => {
    const fail = (status: number, body: string | object, type = 'application/json') => mkP(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } })).generate(request());
    await expect(fail(429, { detail: 'busy now' })).rejects.toMatchObject({ code: 'busy', message: 'busy now' });
    await expect(fail(413, { detail: 'too big' })).rejects.toMatchObject({ code: 'too-large' });
    await expect(fail(504, { detail: 'timed out' })).rejects.toMatchObject({ code: 'timeout' });
    await expect(fail(502, { detail: 'garbage' })).rejects.toMatchObject({ code: 'invalid-output' });
    await expect(fail(421, { detail: 'host' })).rejects.toMatchObject({ code: 'rejected' });
    await expect(fail(403, { detail: 'origin' })).rejects.toMatchObject({ code: 'rejected' });
    await expect(fail(422, { detail: [{ msg: 'field required' }, { msg: 'bad seed' }] })).rejects.toMatchObject({ code: 'rejected', message: 'field required; bad seed' });
    // an HTML error page (a proxy, or another program on the port) must not be shown as if it were the server's message
    const html = (await fail(500, "<html><body>Internal Server Error</body></html>", "text/html").catch((e: unknown) => e)) as GenerationError;
    expect(html).toMatchObject({ code: 'protocol' });
    expect(html.message).not.toContain('<html>');
    await expect(fail(500, '')).rejects.toMatchObject({ code: 'protocol', message: expect.stringContaining('HTTP 500') });
  });

  it('refuses a 200 that is not an image, and results that are too large', async () => {
    await expect(mkP(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })).generate(request())).rejects.toMatchObject({ code: 'protocol', message: expect.stringContaining('application/json') });
    let cancelled = false;
    const declared = new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(500 * 1024 * 1024) } });
    await expect(mkP(async () => declared).generate(request())).rejects.toMatchObject({ code: 'too-large' });
    expect(cancelled).toBe(true);
    // no Content-Length: the cap applies while streaming
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => (sent++ < 100 ? c.enqueue(chunk) : c.close()) });
    const p = new LocalHttpProvider(DEFAULT_LOCAL_URL, async (u) => (u.endsWith('/generate/status') ? okJson({ available: true, limits: { max_result_bytes: 3 * 1024 * 1024 } }) : new Response(endless, { status: 200, headers: { 'content-type': 'image/png' } })));
    await p.status();
    await expect(p.generate(request())).rejects.toMatchObject({ code: 'too-large' });
    expect(sent).toBeLessThan(10); // it stopped reading long before 100 MB
  });

  it('an interrupted download is an error, never a half-written image', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(png(300));
        c.error(new TypeError('network error'));
      },
    });
    await expect(mkP(async () => new Response(broken, { status: 200, headers: { 'content-type': 'image/png' } })).generate(request())).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('incomplete') });
  });

  it('tells a crashed server from an interrupted request', async () => {
    const down = mkP(async () => Promise.reject(new TypeError('fetch failed')));
    await expect(down.generate(request())).rejects.toMatchObject({ code: 'network', message: expect.stringMatching(/crashed|restart/) });
    const up = mkP(async (u) => (u.endsWith('/health') ? okJson({ status: 'ok' }) : Promise.reject(new TypeError('reset'))));
    await expect(up.generate(request())).rejects.toMatchObject({ code: 'network', message: expect.stringContaining('still running') });
  });

  it('times out on its own and distinguishes that from a user cancel', async () => {
    const hang = (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
    await expect(mkP(hang, 30).generate(request())).rejects.toMatchObject({ code: 'timeout' });
    const ctl = new AbortController();
    const run = mkP(hang, 60_000).generate(request(), { signal: ctl.signal });
    ctl.abort();
    await expect(run).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reads a busy server and tolerates nonsense capabilities', async () => {
    const busy = await mkP(async () => okJson({ available: true, busy: true, model: 'm', capabilities: { max_references: -5, guides: 'pose' } })).status();
    expect(busy.state).toBe('ready');
    expect(busy.message).toContain('busy');
    expect(busy.capabilities).toEqual({ acceptsReferences: true, maxReferences: 8, guides: ['pose'] }); // nonsense falls back to the documented defaults
    const weird = await mkP(async () => okJson({ available: true, capabilities: { max_references: 1e9, guides: [1, null, 'depth'] } })).status();
    expect(weird.capabilities).toMatchObject({ maxReferences: 8, guides: ['depth'] });
  });

  it('a failed or cancelled generation leaves the character exactly as it was', async () => {
    const c = character();
    const before = JSON.stringify(c);
    const originalBytes = assets.get('orig')!.bytes.slice();
    for (const f of [async () => okJson({ detail: 'x' }, 500), async () => Promise.reject(new TypeError('x')), async () => okImage(img(1, 10))]) {
      await expect(mkP(f).generate(request())).rejects.toBeInstanceOf(GenerationError);
    }
    expect(JSON.stringify(c)).toBe(before);
    expect(assets.get('orig')!.bytes).toEqual(originalBytes);
  });
});
