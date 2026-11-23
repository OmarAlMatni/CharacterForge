"""CharacterForge generation endpoints (pose-guided 2D generation) — protocol v1.

This module is the *plug-in point* for a real image model. It does NOT contain a model and it never fabricates output:
without a configured backend, /generate/status says exactly what is missing and /generate answers 503.

Configure a backend with the environment variable:

    CF_GENERATION_BACKEND="package.module:object"

The referenced object must provide:

    status() -> dict      # {"available": bool, "detail": str, "model": str|None,
                          #  "capabilities": {"references": bool, "max_references": int, "guides": [..]}}
    generate(request: dict, files: dict[str, bytes]) -> dict
                          # returns {"image": bytes, "mime": "image/png", "model": str|None, "seed": int|None, "info": str|None}

`request` is the parsed JSON described in docs/GENERATION_PROTOCOL.md; `files` maps the multipart part names
("original", "reference_0", "guide_pose", ...) to raw bytes.

SECURITY: CF_GENERATION_BACKEND makes the server import and run that module as ordinary Python with the server's own permissions. It can
only be set by whoever starts the server (it is an environment variable, never read from a request). See docs/SECURITY.md.

Behaviour guarantees of this module (all covered by server/tests):
  * the whole request is size-limited before parsing (limits.RequestGuard), then every part is validated again here;
  * `generate()` runs in a worker thread, so a slow model never blocks /health, /generate/status or /segment;
  * only one heavy job runs at a time (429 otherwise) and the slot is held until the backend really returns;
  * a backend that raises, returns garbage, returns something that is not an image, or takes too long becomes a clear JSON error —
    never a half-written image — and the server keeps answering.
"""
from __future__ import annotations

import importlib
import io
import json
import os
import re
import threading
from typing import Any

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from PIL import Image

import limits
from limits import MB, heavy_slot, inspect_image, sanitize_header

PROTOCOL = 1
MAX_SIDE = 4096  # generated output size
MAX_REFERENCES = 16
MAX_TEXT = 8000
GUIDE_KINDS = ("mannequin", "textured", "pose", "depth", "silhouette")
_SPEC = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*:[A-Za-z_][A-Za-z0-9_]*$")

router = APIRouter()
_loaded: dict[str, Any] = {}


def _backend_spec() -> str:
    return os.environ.get("CF_GENERATION_BACKEND", "").strip()


def load_backend() -> tuple[Any | None, str | None]:
    """Return (backend, problem). `problem` says exactly why no backend can be used. A successfully imported backend is reused."""
    spec = _backend_spec()
    if not spec:
        return None, (
            "No generation backend is configured. CharacterForge ships the protocol and the plug-in point, not a model. "
            "Set CF_GENERATION_BACKEND=module:object to a backend that wraps a pose-conditioned image model "
            "(see docs/GENERATION_PROTOCOL.md)."
        )
    if not _SPEC.match(spec):
        return None, f'CF_GENERATION_BACKEND must look like "module:object" (a Python module name, a colon, an object name), got "{spec[:80]}".'
    if spec in _loaded:
        return _loaded[spec], None
    mod_name, attr = spec.split(":", 1)
    try:
        mod = importlib.import_module(mod_name)
        backend = getattr(mod, attr)
    except Exception as e:  # noqa: BLE001
        return None, f'The generation backend "{spec}" could not be loaded: {e}'
    for fn in ("status", "generate"):
        if not callable(getattr(backend, fn, None)):
            return None, f'The generation backend "{spec}" has no {fn}() function.'
    _loaded[spec] = backend
    return backend, None


@router.get("/generate/status")
async def generate_status() -> dict[str, Any]:
    backend, problem = load_backend()
    base = {"protocol": PROTOCOL, "limits": limits.limits_json(), "busy": heavy_slot.busy}
    if backend is None:
        return {**base, "available": False, "detail": problem, "model": None, "capabilities": None}
    try:
        with anyio.fail_after(limits.STATUS_TIMEOUT_S):
            st = dict(await anyio.to_thread.run_sync(backend.status, abandon_on_cancel=True))
    except TimeoutError:
        return {**base, "available": False, "detail": f"The generation backend did not answer its status check within {limits.STATUS_TIMEOUT_S} s.", "model": None, "capabilities": None}
    except Exception as e:  # noqa: BLE001
        return {**base, "available": False, "detail": f"The generation backend failed its status check: {sanitize_header(e, 300)}", "model": None, "capabilities": None}
    st.update(base)
    st["available"] = bool(st.get("available"))
    st.setdefault("detail", "Ready." if st["available"] else "The backend reports it is not available.")
    return st


def _parse_request(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, str):
        raise HTTPException(400, 'Missing the "request" JSON field.')
    if len(raw.encode("utf-8", "replace")) > limits.MAX_JSON_BYTES:
        raise HTTPException(413, f'The "request" JSON is larger than {limits.MAX_JSON_BYTES // 1024} KB.')
    try:
        req = json.loads(raw)
    except (ValueError, RecursionError) as e:
        raise HTTPException(400, f'"request" is not valid JSON: {e}') from e
    if not isinstance(req, dict) or req.get("protocol") != PROTOCOL:
        raise HTTPException(400, f"Unsupported protocol (this server speaks version {PROTOCOL}).")
    out = req.get("output")
    out = out if isinstance(out, dict) else {}
    w, h = out.get("width"), out.get("height")
    if not (type(w) is int and type(h) is int and 64 <= w <= MAX_SIDE and 64 <= h <= MAX_SIDE):
        raise HTTPException(422, f"output.width/height must be whole numbers from 64 to {MAX_SIDE}.")
    ins = req.get("instructions", "")
    if not isinstance(ins, str) or len(ins) > MAX_TEXT:
        raise HTTPException(422, f"instructions must be text of at most {MAX_TEXT} characters.")
    seed = req.get("seed")
    if seed is not None and not (type(seed) is int and 0 <= seed <= 2**32 - 1):
        raise HTTPException(422, "seed must be null or a whole number from 0 to 4294967295.")
    for key in ("appearance", "pose", "guides"):
        if key in req and not isinstance(req[key], dict):
            raise HTTPException(422, f'"{key}" must be an object.')
    refs = req.get("references", [])
    if not isinstance(refs, list) or not all(isinstance(r, dict) for r in refs):
        raise HTTPException(422, '"references" must be a list of objects.')
    if len(refs) > MAX_REFERENCES:
        raise HTTPException(422, f"At most {MAX_REFERENCES} reference images are supported.")
    return req


def _validate_output(result: Any) -> tuple[bytes, str]:
    """The backend's answer, checked like any other input: it must really be a (reasonably sized) PNG/JPEG/WebP image."""
    image = result.get("image") if isinstance(result, dict) else None
    if not isinstance(image, (bytes, bytearray, memoryview)) or not len(image):
        raise HTTPException(502, "The generation backend returned no image.")
    data = bytes(image)
    if len(data) > limits.MAX_RESULT_BYTES:
        raise HTTPException(502, f"The generation backend returned an image larger than {limits.MAX_RESULT_BYTES // MB} MB.")
    try:
        _, fmt = inspect_image("the generated image", data, max_bytes=limits.MAX_RESULT_BYTES, max_pixels=limits.MAX_PIXELS)
    except HTTPException as e:
        raise HTTPException(502, f"The generation backend returned something that is not a usable image: {e.detail}") from e
    return data, limits.FORMAT_MIME[fmt]


class _Job:
    """Hand-over between the request and its worker thread."""

    def __init__(self, token: object) -> None:
        self.token = token
        self.started = threading.Event()
        self.abandoned = False


def _run_backend(backend: Any, req: dict[str, Any], files: dict[str, bytes], job: _Job) -> Any:
    """Worker-thread body. Releases the heavy-job slot only when the backend has really finished (or never started)."""
    try:
        if job.abandoned:  # the request gave up while this job was still queued: do not start a model run nobody is waiting for
            return None
        job.started.set()
        return backend.generate(req, files)
    finally:
        heavy_slot.release(job.token)


@router.post("/generate")
async def generate(request: Request) -> Response:
    backend, problem = load_backend()
    if backend is None:
        raise HTTPException(503, problem)
    try:
        form = await request.form(max_files=MAX_REFERENCES + 1 + len(GUIDE_KINDS) + 1, max_fields=4, max_part_size=limits.MAX_JSON_BYTES + 1024)
    except (HTTPException, limits.BodyTooLarge):
        raise
    except Exception as e:  # noqa: BLE001 - malformed multipart, too many parts, ...
        raise HTTPException(400, f"The request is not a valid multipart upload: {sanitize_header(e, 200)}") from e
    try:
        req = _parse_request(form.get("request"))
        files: dict[str, bytes] = {}
        total_pixels = 0
        for key, value in form.multi_items():
            if key == "request":
                continue
            if not hasattr(value, "read"):
                raise HTTPException(400, f'Field "{key}" must be a file.')
            if key in files:
                raise HTTPException(400, f'Duplicate part "{key}".')
            if not (key == "original" or re.fullmatch(r"reference_(0|[1-9][0-9]{0,2})", key) or key.startswith("guide_")):
                raise HTTPException(400, f'Unexpected file "{key}".')
            if key.startswith("guide_") and key[len("guide_"):] not in GUIDE_KINDS:
                raise HTTPException(400, f'Unknown guide "{key}".')
            data = await value.read()
            img, _ = inspect_image(key, data)
            total_pixels += img.size[0] * img.size[1]
            if total_pixels > limits.MAX_TOTAL_PIXELS:
                raise HTTPException(413, f"The images together are larger than {limits.MAX_TOTAL_PIXELS / 1e6:.0f} megapixels.")
            files[key] = data
    finally:
        await form.close()
    if "original" not in files:
        raise HTTPException(400, 'The original artwork ("original") is required.')
    ref_keys = sorted(k for k in files if k.startswith("reference_"))
    if len(ref_keys) > MAX_REFERENCES:
        raise HTTPException(422, f"At most {MAX_REFERENCES} reference images are supported.")
    if ref_keys != [f"reference_{i}" for i in range(len(ref_keys))] or len(req.get("references", [])) != len(ref_keys):
        raise HTTPException(422, f'The "references" list ({len(req.get("references", []))}) and the reference_N files ({len(ref_keys)}) do not match.')

    job = _Job(heavy_slot.try_acquire())  # 429 if a segmentation or another generation is still running
    try:
        with anyio.fail_after(limits.GENERATION_TIMEOUT_S):
            result = await anyio.to_thread.run_sync(_run_backend, backend, req, files, job, abandon_on_cancel=True)
    except TimeoutError as e:
        # the worker thread cannot be killed; once started it keeps the slot until it returns, so the next request gets a clear "busy"
        job.abandoned = True
        if not job.started.is_set():
            heavy_slot.release(job.token)
        raise HTTPException(504, f"The generation backend did not finish within {limits.GENERATION_TIMEOUT_S} s. It may still be running; wait for it before starting another job.") from e
    except BaseException as e:  # noqa: BLE001 - includes a backend that calls sys.exit()
        job.abandoned = True
        if not job.started.is_set():
            heavy_slot.release(job.token)
        if isinstance(e, HTTPException):
            raise
        if isinstance(e, (KeyboardInterrupt, anyio.get_cancelled_exc_class())):
            raise
        raise HTTPException(500, f"The generation backend failed: {sanitize_header(f'{type(e).__name__}: {e}', 400)}") from e
    data, mime = _validate_output(result)
    headers: dict[str, str] = {}
    if result.get("model"):
        headers["X-CF-Model"] = sanitize_header(result["model"])
    try:
        if result.get("seed") is not None:
            headers["X-CF-Seed"] = str(int(result["seed"]))
    except (TypeError, ValueError):
        pass
    if result.get("info"):
        headers["X-CF-Info"] = sanitize_header(result["info"], 500)
    return Response(content=data, media_type=mime, headers=headers)
