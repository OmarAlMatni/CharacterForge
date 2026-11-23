"""CharacterForge optional local server: layer segmentation + the pose-guided generation plug-in point (generation.py).

Runs on YOUR machine and only listens on localhost by default. The browser app sends one layer's
PNG here and receives proposed masks back. Nothing is stored and nothing leaves your computer.

Backends (each is optional and loaded lazily):
  foreground  rembg with the "isnet-anime" model  -> one mask: the character vs. background
  parts       Segment Anything automatic masks     -> several region masks (needs a checkpoint)

Run:   python -m uvicorn main:app --host 127.0.0.1 --port 8765   (from the /server folder)
"""
from __future__ import annotations

import base64
import importlib.util
import io
import os
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

import limits
from generation import router as generation_router
from limits import RequestGuard, heavy_slot, inspect_image

VERSION = "0.2.0"
MAX_UPLOAD_BYTES = limits.MAX_FILE_BYTES
MAX_SIDE = 8192
SAM_WORK_SIDE = 1024  # SAM runs on a downscaled copy; masks are scaled back up

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "CF_ALLOWED_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173",
    ).split(",")
    if o.strip()
]
SAM_CHECKPOINT = os.environ.get("CF_SAM_CHECKPOINT", "")
SAM_MODEL_TYPE = os.environ.get("CF_SAM_MODEL_TYPE", "vit_b")
REMBG_MODEL = os.environ.get("CF_REMBG_MODEL", "isnet-anime")

router = APIRouter()


def create_app(generate_limit: int = limits.MAX_GENERATE_BYTES, segment_limit: int = limits.MAX_SEGMENT_BYTES) -> FastAPI:
    application = FastAPI(title="CharacterForge segmentation server", version=VERSION)
    # Order matters: the LAST middleware added is the outermost. CORS must wrap the guard so that the guard's 403/413/421 answers still
    # carry the CORS headers and the browser app can read the reason instead of seeing an opaque network error.
    application.add_middleware(
        RequestGuard,
        allowed_origins=ALLOWED_ORIGINS,
        limits={"/generate": generate_limit, "/segment": segment_limit},
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type"],
        expose_headers=["X-CF-Model", "X-CF-Seed", "X-CF-Info", "Retry-After"],
    )
    application.include_router(generation_router)
    application.include_router(router)
    return application


_rembg_session: Any = None
_sam_generator: Any = None


def _has(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def backend_status() -> dict[str, dict[str, Any]]:
    fg_ok = _has("rembg")
    sam_pkgs = _has("segment_anything") and _has("torch")
    sam_ok = sam_pkgs and bool(SAM_CHECKPOINT) and Path(SAM_CHECKPOINT).is_file()
    sam_detail = None
    if not sam_pkgs:
        sam_detail = "install torch and segment-anything"
    elif not SAM_CHECKPOINT:
        sam_detail = "set CF_SAM_CHECKPOINT to a SAM checkpoint file"
    elif not Path(SAM_CHECKPOINT).is_file():
        sam_detail = f"checkpoint not found: {SAM_CHECKPOINT}"
    return {
        "foreground": {
            "available": fg_ok,
            "model": REMBG_MODEL,
            "license": "rembg: MIT. Check the license of the downloaded model before redistributing results or weights.",
            "detail": None if fg_ok else 'install with: pip install "rembg[cpu]"',
        },
        "parts": {
            "available": sam_ok,
            "model": f"Segment Anything {SAM_MODEL_TYPE}",
            "license": "segment-anything code and weights: Apache-2.0. Verify the license of the exact checkpoint you download.",
            "detail": sam_detail,
        },
    }


@router.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", "version": VERSION, "backends": backend_status()}


def _load_image(data: bytes) -> Image.Image:
    """Validate (header, size, pixel budget, format) BEFORE decoding, then decode. /segment allocates several full-size copies of the
    image, so its pixel budget is tighter than the one for /generate."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"The image is too large for the server ({MAX_UPLOAD_BYTES // limits.MB} MB limit).")
    img, _ = inspect_image("the uploaded file", data, max_bytes=MAX_UPLOAD_BYTES, max_pixels=limits.MAX_SEGMENT_PIXELS)
    if max(img.size) > MAX_SIDE:
        raise HTTPException(413, f"The image is larger than {MAX_SIDE}px on one side.")
    try:
        # verify() leaves the file unusable, so reopen to decode
        img = Image.open(io.BytesIO(data))
        img.load()
        return img.convert("RGBA")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"The uploaded file is not a readable image: {e}") from e


def _on_white(img: Image.Image) -> Image.Image:
    bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
    bg.alpha_composite(img)
    return bg.convert("RGB")


def _mask_png(mask: np.ndarray) -> bytes:
    """mask: HxW float/bool/uint8 -> RGBA PNG whose alpha channel is the mask."""
    a = mask.astype(np.uint8) if mask.dtype == np.uint8 else (np.clip(mask, 0, 1) * 255).astype(np.uint8)
    rgba = np.zeros((*a.shape, 4), dtype=np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = a
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, format="PNG")
    return buf.getvalue()


def _proposal(idx: int, label: str, mask: np.ndarray, score: float | None) -> dict[str, Any]:
    ys, xs = np.nonzero(mask > 0)
    bbox = None if len(xs) == 0 else [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    return {
        "id": f"m{idx}",
        "label": label,
        "score": score,
        "bbox": bbox,
        "mask_png_base64": base64.b64encode(_mask_png(mask)).decode("ascii"),
    }


def run_foreground(img: Image.Image) -> list[dict[str, Any]]:
    global _rembg_session
    if not backend_status()["foreground"]["available"]:
        raise HTTPException(503, 'The "Character vs background" backend is not installed. Run: pip install "rembg[cpu]"')
    from rembg import new_session, remove  # type: ignore[import-not-found]

    if _rembg_session is None:
        _rembg_session = new_session(REMBG_MODEL)  # downloads the model on first use
    out = remove(_on_white(img), session=_rembg_session, only_mask=True)
    mask = np.array(out.convert("L"), dtype=np.uint8)
    mask = np.minimum(mask, np.array(img.getchannel("A"), dtype=np.uint8))  # never outside the original alpha
    return [_proposal(0, "Character", mask, None)]


def run_parts(img: Image.Image, max_masks: int) -> list[dict[str, Any]]:
    global _sam_generator
    status = backend_status()["parts"]
    if not status["available"]:
        raise HTTPException(503, f'The "Split into parts" backend is not ready: {status["detail"]}')
    from segment_anything import SamAutomaticMaskGenerator, sam_model_registry  # type: ignore[import-not-found]

    if _sam_generator is None:
        sam = sam_model_registry[SAM_MODEL_TYPE](checkpoint=SAM_CHECKPOINT)
        try:
            import torch  # type: ignore[import-not-found]

            if torch.cuda.is_available():
                sam.to("cuda")
        except Exception:  # noqa: BLE001
            pass
        _sam_generator = SamAutomaticMaskGenerator(sam, points_per_side=24, pred_iou_thresh=0.86, stability_score_thresh=0.9)

    w, h = img.size
    k = min(1.0, SAM_WORK_SIDE / max(w, h))
    work = _on_white(img)
    if k < 1.0:
        work = work.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    alpha = np.array(img.getchannel("A"), dtype=np.uint8)
    found = _sam_generator.generate(np.array(work))
    found.sort(key=lambda m: m["area"], reverse=True)
    out: list[dict[str, Any]] = []
    for m in found:
        if len(out) >= max_masks:
            break
        seg = (m["segmentation"].astype(np.uint8)) * 255
        big = np.array(Image.fromarray(seg, "L").resize((w, h), Image.BILINEAR)) > 127
        big = big & (alpha > 8)
        if big.mean() < 0.002:
            continue  # ignore specks
        out.append(_proposal(len(out), f"Part {len(out) + 1}", big.astype(np.uint8) * 255, float(m.get("predicted_iou", 0.0))))
    return out


@router.post("/segment")
def segment(file: UploadFile = File(...), mode: str = Form("foreground"), max_masks: int = Form(8)) -> dict[str, Any]:
    """Runs in FastAPI's worker pool (a plain `def`), so it never blocks the event loop; the heavy-job slot keeps it to one model run
    at a time, shared with /generate."""
    if mode not in ("foreground", "parts"):
        raise HTTPException(400, 'mode must be "foreground" or "parts".')
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    max_masks = max(1, min(30, max_masks))
    token = heavy_slot.try_acquire()  # 429 when another model run is in progress
    try:
        img = _load_image(data)
        del data
        proposals = run_foreground(img) if mode == "foreground" else run_parts(img, max_masks)
    except HTTPException:
        raise
    except MemoryError as e:
        raise HTTPException(507, "The server ran out of memory while segmenting. Use a smaller image.") from e
    except Exception as e:  # noqa: BLE001 - a crashing model must not turn into an opaque 500 page
        raise HTTPException(500, f"The segmentation model failed: {limits.sanitize_header(f'{type(e).__name__}: {e}', 400)}") from e
    finally:
        heavy_slot.release(token)
    return {"width": img.width, "height": img.height, "proposals": proposals}


app = create_app()


def _bind_host() -> str:
    host = os.environ.get("CF_HOST", "127.0.0.1").strip() or "127.0.0.1"
    if host not in ("127.0.0.1", "localhost", "::1") and os.environ.get("CF_ALLOW_REMOTE_BIND") != "1":
        raise SystemExit(
            f'Refusing to listen on "{host}": this server has no authentication, so anyone who can reach it could run your models and read results.\n'
            "Use 127.0.0.1 (the default). If you really want to expose it, set CF_ALLOW_REMOTE_BIND=1 and put it behind your own authenticated proxy."
        )
    return host


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=_bind_host(), port=int(os.environ.get("CF_PORT", "8765")))
