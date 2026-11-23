"""Resource limits and request guards shared by every endpoint of the local server.

Why this exists: the server runs on the artist's own machine (default 8 GB RAM, often no GPU) and is reachable by every web page the
artist opens, because browsers will happily send a cross-origin "simple" POST (multipart/form-data) to http://127.0.0.1. CORS only stops
a page from READING the answer; it does not stop the request from being executed. So the server itself must

  * refuse requests that did not come from an allowed origin or Host (DNS-rebinding),
  * cap how many bytes it accepts per request — in total, not just per file — before any parsing happens,
  * cap decoded image sizes before pixels are allocated,
  * run at most one heavy job (segmentation model or generation backend) at a time, and
  * never let a slow job block the other endpoints (heavy work runs in a worker thread).

Nothing here is a security certification. See docs/SECURITY.md for what is and is not covered.
"""
from __future__ import annotations

import io
import os
import re
import threading
from typing import Any, Awaitable, Callable, Iterable

from fastapi import HTTPException
from PIL import Image


def _env_int(name: str, default: int, lo: int = 1) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(lo, int(raw))
    except ValueError:
        return default


MB = 1024 * 1024
#: Largest body the server reads for /generate (all parts together) and for /segment.
MAX_GENERATE_BYTES = _env_int("CF_MAX_REQUEST_MB", 256) * MB
MAX_SEGMENT_BYTES = _env_int("CF_MAX_SEGMENT_MB", 64) * MB
#: Largest single image part.
MAX_FILE_BYTES = _env_int("CF_MAX_FILE_MB", 64) * MB
#: Largest decoded image: width x height. 36 MP is 6000x6000. A decoded RGBA copy of it is 144 MB.
MAX_PIXELS = _env_int("CF_MAX_PIXELS", 36_000_000)
#: Sum of the pixels of every image in one /generate request.
MAX_TOTAL_PIXELS = _env_int("CF_MAX_TOTAL_PIXELS", 120_000_000)
#: /segment decodes the whole image (and several full-size copies), so it gets a tighter pixel budget.
MAX_SEGMENT_PIXELS = _env_int("CF_MAX_SEGMENT_PIXELS", 16_000_000)
MAX_SIDE = 16384
MAX_JSON_BYTES = _env_int("CF_MAX_JSON_KB", 1024) * 1024
MAX_RESULT_BYTES = _env_int("CF_MAX_RESULT_MB", 64) * MB
GENERATION_TIMEOUT_S = _env_int("CF_GENERATION_TIMEOUT_S", 900)
STATUS_TIMEOUT_S = 10

IMAGE_FORMATS = ("PNG", "JPEG", "WEBP")
FORMAT_MIME = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


def limits_json() -> dict[str, int]:
    """What the client is told (in /generate/status) so it can refuse an oversized request before uploading it."""
    return {
        "max_request_bytes": MAX_GENERATE_BYTES,
        "max_file_bytes": MAX_FILE_BYTES,
        "max_pixels": MAX_PIXELS,
        "max_total_pixels": MAX_TOTAL_PIXELS,
        "max_result_bytes": MAX_RESULT_BYTES,
        "timeout_seconds": GENERATION_TIMEOUT_S,
    }


# --------------------------------------------------------------------------------------- image validation
def inspect_image(name: str, data: bytes, *, max_bytes: int = MAX_FILE_BYTES, max_pixels: int = MAX_PIXELS, decode: bool = False) -> tuple[Image.Image, str]:
    """Check one uploaded image WITHOUT trusting its extension, declared type or size. Returns (image, FORMAT).

    The header is read first and the pixel budget is enforced BEFORE any pixel data is decoded, so a 40-byte PNG that claims to be
    100000x100000 is rejected without allocating anything. Only PNG, JPEG and WebP are accepted, and animated files are refused.
    """
    if not data:
        raise HTTPException(400, f'"{name}" is empty.')
    if len(data) > max_bytes:
        raise HTTPException(413, f'"{name}" is larger than {max_bytes // MB} MB.')
    try:
        img = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError as e:
        raise HTTPException(413, f'"{name}" is too large to decode safely.') from e
    except Exception as e:  # noqa: BLE001 - PIL raises many different types for damaged files
        raise HTTPException(400, f'"{name}" is not a readable image: {e}') from e
    fmt = (img.format or "").upper()
    if fmt not in IMAGE_FORMATS:
        raise HTTPException(400, f'"{name}" is a {fmt or "unknown"} file. Only PNG, JPEG and WebP images are accepted.')
    w, h = img.size
    if w < 1 or h < 1:
        raise HTTPException(400, f'"{name}" has no pixels.')
    if max(w, h) > MAX_SIDE:
        raise HTTPException(413, f'"{name}" is larger than {MAX_SIDE} px on one side.')
    if w * h > max_pixels:
        raise HTTPException(413, f'"{name}" is {w}x{h} ({w * h / 1e6:.0f} megapixels); the server accepts at most {max_pixels / 1e6:.0f}.')
    if getattr(img, "n_frames", 1) > 1:
        raise HTTPException(400, f'"{name}" is animated; only still images are accepted.')
    try:
        if decode:
            img.load()
        else:
            img.verify()  # walks the file's structure (PNG chunk CRCs, JPEG markers) without building the pixel array
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f'"{name}" is damaged: {e}') from e
    return img, fmt


def sanitize_header(value: Any, limit: int = 200) -> str:
    """Printable ASCII only, one line, bounded — backend-supplied text becomes an HTTP header, so no CR/LF can get through."""
    text = re.sub(r"[^\x20-\x7e]", "?", str(value))
    return text[:limit]


# ------------------------------------------------------------------------------------------ heavy-job slot
class Busy(HTTPException):
    def __init__(self) -> None:
        super().__init__(429, "The server is busy with another job (segmentation or generation). Wait for it to finish and try again.", headers={"Retry-After": "5"})


class HeavySlot:
    """At most one model run at a time. The slot is released by the WORKER THREAD when it really finishes, so a request that was
    abandoned (client gone, timeout) keeps the slot until the model stops using the GPU/RAM — a new request gets a 429 instead of
    starting a second model run on top of it. Release is by token and idempotent, so a late or doubled release can never free
    somebody else's slot."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._owner: object | None = None

    def try_acquire(self) -> object:
        with self._guard:
            if self._owner is not None:
                raise Busy()
            self._owner = token = object()
            return token

    def release(self, token: object) -> None:
        with self._guard:
            if self._owner is token:
                self._owner = None

    @property
    def busy(self) -> bool:
        with self._guard:
            return self._owner is not None


heavy_slot = HeavySlot()


# ------------------------------------------------------------------------------------------- ASGI guard
class BodyTooLarge(Exception):
    pass


def _loopback_hosts() -> set[str]:
    extra = {h.strip().lower() for h in os.environ.get("CF_ALLOWED_HOSTS", "").split(",") if h.strip()}
    return {"localhost", "127.0.0.1", "[::1]", "::1"} | extra


def _host_name(host_header: str) -> str:
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8765
        return host.split("]")[0] + "]"
    return host.split(":")[0]


class RequestGuard:
    """Pure ASGI middleware (it sees the raw stream, so limits apply before any multipart parsing):

    * Host must be loopback (or listed in CF_ALLOWED_HOSTS): stops DNS-rebinding pages from talking to the server under their own name.
    * A state-changing request that carries an Origin header must come from an allowed origin (a page on another site cannot make the
      server run a model). Requests without Origin (curl, scripts) are allowed: they already run as the user on this machine.
    * Request bodies are limited in total, by Content-Length up front and by counting the bytes actually streamed (chunked uploads).
    """

    def __init__(self, app: Callable[..., Awaitable[None]], allowed_origins: Iterable[str], limits: dict[str, int]) -> None:
        self.app = app
        self.origins = {o.rstrip("/").lower() for o in allowed_origins}
        self.limits = limits  # path -> max body bytes

    async def __call__(self, scope: dict[str, Any], receive: Callable[..., Awaitable[Any]], send: Callable[..., Awaitable[None]]) -> None:
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        method = scope.get("method", "GET")
        if _host_name(headers.get("host", "")) not in _loopback_hosts():
            return await self._reject(send, 421, "This server only answers requests addressed to localhost.")
        origin = headers.get("origin")
        if method not in ("GET", "HEAD", "OPTIONS") and origin is not None and origin.rstrip("/").lower() not in self.origins:
            return await self._reject(send, 403, "This origin is not allowed to use the local server. Set CF_ALLOWED_ORIGINS to add it.")
        limit = self.limits.get(scope.get("path", ""))
        if limit is None or method != "POST":
            return await self.app(scope, receive, send)
        declared = headers.get("content-length")
        if declared is not None:
            if not declared.isdigit():
                return await self._reject(send, 400, "Invalid Content-Length.")
            if int(declared) > limit:
                return await self._reject(send, 413, f"The request is larger than the {limit // MB} MB the server accepts for this endpoint.")
        seen = 0
        started = False

        async def counted_receive() -> Any:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise BodyTooLarge()
            return message

        async def tracked_send(message: Any) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counted_receive, tracked_send)
        except BodyTooLarge:
            if not started:
                await self._reject(send, 413, f"The request is larger than the {limit // MB} MB the server accepts for this endpoint.")

    @staticmethod
    async def _reject(send: Callable[..., Awaitable[None]], status: int, detail: str) -> None:
        import json

        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), (b"connection", b"close")]})
        await send({"type": "http.response.body", "body": body})
