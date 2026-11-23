"""TEST-ONLY generation backends. Synthetic gradients, never shipped, never offered in the app."""
import io

from PIL import Image


class _Fake:
    def status(self):
        return {"available": True, "detail": "test backend", "model": "test-gradient", "capabilities": {"references": True, "max_references": 4, "guides": ["pose"]}}

    def generate(self, request, files):
        w, h = request["output"]["width"], request["output"]["height"]
        img = Image.linear_gradient("L").resize((w, h)).convert("RGB")
        buf = io.BytesIO()
        img.save(buf, "PNG")
        refs = sum(1 for k in files if k.startswith("reference_"))
        guides = sorted(k[len("guide_"):] for k in files if k.startswith("guide_"))
        return {"image": buf.getvalue(), "mime": "image/png", "model": "test-gradient", "seed": request.get("seed"), "info": f"{refs} reference(s); guides: {', '.join(guides) or 'none'} (pose)"}


class _Failing(_Fake):
    def generate(self, request, files):
        raise RuntimeError("out of memory")


class _Empty(_Fake):
    def generate(self, request, files):
        return {"image": b""}


backend = _Fake()
failing_backend = _Failing()
empty_backend = _Empty()


# ---- extra TEST-ONLY backends for the hardening tests (still no model: they only misbehave on purpose) ----
import threading
import time

gate = threading.Event()  # tests open it to let `slow_backend` finish
entered = threading.Event()  # set once `slow_backend.generate` is running
calls: list[dict] = []  # every request a `counting_backend` actually received


def _png(size=(64, 64)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (10, 120, 200)).save(buf, "PNG")
    return buf.getvalue()


class _Slow(_Fake):
    def generate(self, request, files):
        entered.set()
        gate.wait(10)
        return super().generate(request, files)


class _Sleepy(_Fake):
    def generate(self, request, files):
        time.sleep(0.8)
        return super().generate(request, files)


class _Hang(_Fake):
    """TEST-ONLY: keeps the model 'busy' long enough for an end-to-end test to kill the server mid-generation."""

    def generate(self, request, files):
        time.sleep(120)
        return super().generate(request, files)


class _Exit(_Fake):
    def generate(self, request, files):
        raise SystemExit("backend called sys.exit")


class _Garbage(_Fake):
    def generate(self, request, files):
        return {"image": b"<html>definitely not an image</html>", "mime": "image/png"}


class _Html(_Fake):
    """Returns a real PNG but lies about everything else (mime, header text, seed)."""

    def generate(self, request, files):
        return {"image": _png(), "mime": "text/html", "model": "evil\r\nX-Evil: 1", "seed": "not-a-number", "info": "line1\r\nX-Evil2: 1é"}


class _Counting(_Fake):
    def generate(self, request, files):
        calls.append({"request": request, "files": {k: bytes(v) for k, v in files.items()}})
        return super().generate(request, files)


class _Huge(_Fake):
    def generate(self, request, files):
        return {"image": _png((2000, 2000)), "mime": "image/png"}


slow_backend = _Slow()
sleepy_backend = _Sleepy()
hang_backend = _Hang()
exit_backend = _Exit()
garbage_backend = _Garbage()
html_backend = _Html()
counting_backend = _Counting()
huge_backend = _Huge()
