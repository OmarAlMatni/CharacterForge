"""Protocol tests for /generate using FastAPI's TestClient and a TEST-ONLY fake backend.

The fake backend draws a synthetic gradient. It exists to verify request parsing, validation, headers and error mapping.
It is not a model, and it is not part of the shipped server.
"""
import io
import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import main  # noqa: E402


def png(color=(200, 30, 30), size=(64, 96)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def request_json(**over):
    base = {"protocol": 1, "output": {"width": 128, "height": 192}, "instructions": "", "appearance": {}, "seed": 7, "pose": {}, "references": [], "guides": {}}
    base.update(over)
    return json.dumps(base)


@pytest.fixture()
def client():
    return TestClient(main.app, base_url="http://127.0.0.1:8765")


def test_status_without_backend_names_the_missing_capability(client, monkeypatch):
    monkeypatch.delenv("CF_GENERATION_BACKEND", raising=False)
    j = client.get("/generate/status").json()
    assert j["available"] is False
    assert "CF_GENERATION_BACKEND" in j["detail"]
    assert j["protocol"] == 1


def test_generate_without_backend_is_503_and_returns_no_image(client, monkeypatch):
    monkeypatch.delenv("CF_GENERATION_BACKEND", raising=False)
    r = client.post("/generate", data={"request": request_json()}, files={"original": ("o.png", png(), "image/png")})
    assert r.status_code == 503
    assert "No generation backend" in r.json()["detail"]
    assert "image" not in r.headers.get("content-type", "")


def test_bad_backend_spec_is_reported(client, monkeypatch):
    monkeypatch.setenv("CF_GENERATION_BACKEND", "no_such_module_xyz:backend")
    j = client.get("/generate/status").json()
    assert j["available"] is False and "could not be loaded" in j["detail"]
    monkeypatch.setenv("CF_GENERATION_BACKEND", "nocolon")
    assert "module:object" in client.get("/generate/status").json()["detail"]


def test_backend_roundtrip_with_references_and_guides(client, monkeypatch):
    monkeypatch.setenv("CF_GENERATION_BACKEND", "fake_backend:backend")
    st = client.get("/generate/status").json()
    assert st["available"] is True and st["model"] == "test-gradient"
    files = {
        "original": ("o.png", png(), "image/png"),
        "reference_0": ("r.png", png((0, 255, 0)), "image/png"),
        "guide_pose": ("g.png", png((0, 0, 0)), "image/png"),
    }
    r = client.post("/generate", data={"request": request_json(references=[{"index": 0}])}, files=files)
    assert r.status_code == 200, r.text
    assert r.headers["x-cf-model"] == "test-gradient"
    assert r.headers["x-cf-seed"] == "7"
    assert "1 reference" in r.headers["x-cf-info"] and "pose" in r.headers["x-cf-info"]
    img = Image.open(io.BytesIO(r.content))
    assert img.size == (128, 192)


@pytest.mark.parametrize(
    "data,files,status,needle",
    [
        ({}, {"original": ("o.png", png(), "image/png")}, 400, "request"),
        ({"request": "{nope"}, {"original": ("o.png", png(), "image/png")}, 400, "valid JSON"),
        ({"request": request_json(protocol=9)}, {"original": ("o.png", png(), "image/png")}, 400, "protocol"),
        ({"request": request_json(output={"width": 10, "height": 10})}, {"original": ("o.png", png(), "image/png")}, 422, "64"),
        ({"request": request_json()}, {"guide_pose": ("g.png", png(), "image/png")}, 400, "original"),
        ({"request": request_json()}, {"original": ("o.png", b"not an image", "image/png")}, 400, "readable image"),
        ({"request": request_json()}, {"original": ("o.png", png(), "image/png"), "evil": ("x.png", png(), "image/png")}, 400, "Unexpected"),
        ({"request": request_json()}, {"original": ("o.png", png(), "image/png"), "guide_bogus": ("x.png", png(), "image/png")}, 400, "Unknown guide"),
    ],
)
def test_validation(client, monkeypatch, data, files, status, needle):
    monkeypatch.setenv("CF_GENERATION_BACKEND", "fake_backend:backend")
    r = client.post("/generate", data=data, files=files)
    assert r.status_code == status, r.text
    assert needle in r.json()["detail"]


def test_backend_failures_become_500_with_a_message(client, monkeypatch):
    monkeypatch.setenv("CF_GENERATION_BACKEND", "fake_backend:failing_backend")
    r = client.post("/generate", data={"request": request_json()}, files={"original": ("o.png", png(), "image/png")})
    assert r.status_code == 500 and "backend failed" in r.json()["detail"]


def test_backend_returning_nothing_is_an_error_not_an_image(client, monkeypatch):
    monkeypatch.setenv("CF_GENERATION_BACKEND", "fake_backend:empty_backend")
    r = client.post("/generate", data={"request": request_json()}, files={"original": ("o.png", png(), "image/png")})
    assert r.status_code == 502 and "returned no image" in r.json()["detail"]
