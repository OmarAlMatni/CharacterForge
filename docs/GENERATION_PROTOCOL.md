# Generation protocol (version 1)

For the next step (a real pose-conditioned model) see `docs/AI_INTEGRATION_RECOMMENDATION.md`.

CharacterForge talks to an image-generation backend through two things:

1. **`GenerationProvider`** (`src/generation/types.ts`) — the TypeScript contract the UI uses. It has `status()` and `generate()`.
2. **The local HTTP protocol** below, implemented by `LocalHttpProvider` (client) and `server/generation.py` (server plug-in point).

**CharacterForge ships no image model.** Without a configured backend the app says exactly that, the *Generate* button stays disabled, and no image is ever fabricated. To get real output you must supply a backend (see "Writing a backend").

## Privacy rule

`LocalHttpProvider` refuses any address that is not loopback (`127.0.0.1`, `localhost`, `::1`). There is no remote mode. Adding a hosted/paid provider means writing a new `GenerationProvider` with `sendsArtworkOffDevice = true`, and that requires the user's explicit approval before any artwork is sent.

## `GET /generate/status`

```json
{
  "protocol": 1,
  "available": true,
  "detail": "Ready.",
  "model": "my-checkpoint-name",
  "capabilities": { "references": true, "max_references": 4, "guides": ["pose", "depth"] },
  "limits": { "max_request_bytes": 268435456, "max_file_bytes": 67108864, "max_pixels": 36000000, "max_total_pixels": 120000000, "max_result_bytes": 67108864, "timeout_seconds": 900 },
  "busy": false
}
```

`limits` and `busy` are added by the server itself (a backend does not supply them). The client uses `limits` to refuse an oversized request before uploading it; `busy` is true while a segmentation or generation job is running. The status call has a 10 s timeout; a backend whose `status()` hangs or raises is reported as unavailable with the reason.

When no backend is configured: `available: false`, `detail` states what is missing, `capabilities: null`. The app shows `detail` verbatim.

## `POST /generate` (multipart/form-data)

| Part | Type | Notes |
|---|---|---|
| `request` | JSON string | Required. See below. |
| `original` | image file | Required. The user's original full-body drawing, byte-for-byte. |
| `reference_0` … `reference_N` | image files | Approved references, in the order listed in `request.references`. |
| `guide_mannequin`, `guide_textured`, `guide_pose`, `guide_depth`, `guide_silhouette` | PNG files | Pose guides rendered with the same camera/frame as the studio viewport. Any subset. `mannequin` is the grey clay model; `textured` is the character render (the artist's artwork projected onto the posed model) and is only sent when the artwork has been projected and the backend lists `textured` in its `capabilities.guides`. |

`request` JSON:

```json
{
  "protocol": 1,
  "output": { "width": 768, "height": 1152 },
  "instructions": "free text from the user",
  "appearance": { "palette": ["#aabbcc"], "hair": "", "eyes": "", "clothing": "", "accessories": "", "notes": "" },
  "seed": 12345,
  "pose": { "...": "PoseGuideData: camera, joints (world + pixel positions, depth), OpenPose-18 keypoints, facing direction" },
  "original": { "width": 600, "height": 900 },
  "references": [{ "index": 0, "id": "…", "role": "face", "label": "…", "notes": "…", "width": 512, "height": 512 }],
  "guides": { "pose": { "width": 768, "height": 1152 } }
}
```

`seed` is `null` when the user wants a random one. `appearance` text is only a hint: the reference images carry identity.

### Responses

* **200** — body is the image (`image/png`, `image/jpeg` or `image/webp`, taken from the bytes, not from the backend's claim). Optional headers: `X-CF-Model`, `X-CF-Seed`, `X-CF-Info` (ASCII, sanitised, ≤ 500 chars, e.g. which guides were actually used).
* **400** — malformed multipart/JSON/part, unreadable or damaged image, unsupported format (only PNG/JPEG/WebP; animated files are refused), duplicate part, unexpected file name.
* **403** — the request's `Origin` is not allowed. **421** — the `Host` is not loopback.
* **413** — too large: whole request (`max_request_bytes`, checked before parsing, also for chunked uploads), a single file, a pixel count, or total pixels.
* **422** — invalid values: output size outside 64–4096, bad seed, instructions > 8000 chars, > 16 references, or the `references` list not matching the `reference_N` files.
* **429** (+ `Retry-After`) — the server is busy with another generation or segmentation. It is not queued; retry later.
* **500** — the backend raised (or called `sys.exit`); the message is shown. **502** — the backend returned no image, something that is not a usable image, or one over `max_result_bytes`/`max_pixels`. **503** — no backend configured/available. **504** — the backend did not finish within `timeout_seconds`; it may still be running and holds the slot until it returns.

Every error body is JSON `{"detail": "..."}`. The client maps status codes to messages itself and does not trust the body for control flow.

### Limits (defaults; environment variables on the server)

| Limit | Default | Variable |
|---|---|---|
| Whole `/generate` request | 256 MB | `CF_MAX_REQUEST_MB` |
| Single image file | 64 MB | `CF_MAX_FILE_MB` |
| Single decoded image | 36 MP (side ≤ 16384) | `CF_MAX_PIXELS` |
| All images of one request | 120 MP | `CF_MAX_TOTAL_PIXELS` |
| `request` JSON | 1024 KB | `CF_MAX_JSON_KB` |
| Backend result | 64 MB | `CF_MAX_RESULT_MB` |
| Generation time | 900 s | `CF_GENERATION_TIMEOUT_S` |
| References | 16 | fixed |

Only **one** heavy job runs at a time. `generate()` runs in a worker thread, so `/health`, `/generate/status` and `/segment/status` stay responsive during a long generation. See `docs/SECURITY.md` for the full list and the caveats.

### Honesty guard (client side)

Before anything is stored as "generated", `assertGenuineResult` rejects: empty/truncated data, non-images, and any result byte-identical to the original, a reference, or a guide. Rejected results are discarded with an explanation.

### Cancel and progress

The client aborts the `fetch` (the user's *Cancel*). The v1 protocol is a single request/response, so progress is stage text only ("Sending…", "Receiving…"); a backend that wants real progress needs a v2 streaming extension.

## Writing a backend

Create a Python module with an object that has `status()` and `generate(request, files)`, then start the server with:

```
CF_GENERATION_BACKEND=my_backend:backend python -m uvicorn main:app --host 127.0.0.1 --port 8765
```

```python
class MyBackend:
    def status(self):
        return {"available": True, "detail": "Ready.", "model": "my-model",
                "capabilities": {"references": True, "max_references": 4, "guides": ["pose", "depth"]}}

    def generate(self, request, files):
        # files: {"original": bytes, "reference_0": bytes, "guide_pose": bytes, ...}
        png_bytes = run_my_pose_conditioned_model(files, request)   # your code
        return {"image": png_bytes, "mime": "image/png", "model": "my-model", "seed": request["seed"], "info": "used pose+depth"}

backend = MyBackend()
```

A backend runs inside the server process with the server's permissions (see `docs/SECURITY.md`): only configure code you trust. It must return real image bytes; anything else becomes a 502 and nothing is stored. It should check `request.output` and the guide list itself and may raise a plain exception with a readable message — that message reaches the artist.

A backend must use only the inputs it declares in `capabilities.guides`/`references` and must say so honestly in `info`. Typical real setups wrap ComfyUI or diffusers with a pose ControlNet plus an identity/reference adapter. Hardware reality: these models want a GPU with roughly 8 GB+ VRAM; CPU-only runs are impractical.

## Testing

`tests/generation.test.ts` covers the client with a mocked `fetch`. `server/tests/test_generation_protocol.py` covers the server with a **test-only synthetic backend** (`server/tests/fake_backend.py`, a colour gradient — not a model, never loaded unless a test sets the environment variable). No model inference is exercised by any test.
