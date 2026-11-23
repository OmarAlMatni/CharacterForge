# Security and resource limits (v0.4.1)

**This is not a security certification and no third party has audited CharacterForge.** This page records what was inspected and tested during the v0.4.1 hardening pass, what the limits are, and what is still open. It describes a local, single-user tool.

## Threat model

CharacterForge is a browser app (all data stays in the browser's IndexedDB) plus an *optional* Python server (`server/`) that the artist starts on their own computer for background removal, part segmentation and generation. The realistic risks are:

1. **A web page the artist visits** sends requests to `http://127.0.0.1:8765`. Browsers send cross-origin "simple" POSTs (multipart) without asking; CORS only hides the answer, it does not stop the request from running. That could make the server run a model or exhaust memory.
2. **Oversized or malformed input**, accidental or hostile: huge uploads, images that decode to gigabytes (decompression bombs), many references, broken multipart, zip bombs in a project bundle.
3. **A slow or crashing generation backend** freezing the server or corrupting the project.
4. **A damaged or malicious `.cfbundle`/stored project** overwriting or corrupting the artist's work.

Out of scope: multi-user hosting, authentication, a hostile local user, a hostile operator (the operator chooses the backend code).

## Local server

| Protection | Where | Default |
|---|---|---|
| Bind address must be loopback; anything else is refused at startup unless `CF_ALLOW_REMOTE_BIND=1` | `server/main.py` | `127.0.0.1` |
| `Host` header must be `localhost`/`127.0.0.1`/`[::1]` (DNS-rebinding) → 421; extend with `CF_ALLOWED_HOSTS` | `limits.RequestGuard` | on |
| A non-GET request that carries an `Origin` must come from an allowed origin → 403 (`CF_ALLOWED_ORIGINS`; the dev/preview ports are built in). Requests without `Origin` (curl, scripts) are allowed | `limits.RequestGuard` | on |
| Whole-request size cap **before parsing**: by `Content-Length` and by counting streamed bytes (chunked uploads) → 413 | `limits.RequestGuard` | `/generate` 256 MB (`CF_MAX_REQUEST_MB`), `/segment` 64 MB (`CF_MAX_SEGMENT_MB`) |
| Per-file cap, header-first image check (PNG/JPEG/WebP only, no animation, side ≤ 16384, pixel cap **before** decoding), `verify()` | `limits.inspect_image` | 64 MB, 36 MP (`CF_MAX_FILE_MB`, `CF_MAX_PIXELS`) |
| Sum of pixels over all images in a request | `generation.py` | 120 MP (`CF_MAX_TOTAL_PIXELS`) |
| `/segment` decodes the whole image several times, so it has its own cap | `main.py` | 16 MP (`CF_MAX_SEGMENT_PIXELS`) |
| JSON field size, protocol version, output size 64–4096 px, instruction length, seed range, ≤ 16 references, part names (`original`, `reference_N`, `guide_<kind>`), duplicate parts, number of parts | `generation.py` | fixed |
| `references` list must agree with the `reference_N` files | `generation.py` | fixed (422) |
| One heavy job (segmentation or generation) at a time; a second gets **429 + Retry-After**. The slot is held until the backend *really* returns | `limits.HeavySlot` | on |
| Heavy work runs in a worker thread, so `/health`, `/generate/status`, `/segment/status` keep answering while a model runs | `generation.py`, `main.py` | on |
| Generation timeout → 504 (the thread cannot be killed; the slot stays held until it ends) | `generation.py` | 900 s (`CF_GENERATION_TIMEOUT_S`) |
| Backend output is checked like any input (real PNG/JPEG/WebP, ≤ 64 MB, ≤ pixel cap) → 502; mime is derived from the bytes, not from the backend; response headers are ASCII-sanitised (no header injection) | `generation.py` | on |
| Backend exceptions (including `SystemExit`) become a JSON 500; segmentation failures become JSON 500 / 507 (out of memory) | `generation.py`, `main.py` | on |
| `/generate/status` tells the client the limits, so the browser refuses an oversized request *before* uploading it | both | on |

### Server plug-in configuration (read this before setting these)

* **`CF_GENERATION_BACKEND=module:object` imports and runs that module as ordinary Python with the server's permissions.** That is arbitrary code execution *by design* — a generation backend is code. It is only ever read from the server's environment, never from a request. The value must look like `dotted.module:object` (a strict pattern), but that is a typo guard, not a sandbox. Consequences: (a) only set it to code you trust; (b) the module is found through `sys.path` — and the server's working directory is on it — so don't start the server from a directory that holds untrusted `.py` files; (c) the backend is imported once and reused; (d) a backend is trusted with the artist's artwork and runs with their file access.
* **`CF_SAM_CHECKPOINT`** points at a Segment-Anything checkpoint. Such files are PyTorch pickles; loading an untrusted one executes code. Use only checkpoints from the official source.
* **`rembg`** downloads its model on first use (network egress from the server, from rembg's own download location). The app itself never uploads artwork anywhere.
* **`CF_ALLOWED_ORIGINS`, `CF_ALLOWED_HOSTS`** widen who may talk to the server. Adding `*`-style or remote origins weakens the cross-site protection above.
* **`CF_ALLOW_REMOTE_BIND=1`** lets the server listen on a non-loopback address. There is **no authentication**: anyone who can reach the port can run your model and read results. Do not use this on an untrusted network.
* The `CF_MAX_*` limits can be raised; raising them raises the memory a single request can consume. The defaults assume an 8 GB machine.

### Known limits of the server hardening

* A generation that times out or whose client disconnects **keeps running** in its thread until the backend returns (Python cannot kill it). The slot stays occupied, so the next request gets a clear 429 instead of stacking a second model run on top. A backend that never returns needs the server restarted.
* A backend that hard-crashes the process (segfault, CUDA out-of-memory abort, the OS OOM killer) takes the server with it; the app reports "lost the connection… may have crashed or run out of memory" and stores nothing. Restarting is the operator's job (use a process supervisor if you want that automatic).
* The Origin rule trusts the browser to send `Origin`. A non-browser client on the same machine is not restricted (it already runs as the user).
* No rate limiting beyond the single-job rule, no TLS (loopback), no authentication.

## Browser app

* **Originals are never overwritten.** Imported artwork is stored byte-for-byte. Generation only *adds* records/images; a failed, cancelled, invalid or oversized generation stores nothing (verified in the end-to-end run by hashing every stored image before and after, including a backend that returns garbage and a server killed mid-generation). A generated image identical to the original, a reference or a guide is discarded as "not generated".
* **Client request checks:** size is computed and compared with the limits the server reported before anything is sent; 429/413/421/403/502/504 are mapped to specific messages; the response body is read with a hard cap and a content-type check; a lost connection is diagnosed with a `/health` probe. The HTTP provider only accepts loopback addresses.
* **Bundle import** (`src/storage/bundle.ts`): bundle ≤ 1 GiB; per entry ≤ 256 MiB images / 64 MiB `project.json` / 8 MiB manifest; ≤ 20 000 entries; the declared uncompressed sizes are checked **before inflating** (a 307 KB ZIP that inflates to 300 MB is refused); duplicate entries refused; only `manifest.json`, `project.json` and `assets/<id>.<ext>` are read; the manifest may not point anywhere else; **every entry's CRC-32 is verified** against the ZIP directory (added in 0.4.1 — a single flipped byte in an image used to be imported silently); image header size must match the project's declared size and the canvas/pixel caps; dangling references and unsupported types refused; the project goes through the same validation as a stored project. Importing always creates a **new** project and never touches existing ones.
* **Migration safety:** before a stored project is upgraded to the current format, its raw pre-upgrade JSON is kept in a `backups` table (once per project and format version) so an upgrade can never be the only copy. `restoreMigrationBackup` restores as a new project. There is **no UI for restoring yet**; the data is kept and can be recovered programmatically. Migrations are idempotent and do not mutate their input (tested).

## What was actually tested

* `server/tests/test_hardening.py` (51 tests) and `test_generation_protocol.py`: size limits including chunked and aggregate, pixel budget, origin/host/CORS, decompression bombs, unsupported formats, malformed fields, reference consistency, duplicate parts, spec validation, backends that exit/return garbage/return oversized output/inject headers, slow-backend non-blocking behaviour, 429, timeout 504, slot semantics, segmentation limits/crash/concurrency, bind refusal.
* A real-socket smoke test with uvicorn: evil origin 403, over-limit body 413, wrong Host 421, `/health` answered in 0.01 s while a generation ran, second generation 429.
* `tests/bundle.test.ts` (18), `tests/persistence.test.ts`, `tests/generation.test.ts` (client error mapping, size checks, interrupted download, junk capabilities).
* `e2e/full.e2e.cjs`: 36 steps in headless Chromium against the built app and a real server (see README for what that does and does not prove).

**Not done:** no penetration test, no fuzzing beyond the cases above, no dependency vulnerability scan beyond `npm`/`pip` defaults, no testing on Windows/macOS, no test with a real model backend, no test with a real GPU, no test in a headed or non-Chromium browser.
