"""ComfyUI generation backend for CharacterForge.

Talks to a ComfyUI instance running on this computer over loopback HTTP, and maps the CharacterForge guide pack
(original artwork, approved references, OpenPose pose map, depth, silhouette, clay mannequin, textured render) onto a
ComfyUI workflow that the artist supplies.

Why ComfyUI: it already solves the parts that would otherwise take months — model files, VRAM offloading, GGUF
quantisation, ControlNet/IP-Adapter loading, and a node graph the artist can edit. CharacterForge then only has to
answer one question: *which node input does each guide go into?*

    CF_GENERATION_BACKEND=backends.comfyui:backend

Configuration (all optional, all environment variables):

    CF_COMFYUI_URL          http://127.0.0.1:8188   where ComfyUI listens
    CF_COMFYUI_WORKFLOW     path to a workflow JSON  the graph to run (API format, see below)
    CF_COMFYUI_TIMEOUT      seconds to wait for one image (default 900)
    CF_COMFYUI_POLL         seconds between history polls (default 1.0)

The workflow file is ComfyUI's **API format** (the "Save (API Format)" button, or `GET /object_info` shapes): a JSON
object mapping node id -> {"class_type": ..., "inputs": {...}}. CharacterForge does not ship a workflow, because the
right graph depends on which checkpoint and ControlNet the artist installed. Instead the backend discovers the graph
and fills it in, using two conventions:

1. **Placeholder strings.** Any string input whose value is one of the tokens below is replaced with the uploaded
   image's filename in ComfyUI's input directory:

       {{original}}      the artist's original full-body drawing
       {{reference_0}}   approved reference N (0-based, in the order the app sent them)
       {{pose}}          OpenPose-style pose map
       {{depth}}         depth map
       {{silhouette}}    silhouette
       {{mannequin}}     grey clay model
       {{textured}}      the artwork projected on the posed model

   and any numeric input whose value is one of these is replaced with the request's value:

       {{width}} {{height}} {{seed}} {{steps}} {{cfg}} {{denoise}}

2. **Prompt text.** A string input containing `{{prompt}}` gets the assembled prompt (see `_prompt`), and
   `{{negative}}` gets the negative prompt.

If the workflow has no placeholders at all, the backend falls back to *structural* wiring: it finds the `LoadImage`
nodes in graph order and assigns original, then references, then pose, then depth, then silhouette to them. That makes
a plain "Load Image -> ControlNet -> KSampler" graph work without editing, which is what most artists will have.

`status()` reports exactly what is missing — ComfyUI not reachable, no workflow configured, workflow file unreadable,
a placeholder that no node can receive, no checkpoint installed — instead of failing generically at generate time.

SECURITY: this module only ever connects to a loopback address, and it refuses a non-loopback CF_COMFYUI_URL. It sends
the artist's artwork to that address and nowhere else. See docs/SECURITY.md.
"""
from __future__ import annotations

import copy
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

# ---------------------------------------------------------------------------------------------- configuration

DEFAULT_URL = "http://127.0.0.1:8188"
DEFAULT_TIMEOUT = 900.0
DEFAULT_POLL = 1.0

#: Guide tokens a workflow may use, mapped to the multipart part name the server hands us.
GUIDE_TOKENS = {
    "{{original}}": "original",
    "{{pose}}": "guide_pose",
    "{{depth}}": "guide_depth",
    "{{silhouette}}": "guide_silhouette",
    "{{mannequin}}": "guide_mannequin",
    "{{textured}}": "guide_textured",
}
REFERENCE_TOKEN = re.compile(r"^\{\{reference_(\d+)\}\}$")
NUMERIC_TOKENS = {"{{width}}", "{{height}}", "{{seed}}", "{{steps}}", "{{cfg}}", "{{denoise}}"}
TEXT_TOKENS = ("{{prompt}}", "{{negative}}")

#: Guides this backend can actually consume, in the order the structural fallback assigns them.
STRUCTURAL_ORDER = ["original", "guide_pose", "guide_depth", "guide_silhouette", "guide_mannequin", "guide_textured"]

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _env_float(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, "").strip() or default))
    except ValueError:
        return default


def _is_loopback(url: str) -> bool:
    try:
        host = urllib.parse.urlsplit(url).hostname or ""
    except ValueError:
        return False
    return host.lower() in LOOPBACK_HOSTS


class ComfyError(Exception):
    """A failure with a message meant for the artist, not a stack trace."""


# ---------------------------------------------------------------------------------------------- HTTP plumbing


class _Comfy:
    """Minimal ComfyUI HTTP client. No third-party dependency: the server already has urllib."""

    def __init__(self, base: str, timeout: float) -> None:
        self.base = base.rstrip("/")
        self.timeout = timeout

    def _open(self, path: str, data: bytes | None = None, headers: dict[str, str] | None = None, timeout: float | None = None):
        req = urllib.request.Request(self.base + path, data=data, headers=headers or {})
        return urllib.request.urlopen(req, timeout=timeout or self.timeout)

    def get_json(self, path: str, timeout: float | None = None) -> Any:
        with self._open(path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def post_json(self, path: str, payload: Any, timeout: float | None = None) -> Any:
        body = json.dumps(payload).encode("utf-8")
        with self._open(path, body, {"Content-Type": "application/json"}, timeout) as r:
            return json.loads(r.read().decode("utf-8"))

    def upload_image(self, name: str, data: bytes, mime: str = "image/png") -> str:
        """POST /upload/image as multipart/form-data. Returns the filename ComfyUI stored it under."""
        boundary = "----CharacterForge" + uuid.uuid4().hex
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "png")
        filename = f"{name}.{ext}"
        parts: list[bytes] = []
        for field, value in (("type", "input"), ("overwrite", "true")):
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n".encode()
            )
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n".encode()
        )
        parts.append(data)
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        body = b"".join(parts)
        with self._open("/upload/image", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}) as r:
            j = json.loads(r.read().decode("utf-8"))
        # ComfyUI answers {"name": ..., "subfolder": ..., "type": "input"}; LoadImage wants "subfolder/name" when nested.
        sub = j.get("subfolder") or ""
        return f"{sub}/{j['name']}" if sub else j["name"]

    def view(self, filename: str, subfolder: str = "", folder_type: str = "output") -> bytes:
        q = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": folder_type})
        with self._open(f"/view?{q}") as r:
            return r.read()


# ---------------------------------------------------------------------------------------------- workflow handling


def _iter_inputs(workflow: dict[str, Any]):
    """Yield (node_id, node, input_name, value) for every scalar input of every node."""
    for node_id, node in workflow.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for name, value in inputs.items():
            yield node_id, node, name, value


def _load_image_nodes(workflow: dict[str, Any]) -> list[str]:
    """Node ids of LoadImage nodes, in a stable order (numeric id when possible, else insertion order)."""
    ids = [nid for nid, node in workflow.items() if isinstance(node, dict) and node.get("class_type") == "LoadImage"]

    def key(nid: str):
        return (0, int(nid)) if nid.isdigit() else (1, nid)

    return sorted(ids, key=key)


def _tokens_used(workflow: dict[str, Any]) -> set[str]:
    used: set[str] = set()
    for _, _, _, value in _iter_inputs(workflow):
        if isinstance(value, str):
            if value in GUIDE_TOKENS or value in NUMERIC_TOKENS or value in TEXT_TOKENS:
                used.add(value)
            elif REFERENCE_TOKEN.match(value):
                used.add(value)
    return used


def _prompt(request: dict[str, Any]) -> tuple[str, str]:
    """Assemble a positive/negative prompt from the request. The reference images carry identity; text is a hint."""
    app = request.get("appearance") or {}
    bits: list[str] = []
    for key in ("hair", "eyes", "clothing", "accessories"):
        v = app.get(key)
        if isinstance(v, str) and v.strip():
            bits.append(v.strip())
    notes = app.get("notes")
    if isinstance(notes, str) and notes.strip():
        bits.append(notes.strip())
    ins = request.get("instructions")
    if isinstance(ins, str) and ins.strip():
        bits.append(ins.strip())
    positive = ", ".join(bits) if bits else "1girl, solo, full body, standing, anime style, clean lineart"
    negative = "lowres, bad anatomy, bad hands, extra digits, cropped, worst quality, watermark, signature, text"
    return positive, negative


def _fill(workflow: dict[str, Any], request: dict[str, Any], uploaded: dict[str, str]) -> dict[str, Any]:
    """Return a copy of `workflow` with every placeholder replaced. Raises ComfyError if a token cannot be satisfied."""
    out = copy.deepcopy(workflow)
    positive, negative = _prompt(request)
    seed = request.get("seed")
    if not isinstance(seed, int):
        seed = int.from_bytes(os.urandom(4), "big") % (2**32)
    numeric = {
        "{{width}}": int((request.get("output") or {}).get("width") or 768),
        "{{height}}": int((request.get("output") or {}).get("height") or 1152),
        "{{seed}}": seed,
        "{{steps}}": 28,
        "{{cfg}}": 5.0,
        "{{denoise}}": 1.0,
    }
    missing: list[str] = []
    for _, _, name, value in _iter_inputs(out):
        if not isinstance(value, str):
            continue
        if value in GUIDE_TOKENS:
            part = GUIDE_TOKENS[value]
            if part not in uploaded:
                missing.append(f"{value} (the app did not send that guide)")
            else:
                _set(out, name, value, uploaded[part])
        elif REFERENCE_TOKEN.match(value):
            idx = int(REFERENCE_TOKEN.match(value).group(1))  # type: ignore[union-attr]
            part = f"reference_{idx}"
            if part not in uploaded:
                missing.append(f"{value} (only {sum(1 for k in uploaded if k.startswith('reference_'))} references were sent)")
            else:
                _set(out, name, value, uploaded[part])
        elif value in NUMERIC_TOKENS:
            _set(out, name, value, numeric[value])
        elif value == "{{prompt}}":
            _set(out, name, value, positive)
        elif value == "{{negative}}":
            _set(out, name, value, negative)
    if missing:
        raise ComfyError(
            "The ComfyUI workflow asks for inputs this request cannot supply: " + "; ".join(sorted(set(missing))) + "."
        )
    return out


def _set(workflow: dict[str, Any], input_name: str, token: str, replacement: Any) -> None:
    """Replace `token` wherever it appears as the value of `input_name` (the caller already matched the value)."""
    for _, node, name, value in _iter_inputs(workflow):
        if name == input_name and value == token:
            node["inputs"][name] = replacement


def _wire_structurally(workflow: dict[str, Any], uploaded: dict[str, str]) -> dict[str, Any]:
    """No placeholders: assign the uploaded images to the LoadImage nodes in graph order."""
    out = copy.deepcopy(workflow)
    nodes = _load_image_nodes(out)
    if not nodes:
        raise ComfyError(
            "The ComfyUI workflow has no placeholders and no LoadImage node, so there is nowhere to put the artwork. "
            "Add a Load Image node, or use {{original}} / {{pose}} placeholders (see docs/COMFYUI.md)."
        )
    # original first, then references in order, then the guides that were actually sent
    order = ["original"] + sorted((k for k in uploaded if k.startswith("reference_")), key=lambda k: int(k.split("_")[1]))
    order += [g for g in STRUCTURAL_ORDER if g.startswith("guide_") and g in uploaded]
    for node_id, part in zip(nodes, order):
        out[node_id]["inputs"]["image"] = uploaded[part]
    return out


def _output_node(workflow: dict[str, Any]) -> str:
    """The node whose images we read back: SaveImage if present, else PreviewImage."""
    for want in ("SaveImage", "PreviewImage"):
        for nid, node in workflow.items():
            if isinstance(node, dict) and node.get("class_type") == want:
                return nid
    raise ComfyError("The ComfyUI workflow has no SaveImage or PreviewImage node, so there is no image to return.")


# ---------------------------------------------------------------------------------------------- the backend


class ComfyUIBackend:
    """CharacterForge generation backend that runs a ComfyUI workflow."""

    def __init__(self) -> None:
        self.url = (os.environ.get("CF_COMFYUI_URL", "").strip() or DEFAULT_URL).rstrip("/")
        self.workflow_path = os.environ.get("CF_COMFYUI_WORKFLOW", "").strip()
        self.timeout = _env_float("CF_COMFYUI_TIMEOUT", DEFAULT_TIMEOUT)
        self.poll = _env_float("CF_COMFYUI_POLL", DEFAULT_POLL)
        self._workflow_cache: tuple[str, float, dict[str, Any]] | None = None

    # -- workflow file ---------------------------------------------------------------------------------

    def _workflow(self) -> dict[str, Any]:
        if not self.workflow_path:
            raise ComfyError(
                "No ComfyUI workflow is configured. Set CF_COMFYUI_WORKFLOW to a workflow JSON file "
                "(ComfyUI's \"Save (API Format)\"), or use the one in docs/COMFYUI.md."
            )
        path = os.path.abspath(os.path.expanduser(self.workflow_path))
        try:
            mtime = os.path.getmtime(path)
        except OSError as e:
            raise ComfyError(f"The ComfyUI workflow file could not be read: {path} ({e.strerror}).") from e
        if self._workflow_cache and self._workflow_cache[0] == path and self._workflow_cache[1] == mtime:
            return self._workflow_cache[2]
        try:
            with open(path, "r", encoding="utf-8") as f:
                wf = json.load(f)
        except (OSError, ValueError) as e:
            raise ComfyError(f"The ComfyUI workflow file is not valid JSON: {path} ({e}).") from e
        if not isinstance(wf, dict) or not wf:
            raise ComfyError(f"The ComfyUI workflow file is empty or not an object: {path}.")
        # A UI-format export wraps the graph in {"nodes": [...], "links": [...]}; that is not runnable through /prompt.
        if "nodes" in wf and isinstance(wf.get("nodes"), list):
            raise ComfyError(
                "That workflow is in ComfyUI's UI format. Re-export it with \"Save (API Format)\" — the API format is a "
                "flat object of node id -> {class_type, inputs}."
            )
        for nid, node in wf.items():
            if not isinstance(node, dict) or "class_type" not in node:
                raise ComfyError(f'Node "{nid}" in the workflow has no "class_type"; this is not an API-format workflow.')
        self._workflow_cache = (path, mtime, wf)
        return wf

    # -- status ----------------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """Report exactly what is missing. Never raises: a broken setup is a status, not a crash."""
        caps = {"references": True, "max_references": 8, "guides": ["pose", "depth", "silhouette", "mannequin", "textured"]}
        if not _is_loopback(self.url):
            return {
                "available": False,
                "detail": f"CF_COMFYUI_URL must be a loopback address (127.0.0.1 / localhost); got {self.url!r}. "
                "CharacterForge does not send artwork to another machine.",
                "model": None,
                "capabilities": caps,
            }
        client = _Comfy(self.url, 10.0)
        try:
            stats = client.get_json("/system_stats", timeout=8.0)
        except urllib.error.HTTPError as e:
            return {"available": False, "detail": f"ComfyUI at {self.url} answered HTTP {e.code}.", "model": None, "capabilities": caps}
        except (urllib.error.URLError, OSError, ValueError) as e:
            return {
                "available": False,
                "detail": f"Cannot reach ComfyUI at {self.url} ({getattr(e, 'reason', e)}). Start it, or set CF_COMFYUI_URL.",
                "model": None,
                "capabilities": caps,
            }
        sysinfo = (stats or {}).get("system") or {}
        version = sysinfo.get("comfyui_version") or "unknown"
        try:
            wf = self._workflow()
        except ComfyError as e:
            return {"available": False, "detail": str(e), "model": None, "capabilities": caps}
        try:
            _output_node(wf)
        except ComfyError as e:
            return {"available": False, "detail": str(e), "model": None, "capabilities": caps}
        # Which guides can this graph actually receive?
        used = _tokens_used(wf)
        if used:
            guides = [k for k, part in GUIDE_TOKENS.items() if k in used and part.startswith("guide_")]
            guides = [g.strip("{}") for g in guides]
            refs = any(REFERENCE_TOKEN.match(t) for t in used)
        else:
            guides = ["pose", "depth", "silhouette", "mannequin", "textured"]
            refs = True
        caps["guides"] = guides or ["pose"]
        caps["references"] = refs
        # Is there a checkpoint installed? A graph that loads one by name will fail at run time without it.
        model = None
        try:
            info = client.get_json("/object_info/CheckpointLoaderSimple", timeout=8.0)
            names = (((info or {}).get("CheckpointLoaderSimple") or {}).get("input") or {}).get("required", {}).get("ckpt_name", [[]])
            available = names[0] if names and isinstance(names[0], list) else []
            wanted = [
                node["inputs"].get("ckpt_name")
                for node in wf.values()
                if isinstance(node, dict) and node.get("class_type") == "CheckpointLoaderSimple"
            ]
            wanted = [w for w in wanted if isinstance(w, str)]
            if wanted:
                model = wanted[0]
                if available and model not in available:
                    return {
                        "available": False,
                        "detail": f"The workflow loads checkpoint {model!r}, but ComfyUI has none by that name. "
                        f"Installed: {', '.join(available[:6]) or 'none'}. Put the file in ComfyUI/models/checkpoints.",
                        "model": model,
                        "capabilities": caps,
                    }
            elif available:
                model = available[0]
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError):
            pass  # a graph without a checkpoint loader (e.g. an API node) is fine
        ram = sysinfo.get("ram_total")
        detail = f"ComfyUI {version} at {self.url} is ready."
        if isinstance(ram, int) and ram < 6 * 1024**3:
            detail += f" Note: this machine reports {ram / 1024**3:.1f} GB RAM, which is tight for a full SDXL graph."
        return {"available": True, "detail": detail, "model": model, "capabilities": caps}

    # -- generate --------------------------------------------------------------------------------------

    def generate(self, request: dict[str, Any], files: dict[str, bytes]) -> dict[str, Any]:
        if not _is_loopback(self.url):
            raise ComfyError("CF_COMFYUI_URL must be a loopback address; refusing to send artwork elsewhere.")
        client = _Comfy(self.url, 60.0)
        wf = self._workflow()
        # 1. upload every image the request carries, under a per-run prefix so concurrent runs cannot collide
        prefix = "cf_" + uuid.uuid4().hex[:12]
        uploaded: dict[str, str] = {}
        for part, data in files.items():
            if not data:
                continue
            mime = "image/png"
            if data[:2] == b"\xff\xd8":
                mime = "image/jpeg"
            elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
                mime = "image/webp"
            uploaded[part] = client.upload_image(f"{prefix}_{part}", data, mime)
        # 2. fill the graph
        if _tokens_used(wf):
            filled = _fill(wf, request, uploaded)
        else:
            filled = _wire_structurally(wf, uploaded)
        out_node = _output_node(filled)
        # 3. queue it
        try:
            queued = client.post_json("/prompt", {"prompt": filled, "client_id": prefix})
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:1200]
            raise ComfyError(f"ComfyUI rejected the workflow (HTTP {e.code}): {_explain(body)}") from e
        prompt_id = (queued or {}).get("prompt_id")
        if not prompt_id:
            raise ComfyError(f"ComfyUI did not return a prompt id: {str(queued)[:300]}")
        # 4. wait for it
        deadline = time.monotonic() + self.timeout
        images: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            try:
                hist = client.get_json(f"/history/{prompt_id}", timeout=30.0)
            except (urllib.error.URLError, OSError, ValueError):
                hist = {}
            entry = (hist or {}).get(prompt_id)
            if entry:
                status = entry.get("status") or {}
                if status.get("status_str") == "error":
                    raise ComfyError(f"ComfyUI failed to run the workflow: {_explain(json.dumps(status.get('messages', []))[:1200])}")
                outputs = entry.get("outputs") or {}
                node_out = outputs.get(out_node) or {}
                images = node_out.get("images") or []
                if images:
                    break
                if status.get("completed"):
                    raise ComfyError("ComfyUI finished the workflow but produced no image. Check the Save Image node.")
            time.sleep(self.poll)
        else:
            raise ComfyError(
                f"ComfyUI did not finish within {int(self.timeout)} s. The job may still be running; check the ComfyUI console."
            )
        # 5. fetch the bytes
        first = images[0]
        data = client.view(first.get("filename", ""), first.get("subfolder", ""), first.get("type", "output"))
        if not data:
            raise ComfyError("ComfyUI reported an image but returned no bytes for it.")
        seed = request.get("seed")
        used = sorted({k.strip("{}") for k in _tokens_used(wf)} & {"pose", "depth", "silhouette", "mannequin", "textured"})
        info = f"ComfyUI {self.url}; guides: {', '.join(used) or 'structural wiring'}"
        return {
            "image": data,
            "mime": "image/png",
            "model": self.status().get("model"),
            "seed": seed if isinstance(seed, int) else None,
            "info": info,
        }


def _explain(body: str) -> str:
    """Turn ComfyUI's error JSON into one readable line, keeping the useful part."""
    try:
        j = json.loads(body)
    except ValueError:
        return body.strip()[:600] or "no detail"
    err = j.get("error")
    if isinstance(err, dict):
        msg = err.get("message") or err.get("type") or "error"
        details = err.get("details")
        return f"{msg}{f' — {details}' if details else ''}"[:600]
    if isinstance(err, str):
        return err[:600]
    node_errors = j.get("node_errors")
    if isinstance(node_errors, dict) and node_errors:
        first = next(iter(node_errors.items()))
        return f"node {first[0]}: {json.dumps(first[1])[:500]}"
    return body.strip()[:600]


backend = ComfyUIBackend()
