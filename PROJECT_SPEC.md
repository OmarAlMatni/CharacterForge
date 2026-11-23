# CharacterForge — project specification

> This file was written during the pivot to the 2D-first, 3D-guided workflow. The uploaded v0.1 archive did not contain a `PROJECT_SPEC.md`, so there was no earlier specification to preserve; the old behaviour is described from the code in §9.

## 1. Product

A browser-based studio for manga / webtoon artists. The artist keeps **one character profile**: the original full-body drawing, optional reference images, body proportions, saved poses and every generated or imported result. They size a 3D character model to their character, project the artwork onto it, pose it, and a pluggable generation backend produces a **new 2D image of that character in that pose**, which is reviewed (accept / reject / retry) and can be corrected with the existing 2D layer tools.

Principle: **the artist stays in control and the original is never overwritten.** Nothing is presented as AI output unless a real backend produced it.

## 2. Workflow

1. Create a character (a project == a character profile).
2. Import the original drawing (PNG/JPEG/WebP). Stored byte-for-byte as the *original artwork* asset.
3. Optionally add references (face, other views, clothing, accessory, expression) with roles, notes and an *approved* flag.
4. Size the character model (height, width, proportions, body-shape sliders, or auto-fit to the drawing's silhouette), project the artwork onto it, and pose it (presets, IK handles, joint rotation, mirror, ground); set camera (orbit/pan/zoom, view presets, FOV) and output size. The viewport is letterboxed to the output aspect ratio (what you see is the frame that is rendered).
5. Export pose guides: clay model PNG, character render (artwork on the model), OpenPose-style pose map, depth, silhouette.
6. Generate (if a backend is available) or import an externally made image (labelled *imported*).
7. Review: original vs result side by side; accept / reject / back to review; retry with the same pose; notes; use as reference; send to the 2D canvas; download; delete (accepted results must be un-accepted first).
8. Everything (pose, camera, proportions, references, results, provenance, settings) autosaves in the profile and in `.cfbundle` backups.
9. Reopen the profile later and reuse saved poses.

## 3. Scope

In scope: the above; the 2D canvas editor from v0.1 (layers, masks, rig, 2D poses, PSD/PNG import, PNG export, AI mask proposals) kept as a secondary tool.

Out of scope: automatic 3D reconstruction, detailed 3D modelling, mandatory VRM, model training, manga page composition, accounts/billing/cloud, and any guarantee of correct hidden-view generation.

## 4. Architecture

| Layer | Location | Notes |
|---|---|---|
| Pose engine | `src/pose/` | Pure TypeScript, **no React or Three.js**. Skeleton, FK, analytic two-bone IK with limits and pole logic, root-pinned moves, presets, orbit camera + projection, OpenPose keypoints, validation. **Character body** (all pure): `glb.ts` (reads the bundled .glb), `bodyModel.ts` (rigs the unrigged anime base mesh: measured joint table, shell-by-shell skin weights, per-bone native frames, per-joint length/thickness scaling from Height/Proportions/Shape, a decimated copy for fitting), `characterMesh.ts` (registry: the app loads the model once), `bodyShape.ts` (shape multipliers, presets), `bodyMesh.ts` (linear-blend skinning with per-joint scale), `silhouette.ts` (figure mask, rasteriser, IoU), `projection.ts` (artwork fit, UV baking), `fit.ts` (silhouette fit, coordinate descent). |
| Character profile | `src/core/character.ts` | Types and pure operations: references, appearance, studio state, saved poses, generation records, provenance. |
| Generation | `src/generation/` | `GenerationProvider` contract, loopback-only `LocalHttpProvider`, honesty guard, request builder, provenance. See `docs/GENERATION_PROTOCOL.md`. |
| Rendering | `src/render/` | Three.js character body (`characterBody.ts`: CPU-skinned mesh + shader that shows clay or the projected artwork) and viewport; offscreen guide renders (shaded, depth, silhouette; the pose map is drawn in 2D). PixiJS for the 2D canvas. |
| Store | `src/app/store.ts` | Observable store. Two undo histories: `History<DocState>` (2D canvas) and `History<CharacterState>` (profile/studio), routed by the active workspace. Camera moves persist but are not undo steps. Drags are one undo step. |
| Storage | `src/storage/` | Dexie/IndexedDB (DB version 2: `projects`, `assets`, `backups`); binary assets by id; `.cfbundle` ZIP (bundleVersion 1) with size limits, duplicate/path checks and CRC-32 verification on import. |
| Server | `server/` (v0.2.0) | FastAPI: segmentation endpoints (v0.1) and the generation plug-in point; `limits.py` holds the request guard, image validation and the one-heavy-job slot. See `docs/SECURITY.md`. |

Conventions: Y-up; the model faces +Z; character's left = +X; rest pose has limbs along −Y; Euler degrees (pelvis `YXZ`, other joints `XZY`); negative X swings a limb forward; elbow X ∈ [−150, 0], knee X ∈ [0, 150]; mirror = keep X, negate Y and Z.

## 5. Data and migration

`ProjectFile.schemaVersion = 3`. v1→v2 adds `character: CharacterState` (empty character; the first PNG source asset becomes the original artwork). v2→v3 (this release) adds `studio.shape` (nine body-shape multipliers, defaults all 1) and `studio.artwork` (projected front/back images with their model→pixel fit, the pose they were projected in, fill colour, shading, overlay settings; defaults: nothing projected). Generation provenance gains an optional `shape`; guide kind `textured` (character render) is new. Migrations are idempotent and chained, so v1 and v2 files and bundles open directly. Tested in `tests/schema.test.ts`/`tests/character.test.ts` and with a real v1-in-bundle import. Asset kinds: `source`, `layer`, `mask`, `reference`, `guide`, `generated`. Bundles written by v0.1 still import.

Migration safety: when a stored project is upgraded on load, its raw pre-upgrade JSON is saved once per project and format version in the `backups` table (restore creates a new project; no UI yet). Migrations are idempotent and never mutate their input.

## 6. Honesty requirements (testable)

* The original asset is never modified; replacing it keeps the old one in `previousOriginals`.
* No fake provider exists in the app. With no backend, *Generate* is disabled with the exact reason.
* A provider result equal to any input is rejected.
* Imported images are labelled *IMPORTED — NOT GENERATED HERE* in the review and in provenance.
* The only built-in network adapter is loopback-only.
* A failed, cancelled, malformed or oversized generation stores nothing and never alters the original or any stored image (e2e-verified by hashing stored images).
* Replacing the original never discards an earlier one (a full list refuses the replacement instead of dropping the oldest).

## 7. Status of requirements

| Requirement | Status |
|---|---|
| Smooth skinned character body with size/shape controls, silhouette fit, artwork projection and overlay, IK, presets, save/restore poses, pose-guide PNGs (clay, character render, pose, depth, silhouette) | Implemented (bundled third-party model, rigged in this project); pose/rig/projection/fit logic unit-tested; rendering and UI exercised in headless Chromium (software WebGL) |
| Character profiles with references, results, provenance | Implemented and tested |
| Generation adapter contract, progress/errors/cancel, review UI | Implemented; **tested only with a mocked `fetch` and a synthetic test backend — no model has been run** |
| Real image generation | **Not available.** Needs a user-supplied backend and a GPU; see `docs/GENERATION_PROTOCOL.md` |
| Schema migration v1→v2→v3 | Implemented and tested; pre-upgrade backup kept (no restore UI) |
| Server/bundle hardening | Implemented and tested (not certified); see `docs/SECURITY.md` |
| Next milestone | Real pose-conditioned PoC: `docs/AI_INTEGRATION_RECOMMENDATION.md` |

## 8. Known limitations

* The character model is a stylised generic body shaped by sliders or the silhouette fit, not a reconstruction of the artist's character: fingers exist but move as one piece with the hand, the face is neutral, and hair/clothes outside the body outline are not 3D. The body mesh is CC BY 4.0 (Marc Ed) and must be credited.
* Artwork projection is a single front projection in the drawing's pose (optionally a mirrored back view): sides and the unseen back use a fill colour, and stretching appears on surfaces that turn away from the projection direction. Re-project after body changes.
* Pose limits are approximate human ranges; some extreme combinations self-intersect.
* Hidden-view fidelity depends entirely on the generation backend and the references.
* Depth and silhouette maps come from the same body model, so they are only as detailed as it is.
* Browser-side testing was done in headless Chromium with software WebGL only, not on real GPUs or other browsers.
* The 2D canvas remains rigid-layer (no mesh deformation).

## 9. Legacy (v0.1) behaviour retained

Layer-based 2D editor: import PNG/PSD, layer tree, masks, joints/FK/two-bone IK on rigid layers, named 2D poses, transparent PNG export, optional localhost AI mask proposals (`rembg`, SAM). It is reachable from the *2D canvas* tab and was not removed.
