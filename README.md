# CharacterForge

A browser-based **2D-first, 3D-guided manga character studio**. You keep one profile per character (original drawing, references, poses, results), shape and pose a 3D character model and wrap your drawing around it, and a generation backend you run yourself turns that pose into a new 2D image of the same character. The layer-based 2D editor from v0.1 remains available for manual correction.

> **Principle:** the artist stays in control. The original artwork is never overwritten, nothing is presented as AI output unless a real backend produced it, and artwork never leaves your computer.

Everything runs locally in the browser (IndexedDB). No accounts, no cloud, no paid APIs.

---

## Status: read this first

| Area | State |
|---|---|
| Character profiles, references, saved poses, results with provenance, `.cfbundle` backup, v1→v2→v3 migration | Implemented, unit-tested |
| 3D pose studio: the bundled **anime character base model** (rigged here) that you size to your character (height, width, shape sliders, presets, auto-fit to the drawing's silhouette), **artwork projected onto the model**, IK handles, presets, mirror, ground, camera, output frame, pose-guide PNGs | Implemented, unit-tested, and exercised in a real headless Chromium with software WebGL (`e2e/studio.e2e.cjs`) |
| Generation adapter contract, loopback HTTP adapter, review workflow (accept/reject/retry/import/provenance) | Implemented and tested **with a mocked `fetch` and a synthetic test backend only** (no model, no real generation) |
| Server hardening (request/file/pixel limits, origin/host checks, one heavy job at a time, timeouts, output validation), bundle-import hardening (zip-bomb limits, checksums), migration backups | Implemented and tested; **not a security certification** — see [docs/SECURITY.md](docs/SECURITY.md) |
| **Actual AI image generation** | **Not available out of the box.** CharacterForge contains no image model. See [Generation](#generation-what-works-and-what-does-not). |

Verified in this build (v0.4.1): `npm run check` (typecheck + **280 Vitest tests in 18 files** + production build); **65 server tests** (`pytest`); the browser checks `e2e/studio.e2e.cjs` and the broader `e2e/full.e2e.cjs` (**36 steps**: character create/delete, original and reference import, presets, joints, IK drags, camera, proportion/shape sliders, fit, projection, guide downloads, pose save/load, undo/redo, reload persistence, bundle export/import incl. damaged bundles, a stored schema-2 project migrating with its backup, generate/review against the **test-only** gradient backend, failure paths, 2D canvas and PNG export) in headless Chromium. Browser verification was done only in headless Chromium with SwiftShader software WebGL; Firefox, Safari, real GPUs, Windows/macOS and touch input were **not** tested. No real image model has been run.

---

## Quick start

Requirements: **Node.js 20.19+** (or 22.12+) and a modern desktop browser with WebGL.

```
npm install
npm run dev
```

Open the printed address (default <http://localhost:5173>).

| Task | Command |
|---|---|
| Start dev server | `npm run dev` |
| Type-check | `npm run typecheck` |
| Unit tests | `npm test` |
| Production build | `npm run build` (output in `dist/`) |
| Typecheck + tests + build | `npm run check` |
| Serve the production build | `npm run preview` (<http://localhost:4173>) |
| Browser end-to-end checks | `npm run build && npx vite preview --port 4173`, then `node e2e/studio.e2e.cjs` and `node e2e/full.e2e.cjs` (need the `playwright` package and a Chromium; not project dependencies; the second also needs the Python server requirements and takes ~5 min with software WebGL). `CF_E2E_HERO=/path/to/your-character.png` runs it with your own artwork. |
| Server tests | `cd server && pip install -r requirements.txt pytest httpx && python -m pytest` |

---

## Using it

The toolbar has four workspaces.

1. **Character** — create a character (*Characters* → *Create project*), import the **original full-body drawing** (PNG/JPEG/WebP), optionally add **references** (face close-up, other views, clothing…, each with role, notes and an *approved* checkbox: only approved references are sent to a generator), and add appearance notes. Replacing the original keeps the old one in the profile.
2. **Pose studio** — size the character model, match it to your drawing, then pose it:
   * **Character body** (left panel): *Height*, *Build/thickness*, leg/torso/arm length, shoulder and hip width, head size, plus *Body shape* sliders (chest, waist, hips, neck, arm and leg thickness, hand and foot size, front-back depth) and presets (default, tall hero, slender, sturdy, chibi). The body is the bundled **“Anime Character Base mesh” by Marc Ed (CC BY 4.0)**: a 40k-vertex head-to-toe mesh with face shape, ears, fingers and feet. The file ships unrigged, so CharacterForge rigs it itself (`src/pose/bodyModel.ts`): the engine's skeleton is fitted inside the mesh, each body-part shell is skinned to its limb's joints with smooth blends at elbows, knees and the waist, and each bone's length and thickness follow your sliders. Sliders update the body live.
   * **Match to artwork**: *Match view* sets a front, narrow-lens camera; *Show drawing over the viewport* lays your drawing translucently over the model to compare; *Fit body to artwork* searches proportions and shape so the model's front silhouette overlaps the drawing's figure (it reports the silhouette match, e.g. 71% → 87%, and keeps your standing height); *Project artwork onto model* wraps the drawing onto the body in its current pose. From then on the drawing follows the body when you pose it. Surfaces the drawing does not show (sides, and the back unless you choose a back-view reference) use a fill colour; shading is adjustable.
   * **Presets**: neutral, A/T-pose, relaxed, walk, run, sit, crouch, wave, point, hands on hips, guard, jump. Mirror L↔R, Reset, Place on ground.
   * **Orange handles** (hands, feet) drag with two-bone IK; the **diamond** moves the body (Shift = along the floor; *Keep feet planted* makes the legs follow); **blue dots** rotate a joint; the Inspector has per-joint sliders within anatomical limits.
   * **Camera**: drag empty space to orbit, Shift/right-drag to pan, wheel to zoom, view presets, FOV, *Frame figure*. The viewport shows exactly the frame that will be rendered (output size/aspect), so what you see is what the guide images contain.
   * **Saved poses** keep joint angles, body position and camera with the character.
   * **Pose-guide images**: clay model, *character render* (your artwork on the model; only once projected), OpenPose-style pose map, depth, silhouette — downloadable (transparent PNG option), and sent to a generator when one is available.
3. **Generate & review** — shows the inputs, the backend status and the results list. With a backend: *Generate from current pose* (progress text, Cancel). Without one: the button stays disabled and says why; you can **import an image made elsewhere** (e.g. from your own ComfyUI/Krita workflow using the guide pack) — it is labelled *IMPORTED — NOT GENERATED HERE*. Review shows **ORIGINAL ARTWORK** next to the result; **Accept / Reject**, **Retry with same pose** (generated only), notes, *Use as reference*, *Edit in 2D canvas*, *Download*, *Delete* (accepted results must be un-accepted first), and a provenance panel (provider, model, seed, pose, camera, proportions, references, guides, parent result).
4. **2D canvas** — the v0.1 layer editor (layout, masks, rig, 2D poses, PNG export, optional AI mask proposals) for manual correction.

Everything autosaves; the last open character and workspace reopen on startup. Undo/redo is per workspace (2D canvas has its own history; camera moves are saved but are not undo steps). Use *Characters → Export current project as bundle* (`.cfbundle`) for backups.

### Keyboard shortcuts (2D canvas)

`Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Ctrl+E` export · `Ctrl+D` duplicate · `Ctrl+G` / `Ctrl+Shift+G` group/ungroup · `1` `2` `3` modes · `F` fit · `P` pivot · `J` add joint · `Delete` · arrows nudge (Shift ×10) · wheel zoom · Space+drag pan · `Esc`. `Ctrl+Z/Y/S` also work in the other workspaces.

---

## Generation: what works and what does not

* The **contract** (`src/generation/types.ts`) and the **local HTTP protocol** ([docs/GENERATION_PROTOCOL.md](docs/GENERATION_PROTOCOL.md)) are implemented: request builder, multipart upload of original + references + guides + structured pose data, status check, errors, cancel, result validation, provenance, retry lineage.
* The only built-in adapter talks to **a server on this computer** and refuses non-loopback addresses.
* The server has a **plug-in point** (`CF_GENERATION_BACKEND=module:object`, see the protocol doc). **No model is included**, none was downloaded or run, and there is no mock that pretends to generate. Without a backend, `/generate/status` reports exactly what is missing and `/generate` answers 503.
* Guard: a result identical to the original, a reference or a guide image is rejected as "not generated".
* **What you need for real output**: a pose-conditioned image model wrapped as a backend — typically ComfyUI or diffusers with a pose ControlNet plus an identity/reference adapter. Realistic hardware is a GPU with roughly 8 GB+ VRAM; CPU-only generation is impractical (the machine this was built on had 2 CPU cores, 8 GB RAM, no GPU, and could not reach Hugging Face, so no model could be evaluated). Model and licence choice are yours; check each model's licence before use.
* **Limits and safety of the server** (aggregate request size, pixel budgets, origin/host checks, one job at a time, timeouts, validated outputs) are described in [docs/SECURITY.md](docs/SECURITY.md) and the protocol doc. `CF_GENERATION_BACKEND` runs arbitrary Python as you — only point it at code you trust.
* The next milestone (a real pose-conditioned proof of concept, with what was and was not verified about candidate models) is in [docs/AI_INTEGRATION_RECOMMENDATION.md](docs/AI_INTEGRATION_RECOMMENDATION.md).
* Using a paid/hosted API would send your artwork off your computer. That is **not** implemented and would need a new provider plus your explicit approval.
* Reference images improve consistency; **hidden-view results (e.g. the back of a character you only drew from the front) are guesses** and may not match your intent.

### Running the server

```
cd server
python -m venv .venv
# Windows: .\.venv\Scripts\Activate.ps1      macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn main:app --host 127.0.0.1 --port 8765
# with a backend:  CF_GENERATION_BACKEND=my_backend:backend python -m uvicorn main:app --host 127.0.0.1 --port 8765
```

In the Generate tab, *Check server* shows whether the server and a backend are reachable.

---

## Supported formats

| Format | Support |
|---|---|
| **PNG** (opaque or transparent) | Imported unchanged; the original bytes are the layer's pixel asset. Max 16384 px per side and 100 megapixels. 16-bit PNGs are decoded by the browser at 8-bit. |
| **PSD** (via [`ag-psd`](https://github.com/Agamnentzar/ag-psd), MIT) | Layer names, order, groups, visibility, opacity and position. **Not** preserved, and reported in an import report (never silently dropped): blend modes other than Normal, layer masks, clipping layers, layer effects, adjustment layers (skipped), text layers (imported as pixels), non-8-bit or non-RGB colour modes. |
| **`.cfbundle`** (ZIP: `manifest.json`, `project.json`, `assets/*`) | Portable backup/transfer. Validated on import (format, version, sizes, PNG signatures, schema). |
| **Export** | Transparent PNG at canvas resolution × 1/2/4. |

In the 2D canvas, JPEG/WebP/CLIP and other formats are rejected with a message asking you to convert to PNG. The **Character** tab accepts PNG, JPEG and WebP for the original artwork, references and imported results.

---

## Optional: AI-assisted layer separation

The core editor works without any of this. The AI step is a **proposal**: it suggests masks, you accept, refine or discard them. Accepted proposals become **new layers that reuse the source layer's original pixels plus a mask**; the source layer is only hidden (undoable), never cut up.

How it works: the browser sends *one layer's PNG* to a small Python server **on localhost** and gets mask PNGs back. The app refuses non-localhost server addresses, so artwork cannot be sent to a remote service.

### Backends

| Mode | Library / model | Licence (to verify yourself) |
|---|---|---|
| Character vs background | [`rembg`](https://github.com/danielgatis/rembg) with the `isnet-anime` model, CPU via ONNX Runtime | rembg: MIT. Check the downloaded model's licence before redistributing it or its output. |
| Split into parts | [Segment Anything](https://github.com/facebookresearch/segment-anything) automatic mask generator (PyTorch) | Code and weights: Apache-2.0. Verify the exact checkpoint you download. |

I could not check these licences, download the models, or measure result quality or speed in the build environment. **No inference has been run.** Model weights are never committed or bundled.

### Running the server

PowerShell:

```
cd server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install "rembg[cpu]"
python -m uvicorn main:app --host 127.0.0.1 --port 8765
```

macOS / Linux:

```
cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && pip install "rembg[cpu]"
python -m uvicorn main:app --host 127.0.0.1 --port 8765
```

For *Split into parts*, also `pip install torch torchvision segment-anything opencv-python-headless`, download a SAM checkpoint (e.g. `sam_vit_b_01ec64.pth` from the Segment Anything repository) and set `CF_SAM_CHECKPOINT` to its path before starting the server. If a package has no wheel for your Python version, create the server's virtual environment with Python 3.11 or 3.12.

In the app: select a pixel layer → Inspector → *AI-assisted separation* → **Check server** → **Propose masks**. The first run of a model may download weights and take a while on CPU. You can cancel at any time.

If the server is unreachable, the panel says so and everything else keeps working.

---

## Architecture

```
src/
  pose/        Pure TypeScript pose engine (no React/Three): skeleton, FK, two-bone IK, presets, camera, OpenPose keypoints
  core/        Pure data/logic: character profile (character.ts), schema/migrations, 2D layers/rig/IK, history
  generation/  Provider contract, local HTTP adapter, honesty guard, request builder, provenance
  render/      Three.js character body + viewport + guide renders; PixiJS 2D stage; PNG export
  storage/     Dexie/IndexedDB persistence, .cfbundle import/export (fflate)
  import/      PNG and PSD importers
  ai/          v0.1 mask-proposal provider + localhost guard
  app/         Observable store (two undo histories)
  ui/          React views: Character, Studio, Generate, 2D canvas
server/        FastAPI: mask proposals + generation plug-in point
docs/          GENERATION_PROTOCOL.md, SECURITY.md, AI_INTEGRATION_RECOMMENDATION.md
e2e/           Playwright browser check + fixtures
tests/         Vitest suites
```

See [PROJECT_SPEC.md](PROJECT_SPEC.md) for conventions (axes, joint limits, data model, honesty requirements).

---

## Known limitations

* **No bundled image model** — see above. Generation has never been run against a real model.
* The character model is one generic anime-style base body that you size and shape to your character; it is **not** a reconstruction of your character. It has fingers, but each hand moves as one piece (no finger joints), the face is a sculpted neutral face with no expressions, and hair, skirts, capes, tails and other parts outside the body outline do not exist in 3D. Presets and joint limits are approximate; extreme poses can self-intersect.
* The mesh is made of separate overlapping body-part shells (like a jointed doll), so in extreme arm raises or bends a thin gap or a pinched shoulder can show at the seams; the default skeleton was retuned to this model's proportions (a shorter, younger-looking figure than before), which changes where joints sit compared with v0.3.0 projects (poses are stored as angles, so they still load and look right).
* Attribution: the model is licensed CC BY 4.0. Keep the credit (shown in the Pose studio panel and in `public/models/LICENSE-model.txt`) when you share the model, the guide renders that show it, or a build of this app.
* Artwork projection is a single straight-on projection in the pose the drawing shows: it only paints what faces the camera in that pose. Sides and back use a fill colour (or a back-view reference you choose). Stretching appears where the posed body turns away from the projection direction. Re-project after changing the body, and use *Fit* / *Match view* with a front-facing drawing.
* *Fit body to artwork* matches the silhouette only (it is a deterministic coordinate search, not a learned pose/shape estimator); it needs a figure on a transparent or plain background, and cannot know proportions that the outline does not show.
* Pose-guide images are only as detailed as this body model.
* Browser testing covered Chromium with software WebGL only.
* Projected drawings: surfaces that face away from the drawing (sides, back) show the fill colour, not the drawing; on the sides this can look pale or streaky, and hair volume outside the head mesh does not exist in 3D. Auto-fit/projection work best when the model is posed like the drawing (an A-pose figure fits clearly better in A-pose than in T-pose).
* Upgrading an old project keeps a copy of the pre-upgrade data (`backups` table in IndexedDB; restoring creates a new project), but **there is no screen for restoring it yet**.
* Opening a bundle reads the whole file into memory before the size checks run (limit 1 GiB); the server's generation timeout cannot kill a running backend thread; the server has no authentication (loopback only by default). See docs/SECURITY.md.
* Only one heavy server job runs at a time; a second request gets "busy" and is not queued.
* The 2D canvas is rigid-layer (no deformation); group opacity multiplies onto children; PSD limits are listed in the import report.
* Browser storage can be cleared by the browser or user — export bundles for backups. Very large projects keep all images in memory.
* Desktop pointer UI only; touch is untested. The main JS bundle is large (~1.6 MB) because PixiJS and Three.js are both included; the 3D studio is lazy-loaded.

---

## Troubleshooting

* **"The 3D viewport could not start"** — WebGL is unavailable; enable hardware acceleration. (Headless/CI browsers need software GL flags such as `--use-angle=swiftshader --enable-unsafe-swiftshader`.)
* **"Generation is not available: Cannot reach a server"** — start `server/` (above) or change the address in the Generate tab; only localhost addresses are accepted.
* **"The server is busy…" (429)** — a segmentation or generation is still running; wait for it. **"…larger than…" (413)** — an image or the whole request is over the server's limits (shown in the message; raise `CF_MAX_*` only if your machine has the memory). **421/403** — the page or Host is not an allowed local origin (`CF_ALLOWED_ORIGINS`/`CF_ALLOWED_HOSTS`).
* **"No generation backend is configured"** — expected until you set `CF_GENERATION_BACKEND`; see the protocol doc.
* **A project will not open** — the message lists what is invalid. Import a bundle backup if you have one. v0.1 projects/bundles upgrade automatically to the new format.
* **"Cannot reach the segmentation server"** (2D canvas AI masks) — start `server/main.py`; the app must run on `localhost:5173` or `localhost:4173` (otherwise set `CF_ALLOWED_ORIGINS`).
