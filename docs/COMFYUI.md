# ComfyUI backend — install guide

This is the one page you need to get real generation working. It takes about 20 minutes, most of it downloading.

CharacterForge ships **no model**. It ships a backend that drives a ComfyUI you install yourself, because ComfyUI
already solves the hard parts — model files, VRAM offloading, GGUF quantisation, ControlNet and IP-Adapter loading —
and it gives you a node graph you can edit when the result is wrong.

---

## 1. What you need

| | Minimum | Comfortable |
|---|---|---|
| GPU | 4 GB VRAM (SD1.5) | 8–12 GB VRAM (SDXL) |
| System RAM | 8 GB | 16 GB |
| Disk | 10 GB free | 30 GB free |
| OS | Windows 10/11, Linux, macOS (Apple Silicon) | — |

**CPU-only works but is impractical** for real use: a single 768×1152 image can take 10+ minutes. It is fine for
checking that the plumbing works.

---

## 2. Install ComfyUI

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python -m venv venv
# Windows:  venv\Scripts\activate
# Linux/macOS:  source venv/bin/activate
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124   # NVIDIA
# Apple Silicon:  pip install torch torchvision torchaudio
# CPU only:       pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install -r requirements.txt
```

Start it and leave it running:

```bash
python main.py --listen 127.0.0.1 --port 8188
```

Open <http://127.0.0.1:8188> — you should see the ComfyUI graph editor. **Keep this terminal open**; CharacterForge
talks to it over localhost.

> `--listen 127.0.0.1` matters. Do not use `--listen 0.0.0.0` unless you understand that it exposes ComfyUI to your
> whole network, and CharacterForge will refuse a non-loopback address anyway.

---

## 3. Get the models

CharacterForge's fetch script prints every licence and refuses to download until you accept them:

```bash
cd CharacterForge
python tools/fetch_models.py --list
python tools/fetch_models.py --accept-licences --preset comfyui-sdxl --dest /path/to/ComfyUI/models
```

| Preset | Size | What you get |
|---|---|---|
| `comfyui-sdxl` | ~9.4 GB | Animagine XL 4.0 (anime SDXL) + xinsir OpenPose ControlNet. Best quality. |
| `comfyui-sd15` | ~3.5 GB | Anything-v5 + SD1.5 OpenPose ControlNet. Runs on 4 GB VRAM. |
| `tiny` | ~1 GB | segmind/tiny-sd. **Not an art model** — for testing the plumbing on a CPU. |

The script resumes an interrupted download and verifies the size before renaming the file, so a dropped connection
costs you nothing.

**Licences are not interchangeable.** Animagine XL 4.0 is CreativeML Open RAIL++-M (use restrictions, and you must pass
the licence on); the ControlNets are Apache-2.0. Read them before you sell anything made with them.

---

## 4. Point CharacterForge at a workflow

CharacterForge does not ship a workflow, because the right graph depends on which checkpoint and ControlNet you
installed. You have two options.

### Option A — use the placeholders (recommended)

Build a graph in ComfyUI, then replace the values CharacterForge should fill in with these tokens:

| Token | Becomes |
|---|---|
| `{{original}}` | the artist's original full-body drawing |
| `{{reference_0}}`, `{{reference_1}}`, … | approved reference images, in order |
| `{{pose}}` | the OpenPose-style pose map |
| `{{depth}}` | the depth map |
| `{{silhouette}}` | the silhouette |
| `{{mannequin}}` | the grey clay model |
| `{{textured}}` | the artwork projected on the posed model |
| `{{prompt}}` / `{{negative}}` | the assembled prompt text |
| `{{width}}` `{{height}}` `{{seed}}` `{{steps}}` `{{cfg}}` `{{denoise}}` | numbers from the request |

A minimal SDXL + OpenPose graph looks like this (API format — see below):

```json
{
  "1":  { "class_type": "CheckpointLoaderSimple", "inputs": { "ckpt_name": "animagine-xl-4.0.safetensors" } },
  "2":  { "class_type": "CLIPTextEncode", "inputs": { "text": "{{prompt}}", "clip": ["1", 1] } },
  "3":  { "class_type": "CLIPTextEncode", "inputs": { "text": "{{negative}}", "clip": ["1", 1] } },
  "4":  { "class_type": "LoadImage", "inputs": { "image": "{{pose}}" } },
  "5":  { "class_type": "ControlNetLoader", "inputs": { "control_net_name": "controlnet-openpose-sdxl.safetensors" } },
  "6":  { "class_type": "ControlNetApplyAdvanced",
          "inputs": { "positive": ["2", 0], "negative": ["3", 0], "control_net": ["5", 0],
                      "image": ["4", 0], "strength": 0.9, "start_percent": 0.0, "end_percent": 1.0 } },
  "7":  { "class_type": "EmptyLatentImage", "inputs": { "width": "{{width}}", "height": "{{height}}", "batch_size": 1 } },
  "8":  { "class_type": "KSampler",
          "inputs": { "model": ["1", 0], "positive": ["6", 0], "negative": ["6", 1], "latent_image": ["7", 0],
                      "seed": "{{seed}}", "steps": "{{steps}}", "cfg": "{{cfg}}",
                      "sampler_name": "euler_ancestral", "scheduler": "normal", "denoise": "{{denoise}}" } },
  "9":  { "class_type": "VAEDecode", "inputs": { "samples": ["8", 0], "vae": ["1", 2] } },
  "10": { "class_type": "SaveImage", "inputs": { "images": ["9", 0], "filename_prefix": "characterforge" } }
}
```

Save it as `my-workflow.json`. **It must be API format**, not the UI format: in ComfyUI use *Workflow → Export (API)*,
or the "Save (API Format)" button. A UI-format file (the one with `"nodes": [...]`) is rejected with a message telling
you so.

### Option B — no placeholders at all

If your graph has no tokens, CharacterForge wires it structurally: it finds the `LoadImage` nodes in graph order and
assigns original → references → pose → depth → silhouette → mannequin → textured. A plain
"Load Image → ControlNet → KSampler" graph therefore works without editing. It is less precise, so use Option A when
you care which image goes where.

---

## 5. Start the CharacterForge server with the backend

```bash
cd CharacterForge/server
pip install -r requirements.txt

# Linux / macOS
CF_GENERATION_BACKEND=backends.comfyui:backend \
CF_COMFYUI_WORKFLOW=/absolute/path/to/my-workflow.json \
python -m uvicorn main:app --host 127.0.0.1 --port 8765

# Windows (PowerShell)
$env:CF_GENERATION_BACKEND="backends.comfyui:backend"
$env:CF_COMFYUI_WORKFLOW="C:\path\to\my-workflow.json"
python -m uvicorn main:app --host 127.0.0.1 --port 8765
```

Then in CharacterForge: **Generate → Server address** `http://127.0.0.1:8765` → **Check server**. You should see
`Ready. ComfyUI 0.4x at http://127.0.0.1:8188 is ready.` and the list of guides the graph can use.

---

## 6. When it says it is not available

`status()` is written to name the actual problem. The messages and what to do:

| Message | Cause | Fix |
|---|---|---|
| `Cannot reach ComfyUI at …` | ComfyUI is not running, or on another port | Start it; set `CF_COMFYUI_URL` if the port differs |
| `No ComfyUI workflow is configured` | `CF_COMFYUI_WORKFLOW` is unset | Set it to the absolute path of your JSON |
| `That workflow is in ComfyUI's UI format` | You exported the wrong way | *Export (API)* in ComfyUI |
| `The workflow loads checkpoint 'x', but ComfyUI has none by that name` | The file is not in `ComfyUI/models/checkpoints` | Move it there, or fix the name in the graph |
| `The ComfyUI workflow asks for inputs this request cannot supply: {{depth}}` | The graph wants a guide the app did not send | Add the depth guide in the studio, or remove that node |
| `The ComfyUI workflow has no SaveImage or PreviewImage node` | Nothing to read back | Add a Save Image node |
| `CF_COMFYUI_URL must be a loopback address` | You pointed it at another machine | Use `127.0.0.1`; CharacterForge does not send artwork off-device |

---

## 7. What is verified, and what is not

Being precise about this matters more than a green checkmark.

**Verified in this repository's test suite** (`server/tests/test_comfyui_backend.py`, 26 tests: 24 unit + 2 live):

- the placeholder mapping — every token, including references by index, and a clear error naming a missing one;
- structural wiring when a graph has no tokens;
- the configuration guards (non-loopback refused, UI-format rejected, missing workflow reported as a status);
- **against a real ComfyUI 0.46.0 instance**: `status()` reports ready, and `generate()` uploads two images, queues a
  graph, polls `/history`, fetches the result from `/view`, and returns a genuine 128×192 PNG.

**Not verified: a diffusion model producing an image.** This was attempted, not skipped, and it failed for a
measurable infrastructure reason rather than a code one:

- A complete SD1.5 model (DreamShaper 8: UNet 1.72 GB, CLIP 246 MB, VAE 167 MB) was present and validated — all three
  files parse as safetensors with 686 / 196 / 248 tensors.
- ComfyUI loaded the CLIP encoder successfully (235.84 MB, `full load: True`) and then **the process was killed by the
  kernel OOM killer the moment the 1.7 GB UNet was loaded**. The cgroup evidence is unambiguous:
  `memory.max = 2147483648` (2 GiB), `memory.peak = 2147487744` (the ceiling, exactly), `oom_kill 2`.
- Retried with `--use-split-cross-attention --reserve-vram 0.2` and fp16 weights; same outcome. A 1.7 GB fp32 UNet
  plus activations does not fit in 2 GiB, and there is no smaller checkpoint on disk.
- The workflow itself was accepted by ComfyUI (`POST /prompt` → `{"prompt_id": ..., "node_errors": {}}`), so the graph
  is valid; only the model load exceeded the memory limit.

**What this means for you:** the HTTP path, the workflow mapping, the error reporting and the review loop are all
proven. What is *not* proven is that a given checkpoint + ControlNet produces a good picture of your character. That
is the acceptance test in `docs/AI_INTEGRATION_RECOMMENDATION.md` §2, and it needs a machine with a GPU (or at least
8 GB of RAM). No claim is made here about its outcome.

---

## 8. Privacy

The backend only ever connects to a loopback address, and refuses anything else. Your artwork goes to ComfyUI on your
own machine and nowhere else. ComfyUI itself makes no network calls once the models are downloaded; set
`HF_HUB_OFFLINE=1` if you want that enforced.
