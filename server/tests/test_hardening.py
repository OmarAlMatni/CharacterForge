"""Hardening tests for the local server: request limits, origin/host guards, image validation, non-blocking and busy behaviour,
backend failure modes, segmentation resource limits. Everything here uses the TEST-ONLY backends in fake_backend.py; nothing is a model.
"""
import asyncio
import io
import json
import struct
import sys
import threading
import time
import zlib
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import fake_backend  # noqa: E402
import limits  # noqa: E402
import main  # noqa: E402

BASE = "http://127.0.0.1:8765"


def png(color=(200, 30, 30), size=(64, 96)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def fake_png(w: int, h: int) -> bytes:
    """A syntactically valid PNG header that CLAIMS w x h pixels but carries (almost) no data: a decompression-bomb stand-in."""
    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b"")


def req_json(**over) -> str:
    base = {"protocol": 1, "output": {"width": 128, "height": 192}, "instructions": "", "appearance": {}, "seed": 7, "pose": {}, "references": [], "guides": {}}
    base.update(over)
    return json.dumps(base)


def post_generate(client, files=None, **over):
    files = files if files is not None else {"original": ("o.png", png(), "image/png")}
    return client.post("/generate", data={"request": req_json(**over)}, files=files)


@pytest.fixture()
def client():
    return TestClient(main.app, base_url=BASE)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    fake_backend.gate.clear()
    fake_backend.entered.clear()
    fake_backend.calls.clear()
    yield
    fake_backend.gate.set()  # never leave a worker thread waiting
    time.sleep(0.05)


def use(monkeypatch, name: str) -> None:
    monkeypatch.setenv("CF_GENERATION_BACKEND", f"fake_backend:{name}")


# ----------------------------------------------------------------------------------------- request size limits
def test_content_length_over_the_limit_is_rejected_before_the_backend_runs(monkeypatch):
    use(monkeypatch, "counting_backend")
    c = TestClient(main.create_app(generate_limit=300), base_url=BASE)
    r = post_generate(c)  # the multipart body (JSON + PNG) is larger than 300 bytes
    assert r.status_code == 413 and "larger than" in r.json()["detail"]
    assert fake_backend.calls == []


def test_chunked_upload_without_content_length_is_cut_off(monkeypatch):
    use(monkeypatch, "counting_backend")
    c = TestClient(main.create_app(generate_limit=5000), base_url=BASE)

    def body():
        yield b'--b\r\nContent-Disposition: form-data; name="request"\r\n\r\n' + req_json().encode() + b"\r\n"
        for _ in range(50):
            yield b"x" * 1000  # 50 KB streamed with no Content-Length

    r = c.post("/generate", content=body(), headers={"content-type": "multipart/form-data; boundary=b"})
    assert r.status_code == 413
    assert fake_backend.calls == []


def test_many_files_each_under_the_per_file_limit_still_hit_the_aggregate_limit(monkeypatch):
    use(monkeypatch, "counting_backend")
    one = png(size=(300, 300))
    files = {"original": ("o.png", one, "image/png")} | {f"reference_{i}": (f"r{i}.png", one, "image/png") for i in range(6)}
    total = len(one) * 7
    c = TestClient(main.create_app(generate_limit=int(total * 0.8)), base_url=BASE)
    assert len(one) < int(total * 0.8)  # every part individually fits
    r = post_generate(c, files, references=[{"index": i} for i in range(6)])
    assert r.status_code == 413
    assert fake_backend.calls == []


def test_total_pixel_budget_across_images(monkeypatch):
    use(monkeypatch, "counting_backend")
    monkeypatch.setattr(limits, "MAX_TOTAL_PIXELS", 100 * 100 * 2)
    files = {"original": ("o.png", png(size=(100, 100)), "image/png"), "reference_0": ("r.png", png(size=(100, 100)), "image/png"), "reference_1": ("r.png", png(size=(100, 100)), "image/png")}
    r = post_generate(TestClient(main.app, base_url=BASE), files, references=[{"index": 0}, {"index": 1}])
    assert r.status_code == 413 and "megapixels" in r.json()["detail"]


def test_status_reports_the_limits_so_the_client_can_refuse_early(client, monkeypatch):
    monkeypatch.delenv("CF_GENERATION_BACKEND", raising=False)
    j = client.get("/generate/status").json()
    assert j["limits"]["max_request_bytes"] == limits.MAX_GENERATE_BYTES
    assert j["limits"]["max_file_bytes"] == limits.MAX_FILE_BYTES
    assert j["busy"] is False


# ------------------------------------------------------------------------------------------- origin and host
def test_cross_site_post_is_refused_and_never_reaches_the_backend(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    r = client.post("/generate", data={"request": req_json()}, files={"original": ("o.png", png(), "image/png")}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert fake_backend.calls == []


def test_allowed_origin_and_originless_clients_work(client, monkeypatch):
    use(monkeypatch, "backend")
    ok = client.post("/generate", data={"request": req_json()}, files={"original": ("o.png", png(), "image/png")}, headers={"Origin": "http://localhost:5173"})
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert post_generate(client).status_code == 200  # no Origin header: curl / scripts


def test_segment_is_protected_the_same_way(client):
    r = client.post("/segment", files={"file": ("a.png", png(), "image/png")}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_dns_rebinding_host_is_refused(monkeypatch):
    c = TestClient(main.app, base_url="http://attacker.example:8765")
    assert c.get("/health").status_code == 421
    assert c.post("/segment", files={"file": ("a.png", png(), "image/png")}).status_code == 421


def test_guard_errors_still_carry_cors_headers_so_the_app_can_read_them(client, monkeypatch):
    use(monkeypatch, "backend")
    c = TestClient(main.create_app(generate_limit=300), base_url=BASE)
    r = c.post("/generate", data={"request": req_json()}, files={"original": ("o.png", png(), "image/png")}, headers={"Origin": "http://localhost:5173"})
    assert r.status_code == 413 and r.headers["access-control-allow-origin"] == "http://localhost:5173"


# ------------------------------------------------------------------------------------------- image validation
def test_decompression_bomb_is_rejected_from_the_header_without_decoding(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    r = post_generate(client, {"original": ("o.png", fake_png(30000, 30000), "image/png")})
    assert r.status_code == 413
    r = post_generate(client, {"original": ("o.png", fake_png(6001, 6001), "image/png")})  # 36.01 MP, under the side limit
    assert r.status_code == 413 and "megapixels" in r.json()["detail"]
    assert fake_backend.calls == []


@pytest.mark.parametrize("name,make,status,needle", [
    ("gif", lambda: _fmt("GIF"), 400, "GIF"),
    ("tiff", lambda: _fmt("TIFF"), 400, "TIFF"),
    ("bmp", lambda: _fmt("BMP"), 400, "BMP"),
    ("empty", lambda: b"", 400, "empty"),
    ("truncated", lambda: png()[:60], 400, "damaged|readable"),
    ("text", lambda: b"GIF89a-not-really", 400, "readable"),
    ("animated webp", lambda: _animated_webp(), 400, "animated"),
])
def test_unsupported_or_malformed_images_are_rejected(client, monkeypatch, name, make, status, needle):
    import re

    use(monkeypatch, "counting_backend")
    r = post_generate(client, {"original": ("o.png", make(), "image/png")})
    assert r.status_code == status, r.text
    assert re.search(needle, r.json()["detail"]), r.json()
    assert fake_backend.calls == []


def _fmt(fmt: str) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (1, 2, 3)).save(buf, fmt)
    return buf.getvalue()


def _animated_webp() -> bytes:
    buf = io.BytesIO()
    frames = [Image.new("RGB", (16, 16), c) for c in ((255, 0, 0), (0, 255, 0))]
    frames[0].save(buf, "WEBP", save_all=True, append_images=frames[1:], duration=50)
    return buf.getvalue()


def test_valid_jpeg_and_webp_are_accepted(client, monkeypatch):
    use(monkeypatch, "backend")
    assert post_generate(client, {"original": ("o.jpg", _fmt("JPEG"), "image/jpeg")}).status_code == 200
    assert post_generate(client, {"original": ("o.webp", _fmt("WEBP"), "image/webp")}).status_code == 200


# ----------------------------------------------------------------------------------------- malformed requests
@pytest.mark.parametrize("over,status,needle", [
    ({"seed": -1}, 422, "seed"),
    ({"seed": 1.5}, 422, "seed"),
    ({"seed": True}, 422, "seed"),
    ({"seed": 2**40}, 422, "seed"),
    ({"output": {"width": True, "height": 128}}, 422, "output"),
    ({"output": {"width": 128.0, "height": 128}}, 422, "output"),
    ({"output": [1, 2]}, 422, "output"),
    ({"instructions": "x" * 8001}, 422, "instructions"),
    ({"instructions": 5}, 422, "instructions"),
    ({"pose": []}, 422, "pose"),
    ({"references": {}}, 422, "references"),
    ({"references": [1]}, 422, "references"),
])
def test_malformed_request_fields(client, monkeypatch, over, status, needle):
    use(monkeypatch, "counting_backend")
    r = post_generate(client, **over)
    assert r.status_code == status, r.text
    assert needle in r.json()["detail"]
    assert fake_backend.calls == []


def test_request_json_size_and_depth(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    r = client.post("/generate", data={"request": req_json(pose={"x": "y" * (limits.MAX_JSON_BYTES + 10)})}, files={"original": ("o.png", png(), "image/png")})
    assert r.status_code == 413
    deep = "[" * 100000 + "]" * 100000
    r = client.post("/generate", data={"request": deep}, files={"original": ("o.png", png(), "image/png")})
    assert r.status_code == 400  # RecursionError is a clean 400, not a crashed worker
    assert client.get("/health").status_code == 200


def test_reference_count_and_consistency(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    one = png(size=(8, 8))
    # list and files disagree
    r = post_generate(client, {"original": ("o.png", one, "image/png"), "reference_0": ("r", one, "image/png")}, references=[])
    assert r.status_code == 422 and "do not match" in r.json()["detail"]
    # a gap in the numbering
    r = post_generate(client, {"original": ("o.png", one, "image/png"), "reference_1": ("r", one, "image/png")}, references=[{"index": 0}])
    assert r.status_code == 422
    # leading zeros / absurd indexes are not valid part names
    r = post_generate(client, {"original": ("o.png", one, "image/png"), "reference_01": ("r", one, "image/png")}, references=[{"index": 0}])
    assert r.status_code == 400 and "Unexpected" in r.json()["detail"]
    # more than the supported number of references
    files = {"original": ("o.png", one, "image/png")} | {f"reference_{i}": ("r", one, "image/png") for i in range(17)}
    r = post_generate(client, files, references=[{"index": i} for i in range(17)])
    assert r.status_code == 422 and "At most 16" in r.json()["detail"]
    # an absurd number of parts is cut off by the multipart parser itself
    files = {"original": ("o.png", one, "image/png")} | {f"reference_{i}": ("r", one, "image/png") for i in range(60)}
    r = post_generate(client, files, references=[{"index": i} for i in range(60)])
    assert r.status_code in (400, 422)
    assert fake_backend.calls == []


def test_duplicate_parts_are_refused(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    r = client.post("/generate", data={"request": req_json()}, files=[("original", ("a.png", png(), "image/png")), ("original", ("b.png", png((0, 0, 255)), "image/png"))])
    assert r.status_code == 400 and "Duplicate" in r.json()["detail"]
    assert fake_backend.calls == []


def test_non_multipart_body_is_a_clean_error(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    r = client.post("/generate", content=b"{}", headers={"content-type": "application/json"})
    assert r.status_code == 400
    r = client.post("/generate", content=b"--b\r\ngarbage", headers={"content-type": "multipart/form-data; boundary=b"})
    assert r.status_code == 400
    assert client.get("/health").status_code == 200


def test_backend_spec_must_be_a_module_and_an_object_name(client, monkeypatch):
    for bad in ("../evil:backend", "os.path:join extra", "a b:c", "mod:", ":obj", "mod:obj;rm"):
        monkeypatch.setenv("CF_GENERATION_BACKEND", bad)
        d = client.get("/generate/status").json()
        assert d["available"] is False and "module:object" in d["detail"], bad


def test_the_backend_receives_exactly_the_uploaded_bytes(client, monkeypatch):
    use(monkeypatch, "counting_backend")
    original = png((12, 34, 56), (40, 40))
    assert post_generate(client, {"original": ("o.png", original, "image/png")}).status_code == 200
    assert fake_backend.calls[0]["files"]["original"] == original


# ---------------------------------------------------------------------------------- backend failure modes
def test_backend_that_exits_the_interpreter_is_a_500_and_the_server_lives(client, monkeypatch):
    use(monkeypatch, "exit_backend")
    r = post_generate(client)
    assert r.status_code == 500 and "backend failed" in r.json()["detail"]
    assert client.get("/health").status_code == 200
    use(monkeypatch, "backend")
    assert post_generate(client).status_code == 200  # the slot was released


def test_garbage_output_is_a_502_never_forwarded_as_an_image(client, monkeypatch):
    use(monkeypatch, "garbage_backend")
    r = post_generate(client)
    assert r.status_code == 502 and "not a usable image" in r.json()["detail"]
    assert "image" not in r.headers.get("content-type", "")


def test_oversized_output_is_refused(client, monkeypatch):
    use(monkeypatch, "huge_backend")
    monkeypatch.setattr(limits, "MAX_RESULT_BYTES", 100)
    r = post_generate(client)
    assert r.status_code == 502 and "larger than" in r.json()["detail"]


def test_backend_supplied_text_cannot_inject_headers_or_lie_about_the_type(client, monkeypatch):
    use(monkeypatch, "html_backend")
    r = post_generate(client)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"  # detected from the bytes, not taken from the backend
    assert "x-evil" not in r.headers and "x-evil2" not in r.headers
    assert "x-cf-seed" not in r.headers
    assert "\r" not in r.headers["x-cf-model"] and "\n" not in r.headers["x-cf-info"]


def test_status_check_that_raises_or_hangs_is_reported_not_propagated(client, monkeypatch):
    monkeypatch.setenv("CF_GENERATION_BACKEND", "fake_backend:failing_status_backend")
    fake_backend.failing_status_backend = type("S", (), {"status": lambda self: (_ for _ in ()).throw(RuntimeError("gpu on fire")), "generate": lambda self, r, f: {}})()
    d = client.get("/generate/status").json()
    assert d["available"] is False and "gpu on fire" in d["detail"]


# -------------------------------------------------------------------------- slow backends, busy, timeouts
@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_slow_generation_does_not_block_other_requests_and_a_second_job_gets_429(anyio_backend, monkeypatch):
    use(monkeypatch, "slow_backend")
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE) as c:
        files = {"original": ("o.png", png(), "image/png")}
        first = asyncio.create_task(c.post("/generate", data={"request": req_json()}, files=files))
        for _ in range(100):
            if fake_backend.entered.is_set():
                break
            await asyncio.sleep(0.02)
        assert fake_backend.entered.is_set(), "the slow backend never started"
        t0 = time.monotonic()
        health = await c.get("/health")
        status = await c.get("/generate/status")
        assert health.status_code == 200 and status.status_code == 200 and status.json()["busy"] is True
        assert time.monotonic() - t0 < 1.0, "other endpoints were blocked by the running generation"
        second = await c.post("/generate", data={"request": req_json()}, files=files)
        assert second.status_code == 429 and second.headers["retry-after"] == "5"
        seg = await c.post("/segment", files={"file": ("a.png", png(), "image/png")})
        assert seg.status_code == 429  # segmentation shares the one heavy-job slot
        fake_backend.gate.set()
        done = await first
        assert done.status_code == 200
        third = await c.post("/generate", data={"request": req_json()}, files=files)
        assert third.status_code == 200  # the slot was released when the backend returned


@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_timeout_is_a_504_and_the_slot_stays_taken_until_the_backend_really_ends(anyio_backend, monkeypatch):
    use(monkeypatch, "sleepy_backend")  # takes 0.8 s
    monkeypatch.setattr(limits, "GENERATION_TIMEOUT_S", 0.2)
    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url=BASE) as c:
        files = {"original": ("o.png", png(), "image/png")}
        r = await c.post("/generate", data={"request": req_json()}, files=files)
        assert r.status_code == 504 and "did not finish" in r.json()["detail"]
        again = await c.post("/generate", data={"request": req_json()}, files=files)
        assert again.status_code == 429  # still running in its thread: no second model run on top of it
        await asyncio.sleep(1.0)
        monkeypatch.setattr(limits, "GENERATION_TIMEOUT_S", 30)
        ok = await c.post("/generate", data={"request": req_json()}, files=files)
        assert ok.status_code == 200


def test_heavy_slot_release_is_idempotent_and_token_bound():
    slot = limits.HeavySlot()
    a = slot.try_acquire()
    with pytest.raises(limits.Busy):
        slot.try_acquire()
    slot.release(object())  # a stranger's token frees nothing
    assert slot.busy
    slot.release(a)
    slot.release(a)  # doubled release is harmless
    b = slot.try_acquire()
    slot.release(a)  # a late release by the first owner must not free the second owner's slot
    assert slot.busy
    slot.release(b)
    assert not slot.busy


# ------------------------------------------------------------------------------------------- segmentation
def test_segment_rejects_oversized_pixel_counts_without_decoding(client):
    r = client.post("/segment", files={"file": ("a.png", fake_png(8000, 8000), "image/png")})
    assert r.status_code == 413 and "megapixels" in r.json()["detail"]
    r = client.post("/segment", files={"file": ("a.png", fake_png(20000, 10), "image/png")})
    assert r.status_code == 413


def test_segment_rejects_non_images_and_bad_modes_and_releases_the_slot(client):
    assert client.post("/segment", files={"file": ("a.png", b"nope", "image/png")}).status_code == 400
    assert client.post("/segment", files={"file": ("a.gif", _fmt("GIF"), "image/gif")}).status_code == 400
    assert client.post("/segment", data={"mode": "weird"}, files={"file": ("a.png", png(), "image/png")}).status_code == 400
    assert not limits.heavy_slot.busy


def test_segment_model_crash_is_a_json_500_and_frees_the_slot(client, monkeypatch):
    def boom(img):
        raise RuntimeError("onnx session exploded")

    monkeypatch.setattr(main, "run_foreground", boom)
    r = client.post("/segment", files={"file": ("a.png", png(), "image/png")})
    assert r.status_code == 500 and "onnx session exploded" in r.json()["detail"]
    assert not limits.heavy_slot.busy
    monkeypatch.setattr(main, "run_foreground", lambda img: [])
    assert client.post("/segment", files={"file": ("a.png", png(), "image/png")}).status_code == 200


def test_segment_concurrent_jobs_get_429_and_do_not_block_health(monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow(img):
        started.set()
        release.wait(10)
        return []

    monkeypatch.setattr(main, "run_foreground", slow)
    c = TestClient(main.app, base_url=BASE)
    results = {}
    t = threading.Thread(target=lambda: results.setdefault("first", c.post("/segment", files={"file": ("a.png", png(), "image/png")})))
    t.start()
    try:
        assert started.wait(5)
        t0 = time.monotonic()
        assert TestClient(main.app, base_url=BASE).get("/health").status_code == 200
        assert time.monotonic() - t0 < 1.0
        r = TestClient(main.app, base_url=BASE).post("/segment", files={"file": ("a.png", png(), "image/png")})
        assert r.status_code == 429
    finally:
        release.set()
        t.join(10)
    assert results["first"].status_code == 200


def test_segment_body_limit(monkeypatch):
    c = TestClient(main.create_app(segment_limit=500), base_url=BASE)
    assert c.post("/segment", files={"file": ("a.png", png(size=(200, 200)), "image/png")}).status_code == 413


# -------------------------------------------------------------------------------------------- startup
def test_non_loopback_bind_is_refused_unless_explicitly_allowed(monkeypatch):
    monkeypatch.setenv("CF_HOST", "0.0.0.0")
    monkeypatch.delenv("CF_ALLOW_REMOTE_BIND", raising=False)
    with pytest.raises(SystemExit, match="no authentication"):
        main._bind_host()
    monkeypatch.setenv("CF_ALLOW_REMOTE_BIND", "1")
    assert main._bind_host() == "0.0.0.0"
    monkeypatch.setenv("CF_HOST", "127.0.0.1")
    monkeypatch.delenv("CF_ALLOW_REMOTE_BIND")
    assert main._bind_host() == "127.0.0.1"
