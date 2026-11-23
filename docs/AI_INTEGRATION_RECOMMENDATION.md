# Next milestone: a real pose-conditioned generation proof of concept

**Status of CharacterForge today:** the protocol, the provider architecture, the pose/depth/silhouette/character-render guides, the review workflow and the safety guards exist and are tested. **No image model is included, none was downloaded, and no fake generator exists in the product.** The only "backend" in the repository is a test fixture that draws a gradient (`server/tests/fake_backend.py`) and is never loaded outside tests.

Everything below about models comes from the official model pages/docs read on 2026-11-22 (listed at the end). Anything not stated there is marked **unverified**. **Nothing here has been run** — this machine has no GPU, so no model was loaded, and no claim of "works on 6 GB" is made from a measurement.

## 1. What the existing architecture already gives a model

* **Pose conditioning inputs:** `guide_pose` (OpenPose-style skeleton picture plus 18 keypoints in `request.pose`), `guide_depth`, `guide_silhouette`, `guide_mannequin`, and `guide_textured` (the artist's own drawing projected on the posed 3D model), all rendered with the exact output frame.
* **Identity inputs:** `original` (byte-exact), `reference_0..N` (user-approved, with role/label/notes), `appearance` text hints.
* **Plug-in point:** `CF_GENERATION_BACKEND=module:object` with `status()` / `generate()`; the server handles limits, one-job-at-a-time, timeouts, output validation. A backend only has to turn `(request, files)` into image bytes.
* **Honesty guards:** results identical to the original/reference/guide are discarded; provenance (model, seed, guides used, parent result) is recorded; imported images are labelled imported.
* **Gap to be aware of:** the protocol is one request/response (no progress, no streaming). A 60-second CPU/offloaded run shows only "Generating…". That is acceptable for a proof of concept.

## 2. Recommended proof of concept (smallest thing that can answer the real question)

**Question to answer:** *with a pose skeleton + the character's own artwork as reference, can an anime model produce a recognisable version of this character in a new pose on this hardware?*

**Architecture:** a Python backend module using Hugging Face `diffusers`, SDXL-class anime checkpoint + OpenPose ControlNet + IP-Adapter, offloaded. Every part below is **a candidate to be verified on the target machine, not a confirmed combination.**

| Role | Candidate | Verified from the official page | Not verified |
|---|---|---|---|
| Anime base | **Animagine XL 4.0** (SDXL fine-tune) | License "openrail++" (CreativeML Open RAIL++-M, unmodified); base = SDXL 1.0; recommended 1024×1024 / 832×1216, CFG ≈5, 28 steps, Euler a; "higher resolutions such as 1536×1536 may degrade"; states no VRAM figure | quality for *this* character; actual VRAM |
| Pose | **xinsir/controlnet-openpose-sdxl-1.0** | License apache-2.0; fine-tuned from SDXL base 1.0; conditioned on OpenPose images (18-point, normalised coordinates); recommends 1024×1024-class sizes; trained on *thicker limb lines* than the default drawer, author supplies a replacement `draw_bodypose` | that it follows poses rendered from CharacterForge's skeleton as-is (needs a draw step matching the thick-line style); anime fidelity |
| Identity | **IP-Adapter** (`h94/IP-Adapter`, `sdxl_models`: `ip-adapter_sdxl.bin`, `ip-adapter_sdxl_vit-h.bin`, `ip-adapter-plus_sdxl_vit-h.bin`, `ip-adapter-plus-face_sdxl_vit-h.bin`) | License apache-2.0; loaded in diffusers with `load_ip_adapter`; docs say it can be combined with ControlNet (the docs' example is SD 1.5, **not** SDXL); the Plus variant is for "when detail from the reference image matters most"; SDXL folder's image encoder is OpenCLIP-ViT-bigG-14 (1844.9 M parameters); adapter weights ≈100 MB | **identity preservation for a given anime character is exactly what the PoC must measure** — IP-Adapter conditions on image appearance, it does not guarantee the same face/outfit; combined ControlNet + IP-Adapter on SDXL with an anime fine-tune is not shown in the docs read |
| Runtime | `diffusers` with `enable_model_cpu_offload()` (and VAE tiling/slicing) | Docs: model offload moves whole models (UNet, text encoder, VAE) on/off the GPU — faster than sequential offload, but saves less; sequential offload "dramatically reduces memory" but is "extremely slow … often impractical"; docs give **no VRAM numbers** | whether SDXL + ControlNet + IP-Adapter + encoders fit **6 GB VRAM** and **8 GB RAM**; time per image |

A cheaper control experiment to run first: the same pipeline **without** IP-Adapter (pose + prompt only) — to separate "pose works" from "identity works".

## 3. Feasibility on 6 GB VRAM / 8 GB system RAM

Honest answer: **plausible but unproven; the system RAM is the tighter limit.**

* SDXL is listed on its model card at "3B params" in total; at 16-bit that is on the order of 6 GB of weights *before* ControlNet (another full-size network), the IP-Adapter image encoder (1.8 B parameters ≈ 3.7 GB at 16-bit by simple arithmetic) and activations. So **nothing fits fully on a 6 GB card**; the plan depends on model offloading, which moves components between RAM and VRAM — and then **8 GB of system RAM must hold the offloaded parts**, alongside the OS and the browser. This arithmetic is mine, from parameter counts; it is an estimate to be replaced by measurement (`torch.cuda.max_memory_allocated()` and process RSS) in the PoC.
* Mitigations to try, in order: fp16 weights → `enable_model_cpu_offload()` → VAE tiling → smaller output (e.g. 832×1216 as listed on the Animagine page, or lower) → precomputing the IP-Adapter image embedding once, then dropping the encoder (the docs describe passing precomputed embeddings so the encoder is not needed again) → only then `enable_sequential_cpu_offload()` (works, but the docs call it extremely slow).
* **Quantization:** diffusers documents layerwise casting to float8 storage and says offloading "can be combined with quantization"; bitsandbytes/GGUF/torchao support for **SDXL UNet + ControlNet specifically was not verified** here — treat as an experiment, and check quality loss on line art.
* **CPU-only** (no GPU) is impractical for iterating; at best a single slow image as a smoke test.
* **Larger models are not recommended for this hardware.** FLUX.1 Kontext [dev] (12 B parameters, edits an input image while preserving the character, per its announcement) has GGUF quantisations whose files are **4.02 GB (Q2_K) to 12.7 GB (Q8_0); Q4 is 6.8–6.93 GB** — already larger than 6 GB VRAM before the text encoders and activations. It also carries a **non-commercial licence**. It is not conditioned on a skeleton, so it would not replace pose conditioning. Worth a look only on a bigger GPU.

## 4. Output style and identity — what to expect

* **Anime/manga look:** comes from the base checkpoint (Animagine XL 4.0 is an anime-trained SDXL fine-tune). **Black-and-white manga screentone/line-art** is a different target: it needs a line-art/lineart-ControlNet or a manga-specific LoRA, **not verified** here. The PoC should first target *colour anime illustration* and judge manga conversion separately.
* **Identity:** the strongest cheap signals are (a) IP-Adapter on the original + approved references, (b) a short, accurate appearance prompt, (c) the `textured` guide (the artist's own drawing mapped onto the posed model) used as an *img2img/ControlNet-tile style* input at moderate strength. Whether any of these keeps a hand-drawn character recognisable is the PoC's measurable outcome. A **character LoRA trained on the artist's own references** is the usual next step if IP-Adapter is not enough; training needs far more VRAM/time than inference and is out of scope for the first PoC.
* Suggested acceptance test (objective, small): 3 characters × 5 poses × 4 seeds; record time/peak VRAM/peak RAM per image; the artist rates "same character? same outfit? pose followed?" 1–5. No metric is claimed in advance.

## 5. Optional, opt-in remote generation

Local-first stays the default. If a remote option is added later:

* It must be a **separate provider** (`sendsArtworkOffDevice = true`) that cannot be selected without an explicit per-session consent screen listing exactly what is uploaded (original, references, guides, text), where, and the provider's retention terms. The current client refuses non-loopback URLs on purpose; that rule must not be loosened for the local provider.
* No API keys in the project file or bundles; keys live only in memory or the OS keychain. Cost shown before sending. Nothing sent in the background.
* Provenance records must say "generated remotely by <provider/model>".
* Self-hosted GPU box on the artist's LAN is a middle ground (needs `CF_ALLOW_REMOTE_BIND=1`, which has **no authentication** — see `docs/SECURITY.md`; add a token or a reverse proxy first).

## 6. Privacy and licensing checklist (before shipping any backend)

* **The artist's artwork never leaves the machine** with a local backend; say so in the UI and keep it true (no telemetry from the backend module; `HF_HUB_OFFLINE=1` after the one-time download).
* Model licences differ and must be shown to the user at install time: Animagine XL 4.0 → CreativeML Open RAIL++-M (use restrictions, must pass the licence and notices on); SDXL base → OpenRAIL++-M (per its card); xinsir ControlNet and `h94/IP-Adapter` → apache-2.0 per their cards. **IP-Adapter-FaceID variants and InsightFace were not checked** (the h94 page read says nothing about them) — check before using any face-embedding component. FLUX.1 Kontext [dev] → FLUX.1 Non-Commercial licence.
* Licence of the **outputs** and of the training data of each checkpoint was **not investigated**; do not make claims to the artist about commercial safety without reading each licence in full (and, for commercial work, legal advice).
* The existing hash-based honesty guard and provenance stay on for every real backend.

## 7. Installation complexity (the real product risk)

* Needs: Python 3.10+ (exact range per `diffusers`/`torch`, **not verified here**), a PyTorch build matching the GPU driver (CUDA/ROCm), `diffusers`, `transformers`, `accelerate`, `safetensors`, ~15–20 GB of downloads (estimate from the component sizes above; not measured), and a Hugging Face download step per model.
* **Do not auto-download weights from the app or from the server.** Provide a documented `python tools/fetch_models.py --accept-licences` style script the user runs knowingly, with a printed size and licence list. (Not written — it would be a new feature outside this review.)
* The first milestone should ship as: `server/backends/sdxl_pose_ip.py` (≈150 lines), a `requirements-generation.txt`, a one-page install guide, and `status()` that reports exactly what is missing (model files, CUDA, VRAM too small). Windows + NVIDIA is the likely main target; **Windows was not tested at all.**
* Alternative that avoids owning model plumbing: a backend that talks to a **locally running ComfyUI** (HTTP on loopback) using a user-supplied workflow. ComfyUI manages model files, offloading and GGUF; CharacterForge then only maps guides/references to workflow inputs. Trade-off: depends on ComfyUI's API/workflow format (**not verified here**) and on the artist installing it.

## 8. Concrete next steps

1. On the actual target machine (6 GB GPU, 8 GB RAM) run a **stand-alone script** (no CharacterForge) that loads Animagine XL 4.0 + xinsir OpenPose ControlNet with `enable_model_cpu_offload()`, feeds one pose guide exported from CharacterForge, and records peak VRAM/RAM and seconds. Decide go/no-go on memory *first*.
2. Add IP-Adapter (Plus) with the artist's original; compare with and without.
3. Wrap the working script as a backend module against protocol v1 (`status()` must report real availability/VRAM; `capabilities.guides` must list only guides actually used; `info` must say what was used).
4. Run the acceptance test above; write down failures (anatomy, hands, identity drift) — they decide whether a LoRA, a different adapter or a different model is the next step.
5. Only after that: manga/line-art output, quantisation experiments, optional remote provider.

## Sources read (2026-11-22)

* [Diffusers — Reduce memory usage](https://huggingface.co/docs/diffusers/optimization/memory)
* [Diffusers — IP-Adapter](https://huggingface.co/docs/diffusers/using-diffusers/ip_adapter)
* [h94/IP-Adapter model card](https://huggingface.co/h94/IP-Adapter)
* [xinsir/controlnet-openpose-sdxl-1.0](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0)
* [Animagine XL 4.0](https://huggingface.co/cagliostrolab/animagine-xl-4.0)
* [stabilityai/stable-diffusion-xl-base-1.0](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)
* [FLUX.1 Kontext [dev] announcement](https://bfl.ai/announcements/flux-1-kontext-dev)
* [QuantStack/FLUX.1-Kontext-dev-GGUF](https://huggingface.co/QuantStack/FLUX.1-Kontext-dev-GGUF)
