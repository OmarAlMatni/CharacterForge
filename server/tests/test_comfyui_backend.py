"""Tests for the ComfyUI backend module.

Two layers:

* **Pure unit tests** of the workflow handling (placeholder filling, structural wiring, error messages). These need no
  ComfyUI and no network, and they are what protects the mapping logic from regressions.
* **A live test** against a real ComfyUI instance, skipped unless CF_COMFYUI_TEST_URL is set. It is the only test that
  proves the HTTP path (upload -> /prompt -> /history -> /view) works; everything else is a fixture.

The live test deliberately uses a *passthrough* graph (load two images, scale, blend, save) rather than a diffusion
graph, because a diffusion graph needs a multi-gigabyte checkpoint that a test machine may not have. It proves the
plumbing, not the model — see docs/COMFYUI.md for what that distinction means.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backends import comfyui  # noqa: E402


def png(color=(200, 30, 30), size=(64, 96)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def workflow(**nodes) -> dict:
    return nodes


# ---------------------------------------------------------------------------------------------- placeholder filling


def test_fill_replaces_guide_tokens():
    wf = workflow(
        **{
            "1": {"class_type": "LoadImage", "inputs": {"image": "{{original}}"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "{{pose}}"}},
        }
    )
    out = comfyui._fill(wf, {"output": {"width": 8, "height": 8}}, {"original": "a.png", "guide_pose": "b.png"})
    assert out["1"]["inputs"]["image"] == "a.png"
    assert out["2"]["inputs"]["image"] == "b.png"


def test_fill_replaces_numeric_tokens():
    wf = workflow(
        **{
            "1": {
                "class_type": "EmptyLatentImage",
                "inputs": {"width": "{{width}}", "height": "{{height}}", "batch_size": 1},
            },
            "2": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}", "steps": "{{steps}}", "cfg": "{{cfg}}"}},
        }
    )
    out = comfyui._fill(wf, {"output": {"width": 768, "height": 1152}, "seed": 42}, {})
    assert out["1"]["inputs"]["width"] == 768
    assert out["1"]["inputs"]["height"] == 1152
    assert out["2"]["inputs"]["seed"] == 42
    assert out["2"]["inputs"]["steps"] == 28
    assert out["2"]["inputs"]["cfg"] == 5.0


def test_fill_generates_a_seed_when_the_request_has_none():
    wf = workflow(**{"1": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}"}}})
    out = comfyui._fill(wf, {"output": {"width": 8, "height": 8}, "seed": None}, {})
    assert isinstance(out["1"]["inputs"]["seed"], int)
    assert 0 <= out["1"]["inputs"]["seed"] < 2**32


def test_fill_replaces_prompt_tokens():
    wf = workflow(
        **{
            "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}"}},
            "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative}}"}},
        }
    )
    req = {"output": {"width": 8, "height": 8}, "appearance": {"hair": "long black hair"}, "instructions": "looking left"}
    out = comfyui._fill(wf, req, {})
    assert "long black hair" in out["1"]["inputs"]["text"]
    assert "looking left" in out["1"]["inputs"]["text"]
    assert "lowres" in out["2"]["inputs"]["text"]


def test_fill_replaces_reference_tokens_by_index():
    wf = workflow(
        **{
            "1": {"class_type": "LoadImage", "inputs": {"image": "{{reference_0}}"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "{{reference_1}}"}},
        }
    )
    out = comfyui._fill(wf, {"output": {"width": 8, "height": 8}}, {"reference_0": "r0.png", "reference_1": "r1.png"})
    assert out["1"]["inputs"]["image"] == "r0.png"
    assert out["2"]["inputs"]["image"] == "r1.png"


def test_fill_names_the_missing_guide_instead_of_failing_generically():
    wf = workflow(**{"1": {"class_type": "LoadImage", "inputs": {"image": "{{depth}}"}}})
    with pytest.raises(comfyui.ComfyError) as e:
        comfyui._fill(wf, {"output": {"width": 8, "height": 8}}, {"original": "a.png"})
    assert "{{depth}}" in str(e.value)
    assert "did not send" in str(e.value)


def test_fill_names_the_missing_reference():
    wf = workflow(**{"1": {"class_type": "LoadImage", "inputs": {"image": "{{reference_2}}"}}})
    with pytest.raises(comfyui.ComfyError) as e:
        comfyui._fill(wf, {"output": {"width": 8, "height": 8}}, {"reference_0": "a.png"})
    assert "{{reference_2}}" in str(e.value)


def test_fill_does_not_mutate_the_input_workflow():
    wf = workflow(**{"1": {"class_type": "LoadImage", "inputs": {"image": "{{original}}"}}})
    comfyui._fill(wf, {"output": {"width": 8, "height": 8}}, {"original": "a.png"})
    assert wf["1"]["inputs"]["image"] == "{{original}}"


def test_fill_leaves_unrelated_strings_alone():
    wf = workflow(**{"1": {"class_type": "KSampler", "inputs": {"sampler_name": "euler", "scheduler": "normal"}}})
    out = comfyui._fill(wf, {"output": {"width": 8, "height": 8}}, {})
    assert out["1"]["inputs"]["sampler_name"] == "euler"
    assert out["1"]["inputs"]["scheduler"] == "normal"


# ---------------------------------------------------------------------------------------------- structural wiring


def test_structural_wiring_assigns_images_in_graph_order():
    wf = workflow(
        **{
            "10": {"class_type": "LoadImage", "inputs": {"image": "example.png"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "example.png"}},
            "3": {"class_type": "SaveImage", "inputs": {"images": ["2", 0]}},
        }
    )
    out = comfyui._wire_structurally(wf, {"original": "o.png", "guide_pose": "p.png"})
    # numeric order: node 2 first, then node 10
    assert out["2"]["inputs"]["image"] == "o.png"
    assert out["10"]["inputs"]["image"] == "p.png"


def test_structural_wiring_puts_references_before_guides():
    wf = workflow(
        **{
            "1": {"class_type": "LoadImage", "inputs": {"image": "x"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "x"}},
            "3": {"class_type": "LoadImage", "inputs": {"image": "x"}},
        }
    )
    out = comfyui._wire_structurally(wf, {"original": "o.png", "reference_0": "r.png", "guide_pose": "p.png"})
    assert out["1"]["inputs"]["image"] == "o.png"
    assert out["2"]["inputs"]["image"] == "r.png"
    assert out["3"]["inputs"]["image"] == "p.png"


def test_structural_wiring_explains_an_empty_graph():
    with pytest.raises(comfyui.ComfyError) as e:
        comfyui._wire_structurally({"1": {"class_type": "KSampler", "inputs": {}}}, {"original": "o.png"})
    assert "LoadImage" in str(e.value)


def test_output_node_prefers_saveimage():
    wf = workflow(
        **{
            "1": {"class_type": "PreviewImage", "inputs": {}},
            "2": {"class_type": "SaveImage", "inputs": {}},
        }
    )
    assert comfyui._output_node(wf) == "2"


def test_output_node_explains_a_graph_with_no_output():
    with pytest.raises(comfyui.ComfyError) as e:
        comfyui._output_node({"1": {"class_type": "KSampler", "inputs": {}}})
    assert "SaveImage" in str(e.value)


# ---------------------------------------------------------------------------------------------- token discovery


def test_tokens_used_finds_every_kind():
    wf = workflow(
        **{
            "1": {"class_type": "LoadImage", "inputs": {"image": "{{original}}"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": "{{reference_3}}"}},
            "3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}"}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}"}},
        }
    )
    used = comfyui._tokens_used(wf)
    assert "{{original}}" in used
    assert "{{reference_3}}" in used
    assert "{{seed}}" in used
    assert "{{prompt}}" in used


def test_tokens_used_is_empty_for_a_plain_graph():
    assert comfyui._tokens_used({"1": {"class_type": "LoadImage", "inputs": {"image": "example.png"}}}) == set()


# ---------------------------------------------------------------------------------------------- configuration guards


def test_non_loopback_url_is_refused_by_status(monkeypatch):
    monkeypatch.setenv("CF_COMFYUI_URL", "http://192.168.1.50:8188")
    b = comfyui.ComfyUIBackend()
    st = b.status()
    assert st["available"] is False
    assert "loopback" in st["detail"]


def test_non_loopback_url_is_refused_by_generate(monkeypatch):
    monkeypatch.setenv("CF_COMFYUI_URL", "https://example.com")
    b = comfyui.ComfyUIBackend()
    with pytest.raises(comfyui.ComfyError) as e:
        b.generate({"output": {"width": 8, "height": 8}}, {})
    assert "loopback" in str(e.value)


def test_missing_workflow_is_reported_as_a_status_not_a_crash(monkeypatch):
    monkeypatch.setenv("CF_COMFYUI_URL", "http://127.0.0.1:9")  # nothing listens here
    monkeypatch.delenv("CF_COMFYUI_WORKFLOW", raising=False)
    st = comfyui.ComfyUIBackend().status()
    assert st["available"] is False
    assert "Cannot reach ComfyUI" in st["detail"]


def test_ui_format_workflow_is_rejected_with_an_explanation(tmp_path, monkeypatch):
    p = tmp_path / "ui.json"
    p.write_text(json.dumps({"nodes": [{"id": 1}], "links": []}))
    monkeypatch.setenv("CF_COMFYUI_WORKFLOW", str(p))
    b = comfyui.ComfyUIBackend()
    with pytest.raises(comfyui.ComfyError) as e:
        b._workflow()
    assert "API Format" in str(e.value)


def test_workflow_without_class_type_is_rejected(tmp_path, monkeypatch):
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"1": {"inputs": {}}}))
    monkeypatch.setenv("CF_COMFYUI_WORKFLOW", str(p))
    with pytest.raises(comfyui.ComfyError) as e:
        comfyui.ComfyUIBackend()._workflow()
    assert "class_type" in str(e.value)


def test_workflow_file_is_cached_until_it_changes(tmp_path, monkeypatch):
    p = tmp_path / "wf.json"
    p.write_text(json.dumps({"1": {"class_type": "SaveImage", "inputs": {}}}))
    monkeypatch.setenv("CF_COMFYUI_WORKFLOW", str(p))
    b = comfyui.ComfyUIBackend()
    first = b._workflow()
    assert b._workflow() is first  # same object: served from cache
    p.write_text(json.dumps({"1": {"class_type": "SaveImage", "inputs": {}}, "2": {"class_type": "LoadImage", "inputs": {}}}))
    os.utime(p, (0, 0))  # make the mtime change deterministic
    assert len(b._workflow()) == 2


def test_explain_turns_comfy_error_json_into_one_line():
    body = json.dumps({"error": {"type": "prompt_outputs_failed_validation", "message": "Prompt outputs failed validation", "details": "node 3"}})
    assert "Prompt outputs failed validation" in comfyui._explain(body)
    assert "node 3" in comfyui._explain(body)


def test_explain_handles_a_non_json_body():
    assert comfyui._explain("<html>502 Bad Gateway</html>") == "<html>502 Bad Gateway</html>"


# ---------------------------------------------------------------------------------------------- live ComfyUI


LIVE = os.environ.get("CF_COMFYUI_TEST_URL", "").strip()


@pytest.mark.skipif(not LIVE, reason="set CF_COMFYUI_TEST_URL to run against a real ComfyUI")
def test_live_status_reports_ready(monkeypatch):
    monkeypatch.setenv("CF_COMFYUI_URL", LIVE)
    monkeypatch.setenv("CF_COMFYUI_WORKFLOW", str(Path(__file__).resolve().parent.parent / "workflows" / "passthrough-test.json"))
    st = comfyui.ComfyUIBackend().status()
    assert st["available"] is True, st["detail"]
    assert "ComfyUI" in st["detail"]


@pytest.mark.skipif(not LIVE, reason="set CF_COMFYUI_TEST_URL to run against a real ComfyUI")
def test_live_generate_returns_a_real_image(monkeypatch):
    monkeypatch.setenv("CF_COMFYUI_URL", LIVE)
    monkeypatch.setenv("CF_COMFYUI_WORKFLOW", str(Path(__file__).resolve().parent.parent / "workflows" / "passthrough-test.json"))
    b = comfyui.ComfyUIBackend()
    out = b.generate(
        {"output": {"width": 128, "height": 192}, "seed": 3, "appearance": {}, "instructions": ""},
        {"original": png((200, 30, 30)), "guide_pose": png((10, 10, 10))},
    )
    im = Image.open(io.BytesIO(out["image"]))
    assert im.size == (128, 192)
    assert out["mime"] == "image/png"
    assert "ComfyUI" in out["info"]
